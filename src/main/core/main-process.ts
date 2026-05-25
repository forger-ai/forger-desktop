import { app, BrowserWindow, dialog, ipcMain, Notification, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { buildMacTerminalLoginScript, buildMacTerminalScriptLaunchCommand } from '../auth-login-scripts';
import { buildCodexAuthEnvironment, classifyCodexAuthOutput, extractAllowedCodexAuthUrls } from '../codex-auth-helpers';
import { ForgerMcpServer } from '../forger-mcp-server';
import { MemoryStore } from '../memory-store';
import { PromptOverridesStore, buildPromptBases, promptOverrideErrorResult } from '../prompt-overrides';
import { OfficialToolsService, normalizeAppToolDeclarations } from '../official-tools-service';
import { ForgerAccountStore, publicForgerAccount, type StoredForgerAccount } from '../forger-account-store';
import { ForgerBackendClient } from '../forger-backend-client';
import { registerForgerCloudOAuth } from '../forger-cloud-oauth';
import { CloudDeviceManager } from '../cloud-device-manager';
import { CloudIdentityStore, type EncryptedCloudText } from '../cloud-identity-store';
import { BackupsManager } from '../backups-manager';
import {
  createWindowStateEventRegistrar,
  createWindowStateReader,
  registerWindowIpcHandlers,
} from '../ipc/window';
import { registerAgentIpcHandlers } from '../ipc/agent-handlers';
import { registerMainIpcHandlers } from '../ipc/main-handlers';
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
import { configureDesktopUserDataPath, createPathConfigController } from './path-config';
import { createMainUtilitiesController } from './main-utilities';
import { createLocalNetworkShareController } from './local-network-share-service';
import { RemoteNetworkShareManager } from '../remote-network-share-manager';
import { createRuntimeInstallController } from '../runtime/runtime-install';
import { loadOptionalBetterSqlite } from '../runtime/optional-better-sqlite';
import { createWindowBootstrapController } from './window-bootstrap';
import { AGENT_TOOL_DEFINITIONS, AGENT_TOOL_IDS, AGENT_TOOL_PACKAGES, createInitialAgentToolSettings } from './agent-tool-packages';
import { registerMainLifecycle } from './main-lifecycle';
import type {
  AppManifest,
  AppManifestService,
  AppManifestStack,
  AppRegistry,
  InstalledAppRecord,
  RuntimeBinarySet,
  RunningAppProcess,
  StackSkillTemplate,
} from './main-process-types';
import { FORGER_AGENT_CONTRACT_MARKER, FORGER_AGENT_CONTRACT_MARKER_PREFIX, FORGER_AGENT_CONTRACT_VERSION, buildGlobalForgerAgentsMarkdown } from '../prompt-builder/forger-base';
import { buildFailureDiagnostic } from '../../shared/error-diagnostics';
import { buildForgerAppAgentsMarkdown } from '../prompt-builder/apps-base';
import { buildCodexPromptForFreeChat, buildCodexPromptWithAppContext } from '../prompt-builder/user-message';
import { buildForgerOfficialToolSkillTemplates, buildForgerOfficialToolsPromptSection } from '../prompt-builder/official-tools';
import { SecretsStore, appSecretEnvName, isSecretsVaultUnavailableError } from '../secrets-store';
import type {
  AgentToolSettings,
  AppToolDeclaration,
  AppToolsInstallGate,
  AppCategory,
  AppDetails,
  CloudFriendship,
  CloudFriendUser,
  CloudSyncSettings,
  CloudMessage,
  CloudMessageEnvelope,
  CloudSendMessageInput,
  CloudSocialEvent,
  CloudAppMessagePermissionDecision,
  CreateRemoteAppBackupInput,
  CreateRemoteAppBackupResult,
  AppExternalFolderSelection,
  AppAgent,
  AppAgentRuntimeInput,
  AppAgentThreadCreateInput,
  AppAgentPromptSet,
  AppAgentPromptTemplate,
  AppAgentPromptVariable,
  AppAgentPromptVariableType,
  AppAgentThreadRunControlInput,
  AppAgentThreadRunStartInput,
  AppAgentThreadRunSteerInput,
  AppManifestAgentResumeInput,
  AppManifestAgentStartInput,
  AppManifestAgentSteerInput,
  AppManifestAgentStopInput,
  AppCodexTaskStartInput,
  AppCodexConversationCreateInput,
  AppCodexConversationSendMessageInput,
  AppLocalChangeSummary,
  AppPromptMutationResult,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptReviewItem,
  AppPromptTestInput,
  AppPromptTestResult,
  AppPromptTemplate,
  AppPromptValidationResult,
  AppSecretConnection,
  AppSecretDeclaration,
  AppSecretsState,
  AppStatus,
  AppOperationSummary,
  AppSummary,
  AgentProvider,
  AgentRuntime,
  AgentRuntimeRecommendations,
  AgentRuntimeRequest,
  AutomationUpsertInput,
  BackgroundTask,
  BasicActionResult,
  CatalogApp,
  ChatApplyRunInput,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatGetRunInput,
  ChatRun,
  ChatRunEvent,
  ChatStartRunInput,
  ChatUndoInput,
  CallOfficialToolInput,
  ConfigureOfficialToolInput,
  ClaudeAuthStatus,
  ClaudeEffort,
  CodexAuthStatus,
  CodexReasoningEffort,
  DesktopErrorReportPreview,
  ConnectAppSecretInput,
  CreateLocalAppInput,
  CreateLocalAppResult,
  CreateUserSecretInput,
  DeleteUserSecretInput,
  DesktopUpdateState,
  DisconnectAppSecretInput,
  FailureDiagnosticFields,
  FilesCreateCategoryInput,
  FilesDeleteCategoryInput,
  FilesDeleteInput,
  FilesDiscardStagedForChatInput,
  FilesImportInput,
  FilesListInput,
  FilesMoveInput,
  FilesRenameCategoryInput,
  FilesRenameInput,
  FilesStageForChatInput,
  FriendChatWindowOpenResult,
  ForgerAccountLoginInput,
  ForgerAccountProfileInput,
  ForgerAccountRegisterInput,
  InstallAppResult,
  MemoryCreateInput,
  MemoryListInput,
  MemoryUpdateInput,
  OpenAppResult,
  RemoteAppBackupSummary,
  RendererChatTraceEvent,
  RuntimeStatus,
  AgentDefaults,
  Settings,
  SharedFileRef,
  SubmitAppRatingInput,
  SubmitProductFeedbackInput,
  SubmitUsageEventInput,
  StopAppResult,
  UpdateAgentDefaultsInput,
  UpdateAgentToolApprovalInput,
  UpdateCodexDefaultsInput,
  SetAppToolGrantInput,
  UpdateUserSecretInput,
} from '../../shared/types';

const BetterSqlite3 = loadOptionalBetterSqlite();

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
configureDesktopUserDataPath({ app, isDev, path });
const backendBaseUrl = process.env.FORGER_BACKEND_URL ?? (isDev ? 'http://127.0.0.1:3300' : 'https://platform.forger.cloud');
let localCatalogJsonUrl: string | undefined;
const DEFAULT_NODE_VERSION = '22';
const DEFAULT_PYTHON_VERSION = '3.12';
const BUNDLED_GIT_VERSION = '2.54.0';
const CODEX_CLI_VERSION = '0.129.0';
const CLAUDE_CODE_VERSION = 'latest';
const CODEX_USAGE_DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
const BUILT_IN_CODEX_MODEL = 'gpt-5.4';
const BUILT_IN_CODEX_REASONING: CodexReasoningEffort = 'medium';
const BUILT_IN_CLAUDE_MODEL = 'sonnet';
const BUILT_IN_CLAUDE_EFFORT: ClaudeEffort = 'medium';
const APP_CODEX_MODEL_OPTIONS = [
  { displayModelName: '5.4', realModelName: 'gpt-5.4', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.3 Codex', realModelName: 'gpt-5.3-codex', defaultReasoningEffort: 'low' as const },
  { displayModelName: '5.3 Spark', realModelName: 'gpt-5.3-codex-spark', defaultReasoningEffort: 'high' as const },
  { displayModelName: '5.4 Mini', realModelName: 'gpt-5.4-mini', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.5', realModelName: 'gpt-5.5', defaultReasoningEffort: 'medium' as const },
];
const APP_CLAUDE_MODEL_OPTIONS = [
  { displayModelName: 'Sonnet latest', realModelName: 'sonnet', defaultEffort: 'medium' as const },
  { displayModelName: 'Opus latest', realModelName: 'opus', defaultEffort: 'high' as const },
  { displayModelName: 'Haiku latest', realModelName: 'haiku', defaultEffort: 'low' as const },
];
const CODEX_MODEL_VALUES = new Set(APP_CODEX_MODEL_OPTIONS.map((option) => option.realModelName));
const CODEX_REASONING_VALUES = new Set<CodexReasoningEffort>(['none', 'low', 'medium', 'high', 'xhigh']);
const CLAUDE_MODEL_VALUES = new Set(APP_CLAUDE_MODEL_OPTIONS.map((option) => option.realModelName));
const CLAUDE_EFFORT_VALUES = new Set<ClaudeEffort>(['low', 'medium', 'high', 'xhigh', 'max']);
let devCatalogService: DevCatalogService | null = null;
const APP_FOLDER_GRANT_TTL_MS = 5 * 60 * 1000;
const appFolderGrantSecret = randomBytes(32).toString('base64url');
const useCustomWindowFrame = process.platform === 'win32';
const getWindowState = createWindowStateReader(useCustomWindowFrame);
const registerWindowStateEvents = createWindowStateEventRegistrar(getWindowState);

const RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'win32_x64']);

let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: ForgerDeepLink | null = null;
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
let desktopUpdater: DesktopUpdater | null = null;
let desktopErrorReporter: DesktopErrorReporter | null = null;
let automationManager: AutomationManager | null = null;
let backgroundTaskStore: BackgroundTaskStore | null = null;
let appMcpManager: AppMcpManager | null = null;
let backupsManager: BackupsManager | null = null;
let memoryStore: MemoryStore | null = null;
let desktopRuntimeBridge: DesktopRuntimeBridge | null = null;

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
const getClaudeRoot = (): string => getPathConfigController().getClaudeRoot();
const getAgentToolSettingsPath = (): string => getPathConfigController().getAgentToolSettingsPath();
const getSettingsPath = (): string => getPathConfigController().getSettingsPath();
const getPromptOverridesPath = (): string => getPathConfigController().getPromptOverridesPath();
const getForgerAccountPath = (): string => getPathConfigController().getForgerAccountPath();
const getCloudDevicePath = (): string => getPathConfigController().getCloudDevicePath();
const getCloudIdentityPath = (): string => getPathConfigController().getCloudIdentityPath();
const getCloudSyncSettingsPath = (): string => getPathConfigController().getCloudSyncSettingsPath();
const getCloudDeviceAccountStorageKey = (): string | undefined => getPathConfigController().getCloudDeviceAccountStorageKey();

const settingsServiceState = { get promptOverridesStore() { return promptOverridesStore; }, set promptOverridesStore(value) { promptOverridesStore = value; }, get settings() { return settings; }, set settings(value) { settings = value; } };
const createSettingsServiceDeps = () => ({
  BUILT_IN_CLAUDE_EFFORT,
  BUILT_IN_CLAUDE_MODEL,
  BUILT_IN_CODEX_MODEL,
  BUILT_IN_CODEX_REASONING,
  CLAUDE_MODEL_VALUES,
  CLAUDE_EFFORT_VALUES,
  CODEX_MODEL_VALUES,
  CODEX_REASONING_VALUES,
  PromptOverridesStore,
  fs,
  getClaudeAuthStatus,
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
const markProviderConnected = async (provider: AgentProvider): Promise<void> => await getSettingsServiceController().markProviderConnected(provider);
const chooseAgentRuntime = async (requested?: AgentRuntimeRequest): Promise<AgentRuntime> => await getSettingsServiceController().chooseAgentRuntime(requested);
const chooseConnectedProvider = async (): Promise<AgentProvider> => await getSettingsServiceController().chooseConnectedProvider();
const withAgentDefaults = <T extends { model?: string; reasoningEffort?: CodexReasoningEffort; runtime?: AgentRuntime; runtimeRecommendations?: AgentRuntimeRecommendations }>(input: T, defaults: AgentDefaults = normalizeSettings(settings).agentDefaults): T => getSettingsServiceController().withAgentDefaults(input, defaults);

let agentToolSettings: AgentToolSettings = createInitialAgentToolSettings();

let forgerMcpServer: ForgerMcpServer | null = null;

const mainUtilitiesState = { get agentToolSettings() { return agentToolSettings; }, set agentToolSettings(value) { agentToolSettings = value; }, get catalogApps() { return catalogApps; }, set catalogApps(value) { catalogApps = value; }, get desktopUpdater() { return desktopUpdater; }, set desktopUpdater(value) { desktopUpdater = value; }, get forgerAccount() { return forgerAccount; }, set forgerAccount(value) { forgerAccount = value; }, get settings() { return settings; }, set settings(value) { settings = value; } };
const getMainWindow = (): BrowserWindow | null => mainWindow;
const createMainUtilitiesDeps = () => ({ AGENT_TOOL_DEFINITIONS, AGENT_TOOL_IDS, APP_FOLDER_GRANT_TTL_MS, Buffer, Date, DesktopUpdater, IPC_CHANNELS, app, appFolderGrantSecret, appWindows, buildFailureDiagnostic, cloudDeviceManager, createHmac, desktopErrorReporter, forgerAccountStore, friendChatWindows, fs, getAgentToolSettingsPath, getInstallLogPath, installProgressByPhase, isDev, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getMainWindow, path, publicForgerAccount, registry, runningApps, state: mainUtilitiesState });
const getMainUtilitiesController = () => createMainUtilitiesController(createMainUtilitiesDeps());
const CommandFailedError = getMainUtilitiesController().CommandFailedError;
const truncateForInstallLog = (value: string): string => getMainUtilitiesController().truncateForInstallLog(value);
const serializeErrorForInstallLog = (error: unknown): Record<string, unknown> => getMainUtilitiesController().serializeErrorForInstallLog(error);
const signAppFolderGrant = (appId: string, folderPath: string): AppExternalFolderSelection => getMainUtilitiesController().signAppFolderGrant(appId, folderPath);
const resolveAppIdForWebContents = (webContentsId: number): string | null => getMainUtilitiesController().resolveAppIdForWebContents(webContentsId);
const appendInstallLog = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => await getMainUtilitiesController().appendInstallLog(event, payload);
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
const buildChatRunIpcTracePayload = (run: ChatRun): Record<string, unknown> => getMainUtilitiesController().buildChatRunIpcTracePayload(run);
const sanitizeRendererChatTrace = (input: RendererChatTraceEvent): Record<string, unknown> => getMainUtilitiesController().sanitizeRendererChatTrace(input);
const emitChatRunUpdated = (payload: ChatRunEvent): void => getMainUtilitiesController().emitChatRunUpdated(payload);
const emitAutomationUpdated = (payload: { automation: unknown; run?: unknown }): void => getMainUtilitiesController().emitAutomationUpdated(payload);
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

const manifestSupportState = { get secretsStore() { return secretsStore; }, set secretsStore(value) { secretsStore = value; }, get officialToolsService() { return officialToolsService; }, set officialToolsService(value) { officialToolsService = value; }, get memoryStore() { return memoryStore; }, set memoryStore(value) { memoryStore = value; }, get backupsManager() { return backupsManager; }, set backupsManager(value) { backupsManager = value; } };
const createManifestSupportDeps = () => ({
  BackupsManager,
  BUILT_IN_CLAUDE_EFFORT,
  BUILT_IN_CODEX_REASONING,
  CLAUDE_EFFORT_VALUES,
  CODEX_REASONING_VALUES,
  MemoryStore,
  OfficialToolsService,
  SecretsStore,
  appendInstallLog,
  app,
  canUseCloudDataSync,
  catalogApps,
  cloudSyncSettings,
  extractArchive,
  forgerAccount,
  forgerBackendClient,
  getForgerAccount: () => forgerAccount,
  getForgerBackendClient: () => forgerBackendClient,
  fs,
  getBackupsRoot,
  getCloudIdentityStore,
  getCodexDefaults,
  getForgerMetadataRoot,
  getFreePort,
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
const getMemoryStore = (): MemoryStore => getManifestSupportController().getMemoryStore();
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
  spawn,
  stripArchiveExtension,
  syncDirectory,
  truncateForInstallLog,
  yauzl,
});
const getCommandGitController = () => createCommandGitController(createCommandGitDeps());
const hashFileSha256 = async (filePath: string): Promise<string> => await getCommandGitController().hashFileSha256(filePath);
const requiresWindowsShell = (command: string): boolean => getCommandGitController().requiresWindowsShell(command);
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

const createRuntimeInstallDeps = () => ({ DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION, app, clearMacQuarantine, extractArchive, findRuntimeArchive, findRuntimeChecksumFile, fs, getBundledResourcesRoot, getRuntimesRoot, getTempRoot, hashFileSha256, installBackendDependenciesWithUv, normalizeNodeRuntimeVersion, normalizeVersionForFolder, path, resolvePlatformAlias, runCommand, runtimeLocks });
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
  getCodexHome,
  getCodexRoot,
  getForgerMetadataRoot,
  getLogsRoot,
  getTempRoot,
  markProviderConnected,
  path,
  registry,
  resolveInstalledManifest,
  runCommand,
  runCommandCapture,
  serializeErrorForInstallLog,
  shell,
  spawn,
  translateManifestEnvironment,
  truncateForInstallLog,
});
const getAgentAuthController = () => createAgentAuthController(createAgentAuthDeps());
const getRuntimePathEntries = (runtime: RuntimeBinarySet): string[] => getAgentAuthController().getRuntimePathEntries(runtime);
const existsDirectory = async (dir: string): Promise<boolean> => await getAgentAuthController().existsDirectory(dir);
const getAppLocalToolPathEntries = async (record: InstalledAppRecord): Promise<string[]> => await getAgentAuthController().getAppLocalToolPathEntries(record);
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
const connectClaudeAuth = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().connectClaudeAuth();
const reinstallClaude = async (): Promise<{ success: boolean; userMessage: string; status?: ClaudeAuthStatus } & FailureDiagnosticFields> => await getAgentAuthController().reinstallClaude();

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
  dispatchDeepLink,
  emitRuntimeStatus,
  ensureBackendPythonEnvironment,
  ensureCatalogStatuses,
  ensureRuntimeInstalled,
  failureDiagnostic,
  formatProcessOutputForInstallLog,
  friendChatWindows,
  fs,
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
  requiresWindowsShell,
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

const createCloudSocialRelayDeps = () => ({
  CLAUDE_CODE_VERSION,
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
const wait = async (milliseconds: number): Promise<void> => await getCloudSocialRelayController().wait(milliseconds);
const buildEncryptedEnvelopes = async (recipientUserId: number, text: string): Promise<CloudMessageEnvelope[]> => await (getCloudSocialRelayController().buildEncryptedEnvelopes as (...args: unknown[]) => Promise<CloudMessageEnvelope[]>)(recipientUserId, text);
const sendEncryptedCloudMessage = async (input: CloudSendMessageInput): Promise<CloudMessage> => await getCloudSocialRelayController().sendEncryptedCloudMessage(input);
const isCloudSocialEvent = (event: unknown): event is CloudSocialEvent => getCloudSocialRelayController().isCloudSocialEvent(event);
const prepareCloudSocialEvent = async (event: unknown): Promise<CloudSocialEvent | null> => await getCloudSocialRelayController().prepareCloudSocialEvent(event);
const isUnreadIncomingCloudMessage = (event: CloudSocialEvent): boolean => getCloudSocialRelayController().isUnreadIncomingCloudMessage(event);
const showIncomingCloudMessageNotification = (event: CloudSocialEvent): void => getCloudSocialRelayController().showIncomingCloudMessageNotification(event);
const forwardCloudSocialEvent = (event: CloudSocialEvent): void => getCloudSocialRelayController().forwardCloudSocialEvent(event);
const handleCloudSocialEvent = async (event: unknown): Promise<void> => await getCloudSocialRelayController().handleCloudSocialEvent(event);

const getMainProcessIpcDeps = () => ({
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
  AGENT_TOOL_PACKAGES,
  APP_CLAUDE_MODEL_OPTIONS,
  APP_CODEX_MODEL_OPTIONS,
  BetterSqlite3,
  BrowserWindow,
  BUILT_IN_CLAUDE_EFFORT,
  BUILT_IN_CODEX_REASONING,
  CODEX_USAGE_DASHBOARD_URL,
  IPC_CHANNELS,
  agentToolSettings,
  app,
  appAgentConversationManager,
  appAgentTaskManager,
  appFolderGrantSecret,
  appendInstallLog,
  automationManager,
  buildAppSecretsState,
  buildCodexPromptWithAppContext,
  buildForgerToolsContextForApp,
  buildForgerToolsContextForFreeChat,
  canUseCloudDataSync,
  catalogApps,
  chatOrchestrator,
  cloudDeviceManager,
  cloudSyncSettings,
  connectClaudeAuth,
  connectCodexAuth,
  createLocalAppFromSkeleton,
  createRemoteAppBackup,
  decryptCloudMessage,
  decryptCloudMessages,
  desktopErrorReporter,
  dialog,
  disconnectCodexAuth,
  ensureCatalogStatuses,
  failureDiagnostic,
  forgerAccount,
  forgerBackendClient,
  forwardCloudSocialEvent,
  fs,
  getAppDetails,
  getAppRuntimeStatus: getRuntimeStatus,
  getBackupsManager,
  getBackgroundTaskStore,
  getClaudeAuthStatus,
  getCloudIdentityStore,
  getCodexAuthStatus,
  getCodexHome,
  getDesktopUpdater,
  getFileLibrary,
  getForgerHomeRoot,
  getForgerMetadataRoot,
  getInstallLogPath,
  getMemoryStore,
  getOfficialToolsService,
  getPrivateAppsRoot,
  getPrivateDataRoot,
  getRuntimeStatus,
  getLocalNetworkShareStatus,
  getRemoteNetworkShareStatus,
  getSecretsStore,
  getWindowState,
  installAppRuntime,
  installWelcome,
  ipcMain,
  listAppPrompts,
  listCatalogFromBackend,
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
  stopRemoteNetworkShareSession,
  openOrFocusFriendChatWindow,
  path,
  publicForgerAccount,
  registry,
  reinstallClaude,
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
  sendEncryptedCloudMessage,
  serializeErrorForInstallLog,
  setAppAutoSyncSetting,
  settings,
  shell,
  signAppFolderGrant,
  stopInstalledApp,
  switchForgerAccountSession,
  testAppPrompt,
  toAppSummary,
  uninstallAppRuntime,
  updateAgentDefaults,
  updateAgentToolApproval,
  updateAppPrompt,
  updateAppRuntime,
  updateCodexDefaults,
  validateArchiveEntries,
  validateAppPrompt,
  zipDirectory,
});
const windowBootstrapState = { get mainWindow() { return mainWindow; }, set mainWindow(value) { mainWindow = value; }, get pendingDeepLink() { return pendingDeepLink; }, set pendingDeepLink(value) { pendingDeepLink = value; } };
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
  registerAgentIpcHandlers: (deps: unknown) => registerAgentIpcHandlers(deps as Parameters<typeof registerAgentIpcHandlers>[0]),
  registerMainIpcHandlers: (deps: unknown) => registerMainIpcHandlers(deps as Parameters<typeof registerMainIpcHandlers>[0]),
  registerWindowIpcHandlers,
  registerWindowStateEvents,
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
  get fileLibrary() { return fileLibrary; }, set fileLibrary(value) { fileLibrary = value; },
  get secretsStore() { return secretsStore; }, set secretsStore(value) { secretsStore = value; },
  get officialToolsService() { return officialToolsService; }, set officialToolsService(value) { officialToolsService = value; },
  get desktopErrorReporter() { return desktopErrorReporter; }, set desktopErrorReporter(value) { desktopErrorReporter = value; },
  get automationManager() { return automationManager; }, set automationManager(value) { automationManager = value; },
  get appMcpManager() { return appMcpManager; }, set appMcpManager(value) { appMcpManager = value; },
  get backupsManager() { return backupsManager; }, set backupsManager(value) { backupsManager = value; },
  get memoryStore() { return memoryStore; }, set memoryStore(value) { memoryStore = value; },
  get desktopRuntimeBridge() { return desktopRuntimeBridge; }, set desktopRuntimeBridge(value) { desktopRuntimeBridge = value; },
  get localNetworkShareManager() { return localNetworkShareController.manager; }, set localNetworkShareManager(value) { localNetworkShareController.manager = value; },
  get remoteNetworkShareManager() { return remoteNetworkShareManager; },
  get forgerMcpServer() { return forgerMcpServer; }, set forgerMcpServer(value) { forgerMcpServer = value; },
  get agentToolSettings() { return agentToolSettings; }, set agentToolSettings(value) { agentToolSettings = value; },
};

registerMainLifecycle({
  AGENT_TOOL_DEFINITIONS, AppAgentConversationManager, AppAgentTaskManager, AppMcpManager, AutomationManager,
  BrowserWindow, ChatOrchestrator, CloudDeviceManager, CloudIdentityStore, DEFAULT_NODE_VERSION, DesktopRuntimeBridge,
  DevCatalogService, FORGER_AGENT_CONTRACT_VERSION, FileLibrary, ForgerAccountStore, ForgerBackendClient,
  ForgerMcpServer, IPC_CHANNELS, MemoryStore, SecretsStore, anyAppAllowsAgentNetworkAccess, app,
  appAllowsAgentNetworkAccess, appWindows, appendInstallLog, backendBaseUrl, buildForgerToolsContextForApp,
  buildMemoryContextForApp, buildMemoryContextForApps, chooseAgentRuntime, clearForgerAccountSession, closeServer,
  createWindow, emitAutomationUpdated, emitChatRunUpdated, ensureBackendPythonEnvironment, ensureCatalogStatuses,
  ensureGlobalAgentsContext, ensurePathInside, ensureRuntimeInstalled, ensureSqliteDatabaseParent, flushPendingDeepLink,
  fs, getAppLocalToolPathEntries, getBackupsRoot, getClaudeAuthStatus, getCloudDeviceAccountStorageKey,
  getCloudDevicePath, getCloudIdentityPath, getCloudIdentityStore, getCodexAuthStatus, getCodexHome, getCodexRoot,
  getCodexToolEnvironment, getForgerAccountPath, getForgerHomeRoot, getForgerMetadataRoot, getFreePort,
  getLegacyForgerMetadataRoot, getMemoryStore, getOfficialToolsService, getPrivateAppsRoot, getPrivateDataRoot,
  getRuntimesRoot, getRuntimePathEntries, getRuntimeStatus, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getTempRoot, getVenvExecutables,
  handleCloudSocialEvent, hasInstalledCodexConversation, ipcMain, listAppPrompts, listCatalogFromBackend,
  loadAgentToolSettings, loadCloudSyncSettings, loadRegistry, loadSettings, mapBackendCategory, normalizeNodeRuntimeVersion,
  openInstalledApp, startLocalNetworkShare, stopLocalNetworkShare, startRemoteNetworkShare, stopRemoteNetworkShare, stopRemoteNetworkShareSession, openOrFocusAppWindow, registerForgerCloudOAuth,
  registerIpcHandlers, renderManifestAgentPrompt, resolveClaudeCli, resolveCodexCliPath, resolveInstalledAgents, resolveInstalledManifest,
  resolveInstalledPromptTemplates, restoreAppPrompt, restartInstalledApp, runningApps, serializeErrorForInstallLog,
  shell, splitManifestCommand, startDevCatalogService, state: mainLifecycleState, stopInstalledApp,
  switchForgerAccountSession, terminateProcess, testAppPrompt, toAppSummary, toCatalogStatus, translateManifestEnvironment,
  truncateForInstallLog, updateAppPrompt, updateAppRuntime, upsertInstalledRecord, waitForHttpOk,
});
