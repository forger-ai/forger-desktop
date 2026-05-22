import type { AppStatus } from './catalog';
import type { BasicActionResult, FailureDiagnosticFields } from './base';

export interface AppAiSubscriptionStatus {
  connected: boolean;
}

export interface MockActionResult {
  ok: true;
}

export type InstallPhase =
  | 'starting'
  | 'downloading'
  | 'extracting'
  | 'preparing_runtime'
  | 'installing_backend'
  | 'installing_frontend'
  | 'checking_update'
  | 'updating_base'
  | 'merging_user_changes'
  | 'conflict'
  | 'completed'
  | 'failed';

export interface InstallAppResult extends FailureDiagnosticFields {
  success: boolean;
  phase: InstallPhase;
  userMessage: string;
  progress?: number;
}

export type AppBackupReason = 'manual' | 'update' | 'pre_restore';
export type RemoteBackupType = 'backup' | 'sync_snapshot';
export type RemoteBackupSource = 'manual' | 'auto_sync';

export interface AppBackupFileSummary {
  sourceRelativePath: string;
  backupRelativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface AppBackupSummary {
  appId: string;
  appName: string;
  appVersion: string;
  backupId: string;
  createdAt: string;
  reason: AppBackupReason;
  fileCount: number;
  totalBytes: number;
  files: AppBackupFileSummary[];
}

export interface CreateAppBackupInput {
  appId: string;
  reason?: AppBackupReason;
}

export interface CreateAppBackupResult extends BasicActionResult {
  backup?: AppBackupSummary;
}

export interface DeleteAppBackupInput {
  appId: string;
  backupId: string;
}

export interface RestoreAppBackupInput {
  appId: string;
  backupId: string;
}

export interface RemoteAppBackupSummary {
  id: number;
  appId: string;
  appName: string;
  appVersion?: string;
  backupType: RemoteBackupType;
  source: RemoteBackupSource;
  metadata: Record<string, unknown>;
  fileCount: number;
  totalBytes: number;
  checksumSha256: string;
  signature?: string;
  signatureKeyFingerprint?: string;
  signatureAlgorithm?: string;
  createdAt: string;
  updatedAt?: string;
  downloadUrl?: string;
}

export interface RemoteBackupsUsage {
  usedBytes: number;
  limitBytes: number;
  backupCount: number;
  backupCountLimit: number;
}

export interface RemoteBackupsState {
  backups: RemoteAppBackupSummary[];
  usage: RemoteBackupsUsage;
}

export interface CreateRemoteAppBackupInput {
  appId: string;
  backupType: RemoteBackupType;
  source?: RemoteBackupSource;
}

export interface CreateRemoteAppBackupResult extends BasicActionResult {
  remoteBackup?: RemoteAppBackupSummary;
}

export interface RestoreRemoteAppBackupInput {
  remoteBackupId: number;
}

export interface CloudSyncSettings {
  appSync: Record<string, { autoSync: boolean }>;
}

export interface OpenAppResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
  backendUrl?: string;
  frontendUrl?: string;
}

export interface LocalNetworkShareStatus {
  active: boolean;
  appId: string;
  url?: string;
  connectUrl?: string;
  connectedAt?: string;
}

export type RemoteNetworkShareState =
  | 'inactive'
  | 'preparing'
  | 'waiting_for_session'
  | 'connected'
  | 'error'
  | 'closed';

export interface RemoteNetworkConnectionSummary {
  id: string;
  connectedAt: string;
  lastSeenAt?: string;
}

export interface RemoteNetworkShareStatus {
  active: boolean;
  appId: string;
  state: RemoteNetworkShareState;
  sessionId?: string;
  portalUrl?: string;
  frontendUrl?: string;
  tunnelUrl?: string;
  connectionCount?: number;
  connections?: RemoteNetworkConnectionSummary[];
  userMessage?: string;
  technicalCode?: string;
}

export interface RuntimeStatus {
  appId: string;
  status: AppStatus;
  userMessage?: string;
  backendUrl?: string;
  frontendUrl?: string;
  localNetworkShare?: LocalNetworkShareStatus;
  remoteNetworkShare?: RemoteNetworkShareStatus;
}

export interface LocalNetworkShareResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
  status: LocalNetworkShareStatus;
}

export interface RemoteNetworkShareResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
  status: RemoteNetworkShareStatus;
}

export interface StopAppResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
}
