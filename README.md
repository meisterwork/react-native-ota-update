# @meisterwork/react-native-ota-update

S3-based OTA (Over-The-Air) bundle updates for React Native apps. Allows updating JavaScript bundles without going through app store releases.

## Features

- Download JS bundles from S3
- SHA-256 checksum verification
- Configurable update timing (immediate, on splash, reload window)
- Automatic rollback on crash (3 crashes triggers rollback)
- Progress tracking during download
- Hermes bytecode support

## Installation

```bash
npm install @meisterwork/react-native-ota-update
# or
yarn add @meisterwork/react-native-ota-update
```

## Android Setup

### 1. Modify MainApplication.java

```java
import com.meisterwork.otaupdate.OtaUpdateModule;

// In getJSBundleFile() or similar:
@Override
protected String getJSBundleFile() {
    // Check for OTA bundle first
    String otaBundlePath = OtaUpdateModule.getActiveBundlePath(this);

    // Handle rollback if needed
    if (OtaUpdateModule.hasBundleLoadFailed(this)) {
        String fallbackPath = OtaUpdateModule.getFallbackBundlePath(this);
        OtaUpdateModule.clearBundleLoadFailed(this);
        if (fallbackPath != null) {
            return fallbackPath;
        }
        return super.getJSBundleFile(); // Use default asset bundle
    }

    // Increment start count for crash detection
    OtaUpdateModule.incrementStartCount(this);

    if (otaBundlePath != null) {
        return otaBundlePath;
    }

    return super.getJSBundleFile();
}
```

## iOS Setup

### 1. Install pods

```bash
cd ios && pod install
```

### 2. Modify AppDelegate.m (or AppDelegate.mm)

```objc
#import <OtaUpdate/OtaUpdateModule.h>

// Replace the default bundle URL method:
- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
    // Check for OTA bundle first
    NSURL *otaBundleURL = [OtaUpdateModule bundleURL];
    if (otaBundleURL) {
        return otaBundleURL;
    }

    // Fall back to default
#if DEBUG
    return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}
```

### For React Native 0.71+ with new architecture:

```objc
// In AppDelegate.mm
#import <OtaUpdate/OtaUpdateModule.h>

- (NSURL *)bundleURL
{
    NSURL *otaBundleURL = [OtaUpdateModule bundleURL];
    if (otaBundleURL) {
        return otaBundleURL;
    }

#if DEBUG
    return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

## Usage

### Configure and Start

```typescript
import { getOtaUpdateService } from '@meisterwork/react-native-ota-update';

const otaService = getOtaUpdateService();

// Configure (call once at app startup)
otaService.configure({
  bucket: 'my-app-ota-bucket',
  region: 'eu-central-1',
  appIdentifier: 'myapp', // Used in S3 path
  checkIntervalMs: 5 * 60 * 1000, // 5 minutes
  logger: (msg, level) => console.log(`[OTA] ${msg}`),
});

// Start checking for updates
otaService.start();

// Mark bundle as working after successful load
otaService.markBundleAsWorking();
```

### Subscribe to State Changes

```typescript
const unsubscribe = otaService.subscribe((state) => {
  console.log('Update status:', state.status);
  console.log('Download progress:', state.downloadProgress);
});

// Later: unsubscribe();
```

### Control Update Timing

```typescript
// For SPLASH_VISIBLE timing - call when splash screen is shown
otaService.notifySplashVisible();
otaService.notifySplashHidden();

// For RELOAD_WINDOW timing - set the window and notify
otaService.setReloadWindow({ start: '07:00', end: '07:15' });
otaService.notifyReloadWindow();

// Manual apply
await otaService.applyPendingBundle();
```

## S3 Bucket Structure

```
s3://your-bucket/
└── {appIdentifier}/
    └── {buildVersion}/
        ├── manifest.json
        └── bundles/
            ├── index.android.bundle.{bundleVersion}
            └── assets.{bundleVersion}.zip
```

### Manifest Format

```json
{
  "version": "1.2.3",
  "buildVersion": 650,
  "bundleVersion": 5,
  "bundleUrl": "https://s3.../bundle",
  "bundleChecksum": "sha256:abc123...",
  "bundleSize": 1234567,
  "assetsUrl": "https://s3.../assets.zip",
  "updatePolicy": {
    "timing": "splash_visible",
    "forceUpdate": false
  },
  "hermesEnabled": true,
  "releaseDate": "2024-01-15T10:30:00Z"
}
```

## Fastlane Integration

See the `ota_bundle` lane in the loyalty-kiosk project for an example of how to build and upload OTA bundles.

## License

MIT
