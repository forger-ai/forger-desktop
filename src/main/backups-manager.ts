import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppBackupFileSummary,
  AppBackupReason,
  AppBackupSummary,
  BasicActionResult,
  CreateAppBackupInput,
  CreateAppBackupResult,
  DeleteAppBackupBatchInput,
  DeleteAppBackupBatchResult,
  DeleteAppBackupInput,
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

interface BackupRestoreFile {
  file: AppBackupFileSummary;
  sourcePath: string;
  targetPath: string;
}

interface PersistentPathContract {
  relativePath: string;
  allowsDescendants: boolean;
}

interface StagedBackupRestoreFile extends BackupRestoreFile {
  stagedPath: string;
  rollbackPath: string;
  originalMoved: boolean;
  stagedMoved: boolean;
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

const safePathSegment = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.endsWith('.')) {
    return null;
  }
  const windowsStem = value.split('.')[0].toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem) ? null : value;
};

const safeAppId = (value: string): string | null => safePathSegment(value);

const safeBackupId = (value: string): string | null => safePathSegment(value);

const pathsEqual = (left: string, right: string): boolean =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

const relativePathsEqual = (left: string, right: string): boolean => {
  const normalizedLeft = process.platform === 'win32' ? left.toLowerCase() : left;
  const normalizedRight = process.platform === 'win32' ? right.toLowerCase() : right;
  return normalizedLeft === normalizedRight;
};

const relativePathIsWithin = (rootPath: string, targetPath: string): boolean => {
  const normalizedRoot = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  const normalizedTarget = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const relative = path.posix.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('../') && !path.posix.isAbsolute(relative));
};

const resolveCanonicalPath = async (targetPath: string): Promise<string> => {
  let currentPath = path.resolve(targetPath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonicalParent = await fs.realpath(currentPath);
      return path.resolve(canonicalParent, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        throw error;
      }
      missingSegments.push(path.basename(currentPath));
      currentPath = parentPath;
    }
  }
};

const ensureCanonicalPathInside = async (rootPath: string, targetPath: string): Promise<boolean> => {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);
  if (!ensurePathInside(resolvedRoot, resolvedTarget)) {
    return false;
  }
  const canonicalRoot = await fs.realpath(resolvedRoot);
  const canonicalTarget = await resolveCanonicalPath(resolvedTarget);
  const expectedCanonicalTarget = path.resolve(canonicalRoot, path.relative(resolvedRoot, resolvedTarget));
  return ensurePathInside(canonicalRoot, canonicalTarget) && pathsEqual(canonicalTarget, expectedCanonicalTarget);
};

const uniqueBackupId = (): string => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;

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
  const canonicalPathIsSafe = await ensureCanonicalPathInside(root, targetPath).catch(() => false);
  if (!canonicalPathIsSafe) {
    return [];
  }
  const stat = await fs.lstat(targetPath).catch(() => null);
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
  private appMutationLocks = new Map<string, Promise<void>>();

  constructor(options: BackupsManagerOptions) {
    this.backupsRoot = path.resolve(options.backupsRoot);
    this.listInstalledApps = options.listInstalledApps;
    this.getInstalledApp = options.getInstalledApp;
    this.isAppRunning = options.isAppRunning;
    this.log = options.log;
  }

  async listBackups(appId?: string): Promise<AppBackupSummary[]> {
    const appIds = appId === undefined ? this.listInstalledApps().map((appRecord) => appRecord.appId) : [appId];
    const backups: AppBackupSummary[] = [];
    for (const currentAppId of appIds) {
      const appBackupRoot = this.resolveAppBackupRoot(currentAppId);
      if (!appBackupRoot) {
        continue;
      }
      const canonicalPathIsSafe = await ensureCanonicalPathInside(this.backupsRoot, appBackupRoot).catch(() => false);
      if (!canonicalPathIsSafe) {
        continue;
      }
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
    if (!safeAppId(input.appId)) {
      return {
        success: false,
        userMessage: 'No pudimos crear el respaldo.',
        technicalCode: 'invalid_app_id',
      };
    }
    return await this.withAppMutationLock(input.appId, async () => await this.createBackupUnlocked(input));
  }

  private async createBackupUnlocked(input: CreateAppBackupInput): Promise<CreateAppBackupResult> {
    const appRecord = this.getInstalledApp(input.appId);
    if (!appRecord?.installDir) {
      return {
        success: false,
        userMessage: 'Primero instala esta app.',
        technicalCode: 'app_not_installed',
      };
    }
    if (appRecord.appId !== input.appId || !safeAppId(appRecord.appId)) {
      return {
        success: false,
        userMessage: 'No pudimos crear el respaldo.',
        technicalCode: 'invalid_app_id',
      };
    }

    const createdAt = new Date().toISOString();
    const filePaths = await this.collectPersistentFiles(appRecord);
    const allocation = await this.allocateBackupDirectory(appRecord.appId);
    if (!allocation) {
      return {
        success: false,
        userMessage: 'No pudimos crear el respaldo.',
        technicalCode: 'unsafe_backup_path',
      };
    }
    const { backupId, backupDir } = allocation;
    const filesRoot = path.join(backupDir, FILES_DIR);
    const files: AppBackupFileSummary[] = [];

    try {
      const allocatedDirectoryIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupDir).catch(() => false);
      if (!allocatedDirectoryIsSafe) {
        throw new Error('unsafe_backup_create_path');
      }
      await fs.mkdir(filesRoot, { mode: 0o700 });
      for (const sourcePath of filePaths) {
        const relativePath = normalizeRelativePath(path.relative(appRecord.installDir, sourcePath));
        if (!relativePath) {
          continue;
        }
        const targetPath = path.join(filesRoot, relativePath);
        await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        const sourceIsSafe = await ensureCanonicalPathInside(appRecord.installDir, sourcePath).catch(() => false);
        const targetIsSafe = await ensureCanonicalPathInside(backupDir, targetPath).catch(() => false);
        if (!sourceIsSafe || !targetIsSafe) {
          throw new Error('unsafe_backup_create_path');
        }
        await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
        const copiedTargetIsSafe = await ensureCanonicalPathInside(backupDir, targetPath).catch(() => false);
        if (!copiedTargetIsSafe) {
          throw new Error('unsafe_backup_create_path');
        }
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
      const metadataPath = path.join(backupDir, METADATA_FILE);
      const metadataPathIsSafe = await ensureCanonicalPathInside(backupDir, metadataPath).catch(() => false);
      if (!metadataPathIsSafe) {
        throw new Error('unsafe_backup_create_path');
      }
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
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
    } catch (error) {
      await this.removeAllocatedBackupDirectory(backupDir);
      throw error;
    }
  }

  async deleteBackup(input: DeleteAppBackupInput): Promise<BasicActionResult> {
    if (!safeAppId(input.appId)) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'invalid_app_id',
      };
    }
    if (!safeBackupId(input.backupId)) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'invalid_backup_id',
      };
    }
    return await this.withAppMutationLock(input.appId, async () => await this.deleteBackupUnlocked(input));
  }

  private async deleteBackupUnlocked(input: DeleteAppBackupInput): Promise<BasicActionResult> {
    const backupPath = this.resolveBackupPath(input.appId, input.backupId);
    if (!backupPath) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'invalid_backup_id',
      };
    }
    const backupsRootStat = await fs.stat(this.backupsRoot).catch(() => null);
    if (!backupsRootStat?.isDirectory()) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'backup_not_found',
      };
    }
    const canonicalPathIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupPath).catch(() => false);
    if (!canonicalPathIsSafe) {
      return {
        success: false,
        userMessage: 'No pudimos eliminar ese respaldo de forma segura.',
        technicalCode: 'unsafe_backup_path',
      };
    }
    const stat = await fs.lstat(backupPath).catch(() => null);
    if (!stat?.isDirectory()) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'backup_not_found',
      };
    }
    const deletionPathIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupPath).catch(() => false);
    if (!deletionPathIsSafe) {
      return {
        success: false,
        userMessage: 'No pudimos eliminar ese respaldo de forma segura.',
        technicalCode: 'unsafe_backup_path',
      };
    }
    await fs.rm(backupPath, { recursive: true, force: true });
    await this.log?.('backup:deleted', { appId: input.appId, backupId: input.backupId });
    return {
      success: true,
      userMessage: 'Respaldo eliminado.',
    };
  }

  async deleteBackups(input: DeleteAppBackupBatchInput): Promise<DeleteAppBackupBatchResult> {
    const deleted: DeleteAppBackupBatchResult['deleted'] = [];
    const failed: DeleteAppBackupBatchResult['failed'] = [];

    for (const backupId of input.backupIds) {
      const result = await this.deleteBackup({ appId: input.appId, backupId });
      if (result.success) {
        deleted.push({ appId: input.appId, backupId });
      } else {
        failed.push({
          appId: input.appId,
          backupId,
          userMessage: result.userMessage,
          technicalCode: result.technicalCode,
        });
      }
    }

    if (failed.length > 0) {
      return {
        success: false,
        userMessage: deleted.length > 0
          ? 'Eliminamos algunos respaldos, pero otros no se pudieron eliminar.'
          : 'No pudimos eliminar los respaldos seleccionados.',
        technicalCode: deleted.length > 0 ? 'backup_batch_delete_partial' : 'backup_batch_delete_failed',
        deleted,
        failed,
      };
    }

    return {
      success: true,
      userMessage: deleted.length === 1 ? 'Respaldo eliminado.' : 'Respaldos eliminados.',
      deleted,
      failed,
    };
  }

  async restoreBackup(input: RestoreAppBackupInput): Promise<BasicActionResult> {
    if (!safeAppId(input.appId)) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'invalid_app_id',
      };
    }
    return await this.withAppMutationLock(input.appId, async () => await this.restoreBackupUnlocked(input));
  }

  private async restoreBackupUnlocked(input: RestoreAppBackupInput): Promise<BasicActionResult> {
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

    const backupRoot = this.resolveBackupPath(input.appId, input.backupId);
    if (!backupRoot) {
      throw new Error('invalid_backup_id');
    }
    const metadata = await this.readMetadata(input.appId, input.backupId);
    await this.verifyBackupFiles(backupRoot, metadata);
    const restoreFiles = await this.buildRestorePlan(backupRoot, appRecord.installDir, metadata);
    const preRestore = await this.createBackupUnlocked({ appId: input.appId, reason: 'pre_restore' });
    if (!preRestore.success) {
      return preRestore;
    }

    await this.applyRestorePlan(backupRoot, appRecord.installDir, restoreFiles);

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
    if (!safeAppId(input.appId)) {
      return {
        success: false,
        userMessage: 'No pudimos encontrar ese respaldo.',
        technicalCode: 'invalid_app_id',
      };
    }
    return await this.withAppMutationLock(input.appId, async () => await this.restoreBackupDirectoryUnlocked(input));
  }

  private async restoreBackupDirectoryUnlocked(
    input: { appId: string; backupDir: string },
  ): Promise<BasicActionResult> {
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

    const backupRoot = path.resolve(input.backupDir);
    const metadata = await this.readMetadataFromDirectory(backupRoot);
    if (metadata.appId !== input.appId) {
      throw new Error('remote_backup_app_mismatch');
    }
    await this.verifyBackupFiles(backupRoot, metadata);
    await this.verifyRemoteRestoreTargets(appRecord, metadata);
    const restoreFiles = await this.buildRestorePlan(backupRoot, appRecord.installDir, metadata);
    const preRestore = await this.createBackupUnlocked({ appId: input.appId, reason: 'pre_restore' });
    if (!preRestore.success) {
      return preRestore;
    }

    await this.applyRestorePlan(backupRoot, appRecord.installDir, restoreFiles);

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
    const contract = await this.collectPersistentPathContract(appRecord);
    const installRoot = path.resolve(appRecord.installDir);
    const files = new Set<string>();
    for (const entry of contract) {
      const targetPath = path.resolve(appRecord.installDir, entry.relativePath);
      if (!ensurePathInside(installRoot, targetPath)) {
        continue;
      }
      for (const filePath of await collectFiles(installRoot, targetPath)) {
        files.add(filePath);
      }
    }
    return [...files].sort();
  }

  private async collectPersistentPathContract(appRecord: BackupAppRecord): Promise<PersistentPathContract[]> {
    const manifest = await readManifest(appRecord.installDir);
    const contract = new Map<string, PersistentPathContract>();
    contract.set('backend/data', { relativePath: 'backend/data', allowsDescendants: true });

    for (const service of manifest?.services ?? []) {
      for (const volume of service.volumes ?? []) {
        if (!volume.persist || typeof volume.source !== 'string') {
          continue;
        }
        const normalized = normalizeRelativePath(volume.source);
        if (normalized) {
          contract.set(normalized, { relativePath: normalized, allowsDescendants: true });
        }
      }

      const environment = service.environment && typeof service.environment === 'object' ? service.environment : {};
      const databaseUrl = translatedEnvironment(environment, appRecord.installDir, service.context).DATABASE_URL;
      const sqlitePath = typeof databaseUrl === 'string' ? sqlitePathFromUrl(databaseUrl) : null;
      if (sqlitePath && path.isAbsolute(sqlitePath)) {
        const relativeDbPath = normalizeRelativePath(path.relative(appRecord.installDir, sqlitePath));
        if (relativeDbPath) {
          contract.set(relativeDbPath, { relativePath: relativeDbPath, allowsDescendants: false });
        }
      }
    }
    return [...contract.values()];
  }

  private async verifyRemoteRestoreTargets(appRecord: BackupAppRecord, metadata: BackupMetadata): Promise<void> {
    const contract = await this.collectPersistentPathContract(appRecord);
    for (const file of metadata.files) {
      const sourceRelativePath = normalizeRelativePath(file.sourceRelativePath);
      if (!sourceRelativePath) {
        throw new Error('invalid_backup_metadata_path');
      }
      const declaredPersistentTarget = contract.some((entry) =>
        relativePathsEqual(entry.relativePath, sourceRelativePath)
        || (entry.allowsDescendants && relativePathIsWithin(entry.relativePath, sourceRelativePath))
      );
      if (!declaredPersistentTarget) {
        throw new Error('remote_backup_target_not_persistent');
      }
    }
  }

  private async withAppMutationLock<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.appMutationLocks.get(appId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(async () => await current);
    this.appMutationLocks.set(appId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.appMutationLocks.get(appId) === tail) {
        this.appMutationLocks.delete(appId);
      }
    }
  }

  private async allocateBackupDirectory(
    appId: string,
  ): Promise<{ backupId: string; backupDir: string } | null> {
    await fs.mkdir(this.backupsRoot, { recursive: true, mode: 0o700 });
    const appBackupRoot = this.resolveAppBackupRoot(appId);
    if (!appBackupRoot) {
      return null;
    }
    const appRootWasSafe = await ensureCanonicalPathInside(this.backupsRoot, appBackupRoot).catch(() => false);
    if (!appRootWasSafe) {
      return null;
    }
    await fs.mkdir(appBackupRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    const appRootStat = await fs.lstat(appBackupRoot).catch(() => null);
    const appRootIsSafe = await ensureCanonicalPathInside(this.backupsRoot, appBackupRoot).catch(() => false);
    if (!appRootStat?.isDirectory() || !appRootIsSafe) {
      return null;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const backupId = uniqueBackupId();
      const backupDir = this.resolveBackupPath(appId, backupId);
      if (!backupDir) {
        return null;
      }
      const parentStillSafe = await ensureCanonicalPathInside(this.backupsRoot, appBackupRoot).catch(() => false);
      const destinationIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupDir).catch(() => false);
      if (!parentStillSafe || !destinationIsSafe) {
        return null;
      }
      try {
        await fs.mkdir(backupDir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          continue;
        }
        throw error;
      }
      const allocatedPathIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupDir).catch(() => false);
      if (!allocatedPathIsSafe) {
        return null;
      }
      return { backupId, backupDir };
    }
    throw new Error('backup_id_allocation_failed');
  }

  private async removeAllocatedBackupDirectory(backupDir: string): Promise<void> {
    const pathIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupDir).catch(() => false);
    const stat = pathIsSafe ? await fs.lstat(backupDir).catch(() => null) : null;
    const pathIsStillSafe = stat?.isDirectory()
      ? await ensureCanonicalPathInside(this.backupsRoot, backupDir).catch(() => false)
      : false;
    if (pathIsStillSafe) {
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private resolveAppBackupRoot(appId: string): string | null {
    const validAppId = safeAppId(appId);
    if (!validAppId) {
      return null;
    }
    const appBackupRoot = path.resolve(this.backupsRoot, validAppId);
    return ensurePathInside(this.backupsRoot, appBackupRoot) ? appBackupRoot : null;
  }

  private resolveBackupPath(appId: string, backupId: string): string | null {
    const appBackupRoot = this.resolveAppBackupRoot(appId);
    const validBackupId = safeBackupId(backupId);
    if (!appBackupRoot || !validBackupId) {
      return null;
    }
    const backupPath = path.resolve(appBackupRoot, validBackupId);
    return ensurePathInside(this.backupsRoot, backupPath) ? backupPath : null;
  }

  private async readMetadata(appId: string, backupId: string): Promise<BackupMetadata> {
    const backupPath = this.resolveBackupPath(appId, backupId);
    if (!backupPath) {
      throw new Error('invalid_backup_id');
    }
    const canonicalPathIsSafe = await ensureCanonicalPathInside(this.backupsRoot, backupPath).catch(() => false);
    if (!canonicalPathIsSafe) {
      throw new Error('unsafe_backup_path');
    }
    const metadata = await this.readMetadataFromDirectory(backupPath);
    if (metadata.appId !== appId || metadata.backupId !== backupId) {
      throw new Error('invalid_backup_metadata');
    }
    return metadata;
  }

  private async readMetadataFromDirectory(backupPath: string): Promise<BackupMetadata> {
    const resolvedBackupRoot = path.resolve(backupPath);
    const backupRootStat = await fs.stat(resolvedBackupRoot);
    if (!backupRootStat.isDirectory()) {
      throw new Error('invalid_backup_metadata');
    }
    const metadataPath = path.resolve(resolvedBackupRoot, METADATA_FILE);
    const metadataPathIsSafe = await ensureCanonicalPathInside(resolvedBackupRoot, metadataPath).catch(() => false);
    if (!metadataPathIsSafe) {
      throw new Error('unsafe_backup_metadata_path');
    }
    const raw = await fs.readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(raw) as BackupMetadata;
    if (
      !metadata
      || metadata.schemaVersion !== 1
      || !safeAppId(metadata.appId)
      || !safeBackupId(metadata.backupId)
      || !Array.isArray(metadata.files)
    ) {
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
      const canonicalPathIsSafe = await ensureCanonicalPathInside(backupRoot, backupPath).catch(() => false);
      if (!canonicalPathIsSafe) {
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

  private async buildRestorePlan(
    backupRoot: string,
    installRoot: string,
    metadata: BackupMetadata,
  ): Promise<BackupRestoreFile[]> {
    const resolvedBackupRoot = path.resolve(backupRoot);
    const resolvedInstallRoot = path.resolve(installRoot);
    const restoreFiles: BackupRestoreFile[] = [];
    const targetPaths = new Set<string>();
    for (const file of metadata.files) {
      const sourceRelative = normalizeRelativePath(file.sourceRelativePath);
      const backupRelative = normalizeRelativePath(file.backupRelativePath);
      if (!sourceRelative || !backupRelative) {
        throw new Error('invalid_backup_metadata_path');
      }
      const sourcePath = path.resolve(resolvedBackupRoot, backupRelative);
      const targetPath = path.resolve(resolvedInstallRoot, sourceRelative);
      if (!ensurePathInside(resolvedBackupRoot, sourcePath)) {
        throw new Error('unsafe_backup_file_path');
      }
      if (!ensurePathInside(resolvedInstallRoot, targetPath)) {
        throw new Error('unsafe_backup_restore_path');
      }
      const sourceIsSafe = await ensureCanonicalPathInside(resolvedBackupRoot, sourcePath).catch(() => false);
      if (!sourceIsSafe) {
        throw new Error('unsafe_backup_file_path');
      }
      const targetIsSafe = await ensureCanonicalPathInside(resolvedInstallRoot, targetPath).catch(() => false);
      if (!targetIsSafe) {
        throw new Error('unsafe_backup_restore_path');
      }
      const targetKey = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
      if (targetPaths.has(targetKey)) {
        throw new Error('duplicate_backup_restore_target');
      }
      targetPaths.add(targetKey);
      restoreFiles.push({ file, sourcePath, targetPath });
    }
    return restoreFiles;
  }

  private async applyRestorePlan(
    backupRoot: string,
    installRoot: string,
    restoreFiles: BackupRestoreFile[],
  ): Promise<void> {
    const resolvedInstallRoot = path.resolve(installRoot);
    const transactionRoot = await fs.mkdtemp(path.join(resolvedInstallRoot, '.forger-restore-'));
    const stagedRoot = path.join(transactionRoot, 'staged');
    const rollbackRoot = path.join(transactionRoot, 'rollback');
    const stagedFiles: StagedBackupRestoreFile[] = [];
    const createdParents = new Set<string>();
    let restoreError: unknown;
    let rollbackFailed = false;

    try {
      const transactionIsSafe = await ensureCanonicalPathInside(resolvedInstallRoot, transactionRoot).catch(() => false);
      if (!transactionIsSafe) {
        throw new Error('unsafe_backup_restore_path');
      }
      await fs.mkdir(stagedRoot, { mode: 0o700 });
      await fs.mkdir(rollbackRoot, { mode: 0o700 });

      for (const [index, restoreFile] of restoreFiles.entries()) {
        const sourceIsSafe = await ensureCanonicalPathInside(backupRoot, restoreFile.sourcePath).catch(() => false);
        if (!sourceIsSafe) {
          throw new Error('unsafe_backup_file_path');
        }
        const stagedPath = path.join(stagedRoot, String(index));
        const rollbackPath = path.join(rollbackRoot, String(index));
        await fs.copyFile(restoreFile.sourcePath, stagedPath, fsConstants.COPYFILE_EXCL);
        const stagedStat = await fs.stat(stagedPath);
        if (!stagedStat.isFile() || stagedStat.size !== restoreFile.file.sizeBytes) {
          throw new Error('backup_file_mismatch');
        }
        if (await hashFileSha256(stagedPath) !== restoreFile.file.sha256) {
          throw new Error('backup_checksum_mismatch');
        }
        stagedFiles.push({
          ...restoreFile,
          stagedPath,
          rollbackPath,
          originalMoved: false,
          stagedMoved: false,
        });
      }

      for (const stagedFile of stagedFiles) {
        const targetParent = path.dirname(stagedFile.targetPath);
        const missingParents = await this.missingRestoreParents(resolvedInstallRoot, targetParent);
        const parentIsSafe = await ensureCanonicalPathInside(resolvedInstallRoot, targetParent).catch(() => false);
        if (!parentIsSafe) {
          throw new Error('unsafe_backup_restore_path');
        }
        await fs.mkdir(targetParent, { recursive: true });
        for (const createdParent of missingParents) {
          createdParents.add(createdParent);
        }

        const stagedPathIsSafe = await ensureCanonicalPathInside(resolvedInstallRoot, stagedFile.stagedPath).catch(() => false);
        const targetIsSafe = await ensureCanonicalPathInside(resolvedInstallRoot, stagedFile.targetPath).catch(() => false);
        if (!stagedPathIsSafe || !targetIsSafe) {
          throw new Error('unsafe_backup_restore_path');
        }
        const targetStat = await fs.lstat(stagedFile.targetPath).catch(() => null);
        if (targetStat && !targetStat.isFile()) {
          throw new Error('unsafe_backup_restore_path');
        }
        if (targetStat) {
          await fs.rename(stagedFile.targetPath, stagedFile.rollbackPath);
          stagedFile.originalMoved = true;
        }

        const stagedSourceIsStillSafe = await ensureCanonicalPathInside(resolvedInstallRoot, stagedFile.stagedPath).catch(() => false);
        const vacantTargetIsSafe = await ensureCanonicalPathInside(resolvedInstallRoot, stagedFile.targetPath).catch(() => false);
        if (!stagedSourceIsStillSafe || !vacantTargetIsSafe) {
          throw new Error('unsafe_backup_restore_path');
        }
        await fs.rename(stagedFile.stagedPath, stagedFile.targetPath);
        stagedFile.stagedMoved = true;
      }
    } catch (error) {
      restoreError = error;
      const rollbackErrors: unknown[] = [];
      for (const stagedFile of [...stagedFiles].reverse()) {
        try {
          if (stagedFile.stagedMoved) {
            await fs.rm(stagedFile.targetPath, { force: true });
          }
          if (stagedFile.originalMoved) {
            await fs.rename(stagedFile.rollbackPath, stagedFile.targetPath);
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        rollbackFailed = true;
        throw new AggregateError([restoreError, ...rollbackErrors], 'backup_restore_rollback_failed');
      }
      throw error;
    } finally {
      const transactionIsStillSafe = await ensureCanonicalPathInside(resolvedInstallRoot, transactionRoot).catch(() => false);
      if (transactionIsStillSafe && !rollbackFailed) {
        await fs.rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      if (restoreError) {
        for (const createdParent of [...createdParents].sort((left, right) => right.length - left.length)) {
          await fs.rmdir(createdParent).catch(() => undefined);
        }
      }
    }
  }

  private async missingRestoreParents(installRoot: string, targetParent: string): Promise<string[]> {
    const missing: string[] = [];
    let current = path.resolve(targetParent);
    while (!pathsEqual(current, installRoot)) {
      if (!ensurePathInside(installRoot, current)) {
        throw new Error('unsafe_backup_restore_path');
      }
      if (await fs.lstat(current).catch(() => null)) {
        break;
      }
      missing.push(current);
      current = path.dirname(current);
    }
    return missing;
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
