import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppBackupFileSummary,
  AppBackupReason,
  AppBackupSummary,
  BasicActionResult,
  CreateAppBackupInput,
  CreateAppBackupResult,
  RestoreAppBackupInput,
} from '../shared/types';

interface BackupAppRecord {
  appId: string;
  name: string;
  version: string;
  installDir: string;
}

interface ManifestVolume {
  source?: string;
  persist?: boolean;
}

interface ManifestService {
  context?: string;
  environment?: Record<string, string>;
  volumes?: ManifestVolume[];
}

interface AppManifest {
  services?: ManifestService[];
}

interface BackupMetadata {
  schemaVersion: 1;
  appId: string;
  appName: string;
  appVersion: string;
  backupId: string;
  createdAt: string;
  reason: AppBackupReason;
  files: AppBackupFileSummary[];
}

interface BackupsManagerOptions {
  backupsRoot: string;
  listInstalledApps: () => BackupAppRecord[];
  getInstalledApp: (appId: string) => BackupAppRecord | undefined;
  isAppRunning: (appId: string) => boolean;
  log?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

const METADATA_FILE = 'metadata.json';
const FILES_DIR = 'files';

const toPosixRelativePath = (value: string): string => value.replace(/\\/g, '/');

const normalizeRelativePath = (value: string): string | null => {
  const normalized = toPosixRelativePath(value).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
};

const ensurePathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(relative));
};

const safeBackupId = (value: string): string | null =>
  /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes('/') && !value.includes('\\') ? value : null;

const timestampBackupId = (): string => new Date().toISOString().replace(/[:.]/g, '-');

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const buffer = await fs.readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
};

const readManifest = async (installDir: string): Promise<AppManifest | null> => {
  const raw = await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8').catch(() => '');
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as AppManifest;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const translatedEnvironment = (
  environment: Record<string, string>,
  installDir: string,
  serviceContext: string | undefined,
): Record<string, string> => {
  const backendDir = path.join(installDir, 'backend');
  const serviceDir = serviceContext ? path.resolve(installDir, serviceContext) : backendDir;
  const appDataDir = path.join(backendDir, 'data');
  const placeholders: Record<string, string> = {
    '{app_root}': installDir,
    '{backend}': backendDir,
    '{app_data}': appDataDir,
  };

  const translated: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    let next = value;
    for (const [placeholder, replacement] of Object.entries(placeholders)) {
      next = next.split(placeholder).join(replacement);
    }
    const dockerAppPrefix = 'sqlite:////app/';
    if (key === 'DATABASE_URL' && next.startsWith(dockerAppPrefix)) {
      next = `sqlite:///${path.join(serviceDir, next.slice(dockerAppPrefix.length))}`;
    }
    translated[key] = next;
  }
  return translated;
};

const sqlitePathFromUrl = (databaseUrl: string): string | null => {
  if (!databaseUrl.startsWith('sqlite:///')) {
    return null;
  }
  return databaseUrl.slice('sqlite:///'.length);
};

const collectFiles = async (root: string, targetPath: string): Promise<string[]> => {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat) {
    return [];
  }
  if (stat.isFile()) {
    return [targetPath];
  }
  if (!stat.isDirectory()) {
    return [];
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.gitkeep' || entry.name === '.DS_Store') {
      continue;
    }
    files.push(...await collectFiles(root, path.join(targetPath, entry.name)));
  }
  return files.filter((filePath) => ensurePathInside(root, filePath));
};

export class BackupsManager {
  private backupsRoot: string;
  private listInstalledApps: () => BackupAppRecord[];
  private getInstalledApp: (appId: string) => BackupAppRecord | undefined;
  private isAppRunning: (appId: string) => boolean;
  private log?: (event: string, payload?: Record<string, unknown>) => Promise<void>;

  constructor(options: BackupsManagerOptions) {
    this.backupsRoot = options.backupsRoot;
    this.listInstalledApps = options.listInstalledApps;
    this.getInstalledApp = options.getInstalledApp;
    this.isAppRunning = options.isAppRunning;
    this.log = options.log;
  }

  async listBackups(appId?: string): Promise<AppBackupSummary[]> {
    const appIds = appId ? [appId] : this.listInstalledApps().map((appRecord) => appRecord.appId);
    const backups: AppBackupSummary[] = [];
    for (const currentAppId of appIds) {
      const appBackupRoot = path.join(this.backupsRoot, currentAppId);
      const entries = await fs.readdir(appBackupRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const metadata = await this.readMetadata(currentAppId, entry.name).catch(() => null);
        if (metadata) {
          backups.push(this.toSummary(metadata));
        }
      }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  backupDirectory(appId: string, backupId: string): string | null {
    return this.resolveBackupPath(appId, backupId);
  }

  async createBackup(input: CreateAppBackupInput): Promise<CreateAppBackupResult> {
    const appRecord = this.getInstalledApp(input.appId);
    if (!appRecord?.installDir) {
      return {
        success: false,
        userMessage: 'Primero instala esta app.',
        technicalCode: 'app_not_installed',
      };
    }

    const createdAt = new Date().toISOString();
    const backupId = timestampBackupId();
    const backupDir = path.join(this.backupsRoot, appRecord.appId, backupId);
    const filesRoot = path.join(backupDir, FILES_DIR);
    const filePaths = await this.collectPersistentFiles(appRecord);
    const files: AppBackupFileSummary[] = [];

    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.mkdir(filesRoot, { recursive: true });

    for (const sourcePath of filePaths) {
      const relativePath = normalizeRelativePath(path.relative(appRecord.installDir, sourcePath));
      if (!relativePath) {
        continue;
      }
      const targetPath = path.join(filesRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      const stat = await fs.stat(targetPath);
      files.push({
        sourceRelativePath: relativePath,
        backupRelativePath: toPosixRelativePath(path.join(FILES_DIR, relativePath)),
        sha256: await hashFileSha256(targetPath),
        sizeBytes: stat.size,
      });
    }

    const metadata: BackupMetadata = {
      schemaVersion: 1,
      appId: appRecord.appId,
      appName: appRecord.name,
      appVersion: appRecord.version,
      backupId,
      createdAt,
      reason: input.reason ?? 'manual',
      files,
    };
    await fs.writeFile(path.join(backupDir, METADATA_FILE), JSON.stringify(metadata, null, 2), 'utf8');
    await this.log?.('backup:created', {
      appId: appRecord.appId,
      backupId,
      reason: metadata.reason,
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    });

    return {
      success: true,
      userMessage: files.length > 0 ? 'Respaldo creado.' : 'Respaldo creado, sin archivos de datos para copiar.',
      backup: this.toSummary(metadata),
    };
  }

  async deleteBackup(input: { appId: string; backupId: string }): Promise<BasicActionResult> {
    const backupPath = this.resolveBackupPath(input.appId, input.backupId);
    if (!backupPath) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'invalid_backup_id',
      };
    }
    const stat = await fs.stat(backupPath).catch(() => null);
    if (!stat?.isDirectory()) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'backup_not_found',
      };
    }
    await fs.rm(backupPath, { recursive: true, force: true });
    await this.log?.('backup:deleted', { appId: input.appId, backupId: input.backupId });
    return {
      success: true,
      userMessage: 'Respaldo eliminado.',
    };
  }

  async restoreBackup(input: RestoreAppBackupInput): Promise<BasicActionResult> {
    const appRecord = this.getInstalledApp(input.appId);
    if (!appRecord?.installDir) {
      return {
        success: false,
        userMessage: 'Primero instala esta app.',
        technicalCode: 'app_not_installed',
      };
    }
    if (this.isAppRunning(input.appId)) {
      return {
        success: false,
        userMessage: 'Cierra la app antes de restaurar un respaldo.',
        technicalCode: 'app_running',
      };
    }

    const metadata = await this.readMetadata(input.appId, input.backupId);
    await this.verifyBackupFiles(path.resolve(this.backupsRoot, input.appId, input.backupId), metadata);
    const preRestore = await this.createBackup({ appId: input.appId, reason: 'pre_restore' });
    if (!preRestore.success) {
      return preRestore;
    }

    const installRoot = path.resolve(appRecord.installDir);
    for (const file of metadata.files) {
      const sourceRelative = normalizeRelativePath(file.sourceRelativePath);
      const backupRelative = normalizeRelativePath(file.backupRelativePath);
      if (!sourceRelative || !backupRelative) {
        throw new Error('invalid_backup_metadata_path');
      }
      const targetPath = path.resolve(appRecord.installDir, sourceRelative);
      const backupPath = path.resolve(this.backupsRoot, input.appId, input.backupId, backupRelative);
      if (!ensurePathInside(installRoot, targetPath) || !ensurePathInside(this.backupsRoot, backupPath)) {
        throw new Error('unsafe_backup_restore_path');
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(backupPath, targetPath);
    }

    await this.log?.('backup:restored', {
      appId: input.appId,
      backupId: input.backupId,
      preRestoreBackupId: preRestore.backup?.backupId,
      fileCount: metadata.files.length,
    });
    return {
      success: true,
      userMessage: 'Respaldo restaurado.',
    };
  }

  async restoreBackupDirectory(input: { appId: string; backupDir: string }): Promise<BasicActionResult> {
    const appRecord = this.getInstalledApp(input.appId);
    if (!appRecord?.installDir) {
      return {
        success: false,
        userMessage: 'Primero instala esta app.',
        technicalCode: 'app_not_installed',
      };
    }
    if (this.isAppRunning(input.appId)) {
      return {
        success: false,
        userMessage: 'Cierra la app antes de restaurar un respaldo.',
        technicalCode: 'app_running',
      };
    }

    const metadata = await this.readMetadataFromDirectory(input.backupDir);
    if (metadata.appId !== input.appId) {
      throw new Error('remote_backup_app_mismatch');
    }
    await this.verifyBackupFiles(input.backupDir, metadata);
    const preRestore = await this.createBackup({ appId: input.appId, reason: 'pre_restore' });
    if (!preRestore.success) {
      return preRestore;
    }

    const installRoot = path.resolve(appRecord.installDir);
    for (const file of metadata.files) {
      const sourceRelative = normalizeRelativePath(file.sourceRelativePath);
      const backupRelative = normalizeRelativePath(file.backupRelativePath);
      if (!sourceRelative || !backupRelative) {
        throw new Error('invalid_backup_metadata_path');
      }
      const targetPath = path.resolve(appRecord.installDir, sourceRelative);
      const backupPath = path.resolve(input.backupDir, backupRelative);
      if (!ensurePathInside(installRoot, targetPath) || !ensurePathInside(path.resolve(input.backupDir), backupPath)) {
        throw new Error('unsafe_backup_restore_path');
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(backupPath, targetPath);
    }

    await this.log?.('backup:remote_restored', {
      appId: input.appId,
      backupId: metadata.backupId,
      preRestoreBackupId: preRestore.backup?.backupId,
      fileCount: metadata.files.length,
    });
    return {
      success: true,
      userMessage: 'Respaldo cloud restaurado.',
    };
  }

  private async collectPersistentFiles(appRecord: BackupAppRecord): Promise<string[]> {
    const manifest = await readManifest(appRecord.installDir);
    const paths = new Set<string>();
    paths.add('backend/data');

    for (const service of manifest?.services ?? []) {
      for (const volume of service.volumes ?? []) {
        if (!volume.persist || typeof volume.source !== 'string') {
          continue;
        }
        const normalized = normalizeRelativePath(volume.source);
        if (normalized) {
          paths.add(normalized);
        }
      }

      const environment = service.environment && typeof service.environment === 'object' ? service.environment : {};
      const databaseUrl = translatedEnvironment(environment, appRecord.installDir, service.context).DATABASE_URL;
      const sqlitePath = typeof databaseUrl === 'string' ? sqlitePathFromUrl(databaseUrl) : null;
      if (sqlitePath && path.isAbsolute(sqlitePath)) {
        const relativeDbPath = normalizeRelativePath(path.relative(appRecord.installDir, sqlitePath));
        if (relativeDbPath) {
          paths.add(relativeDbPath);
        }
      }
    }

    const installRoot = path.resolve(appRecord.installDir);
    const files = new Set<string>();
    for (const relativePath of paths) {
      const targetPath = path.resolve(appRecord.installDir, relativePath);
      if (!ensurePathInside(installRoot, targetPath)) {
        continue;
      }
      for (const filePath of await collectFiles(installRoot, targetPath)) {
        files.add(filePath);
      }
    }
    return [...files].sort();
  }

  private resolveBackupPath(appId: string, backupId: string): string | null {
    const safeId = safeBackupId(backupId);
    if (!safeId) {
      return null;
    }
    const backupPath = path.resolve(this.backupsRoot, appId, safeId);
    return ensurePathInside(path.resolve(this.backupsRoot, appId), backupPath) ? backupPath : null;
  }

  private async readMetadata(appId: string, backupId: string): Promise<BackupMetadata> {
    const backupPath = this.resolveBackupPath(appId, backupId);
    if (!backupPath) {
      throw new Error('invalid_backup_id');
    }
    const metadata = await this.readMetadataFromDirectory(backupPath);
    if (metadata.appId !== appId || metadata.backupId !== backupId) {
      throw new Error('invalid_backup_metadata');
    }
    return metadata;
  }

  private async readMetadataFromDirectory(backupPath: string): Promise<BackupMetadata> {
    const raw = await fs.readFile(path.join(backupPath, METADATA_FILE), 'utf8');
    const metadata = JSON.parse(raw) as BackupMetadata;
    if (!metadata || metadata.schemaVersion !== 1 || !metadata.appId || !metadata.backupId) {
      throw new Error('invalid_backup_metadata');
    }
    return metadata;
  }

  private async verifyBackupFiles(backupRoot: string, metadata: BackupMetadata): Promise<void> {
    for (const file of metadata.files) {
      const backupRelative = normalizeRelativePath(file.backupRelativePath);
      if (!backupRelative) {
        throw new Error('invalid_backup_metadata_path');
      }
      const backupPath = path.resolve(backupRoot, backupRelative);
      if (!ensurePathInside(path.resolve(backupRoot), backupPath)) {
        throw new Error('unsafe_backup_file_path');
      }
      const stat = await fs.stat(backupPath);
      if (!stat.isFile() || stat.size !== file.sizeBytes) {
        throw new Error('backup_file_mismatch');
      }
      const sha256 = await hashFileSha256(backupPath);
      if (sha256 !== file.sha256) {
        throw new Error('backup_checksum_mismatch');
      }
    }
  }

  private toSummary(metadata: BackupMetadata): AppBackupSummary {
    return {
      appId: metadata.appId,
      appName: metadata.appName,
      appVersion: metadata.appVersion,
      backupId: metadata.backupId,
      createdAt: metadata.createdAt,
      reason: metadata.reason,
      fileCount: metadata.files.length,
      totalBytes: metadata.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      files: metadata.files,
    };
  }
}
