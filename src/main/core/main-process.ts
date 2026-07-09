import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Notification, session, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import yauzl from 'yauzl';
import { settingsSeed } from '../../shared/mock-data';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getSharedCopy, installProgressByPhase } from '../../shared/i18n';
import { ChatOrchestrator } from '../chat/orchestrator';
import { AppAgentTaskManager } from '../app-agent-task-manager';
import { AppAgentConversationManager } from '../app-agent-conversation-manager';
import { renderManifestAgentPrompt, type ManifestAgentPromptKind } from '../manifest-agent-prompts';
import { AppMcpManager } from '../app-mcp-manager';
import { AutomationManager } from '../automation-manager';
import { WorkflowManager } from '../workflow-manager';
import { BackgroundTaskStore } from '../background-task-store';
import {
  extractDeepLinkFromArgv,
  focusWindow as focusDeepLinkWindow,
  FORGER_PROTOCOL,
  parseForgerUrl,
  registerForgerProtocol,
  type ForgerDeepLink,
} from '../deep-links';
import { DevCatalogService } from '../dev-catalog-service';
import { DesktopUpdater } from '../desktop-updater';
import { DesktopRuntimeBridge } from '../desktop-runtime-bridge';
import { DesktopErrorReporter } from '../error-reporting';
import { FileLibrary } from '../file-library';
import { SelfOAuthCallbackService } from '../oauth-callback/service';
import { buildMacTerminalLoginScript, buildMacTerminalScriptLaunchCommand } from '../auth-login-scripts';
import { buildCodexAuthEnvironment, classifyCodexAuthOutput, extractAllowedCodexAuthUrls } from '../codex-auth-helpers';
import { ForgerMcpServer } from '../forger-mcp-server';
import { MemoryMaintenanceManager } from '../memory-maintenance-manager';
import { MemoryStore } from '../memory-store';
import { AgentConversationManager } from '../personal-agents/agent-conversation-manager';
import { AgentRoutineManager } from '../personal-agents/agent-routine-manager';
import { AgentStore } from '../personal-agents/agent-store';
import { RemoteAgentSessionService } from '../personal-agents/remote-session-service';
import { PromptOverridesStore, buildPromptBases, promptOverrideErrorResult } from '../prompt-overrides';
import { OfficialToolsService, normalizeAppToolDeclarations } from '../official-tools-service';
import { ConnectionsService } from '../connections-service';
import { cleanupLegacyExternalToolState } from '../legacy-external-tools-cleanup';
import { AudioRuntimeBroker } from '../audio-runtime-broker';
import { SpeechToTextServiceManager } from '../speech-to-text-service';
import { TextToSpeechServiceManager } from '../text-to-speech-service';
import { LiveVoiceInputServiceManager } from '../live-voice-input-service';
import { WakeWordServiceManager } from '../wake-word-service';
import { ForgerAccountStore, publicForgerAccount, type StoredForgerAccount } from '../forger-account-store';
import { ForgerBackendClient } from '../forger-backend-client';
import { registerForgerCloudOAuth } from '../forger-cloud-oauth';
import { CloudDeviceManager } from '../cloud-device-manager';
import { CloudIdentityStore, type EncryptedCloudText } from '../cloud-identity-store';
import { BackupsManager } from '../backups-manager';
import { createWindowStateEventRegistrar, createWindowStateReader, registerWindowIpcHandlers } from '../ipc/window';
import { registerAgentIpcHandlers, type AgentIpcDeps } from '../ipc/agent-handlers';
import { registerMainIpcHandlers, type MainProcessIpcDeps } from '../ipc/main-handlers';
import { createInstalledAppRuntimeController } from '../runtime/installed-app-runtime';
import { createInstalledAppLifecycleController } from '../installed-apps/lifecycle';
import { createLocalAppCreator } from '../installed-apps/local-app-creator';
import { createCommandGitController } from '../runtime/command-git';
import { createAgentAuthController } from '../runtime/agent-auth';
import { createCloudSocialRelayController } from '../cloud/social-relay';
import { createManifestSupportController } from '../apps/manifest-support';
import { createAppContextSupportController } from '../apps/context-support';
import { createRegistryStoreController } from '../installed-apps/registry-store';
import { createSettingsServiceController } from './settings-service';
import type { LlmProviderAuthProfileResolver } from '../llm-provider/types';
import { configureDesktopUserDataPath, createPathConfigController } from './path-config';
import { createMainUtilitiesController } from './main-utilities';
import { createLocalNetworkShareController } from './local-network-share-service';
import { createDeveloperPathService } from './developer-path-service';
import { APP_CLAUDE_MODEL_OPTIONS, APP_CODEX_MODEL_OPTIONS, BUILT_IN_CLAUDE_EFFORT, BUILT_IN_CLAUDE_MODEL, BUILT_IN_CODEX_MODEL, BUILT_IN_CODEX_REASONING, BUNDLED_GIT_VERSION, CLAUDE_CODE_VERSION, CODEX_CLI_VERSION, CODEX_USAGE_DASHBOARD_URL, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION } from './agent-runtime-defaults';
import { RemoteNetworkShareManager } from '../remote-network-share-manager';
import { RemoteActivityStore } from '../remote-activity-store';
import { LlmRunsStore } from '../llm-runs-store';
import { createRuntimeInstallController } from '../runtime/runtime-install';
import { spawnProcess } from '../runtime/process-spawn';
import { loadOptionalBetterSqlite } from '../runtime/optional-better-sqlite';
import { createWindowBootstrapController } from './window-bootstrap';
import { AGENT_TOOL_DEFINITIONS, AGENT_TOOL_IDS, createInitialAgentToolSettings } from './agent-tool-packages';
import { registerMainLifecycle } from './main-lifecycle';
import type { AppManifest, AppManifestService, AppManifestStack, AppRegistry, InstalledAppRecord, RuntimeBinarySet, RunningAppProcess, StackSkillTemplate } from './main-process-types';
import { FORGER_AGENT_CONTRACT_MARKER, FORGER_AGENT_CONTRACT_MARKER_PREFIX, FORGER_AGENT_CONTRACT_VERSION, buildGlobalForgerAgentsMarkdown } from '../prompt-builder/forger-base';
import { buildFailureDiagnostic } from '../../shared/error-diagnostics';
import {
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  DEFAULT_ANTIGRAVITY_EFFORT,
  DEFAULT_ANTIGRAVITY_MODEL,
  createAgentProviderRuntimeRegistry,
} from '../../shared/agent-runtime-registry';
import { appAllowsAudioInput, appAllowsSpeechToText, appAllowsTextToSpeech } from '../../shared/platform-capabilities';
import { buildForgerAppAgentsMarkdown } from '../prompt-builder/apps-base';
import { buildCodexPromptForFreeChat, buildCodexPromptWithAppContext } from '../prompt-builder/user-message';
import { buildForgerOfficialToolSkillTemplates, buildForgerOfficialToolsPromptSection } from '../prompt-builder/official-tools';
import { SecretsStore, appSecretEnvName, isSecretsVaultUnavailableError } from '../secrets-store';
import type {
  AgentDefaults, AgentProvider, AgentRuntime, AgentRuntimeRecommendations, AgentRuntimeRequest, AgentToolSettings,
  AppAgent, AppAgentPromptSet, AppAgentPromptTemplate, AppAgentPromptVariable, AppAgentPromptVariableType,
  AppAgentRuntimeInput, AppAgentThreadCreateInput, AppAgentThreadRunControlInput, AppAgentThreadRunStartInput,
  AppAgentThreadRunSteerInput, AppCategory, AppCodexConversationCreateInput, AppCodexConversationSendMessageInput,
  AppCodexTaskStartInput, AppDetails, AppExternalFolderSelection, AppLocalChangeSummary, AppManifestAgentResumeInput,
  AppManifestAgentStartInput, AppManifestAgentSteerInput, AppManifestAgentStopInput, AppOperationSummary,
  AppPromptMutationResult, AppPromptRestoreInput, AppPromptReviewInput, AppPromptReviewItem, AppPromptTemplate,
  AppPromptTestInput, AppPromptTestResult, AppPromptValidationResult, AppSecretConnection, AppSecretDeclaration,
  AppSecretsState, AppStatus, AppSummary, AppToolDeclaration, AppToolsInstallGate, AutomationUpsertInput,
  BackgroundTask, BasicActionResult, CallOfficialToolInput, CatalogApp, ChatApplyRunInput, ChatApprovePermissionInput,
  ChatCancelRunInput, ChatGetRunInput, ChatRun, ChatRunEvent, ChatStartRunInput, ChatUndoInput, ClaudeAuthStatus,
  ClaudeEffort, AntigravityAuthSessionEvent, AntigravityAuthSessionStartResult, AntigravityAuthStatus, CloudAppMessagePermissionDecision, CloudFriendUser, CloudFriendship, CloudMessage, CloudMessageEnvelope,
  CloudSendAppShareInput, CloudSendMessageInput, CloudSocialEvent, CloudSyncSettings, CodexAuthStatus,
  CodexReasoningEffort, ConfigureOfficialToolInput, ConnectAppSecretInput, CreateLocalAppInput, CreateLocalAppResult,
  CreateRemoteAppBackupInput, CreateRemoteAppBackupResult, CreateUserSecretInput, DeleteUserSecretInput,
  DesktopErrorReportPreview, DesktopUpdateState, DisconnectAppSecretInput, FailureDiagnosticFields, FilesCreateCategoryInput,
  FilesDeleteCategoryInput, FilesDeleteInput, FilesDiscardStagedForChatInput, FilesImportInput, FilesListInput,
  FilesMoveInput, FilesRenameCategoryInput, FilesRenameInput, FilesStageForChatInput, ForgerAccountLoginInput,
  ForgerAccountProfileInput, ForgerAccountRegisterInput, FriendChatWindowOpenResult, InstallAppResult, LlmProviderProfilesState, PrepareSocialAppReviewInput, MemoryCreateInput,
  MemoryListInput, MemoryUpdateInput, OfficialToolRuntimeEvent, OpenAppResult, PersonalAgentConversationEvent, RemoteAppBackupSummary,
  LlmProviderProfileMutationResult, RendererChatTraceEvent, RuntimeStatus, SetActiveLlmProviderProfileInput, SetActiveLlmProviderProfileResult, SetAppToolGrantInput, Settings, SharedFileRef, StopAppResult,
  SubmitAppRatingInput, SubmitProductFeedbackInput, SubmitUsageEventInput, UpdateAgentDefaultsInput,
  UpdateAgentToolApprovalInput, UpdateCodexDefaultsInput, UpdateDeveloperModeInput, UpdateLlmProviderProfileDefaultsInput, UpdateUserSecretInput,
} from '../../shared/types';

const BetterSqlite3 = loadOptionalBetterSqlite();
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
configureDesktopUserDataPath({ app, isDev, path });
const backendBaseUrl = process.env.FORGER_BACKEND_URL ?? (isDev ? 'http://127.0.0.1:3300' : 'https://platform.forger.cloud');
let localCatalogJsonUrl: string | undefined;
const CODEX_MODEL_VALUES = new Set(APP_CODEX_MODEL_OPTIONS.map((option) => option.realModelName));
const CODEX_REASONING_VALUES = new Set<CodexReasoningEffort>(['none', 'low', 'medium', 'high', 'xhigh']);
const CLAUDE_MODEL_VALUES = new Set(APP_CLAUDE_MODEL_OPTIONS.map((option) => option.realModelName));
const CLAUDE_EFFORT_VALUES = new Set<ClaudeEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
const ANTIGRAVITY_MODEL_VALUES = new Set(ANTIGRAVITY_MODEL_OPTIONS.map((option) => option.realModelName));
const ANTIGRAVITY_EFFORT_VALUES = new Set(ANTIGRAVITY_EFFORT_OPTIONS.map((option) => option.value));
const AGENT_PROVIDER_RUNTIME_REGISTRY = createAgentProviderRuntimeRegistry({
  codex: {
    defaultModel: BUILT_IN_CODEX_MODEL,
    defaultReasoningEffort: BUILT_IN_CODEX_REASONING,
    modelValues: CODEX_MODEL_VALUES,
    reasoningEffortValues: CODEX_REASONING_VALUES,
  },
  claude: {
    defaultModel: BUILT_IN_CLAUDE_MODEL,
    defaultEffort: BUILT_IN_CLAUDE_EFFORT,
    modelValues: CLAUDE_MODEL_VALUES,
    effortValues: CLAUDE_EFFORT_VALUES,
  },
  antigravity: {
    defaultModel: DEFAULT_ANTIGRAVITY_MODEL,
    defaultEffort: DEFAULT_ANTIGRAVITY_EFFORT,
    modelValues: ANTIGRAVITY_MODEL_VALUES,
    effortValues: ANTIGRAVITY_EFFORT_VALUES,
  },
});
let devCatalogService: DevCatalogService | null = null;
const APP_FOLDER_GRANT_TTL_MS = 5 * 60 * 1000;
const appFolderGrantSecret = randomBytes(32).toString('base64url');
const useCustomWindowFrame = process.platform === 'win32';
const getWindowState = createWindowStateReader(useCustomWindowFrame);
const registerWindowStateEvents = createWindowStateEventRegistrar(getWindowState);

const RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'darwin_x64', 'linux_x64', 'win32_x64']);

let mainWindow: BrowserWindow | null = null;
const remoteActivityStore = new RemoteActivityStore({ getMainWindow: () => mainWindow });
const llmRunsStore = new LlmRunsStore({ getMainWindow: () => mainWindow });
let pendingDeepLink: ForgerDeepLink | null = null;
let pendingDeepLinkFlushScheduled = false;
let catalogApps: CatalogApp[] = [];
let settings: Settings = structuredClone(settingsSeed);
let registry: AppRegistry = { apps: {} };
let forgerAccount: StoredForgerAccount = { authenticated: false };
let forgerAccountStore: ForgerAccountStore | null = null;
let cloudDeviceManager: CloudDeviceManager | null = null;
let cloudIdentityStore: CloudIdentityStore | null = null;
let forgerBackendClient: ForgerBackendClient | null = null;
const cloudSyncSettings: CloudSyncSettings = { appSync: {} };
const runningApps = new Map<string, RunningAppProcess>();
const appWindows = new Map<string, BrowserWindow>();

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => {
        callback({});
      });
  });
}).catch(() => undefined);
const friendChatWindows = new Map<number, BrowserWindow>();
const stoppingApps = new Set<string>();
const appLifecycleLocks = new Map<string, Promise<unknown>>();
const backendPythonEnvironmentLocks = new Map<string, Promise<void>>();
const runtimeLocks = new Map<string, Promise<RuntimeBinarySet>>();
const gitToolLocks = new Map<string, Promise<string | null>>();
let chatOrchestrator: ChatOrchestrator | null = null;
let appAgentTaskManager: AppAgentTaskManager | null = null;
let appAgentConversationManager: AppAgentConversationManager | null = null;
let fileLibrary: FileLibrary | null = null;
let secretsStore: SecretsStore | null = null;
let officialToolsService: OfficialToolsService | null = null;
let connectionsService: ConnectionsService | null = null;
let audioRuntimeBroker: AudioRuntimeBroker | null = null;
let speechToTextService: SpeechToTextServiceManager | null = null;
let textToSpeechService: TextToSpeechServiceManager | null = null;
let liveVoiceInputService: LiveVoiceInputServiceManager | null = null;
let wakeWordService: WakeWordServiceManager | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let desktopErrorReporter: DesktopErrorReporter | null = null;
let automationManager: AutomationManager | null = null;
let workflowManager: WorkflowManager | null = null;
let backgroundTaskStore: BackgroundTaskStore | null = null;
let appMcpManager: AppMcpManager | null = null;
let backupsManager: BackupsManager | null = null;
let memoryStore: MemoryStore | null = null;
let personalAgentStore: AgentStore | null = null;
let personalAgentConversationManager: AgentConversationManager | null = null;
let personalAgentRoutineManager: AgentRoutineManager | null = null;
let remoteAgentSessionService: RemoteAgentSessionService | null = null;
let memoryMaintenanceManager: MemoryMaintenanceManager | null = null;
let desktopRuntimeBridge: DesktopRuntimeBridge | null = null;
let selfOAuthCallbackService: SelfOAuthCallbackService | null = null;

desktopErrorReporter = new DesktopErrorReporter({
  getMainWindow: () => mainWindow,
  getAppVersion: () => app.getVersion(),
  getInstalledApp: (appId) => registry.apps[appId],
});

let promptOverridesStore: PromptOverridesStore | null = null;

const createPathConfigDeps = () => ({ app, forgerAccount, isDev, os, path });
const getPathConfigController = () => createPathConfigController(createPathConfigDeps());
const normalizeVersionForFolder = (value: string): string => getPathConfigController().normalizeVersionForFolder(value);
const normalizeNodeRuntimeVersion = (value?: string | null): string => getPathConfigController().normalizeNodeRuntimeVersion(value);
const resolvePlatformAlias = (): string => getPathConfigController().resolvePlatformAlias();
const getRegistryPath = (): string => getPathConfigController().getRegistryPath();
const getRegistryBackupPath = (): string => getPathConfigController().getRegistryBackupPath();
const getRuntimesRoot = (): string => getPathConfigController().getRuntimesRoot();
const getTempRoot = (): string => getPathConfigController().getTempRoot();
const getLogsRoot = (): string => getPathConfigController().getLogsRoot();
const getInstallLogPath = (): string => getPathConfigController().getInstallLogPath();
const getForgerHomeRoot = (): string => getPathConfigController().getForgerHomeRoot();
const getPrivateAppsRoot = (): string => getPathConfigController().getPrivateAppsRoot();
const getPrivateDataRoot = (): string => getPathConfigController().getPrivateDataRoot();
const getBackupsRoot = (): string => getPathConfigController().getBackupsRoot();
const getForgerMetadataRoot = (): string => getPathConfigController().getForgerMetadataRoot();
const getLegacyForgerMetadataRoot = (): string => getPathConfigController().getLegacyForgerMetadataRoot();
const getCodexRoot = (): string => getPathConfigController().getCodexRoot();
const getCodexHome = (): string => getPathConfigController().getCodexHome();
const getProviderProfilesRoot = (): string => path.join(app.getPath('userData'), 'llm-profiles');
const getClaudeRoot = (): string => getPathConfigController().getClaudeRoot();
const getAntigravityRoot = (): string => getPathConfigController().getAntigravityRoot();
const getAgentToolSettingsPath = (): string => getPathConfigController().getAgentToolSettingsPath();
const getSettingsPath = (): string => getPathConfigController().getSettingsPath();
const getPromptOverridesPath = (): string => getPathConfigController().getPromptOverridesPath();
const getForgerAccountPath = (): string => getPathConfigController().getForgerAccountPath();
const getCloudDevicePath = (): string => getPathConfigController().getCloudDevicePath();
const getCloudIdentityPath = (): string => getPathConfigController().getCloudIdentityPath();
const getSocialMessagesPath = (): string => getPathConfigController().getSocialMessagesPath();
const getCloudSyncSettingsPath = (): string => getPathConfigController().getCloudSyncSettingsPath();
const getCloudDeviceAccountStorageKey = (): string | undefined => getPathConfigController().getCloudDeviceAccountStorageKey();

const settingsServiceState = { get promptOverridesStore() { return promptOverridesStore; }, set promptOverridesStore(value) { promptOverridesStore = value; }, get settings() { return settings; }, set settings(value) { settings = value; } };
const createSettingsServiceDeps = () => ({
  agentProviderRegistry: AGENT_PROVIDER_RUNTIME_REGISTRY,
  PromptOverridesStore,
  fs,
  getClaudeAuthStatus,
  getAntigravityAuthStatus,
  getCodexAuthStatus,
  path,
  getPromptOverridesPath,
  getSettingsPath,
  settingsSeed,
  state: settingsServiceState,
});
const getSettingsServiceController = () => createSettingsServiceController(createSettingsServiceDeps());
const getPromptOverridesStore = (): PromptOverridesStore => getSettingsServiceController().getPromptOverridesStore();
const normalizeCodexReasoningEffort = (value: unknown, fallback: CodexReasoningEffort): CodexReasoningEffort => getSettingsServiceController().normalizeCodexReasoningEffort(value, fallback);
const normalizeClaudeEffort = (value: unknown, fallback: ClaudeEffort): ClaudeEffort => getSettingsServiceController().normalizeClaudeEffort(value, fallback);
const normalizeAgentProvider = (value: unknown): AgentProvider | undefined => getSettingsServiceController().normalizeAgentProvider(value);
const normalizeDefaultAgentProvider = (value: unknown): AgentProvider | 'auto' => getSettingsServiceController().normalizeDefaultAgentProvider(value);
const normalizeSettings = (input?: Partial<Settings>): Settings => getSettingsServiceController().normalizeSettings(input);
const loadSettings = async (): Promise<void> => await getSettingsServiceController().loadSettings();
const saveSettings = async (): Promise<void> => await getSettingsServiceController().saveSettings();
const getCodexDefaults = (): Settings['codexDefaults'] => getSettingsServiceController().getCodexDefaults();
const updateCodexDefaults = async (input: UpdateCodexDefaultsInput): Promise<Settings> => await getSettingsServiceController().updateCodexDefaults(input);
const updateAgentDefaults = async (input: UpdateAgentDefaultsInput): Promise<Settings> => await getSettingsServiceController().updateAgentDefaults(input);
const updateDeveloperMode = async (input: UpdateDeveloperModeInput): Promise<Settings> => await getSettingsServiceController().updateDeveloperMode(input);
const markProviderConnected = async (provider: AgentProvider): Promise<void> => await getSettingsServiceController().markProviderConnected(provider);
const markProviderDisconnected = async (provider: AgentProvider): Promise<void> => await getSettingsServiceController().markProviderDisconnected(provider);
const chooseAgentRuntime = async (requested?: AgentRuntimeRequest): Promise<AgentRuntime> => await getSettingsServiceController().chooseAgentRuntime(requested);
const chooseConnectedProvider = async (): Promise<AgentProvider> => await getSettingsServiceController().chooseConnectedProvider();
const listLlmProviderProfiles = async (): Promise<LlmProviderProfilesState> => await getSettingsServiceController().listLlmProviderProfiles();
const setActiveLlmProviderProfile = async (input: SetActiveLlmProviderProfileInput): Promise<SetActiveLlmProviderProfileResult> => await getSettingsServiceController().setActiveLlmProviderProfile(input);
const updateLlmProviderProfileDefaults = async (input: UpdateLlmProviderProfileDefaultsInput): Promise<LlmProviderProfileMutationResult> => await getSettingsServiceController().updateLlmProviderProfileDefaults(input);
const resolveLlmProviderAuthProfile: LlmProviderAuthProfileResolver = async (provider, authProfileId) => {
  const profiles = (await listLlmProviderProfiles()).providers[provider] ?? [];
  const normalizedAuthProfileId = authProfileId === `${provider}:local-active` ? `${provider}:system` : authProfileId;
  const profile = profiles.find((entry) => entry.id === normalizedAuthProfileId && entry.provider === provider);
  if (!profile) {
    return null;
  }
  return {
    ...profile,
    active: profile.active !== false,
    connected: profile.status === 'connected',
  };
};
const withAgentDefaults = <T extends { model?: string; reasoningEffort?: CodexReasoningEffort; runtime?: AgentRuntime; runtimeRecommendations?: AgentRuntimeRecommendations }>(input: T, defaults: AgentDefaults = normalizeSettings(settings).agentDefaults): T => getSettingsServiceController().withAgentDefaults(input, defaults);

let agentToolSettings: AgentToolSettings = createInitialAgentToolSettings();

let forgerMcpServer: ForgerMcpServer | null = null;

const mainUtilitiesState = { get agentToolSettings() { return agentToolSettings; }, set agentToolSettings(value) { agentToolSettings = value; }, get catalogApps() { return catalogApps; }, set catalogApps(value) { catalogApps = value; }, get desktopUpdater() { return desktopUpdater; }, set desktopUpdater(value) { desktopUpdater = value; }, get forgerAccount() { return forgerAccount; }, set forgerAccount(value) { forgerAccount = value; }, get settings() { return settings; }, set settings(value) { settings = value; } };
const getMainWindow = (): BrowserWindow | null => mainWindow;
const createMainUtilitiesDeps = () => ({ AGENT_TOOL_DEFINITIONS, AGENT_TOOL_IDS, APP_FOLDER_GRANT_TTL_MS, Buffer, Date, DesktopUpdater, IPC_CHANNELS, app, appFolderGrantSecret, appWindows, buildFailureDiagnostic, cloudDeviceManager, createHmac, desktopErrorReporter, forgerAccountStore, friendChatWindows, fs, getAgentToolSettingsPath, getForgerMetadataRoot, getInstallLogPath, installProgressByPhase, isDev, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getMainWindow, path, publicForgerAccount, registry, runningApps, state: mainUtilitiesState });
const getMainUtilitiesController = () => createMainUtilitiesController(createMainUtilitiesDeps());
const CommandFailedError = getMainUtilitiesController().CommandFailedError;
const truncateForInstallLog = (value: string): string => getMainUtilitiesController().truncateForInstallLog(value);
const serializeErrorForInstallLog = (error: unknown): Record<string, unknown> => getMainUtilitiesController().serializeErrorForInstallLog(error);
const signAppFolderGrant = (appId: string, folderPath: string): AppExternalFolderSelection => getMainUtilitiesController().signAppFolderGrant(appId, folderPath);
const verifyAppFolderGrant = (appId: string, grantToken: string): { path: string; expiresAt: string } | null => getMainUtilitiesController().verifyAppFolderGrant(appId, grantToken);
const resolveAppIdForWebContents = (webContentsId: number): string | null => getMainUtilitiesController().resolveAppIdForWebContents(webContentsId);
const appendInstallLog = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => await getMainUtilitiesController().appendInstallLog(event, payload);
const getAudioRuntimeBroker = (): AudioRuntimeBroker => {
  audioRuntimeBroker ??= new AudioRuntimeBroker({
    IPC_CHANNELS,
    appendInstallLog,
    getMainWindow,
    ipcMain,
  });
  audioRuntimeBroker.registerIpcHandlers();
  return audioRuntimeBroker;
};
const loadAgentToolSettings = async (): Promise<void> => await getMainUtilitiesController().loadAgentToolSettings();
const updateAgentToolApproval = async (input: UpdateAgentToolApprovalInput): Promise<AgentToolSettings> => await getMainUtilitiesController().updateAgentToolApproval(input);
const getBundledResourcesRoot = (): string => getMainUtilitiesController().getBundledResourcesRoot();
const stripArchiveExtension = (fileName: string): string => getMainUtilitiesController().stripArchiveExtension(fileName);
const runtimePlatformTokens = (platformAlias: string): string[] => getMainUtilitiesController().runtimePlatformTokens(platformAlias);
const findRuntimeArchive = async (runtimeVersionDir: string, platformAlias: string): Promise<string | null> => await getMainUtilitiesController().findRuntimeArchive(runtimeVersionDir, platformAlias);
const findRuntimeChecksumFile = async (runtimeVersionDir: string, archivePath: string, platformAlias: string): Promise<string | null> => await getMainUtilitiesController().findRuntimeChecksumFile(runtimeVersionDir, archivePath, platformAlias);
const runtimeError = (message: string, technicalCode: string, phase: InstallAppResult['phase'] = 'failed'): InstallAppResult => getMainUtilitiesController().runtimeError(message, technicalCode, phase);
const failureDiagnostic = (error: unknown, fallbackCode: string): FailureDiagnosticFields =>
  getMainUtilitiesController().failureDiagnostic(error, fallbackCode) as FailureDiagnosticFields;
const emitInstallProgress = (appId: string, payload: InstallAppResult): void => getMainUtilitiesController().emitInstallProgress(appId, payload);
const emitRuntimeStatus = (payload: RuntimeStatus): void => getMainUtilitiesController().emitRuntimeStatus(payload);
const emitOfficialToolEvent = (payload: OfficialToolRuntimeEvent): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.officialToolEvent, payload);
};
const buildChatRunIpcTracePayload = (run: ChatRun): Record<string, unknown> => getMainUtilitiesController().buildChatRunIpcTracePayload(run);
const sanitizeRendererChatTrace = (input: RendererChatTraceEvent): Record<string, unknown> => getMainUtilitiesController().sanitizeRendererChatTrace(input);
const emitChatRunUpdated = (payload: ChatRunEvent): void => getMainUtilitiesController().emitChatRunUpdated(payload);
const emitAutomationUpdated = (payload: { automation: unknown; run?: unknown }): void => getMainUtilitiesController().emitAutomationUpdated(payload);
const emitWorkflowUpdated = (payload: { workflow: unknown; run?: unknown }): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(IPC_CHANNELS.workflowUpdated, payload);
};
const emitBackgroundTaskUpdated = (payload: { task: BackgroundTask }): void => getMainUtilitiesController().emitBackgroundTaskUpdated(payload);
const emitDesktopUpdateProgress = (payload: DesktopUpdateState): void => getMainUtilitiesController().emitDesktopUpdateProgress(payload);
const emitForgerAccountUpdated = (payload: ReturnType<typeof publicForgerAccount> & { success?: boolean; userMessage?: string; technicalCode?: string }): void => getMainUtilitiesController().emitForgerAccountUpdated(payload);
const closeFriendChatWindows = (): void => getMainUtilitiesController().closeFriendChatWindows();
const switchForgerAccountSession = async (account: StoredForgerAccount, result: { userMessage?: string; technicalCode?: string } = {}): Promise<ReturnType<typeof publicForgerAccount>> => await getMainUtilitiesController().switchForgerAccountSession(account, result);
const clearForgerAccountSession = async (technicalCode: string): Promise<void> => await getMainUtilitiesController().clearForgerAccountSession(technicalCode);
const getDesktopUpdater = (): DesktopUpdater => getMainUtilitiesController().getDesktopUpdater();
const toAppSummary = (record: InstalledAppRecord): AppSummary => getMainUtilitiesController().toAppSummary(record);
const parseVersionParts = (value?: string): number[] | null => getMainUtilitiesController().parseVersionParts(value);
const isVersionNewer = (candidate?: string, current?: string): boolean => getMainUtilitiesController().isVersionNewer(candidate, current);
const mapBackendCategory = (backendCategory: string): AppCategory => getMainUtilitiesController().mapBackendCategory(backendCategory);
const toCatalogStatus = (slug: string): AppStatus => getMainUtilitiesController().toCatalogStatus(slug);

const manifestSupportState = { get secretsStore() { return secretsStore; }, set secretsStore(value) { secretsStore = value; }, get officialToolsService() { return officialToolsService; }, set officialToolsService(value) { officialToolsService = value; }, get connectionsService() { return connectionsService; }, set connectionsService(value) { connectionsService = value; }, get memoryStore() { return memoryStore; }, set memoryStore(value) { memoryStore = value; }, get backupsManager() { return backupsManager; }, set backupsManager(value) { backupsManager = value; } };
const createManifestSupportDeps = () => ({
  BackupsManager,
  BUILT_IN_CLAUDE_EFFORT,
  BUILT_IN_CODEX_REASONING,
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_VALUES,
  MemoryStore,
  OfficialToolsService,
  ConnectionsService,
  SecretsStore,
  appendInstallLog,
  app,
  canUseCloudDataSync,
  catalogApps,
  cloudSyncSettings,
  extractArchive,
  emitOfficialToolEvent,
  forgerAccount,
  forgerBackendClient,
  getForgerAccount: () => forgerAccount,
  getForgerBackendClient: () => forgerBackendClient,
  getRegistry: () => registry,
  fs,
  getBackupsRoot,
  getCloudIdentityStore,
  getCodexDefaults,
  getForgerMetadataRoot,
  getFreePort,
  getSelfOAuthCallbackService,
  getPromptOverridesStore,
  getTempRoot,
  hashFileSha256,
  normalizeClaudeEffort,
  normalizeCodexReasoningEffort,
  normalizeSettings,
  path,
  registry,
  renderManifestAgentPrompt,
  runningApps,
  settings,
  shell,
  state: manifestSupportState,
  validateArchiveEntries,
  withAgentDefaults,
  zipDirectory,
});
const getManifestSupportController = () => createManifestSupportController(createManifestSupportDeps());
const normalizeToken = (value: string | undefined): string => getManifestSupportController().normalizeToken(value);
const ensurePathInside = (rootPath: string, targetPath: string): boolean => getManifestSupportController().ensurePathInside(rootPath, targetPath);
const toPosixRelativePath = (value: string): string => getManifestSupportController().toPosixRelativePath(value);
const resolveInstalledManifest = async (installDir: string): Promise<AppManifest | null> => await getManifestSupportController().resolveInstalledManifest(installDir);
const manifestAllowsAgentNetworkAccess = (manifest: AppManifest | null): boolean => getManifestSupportController().manifestAllowsAgentNetworkAccess(manifest);
const appAllowsAgentNetworkAccess = async (appId: string): Promise<boolean> => await getManifestSupportController().appAllowsAgentNetworkAccess(appId);
const anyAppAllowsAgentNetworkAccess = async (appIds: string[]): Promise<boolean> => await getManifestSupportController().anyAppAllowsAgentNetworkAccess(appIds);
const getSecretsStore = (): SecretsStore => getManifestSupportController().getSecretsStore();
const getOfficialToolsService = (): OfficialToolsService => getManifestSupportController().getOfficialToolsService();
const getConnectionsService = (): ConnectionsService => getManifestSupportController().getConnectionsService();
const getSelfOAuthCallbackService = (): SelfOAuthCallbackService => {
  selfOAuthCallbackService ??= new SelfOAuthCallbackService({
    metadataRoot: getForgerMetadataRoot(),
    appendLog: appendInstallLog,
  });
  return selfOAuthCallbackService;
};
const getSpeechToTextServiceSourcePath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'speech-to-text', 'server.py')
    : path.join(app.getAppPath(), 'resources', 'speech-to-text', 'server.py');
const getSpeechToTextService = (): SpeechToTextServiceManager => {
  speechToTextService ??= new SpeechToTextServiceManager({
    appendInstallLog,
    ensureRuntimeInstalled,
    fs,
    getFreePort,
    getMetadataRoot: getForgerMetadataRoot,
    getPrivateAppsRoot,
    getPrivateDataRoot,
    getServiceSourcePath: getSpeechToTextServiceSourcePath,
    path,
    runCommand,
  });
  return speechToTextService;
};
const getLiveVoiceInputService = (): LiveVoiceInputServiceManager => {
  liveVoiceInputService ??= new LiveVoiceInputServiceManager({
    appendInstallLog,
    fs,
    getMetadataRoot: getForgerMetadataRoot,
    getSpeechToTextState: async () => await getSpeechToTextService().getState(),
    createSpeechRealtimeSession: async () => await getSpeechToTextService().createRealtimeSession(),
    onForgerWakeDetected: (event) => {
      mainWindow?.webContents.send(IPC_CHANNELS.liveVoiceInputForgerWake, event);
    },
    path,
  });
  return liveVoiceInputService;
};
const getWakeWordServiceSourcePath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'wake-word', 'server.py')
    : path.join(app.getAppPath(), 'resources', 'wake-word', 'server.py');
const getWakeWordService = (): WakeWordServiceManager => {
  wakeWordService ??= new WakeWordServiceManager({
    appendInstallLog,
    ensureRuntimeInstalled,
    fs,
    getFreePort,
    getMetadataRoot: getForgerMetadataRoot,
    getServiceSourcePath: getWakeWordServiceSourcePath,
    onWakeDetected: (event) => {
      mainWindow?.webContents.send(IPC_CHANNELS.wakeWordDetected, event);
    },
    path,
    runCommand,
  });
  return wakeWordService;
};
const getTextToSpeechServiceSourcePath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'text-to-speech', 'server.py')
    : path.join(app.getAppPath(), 'resources', 'text-to-speech', 'server.py');
const getTextToSpeechService = (): TextToSpeechServiceManager => {
  textToSpeechService ??= new TextToSpeechServiceManager({
    appendInstallLog,
    ensureRuntimeInstalled,
    fs,
    getFreePort,
    getMetadataRoot: getForgerMetadataRoot,
    getPrivateDataRoot,
    getServiceSourcePath: getTextToSpeechServiceSourcePath,
    path,
    runCommand,
  });
  return textToSpeechService;
};
const getMemoryStore = (): MemoryStore => getManifestSupportController().getMemoryStore();
const getPersonalAgentStore = (): AgentStore => {
  if (!personalAgentStore) {
    personalAgentStore = new AgentStore({
      metadataRoot: getForgerMetadataRoot(),
      forgerHomeRoot: getForgerHomeRoot(),
    });
  }
  return personalAgentStore;
};
const emitPersonalAgentConversationEvent = (event: PersonalAgentConversationEvent): void => {
  void (async () => {
    const agent = await getPersonalAgentStore().getAgent(event.conversation.agentId).catch(() => null);
    llmRunsStore.recordPersonalAgentConversationEvent(event, { agentName: agent?.name });
  })();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.personalAgentConversationEvent, event);
  }
};
const getPersonalAgentConversationManager = (): AgentConversationManager => {
  if (!personalAgentConversationManager) {
    personalAgentConversationManager = new AgentConversationManager({
      store: getPersonalAgentStore(),
      metadataRoot: getForgerMetadataRoot(),
      codexHome: getCodexHome(),
      providerProfilesRoot: getProviderProfilesRoot(),
      resolveAuthProfile: resolveLlmProviderAuthProfile,
      getAgentRuntime: chooseAgentRuntime,
      getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
      getClaudeCliPath: async () => (await resolveClaudeCli())?.path ?? null,
      getAntigravityCliPath: resolveAntigravityCliPath,
      getCodexPathEntries: async () => await getAgentPathEntries(),
      ensureGitAvailable,
      getCodexEnvironment: async () => await getCodexToolEnvironment(),
      getCodexAuthenticated: async () => (await getCodexAuthStatus()).authenticated,
      getClaudeAuthenticated: getClaudeConnectedForForger,
      getAntigravityAuthenticated: async () => (await getAntigravityAuthStatus()).authenticated,
      createForgerMcpSession: (runId, agent, context) =>
        forgerMcpServer?.createSession(runId, 'forger', {
          caller: 'personal-agent',
          personalAgentId: agent.id,
          personalAgentConversationId: context.conversationId,
          personalAgentPeerThreadId: context.peerThreadId,
          personalAgentCallStackIds: context.callStackAgentIds,
          appIds: agent.appIds,
          officialToolActionIds: agent.toolIds,
          forgerToolActionIds: agent.toolIds,
          connectionGrants: agent.connectionGrants,
        }) ?? null,
      releaseForgerMcpSession: (token) => forgerMcpServer?.releaseSession(token),
      listenAppMcps: async (appIds, runId) => {
        const installedAppIds = appIds.filter((appId) => Boolean(registry.apps[appId]));
        return await (appMcpManager?.listenMcps(installedAppIds, runId) ?? Promise.resolve([]));
      },
      resolveAppTrustedRoots: async (appIds) =>
        appIds
          .map((appId) => registry.apps[appId]?.installDir)
          .filter((installDir): installDir is string => Boolean(installDir)),
      releaseAppMcps: (runId) => {
        appMcpManager?.releaseMcps(runId);
      },
      onConversationEvent: emitPersonalAgentConversationEvent,
    });
  }
  return personalAgentConversationManager;
};
const getPersonalAgentRoutineManager = (): AgentRoutineManager => {
  if (!personalAgentRoutineManager) {
    personalAgentRoutineManager = new AgentRoutineManager({
      store: getPersonalAgentStore(),
      conversationManager: getPersonalAgentConversationManager(),
      onConversationEvent: emitPersonalAgentConversationEvent,
    });
  }
  return personalAgentRoutineManager;
};
const getRemoteAgentSessionService = (): RemoteAgentSessionService => {
  if (!remoteAgentSessionService) {
    remoteAgentSessionService = new RemoteAgentSessionService({
      store: getPersonalAgentStore(),
      conversationManager: getPersonalAgentConversationManager(),
      appendInstallLog,
      onStatusChanged: ({ agentId, agentName, status, requesterMobileDevice }) => {
        remoteActivityStore.recordAgentStatus({ agentId, agentName, status, requesterMobileDevice });
      },
      onSessionClosed: async ({ agentId, requestIds, status }) => {
        await Promise.all(requestIds.map(async (requestId) => {
          try {
            await forgerBackendClient?.reportAgentAccessRequest({
              requestId,
              agentId,
              status: 'closed',
              agentStatus: status,
              technicalCode: 'desktop_session_closed',
            });
            await appendInstallLog('agent_access:cloud_report_success', {
              requestId,
              agentId,
              status: 'closed',
            });
          } catch (error) {
            await appendInstallLog('agent_access:cloud_report_failed', {
              requestId,
              agentId,
              status: 'closed',
              technicalCode: error instanceof Error ? error.message : 'agent_access_request_report_failed',
            });
          }
        }));
      },
    });
  }
  return remoteAgentSessionService;
};
const getPersonalAgentHeartbeat = async () => ({
  ...(await getPersonalAgentStore().getHeartbeatSummary()),
  activeSessionRequestIds: remoteAgentSessionService?.activeSessionRequestIds() ?? [],
});
const getBackgroundTaskStore = (): BackgroundTaskStore => {
  if (!backgroundTaskStore) {
    backgroundTaskStore = new BackgroundTaskStore(getForgerMetadataRoot(), {
      onUpdated: (task) => emitBackgroundTaskUpdated({ task }),
    });
  }
  return backgroundTaskStore;
};
const buildMemoryContextForApps = async (appIds: string[]): Promise<string> => await getManifestSupportController().buildMemoryContextForApps(appIds);
const buildMemoryContextForApp = async (appId: string): Promise<string> => await getManifestSupportController().buildMemoryContextForApp(appId);
const buildForgerToolsContextForApp = async (appId: string): Promise<string> => await getManifestSupportController().buildForgerToolsContextForApp(appId);
const buildForgerToolsContextForFreeChat = async (): Promise<string> => await getManifestSupportController().buildForgerToolsContextForFreeChat();
const getBackupsManager = (): BackupsManager => getManifestSupportController().getBackupsManager();
const createRemoteAppBackup = async (input: CreateRemoteAppBackupInput): Promise<CreateRemoteAppBackupResult> => await getManifestSupportController().createRemoteAppBackup(input);
const restoreRemoteAppBackup = async (remoteBackupId: number): Promise<BasicActionResult> => await getManifestSupportController().restoreRemoteAppBackup(remoteBackupId);
const syncAppToCloudIfEnabled = async (appId: string): Promise<void> => await getManifestSupportController().syncAppToCloudIfEnabled(appId);
const isReservedAppSecretEnvName = (envName: string): boolean => getManifestSupportController().isReservedAppSecretEnvName(envName);
const normalizeAppSecretDeclaration = (value: unknown): AppSecretDeclaration | null => getManifestSupportController().normalizeAppSecretDeclaration(value);
const normalizeManifestAppSecrets = (manifest: AppManifest | null): AppSecretDeclaration[] => getManifestSupportController().normalizeManifestAppSecrets(manifest);
const resolveAppToolDeclarations = async (...args: unknown[]) => await (getManifestSupportController().resolveAppToolDeclarations as (...input: unknown[]) => Promise<unknown>)(...args);
const normalizeManifestPromptTemplates = (manifest: AppManifest | null): AppPromptTemplate[] => getManifestSupportController().normalizeManifestPromptTemplates(manifest);
const normalizeManifestAgents = (manifest: AppManifest | null): AppAgent[] => getManifestSupportController().normalizeManifestAgents(manifest);
const normalizeManifestAgentKind = (value: unknown): AppAgent['kind'] => getManifestSupportController().normalizeManifestAgentKind(value);
const normalizeManifestAgentPrompts = (value: unknown): AppAgentPromptSet | undefined => getManifestSupportController().normalizeManifestAgentPrompts(value);
const normalizeManifestAgentPromptTemplate = (value: unknown): AppAgentPromptTemplate | undefined => getManifestSupportController().normalizeManifestAgentPromptTemplate(value);
const normalizeManifestAgentPromptVariables = (value: unknown): Record<string, AppAgentPromptVariable> => getManifestSupportController().normalizeManifestAgentPromptVariables(value);
const isAppAgentPromptVariableType = (value: unknown): value is AppAgentPromptVariableType => getManifestSupportController().isAppAgentPromptVariableType(value);
const normalizeManifestReasoningEffort = (value: unknown): CodexReasoningEffort | undefined => getManifestSupportController().normalizeManifestReasoningEffort(value);
const normalizeManifestAgentDefaults = (manifest: AppManifest | null): AgentDefaults => getManifestSupportController().normalizeManifestAgentDefaults(manifest);
const normalizeManifestRuntime = (value: unknown): AgentRuntime | undefined => getManifestSupportController().normalizeManifestRuntime(value);
const normalizePromptTemplateArguments = (input: unknown): NonNullable<AppPromptTemplate['arguments']> => getManifestSupportController().normalizePromptTemplateArguments(input);
const resolveInstalledPromptTemplates = async (appId: string): Promise<AppPromptTemplate[]> => await getManifestSupportController().resolveInstalledPromptTemplates(appId);
const resolveInstalledAgents = async (appId: string): Promise<AppAgent[]> => await getManifestSupportController().resolveInstalledAgents(appId);
const hasInstalledCodexConversation = async (appId: string): Promise<boolean> => await getManifestSupportController().hasInstalledCodexConversation(appId);
const resolveInstalledPromptBases = async (appId: string) => await getManifestSupportController().resolveInstalledPromptBases(appId);
const listAppPrompts = async (appId: string): Promise<AppPromptReviewItem[]> => await getManifestSupportController().listAppPrompts(appId);
const validateAppPrompt = async (input: AppPromptReviewInput): Promise<AppPromptValidationResult> => await getManifestSupportController().validateAppPrompt(input);
const testAppPrompt = async (input: AppPromptTestInput): Promise<AppPromptTestResult> => await getManifestSupportController().testAppPrompt(input);
const updateAppPrompt = async (input: AppPromptReviewInput): Promise<AppPromptMutationResult> => await getManifestSupportController().updateAppPrompt(input);
const restoreAppPrompt = async (input: AppPromptRestoreInput): Promise<AppPromptMutationResult> => await getManifestSupportController().restoreAppPrompt(input);
const getManifestAppSecretsValidationError = (manifest: AppManifest | null): string | null => getManifestSupportController().getManifestAppSecretsValidationError(manifest);
const resolveInstalledAppSecrets = async (appId: string): Promise<AppSecretDeclaration[]> => await getManifestSupportController().resolveInstalledAppSecrets(appId);
const buildAppSecretsState = async (appId: string): Promise<AppSecretsState> => await getManifestSupportController().buildAppSecretsState(appId);
const formatProcessOutputForInstallLog = (value: string, secretValues: string[]): string => getManifestSupportController().formatProcessOutputForInstallLog(value, secretValues);

const createAppContextSupportDeps = () => ({
  appLifecycleLocks,
  catalogApps,
  fileLibraryState: {
    get current() { return fileLibrary; },
    set current(value) { fileLibrary = value; },
  },
  forgerBackendClient,
  fs,
  getForgerMetadataRoot,
  getPrivateDataRoot,
  mapBackendCategory,
  path,
  registry,
  resolveAppToolDeclarations,
  toCatalogStatus,
});
const getAppContextSupportController = () => createAppContextSupportController(createAppContextSupportDeps());
const hasValidManifestStack = (manifest: AppManifest | null): manifest is AppManifest & { stack: AppManifestStack } => getAppContextSupportController().hasValidManifestStack(manifest);
const ensureGlobalAgentsContext = async (forgerHomeRoot: string): Promise<void> => await getAppContextSupportController().ensureGlobalAgentsContext(forgerHomeRoot);
const shouldWriteAppAgentsMarkdown = async (agentsPath: string): Promise<boolean> => await getAppContextSupportController().shouldWriteAppAgentsMarkdown(agentsPath);
const buildStackSkillTemplates = (stack: AppManifestStack, hasAppMcp = false): StackSkillTemplate[] => getAppContextSupportController().buildStackSkillTemplates(stack, hasAppMcp);
const writeSkillTemplates = async (skillsRoot: string, templates: StackSkillTemplate[]): Promise<void> => await getAppContextSupportController().writeSkillTemplates(skillsRoot, templates);
const copyDirectory = async (sourceDir: string, targetDir: string): Promise<void> => await getAppContextSupportController().copyDirectory(sourceDir, targetDir);
const writeStackSkills = async (skillsRoot: string, stack: AppManifestStack, hasAppMcp = false): Promise<void> => await getAppContextSupportController().writeStackSkills(skillsRoot, stack, hasAppMcp);
const copyAppSkills = async (installDir: string, skillsRoot: string, manifest: AppManifest): Promise<void> => await getAppContextSupportController().copyAppSkills(installDir, skillsRoot, manifest);
const normalizeInstalledAgentContext = async (installDir: string, appId: string): Promise<void> => await getAppContextSupportController().normalizeInstalledAgentContext(installDir, appId);
const resolveSelectedAppDisplayName = (appId: string): string => getAppContextSupportController().resolveSelectedAppDisplayName(appId);
const getFileLibrary = (): FileLibrary => getAppContextSupportController().getFileLibrary();
const withAppLifecycleLock = async <T>(appId: string, operation: () => Promise<T>): Promise<T> => await getAppContextSupportController().withAppLifecycleLock(appId, operation);
const listCatalogFromBackend = async (): Promise<CatalogApp[]> => await getAppContextSupportController().listCatalogFromBackend();

const createRegistryStoreDeps = () => ({
  DEFAULT_PYTHON_VERSION,
  DEFAULT_NODE_VERSION,
  DevCatalogService,
  app,
  appendInstallLog,
  catalogApps,
  cloudSyncSettings,
  emitRuntimeStatus,
  forgerAccount,
  fs,
  getCloudSyncSettingsPath,
  getPrivateAppsRoot,
  getRegistryBackupPath,
  getRegistryPath,
  isDev,
  isVersionNewer,
  localCatalogJsonUrl,
  setCatalogApps: (value: CatalogApp[]) => {
    catalogApps = value;
  },
  setCloudSyncSettings: (value: CloudSyncSettings) => {
    Object.assign(cloudSyncSettings, value);
  },
  setDevCatalogService: (value: DevCatalogService | null) => {
    devCatalogService = value;
  },
  setLocalCatalogJsonUrl: (value: string | undefined) => {
    localCatalogJsonUrl = value;
  },
  setRegistry: (value: AppRegistry) => {
    registry = value;
  },
  normalizeNodeRuntimeVersion,
  normalizeVersionForFolder,
  path,
  registry,
  runningApps,
  serializeErrorForInstallLog,
  settings,
});
const getRegistryStoreController = () => createRegistryStoreController(createRegistryStoreDeps());
const startDevCatalogService = async (): Promise<void> => await getRegistryStoreController().startDevCatalogService();
const parseRegistry = (raw: string): AppRegistry | null => getRegistryStoreController().parseRegistry(raw);
const normalizeInstalledAppRecord = (record: InstalledAppRecord): InstalledAppRecord => getRegistryStoreController().normalizeInstalledAppRecord(record);
const normalizeRegistryRuntimeVersions = (input: AppRegistry): { registry: AppRegistry; changed: boolean } => getRegistryStoreController().normalizeRegistryRuntimeVersions(input);
const loadRegistryFile = async (registryPath: string): Promise<AppRegistry | null> => await getRegistryStoreController().loadRegistryFile(registryPath);
const syncDirectory = async (directoryPath: string): Promise<void> => await getRegistryStoreController().syncDirectory(directoryPath);
const loadRegistry = async (): Promise<void> => await getRegistryStoreController().loadRegistry();
const saveRegistry = async (): Promise<void> => await getRegistryStoreController().saveRegistry();
const loadCloudSyncSettings = async (): Promise<void> => await getRegistryStoreController().loadCloudSyncSettings();
const saveCloudSyncSettings = async (): Promise<void> => await getRegistryStoreController().saveCloudSyncSettings();
const setAppAutoSyncSetting = async (appId: string, autoSync: boolean): Promise<CloudSyncSettings> => await getRegistryStoreController().setAppAutoSyncSetting(appId, autoSync);
const canUseCloudDataSync = (): boolean => getRegistryStoreController().canUseCloudDataSync();
const upsertInstalledRecord = async (record: InstalledAppRecord): Promise<void> => await getRegistryStoreController().upsertInstalledRecord(record);
const removeInstalledRecord = async (appId: string): Promise<void> => await getRegistryStoreController().removeInstalledRecord(appId);
const ensureCatalogStatuses = (): void => getRegistryStoreController().ensureCatalogStatuses();

const createCommandGitDeps = () => ({
  BUNDLED_GIT_VERSION,
  appendInstallLog,
  app,
  createHash,
  findRuntimeArchive,
  findRuntimeChecksumFile,
  fs,
  getBundledResourcesRoot,
  getRuntimesRoot,
  getTempRoot,
  normalizeVersionForFolder,
  path,
  resolvePlatformAlias,
  runtimePlatformTokens,
  serializeErrorForInstallLog,
  spawn: spawnProcess,
  stripArchiveExtension,
  syncDirectory,
  truncateForInstallLog,
  yauzl,
});
const getCommandGitController = () => createCommandGitController(createCommandGitDeps());
const hashFileSha256 = async (filePath: string): Promise<string> => await getCommandGitController().hashFileSha256(filePath);
const runCommand = async (command: string, args: string[], options: Record<string, unknown> & { cwd: string }): Promise<void> => await getCommandGitController().runCommand(command, args, options);
const runCommandCapture = async (command: string, args: string[], options: Record<string, unknown> & { cwd: string }): Promise<{ stdout: string; stderr: string; code?: number | null }> => await getCommandGitController().runCommandCapture(command, args, options);
const zipDirectory = async (sourceDir: string, zipPath: string): Promise<void> => await getCommandGitController().zipDirectory(sourceDir, zipPath);
const canRunCommand = async (command: string, args: string[]): Promise<boolean> => await getCommandGitController().canRunCommand(command, args);
const existsFile = async (filePath: string): Promise<boolean> => await getCommandGitController().existsFile(filePath);
const appendProcessPathEntry = (entry: string): void => getCommandGitController().appendProcessPathEntry(entry);
const ensureGitAvailable = async (): Promise<void> => await getCommandGitController().ensureGitAvailable();
const ensureGitMainBranch = async (cwd: string): Promise<void> => await getCommandGitController().ensureGitMainBranch(cwd);
const ensureForgerLocalGitExcludes = async (cwd: string): Promise<void> => await getCommandGitController().ensureForgerLocalGitExcludes(cwd);
const ensureAppGitRepository = async (cwd: string): Promise<void> => await getCommandGitController().ensureAppGitRepository(cwd);
const ensureUserModifiedBranch = async (cwd: string): Promise<void> => await getCommandGitController().ensureUserModifiedBranch(cwd);
const getGitStatusLines = async (cwd: string): Promise<string[]> => await getCommandGitController().getGitStatusLines(cwd);
const getUserVisibleGitStatusLines = async (cwd: string): Promise<string[]> => await getCommandGitController().getUserVisibleGitStatusLines(cwd);
const getGitHead = async (cwd: string): Promise<string | null> => await getCommandGitController().getGitHead(cwd);
const getOriginalCommitSha = async (cwd: string): Promise<string | undefined> => await getCommandGitController().getOriginalCommitSha(cwd);
const clearMacQuarantine = async (targetPath: string): Promise<void> => await getCommandGitController().clearMacQuarantine(targetPath);
const extractArchive = async (archivePath: string, destination: string): Promise<void> => await getCommandGitController().extractArchive(archivePath, destination);
const listZipEntries = async (archivePath: string): Promise<string[]> => await getCommandGitController().listZipEntries(archivePath);
const validateArchiveEntries = async (archivePath: string): Promise<void> => await getCommandGitController().validateArchiveEntries(archivePath);
const normalizeRelativeInstallPath = (value: string): string | null => getCommandGitController().normalizeRelativeInstallPath(value);
const collectPersistentInstallPaths = (manifest: AppManifest | null): string[] => getCommandGitController().collectPersistentInstallPaths(manifest);
const gitCommitAllExcept = async (cwd: string, message: string, excludedPaths: string[]): Promise<string> => await getCommandGitController().gitCommitAllExcept(cwd, message, excludedPaths);
const copyReleaseContentsForUpdate = async (sourceDir: string, targetDir: string, preservedPaths: string[]): Promise<void> => await getCommandGitController().copyReleaseContentsForUpdate(sourceDir, targetDir, preservedPaths);
const syncReleaseIntoInstalledApp = async (sourceDir: string, targetDir: string, preservedPaths: string[]): Promise<void> => await getCommandGitController().syncReleaseIntoInstalledApp(sourceDir, targetDir, preservedPaths);

const createRuntimeInstallDeps = () => ({ DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION, appendInstallLog, app, clearMacQuarantine, extractArchive, findRuntimeArchive, findRuntimeChecksumFile, fs, getBundledResourcesRoot, getRuntimesRoot, getTempRoot, hashFileSha256, installBackendDependenciesWithUv, normalizeNodeRuntimeVersion, normalizeVersionForFolder, path, resolvePlatformAlias, runCommand, runtimeLocks });
const getRuntimeInstallController = () => createRuntimeInstallController(createRuntimeInstallDeps());
const fileExists = async (filePath: string): Promise<boolean> => await getRuntimeInstallController().fileExists(filePath);
const installFrontendDependenciesWithNpm = async (
  nodePath: string,
  npmPath: string,
  frontendDir: string,
  appId: string,
): Promise<void> =>
  await getRuntimeInstallController().installFrontendDependenciesWithNpm(nodePath, npmPath, frontendDir, appId);
const installAppDependencies = async (
  appId: string,
  installDir: string,
  nodeVersion: string,
  pythonVersion: string,
  publishProgress: (phase: InstallAppResult['phase'], userMessage: string) => Promise<void>,
  messages?: ReturnType<typeof getSharedCopy>['install'],
): Promise<void> =>
  await getRuntimeInstallController().installAppDependencies(
    appId,
    installDir,
    nodeVersion,
    pythonVersion,
    publishProgress,
    messages,
  );
const flattenSingleTopLevelDirectory = async (targetDir: string): Promise<void> => await getRuntimeInstallController().flattenSingleTopLevelDirectory(targetDir);
const findExistingFile = async (baseDir: string, candidates: string[]): Promise<string | null> => await getRuntimeInstallController().findExistingFile(baseDir, candidates);
const resolveRuntimeExecutables = async (runtimeRoot: string, type: 'node' | 'python'): Promise<RuntimeBinarySet> => await getRuntimeInstallController().resolveRuntimeExecutables(runtimeRoot, type);
const ensureRuntimeInstalled = async (type: 'node' | 'python', version: string): Promise<RuntimeBinarySet> => await getRuntimeInstallController().ensureRuntimeInstalled(type, version);

const createAgentAuthDeps = () => ({
  CLAUDE_CODE_VERSION,
  CODEX_CLI_VERSION,
  DEFAULT_NODE_VERSION,
  appendInstallLog,
  app,
  buildCodexAuthEnvironment,
  buildMacTerminalLoginScript,
  buildMacTerminalScriptLaunchCommand,
  canRunCommand,
  classifyCodexAuthOutput,
  ensureRuntimeInstalled,
  extractAllowedCodexAuthUrls,
  failureDiagnostic,
  findExistingFile,
  findManifestService,
  fs,
  getClaudeRoot,
  getAntigravityRoot,
  getCodexHome,
  getCodexRoot,
  getForgerMetadataRoot,
  getLogsRoot,
  getTempRoot,
  markProviderConnected,
  markProviderDisconnected,
  path,
  registry,
  resolveInstalledManifest,
  runCommand,
  runCommandCapture,
  serializeErrorForInstallLog,
  shell,
  spawn: spawnProcess,
  translateManifestEnvironment,
  truncateForInstallLog,
});
const getAgentAuthController = () => createAgentAuthController(createAgentAuthDeps());
const getRuntimePathEntries = (runtime: RuntimeBinarySet): string[] => getAgentAuthController().getRuntimePathEntries(runtime);
const existsDirectory = async (dir: string): Promise<boolean> => await getAgentAuthController().existsDirectory(dir);
const getAppLocalToolPathEntries = async (record: InstalledAppRecord): Promise<string[]> => await getAgentAuthController().getAppLocalToolPathEntries(record);
const getDeveloperPathService = () => createDeveloperPathService({
  defaultNodeVersion: DEFAULT_NODE_VERSION,
  ensureRuntimeInstalled,
  fs,
  getAppLocalToolPathEntries,
  getRuntimePathEntries,
  normalizeNodeRuntimeVersion,
  normalizeSettings,
  path,
  registry,
  settings: () => settings,
  systemPath: () => process.env.PATH,
  upsertInstalledRecord,
});
const getAgentPathEntries = async (appId?: string): Promise<string[]> => await getDeveloperPathService().getAgentPathEntries(appId);
const getDeveloperPathState = async (appId?: string) => await getDeveloperPathService().getDeveloperPathState(appId);
const updateAppDeveloperSettings = async (input: Parameters<ReturnType<typeof createDeveloperPathService>['updateAppDeveloperSettings']>[0]) => await getDeveloperPathService().updateAppDeveloperSettings(input);
const getCodexToolEnvironment = async (appId?: string, pythonRuntime?: RuntimeBinarySet): Promise<Record<string, string>> => await getAgentAuthController().getCodexToolEnvironment(appId, pythonRuntime);
const resolveCodexCliPath = async (baseDir: string): Promise<string | null> => await getAgentAuthController().resolveCodexCliPath(baseDir);
const getInstalledCodexCliVersion = async (baseDir: string): Promise<string | null> => await getAgentAuthController().getInstalledCodexCliVersion(baseDir);
const ensureCodexCliInstalled = async (): Promise<string> => await getAgentAuthController().ensureCodexCliInstalled();
const buildManagedCodexAuthEnvironment = async (codexCliPath: string, codexHome: string): Promise<NodeJS.ProcessEnv> => await getAgentAuthController().buildManagedCodexAuthEnvironment(codexCliPath, codexHome);
const getCodexAuthStatus = async (): Promise<CodexAuthStatus> => await getAgentAuthController().getCodexAuthStatus();
const connectCodexAuth = async (): Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields> => await getAgentAuthController().connectCodexAuth();
const disconnectCodexAuth = async (): Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields> => await getAgentAuthController().disconnectCodexAuth();
const reinstallCodex = async (): Promise<{ success: boolean; userMessage: string; status?: CodexAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().reinstallCodex();
const getClaudeAuthStatus = async (): Promise<ClaudeAuthStatus> => await getAgentAuthController().getClaudeAuthStatus();
const confirmClaudeAuthConnection = async (): Promise<{ success: boolean; userMessage: string; status: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().confirmClaudeAuthConnection();
const connectClaudeAuth = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().connectClaudeAuth();
const disconnectClaudeAuth = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().disconnectClaudeAuth();
const signOutClaudeAuth = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().signOutClaudeAuth();
const reinstallClaude = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().reinstallClaude();
const getClaudeConnectedForForger = async (): Promise<boolean> => {
  if (!normalizeSettings(settings).providerConnections.claude) {
    return false;
  }
  return (await getClaudeAuthStatus()).authenticated;
};
const getAntigravityAuthStatus = async (): Promise<AntigravityAuthStatus> => await getAgentAuthController().getAntigravityAuthStatus();
const resolveAntigravityCliPath = async (): Promise<string | null> => (await getAgentAuthController().resolveAntigravityCli())?.path ?? null;
const connectAntigravityAuth = async (): Promise<{ success: boolean; userMessage: string; status?: AntigravityAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().connectAntigravityAuth();
const startAntigravityAuthSession = async (onEvent: (event: AntigravityAuthSessionEvent) => void): Promise<AntigravityAuthSessionStartResult & FailureDiagnosticFields> => await getAgentAuthController().startAntigravityAuthSession(onEvent);
const writeAntigravityAuthSession = async (sessionId: string, input: string): Promise<{ success: boolean; userMessage?: string } & FailureDiagnosticFields> => await getAgentAuthController().writeAntigravityAuthSession(sessionId, input);
const cancelAntigravityAuthSession = async (sessionId: string): Promise<{ success: boolean; userMessage?: string } & FailureDiagnosticFields> => await getAgentAuthController().cancelAntigravityAuthSession(sessionId);
const disconnectAntigravityAuth = async (): Promise<{ success: boolean; userMessage: string; status?: AntigravityAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().disconnectAntigravityAuth();
const reinstallAntigravity = async (): Promise<{ success: boolean; userMessage: string; status?: AntigravityAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().reinstallAntigravity();

const createInstalledAppLifecycleDeps = () => ({
  DEFAULT_NODE_VERSION,
  DEFAULT_PYTHON_VERSION,
  appendInstallLog,
  app,
  backendPythonEnvironmentLocks,
  catalogApps,
  clearMacQuarantine,
  closeAppWindow,
  collectPersistentInstallPaths,
  copyAppSkills,
  copyReleaseContentsForUpdate,
  createRemoteAppBackup,
  emitInstallProgress,
  emitRuntimeStatus,
  ensureAppGitRepository,
  ensureCatalogStatuses,
  ensureGitAvailable,
  ensureGlobalAgentsContext,
  ensurePathInside,
  ensureRuntimeInstalled,
  ensureUserModifiedBranch,
  extractArchive,
  failureDiagnostic,
  flattenSingleTopLevelDirectory,
  forgerBackendClient,
  fs,
  getBackupsManager,
  getForgerHomeRoot,
  getForgerMetadataRoot,
  getGitHead,
  getInstallLogPath,
  getLegacyForgerMetadataRoot,
  getOfficialToolsService,
  getOriginalCommitSha,
  getPrivateAppsRoot,
  getRuntimeStatus,
  getLocalNetworkShareStatus,
  getTempRoot,
  getUserVisibleGitStatusLines,
  gitCommitAllExcept,
  installAppDependencies,
  installFrontendDependenciesWithNpm,
  installWelcome,
  isVersionNewer,
  listCatalogFromBackend,
  listAppPrompts,
  normalizeInstalledAgentContext,
  normalizeNodeRuntimeVersion,
  normalizeVersionForFolder,
  openInstalledAppUnlocked,
  path,
  registry,
  removeInstalledRecord,
  resolveInstalledAgents,
  resolveInstalledManifest,
  resolveInstalledPromptTemplates,
  resolvePlatformAlias,
  runCommand,
  runCommandCapture,
  runningApps,
  runtimeError,
  serializeErrorForInstallLog,
  stopInstalledApp,
  syncAppToCloudIfEnabled,
  syncReleaseIntoInstalledApp,
  toAppSummary,
  upsertInstalledRecord,
  validateArchiveEntries,
  truncateForInstallLog,
});

const getInstalledAppLifecycleController = () => createInstalledAppLifecycleController(createInstalledAppLifecycleDeps());
const fetchDownloadBundle = async (catalogApp: CatalogApp) => await getInstalledAppLifecycleController().fetchDownloadBundle(catalogApp);
const getVenvExecutables = (backendDir: string): { python: string; pip: string } => getInstalledAppLifecycleController().getVenvExecutables(backendDir);
const installBackendDependenciesWithUv = async (pythonPath: string, backendDir: string, appId: string): Promise<void> => await getInstalledAppLifecycleController().installBackendDependenciesWithUv(pythonPath, backendDir, appId);
const ensureBackendPythonEnvironment = async (pythonPath: string, backendDir: string, appId: string, reason: string): Promise<void> => await getInstalledAppLifecycleController().ensureBackendPythonEnvironment(pythonPath, backendDir, appId, reason);
const installAppRuntime = async (appId: string, localeInput?: string): Promise<InstallAppResult> => await getInstalledAppLifecycleController().installAppRuntime(appId, localeInput);
const prepareSocialAppReview = async (input: PrepareSocialAppReviewInput, localeInput?: string) => await getInstalledAppLifecycleController().prepareSocialAppReview(input, localeInput);
const finishSocialAppInstall = async (input: { quarantineId: string }, localeInput?: string): Promise<InstallAppResult & { appId?: string }> => await getInstalledAppLifecycleController().finishSocialAppInstall(input, localeInput);
const deleteQuarantinedSocialApp = async (input: { quarantineId: string }, localeInput?: string) => await getInstalledAppLifecycleController().deleteQuarantinedSocialApp(input, localeInput);
const getSocialAppReviewPromptContext = async (appId: string) => await getInstalledAppLifecycleController().getSocialAppReviewPromptContext(appId);
const installSocialAppRuntime = async (input: { appId?: number; appSlug?: string; shareCode?: string; trustDecision?: 'not_reviewed' | 'reviewed' | 'skipped_review' }, localeInput?: string): Promise<InstallAppResult & { appId?: string }> => await getInstalledAppLifecycleController().installSocialAppRuntime(input, localeInput);
const localAppCreator = createLocalAppCreator({ DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION, appendInstallLog, app, emitInstallProgress, failureDiagnostic, fs, getPrivateAppsRoot, installAppDependencies, normalizeInstalledAgentContext, path, registry, serializeErrorForInstallLog, upsertInstalledRecord, ensureAppGitRepository, ensureUserModifiedBranch, getOriginalCommitSha });
const createLocalAppFromSkeleton = async (input: CreateLocalAppInput, localeInput?: string): Promise<CreateLocalAppResult> => await localAppCreator.createLocalAppFromSkeleton(input, localeInput);
const updateAppRuntime = async (appId: string, localeInput?: string): Promise<InstallAppResult> => await getInstalledAppLifecycleController().updateAppRuntime(appId, localeInput);
const restoreAppUserVersionRuntime = async (appId: string): Promise<BasicActionResult> => await getInstalledAppLifecycleController().restoreAppUserVersionRuntime(appId);
const readOperationSummaries = async (appId: string): Promise<AppOperationSummary[]> => await getInstalledAppLifecycleController().readOperationSummaries(appId);
const readLocalChangeSummaries = async (appDir: string): Promise<AppLocalChangeSummary[]> => await getInstalledAppLifecycleController().readLocalChangeSummaries(appDir);
const getAppDetails = async (appId: string): Promise<AppDetails | null> => await getInstalledAppLifecycleController().getAppDetails(appId);
const uninstallAppRuntime = async (appId: string): Promise<BasicActionResult> => await getInstalledAppLifecycleController().uninstallAppRuntime(appId);
const installWelcome = async (appId: string, userLanguage?: string): Promise<{ success: boolean; userMessage: string; welcome?: string; technicalCode?: string }> => await getInstalledAppLifecycleController().installWelcome(appId, userLanguage);

const createInstalledAppRuntimeDeps = () => ({
  FORGER_PROTOCOL,
  app,
  appAgentConversationManager,
  appAgentTaskManager,
  appFolderGrantSecret,
  appWindows,
  appendInstallLog,
  desktopRuntimeBridge,
  getSpeechToTextEnvironment: (manifest: AppManifest | null) => {
    return getSpeechToTextService().environmentForApp(appAllowsSpeechToText(manifest?.platformCapabilities));
  },
  getTextToSpeechEnvironment: (manifest: AppManifest | null) => {
    return getTextToSpeechService().environmentForApp(appAllowsTextToSpeech(manifest?.platformCapabilities));
  },
  getAudioInputEnvironment: (manifest: AppManifest | null): Record<string, string> =>
    appAllowsAudioInput(manifest?.platformCapabilities) ? { FORGER_AUDIO_INPUT_ENABLED: '1' } : {},
  dispatchDeepLink,
  emitRuntimeStatus,
  ensureBackendPythonEnvironment,
  ensureCatalogStatuses,
  ensureRuntimeInstalled,
  failureDiagnostic,
  formatProcessOutputForInstallLog,
  friendChatWindows,
  fs,
  getBackendPathEntries: getAgentPathEntries,
  getInstallLogPath,
  getLocalNetworkShareStatus,
  getManifestAppSecretsValidationError,
  getSecretsStore,
  getVenvExecutables,
  http,
  isDev,
  isSecretsVaultUnavailableError,
  net,
  normalizeManifestAppSecrets,
  normalizeNodeRuntimeVersion,
  parseForgerUrl,
  path,
  registry,
  resolveInstalledManifest,
  runCommand,
  runningApps,
  serializeErrorForInstallLog,
  shell,
  stoppingApps,
  stopLocalNetworkShare,
  stopRemoteNetworkShare,
  syncAppToCloudIfEnabled,
  truncateForInstallLog,
  upsertInstalledRecord,
  wait,
  withAppLifecycleLock,
});

const getInstalledAppRuntimeController = () => createInstalledAppRuntimeController(createInstalledAppRuntimeDeps());
const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => await getInstalledAppRuntimeController().waitForHttpOk(url, timeoutMs);
const getFreePort = async (): Promise<number> => await getInstalledAppRuntimeController().getFreePort();
const fetchBodyFromBuffer = (body: Buffer): ArrayBuffer => getInstalledAppRuntimeController().fetchBodyFromBuffer(body);
const closeServer = async (server: http.Server): Promise<void> => await getInstalledAppRuntimeController().closeServer(server);
const terminateProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => await getInstalledAppRuntimeController().terminateProcess(child);
const closeAppWindow = (appId: string): void => getInstalledAppRuntimeController().closeAppWindow(appId);
const loadDesktopWindow = async (window: BrowserWindow, query: Record<string, string> = {}): Promise<void> => await getInstalledAppRuntimeController().loadDesktopWindow(window, query);
const openOrFocusAppWindow = async (appId: string, appName: string, frontendUrl: string, locale?: string): Promise<void> => await getInstalledAppRuntimeController().openOrFocusAppWindow(appId, appName, frontendUrl, locale);
const openOrFocusFriendChatWindowForFriend = async (friend: CloudFriendUser): Promise<FriendChatWindowOpenResult> => await getInstalledAppRuntimeController().openOrFocusFriendChatWindowForFriend(friend);
const openOrFocusFriendChatWindow = async (friendship: CloudFriendship): Promise<FriendChatWindowOpenResult> => await getInstalledAppRuntimeController().openOrFocusFriendChatWindow(friendship);
const findManifestService = (manifest: AppManifest | null, name: string, fallbackContext: string): AppManifestService | null => getInstalledAppRuntimeController().findManifestService(manifest, name, fallbackContext);
const splitManifestCommand = (command: string | undefined): string[] => getInstalledAppRuntimeController().splitManifestCommand(command);
const translateManifestEnvironment = (environment: Record<string, string>, backendDir: string): Record<string, string> => getInstalledAppRuntimeController().translateManifestEnvironment(environment, backendDir);
const ensureSqliteDatabaseParent = async (environment: Record<string, string>): Promise<void> => await getInstalledAppRuntimeController().ensureSqliteDatabaseParent(environment);
const openInstalledAppUnlocked = async (appId: string, locale?: string, options: { openWindow?: boolean } = {}): Promise<OpenAppResult> => await getInstalledAppRuntimeController().openInstalledAppUnlocked(appId, locale, options);
const openInstalledApp = async (appId: string, locale?: string): Promise<OpenAppResult> => await getInstalledAppRuntimeController().openInstalledApp(appId, locale);
const stopInstalledApp = async (appId: string): Promise<StopAppResult> => await getInstalledAppRuntimeController().stopInstalledApp(appId);
const restartInstalledApp = async (appId: string, options: { onProgress?: (message: string) => void } = {}): Promise<OpenAppResult> => await getInstalledAppRuntimeController().restartInstalledApp(appId, options);
const getRuntimeStatus = (appId: string): RuntimeStatus => getInstalledAppRuntimeController().getRuntimeStatus(appId);
const appActivityName = (appId: string): string => registry.apps[appId]?.name ?? appId;
const recordRemoteCloudActivity = (event: { kind: 'app' | 'agent'; targetId: string; targetName?: string; state: 'preparing' | 'active' | 'error' | 'closed'; requesterMobileDevice?: { id: number; name: string; platform?: string }; technicalCode?: string }): void => {
  remoteActivityStore.recordRequest({
    id: `${event.kind}:${event.targetId}`,
    kind: event.kind,
    targetId: event.targetId,
    targetName: event.targetName ?? (event.kind === 'app' ? appActivityName(event.targetId) : event.targetId),
    state: event.state,
    ...(event.requesterMobileDevice ? { requesterMobileDevice: event.requesterMobileDevice } : {}),
    ...(event.technicalCode ? { lastError: event.technicalCode } : {}),
  });
};
const getRemoteActivitySnapshot = () => remoteActivityStore.snapshot();
const getLlmRunsSnapshot = () => llmRunsStore.snapshot();

const localNetworkShareController = createLocalNetworkShareController({
  runningApps,
  openInstalledApp: openInstalledAppUnlocked,
  appendInstallLog,
  getRuntimeStatus,
  emitRuntimeStatus,
});

const remoteNetworkShareManager = new RemoteNetworkShareManager({
  runningApps,
  openInstalledApp: openInstalledAppUnlocked,
  resolveInstalledManifest: async (appId) => {
    const installDir = registry.apps[appId]?.installDir;
    return installDir ? await resolveInstalledManifest(installDir) : null;
  },
  backendBaseUrl,
  backendClient: () => forgerBackendClient,
  getCurrentDeviceId: async () => {
    const state = await cloudDeviceManager?.getState?.();
    return state?.currentDevice?.id;
  },
  installDirForApp: (appId: string) => registry.apps[appId]?.installDir,
  ensureRuntimeInstalled,
  normalizeNodeRuntimeVersion,
  requiredNodeVersionForApp: (appId: string) => registry.apps[appId]?.requiredNodeVersion,
  appendInstallLog,
  emitRuntimeStatus: (appId, remoteNetworkShare) => emitRuntimeStatus({ ...getRuntimeStatus(appId), remoteNetworkShare }),
  onStatusChanged: (status) => {
    remoteActivityStore.recordAppStatus({
      appId: status.appId,
      appName: appActivityName(status.appId),
      status,
    });
  },
});

function getLocalNetworkShareStatus(appId: string): ReturnType<typeof localNetworkShareController.getStatus> {
  return localNetworkShareController.getStatus(appId);
}

async function startLocalNetworkShare(appId: string): ReturnType<typeof localNetworkShareController.start> {
  const installDir = registry.apps[appId]?.installDir; const manifest = installDir ? await resolveInstalledManifest(installDir) : null;
  if (manifest?.localNetworkShare !== true) {
    return { success: false, userMessage: 'Esta app no soporta red local.', technicalCode: 'local_network_share_not_supported', status: { active: false, appId } };
  }
  return await localNetworkShareController.start(appId);
}

async function stopLocalNetworkShare(appId: string): ReturnType<typeof localNetworkShareController.stop> {
  return await localNetworkShareController.stop(appId);
}

function getRemoteNetworkShareStatus(appId: string): ReturnType<typeof remoteNetworkShareManager.status> {
  return remoteNetworkShareManager.status(appId);
}

async function startRemoteNetworkShare(appId: string): ReturnType<typeof remoteNetworkShareManager.start> {
  return await remoteNetworkShareManager.start(appId);
}

async function stopRemoteNetworkShare(appId: string): ReturnType<typeof remoteNetworkShareManager.stop> {
  return await remoteNetworkShareManager.stop(appId);
}

async function stopRemoteNetworkShareSession(sessionId: string): ReturnType<typeof remoteNetworkShareManager.stopBySession> {
  return await remoteNetworkShareManager.stopBySession(sessionId);
}

async function startRemoteAgentSession(agentId: string, options?: Parameters<RemoteAgentSessionService['start']>[1]): ReturnType<RemoteAgentSessionService['start']> {
  return await getRemoteAgentSessionService().start(agentId, options);
}

async function stopRemoteAgentSession(agentId: string): ReturnType<RemoteAgentSessionService['stop']> {
  return await getRemoteAgentSessionService().stop(agentId);
}

async function stopRemoteAgentSessionSession(sessionId: string): ReturnType<RemoteAgentSessionService['stopBySession']> {
  return await getRemoteAgentSessionService().stopBySession(sessionId);
}

const createCloudSocialRelayDeps = () => ({
  CLAUDE_CODE_VERSION,
  BetterSqlite3,
  CloudIdentityStore,
  DEFAULT_NODE_VERSION,
  app,
  appAgentTaskManager,
  appWindows,
  canRunCommand,
  cloudDeviceManager,
  cloudIdentityStore,
  ensureRuntimeInstalled,
  existsFile,
  fetchBodyFromBuffer,
  forgerAccount,
  forgerBackendClient,
  friendChatWindows,
  fs,
  getClaudeRoot,
  getCloudIdentityPath,
  getSocialMessagesPath,
  getCodexAuthStatus,
  getRuntimePathEntries,
  getRuntimeStatus,
  mainWindow,
  openInstalledAppUnlocked,
  openOrFocusFriendChatWindowForFriend,
  path,
  registry,
  resolveInstalledAgents,
  runCommand,
  runCommandCapture,
  runningApps,
});
const getCloudSocialRelayController = () => createCloudSocialRelayController(createCloudSocialRelayDeps());
const findSqliteFile = async (searchDir: string): Promise<string | null> => await getCloudSocialRelayController().findSqliteFile(searchDir);
const resolveManagedClaudeCliPath = async (baseDir: string): Promise<string | null> => await getCloudSocialRelayController().resolveManagedClaudeCliPath(baseDir);
const resolveSystemClaudeCliPath = async (): Promise<string | null> => await getCloudSocialRelayController().resolveSystemClaudeCliPath();
const resolveClaudeCli = async (): Promise<{ path: string; source: 'managed' | 'system' } | null> => await getCloudSocialRelayController().resolveClaudeCli();
const ensureClaudeCliInstalled = async (): Promise<string> => await getCloudSocialRelayController().ensureClaudeCliInstalled();
const resolveAppDbPath = async (appId: string): Promise<string | null> => await getCloudSocialRelayController().resolveAppDbPath(appId);
const getCloudIdentityStore = (): CloudIdentityStore => getCloudSocialRelayController().getCloudIdentityStore();
const decryptCloudMessage = async (message: CloudMessage): Promise<CloudMessage> => await getCloudSocialRelayController().decryptCloudMessage(message);
const decryptCloudMessages = async (messages: CloudMessage[]): Promise<CloudMessage[]> => await getCloudSocialRelayController().decryptCloudMessages(messages);
const listLocalCloudMessages = async (friendUserId: number): Promise<CloudMessage[]> => await getCloudSocialRelayController().listLocalCloudMessages(friendUserId);
const wait = async (milliseconds: number): Promise<void> => await getCloudSocialRelayController().wait(milliseconds);
const buildEncryptedEnvelopes = async (recipientUserId: number, text: string): Promise<CloudMessageEnvelope[]> => await (getCloudSocialRelayController().buildEncryptedEnvelopes as (...args: unknown[]) => Promise<CloudMessageEnvelope[]>)(recipientUserId, text);
const sendEncryptedCloudMessage = async (input: CloudSendMessageInput): Promise<CloudMessage> => await getCloudSocialRelayController().sendEncryptedCloudMessage(input); const sendEncryptedCloudAppShareMessage = async (input: CloudSendAppShareInput): Promise<CloudMessage> => await getCloudSocialRelayController().sendEncryptedCloudAppShareMessage(input);
const isCloudSocialEvent = (event: unknown): event is CloudSocialEvent => getCloudSocialRelayController().isCloudSocialEvent(event);
const prepareCloudSocialEvent = async (event: unknown): Promise<CloudSocialEvent | null> => await getCloudSocialRelayController().prepareCloudSocialEvent(event);
const isUnreadIncomingCloudMessage = (event: CloudSocialEvent): boolean => getCloudSocialRelayController().isUnreadIncomingCloudMessage(event);
const showIncomingCloudMessageNotification = (event: CloudSocialEvent): void => getCloudSocialRelayController().showIncomingCloudMessageNotification(event);
const forwardCloudSocialEvent = (event: CloudSocialEvent): void => getCloudSocialRelayController().forwardCloudSocialEvent(event);
const handleCloudSocialEvent = async (event: unknown): Promise<void> => await getCloudSocialRelayController().handleCloudSocialEvent(event);

const getMainProcessIpcDeps = (): MainProcessIpcDeps & AgentIpcDeps => ({
  state: {
    get agentToolSettings() { return agentToolSettings; },
    set agentToolSettings(value) { agentToolSettings = value; },
    get catalogApps() { return catalogApps; },
    set catalogApps(value) { catalogApps = value; },
    get cloudSyncSettings() { return cloudSyncSettings; },
    set cloudSyncSettings(value) {
      Object.assign(cloudSyncSettings, value);
    },
    get forgerAccount() { return forgerAccount; },
    set forgerAccount(value) { forgerAccount = value; },
    get settings() { return settings; },
    set settings(value) { settings = value; },
  },
  APP_CLAUDE_MODEL_OPTIONS,
  APP_CODEX_MODEL_OPTIONS,
  BetterSqlite3,
  BrowserWindow,
  BUILT_IN_CLAUDE_EFFORT,
  BUILT_IN_CODEX_REASONING,
  CODEX_USAGE_DASHBOARD_URL,
  IPC_CHANNELS,
  app,
  appAgentConversationManager,
  appAgentTaskManager,
  appendInstallLog,
  automationManager,
  workflowManager,
  buildAppSecretsState,
  buildCodexPromptWithAppContext,
  buildForgerToolsContextForApp,
  buildForgerToolsContextForFreeChat,
  canUseCloudDataSync,
  chatOrchestrator,
  cloudDeviceManager,
  confirmClaudeAuthConnection,
  connectClaudeAuth,
  disconnectClaudeAuth,
  signOutClaudeAuth,
  connectAntigravityAuth,
  startAntigravityAuthSession,
  writeAntigravityAuthSession,
  cancelAntigravityAuthSession,
  disconnectAntigravityAuth,
  connectCodexAuth,
  createLocalAppFromSkeleton,
  createRemoteAppBackup,
  decryptCloudMessage,
  decryptCloudMessages,
  listLocalCloudMessages,
  desktopErrorReporter,
  dialog,
  disconnectCodexAuth,
  ensureCatalogStatuses,
  failureDiagnostic,
  forgerBackendClient,
  forwardCloudSocialEvent,
  fs,
  getAppDetails,
  getBackupsManager,
  getBackgroundTaskStore,
  getClaudeAuthStatus,
  getAntigravityAuthStatus,
  getCloudIdentityStore,
  getCodexAuthStatus,
  getCodexHome,
  getDeveloperPathState,
  getDesktopUpdater,
  getFileLibrary,
  getForgerHomeRoot,
  getForgerMetadataRoot,
  getInstallLogPath,
  getMemoryStore,
  getPersonalAgentStore,
  getPersonalAgentConversationManager,
  getPersonalAgentRoutineManager,
  getOfficialToolsService,
  getConnectionsService,
  getSpeechToTextService,
  getLiveVoiceInputService,
  getWakeWordService,
  getTextToSpeechService,
  getPrivateAppsRoot,
  getPrivateDataRoot,
  getRuntimeStatus,
  getLocalNetworkShareStatus,
  getRemoteNetworkShareStatus,
  getRemoteActivitySnapshot,
  getLlmRunsSnapshot,
  getSecretsStore,
  installAppRuntime,
  prepareSocialAppReview,
  finishSocialAppInstall,
  deleteQuarantinedSocialApp,
  getSocialAppReviewPromptContext,
  installSocialAppRuntime,
  installWelcome,
  ipcMain,
  listAppPrompts,
  listCatalogFromBackend,
  listLlmProviderProfiles,
  mainWindow: getMainWindow(),
  normalizeAgentProvider,
  normalizeClaudeEffort,
  normalizeCodexReasoningEffort,
  normalizeManifestAgentDefaults,
  openInstalledApp,
  startLocalNetworkShare,
  stopLocalNetworkShare,
  startRemoteNetworkShare,
  stopRemoteNetworkShare,
  openOrFocusFriendChatWindow,
  path,
  publicForgerAccount,
  registry,
  reinstallClaude,
  reinstallAntigravity,
  reinstallCodex,
  renderManifestAgentPrompt,
  resolveAppDbPath,
  resolveAppIdForWebContents,
  resolveInstalledAgents,
  resolveInstalledAppSecrets,
  resolveInstalledManifest,
  resolveSelectedAppDisplayName,
  restoreAppPrompt,
  restoreAppUserVersionRuntime,
  restoreRemoteAppBackup,
  sanitizeRendererChatTrace,
  sendEncryptedCloudMessage, sendEncryptedCloudAppShareMessage,
  serializeErrorForInstallLog,
  setAppAutoSyncSetting,
  setActiveLlmProviderProfile,
  updateLlmProviderProfileDefaults,
  shell,
  signAppFolderGrant,
  stopInstalledApp,
  switchForgerAccountSession,
  toAppSummary,
  uninstallAppRuntime,
  upsertInstalledRecord,
  updateAgentDefaults,
  updateAgentToolApproval,
  updateAppDeveloperSettings,
  updateDeveloperMode,
  updateAppPrompt,
  updateAppRuntime,
  updateCodexDefaults,
  validateArchiveEntries,
  validateAppPrompt,
  zipDirectory,
});
const windowBootstrapState = {
  get mainWindow() { return mainWindow; }, set mainWindow(value) { mainWindow = value; },
  get pendingDeepLink() { return pendingDeepLink; }, set pendingDeepLink(value) { pendingDeepLink = value; },
  get pendingDeepLinkFlushScheduled() { return pendingDeepLinkFlushScheduled; }, set pendingDeepLinkFlushScheduled(value) { pendingDeepLinkFlushScheduled = value; },
};
const createWindowBootstrapDeps = () => ({
  BrowserWindow,
  IPC_CHANNELS,
  app,
  desktopErrorReporter,
  focusDeepLinkWindow,
  getMainProcessIpcDeps,
  getMainWindow,
  getWindowState,
  ipcMain,
  isDev,
  loadDesktopWindow,
  path,
  registerAgentIpcHandlers,
  registerMainIpcHandlers,
  registerWindowIpcHandlers,
  registerWindowStateEvents,
  shell,
  state: windowBootstrapState,
  useCustomWindowFrame,
});
const getWindowBootstrapController = () => createWindowBootstrapController(createWindowBootstrapDeps());
const createWindow = async (): Promise<void> => await getWindowBootstrapController().createWindow();
const registerIpcHandlers = (): void => getWindowBootstrapController().registerIpcHandlers();
const dispatchDeepLink = (link: ForgerDeepLink): void => getWindowBootstrapController().dispatchDeepLink(link);
const flushPendingDeepLink = (): void => getWindowBootstrapController().flushPendingDeepLink();
const handleIncomingUrl = (rawUrl: string): void => getWindowBootstrapController().handleIncomingUrl(rawUrl);

const mainLifecycleState = {
  get localCatalogJsonUrl() { return localCatalogJsonUrl; }, set localCatalogJsonUrl(value) { localCatalogJsonUrl = value; },
  get devCatalogService() { return devCatalogService; }, set devCatalogService(value) { devCatalogService = value; },
  get mainWindow() { return mainWindow; }, set mainWindow(value) { mainWindow = value; },
  get pendingDeepLink() { return pendingDeepLink; }, set pendingDeepLink(value) { pendingDeepLink = value; },
  get pendingDeepLinkFlushScheduled() { return pendingDeepLinkFlushScheduled; }, set pendingDeepLinkFlushScheduled(value) { pendingDeepLinkFlushScheduled = value; },
  get catalogApps() { return catalogApps; }, set catalogApps(value) { catalogApps = value; },
  get registry() { return registry; }, set registry(value) { registry = value; },
  get forgerAccount() { return forgerAccount; }, set forgerAccount(value) { forgerAccount = value; },
  get forgerAccountStore() { return forgerAccountStore; }, set forgerAccountStore(value) { forgerAccountStore = value; },
  get cloudDeviceManager() { return cloudDeviceManager; }, set cloudDeviceManager(value) { cloudDeviceManager = value; },
  get cloudIdentityStore() { return cloudIdentityStore; }, set cloudIdentityStore(value) { cloudIdentityStore = value; },
  get forgerBackendClient() { return forgerBackendClient; }, set forgerBackendClient(value) { forgerBackendClient = value; },
  get chatOrchestrator() { return chatOrchestrator; }, set chatOrchestrator(value) { chatOrchestrator = value; },
  get appAgentTaskManager() { return appAgentTaskManager; }, set appAgentTaskManager(value) { appAgentTaskManager = value; },
  get appAgentConversationManager() { return appAgentConversationManager; }, set appAgentConversationManager(value) { appAgentConversationManager = value; },
  get llmRunsStore() { return llmRunsStore; },
  get fileLibrary() { return fileLibrary; }, set fileLibrary(value) { fileLibrary = value; },
  get secretsStore() { return secretsStore; }, set secretsStore(value) { secretsStore = value; },
  get officialToolsService() { return officialToolsService; }, set officialToolsService(value) { officialToolsService = value; },
  get connectionsService() { return connectionsService; }, set connectionsService(value) { connectionsService = value; },
  get speechToTextService() { return speechToTextService; }, set speechToTextService(value) { speechToTextService = value; },
  get textToSpeechService() { return textToSpeechService; }, set textToSpeechService(value) { textToSpeechService = value; },
  get wakeWordService() { return wakeWordService; }, set wakeWordService(value) { wakeWordService = value; },
  get desktopErrorReporter() { return desktopErrorReporter; }, set desktopErrorReporter(value) { desktopErrorReporter = value; },
  get automationManager() { return automationManager; }, set automationManager(value) { automationManager = value; },
  get workflowManager() { return workflowManager; }, set workflowManager(value) { workflowManager = value; },
  get appMcpManager() { return appMcpManager; }, set appMcpManager(value) { appMcpManager = value; },
  get backupsManager() { return backupsManager; }, set backupsManager(value) { backupsManager = value; },
  get memoryStore() { return memoryStore; }, set memoryStore(value) { memoryStore = value; },
  get memoryMaintenanceManager() { return memoryMaintenanceManager; }, set memoryMaintenanceManager(value) { memoryMaintenanceManager = value; },
  get desktopRuntimeBridge() { return desktopRuntimeBridge; }, set desktopRuntimeBridge(value) { desktopRuntimeBridge = value; },
  get selfOAuthCallbackService() { return selfOAuthCallbackService; }, set selfOAuthCallbackService(value) { selfOAuthCallbackService = value; },
  get personalAgentRoutineManager() { return personalAgentRoutineManager; }, set personalAgentRoutineManager(value) { personalAgentRoutineManager = value; },
  get localNetworkShareManager() { return localNetworkShareController.manager; }, set localNetworkShareManager(value) { localNetworkShareController.manager = value; },
  get remoteNetworkShareManager() { return remoteNetworkShareManager; },
  get remoteAgentSessionService() { return remoteAgentSessionService; }, set remoteAgentSessionService(value) { remoteAgentSessionService = value; },
  get forgerMcpServer() { return forgerMcpServer; }, set forgerMcpServer(value) { forgerMcpServer = value; },
  get agentToolSettings() { return agentToolSettings; }, set agentToolSettings(value) { agentToolSettings = value; },
};

registerMainLifecycle({
  AGENT_TOOL_DEFINITIONS, AppAgentConversationManager, AppAgentTaskManager, AppMcpManager, AutomationManager, WorkflowManager,
  BrowserWindow, ChatOrchestrator, CloudDeviceManager, CloudIdentityStore, DesktopRuntimeBridge,
  DevCatalogService, FORGER_AGENT_CONTRACT_VERSION, FileLibrary, ForgerAccountStore, ForgerBackendClient,
  ForgerMcpServer, IPC_CHANNELS, MemoryMaintenanceManager, MemoryStore, SecretsStore, anyAppAllowsAgentNetworkAccess, app,
  appAllowsAgentNetworkAccess, appWindows, appendInstallLog, backendBaseUrl, dialog, buildForgerToolsContextForApp, buildMemoryContextForApp,
  buildMemoryContextForApps, chooseAgentRuntime, cleanupLegacyExternalToolState, clearForgerAccountSession, closeServer, createLocalAppFromSkeleton, createWindow,
  finishSocialAppInstall, deleteQuarantinedSocialApp,
  emitAutomationUpdated, emitWorkflowUpdated, emitChatRunUpdated, ensureBackendPythonEnvironment, ensureCatalogStatuses, ensureGlobalAgentsContext,
  ensureGitAvailable, ensurePathInside, ensureRuntimeInstalled, ensureSqliteDatabaseParent, flushPendingDeepLink, fs, getAgentPathEntries, getBackupsRoot,
  getClaudeAuthStatus, getAntigravityAuthStatus, getCloudDeviceAccountStorageKey, getCloudDevicePath, getCloudIdentityPath, getCloudIdentityStore,
  getCodexAuthStatus, getCodexHome, getCodexRoot, getCodexToolEnvironment, getDesktopChatNetworkAccessDefault: () => settings.defaultChatNetworkAccess !== false, getManifestAppSecretsValidationError, getSecretsStore, getForgerAccountPath, getForgerHomeRoot, getForgerMetadataRoot,
  getProviderProfilesRoot, resolveLlmProviderAuthProfile, getSocialAppReviewPromptContext,
  getFreePort, getLegacyForgerMetadataRoot, getMemoryStore, getPersonalAgentStore, getPersonalAgentConversationManager, getPersonalAgentRoutineManager, getOfficialToolsService, getConnectionsService, getSelfOAuthCallbackService, getSpeechToTextService, getTextToSpeechService, getLiveVoiceInputService, getWakeWordService,
  getAudioDevices: async () => await getAudioRuntimeBroker().listDevices(),
  playTextToSpeechAudio: async (input: { playbackId: string; audioDataBase64: string; mimeType: string; outputDeviceId?: string }) => await getAudioRuntimeBroker().playAudio(input),
  cancelTextToSpeechPlayback: async (playbackId: string) => await getAudioRuntimeBroker().cancelPlayback(playbackId),
  deleteTextToSpeechAudio: async (audioPath: string) => {
    await fs.unlink(audioPath).catch((error: unknown) => {
      if ((error as { code?: string })?.code !== 'ENOENT') throw error;
    });
  },
  getPrivateAppsRoot, getPrivateDataRoot, getRuntimesRoot,
  getRuntimePathEntries, getRuntimeStatus, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getTempRoot, getVenvExecutables,
  getPersonalAgentHeartbeat, handleCloudSocialEvent, hasInstalledCodexConversation, ipcMain, listAppPrompts, listCatalogFromBackend, loadAgentToolSettings,
  loadCloudSyncSettings, loadRegistry, loadSettings, llmRunsStore, mapBackendCategory, formatProcessOutputForInstallLog, isSecretsVaultUnavailableError, normalizeManifestAppSecrets, openInstalledApp, startLocalNetworkShare, stopLocalNetworkShare,
  startRemoteNetworkShare, stopRemoteNetworkShare, stopRemoteNetworkShareSession, startRemoteAgentSession, stopRemoteAgentSession, stopRemoteAgentSessionSession, openOrFocusAppWindow, registerForgerCloudOAuth,
  registerIpcHandlers, renderManifestAgentPrompt, resolveClaudeCli, resolveAntigravityCliPath, resolveCodexCliPath, resolveInstalledAgents, resolveInstalledManifest,
  resolveAppFolderGrant: verifyAppFolderGrant, resolveInstalledPromptTemplates, restoreAppPrompt, restartInstalledApp, runningApps, serializeErrorForInstallLog, shell,
  splitManifestCommand, startDevCatalogService, state: mainLifecycleState, stopInstalledApp, switchForgerAccountSession, terminateProcess,
  testAppPrompt, toAppSummary, toCatalogStatus, translateManifestEnvironment, truncateForInstallLog, updateAppPrompt, updateAppRuntime,
  upsertInstalledRecord, waitForHttpOk,
});
