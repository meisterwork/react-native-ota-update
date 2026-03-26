package com.meisterwork.otaupdate;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class OtaUpdateModule extends ReactContextBaseJavaModule {
    private static final String TAG = "OtaUpdateModule";
    private static final String MODULE_NAME = "OtaUpdateModule";

    // SharedPreferences
    private static final String PREFS_NAME = "OtaUpdatePrefs";
    private static final String KEY_CURRENT_BUNDLE_VERSION = "currentBundleVersion";
    private static final String KEY_START_COUNT = "startCount";
    private static final String KEY_BUNDLE_LOAD_FAILED = "bundleLoadFailed";
    private static final String KEY_LAST_BUILD_VERSION = "lastBuildVersion";

    // Bundle file names
    private static final String BUNDLES_DIR = "bundles";
    private static final String PENDING_BUNDLE = "pending.bundle";
    private static final String ACTIVE_BUNDLE = "active.bundle";
    private static final String FALLBACK_BUNDLE = "fallback.bundle";
    private static final String PENDING_ASSETS_DIR = "pending_assets";
    private static final String FALLBACK_ASSETS_DIR = "fallback_assets";
    private static final String DRAWABLE_PREFIX = "drawable-";

    private static final int BUFFER_SIZE = 8192;

    private final ReactApplicationContext reactContext;

    public OtaUpdateModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @NonNull
    @Override
    public String getName() {
        return MODULE_NAME;
    }

    /**
     * Get the path to the active custom bundle, if it exists.
     * Called from MainApplication to determine which bundle to load.
     *
     * If the APK build version has changed since the last run, all OTA bundles
     * and preferences are cleared so the app uses the fresh JS bundle from the new APK.
     */
    @Nullable
    public static String getActiveBundlePath(Context context) {
        int currentBuild = 0;
        try {
            currentBuild = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0).versionCode;
        } catch (Exception e) {
            Log.w(TAG, "Could not get APK versionCode", e);
        }

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int lastBuild = prefs.getInt(KEY_LAST_BUILD_VERSION, 0);

        if (currentBuild > 0 && lastBuild != currentBuild) {
            Log.i(TAG, "Build version changed from " + lastBuild + " to " + currentBuild + ", clearing OTA bundles");

            File bundlesDir = new File(context.getFilesDir(), BUNDLES_DIR);
            if (bundlesDir.exists()) {
                File[] files = bundlesDir.listFiles();
                if (files != null) {
                    for (File file : files) {
                        deleteRecursive(file);
                    }
                }
            }

            prefs.edit()
                .putInt(KEY_LAST_BUILD_VERSION, currentBuild)
                .putInt(KEY_CURRENT_BUNDLE_VERSION, 0)
                .putInt(KEY_START_COUNT, 0)
                .putBoolean(KEY_BUNDLE_LOAD_FAILED, false)
                .remove("pendingBundleVersion")
                .commit();

            return null;
        }

        File bundlesDir = new File(context.getFilesDir(), BUNDLES_DIR);
        File activeBundle = new File(bundlesDir, ACTIVE_BUNDLE);

        if (activeBundle.exists() && activeBundle.length() > 0) {
            return activeBundle.getAbsolutePath();
        }
        return null;
    }

    private static void deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursive(child);
                }
            }
        }
        file.delete();
    }

    /**
     * Get the path to the fallback bundle, if it exists.
     */
    @Nullable
    public static String getFallbackBundlePath(Context context) {
        File bundlesDir = new File(context.getFilesDir(), BUNDLES_DIR);
        File fallbackBundle = new File(bundlesDir, FALLBACK_BUNDLE);

        if (fallbackBundle.exists() && fallbackBundle.length() > 0) {
            return fallbackBundle.getAbsolutePath();
        }
        return null;
    }

    /**
     * Check if bundle load has failed (for rollback detection).
     */
    public static boolean hasBundleLoadFailed(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(KEY_BUNDLE_LOAD_FAILED, false);
    }

    /**
     * Clear the bundle load failed flag.
     */
    public static void clearBundleLoadFailed(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean(KEY_BUNDLE_LOAD_FAILED, false).apply();
    }

    /**
     * Increment the start count for crash detection.
     * If count reaches 3, set bundle load failed flag.
     */
    public static void incrementStartCount(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int startCount = prefs.getInt(KEY_START_COUNT, 0) + 1;

        if (startCount >= 3) {
            Log.w(TAG, "App has crashed 3 times, marking bundle as failed");
            prefs.edit()
                .putBoolean(KEY_BUNDLE_LOAD_FAILED, true)
                .putInt(KEY_START_COUNT, 0)
                .apply();
        } else {
            prefs.edit().putInt(KEY_START_COUNT, startCount).apply();
        }
    }

    @ReactMethod
    public void downloadBundle(ReadableMap manifest, Promise promise) {
        String bundleUrl = manifest.getString("bundleUrl");
        String expectedChecksum = manifest.getString("bundleChecksum");
        int bundleVersion = manifest.getInt("bundleVersion");
        int expectedSize = manifest.hasKey("bundleSize") ? manifest.getInt("bundleSize") : 0;

        if (bundleUrl == null || expectedChecksum == null) {
            promise.reject("INVALID_MANIFEST", "Bundle URL or checksum is missing");
            return;
        }

        new Thread(() -> {
            HttpURLConnection connection = null;
            InputStream inputStream = null;
            FileOutputStream outputStream = null;

            try {
                File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
                if (!bundlesDir.exists()) {
                    bundlesDir.mkdirs();
                }

                File pendingBundle = new File(bundlesDir, PENDING_BUNDLE);

                URL url = new URL(bundleUrl);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(30000);
                connection.setReadTimeout(60000);
                connection.connect();

                int responseCode = connection.getResponseCode();
                if (responseCode != HttpURLConnection.HTTP_OK) {
                    promise.reject("DOWNLOAD_FAILED", "HTTP error: " + responseCode);
                    return;
                }

                int totalSize = connection.getContentLength();
                if (totalSize <= 0 && expectedSize > 0) {
                    totalSize = expectedSize;
                }

                inputStream = connection.getInputStream();
                outputStream = new FileOutputStream(pendingBundle);

                byte[] buffer = new byte[BUFFER_SIZE];
                int bytesRead;
                int totalBytesRead = 0;
                int lastProgressPercent = 0;

                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    outputStream.write(buffer, 0, bytesRead);
                    totalBytesRead += bytesRead;

                    if (totalSize > 0) {
                        int progressPercent = (int) ((totalBytesRead * 100L) / totalSize);
                        if (progressPercent > lastProgressPercent) {
                            lastProgressPercent = progressPercent;
                            sendProgressEvent(progressPercent, "downloading");
                        }
                    }
                }

                outputStream.flush();
                outputStream.close();
                outputStream = null;

                sendProgressEvent(100, "verifying");
                String actualChecksum = calculateChecksum(pendingBundle);

                String expectedHash = expectedChecksum;
                if (expectedHash.startsWith("sha256:")) {
                    expectedHash = expectedHash.substring(7);
                }

                if (!actualChecksum.equalsIgnoreCase(expectedHash)) {
                    pendingBundle.delete();
                    promise.reject("CHECKSUM_MISMATCH",
                        "Checksum verification failed. Expected: " + expectedHash + ", Got: " + actualChecksum);
                    return;
                }

                SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putInt("pendingBundleVersion", bundleVersion).commit();

                Log.i(TAG, "Bundle downloaded and verified successfully: v" + bundleVersion);

                WritableMap result = Arguments.createMap();
                result.putBoolean("success", true);
                result.putInt("bundleVersion", bundleVersion);
                result.putInt("size", totalBytesRead);
                promise.resolve(result);

            } catch (Exception e) {
                Log.e(TAG, "Download failed", e);
                promise.reject("DOWNLOAD_ERROR", e.getMessage(), e);
            } finally {
                try {
                    if (outputStream != null) outputStream.close();
                    if (inputStream != null) inputStream.close();
                    if (connection != null) connection.disconnect();
                } catch (IOException ignored) {}
            }
        }).start();
    }

    @ReactMethod
    public void downloadAssets(ReadableMap manifest, Promise promise) {
        String assetsUrl = manifest.hasKey("assetsUrl") ? manifest.getString("assetsUrl") : null;

        if (assetsUrl == null) {
            promise.resolve(true);
            return;
        }

        new Thread(() -> {
            HttpURLConnection connection = null;
            InputStream inputStream = null;

            try {
                File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
                if (!bundlesDir.exists()) {
                    bundlesDir.mkdirs();
                }

                File pendingAssetsDir = new File(bundlesDir, PENDING_ASSETS_DIR);
                if (pendingAssetsDir.exists()) {
                    deleteDirectory(pendingAssetsDir);
                }
                pendingAssetsDir.mkdirs();

                File tempZip = new File(bundlesDir, "temp_assets.zip");

                URL url = new URL(assetsUrl);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(30000);
                connection.setReadTimeout(120000);
                connection.connect();

                int responseCode = connection.getResponseCode();
                if (responseCode != HttpURLConnection.HTTP_OK) {
                    promise.reject("DOWNLOAD_FAILED", "HTTP error: " + responseCode);
                    return;
                }

                inputStream = connection.getInputStream();
                FileOutputStream fos = new FileOutputStream(tempZip);

                byte[] buffer = new byte[BUFFER_SIZE];
                int bytesRead;
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    fos.write(buffer, 0, bytesRead);
                }
                fos.close();
                inputStream.close();
                inputStream = null;

                sendProgressEvent(100, "extracting_assets");
                unzip(tempZip, pendingAssetsDir);

                tempZip.delete();

                Log.i(TAG, "Assets downloaded and extracted successfully");
                promise.resolve(true);

            } catch (Exception e) {
                Log.e(TAG, "Assets download failed", e);
                promise.reject("ASSETS_DOWNLOAD_ERROR", e.getMessage(), e);
            } finally {
                try {
                    if (inputStream != null) inputStream.close();
                    if (connection != null) connection.disconnect();
                } catch (IOException ignored) {}
            }
        }).start();
    }

    @ReactMethod
    public void applyPendingBundle(Promise promise) {
        try {
            File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
            File pendingBundle = new File(bundlesDir, PENDING_BUNDLE);
            File activeBundle = new File(bundlesDir, ACTIVE_BUNDLE);
            File fallbackBundle = new File(bundlesDir, FALLBACK_BUNDLE);
            File pendingAssetsDir = new File(bundlesDir, PENDING_ASSETS_DIR);
            File fallbackAssetsDir = new File(bundlesDir, FALLBACK_ASSETS_DIR);

            if (!pendingBundle.exists()) {
                promise.reject("NO_PENDING_BUNDLE", "No pending bundle to apply");
                return;
            }

            if (activeBundle.exists()) {
                if (fallbackBundle.exists()) {
                    fallbackBundle.delete();
                }
                if (!activeBundle.renameTo(fallbackBundle)) {
                    copyFile(activeBundle, fallbackBundle);
                    activeBundle.delete();
                }
            }

            moveDrawableFoldersToFallback(bundlesDir, fallbackAssetsDir);

            if (!pendingBundle.renameTo(activeBundle)) {
                copyFile(pendingBundle, activeBundle);
                pendingBundle.delete();
            }

            if (pendingAssetsDir.exists()) {
                moveDrawableFoldersToBundles(pendingAssetsDir, bundlesDir);
                deleteDirectory(pendingAssetsDir);
            }

            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            int pendingVersion = prefs.getInt("pendingBundleVersion", 0);
            prefs.edit()
                .putInt(KEY_CURRENT_BUNDLE_VERSION, pendingVersion)
                .putInt(KEY_START_COUNT, 0)
                .remove("pendingBundleVersion")
                .commit();

            Log.i(TAG, "Bundle applied successfully: v" + pendingVersion);

            WritableMap result = Arguments.createMap();
            result.putBoolean("success", true);
            result.putInt("bundleVersion", pendingVersion);
            promise.resolve(result);

        } catch (Exception e) {
            Log.e(TAG, "Failed to apply bundle", e);
            promise.reject("APPLY_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void getCurrentBundleInfo(Promise promise) {
        try {
            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            int currentBundleVersion = prefs.getInt(KEY_CURRENT_BUNDLE_VERSION, 0);
            int pendingVersion = prefs.getInt("pendingBundleVersion", 0);

            int buildVersion = 0;
            try {
                buildVersion = reactContext.getPackageManager()
                    .getPackageInfo(reactContext.getPackageName(), 0).versionCode;
            } catch (Exception e) {
                Log.w(TAG, "Could not get APK versionCode", e);
            }

            File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
            File activeBundle = new File(bundlesDir, ACTIVE_BUNDLE);
            File pendingBundle = new File(bundlesDir, PENDING_BUNDLE);
            File fallbackBundle = new File(bundlesDir, FALLBACK_BUNDLE);

            WritableMap result = Arguments.createMap();
            result.putInt("buildVersion", buildVersion);
            result.putInt("currentBundleVersion", currentBundleVersion);
            result.putBoolean("hasActiveBundle", activeBundle.exists());
            result.putBoolean("hasPendingBundle", pendingBundle.exists());
            result.putBoolean("hasFallbackBundle", fallbackBundle.exists());
            result.putInt("pendingVersion", pendingVersion);
            result.putBoolean("isUsingCustomBundle", activeBundle.exists());

            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("INFO_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void markBundleAsWorking(Promise promise) {
        try {
            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                .putInt(KEY_START_COUNT, 0)
                .putBoolean(KEY_BUNDLE_LOAD_FAILED, false)
                .apply();

            Log.i(TAG, "Bundle marked as working");
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("MARK_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void rollbackToFallback(Promise promise) {
        try {
            File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
            File activeBundle = new File(bundlesDir, ACTIVE_BUNDLE);
            File fallbackBundle = new File(bundlesDir, FALLBACK_BUNDLE);
            File fallbackAssetsDir = new File(bundlesDir, FALLBACK_ASSETS_DIR);

            if (!fallbackBundle.exists()) {
                if (activeBundle.exists()) {
                    activeBundle.delete();
                }
                deleteDrawableFolders(bundlesDir);

                SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit()
                    .putInt(KEY_CURRENT_BUNDLE_VERSION, 0)
                    .putInt(KEY_START_COUNT, 0)
                    .putBoolean(KEY_BUNDLE_LOAD_FAILED, false)
                    .apply();

                promise.resolve(true);
                return;
            }

            if (activeBundle.exists()) {
                activeBundle.delete();
            }

            if (!fallbackBundle.renameTo(activeBundle)) {
                copyFile(fallbackBundle, activeBundle);
                fallbackBundle.delete();
            }

            deleteDrawableFolders(bundlesDir);
            if (fallbackAssetsDir.exists()) {
                restoreDrawableFoldersFromFallback(fallbackAssetsDir, bundlesDir);
                deleteDirectory(fallbackAssetsDir);
            }

            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                .putInt(KEY_START_COUNT, 0)
                .putBoolean(KEY_BUNDLE_LOAD_FAILED, false)
                .apply();

            Log.i(TAG, "Rolled back to fallback bundle");
            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("ROLLBACK_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void hasPendingBundle(Promise promise) {
        File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
        File pendingBundle = new File(bundlesDir, PENDING_BUNDLE);
        promise.resolve(pendingBundle.exists());
    }

    @ReactMethod
    public void deletePendingBundle(Promise promise) {
        try {
            File bundlesDir = new File(reactContext.getFilesDir(), BUNDLES_DIR);
            File pendingBundle = new File(bundlesDir, PENDING_BUNDLE);
            File pendingAssetsDir = new File(bundlesDir, PENDING_ASSETS_DIR);

            if (pendingBundle.exists()) {
                pendingBundle.delete();
            }

            if (pendingAssetsDir.exists()) {
                deleteDirectory(pendingAssetsDir);
            }

            SharedPreferences prefs = reactContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().remove("pendingBundleVersion").apply();

            promise.resolve(true);
        } catch (Exception e) {
            promise.reject("DELETE_ERROR", e.getMessage(), e);
        }
    }

    @ReactMethod
    public void addListener(String eventName) {
        // Required for NativeEventEmitter
    }

    @ReactMethod
    public void removeListeners(int count) {
        // Required for NativeEventEmitter
    }

    // Helper methods

    private void sendProgressEvent(int progress, String status) {
        WritableMap params = Arguments.createMap();
        params.putInt("progress", progress);
        params.putString("status", status);

        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("OtaUpdateProgress", params);
        } catch (Exception e) {
            Log.w(TAG, "Failed to send progress event", e);
        }
    }

    private String calculateChecksum(File file) throws IOException, NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        FileInputStream fis = new FileInputStream(file);

        byte[] buffer = new byte[BUFFER_SIZE];
        int bytesRead;

        while ((bytesRead = fis.read(buffer)) != -1) {
            digest.update(buffer, 0, bytesRead);
        }

        fis.close();

        byte[] hashBytes = digest.digest();
        StringBuilder sb = new StringBuilder();
        for (byte b : hashBytes) {
            sb.append(String.format("%02x", b));
        }

        return sb.toString();
    }

    private void copyFile(File source, File dest) throws IOException {
        FileInputStream fis = new FileInputStream(source);
        FileOutputStream fos = new FileOutputStream(dest);

        byte[] buffer = new byte[BUFFER_SIZE];
        int bytesRead;

        while ((bytesRead = fis.read(buffer)) != -1) {
            fos.write(buffer, 0, bytesRead);
        }

        fos.flush();
        fos.close();
        fis.close();
    }

    private void deleteDirectory(File dir) {
        if (dir.isDirectory()) {
            File[] children = dir.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteDirectory(child);
                }
            }
        }
        dir.delete();
    }

    private void copyDirectory(File source, File dest) throws IOException {
        if (source.isDirectory()) {
            if (!dest.exists()) {
                dest.mkdirs();
            }
            File[] children = source.listFiles();
            if (children != null) {
                for (File child : children) {
                    copyDirectory(child, new File(dest, child.getName()));
                }
            }
        } else {
            copyFile(source, dest);
        }
    }

    private void unzip(File zipFile, File targetDir) throws IOException {
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zipFile)));
        ZipEntry entry;

        while ((entry = zis.getNextEntry()) != null) {
            File file = new File(targetDir, entry.getName());

            if (!file.getCanonicalPath().startsWith(targetDir.getCanonicalPath())) {
                throw new SecurityException("Zip entry is outside of target dir: " + entry.getName());
            }

            if (entry.isDirectory()) {
                file.mkdirs();
            } else {
                file.getParentFile().mkdirs();

                FileOutputStream fos = new FileOutputStream(file);
                byte[] buffer = new byte[BUFFER_SIZE];
                int bytesRead;

                while ((bytesRead = zis.read(buffer)) != -1) {
                    fos.write(buffer, 0, bytesRead);
                }

                fos.close();
            }
            zis.closeEntry();
        }
        zis.close();
    }

    private void moveDrawableFoldersToFallback(File bundlesDir, File fallbackDir) throws IOException {
        File[] files = bundlesDir.listFiles();
        if (files == null) return;

        if (fallbackDir.exists()) {
            deleteDirectory(fallbackDir);
        }
        fallbackDir.mkdirs();

        for (File file : files) {
            if (file.isDirectory() && file.getName().startsWith(DRAWABLE_PREFIX)) {
                File destDir = new File(fallbackDir, file.getName());
                if (!file.renameTo(destDir)) {
                    copyDirectory(file, destDir);
                    deleteDirectory(file);
                }
            }
        }
    }

    private void moveDrawableFoldersToBundles(File sourceDir, File bundlesDir) throws IOException {
        File[] files = sourceDir.listFiles();
        if (files == null) return;

        for (File file : files) {
            if (file.isDirectory() && file.getName().startsWith(DRAWABLE_PREFIX)) {
                File destDir = new File(bundlesDir, file.getName());
                if (destDir.exists()) {
                    deleteDirectory(destDir);
                }
                if (!file.renameTo(destDir)) {
                    copyDirectory(file, destDir);
                    deleteDirectory(file);
                }
            }
        }
    }

    private void restoreDrawableFoldersFromFallback(File fallbackDir, File bundlesDir) throws IOException {
        File[] files = fallbackDir.listFiles();
        if (files == null) return;

        for (File file : files) {
            if (file.isDirectory() && file.getName().startsWith(DRAWABLE_PREFIX)) {
                File destDir = new File(bundlesDir, file.getName());
                if (destDir.exists()) {
                    deleteDirectory(destDir);
                }
                if (!file.renameTo(destDir)) {
                    copyDirectory(file, destDir);
                    deleteDirectory(file);
                }
            }
        }
    }

    private void deleteDrawableFolders(File bundlesDir) {
        File[] files = bundlesDir.listFiles();
        if (files == null) return;

        for (File file : files) {
            if (file.isDirectory() && file.getName().startsWith(DRAWABLE_PREFIX)) {
                deleteDirectory(file);
            }
        }
    }
}
