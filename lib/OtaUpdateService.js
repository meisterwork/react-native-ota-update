"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOtaUpdateService = exports.OtaUpdateService = void 0;
const react_native_1 = require("react-native");
const types_1 = require("./types");
const { OtaUpdateModule, RNRestartModule } = react_native_1.NativeModules;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_REGION = 'eu-central-1';
function createInitialState() {
    return {
        status: types_1.UpdateStatus.IDLE,
        downloadProgress: 0,
        currentBundleVersion: 0,
        availableManifest: null,
        lastCheckTime: null,
        lastError: null,
        isUsingCustomBundle: false,
        hasPendingBundle: false,
    };
}
class OtaUpdateService {
    /**
     * Get the singleton instance
     */
    static getInstance() {
        if (!OtaUpdateService.instance) {
            OtaUpdateService.instance = new OtaUpdateService();
        }
        return OtaUpdateService.instance;
    }
    constructor() {
        this.config = null;
        this.state = createInitialState();
        this.listeners = new Set();
        this.checkInterval = null;
        this.eventEmitter = null;
        this.manifestUrl = '';
        this.buildVersion = 0;
        this.isSplashVisible = false;
        this.isInReloadWindow = false;
        this.reloadWindowConfig = null;
        if ((react_native_1.Platform.OS === 'android' || react_native_1.Platform.OS === 'ios') && OtaUpdateModule) {
            this.eventEmitter = new react_native_1.NativeEventEmitter(OtaUpdateModule);
            this.setupProgressListener();
        }
    }
    /**
     * Configure the OTA update service. Must be called before start().
     */
    configure(config) {
        this.config = {
            ...config,
            region: config.region || DEFAULT_REGION,
            checkIntervalMs: config.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS,
        };
        this.log(`Configured with bucket: ${config.bucket}, app: ${config.appIdentifier}`);
    }
    /**
     * Set the reload window configuration for RELOAD_WINDOW timing.
     */
    setReloadWindow(config) {
        this.reloadWindowConfig = config;
    }
    /**
     * Subscribe to state changes.
     * Returns an unsubscribe function.
     */
    subscribe(listener) {
        this.listeners.add(listener);
        // Immediately call with current state
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }
    /**
     * Get current state.
     */
    getState() {
        return { ...this.state };
    }
    /**
     * Start the OTA update service.
     * Checks for updates immediately and then periodically.
     */
    start() {
        if (!this.config) {
            this.log('Cannot start - not configured. Call configure() first.', 'error');
            return;
        }
        if (react_native_1.Platform.OS !== 'android' && react_native_1.Platform.OS !== 'ios') {
            this.log('OTA updates only supported on Android and iOS', 'warn');
            return;
        }
        this.log(`Starting OTA update service on ${react_native_1.Platform.OS}...`);
        // Initial check
        this.checkForUpdate();
        // Periodic checks
        this.checkInterval = setInterval(() => {
            this.checkForUpdate();
        }, this.config.checkIntervalMs);
    }
    /**
     * Stop the OTA update service.
     */
    stop() {
        this.log('Stopping OTA update service...');
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }
    /**
     * Check for available updates.
     */
    async checkForUpdate() {
        if (!this.config) {
            this.log('Cannot check - not configured', 'error');
            return;
        }
        if (!OtaUpdateModule) {
            this.log('Native module not available', 'warn');
            return;
        }
        try {
            await this.initManifestUrl();
            this.updateState({
                status: types_1.UpdateStatus.CHECKING,
                lastError: null,
            });
            this.log(`Checking for updates at ${this.manifestUrl}`);
            const response = await fetch(this.manifestUrl, {
                method: 'GET',
                headers: {
                    'Cache-Control': 'no-cache',
                },
            });
            if (!response.ok) {
                // 404 = file not found, 403 = access denied (S3 returns this when file doesn't exist and no ListBucket permission)
                // Both mean no OTA manifest exists for this build - this is normal, not an error
                if (response.status === 404 || response.status === 403) {
                    this.log(`No OTA manifest for build ${this.buildVersion} - using bundled JS`);
                    this.updateState({
                        status: types_1.UpdateStatus.IDLE,
                        lastCheckTime: new Date().toISOString(),
                    });
                    return;
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const manifest = await response.json();
            this.log(`Manifest received - bundleVersion: ${manifest.bundleVersion}`);
            // Verify manifest is for this build
            if (manifest.buildVersion !== this.buildVersion) {
                this.log(`Manifest buildVersion ${manifest.buildVersion} doesn't match APK ${this.buildVersion}`, 'warn');
                this.updateState({
                    status: types_1.UpdateStatus.IDLE,
                    lastCheckTime: new Date().toISOString(),
                });
                return;
            }
            // Get current bundle info
            const bundleInfo = await OtaUpdateModule.getCurrentBundleInfo();
            const currentBundleVersion = bundleInfo.currentBundleVersion || 0;
            this.updateState({
                currentBundleVersion,
                isUsingCustomBundle: bundleInfo.isUsingCustomBundle,
                hasPendingBundle: bundleInfo.hasPendingBundle,
            });
            // Check if update is available
            if (manifest.bundleVersion > currentBundleVersion) {
                this.log(`Update available: ${currentBundleVersion} -> ${manifest.bundleVersion}`);
                this.updateState({
                    availableManifest: manifest,
                    lastCheckTime: new Date().toISOString(),
                });
                await this.downloadUpdate(manifest);
            }
            else {
                this.log('No update available');
                this.updateState({
                    status: types_1.UpdateStatus.IDLE,
                    availableManifest: null,
                    lastCheckTime: new Date().toISOString(),
                });
                if (bundleInfo.hasPendingBundle) {
                    this.tryApplyPendingBundle();
                }
            }
        }
        catch (error) {
            this.log(`Check failed: ${error.message}`, 'error');
            this.updateState({
                status: types_1.UpdateStatus.ERROR,
                lastError: error.message,
                lastCheckTime: new Date().toISOString(),
            });
        }
    }
    /**
     * Apply pending bundle and restart the app.
     */
    async applyPendingBundle() {
        try {
            this.updateState({ status: types_1.UpdateStatus.APPLYING });
            this.log('Applying pending bundle...');
            const result = await OtaUpdateModule.applyPendingBundle();
            this.log(`Bundle applied - version ${result.bundleVersion}`);
            // Restart the app
            if (RNRestartModule) {
                this.log('Restarting app...');
                RNRestartModule.restart();
            }
        }
        catch (error) {
            this.log(`Apply failed: ${error.message}`, 'error');
            this.updateState({
                status: types_1.UpdateStatus.ERROR,
                lastError: error.message,
            });
        }
    }
    /**
     * Notify that splash screen is visible.
     * This may trigger update application for SPLASH_VISIBLE timing.
     */
    notifySplashVisible() {
        this.log('Splash screen visible');
        this.isSplashVisible = true;
        if (this.state.hasPendingBundle && this.state.status === types_1.UpdateStatus.READY_TO_APPLY) {
            const manifest = this.state.availableManifest;
            if (!manifest || manifest.updatePolicy.timing === types_1.UpdateTiming.SPLASH_VISIBLE) {
                this.applyPendingBundle();
            }
        }
    }
    /**
     * Notify that splash screen is hidden.
     */
    notifySplashHidden() {
        this.isSplashVisible = false;
    }
    /**
     * Notify that we're in the reload window.
     * This may trigger update application for RELOAD_WINDOW timing.
     */
    notifyReloadWindow() {
        this.log('In reload window');
        this.isInReloadWindow = true;
        if (this.state.hasPendingBundle && this.state.status === types_1.UpdateStatus.READY_TO_APPLY) {
            const manifest = this.state.availableManifest;
            if (!manifest || manifest.updatePolicy.timing === types_1.UpdateTiming.RELOAD_WINDOW) {
                this.applyPendingBundle();
            }
        }
        // Reset flag after 1 minute
        setTimeout(() => {
            this.isInReloadWindow = false;
        }, 60000);
    }
    /**
     * Mark the current bundle as working (call after successful app load).
     */
    async markBundleAsWorking() {
        if (!OtaUpdateModule)
            return;
        try {
            await OtaUpdateModule.markBundleAsWorking();
            this.log('Bundle marked as working');
        }
        catch (error) {
            this.log(`Failed to mark bundle as working: ${error.message}`, 'error');
        }
    }
    /**
     * Get current bundle info from native module.
     */
    async getBundleInfo() {
        if (!OtaUpdateModule)
            return null;
        try {
            return await OtaUpdateModule.getCurrentBundleInfo();
        }
        catch (error) {
            this.log(`Failed to get bundle info: ${error.message}`, 'error');
            return null;
        }
    }
    /**
     * Rollback to the fallback bundle.
     */
    async rollbackToFallback() {
        if (!OtaUpdateModule)
            return false;
        try {
            await OtaUpdateModule.rollbackToFallback();
            this.log('Rolled back to fallback bundle');
            return true;
        }
        catch (error) {
            this.log(`Rollback failed: ${error.message}`, 'error');
            return false;
        }
    }
    // Private methods
    async initManifestUrl() {
        if (this.manifestUrl)
            return;
        const bundleInfo = await OtaUpdateModule.getCurrentBundleInfo();
        this.buildVersion = bundleInfo.buildVersion || 0;
        const baseUrl = `https://s3.${this.config.region}.amazonaws.com`;
        const platform = react_native_1.Platform.OS === 'ios' ? 'ios' : 'android';
        this.manifestUrl = `${baseUrl}/${this.config.bucket}/${this.config.appIdentifier}/${platform}/${this.buildVersion}/manifest.json`;
        this.log(`Manifest URL: ${this.manifestUrl}`);
    }
    async downloadUpdate(manifest) {
        try {
            this.updateState({
                status: types_1.UpdateStatus.DOWNLOADING,
                downloadProgress: 0,
            });
            this.log(`Downloading bundle from ${manifest.bundleUrl}`);
            await OtaUpdateModule.downloadBundle({
                bundleUrl: manifest.bundleUrl,
                bundleChecksum: manifest.bundleChecksum,
                bundleVersion: manifest.bundleVersion,
                bundleSize: manifest.bundleSize,
            });
            this.log('Bundle download complete');
            // Download assets if available
            if (manifest.assetsUrl) {
                this.log(`Downloading assets from ${manifest.assetsUrl}`);
                this.updateState({ downloadProgress: 100 });
                await OtaUpdateModule.downloadAssets({
                    assetsUrl: manifest.assetsUrl,
                });
                this.log('Assets download complete');
            }
            this.updateState({
                status: types_1.UpdateStatus.READY_TO_APPLY,
                downloadProgress: 100,
                hasPendingBundle: true,
            });
            this.tryApplyPendingBundle();
        }
        catch (error) {
            this.log(`Download failed: ${error.message}`, 'error');
            this.updateState({
                status: types_1.UpdateStatus.ERROR,
                lastError: error.message,
                downloadProgress: 0,
            });
        }
    }
    tryApplyPendingBundle() {
        const manifest = this.state.availableManifest;
        if (!manifest) {
            if (this.state.hasPendingBundle && this.canApplyNow(types_1.UpdateTiming.SPLASH_VISIBLE)) {
                this.applyPendingBundle();
            }
            return;
        }
        const timing = manifest.updatePolicy.timing;
        if (this.canApplyNow(timing)) {
            this.applyPendingBundle();
        }
        else {
            this.log(`Waiting for ${timing} to apply update`);
        }
    }
    canApplyNow(timing) {
        switch (timing) {
            case types_1.UpdateTiming.IMMEDIATE:
                return true;
            case types_1.UpdateTiming.SPLASH_VISIBLE:
                return this.isSplashVisible;
            case types_1.UpdateTiming.RELOAD_WINDOW:
                return this.isInReloadWindow || this.checkReloadWindow();
            default:
                return false;
        }
    }
    checkReloadWindow() {
        if (!this.reloadWindowConfig)
            return false;
        const now = new Date();
        const [startHour, startMin] = this.reloadWindowConfig.start.split(':').map(Number);
        const [endHour, endMin] = this.reloadWindowConfig.end.split(':').map(Number);
        const startTime = new Date(now);
        startTime.setHours(startHour, startMin, 0, 0);
        const endTime = new Date(now);
        endTime.setHours(endHour, endMin, 0, 0);
        return now >= startTime && now <= endTime;
    }
    setupProgressListener() {
        if (!this.eventEmitter)
            return;
        this.eventEmitter.addListener('OtaUpdateProgress', (event) => {
            this.updateState({
                downloadProgress: event.progress,
            });
            if (event.status === 'verifying') {
                this.log('Verifying checksum...');
            }
        });
    }
    updateState(partial) {
        this.state = { ...this.state, ...partial };
        this.listeners.forEach((listener) => listener(this.state));
    }
    log(message, level = 'debug') {
        const prefix = '[OtaUpdate]';
        if (this.config?.logger) {
            this.config.logger(`${prefix} ${message}`, level);
        }
        else {
            const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            logFn(`${prefix} ${message}`);
        }
    }
}
exports.OtaUpdateService = OtaUpdateService;
OtaUpdateService.instance = null;
// Export singleton getter for convenience
exports.getOtaUpdateService = OtaUpdateService.getInstance;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiT3RhVXBkYXRlU2VydmljZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9PdGFVcGRhdGVTZXJ2aWNlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLCtDQUF5RTtBQUN6RSxtQ0FTaUI7QUFFakIsTUFBTSxFQUFDLGVBQWUsRUFBRSxlQUFlLEVBQUMsR0FBRyw0QkFBYSxDQUFDO0FBRXpELE1BQU0seUJBQXlCLEdBQUcsQ0FBQyxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUMsQ0FBQyxZQUFZO0FBQzdELE1BQU0sY0FBYyxHQUFHLGNBQWMsQ0FBQztBQUV0QyxTQUFTLGtCQUFrQjtJQUN6QixPQUFPO1FBQ0wsTUFBTSxFQUFFLG9CQUFZLENBQUMsSUFBSTtRQUN6QixnQkFBZ0IsRUFBRSxDQUFDO1FBQ25CLG9CQUFvQixFQUFFLENBQUM7UUFDdkIsaUJBQWlCLEVBQUUsSUFBSTtRQUN2QixhQUFhLEVBQUUsSUFBSTtRQUNuQixTQUFTLEVBQUUsSUFBSTtRQUNmLG1CQUFtQixFQUFFLEtBQUs7UUFDMUIsZ0JBQWdCLEVBQUUsS0FBSztLQUN4QixDQUFDO0FBQ0osQ0FBQztBQUVELE1BQWEsZ0JBQWdCO0lBYzNCOztPQUVHO0lBQ0ksTUFBTSxDQUFDLFdBQVc7UUFDdkIsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQy9CLGdCQUFnQixDQUFDLFFBQVEsR0FBRyxJQUFJLGdCQUFnQixFQUFFLENBQUM7UUFDckQsQ0FBQztRQUNELE9BQU8sZ0JBQWdCLENBQUMsUUFBUSxDQUFDO0lBQ25DLENBQUM7SUFFRDtRQXZCUSxXQUFNLEdBQTJCLElBQUksQ0FBQztRQUN0QyxVQUFLLEdBQW1CLGtCQUFrQixFQUFFLENBQUM7UUFDN0MsY0FBUyxHQUEyQixJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQzlDLGtCQUFhLEdBQTBDLElBQUksQ0FBQztRQUM1RCxpQkFBWSxHQUE4QixJQUFJLENBQUM7UUFDL0MsZ0JBQVcs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Q0FBQyxDQUFDLEtBQUssS0FBSyxNQUFNLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7WUFDaEcsS0FBSyxDQUFDLEdBQUcsTUFBTSxJQUFJLE9BQU8sRUFBRSxDQUFDLENBQUM7UUFDaEMsQ0FBQztJQUNILENBQUM7O0FBcmNILDRDQXNjQztBQTFiZ0IseUJBQVEsR0FBNEIsSUFBSSxBQUFoQyxDQUFpQztBQTRiMUQsMENBQTBDO0FBQzdCLFFBQUEsbUJBQW1CLEdBQUcsZ0JBQWdCLENBQUMsV0FBVyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtOYXRpdmVNb2R1bGVzLCBOYXRpdmVFdmVudEVtaXR0ZXIsIFBsYXRmb3JtfSBmcm9tICdyZWFjdC1uYXRpdmUnO1xuaW1wb3J0IHtcbiAgQnVuZGxlTWFuaWZlc3QsXG4gIEJ1bmRsZUluZm8sXG4gIE90YVVwZGF0ZUNvbmZpZyxcbiAgT3RhVXBkYXRlU3RhdGUsXG4gIE90YVVwZGF0ZUxpc3RlbmVyLFxuICBVcGRhdGVTdGF0dXMsXG4gIFVwZGF0ZVRpbWluZyxcbiAgUmVsb2FkV2luZG93Q29uZmlnLFxufSBmcm9tICcuL3R5cGVzJztcblxuY29uc3Qge090YVVwZGF0ZU1vZHVsZSwgUk5SZXN0YXJ0TW9kdWxlfSA9IE5hdGl2ZU1vZHVsZXM7XG5cbmNvbnN0IERFRkFVTFRfQ0hFQ0tfSU5URVJWQUxfTVMgPSA1ICogNjAgKiAxMDAwOyAvLyA1IG1pbnV0ZXNcbmNvbnN0IERFRkFVTFRfUkVHSU9OID0gJ2V1LWNlbnRyYWwtMSc7XG5cbmZ1bmN0aW9uIGNyZWF0ZUluaXRpYWxTdGF0ZSgpOiBPdGFVcGRhdGVTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuSURMRSxcbiAgICBkb3dubG9hZFByb2dyZXNzOiAwLFxuICAgIGN1cnJlbnRCdW5kbGVWZXJzaW9uOiAwLFxuICAgIGF2YWlsYWJsZU1hbmlmZXN0OiBudWxsLFxuICAgIGxhc3RDaGVja1RpbWU6IG51bGwsXG4gICAgbGFzdEVycm9yOiBudWxsLFxuICAgIGlzVXNpbmdDdXN0b21CdW5kbGU6IGZhbHNlLFxuICAgIGhhc1BlbmRpbmdCdW5kbGU6IGZhbHNlLFxuICB9O1xufVxuXG5leHBvcnQgY2xhc3MgT3RhVXBkYXRlU2VydmljZSB7XG4gIHByaXZhdGUgY29uZmlnOiBPdGFVcGRhdGVDb25maWcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBzdGF0ZTogT3RhVXBkYXRlU3RhdGUgPSBjcmVhdGVJbml0aWFsU3RhdGUoKTtcbiAgcHJpdmF0ZSBsaXN0ZW5lcnM6IFNldDxPdGFVcGRhdGVMaXN0ZW5lcj4gPSBuZXcgU2V0KCk7XG4gIHByaXZhdGUgY2hlY2tJbnRlcnZhbDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgZXZlbnRFbWl0dGVyOiBOYXRpdmVFdmVudEVtaXR0ZXIgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtYW5pZmVzdFVybDogc3RyaW5nID0gJyc7XG4gIHByaXZhdGUgYnVpbGRWZXJzaW9uOiBudW1iZXIgPSAwO1xuICBwcml2YXRlIGlzU3BsYXNoVmlzaWJsZTogYm9vbGVhbiA9IGZhbHNlO1xuICBwcml2YXRlIGlzSW5SZWxvYWRXaW5kb3c6IGJvb2xlYW4gPSBmYWxzZTtcbiAgcHJpdmF0ZSByZWxvYWRXaW5kb3dDb25maWc6IFJlbG9hZFdpbmRvd0NvbmZpZyB8IG51bGwgPSBudWxsO1xuXG4gIHByaXZhdGUgc3RhdGljIGluc3RhbmNlOiBPdGFVcGRhdGVTZXJ2aWNlIHwgbnVsbCA9IG51bGw7XG5cbiAgLyoqXG4gICAqIEdldCB0aGUgc2luZ2xldG9uIGluc3RhbmNlXG4gICAqL1xuICBwdWJsaWMgc3RhdGljIGdldEluc3RhbmNlKCk6IE90YVVwZGF0ZVNlcnZpY2Uge1xuICAgIGlmICghT3RhVXBkYXRlU2VydmljZS5pbnN0YW5jZSkge1xuICAgICAgT3RhVXBkYXRlU2VydmljZS5pbnN0YW5jZSA9IG5ldyBPdGFVcGRhdGVTZXJ2aWNlKCk7XG4gICAgfVxuICAgIHJldHVybiBPdGFVcGRhdGVTZXJ2aWNlLmluc3RhbmNlO1xuICB9XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcigpIHtcbiAgICBpZiAoKFBsYXRmb3JtLk9TID09PSAnYW5kcm9pZCcgfHwgUGxhdGZvcm0uT1MgPT09ICdpb3MnKSAmJiBPdGFVcGRhdGVNb2R1bGUpIHtcbiAgICAgIHRoaXMuZXZlbnRFbWl0dGVyID0gbmV3IE5hdGl2ZUV2ZW50RW1pdHRlcihPdGFVcGRhdGVNb2R1bGUpO1xuICAgICAgdGhpcy5zZXR1cFByb2dyZXNzTGlzdGVuZXIoKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogQ29uZmlndXJlIHRoZSBPVEEgdXBkYXRlIHNlcnZpY2UuIE11c3QgYmUgY2FsbGVkIGJlZm9yZSBzdGFydCgpLlxuICAgKi9cbiAgcHVibGljIGNvbmZpZ3VyZShjb25maWc6IE90YVVwZGF0ZUNvbmZpZyk6IHZvaWQge1xuICAgIHRoaXMuY29uZmlnID0ge1xuICAgICAgLi4uY29uZmlnLFxuICAgICAgcmVnaW9uOiBjb25maWcucmVnaW9uIHx8IERFRkFVTFRfUkVHSU9OLFxuICAgICAgY2hlY2tJbnRlcnZhbE1zOiBjb25maWcuY2hlY2tJbnRlcnZhbE1zIHx8IERFRkFVTFRfQ0hFQ0tfSU5URVJWQUxfTVMsXG4gICAgfTtcbiAgICB0aGlzLmxvZyhgQ29uZmlndXJlZCB3aXRoIGJ1Y2tldDogJHtjb25maWcuYnVja2V0fSwgYXBwOiAke2NvbmZpZy5hcHBJZGVudGlmaWVyfWApO1xuICB9XG5cbiAgLyoqXG4gICAqIFNldCB0aGUgcmVsb2FkIHdpbmRvdyBjb25maWd1cmF0aW9uIGZvciBSRUxPQURfV0lORE9XIHRpbWluZy5cbiAgICovXG4gIHB1YmxpYyBzZXRSZWxvYWRXaW5kb3coY29uZmlnOiBSZWxvYWRXaW5kb3dDb25maWcpOiB2b2lkIHtcbiAgICB0aGlzLnJlbG9hZFdpbmRvd0NvbmZpZyA9IGNvbmZpZztcbiAgfVxuXG4gIC8qKlxuICAgKiBTdWJzY3JpYmUgdG8gc3RhdGUgY2hhbmdlcy5cbiAgICogUmV0dXJucyBhbiB1bnN1YnNjcmliZSBmdW5jdGlvbi5cbiAgICovXG4gIHB1YmxpYyBzdWJzY3JpYmUobGlzdGVuZXI6IE90YVVwZGF0ZUxpc3RlbmVyKTogKCkgPT4gdm9pZCB7XG4gICAgdGhpcy5saXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAvLyBJbW1lZGlhdGVseSBjYWxsIHdpdGggY3VycmVudCBzdGF0ZVxuICAgIGxpc3RlbmVyKHRoaXMuc3RhdGUpO1xuICAgIHJldHVybiAoKSA9PiB7XG4gICAgICB0aGlzLmxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogR2V0IGN1cnJlbnQgc3RhdGUuXG4gICAqL1xuICBwdWJsaWMgZ2V0U3RhdGUoKTogT3RhVXBkYXRlU3RhdGUge1xuICAgIHJldHVybiB7Li4udGhpcy5zdGF0ZX07XG4gIH1cblxuICAvKipcbiAgICogU3RhcnQgdGhlIE9UQSB1cGRhdGUgc2VydmljZS5cbiAgICogQ2hlY2tzIGZvciB1cGRhdGVzIGltbWVkaWF0ZWx5IGFuZCB0aGVuIHBlcmlvZGljYWxseS5cbiAgICovXG4gIHB1YmxpYyBzdGFydCgpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuY29uZmlnKSB7XG4gICAgICB0aGlzLmxvZygnQ2Fubm90IHN0YXJ0IC0gbm90IGNvbmZpZ3VyZWQuIENhbGwgY29uZmlndXJlKCkgZmlyc3QuJywgJ2Vycm9yJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKFBsYXRmb3JtLk9TICE9PSAnYW5kcm9pZCcgJiYgUGxhdGZvcm0uT1MgIT09ICdpb3MnKSB7XG4gICAgICB0aGlzLmxvZygnT1RBIHVwZGF0ZXMgb25seSBzdXBwb3J0ZWQgb24gQW5kcm9pZCBhbmQgaU9TJywgJ3dhcm4nKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICB0aGlzLmxvZyhgU3RhcnRpbmcgT1RBIHVwZGF0ZSBzZXJ2aWNlIG9uICR7UGxhdGZvcm0uT1N9Li4uYCk7XG5cbiAgICAvLyBJbml0aWFsIGNoZWNrXG4gICAgdGhpcy5jaGVja0ZvclVwZGF0ZSgpO1xuXG4gICAgLy8gUGVyaW9kaWMgY2hlY2tzXG4gICAgdGhpcy5jaGVja0ludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgICAgdGhpcy5jaGVja0ZvclVwZGF0ZSgpO1xuICAgIH0sIHRoaXMuY29uZmlnLmNoZWNrSW50ZXJ2YWxNcyEpO1xuICB9XG5cbiAgLyoqXG4gICAqIFN0b3AgdGhlIE9UQSB1cGRhdGUgc2VydmljZS5cbiAgICovXG4gIHB1YmxpYyBzdG9wKCk6IHZvaWQge1xuICAgIHRoaXMubG9nKCdTdG9wcGluZyBPVEEgdXBkYXRlIHNlcnZpY2UuLi4nKTtcbiAgICBpZiAodGhpcy5jaGVja0ludGVydmFsKSB7XG4gICAgICBjbGVhckludGVydmFsKHRoaXMuY2hlY2tJbnRlcnZhbCk7XG4gICAgICB0aGlzLmNoZWNrSW50ZXJ2YWwgPSBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBDaGVjayBmb3IgYXZhaWxhYmxlIHVwZGF0ZXMuXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgY2hlY2tGb3JVcGRhdGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZykge1xuICAgICAgdGhpcy5sb2coJ0Nhbm5vdCBjaGVjayAtIG5vdCBjb25maWd1cmVkJywgJ2Vycm9yJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCFPdGFVcGRhdGVNb2R1bGUpIHtcbiAgICAgIHRoaXMubG9nKCdOYXRpdmUgbW9kdWxlIG5vdCBhdmFpbGFibGUnLCAnd2FybicpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCB0aGlzLmluaXRNYW5pZmVzdFVybCgpO1xuXG4gICAgICB0aGlzLnVwZGF0ZVN0YXRlKHtcbiAgICAgICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuQ0hFQ0tJTkcsXG4gICAgICAgIGxhc3RFcnJvcjogbnVsbCxcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLmxvZyhgQ2hlY2tpbmcgZm9yIHVwZGF0ZXMgYXQgJHt0aGlzLm1hbmlmZXN0VXJsfWApO1xuXG4gICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHRoaXMubWFuaWZlc3RVcmwsIHtcbiAgICAgICAgbWV0aG9kOiAnR0VUJyxcbiAgICAgICAgaGVhZGVyczoge1xuICAgICAgICAgICdDYWNoZS1Db250cm9sJzogJ25vLWNhY2hlJyxcbiAgICAgICAgfSxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICAgIC8vIDQwNCA9IGZpbGUgbm90IGZvdW5kLCA0MDMgPSBhY2Nlc3MgZGVuaWVkIChTMyByZXR1cm5zIHRoaXMgd2hlbiBmaWxlIGRvZXNuJ3QgZXhpc3QgYW5kIG5vIExpc3RCdWNrZXQgcGVybWlzc2lvbilcbiAgICAgICAgLy8gQm90aCBtZWFuIG5vIE9UQSBtYW5pZmVzdCBleGlzdHMgZm9yIHRoaXMgYnVpbGQgLSB0aGlzIGlzIG5vcm1hbCwgbm90IGFuIGVycm9yXG4gICAgICAgIGlmIChyZXNwb25zZS5zdGF0dXMgPT09IDQwNCB8fCByZXNwb25zZS5zdGF0dXMgPT09IDQwMykge1xuICAgICAgICAgIHRoaXMubG9nKGBObyBPVEEgbWFuaWZlc3QgZm9yIGJ1aWxkICR7dGhpcy5idWlsZFZlcnNpb259IC0gdXNpbmcgYnVuZGxlZCBKU2ApO1xuICAgICAgICAgIHRoaXMudXBkYXRlU3RhdGUoe1xuICAgICAgICAgICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuSURMRSxcbiAgICAgICAgICAgIGxhc3RDaGVja1RpbWU6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfTogJHtyZXNwb25zZS5zdGF0dXNUZXh0fWApO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYW5pZmVzdDogQnVuZGxlTWFuaWZlc3QgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gICAgICB0aGlzLmxvZyhgTWFuaWZlc3QgcmVjZWl2ZWQgLSBidW5kbGVWZXJzaW9uOiAke21hbmlmZXN0LmJ1bmRsZVZlcnNpb259YCk7XG5cbiAgICAgIC8vIFZlcmlmeSBtYW5pZmVzdCBpcyBmb3IgdGhpcyBidWlsZFxuICAgICAgaWYgKG1hbmlmZXN0LmJ1aWxkVmVyc2lvbiAhPT0gdGhpcy5idWlsZFZlcnNpb24pIHtcbiAgICAgICAgdGhpcy5sb2coYE1hbmlmZXN0IGJ1aWxkVmVyc2lvbiAke21hbmlmZXN0LmJ1aWxkVmVyc2lvbn0gZG9lc24ndCBtYXRjaCBBUEsgJHt0aGlzLmJ1aWxkVmVyc2lvbn1gLCAnd2FybicpO1xuICAgICAgICB0aGlzLnVwZGF0ZVN0YXRlKHtcbiAgICAgICAgICBzdGF0dXM6IFVwZGF0ZVN0YXR1cy5JRExFLFxuICAgICAgICAgIGxhc3RDaGVja1RpbWU6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8gR2V0IGN1cnJlbnQgYnVuZGxlIGluZm9cbiAgICAgIGNvbnN0IGJ1bmRsZUluZm86IEJ1bmRsZUluZm8gPSBhd2FpdCBPdGFVcGRhdGVNb2R1bGUuZ2V0Q3VycmVudEJ1bmRsZUluZm8oKTtcbiAgICAgIGNvbnN0IGN1cnJlbnRCdW5kbGVWZXJzaW9uID0gYnVuZGxlSW5mby5jdXJyZW50QnVuZGxlVmVyc2lvbiB8fCAwO1xuXG4gICAgICB0aGlzLnVwZGF0ZVN0YXRlKHtcbiAgICAgICAgY3VycmVudEJ1bmRsZVZlcnNpb24sXG4gICAgICAgIGlzVXNpbmdDdXN0b21CdW5kbGU6IGJ1bmRsZUluZm8uaXNVc2luZ0N1c3RvbUJ1bmRsZSxcbiAgICAgICAgaGFzUGVuZGluZ0J1bmRsZTogYnVuZGxlSW5mby5oYXNQZW5kaW5nQnVuZGxlLFxuICAgICAgfSk7XG5cbiAgICAgIC8vIENoZWNrIGlmIHVwZGF0ZSBpcyBhdmFpbGFibGVcbiAgICAgIGlmIChtYW5pZmVzdC5idW5kbGVWZXJzaW9uID4gY3VycmVudEJ1bmRsZVZlcnNpb24pIHtcbiAgICAgICAgdGhpcy5sb2coYFVwZGF0ZSBhdmFpbGFibGU6ICR7Y3VycmVudEJ1bmRsZVZlcnNpb259IC0+ICR7bWFuaWZlc3QuYnVuZGxlVmVyc2lvbn1gKTtcbiAgICAgICAgdGhpcy51cGRhdGVTdGF0ZSh7XG4gICAgICAgICAgYXZhaWxhYmxlTWFuaWZlc3Q6IG1hbmlmZXN0LFxuICAgICAgICAgIGxhc3RDaGVja1RpbWU6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IHRoaXMuZG93bmxvYWRVcGRhdGUobWFuaWZlc3QpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdGhpcy5sb2coJ05vIHVwZGF0ZSBhdmFpbGFibGUnKTtcbiAgICAgICAgdGhpcy51cGRhdGVTdGF0ZSh7XG4gICAgICAgICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuSURMRSxcbiAgICAgICAgICBhdmFpbGFibGVNYW5pZmVzdDogbnVsbCxcbiAgICAgICAgICBsYXN0Q2hlY2tUaW1lOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChidW5kbGVJbmZvLmhhc1BlbmRpbmdCdW5kbGUpIHtcbiAgICAgICAgICB0aGlzLnRyeUFwcGx5UGVuZGluZ0J1bmRsZSgpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgdGhpcy5sb2coYENoZWNrIGZhaWxlZDogJHtlcnJvci5tZXNzYWdlfWAsICdlcnJvcicpO1xuICAgICAgdGhpcy51cGRhdGVTdGF0ZSh7XG4gICAgICAgIHN0YXR1czogVXBkYXRlU3RhdHVzLkVSUk9SLFxuICAgICAgICBsYXN0RXJyb3I6IGVycm9yLm1lc3NhZ2UsXG4gICAgICAgIGxhc3RDaGVja1RpbWU6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBBcHBseSBwZW5kaW5nIGJ1bmRsZSBhbmQgcmVzdGFydCB0aGUgYXBwLlxuICAgKi9cbiAgcHVibGljIGFzeW5jIGFwcGx5UGVuZGluZ0J1bmRsZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICB0cnkge1xuICAgICAgdGhpcy51cGRhdGVTdGF0ZSh7c3RhdHVzOiBVcGRhdGVTdGF0dXMuQVBQTFlJTkd9KTtcblxuICAgICAgdGhpcy5sb2coJ0FwcGx5aW5nIHBlbmRpbmcgYnVuZGxlLi4uJyk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBPdGFVcGRhdGVNb2R1bGUuYXBwbHlQZW5kaW5nQnVuZGxlKCk7XG4gICAgICB0aGlzLmxvZyhgQnVuZGxlIGFwcGxpZWQgLSB2ZXJzaW9uICR7cmVzdWx0LmJ1bmRsZVZlcnNpb259YCk7XG5cbiAgICAgIC8vIFJlc3RhcnQgdGhlIGFwcFxuICAgICAgaWYgKFJOUmVzdGFydE1vZHVsZSkge1xuICAgICAgICB0aGlzLmxvZygnUmVzdGFydGluZyBhcHAuLi4nKTtcbiAgICAgICAgUk5SZXN0YXJ0TW9kdWxlLnJlc3RhcnQoKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICB0aGlzLmxvZyhgQXBwbHkgZmFpbGVkOiAke2Vycm9yLm1lc3NhZ2V9YCwgJ2Vycm9yJyk7XG4gICAgICB0aGlzLnVwZGF0ZVN0YXRlKHtcbiAgICAgICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuRVJST1IsXG4gICAgICAgIGxhc3RFcnJvcjogZXJyb3IubWVzc2FnZSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBOb3RpZnkgdGhhdCBzcGxhc2ggc2NyZWVuIGlzIHZpc2libGUuXG4gICAqIFRoaXMgbWF5IHRyaWdnZXIgdXBkYXRlIGFwcGxpY2F0aW9uIGZvciBTUExBU0hfVklTSUJMRSB0aW1pbmcuXG4gICAqL1xuICBwdWJsaWMgbm90aWZ5U3BsYXNoVmlzaWJsZSgpOiB2b2lkIHtcbiAgICB0aGlzLmxvZygnU3BsYXNoIHNjcmVlbiB2aXNpYmxlJyk7XG4gICAgdGhpcy5pc1NwbGFzaFZpc2libGUgPSB0cnVlO1xuXG4gICAgaWYgKHRoaXMuc3RhdGUuaGFzUGVuZGluZ0J1bmRsZSAmJiB0aGlzLnN0YXRlLnN0YXR1cyA9PT0gVXBkYXRlU3RhdHVzLlJFQURZX1RPX0FQUExZKSB7XG4gICAgICBjb25zdCBtYW5pZmVzdCA9IHRoaXMuc3RhdGUuYXZhaWxhYmxlTWFuaWZlc3Q7XG4gICAgICBpZiAoIW1hbmlmZXN0IHx8IG1hbmlmZXN0LnVwZGF0ZVBvbGljeS50aW1pbmcgPT09IFVwZGF0ZVRpbWluZy5TUExBU0hfVklTSUJMRSkge1xuICAgICAgICB0aGlzLmFwcGx5UGVuZGluZ0J1bmRsZSgpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBOb3RpZnkgdGhhdCBzcGxhc2ggc2NyZWVuIGlzIGhpZGRlbi5cbiAgICovXG4gIHB1YmxpYyBub3RpZnlTcGxhc2hIaWRkZW4oKTogdm9pZCB7XG4gICAgdGhpcy5pc1NwbGFzaFZpc2libGUgPSBmYWxzZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBOb3RpZnkgdGhhdCB3ZSdyZSBpbiB0aGUgcmVsb2FkIHdpbmRvdy5cbiAgICogVGhpcyBtYXkgdHJpZ2dlciB1cGRhdGUgYXBwbGljYXRpb24gZm9yIFJFTE9BRF9XSU5ET1cgdGltaW5nLlxuICAgKi9cbiAgcHVibGljIG5vdGlmeVJlbG9hZFdpbmRvdygpOiB2b2lkIHtcbiAgICB0aGlzLmxvZygnSW4gcmVsb2FkIHdpbmRvdycpO1xuICAgIHRoaXMuaXNJblJlbG9hZFdpbmRvdyA9IHRydWU7XG5cbiAgICBpZiAodGhpcy5zdGF0ZS5oYXNQZW5kaW5nQnVuZGxlICYmIHRoaXMuc3RhdGUuc3RhdHVzID09PSBVcGRhdGVTdGF0dXMuUkVBRFlfVE9fQVBQTFkpIHtcbiAgICAgIGNvbnN0IG1hbmlmZXN0ID0gdGhpcy5zdGF0ZS5hdmFpbGFibGVNYW5pZmVzdDtcbiAgICAgIGlmICghbWFuaWZlc3QgfHwgbWFuaWZlc3QudXBkYXRlUG9saWN5LnRpbWluZyA9PT0gVXBkYXRlVGltaW5nLlJFTE9BRF9XSU5ET1cpIHtcbiAgICAgICAgdGhpcy5hcHBseVBlbmRpbmdCdW5kbGUoKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZXNldCBmbGFnIGFmdGVyIDEgbWludXRlXG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLmlzSW5SZWxvYWRXaW5kb3cgPSBmYWxzZTtcbiAgICB9LCA2MDAwMCk7XG4gIH1cblxuICAvKipcbiAgICogTWFyayB0aGUgY3VycmVudCBidW5kbGUgYXMgd29ya2luZyAoY2FsbCBhZnRlciBzdWNjZXNzZnVsIGFwcCBsb2FkKS5cbiAgICovXG4gIHB1YmxpYyBhc3luYyBtYXJrQnVuZGxlQXNXb3JraW5nKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGlmICghT3RhVXBkYXRlTW9kdWxlKSByZXR1cm47XG5cbiAgICB0cnkge1xuICAgICAgYXdhaXQgT3RhVXBkYXRlTW9kdWxlLm1hcmtCdW5kbGVBc1dvcmtpbmcoKTtcbiAgICAgIHRoaXMubG9nKCdCdW5kbGUgbWFya2VkIGFzIHdvcmtpbmcnKTtcbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICB0aGlzLmxvZyhgRmFpbGVkIHRvIG1hcmsgYnVuZGxlIGFzIHdvcmtpbmc6ICR7ZXJyb3IubWVzc2FnZX1gLCAnZXJyb3InKTtcbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogR2V0IGN1cnJlbnQgYnVuZGxlIGluZm8gZnJvbSBuYXRpdmUgbW9kdWxlLlxuICAgKi9cbiAgcHVibGljIGFzeW5jIGdldEJ1bmRsZUluZm8oKTogUHJvbWlzZTxCdW5kbGVJbmZvIHwgbnVsbD4ge1xuICAgIGlmICghT3RhVXBkYXRlTW9kdWxlKSByZXR1cm4gbnVsbDtcblxuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgT3RhVXBkYXRlTW9kdWxlLmdldEN1cnJlbnRCdW5kbGVJbmZvKCk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgdGhpcy5sb2coYEZhaWxlZCB0byBnZXQgYnVuZGxlIGluZm86ICR7ZXJyb3IubWVzc2FnZX1gLCAnZXJyb3InKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSb2xsYmFjayB0byB0aGUgZmFsbGJhY2sgYnVuZGxlLlxuICAgKi9cbiAgcHVibGljIGFzeW5jIHJvbGxiYWNrVG9GYWxsYmFjaygpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgICBpZiAoIU90YVVwZGF0ZU1vZHVsZSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IE90YVVwZGF0ZU1vZHVsZS5yb2xsYmFja1RvRmFsbGJhY2soKTtcbiAgICAgIHRoaXMubG9nKCdSb2xsZWQgYmFjayB0byBmYWxsYmFjayBidW5kbGUnKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIHRoaXMubG9nKGBSb2xsYmFjayBmYWlsZWQ6ICR7ZXJyb3IubWVzc2FnZX1gLCAnZXJyb3InKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH1cblxuICAvLyBQcml2YXRlIG1ldGhvZHNcblxuICBwcml2YXRlIGFzeW5jIGluaXRNYW5pZmVzdFVybCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBpZiAodGhpcy5tYW5pZmVzdFVybCkgcmV0dXJuO1xuXG4gICAgY29uc3QgYnVuZGxlSW5mbzogQnVuZGxlSW5mbyA9IGF3YWl0IE90YVVwZGF0ZU1vZHVsZS5nZXRDdXJyZW50QnVuZGxlSW5mbygpO1xuICAgIHRoaXMuYnVpbGRWZXJzaW9uID0gYnVuZGxlSW5mby5idWlsZFZlcnNpb24gfHwgMDtcblxuICAgIGNvbnN0IGJhc2VVcmwgPSBgaHR0cHM6Ly9zMy4ke3RoaXMuY29uZmlnIS5yZWdpb259LmFtYXpvbmF3cy5jb21gO1xuICAgIGNvbnN0IHBsYXRmb3JtID0gUGxhdGZvcm0uT1MgPT09ICdpb3MnID8gJ2lvcycgOiAnYW5kcm9pZCc7XG4gICAgdGhpcy5tYW5pZmVzdFVybCA9IGAke2Jhc2VVcmx9LyR7dGhpcy5jb25maWchLmJ1Y2tldH0vJHt0aGlzLmNvbmZpZyEuYXBwSWRlbnRpZmllcn0vJHtwbGF0Zm9ybX0vJHt0aGlzLmJ1aWxkVmVyc2lvbn0vbWFuaWZlc3QuanNvbmA7XG5cbiAgICB0aGlzLmxvZyhgTWFuaWZlc3QgVVJMOiAke3RoaXMubWFuaWZlc3RVcmx9YCk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIGRvd25sb2FkVXBkYXRlKG1hbmlmZXN0OiBCdW5kbGVNYW5pZmVzdCk6IFByb21pc2U8dm9pZD4ge1xuICAgIHRyeSB7XG4gICAgICB0aGlzLnVwZGF0ZVN0YXRlKHtcbiAgICAgICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuRE9XTkxPQURJTkcsXG4gICAgICAgIGRvd25sb2FkUHJvZ3Jlc3M6IDAsXG4gICAgICB9KTtcblxuICAgICAgdGhpcy5sb2coYERvd25sb2FkaW5nIGJ1bmRsZSBmcm9tICR7bWFuaWZlc3QuYnVuZGxlVXJsfWApO1xuXG4gICAgICBhd2FpdCBPdGFVcGRhdGVNb2R1bGUuZG93bmxvYWRCdW5kbGUoe1xuICAgICAgICBidW5kbGVVcmw6IG1hbmlmZXN0LmJ1bmRsZVVybCxcbiAgICAgICAgYnVuZGxlQ2hlY2tzdW06IG1hbmlmZXN0LmJ1bmRsZUNoZWNrc3VtLFxuICAgICAgICBidW5kbGVWZXJzaW9uOiBtYW5pZmVzdC5idW5kbGVWZXJzaW9uLFxuICAgICAgICBidW5kbGVTaXplOiBtYW5pZmVzdC5idW5kbGVTaXplLFxuICAgICAgfSk7XG5cbiAgICAgIHRoaXMubG9nKCdCdW5kbGUgZG93bmxvYWQgY29tcGxldGUnKTtcblxuICAgICAgLy8gRG93bmxvYWQgYXNzZXRzIGlmIGF2YWlsYWJsZVxuICAgICAgaWYgKG1hbmlmZXN0LmFzc2V0c1VybCkge1xuICAgICAgICB0aGlzLmxvZyhgRG93bmxvYWRpbmcgYXNzZXRzIGZyb20gJHttYW5pZmVzdC5hc3NldHNVcmx9YCk7XG4gICAgICAgIHRoaXMudXBkYXRlU3RhdGUoe2Rvd25sb2FkUHJvZ3Jlc3M6IDEwMH0pO1xuICAgICAgICBhd2FpdCBPdGFVcGRhdGVNb2R1bGUuZG93bmxvYWRBc3NldHMoe1xuICAgICAgICAgIGFzc2V0c1VybDogbWFuaWZlc3QuYXNzZXRzVXJsLFxuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5sb2coJ0Fzc2V0cyBkb3dubG9hZCBjb21wbGV0ZScpO1xuICAgICAgfVxuXG4gICAgICB0aGlzLnVwZGF0ZVN0YXRlKHtcbiAgICAgICAgc3RhdHVzOiBVcGRhdGVTdGF0dXMuUkVBRFlfVE9fQVBQTFksXG4gICAgICAgIGRvd25sb2FkUHJvZ3Jlc3M6IDEwMCxcbiAgICAgICAgaGFzUGVuZGluZ0J1bmRsZTogdHJ1ZSxcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLnRyeUFwcGx5UGVuZGluZ0J1bmRsZSgpO1xuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIHRoaXMubG9nKGBEb3dubG9hZCBmYWlsZWQ6ICR7ZXJyb3IubWVzc2FnZX1gLCAnZXJyb3InKTtcbiAgICAgIHRoaXMudXBkYXRlU3RhdGUoe1xuICAgICAgICBzdGF0dXM6IFVwZGF0ZVN0YXR1cy5FUlJPUixcbiAgICAgICAgbGFzdEVycm9yOiBlcnJvci5tZXNzYWdlLFxuICAgICAgICBkb3dubG9hZFByb2dyZXNzOiAwLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSB0cnlBcHBseVBlbmRpbmdCdW5kbGUoKTogdm9pZCB7XG4gICAgY29uc3QgbWFuaWZlc3QgPSB0aGlzLnN0YXRlLmF2YWlsYWJsZU1hbmlmZXN0O1xuXG4gICAgaWYgKCFtYW5pZmVzdCkge1xuICAgICAgaWYgKHRoaXMuc3RhdGUuaGFzUGVuZGluZ0J1bmRsZSAmJiB0aGlzLmNhbkFwcGx5Tm93KFVwZGF0ZVRpbWluZy5TUExBU0hfVklTSUJMRSkpIHtcbiAgICAgICAgdGhpcy5hcHBseVBlbmRpbmdCdW5kbGUoKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB0aW1pbmcgPSBtYW5pZmVzdC51cGRhdGVQb2xpY3kudGltaW5nO1xuXG4gICAgaWYgKHRoaXMuY2FuQXBwbHlOb3codGltaW5nKSkge1xuICAgICAgdGhpcy5hcHBseVBlbmRpbmdCdW5kbGUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb2coYFdhaXRpbmcgZm9yICR7dGltaW5nfSB0byBhcHBseSB1cGRhdGVgKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNhbkFwcGx5Tm93KHRpbWluZzogVXBkYXRlVGltaW5nKTogYm9vbGVhbiB7XG4gICAgc3dpdGNoICh0aW1pbmcpIHtcbiAgICAgIGNhc2UgVXBkYXRlVGltaW5nLklNTUVESUFURTpcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICBjYXNlIFVwZGF0ZVRpbWluZy5TUExBU0hfVklTSUJMRTpcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNTcGxhc2hWaXNpYmxlO1xuICAgICAgY2FzZSBVcGRhdGVUaW1pbmcuUkVMT0FEX1dJTkRPVzpcbiAgICAgICAgcmV0dXJuIHRoaXMuaXNJblJlbG9hZFdpbmRvdyB8fCB0aGlzLmNoZWNrUmVsb2FkV2luZG93KCk7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjaGVja1JlbG9hZFdpbmRvdygpOiBib29sZWFuIHtcbiAgICBpZiAoIXRoaXMucmVsb2FkV2luZG93Q29uZmlnKSByZXR1cm4gZmFsc2U7XG5cbiAgICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpO1xuICAgIGNvbnN0IFtzdGFydEhvdXIsIHN0YXJ0TWluXSA9IHRoaXMucmVsb2FkV2luZG93Q29uZmlnLnN0YXJ0LnNwbGl0KCc6JykubWFwKE51bWJlcik7XG4gICAgY29uc3QgW2VuZEhvdXIsIGVuZE1pbl0gPSB0aGlzLnJlbG9hZFdpbmRvd0NvbmZpZy5lbmQuc3BsaXQoJzonKS5tYXAoTnVtYmVyKTtcblxuICAgIGNvbnN0IHN0YXJ0VGltZSA9IG5ldyBEYXRlKG5vdyk7XG4gICAgc3RhcnRUaW1lLnNldEhvdXJzKHN0YXJ0SG91ciwgc3RhcnRNaW4sIDAsIDApO1xuXG4gICAgY29uc3QgZW5kVGltZSA9IG5ldyBEYXRlKG5vdyk7XG4gICAgZW5kVGltZS5zZXRIb3VycyhlbmRIb3VyLCBlbmRNaW4sIDAsIDApO1xuXG4gICAgcmV0dXJuIG5vdyA+PSBzdGFydFRpbWUgJiYgbm93IDw9IGVuZFRpbWU7XG4gIH1cblxuICBwcml2YXRlIHNldHVwUHJvZ3Jlc3NMaXN0ZW5lcigpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuZXZlbnRFbWl0dGVyKSByZXR1cm47XG5cbiAgICB0aGlzLmV2ZW50RW1pdHRlci5hZGRMaXN0ZW5lcignT3RhVXBkYXRlUHJvZ3Jlc3MnLCAoZXZlbnQpID0+IHtcbiAgICAgIHRoaXMudXBkYXRlU3RhdGUoe1xuICAgICAgICBkb3dubG9hZFByb2dyZXNzOiBldmVudC5wcm9ncmVzcyxcbiAgICAgIH0pO1xuXG4gICAgICBpZiAoZXZlbnQuc3RhdHVzID09PSAndmVyaWZ5aW5nJykge1xuICAgICAgICB0aGlzLmxvZygnVmVyaWZ5aW5nIGNoZWNrc3VtLi4uJyk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIHVwZGF0ZVN0YXRlKHBhcnRpYWw6IFBhcnRpYWw8T3RhVXBkYXRlU3RhdGU+KTogdm9pZCB7XG4gICAgdGhpcy5zdGF0ZSA9IHsuLi50aGlzLnN0YXRlLCAuLi5wYXJ0aWFsfTtcbiAgICB0aGlzLmxpc3RlbmVycy5mb3JFYWNoKChsaXN0ZW5lcikgPT4gbGlzdGVuZXIodGhpcy5zdGF0ZSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBsb2cobWVzc2FnZTogc3RyaW5nLCBsZXZlbDogJ2RlYnVnJyB8ICdpbmZvJyB8ICd3YXJuJyB8ICdlcnJvcicgPSAnZGVidWcnKTogdm9pZCB7XG4gICAgY29uc3QgcHJlZml4ID0gJ1tPdGFVcGRhdGVdJztcbiAgICBpZiAodGhpcy5jb25maWc/LmxvZ2dlcikge1xuICAgICAgdGhpcy5jb25maWcubG9nZ2VyKGAke3ByZWZpeH0gJHttZXNzYWdlfWAsIGxldmVsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgbG9nRm4gPSBsZXZlbCA9PT0gJ2Vycm9yJyA/IGNvbnNvbGUuZXJyb3IgOiBsZXZlbCA9PT0gJ3dhcm4nID8gY29uc29sZS53YXJuIDogY29uc29sZS5sb2c7XG4gICAgICBsb2dGbihgJHtwcmVmaXh9ICR7bWVzc2FnZX1gKTtcbiAgICB9XG4gIH1cbn1cblxuLy8gRXhwb3J0IHNpbmdsZXRvbiBnZXR0ZXIgZm9yIGNvbnZlbmllbmNlXG5leHBvcnQgY29uc3QgZ2V0T3RhVXBkYXRlU2VydmljZSA9IE90YVVwZGF0ZVNlcnZpY2UuZ2V0SW5zdGFuY2U7XG4iXX0=