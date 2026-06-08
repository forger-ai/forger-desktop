import type { App, BrowserWindow, IpcMain, Shell } from 'electron';
import type fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { appendDesktopLog } from '../desktop-logger';
import type { DesktopErrorReporter } from '../error-reporting';
import { reportSanitizerRoots } from '../conversation-diagnostics';
import type { StoredForgerAccount } from '../forger-account-store';
import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolSettings,
  AppToolGrantRequestPreview,
  AppToolGrantRequestResult,
  AppCodexConversationEvent,
  AppCodexTaskEvent,
  AppSummary,
  BasicActionResult,
  CatalogApp,
  ChatCreatedAppRequest,
  ChatQuestion,
  ChatQuestionRequest,
  CodexAuthStatus,
  ClaudeAuthStatus,
  CreateLocalAppInput,
  CreateLocalAppResult,
  RuntimeStatus,
  SetAppToolGrantInput,
} from '../../shared/types';
import type {
  AppRegistry,
  InstalledAppRecord,
  RuntimeBinarySet,
  RunningAppProcess,
} from './main-process-types';
import {
  createStartupLoadingController,
  createStartupLogger,
} from './startup-loading';

type ServiceConstructor<T> = new (...args: unknown[]) => T;
type AsyncFn<T = unknown> = (...args: unknown[]) => Promise<T>;
type SyncFn<T = unknown> = (...args: unknown[]) => T;
type ToolAccess = { appId: string; caller: string };
type PermissionDecision = unknown;
type PermissionRequest = unknown;
type ForgerMcpSessionOptions = { caller: string; appIds: string[]; locale?: string };
type RunEventLike = {
  run: { status: string; appId: string; runId: string; errorCode?: string; userMessage?: string };
};
type TaskEventLike = AppCodexTaskEvent;
type ConversationEventLike = AppCodexConversationEvent;
type AutomationEventLike = {
  automation: { id: string; selectedAppIds: string[] };
  run?: { id: string; status?: string; error?: unknown; userMessage?: string };
};
type ForgerMcpToolFailure = { appId: string; runId: string; toolName?: unknown; error: unknown };
type ForgerMcpHttpFailure = { error: unknown; appId?: string; runId?: string };
type RemoteTunnelCloseEvent = { type: 'remote_tunnel_close'; session_id: string };

const isRemoteTunnelCloseEvent = (event: unknown): event is RemoteTunnelCloseEvent =>
  Boolean(
    event
      && typeof event === 'object'
      && (event as { type?: unknown }).type === 'remote_tunnel_close'
      && typeof (event as { session_id?: unknown }).session_id === 'string',
  );

interface LifecycleService {
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  dispose: () => void;
  initialize: () => Promise<void>;
  load: () => Promise<unknown>;
  getSummary: () => Promise<unknown>;
  getPublicRegistration: () => unknown;
  requestPermission: (runId: string, request: PermissionRequest) => Promise<PermissionDecision | null>;
  requestExternalPermission: (runId: string, request: PermissionRequest) => Promise<PermissionDecision | null>;
  createSession: (runId: string, appId: string, options: ForgerMcpSessionOptions) => string | null;
  releaseSession: (token: string) => void;
  listenMcps: (appIds: string[], runId: string) => Promise<unknown[]>;
  releaseMcps: (runId: string) => void;
  appendExternalProgress: (runId: string, message: string) => void;
  environmentForApp: (appId: string) => Record<string, string>;
  publishAgentEvent: (event: ConversationEventLike) => void;
}

interface MemoryMaintenanceService {
  initialize: () => Promise<void>;
  dispose: () => void;
}

interface ChatOrchestratorService extends LifecycleService {
  recordCreatedAppFromMcp: (runId: string, createdApp: ChatCreatedAppRequest) => void;
  registerQuestionFromMcp: (
    runId: string,
    input: { questions: ChatQuestion[] },
  ) => Promise<ChatQuestionRequest>;
}

type ServiceWithLoad<T> = Omit<LifecycleService, 'load'> & { load: () => Promise<T> };

interface MainLifecycleState {
  agentToolSettings: AgentToolSettings;
  appAgentConversationManager: LifecycleService | null;
  appAgentTaskManager: LifecycleService | null;
  appMcpManager: LifecycleService | null;
  automationManager: LifecycleService | null;
  catalogApps: CatalogApp[];
  chatOrchestrator: ChatOrchestratorService | null;
  cloudDeviceManager: LifecycleService | null;
  cloudIdentityStore: LifecycleService | null;
  desktopErrorReporter: DesktopErrorReporter | null;
  desktopRuntimeBridge: LifecycleService | null;
  devCatalogService: LifecycleService | null;
  fileLibrary: (LifecycleService & { cleanupStagedFilesForChat?: () => Promise<void> }) | null;
  forgerAccount: StoredForgerAccount;
  forgerAccountStore: ServiceWithLoad<StoredForgerAccount> | null;
  forgerBackendClient: LifecycleService | null;
  forgerMcpServer: LifecycleService | null;
  localCatalogJsonUrl: string | undefined;
  localNetworkShareManager: { stopAll?: () => Promise<void> } | null;
  remoteNetworkShareManager: { stopAll?: () => Promise<void> } | null;
  mainWindow: BrowserWindow | null;
  memoryMaintenanceManager: MemoryMaintenanceService | null;
  memoryStore: LifecycleService | null;
  officialToolsService: (LifecycleService & {
    startActiveTools: () => Promise<void>;
    listAgentActionIdsForApp: (appId: string) => Promise<string[]>;
    previewOptionalAppToolGrant: (
      input: Pick<SetAppToolGrantInput, 'appId' | 'toolId'>,
      locale?: string,
    ) => Promise<AppToolGrantRequestPreview>;
    setOptionalAppToolGrant: (input: SetAppToolGrantInput, locale?: string) => Promise<AppToolGrantRequestResult>;
    validateAgentCall: (input: unknown, access: { appId: string; requireAppGrant: boolean }) => Promise<unknown>;
    callFromAgent: (input: unknown, access: { appId: string; requireAppGrant: boolean }) => Promise<unknown>;
  }) | null;
  pendingDeepLink: unknown;
  registry: AppRegistry;
  secretsStore: LifecycleService | null;
}

interface MainLifecycleDeps {
  AGENT_TOOL_DEFINITIONS: AgentToolDefinition[];
  AppAgentConversationManager: ServiceConstructor<LifecycleService>;
  AppAgentTaskManager: ServiceConstructor<LifecycleService>;
  AppMcpManager: ServiceConstructor<LifecycleService>;
  AutomationManager: ServiceConstructor<LifecycleService>;
  BrowserWindow: typeof BrowserWindow;
  ChatOrchestrator: ServiceConstructor<ChatOrchestratorService>;
  CloudDeviceManager: ServiceConstructor<LifecycleService>;
  CloudIdentityStore: ServiceConstructor<LifecycleService>;
  DesktopRuntimeBridge: ServiceConstructor<LifecycleService>;
  DevCatalogService: ServiceConstructor<LifecycleService>;
  FORGER_AGENT_CONTRACT_VERSION: string;
  FileLibrary: ServiceConstructor<LifecycleService & { cleanupStagedFilesForChat: () => Promise<void> }>;
  ForgerAccountStore: ServiceConstructor<ServiceWithLoad<StoredForgerAccount>>;
  ForgerBackendClient: ServiceConstructor<LifecycleService>;
  ForgerMcpServer: ServiceConstructor<LifecycleService>;
  IPC_CHANNELS: Record<string, string>;
  MemoryMaintenanceManager: ServiceConstructor<MemoryMaintenanceService>;
  MemoryStore: ServiceConstructor<LifecycleService>;
  SecretsStore: ServiceConstructor<LifecycleService>;
  anyAppAllowsAgentNetworkAccess: AsyncFn<boolean>;
  app: App;
  appAllowsAgentNetworkAccess: AsyncFn<boolean>;
  appWindows: Map<string, BrowserWindow>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  backendBaseUrl: string;
  buildForgerToolsContextForApp: AsyncFn<string>;
  buildMemoryContextForApp: AsyncFn<string>;
  buildMemoryContextForApps: AsyncFn<string>;
  chooseAgentRuntime: (request?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  clearForgerAccountSession: (technicalCode: string) => Promise<void>;
  closeServer: (server: Server) => Promise<void>;
  createLocalAppFromSkeleton: (input: CreateLocalAppInput, locale?: string) => Promise<CreateLocalAppResult>;
  createWindow: () => Promise<void>;
  emitAutomationUpdated: (payload: { automation: unknown; run?: unknown }) => void;
  emitChatRunUpdated: (event: RunEventLike) => void;
  ensureBackendPythonEnvironment: AsyncFn<void>;
  ensureCatalogStatuses: () => void;
  ensureGlobalAgentsContext: (root: string) => Promise<void>;
  ensurePathInside: SyncFn<boolean>;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  ensureSqliteDatabaseParent: AsyncFn<void>;
  flushPendingDeepLink: () => void;
  fs: typeof fs;
  getAgentPathEntries: (appId?: string) => Promise<string[]>;
  getBackupsRoot: () => string;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getCloudDeviceAccountStorageKey: () => string | undefined;
  getCloudDevicePath: () => string;
  getCloudIdentityPath: () => string;
  getCloudIdentityStore: () => LifecycleService & { getPublicRegistration: () => unknown };
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getCodexHome: () => string;
  getCodexRoot: () => string;
  getCodexToolEnvironment: (appId?: string, runtime?: RuntimeBinarySet) => Promise<Record<string, string>>;
  getDesktopChatNetworkAccessDefault: () => boolean;
  getForgerAccountPath: () => string;
  getForgerHomeRoot: () => string;
  getForgerMetadataRoot: () => string;
  getFreePort: () => Promise<number>;
  getLegacyForgerMetadataRoot: () => string;
  getMemoryStore: () => { list: AsyncFn; create: AsyncFn; update: AsyncFn; delete: AsyncFn };
  getOfficialToolsService: () => NonNullable<MainLifecycleState['officialToolsService']>;
  getPrivateAppsRoot: () => string;
  getPrivateDataRoot: () => string;
  getRuntimesRoot: () => string;
  getRuntimePathEntries: (runtime: RuntimeBinarySet) => string[];
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  getLocalNetworkShareStatus: SyncFn<unknown>;
  getRemoteNetworkShareStatus: SyncFn<unknown>;
  getTempRoot: () => string;
  getVenvExecutables: SyncFn;
  handleCloudSocialEvent: AsyncFn<void>;
  hasInstalledCodexConversation: AsyncFn<boolean>;
  ipcMain: IpcMain;
  listAppPrompts: AsyncFn;
  listCatalogFromBackend: () => Promise<CatalogApp[]>;
  loadAgentToolSettings: () => Promise<void>;
  loadCloudSyncSettings: () => Promise<void>;
  loadRegistry: () => Promise<void>;
  loadSettings: () => Promise<void>;
  mapBackendCategory: SyncFn;
  openInstalledApp: AsyncFn;
  startLocalNetworkShare: AsyncFn;
  stopLocalNetworkShare: AsyncFn;
  startRemoteNetworkShare: AsyncFn;
  stopRemoteNetworkShare: AsyncFn;
  stopRemoteNetworkShareSession: (sessionId: string) => Promise<unknown>;
  openOrFocusAppWindow: (appId: string, appName: string, frontendUrl: string) => Promise<void>;
  registerForgerCloudOAuth: SyncFn;
  registerIpcHandlers: () => void;
  renderManifestAgentPrompt: SyncFn<string>;
  resolveClaudeCli: () => Promise<{ path: string; source: string } | null>;
  resolveCodexCliPath: (root: string) => Promise<string | null>;
  resolveInstalledAgents: AsyncFn;
  resolveInstalledManifest: AsyncFn;
  resolveInstalledPromptTemplates: AsyncFn;
  restoreAppPrompt: AsyncFn;
  restartInstalledApp: AsyncFn;
  runningApps: Map<string, RunningAppProcess>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  shell: Shell;
  splitManifestCommand: SyncFn;
  startDevCatalogService: () => Promise<void>;
  state: MainLifecycleState;
  stopInstalledApp: AsyncFn;
  switchForgerAccountSession: AsyncFn;
  terminateProcess: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  toAppSummary: (record: InstalledAppRecord) => AppSummary;
  toCatalogStatus: SyncFn;
  translateManifestEnvironment: SyncFn;
  truncateForInstallLog: (value: string) => string;
  testAppPrompt: AsyncFn;
  updateAppPrompt: AsyncFn;
  updateAppRuntime: AsyncFn;
  upsertInstalledRecord: (record: InstalledAppRecord) => Promise<void>;
  waitForHttpOk: AsyncFn<void>;
}

export const registerMainLifecycle = (deps: unknown) => {
  const {
    AGENT_TOOL_DEFINITIONS,
    AppAgentConversationManager,
    AppAgentTaskManager,
    AppMcpManager,
    AutomationManager,
    BrowserWindow,
    ChatOrchestrator,
    CloudDeviceManager,
    CloudIdentityStore,
    DesktopRuntimeBridge,
    DevCatalogService,
    FORGER_AGENT_CONTRACT_VERSION,
    FileLibrary,
    ForgerAccountStore,
    ForgerBackendClient,
    ForgerMcpServer,
    IPC_CHANNELS,
    MemoryMaintenanceManager,
    MemoryStore,
    SecretsStore,
    anyAppAllowsAgentNetworkAccess,
    app,
    appAllowsAgentNetworkAccess,
    appWindows,
    appendInstallLog,
    backendBaseUrl,
    buildForgerToolsContextForApp,
    buildMemoryContextForApp,
    buildMemoryContextForApps,
    chooseAgentRuntime,
    clearForgerAccountSession,
    closeServer,
    createLocalAppFromSkeleton,
    createWindow,
    emitAutomationUpdated,
    emitChatRunUpdated,
    ensureBackendPythonEnvironment,
    ensureCatalogStatuses,
    ensureGlobalAgentsContext,
    ensurePathInside,
    ensureRuntimeInstalled,
    ensureSqliteDatabaseParent,
    flushPendingDeepLink,
    fs,
    getAgentPathEntries,
    getBackupsRoot,
    getClaudeAuthStatus,
    getCloudDeviceAccountStorageKey,
    getCloudDevicePath,
    getCloudIdentityPath,
    getCloudIdentityStore,
    getCodexAuthStatus,
    getCodexHome,
    getCodexRoot,
    getCodexToolEnvironment,
    getDesktopChatNetworkAccessDefault,
    getForgerAccountPath,
    getForgerHomeRoot,
    getForgerMetadataRoot,
    getFreePort,
    getLegacyForgerMetadataRoot,
    getMemoryStore,
    getOfficialToolsService,
    getPrivateAppsRoot,
    getPrivateDataRoot,
    getRuntimesRoot,
    getRuntimePathEntries,
    getRuntimeStatus,
    getTempRoot,
    getVenvExecutables,
    handleCloudSocialEvent,
    hasInstalledCodexConversation,
    ipcMain,
    listAppPrompts,
    listCatalogFromBackend,
    loadAgentToolSettings,
    loadCloudSyncSettings,
    loadRegistry,
    loadSettings,
    mapBackendCategory,
    openInstalledApp,
    openOrFocusAppWindow,
    registerForgerCloudOAuth,
    registerIpcHandlers,
    renderManifestAgentPrompt,
    resolveClaudeCli,
    resolveCodexCliPath,
    resolveInstalledAgents,
    resolveInstalledManifest,
    resolveInstalledPromptTemplates,
    restoreAppPrompt,
    restartInstalledApp,
    runningApps,
    serializeErrorForInstallLog,
    shell,
    splitManifestCommand,
    startDevCatalogService,
    startLocalNetworkShare,
    startRemoteNetworkShare,
    state,
    stopLocalNetworkShare,
    stopRemoteNetworkShare,
    stopRemoteNetworkShareSession,
    stopInstalledApp,
    switchForgerAccountSession,
    terminateProcess,
    toAppSummary,
    toCatalogStatus,
    translateManifestEnvironment,
    truncateForInstallLog,
    testAppPrompt,
    updateAppPrompt,
    updateAppRuntime,
    upsertInstalledRecord,
    waitForHttpOk,
  } = deps as MainLifecycleDeps;

  app.whenReady().then(async () => {
  const startupLoading = createStartupLoadingController(BrowserWindow, typeof app.getLocale === 'function' ? app.getLocale() : undefined);
  const startupLogger = createStartupLogger(getForgerMetadataRoot, startupLoading.update);
  await startupLogger.event('startup:ready', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  const ensureDirectory = async (name: string, getPath: () => string): Promise<void> => {
    await startupLogger.step('startup:directory', async () => {
      await fs.mkdir(getPath(), { recursive: true });
    }, { name, path: getPath() });
  };

  await ensureDirectory('temp', getTempRoot);
  await ensureDirectory('runtimes', getRuntimesRoot);
  await ensureDirectory('forgerHome', getForgerHomeRoot);
  await ensureDirectory('metadata', getForgerMetadataRoot);
  await ensureDirectory('privateApps', getPrivateAppsRoot);
  await ensureDirectory('privateData', getPrivateDataRoot);
  await ensureDirectory('backups', getBackupsRoot);
  await startupLogger.step('startup:global_agents_context', async () => {
    await ensureGlobalAgentsContext(getForgerHomeRoot());
  });
  await ensureDirectory('codexRoot', getCodexRoot);
  await ensureDirectory('codexHome', getCodexHome);
  await startupLogger.step('startup:settings:load', loadSettings);
  await startupLogger.step('startup:secrets_store:create', () => {
    state.secretsStore = new SecretsStore(app.getPath('userData'));
  });
  await startupLogger.step('startup:official_tools:create', () => {
    state.officialToolsService = getOfficialToolsService();
  });
  await startupLogger.step('startup:official_tools:load', async () => {
    await state.officialToolsService?.load();
  });
  if (typeof state.officialToolsService?.startActiveTools === 'function') {
    await startupLogger.step('startup:official_tools:start_active', async () => {
      await state.officialToolsService?.startActiveTools().catch((error: unknown) => {
        void appendInstallLog('official_tools:start_active_failed', serializeErrorForInstallLog(error));
        throw error;
      });
    }).catch(() => undefined);
  }
  await startupLogger.step('startup:agent_tool_settings:load', loadAgentToolSettings);
  await startupLogger.step('startup:forger_account_store:create', () => {
    state.forgerAccountStore = new ForgerAccountStore(getForgerAccountPath());
  });
  await startupLogger.step('startup:forger_account_store:load', async () => {
    state.forgerAccount = await state.forgerAccountStore!.load();
  });
  await startupLogger.step('startup:cloud_identity_store:create', () => {
    state.cloudIdentityStore = new CloudIdentityStore(getCloudIdentityPath());
  });
  await startupLogger.step('startup:cloud_identity_store:summary', async () => {
    await state.cloudIdentityStore?.getSummary().catch((error: unknown) => {
      throw error;
    });
  }).catch(() => undefined);
  await startupLogger.step('startup:cloud_sync_settings:load', loadCloudSyncSettings);
  await startupLogger.step('startup:memory_store:create', () => {
    state.memoryStore = new MemoryStore(getForgerMetadataRoot());
  });
  await startupLogger.step('startup:registry:load', loadRegistry);
  await startupLogger.step('startup:dev_catalog:start', startDevCatalogService);
  await startupLogger.step('startup:backend_client:create', () => {
  state.forgerBackendClient = new ForgerBackendClient({
    backendBaseUrl,
    localCatalogJsonUrl: () => state.localCatalogJsonUrl,
    token: () => state.forgerAccount.token,
    mapBackendCategory,
    toCatalogStatus,
    getUserMessage: (slug: string) => state.registry.apps[slug]?.userMessage,
    reportSanitizerRoots: () => reportSanitizerRoots({
      getUserDataPath: () => app.getPath('userData'),
      getForgerHomeRoot,
      getPrivateAppsRoot,
      getPrivateDataRoot,
      getForgerMetadataRoot,
      getCodexHome,
    }),
  });
  });
  await startupLogger.step('startup:oauth:google:register', () => {
  registerForgerCloudOAuth({
    ipcMain,
    channel: IPC_CHANNELS.loginForgerAccountWithGoogle,
    provider: 'google',
    backendClient: () => state.forgerBackendClient,
    saveAccount: switchForgerAccountSession,
    openExternalUrl: async (url: string) => {
      await shell.openExternal(url);
    },
    appendLog: appendInstallLog,
    refreshCatalog: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
    },
  });
  });
  await startupLogger.step('startup:oauth:apple:register', () => {
  registerForgerCloudOAuth({
    ipcMain,
    channel: IPC_CHANNELS.loginForgerAccountWithApple,
    provider: 'apple',
    backendClient: () => state.forgerBackendClient,
    saveAccount: switchForgerAccountSession,
    openExternalUrl: async (url: string) => {
      await shell.openExternal(url);
    },
    appendLog: appendInstallLog,
    refreshCatalog: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
    },
  });
  });
  await startupLogger.step('startup:cloud_device_manager:create', () => {
  state.cloudDeviceManager = new CloudDeviceManager({
    filePath: getCloudDevicePath(),
    accountStorageKey: getCloudDeviceAccountStorageKey,
    backendBaseUrl,
    backendClient: () => state.forgerBackendClient,
    token: () => state.forgerAccount.token,
    getCloudIdentity: () => getCloudIdentityStore().getPublicRegistration(),
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    handleRemoteSessionRequest: async (request: { appId: string; requestId: string }) => {
      await appendInstallLog('remote_network_share:cloud_request', {
        appId: request.appId,
        requestId: request.requestId,
      });
      return await startRemoteNetworkShare(request.appId);
    },
    handleAppAccessRequest: async (request: { appId: string; requestId: string; mode: string }) => {
      await appendInstallLog('app_access:cloud_request', {
        appId: request.appId,
        requestId: request.requestId,
        mode: request.mode,
      });
      if (request.mode === 'local_network') {
        return await startLocalNetworkShare(request.appId);
      }
      return await startRemoteNetworkShare(request.appId);
    },
    handleAppControlRequest: async (request: { appId: string; requestId: string; action: string }) => {
      await appendInstallLog('app_control:cloud_request', {
        appId: request.appId,
        requestId: request.requestId,
        action: request.action,
      });
      if (request.action !== 'stop_app') {
        return {
          success: false,
          userMessage: 'Accion no soportada.',
          technicalCode: 'app_control_action_unsupported',
        };
      }
      await stopLocalNetworkShare(request.appId).catch((error) => {
        void appendInstallLog('app_control:local_network_stop_failed', {
          appId: request.appId,
          requestId: request.requestId,
          error: serializeErrorForInstallLog(error),
        });
      });
      await stopRemoteNetworkShare(request.appId).catch((error) => {
        void appendInstallLog('app_control:remote_network_stop_failed', {
          appId: request.appId,
          requestId: request.requestId,
          error: serializeErrorForInstallLog(error),
        });
      });
      return await stopInstalledApp(request.appId);
    },
    handleFriendshipEvent: async (event: unknown) => {
      if (isRemoteTunnelCloseEvent(event)) {
        await stopRemoteNetworkShareSession(event.session_id).catch((error) => {
          void appendInstallLog('remote_network_share:cloud_close_failed', {
            sessionId: event.session_id,
            error: serializeErrorForInstallLog(error),
          });
        });
      }
      await handleCloudSocialEvent(event);
    },
    onAuthenticationInvalid: clearForgerAccountSession,
  });
  });
  await startupLogger.step('startup:cloud_device_manager:start', async () => {
    await state.cloudDeviceManager?.start();
  });
  await startupLogger.step('startup:forger_mcp_server:create', () => {
  state.forgerMcpServer = new ForgerMcpServer({
    getAppVersion: () => app.getVersion(),
    getToolDefinitions: () => AGENT_TOOL_DEFINITIONS,
    getToolSettings: () => state.agentToolSettings,
    appendInstallLog,
    requestPermission: async (runId: string, request: PermissionRequest) => {
      const taskDecision = await (state.appAgentTaskManager?.requestPermission(runId, request) ?? Promise.resolve(null));
      if (taskDecision !== null) {
        return taskDecision;
      }
      const conversationDecision = await (state.appAgentConversationManager?.requestPermission(runId, request) ?? Promise.resolve(null));
      if (conversationDecision !== null) {
        return conversationDecision;
      }
      return state.chatOrchestrator?.requestExternalPermission(runId, request) ?? null;
    },
    listCatalog: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return state.catalogApps;
    },
    listInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    checkUpdates: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return Object.values(state.registry.apps)
        .map((record) => toAppSummary(record))
        .filter((summary) => summary.updateAvailable);
    },
    createLocalApp: createLocalAppFromSkeleton,
    recordCreatedApp: (runId: string, createdApp: ChatCreatedAppRequest) => state.chatOrchestrator?.recordCreatedAppFromMcp(runId, createdApp),
    registerQuestion: async (runId: string, input: { questions: ChatQuestion[] }) => {
      if (!state.chatOrchestrator) {
        throw new Error('chat_orchestrator_unavailable');
      }
      return await state.chatOrchestrator.registerQuestionFromMcp(runId, input);
    },
    getRuntimeStatus,
    openApp: openInstalledApp,
    stopApp: stopInstalledApp,
    restartApp: restartInstalledApp,
    refreshAppView: async (appId: string) => {
      const appWindow = appWindows.get(appId);
      const running = runningApps.get(appId);
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.webContents.reloadIgnoringCache();
        return { success: true, userMessage: 'Vista reiniciada correctamente.' };
      }
      if (running) {
        const record = state.registry.apps[appId];
        await openOrFocusAppWindow(appId, record?.name ?? appId, running.frontendUrl);
        return { success: true, userMessage: 'Vista abierta correctamente.' };
      }
      return { success: false, userMessage: 'La app no esta abierta.', technicalCode: 'app_not_running' };
    },
    updateApp: updateAppRuntime,
    listAppPrompts,
    testAppPrompt,
    updateAppPrompt,
    restoreAppPrompt,
    previewAppToolGrant: async (input: unknown, locale?: string) => await getOfficialToolsService().previewOptionalAppToolGrant(input as { appId: string; toolId: string }, locale),
    setAppToolGrant: async (input: unknown, locale?: string) => await getOfficialToolsService().setOptionalAppToolGrant(input as { appId: string; toolId: string; granted: boolean }, locale),
    memoryList: async (input: unknown, access: unknown) => await getMemoryStore().list(input, access),
    memoryCreate: async (input: unknown, access: unknown) => await getMemoryStore().create(input, access),
    memoryUpdate: async (input: unknown, access: unknown) => await getMemoryStore().update(input, access),
    memoryDelete: async (id: unknown, access: unknown) => await getMemoryStore().delete(id, access),
    listOfficialToolActionIdsForApp: async (appId: string) => await getOfficialToolsService().listAgentActionIdsForApp(appId),
    validateOfficialTool: async (input: unknown, access: ToolAccess) => await getOfficialToolsService().validateAgentCall(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
    }),
    callOfficialTool: async (input: unknown, access: ToolAccess) => await getOfficialToolsService().callFromAgent(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
    }),
    onToolProgress: (input: { runId: string; message: string }) => state.chatOrchestrator?.appendExternalProgress(input.runId, input.message),
    onToolFailure: (input: ForgerMcpToolFailure) => state.desktopErrorReporter?.reportForgerMcpToolFailure(input),
    onHttpFailure: (input: ForgerMcpHttpFailure) => state.desktopErrorReporter?.reportForgerMcpHttpFailure(input),
  });
  });
  await startupLogger.step('startup:forger_mcp_server:start', async () => {
    await state.forgerMcpServer?.start();
  });
  await startupLogger.step('startup:app_mcp_manager:create', () => {
  state.appMcpManager = new AppMcpManager({
    getInstalledApp: (appId: string) => state.registry.apps[appId],
    resolveInstalledManifest,
    ensureRuntimeInstalled,
    ensureBackendPythonEnvironment,
    getVenvExecutables,
    getFreePort,
    splitManifestCommand,
    ensurePathInside,
    translateManifestEnvironment,
    ensureSqliteDatabaseParent,
    getDesktopRuntimeEnvironment: (appId: string) => state.desktopRuntimeBridge?.environmentForApp(appId) ?? {},
    getRuntimePathEntries,
    getPathEntries: getAgentPathEntries,
    waitForHttpOk,
    terminateProcess,
    appendInstallLog,
    truncateForInstallLog,
    serializeErrorForInstallLog,
    onMcpStartFailed: (input: { appId: string; runId: string; error: unknown }) => state.desktopErrorReporter?.reportAppMcpStartFailure(input),
  });
  });
  await startupLogger.step('startup:file_library:create', () => {
    state.fileLibrary = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
  });
  await startupLogger.step('startup:file_library:cleanup_chat_staging', async () => {
    await state.fileLibrary?.cleanupStagedFilesForChat?.().catch((error: unknown) => {
      void appendInstallLog('files:chat_staging_cleanup_failed', {
        error: serializeErrorForInstallLog(error),
      });
      throw error;
    });
  }).catch(() => undefined);
  await startupLogger.step('startup:chat_orchestrator:create', () => {
  state.chatOrchestrator = new ChatOrchestrator({
    forgerHomeRoot: getForgerHomeRoot(),
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    legacyMetadataRoot: getLegacyForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    agentContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => await getAgentPathEntries(appId),
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getChatNetworkAccessDefault: getDesktopChatNetworkAccessDefault,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    createForgerMcpSession: (runId: string, appId: string, locale?: string) =>
      state.forgerMcpServer?.createSession(runId, appId, {
        caller: appId === 'forger' ? 'free-chat' : 'desktop-chat',
        appIds: appId === 'forger' ? Object.keys(state.registry.apps) : [appId],
        locale,
      }) ?? null,
    releaseForgerMcpSession: (token: string) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds.length > 0 ? appIds : Object.keys(state.registry.apps), runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    trace: appendInstallLog,
    onUpdateConflictResolved: async (appId: string) => {
      const current = state.registry.apps[appId];
      if (!current?.pendingUpdate) {
        return;
      }
      await upsertInstalledRecord({
        ...current,
        version: current.pendingUpdate.targetVersion,
        status: 'installed',
        userMessage: 'Actualizacion combinada y lista para abrir.',
        pendingUpdate: undefined,
      });
      ensureCatalogStatuses();
    },
    onRunUpdated: (event: RunEventLike) => {
      const target = event.run.appId ? appWindows.get(event.run.appId) : null;
      if (target && !target.isDestroyed()) {
        void appendInstallLog('chat_run:app_window_state', {
          appId: event.run.appId,
          runId: event.run.runId,
          conversationId: 'conversationId' in event.run ? event.run.conversationId : undefined,
          status: event.run.status,
          url: typeof target.webContents?.getURL === 'function' ? target.webContents.getURL() : null,
        });
      }
      if (event.run.status === 'failed') {
        state.desktopErrorReporter?.reportChatRunFailure({
          appId: event.run.appId,
          runId: event.run.runId,
          errorCode: event.run.errorCode,
          message: event.run.userMessage,
        });
      }
      emitChatRunUpdated(event);
    },
  });
  });
  await startupLogger.step('startup:app_agent_task_manager:create', () => {
  state.appAgentTaskManager = new AppAgentTaskManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => await getAgentPathEntries(appId),
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getAgentNetworkAccess: appAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    resolvePromptTemplates: resolveInstalledPromptTemplates,
    createForgerMcpSession: (runId: string, appId: string) =>
      state.forgerMcpServer?.createSession(runId, appId, { caller: 'app-agent', appIds: [appId] }) ?? null,
    releaseForgerMcpSession: (token: string) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApp,
    buildForgerToolsContext: buildForgerToolsContextForApp,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onTaskUpdated: (event: TaskEventLike) => {
      state.desktopErrorReporter?.reportAppCodexTaskEvent(event);
      const target = appWindows.get(event.task.appId);
      if (target && !target.isDestroyed()) {
        target.webContents.send(IPC_CHANNELS.appAgentTaskUpdated, event);
        target.webContents.send(IPC_CHANNELS.appCodexTaskUpdated, event);
      }
    },
  });
  });
  await startupLogger.step('startup:app_agent_conversation_manager:create', () => {
  state.appAgentConversationManager = new AppAgentConversationManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => await getAgentPathEntries(appId),
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getAgentNetworkAccess: appAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    hasCodexConversation: hasInstalledCodexConversation,
    resolveAgents: resolveInstalledAgents,
    createForgerMcpSession: (runId: string, appId: string, locale?: string) =>
      state.forgerMcpServer?.createSession(runId, appId, { caller: 'app-agent', appIds: [appId], locale }) ?? null,
    releaseForgerMcpSession: (token: string) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApp,
    buildForgerToolsContext: buildForgerToolsContextForApp,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onConversationEvent: (event: ConversationEventLike) => {
      state.desktopErrorReporter?.reportAppCodexConversationEvent(event);
      state.desktopRuntimeBridge?.publishAgentEvent(event);
      const target = appWindows.get(event.conversation.appId);
      if (target && !target.isDestroyed()) {
        const targetUrl = typeof target.webContents?.getURL === 'function' ? target.webContents.getURL() : null;
        void appendInstallLog('app_agent_conversation:app_window_event', {
          appId: event.conversation.appId,
          conversationId: event.conversation.conversationId,
          runId: event.run?.runId,
          type: event.type,
          url: targetUrl,
          channels: [
            IPC_CHANNELS.appAgentConversationEvent,
            IPC_CHANNELS.appCodexConversationEvent,
            ...(event.type === 'run.message.completed' ? [] : [IPC_CHANNELS.appAgentThreadEvent]),
          ],
        });
        target.webContents.send(IPC_CHANNELS.appAgentConversationEvent, event);
        target.webContents.send(IPC_CHANNELS.appCodexConversationEvent, event);
        if (event.type === 'run.message.completed') {
          return;
        }
        const desktopThreadId = event.conversation.conversationId;
        const normalizedType = event.type === 'conversation.created'
          ? 'thread.created'
          : event.type === 'message.created'
            ? 'run.message'
            : event.type;
        target.webContents.send(IPC_CHANNELS.appAgentThreadEvent, {
          type: normalizedType,
          desktop_thread_id: desktopThreadId,
          ...(event.run ? { desktop_run_id: event.run.runId } : {}),
          thread: {
            desktop_thread_id: desktopThreadId,
            title: event.conversation.title,
            status: event.run?.status ?? event.conversation.activeRun?.status ?? 'idle',
          },
          ...(event.run
            ? {
                run: {
                  desktop_thread_id: desktopThreadId,
                  desktop_run_id: event.run.runId,
                  status: event.run.status,
                  ...(event.run.error ? { error: event.run.error } : {}),
                  ...(event.run.progressLog ? { progressLog: event.run.progressLog } : {}),
                },
              }
            : {}),
          ...(event.progress ? { progress: event.progress } : {}),
        });
      }
    },
  });
  });
  await startupLogger.step('startup:desktop_runtime_bridge:create', () => {
  state.desktopRuntimeBridge = new DesktopRuntimeBridge({
    getInstalledApp: (appId: string) => state.registry.apps[appId],
    getConversationManager: () => state.appAgentConversationManager,
    getTaskManager: () => state.appAgentTaskManager,
    getTaskStatus: async () => {
      const [codexStatus, claudeStatus] = await Promise.all([
        getCodexAuthStatus().catch(() => ({ authenticated: false })),
        getClaudeAuthStatus().catch(() => ({ authenticated: false })),
      ]);
      const codex = Boolean(codexStatus.authenticated);
      const claude = Boolean(claudeStatus.authenticated);
      return {
        connected: codex || claude,
        codex,
        claude,
      };
    },
    getAppContext: (appId: string) => {
      const running = runningApps.get(appId);
      return {
        locale: running?.locale ?? 'es',
        rawLocale: running?.rawLocale ?? null,
      };
    },
    renderManifestAgentPrompt,
    resolveInstalledAgents,
    appendInstallLog,
    serializeErrorForInstallLog,
  });
  });
  await startupLogger.step('startup:desktop_runtime_bridge:start', async () => {
    await state.desktopRuntimeBridge?.start();
  });
  await startupLogger.step('startup:automation_manager:create', () => {
  state.automationManager = new AutomationManager({
    forgerHomeRoot: getForgerHomeRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async () => await getAgentPathEntries(),
    getAgentNetworkAccess: anyAppAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: async () => {
      const status = await getClaudeAuthStatus();
      return status.authenticated;
    },
    createForgerMcpSession: (runId: string, appId: string, appIds: string[]) =>
      state.forgerMcpServer?.createSession(runId, appId, { caller: 'automation', appIds }) ?? null,
    releaseForgerMcpSession: (token: string) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      state.appMcpManager?.releaseMcps(runId);
    },
    onAutomationUpdated: (event: AutomationEventLike) => {
      if (event.run?.status === 'failed') {
        state.desktopErrorReporter?.reportAutomationRunFailure({
          automationId: event.automation.id,
          runId: event.run.id,
          selectedAppIds: event.automation.selectedAppIds,
          error: event.run.error ?? event.run.userMessage ?? 'automation_run_failed',
        });
      }
      emitAutomationUpdated(event as { automation: unknown; run?: unknown });
    },
  });
  });
  await startupLogger.step('startup:automation_manager:initialize', async () => {
    await state.automationManager?.initialize();
  });
  await startupLogger.step('startup:memory_maintenance_manager:create', () => {
  state.memoryMaintenanceManager = new MemoryMaintenanceManager({
    forgerHomeRoot: getForgerHomeRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getCodexPathEntries: async () => await getAgentPathEntries(),
    createForgerMcpSession: (runId: string) =>
      state.forgerMcpServer?.createSession(runId, 'forger', {
        caller: 'automation',
        appIds: Object.keys(state.registry.apps),
      }) ?? null,
    releaseForgerMcpSession: (token: string) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: async () => await buildMemoryContextForApps(Object.keys(state.registry.apps)),
    getMemoryStore,
    appendInstallLog,
  });
  });
  await startupLogger.step('startup:memory_maintenance_manager:initialize', async () => {
    await state.memoryMaintenanceManager?.initialize();
  });

  await startupLogger.step('startup:ipc_handlers:register', registerIpcHandlers);
  await startupLogger.step('startup:catalog_statuses:ensure', ensureCatalogStatuses);
  await startupLogger.step('startup:main_window:create', createWindow);
  startupLoading.close();

  // Deliver any deep-link captured before the renderer existed (cold
  // boot from `process.argv` or an `open-url` fired during startup).
  if (state.mainWindow && state.pendingDeepLink) {
    state.mainWindow.webContents.once('did-finish-load', flushPendingDeepLink);
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await startupLogger.step('startup:main_window:create_on_activate', createWindow);
    }
  });
}).catch((error: unknown) => {
  const startupLogger = createStartupLogger(getForgerMetadataRoot);
  void startupLogger.event('startup:failed', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  }).then(() => appendDesktopLog({
    metadataRoot: getForgerMetadataRoot(),
    level: 'error',
    service: 'desktop-main',
    event: 'startup:failed:error',
    error,
  }));
  if (process.env.NODE_ENV === 'development') {
    console.error('Forger Desktop startup failed', error);
  }
});

app.on('before-quit', () => {
  state.memoryMaintenanceManager?.dispose();
  state.automationManager?.dispose();
  state.appMcpManager?.dispose();
  void state.localNetworkShareManager?.stopAll?.();
  void state.remoteNetworkShareManager?.stopAll?.();
  void state.desktopRuntimeBridge?.stop();
  state.desktopRuntimeBridge = null;
  state.cloudDeviceManager?.stop();
  state.devCatalogService?.stop?.();
  state.forgerMcpServer?.stop();
  state.forgerMcpServer = null;
  for (const running of runningApps.values()) {
    void terminateProcess(running.backend);
    void terminateProcess(running.frontend);
    void closeServer(running.proxyServer);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
};
