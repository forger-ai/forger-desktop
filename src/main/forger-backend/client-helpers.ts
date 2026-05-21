import os from 'node:os';
import path from 'node:path';
import type {
  RemoteAppBackupSummary,
  RemoteBackupsState,
  RemoteBackupsUsage,
  RemoteBackupSource,
  RemoteBackupType,
} from '../../shared/types';
import { normalizeForgerAccountUser, type StoredForgerAccount } from '../forger-account-store';

export interface RemoteBackupPayload {
  id: number | string;
  app_id: string;
  app_name: string;
  app_version?: string | null;
  backup_type: RemoteBackupType;
  source: RemoteBackupSource;
  metadata?: Record<string, unknown> | null;
  file_count?: number | string | null;
  total_bytes?: number | string | null;
  checksum_sha256?: string | null;
  signature?: string | null;
  signature_key_fingerprint?: string | null;
  signature_algorithm?: string | null;
  created_at?: string;
  updated_at?: string;
  download_url?: string;
}

export interface RemoteBackupsResponse {
  backups?: unknown[];
  usage?: {
    used_bytes?: number | string | null;
    limit_bytes?: number | string | null;
    backup_count?: number | string | null;
    backup_count_limit?: number | string | null;
  } | null;
}

export const backendError = (message: string, technicalCode: string): Error & { technicalCode: string } =>
  Object.assign(new Error(message), { technicalCode });

export const buildBackendHeaders = (
  token: string | undefined,
  options: { accept?: string; contentType?: false | string } = {},
): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: options.accept ?? 'application/json',
  };
  if (typeof options.contentType === 'string') {
    headers['Content-Type'] = options.contentType;
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

export const parseAccountPayload = (
  payload: unknown,
  token: string | undefined,
  storedToken: string | undefined,
): StoredForgerAccount => {
  if (!payload || typeof payload !== 'object') {
    return { authenticated: false };
  }

  const record = payload as Record<string, unknown>;
  const user = normalizeForgerAccountUser(record.user);
  return {
    authenticated: Boolean(record.authenticated && (token || storedToken) && user),
    confirmationRequired: Boolean(record.confirmation_required ?? record.confirmationRequired),
    token,
    user,
  };
};

export const normalizeRuntimePlatform = (platform: NodeJS.Platform, arch: string): string => {
  const normalizedArch = arch === 'x64' || arch === 'arm64' ? arch : arch.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${platform}_${normalizedArch}`;
};

export const safeValidationKeys = (payload: unknown): Record<string, string[]> | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const errors = (payload as { errors?: unknown }).errors;
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) {
    return undefined;
  }
  const blockedKeys = new Set(['__proto__', 'constructor', 'prototype']);
  const entries = Object.entries(errors)
    .filter(([key]) => /^[a-zA-Z0-9_.-]+$/.test(key) && !blockedKeys.has(key))
    .map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((entry) => String(entry)).slice(0, 5)
        : [String(value)],
    ] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

export const responseRequestId = (response: Response): string | undefined =>
  response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? undefined;

export const defaultReportingLogPath = (): string => {
  const appDataName = process.env.VITE_DEV_SERVER_URL ? 'forger-desktop-dev' : 'forger-desktop';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appDataName, 'logs', 'reporting.log');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), appDataName, 'logs', 'reporting.log');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), appDataName, 'logs', 'reporting.log');
};

export const emptyRemoteBackupsState = (): RemoteBackupsState => ({
  backups: [],
  usage: {
    usedBytes: 0,
    limitBytes: 0,
    backupCount: 0,
    backupCountLimit: 0,
  },
});

export const normalizeRemoteBackup = (value: unknown): RemoteAppBackupSummary | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as RemoteBackupPayload;
  const id = typeof record.id === 'number' ? record.id : Number(record.id);
  const appId = typeof record.app_id === 'string' ? record.app_id.trim() : '';
  const appName = typeof record.app_name === 'string' ? record.app_name.trim() : '';
  if (!Number.isFinite(id) || !appId || !appName) {
    return undefined;
  }
  return {
    id,
    appId,
    appName,
    appVersion: typeof record.app_version === 'string' && record.app_version.trim() ? record.app_version : undefined,
    backupType: record.backup_type === 'sync_snapshot' ? 'sync_snapshot' : 'backup',
    source: record.source === 'auto_sync' ? 'auto_sync' : 'manual',
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {},
    fileCount: normalizeRemoteBackupNumber(record.file_count),
    totalBytes: normalizeRemoteBackupNumber(record.total_bytes),
    checksumSha256: typeof record.checksum_sha256 === 'string' ? record.checksum_sha256 : '',
    signature: typeof record.signature === 'string' ? record.signature : undefined,
    signatureKeyFingerprint: typeof record.signature_key_fingerprint === 'string' ? record.signature_key_fingerprint : undefined,
    signatureAlgorithm: typeof record.signature_algorithm === 'string' ? record.signature_algorithm : undefined,
    createdAt: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
    downloadUrl: typeof record.download_url === 'string' ? record.download_url : undefined,
  };
};

const normalizeRemoteBackupNumber = (value: unknown): number => {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
};

export const normalizeRemoteBackupsUsage = (value: unknown): RemoteBackupsUsage => {
  if (!value || typeof value !== 'object') {
    return emptyRemoteBackupsState().usage;
  }
  const record = value as NonNullable<RemoteBackupsResponse['usage']>;
  return {
    usedBytes: normalizeRemoteBackupNumber(record.used_bytes),
    limitBytes: normalizeRemoteBackupNumber(record.limit_bytes),
    backupCount: normalizeRemoteBackupNumber(record.backup_count),
    backupCountLimit: normalizeRemoteBackupNumber(record.backup_count_limit),
  };
};

export const remoteBackupErrorMessage = (status: number, payload: unknown): string => {
  const error = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).error : undefined;
  if (status === 403) {
    return 'Forger Cloud Sync requiere una cuenta demo o pro.';
  }
  if (error === 'storage_limit_exceeded') {
    return 'Tu espacio de Forger Cloud esta lleno. Elimina respaldos cloud antes de subir otro.';
  }
  if (error === 'backup_count_limit_exceeded') {
    return 'Llegaste al maximo de respaldos cloud. Elimina algunos antes de subir otro.';
  }
  return 'No pudimos subir el respaldo a Forger Cloud.';
};

export const googleLoginErrorMessage = (payload: unknown): string => {
  const error = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).error : undefined;
  if (error === 'google_login_server_not_configured') {
    return 'Google login no esta configurado en Forger Cloud.';
  }
  if (error === 'google_login_email_unverified') {
    return 'Google no confirmo este correo.';
  }
  if (error === 'google_login_account_conflict') {
    return 'Este correo ya esta vinculado a otra cuenta de Google.';
  }
  if (error === 'access_denied') {
    return 'Google cancelo el inicio de sesion.';
  }
  return 'No pudimos iniciar sesion con Google.';
};

export const usernameCooldownMessage = (availableAt?: string): string => {
  if (!availableAt) {
    return 'Podras cambiar tu username cuando se cumplan 30 dias desde el ultimo cambio.';
  }

  const date = new Date(availableAt);
  if (Number.isNaN(date.getTime())) {
    return 'Podras cambiar tu username cuando se cumplan 30 dias desde el ultimo cambio.';
  }

  return `Podras cambiar tu username desde el ${date.toLocaleDateString('es-CL', { dateStyle: 'medium' })}.`;
};
