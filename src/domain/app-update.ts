export type AppUpdatePhase = 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';

export interface AppUpdateState {
  phase: AppUpdatePhase;
  currentVersion: string;
  version?: string;
  received?: number;
  total?: number;
  error?: string;
}

export interface AppUpdateAsset {
  platform: 'macos' | 'windows';
  architecture: 'arm64' | 'x64';
  kind: 'app-zip' | 'nsis';
  url: string;
  sha256: string;
  size: number;
}

export interface AppUpdateManifest {
  version: string;
  assets: AppUpdateAsset[];
}

export const APP_UPDATE_REPOSITORY = 'Fanch-hui/multi-ai-work';
export const APP_UPDATE_FEED = `https://github.com/${APP_UPDATE_REPOSITORY}/releases/latest/download/latest.json`;
