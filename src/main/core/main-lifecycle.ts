import type { App, BrowserWindow, IpcMain, Shell } from 'electron';
import type fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type { DesktopErrorReporter } from '../error-reporting';
import type { StoredForgerAccount } from '../forger-account-store';
import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentToolSettings,
  AppCodexConversationEvent,
  AppCodexTaskEvent,
  AppSummary,
  BasicActionResult,
  CatalogApp,
  CodexAuthStatus,
  ClaudeAuthStatus,
  RuntimeStatus,
} from '../../shared/types';
import type {
  AppRegistry,
  InstalledAppRecord,
  RuntimeBinarySet,
  RunningAppProcess,
} from './main-process-types';

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

type ServiceWithLoad<T> = Omit<LifecycleService, 'load'> & { load: () => Promise<T> };

interface MainLifecycleState {
  agentToolSettings: AgentToolSettings;
  appAgentConversationManager: LifecycleService | null;
  appAgentTaskManager: LifecycleService | null;
  appMcpManager: LifecycleService | null;
  automationManager: LifecycleService | null;
  catalogApps: CatalogApp[];
  chatOrchestrator: LifecycleService | null;
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
  memoryStore: LifecycleService | null;
  officialToolsService: (LifecycleService & {
    listAgentActionIdsForApp: (appId: string) => Promise<string[]>;
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
  ChatOrchestrator: ServiceConstructor<LifecycleService>;
  CloudDeviceManager: ServiceConstructor<LifecycleService>;
  CloudIdentityStore: ServiceConstructor<LifecycleService>;
  DEFAULT_NODE_VERSION: string;
  DesktopRuntimeBridge: ServiceConstructor<LifecycleService>;
  DevCatalogService: ServiceConstructor<LifecycleService>;
  FORGER_AGENT_CONTRACT_VERSION: string;
  FileLibrary: ServiceConstructor<LifecycleService & { cleanupStagedFilesForChat: () => Promise<void> }>;
  ForgerAccountStore: ServiceConstructor<ServiceWithLoad<StoredForgerAccount>>;
  ForgerBackendClient: ServiceConstructor<LifecycleService>;
  ForgerMcpServer: ServiceConstructor<LifecycleService>;
  IPC_CHANNELS: Record<string, string>;
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
  getAppLocalToolPathEntries: (record: InstalledAppRecord) => Promise<string[]>;
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
  normalizeNodeRuntimeVersion: (version?: string | null) => string;
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
    DEFAULT_NODE_VERSION,
    DesktopRuntimeBridge,
    DevCatalogService,
    FORGER_AGENT_CONTRACT_VERSION,
    FileLibrary,
    ForgerAccountStore,
    ForgerBackendClient,
    ForgerMcpServer,
    IPC_CHANNELS,
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
    getAppLocalToolPathEntries,
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
    normalizeNodeRuntimeVersion,
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
    state,
    stopRemoteNetworkShareSession,
    stopInstalledApp,
    switchForgerAccountSession,
    terminateProcess,
    toAppSummary,
    toCatalogStatus,
    translateManifestEnvironment,
    truncateForInstallLog,
    updateAppPrompt,
    updateAppRuntime,
    upsertInstalledRecord,
    waitForHttpOk,
  } = deps as MainLifecycleDeps;

  app.whenReady().then(async () => {
  await fs.mkdir(getTempRoot(), { recursive: true });
  await fs.mkdir(getRuntimesRoot(), { recursive: true });
  await fs.mkdir(getForgerHomeRoot(), { recursive: true });
  await fs.mkdir(getForgerMetadataRoot(), { recursive: true });
  await fs.mkdir(getPrivateAppsRoot(), { recursive: true });
  await fs.mkdir(getPrivateDataRoot(), { recursive: true });
  await fs.mkdir(getBackupsRoot(), { recursive: true });
  await ensureGlobalAgentsContext(getForgerHomeRoot());
  await fs.mkdir(getCodexRoot(), { recursive: true });
  await fs.mkdir(getCodexHome(), { recursive: true });
  await loadSettings();
  state.secretsStore = new SecretsStore(app.getPath('userData'));
  state.officialToolsService = getOfficialToolsService();
  await state.officialToolsService.load();
  await loadAgentToolSettings();
  state.forgerAccountStore = new ForgerAccountStore(getForgerAccountPath());
  state.forgerAccount = await state.forgerAccountStore.load();
  state.cloudIdentityStore = new CloudIdentityStore(getCloudIdentityPath());
  await state.cloudIdentityStore.getSummary().catch(() => undefined);
  await loadCloudSyncSettings();
  state.memoryStore = new MemoryStore(getForgerMetadataRoot());
  await loadRegistry();
  await startDevCatalogService();
  state.forgerBackendClient = new ForgerBackendClient({
    backendBaseUrl,
    localCatalogJsonUrl: () => state.localCatalogJsonUrl,
    token: () => state.forgerAccount.token,
    mapBackendCategory,
    toCatalogStatus,
    getUserMessage: (slug: string) => state.registry.apps[slug]?.userMessage,
  });
  registerForgerCloudOAuth({
    ipcMain,
    channel: IPC_CHANNELS.loginForgerAccountWithGoogle,
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
  state.cloudDeviceManager = new CloudDeviceManager({
    filePath: getCloudDevicePath(),
    accountStorageKey: getCloudDeviceAccountStorageKey,
    backendBaseUrl,
    backendClient: () => state.forgerBackendClient,
    token: () => state.forgerAccount.token,
    getCloudIdentity: () => getCloudIdentityStore().getPublicRegistration(),
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
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
  await state.cloudDeviceManager.start();
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
    updateAppPrompt,
    restoreAppPrompt,
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
  await state.forgerMcpServer.start();
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
    waitForHttpOk,
    terminateProcess,
    appendInstallLog,
    truncateForInstallLog,
    serializeErrorForInstallLog,
    onMcpStartFailed: (input: { appId: string; runId: string; error: unknown }) => state.desktopErrorReporter?.reportAppMcpStartFailure(input),
  });
  state.fileLibrary = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
  await state.fileLibrary.cleanupStagedFilesForChat?.().catch((error: unknown) => {
    void appendInstallLog('files:chat_staging_cleanup_failed', {
      error: serializeErrorForInstallLog(error),
    });
  });
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
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? state.registry.apps[appId] : undefined;
      if (record) {
        for (const entry of await getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
      }

      const codexNodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      for (const entry of getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }

      if (record) {
        const appNodeRuntime = await ensureRuntimeInstalled('node', normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }

      return [...pathEntries];
    },
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
  state.appAgentTaskManager = new AppAgentTaskManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? state.registry.apps[appId] : undefined;
      if (record) {
        for (const entry of await getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
      }

      const codexNodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      for (const entry of getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }

      if (record) {
        const appNodeRuntime = await ensureRuntimeInstalled('node', normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }

      return [...pathEntries];
    },
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
  state.appAgentConversationManager = new AppAgentConversationManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? state.registry.apps[appId] : undefined;
      if (record) {
        for (const entry of await getAppLocalToolPathEntries(record)) {
          pathEntries.add(entry);
        }
      }

      const codexNodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      for (const entry of getRuntimePathEntries(codexNodeRuntime)) {
        pathEntries.add(entry);
      }

      if (record) {
        const appNodeRuntime = await ensureRuntimeInstalled('node', normalizeNodeRuntimeVersion(record.requiredNodeVersion));
        const appPythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
        for (const entry of getRuntimePathEntries(appNodeRuntime)) {
          pathEntries.add(entry);
        }
        for (const entry of getRuntimePathEntries(appPythonRuntime)) {
          pathEntries.add(entry);
        }
      }

      return [...pathEntries];
    },
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
    renderManifestAgentPrompt,
    resolveInstalledAgents,
    appendInstallLog,
    serializeErrorForInstallLog,
  });
  await state.desktopRuntimeBridge.start();
  state.automationManager = new AutomationManager({
    forgerHomeRoot: getForgerHomeRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getAgentRuntime: chooseAgentRuntime,
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getCodexPathEntries: async () => {
      const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      return getRuntimePathEntries(nodeRuntime);
    },
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
  await state.automationManager.initialize();

  registerIpcHandlers();
  ensureCatalogStatuses();
  await createWindow();

  // Deliver any deep-link captured before the renderer existed (cold
  // boot from `process.argv` or an `open-url` fired during startup).
  if (state.mainWindow && state.pendingDeepLink) {
    state.mainWindow.webContents.once('did-finish-load', flushPendingDeepLink);
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('before-quit', () => {
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
