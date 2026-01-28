# OTA Bundle Lanes for React Native
# Include this in your Fastfile: import '../node_modules/@meisterwork/react-native-ota-update/fastlane/ota_lanes.rb'
#
# Required configuration (set before importing):
#   $OTA_S3_BUCKET - S3 bucket name
#   $OTA_S3_REGION - AWS region (default: eu-central-1)
#   $OTA_ALL_APPS - Array of app configs: [{flavor: "MyApp", version: "1.0.0", buildVersion: 123}, ...]
#
# Example:
#   $OTA_S3_BUCKET = "my-app-ota"
#   $OTA_S3_REGION = "eu-central-1"
#   $OTA_ALL_APPS = [{flavor: "MyApp", version: "1.0.0", buildVersion: 1}]
#
# Usage:
#   fastlane ota_bundle app:MyApp platform:android
#   fastlane ota_bundle app:MyApp platform:ios
#   fastlane ota_bundle app:MyApp  # defaults to android
#
# Note: buildVersion should be updated after each beta/release build

$OTA_S3_REGION ||= "eu-central-1"
$OTA_S3_BASE_URL = "https://s3.#{$OTA_S3_REGION}.amazonaws.com"

desc "Build and upload OTA bundle to S3 (supports Android and iOS)"
lane :ota_bundle do |options|
  UI.user_error!("$OTA_S3_BUCKET not configured") unless $OTA_S3_BUCKET
  UI.user_error!("$OTA_ALL_APPS not configured") unless $OTA_ALL_APPS

  all_apps = extractOtaAppsFromOptions(options)
  timing = options[:timing] || "reload_window"
  force_update = options[:force] == true
  release_notes = options[:notes] || ""
  platform = options[:platform] || "android"

  all_apps.each do |app|
    flavor = app[:flavor]
    version = app[:version]

    project_root = File.expand_path("../..", __dir__)

    # Get build version from app config (should be set after each beta/release build)
    # Falls back to reading from project files if not set
    build_version = app[:buildVersion]
    unless build_version
      if platform == "ios"
        build_version = get_build_number rescue 1
      else
        build_version = get_version_code(gradle_file_path: "app/build.gradle")
      end
      puts "Warning: No buildVersion in app config for #{flavor}, reading from project files: #{build_version}"
    end

    app_folder = flavor.downcase
    s3_manifest_key = "#{app_folder}/#{platform}/#{build_version}/manifest.json"

    # Check existing manifest
    existing_bundle_version = 0
    begin
      existing_manifest = sh("aws s3 cp s3://#{$OTA_S3_BUCKET}/#{s3_manifest_key} - --region #{$OTA_S3_REGION} 2>/dev/null || echo '{}'", log: false)
      require 'json'
      existing = JSON.parse(existing_manifest)
      existing_bundle_version = existing["bundleVersion"].to_i if existing["bundleVersion"]
    rescue
    end

    bundle_version = existing_bundle_version + 1

    puts "Building OTA bundle for #{flavor} v#{version}, build #{build_version}, bundle #{bundle_version}, platform #{platform}"

    # Set version based on platform
    if platform == "ios"
      # For iOS projects
      increment_build_number(build_number: build_version) rescue nil
    else
      android_set_version_name(version_name: version)
    end

    # Copy whitelabel if script exists
    whitelabel_script = "#{project_root}/copy_whitelabel_files.sh"
    if File.exist?(whitelabel_script)
      sh("sh #{whitelabel_script} #{flavor.downcase}")
      verifyWhitelabelConfig(flavor) if defined?(verifyWhitelabelConfig)
    end

    build_dir = "#{project_root}/build/generated/ota/#{platform}/#{flavor.downcase}"
    sh("mkdir -p #{build_dir}")

    # Bundle names differ by platform
    if platform == "ios"
      bundle_output = "#{build_dir}/main.jsbundle"
      hermes_output = "#{build_dir}/main.jsbundle.hbc"
    else
      bundle_output = "#{build_dir}/index.android.bundle"
      hermes_output = "#{build_dir}/index.android.bundle.hbc"
    end

    puts "Building JS bundle for #{platform}..."
    sh("cd #{project_root} && npx react-native bundle --platform #{platform} --dev false --entry-file index.js --bundle-output #{bundle_output} --assets-dest #{build_dir}/assets --minify true")

    unless File.exist?(bundle_output)
      UI.user_error!("Bundle creation failed - #{bundle_output} not found")
    end

    puts "Compiling to Hermes bytecode..."
    hermesc_paths = [
      "#{project_root}/node_modules/react-native/sdks/hermesc/osx-bin/hermesc",
      "#{project_root}/node_modules/react-native/sdks/hermesc/linux64-bin/hermesc",
      "#{project_root}/node_modules/hermes-engine/osx-bin/hermesc",
      "#{project_root}/node_modules/hermes-engine/linux64-bin/hermesc",
      # iOS specific paths
      "#{project_root}/ios/Pods/hermes-engine/destroot/bin/hermesc"
    ]

    hermesc_path = hermesc_paths.find { |p| File.exist?(p) }

    if hermesc_path
      sh("#{hermesc_path} -emit-binary -out #{hermes_output} #{bundle_output}")
      final_bundle = hermes_output
    else
      puts "Warning: hermesc not found, using plain JS bundle"
      final_bundle = bundle_output
    end

    checksum = sh("shasum -a 256 #{final_bundle} | cut -d ' ' -f1").strip
    bundle_size = File.size(final_bundle)

    assets_dir = "#{build_dir}/assets"
    assets_zip = "#{build_dir}/assets.zip"
    if File.directory?(assets_dir)
      sh("cd #{assets_dir} && zip -r #{assets_zip} .")
      assets_checksum = sh("shasum -a 256 #{assets_zip} | cut -d ' ' -f1").strip
      assets_size = File.size(assets_zip)
    end

    bundle_filename = platform == "ios" ? "main.jsbundle" : "index.android.bundle"
    s3_bundle_key = "#{app_folder}/#{platform}/#{build_version}/bundles/#{bundle_filename}.#{bundle_version}"
    s3_assets_key = "#{app_folder}/#{platform}/#{build_version}/bundles/assets.#{bundle_version}.zip"

    puts "Uploading bundle to S3..."
    sh("aws s3 cp #{final_bundle} s3://#{$OTA_S3_BUCKET}/#{s3_bundle_key} --region #{$OTA_S3_REGION}")

    if File.exist?(assets_zip)
      puts "Uploading assets to S3..."
      sh("aws s3 cp #{assets_zip} s3://#{$OTA_S3_BUCKET}/#{s3_assets_key} --region #{$OTA_S3_REGION}")
    end

    manifest = {
      "version" => version,
      "buildVersion" => build_version.to_i,
      "bundleVersion" => bundle_version,
      "bundleUrl" => "#{$OTA_S3_BASE_URL}/#{$OTA_S3_BUCKET}/#{s3_bundle_key}",
      "bundleChecksum" => "sha256:#{checksum}",
      "bundleSize" => bundle_size,
      "assetsUrl" => File.exist?(assets_zip) ? "#{$OTA_S3_BASE_URL}/#{$OTA_S3_BUCKET}/#{s3_assets_key}" : nil,
      "assetsChecksum" => File.exist?(assets_zip) ? "sha256:#{assets_checksum}" : nil,
      "assetsSize" => File.exist?(assets_zip) ? assets_size : nil,
      "releaseDate" => Time.now.utc.iso8601,
      "updatePolicy" => {
        "timing" => timing,
        "forceUpdate" => force_update
      },
      "hermesEnabled" => hermesc_path != nil,
      "releaseNotes" => release_notes
    }

    require 'json'
    manifest_file = "/tmp/manifest_#{flavor.downcase}.json"
    File.write(manifest_file, JSON.pretty_generate(manifest))

    puts "Uploading manifest to S3..."
    sh("aws s3 cp #{manifest_file} s3://#{$OTA_S3_BUCKET}/#{s3_manifest_key} --region #{$OTA_S3_REGION}")

    puts ""
    puts "OTA bundle uploaded for #{flavor} (#{platform}):"
    puts "  - Version: #{version}"
    puts "  - Build: #{build_version}"
    puts "  - Bundle: #{bundle_version}"
    puts "  - Timing: #{timing}"
    puts "  - S3 path: #{app_folder}/#{platform}/#{build_version}/"
  end
end

desc "Check OTA bundle status"
lane :ota_status do |options|
  UI.user_error!("$OTA_S3_BUCKET not configured") unless $OTA_S3_BUCKET
  UI.user_error!("$OTA_ALL_APPS not configured") unless $OTA_ALL_APPS

  all_apps = extractOtaAppsFromOptions(options)
  platform = options[:platform] || "android"

  all_apps.each do |app|
    flavor = app[:flavor]
    # Use build option if provided, otherwise use app's stored buildVersion
    build_version = options[:build] || app[:buildVersion]
    unless build_version
      if platform == "ios"
        build_version = get_build_number rescue 1
      else
        build_version = get_version_code(gradle_file_path: "app/build.gradle")
      end
    end
    app_folder = flavor.downcase
    manifest_url = "#{$OTA_S3_BASE_URL}/#{$OTA_S3_BUCKET}/#{app_folder}/#{platform}/#{build_version}/manifest.json"

    puts "\nOTA Status for #{flavor} (#{platform}, build #{build_version}):"
    puts "  Manifest: #{manifest_url}"

    begin
      manifest_content = sh("curl -s #{manifest_url}", log: false)
      require 'json'
      manifest = JSON.parse(manifest_content)
      puts "  Version: #{manifest['version']}"
      puts "  Bundle: #{manifest['bundleVersion']}"
      puts "  Timing: #{manifest.dig('updatePolicy', 'timing')}"
      puts "  Released: #{manifest['releaseDate']}"
    rescue
      puts "  Status: No manifest found"
    end
  end
end

def extractOtaAppsFromOptions(options)
  apps = $OTA_ALL_APPS

  if options[:app]
    apps = $OTA_ALL_APPS.select { |item| item[:flavor] == options[:app] }
  end

  if options[:apps]
    app_names = options[:apps].split(',')
    apps = $OTA_ALL_APPS.select { |item| app_names.include?(item[:flavor]) }
  end

  apps
end

def verifyWhitelabelConfig(flavor)
  project_root = File.expand_path("../..", __dir__)
  whitelabel_config_path = "#{project_root}/whitelabel/whitelabel-config.json"
  return unless File.exist?(whitelabel_config_path)

  whitelabel_content = File.read(whitelabel_config_path)
  url_scheme_match = whitelabel_content.match(/"urlScheme"\s*:\s*"([^"]+)"/)
  url_scheme = url_scheme_match ? url_scheme_match[1] : ""

  expected_scheme = "loyalty#{flavor.downcase}"
  unless url_scheme.downcase == expected_scheme.downcase
    UI.user_error!("Whitelabel config mismatch! Expected '#{expected_scheme}' but got '#{url_scheme}'")
  end
  puts "Verified whitelabel config: #{url_scheme}"
end

# Helper to update buildVersion for an app in the Fastfile
# Call this after beta/release builds to save the new buildVersion
# Usage: updateOtaAppBuildVersion("MyApp", 123, "path/to/Fastfile")
def updateOtaAppBuildVersion(flavor, new_build_version, fastfile_path = nil)
  fastfile_path ||= File.expand_path("../Fastfile", __dir__)
  return unless File.exist?(fastfile_path)

  content = File.read(fastfile_path)

  # Match the app entry and update buildVersion
  # Pattern works even when there are more fields after buildVersion (e.g., gdriveFolderId)
  updated = content.gsub(
    /(\{flavor:\s*"#{flavor}",.*?buildVersion:\s*)\d+/m,
    "\\1#{new_build_version}"
  )

  if content != updated
    File.write(fastfile_path, updated)
    puts "Updated #{flavor} buildVersion to #{new_build_version} in Fastfile"
  else
    puts "Warning: Could not find #{flavor} buildVersion entry to update"
  end
end
