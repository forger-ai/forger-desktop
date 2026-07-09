import type fs from 'node:fs/promises';
import type path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type * as Electron from 'electron';
import { BrowserWindow, type IpcMain } from 'electron';
import { getAgentToolPackages } from '../core/agent-tool-packages';
import type { AppAgentConversationManager } from '../app-agent-conversation-manager';
import type { AppAgentTaskManager } from '../app-agent-task-manager';
import type { AutomationManager } from '../automation-manager';
import type { BackgroundTaskStore } from '../background-task-store';
import type { BackupsManager } from '../backups-manager';
import type { ChatOrchestrator } from '../chat/orchestrator';
import type { CloudDeviceManager } from '../cloud-device-manager';
import type { CloudIdentityStore } from '../cloud-identity-store';
import type { DesktopUpdater } from '../desktop-updater';
import type { DesktopErrorReporter } from '../error-reporting';
import type { FileLibrary } from '../file-library';
import type { ForgerBackendClient } from '../forger-backend-client';
import type { StoredForgerAccount } from '../forger-account-store';
import type { MemoryStore } from '../memory-store';
import type { AgentConversationManager } from '../personal-agents/agent-conversation-manager';
import type { AgentRoutineManager } from '../personal-agents/agent-routine-manager';
import type { AgentStore } from '../personal-agents/agent-store';
import type { OfficialToolsService } from '../official-tools-service';
import type { ConnectionsService } from '../connections-service';
import type { SecretsStore } from '../secrets-store';
import {
  buildConversationDiagnosticAttachments,
  buildConversationDiagnosticReport,
  reportSanitizerRoots,
  summarizeConversationDiagnosticAttachments,
  type ConversationDiagnosticAttachmentUpload,
} from '../conversation-diagnostics';
import {
  prepareDesktopErrorReport,
  type DesktopErrorReportAttachmentUpload,
} from '../desktop-error-report-artifacts';
import { appendDesktopLog, type DesktopLogLevel } from '../desktop-logger';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import { registerAppCloudMessagingIpcHandlers } from './app-cloud-messaging-handlers';
import { registerAppRuntimeIpcHandlers } from './app-runtime-handlers';
import { registerChatIpcHandlers } from './chat-handlers';
import { registerConnectionIpcHandlers } from './connection-handlers';
import { registerExternalUrlIpcHandlers } from './external-url-handler';
import { registerFileLibraryIpcHandlers } from './file-library-handlers';
import { registerLiveVoiceInputIpcHandlers } from './live-voice-input-handlers';
import { getMicrophonePermissionStatus, requestMicrophonePermission } from './microphone-permissions';
import { registerPersonalAgentIpcHandlers } from './personal-agent-handlers';
import { registerProviderAuthIpcHandlers } from './provider-auth-handlers';
import { registerWakeWordIpcHandlers } from './wake-word-handlers';
import type {
  AgentDefaults,
  AgentProvider,
  AntigravityAuthStatus,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppAgent,
  AppExternalFolderSelection,
  AppSummary,
  AppPromptMutationResult,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptReviewItem,
  AppPromptValidationResult,
  AppSecretDeclaration,
  AppSecretsState,
  AppToolsInstallGate,
  BackgroundTaskUpsertInput,
  BasicActionResult,
  CatalogApp,
  ChatStartRunInput,
  ClaudeAuthStatus,
  CloudAppMessagePermissionDecision,
  CloudFriendship,
  CloudMessage,
  CloudSocialEvent,
  CloudSendAppShareInput, CloudSendMessageInput,
  CloudSyncSettings,
  ConfigureOfficialToolInput,
  CallOfficialToolInput,
  ConnectAppSecretInput,
  CreateLocalAppInput,
  CreateLocalAppResult,
  CreateRemoteAppBackupInput,
  CreateRemoteAppBackupResult,
  CreateUserSecretInput,
  DeleteUserSecretInput,
  DesktopErrorReportPreview,
  ConversationDiagnosticReportPreview,
  DisconnectAppSecretInput,
  FailureDiagnosticFields,
  ForgerAccountLoginInput,
  ForgerAccountProfileInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  FriendChatWindowOpenResult,
  GetAppToolsInstallGateOptions,
  InstallAppResult,
  LlmProviderProfileMutationResult,
  LlmProviderProfilesState,
  LlmRunsSnapshot,
  MemoryCreateInput,
  MemoryListInput,
  MemoryUpdateInput,
  OpenAppResult,
  PrepareConversationDiagnosticReportInput,
  RendererChatTraceEvent,
  RemoteActivitySnapshot,
  RuntimeStatus,
  SetActiveLlmProviderProfileInput,
  SetActiveLlmProviderProfileResult,
  SetAppToolGrantInput,
  Settings,
  SpeechToTextConfigInput,
  SpeechToTextProcessInput,
  SpeechToTextUploadInput,
  TextToSpeechConfigInput,
  TextToSpeechSynthesizeInput,
  WakeWordConfigInput,
  WakeWordRuntime,
  StopAppResult,
  PrepareSocialAppReviewInput,
  SocialAppQuarantineRecord,
  SocialUserAppUpdateInput,
  SocialUserAppUploadInput,
  SocialUserAppVisibility,
  RenameInstalledAppInput,
  RenameInstalledAppResult,
  SubmitAppRatingInput,
  SubmitProductFeedbackInput,
  SubmitUsageEventInput,
  UpdateAgentDefaultsInput,
  UpdateAgentToolApprovalInput,
  UpdateAppDeveloperSettingsInput,
  UpdateCodexDefaultsInput,
  UpdateDeveloperModeInput,
  UpdateLlmProviderProfileDefaultsInput,
  UpdateUserSecretInput,
  DeveloperPathState,
  CodexAuthStatus,
} from '../../shared/types';
import type { AppManifest, AppRegistry, InstalledAppRecord } from '../core/main-process-types';

const conversationDiagnosticAttachmentCache = new Map<string, ConversationDiagnosticAttachmentUpload[]>();
const desktopErrorReportAttachmentCache = new Map<string, DesktopErrorReportAttachmentUpload[]>();

interface MainIpcState {
  agentToolSettings: AgentToolSettings;
  catalogApps: CatalogApp[];
  cloudSyncSettings: CloudSyncSettings;
  forgerAccount: StoredForgerAccount;
  localCatalogJsonUrl?: string | null;
  settings: Settings;
}

export interface MainProcessIpcDeps {
  state: MainIpcState;
  APP_CLAUDE_MODEL_OPTIONS: unknown[];
  APP_CODEX_MODEL_OPTIONS: unknown[];
  BetterSqlite3: typeof import('better-sqlite3') | null;
  BrowserWindow: typeof BrowserWindow;
  CODEX_USAGE_DASHBOARD_URL: string;
  IPC_CHANNELS: typeof IpcChannels;
  app: Electron.App;
  appAgentConversationManager: AppAgentConversationManager | null;
  appAgentTaskManager: AppAgentTaskManager | null;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  automationManager: AutomationManager | null;
  buildAppSecretsState: (appId: string) => Promise<AppSecretsState>;
  buildCodexPromptWithAppContext: (params: Parameters<typeof import('../prompt-builder/user-message').buildCodexPromptWithAppContext>[0]) => string;
  buildForgerToolsContextForApp: (appId: string) => Promise<string>;
  buildForgerToolsContextForFreeChat: () => Promise<string>;
  canUseCloudDataSync: () => boolean;
  chatOrchestrator: ChatOrchestrator | null;
  cloudDeviceManager: CloudDeviceManager | null;
  confirmClaudeAuthConnection: () => Promise<unknown>;
  connectClaudeAuth: () => Promise<unknown>;
  disconnectClaudeAuth: () => Promise<unknown>;
  signOutClaudeAuth: () => Promise<unknown>;
  connectAntigravityAuth: () => Promise<unknown>;
  startAntigravityAuthSession: (onEvent: (event: unknown) => void) => Promise<unknown>;
  writeAntigravityAuthSession: (sessionId: string, input: string) => Promise<unknown>;
  cancelAntigravityAuthSession: (sessionId: string) => Promise<unknown>;
  disconnectAntigravityAuth: () => Promise<unknown>;
  connectCodexAuth: () => Promise<unknown>;
  createRemoteAppBackup: (input: CreateRemoteAppBackupInput) => Promise<CreateRemoteAppBackupResult>;
  decryptCloudMessage: (message: CloudMessage) => Promise<CloudMessage>;
  decryptCloudMessages: (messages: CloudMessage[]) => Promise<CloudMessage[]>;
  listLocalCloudMessages: (friendUserId: number) => Promise<CloudMessage[]>;
  desktopErrorReporter: DesktopErrorReporter | null;
  dialog: typeof Electron.dialog;
  disconnectCodexAuth: () => Promise<unknown>;
  ensureCatalogStatuses: () => void;
  failureDiagnostic: (error: unknown, fallbackCode: string) => FailureDiagnosticFields;
  forgerBackendClient: ForgerBackendClient | null;
  forwardCloudSocialEvent: (event: CloudSocialEvent) => void;
  fs: typeof fs;
  getAppDetails: (appId: string) => Promise<unknown>;
  getBackupsManager: () => BackupsManager;
  getBackgroundTaskStore: () => BackgroundTaskStore;
  getClaudeAuthStatus: () => Promise<ClaudeAuthStatus>;
  getAntigravityAuthStatus: () => Promise<AntigravityAuthStatus>;
  getCloudIdentityStore: () => CloudIdentityStore;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  getCodexHome: () => string;
  getDesktopUpdater: () => DesktopUpdater;
  getFileLibrary: () => FileLibrary;
  getForgerHomeRoot: () => string;
  getForgerMetadataRoot: () => string;
  getInstallLogPath: () => string;
  getMemoryStore: () => MemoryStore;
  getPersonalAgentStore: () => AgentStore;
  getPersonalAgentConversationManager: () => AgentConversationManager;
  getPersonalAgentRoutineManager: () => AgentRoutineManager;
  getOfficialToolsService: () => OfficialToolsService;
  getConnectionsService: () => ConnectionsService;
  getSpeechToTextService: () => {
    getState: () => Promise<unknown>;
    install: () => Promise<unknown>;
    start: () => Promise<unknown>;
    stop: () => void;
    allowUserSelectedPath: (path: string) => Promise<void>;
    updateConfig: (input: SpeechToTextConfigInput) => Promise<unknown>;
    process: (input: SpeechToTextProcessInput, access?: Record<string, unknown>) => Promise<unknown>;
    processUpload: (input: SpeechToTextUploadInput) => Promise<unknown>;
    createRealtimeSession: () => Promise<unknown>;
  };
  getLiveVoiceInputService: () => {
    getState: () => Promise<unknown>;
    updateConfig: (input: any) => Promise<unknown>;
    updateDevices: (input: any) => Promise<unknown>;
    createSession: (input: any) => Promise<unknown>;
    stop: (input?: any) => Promise<unknown>;
    recordWakeDetected: (input: any) => Promise<unknown>;
    recordWakeReady: (input: any) => Promise<unknown>;
    recordWakeUnavailable: (input: any) => Promise<unknown>;
  };
  getWakeWordService: () => {
    getState: () => Promise<unknown>;
    install: () => Promise<unknown>;
    start: () => Promise<unknown>;
    stop: () => void;
    updateConfig: (input: WakeWordConfigInput) => Promise<unknown>;
    createSession: () => Promise<unknown>;
    recordReady: (input: Partial<WakeWordRuntime>) => Promise<unknown>;
    recordUnavailable: (input: Partial<WakeWordRuntime>) => Promise<unknown>;
    recordDetected: (input: { deviceId?: string; modelId?: string; confidence?: number }) => Promise<unknown>;
    recordDiagnostic: (input: any) => Promise<unknown>;
  };
  getTextToSpeechService: () => {
    getState: () => Promise<unknown>;
    install: () => Promise<unknown>;
    start: () => Promise<unknown>;
    stop: () => void;
    updateConfig: (input: TextToSpeechConfigInput) => Promise<unknown>;
    synthesize: (input: TextToSpeechSynthesizeInput) => Promise<unknown>;
  };
  getPrivateAppsRoot: () => string;
  getPrivateDataRoot: () => string;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  getLocalNetworkShareStatus?: (appId: string) => RuntimeStatus['localNetworkShare'];
  getRemoteNetworkShareStatus?: (appId: string) => RuntimeStatus['remoteNetworkShare'];
  getRemoteActivitySnapshot?: () => RemoteActivitySnapshot;
  getLlmRunsSnapshot?: () => LlmRunsSnapshot;
  getSecretsStore: () => SecretsStore;
  installAppRuntime: (appId: string, locale?: string) => Promise<InstallAppResult>;
  prepareSocialAppReview: (input: PrepareSocialAppReviewInput, locale?: string) => Promise<{ success: boolean; quarantine?: SocialAppQuarantineRecord; userMessage: string; technicalCode?: string }>;
  finishSocialAppInstall: (input: { quarantineId: string }, locale?: string) => Promise<InstallAppResult & { appId?: string }>;
  deleteQuarantinedSocialApp: (input: { quarantineId: string }, locale?: string) => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  getSocialAppReviewPromptContext: (appId: string) => Promise<unknown | null>;
  installSocialAppRuntime: (input: { appId?: number; appSlug?: string; shareCode?: string; trustDecision?: 'not_reviewed' | 'reviewed' | 'skipped_review' }, locale?: string) => Promise<InstallAppResult & { appId?: string }>;
  createLocalAppFromSkeleton: (input: CreateLocalAppInput, locale?: string) => Promise<CreateLocalAppResult>;
  installWelcome: (appId: string, userLanguage?: string) => Promise<{ success: boolean; userMessage: string; welcome?: string; technicalCode?: string }>;
  ipcMain: IpcMain;
  listAppPrompts: (appId: string) => Promise<AppPromptReviewItem[]>;
  listCatalogFromBackend: () => Promise<CatalogApp[]>;
  listLlmProviderProfiles: () => Promise<LlmProviderProfilesState>;
  mainWindow: Electron.BrowserWindow | null;
  normalizeManifestAgentDefaults: (manifest: AppManifest | null) => AgentDefaults;
  openInstalledApp: (appId: string, locale?: string) => Promise<OpenAppResult>;
  startLocalNetworkShare: (appId: string) => Promise<unknown>;
  stopLocalNetworkShare: (appId: string) => Promise<unknown>;
  startRemoteNetworkShare: (appId: string) => Promise<unknown>;
  stopRemoteNetworkShare: (appId: string) => Promise<unknown>;
  openOrFocusFriendChatWindow: (friendship: CloudFriendship) => Promise<FriendChatWindowOpenResult>;
  path: typeof path;
  publicForgerAccount: (account: StoredForgerAccount) => ForgerAccountSession;
  registry: AppRegistry;
  reinstallClaude: () => Promise<unknown>;
  reinstallAntigravity: () => Promise<unknown>;
  reinstallCodex: () => Promise<unknown>;
  resolveAppDbPath: (appId: string) => Promise<string | null>;
  resolveAppIdForWebContents: (webContentsId: number) => string | null;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
  resolveInstalledAppSecrets: (appId: string) => Promise<AppSecretDeclaration[]>;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  resolveSelectedAppDisplayName: (appId: string) => string;
  restoreAppPrompt: (input: AppPromptRestoreInput) => Promise<AppPromptMutationResult>;
  restoreAppUserVersionRuntime: (appId: string) => Promise<BasicActionResult>;
  restoreRemoteAppBackup: (remoteBackupId: number) => Promise<BasicActionResult>;
  sanitizeRendererChatTrace: (input: RendererChatTraceEvent) => Record<string, unknown>;
  sendEncryptedCloudMessage: (input: CloudSendMessageInput) => Promise<CloudMessage>; sendEncryptedCloudAppShareMessage: (input: CloudSendAppShareInput) => Promise<CloudMessage>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  setAppAutoSyncSetting: (appId: string, autoSync: boolean) => Promise<CloudSyncSettings>;
  setActiveLlmProviderProfile: (input: SetActiveLlmProviderProfileInput) => Promise<SetActiveLlmProviderProfileResult>;
  updateLlmProviderProfileDefaults: (input: UpdateLlmProviderProfileDefaultsInput) => Promise<LlmProviderProfileMutationResult>;
  shell: typeof Electron.shell;
  signAppFolderGrant: (appId: string, folderPath: string) => AppExternalFolderSelection;
  stopInstalledApp: (appId: string) => Promise<StopAppResult>;
  switchForgerAccountSession: (account: StoredForgerAccount, result?: { userMessage?: string; technicalCode?: string }) => Promise<ForgerAccountSession>;
  toAppSummary: (record: InstalledAppRecord) => unknown;
  uninstallAppRuntime: (appId: string) => Promise<BasicActionResult>;
  upsertInstalledRecord: (record: InstalledAppRecord) => Promise<void>;
  updateAgentDefaults: (input: UpdateAgentDefaultsInput) => Promise<Settings>;
  updateDeveloperMode: (input: UpdateDeveloperModeInput) => Promise<Settings>;
  updateAppDeveloperSettings: (input: UpdateAppDeveloperSettingsInput) => Promise<DeveloperPathState>;
  getDeveloperPathState: (appId?: string) => Promise<DeveloperPathState>;
  updateAgentToolApproval: (input: UpdateAgentToolApprovalInput) => Promise<AgentToolSettings>;
  updateAppPrompt: (input: AppPromptReviewInput) => Promise<AppPromptMutationResult>;
  updateAppRuntime: (appId: string, locale?: string) => Promise<InstallAppResult>;
  updateCodexDefaults: (input: UpdateCodexDefaultsInput) => Promise<Settings>;
  validateArchiveEntries: (archivePath: string) => Promise<void>;
  validateAppPrompt: (input: AppPromptReviewInput) => Promise<AppPromptValidationResult>;
  zipDirectory: (sourceDir: string, zipPath: string) => Promise<void>;
}

const SOCIAL_UPLOAD_EXCLUDED_NAMES = new Set([
  '.git',
  '.DS_Store',
  'node_modules',
  '.venv',
  'dist',
  'build',
  '.vite',
  '.pytest_cache',
  '.ruff_cache',
  '__pycache__',
  'coverage',
]);

const shouldSkipSocialUploadPath = (sourcePath: string, root: string, pathModule: typeof path): boolean => {
  const relative = pathModule.relative(root, sourcePath);
  const parts = relative.split(pathModule.sep).filter(Boolean);
  if (parts.some((part) => SOCIAL_UPLOAD_EXCLUDED_NAMES.has(part))) return true;
  if (parts.includes('data') && /\.(sqlite|sqlite-|db|backup)/i.test(pathModule.basename(sourcePath))) return true;
  if (/\.env(\.|$)/i.test(pathModule.basename(sourcePath))) return true;
  return false;
};

const slugifySocialUpload = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'social-app';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isDesktopLogLevel = (value: unknown): value is DesktopLogLevel =>
  value === 'debug' || value === 'info' || value === 'warn' || value === 'error';

export const __testMainHandlersInternals = {
};

const trimInstalledAppName = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const updateInstalledManifestDisplayName = async (
  fs: typeof import('node:fs/promises'),
  path: typeof import('node:path'),
  installDir: string,
  name: string,
): Promise<void> => {
  const manifestPath = path.join(installDir, 'manifest.json');
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('app_manifest_invalid');
  }
  const catalog = isRecord(parsed.catalog) ? { ...parsed.catalog } : {};
  parsed.catalog = { ...catalog, display_name: name };
  await fs.writeFile(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
};

export const registerMainIpcHandlers = (deps: MainProcessIpcDeps): void => {
  const { state, APP_CLAUDE_MODEL_OPTIONS, APP_CODEX_MODEL_OPTIONS, BetterSqlite3, BrowserWindow, CODEX_USAGE_DASHBOARD_URL, IPC_CHANNELS, app, appAgentConversationManager, appendInstallLog, buildAppSecretsState, buildCodexPromptWithAppContext, buildForgerToolsContextForApp, buildForgerToolsContextForFreeChat, canUseCloudDataSync, chatOrchestrator, cloudDeviceManager, confirmClaudeAuthConnection, connectClaudeAuth, disconnectClaudeAuth, signOutClaudeAuth, connectAntigravityAuth, startAntigravityAuthSession, writeAntigravityAuthSession, cancelAntigravityAuthSession, disconnectAntigravityAuth, connectCodexAuth, createLocalAppFromSkeleton, createRemoteAppBackup, decryptCloudMessage, decryptCloudMessages, listLocalCloudMessages, dialog, disconnectCodexAuth, ensureCatalogStatuses, failureDiagnostic, forgerBackendClient, forwardCloudSocialEvent, fs, getAppDetails, getBackupsManager, getBackgroundTaskStore, getClaudeAuthStatus, getAntigravityAuthStatus, getCloudIdentityStore, getCodexAuthStatus, getCodexHome, getDesktopUpdater, getDeveloperPathState, getFileLibrary, getForgerHomeRoot, getForgerMetadataRoot, getInstallLogPath, getMemoryStore, getPersonalAgentStore, getPersonalAgentConversationManager, getPersonalAgentRoutineManager, getOfficialToolsService, getConnectionsService, getSpeechToTextService, getLiveVoiceInputService, getWakeWordService, getTextToSpeechService, getPrivateAppsRoot, getPrivateDataRoot, getRuntimeStatus, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getRemoteActivitySnapshot, getLlmRunsSnapshot, getSecretsStore, installAppRuntime, prepareSocialAppReview, finishSocialAppInstall, deleteQuarantinedSocialApp, getSocialAppReviewPromptContext, installSocialAppRuntime, installWelcome, ipcMain, listAppPrompts, listCatalogFromBackend, listLlmProviderProfiles, mainWindow, normalizeManifestAgentDefaults, openInstalledApp, startLocalNetworkShare, stopLocalNetworkShare, startRemoteNetworkShare, stopRemoteNetworkShare, openOrFocusFriendChatWindow, path, publicForgerAccount, registry, reinstallClaude, reinstallAntigravity, reinstallCodex, resolveAppIdForWebContents, resolveInstalledAgents, resolveInstalledAppSecrets, resolveInstalledManifest, resolveSelectedAppDisplayName, restoreAppPrompt, restoreAppUserVersionRuntime, restoreRemoteAppBackup, sanitizeRendererChatTrace, sendEncryptedCloudMessage, sendEncryptedCloudAppShareMessage, serializeErrorForInstallLog, setAppAutoSyncSetting, setActiveLlmProviderProfile, updateLlmProviderProfileDefaults, shell, signAppFolderGrant, stopInstalledApp, switchForgerAccountSession, toAppSummary, uninstallAppRuntime, upsertInstalledRecord, updateAgentDefaults, updateAgentToolApproval, updateAppDeveloperSettings, updateDeveloperMode, updateAppPrompt, updateAppRuntime, updateCodexDefaults, validateArchiveEntries, validateAppPrompt, zipDirectory } = deps;
  const resolveReportRoot = (reader: () => string): string | undefined => {
    try {
      return typeof reader === 'function' ? reader() : undefined;
    } catch {
      return undefined;
    }
  };
  const desktopErrorReportRoots = (appId?: string) => {
    const privateAppsRoot = resolveReportRoot(getPrivateAppsRoot);
    return [
      { alias: 'FORGER_HOME/', path: resolveReportRoot(getForgerHomeRoot) },
      { alias: 'FORGER_APPS/', path: privateAppsRoot },
      ...(appId && privateAppsRoot ? [{ alias: `FORGER_APPS/${appId}/`, path: path.join(privateAppsRoot, appId) }] : []),
      { alias: 'FORGER_DATA/', path: resolveReportRoot(getPrivateDataRoot) },
      { alias: 'FORGER_METADATA/', path: resolveReportRoot(getForgerMetadataRoot) },
      { alias: 'DESKTOP_USER_DATA/', path: app?.getPath ? resolveReportRoot(() => app.getPath('userData')) : undefined },
      { alias: 'CODEX_HOME/', path: resolveReportRoot(getCodexHome) },
    ];
  };
  const getDesktopLogPath = (): string => {
    if (typeof getForgerMetadataRoot === 'function') {
      return path.join(getForgerMetadataRoot(), 'logs', 'forger-desktop.jsonl');
    }
    return path.join(path.dirname(getInstallLogPath()), 'forger-desktop.jsonl');
  };
  const localNetworkShareStatusFor = getLocalNetworkShareStatus ?? (() => undefined);
  const remoteNetworkShareStatusFor = getRemoteNetworkShareStatus ?? (() => undefined);
  const remoteActivityFor = getRemoteActivitySnapshot ?? (() => ({ activities: [], activeCount: 0, preparingCount: 0, errorCount: 0, updatedAt: new Date().toISOString() }));
  const llmRunsSnapshotFor = getLlmRunsSnapshot ?? (() => ({ items: [], activeCount: 0, errorCount: 0, updatedAt: new Date().toISOString() }));
  const localNetworkSharePayloadFor = (appId: string) => {
    const status = localNetworkShareStatusFor(appId);
    const remoteStatus = remoteNetworkShareStatusFor(appId);
    return {
      ...(status ? { localNetworkShare: status } : {}),
      ...(remoteStatus ? { remoteNetworkShare: remoteStatus } : {}),
    };
  };
  const ensurePathInside = (rootPath: string, targetPath: string): boolean => {
    const relative = path.relative(rootPath, targetPath);
    const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
    return normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(relative));
  };
  const installedAppPromptContext = async (appId: string, input?: Pick<ChatStartRunInput, 'provider' | 'model' | 'reasoningEffort' | 'effort'>) => {
    const record = registry.apps[appId];
    const appRoot = record?.installDir;
    const manifest = appRoot ? await resolveInstalledManifest(appRoot).catch(() => null) : null;
    const backend = manifest?.stack?.backend;
    const frontend = manifest?.stack?.frontend;
    const stackParts = [
      backend?.language || backend?.framework || backend?.package_manager
        ? `backend ${[backend?.language, backend?.framework, backend?.package_manager].filter(Boolean).join('/')}`
        : '',
      frontend?.language || frontend?.framework || frontend?.bundler || frontend?.ui
        ? `frontend ${[frontend?.language, frontend?.framework, frontend?.bundler, frontend?.ui].filter(Boolean).join('/')}`
        : '',
    ].filter(Boolean);
    const runtimeParts = [
      input?.provider ? `provider ${input.provider}` : '',
      input?.model ? `model ${input.model}` : '',
      input?.reasoningEffort ? `reasoning ${input.reasoningEffort}` : '',
      input?.effort ? `effort ${input.effort}` : '',
    ].filter(Boolean);
    return {
      appRoot,
      runRoot: appRoot,
      appStack: stackParts.join('; ') || undefined,
      runtime: runtimeParts.join(', ') || undefined,
    };
  };
  ipcMain.handle(IPC_CHANNELS.listInstalledApps, async () => {
    return Object.values(registry.apps).map(toAppSummary);
  });

  ipcMain.handle(IPC_CHANNELS.listCatalogApps, async () => {
    state.catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    return state.catalogApps.map((appEntry) => ({
      ...appEntry,
      ...localNetworkSharePayloadFor(appEntry.id),
    }));
  });

  ipcMain.handle(IPC_CHANNELS.installApp, async (_event, appId: string, locale?: string) => {
    return await installAppRuntime(appId, locale);
  });

  ipcMain.handle(IPC_CHANNELS.createLocalApp, async (_event, input: CreateLocalAppInput, locale?: string) => {
    return await createLocalAppFromSkeleton(input, locale);
  });

  ipcMain.handle(IPC_CHANNELS.updateApp, async (_event, appId: string, locale?: string) => {
    return await updateAppRuntime(appId, locale);
  });

  ipcMain.handle(IPC_CHANNELS.listBackups, async (_event, appId?: string) => {
    return await getBackupsManager().listBackups(appId);
  });

  ipcMain.handle(IPC_CHANNELS.createBackup, async (_event, input: { appId: string; reason?: 'manual' | 'update' | 'pre_restore' }) => {
    try {
      return await getBackupsManager().createBackup(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_create_failed');
      await appendInstallLog('backup:create_failed', {
        appId: input?.appId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos crear el respaldo.',
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.deleteBackup, async (_event, input: { appId: string; backupId: string }) => {
    try {
      return await getBackupsManager().deleteBackup(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_delete_failed');
      await appendInstallLog('backup:delete_failed', {
        appId: input?.appId,
        backupId: input?.backupId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos eliminar ese respaldo.',
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.deleteBackups, async (_event, input: { appId: string; backupIds: string[] }) => {
    try {
      return await getBackupsManager().deleteBackups(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_batch_delete_failed');
      await appendInstallLog('backup:batch_delete_failed', {
        appId: input?.appId,
        backupIds: input?.backupIds,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos eliminar esos respaldos.',
        deleted: [],
        failed: [],
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.restoreBackup, async (_event, input: { appId: string; backupId: string }) => {
    try {
      return await getBackupsManager().restoreBackup(input);
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'backup_restore_failed');
      await appendInstallLog('backup:restore_failed', {
        appId: input?.appId,
        backupId: input?.backupId,
        detail: diagnostic.technicalCode,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos restaurar ese respaldo.',
        ...diagnostic,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.listRemoteBackups, async (_event, appId?: string) => {
    if (!forgerBackendClient || !canUseCloudDataSync()) {
      return { backups: [], usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 } };
    }
    return await forgerBackendClient.listRemoteBackups(appId);
  });

  ipcMain.handle(IPC_CHANNELS.createRemoteBackup, async (_event, input: CreateRemoteAppBackupInput) => {
    try {
      return await createRemoteAppBackup(input);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'remote_backup_create_failed';
      await appendInstallLog('remote_backup:create_failed', {
        appId: input?.appId,
        detail,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos subir el respaldo a Forger Cloud.',
        technicalCode: detail,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.deleteRemoteBackup, async (_event, remoteBackupId: number) => {
    return forgerBackendClient && canUseCloudDataSync()
      ? await forgerBackendClient.deleteRemoteBackup(remoteBackupId)
      : { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta de Forger Cloud activa.', technicalCode: 'subscription_required' };
  });

  ipcMain.handle(IPC_CHANNELS.restoreRemoteBackup, async (_event, input: { remoteBackupId: number }) => {
    try {
      return await restoreRemoteAppBackup(input.remoteBackupId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'remote_backup_restore_failed';
      await appendInstallLog('remote_backup:restore_failed', {
        remoteBackupId: input?.remoteBackupId,
        detail,
        error: serializeErrorForInstallLog(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos restaurar el respaldo cloud.',
        technicalCode: detail,
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.getCloudSyncSettings, async () => state.cloudSyncSettings);
  ipcMain.handle(IPC_CHANNELS.setAppAutoSync, async (_event, appId: string, autoSync: boolean) => {
    return await setAppAutoSyncSetting(appId, autoSync);
  });

  ipcMain.handle(IPC_CHANNELS.restoreAppUserVersion, async (_event, appId: string) => {
    return await restoreAppUserVersionRuntime(appId);
  });

  ipcMain.handle(IPC_CHANNELS.resolveAppUpdateConflict, async (_event, appId: string) => {
    const record = registry.apps[appId];
    if (!record?.pendingUpdate || record.status !== 'conflict') {
      return {
        success: false,
        userMessage: 'No hay una actualizacion en conflicto para resolver.',
        technicalCode: 'no_pending_update_conflict',
      };
    }
    if (!chatOrchestrator) {
      return {
        success: false,
        userMessage: 'El agente no esta disponible para resolver el conflicto.',
        technicalCode: 'chat_orchestrator_unavailable',
      };
    }
    const promptContext = await installedAppPromptContext(appId);
    const prompt = buildCodexPromptWithAppContext({
      appId,
      displayName: resolveSelectedAppDisplayName(appId),
      ...promptContext,
      userLanguage: 'not configured',
      officialToolsContext: await buildForgerToolsContextForApp(appId),
      userPrompt:
        'Resolve this app update conflict. Preserve as much as possible from both the new version and the user customizations. If something cannot be integrated maintainably, leave that part out and explain it in functional terms. Finish the merge and leave a saved version.',
      sharedFilesRootName: path.basename(getPrivateDataRoot()),
      sharedFiles: [],
    });
    return await chatOrchestrator.startRun({
      appId,
      prompt,
      dangerMode: true,
    });
  });

  ipcMain.handle(IPC_CHANNELS.uninstallApp, async (_event, appId: string) => {
    return await uninstallAppRuntime(appId);
  });

  ipcMain.handle(IPC_CHANNELS.renameInstalledApp, async (_event, input: RenameInstalledAppInput): Promise<RenameInstalledAppResult> => {
    const appId = typeof input?.appId === 'string' ? input.appId : '';
    const name = trimInstalledAppName(input?.name);
    const record = registry.apps[appId];
    if (!record?.installDir) {
      return { success: false, userMessage: 'No encontramos esta app instalada.', technicalCode: 'app_not_installed' };
    }
    if (!name) {
      return { success: false, userMessage: 'Escribe un nombre para la app.', technicalCode: 'app_name_required' };
    }
    if (!record.privateLocal && !record.socialSource) {
      return { success: false, userMessage: 'Solo puedes cambiar el nombre de apps tuyas o remixes.', technicalCode: 'app_rename_not_owned_or_remixable' };
    }

    try {
      await updateInstalledManifestDisplayName(fs, path, record.installDir, name);
      await upsertInstalledRecord({ ...record, name });
      state.catalogApps = state.catalogApps.map((entry) => entry.id === appId ? { ...entry, name } : entry);
    } catch (error) {
      return {
        success: false,
        userMessage: 'No pudimos cambiar el nombre de esta app.',
        ...failureDiagnostic(error, 'app_rename_local_failed'),
      };
    }

    const renamedRecord = registry.apps[appId] ?? { ...record, name };
    const appSummary = toAppSummary(renamedRecord) as AppSummary;
    const cloudUserAppId = record.publishedSocialSource?.userAppId ?? record.socialSource?.userAppId;
    if (!cloudUserAppId) {
      return { success: true, userMessage: 'Nombre actualizado.', app: appSummary, cloudSynced: false };
    }
    if (!forgerBackendClient) {
      return {
        success: true,
        userMessage: 'El nombre cambió en este equipo, pero no pudimos actualizar tu perfil de Forger.',
        app: appSummary,
        cloudSynced: false,
        technicalCode: 'backend_client_missing',
      };
    }

    try {
      await forgerBackendClient.updateSocialApp({ id: cloudUserAppId, name });
      return { success: true, userMessage: 'Nombre actualizado.', app: appSummary, cloudSynced: true };
    } catch (error) {
      return {
        success: true,
        userMessage: 'El nombre cambió en este equipo, pero no pudimos actualizar tu perfil de Forger.',
        app: appSummary,
        cloudSynced: false,
        ...failureDiagnostic(error, 'app_rename_cloud_failed'),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.getAppDetails, async (_event, appId: string) => {
    return await getAppDetails(appId);
  });

  ipcMain.handle(IPC_CHANNELS.listAppPrompts, async (_event, appId: string) => {
    return await listAppPrompts(appId);
  });

  ipcMain.handle(IPC_CHANNELS.validateAppPrompt, async (_event, input: AppPromptReviewInput) => {
    return await validateAppPrompt(input);
  });

  ipcMain.handle(IPC_CHANNELS.updateAppPrompt, async (_event, input: AppPromptReviewInput) => {
    return await updateAppPrompt(input);
  });

  ipcMain.handle(IPC_CHANNELS.restoreAppPrompt, async (_event, input: AppPromptRestoreInput) => {
    return await restoreAppPrompt(input);
  });

  ipcMain.handle(IPC_CHANNELS.installWelcome, async (_event, appId: string, userLanguage?: string) => {
    return await installWelcome(appId, userLanguage);
  });

  ipcMain.handle(IPC_CHANNELS.openApp, async (_event, appId: string, locale?: string) => {
    return await openInstalledApp(appId, locale);
  });

  ipcMain.handle(IPC_CHANNELS.stopApp, async (_event, appId: string) => {
    return await stopInstalledApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getAppRuntimeStatus, async (_event, appId: string) => {
    return getRuntimeStatus(appId);
  });

  ipcMain.handle(IPC_CHANNELS.startLocalNetworkShare, async (_event, appId: string) => {
    return await startLocalNetworkShare(appId);
  });

  ipcMain.handle(IPC_CHANNELS.stopLocalNetworkShare, async (_event, appId: string) => {
    return await stopLocalNetworkShare(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getLocalNetworkShareStatus, async (_event, appId: string) => {
    return localNetworkShareStatusFor(appId);
  });

  ipcMain.handle(IPC_CHANNELS.startRemoteNetworkShare, async (_event, appId: string) => {
    return await startRemoteNetworkShare(appId);
  });

  ipcMain.handle(IPC_CHANNELS.stopRemoteNetworkShare, async (_event, appId: string) => {
    return await stopRemoteNetworkShare(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getRemoteNetworkShareStatus, async (_event, appId: string) => {
    return remoteNetworkShareStatusFor(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getRemoteActivity, async () => {
    return remoteActivityFor();
  });

  ipcMain.handle(IPC_CHANNELS.llmRunsSnapshotGet, async () => {
    return llmRunsSnapshotFor();
  });

  ipcMain.handle(IPC_CHANNELS.getAppSecrets, async (_event, appId: string) => {
    return await buildAppSecretsState(appId);
  });

  ipcMain.handle(IPC_CHANNELS.listUserSecrets, async () => {
    return await getSecretsStore().listUserSecrets();
  });

  ipcMain.handle(IPC_CHANNELS.createUserSecret, async (_event, input: CreateUserSecretInput) => {
    return await getSecretsStore().createUserSecret(input);
  });

  ipcMain.handle(IPC_CHANNELS.updateUserSecret, async (_event, input: UpdateUserSecretInput) => {
    return await getSecretsStore().updateUserSecret(input);
  });

  ipcMain.handle(IPC_CHANNELS.deleteUserSecret, async (_event, input: DeleteUserSecretInput) => {
    return await getSecretsStore().deleteUserSecret(input.id);
  });

  ipcMain.handle(IPC_CHANNELS.connectAppSecret, async (_event, input: ConnectAppSecretInput) => {
    const declarations = await resolveInstalledAppSecrets(input.appId);
    if (!declarations.some((secret) => secret.name === input.appSecretName)) {
      return {
        success: false,
        userMessage: 'La app no declara ese secreto.',
        technicalCode: 'app_secret_not_declared',
      };
    }
    return await getSecretsStore().connectAppSecret(input.appId, input.appSecretName, input.userSecretId);
  });

  ipcMain.handle(IPC_CHANNELS.disconnectAppSecret, async (_event, input: DisconnectAppSecretInput) => {
    return await getSecretsStore().disconnectAppSecret(input.appId, input.appSecretName);
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, async () => state.settings);
  ipcMain.handle(IPC_CHANNELS.speechToTextGetState, async () => await getSpeechToTextService().getState());
  ipcMain.handle(IPC_CHANNELS.speechToTextInstall, async () => await getSpeechToTextService().install());
  ipcMain.handle(IPC_CHANNELS.speechToTextStart, async () => await getSpeechToTextService().start());
  ipcMain.handle(IPC_CHANNELS.speechToTextStop, async () => {
    getSpeechToTextService().stop();
    return await getSpeechToTextService().getState();
  });
  ipcMain.handle(IPC_CHANNELS.speechToTextUpdateConfig, async (_event, input: SpeechToTextConfigInput) => {
    return await getSpeechToTextService().updateConfig(input);
  });
  ipcMain.handle(IPC_CHANNELS.speechToTextPickAudio, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'mp4', 'm4a', 'wav', 'webm', 'ogg', 'flac', 'aac'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    const selectedPath = result.filePaths[0];
    if (!result.canceled && selectedPath) {
      await getSpeechToTextService().allowUserSelectedPath(selectedPath);
    }
    return { canceled: result.canceled, path: selectedPath };
  });
  ipcMain.handle(IPC_CHANNELS.speechToTextProcess, async (_event, input: SpeechToTextProcessInput) => {
    return await getSpeechToTextService().process(input, { extraAllowedRoots: [getPrivateDataRoot()] });
  });
  ipcMain.handle(IPC_CHANNELS.speechToTextProcessUpload, async (_event, input: SpeechToTextUploadInput) => {
    return await getSpeechToTextService().processUpload(input);
  });
  ipcMain.handle(IPC_CHANNELS.speechToTextCreateRealtimeSession, async () => {
    return await getSpeechToTextService().createRealtimeSession();
  });
  ipcMain.handle(IPC_CHANNELS.microphonePermissionStatus, async () => {
    return getMicrophonePermissionStatus();
  });
  ipcMain.handle(IPC_CHANNELS.microphonePermissionRequest, async () => {
    return await requestMicrophonePermission();
  });
  registerLiveVoiceInputIpcHandlers({ IPC_CHANNELS, ipcMain, mainWindow, getLiveVoiceInputService });
  registerWakeWordIpcHandlers({ IPC_CHANNELS, ipcMain, mainWindow, getWakeWordService });
  ipcMain.handle(IPC_CHANNELS.textToSpeechGetState, async () => await getTextToSpeechService().getState());
  ipcMain.handle(IPC_CHANNELS.textToSpeechInstall, async () => await getTextToSpeechService().install());
  ipcMain.handle(IPC_CHANNELS.textToSpeechStart, async () => await getTextToSpeechService().start());
  ipcMain.handle(IPC_CHANNELS.textToSpeechStop, async () => {
    getTextToSpeechService().stop();
    return await getTextToSpeechService().getState();
  });
  ipcMain.handle(IPC_CHANNELS.textToSpeechUpdateConfig, async (_event, input: TextToSpeechConfigInput) => {
    return await getTextToSpeechService().updateConfig(input);
  });
  ipcMain.handle(IPC_CHANNELS.textToSpeechSynthesize, async (_event, input: TextToSpeechSynthesizeInput) => {
    return await getTextToSpeechService().synthesize(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateCodexDefaults, async (_event, input: UpdateCodexDefaultsInput) => {
    return await updateCodexDefaults(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateAgentDefaults, async (_event, input: UpdateAgentDefaultsInput) => {
    return await updateAgentDefaults(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateDeveloperMode, async (_event, input: UpdateDeveloperModeInput) => {
    return await updateDeveloperMode(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateAppDeveloperSettings, async (_event, input: UpdateAppDeveloperSettingsInput) => {
    return await updateAppDeveloperSettings(input);
  });
  ipcMain.handle(IPC_CHANNELS.getDeveloperPathState, async (_event, appId?: string) => {
    return await getDeveloperPathState(appId);
  });
  ipcMain.handle(IPC_CHANNELS.memoryList, async (_event, input: MemoryListInput = {}) => {
    return await getMemoryStore().list(input, { caller: 'settings' });
  });
  ipcMain.handle(IPC_CHANNELS.memoryCreate, async (_event, input: MemoryCreateInput) => {
    return await getMemoryStore().create({ ...input, source: 'settings' }, { caller: 'settings' });
  });
  ipcMain.handle(IPC_CHANNELS.memoryUpdate, async (_event, input: MemoryUpdateInput) => {
    return await getMemoryStore().update(input, { caller: 'settings' });
  });
  ipcMain.handle(IPC_CHANNELS.memoryDelete, async (_event, id: string) => {
    return await getMemoryStore().delete(id, { caller: 'settings' });
  });
  ipcMain.handle(IPC_CHANNELS.backgroundTasksList, async () => {
    return await getBackgroundTaskStore().list();
  });
  ipcMain.handle(IPC_CHANNELS.backgroundTaskGet, async (_event, id: string) => {
    return await getBackgroundTaskStore().get(id);
  });
  ipcMain.handle(IPC_CHANNELS.backgroundTasksUpsert, async (_event, input: BackgroundTaskUpsertInput) => {
    return await getBackgroundTaskStore().upsert(input);
  });
  ipcMain.handle(IPC_CHANNELS.getDesktopUpdateState, async () => getDesktopUpdater().getState());
  ipcMain.handle(IPC_CHANNELS.checkDesktopUpdates, async () => await getDesktopUpdater().check());
  ipcMain.handle(IPC_CHANNELS.downloadDesktopUpdate, async () => await getDesktopUpdater().download());
  ipcMain.handle(IPC_CHANNELS.installDesktopUpdate, async () => await getDesktopUpdater().install());
  ipcMain.handle(IPC_CHANNELS.desktopUpdateQuitForInstall, async () => {
    app.quit();
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.getForgerAccount, async () => publicForgerAccount(state.forgerAccount));
  ipcMain.handle(IPC_CHANNELS.registerForgerAccount, async (_event, input: ForgerAccountRegisterInput) => {
    return forgerBackendClient
      ? await forgerBackendClient.registerAccount(input)
      : { success: false, authenticated: false, userMessage: 'No pudimos crear la cuenta.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.loginForgerAccount, async (_event, input: ForgerAccountLoginInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.loginAccount(input)
      : { success: false, authenticated: false, userMessage: 'No pudimos iniciar sesion.', technicalCode: 'backend_client_missing' };
    if (result.success) {
      await switchForgerAccountSession(result, { userMessage: result.userMessage, technicalCode: result.technicalCode });
    }
    state.catalogApps = await listCatalogFromBackend();
    return { ...publicForgerAccount(state.forgerAccount), success: result.success, userMessage: result.userMessage, technicalCode: result.technicalCode };
  });
  ipcMain.handle(IPC_CHANNELS.updateForgerAccountProfile, async (_event, input: ForgerAccountProfileInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.updateAccountProfile(input)
      : { success: false, authenticated: Boolean(state.forgerAccount.token), userMessage: 'No pudimos actualizar tu perfil.', technicalCode: 'backend_client_missing' };
    if (result.success) {
      await switchForgerAccountSession({ ...state.forgerAccount, ...result, token: state.forgerAccount.token }, {
        userMessage: result.userMessage,
        technicalCode: result.technicalCode,
      });
    }
    return { ...publicForgerAccount(state.forgerAccount), success: result.success, userMessage: result.userMessage, technicalCode: result.technicalCode };
  });
  ipcMain.handle(IPC_CHANNELS.logoutForgerAccount, async () => {
    await forgerBackendClient?.logoutAccount().catch(() => undefined);
    const account = await switchForgerAccountSession({ authenticated: false });
    state.catalogApps = await listCatalogFromBackend();
    return { ...account, success: true };
  });
  ipcMain.handle(IPC_CHANNELS.getCloudStorageUsage, async () => {
    return forgerBackendClient ? await forgerBackendClient.getCloudStorageUsage() : null;
  });
  ipcMain.handle(IPC_CHANNELS.getCloudDevices, async () => {
    return cloudDeviceManager ? await cloudDeviceManager.getState() : { devices: [], connected: false };
  });
  ipcMain.handle(IPC_CHANNELS.registerCloudDevice, async (_event, input: { name?: string }) => {
    return cloudDeviceManager
      ? await cloudDeviceManager.registerCloudDevice({ name: input?.name ?? '' })
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos registrar este equipo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.updateCloudDeviceName, async (_event, input: { name?: string }) => {
    return cloudDeviceManager
      ? await cloudDeviceManager.updateCloudDeviceName({ name: input?.name ?? '' })
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos actualizar este equipo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.unlinkMobileDeviceFromDesktop, async (_event, authorizationId: number) => {
    return cloudDeviceManager
      ? await cloudDeviceManager.unlinkMobileDeviceFromDesktop(authorizationId)
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos desvincular el dispositivo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.generateDevicePairingCode, async () => {
    return cloudDeviceManager
      ? await cloudDeviceManager.generatePairingCode()
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos preparar este equipo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.acceptMobilePairingRequest, async (_event, requestId: number) => {
    return cloudDeviceManager
      ? await cloudDeviceManager.acceptMobilePairingRequest(requestId)
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos aceptar la solicitud.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.rejectMobilePairingRequest, async (_event, requestId: number) => {
    return cloudDeviceManager
      ? await cloudDeviceManager.rejectMobilePairingRequest(requestId)
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos rechazar la solicitud.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.deleteMobilePairingRequest, async (_event, requestId: number) => {
    return cloudDeviceManager
      ? await cloudDeviceManager.deleteMobilePairingRequest(requestId)
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos eliminar la solicitud.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.listFriends, async () => {
    return forgerBackendClient ? await forgerBackendClient.listFriends() : [];
  });
  ipcMain.handle(IPC_CHANNELS.listMySocialApps, async () => {
    return forgerBackendClient ? await forgerBackendClient.listMySocialApps() : { apps: [] };
  });
  ipcMain.handle(IPC_CHANNELS.updateSocialApp, async (_event, input: SocialUserAppUpdateInput) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.updateSocialApp(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateSocialAppVisibility, async (_event, userAppId: number, visibility: Exclude<SocialUserAppVisibility, 'restricted'>) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.updateSocialAppVisibility(userAppId, visibility);
  });
  ipcMain.handle(IPC_CHANNELS.deleteSocialApp, async (_event, userAppId: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.deleteSocialApp(userAppId);
  });
  ipcMain.handle(IPC_CHANNELS.uploadSocialApp, async (_event, input: SocialUserAppUploadInput) => {
    const startedAt = new Date().toISOString();
    const taskId = `social-upload:${input.appId}:${Date.now()}`;
    const record = registry.apps[input.appId];
    const isRemixUpload = Boolean(record?.socialSource);
    const appName = input.name?.trim() || record?.name || input.appId;
    const taskStore = getBackgroundTaskStore();
    await taskStore.upsert({
      id: taskId,
      source: 'social-upload',
      title: `Subiendo ${appName} a Social`,
      status: 'queued',
      app: { id: input.appId, name: appName },
      relatedEntity: { kind: 'social-upload', id: input.appId },
      statusUpdates: [{ message: 'Preparando app', status: 'queued', createdAt: startedAt }],
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    if (!forgerBackendClient) {
      await taskStore.upsert({
        id: taskId,
        source: 'social-upload',
        title: `Subiendo ${appName} a Social`,
        status: 'failed',
        result: {
          status: 'error',
          message: 'Inicia sesion en Forger Cloud para subir apps a Social.',
          technicalCode: 'backend_client_missing',
        },
        completedAt: new Date().toISOString(),
      });
      return { success: false, userMessage: 'Inicia sesion en Forger Cloud para subir apps a Social.', technicalCode: 'backend_client_missing' };
    }
    if (!record?.installDir || (!record.privateLocal && !record.socialSource)) {
      await taskStore.upsert({
        id: taskId,
        source: 'social-upload',
        title: `Subiendo ${appName} a Social`,
        status: 'failed',
        result: {
          status: 'error',
          message: 'Solo puedes subir a Social apps tuyas o remixes de apps compartidas.',
          technicalCode: 'social_upload_not_owned_or_remixable',
        },
        completedAt: new Date().toISOString(),
      });
      return { success: false, userMessage: 'Solo puedes subir a Social apps tuyas o remixes de apps compartidas.', technicalCode: 'social_upload_not_owned_or_remixable' };
    }
    const manifest = await resolveInstalledManifest(record.installDir);
    const uploadRoot = path.join(os.tmpdir(), `forger-social-upload-${input.appId}-${Date.now()}`);
    const stageDir = path.join(uploadRoot, input.appId);
    const zipPath = path.join(os.tmpdir(), `forger-social-upload-${input.appId}-${Date.now()}.zip`);
    try {
      await taskStore.appendStatusUpdate(taskId, { message: 'Preparando app', status: 'running' });
      await fs.rm(uploadRoot, { recursive: true, force: true });
      await fs.rm(zipPath, { force: true });
      await fs.mkdir(stageDir, { recursive: true });
      await fs.cp(record.installDir, stageDir, {
        recursive: true,
        filter: (sourcePath) => !shouldSkipSocialUploadPath(sourcePath, record.installDir, path),
      });
      await taskStore.appendStatusUpdate(taskId, { message: 'Comprimiendo app', status: 'running' });
      await zipDirectory(uploadRoot, zipPath);
      await validateArchiveEntries(zipPath);
      await taskStore.appendStatusUpdate(taskId, { message: 'Subiendo a Social', status: 'running' });
      const appEntry = await forgerBackendClient.uploadSocialApp({
        zipPath,
        name: appName,
        slug: input.slug?.trim() || (isRemixUpload ? slugifySocialUpload(appName) : input.appId),
        description: record.description,
        shortDescription: record.description,
        longDescription: input.longDescription ?? record.longDescription ?? record.description,
        category: input.category
          || (manifest && typeof (manifest.catalog as { category?: unknown } | null)?.category === 'string'
          ? (manifest.catalog as { category: string }).category
          : 'productivity'),
        visibility: input.visibility,
        remixSourceUserAppId: record.socialSource?.userAppId,
        onProgress: async (message) => {
          await taskStore.appendStatusUpdate(taskId, { message, status: 'running' });
        },
      });
      await taskStore.appendStatusUpdate(taskId, { message: 'Creando link para compartir', status: 'running' });
      const share = await forgerBackendClient.createSocialAppShare(appEntry.id).catch(() => undefined);
      const message = share?.deepLink ? `App subida a Social. ${share.deepLink}` : 'App subida a Social.';
      await taskStore.upsert({
        id: taskId,
        source: 'social-upload',
        title: `Subiendo ${appName} a Social`,
        status: 'succeeded',
        result: { status: 'success', message, details: { userAppId: appEntry.id, deepLink: share?.deepLink } },
        relatedEntity: { kind: 'social-upload', id: input.appId, secondaryId: String(appEntry.id) },
        completedAt: new Date().toISOString(),
      });
      if (registry.apps[input.appId]) {
        await upsertInstalledRecord({
          ...registry.apps[input.appId],
          name: appEntry.name || appName,
          publishedSocialSource: {
            userAppId: appEntry.id,
            slug: appEntry.slug || input.appId,
            ownerUsername: appEntry.owner.username,
          },
        });
        state.catalogApps = state.catalogApps.map((entry) => entry.id === input.appId ? { ...entry, name: appEntry.name || appName } : entry);
      }
      return { success: true, app: appEntry, share, userMessage: 'App subida a Social.' };
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'social_upload_failed');
      await taskStore.upsert({
        id: taskId,
        source: 'social-upload',
        title: `Subiendo ${appName} a Social`,
        status: 'failed',
        result: {
          status: 'error',
          message: 'No pudimos subir la app a Social.',
          technicalCode: typeof diagnostic.technicalCode === 'string' ? diagnostic.technicalCode : 'social_upload_failed',
          details: typeof diagnostic.details === 'object' && diagnostic.details ? diagnostic.details as Record<string, unknown> : undefined,
        },
        completedAt: new Date().toISOString(),
      });
      return { success: false, userMessage: 'No pudimos subir la app a Social.', ...diagnostic };
    } finally {
      await fs.rm(uploadRoot, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(zipPath, { force: true }).catch(() => undefined);
    }
  });
  ipcMain.handle(IPC_CHANNELS.createSocialAppShare, async (_event, userAppId: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.createSocialAppShare(userAppId);
  });
  ipcMain.handle(IPC_CHANNELS.resolveSocialCode, async (_event, code: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.resolveSocialCode(code);
  });
  ipcMain.handle(IPC_CHANNELS.resolveSocialApp, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.resolveSocialApp(id);
  });
  ipcMain.handle(IPC_CHANNELS.prepareSocialAppReview, async (_event, input: PrepareSocialAppReviewInput, locale?: string) => {
    return await prepareSocialAppReview(input, locale);
  });
  ipcMain.handle(IPC_CHANNELS.finishSocialAppInstall, async (_event, input: { quarantineId: string }, locale?: string) => {
    return await finishSocialAppInstall(input, locale);
  });
  ipcMain.handle(IPC_CHANNELS.deleteQuarantinedSocialApp, async (_event, input: { quarantineId: string }, locale?: string) => {
    return await deleteQuarantinedSocialApp(input, locale);
  });
  ipcMain.handle(IPC_CHANNELS.getSocialProfile, async (_event, username: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.getSocialProfile(username);
  });
  ipcMain.handle(IPC_CHANNELS.getSocialProfileUrl, async (_event, username: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return forgerBackendClient.socialProfileUrl(username);
  });
  ipcMain.handle(IPC_CHANNELS.installSocialApp, async (_event, input: { appId?: number; appSlug?: string; shareCode?: string; trustDecision?: 'not_reviewed' | 'reviewed' | 'skipped_review' }, locale?: string) => {
    return await installSocialAppRuntime(input, locale);
  });
  ipcMain.handle(IPC_CHANNELS.searchFriends, async (_event, username: string) => {
    return forgerBackendClient ? await forgerBackendClient.searchFriends(username) : [];
  });
  ipcMain.handle(IPC_CHANNELS.sendFriendRequest, async (_event, username: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.sendFriendRequest(username);
  });
  ipcMain.handle(IPC_CHANNELS.acceptFriendRequest, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.acceptFriendRequest(id);
  });
  ipcMain.handle(IPC_CHANNELS.declineFriendRequest, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.declineFriendRequest(id);
  });
  ipcMain.handle(IPC_CHANNELS.cancelFriendRequest, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.cancelFriendRequest(id);
  });
  ipcMain.handle(IPC_CHANNELS.markFriendChatRead, async (_event, friendUserId: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    const friendship = await forgerBackendClient.markFriendChatRead(friendUserId);
    forwardCloudSocialEvent({ type: 'friendship_changed', friendship });
    return friendship;
  });
  ipcMain.handle(IPC_CHANNELS.openFriendChatWindow, async (_event, friendship: CloudFriendship) => {
    return await openOrFocusFriendChatWindow(friendship);
  });
  ipcMain.handle(IPC_CHANNELS.listCloudMessages, async (_event, friendUserId: number) => {
    return await listLocalCloudMessages(friendUserId);
  });
  ipcMain.handle(IPC_CHANNELS.sendCloudMessage, async (_event, input: CloudSendMessageInput) => {
    return await sendEncryptedCloudMessage(input);
  });
  ipcMain.handle(IPC_CHANNELS.sendCloudAppShareMessage, async (_event, input: CloudSendAppShareInput) => {
    return await sendEncryptedCloudAppShareMessage(input);
  });
  ipcMain.handle(IPC_CHANNELS.decideAppMessagePermission, async (_event, cloudMessageId: number, decision: CloudAppMessagePermissionDecision) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await decryptCloudMessage(await forgerBackendClient.decideAppMessagePermission(cloudMessageId, decision));
  });
  ipcMain.handle(IPC_CHANNELS.getForumParticipation, async () => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.getForumParticipation();
  });
  ipcMain.handle(IPC_CHANNELS.updateForumParticipation, async (_event, action: 'mark_prompt_shown' | 'opt_in' | 'opt_out') => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.updateForumParticipation(action);
  });
  ipcMain.handle(IPC_CHANNELS.listForumPosts, async (_event, limit?: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.listForumPosts(limit);
  });
  ipcMain.handle(IPC_CHANNELS.getForumPost, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.getForumPost(id);
  });
  ipcMain.handle(IPC_CHANNELS.createForumPost, async (_event, body: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.createForumPost(body);
  });
  ipcMain.handle(IPC_CHANNELS.createForumComment, async (_event, postId: number, body: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.createForumComment(postId, body);
  });
  ipcMain.handle(IPC_CHANNELS.replyForumComment, async (_event, commentId: number, body: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.replyForumComment(commentId, body);
  });
  ipcMain.handle(IPC_CHANNELS.deleteForumPost, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.deleteForumPost(id);
  });
  ipcMain.handle(IPC_CHANNELS.deleteForumComment, async (_event, id: number) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.deleteForumComment(id);
  });
  ipcMain.handle(IPC_CHANNELS.moderateForumPost, async (_event, id: number, action: 'hide' | 'unhide', reason?: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.moderateForumPost(id, action, reason);
  });
  ipcMain.handle(IPC_CHANNELS.moderateForumComment, async (_event, id: number, action: 'hide' | 'unhide', reason?: string) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await forgerBackendClient.moderateForumComment(id, action, reason);
  });
  ipcMain.handle(IPC_CHANNELS.getCloudIdentity, async () => await getCloudIdentityStore().getSummary());
  ipcMain.handle(IPC_CHANNELS.revealCloudSecretKey, async () => await getCloudIdentityStore().revealSecretKey());
  ipcMain.handle(IPC_CHANNELS.regenerateCloudSecretKey, async () => {
    const identity = await getCloudIdentityStore().regenerate();
    await cloudDeviceManager?.start();
    return identity;
  });
  ipcMain.handle(IPC_CHANNELS.submitAppRating, async (_event, input: SubmitAppRatingInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.submitAppRating(input)
      : { success: false, userMessage: 'No pudimos guardar tu review.', technicalCode: 'backend_client_missing' };
    state.catalogApps = await listCatalogFromBackend();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.submitProductFeedback, async (_event, input: SubmitProductFeedbackInput) => {
    return forgerBackendClient
      ? await forgerBackendClient.submitProductFeedback(input)
      : { success: false, userMessage: 'No pudimos enviar el feedback.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.submitUsageEvent, async (_event, input: SubmitUsageEventInput) => {
    const eventInput: SubmitUsageEventInput = {
      ...input,
      desktopVersion: input.desktopVersion || app.getVersion(),
      platform: input.platform || process.platform,
      occurredAt: input.occurredAt || new Date().toISOString(),
    };
    return forgerBackendClient
      ? await forgerBackendClient.submitUsageEvent(eventInput)
      : { success: false, userMessage: 'No pudimos enviar la métrica de uso.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.prepareDesktopErrorReport, async (_event, input: DesktopErrorReportPreview) => {
    const roots = desktopErrorReportRoots(input.appId);
    const { report, attachments } = await prepareDesktopErrorReport({
      fs,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      getInstallLogPath,
      getDesktopLogPath,
      getMetadataRoot: getForgerMetadataRoot,
      roots,
    }, input);
    if (attachments.length === 0) {
      return report;
    }
    const diagnosticAttachmentToken = randomUUID();
    desktopErrorReportAttachmentCache.set(diagnosticAttachmentToken, attachments);
    return {
      ...report,
      diagnosticAttachmentToken,
    };
  });
  ipcMain.handle(IPC_CHANNELS.submitDesktopErrorReport, async (_event, input: DesktopErrorReportPreview) => {
    const roots = desktopErrorReportRoots(input.appId);
    const cachedAttachments = input.diagnosticAttachmentToken
      ? desktopErrorReportAttachmentCache.get(input.diagnosticAttachmentToken) ?? []
      : [];
    const { report, attachments: preparedAttachments } = await prepareDesktopErrorReport({
      fs,
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      getInstallLogPath,
      getDesktopLogPath,
      getMetadataRoot: getForgerMetadataRoot,
      roots,
    }, input);
    const attachments = cachedAttachments.length > 0 ? cachedAttachments : preparedAttachments;
    try {
      return forgerBackendClient
        ? await forgerBackendClient.submitDesktopErrorReport(report, attachments)
        : { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode: 'backend_client_missing' };
    } finally {
      if (input.diagnosticAttachmentToken) {
        desktopErrorReportAttachmentCache.delete(input.diagnosticAttachmentToken);
      }
    }
  });
  ipcMain.handle(IPC_CHANNELS.prepareConversationDiagnosticReport, async (_event, input: PrepareConversationDiagnosticReportInput) => {
    const options = {
      appVersion: app.getVersion(),
      platform: process.platform,
      getUserDataPath: () => app.getPath('userData'),
      getForgerHomeRoot,
      getPrivateAppsRoot,
      getPrivateDataRoot,
      getForgerMetadataRoot,
      getCodexHome,
      getInstalledAppVersion: (appId: string) => registry.apps[appId]?.version,
      getConversationManager: () => appAgentConversationManager,
    };
    const report = await buildConversationDiagnosticReport(options, input);
    const attachments = await buildConversationDiagnosticAttachments(options, input);
    if (attachments.length === 0) {
      return report;
    }
    const diagnosticAttachmentToken = randomUUID();
    const diagnosticFiles = summarizeConversationDiagnosticAttachments(attachments);
    conversationDiagnosticAttachmentCache.set(diagnosticAttachmentToken, attachments);
    return {
      ...report,
      diagnosticAttachmentToken,
      diagnosticFiles,
      payload: {
        ...report.payload,
        diagnosticFiles,
      },
    };
  });
  ipcMain.handle(IPC_CHANNELS.submitConversationDiagnosticReport, async (_event, input: ConversationDiagnosticReportPreview) => {
    if (!forgerBackendClient) {
      return { success: false, userMessage: 'No pudimos enviar el reporte de conversación.', technicalCode: 'backend_client_missing' };
    }
    const attachments = input.diagnosticAttachmentToken
      ? conversationDiagnosticAttachmentCache.get(input.diagnosticAttachmentToken) ?? []
      : [];
    try {
      return await forgerBackendClient.submitConversationDiagnosticReport(input, attachments);
    } finally {
      if (input.diagnosticAttachmentToken) {
        conversationDiagnosticAttachmentCache.delete(input.diagnosticAttachmentToken);
      }
    }
  });
  ipcMain.handle(IPC_CHANNELS.desktopLog, async (_event, input: unknown) => {
    if (!isRecord(input) || typeof input.event !== 'string' || !input.event.trim()) {
      return { success: false };
    }
    await appendDesktopLog({
      metadataRoot: typeof getForgerMetadataRoot === 'function' ? getForgerMetadataRoot() : path.dirname(getInstallLogPath()),
      level: isDesktopLogLevel(input.level) ? input.level : 'info',
      service: 'desktop-renderer',
      event: input.event.trim(),
      ...(typeof input.message === 'string' ? { message: input.message } : {}),
      ...(isRecord(input.context) ? { context: input.context } : {}),
    });
    return { success: true };
  });
  registerExternalUrlIpcHandlers({ IPC_CHANNELS, failureDiagnostic, fs, ipcMain, path, shell });
  registerProviderAuthIpcHandlers({
    IPC_CHANNELS,
    CODEX_USAGE_DASHBOARD_URL,
    fs,
    ipcMain,
    path,
    shell,
    getMainWindow: () => mainWindow,
    getForgerMetadataRoot,
    getCodexAuthStatus,
    getClaudeAuthStatus,
    getAntigravityAuthStatus,
    listLlmProviderProfiles,
    setActiveLlmProviderProfile,
    updateLlmProviderProfileDefaults,
    connectCodexAuth,
    disconnectCodexAuth,
    reinstallCodex,
    confirmClaudeAuthConnection,
    connectClaudeAuth,
    disconnectClaudeAuth,
    signOutClaudeAuth,
    reinstallClaude,
    connectAntigravityAuth,
    startAntigravityAuthSession,
    writeAntigravityAuthSession,
    cancelAntigravityAuthSession,
    disconnectAntigravityAuth,
    reinstallAntigravity,
    failureDiagnostic,
  });
  ipcMain.handle(IPC_CHANNELS.listAgentTools, async (_event, locale?: string) => getAgentToolPackages(locale));
  ipcMain.handle(IPC_CHANNELS.getAgentToolSettings, async () => state.agentToolSettings);
  ipcMain.handle(IPC_CHANNELS.updateAgentToolApproval, async (_event, input: UpdateAgentToolApprovalInput) => {
    return await updateAgentToolApproval(input);
  });
  ipcMain.handle(IPC_CHANNELS.listOfficialTools, async (_event, locale?: string) => await getOfficialToolsService().list(locale));
  ipcMain.handle(IPC_CHANNELS.refreshOfficialTools, async (_event, locale?: string) => await getOfficialToolsService().refresh(locale));
  ipcMain.handle(IPC_CHANNELS.activateOfficialTool, async (_event, toolId: string, locale?: string) => {
    return await getOfficialToolsService().activate(toolId, locale);
  });
  ipcMain.handle(IPC_CHANNELS.configureOfficialTool, async (_event, input: ConfigureOfficialToolInput) => {
    return await getOfficialToolsService().configure(input);
  });
  ipcMain.handle(IPC_CHANNELS.callOfficialTool, async (_event, input: CallOfficialToolInput) => {
    return await getOfficialToolsService().callFromAgent(input);
  });
  ipcMain.handle(IPC_CHANNELS.deactivateOfficialTool, async (_event, toolId: string, locale?: string) => {
    return await getOfficialToolsService().deactivate(toolId, { locale });
  });
  registerConnectionIpcHandlers({ IPC_CHANNELS, ipcMain, getConnectionsService });
  ipcMain.handle(IPC_CHANNELS.getAppToolsInstallGate, async (_event, appId: string, locale?: string, options?: GetAppToolsInstallGateOptions): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().getInstallGate(appId, locale, options);
  });
  ipcMain.handle(IPC_CHANNELS.setAppToolGrant, async (_event, input: SetAppToolGrantInput, locale?: string): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().setAppToolGrant(input, locale);
  });
  registerChatIpcHandlers({
    IPC_CHANNELS,
    appendInstallLog,
    buildCodexPromptWithAppContext,
    buildForgerToolsContextForApp,
    buildForgerToolsContextForFreeChat,
    chatOrchestrator,
    defaultChatNetworkAccess: state.settings.defaultChatNetworkAccess,
    ensurePathInside,
    fs,
    getPrivateDataRoot,
    getSocialAppReviewPromptContext: async (appId: string) => {
      const context = await getSocialAppReviewPromptContext(appId);
      return context && typeof context === 'object' && !Array.isArray(context)
        ? context as Record<string, unknown>
        : null;
    },
    installedAppPromptContext,
    ipcMain,
    path,
    resolveSelectedAppDisplayName,
    sanitizeRendererChatTrace,
  });

  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog,
    getFileLibrary,
    ipcMain,
    mainWindow,
  });

  registerPersonalAgentIpcHandlers({
    IPC_CHANNELS,
    ensurePathInside,
    fs,
    getPrivateDataRoot,
    getPersonalAgentConversationManager,
    getPersonalAgentRoutineManager,
    getPersonalAgentStore,
    ipcMain,
    path,
    isAgentProviderConnected: async (provider: AgentProvider) => {
      if (provider === 'claude') {
        return Boolean((await getClaudeAuthStatus() as { authenticated?: boolean }).authenticated);
      }
      if (provider === 'antigravity') {
        return Boolean((await getAntigravityAuthStatus() as { authenticated?: boolean }).authenticated);
      }
      return Boolean((await getCodexAuthStatus()).authenticated);
    },
    listInstalledApps: () => Object.values(registry.apps).map((record) => toAppSummary(record)) as AppSummary[],
    listOfficialTools: async () => await getOfficialToolsService().list(),
    listConnections: async () => await getConnectionsService().listState(),
  });

  registerAppRuntimeIpcHandlers({
    APP_CLAUDE_MODEL_OPTIONS,
    APP_CODEX_MODEL_OPTIONS,
    BrowserWindow,
    IPC_CHANNELS,
    dialog,
    fs,
    getCodexAuthStatus,
    getOfficialToolsService,
    ipcMain,
    normalizeManifestAgentDefaults,
    registry,
    resolveAppIdForWebContents,
    resolveInstalledAgents,
    resolveInstalledManifest,
    signAppFolderGrant,
  });

  registerAppCloudMessagingIpcHandlers({
    IPC_CHANNELS,
    listLocalCloudMessages,
    ipcMain,
    registry,
    resolveAppIdForWebContents,
    resolveInstalledManifest,
    sendEncryptedCloudMessage,
  });
};
