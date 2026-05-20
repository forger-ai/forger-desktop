// @ts-nocheck

type RegistryStoreDeps = Record<string, any>;

export const createRegistryStoreController = (deps: RegistryStoreDeps) => {
  const { DevCatalogService, app, localCatalogJsonUrl, appendInstallLog, backendBaseUrl, catalogApps, normalizeNodeRuntimeVersion, DEFAULT_NODE_VERSION, registry, fs, getRegistryPath, getRegistryBackupPath, getCloudSyncSettingsPath, cloudSyncSettings, forgerAccount, settings, isVersionNewer } = deps;
const startDevCatalogService = async (): Promise<void> => {
  if (!isDev || !process.env.FORGER_LOCAL_APPS?.trim()) {
    return;
  }

  devCatalogService = new DevCatalogService();
  try {
    await devCatalogService.start();
    localCatalogJsonUrl = devCatalogService.url;
    await appendInstallLog('dev_catalog:start', {
      catalogUrl: localCatalogJsonUrl,
      localApps: process.env.FORGER_LOCAL_APPS,
    });
  } catch (error) {
    devCatalogService = null;
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

const normalizeInstalledAppRecord = (record: InstalledAppRecord): InstalledAppRecord => {
  const pythonVersion =
    typeof record.requiredPythonVersion === 'string' && record.requiredPythonVersion.trim()
      ? normalizeVersionForFolder(record.requiredPythonVersion.trim())
      : DEFAULT_PYTHON_VERSION;
  return {
    ...record,
    requiredNodeVersion: normalizeNodeRuntimeVersion(record.requiredNodeVersion),
    requiredPythonVersion: pythonVersion,
  };
};

const normalizeRegistryRuntimeVersions = (input: AppRegistry): { registry: AppRegistry; changed: boolean } => {
  let changed = false;
  const apps = Object.fromEntries(
    Object.entries(input.apps).map(([appId, record]) => {
      const normalized = normalizeInstalledAppRecord(record);
      if (
        normalized.requiredNodeVersion !== record.requiredNodeVersion ||
        normalized.requiredPythonVersion !== record.requiredPythonVersion
      ) {
        changed = true;
      }
      return [appId, normalized];
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
      registry = normalized.registry;
      if (normalized.changed) {
        await saveRegistry();
      }
      return;
    }
  }

  registry = { apps: {} };
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
      version: installed?.version ?? appEntry.version,
      latestVersion: appEntry.latestVersion,
      iconUrl: appEntry.iconUrl,
      updateAvailable: installed ? isVersionNewer(appEntry.latestVersion, installed.version) : false,
    };
  });
};

  return { startDevCatalogService, parseRegistry, normalizeInstalledAppRecord, normalizeRegistryRuntimeVersions, loadRegistryFile, syncDirectory, loadRegistry, saveRegistry, loadCloudSyncSettings, saveCloudSyncSettings, setAppAutoSyncSetting, canUseCloudDataSync, upsertInstalledRecord, removeInstalledRecord, ensureCatalogStatuses };
};
