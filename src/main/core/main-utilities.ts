
import type { App, BrowserWindow } from 'electron';
import type { BinaryLike } from 'node:crypto';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import type { DesktopUpdater } from '../desktop-updater';
import type { DesktopErrorReporter } from '../error-reporting';
import type { ForgerAccountStore, StoredForgerAccount, publicForgerAccount } from '../forger-account-store';
import type { AGENT_TOOL_DEFINITIONS, AGENT_TOOL_IDS } from './agent-tool-packages';
import type { IPC_CHANNELS } from '../../shared/ipc';
import type {
  AgentToolApprovalSettings,
  AgentToolId,
  AgentToolSettings,
  AppCategory,
  AppExternalFolderSelection,
  AppStatus,
  AppSummary,
  CatalogApp,
  ChatRun,
  ChatRunEvent,
  DesktopUpdateState,
  FailureDiagnosticFields,
  InstallAppResult,
  RendererChatTraceEvent,
  RuntimeStatus,
  Settings,
  UpdateAgentToolApprovalInput,
} from '../../shared/types';
import type { AppRegistry, InstalledAppRecord, RunningAppProcess } from './main-process-types';

interface MainUtilitiesState {
  agentToolSettings: AgentToolSettings;
  catalogApps: CatalogApp[];
  desktopUpdater: DesktopUpdater | null;
  forgerAccount: StoredForgerAccount;
  settings: Settings;
}

interface MainUtilitiesDeps {
  AGENT_TOOL_DEFINITIONS: typeof AGENT_TOOL_DEFINITIONS;
  AGENT_TOOL_IDS: typeof AGENT_TOOL_IDS;
  APP_FOLDER_GRANT_TTL_MS: number;
  Buffer: typeof Buffer;
  Date: DateConstructor;
  DesktopUpdater: new (options: {
    currentVersion: string;
    userDataPath: string;
    onStateChanged: (state: DesktopUpdateState) => void;
  }) => DesktopUpdater;
  IPC_CHANNELS: typeof IPC_CHANNELS;
  app: App;
  appFolderGrantSecret: BinaryLike;
  appWindows: Map<string, BrowserWindow>;
  buildFailureDiagnostic: (input: { error: unknown; fallbackCode: string }) => FailureDiagnosticFields;
  cloudDeviceManager: { start: () => Promise<void>; stop: () => void } | null;
  createHmac: typeof import('node:crypto').createHmac;
  desktopErrorReporter: DesktopErrorReporter | null;
  forgerAccountStore: ForgerAccountStore | null;
  friendChatWindows: Map<number, BrowserWindow>;
  fs: typeof fs;
  getAgentToolSettingsPath: () => string;
  getInstallLogPath: () => string;
  installProgressByPhase: Record<InstallAppResult['phase'], number>;
  isDev: boolean;
  getLocalNetworkShareStatus?: (appId: string) => AppSummary['localNetworkShare'];
  getRemoteNetworkShareStatus?: (appId: string) => AppSummary['remoteNetworkShare'];
  getMainWindow: () => BrowserWindow | null;
  path: typeof path;
  publicForgerAccount: typeof publicForgerAccount;
  registry: AppRegistry;
  runningApps: Map<string, RunningAppProcess>;
  state: MainUtilitiesState;
}

let activeProcessErrorReporter: DesktopErrorReporter | null = null;
let processErrorHandlersRegistered = false;

const handleMainUncaughtException = (error: Error): void => {
  activeProcessErrorReporter?.reportMainUncaughtException(error);
};

const handleMainUnhandledRejection = (reason: unknown): void => {
  activeProcessErrorReporter?.reportMainUnhandledRejection(reason);
};

const registerProcessErrorHandlers = (reporter: DesktopErrorReporter | null): void => {
  activeProcessErrorReporter = reporter;
  if (processErrorHandlersRegistered) {
    return;
  }
  process.on('uncaughtException', handleMainUncaughtException);
  process.on('unhandledRejection', handleMainUnhandledRejection);
  processErrorHandlersRegistered = true;
};

export const __testMainUtilitiesInternals = {
  handleMainUncaughtException,
  handleMainUnhandledRejection,
  resetProcessErrorHandlersForTests: (): void => {
    process.removeListener('uncaughtException', handleMainUncaughtException);
    process.removeListener('unhandledRejection', handleMainUnhandledRejection);
    activeProcessErrorReporter = null;
    processErrorHandlersRegistered = false;
  },
};

export const createMainUtilitiesController = (deps: MainUtilitiesDeps) => {
const { Buffer, Date, app, path, fs, createHmac, appFolderGrantSecret, APP_FOLDER_GRANT_TTL_MS, appWindows, friendChatWindows, getInstallLogPath, isDev, AGENT_TOOL_IDS, AGENT_TOOL_DEFINITIONS, getAgentToolSettingsPath, getLocalNetworkShareStatus, getRemoteNetworkShareStatus, getMainWindow, IPC_CHANNELS, DesktopUpdater, desktopErrorReporter, forgerAccountStore, cloudDeviceManager, publicForgerAccount, state, registry, runningApps, buildFailureDiagnostic, installProgressByPhase } = deps;
registerProcessErrorHandlers(desktopErrorReporter);
const localNetworkShareStatusFor = getLocalNetworkShareStatus ?? (() => undefined);
const remoteNetworkShareStatusFor = getRemoteNetworkShareStatus ?? (() => undefined);
const localNetworkSharePayloadFor = (appId: string) => {
  const status = localNetworkShareStatusFor(appId);
  return status ? { localNetworkShare: status } : {};
};
const remoteNetworkSharePayloadFor = (appId: string) => {
  const status = remoteNetworkShareStatusFor(appId);
  return status ? { remoteNetworkShare: status } : {};
};
const MAX_INSTALL_LOG_FIELD_LENGTH = 60_000;

class CommandFailedError extends Error {
  public constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly cwd: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`command_failed_${exitCode ?? 'null'}`);
    this.name = 'CommandFailedError';
  }
}

const truncateForInstallLog = (value: string): string => {
  if (value.length <= MAX_INSTALL_LOG_FIELD_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_INSTALL_LOG_FIELD_LENGTH)}\n...[truncated ${value.length - MAX_INSTALL_LOG_FIELD_LENGTH} chars]`;
};

const serializeErrorForInstallLog = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error instanceof CommandFailedError
        ? {
            command: error.command,
            args: error.args,
            cwd: error.cwd,
            exitCode: error.exitCode,
            signal: error.signal,
            stdout: truncateForInstallLog(error.stdout),
            stderr: truncateForInstallLog(error.stderr),
          }
        : {}),
    };
  }

  return {
    message: String(error),
  };
};

const encodeBase64Url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');

const signAppFolderGrant = (appId: string, folderPath: string): AppExternalFolderSelection => {
  const expiresAtMs = Date.now() + APP_FOLDER_GRANT_TTL_MS;
  const payload = encodeBase64Url(JSON.stringify({
    appId,
    path: folderPath,
    exp: Math.floor(expiresAtMs / 1000),
  }));
  const signature = createHmac('sha256', appFolderGrantSecret).update(payload).digest('base64url');

  return {
    canceled: false,
    path: folderPath,
    grantToken: `${payload}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
};

const resolveAppIdForWebContents = (webContentsId: number): string | null => {
  for (const [appId, appWindow] of appWindows.entries()) {
    if (!appWindow.isDestroyed() && appWindow.webContents.id === webContentsId) {
      return appId;
    }
  }
  return null;
};

const appendInstallLog = async (event: string, payload: Record<string, unknown> = {}): Promise<void> => {
  const logPath = getInstallLogPath();
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    dev: isDev,
    ...payload,
  };

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.warn('Failed to write Forger install log', error);
  }
};

const isAgentToolId = (value: unknown): value is AgentToolId =>
  typeof value === 'string' && AGENT_TOOL_IDS.has(value as AgentToolId);

const normalizeAgentToolSettings = (input?: Partial<AgentToolSettings>): AgentToolSettings => {
  const approvals = AGENT_TOOL_DEFINITIONS.reduce((acc, tool) => {
    const configured = input?.approvals?.[tool.id];
    acc[tool.id] = typeof configured === 'boolean' ? configured : tool.defaultRequiresApproval;
    return acc;
  }, {} as AgentToolApprovalSettings);

  return { approvals };
};

const loadAgentToolSettings = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(getAgentToolSettingsPath(), 'utf8');
    state.agentToolSettings = normalizeAgentToolSettings(JSON.parse(raw) as Partial<AgentToolSettings>);
  } catch {
    state.agentToolSettings = normalizeAgentToolSettings();
  }
};

const saveAgentToolSettings = async (): Promise<void> => {
  await fs.mkdir(path.dirname(getAgentToolSettingsPath()), { recursive: true });
  await fs.writeFile(getAgentToolSettingsPath(), JSON.stringify(state.agentToolSettings, null, 2), 'utf8');
};

const updateAgentToolApproval = async (input: UpdateAgentToolApprovalInput): Promise<AgentToolSettings> => {
  if (!isAgentToolId(input.toolId)) {
    throw new Error('invalid_agent_tool_id');
  }
  state.agentToolSettings = normalizeAgentToolSettings({
    approvals: {
      ...state.agentToolSettings.approvals,
      [input.toolId]: Boolean(input.requiresApproval),
    },
  });
  await saveAgentToolSettings();
  return state.agentToolSettings;
};

const getBundledResourcesRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtimes');
  }
  return path.join(app.getAppPath(), 'resources', 'runtimes');
};

const stripArchiveExtension = (fileName: string): string => {
  if (fileName.endsWith('.tar.gz')) {
    return fileName.slice(0, -7);
  }
  if (fileName.endsWith('.tgz')) {
    return fileName.slice(0, -4);
  }
  if (fileName.endsWith('.zip')) {
    return fileName.slice(0, -4);
  }
  return fileName;
};

const runtimePlatformTokens = (platformAlias: string): string[] => {
  const tokens = new Set<string>([platformAlias, platformAlias.replace('_', '-')]);

  if (platformAlias === 'darwin_arm64') {
    tokens.add('darwin-arm64');
    tokens.add('aarch64-apple-darwin');
  }
  if (platformAlias === 'win32_x64') {
    tokens.add('win-x64');
    tokens.add('x86_64-pc-windows-msvc');
    tokens.add('windows-x64');
    tokens.add('64-bit');
  }

  return Array.from(tokens);
};

const findRuntimeArchive = async (
  baseDir: string,
  platformAlias: string,
): Promise<string | null> => {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz'));
    if (files.length === 0) {
      return null;
    }

    const tokens = runtimePlatformTokens(platformAlias);
    const byToken = files.find((name) => tokens.some((token) => name.includes(token)));
    if (byToken) {
      return path.join(baseDir, byToken);
    }

    if (files.length === 1) {
      return path.join(baseDir, files[0]);
    }

    return null;
  } catch {
    return null;
  }
};

const findRuntimeChecksumFile = async (
  baseDir: string,
  archivePath: string,
  platformAlias: string,
): Promise<string | null> => {
  const archiveName = path.basename(archivePath);
  const candidates = [
    `${archiveName}.sha256`,
    `${stripArchiveExtension(archiveName)}.sha256`,
    `${platformAlias}.sha256`,
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(baseDir, candidate);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        return fullPath;
      }
    } catch {
      // keep searching
    }
  }

  return null;
};

const runtimeError = (message: string, technicalCode: string, phase: InstallAppResult['phase'] = 'failed'): InstallAppResult => ({
  success: false,
  phase,
  userMessage: message,
  progress: installProgressByPhase[phase],
  technicalCode,
});

const failureDiagnostic = (error: unknown, fallbackCode: string) =>
  buildFailureDiagnostic({ error, fallbackCode });

const emitInstallProgress = (appId: string, payload: InstallAppResult): void => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.installProgress, {
    appId,
    progress: payload,
  });
};

const emitRuntimeStatus = (payload: RuntimeStatus): void => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.runtimeStatusChanged, payload);
};

const buildChatRunIpcTracePayload = (run: ChatRun): Record<string, unknown> => ({
  runId: run.runId,
  appId: run.appId,
  conversationId: run.conversationId ?? null,
  status: run.status,
  hasUserMessage: typeof run.userMessage === 'string' && run.userMessage.trim().length > 0,
  progressCount: run.progressLog?.length ?? 0,
});

const RENDERER_CHAT_TRACE_EVENTS = new Set<RendererChatTraceEvent['event']>([
  'chat_run_event_received',
  'chat_run_message_append_attempt',
  'chat_run_message_appended',
  'chat_new_conversation_clicked',
]);

const sanitizeRendererChatTrace = (input: RendererChatTraceEvent): Record<string, unknown> => ({
  traceEvent: input.event,
  timestamp: typeof input.timestamp === 'string' ? input.timestamp : null,
  runId: typeof input.runId === 'string' ? input.runId : null,
  appId: typeof input.appId === 'string' ? input.appId : null,
  conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
  activeConversationId: typeof input.activeConversationId === 'string' ? input.activeConversationId : null,
  status: typeof input.status === 'string' ? input.status : null,
  messageCount: typeof input.messageCount === 'number' ? input.messageCount : null,
  foundConversation: typeof input.foundConversation === 'boolean' ? input.foundConversation : null,
});

const emitChatRunUpdated = (payload: ChatRunEvent): void => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    mainWindow.webContents.send(IPC_CHANNELS.chatRunUpdated, payload);
    void appendInstallLog('chat_run_emit_sent', buildChatRunIpcTracePayload(payload.run));
  } catch (error) {
    void appendInstallLog('chat_run_update_send_failed', {
      ...buildChatRunIpcTracePayload(payload.run),
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
};

const emitAutomationUpdated = (payload: { automation: unknown; run?: unknown }): void => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.automationUpdated, payload);
};

const emitDesktopUpdateProgress = (payload: DesktopUpdateState): void => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.desktopUpdateProgress, payload);
};

const emitForgerAccountUpdated = (payload: ReturnType<typeof publicForgerAccount> & {
  userMessage?: string;
  technicalCode?: string;
}): void => {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.forgerAccountUpdated, payload);
};

const closeFriendChatWindows = (): void => {
  for (const window of friendChatWindows.values()) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
  friendChatWindows.clear();
};

const switchForgerAccountSession = async (
  nextAccount: StoredForgerAccount,
  options: { userMessage?: string; technicalCode?: string } = {},
): Promise<ReturnType<typeof publicForgerAccount> & { userMessage?: string; technicalCode?: string }> => {
  cloudDeviceManager?.stop();
  closeFriendChatWindows();
  state.forgerAccount = nextAccount;

  if (state.forgerAccount.authenticated && state.forgerAccount.token) {
    await forgerAccountStore?.save(state.forgerAccount);
    await cloudDeviceManager?.start();
  } else {
    await forgerAccountStore?.clear();
  }

  const payload = {
    ...publicForgerAccount(state.forgerAccount),
    userMessage: options.userMessage,
    technicalCode: options.technicalCode,
  };
  emitForgerAccountUpdated(payload);
  return payload;
};

const clearForgerAccountSession = async (technicalCode: string): Promise<void> => {
  if (!state.forgerAccount.authenticated && !state.forgerAccount.token) {
    return;
  }
  await switchForgerAccountSession({ authenticated: false }, {
    userMessage: 'Tu sesion de Forger Cloud expiro. Inicia sesion nuevamente.',
    technicalCode,
  });
};

const getDesktopUpdater = (): DesktopUpdater => {
  if (!state.desktopUpdater) {
    state.desktopUpdater = new DesktopUpdater({
      currentVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
      onStateChanged: emitDesktopUpdateProgress,
    });
  }
  return state.desktopUpdater;
};

const toAppSummary = (record: InstalledAppRecord): AppSummary => {
  const running = runningApps.get(record.appId);
  const catalog = state.catalogApps.find((entry) => entry.id === record.appId);
  const latestVersion = catalog?.latestVersion;
  const updateAvailable = isVersionNewer(latestVersion, record.version);
  const base = {
    changelog: catalog?.changelog,
    iconUrl: catalog?.iconUrl,
    beta: catalog?.beta,
    privateLocal: record.privateLocal,
    localNetworkShareSupported: record.localNetworkShareSupported ?? catalog?.localNetworkShareSupported,
    remoteTunnelSupported: record.remoteTunnelSupported ?? catalog?.remoteTunnelSupported,
    ...localNetworkSharePayloadFor(record.appId),
    ...remoteNetworkSharePayloadFor(record.appId),
  };
  if (running) {
    return {
      ...base,
      id: record.appId,
      name: catalog?.name ?? record.name,
      description: catalog?.description ?? record.description,
      category: catalog?.category ?? record.category,
      version: record.version,
      latestVersion,
      updateAvailable,
      status: 'running',
      userMessage: 'En ejecucion',
    };
  }

  return {
    ...base,
    id: record.appId,
    name: catalog?.name ?? record.name,
    description: catalog?.description ?? record.description,
    category: catalog?.category ?? record.category,
    version: record.version,
    latestVersion,
    updateAvailable,
    status: record.status,
    userMessage: record.userMessage,
  };
};

const parseVersionParts = (value?: string): number[] | null => {
  if (!value) {
    return null;
  }
  const cleaned = value.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+(?:\.\d+){0,3})/);
  if (!match) {
    return null;
  }
  return match[1].split('.').map((part) => Number.parseInt(part, 10));
};

const isVersionNewer = (candidate?: string, current?: string): boolean => {
  const normalizedCandidate = candidate?.trim();
  const normalizedCurrent = current?.trim();
  if (normalizedCandidate && normalizedCurrent && normalizedCandidate === normalizedCurrent) {
    return false;
  }
  const next = parseVersionParts(candidate);
  const prev = parseVersionParts(current);
  if (!next || !prev) {
    return Boolean(candidate && current && candidate !== current);
  }
  const length = Math.max(next.length, prev.length);
  for (let index = 0; index < length; index += 1) {
    const a = next[index] ?? 0;
    const b = prev[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return (normalizedCandidate ?? '') > (normalizedCurrent ?? '');
};

const mapBackendCategory = (backendCategory: string): AppCategory => {
  switch (backendCategory) {
    case 'finance':
      return 'finanzas';
    case 'home':
      return 'hogar';
    case 'health':
      return 'salud';
    case 'developer_tools':
      return 'developer_tools';
    default:
      return 'productividad';
  }
};

const toCatalogStatus = (slug: string): AppStatus => {
  const installed = registry.apps[slug];
  if (!installed) {
    return 'not_installed';
  }
  return runningApps.has(slug) ? 'running' : installed.status;
};

  return { CommandFailedError, truncateForInstallLog, serializeErrorForInstallLog, encodeBase64Url, signAppFolderGrant, resolveAppIdForWebContents, appendInstallLog, isAgentToolId, normalizeAgentToolSettings, loadAgentToolSettings, saveAgentToolSettings, updateAgentToolApproval, getBundledResourcesRoot, stripArchiveExtension, runtimePlatformTokens, findRuntimeArchive, findRuntimeChecksumFile, runtimeError, failureDiagnostic, emitInstallProgress, emitRuntimeStatus, buildChatRunIpcTracePayload, sanitizeRendererChatTrace, emitChatRunUpdated, emitAutomationUpdated, emitDesktopUpdateProgress, emitForgerAccountUpdated, closeFriendChatWindows, switchForgerAccountSession, clearForgerAccountSession, getDesktopUpdater, toAppSummary, parseVersionParts, isVersionNewer, mapBackendCategory, toCatalogStatus };
};
