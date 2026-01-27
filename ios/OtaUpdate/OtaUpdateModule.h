#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface OtaUpdateModule : RCTEventEmitter <RCTBridgeModule>

/**
 * Get the path to the active custom bundle, if it exists.
 * Called from AppDelegate to determine which bundle to load.
 */
+ (NSString * _Nullable)getActiveBundlePath;

/**
 * Get the path to the fallback bundle, if it exists.
 */
+ (NSString * _Nullable)getFallbackBundlePath;

/**
 * Check if bundle load has failed (for rollback detection).
 */
+ (BOOL)hasBundleLoadFailed;

/**
 * Clear the bundle load failed flag.
 */
+ (void)clearBundleLoadFailed;

/**
 * Increment the start count for crash detection.
 * If count reaches 3, set bundle load failed flag.
 */
+ (void)incrementStartCount;

/**
 * Get the bundle URL to use for React Native.
 * Returns custom bundle URL if available, otherwise nil (use default).
 */
+ (NSURL * _Nullable)bundleURL;

@end
