import { createHash } from 'node:crypto';
import os from 'node:os';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import { getSharedCopy, installProgressByPhase } from '../../shared/i18n';
import { buildFailureDiagnostic } from '../../shared/error-diagnostics';
import type { ForgerBackendClient } from '../forger-backend-client';
import type { OfficialToolsService } from '../official-tools-service';
import type { BackupsManager } from '../backups-manager';
import type {
  AppManifest,
  AppRegistry,
  InstalledAppRecord,
  RuntimeBinarySet,
  RunningAppProcess,
} from '../core/main-process-types';
import type {
  AppDetails,
  AppAgent,
  AppLocalChangeSummary,
  AppOperationSummary,
  AppPromptReviewItem,
  AppPromptTemplate,
  AppStatus,
  AppSummary,
  BasicActionResult,
  CatalogApp,
  InstallAppResult,
  OpenAppResult,
  RuntimeStatus,
  StopAppResult,
  PrepareSocialAppReviewInput,
  SocialAppQuarantineRecord,
  FailureDiagnosticFields,
} from '../../shared/types';

interface SocialInstallInput {
  appId?: number;
  appSlug?: string;
  shareCode?: string;
  trustDecision?: 'not_reviewed' | 'reviewed' | 'skipped_review';
}

interface SocialReviewPromptContext {
  appRoot: string;
  runRoot: string;
  appStack: string;
  runtime: string;
}

interface CommandCaptureResult {
  code?: number | null;
  stdout: string;
  stderr: string;
}

interface InstallWelcomeResult {
  success: boolean;
  appId: string;
  message?: string;
  usedCodex: boolean;
  userMessage: string;
  technicalCode?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}

interface InstalledAppLifecycleDeps {
  DEFAULT_NODE_VERSION: string;
  DEFAULT_PYTHON_VERSION: string;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  app: Electron.App;
  backendPythonEnvironmentLocks: Map<string, Promise<void>>;
  catalogApps: CatalogApp[];
  clearMacQuarantine: (targetPath: string) => Promise<void>;
  closeAppWindow: (appId: string) => void;
  collectPersistentInstallPaths: (manifest: AppManifest | null) => string[];
  copyReleaseContentsForUpdate: (sourceDir: string, targetDir: string, preservedPaths: string[]) => Promise<void>;
  emitInstallProgress: (appId: string, payload: InstallAppResult) => void;
  emitRuntimeStatus: (payload: RuntimeStatus) => void;
  ensureAppGitRepository: (cwd: string) => Promise<void>;
  ensureCatalogStatuses: () => void;
  ensureGlobalAgentsContext: (forgerHomeRoot: string) => Promise<void>;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  ensureUserModifiedBranch: (cwd: string) => Promise<void>;
  extractArchive: (archivePath: string, destination: string) => Promise<void>;
  failureDiagnostic: (error: unknown, fallbackCode: string) => ReturnType<typeof buildFailureDiagnostic>;
  flattenSingleTopLevelDirectory: (targetDir: string) => Promise<void>;
  forgerBackendClient: ForgerBackendClient | null;
  fs: typeof fs;
  getBackupsManager: () => BackupsManager;
  getForgerHomeRoot: () => string;
  getForgerMetadataRoot: () => string;
  getGitHead: (cwd: string) => Promise<string | null>;
  getInstallLogPath: () => string;
  getLegacyForgerMetadataRoot: () => string;
  getOfficialToolsService: () => OfficialToolsService;
  getOriginalCommitSha: (cwd: string) => Promise<string | undefined>;
  getPrivateAppsRoot: () => string;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  getTempRoot: () => string;
  getUserVisibleGitStatusLines: (cwd: string) => Promise<string[]>;
  gitCommitAllExcept: (cwd: string, message: string, excludedPaths: string[]) => Promise<string>;
  installAppDependencies: (
    appId: string,
    installDir: string,
    nodeVersion: string,
    pythonVersion: string,
    publishProgress: (phase: InstallAppResult['phase'], userMessage: string) => Promise<void>,
    messages?: ReturnType<typeof getSharedCopy>['install'],
  ) => Promise<void>;
  installFrontendDependenciesWithNpm: (nodePath: string, npmPath: string, frontendDir: string, appId: string) => Promise<void>;
  isVersionNewer: (candidate?: string, current?: string) => boolean;
  listAppPrompts: (appId: string) => Promise<AppPromptReviewItem[]>;
  listCatalogFromBackend: () => Promise<CatalogApp[]>;
  normalizeInstalledAgentContext: (installDir: string, appId: string) => Promise<void>;
  normalizeNodeRuntimeVersion: (value?: string | null) => string;
  normalizeVersionForFolder: (value: string) => string;
  openInstalledAppUnlocked: (appId: string, locale?: string, options?: { openWindow?: boolean }) => Promise<OpenAppResult>;
  path: typeof path;
  registry: AppRegistry;
  removeInstalledRecord: (appId: string) => Promise<void>;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  resolveInstalledPromptTemplates: (appId: string) => Promise<AppPromptTemplate[]>;
  resolvePlatformAlias: () => string;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  runCommandCapture: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<CommandCaptureResult>;
  runtimeError: (message: string, technicalCode: string, phase?: InstallAppResult['phase']) => InstallAppResult;
  runningApps: Map<string, RunningAppProcess>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  stopInstalledApp: (appId: string) => Promise<StopAppResult>;
  syncAppToCloudIfEnabled: (appId: string) => Promise<void>;
  syncReleaseIntoInstalledApp: (sourceDir: string, targetDir: string, preservedPaths: string[]) => Promise<void>;
  toAppSummary: (record: InstalledAppRecord) => AppSummary;
  truncateForInstallLog: (value: string) => string;
  upsertInstalledRecord: (record: InstalledAppRecord) => Promise<void>;
  validateArchiveEntries: (archivePath: string) => Promise<void>;
}

export const createInstalledAppLifecycleController = (deps: InstalledAppLifecycleDeps) => {
  let { catalogApps } = deps;
  const { DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION, appendInstallLog, backendPythonEnvironmentLocks, clearMacQuarantine, closeAppWindow, collectPersistentInstallPaths, emitInstallProgress, emitRuntimeStatus, ensureAppGitRepository, ensureCatalogStatuses, ensureGlobalAgentsContext, ensureRuntimeInstalled, ensureUserModifiedBranch, extractArchive, failureDiagnostic, flattenSingleTopLevelDirectory, forgerBackendClient, fs, getBackupsManager, getForgerHomeRoot, getForgerMetadataRoot, getGitHead, getInstallLogPath, getLegacyForgerMetadataRoot, getOfficialToolsService, getOriginalCommitSha, getPrivateAppsRoot, getRuntimeStatus, getTempRoot, getUserVisibleGitStatusLines, gitCommitAllExcept, installAppDependencies, installFrontendDependenciesWithNpm, isVersionNewer, listAppPrompts, listCatalogFromBackend, normalizeInstalledAgentContext, normalizeNodeRuntimeVersion, normalizeVersionForFolder, openInstalledAppUnlocked, path, registry, removeInstalledRecord, resolveInstalledAgents, resolveInstalledManifest, resolveInstalledPromptTemplates, resolvePlatformAlias, runCommand, runCommandCapture, runningApps, runtimeError, serializeErrorForInstallLog, stopInstalledApp, syncAppToCloudIfEnabled, syncReleaseIntoInstalledApp, toAppSummary, truncateForInstallLog, upsertInstalledRecord, validateArchiveEntries } = deps;
const fetchDownloadBundle = async (
  appEntry: CatalogApp,
): Promise<{ zipPath: string; version: string; checksumSha256?: string }> => {
  let downloadUrl = appEntry.downloadUrl;
  let resolvedVersion = appEntry.latestVersion;
  let expectedChecksum = appEntry.checksumSha256;

  if (!downloadUrl) {
    if (!appEntry.latestVersionId || !forgerBackendClient) {
      throw new Error('download_url_missing');
    }

    const payload = await forgerBackendClient.requestDownload(appEntry.latestVersionId, {
      platform: resolvePlatformAlias(),
      deviceIdentifier: os.hostname(),
    });

    downloadUrl = payload.download_url;
    resolvedVersion = payload.version.version;
    expectedChecksum = payload.version.checksum_sha256 ?? expectedChecksum;
  }

  if (downloadUrl.startsWith('file://')) {
    const sourcePath = decodeURIComponent(new URL(downloadUrl).pathname);
    const zipPath = path.join(getTempRoot(), `${appEntry.id}-${Date.now()}.zip`);
    await fs.mkdir(path.dirname(zipPath), { recursive: true });
    await fs.copyFile(sourcePath, zipPath);
    if (expectedChecksum) {
      const buffer = await fs.readFile(zipPath);
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== expectedChecksum) {
        throw new Error('app_zip_checksum_mismatch');
      }
    }
    return {
      zipPath,
      version: resolvedVersion ?? '0.0.0',
      checksumSha256: expectedChecksum ?? undefined,
    };
  }

  const zipResponse = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/zip',
    },
  });

  if (!zipResponse.ok) {
    throw new Error(`download_blob_failed_${zipResponse.status}`);
  }

  const arrayBuffer = await zipResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const zipPath = path.join(getTempRoot(), `${appEntry.id}-${Date.now()}.zip`);
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, buffer);

  if (expectedChecksum) {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual !== expectedChecksum) {
      throw new Error('app_zip_checksum_mismatch');
    }
  }

  return {
    zipPath,
    version: resolvedVersion ?? '0.0.0',
    checksumSha256: expectedChecksum ?? undefined,
  };
};

const getVenvExecutables = (backendDir: string): { python: string; pip: string } => {
  if (process.platform === 'win32') {
    return {
      python: path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
      pip: path.join(backendDir, '.venv', 'Scripts', 'pip.exe'),
    };
  }

  return {
    python: path.join(backendDir, '.venv', 'bin', 'python'),
    pip: path.join(backendDir, '.venv', 'bin', 'pip'),
  };
};

const socialLocalAppId = (ownerUsername: string, slug: string): string => {
  const safeOwner = ownerUsername.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return `social-${safeOwner}-${safeSlug}`.slice(0, 96);
};

const socialQuarantineRoot = () => path.join(getForgerMetadataRoot(), 'social-app-quarantine');
const socialQuarantineIndexPath = () => path.join(socialQuarantineRoot(), 'index.json');

const readSocialQuarantines = async (): Promise<Record<string, SocialAppQuarantineRecord>> => {
  const raw = await fs.readFile(socialQuarantineIndexPath(), 'utf8').catch(() => '{}');
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, SocialAppQuarantineRecord>
      : {};
  } catch {
    return {};
  }
};

const writeSocialQuarantines = async (records: Record<string, SocialAppQuarantineRecord>) => {
  await fs.mkdir(socialQuarantineRoot(), { recursive: true });
  await fs.writeFile(socialQuarantineIndexPath(), JSON.stringify(records, null, 2), 'utf8');
};

const upsertSocialQuarantine = async (record: SocialAppQuarantineRecord) => {
  const records = await readSocialQuarantines();
  records[record.quarantineId] = record;
  await writeSocialQuarantines(records);
};

const getSocialQuarantine = async (quarantineId: string) => {
  const records = await readSocialQuarantines();
  return records[quarantineId];
};

const installBackendDependenciesWithUv = async (
  pythonPath: string,
  backendDir: string,
  appId: string,
): Promise<void> => {
  await runCommand(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'uv'], {
    cwd: backendDir,
    log: {
      appId,
      phase: 'installing_backend',
      label: 'install pip and uv',
    },
  });

  const lockPath = path.join(backendDir, 'uv.lock');
  const uvArgs = ['-m', 'uv', 'sync', '--no-install-project', '--extra', 'dev'];

  try {
    await fs.access(lockPath);
    uvArgs.push('--frozen');
  } catch {
    // Without uv.lock, we still sync from pyproject.
  }

  await runCommand(pythonPath, uvArgs, {
    cwd: backendDir,
    env: {
      UV_PROJECT_ENVIRONMENT: path.join(backendDir, '.venv'),
      UV_PYTHON: pythonPath,
    },
    log: {
      appId,
      phase: 'installing_backend',
      label: 'uv sync',
    },
  });
};

const ensureManagedPythonUv = async (
  pythonPath: string,
  backendDir: string,
  appId: string,
): Promise<void> => {
  await runCommand(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'uv'], {
    cwd: backendDir,
    log: {
      appId,
      phase: 'installing_backend',
      label: 'install pip and uv',
    },
  });
};

const isBackendPythonEnvironmentUsable = async (
  pythonPath: string,
  backendDir: string,
): Promise<{ usable: boolean; detail?: string; stdout?: string; stderr?: string }> => {
  const venv = getVenvExecutables(backendDir);
  try {
    await fs.access(venv.python);
  } catch (error) {
    return {
      usable: false,
      detail: 'venv_python_missing',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const result = await runCommandCapture(
      pythonPath,
      ['-m', 'uv', '--version'],
      {
        cwd: backendDir,
        env: { PYTHONNOUSERSITE: '1' },
        timeoutMs: 15_000,
      },
    );
    if (result.code !== 0) {
      return {
        usable: false,
        detail: `managed_uv_missing_${result.code ?? 'signal'}`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
  } catch (error) {
    return {
      usable: false,
      detail: 'managed_uv_check_failed',
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }

  try {
    const result = await runCommandCapture(
      venv.python,
      [
        '-c',
        'import fastapi, pydantic_core, sqlmodel, uvicorn',
      ],
      {
        cwd: backendDir,
        env: { PYTHONNOUSERSITE: '1' },
        timeoutMs: 15_000,
      },
    );
    return {
      usable: result.code === 0,
      detail: result.code === 0 ? undefined : `venv_import_smoke_failed_${result.code ?? 'signal'}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      usable: false,
      detail: error instanceof Error ? error.message : 'venv_check_failed',
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  }
};

const ensureBackendPythonEnvironment = async (
  pythonPath: string,
  backendDir: string,
  appId: string,
  reason: string,
): Promise<void> => {
  const lockKey = path.resolve(backendDir);
  const pending = backendPythonEnvironmentLocks.get(lockKey);
  if (pending) {
    await pending;
    return;
  }

  const task = (async () => {
    const check = await isBackendPythonEnvironmentUsable(pythonPath, backendDir);
    if (check.usable) {
      await appendInstallLog('backend_python_env:ready', { appId, reason, backendDir });
      return;
    }

    await appendInstallLog('backend_python_env:repair_start', {
      appId,
      reason,
      backendDir,
      detail: check.detail,
      stdout: truncateForInstallLog(check.stdout ?? ''),
      stderr: truncateForInstallLog(check.stderr ?? ''),
    });
    if (check.detail?.startsWith('managed_uv_missing_') || check.detail === 'managed_uv_check_failed') {
      await ensureManagedPythonUv(pythonPath, backendDir, appId);
    } else {
      await fs.rm(path.join(backendDir, '.venv'), { recursive: true, force: true });
      await installBackendDependenciesWithUv(pythonPath, backendDir, appId);
    }
    const repaired = await isBackendPythonEnvironmentUsable(pythonPath, backendDir);
    if (!repaired.usable) {
      await appendInstallLog('backend_python_env:repair_failed', {
        appId,
        reason,
        backendDir,
        detail: repaired.detail,
        stdout: truncateForInstallLog(repaired.stdout ?? ''),
        stderr: truncateForInstallLog(repaired.stderr ?? ''),
      });
      throw new Error(`backend_python_env_unusable_${repaired.detail ?? 'unknown'}`);
    }
    await appendInstallLog('backend_python_env:repair_ready', { appId, reason, backendDir });
  })();

  backendPythonEnvironmentLocks.set(lockKey, task);
  try {
    await task;
  } finally {
    backendPythonEnvironmentLocks.delete(lockKey);
  }
};

const installAppRuntime = async (appId: string, localeInput?: string): Promise<InstallAppResult> => {
  const copy = getSharedCopy(localeInput);
  const catalogApp = catalogApps.find((entry) => entry.id === appId);
  if (!catalogApp) {
    return runtimeError(copy.install.catalogMissing, 'catalog_app_missing');
  }

  const toolGate = await getOfficialToolsService().getInstallGate(appId);
  const unavailableRequiredTools = (toolGate?.required ?? []).filter((item) => !item.available || !item.configured);
  if (unavailableRequiredTools.length > 0) {
    await appendInstallLog('install:required_tools_unavailable', {
      appId,
      tools: unavailableRequiredTools.map((item) => ({
        toolId: item.declaration.toolId,
        available: item.available,
        configured: item.configured,
      })),
    });
  }

  const initialRecord: InstalledAppRecord = {
    appId,
    category: catalogApp.category,
    name: catalogApp.name ?? appId,
    description: catalogApp.description ?? '',
    longDescription: catalogApp.longDescription,
    version: catalogApp.latestVersion ?? '0.0.0',
    installDir: '',
    requiredNodeVersion: DEFAULT_NODE_VERSION,
    requiredPythonVersion: DEFAULT_PYTHON_VERSION,
    status: 'installing',
    userMessage: copy.install.preparing,
    lastErrorOperation: undefined,
    installedAt: new Date().toISOString(),
  };

  await upsertInstalledRecord(initialRecord);
  await appendInstallLog('install:start', {
    appId,
    catalogName: catalogApp.name,
    catalogVersion: catalogApp.latestVersion,
    logPath: getInstallLogPath(),
  });

  const publishProgress = async (phase: InstallAppResult['phase'], userMessage: string): Promise<void> => {
    await appendInstallLog('install:progress', {
      appId,
      phase,
      userMessage,
    });

    emitInstallProgress(appId, {
      success: true,
      phase,
      userMessage,
      progress: installProgressByPhase[phase],
    });

    const current = registry.apps[appId];
    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: 'installing',
        userMessage,
        lastErrorOperation: undefined,
      });
    }
  };

  try {
    await publishProgress('starting', copy.install.starting);

    const nodeVersion = DEFAULT_NODE_VERSION;
    const pythonVersion = catalogApp.requiredPythonVersion
      ? normalizeVersionForFolder(catalogApp.requiredPythonVersion)
      : DEFAULT_PYTHON_VERSION;

    await publishProgress('downloading', copy.install.downloading);
    const download = await fetchDownloadBundle(catalogApp);
    await appendInstallLog('install:downloaded', {
      appId,
      version: download.version,
      zipPath: download.zipPath,
      checksumSha256: download.checksumSha256,
    });

    const installRoot = path.join(getPrivateAppsRoot(), appId);
    const installDir = installRoot;
    await fs.mkdir(path.dirname(installRoot), { recursive: true });
    await fs.rm(installDir, { recursive: true, force: true });

    await publishProgress('extracting', copy.install.extracting);
    await appendInstallLog('install:extracting', {
      appId,
      installDir,
      privateAppsRoot: getPrivateAppsRoot(),
    });
    await validateArchiveEntries(download.zipPath);
    await extractArchive(download.zipPath, installDir);
    await flattenSingleTopLevelDirectory(installDir);
    await clearMacQuarantine(installDir);
    const installedManifest = await resolveInstalledManifest(installDir);
    await normalizeInstalledAgentContext(installDir, appId);
    await ensureGlobalAgentsContext(getForgerHomeRoot());
    await ensureAppGitRepository(installDir);
    const originalCommitSha = await getOriginalCommitSha(installDir);
    await ensureUserModifiedBranch(installDir);

    await publishProgress('preparing_runtime', copy.install.preparingRuntime);
    const nodeRuntime = await ensureRuntimeInstalled('node', nodeVersion);
    const pythonRuntime = await ensureRuntimeInstalled('python', pythonVersion);
    await appendInstallLog('install:runtimes_ready', {
      appId,
      nodeVersion,
      pythonVersion,
      node: nodeRuntime.node,
      npm: nodeRuntime.npm,
      python: pythonRuntime.python,
      pip: pythonRuntime.pip,
    });

    const backendDir = path.join(installDir, 'backend');
    const frontendDir = path.join(installDir, 'frontend');

    await publishProgress('installing_backend', copy.install.installingBackend);
    await installBackendDependenciesWithUv(pythonRuntime.python as string, backendDir, appId);

    await publishProgress('installing_frontend', copy.install.installingFrontend);
    await installFrontendDependenciesWithNpm(nodeRuntime.node as string, nodeRuntime.npm as string, frontendDir, appId);

    const installed: InstalledAppRecord = {
      appId,
      category: catalogApp.category,
      name: catalogApp.name ?? appId,
      description: catalogApp.description ?? '',
      longDescription: catalogApp.longDescription,
      version: download.version,
      installDir,
      requiredNodeVersion: nodeVersion,
      requiredPythonVersion: pythonVersion,
      status: 'installed',
      userMessage: copy.install.installedReady,
      lastErrorOperation: undefined,
      originalCommitSha,
      installedAt: initialRecord.installedAt,
      localNetworkShareSupported: installedManifest?.localNetworkShare === true || catalogApp.localNetworkShareSupported === true,
      remoteTunnelSupported: installedManifest?.remoteTunnel === true || catalogApp.remoteTunnelSupported === true,
    };
    await upsertInstalledRecord(installed);

    emitInstallProgress(appId, {
      success: true,
      phase: 'completed',
      userMessage: copy.install.completed,
      progress: installProgressByPhase.completed,
    });
    await appendInstallLog('install:completed', {
      appId,
      installDir,
      version: download.version,
    });

    ensureCatalogStatuses();

    return {
      success: true,
      phase: 'completed',
      userMessage: copy.install.completed,
      progress: installProgressByPhase.completed,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'install_failed_unknown');
    const current = registry.apps[appId];
    await appendInstallLog('install:failed', {
      appId,
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });

    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: 'error',
        userMessage: copy.install.failedStored,
        lastErrorOperation: 'install',
      });
    }

    emitInstallProgress(appId, {
      success: false,
      phase: 'failed',
      userMessage: copy.install.failed,
      progress: installProgressByPhase.failed,
      ...diagnostic,
    });

    ensureCatalogStatuses();

    return {
      success: false,
      phase: 'failed',
      userMessage: copy.install.failed,
      progress: installProgressByPhase.failed,
      ...diagnostic,
    };
  }
};

const prepareSocialAppReview = async (
  input: PrepareSocialAppReviewInput,
  localeInput?: string,
): Promise<{ success: boolean; quarantine?: SocialAppQuarantineRecord; userMessage: string } & FailureDiagnosticFields> => {
  if (!forgerBackendClient) {
    return { success: false, userMessage: 'Inicia sesion en Forger Cloud para revisar apps de Social.', technicalCode: 'backend_client_missing' };
  }

  try {
    const resolvedFromCode = !input.appId && !input.appSlug && input.shareCode
      ? await forgerBackendClient.resolveSocialCode(input.shareCode)
      : null;
    const download = await forgerBackendClient.requestSocialAppDownload({
      appId: input.appId ?? resolvedFromCode?.app.id,
      appSlug: input.appSlug,
      shareCode: input.shareCode,
      trustDecision: 'not_reviewed',
      platform: resolvePlatformAlias(),
      deviceIdentifier: os.hostname(),
    });
    const localAppId = socialLocalAppId(download.app.ownerUsername, download.app.slug);
    const quarantineId = `review-${localAppId}-${Date.now()}`;
    const quarantineDir = path.join(socialQuarantineRoot(), quarantineId);
    const stagedDir = path.join(quarantineDir, 'staged');
    const zipPath = path.join(quarantineDir, 'source.zip');
    const catalogEntry = catalogApps.find((entry) => entry.socialUserAppId === download.app.id);
    const catalogApp: CatalogApp = {
      id: localAppId,
      name: catalogEntry?.name ?? download.app.name ?? download.app.slug,
      shortDescription: catalogEntry?.shortDescription,
      description: catalogEntry?.description ?? `App compartida por @${download.app.ownerUsername} en Forger Social.`,
      longDescription: catalogEntry?.longDescription,
      category: catalogEntry?.category ?? 'productivity',
      status: 'not_installed',
      latestVersion: download.version.version,
      downloadUrl: download.downloadUrl,
      checksumSha256: download.version.checksumSha256,
      capabilities: download.version.capabilities.map((id) => ({ id })),
      platformCapabilities: download.version.platformCapabilities,
      tools: download.version.tools,
      agents: download.version.agents as AppAgent[] | undefined,
      promptTemplates: download.version.promptTemplates as AppPromptTemplate[] | undefined,
    };
    const bundle = await fetchDownloadBundle(catalogApp);
    await validateArchiveEntries(bundle.zipPath);
    await fs.rm(quarantineDir, { recursive: true, force: true });
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.copyFile(bundle.zipPath, zipPath);
    await extractArchive(bundle.zipPath, stagedDir);
    await flattenSingleTopLevelDirectory(stagedDir);
    await resolveInstalledManifest(stagedDir);
    await fs.rm(bundle.zipPath, { force: true }).catch(() => undefined);
    const now = new Date().toISOString();
    const quarantine: SocialAppQuarantineRecord = {
      quarantineId,
      userAppId: download.app.id,
      ...(input.appSlug ? { appSlug: input.appSlug } : {}),
      ...(input.shareCode ? { shareCode: input.shareCode } : {}),
      localAppId,
      status: 'pending_review',
      name: catalogApp.name ?? download.app.slug,
      slug: download.app.slug,
      ownerUsername: download.app.ownerUsername,
      category: catalogApp.category,
      shortDescription: catalogApp.shortDescription,
      description: catalogApp.description,
      longDescription: catalogApp.longDescription,
      version: download.version.version,
      checksumSha256: download.version.checksumSha256,
      fileSizeBytes: download.version.fileSizeBytes,
      zipPath,
      stagedDir,
      createdAt: now,
      updatedAt: now,
    };
    await upsertSocialQuarantine(quarantine);
    await appendInstallLog('social_install:quarantine_prepared', {
      quarantineId,
      appId: localAppId,
      userAppId: download.app.id,
      stagedDir,
      zipPath,
    });
    return {
      success: true,
      quarantine,
      userMessage: localeInput === 'en' ? 'App downloaded for review.' : 'App descargada para revisión.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'social_app_review_prepare_failed');
    return {
      success: false,
      userMessage: localeInput === 'en' ? 'We could not prepare this app for review.' : 'No pudimos preparar esta app para revisión.',
      ...diagnostic,
    };
  }
};

const installSocialAppRuntime = async (input: SocialInstallInput, localeInput?: string): Promise<InstallAppResult & { appId?: string }> => {
  const copy = getSharedCopy(localeInput);
  if (!forgerBackendClient) {
    return runtimeError('Inicia sesion en Forger Cloud para instalar apps de Social.', 'backend_client_missing');
  }

  try {
    const existingSocialCatalogEntry = typeof input.appId === 'number'
      ? catalogApps.find((entry) => entry.socialUserAppId === input.appId)
      : undefined;
    const resolvedFromCode = !input.appId && !input.appSlug && input.shareCode
      ? await forgerBackendClient.resolveSocialCode(input.shareCode)
      : null;
    let download = await forgerBackendClient.requestSocialAppDownload({
      appId: input.appId ?? resolvedFromCode?.app.id,
      appSlug: input.appSlug,
      shareCode: input.shareCode,
      trustDecision: input.trustDecision === 'reviewed' ? 'not_reviewed' : input.trustDecision,
      platform: resolvePlatformAlias(),
      deviceIdentifier: os.hostname(),
    });
    const localAppId = socialLocalAppId(download.app.ownerUsername, download.app.slug);
    const socialCatalogApp: CatalogApp = {
      id: localAppId,
      name: existingSocialCatalogEntry?.name ?? download.app.name ?? download.app.slug,
      shortDescription: existingSocialCatalogEntry?.shortDescription,
      description: existingSocialCatalogEntry?.description ?? `App compartida por @${download.app.ownerUsername} en Forger Social.`,
      longDescription: existingSocialCatalogEntry?.longDescription,
      category: existingSocialCatalogEntry?.category ?? 'productivity',
      status: registry.apps[localAppId]?.status ?? 'not_installed',
      latestVersion: download.version.version,
      version: registry.apps[localAppId]?.version,
      downloadUrl: download.downloadUrl,
      checksumSha256: download.version.checksumSha256,
      capabilities: download.version.capabilities.map((id) => ({ id })),
      platformCapabilities: download.version.platformCapabilities,
      tools: download.version.tools,
      agents: download.version.agents as AppAgent[] | undefined,
      promptTemplates: download.version.promptTemplates as AppPromptTemplate[] | undefined,
    };
    if (input.trustDecision === 'reviewed') {
      const reviewDir = path.join(getTempRoot(), `${localAppId}-social-review-${Date.now()}`);
      const reviewDownload = await fetchDownloadBundle(socialCatalogApp);
      try {
        await appendInstallLog('social_install:review_staging_start', {
          appId: localAppId,
          userAppId: download.app.id,
          ownerUsername: download.app.ownerUsername,
          zipPath: reviewDownload.zipPath,
          reviewDir,
          skill: 'forger-social-app-review',
        });
        await validateArchiveEntries(reviewDownload.zipPath);
        await fs.rm(reviewDir, { recursive: true, force: true });
        await fs.mkdir(reviewDir, { recursive: true });
        await extractArchive(reviewDownload.zipPath, reviewDir);
        await flattenSingleTopLevelDirectory(reviewDir);
        const reviewedManifest = await resolveInstalledManifest(reviewDir);
        await appendInstallLog('social_install:review_staging_completed', {
          appId: localAppId,
          userAppId: download.app.id,
          manifestName: reviewedManifest?.name,
          services: reviewedManifest?.services?.length ?? 0,
          scripts: Object.keys((reviewedManifest as { scripts?: Record<string, unknown> } | null)?.scripts ?? {}).length,
        });
        download = await forgerBackendClient.requestSocialAppDownload({
          appId: input.appId ?? resolvedFromCode?.app.id,
          appSlug: input.appSlug,
          shareCode: input.shareCode,
          trustDecision: 'reviewed',
          platform: resolvePlatformAlias(),
          deviceIdentifier: os.hostname(),
        });
        socialCatalogApp.latestVersion = download.version.version;
        socialCatalogApp.downloadUrl = download.downloadUrl;
        socialCatalogApp.checksumSha256 = download.version.checksumSha256;
        socialCatalogApp.capabilities = download.version.capabilities.map((id) => ({ id }));
        socialCatalogApp.platformCapabilities = download.version.platformCapabilities;
        socialCatalogApp.tools = download.version.tools;
        socialCatalogApp.agents = download.version.agents as AppAgent[] | undefined;
        socialCatalogApp.promptTemplates = download.version.promptTemplates as AppPromptTemplate[] | undefined;
      } finally {
        await fs.rm(reviewDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(reviewDownload.zipPath, { force: true }).catch(() => undefined);
      }
    } else if (input.trustDecision === 'skipped_review') {
      await appendInstallLog('social_install:review_skipped', {
        appId: localAppId,
        userAppId: download.app.id,
        ownerUsername: download.app.ownerUsername,
      });
    }
    const socialSource = {
      userAppId: download.app.id,
      slug: download.app.slug,
      ownerUsername: download.app.ownerUsername,
      installId: download.install.id,
    };
    catalogApps = [socialCatalogApp, ...catalogApps.filter((entry) => entry.id !== localAppId)];
    const existingRecord = registry.apps[localAppId];
    const updatingExistingInstall = Boolean(existingRecord?.installDir);
    const result = updatingExistingInstall
      ? await updateAppRuntime(localAppId, localeInput)
      : await installAppRuntime(localAppId, localeInput);
    if (result.success && registry.apps[localAppId]) {
      await upsertInstalledRecord({
        ...registry.apps[localAppId],
        socialSource,
      });
    }
    return { ...result, appId: localAppId, userMessage: result.success && !updatingExistingInstall ? copy.install.completed : result.userMessage };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'social_install_failed');
    return {
      success: false,
      phase: 'failed',
      userMessage: 'No pudimos instalar esta app de Social.',
      progress: installProgressByPhase.failed,
      ...diagnostic,
    };
  }
};

const deleteQuarantinedSocialApp = async (
  input: { quarantineId: string },
  localeInput?: string,
): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> => {
  const quarantine = await getSocialQuarantine(input.quarantineId);
  if (!quarantine) {
    return { success: false, userMessage: localeInput === 'en' ? 'Review not found.' : 'No encontramos esta revisión.', technicalCode: 'social_quarantine_not_found' };
  }
  const records = await readSocialQuarantines();
  records[input.quarantineId] = { ...quarantine, status: 'deleted', updatedAt: new Date().toISOString() };
  await writeSocialQuarantines(records);
  await fs.rm(path.dirname(quarantine.zipPath), { recursive: true, force: true }).catch(() => undefined);
  await appendInstallLog('social_install:quarantine_deleted', { quarantineId: input.quarantineId, appId: quarantine.localAppId });
  return { success: true, userMessage: localeInput === 'en' ? 'Review files deleted.' : 'Archivos de revisión eliminados.' };
};

const finishSocialAppInstall = async (
  input: { quarantineId: string },
  localeInput?: string,
): Promise<InstallAppResult & { appId?: string }> => {
  if (!forgerBackendClient) {
    return runtimeError('Inicia sesion en Forger Cloud para instalar apps de Social.', 'backend_client_missing');
  }
  const quarantine = await getSocialQuarantine(input.quarantineId);
  if (!quarantine || quarantine.status === 'deleted') {
    return runtimeError(localeInput === 'en' ? 'Review not found.' : 'No encontramos esta revisión.', 'social_quarantine_not_found');
  }
  const download = await forgerBackendClient.requestSocialAppDownload({
    appId: quarantine.userAppId,
    appSlug: quarantine.appSlug,
    shareCode: quarantine.shareCode,
    trustDecision: 'reviewed',
    platform: resolvePlatformAlias(),
    deviceIdentifier: os.hostname(),
  });
  const socialCatalogApp: CatalogApp = {
    id: quarantine.localAppId,
    name: quarantine.name,
    shortDescription: quarantine.shortDescription,
    description: quarantine.description,
    longDescription: quarantine.longDescription,
    category: (quarantine.category as CatalogApp['category'] | undefined) ?? 'productivity',
    status: registry.apps[quarantine.localAppId]?.status ?? 'not_installed',
    latestVersion: download.version.version,
    version: registry.apps[quarantine.localAppId]?.version,
    downloadUrl: `file://${encodeURI(quarantine.zipPath)}`,
    checksumSha256: quarantine.checksumSha256,
    capabilities: download.version.capabilities.map((id) => ({ id })),
    agents: download.version.agents as AppAgent[] | undefined,
    promptTemplates: download.version.promptTemplates as AppPromptTemplate[] | undefined,
  };
  catalogApps = [socialCatalogApp, ...catalogApps.filter((entry) => entry.id !== quarantine.localAppId)];
  const result = registry.apps[quarantine.localAppId]?.installDir
    ? await updateAppRuntime(quarantine.localAppId, localeInput)
    : await installAppRuntime(quarantine.localAppId, localeInput);
  if (result.success && registry.apps[quarantine.localAppId]) {
    await upsertInstalledRecord({
      ...registry.apps[quarantine.localAppId],
      socialSource: {
        userAppId: download.app.id,
        slug: download.app.slug,
        ownerUsername: download.app.ownerUsername,
        installId: download.install.id,
      },
    });
    await upsertSocialQuarantine({ ...quarantine, status: 'approved', updatedAt: new Date().toISOString() });
  }
  return result.success ? { ...result, appId: quarantine.localAppId } : result;
};

const getSocialAppReviewPromptContext = async (appId: string): Promise<SocialReviewPromptContext | null> => {
  const records = await readSocialQuarantines();
  const quarantine = Object.values(records).find((entry) => entry.quarantineId === appId);
  if (!quarantine || quarantine.status === 'deleted') {
    return null;
  }
  return {
    appRoot: quarantine.stagedDir,
    runRoot: quarantine.stagedDir,
    appStack: 'quarantined Social app package',
    runtime: `social review ${quarantine.version}`,
  };
};

const updateAppRuntime = async (appId: string, localeInput?: string): Promise<InstallAppResult> => {
  const copy = getSharedCopy(localeInput);
  const record = registry.apps[appId];
  const catalogApp = catalogApps.find((entry) => entry.id === appId);
  if (!record?.installDir) {
    return runtimeError(copy.update.appNotInstalled, 'app_not_installed');
  }
  if (!catalogApp) {
    return runtimeError(copy.update.catalogMissing, 'catalog_app_missing');
  }
  if (record.status === 'conflict') {
    return runtimeError(copy.update.conflictPending, 'app_update_conflict');
  }
  if (!isVersionNewer(catalogApp.latestVersion, record.version)) {
    return {
      success: true,
      phase: 'completed',
      userMessage: copy.update.alreadyLatest,
      progress: installProgressByPhase.completed,
    };
  }

  const publishProgress = async (phase: InstallAppResult['phase'], userMessage: string): Promise<void> => {
    emitInstallProgress(appId, { success: true, phase, userMessage, progress: installProgressByPhase[phase] });
    const current = registry.apps[appId];
    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: phase === 'conflict' ? 'conflict' : 'installing',
        userMessage,
        lastErrorOperation: undefined,
      });
    }
    await appendInstallLog('update:progress', { appId, phase, userMessage });
  };

  const startedAt = new Date().toISOString();
  let preUpdateUserHead = '';
  let stageDir: string | null = null;

  const abortUpdateAndRestoreInstalled = async (userMessage: string, technicalCode: string): Promise<InstallAppResult> => {
    const current = registry.apps[appId] ?? record;
    await upsertInstalledRecord({
      ...current,
      status: 'installed',
      userMessage,
      lastErrorOperation: undefined,
    });
    await appendInstallLog('update:blocked', { appId, detail: technicalCode, userMessage });
    ensureCatalogStatuses();
    return runtimeError(userMessage, technicalCode);
  };

  try {
    await publishProgress('checking_update', copy.update.checking);
    if (runningApps.has(appId)) {
      await publishProgress('checking_update', copy.update.stoppingApp);
      await appendInstallLog('update:stop_running_app', { appId });
      const stop = await stopInstalledApp(appId);
      await appendInstallLog('update:stop_running_app_done', {
        appId,
        success: stop.success,
        technicalCode: stop.technicalCode,
      });
      if (!stop.success) {
        return await abortUpdateAndRestoreInstalled(
          stop.userMessage || copy.update.stopFailed,
          stop.technicalCode || 'update_stop_failed',
        );
      }
    }
    await ensureAppGitRepository(record.installDir);
    await ensureUserModifiedBranch(record.installDir);
    const installedManifest = await resolveInstalledManifest(record.installDir);
    const preservedInstallPaths = collectPersistentInstallPaths(installedManifest);
    const status = await getUserVisibleGitStatusLines(record.installDir);
    if (status.length > 0) {
      return await abortUpdateAndRestoreInstalled(
        copy.update.dirtyWorktree,
        'dirty_worktree',
      );
    }
    preUpdateUserHead = (await getGitHead(record.installDir)) ?? '';
    if (!preUpdateUserHead) {
      throw new Error('missing_user_branch_head');
    }

    const updateBackup = await getBackupsManager().createBackup({ appId, reason: 'update' });
    if (!updateBackup.success || !updateBackup.backup) {
      return await abortUpdateAndRestoreInstalled(
        updateBackup.userMessage || copy.update.backupFailed,
        updateBackup.technicalCode || 'backup_failed',
      );
    }

    await publishProgress('downloading', copy.update.downloading);
    const download = await fetchDownloadBundle(catalogApp);
    await validateArchiveEntries(download.zipPath);

    stageDir = path.join(getTempRoot(), `${appId}-update-${Date.now()}`);
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.mkdir(stageDir, { recursive: true });
    await publishProgress('extracting', copy.update.extracting);
    await extractArchive(download.zipPath, stageDir);
    await flattenSingleTopLevelDirectory(stageDir);
    await clearMacQuarantine(stageDir);

    await runCommand('git', ['checkout', 'main'], { cwd: record.installDir });
    await syncReleaseIntoInstalledApp(stageDir, record.installDir, preservedInstallPaths);
    await normalizeInstalledAgentContext(record.installDir, appId);
    await ensureGlobalAgentsContext(getForgerHomeRoot());

    await publishProgress('updating_base', copy.update.updatingBase);
    const baseCommitSha = await gitCommitAllExcept(
      record.installDir,
      `forger(base): update ${download.version}`,
      preservedInstallPaths,
    );
    await upsertInstalledRecord({
      ...record,
      status: 'installing',
      userMessage: copy.update.merging,
      lastErrorOperation: undefined,
      pendingUpdate: {
        fromVersion: record.version,
        targetVersion: download.version,
        preUpdateUserHead,
        baseCommitSha,
        backup: updateBackup.backup,
        startedAt,
      },
    });

    await publishProgress('merging_user_changes', copy.update.merging);
    await runCommand('git', ['checkout', 'user-modified'], { cwd: record.installDir });
    const merge = await runCommandCapture('git', ['merge', 'main', '--no-edit'], {
      cwd: record.installDir,
      timeoutMs: 60_000,
    });
    if (merge.code !== 0) {
      const diagnostic = buildFailureDiagnostic({
        fallbackCode: 'merge_conflict',
        rawError: merge.stderr || merge.stdout || 'merge_conflict',
        details: { exitCode: merge.code },
      });
      await upsertInstalledRecord({
        ...record,
        status: 'conflict',
        userMessage: copy.update.mergeFailedStored,
        pendingUpdate: {
          fromVersion: record.version,
          targetVersion: download.version,
          preUpdateUserHead,
          baseCommitSha,
          backup: updateBackup.backup,
          startedAt,
          message: merge.stderr || merge.stdout || 'merge_conflict',
        },
      });
      emitInstallProgress(appId, {
        success: false,
        phase: 'conflict',
        userMessage: copy.update.mergeNeedsHelp,
        progress: installProgressByPhase.conflict,
        ...diagnostic,
      });
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      ensureCatalogStatuses();
      return {
        success: false,
        phase: 'conflict',
        userMessage: copy.update.mergeNeedsHelp,
        progress: installProgressByPhase.conflict,
        ...diagnostic,
      };
    }

    const nodeVersion = normalizeNodeRuntimeVersion(catalogApp.requiredNodeVersion ?? record.requiredNodeVersion);
    const pythonVersion = catalogApp.requiredPythonVersion
      ? normalizeVersionForFolder(catalogApp.requiredPythonVersion)
      : record.requiredPythonVersion;
    await installAppDependencies(appId, record.installDir, nodeVersion, pythonVersion, publishProgress, copy.install);

    await upsertInstalledRecord({
      ...record,
      version: download.version,
      requiredNodeVersion: nodeVersion,
      requiredPythonVersion: pythonVersion,
      status: 'installed',
      userMessage: copy.update.installedReady,
      lastErrorOperation: undefined,
      pendingUpdate: undefined,
    });
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    ensureCatalogStatuses();
    emitInstallProgress(appId, {
      success: true,
      phase: 'completed',
      userMessage: copy.update.completed,
      progress: installProgressByPhase.completed,
    });
    return {
      success: true,
      phase: 'completed',
      userMessage: copy.update.completed,
      progress: installProgressByPhase.completed,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'update_failed_unknown');
    if (stageDir) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await appendInstallLog('update:failed', {
      appId,
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    await upsertInstalledRecord({
      ...record,
      status: 'error',
      userMessage: copy.update.failedStored,
      lastErrorOperation: 'update',
    });
    ensureCatalogStatuses();
    emitInstallProgress(appId, {
      success: false,
      phase: 'failed',
      userMessage: copy.update.failed,
      progress: installProgressByPhase.failed,
      ...diagnostic,
    });
    return {
      success: false,
      phase: 'failed',
      userMessage: copy.update.failed,
      progress: installProgressByPhase.failed,
      ...diagnostic,
    };
  }
};

const restoreAppUserVersionRuntime = async (appId: string): Promise<BasicActionResult> => {
  const record = registry.apps[appId];
  if (!record?.installDir || !record.pendingUpdate) {
    return {
      success: false,
      userMessage: 'No hay una actualizacion en conflicto para restaurar.',
      technicalCode: 'no_pending_update_conflict',
    };
  }

  try {
    await runCommandCapture('git', ['merge', '--abort'], { cwd: record.installDir, timeoutMs: 30_000 }).catch(
      () => undefined,
    );
    await runCommand('git', ['checkout', 'user-modified'], { cwd: record.installDir });
    await runCommand('git', ['reset', '--hard', record.pendingUpdate.preUpdateUserHead], { cwd: record.installDir });
    await upsertInstalledRecord({
      ...record,
      version: record.pendingUpdate.fromVersion,
      status: 'installed',
      userMessage: 'Restauramos tu version anterior.',
      lastErrorOperation: undefined,
      pendingUpdate: undefined,
    });
    ensureCatalogStatuses();
    return {
      success: true,
      userMessage: 'Restauramos tu version anterior.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'restore_failed');
    return {
      success: false,
      userMessage: 'No pudimos restaurar la version anterior.',
      ...diagnostic,
    };
  }
};

interface StoredOperationEntry {
  operationId?: string;
  runId?: string;
  appId?: string;
  commitSha?: string;
  createdAt?: string;
  title?: string;
  summary?: string;
  revertedAt?: string;
}

const operationsFile = (appId: string): string =>
  path.join(getForgerMetadataRoot(), 'operations', `${appId}.json`);

const legacyOperationsFile = (appId: string): string =>
  path.join(getLegacyForgerMetadataRoot(), 'operations', `${appId}.json`);

const readOperationSummaries = async (appId: string): Promise<AppOperationSummary[]> => {
  const raw = await fs.readFile(operationsFile(appId), 'utf8').catch(async () => {
    return await fs.readFile(legacyOperationsFile(appId), 'utf8').catch(() => '[]');
  });
  try {
    const parsed = JSON.parse(raw) as StoredOperationEntry[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry) => typeof entry.createdAt === 'string')
      .map((entry) => ({
        operationId: entry.operationId ?? entry.commitSha ?? `${appId}-${entry.createdAt}`,
        runId: entry.runId,
        commitSha: entry.commitSha,
        title: entry.title?.trim() || 'Cambio aplicado',
        summary: entry.summary?.trim() || 'Forger aplico una modificacion en esta app.',
        createdAt: entry.createdAt as string,
        revertedAt: entry.revertedAt,
      }));
  } catch {
    return [];
  }
};

const readLocalChangeSummaries = async (appDir: string): Promise<AppLocalChangeSummary[]> => {
  const result = await runCommandCapture(
    'git',
    ['log', 'main..user-modified', '--max-count=10', '--pretty=format:%H%x1f%s%x1f%cI'],
    { cwd: appDir, timeoutMs: 5_000 },
  ).catch(() => null);
  if (!result || result.code !== 0 || !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.split('\x1f'))
    .filter((parts) => parts.length >= 2)
    .map(([commitSha, subject, createdAt]) => ({
      id: commitSha,
      title: subject?.replace(/^forger\([^)]+\):\s*/i, '').trim() || 'Cambio guardado',
      createdAt: createdAt || new Date().toISOString(),
    }));
};

const getAppDetails = async (appId: string): Promise<AppDetails | null> => {
  const installed = registry.apps[appId];
  let catalog = catalogApps.find((entry) => entry.id === appId);
  if (!catalog) {
    catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    catalog = catalogApps.find((entry) => entry.id === appId);
  }
  const detailStatus: AppStatus | undefined = installed
    ? runningApps.has(appId)
      ? 'running'
      : installed.status
    : undefined;
  const appEntry = installed
    ? {
        ...toAppSummary(installed),
        ...catalog,
        id: installed.appId,
        status: detailStatus ?? installed.status,
        version: installed.version,
        userMessage: installed.userMessage,
        updateAvailable: isVersionNewer(catalog?.latestVersion, installed.version),
        averageRating: catalog?.averageRating,
        ratingsCount: catalog?.ratingsCount,
        recentRatings: catalog?.recentRatings,
        currentUserRating: catalog?.currentUserRating,
      }
    : catalog;
  if (!appEntry) {
    return null;
  }

  let originalCommitSha = installed?.originalCommitSha;
  if (installed?.installDir && !originalCommitSha) {
    originalCommitSha = await getOriginalCommitSha(installed.installDir);
    await upsertInstalledRecord({ ...installed, originalCommitSha });
  }
  const agents = installed ? await resolveInstalledAgents(appId) : catalog?.agents ?? [];
  const promptReviews = installed ? await listAppPrompts(appId) : [];

  return {
    app: appEntry,
    installed: Boolean(installed),
    status: installed ? (runningApps.has(appId) ? 'running' : installed.status) : 'not_installed',
    version: installed?.version ?? catalog?.version,
    latestVersion: catalog?.latestVersion,
    updateAvailable: installed ? isVersionNewer(catalog?.latestVersion, installed.version) : false,
    changelog: catalog?.changelog,
    conflictInfo: installed?.pendingUpdate
      ? {
          fromVersion: installed.pendingUpdate.fromVersion,
          targetVersion: installed.pendingUpdate.targetVersion,
          startedAt: installed.pendingUpdate.startedAt,
          message: installed.pendingUpdate.message,
        }
      : undefined,
    originalCommitSha,
    installedAt: installed?.installedAt,
    operations: installed ? await readOperationSummaries(appId) : [],
    localChanges: installed?.installDir ? await readLocalChangeSummaries(installed.installDir) : [],
    promptTemplates: installed ? await resolveInstalledPromptTemplates(appId) : catalog?.promptTemplates ?? [],
    agents,
    promptReviews,
    codexConversation: agents.length > 0 ? { enabled: true } : undefined,
  };
};

const uninstallAppRuntime = async (appId: string): Promise<BasicActionResult> => {
  const record = registry.apps[appId];
  if (!record) {
    return {
      success: false,
      userMessage: 'Esta app no esta instalada.',
      technicalCode: 'app_not_installed',
    };
  }

  try {
    if (runningApps.has(appId)) {
      await stopInstalledApp(appId);
    }
    closeAppWindow(appId);
    if (record.installDir) {
      await fs.rm(record.installDir, { recursive: true, force: true });
    }
    await fs.rm(operationsFile(appId), { force: true });
    await removeInstalledRecord(appId);
    ensureCatalogStatuses();
    emitRuntimeStatus({
      appId,
      status: 'not_installed',
      userMessage: 'App eliminada.',
    });
    return {
      success: true,
      userMessage: 'App eliminada de tu equipo.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'uninstall_failed');
    return {
      success: false,
      userMessage: 'No pudimos eliminar la app.',
      ...diagnostic,
    };
  }
};

const normalizeLanguageCode = (value?: string): string => {
  const normalized = value?.trim().toLowerCase().replace('_', '-') ?? '';
  if (!normalized) {
    return 'en';
  }
  return normalized.split('-')[0] || 'en';
};

const normalizePostinstallText = (value: string): string =>
  value
    .replace(/^#+\s*/gm, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .join('\n');

const firstLines = (value: string, count: number): string => value.split('\n').slice(0, count).join(' ');

const readLocalizedPostinstall = async (installDir: string, userLanguage?: string): Promise<string> => {
  const language = normalizeLanguageCode(userLanguage);
  const candidates = [
    path.join(installDir, `POSTINSTALL.${language}.md`),
    path.join(installDir, 'POSTINSTALL.en.md'),
    path.join(installDir, 'POSTINSTALL.md'),
  ];

  for (const candidate of candidates) {
    const raw = await fs.readFile(candidate, 'utf8').catch(() => '');
    if (raw.trim()) {
      return raw.replace(/\r/g, '').trim();
    }
  }

  return '';
};

const buildInstallWelcomeMessage = async (record: InstalledAppRecord, userLanguage?: string): Promise<string> => {
  const raw = await readLocalizedPostinstall(record.installDir, userLanguage);
  if (raw.trim()) {
    return raw;
  }

  const language = normalizeLanguageCode(userLanguage);
  const normalized = normalizePostinstallText(raw);
  const fallbackIntro =
    record.description || (language === 'es' ? `${record.name} ya esta lista para usar.` : `${record.name} is ready to use.`);
  const lines = normalized.split('\n').filter(Boolean);
  const intro = firstLines(lines.slice(0, 3).join('\n') || fallbackIntro, 3);
  const howTo =
    lines.find((line) => /start|begin|comenzar|empezar|inicio/i.test(line)) ??
    (language === 'es'
      ? 'Abre la app para revisar sus pantallas principales y empezar con tu informacion local.'
      : 'Open the app to review its main screens and start with your local information.');
  const suggestion =
    lines.find((line) => /suggest|suger/i.test(line)) ??
    (language === 'es'
      ? 'Si quieres, puedo ayudarte a revisar la app y preparar los primeros pasos contigo.'
      : 'I can help you review the app and prepare the first steps with you.');

  if (language === 'es') {
    return [
      `${record.name} ya esta instalada.`,
      '',
      intro,
      '',
      '**Como comenzar**',
      howTo,
      '',
      '**Sugerencia para empezar**',
      suggestion,
    ].join('\n');
  }

  return [
    `${record.name} is installed.`,
    '',
    intro,
    '',
    '**How to start**',
    howTo,
    '',
    '**Suggested first request**',
    suggestion,
  ].join('\n');
};

const installWelcome = async (appId: string, userLanguage?: string): Promise<{
  success: boolean;
  appId: string;
  message?: string;
  usedCodex: boolean;
  userMessage: string;
  technicalCode?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return {
      success: false,
      appId,
      usedCodex: false,
      userMessage: 'Primero instala esta app.',
      technicalCode: 'app_not_installed',
    };
  }

  try {
    const message = await buildInstallWelcomeMessage(record, userLanguage);
    return {
      success: true,
      appId,
      message,
      usedCodex: false,
      userMessage: 'Mensaje de bienvenida preparado.',
    };
  } catch (error) {
    return {
      success: false,
      appId,
      usedCodex: false,
      userMessage: 'No pudimos preparar el mensaje inicial.',
      ...failureDiagnostic(error, 'install_welcome_failed'),
    };
  }
};

  return { fetchDownloadBundle, getVenvExecutables, installBackendDependenciesWithUv, ensureBackendPythonEnvironment, installAppRuntime, prepareSocialAppReview, finishSocialAppInstall, deleteQuarantinedSocialApp, getSocialAppReviewPromptContext, installSocialAppRuntime, updateAppRuntime, restoreAppUserVersionRuntime, readOperationSummaries, readLocalChangeSummaries, getAppDetails, uninstallAppRuntime, installWelcome };
};
