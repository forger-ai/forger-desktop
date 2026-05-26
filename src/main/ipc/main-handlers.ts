import type fs from 'node:fs/promises';
import type path from 'node:path';
import os from 'node:os';
import type * as Electron from 'electron';
import { BrowserWindow, type IpcMain } from 'electron';
import { AGENT_TOOL_PACKAGES } from '../core/agent-tool-packages';
import { buildCodexPromptForFreeChat } from '../prompt-builder/user-message';
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
import type { OfficialToolsService } from '../official-tools-service';
import type { SecretsStore } from '../secrets-store';
import { buildConversationDiagnosticReport } from '../conversation-diagnostics';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import { registerAppCloudMessagingIpcHandlers } from './app-cloud-messaging-handlers';
import { registerAppRuntimeIpcHandlers } from './app-runtime-handlers';
import { registerFileLibraryIpcHandlers } from './file-library-handlers';
import { RENDERER_CHAT_TRACE_EVENTS } from './renderer-chat-trace-events';
import type {
  AgentDefaults,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppAgent,
  AppExternalFolderSelection,
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
  ChatApplyRunInput,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatGetRunInput,
  ChatStartRunInput,
  ChatUndoInput,
  CloudAppMessagePermissionDecision,
  CloudFriendship,
  CloudMessage,
  CloudSendMessageInput,
  CloudSyncSettings,
  ConfigureOfficialToolInput,
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
  ForgerAccountLoginInput,
  ForgerAccountProfileInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  FriendChatWindowOpenResult,
  InstallAppResult,
  InstallWelcomeResult,
  MemoryCreateInput,
  MemoryListInput,
  MemoryUpdateInput,
  OpenAppResult,
  PrepareConversationDiagnosticReportInput,
  RendererChatTraceEvent,
  RuntimeStatus,
  SetAppToolGrantInput,
  Settings,
  SharedFileRef,
  StopAppResult,
  SocialUserAppUploadInput,
  SubmitAppRatingInput,
  SubmitProductFeedbackInput,
  SubmitUsageEventInput,
  UpdateAgentDefaultsInput,
  UpdateAgentToolApprovalInput,
  UpdateCodexDefaultsInput,
  UpdateUserSecretInput,
} from '../../shared/types';
import type { AppManifest, AppRegistry, InstalledAppRecord } from '../core/main-process-types';

interface MainIpcState {
  agentToolSettings: AgentToolSettings;
  catalogApps: CatalogApp[];
  cloudSyncSettings: CloudSyncSettings;
  forgerAccount: StoredForgerAccount;
  localCatalogJsonUrl?: string | null;
  settings: Settings;
}

interface MainProcessIpcDeps {
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
  connectClaudeAuth: () => Promise<unknown>;
  connectCodexAuth: () => Promise<unknown>;
  createRemoteAppBackup: (input: CreateRemoteAppBackupInput) => Promise<CreateRemoteAppBackupResult>;
  decryptCloudMessage: (message: CloudMessage) => Promise<CloudMessage>;
  decryptCloudMessages: (messages: CloudMessage[]) => Promise<CloudMessage[]>;
  desktopErrorReporter: DesktopErrorReporter | null;
  dialog: typeof Electron.dialog;
  disconnectCodexAuth: () => Promise<unknown>;
  ensureCatalogStatuses: () => void;
  failureDiagnostic: (error: unknown, fallbackCode: string) => Record<string, unknown>;
  forgerBackendClient: ForgerBackendClient | null;
  forwardCloudSocialEvent: (event: { type: 'friendship_changed'; friendship: CloudFriendship }) => void;
  fs: typeof fs;
  getAppDetails: (appId: string) => Promise<unknown>;
  getBackupsManager: () => BackupsManager;
  getBackgroundTaskStore: () => BackgroundTaskStore;
  getClaudeAuthStatus: () => Promise<unknown>;
  getCloudIdentityStore: () => CloudIdentityStore;
  getCodexAuthStatus: () => Promise<{ authenticated: boolean }>;
  getCodexHome: () => string;
  getDesktopUpdater: () => DesktopUpdater;
  getFileLibrary: () => FileLibrary;
  getForgerHomeRoot: () => string;
  getForgerMetadataRoot: () => string;
  getInstallLogPath: () => string;
  getMemoryStore: () => MemoryStore;
  getOfficialToolsService: () => OfficialToolsService;
  getPrivateAppsRoot: () => string;
  getPrivateDataRoot: () => string;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  getLocalNetworkShareStatus?: (appId: string) => RuntimeStatus['localNetworkShare'];
  getRemoteNetworkShareStatus?: (appId: string) => RuntimeStatus['remoteNetworkShare'];
  getSecretsStore: () => SecretsStore;
  installAppRuntime: (appId: string, locale?: string) => Promise<InstallAppResult>;
  installSocialAppRuntime: (input: { appId?: number; appSlug?: string; shareCode?: string; trustDecision?: 'not_reviewed' | 'reviewed' | 'skipped_review' }, locale?: string) => Promise<InstallAppResult & { appId?: string }>;
  createLocalAppFromSkeleton: (input: CreateLocalAppInput, locale?: string) => Promise<CreateLocalAppResult>;
  installWelcome: (appId: string, userLanguage?: string) => Promise<InstallWelcomeResult>;
  ipcMain: IpcMain;
  listAppPrompts: (appId: string) => Promise<AppPromptReviewItem[]>;
  listCatalogFromBackend: () => Promise<CatalogApp[]>;
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
  sendEncryptedCloudMessage: (input: CloudSendMessageInput) => Promise<CloudMessage>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  setAppAutoSyncSetting: (appId: string, autoSync: boolean) => Promise<CloudSyncSettings>;
  shell: typeof Electron.shell;
  signAppFolderGrant: (appId: string, folderPath: string) => AppExternalFolderSelection;
  stopInstalledApp: (appId: string) => Promise<StopAppResult>;
  switchForgerAccountSession: (account: StoredForgerAccount, result?: { userMessage?: string; technicalCode?: string }) => Promise<ForgerAccountSession>;
  toAppSummary: (record: InstalledAppRecord) => unknown;
  uninstallAppRuntime: (appId: string) => Promise<BasicActionResult>;
  updateAgentDefaults: (input: UpdateAgentDefaultsInput) => Promise<Settings>;
  updateAgentToolApproval: (input: UpdateAgentToolApprovalInput) => Promise<Settings>;
  updateAppPrompt: (input: AppPromptReviewInput) => Promise<AppPromptMutationResult>;
  updateAppRuntime: (appId: string, locale?: string) => Promise<InstallAppResult>;
  updateCodexDefaults: (input: UpdateCodexDefaultsInput) => Promise<Settings>;
  validateArchiveEntries: (archivePath: string) => Promise<void>;
  validateAppPrompt: (input: AppPromptReviewInput) => Promise<AppPromptValidationResult>;
  zipDirectory: (sourceDir: string, zipPath: string) => Promise<void>;
}

const MAX_APP_ERROR_LOG_BYTES = 512 * 1024;
const MAX_APP_ERROR_LOG_LINES = 80;
const MAX_APP_ERROR_LOG_LINE_CHARS = 8_000;

const truncateLogLine = (line: string): string => {
  if (line.length <= MAX_APP_ERROR_LOG_LINE_CHARS) {
    return line;
  }
  return `${line.slice(0, MAX_APP_ERROR_LOG_LINE_CHARS)}...[truncated ${line.length - MAX_APP_ERROR_LOG_LINE_CHARS} chars]`;
};

const readRecentAppInstallLogLines = async (input: {
  fs: typeof fs;
  getInstallLogPath: () => string;
  appId: string;
}): Promise<{ source: 'install.log'; bytesRead: number; truncatedFromStart: boolean; lines: string[] } | null> => {
  const logPath = input.getInstallLogPath();
  let handle: fs.FileHandle | null = null;
  try {
    const stats = await input.fs.stat(logPath);
    const bytesToRead = Math.min(stats.size, MAX_APP_ERROR_LOG_BYTES);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    handle = await input.fs.open(logPath, 'r');
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    const rawLines = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const candidateLines = start > 0 ? rawLines.slice(1) : rawLines;
    const lines: string[] = [];
    for (let index = candidateLines.length - 1; index >= 0 && lines.length < MAX_APP_ERROR_LOG_LINES; index -= 1) {
      const line = candidateLines[index];
      try {
        const parsed = JSON.parse(line) as { appId?: unknown };
        if (parsed.appId === input.appId) {
          lines.push(truncateLogLine(line));
        }
      } catch {
        // Ignore partial or non-JSON log lines; install.log is best-effort diagnostics.
      }
    }
    if (lines.length === 0) {
      return null;
    }
    return {
      source: 'install.log',
      bytesRead,
      truncatedFromStart: start > 0,
      lines: lines.reverse(),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

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

const enrichAppErrorReportWithInstallLog = async (input: {
  fs: typeof fs;
  getInstallLogPath: () => string;
  input: DesktopErrorReportPreview;
}): Promise<DesktopErrorReportPreview> => {
  if (input.input.source !== 'app' || !input.input.appId || input.input.sensitiveDetails?.appInstallLogExcerpt) {
    return input.input;
  }
  const appInstallLogExcerpt = await readRecentAppInstallLogLines({
    fs: input.fs,
    getInstallLogPath: input.getInstallLogPath,
    appId: input.input.appId,
  });
  if (!appInstallLogExcerpt) {
    return input.input;
  }
  return {
    ...input.input,
    sensitiveDetails: {
      ...(input.input.sensitiveDetails ?? {}),
      appInstallLogExcerpt,
    },
  };
};

export const __testMainHandlersInternals = {
  enrichAppErrorReportWithInstallLog,
  readRecentAppInstallLogLines,
};

export const registerMainIpcHandlers = (deps: MainProcessIpcDeps): void => {
  const { state, APP_CLAUDE_MODEL_OPTIONS, APP_CODEX_MODEL_OPTIONS, BetterSqlite3, BrowserWindow, CODEX_USAGE_DASHBOARD_URL, IPC_CHANNELS, app, appAgentConversationManager, appendInstallLog, buildAppSecretsState, buildCodexPromptWithAppContext, buildForgerToolsContextForApp, buildForgerToolsContextForFreeChat, canUseCloudDataSync, chatOrchestrator, cloudDeviceManager, connectClaudeAuth, connectCodexAuth, createLocalAppFromSkeleton, createRemoteAppBackup, decryptCloudMessage, decryptCloudMessages, dialog, disconnectCodexAuth, ensureCatalogStatuses, failureDiagnostic, forgerBackendClient, forwardCloudSocialEvent, fs, getAppDetails, getBackupsManager, getBackgroundTaskStore, getClaudeAuthStatus, getCloudIdentityStore, getCodexAuthStatus, getCodexHome, getDesktopUpdater, getFileLibrary, getForgerHomeRoot, getForgerMetadataRoot, getInstallLogPath, getMemoryStore, getOfficialToolsService, getPrivateAppsRoot, getPrivateDataRoot, getRuntimeStatus, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getSecretsStore, installAppRuntime, installSocialAppRuntime, installWelcome, ipcMain, listAppPrompts, listCatalogFromBackend, mainWindow, normalizeManifestAgentDefaults, openInstalledApp, startLocalNetworkShare, stopLocalNetworkShare, startRemoteNetworkShare, stopRemoteNetworkShare, openOrFocusFriendChatWindow, path, publicForgerAccount, registry, reinstallClaude, reinstallCodex, resolveAppIdForWebContents, resolveInstalledAgents, resolveInstalledAppSecrets, resolveInstalledManifest, resolveSelectedAppDisplayName, restoreAppPrompt, restoreAppUserVersionRuntime, restoreRemoteAppBackup, sanitizeRendererChatTrace, sendEncryptedCloudMessage, serializeErrorForInstallLog, setAppAutoSyncSetting, shell, signAppFolderGrant, stopInstalledApp, switchForgerAccountSession, toAppSummary, uninstallAppRuntime, updateAgentDefaults, updateAgentToolApproval, updateAppPrompt, updateAppRuntime, updateCodexDefaults, validateArchiveEntries, validateAppPrompt, zipDirectory } = deps;
  const localNetworkShareStatusFor = getLocalNetworkShareStatus ?? (() => undefined);
  const remoteNetworkShareStatusFor = getRemoteNetworkShareStatus ?? (() => undefined);
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
  const toPosixRelativePath = (value: string): string => value.replace(/\\/g, '/');
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
      : { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.', technicalCode: 'subscription_required' };
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
  ipcMain.handle(IPC_CHANNELS.updateCodexDefaults, async (_event, input: UpdateCodexDefaultsInput) => {
    return await updateCodexDefaults(input);
  });
  ipcMain.handle(IPC_CHANNELS.updateAgentDefaults, async (_event, input: UpdateAgentDefaultsInput) => {
    return await updateAgentDefaults(input);
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
  ipcMain.handle(IPC_CHANNELS.getCloudDevices, async () => {
    return cloudDeviceManager ? await cloudDeviceManager.getState() : { devices: [], connected: false };
  });
  ipcMain.handle(IPC_CHANNELS.generateDevicePairingCode, async () => {
    return cloudDeviceManager
      ? await cloudDeviceManager.generatePairingCode()
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos preparar este equipo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.listFriends, async () => {
    return forgerBackendClient ? await forgerBackendClient.listFriends() : [];
  });
  ipcMain.handle(IPC_CHANNELS.listMySocialApps, async () => {
    return forgerBackendClient ? await forgerBackendClient.listMySocialApps() : { apps: [] };
  });
  ipcMain.handle(IPC_CHANNELS.uploadSocialApp, async (_event, input: SocialUserAppUploadInput) => {
    const startedAt = new Date().toISOString();
    const taskId = `social-upload:${input.appId}:${Date.now()}`;
    const record = registry.apps[input.appId];
    const appName = record?.name ?? input.appId;
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
    if (!record?.installDir || !record.privateLocal) {
      await taskStore.upsert({
        id: taskId,
        source: 'social-upload',
        title: `Subiendo ${appName} a Social`,
        status: 'failed',
        result: {
          status: 'error',
          message: 'Solo puedes subir a Social apps creadas por ti.',
          technicalCode: 'social_upload_not_private_local',
        },
        completedAt: new Date().toISOString(),
      });
      return { success: false, userMessage: 'Solo puedes subir a Social apps creadas por ti.', technicalCode: 'social_upload_not_private_local' };
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
        name: record.name,
        slug: input.appId,
        description: record.description,
        shortDescription: record.description,
        category: manifest && typeof (manifest.catalog as { category?: unknown } | null)?.category === 'string'
          ? (manifest.catalog as { category: string }).category
          : 'productivity',
        visibility: input.visibility,
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
    return forgerBackendClient ? await decryptCloudMessages(await forgerBackendClient.listCloudMessages(friendUserId)) : [];
  });
  ipcMain.handle(IPC_CHANNELS.sendCloudMessage, async (_event, input: CloudSendMessageInput) => {
    return await sendEncryptedCloudMessage(input);
  });
  ipcMain.handle(IPC_CHANNELS.decideAppMessagePermission, async (_event, cloudMessageId: number, decision: CloudAppMessagePermissionDecision) => {
    if (!forgerBackendClient) throw new Error('backend_client_missing');
    return await decryptCloudMessage(await forgerBackendClient.decideAppMessagePermission(cloudMessageId, decision));
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
  ipcMain.handle(IPC_CHANNELS.submitDesktopErrorReport, async (_event, input: DesktopErrorReportPreview) => {
    const report = await enrichAppErrorReportWithInstallLog({
      fs,
      getInstallLogPath,
      input: {
      ...input,
      desktopVersion: input.desktopVersion || app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      occurredAt: input.occurredAt || new Date().toISOString(),
      },
    });
    return forgerBackendClient
      ? await forgerBackendClient.submitDesktopErrorReport(report)
      : { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.prepareConversationDiagnosticReport, async (_event, input: PrepareConversationDiagnosticReportInput) => {
    return await buildConversationDiagnosticReport({
      appVersion: app.getVersion(),
      platform: process.platform,
      getUserDataPath: () => app.getPath('userData'),
      getForgerHomeRoot,
      getPrivateAppsRoot,
      getPrivateDataRoot,
      getForgerMetadataRoot,
      getCodexHome,
      getInstalledAppVersion: (appId) => registry.apps[appId]?.version,
      getConversationManager: () => appAgentConversationManager,
    }, input);
  });
  ipcMain.handle(IPC_CHANNELS.submitConversationDiagnosticReport, async (_event, input: ConversationDiagnosticReportPreview) => {
    return forgerBackendClient
      ? await forgerBackendClient.submitConversationDiagnosticReport(input)
      : { success: false, userMessage: 'No pudimos enviar el reporte de conversación.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.openExternalUrl, async (_event, targetUrl: string) => {
    try {
      const parsed = new URL(targetUrl);
      if (parsed.protocol !== 'https:') {
        return { success: false, userMessage: 'No pudimos abrir ese enlace.', technicalCode: 'unsupported_url_protocol' };
      }

      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch (error) {
      return { success: false, userMessage: 'No pudimos abrir ese enlace.', ...failureDiagnostic(error, 'open_external_url_failed') };
    }
  });
  ipcMain.handle(IPC_CHANNELS.getCodexAuthStatus, async () => await getCodexAuthStatus());
  ipcMain.handle(IPC_CHANNELS.openCodexUsageDashboard, async () => {
    try {
      await shell.openExternal(CODEX_USAGE_DASHBOARD_URL);
      return { success: true };
    } catch (error) {
      return { success: false, ...failureDiagnostic(error, 'open_codex_usage_failed'), userMessage: 'No pudimos abrir el panel de uso de Codex.' };
    }
  });
  ipcMain.handle(IPC_CHANNELS.connectCodexAuth, async () => await connectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.disconnectCodexAuth, async () => await disconnectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallCodex, async () => await reinstallCodex());
  ipcMain.handle(IPC_CHANNELS.getClaudeAuthStatus, async () => await getClaudeAuthStatus());
  ipcMain.handle(IPC_CHANNELS.connectClaudeAuth, async () => await connectClaudeAuth());
  ipcMain.handle(IPC_CHANNELS.reinstallClaude, async () => await reinstallClaude());
  ipcMain.handle(IPC_CHANNELS.listAgentTools, async () => AGENT_TOOL_PACKAGES);
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
  ipcMain.handle(IPC_CHANNELS.deactivateOfficialTool, async (_event, toolId: string, locale?: string) => {
    return await getOfficialToolsService().deactivate(toolId, { locale });
  });
  ipcMain.handle(IPC_CHANNELS.getAppToolsInstallGate, async (_event, appId: string, locale?: string): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().getInstallGate(appId, locale);
  });
  ipcMain.handle(IPC_CHANNELS.setAppToolGrant, async (_event, input: SetAppToolGrantInput, locale?: string): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().setAppToolGrant(input, locale);
  });
  ipcMain.handle(IPC_CHANNELS.chatStartRun, async (_event, input: ChatStartRunInput) => {
    if (!chatOrchestrator) {
      return { runId: '', status: 'failed' };
    }
    const dataRootReal = await fs.realpath(getPrivateDataRoot()).catch(async () => {
      await fs.mkdir(getPrivateDataRoot(), { recursive: true });
      return fs.realpath(getPrivateDataRoot());
    });
    const sharedFiles: SharedFileRef[] = [];
    for (const fileRef of input.sharedFiles ?? []) {
      const candidatePath = path.isAbsolute(fileRef.path) ? fileRef.path : path.join(getPrivateDataRoot(), fileRef.path);
      const realPath = await fs.realpath(candidatePath).catch(() => null);
      if (!realPath || !ensurePathInside(dataRootReal, realPath)) {
        continue;
      }
      sharedFiles.push({ ...fileRef, path: realPath });
    }
    const sharedPromptFiles = sharedFiles.map((fileRef) => ({
      name: fileRef.name ?? path.basename(fileRef.path),
      relativePath: toPosixRelativePath(fileRef.relativePath ?? path.relative(getPrivateDataRoot(), fileRef.path)),
      sizeBytes: fileRef.sizeBytes ?? 0,
      modifiedAt: fileRef.modifiedAt ?? '',
      source: fileRef.source ?? 'mentioned',
    }));
    const promptContext = input.appId ? await installedAppPromptContext(input.appId, input) : null;
    const enrichedPrompt = input.appId
      ? buildCodexPromptWithAppContext({
          turnKind: 'start',
          appId: input.appId,
          displayName: resolveSelectedAppDisplayName(input.appId),
          ...promptContext,
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForApp(input.appId),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        })
      : buildCodexPromptForFreeChat({
          turnKind: 'start',
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForFreeChat(),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        });
    const resumePrompt = input.appId
      ? buildCodexPromptWithAppContext({
          turnKind: 'resume',
          appId: input.appId,
          displayName: resolveSelectedAppDisplayName(input.appId),
          ...(promptContext ?? {}),
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: '',
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        })
      : buildCodexPromptForFreeChat({
          turnKind: 'resume',
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: '',
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        });
    return await chatOrchestrator.startRun({
      ...input,
      appId: input.appId ?? null,
      prompt: enrichedPrompt,
      resumePrompt,
      sharedFiles,
    });
  });
  ipcMain.handle(IPC_CHANNELS.chatGetRun, async (_event, input: ChatGetRunInput) => {
    if (!chatOrchestrator) {
      return null;
    }
    return chatOrchestrator.getRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatCancelRun, async (_event, input: ChatCancelRunInput) => {
    if (!chatOrchestrator) {
      return { success: false };
    }
    return chatOrchestrator.cancelRun(input);
  });
  ipcMain.handle(
    IPC_CHANNELS.chatApprovePermission,
    async (_event, input: ChatApprovePermissionInput) => {
      if (!chatOrchestrator) {
        return { success: false };
      }
      return chatOrchestrator.approvePermission(input);
    },
  );
  ipcMain.handle(IPC_CHANNELS.chatApplyRun, async (_event, input: ChatApplyRunInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.applyRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatUndo, async (_event, input: ChatUndoInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.undo(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatTrace, async (_event, input: RendererChatTraceEvent) => {
    if (!input || !RENDERER_CHAT_TRACE_EVENTS.has(input.event)) {
      return { success: false };
    }
    await appendInstallLog('chat_renderer_trace', sanitizeRendererChatTrace(input));
    return { success: true };
  });

  registerFileLibraryIpcHandlers({
    IPC_CHANNELS,
    dialog,
    getFileLibrary,
    ipcMain,
    mainWindow,
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
    decryptCloudMessages,
    forgerBackendClient,
    ipcMain,
    registry,
    resolveAppIdForWebContents,
    resolveInstalledManifest,
    sendEncryptedCloudMessage,
  });
};
