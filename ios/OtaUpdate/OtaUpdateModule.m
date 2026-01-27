#import "OtaUpdateModule.h"
#import <React/RCTLog.h>
#import <CommonCrypto/CommonDigest.h>

static NSString *const kPrefsName = @"OtaUpdatePrefs";
static NSString *const kCurrentBundleVersion = @"currentBundleVersion";
static NSString *const kPendingBundleVersion = @"pendingBundleVersion";
static NSString *const kStartCount = @"startCount";
static NSString *const kBundleLoadFailed = @"bundleLoadFailed";

static NSString *const kBundlesDir = @"bundles";
static NSString *const kPendingBundle = @"pending.bundle";
static NSString *const kActiveBundle = @"active.bundle";
static NSString *const kFallbackBundle = @"fallback.bundle";
static NSString *const kPendingAssetsDir = @"pending_assets";
static NSString *const kFallbackAssetsDir = @"fallback_assets";

@implementation OtaUpdateModule
{
    bool hasListeners;
}

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
    return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
    return @[@"OtaUpdateProgress"];
}

- (void)startObserving
{
    hasListeners = YES;
}

- (void)stopObserving
{
    hasListeners = NO;
}

#pragma mark - Static Methods

+ (NSString *)bundlesDirectory
{
    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *documentsDir = [paths firstObject];
    return [documentsDir stringByAppendingPathComponent:kBundlesDir];
}

+ (NSString * _Nullable)getActiveBundlePath
{
    NSString *bundlesDir = [self bundlesDirectory];
    NSString *activeBundlePath = [bundlesDir stringByAppendingPathComponent:kActiveBundle];

    NSFileManager *fileManager = [NSFileManager defaultManager];
    if ([fileManager fileExistsAtPath:activeBundlePath]) {
        NSDictionary *attrs = [fileManager attributesOfItemAtPath:activeBundlePath error:nil];
        if ([attrs fileSize] > 0) {
            return activeBundlePath;
        }
    }
    return nil;
}

+ (NSString * _Nullable)getFallbackBundlePath
{
    NSString *bundlesDir = [self bundlesDirectory];
    NSString *fallbackBundlePath = [bundlesDir stringByAppendingPathComponent:kFallbackBundle];

    NSFileManager *fileManager = [NSFileManager defaultManager];
    if ([fileManager fileExistsAtPath:fallbackBundlePath]) {
        NSDictionary *attrs = [fileManager attributesOfItemAtPath:fallbackBundlePath error:nil];
        if ([attrs fileSize] > 0) {
            return fallbackBundlePath;
        }
    }
    return nil;
}

+ (BOOL)hasBundleLoadFailed
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    return [defaults boolForKey:kBundleLoadFailed];
}

+ (void)clearBundleLoadFailed
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    [defaults setBool:NO forKey:kBundleLoadFailed];
    [defaults synchronize];
}

+ (void)incrementStartCount
{
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSInteger startCount = [defaults integerForKey:kStartCount] + 1;

    if (startCount >= 3) {
        RCTLogWarn(@"[OtaUpdate] App has crashed 3 times, marking bundle as failed");
        [defaults setBool:YES forKey:kBundleLoadFailed];
        [defaults setInteger:0 forKey:kStartCount];
    } else {
        [defaults setInteger:startCount forKey:kStartCount];
    }
    [defaults synchronize];
}

+ (NSURL * _Nullable)bundleURL
{
    // Check for rollback
    if ([self hasBundleLoadFailed]) {
        NSString *fallbackPath = [self getFallbackBundlePath];
        [self clearBundleLoadFailed];
        if (fallbackPath) {
            RCTLogInfo(@"[OtaUpdate] Using fallback bundle after crash");
            return [NSURL fileURLWithPath:fallbackPath];
        }
        return nil; // Use default bundle
    }

    // Increment start count for crash detection
    [self incrementStartCount];

    // Check for active bundle
    NSString *activePath = [self getActiveBundlePath];
    if (activePath) {
        RCTLogInfo(@"[OtaUpdate] Using custom bundle: %@", activePath);
        return [NSURL fileURLWithPath:activePath];
    }

    return nil; // Use default bundle
}

#pragma mark - React Native Methods

RCT_EXPORT_METHOD(downloadBundle:(NSDictionary *)manifest
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSString *bundleUrl = manifest[@"bundleUrl"];
    NSString *expectedChecksum = manifest[@"bundleChecksum"];
    NSInteger bundleVersion = [manifest[@"bundleVersion"] integerValue];
    NSInteger expectedSize = [manifest[@"bundleSize"] integerValue];

    if (!bundleUrl || !expectedChecksum) {
        reject(@"INVALID_MANIFEST", @"Bundle URL or checksum is missing", nil);
        return;
    }

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        @try {
            // Ensure bundles directory exists
            NSString *bundlesDir = [[self class] bundlesDirectory];
            NSFileManager *fileManager = [NSFileManager defaultManager];
            [fileManager createDirectoryAtPath:bundlesDir withIntermediateDirectories:YES attributes:nil error:nil];

            NSString *pendingBundlePath = [bundlesDir stringByAppendingPathComponent:kPendingBundle];

            // Download bundle
            NSURL *url = [NSURL URLWithString:bundleUrl];
            NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
            [request setTimeoutInterval:60];

            NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
            NSURLSession *session = [NSURLSession sessionWithConfiguration:config];

            dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
            __block NSData *downloadedData = nil;
            __block NSError *downloadError = nil;

            NSURLSessionDataTask *task = [session dataTaskWithRequest:request
                completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                    downloadedData = data;
                    downloadError = error;
                    dispatch_semaphore_signal(semaphore);
                }];
            [task resume];

            dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

            if (downloadError) {
                reject(@"DOWNLOAD_FAILED", downloadError.localizedDescription, downloadError);
                return;
            }

            if (!downloadedData || downloadedData.length == 0) {
                reject(@"DOWNLOAD_FAILED", @"No data received", nil);
                return;
            }

            // Send progress event
            [self sendProgressEvent:100 status:@"verifying"];

            // Write to file
            [downloadedData writeToFile:pendingBundlePath atomically:YES];

            // Verify checksum
            NSString *actualChecksum = [self calculateSHA256:pendingBundlePath];
            NSString *expectedHash = expectedChecksum;
            if ([expectedHash hasPrefix:@"sha256:"]) {
                expectedHash = [expectedHash substringFromIndex:7];
            }

            if (![actualChecksum.lowercaseString isEqualToString:expectedHash.lowercaseString]) {
                [fileManager removeItemAtPath:pendingBundlePath error:nil];
                reject(@"CHECKSUM_MISMATCH",
                       [NSString stringWithFormat:@"Checksum verification failed. Expected: %@, Got: %@", expectedHash, actualChecksum],
                       nil);
                return;
            }

            // Store pending version
            NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
            [defaults setInteger:bundleVersion forKey:kPendingBundleVersion];
            [defaults synchronize];

            RCTLogInfo(@"[OtaUpdate] Bundle downloaded and verified: v%ld", (long)bundleVersion);

            resolve(@{
                @"success": @YES,
                @"bundleVersion": @(bundleVersion),
                @"size": @(downloadedData.length)
            });

        } @catch (NSException *exception) {
            reject(@"DOWNLOAD_ERROR", exception.reason, nil);
        }
    });
}

RCT_EXPORT_METHOD(downloadAssets:(NSDictionary *)manifest
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSString *assetsUrl = manifest[@"assetsUrl"];

    if (!assetsUrl) {
        resolve(@YES);
        return;
    }

    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        @try {
            NSString *bundlesDir = [[self class] bundlesDirectory];
            NSFileManager *fileManager = [NSFileManager defaultManager];

            NSString *pendingAssetsDir = [bundlesDir stringByAppendingPathComponent:kPendingAssetsDir];
            [fileManager removeItemAtPath:pendingAssetsDir error:nil];
            [fileManager createDirectoryAtPath:pendingAssetsDir withIntermediateDirectories:YES attributes:nil error:nil];

            // Download zip
            NSURL *url = [NSURL URLWithString:assetsUrl];
            NSData *zipData = [NSData dataWithContentsOfURL:url];

            if (!zipData) {
                reject(@"DOWNLOAD_FAILED", @"Failed to download assets", nil);
                return;
            }

            NSString *tempZipPath = [bundlesDir stringByAppendingPathComponent:@"temp_assets.zip"];
            [zipData writeToFile:tempZipPath atomically:YES];

            // Unzip
            [self sendProgressEvent:100 status:@"extracting_assets"];
            [self unzipFile:tempZipPath toDestination:pendingAssetsDir];

            // Delete temp zip
            [fileManager removeItemAtPath:tempZipPath error:nil];

            RCTLogInfo(@"[OtaUpdate] Assets downloaded and extracted");
            resolve(@YES);

        } @catch (NSException *exception) {
            reject(@"ASSETS_DOWNLOAD_ERROR", exception.reason, nil);
        }
    });
}

RCT_EXPORT_METHOD(applyPendingBundle:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSString *bundlesDir = [[self class] bundlesDirectory];
        NSFileManager *fileManager = [NSFileManager defaultManager];

        NSString *pendingPath = [bundlesDir stringByAppendingPathComponent:kPendingBundle];
        NSString *activePath = [bundlesDir stringByAppendingPathComponent:kActiveBundle];
        NSString *fallbackPath = [bundlesDir stringByAppendingPathComponent:kFallbackBundle];
        NSString *pendingAssetsDir = [bundlesDir stringByAppendingPathComponent:kPendingAssetsDir];
        NSString *fallbackAssetsDir = [bundlesDir stringByAppendingPathComponent:kFallbackAssetsDir];

        if (![fileManager fileExistsAtPath:pendingPath]) {
            reject(@"NO_PENDING_BUNDLE", @"No pending bundle to apply", nil);
            return;
        }

        // Move active to fallback
        if ([fileManager fileExistsAtPath:activePath]) {
            [fileManager removeItemAtPath:fallbackPath error:nil];
            [fileManager moveItemAtPath:activePath toPath:fallbackPath error:nil];
        }

        // Move pending to active
        [fileManager moveItemAtPath:pendingPath toPath:activePath error:nil];

        // Handle assets
        if ([fileManager fileExistsAtPath:pendingAssetsDir]) {
            [fileManager removeItemAtPath:fallbackAssetsDir error:nil];
            // Move current assets to fallback, pending to current
            // For iOS, assets are typically in the pending_assets folder
            [fileManager moveItemAtPath:pendingAssetsDir toPath:fallbackAssetsDir error:nil];
        }

        // Update version
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        NSInteger pendingVersion = [defaults integerForKey:kPendingBundleVersion];
        [defaults setInteger:pendingVersion forKey:kCurrentBundleVersion];
        [defaults setInteger:0 forKey:kStartCount];
        [defaults removeObjectForKey:kPendingBundleVersion];
        [defaults synchronize];

        RCTLogInfo(@"[OtaUpdate] Bundle applied: v%ld", (long)pendingVersion);

        resolve(@{
            @"success": @YES,
            @"bundleVersion": @(pendingVersion)
        });

    } @catch (NSException *exception) {
        reject(@"APPLY_ERROR", exception.reason, nil);
    }
}

RCT_EXPORT_METHOD(getCurrentBundleInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        NSInteger currentBundleVersion = [defaults integerForKey:kCurrentBundleVersion];
        NSInteger pendingVersion = [defaults integerForKey:kPendingBundleVersion];

        // Get app version
        NSString *buildString = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleVersion"];
        NSInteger buildVersion = [buildString integerValue];

        NSString *bundlesDir = [[self class] bundlesDirectory];
        NSFileManager *fileManager = [NSFileManager defaultManager];

        NSString *activePath = [bundlesDir stringByAppendingPathComponent:kActiveBundle];
        NSString *pendingPath = [bundlesDir stringByAppendingPathComponent:kPendingBundle];
        NSString *fallbackPath = [bundlesDir stringByAppendingPathComponent:kFallbackBundle];

        BOOL hasActive = [fileManager fileExistsAtPath:activePath];
        BOOL hasPending = [fileManager fileExistsAtPath:pendingPath];
        BOOL hasFallback = [fileManager fileExistsAtPath:fallbackPath];

        resolve(@{
            @"buildVersion": @(buildVersion),
            @"currentBundleVersion": @(currentBundleVersion),
            @"hasActiveBundle": @(hasActive),
            @"hasPendingBundle": @(hasPending),
            @"hasFallbackBundle": @(hasFallback),
            @"pendingVersion": @(pendingVersion),
            @"isUsingCustomBundle": @(hasActive)
        });

    } @catch (NSException *exception) {
        reject(@"INFO_ERROR", exception.reason, nil);
    }
}

RCT_EXPORT_METHOD(markBundleAsWorking:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setInteger:0 forKey:kStartCount];
        [defaults setBool:NO forKey:kBundleLoadFailed];
        [defaults synchronize];

        RCTLogInfo(@"[OtaUpdate] Bundle marked as working");
        resolve(@YES);

    } @catch (NSException *exception) {
        reject(@"MARK_ERROR", exception.reason, nil);
    }
}

RCT_EXPORT_METHOD(rollbackToFallback:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSString *bundlesDir = [[self class] bundlesDirectory];
        NSFileManager *fileManager = [NSFileManager defaultManager];

        NSString *activePath = [bundlesDir stringByAppendingPathComponent:kActiveBundle];
        NSString *fallbackPath = [bundlesDir stringByAppendingPathComponent:kFallbackBundle];

        if (![fileManager fileExistsAtPath:fallbackPath]) {
            [fileManager removeItemAtPath:activePath error:nil];

            NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
            [defaults setInteger:0 forKey:kCurrentBundleVersion];
            [defaults setInteger:0 forKey:kStartCount];
            [defaults setBool:NO forKey:kBundleLoadFailed];
            [defaults synchronize];

            resolve(@YES);
            return;
        }

        [fileManager removeItemAtPath:activePath error:nil];
        [fileManager moveItemAtPath:fallbackPath toPath:activePath error:nil];

        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults setInteger:0 forKey:kStartCount];
        [defaults setBool:NO forKey:kBundleLoadFailed];
        [defaults synchronize];

        RCTLogInfo(@"[OtaUpdate] Rolled back to fallback bundle");
        resolve(@YES);

    } @catch (NSException *exception) {
        reject(@"ROLLBACK_ERROR", exception.reason, nil);
    }
}

RCT_EXPORT_METHOD(hasPendingBundle:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSString *bundlesDir = [[self class] bundlesDirectory];
    NSString *pendingPath = [bundlesDir stringByAppendingPathComponent:kPendingBundle];

    NSFileManager *fileManager = [NSFileManager defaultManager];
    resolve(@([fileManager fileExistsAtPath:pendingPath]));
}

RCT_EXPORT_METHOD(deletePendingBundle:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    @try {
        NSString *bundlesDir = [[self class] bundlesDirectory];
        NSFileManager *fileManager = [NSFileManager defaultManager];

        NSString *pendingPath = [bundlesDir stringByAppendingPathComponent:kPendingBundle];
        NSString *pendingAssetsDir = [bundlesDir stringByAppendingPathComponent:kPendingAssetsDir];

        [fileManager removeItemAtPath:pendingPath error:nil];
        [fileManager removeItemAtPath:pendingAssetsDir error:nil];

        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        [defaults removeObjectForKey:kPendingBundleVersion];
        [defaults synchronize];

        resolve(@YES);

    } @catch (NSException *exception) {
        reject(@"DELETE_ERROR", exception.reason, nil);
    }
}

#pragma mark - Helper Methods

- (void)sendProgressEvent:(NSInteger)progress status:(NSString *)status
{
    if (hasListeners) {
        [self sendEventWithName:@"OtaUpdateProgress" body:@{
            @"progress": @(progress),
            @"status": status
        }];
    }
}

- (NSString *)calculateSHA256:(NSString *)filePath
{
    NSData *data = [NSData dataWithContentsOfFile:filePath];
    if (!data) return nil;

    unsigned char hash[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, hash);

    NSMutableString *result = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
        [result appendFormat:@"%02x", hash[i]];
    }

    return result;
}

- (BOOL)unzipFile:(NSString *)zipPath toDestination:(NSString *)destPath
{
    // Simple unzip using NSTask (works for basic zip files)
    // For production, consider using SSZipArchive or similar
    NSTask *task = [[NSTask alloc] init];
    [task setLaunchPath:@"/usr/bin/unzip"];
    [task setArguments:@[@"-o", zipPath, @"-d", destPath]];
    [task setStandardOutput:[NSPipe pipe]];
    [task setStandardError:[NSPipe pipe]];

    @try {
        [task launch];
        [task waitUntilExit];
        return task.terminationStatus == 0;
    } @catch (NSException *exception) {
        RCTLogError(@"[OtaUpdate] Unzip failed: %@", exception.reason);
        return NO;
    }
}

@end
