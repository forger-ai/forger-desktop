import type fs from 'node:fs/promises';
import type path from 'node:path';

import type { DevCatalogService } from '../dev-catalog-service';
import type { StoredForgerAccount } from '../forger-account-store';
import type { AppRegistry, InstalledAppRecord, RunningAppProcess } from '../core/main-process-types';
import type { AppLastErrorOperation, CatalogApp, CloudSyncSettings, RuntimeStatus, Settings } from '../../shared/types';

interface RegistryStoreDeps {
  DEFAULT_NODE_VERSION: string;
  DEFAULT_PYTHON_VERSION: string;
  DevCatalogService: typeof DevCatalogService;
  app: Electron.App;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  catalogApps: CatalogApp[];
  cloudSyncSettings: CloudSyncSettings;
  emitRuntimeStatus: (payload: RuntimeStatus) => void;
  forgerAccount: StoredForgerAccount;
  fs: typeof fs;
  getCloudSyncSettingsPath: () => string;
  getPrivateAppsRoot: () => string;
  getRegistryBackupPath: () => string;
  getRegistryPath: () => string;
  isDev: boolean;
  isVersionNewer: (candidate?: string, current?: string) => boolean;
  localCatalogJsonUrl: string | null | undefined;
  setCatalogApps?: (apps: CatalogApp[]) => void;
  setCloudSyncSettings?: (settings: CloudSyncSettings) => void;
  setDevCatalogService?: (service: InstanceType<typeof DevCatalogService> | null) => void;
  setLocalCatalogJsonUrl?: (url: string | undefined) => void;
  setRegistry?: (registry: AppRegistry) => void;
  normalizeNodeRuntimeVersion: (value?: string | null) => string;
  normalizeVersionForFolder: (value: string) => string;
  path: typeof path;
  registry: AppRegistry;
  runningApps: Map<string, RunningAppProcess>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  settings: Settings;
}

export const createRegistryStoreController = (deps: RegistryStoreDeps) => {
  let { catalogApps, cloudSyncSettings, localCatalogJsonUrl, registry } = deps;
  const { DEFAULT_PYTHON_VERSION, DevCatalogService, appendInstallLog, emitRuntimeStatus, fs, getCloudSyncSettingsPath, getPrivateAppsRoot, getRegistryBackupPath, getRegistryPath, isDev, isVersionNewer, normalizeNodeRuntimeVersion, normalizeVersionForFolder, path, runningApps, forgerAccount, serializeErrorForInstallLog, setCatalogApps, setCloudSyncSettings, setDevCatalogService, setLocalCatalogJsonUrl, setRegistry } = deps;
let devCatalogService: InstanceType<typeof DevCatalogService> | null = null;
const startDevCatalogService = async (): Promise<void> => {
  if (!isDev || !process.env.FORGER_LOCAL_APPS?.trim()) {
    return;
  }

  devCatalogService = new DevCatalogService();
  setDevCatalogService?.(devCatalogService);
  try {
    await devCatalogService.start();
    localCatalogJsonUrl = devCatalogService.url;
    setLocalCatalogJsonUrl?.(localCatalogJsonUrl);
    await appendInstallLog('dev_catalog:start', {
      catalogUrl: localCatalogJsonUrl,
      localApps: process.env.FORGER_LOCAL_APPS,
    });
  } catch (error) {
    devCatalogService = null;
    setDevCatalogService?.(null);
    setLocalCatalogJsonUrl?.(undefined);
    await appendInstallLog('dev_catalog:failed', {
      localApps: process.env.FORGER_LOCAL_APPS,
      error: serializeErrorForInstallLog(error),
    });
    console.warn('Failed to start Forger dev catalog service', error);
  }
};

const parseRegistry = (raw: string): AppRegistry | null => {
  const parsed = JSON.parse(raw) as Partial<AppRegistry>;
  if (!parsed || !parsed.apps || typeof parsed.apps !== 'object') {
    return null;
  }

  return { apps: parsed.apps as Record<string, InstalledAppRecord> };
};

const isAppLastErrorOperation = (value: unknown): value is AppLastErrorOperation =>
  value === 'install' || value === 'open' || value === 'runtime' || value === 'update';

const normalizeInstalledAppRecord = (record: InstalledAppRecord): InstalledAppRecord => {
  const pythonVersion =
    typeof record.requiredPythonVersion === 'string' && record.requiredPythonVersion.trim()
      ? normalizeVersionForFolder(record.requiredPythonVersion.trim())
      : DEFAULT_PYTHON_VERSION;
  const inferredLastErrorOperation = record.status === 'error'
    ? isAppLastErrorOperation(record.lastErrorOperation)
      ? record.lastErrorOperation
      : typeof record.installDir === 'string' && record.installDir.trim()
        ? 'open'
        : 'install'
    : undefined;
  return {
    ...record,
    requiredNodeVersion: normalizeNodeRuntimeVersion(record.requiredNodeVersion),
    requiredPythonVersion: pythonVersion,
    lastErrorOperation: inferredLastErrorOperation,
  };
};

const normalizeRegistryRuntimeVersions = (input: AppRegistry): { registry: AppRegistry; changed: boolean } => {
  let changed = false;
  const apps = Object.fromEntries(
    Object.entries(input.apps).map(([appId, record]) => {
      const normalized = normalizeInstalledAppRecord(record);
      if (
        normalized.requiredNodeVersion !== record.requiredNodeVersion ||
        normalized.requiredPythonVersion !== record.requiredPythonVersion ||
        normalized.lastErrorOperation !== record.lastErrorOperation
      ) {
        changed = true;
      }
      return [appId, normalized];
    }),
  );
  return { registry: { apps }, changed };
};

const readManifestAccessFlags = async (installDir: string): Promise<{
  localNetworkShareSupported: boolean;
  remoteTunnelSupported: boolean;
} | null> => {
  try {
    const raw = await fs.readFile(path.join(installDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return null;
    }
    const record = manifest as { localNetworkShare?: unknown; remoteTunnel?: unknown };
    return {
      localNetworkShareSupported: record.localNetworkShare === true,
      remoteTunnelSupported: record.remoteTunnel === true,
    };
  } catch {
    return null;
  }
};

const reconcileRegistryAccessFlags = async (input: AppRegistry): Promise<{ registry: AppRegistry; changed: boolean }> => {
  let changed = false;
  const apps = Object.fromEntries(await Promise.all(
    Object.entries(input.apps).map(async ([appId, record]) => {
      if (typeof record.installDir !== 'string' || !record.installDir.trim()) {
        return [appId, record] as const;
      }
      const flags = await readManifestAccessFlags(record.installDir);
      if (!flags) {
        return [appId, record] as const;
      }
      if (
        record.localNetworkShareSupported === flags.localNetworkShareSupported &&
        record.remoteTunnelSupported === flags.remoteTunnelSupported
      ) {
        return [appId, record] as const;
      }
      changed = true;
      return [appId, {
        ...record,
        localNetworkShareSupported: flags.localNetworkShareSupported,
        remoteTunnelSupported: flags.remoteTunnelSupported,
      }] as const;
    }),
  ));
  return { registry: { apps }, changed };
};

const isPathInside = (candidate: string, root: string): boolean => {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
};

const filterRegistryForCurrentEnvironment = (input: AppRegistry): { registry: AppRegistry; changed: boolean } => {
  let changed = false;
  const privateAppsRoot = getPrivateAppsRoot();
  const apps = Object.fromEntries(
    Object.entries(input.apps).filter(([, record]) => {
      if (typeof record.installDir !== 'string' || !record.installDir.trim()) {
        return true;
      }
      const belongsToEnvironment = isPathInside(record.installDir, privateAppsRoot);
      changed ||= !belongsToEnvironment;
      return belongsToEnvironment;
    }),
  );
  return { registry: { apps }, changed };
};

const loadRegistryFile = async (registryPath: string): Promise<AppRegistry | null> => {
  try {
    return parseRegistry(await fs.readFile(registryPath, 'utf8'));
  } catch {
    return null;
  }
};

const syncDirectory = async (directoryPath: string): Promise<void> => {
  let directoryHandle: fs.FileHandle | null = null;
  try {
    directoryHandle = await fs.open(directoryPath, 'r');
    await directoryHandle.sync();
  } catch {
    // Some platforms do not allow fsync on directories.
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
};

const loadRegistry = async (): Promise<void> => {
  const registryPaths = [getRegistryPath(), getRegistryBackupPath()];

  for (const registryPath of registryPaths) {
    const loadedRegistry = await loadRegistryFile(registryPath);
    if (loadedRegistry) {
      const normalized = normalizeRegistryRuntimeVersions(loadedRegistry);
      const filtered = filterRegistryForCurrentEnvironment(normalized.registry);
      const reconciled = await reconcileRegistryAccessFlags(filtered.registry);
      registry = reconciled.registry;
      setRegistry?.(registry);
      if (normalized.changed || filtered.changed || reconciled.changed) {
        await saveRegistry();
      }
      return;
    }
  }

  registry = { apps: {} };
  setRegistry?.(registry);
};

const saveRegistry = async (): Promise<void> => {
  const registryPath = getRegistryPath();
  const backupPath = getRegistryBackupPath();
  const registryDir = path.dirname(registryPath);
  const tempPath = path.join(registryDir, `.app_registry.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(registry, null, 2);
  await fs.mkdir(registryDir, { recursive: true });

  let tempHandle: fs.FileHandle | null = null;
  try {
    tempHandle = await fs.open(tempPath, 'w');
    await tempHandle.writeFile(payload, 'utf8');
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = null;

    const currentRegistry = await loadRegistryFile(registryPath);
    if (currentRegistry) {
      await fs.copyFile(registryPath, backupPath);
    }

    await fs.rename(tempPath, registryPath);
    await syncDirectory(registryDir);
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

const loadCloudSyncSettings = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(getCloudSyncSettingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as CloudSyncSettings;
    cloudSyncSettings = {
      appSync: parsed && typeof parsed.appSync === 'object' && parsed.appSync ? parsed.appSync : {},
    };
  } catch {
    cloudSyncSettings = { appSync: {} };
  }
  setCloudSyncSettings?.(cloudSyncSettings);
};

const saveCloudSyncSettings = async (): Promise<void> => {
  const settingsPath = getCloudSyncSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(cloudSyncSettings, null, 2), 'utf8');
};

const setAppAutoSyncSetting = async (appId: string, autoSync: boolean): Promise<CloudSyncSettings> => {
  cloudSyncSettings = {
    appSync: {
      ...cloudSyncSettings.appSync,
      [appId]: { autoSync },
    },
  };
  setCloudSyncSettings?.(cloudSyncSettings);
  await saveCloudSyncSettings();
  return cloudSyncSettings;
};

const canUseCloudDataSync = (): boolean => {
  const tier = forgerAccount.user?.subscriptionTier;
  return Boolean(forgerAccount.authenticated && forgerAccount.token && (tier === 'demo' || tier === 'pro'));
};

const upsertInstalledRecord = async (record: InstalledAppRecord): Promise<void> => {
  const normalized = normalizeInstalledAppRecord(record);
  registry.apps[normalized.appId] = normalized;
  setRegistry?.(registry);
  await saveRegistry();
  emitRuntimeStatus({
    appId: normalized.appId,
    status: runningApps.has(normalized.appId) ? 'running' : normalized.status,
    userMessage: normalized.userMessage,
    backendUrl: runningApps.get(normalized.appId)?.backendUrl,
    frontendUrl: runningApps.get(normalized.appId)?.frontendUrl,
  });
};

const removeInstalledRecord = async (appId: string): Promise<void> => {
  delete registry.apps[appId];
  setRegistry?.(registry);
  await saveRegistry();
};

const ensureCatalogStatuses = (): void => {
  catalogApps = catalogApps.map((appEntry) => {
    const installed = registry.apps[appEntry.id];
    const running = runningApps.has(appEntry.id);

    return {
      ...appEntry,
      status: installed ? (running ? 'running' : installed.status) : 'not_installed',
      userMessage: installed?.userMessage,
      lastErrorOperation: installed?.lastErrorOperation,
      version: installed?.version ?? appEntry.version,
      latestVersion: appEntry.latestVersion,
      iconUrl: appEntry.iconUrl,
      updateAvailable: installed ? isVersionNewer(appEntry.latestVersion, installed.version) : false,
    };
  });
  setCatalogApps?.(catalogApps);
};

  return { startDevCatalogService, parseRegistry, normalizeInstalledAppRecord, normalizeRegistryRuntimeVersions, reconcileRegistryAccessFlags, filterRegistryForCurrentEnvironment, loadRegistryFile, syncDirectory, loadRegistry, saveRegistry, loadCloudSyncSettings, saveCloudSyncSettings, setAppAutoSyncSetting, canUseCloudDataSync, upsertInstalledRecord, removeInstalledRecord, ensureCatalogStatuses };
};
