#import "RNRestartModule.h"
#import <React/RCTBridge.h>
#import <React/RCTReloadCommand.h>

@implementation RNRestartModule

@synthesize bridge = _bridge;

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
    return YES;
}

RCT_EXPORT_METHOD(restart)
{
    if ([NSThread isMainThread]) {
        [self performRestart];
    } else {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self performRestart];
        });
    }
}

- (void)performRestart
{
    // In production, we need to actually exit the app for the new bundle to load
    // RCTTriggerReloadCommandListeners only works in development
#if DEBUG
    RCTTriggerReloadCommandListeners(@"OTA Update");
#else
    // Exit the app - user will need to reopen it
    // The new bundle will be loaded on next launch
    exit(0);
#endif
}

@end
