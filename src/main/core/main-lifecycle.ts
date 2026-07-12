import type { App, BrowserWindow, IpcMain, Shell } from 'electron';
import type fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendDesktopLog } from '../desktop-logger';
import { reportSanitizerRoots } from '../conversation-diagnostics';
import type { StoredForgerAccount } from '../forger-account-store';
import { createAppMcpSecretsFingerprint } from '../app-mcp-manager';
import { AppFolderGrantStore } from '../app-folder-grants';
import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AgentToolDefinition,
  AppSummary,
  AppSecretDeclaration,
  AutomationFrequency,
  BasicActionResult,
  CatalogApp,
  ChatCreatedAppRequest,
  ChatQuestion,
  ChatQuestionRequest,
  AntigravityAuthStatus,
  CodexAuthStatus,
  ClaudeAuthStatus,
  CreateLocalAppInput,
  CreateLocalAppResult,
  RuntimeStatus,
  AudioRuntimeDevices,
  CallConnectionActionInput,
  ConfigureConnectionInput,
  CallOfficialToolInput,
  PersonalAgent,
  PersonalAgentPeerThread,
  SecretMutationResult,
} from '../../shared/types';
import type {
  AsyncFn,
  AutomationEventLike,
  ChatOrchestratorService,
  ConversationEventLike,
  ForgerMcpHttpFailure,
  ForgerMcpSessionOptions,
  ForgerMcpToolFailure,
  LifecycleService,
  LlmRunsService,
  MainLifecycleState,
  MemoryMaintenanceService,
  PermissionDecision,
  PermissionRequest,
  RunEventLike,
  ServiceConstructor,
  ServiceWithLoad,
  SyncFn,
  TaskEventLike,
  ToolAccess,
} from './main-lifecycle-types';
import type {
  AppManifest,
  InstalledAppRecord,
  RuntimeBinarySet,
  RunningAppProcess,
} from './main-process-types';
import {
  createStartupLoadingController,
  createStartupLogger,
} from './startup-loading';
import { appAllowsAgentRuntimeControl, appAllowsAudioInput, appAllowsSidekickDisplay, appAllowsSidekickSpeech, appAllowsSpeechToText, appAllowsTextToSpeech, appAllowsWorkspaceFolders } from '../../shared/platform-capabilities';
import type { LlmProviderAuthProfileResolver } from '../llm-provider/types';
import { connectionToolDefinitionsFromState } from './mcp-connection-tools';
import { createAppRuntimeDiagnostics } from './app-runtime-diagnostics';
import { createPublishedAppInfoUpdater } from './main-lifecycle-mcp-handlers';
import { registerGracefulShutdownHandlers } from './main-lifecycle-shutdown';
import { isRemoteAgentSessionCloseEvent, isRemoteTunnelCloseEvent } from './remote-session-events';
import type { SidekickService } from '../sidekick-service';
import type { SidekickVoiceOutcomeInput } from '../sidekick-voice-runtime';
import { createSidekickRuntimeBridgeBindings } from '../sidekick-runtime-bridge';
export interface MainLifecycleDeps {
  AGENT_TOOL_DEFINITIONS: AgentToolDefinition[];
  AppAgentConversationManager: ServiceConstructor<LifecycleService>;
  AppAgentTaskManager: ServiceConstructor<LifecycleService>;
  AppMcpManager: ServiceConstructor<LifecycleService>;
  AutomationManager: ServiceConstructor<LifecycleService>;
  WorkflowManager: ServiceConstructor<LifecycleService>;
  BrowserWindow: typeof BrowserWindow;
  ChatOrchestrator: ServiceConstructor<ChatOrchestratorService>;
  CloudDeviceManager: ServiceConstructor<LifecycleService>;
  CloudIdentityStore: ServiceConstructor<LifecycleService>;
  DesktopRuntimeBridge: ServiceConstructor<LifecycleService>;
  DevCatalogService: ServiceConstructor<LifecycleService>;
  FORGER_AGENT_CONTRACT_VERSION: string | number;
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
  dialog: typeof import('electron').dialog;
  buildForgerToolsContextForApp: AsyncFn<string>;
  buildMemoryContextForApp: AsyncFn<string>;
  buildMemoryContextForApps: AsyncFn<string>;
  chooseAgentRuntime: (request?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  cleanupLegacyExternalToolState: (input: { metadataRoot: string; secretsStore: { deleteToolSecrets(toolId: string): Promise<SecretMutationResult> }; appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void> }) => Promise<void>;
  clearForgerAccountSession: (technicalCode: string) => Promise<void>;
  closeServer: (server: Server) => Promise<void>;
  createLocalAppFromSkeleton: (input: CreateLocalAppInput, locale?: string) => Promise<CreateLocalAppResult>;
  finishSocialAppInstall: (input: { quarantineId: string }, locale?: string) => Promise<BasicActionResult & { appId?: string }>;
  deleteQuarantinedSocialApp: (input: { quarantineId: string }, locale?: string) => Promise<BasicActionResult>;
  createWindow: () => Promise<void>;
  emitAutomationUpdated: (payload: { automation: unknown; run?: unknown }) => void;
  emitWorkflowUpdated: (payload: { workflow: unknown; run?: unknown }) => void;
  emitChatRunUpdated: (event: any) => void;
  ensureBackendPythonEnvironment: AsyncFn<void>;
  ensureCatalogStatuses: () => void;
  ensureGlobalAgentsContext: (root: string) => Promise<void>;
  ensureGitAvailable: () => Promise<void>;
  ensurePathInside: SyncFn<boolean>;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  ensureSqliteDatabaseParent: AsyncFn<void>;
  flushPendingDeepLink: () => void;
  fs: typeof fs;
  getAgentPathEntries: (appId?: string) => Promise<string[]>;
  getBackupsRoot: () => string;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getClaudeConnectedForForger?: () => Promise<boolean>;
  getAntigravityAuthStatus?: () => Promise<AntigravityAuthStatus>;
  getCloudDeviceAccountStorageKey: () => string | undefined;
  getCloudDevicePath: () => string;
  getCloudIdentityPath: () => string;
  getCloudIdentityStore: () => LifecycleService & { getPublicRegistration: () => unknown };
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getCodexHome: () => string;
  getCodexRoot: () => string;
  getCodexToolEnvironment: (appId?: string, runtime?: RuntimeBinarySet) => Promise<Record<string, string>>;
  getDesktopChatNetworkAccessDefault: () => boolean;
  getManifestAppSecretsValidationError: (manifest: AppManifest | null) => string | null;
  getSecretsStore: () => {
    resolveAppEnv: (appId: string, declarations: AppSecretDeclaration[]) => Promise<{
      env: Record<string, string>;
      missingRequired: AppSecretDeclaration[];
      secretValues: string[];
    }>;
  };
  getForgerAccountPath: () => string;
  getForgerHomeRoot: () => string;
  getForgerMetadataRoot: () => string;
  getProviderProfilesRoot?: () => string;
  resolveLlmProviderAuthProfile?: LlmProviderAuthProfileResolver;
  getSocialAppReviewPromptContext: (appId: string) => Promise<unknown | null>;
  getFreePort: () => Promise<number>;
  getLegacyForgerMetadataRoot: () => string;
  getMemoryStore: () => { list: AsyncFn; create: AsyncFn; update: AsyncFn; delete: AsyncFn };
	  getPersonalAgentHeartbeat: AsyncFn;
	  getPersonalAgentStore: () => {
	    requireAgent: (agentId: string) => Promise<PersonalAgent>;
    requireRoutine: (routineId: string) => Promise<{ agentId: string }>;
	    updateAgentPermissions: (input: { agentId: string; appIds?: string[] }) => Promise<PersonalAgent>;
	    listPeerGrants: (agentId: string) => Promise<PersonalAgent['peerAgentGrants']>;
	    listRecentPeerThreadsForAgent: (agentId: string, limit?: number) => Promise<PersonalAgentPeerThread[]>;
	    requirePeerThreadAccess: (input: { agentId: string; threadId: string }) => Promise<PersonalAgentPeerThread>;
	  };
		  getPersonalAgentConversationManager: () => {
		    askPeerAgent: AsyncFn;
		  };
  getPersonalAgentRoutineManager?: () => {
    initialize: () => Promise<void>;
    dispose: () => void;
    scheduleWakeup: AsyncFn;
    cancelWakeup: AsyncFn;
    create: AsyncFn;
    list: AsyncFn;
    update: AsyncFn;
    delete: AsyncFn;
  };
		  getOfficialToolsService: () => NonNullable<MainLifecycleState['officialToolsService']>;
  getConnectionsService: () => NonNullable<MainLifecycleState['connectionsService']>;
  getSelfOAuthCallbackService: () => NonNullable<MainLifecycleState['selfOAuthCallbackService']>;
  getSpeechToTextService: () => NonNullable<MainLifecycleState['speechToTextService']>;
  getTextToSpeechService: () => NonNullable<MainLifecycleState['textToSpeechService']>;
  getSidekickService: () => SidekickService;
  resolveSidekickVoiceOutcome: (input: SidekickVoiceOutcomeInput) => { accepted: boolean };
  getWakeWordService: () => NonNullable<MainLifecycleState['wakeWordService']>;
  getLiveVoiceInputService: () => {
    createSession: AsyncFn;
    stop: AsyncFn;
    updateDevices: AsyncFn;
  };
  getAudioDevices: () => Promise<AudioRuntimeDevices>;
  playTextToSpeechAudio: (input: { playbackId: string; audioDataBase64: string; mimeType: string; outputDeviceId?: string }) => Promise<{ success: boolean; durationSeconds?: number; error?: string }>;
  cancelTextToSpeechPlayback: (playbackId: string) => Promise<void>;
  deleteTextToSpeechAudio: (audioPath: string) => Promise<void>;
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
  llmRunsStore?: LlmRunsService;
  mapBackendCategory: SyncFn;
  formatProcessOutputForInstallLog: (value: string, secretValues: string[]) => string;
  isSecretsVaultUnavailableError: (error: unknown) => boolean;
  normalizeManifestAppSecrets: (manifest: AppManifest | null) => AppSecretDeclaration[];
  openInstalledApp: AsyncFn;
  startLocalNetworkShare: AsyncFn;
  stopLocalNetworkShare: AsyncFn;
  startRemoteNetworkShare: AsyncFn;
  stopRemoteNetworkShare: AsyncFn;
  stopRemoteNetworkShareSession: (sessionId: string) => Promise<unknown>;
  startRemoteAgentSession: AsyncFn;
  stopRemoteAgentSession: (agentId: string) => Promise<unknown>;
  stopRemoteAgentSessionSession: (sessionId: string) => Promise<unknown>;
  openOrFocusAppWindow: (appId: string, appName: string, frontendUrl: string) => Promise<void>;
  registerForgerCloudOAuth: SyncFn;
  registerIpcHandlers: () => void;
  renderManifestAgentPrompt: SyncFn<string>;
  resolveClaudeCli: () => Promise<{ path: string; source: string } | null>;
  resolveAntigravityCliPath?: () => Promise<string | null>;
  resolveCodexCliPath: (root: string) => Promise<string | null>;
  resolveAppFolderGrant: (appId: string, grantToken: string) => { path: string; expiresAt: string } | null;
  resolveInstalledAgents: AsyncFn;
  resolveInstalledManifest: AsyncFn<AppManifest | null>;
  resolveInstalledPromptTemplates: AsyncFn;
  restoreAppPrompt: AsyncFn;
  restartInstalledApp: AsyncFn;
  runningApps: Map<string, RunningAppProcess>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  shell: Shell;
  splitManifestCommand: SyncFn;
  startDevCatalogService: () => Promise<void>;
  startSidekickIfPaired?: () => Promise<void>;
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

export const registerMainLifecycle = (deps: MainLifecycleDeps) => {
  const {
    AGENT_TOOL_DEFINITIONS,
    AppAgentConversationManager,
    AppAgentTaskManager,
    AppMcpManager,
    AutomationManager,
    WorkflowManager,
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
    dialog,
    buildForgerToolsContextForApp,
    buildMemoryContextForApp,
    buildMemoryContextForApps,
    chooseAgentRuntime,
    cleanupLegacyExternalToolState,
    clearForgerAccountSession,
    closeServer,
    createLocalAppFromSkeleton,
    finishSocialAppInstall,
    deleteQuarantinedSocialApp,
    createWindow,
    emitAutomationUpdated,
    emitWorkflowUpdated,
    emitChatRunUpdated,
    ensureBackendPythonEnvironment,
    ensureCatalogStatuses,
    ensureGlobalAgentsContext,
    ensureGitAvailable,
    ensurePathInside,
    ensureRuntimeInstalled,
    ensureSqliteDatabaseParent,
    flushPendingDeepLink,
    fs,
    getAgentPathEntries,
    getBackupsRoot,
    getClaudeAuthStatus,
    getClaudeConnectedForForger,
    getAntigravityAuthStatus,
    getCloudDeviceAccountStorageKey,
    getCloudDevicePath,
    getCloudIdentityPath,
    getCloudIdentityStore,
    getCodexAuthStatus,
    getCodexHome,
    getCodexRoot,
    getCodexToolEnvironment,
    getDesktopChatNetworkAccessDefault,
    getManifestAppSecretsValidationError,
    getSecretsStore,
    getForgerAccountPath,
    getForgerHomeRoot,
    getForgerMetadataRoot,
    getProviderProfilesRoot,
    resolveLlmProviderAuthProfile,
    getSocialAppReviewPromptContext,
    getFreePort,
    getLegacyForgerMetadataRoot,
    getMemoryStore,
    getPersonalAgentHeartbeat,
    getPersonalAgentStore,
    getPersonalAgentConversationManager,
    getPersonalAgentRoutineManager,
    getOfficialToolsService,
    getConnectionsService,
    getSelfOAuthCallbackService,
    getSidekickService,
    getSpeechToTextService,
    getTextToSpeechService,
    getWakeWordService,
    getLiveVoiceInputService,
    getAudioDevices,
    playTextToSpeechAudio,
    cancelTextToSpeechPlayback,
    deleteTextToSpeechAudio,
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
    llmRunsStore,
    mapBackendCategory,
    formatProcessOutputForInstallLog,
    isSecretsVaultUnavailableError,
    normalizeManifestAppSecrets,
    openInstalledApp,
    openOrFocusAppWindow,
    registerForgerCloudOAuth,
    registerIpcHandlers,
    renderManifestAgentPrompt,
    resolveClaudeCli,
    resolveAntigravityCliPath,
    resolveCodexCliPath,
    resolveAppFolderGrant,
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
    startSidekickIfPaired,
    startLocalNetworkShare,
    startRemoteNetworkShare,
    state,
    stopLocalNetworkShare,
    stopRemoteNetworkShare,
    stopRemoteNetworkShareSession,
    startRemoteAgentSession,
    stopRemoteAgentSession,
    stopRemoteAgentSessionSession,
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
  } = deps;
  const getLlmProviderProfilesRoot = (): string | undefined => getProviderProfilesRoot?.();
  const resolveLlmAuthProfile: LlmProviderAuthProfileResolver = resolveLlmProviderAuthProfile ?? (async () => null);
  const requirePersonalAgentRoutineManager = () => {
    const manager = getPersonalAgentRoutineManager?.();
    if (!manager) throw new Error('personal_agent_routines_unavailable');
    return manager;
  };
  const getClaudeAuthenticatedForForger = getClaudeConnectedForForger ?? (async () => {
    const status = await getClaudeAuthStatus();
    return status.authenticated;
  });
  const appFolderGrantStore = new AppFolderGrantStore(getForgerMetadataRoot());

  const {
    getAppRuntimeDiagnostics,
    getAppViewSnapshot,
  } = createAppRuntimeDiagnostics({
    appWindows,
    runningApps,
    getForgerMetadataRoot,
    getRuntimeStatus,
    serializeErrorForInstallLog,
  });

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
  await startupLogger.step('startup:legacy_external_tools_cleanup', async () => {
    const secretsStore = state.secretsStore as { deleteToolSecrets(toolId: string): Promise<SecretMutationResult> } | null;
    if (secretsStore?.deleteToolSecrets) {
      await cleanupLegacyExternalToolState({ metadataRoot: getForgerMetadataRoot(), secretsStore, appendLog: appendInstallLog });
    }
  }).catch((error: unknown) => {
    void appendInstallLog('legacy_external_tools_cleanup:failed', serializeErrorForInstallLog(error));
  });
  await startupLogger.step('startup:official_tools:create', () => {
    state.officialToolsService = getOfficialToolsService();
  });
  await startupLogger.step('startup:official_tools:load', async () => {
    await state.officialToolsService?.load();
  });
  await startupLogger.step('startup:self_oauth_callback:start', async () => {
    state.selfOAuthCallbackService = getSelfOAuthCallbackService();
    await state.selfOAuthCallbackService.start();
  }).catch((error: unknown) => {
    void appendInstallLog('self_oauth_callback:start_failed', serializeErrorForInstallLog(error));
  });
  await startupLogger.step('startup:connections:create', () => {
    state.connectionsService = getConnectionsService();
  });
  await startupLogger.step('startup:connections:load', async () => {
    await state.connectionsService?.load();
  });
  await startupLogger.step('startup:sidekick:start_if_paired', async () => {
    await startSidekickIfPaired?.();
  }).catch((error: unknown) => {
    void appendInstallLog('sidekick:start_if_paired_failed', serializeErrorForInstallLog(error));
  });
  if (typeof state.officialToolsService?.startActiveTools === 'function') {
    await startupLogger.step('startup:official_tools:start_active', async () => {
      await state.officialToolsService?.startActiveTools().catch((error: unknown) => {
        void appendInstallLog('official_tools:start_active_failed', serializeErrorForInstallLog(error));
        throw error;
      });
    }).catch(() => undefined);
  }
  await startupLogger.step('startup:speech_to_text:start_configured', async () => {
    state.speechToTextService = getSpeechToTextService();
    await state.speechToTextService.startIfConfigured().catch((error: unknown) => {
      void appendInstallLog('speech_to_text:start_configured_failed', serializeErrorForInstallLog(error));
      throw error;
    });
  }).catch(() => undefined);
  await startupLogger.step('startup:text_to_speech:start_configured', async () => {
    state.textToSpeechService = getTextToSpeechService();
    await state.textToSpeechService.startIfConfigured().catch((error: unknown) => {
      void appendInstallLog('text_to_speech:start_configured_failed', serializeErrorForInstallLog(error));
      throw error;
    });
  }).catch(() => undefined);
  await startupLogger.step('startup:wake_word:start_configured', async () => {
    state.wakeWordService = getWakeWordService();
    await state.wakeWordService.startIfConfigured().catch((error: unknown) => {
      void appendInstallLog('wake_word:start_configured_failed', serializeErrorForInstallLog(error));
      throw error;
    });
  }).catch(() => undefined);
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
    getPersonalAgentHeartbeat,
    appendInstallLog,
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
    handleAgentAccessRequest: async (request: { agentId: string; agentName?: string; requestId: string; requestedByDeviceId?: number; requestedByDeviceName?: string }) => {
      await appendInstallLog('agent_access:cloud_request', {
        agentId: request.agentId,
        requestId: request.requestId,
      });
      return await startRemoteAgentSession(request.agentId, {
        requestId: request.requestId,
        requesterMobileDevice: request.requestedByDeviceId && request.requestedByDeviceName
          ? { id: request.requestedByDeviceId, name: request.requestedByDeviceName }
          : undefined,
      });
    },
    handleAgentAccessDisconnect: async (request: { agentId?: string; sessionId?: string; requestId?: string }) => {
      await appendInstallLog('agent_access:cloud_disconnect', {
        agentId: request.agentId,
        sessionId: request.sessionId,
        requestId: request.requestId,
      });
      if (request.sessionId) {
        return await stopRemoteAgentSessionSession(request.sessionId);
      }
      if (request.agentId) {
        return await stopRemoteAgentSession(request.agentId);
      }
      return undefined;
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
      if (isRemoteAgentSessionCloseEvent(event)) {
        const sessionId = event.session_id ?? event.sessionId;
        const agentId = event.agent_id ?? event.agentId;
        const close = sessionId
          ? stopRemoteAgentSessionSession(sessionId)
          : agentId
            ? stopRemoteAgentSession(agentId)
            : Promise.resolve(undefined);
        await close.catch((error) => {
          void appendInstallLog('agent_access:cloud_disconnect_failed', {
            agentId,
            sessionId,
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
    getConnectionToolDefinitions: async () => await connectionToolDefinitionsFromState(getConnectionsService),
    getToolSettings: () => state.agentToolSettings,
    resolveSidekickVoiceOutcome: deps.resolveSidekickVoiceOutcome,
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
    listInstalledApps: () => Object.values(state.registry.apps).map((record) => ({
      ...toAppSummary(record),
      ...(record.installDir ? { path: record.installDir } : {}),
    })),
    checkUpdates: async () => {
      state.catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return Object.values(state.registry.apps)
        .map((record) => toAppSummary(record))
        .filter((summary) => summary.updateAvailable);
    },
    createLocalApp: createLocalAppFromSkeleton,
    updatePublishedAppInfo: createPublishedAppInfoUpdater(state),
	    addAppToPersonalAgent: async ({ agentId, appId }: { agentId: string; appId: string }) => {
	      const record = state.registry.apps[appId];
	      if (!record) {
        return {
          success: false,
          appId,
          alreadyGranted: false,
          userMessage: 'La app no esta instalada en Forger.',
          technicalCode: 'personal_agent_app_not_installed',
        };
      }
      const store = getPersonalAgentStore();
      const agent = await store.requireAgent(agentId);
      const nextAppIds = [...new Set([...agent.appIds, appId])];
      if (nextAppIds.length === agent.appIds.length) {
        return {
          success: true,
          appId,
          alreadyGranted: true,
          userMessage: 'El agente ya tenia acceso a esta app.',
        };
      }
      await store.updateAgentPermissions({ agentId, appIds: nextAppIds });
	      return {
	        success: true,
	        appId,
	        alreadyGranted: false,
	        userMessage: 'La app quedo agregada al agente. Sus herramientas estaran disponibles en proximas ejecuciones.',
	      };
	    },
	    listAgentPeers: async ({ agentId }: { agentId: string }) => {
	      const store = getPersonalAgentStore();
	      const [peers, recentThreads] = await Promise.all([
	        store.listPeerGrants(agentId),
	        store.listRecentPeerThreadsForAgent(agentId, 10),
	      ]);
	      return {
	        success: true,
	        peers,
	        recentThreads,
	      };
	    },
	    askAgent: async (input: unknown) => await getPersonalAgentConversationManager().askPeerAgent(input),
	    readAgentThread: async ({ agentId, threadId }: { agentId: string; threadId: string }) => {
	      try {
	        const thread = await getPersonalAgentStore().requirePeerThreadAccess({ agentId, threadId });
	        return {
	          success: true,
	          thread,
	        };
	      } catch (error) {
	        return {
	          success: false,
	          userMessage: 'No se pudo leer este thread entre agentes.',
	          technicalCode: error instanceof Error ? error.message : 'personal_agent_peer_thread_read_failed',
	        };
	      }
    },
    schedulePersonalAgentWakeup: async (input: { agentId: string; conversationId: string; runId: string; seconds: number; prompt: string }) =>
      await requirePersonalAgentRoutineManager().scheduleWakeup({
        agentId: input.agentId,
        conversationId: input.conversationId,
        createdByRunId: input.runId,
        seconds: input.seconds,
        prompt: input.prompt,
      }),
    cancelPersonalAgentWakeup: async (input: { wakeupId?: string; conversationId?: string }) =>
      await requirePersonalAgentRoutineManager().cancelWakeup(input),
    createAgentRoutine: async (input: {
      agentId: string;
      name: string;
      prompt: string;
      frequency: AutomationFrequency;
      missedRunPolicy?: 'skip' | 'always' | 'within_window';
      missedRunWindowMinutes?: number;
      enabled?: boolean;
      authorizationText: string;
    }) => await requirePersonalAgentRoutineManager().create(input.agentId, input),
    listAgentRoutines: async ({ agentId }: { agentId: string }) =>
      await requirePersonalAgentRoutineManager().list({ agentId }),
    updateAgentRoutine: async (input: {
      agentId: string;
      routineId: string;
      name: string;
      prompt: string;
      frequency: AutomationFrequency;
      missedRunPolicy?: 'skip' | 'always' | 'within_window';
      missedRunWindowMinutes?: number;
      enabled?: boolean;
      authorizationText: string;
    }) => {
      const routine = await getPersonalAgentStore().requireRoutine(input.routineId);
      if (routine.agentId !== input.agentId) {
        throw new Error('personal_agent_routine_not_found');
      }
      return await requirePersonalAgentRoutineManager().update(input);
    },
    deleteAgentRoutine: async (input: { agentId: string; routineId: string; authorizationText: string }) => {
      const routine = await getPersonalAgentStore().requireRoutine(input.routineId);
      if (routine.agentId !== input.agentId) {
        throw new Error('personal_agent_routine_not_found');
      }
      return await requirePersonalAgentRoutineManager().delete({
        routineId: input.routineId,
        authorizationText: input.authorizationText,
      });
    },
	    finishSocialAppInstall,
    deleteQuarantinedSocialApp,
    recordCreatedApp: (runId: string, createdApp: ChatCreatedAppRequest) => state.chatOrchestrator?.recordCreatedAppFromMcp(runId, createdApp),
    registerQuestion: async (runId: string, input: { questions: ChatQuestion[] }) => {
      if (!state.chatOrchestrator) {
        throw new Error('chat_orchestrator_unavailable');
      }
      return await state.chatOrchestrator.registerQuestionFromMcp(runId, input);
    },
    getRuntimeStatus,
    getAppViewSnapshot,
    getAppRuntimeDiagnostics,
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
    listConnectionGrantsForApp: async (appId: string) => await getConnectionsService().listSessionGrantsForApp(appId),
    listConnectionsForSession: async (grants: unknown) => await getConnectionsService().listConnectionsForSession(grants as never),
    callConnectionFromSession: async (input: unknown, grants: unknown) => await getConnectionsService().callFromSession(input as never, grants as never),
    memoryList: async (input: unknown, access: unknown) => await getMemoryStore().list(input, access),
    memoryCreate: async (input: unknown, access: unknown) => await getMemoryStore().create(input, access),
    memoryUpdate: async (input: unknown, access: unknown) => await getMemoryStore().update(input, access),
    memoryDelete: async (id: unknown, access: unknown) => await getMemoryStore().delete(id, access),
    listOfficialToolActionIdsForApp: async (appId: string) => await getOfficialToolsService().listAgentActionIdsForApp(appId),
    validateOfficialTool: async (input: unknown, access: ToolAccess) => await getOfficialToolsService().validateAgentCall(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
      locale: access.locale,
    }),
    callOfficialTool: async (input: unknown, access: ToolAccess) => await getOfficialToolsService().callFromAgent(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
      locale: access.locale,
    }),
    getSpeechToTextState: async () => await getSpeechToTextService().getState(),
    getTextToSpeechState: async () => await getTextToSpeechService().getState(),
    synthesizeTextToSpeech: async (input: unknown, access: ToolAccess) => {
      const record = state.registry.apps[access.appId];
      const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
      if (access.caller === 'app-agent' && !appAllowsTextToSpeech(manifest?.platformCapabilities)) {
        return { success: false, userMessage: 'Text to speech is not available for this app.', technicalCode: 'text_to_speech_capability_required' };
      }
      return await getTextToSpeechService().synthesize(input as { text: string; model: string; voice: string; speed?: number; format?: 'wav' | 'mp3' | 'opus' });
    },
    processSpeechToText: async (input: unknown, access: ToolAccess) => {
      const record = state.registry.apps[access.appId];
      const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
      return await getSpeechToTextService().process(input as { path: string; task?: 'transcribe' | 'translate'; language?: string; model?: string }, {
        appId: access.appId,
        appInstallDir: record?.installDir,
        appAllowsSpeechToText: access.caller === 'app-agent' ? appAllowsSpeechToText(manifest?.platformCapabilities) : false,
      });
    },
    workflowGetNodeContext: (nodeRunKey: string) => state.workflowManager?.getNodeContext(nodeRunKey) ?? null,
    workflowCompleteNode: (nodeRunKey: string, args: { output?: unknown; summary?: unknown }) =>
      state.workflowManager?.completeNodeFromMcp(nodeRunKey, args)
        ?? { success: false, technicalCode: 'workflow_manager_unavailable' },
    workflowFailNode: (nodeRunKey: string, args: { reason?: unknown }) =>
      state.workflowManager?.failNodeFromMcp(nodeRunKey, args)
        ?? { success: false, technicalCode: 'workflow_manager_unavailable' },
    workflowsList: () => state.workflowManager?.list() ?? [],
    workflowsGet: (workflowId: string) => state.workflowManager?.get(workflowId) ?? null,
    workflowsUpsert: async (input: unknown) => {
      if (!state.workflowManager) {
        throw new Error('workflow_manager_unavailable');
      }
      return await state.workflowManager.upsert(input);
    },
    workflowsRun: async (workflowId: string) => {
      if (!state.workflowManager) {
        throw new Error('workflow_manager_unavailable');
      }
      return await state.workflowManager.runNow(workflowId, 'chat');
    },
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
    resolveAppSecretsEnvironment: async (appId: string, manifest: AppManifest | null) => {
      const appSecretsValidationError = getManifestAppSecretsValidationError(manifest);
      if (appSecretsValidationError) {
        throw new Error('invalid_app_secrets_manifest');
      }
      const declarations = normalizeManifestAppSecrets(manifest);
      try {
        const resolved = await getSecretsStore().resolveAppEnv(appId, declarations);
        return {
          ...resolved,
          fingerprint: createAppMcpSecretsFingerprint(resolved.env),
        };
      } catch (error) {
        if (isSecretsVaultUnavailableError(error)) {
          throw new Error('secrets_vault_unavailable');
        }
        throw error;
      }
    },
    formatProcessOutputForInstallLog,
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
    providerProfilesRoot: getLlmProviderProfilesRoot(),
    resolveAuthProfile: resolveLlmAuthProfile,
    getAgentRuntime: chooseAgentRuntime,
    agentContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getAntigravityCliPath: async () => await (resolveAntigravityCliPath?.() ?? Promise.resolve(null)),
    getCodexPathEntries: async (appId?: string) => await getAgentPathEntries(appId),
    ensureGitAvailable,
    getCodexEnvironment: async (appId?: string) => {
      const record = appId ? state.registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getChatNetworkAccessDefault: getDesktopChatNetworkAccessDefault,
    resolveChatAppRoot: async (appId: string, chatMode?: string) => {
      if (chatMode !== 'social_app_review') {
        return null;
      }
      const context = await getSocialAppReviewPromptContext(appId);
      return context && typeof context === 'object' && typeof (context as { appRoot?: unknown }).appRoot === 'string'
        ? (context as { appRoot: string }).appRoot
        : null;
    },
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: getClaudeAuthenticatedForForger,
    getAntigravityAuthenticated: async () => {
      const status = await (getAntigravityAuthStatus?.() ?? Promise.resolve({ authenticated: false } as AntigravityAuthStatus));
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
      await (state.appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
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
      llmRunsStore?.recordChatRunEvent(event, {
        appName: state.registry.apps[event.run.appId]?.name ?? (event.run.appId === 'forger' ? 'Forger' : undefined),
      });
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
    providerProfilesRoot: getLlmProviderProfilesRoot(),
    resolveAuthProfile: resolveLlmAuthProfile,
    getAgentRuntime: chooseAgentRuntime,
    appAllowsAgentRuntimeControl: async (appId: string) => {
      const record = state.registry.apps[appId];
      const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
      return appAllowsAgentRuntimeControl(manifest?.platformCapabilities);
    },
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getAntigravityCliPath: async () => await (resolveAntigravityCliPath?.() ?? Promise.resolve(null)),
    getCodexPathEntries: async (appId?: string) => await getAgentPathEntries(appId),
    ensureGitAvailable,
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
    getClaudeAuthenticated: getClaudeAuthenticatedForForger,
    getAntigravityAuthenticated: async () => {
      const status = await (getAntigravityAuthStatus?.() ?? Promise.resolve({ authenticated: false } as AntigravityAuthStatus));
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
    resolveFolderGrant: async (appId: string, grantId: string) => await appFolderGrantStore.resolve(appId, grantId),
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onTaskUpdated: (event: TaskEventLike) => {
      llmRunsStore?.recordAppPromptTaskEvent(event, {
        appName: state.registry.apps[event.task.appId]?.name,
      });
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
    providerProfilesRoot: getLlmProviderProfilesRoot(),
    resolveAuthProfile: resolveLlmAuthProfile,
    getAgentRuntime: chooseAgentRuntime,
    appAllowsAgentRuntimeControl: async (appId: string) => {
      const record = state.registry.apps[appId];
      const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
      return appAllowsAgentRuntimeControl(manifest?.platformCapabilities);
    },
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getAntigravityCliPath: async () => await (resolveAntigravityCliPath?.() ?? Promise.resolve(null)),
    getCodexPathEntries: async (appId?: string) => await getAgentPathEntries(appId),
    ensureGitAvailable,
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
    getClaudeAuthenticated: getClaudeAuthenticatedForForger,
    getAntigravityAuthenticated: async () => {
      const status = await (getAntigravityAuthStatus?.() ?? Promise.resolve({ authenticated: false } as AntigravityAuthStatus));
      return status.authenticated;
    },
    hasCodexConversation: hasInstalledCodexConversation,
    resolveAgents: resolveInstalledAgents,
    resolveFolderGrant: async (appId: string, grantId: string) => await appFolderGrantStore.resolve(appId, grantId),
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
      llmRunsStore?.recordAppAgentConversationEvent(event, {
        appName: state.registry.apps[event.conversation.appId]?.name,
      });
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
      const [codexStatus, claudeStatus, antigravityStatus] = await Promise.all([
        getCodexAuthStatus().catch(() => ({ authenticated: false })),
        getClaudeAuthStatus().catch(() => ({ authenticated: false })),
        getAntigravityAuthStatus?.().catch(() => ({ authenticated: false })) ?? Promise.resolve({ authenticated: false }),
      ]);
      const codex = Boolean(codexStatus.authenticated);
      const claude = Boolean(claudeStatus.authenticated);
      const antigravity = Boolean(antigravityStatus.authenticated);
      return {
        connected: codex || claude || antigravity,
        codex,
        claude,
        ...(getAntigravityAuthStatus ? { antigravity } : {}),
      };
    },
    getAppContext: (appId: string) => {
      const running = runningApps.get(appId);
      return {
        locale: running?.locale ?? 'es',
        rawLocale: running?.rawLocale ?? null,
      };
    },
    getAppPlatformCapabilities: async (appId: string) => {
      const record = state.registry.apps[appId];
      const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
      return {
        speechToText: appAllowsSpeechToText(manifest?.platformCapabilities),
        audioInput: appAllowsAudioInput(manifest?.platformCapabilities),
        textToSpeech: appAllowsTextToSpeech(manifest?.platformCapabilities),
        workspaceFolders: appAllowsWorkspaceFolders(manifest?.platformCapabilities),
        agentRuntimeControl: appAllowsAgentRuntimeControl(manifest?.platformCapabilities),
        sidekickDisplay: appAllowsSidekickDisplay(manifest?.platformCapabilities),
        sidekickSpeech: appAllowsSidekickSpeech(manifest?.platformCapabilities),
      };
    },
    requestFolderGrant: async (appId: string, grantToken: string) => {
      const resolved = resolveAppFolderGrant(appId, grantToken);
      return resolved ? await appFolderGrantStore.create(appId, resolved.path) : null;
    },
    listFolderGrants: async (appId: string) => await appFolderGrantStore.list(appId),
    revokeFolderGrant: async (appId: string, grantId: string) => await appFolderGrantStore.revoke(appId, grantId),
    officialTools: state.officialToolsService ? {
      listToolsForApp: async (appId: string) => await state.officialToolsService!.listToolsForApp(appId),
      callFromApp: async (appId: string, input: CallOfficialToolInput) => await state.officialToolsService!.callFromApp(appId, input),
    } : undefined,
    connections: state.connectionsService ? {
      listConnectionsForApp: async (appId: string) => await state.connectionsService!.listConnectionsForApp(appId),
      callFromApp: async (appId: string, input: CallConnectionActionInput) => await state.connectionsService!.callFromApp(appId, input),
      configureFromApp: async (appId: string, input: ConfigureConnectionInput) => await state.connectionsService!.configureFromApp(appId, input),
    } : undefined,
    getAudioDevices,
    updateAudioInputDevices: async (devices: AudioRuntimeDevices) => {
      await getLiveVoiceInputService().updateDevices({
        devices: devices.inputDevices.map((device) => ({
          id: device.id,
          label: device.label,
          kind: device.kind,
          groupId: device.groupId,
          default: device.default,
          supported: device.supported,
          requiresDisplayCapture: device.requiresDisplayCapture,
        })),
      });
    },
    createLiveVoiceSession: async (appId: string, input: { consumerKind: 'app_transcript'; deviceId?: string; task?: 'transcribe' | 'translate'; language?: string }) => {
      return await getLiveVoiceInputService().createSession({
        deviceId: input.deviceId,
        consumerKind: input.consumerKind,
        label: `${appId} transcript`,
        targetType: 'app_agent',
        targetId: appId,
        task: input.task,
        language: input.language,
      });
    },
    stopLiveVoiceSession: async (_appId: string, input: { consumerId: string }) => {
      return await getLiveVoiceInputService().stop({ consumerId: input.consumerId, targetId: _appId });
    },
    processSpeechToText: async (appId: string, input: { path: string; task?: 'transcribe' | 'translate'; language?: string; model?: string }) => {
      const record = state.registry.apps[appId];
      const manifest = record?.installDir ? await resolveInstalledManifest(record.installDir) : null;
      return await getSpeechToTextService().process(input, {
        appId,
        appInstallDir: record?.installDir,
        appAllowsSpeechToText: appAllowsSpeechToText(manifest?.platformCapabilities),
      });
    },
    synthesizeTextToSpeech: async (input: { text: string; model: string; voice: string; speed?: number; format?: 'wav' | 'mp3' | 'opus' }) => await getTextToSpeechService().synthesize(input),
    playTextToSpeechAudio,
    cancelTextToSpeechPlayback,
    deleteTextToSpeechAudio,
    ...createSidekickRuntimeBridgeBindings(getSidekickService),
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
    providerProfilesRoot: getLlmProviderProfilesRoot(),
    resolveAuthProfile: resolveLlmAuthProfile,
    getAgentRuntime: chooseAgentRuntime,
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getAntigravityCliPath: async () => await (resolveAntigravityCliPath?.() ?? Promise.resolve(null)),
    getCodexPathEntries: async () => await getAgentPathEntries(),
    getAgentNetworkAccess: anyAppAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: getClaudeAuthenticatedForForger,
    getAntigravityAuthenticated: async () => {
      const status = await (getAntigravityAuthStatus?.() ?? Promise.resolve({ authenticated: false } as AntigravityAuthStatus));
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
          ...(event.diagnosticTranscript ? { automationTranscript: event.diagnosticTranscript } : {}),
        });
      }
      const { diagnosticTranscript: _diagnosticTranscript, ...publicEvent } = event;
      emitAutomationUpdated(publicEvent as { automation: unknown; run?: unknown });
    },
  });
  });
  await startupLogger.step('startup:automation_manager:initialize', async () => {
    await state.automationManager?.initialize();
  });
  await startupLogger.step('startup:workflow_manager:create', () => {
  state.workflowManager = new WorkflowManager({
    forgerHomeRoot: getForgerHomeRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    providerProfilesRoot: getLlmProviderProfilesRoot(),
    resolveAuthProfile: resolveLlmAuthProfile,
    getAgentRuntime: chooseAgentRuntime,
    getInstalledApps: () => Object.values(state.registry.apps).map(toAppSummary),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
    getAntigravityCliPath: async () => await (resolveAntigravityCliPath?.() ?? Promise.resolve(null)),
    getCodexPathEntries: async () => await getAgentPathEntries(),
    getAgentNetworkAccess: anyAppAllowsAgentNetworkAccess,
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    getClaudeAuthenticated: getClaudeAuthenticatedForForger,
    getAntigravityAuthenticated: async () => {
      const status = await (getAntigravityAuthStatus?.() ?? Promise.resolve({ authenticated: false } as AntigravityAuthStatus));
      return status.authenticated;
    },
    createForgerMcpSession: (
      nodeRunKey: string,
      appIds: string[],
      forgerToolActionIds: string[],
      connectionGrants: unknown[],
    ) =>
      state.forgerMcpServer?.createSession(nodeRunKey, 'forger', {
        caller: 'workflow',
        appIds,
        forgerToolActionIds,
        connectionGrants: connectionGrants as never,
      }) ?? null,
    releaseForgerMcpSession: (token: string) => state.forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], listenerId: string) =>
      await (state.appMcpManager?.listenMcps(appIds, listenerId) ?? Promise.resolve([])),
    releaseAppMcps: (listenerId: string) => {
      state.appMcpManager?.releaseMcps(listenerId);
    },
    getPersonalAgent: async (agentId: string) => {
      try {
        return await getPersonalAgentStore().requireAgent(agentId);
      } catch {
        return null;
      }
    },
    callForgerToolAction: async (input: unknown) =>
      await getOfficialToolsService().callFromAgent(input),
    callConnectionAction: async (input: unknown) =>
      await getConnectionsService().call(input as CallConnectionActionInput),
    callConnectorAction: async (input: unknown) =>
      await getOfficialToolsService().callFromAgent(input),
    getValidToolIds: () => new Set(AGENT_TOOL_DEFINITIONS.map((tool) => tool.id)),
    onAgentRunActivity: (activity: unknown) => {
      llmRunsStore?.recordWorkflowNodeActivity(activity, {
        appName: typeof activity === 'object' && activity && 'sourceRef' in activity
          ? state.registry.apps[String((activity as { sourceRef?: { appId?: unknown } }).sourceRef?.appId ?? '')]?.name
          : undefined,
      });
    },
    onWorkflowUpdated: (event: { workflow: unknown; run?: unknown }) => {
      emitWorkflowUpdated(event);
    },
  });
  });
  await startupLogger.step('startup:workflow_manager:initialize', async () => {
    await state.workflowManager?.initialize();
  });
  await startupLogger.step('startup:personal_agent_routine_manager:initialize', async () => {
    const routineManager = getPersonalAgentRoutineManager?.();
    if (!routineManager) return;
    state.personalAgentRoutineManager = routineManager;
    await routineManager.initialize();
  });
  await startupLogger.step('startup:memory_maintenance_manager:create', () => {
  state.memoryMaintenanceManager = new MemoryMaintenanceManager({
    forgerHomeRoot: getForgerHomeRoot(),
    codexHome: getCodexHome(),
    providerProfilesRoot: getLlmProviderProfilesRoot(),
    resolveAuthProfile: resolveLlmAuthProfile,
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

  const schedulePendingDeepLinkFlush = (): void => {
    if (!state.mainWindow || !state.pendingDeepLink || state.pendingDeepLinkFlushScheduled) return;
    state.pendingDeepLinkFlushScheduled = true;
    state.mainWindow.webContents.once('did-finish-load', () => {
      state.pendingDeepLinkFlushScheduled = false;
      flushPendingDeepLink();
    });
  };

  // Deliver any deep-link captured before the renderer existed (cold
  // boot from `process.argv` or an `open-url` fired during startup).
  schedulePendingDeepLinkFlush();

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

registerGracefulShutdownHandlers({ app, state, runningApps, stopInstalledApp, terminateProcess, closeServer });
};
