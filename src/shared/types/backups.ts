import type { BasicActionResult } from './base';

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
