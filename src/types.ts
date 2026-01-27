export enum UpdateTiming {
  IMMEDIATE = 'immediate',
  RELOAD_WINDOW = 'reload_window',
  SPLASH_VISIBLE = 'splash_visible',
}

export enum UpdateStatus {
  IDLE = 'idle',
  CHECKING = 'checking',
  DOWNLOADING = 'downloading',
  READY_TO_APPLY = 'ready_to_apply',
  APPLYING = 'applying',
  ERROR = 'error',
}

export interface BundleManifest {
  version: string;
  buildVersion: number;
  bundleVersion: number;
  bundleUrl: string;
  bundleChecksum: string;
  bundleSize: number;
  assetsUrl?: string;
  assetsChecksum?: string;
  assetsSize?: number;
  releaseDate: string;
  updatePolicy: {
    timing: UpdateTiming;
    forceUpdate: boolean;
  };
  hermesEnabled: boolean;
  releaseNotes?: string;
}

export interface OtaUpdateState {
  status: UpdateStatus;
  downloadProgress: number;
  currentBundleVersion: number;
  availableManifest: BundleManifest | null;
  lastCheckTime: string | null;
  lastError: string | null;
  isUsingCustomBundle: boolean;
  hasPendingBundle: boolean;
}

export interface OtaUpdateConfig {
  /** S3 bucket name */
  bucket: string;
  /** AWS region (default: eu-central-1) */
  region?: string;
  /** App identifier used in S3 path (e.g., 'bessakiosk') */
  appIdentifier: string;
  /** Check interval in milliseconds (default: 5 minutes) */
  checkIntervalMs?: number;
  /** Optional logger function */
  logger?: (message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void;
}

export interface BundleInfo {
  buildVersion: number;
  currentBundleVersion: number;
  hasActiveBundle: boolean;
  hasPendingBundle: boolean;
  hasFallbackBundle: boolean;
  pendingVersion: number;
  isUsingCustomBundle: boolean;
}

export interface ReloadWindowConfig {
  start: string; // HH:mm format
  end: string;   // HH:mm format
}

export type OtaUpdateListener = (state: OtaUpdateState) => void;
