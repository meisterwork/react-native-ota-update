import {NativeModules, NativeEventEmitter, Platform} from 'react-native';
import {
  BundleManifest,
  BundleInfo,
  OtaUpdateConfig,
  OtaUpdateState,
  OtaUpdateListener,
  UpdateStatus,
  UpdateTiming,
  ReloadWindowConfig,
} from './types';

const {OtaUpdateModule, RNRestartModule} = NativeModules;

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_REGION = 'eu-central-1';

function createInitialState(): OtaUpdateState {
  return {
    status: UpdateStatus.IDLE,
    downloadProgress: 0,
    currentBundleVersion: 0,
    availableManifest: null,
    lastCheckTime: null,
    lastError: null,
    isUsingCustomBundle: false,
    hasPendingBundle: false,
  };
}

export class OtaUpdateService {
  private config: OtaUpdateConfig | null = null;
  private state: OtaUpdateState = createInitialState();
  private listeners: Set<OtaUpdateListener> = new Set();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private eventEmitter: NativeEventEmitter | null = null;
  private manifestUrl: string = '';
  private buildVersion: number = 0;
  private isSplashVisible: boolean = false;
  private isInReloadWindow: boolean = false;
  private reloadWindowConfig: ReloadWindowConfig | null = null;

  private static instance: OtaUpdateService | null = null;

  /**
   * Get the singleton instance
   */
  public static getInstance(): OtaUpdateService {
    if (!OtaUpdateService.instance) {
      OtaUpdateService.instance = new OtaUpdateService();
    }
    return OtaUpdateService.instance;
  }

  private constructor() {
    if ((Platform.OS === 'android' || Platform.OS === 'ios') && OtaUpdateModule) {
      this.eventEmitter = new NativeEventEmitter(OtaUpdateModule);
      this.setupProgressListener();
    }
  }

  /**
   * Configure the OTA update service. Must be called before start().
   */
  public configure(config: OtaUpdateConfig): void {
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
  public setReloadWindow(config: ReloadWindowConfig): void {
    this.reloadWindowConfig = config;
  }

  /**
   * Subscribe to state changes.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: OtaUpdateListener): () => void {
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
  public getState(): OtaUpdateState {
    return {...this.state};
  }

  /**
   * Start the OTA update service.
   * Checks for updates immediately and then periodically.
   */
  public start(): void {
    if (!this.config) {
      this.log('Cannot start - not configured. Call configure() first.', 'error');
      return;
    }

    if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
      this.log('OTA updates only supported on Android and iOS', 'warn');
      return;
    }

    this.log(`Starting OTA update service on ${Platform.OS}...`);

    // Initial check
    this.checkForUpdate();

    // Periodic checks
    this.checkInterval = setInterval(() => {
      this.checkForUpdate();
    }, this.config.checkIntervalMs!);
  }

  /**
   * Stop the OTA update service.
   */
  public stop(): void {
    this.log('Stopping OTA update service...');
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Check for available updates.
   */
  public async checkForUpdate(): Promise<void> {
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
        status: UpdateStatus.CHECKING,
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
        if (response.status === 404) {
          this.log(`No manifest found for build ${this.buildVersion}`);
          this.updateState({
            status: UpdateStatus.IDLE,
            lastCheckTime: new Date().toISOString(),
          });
          return;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const manifest: BundleManifest = await response.json();
      this.log(`Manifest received - bundleVersion: ${manifest.bundleVersion}`);

      // Verify manifest is for this build
      if (manifest.buildVersion !== this.buildVersion) {
        this.log(`Manifest buildVersion ${manifest.buildVersion} doesn't match APK ${this.buildVersion}`, 'warn');
        this.updateState({
          status: UpdateStatus.IDLE,
          lastCheckTime: new Date().toISOString(),
        });
        return;
      }

      // Get current bundle info
      const bundleInfo: BundleInfo = await OtaUpdateModule.getCurrentBundleInfo();
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
      } else {
        this.log('No update available');
        this.updateState({
          status: UpdateStatus.IDLE,
          availableManifest: null,
          lastCheckTime: new Date().toISOString(),
        });

        if (bundleInfo.hasPendingBundle) {
          this.tryApplyPendingBundle();
        }
      }
    } catch (error: any) {
      this.log(`Check failed: ${error.message}`, 'error');
      this.updateState({
        status: UpdateStatus.ERROR,
        lastError: error.message,
        lastCheckTime: new Date().toISOString(),
      });
    }
  }

  /**
   * Apply pending bundle and restart the app.
   */
  public async applyPendingBundle(): Promise<void> {
    try {
      this.updateState({status: UpdateStatus.APPLYING});

      this.log('Applying pending bundle...');
      const result = await OtaUpdateModule.applyPendingBundle();
      this.log(`Bundle applied - version ${result.bundleVersion}`);

      // Restart the app
      if (RNRestartModule) {
        this.log('Restarting app...');
        RNRestartModule.restart();
      }
    } catch (error: any) {
      this.log(`Apply failed: ${error.message}`, 'error');
      this.updateState({
        status: UpdateStatus.ERROR,
        lastError: error.message,
      });
    }
  }

  /**
   * Notify that splash screen is visible.
   * This may trigger update application for SPLASH_VISIBLE timing.
   */
  public notifySplashVisible(): void {
    this.log('Splash screen visible');
    this.isSplashVisible = true;

    if (this.state.hasPendingBundle && this.state.status === UpdateStatus.READY_TO_APPLY) {
      const manifest = this.state.availableManifest;
      if (!manifest || manifest.updatePolicy.timing === UpdateTiming.SPLASH_VISIBLE) {
        this.applyPendingBundle();
      }
    }
  }

  /**
   * Notify that splash screen is hidden.
   */
  public notifySplashHidden(): void {
    this.isSplashVisible = false;
  }

  /**
   * Notify that we're in the reload window.
   * This may trigger update application for RELOAD_WINDOW timing.
   */
  public notifyReloadWindow(): void {
    this.log('In reload window');
    this.isInReloadWindow = true;

    if (this.state.hasPendingBundle && this.state.status === UpdateStatus.READY_TO_APPLY) {
      const manifest = this.state.availableManifest;
      if (!manifest || manifest.updatePolicy.timing === UpdateTiming.RELOAD_WINDOW) {
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
  public async markBundleAsWorking(): Promise<void> {
    if (!OtaUpdateModule) return;

    try {
      await OtaUpdateModule.markBundleAsWorking();
      this.log('Bundle marked as working');
    } catch (error: any) {
      this.log(`Failed to mark bundle as working: ${error.message}`, 'error');
    }
  }

  /**
   * Get current bundle info from native module.
   */
  public async getBundleInfo(): Promise<BundleInfo | null> {
    if (!OtaUpdateModule) return null;

    try {
      return await OtaUpdateModule.getCurrentBundleInfo();
    } catch (error: any) {
      this.log(`Failed to get bundle info: ${error.message}`, 'error');
      return null;
    }
  }

  /**
   * Rollback to the fallback bundle.
   */
  public async rollbackToFallback(): Promise<boolean> {
    if (!OtaUpdateModule) return false;

    try {
      await OtaUpdateModule.rollbackToFallback();
      this.log('Rolled back to fallback bundle');
      return true;
    } catch (error: any) {
      this.log(`Rollback failed: ${error.message}`, 'error');
      return false;
    }
  }

  // Private methods

  private async initManifestUrl(): Promise<void> {
    if (this.manifestUrl) return;

    const bundleInfo: BundleInfo = await OtaUpdateModule.getCurrentBundleInfo();
    this.buildVersion = bundleInfo.buildVersion || 0;

    const baseUrl = `https://s3.${this.config!.region}.amazonaws.com`;
    const platform = Platform.OS === 'ios' ? 'ios' : 'android';
    this.manifestUrl = `${baseUrl}/${this.config!.bucket}/${this.config!.appIdentifier}/${platform}/${this.buildVersion}/manifest.json`;

    this.log(`Manifest URL: ${this.manifestUrl}`);
  }

  private async downloadUpdate(manifest: BundleManifest): Promise<void> {
    try {
      this.updateState({
        status: UpdateStatus.DOWNLOADING,
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
        this.updateState({downloadProgress: 100});
        await OtaUpdateModule.downloadAssets({
          assetsUrl: manifest.assetsUrl,
        });
        this.log('Assets download complete');
      }

      this.updateState({
        status: UpdateStatus.READY_TO_APPLY,
        downloadProgress: 100,
        hasPendingBundle: true,
      });

      this.tryApplyPendingBundle();
    } catch (error: any) {
      this.log(`Download failed: ${error.message}`, 'error');
      this.updateState({
        status: UpdateStatus.ERROR,
        lastError: error.message,
        downloadProgress: 0,
      });
    }
  }

  private tryApplyPendingBundle(): void {
    const manifest = this.state.availableManifest;

    if (!manifest) {
      if (this.state.hasPendingBundle && this.canApplyNow(UpdateTiming.SPLASH_VISIBLE)) {
        this.applyPendingBundle();
      }
      return;
    }

    const timing = manifest.updatePolicy.timing;

    if (this.canApplyNow(timing)) {
      this.applyPendingBundle();
    } else {
      this.log(`Waiting for ${timing} to apply update`);
    }
  }

  private canApplyNow(timing: UpdateTiming): boolean {
    switch (timing) {
      case UpdateTiming.IMMEDIATE:
        return true;
      case UpdateTiming.SPLASH_VISIBLE:
        return this.isSplashVisible;
      case UpdateTiming.RELOAD_WINDOW:
        return this.isInReloadWindow || this.checkReloadWindow();
      default:
        return false;
    }
  }

  private checkReloadWindow(): boolean {
    if (!this.reloadWindowConfig) return false;

    const now = new Date();
    const [startHour, startMin] = this.reloadWindowConfig.start.split(':').map(Number);
    const [endHour, endMin] = this.reloadWindowConfig.end.split(':').map(Number);

    const startTime = new Date(now);
    startTime.setHours(startHour, startMin, 0, 0);

    const endTime = new Date(now);
    endTime.setHours(endHour, endMin, 0, 0);

    return now >= startTime && now <= endTime;
  }

  private setupProgressListener(): void {
    if (!this.eventEmitter) return;

    this.eventEmitter.addListener('OtaUpdateProgress', (event) => {
      this.updateState({
        downloadProgress: event.progress,
      });

      if (event.status === 'verifying') {
        this.log('Verifying checksum...');
      }
    });
  }

  private updateState(partial: Partial<OtaUpdateState>): void {
    this.state = {...this.state, ...partial};
    this.listeners.forEach((listener) => listener(this.state));
  }

  private log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): void {
    const prefix = '[OtaUpdate]';
    if (this.config?.logger) {
      this.config.logger(`${prefix} ${message}`, level);
    } else {
      const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      logFn(`${prefix} ${message}`);
    }
  }
}

// Export singleton getter for convenience
export const getOtaUpdateService = OtaUpdateService.getInstance;
