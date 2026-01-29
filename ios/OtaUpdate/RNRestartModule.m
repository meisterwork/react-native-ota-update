#import "RNRestartModule.h"
#import <React/RCTBridge.h>

@implementation RNRestartModule

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
    RCTBridge *bridge = [RCTBridge currentBridge];
    if (bridge) {
        [bridge reload];
    }
}

@end
