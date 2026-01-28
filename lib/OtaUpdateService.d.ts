import { BundleInfo, OtaUpdateConfig, OtaUpdateState, OtaUpdateListener, ReloadWindowConfig } from './types';
export declare class OtaUpdateService {
    private config;
    private state;
    private listeners;
    private checkInterval;
    private eventEmitter;
    private manifestUrl;
    private buildVersion;
    private isSplashVisible;
    private isInReloadWindow;
    private reloadWindowConfig;
    private static instance;
    /**
     * Get the singleton instance
     */
    static getInstance(): OtaUpdateService;
    private constructor();
    /**
     * Configure the OTA update service. Must be called before start().
     */
    configure(config: OtaUpdateConfig): void;
    /**
     * Set the reload window configuration for RELOAD_WINDOW timing.
     */
    setReloadWindow(config: ReloadWindowConfig): void;
    /**
     * Subscribe to state changes.
     * Returns an unsubscribe function.
     */
    subscribe(listener: OtaUpdateListener): () => void;
    /**
     * Get current state.
     */
    getState(): OtaUpdateState;
    /**
     * Start the OTA update service.
     * Checks for updates immediately and then periodically.
     */
    start(): void;
    /**
     * Stop the OTA update service.
     */
    stop(): void;
    /**
     * Check for available updates.
     */
    checkForUpdate(): Promise<void>;
    /**
     * Apply pending bundle and restart the app.
     */
    applyPendingBundle(): Promise<void>;
    /**
     * Notify that splash screen is visible.
     * This may trigger update application for SPLASH_VISIBLE timing.
     */
    notifySplashVisible(): void;
    /**
     * Notify that splash screen is hidden.
     */
    notifySplashHidden(): void;
    /**
     * Notify that we're in the reload window.
     * This may trigger update application for RELOAD_WINDOW timing.
     */
    notifyReloadWindow(): void;
    /**
     * Mark the current bundle as working (call after successful app load).
     */
    markBundleAsWorking(): Promise<void>;
    /**
     * Get current bundle info from native module.
     */
    getBundleInfo(): Promise<BundleInfo | null>;
    /**
     * Rollback to the fallback bundle.
     */
    rollbackToFallback(): Promise<boolean>;
    private initManifestUrl;
    private downloadUpdate;
    private tryApplyPendingBundle;
    private canApplyNow;
    private checkReloadWindow;
    private setupProgressListener;
    private updateState;
    private log;
}
export declare const getOtaUpdateService: typeof OtaUpdateService.getInstance;
