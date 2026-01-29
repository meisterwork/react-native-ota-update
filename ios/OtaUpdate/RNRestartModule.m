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
    RCTTriggerReloadCommandListeners(@"OTA Update");
}

@end
