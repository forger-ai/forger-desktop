export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'unsupported'
  | 'error';

export interface DesktopUpdateReleaseNotes {
  summary?: string;
  changes: string[];
}

export interface DesktopUpdateAsset {
  platform: string;
  arch: string;
  kind: string;
  url: string;
  sha256?: string;
  size?: number;
  experimental?: boolean;
}

export interface DesktopUpdateMetadata {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  releaseNotes: DesktopUpdateReleaseNotes;
  assets: DesktopUpdateAsset[];
}

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  publishedAt?: string;
  releaseNotes?: DesktopUpdateReleaseNotes;
  asset?: DesktopUpdateAsset;
  downloadedPath?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  userMessage?: string;
  technicalCode?: string;
}
