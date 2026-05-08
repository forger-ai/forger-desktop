import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import yauzl from 'yauzl';

// better-sqlite3 is optional — gracefully unavailable if not installed / rebuilt
// eslint-disable-next-line @typescript-eslint/no-require-imports
let BetterSqlite3: (typeof import('better-sqlite3')) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
} catch {
  // package not yet installed or not rebuilt for this Electron version
}
import { settingsSeed } from '../shared/mock-data';
import { IPC_CHANNELS } from '../shared/ipc';
import { ChatOrchestrator } from './chat/orchestrator';
import { AppCodexTaskManager } from './app-codex-task-manager';
import { AppCodexConversationManager } from './app-codex-conversation-manager';
import { AppMcpManager, type CodexMcpServerConfig } from './app-mcp-manager';
import { AutomationManager } from './automation-manager';
import { DevCatalogService } from './dev-catalog-service';
import { DesktopUpdater } from './desktop-updater';
import { DesktopErrorReporter } from './error-reporting';
import { FileLibrary } from './file-library';
import { ForgerMcpServer } from './forger-mcp-server';
import { MemoryStore } from './memory-store';
import { OfficialToolsService, normalizeAppToolDeclarations } from './official-tools-service';
import { ForgerAccountStore, publicForgerAccount, type StoredForgerAccount } from './forger-account-store';
import { ForgerBackendClient } from './forger-backend-client';
import { CloudDeviceManager, type CloudRelayRequest, type CloudRelayResponse } from './cloud-device-manager';
import { BackupsManager } from './backups-manager';
import {
  FORGER_AGENT_CONTRACT_MARKER,
  FORGER_AGENT_CONTRACT_MARKER_PREFIX,
  FORGER_AGENT_CONTRACT_VERSION,
  buildGlobalForgerAgentsMarkdown,
} from './prompts/forger-base';
import { buildFailureDiagnostic } from '../shared/error-diagnostics';
import { buildForgerAppAgentsMarkdown } from './prompts/apps-base';
import { buildCodexPromptForFreeChat, buildCodexPromptWithAppContext } from './prompts/user-message';
import {
  buildForgerOfficialToolSkillTemplates,
  buildForgerOfficialToolsPromptSection,
} from './prompts/official-tools';
import { SecretsStore, appSecretEnvName, isSecretsVaultUnavailableError } from './secrets-store';
import type {
  AgentToolApprovalSettings,
  AgentToolDefinition,
  AgentToolId,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppToolDeclaration,
  AppToolsInstallGate,
  AppBackupSummary,
  AppCategory,
  AppDetails,
  CloudSyncSettings,
  CreateRemoteAppBackupInput,
  AppExternalFolderSelection,
  AppAgent,
  AppCodexTaskStartInput,
  AppCodexConversationCreateInput,
  AppCodexConversationSendMessageInput,
  AppLocalChangeSummary,
  AppPromptTemplate,
  AppSecretConnection,
  AppSecretDeclaration,
  AppSecretsState,
  AppStatus,
  AppOperationSummary,
  AppSummary,
  AutomationUpsertInput,
  BasicActionResult,
  CatalogApp,
  ChatApplyRunInput,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatGetRunInput,
  ChatStartRunInput,
  ChatUndoInput,
  CallOfficialToolInput,
  ConfigureOfficialToolInput,
  CodexAuthStatus,
  DesktopErrorReportPreview,
  ConnectAppSecretInput,
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
  ForgerAccountLoginInput,
  ForgerAccountRegisterInput,
  InstallAppResult,
  MemoryCreateInput,
  MemoryListInput,
  MemoryUpdateInput,
  OpenAppResult,
  RemoteAppBackupSummary,
  RuntimeStatus,
  Settings,
  SharedFileRef,
  SubmitAppFeedbackInput,
  SubmitAppRatingInput,
  StopAppResult,
  UpdateAgentToolApprovalInput,
  SetAppToolGrantInput,
  UpdateUserSecretInput,
  VersionChangelog,
  WindowControlState,
} from '../shared/types';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const backendBaseUrl = process.env.FORGER_BACKEND_URL ?? (isDev ? 'http://127.0.0.1:3300' : 'https://platform.forger.cloud');
let localCatalogJsonUrl: string | undefined;
const DEFAULT_NODE_VERSION = '22';
const DEFAULT_PYTHON_VERSION = '3.12';
const CODEX_CLI_VERSION = '0.129.0';
const CODEX_USAGE_DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
let devCatalogService: DevCatalogService | null = null;
const APP_FOLDER_GRANT_TTL_MS = 5 * 60 * 1000;
const appFolderGrantSecret = randomBytes(32).toString('base64url');
const useCustomWindowFrame = process.platform === 'win32';

const normalizeVersionForFolder = (value: string): string => {
  const [major, minor] = value.split('.');
  if (major && minor) {
    return `${major}.${minor}`;
  }
  return value;
};

const normalizeNodeRuntimeVersion = (value?: string | null): string => {
  const rawValue = typeof value === 'string' ? value.trim() : '';
  const normalized = normalizeVersionForFolder(rawValue || DEFAULT_NODE_VERSION);
  return /^24(?:\.|$)/.test(normalized) ? DEFAULT_NODE_VERSION : normalized;
};

if (isDev) {
  app.setName('Forger Dev');
  app.setPath('userData', path.join(app.getPath('appData'), 'forger-desktop-dev'));
}

const PLATFORM_KEY_BY_RUNTIME: Record<NodeJS.Platform, string> = {
  darwin: 'darwin',
  win32: 'win32',
  linux: 'linux',
  aix: 'aix',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  sunos: 'sunos',
  android: 'android',
  cygwin: 'cygwin',
  haiku: 'haiku',
  netbsd: 'netbsd',
};

const RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'win32_x64']);

interface InstalledAppRecord {
  appId: string;
  name: string;
  description: string;
  category: AppCategory;
  version: string;
  installDir: string;
  status: Exclude<AppStatus, 'not_installed' | 'running'>;
  userMessage?: string;
  requiredNodeVersion: string;
  requiredPythonVersion: string;
  originalCommitSha?: string;
  installedAt?: string;
  pendingUpdate?: {
    fromVersion: string;
    targetVersion: string;
    preUpdateUserHead: string;
    baseCommitSha?: string;
    backup?: AppBackupSummary;
    startedAt: string;
    message?: string;
  };
}

interface AppRegistry {
  apps: Record<string, InstalledAppRecord>;
}

interface RuntimeBinarySet {
  rootDir: string;
  node?: string;
  npm?: string;
  python?: string;
  pip?: string;
}

interface RunningAppProcess {
  appId: string;
  backend: ChildProcessWithoutNullStreams;
  frontend: ChildProcessWithoutNullStreams;
  backendUrl: string;
  frontendUrl: string;
  rawFrontendUrl: string;
  proxyServer: http.Server;
}

interface AppManifestService {
  name?: string;
  type?: string;
  port?: number;
  command?: string;
  healthcheck?: string;
  context?: string;
  environment?: Record<string, string>;
  volumes?: AppManifestVolume[];
}

interface AppManifestMcp {
  type?: string;
  context?: string;
  command?: string;
  healthcheck?: string;
  environment?: Record<string, string>;
  toolTimeoutSec?: number;
}

interface AppManifestStackSection {
  language?: string;
  framework?: string;
  package_manager?: string;
  database?: string;
  bundler?: string;
  ui?: string;
}

interface AppManifestStack {
  backend?: AppManifestStackSection;
  frontend?: AppManifestStackSection;
}

interface AppManifest {
  name?: string;
  version?: string;
  description?: string;
  changelog?: VersionChangelog[];
  promptTemplates?: unknown;
  codexConversation?: unknown;
  agents?: unknown;
  stack?: AppManifestStack;
  services?: AppManifestService[];
  mcp?: AppManifestMcp;
  scripts?: Record<string, string>;
  skills?: string[];
  appSecrets?: unknown;
  tools?: unknown;
}

interface AppManifestVolume {
  source?: string;
  target?: string;
  persist?: boolean;
}

interface StackSkillTemplate {
  id: string;
  description: string;
  body: string;
}

let mainWindow: BrowserWindow | null = null;
let catalogApps: CatalogApp[] = [];
let settings: Settings = structuredClone(settingsSeed);
let registry: AppRegistry = { apps: {} };
let forgerAccount: StoredForgerAccount = { authenticated: false };
let forgerAccountStore: ForgerAccountStore | null = null;
let cloudDeviceManager: CloudDeviceManager | null = null;
let forgerBackendClient: ForgerBackendClient | null = null;
let cloudSyncSettings: CloudSyncSettings = { appSync: {} };
const runningApps = new Map<string, RunningAppProcess>();
const appWindows = new Map<string, BrowserWindow>();
const stoppingApps = new Set<string>();
const appLifecycleLocks = new Map<string, Promise<unknown>>();
const runtimeLocks = new Map<string, Promise<RuntimeBinarySet>>();
let chatOrchestrator: ChatOrchestrator | null = null;
let appCodexTaskManager: AppCodexTaskManager | null = null;
let appCodexConversationManager: AppCodexConversationManager | null = null;
let fileLibrary: FileLibrary | null = null;
let secretsStore: SecretsStore | null = null;
let officialToolsService: OfficialToolsService | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let desktopErrorReporter: DesktopErrorReporter | null = null;
let automationManager: AutomationManager | null = null;
let appMcpManager: AppMcpManager | null = null;
let backupsManager: BackupsManager | null = null;
let memoryStore: MemoryStore | null = null;

desktopErrorReporter = new DesktopErrorReporter({
  getMainWindow: () => mainWindow,
  getAppVersion: () => app.getVersion(),
  getInstalledApp: (appId) => registry.apps[appId],
});

const resolvePlatformAlias = (): string => {
  const platformPrefix = PLATFORM_KEY_BY_RUNTIME[process.platform] ?? process.platform;
  return `${platformPrefix}_${process.arch}`;
};

const getRegistryPath = () => path.join(app.getPath('userData'), 'app_registry.json');
const getRegistryBackupPath = () => `${getRegistryPath()}.bak`;
const getRuntimesRoot = () => path.join(app.getPath('userData'), 'runtimes');
const getTempRoot = () => path.join(app.getPath('userData'), 'tmp');
const getLogsRoot = () => path.join(app.getPath('userData'), 'logs');
const getInstallLogPath = () => path.join(getLogsRoot(), 'install.log');
const getForgerHomeRoot = () => path.join(os.homedir(), isDev ? 'Forger-dev' : 'Forger');
const getPrivateAppsRoot = () => path.join(getForgerHomeRoot(), 'apps');
const getPrivateDataRoot = () => path.join(getForgerHomeRoot(), 'data');
const getBackupsRoot = () => path.join(getForgerHomeRoot(), 'backups');
const getForgerMetadataRoot = () => path.join(getForgerHomeRoot(), '.forger');
const getLegacyForgerMetadataRoot = () => path.join(getPrivateAppsRoot(), '.forger');
const getCodexRoot = () => path.join(app.getPath('userData'), 'codex-cli');
const getCodexHome = () => path.join(app.getPath('userData'), 'codex-home');
const getAgentToolSettingsPath = () => path.join(getForgerMetadataRoot(), 'agent-tools.json');
const getForgerAccountPath = () => path.join(getForgerMetadataRoot(), 'account.json');
const getCloudDevicePath = () => path.join(getForgerMetadataRoot(), 'cloud-device.json');
const getCloudSyncSettingsPath = () => path.join(getForgerMetadataRoot(), 'cloud-sync.json');

const FORGER_TOOL_PACKAGE_ID = 'forger';

const AGENT_TOOL_PACKAGES: AgentToolPackageDefinition[] = [
  {
    id: FORGER_TOOL_PACKAGE_ID,
    name: 'Forger',
    description: 'Built-in tools included with the Forger desktop application.',
    icon: 'forger',
    tools: [
      {
        id: 'forger_list_catalog',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Obtener catalogo',
        description: 'Revisa las apps publicadas y sus versiones disponibles.',
        category: 'consulta',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'forger_list_installed_apps',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Listar apps instaladas',
        description: 'Consulta que apps estan instaladas y su estado actual.',
        category: 'consulta',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'forger_check_updates',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Revisar actualizaciones',
        description: 'Compara versiones instaladas con el catalogo publicado.',
        category: 'consulta',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'memory_list',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Consultar memoria',
        description: 'Consulta preferencias y notas guardadas en la memoria local de Forger.',
        category: 'memoria',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'memory_create',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Guardar memoria',
        description: 'Guarda una preferencia o nota util en la memoria local de Forger.',
        category: 'memoria',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'memory_update',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Actualizar memoria',
        description: 'Actualiza una preferencia o nota guardada en la memoria local de Forger.',
        category: 'memoria',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'memory_delete',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Eliminar memoria',
        description: 'Elimina una preferencia o nota guardada en la memoria local de Forger.',
        category: 'memoria',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'forger_get_app_runtime_status',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Consultar estado de app',
        description: 'Revisa si una app esta abierta, detenida o requiere atencion.',
        category: 'consulta',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'forger_open_app',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Abrir app',
        description: 'Inicia una app instalada y abre su ventana.',
        category: 'app',
        risk: 'medio',
        defaultRequiresApproval: true,
      },
      {
        id: 'forger_stop_app',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Cerrar app',
        description: 'Detiene una app abierta y cierra sus servicios locales.',
        category: 'app',
        risk: 'medio',
        defaultRequiresApproval: true,
      },
      {
        id: 'forger_restart_app',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Reiniciar app',
        description: 'Cierra y vuelve a abrir una app instalada.',
        category: 'app',
        risk: 'medio',
        defaultRequiresApproval: true,
      },
      {
        id: 'forger_refresh_app_view',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Refrescar vista',
        description: 'Refresca la ventana de una app que ya esta abierta.',
        category: 'vista',
        risk: 'medio',
        defaultRequiresApproval: true,
      },
      {
        id: 'forger_update_app',
        packageId: FORGER_TOOL_PACKAGE_ID,
        name: 'Actualizar app',
        description: 'Aplica una nueva version publicada cuando esta disponible.',
        category: 'actualizacion',
        risk: 'alto',
        defaultRequiresApproval: true,
      },
    ],
  },
  {
    id: 'official:gmail',
    name: 'Gmail',
    description: 'Herramienta oficial para buscar, leer y enviar correos de Gmail.',
    icon: 'forger',
    tools: [
      {
        id: 'gmail.connection.status',
        packageId: 'official:gmail',
        name: 'Estado de Gmail',
        description: 'Revisa si la cuenta de Gmail esta conectada.',
        category: 'consulta',
        risk: 'bajo',
        defaultRequiresApproval: false,
      },
      {
        id: 'gmail.search_messages',
        packageId: 'official:gmail',
        name: 'Buscar correos',
        description: 'Busca correos de Gmail usando una consulta.',
        category: 'consulta',
        risk: 'medio',
        defaultRequiresApproval: true,
      },
      {
        id: 'gmail.read_thread',
        packageId: 'official:gmail',
        name: 'Leer correo',
        description: 'Lee una conversacion o mensaje de Gmail.',
        category: 'consulta',
        risk: 'alto',
        defaultRequiresApproval: true,
      },
      {
        id: 'gmail.send_email',
        packageId: 'official:gmail',
        name: 'Enviar correo',
        description: 'Envia un correo desde Gmail.',
        category: 'app',
        risk: 'alto',
        defaultRequiresApproval: true,
      },
    ],
  },
];

const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = AGENT_TOOL_PACKAGES.flatMap((toolPackage) => toolPackage.tools);

const AGENT_TOOL_IDS = new Set<AgentToolId>(AGENT_TOOL_DEFINITIONS.map((tool) => tool.id));

let agentToolSettings: AgentToolSettings = {
  approvals: AGENT_TOOL_DEFINITIONS.reduce((acc, tool) => {
    acc[tool.id] = tool.defaultRequiresApproval;
    return acc;
  }, {} as AgentToolApprovalSettings),
};

let forgerMcpServer: ForgerMcpServer | null = null;

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
    agentToolSettings = normalizeAgentToolSettings(JSON.parse(raw) as Partial<AgentToolSettings>);
  } catch {
    agentToolSettings = normalizeAgentToolSettings();
  }
};

const saveAgentToolSettings = async (): Promise<void> => {
  await fs.mkdir(path.dirname(getAgentToolSettingsPath()), { recursive: true });
  await fs.writeFile(getAgentToolSettingsPath(), JSON.stringify(agentToolSettings, null, 2), 'utf8');
};

const updateAgentToolApproval = async (input: UpdateAgentToolApprovalInput): Promise<AgentToolSettings> => {
  if (!isAgentToolId(input.toolId)) {
    throw new Error('invalid_agent_tool_id');
  }
  agentToolSettings = normalizeAgentToolSettings({
    approvals: {
      ...agentToolSettings.approvals,
      [input.toolId]: Boolean(input.requiresApproval),
    },
  });
  await saveAgentToolSettings();
  return agentToolSettings;
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

const runtimeError = (message: string, technicalCode: string): InstallAppResult => ({
  success: false,
  phase: 'failed',
  userMessage: message,
  technicalCode,
});

const failureDiagnostic = (error: unknown, fallbackCode: string) =>
  buildFailureDiagnostic({ error, fallbackCode });

const emitInstallProgress = (appId: string, payload: InstallAppResult): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.installProgress, {
    appId,
    progress: payload,
  });
};

const emitRuntimeStatus = (payload: RuntimeStatus): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.runtimeStatusChanged, payload);
};

const emitChatRunUpdated = (payload: { run: unknown }): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.chatRunUpdated, payload);
};

const emitAutomationUpdated = (payload: { automation: unknown; run?: unknown }): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.automationUpdated, payload);
};

const emitDesktopUpdateProgress = (payload: DesktopUpdateState): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.desktopUpdateProgress, payload);
};

process.on('uncaughtException', (error) => {
  desktopErrorReporter?.reportMainUncaughtException(error);
});

process.on('unhandledRejection', (reason) => {
  desktopErrorReporter?.reportMainUnhandledRejection(reason);
});

const getDesktopUpdater = (): DesktopUpdater => {
  if (!desktopUpdater) {
    desktopUpdater = new DesktopUpdater({
      currentVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
      onStateChanged: emitDesktopUpdateProgress,
    });
  }
  return desktopUpdater;
};

const toAppSummary = (record: InstalledAppRecord): AppSummary => {
  const running = runningApps.get(record.appId);
  const catalog = catalogApps.find((entry) => entry.id === record.appId);
  const latestVersion = catalog?.latestVersion;
  const updateAvailable = isVersionNewer(latestVersion, record.version);
  const base = {
    capabilities: catalog?.capabilities,
    changelog: catalog?.changelog,
    iconUrl: catalog?.iconUrl,
    beta: catalog?.beta,
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
  if (normalizedCandidate && normalizedCurrent) {
    return normalizedCandidate > normalizedCurrent;
  }
  return false;
};

const normalizeChangelog = (value: unknown, version?: string): VersionChangelog | undefined => {
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const raw = entry as { version?: unknown; summary?: unknown; changes?: unknown };
    const entryVersion = typeof raw.version === 'string' ? raw.version : version;
    if (version && entryVersion && entryVersion !== version) {
      continue;
    }
    const changes = Array.isArray(raw.changes)
      ? raw.changes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    return {
      version: entryVersion ?? version ?? '',
      summary: typeof raw.summary === 'string' ? raw.summary : undefined,
      changes,
    };
  }
  return undefined;
};

const mapBackendCategory = (backendCategory: string): AppCategory => {
  switch (backendCategory) {
    case 'finance':
      return 'finanzas';
    case 'home':
      return 'hogar';
    case 'health':
      return 'salud';
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

const normalizeToken = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  return value.trim().toLowerCase();
};

const ensurePathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(relative));
};

const toPosixRelativePath = (value: string): string => value.replace(/\\/g, '/');

const resolveInstalledManifest = async (installDir: string): Promise<AppManifest | null> => {
  const manifestPath = path.join(installDir, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as AppManifest;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const getSecretsStore = (): SecretsStore => {
  if (!secretsStore) {
    secretsStore = new SecretsStore(app.getPath('userData'));
  }
  return secretsStore;
};

const getOfficialToolsService = (): OfficialToolsService => {
  if (!officialToolsService) {
    officialToolsService = new OfficialToolsService({
      metadataRoot: getForgerMetadataRoot(),
      secretsStore: getSecretsStore(),
      getFreePort,
      openExternalUrl: async (url) => {
        await shell.openExternal(url);
      },
      isForgerAccountAuthenticated: () => Boolean(forgerAccount.token),
      getGmailOAuthClientId: async () => {
        if (!forgerAccount.token || !forgerBackendClient) {
          throw new Error('forger_account_required');
        }
        return await forgerBackendClient.getGmailOAuthClientId();
      },
      exchangeGmailOAuthCode: async (input) => {
        if (!forgerAccount.token || !forgerBackendClient) {
          throw new Error('forger_account_required');
        }
        return await forgerBackendClient.exchangeGmailOAuthCode(input);
      },
      refreshGmailOAuthAccessToken: async (input) => {
        if (!forgerAccount.token || !forgerBackendClient) {
          throw new Error('forger_account_required');
        }
        return await forgerBackendClient.refreshGmailOAuthAccessToken(input);
      },
      appendLog: appendInstallLog,
      getAppToolDeclarations: resolveAppToolDeclarations,
    });
  }
  return officialToolsService;
};

const getMemoryStore = (): MemoryStore => {
  if (!memoryStore) {
    memoryStore = new MemoryStore(getForgerMetadataRoot());
  }
  return memoryStore;
};

const buildMemoryContextForApps = async (appIds: string[]): Promise<string> => {
  return await getMemoryStore().buildContext({ caller: 'automation', appIds });
};

const buildMemoryContextForApp = async (appId: string): Promise<string> => {
  return await getMemoryStore().buildContext({ caller: 'app-agent', appId, appIds: [appId] });
};

const buildForgerToolsContextForApp = async (appId: string): Promise<string> => {
  const state = await getOfficialToolsService().list().catch(() => null);
  const gmail = state?.tools.find((tool) => tool.id === 'gmail');
  const gmailReady = gmail?.status === 'configured';
  const allowedActions = await getOfficialToolsService().listAgentActionIdsForApp(appId).catch(() => new Set<string>());
  return buildForgerOfficialToolsPromptSection({
    mode: 'app-agent',
    gmailReady,
    allowedActions: [...allowedActions],
  });
};

const buildForgerToolsContextForFreeChat = async (): Promise<string> => {
  const state = await getOfficialToolsService().list().catch(() => null);
  const gmail = state?.tools.find((tool) => tool.id === 'gmail');
  const gmailReady = gmail?.status === 'configured';
  const gmailActions = AGENT_TOOL_DEFINITIONS
    .map((tool) => tool.id)
    .filter((toolId) => toolId.startsWith('gmail.'));
  return buildForgerOfficialToolsPromptSection({
    mode: 'free-chat',
    gmailReady,
    allowedActions: gmailActions,
  });
};

const getBackupsManager = (): BackupsManager => {
  if (!backupsManager) {
    backupsManager = new BackupsManager({
      backupsRoot: getBackupsRoot(),
      listInstalledApps: () => Object.values(registry.apps).map((record) => ({
        appId: record.appId,
        name: record.name,
        version: record.version,
        installDir: record.installDir,
      })),
      getInstalledApp: (appId) => {
        const record = registry.apps[appId];
        return record
          ? {
              appId: record.appId,
              name: record.name,
              version: record.version,
              installDir: record.installDir,
            }
          : undefined;
      },
      isAppRunning: (appId) => runningApps.has(appId),
      log: appendInstallLog,
    });
  }
  return backupsManager;
};

const createRemoteAppBackup = async (
  input: CreateRemoteAppBackupInput,
): Promise<{ success: boolean; userMessage: string; technicalCode?: string; remoteBackup?: RemoteAppBackupSummary }> => {
  if (!forgerBackendClient) {
    return { success: false, userMessage: 'No pudimos conectar con Forger Cloud.', technicalCode: 'backend_client_missing' };
  }
  if (!forgerAccount.authenticated || !forgerAccount.token) {
    return { success: false, userMessage: 'Inicia sesion en Forger Cloud para usar esta funcionalidad.', technicalCode: 'cloud_account_required' };
  }
  if (!canUseCloudDataSync()) {
    return { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.', technicalCode: 'subscription_required' };
  }

  const localBackup = await getBackupsManager().createBackup({ appId: input.appId, reason: 'manual' });
  if (!localBackup.success || !localBackup.backup) {
    return localBackup;
  }
  const backupDir = getBackupsManager().backupDirectory(localBackup.backup.appId, localBackup.backup.backupId);
  if (!backupDir) {
    return { success: false, userMessage: 'No pudimos preparar el respaldo para subir.', technicalCode: 'local_backup_missing' };
  }

  const archivePath = path.join(getTempRoot(), 'cloud-backups', `${localBackup.backup.appId}-${localBackup.backup.backupId}.zip`);
  await fs.rm(archivePath, { force: true }).catch(() => undefined);
  await zipDirectory(backupDir, archivePath);

  try {
    return await forgerBackendClient.createRemoteBackup({
      archivePath,
      localBackup: localBackup.backup,
      backupType: input.backupType,
      source: input.source ?? 'manual',
    });
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
  }
};

const restoreRemoteAppBackup = async (remoteBackupId: number): Promise<BasicActionResult> => {
  if (!forgerBackendClient) {
    return { success: false, userMessage: 'No pudimos conectar con Forger Cloud.', technicalCode: 'backend_client_missing' };
  }
  if (!canUseCloudDataSync()) {
    return { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.', technicalCode: 'subscription_required' };
  }

  const remoteBackup = (await forgerBackendClient.listRemoteBackups()).backups.find((backup) => backup.id === remoteBackupId);
  if (!remoteBackup) {
    return { success: false, userMessage: 'No encontramos ese respaldo cloud.', technicalCode: 'remote_backup_not_found' };
  }

  const downloadPath = path.join(getTempRoot(), 'cloud-backups', `${remoteBackup.id}.zip`);
  const extractDir = path.join(getTempRoot(), 'cloud-backups', `${remoteBackup.id}-extracted-${Date.now()}`);
  await fs.rm(downloadPath, { force: true }).catch(() => undefined);
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);

  try {
    const download = await forgerBackendClient.downloadRemoteBackup(remoteBackup.id, downloadPath);
    const actualChecksum = await hashFileSha256(downloadPath);
    const expectedChecksum = download.checksumSha256 || remoteBackup.checksumSha256;
    if (expectedChecksum && actualChecksum !== expectedChecksum) {
      throw new Error('remote_backup_checksum_mismatch');
    }
    await validateArchiveEntries(downloadPath);
    await extractArchive(downloadPath, extractDir);
    return await getBackupsManager().restoreBackupDirectory({ appId: remoteBackup.appId, backupDir: extractDir });
  } finally {
    await fs.rm(downloadPath, { force: true }).catch(() => undefined);
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const syncAppToCloudIfEnabled = async (appId: string): Promise<void> => {
  if (!cloudSyncSettings.appSync[appId]?.autoSync || !canUseCloudDataSync()) {
    return;
  }
  const result = await createRemoteAppBackup({ appId, backupType: 'sync_snapshot', source: 'auto_sync' });
  await appendInstallLog(result.success ? 'cloud_sync:auto_success' : 'cloud_sync:auto_failed', {
    appId,
    technicalCode: result.technicalCode,
  });
};

const RESERVED_APP_SECRET_ENV_NAMES = new Set([
  'APPDATA',
  'CORS_ORIGINS',
  'DATABASE_URL',
  'ELECTRON_RUN_AS_NODE',
  'HOME',
  'NODE_ENV',
  'PATH',
  'PORT',
  'PYTHONHOME',
  'PYTHONPATH',
  'SHELL',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'VITE_API_BASE_URL',
]);

const isReservedAppSecretEnvName = (envName: string): boolean =>
  RESERVED_APP_SECRET_ENV_NAMES.has(envName) || envName.startsWith('NPM_');

const normalizeAppSecretDeclaration = (value: unknown): AppSecretDeclaration | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<AppSecretDeclaration>;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const usage = typeof candidate.usage === 'string' ? candidate.usage.trim() : '';
  const envName = appSecretEnvName(name);
  if (!name || !usage || !envName || isReservedAppSecretEnvName(envName)) {
    return null;
  }

  const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : undefined;
  return {
    name,
    required: candidate.required === true,
    usage,
    ...(label ? { label } : {}),
  };
};

const normalizeManifestAppSecrets = (manifest: AppManifest | null): AppSecretDeclaration[] => {
  if (!manifest || !Array.isArray(manifest.appSecrets)) {
    return [];
  }

  const seenNames = new Set<string>();
  const seenEnvNames = new Set<string>();
  const declarations: AppSecretDeclaration[] = [];
  for (const entry of manifest.appSecrets) {
    const declaration = normalizeAppSecretDeclaration(entry);
    if (!declaration) {
      continue;
    }
    const envName = appSecretEnvName(declaration.name);
    if (seenNames.has(declaration.name) || seenEnvNames.has(envName)) {
      continue;
    }
    seenNames.add(declaration.name);
    seenEnvNames.add(envName);
    declarations.push(declaration);
  }

  return declarations;
};

const resolveAppToolDeclarations = async (
  appId: string,
): Promise<{ appName: string; required: AppToolDeclaration[]; optional: AppToolDeclaration[] } | null> => {
  const record = registry.apps[appId];
  if (record?.installDir) {
    const manifest = await resolveInstalledManifest(record.installDir);
    const declarations = normalizeAppToolDeclarations(manifest?.tools);
    return {
      appName: record.name ?? appId,
      ...declarations,
    };
  }

  const catalog = catalogApps.find((entry) => entry.id === appId);
  if (!catalog) {
    return null;
  }
  const declarations = normalizeAppToolDeclarations(catalog.tools);
  return {
    appName: catalog.name ?? appId,
    ...declarations,
  };
};

const normalizeManifestPromptTemplates = (manifest: AppManifest | null): AppPromptTemplate[] => {
  if (!manifest || !Array.isArray(manifest.promptTemplates)) {
    return [];
  }

  const seenIds = new Set<string>();
  const templates: AppPromptTemplate[] = [];
  for (const entry of manifest.promptTemplates) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Partial<AppPromptTemplate>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
    if (!id || !title || !prompt || seenIds.has(id)) {
      continue;
    }
    const description =
      typeof candidate.description === 'string' && candidate.description.trim()
        ? candidate.description.trim()
        : undefined;
    const acceptedFileTypes = Array.isArray(candidate.acceptedFileTypes)
      ? candidate.acceptedFileTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    const args = normalizePromptTemplateArguments(candidate.arguments);
    seenIds.add(id);
    templates.push({
      id,
      title,
      prompt,
      ...(description ? { description } : {}),
      ...(args.length > 0 ? { arguments: args } : {}),
      ...(acceptedFileTypes && acceptedFileTypes.length > 0 ? { acceptedFileTypes } : {}),
    });
  }
  return templates;
};

const normalizeManifestAgents = (manifest: AppManifest | null): AppAgent[] => {
  const agents: AppAgent[] = [];
  const seenIds = new Set<string>();
  if (manifest && Array.isArray(manifest.agents)) {
    for (const entry of manifest.agents) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const candidate = entry as Partial<AppAgent>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      const initialPrompt =
        typeof candidate.initialPrompt === 'string' ? candidate.initialPrompt.trim() : '';
      if (!id || !title || !initialPrompt || seenIds.has(id)) {
        continue;
      }
      const description =
        typeof candidate.description === 'string' && candidate.description.trim()
          ? candidate.description.trim()
          : undefined;
      seenIds.add(id);
      agents.push({
        id,
        title,
        initialPrompt,
        ...(description ? { description } : {}),
      });
    }
  }

  if (
    agents.length === 0 &&
    manifest?.codexConversation &&
    typeof manifest.codexConversation === 'object' &&
    (manifest.codexConversation as Record<string, unknown>).enabled === true
  ) {
    agents.push({
      id: 'legacy-codex-conversation',
      title: 'App Agent',
      description: 'Conversacion asistida declarada por la app.',
      initialPrompt: 'Ayuda al usuario con esta app usando su documentacion y herramientas disponibles.',
      legacy: true,
    });
  }

  return agents;
};

const normalizePromptTemplateArguments = (input: unknown): NonNullable<AppPromptTemplate['arguments']> => {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenNames = new Set<string>();
  const args: NonNullable<AppPromptTemplate['arguments']> = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const type = candidate.type === 'file' || candidate.type === 'string' ? candidate.type : null;
    if (!name || !type || seenNames.has(name)) {
      continue;
    }
    const acceptedFileTypes = Array.isArray(candidate.acceptedFileTypes)
      ? candidate.acceptedFileTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    const maxBytes = typeof candidate.maxBytes === 'number' && Number.isFinite(candidate.maxBytes) && candidate.maxBytes > 0
      ? candidate.maxBytes
      : undefined;
    const maxLength = typeof candidate.maxLength === 'number' && Number.isFinite(candidate.maxLength) && candidate.maxLength > 0
      ? candidate.maxLength
      : undefined;
    seenNames.add(name);
    args.push({
      name,
      type,
      ...(candidate.required === true ? { required: true } : {}),
      ...(candidate.multiple === true ? { multiple: true } : {}),
      ...(acceptedFileTypes && acceptedFileTypes.length > 0 ? { acceptedFileTypes } : {}),
      ...(maxBytes ? { maxBytes } : {}),
      ...(maxLength ? { maxLength } : {}),
    });
  }
  return args;
};

const resolveInstalledPromptTemplates = async (appId: string): Promise<AppPromptTemplate[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  return normalizeManifestPromptTemplates(await resolveInstalledManifest(record.installDir));
};

const resolveInstalledAgents = async (appId: string): Promise<AppAgent[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  return normalizeManifestAgents(await resolveInstalledManifest(record.installDir));
};

const hasInstalledCodexConversation = async (appId: string): Promise<boolean> =>
  (await resolveInstalledAgents(appId)).length > 0;

const getManifestAppSecretsValidationError = (manifest: AppManifest | null): string | null => {
  if (!manifest || !Array.isArray(manifest.appSecrets)) {
    return null;
  }

  const seenNames = new Set<string>();
  const seenEnvNames = new Set<string>();
  for (const entry of manifest.appSecrets) {
    if (!entry || typeof entry !== 'object') {
      return 'La app declara un secreto invalido.';
    }

    const candidate = entry as Partial<AppSecretDeclaration>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const usage = typeof candidate.usage === 'string' ? candidate.usage.trim() : '';
    const envName = appSecretEnvName(name);

    if (!name || !usage || !envName) {
      return 'La app declara un secreto incompleto.';
    }
    if (isReservedAppSecretEnvName(envName)) {
      return `La app declara un secreto con un nombre reservado: ${envName}.`;
    }
    if (seenNames.has(name) || seenEnvNames.has(envName)) {
      return `La app declara secretos duplicados para la variable ${envName}.`;
    }

    seenNames.add(name);
    seenEnvNames.add(envName);
  }

  return null;
};

const resolveInstalledAppSecrets = async (appId: string): Promise<AppSecretDeclaration[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  const manifest = await resolveInstalledManifest(record.installDir);
  return normalizeManifestAppSecrets(manifest);
};

const buildAppSecretsState = async (appId: string): Promise<AppSecretsState> => {
  const record = registry.apps[appId];
  const declarations = await resolveInstalledAppSecrets(appId);
  const store = getSecretsStore();
  const userSecrets = await store.listUserSecrets();
  const userSecretById = new Map(userSecrets.map((secret) => [secret.id, secret]));
  const appSecrets: AppSecretConnection[] = [];

  for (const declaration of declarations) {
    const userSecretId = await store.getMappedSecretId(appId, declaration.name);
    const userSecret = userSecretId ? userSecretById.get(userSecretId) : undefined;
    appSecrets.push({
      appSecret: declaration,
      envName: appSecretEnvName(declaration.name),
      connected: Boolean(userSecret),
      ...(userSecret ? { userSecretId: userSecret.id, userSecretName: userSecret.name } : {}),
    });
  }

  return {
    appId,
    appName: record?.name ?? appId,
    appSecrets,
    userSecrets,
  };
};

const formatProcessOutputForInstallLog = (value: string, secretValues: string[]): string =>
  secretValues.length > 0
    ? '[salida omitida porque la app recibio secretos]'
    : value;

const hasValidManifestStack = (manifest: AppManifest | null): manifest is AppManifest & { stack: AppManifestStack } => {
  if (!manifest?.stack || typeof manifest.stack !== 'object') {
    return false;
  }
  const backend = manifest.stack.backend && typeof manifest.stack.backend === 'object';
  const frontend = manifest.stack.frontend && typeof manifest.stack.frontend === 'object';
  return Boolean(backend || frontend);
};

const ensureGlobalAgentsContext = async (forgerHomeRoot: string): Promise<void> => {
  await fs.mkdir(forgerHomeRoot, { recursive: true });
  const agentsPath = path.join(forgerHomeRoot, 'AGENTS.md');
  await fs.writeFile(agentsPath, buildGlobalForgerAgentsMarkdown(), 'utf8');
  const skillsRoot = path.join(forgerHomeRoot, '.agents', 'skills');
  await writeSkillTemplates(skillsRoot, buildForgerOfficialToolSkillTemplates());
};

const shouldWriteAppAgentsMarkdown = async (agentsPath: string): Promise<boolean> => {
  const current = await fs.readFile(agentsPath, 'utf8').catch(() => null);
  if (current === null) {
    return true;
  }

  if (!current.includes(FORGER_AGENT_CONTRACT_MARKER_PREFIX)) {
    return false;
  }

  return !current.includes(FORGER_AGENT_CONTRACT_MARKER);
};

const buildStackSkillTemplates = (stack: AppManifestStack, hasAppMcp = false): StackSkillTemplate[] => {
  const templates: StackSkillTemplate[] = buildForgerOfficialToolSkillTemplates();
  const backend = stack.backend ?? {};
  const frontend = stack.frontend ?? {};
  const backendLanguage = normalizeToken(backend.language);
  const backendFramework = normalizeToken(backend.framework);
  const frontendFramework = normalizeToken(frontend.framework);
  const frontendUi = normalizeToken(frontend.ui);

  if (backendLanguage === 'python') {
    templates.push({
      id: 'forger-python-backend',
      description: 'Best practices for Python backends in Forger.',
      body: [
        '---',
        'name: forger-python-backend',
        'description: Use small, safe Python backend changes focused on validation and integrity.',
        '---',
        '',
        '- Keep domain validations before persisting data.',
        '- Avoid breaking payload compatibility without explaining the impact.',
        '- Prefer clear, testable changes that are easy to revert.',
      ].join('\n'),
    });
  }

  if (backendFramework === 'fastapi') {
    templates.push({
      id: 'forger-fastapi-contracts',
      description: 'Guidance for contracts and safety in FastAPI endpoints.',
      body: [
        '---',
        'name: forger-fastapi-contracts',
        'description: Adjust FastAPI routes while preserving contracts and consistent responses for non-technical users.',
        '---',
        '',
        '- Keep HTTP semantics consistent.',
        '- Do not remove response fields used by the frontend without a migration plan.',
        '- Return errors with clear, actionable messages.',
      ].join('\n'),
    });
  }

  if (frontendFramework === 'react') {
    templates.push({
      id: 'forger-react-ui',
      description: 'React UI best practices for non-technical users.',
      body: [
        '---',
        'name: forger-react-ui',
        'description: Prioritize clear flows with saved versions, adjustments, and return-to-previous-version behavior in React interfaces.',
        '---',
        '',
        '- Use simple action-oriented copy.',
        '- Avoid ambiguous states; clearly show success, error, and next steps.',
        '- Keep components predictable and easy to extend.',
        '- When the user asks for visible changes, describe screens, buttons, and flows instead of implementation.',
      ].join('\n'),
    });
  }

  if (frontendUi === 'mui') {
    templates.push({
      id: 'forger-mui-consistency',
      description: 'Visual consistency and accessibility in MUI.',
      body: [
        '---',
        'name: forger-mui-consistency',
        'description: Use consistent MUI patterns to keep the experience stable.',
        '---',
        '',
        '- Reuse MUI components before creating ad hoc variants.',
        '- Keep visual hierarchy simple and messages easy to understand.',
        '- Do not introduce styles that make maintenance harder.',
      ].join('\n'),
    });
  }

  if (hasAppMcp) {
    templates.push({
      id: 'forger-app-mcp-data-tools',
      description: 'Use app MCP tools for structured Forger app data operations.',
      body: [
        '---',
        'name: forger-app-mcp-data-tools',
        'description: Prefer app MCP tools when app data needs to be read, exposed, created, edited, deleted, imported, or validated.',
        '---',
        '',
        '- Review the app `AGENTS.md` and `manifest.json` before using tools.',
        '- Use app MCP tools before scripts, direct database access, or ad hoc endpoint calls for structured data operations.',
        '- Treat MCP tools as internal agent tools, not user-visible commands.',
        '- Let MCP validation errors shape the user-facing answer: explain missing data, rejected records, invalid categories, duplicates, or unsupported operations in product language.',
        '- If MCP does not expose the needed operation, fall back to documented scripts or endpoints when they preserve app validations.',
        '- Avoid direct SQL writes unless there is no MCP or documented tool for the task and the change is narrow, validated, and safe.',
        '- Confirm before destructive or irreversible data changes.',
      ].join('\n'),
    });
  }

  return templates;
};

const writeSkillTemplates = async (skillsRoot: string, templates: StackSkillTemplate[]): Promise<void> => {
  for (const template of templates) {
    const targetDir = path.join(skillsRoot, template.id);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), template.body, 'utf8');
    await fs.writeFile(path.join(targetDir, 'README.md'), `${template.description}\n`, 'utf8');
  }
};

const copyDirectory = async (sourceDir: string, targetDir: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
};

const writeStackSkills = async (skillsRoot: string, stack: AppManifestStack, hasAppMcp = false): Promise<void> => {
  await writeSkillTemplates(skillsRoot, buildStackSkillTemplates(stack, hasAppMcp));
};

const copyAppSkills = async (installDir: string, skillsRoot: string, manifest: AppManifest): Promise<void> => {
  const declared = Array.isArray(manifest.skills) ? manifest.skills : [];
  const resolvedInstallDir = await fs.realpath(installDir);

  for (const entry of declared) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    const sourcePath = path.resolve(installDir, entry);
    const sourcePathReal = await fs.realpath(sourcePath).catch(() => null);
    if (!sourcePathReal || !ensurePathInside(resolvedInstallDir, sourcePathReal)) {
      continue;
    }

    const stat = await fs.stat(sourcePathReal).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }

    const skillName = path.basename(sourcePathReal);
    const destinationPath = path.join(skillsRoot, skillName);
    await copyDirectory(sourcePathReal, destinationPath);
  }
};

const normalizeInstalledAgentContext = async (installDir: string, appId: string): Promise<void> => {
  const manifest = await resolveInstalledManifest(installDir);

  const agentsPath = path.join(installDir, 'AGENTS.md');
  if (await shouldWriteAppAgentsMarkdown(agentsPath)) {
    await fs.writeFile(agentsPath, buildForgerAppAgentsMarkdown(appId, manifest), 'utf8');
  }

  const hasStack = hasValidManifestStack(manifest);
  const hasAppMcp = Boolean(
    manifest?.mcp
    && typeof manifest.mcp === 'object'
    && (!manifest.mcp.type || manifest.mcp.type === 'http')
    && typeof manifest.mcp.command === 'string',
  );
  const hasAppSkills = Boolean(manifest && Array.isArray(manifest.skills) && manifest.skills.length > 0);
  if (!hasStack && !hasAppSkills && !hasAppMcp) {
    return;
  }

  const skillsRoot = path.join(installDir, '.agents', 'skills');
  await fs.rm(skillsRoot, { recursive: true, force: true });
  await fs.mkdir(skillsRoot, { recursive: true });
  if (hasStack) {
    await writeStackSkills(skillsRoot, manifest.stack, hasAppMcp);
  }
  if (!hasStack && hasAppMcp) {
    await writeStackSkills(skillsRoot, {}, hasAppMcp);
  }
  if (manifest) {
    await copyAppSkills(installDir, skillsRoot, manifest);
  }
};

const resolveSelectedAppDisplayName = (appId: string): string => {
  const installedName = registry.apps[appId]?.name?.trim();
  if (installedName) {
    return installedName;
  }
  const catalogName = catalogApps.find((entry) => entry.id === appId)?.name?.trim();
  if (catalogName) {
    return catalogName;
  }
  return appId;
};

const getFileLibrary = (): FileLibrary => {
  if (!fileLibrary) {
    fileLibrary = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
  }
  return fileLibrary;
};

const withAppLifecycleLock = async <T>(appId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = appLifecycleLocks.get(appId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => current);
  appLifecycleLocks.set(appId, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (appLifecycleLocks.get(appId) === chain) {
      appLifecycleLocks.delete(appId);
    }
  }
};

const listCatalogFromBackend = async (): Promise<CatalogApp[]> => {
  return forgerBackendClient ? await forgerBackendClient.listCatalogApps() : [];
};

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

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
};

const requiresWindowsShell = (command: string): boolean => {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
};

const runCommand = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    log?: {
      appId?: string;
      phase?: string;
      label?: string;
    };
  },
): Promise<void> => {
  const useShell = requiresWindowsShell(command);

  if (options.log) {
    await appendInstallLog('command:start', {
      appId: options.log.appId,
      phase: options.log.phase,
      label: options.log.label,
      command,
      args,
      cwd: options.cwd,
      shell: useShell,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: useShell,
      stdio: 'pipe',
    });

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (options.log) {
        void appendInstallLog('command:error', {
          appId: options.log.appId,
          phase: options.log.phase,
          label: options.log.label,
          command,
          args,
          cwd: options.cwd,
          shell: useShell,
          error: serializeErrorForInstallLog(error),
          stdout: truncateForInstallLog(stdout),
          stderr: truncateForInstallLog(stderr),
        });
      }
      reject(error);
    });

    child.on('exit', (code, signal) => {
      if (options.log) {
        void appendInstallLog('command:exit', {
          appId: options.log.appId,
          phase: options.log.phase,
          label: options.log.label,
          command,
          args,
          cwd: options.cwd,
          shell: useShell,
          code,
          signal,
          stdout: truncateForInstallLog(stdout),
          stderr: truncateForInstallLog(stderr),
        });
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new CommandFailedError(command, args, options.cwd, code, signal, stdout, stderr));
    });
  });
};

const runCommandCapture = async (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const useShell = requiresWindowsShell(command);

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: useShell,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('command_timeout'));
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
};

const zipDirectory = async (sourceDir: string, zipPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  if (process.platform === 'win32') {
    const escapedSource = path.join(sourceDir, '*').replace(/'/g, "''");
    const escapedZip = zipPath.replace(/'/g, "''");
    await runCommand(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${escapedSource}' -DestinationPath '${escapedZip}' -Force`],
      { cwd: sourceDir },
    );
    return;
  }

  await runCommand('zip', ['-qry', zipPath, '.'], { cwd: sourceDir });
};

const canRunCommand = async (command: string, args: string[]): Promise<boolean> => {
  try {
    await runCommand(command, args, {
      cwd: app.getPath('userData'),
    });
    return true;
  } catch {
    return false;
  }
};

const ensureGitAvailable = async (): Promise<void> => {
  if (await canRunCommand('git', ['--version'])) {
    return;
  }

  if (process.platform === 'darwin') {
    if (await canRunCommand('brew', ['--version'])) {
      await runCommand('brew', ['install', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    }
  } else if (process.platform === 'win32') {
    if (await canRunCommand('winget', ['--version'])) {
      await runCommand(
        'winget',
        ['install', '--id', 'Git.Git', '-e', '--accept-package-agreements', '--accept-source-agreements'],
        { cwd: app.getPath('userData') },
      ).catch(() => undefined);
    }
  } else {
    if (await canRunCommand('apt-get', ['--version'])) {
      await runCommand('apt-get', ['update'], { cwd: app.getPath('userData') }).catch(() => undefined);
      await runCommand('apt-get', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('dnf', ['--version'])) {
      await runCommand('dnf', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('yum', ['--version'])) {
      await runCommand('yum', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('apk', ['--version'])) {
      await runCommand('apk', ['add', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    }
  }

  if (!(await canRunCommand('git', ['--version']))) {
    throw new Error('git_unavailable');
  }
};

const ensureGitMainBranch = async (cwd: string): Promise<void> => {
  await runCommand('git', ['checkout', 'main'], { cwd }).catch(async () => {
    await runCommand('git', ['checkout', '-B', 'main'], { cwd });
  });
};

const LOCAL_GIT_EXCLUDE_RULES = [
  '',
  '# Forger runtime artifacts',
  'backend/.venv/',
  'backend/__pycache__/',
  'backend/**/__pycache__/',
  'backend/**/*.pyc',
  'backend/.ruff_cache/',
  'backend/.pytest_cache/',
  'backend/data/',
  'frontend/node_modules/',
  'frontend/dist/',
  'frontend/.vite/',
  'frontend/tsconfig.tsbuildinfo',
  '.DS_Store',
];

const ensureForgerLocalGitExcludes = async (cwd: string): Promise<void> => {
  const result = await runCommandCapture('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd,
    timeoutMs: 5_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'git_exclude_path_failed');
  }

  const excludePath = path.resolve(cwd, result.stdout.trim());
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
  const missingRules = LOCAL_GIT_EXCLUDE_RULES.filter((rule) => rule && !existing.split('\n').includes(rule));
  if (missingRules.length === 0) {
    return;
  }

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(excludePath, `${prefix}${missingRules.join('\n')}\n`, 'utf8');
};

const ensureAppGitRepository = async (cwd: string): Promise<void> => {
  await ensureGitAvailable();

  const isRepo = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    .then(() => true)
    .catch(() => false);

  if (!isRepo) {
    await runCommand('git', ['init', '-b', 'main'], { cwd }).catch(async () => {
      await runCommand('git', ['init'], { cwd });
      await ensureGitMainBranch(cwd);
    });
    await runCommand('git', ['config', 'user.email', 'forger@local.invalid'], { cwd }).catch(() => undefined);
    await runCommand('git', ['config', 'user.name', 'Forger'], { cwd }).catch(() => undefined);
    await ensureForgerLocalGitExcludes(cwd);
    await runCommand('git', ['add', '-A'], { cwd }).catch(() => undefined);
    await runCommand('git', ['commit', '--allow-empty', '-m', 'forger: initial state'], { cwd }).catch(
      () => undefined,
    );
    return;
  }

  await runCommand('git', ['config', 'user.email', 'forger@local.invalid'], { cwd }).catch(() => undefined);
  await runCommand('git', ['config', 'user.name', 'Forger'], { cwd }).catch(() => undefined);
  await ensureGitMainBranch(cwd);
  await ensureForgerLocalGitExcludes(cwd);
};

const ensureUserModifiedBranch = async (cwd: string): Promise<void> => {
  await runCommand('git', ['checkout', 'user-modified'], { cwd }).catch(async () => {
    await runCommand('git', ['checkout', '-b', 'user-modified'], { cwd });
  });
};

const getGitStatusLines = async (cwd: string): Promise<string[]> => {
  const result = await runCommandCapture('git', ['status', '--porcelain'], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'git_status_failed');
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const normalizeGitStatusPath = (line: string): string => {
  const rawPath = line.slice(3).trim();
  const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath;
  return renamedPath.replace(/\\/g, '/');
};

const isRuntimeArtifactStatusLine = (line: string): boolean => {
  const filePath = normalizeGitStatusPath(line);
  return (
    filePath === 'frontend/node_modules' ||
    filePath.startsWith('frontend/node_modules/') ||
    filePath === 'frontend/package-lock.json' ||
    filePath === 'backend/.venv' ||
    filePath.startsWith('backend/.venv/') ||
    filePath === 'backend/data' ||
    filePath.startsWith('backend/data/') ||
    filePath === 'frontend/dist' ||
    filePath.startsWith('frontend/dist/') ||
    filePath === 'frontend/.vite' ||
    filePath.startsWith('frontend/.vite/') ||
    filePath.includes('/__pycache__/') ||
    filePath.endsWith('/__pycache__') ||
    filePath.endsWith('.pyc') ||
    filePath.endsWith('tsconfig.tsbuildinfo') ||
    filePath === '.DS_Store'
  );
};

const getUserVisibleGitStatusLines = async (cwd: string): Promise<string[]> =>
  (await getGitStatusLines(cwd)).filter((line) => !isRuntimeArtifactStatusLine(line));

const gitCommitAll = async (cwd: string, message: string): Promise<string> => {
  await runCommand('git', ['add', '-A'], { cwd });
  await runCommand('git', ['commit', '--allow-empty', '-m', message], { cwd });
  const head = await getGitHead(cwd);
  if (!head) {
    throw new Error('missing_git_head_after_commit');
  }
  return head;
};

const getGitHead = async (cwd: string): Promise<string | null> => {
  const result = await runCommandCapture('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 5_000 }).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
};

const getOriginalCommitSha = async (cwd: string): Promise<string | undefined> => {
  const result = await runCommandCapture('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!result || result.code !== 0) {
    return (await getGitHead(cwd)) ?? undefined;
  }
  return result.stdout.split('\n')[0]?.trim() || ((await getGitHead(cwd)) ?? undefined);
};

const clearMacQuarantine = async (targetPath: string): Promise<void> => {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    await fs.access(targetPath);
  } catch {
    return;
  }

  await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetPath], {
    cwd: path.dirname(targetPath),
  }).catch(() => {
    // Best effort: if no xattr is present we can continue.
  });
};

const extractArchive = async (archivePath: string, destination: string): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await runCommand(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
        ],
        { cwd: destination },
      );
      return;
    }

    await runCommand('unzip', ['-q', archivePath, '-d', destination], { cwd: destination });
    return;
  }

  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    await runCommand('tar', ['-xzf', archivePath, '-C', destination], { cwd: destination });
    return;
  }

  throw new Error(`unsupported_archive_format_${archivePath}`);
};

const listZipEntries = async (archivePath: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('archive_open_failed'));
        return;
      }

      const entries: string[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        reject(error);
      };

      zipFile.once('error', fail);
      zipFile.on('entry', (entry: yauzl.Entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.once('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        resolve(entries);
      });
      zipFile.readEntry();
    });
  });

const validateArchiveEntries = async (archivePath: string): Promise<void> => {
  const entries = archivePath.endsWith('.zip')
    ? await listZipEntries(archivePath)
    : archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')
      ? await (async () => {
          const listResult = await runCommandCapture('tar', ['-tzf', archivePath], {
            cwd: path.dirname(archivePath),
            timeoutMs: 30_000,
          });
          if (listResult.code !== 0) {
            throw new Error(listResult.stderr || listResult.stdout || 'archive_list_failed');
          }
          return listResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        })()
      : null;

  if (!entries) {
    throw new Error(`unsupported_archive_format_${archivePath}`);
  }

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      parts.includes('..') ||
      parts.includes('.git') ||
      normalized.includes('/.git/') ||
      normalized.endsWith('/.git')
    ) {
      throw new Error(`unsafe_archive_entry_${normalized}`);
    }
  }
};

const normalizeRelativeInstallPath = (value: string): string | null => {
  const normalized = toPosixRelativePath(value).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
};

const runtimeArtifactRoots = [
  'backend/.venv',
  'backend/data',
  'frontend/node_modules',
  'frontend/dist',
  'frontend/.vite',
];

const isPathAtOrInside = (filePath: string, rootPath: string): boolean =>
  filePath === rootPath || filePath.startsWith(`${rootPath}/`);

const collectPersistentInstallPaths = (manifest: AppManifest | null): string[] => {
  const paths = new Set(runtimeArtifactRoots);
  for (const service of manifest?.services ?? []) {
    for (const volume of service.volumes ?? []) {
      if (!volume?.persist || typeof volume.source !== 'string') {
        continue;
      }
      const normalized = normalizeRelativeInstallPath(volume.source);
      if (normalized) {
        paths.add(normalized);
      }
    }
  }
  return [...paths].sort();
};

const isPreservedInstallPath = (relativePath: string, preservedPaths: string[]): boolean => {
  const normalized = normalizeRelativeInstallPath(relativePath);
  return Boolean(normalized && preservedPaths.some((preservedPath) => isPathAtOrInside(normalized, preservedPath)));
};

const gitCommitAllExcept = async (cwd: string, message: string, excludedPaths: string[]): Promise<string> => {
  await runCommand('git', ['add', '-A'], { cwd });
  const safeExcludedPaths = excludedPaths
    .map((entry) => normalizeRelativeInstallPath(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (safeExcludedPaths.length > 0) {
    await runCommand('git', ['reset', '--', ...safeExcludedPaths], { cwd });
  }
  await runCommand('git', ['commit', '--allow-empty', '-m', message], { cwd });
  const head = await getGitHead(cwd);
  if (!head) {
    throw new Error('missing_git_head_after_commit');
  }
  return head;
};

const removeTrackedFilesMissingFromStage = async (
  stageDir: string,
  installDir: string,
  preservedPaths: string[],
): Promise<void> => {
  const result = await runCommandCapture('git', ['ls-files', '-z'], { cwd: installDir, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'git_ls_files_failed');
  }
  const trackedPaths = result.stdout.split('\0').filter(Boolean);
  await Promise.all(
    trackedPaths.map(async (trackedPath) => {
      const normalized = normalizeRelativeInstallPath(trackedPath);
      if (!normalized || isPreservedInstallPath(normalized, preservedPaths)) {
        return;
      }
      const stagedPath = path.join(stageDir, normalized);
      const stagedStat = await fs.stat(stagedPath).catch(() => null);
      if (stagedStat) {
        return;
      }
      await fs.rm(path.join(installDir, normalized), { recursive: true, force: true });
    }),
  );
};

const copyReleaseContentsForUpdate = async (
  sourceDir: string,
  targetDir: string,
  preservedPaths: string[],
  relativeRoot = '',
): Promise<void> => {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') {
      throw new Error('unsafe_staged_git_entry');
    }
    const relativePath = normalizeRelativeInstallPath(path.posix.join(relativeRoot, entry.name));
    if (!relativePath || isPreservedInstallPath(relativePath, preservedPaths)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const targetStat = await fs.lstat(targetPath).catch(() => null);
    if (targetStat && targetStat.isDirectory() !== entry.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
    }

    if (entry.isDirectory()) {
      await copyReleaseContentsForUpdate(sourcePath, targetPath, preservedPaths, relativePath);
      continue;
    }

    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
    });
  }
};

const syncReleaseIntoInstalledApp = async (
  stageDir: string,
  installDir: string,
  preservedPaths: string[],
): Promise<void> => {
  await copyReleaseContentsForUpdate(stageDir, installDir, preservedPaths);
  await removeTrackedFilesMissingFromStage(stageDir, installDir, preservedPaths);
};

const copyDirectoryContents = async (sourceDir: string, targetDir: string): Promise<void> => {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') {
      throw new Error('unsafe_staged_git_entry');
    }
    await fs.cp(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
    });
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
};

const installFrontendDependenciesWithNpm = async (
  nodePath: string,
  npmPath: string,
  frontendDir: string,
  appId: string,
): Promise<void> => {
  const hasPackageLock = await fileExists(path.join(frontendDir, 'package-lock.json'));
  const args = hasPackageLock ? ['ci'] : ['install', '--package-lock=false'];
  const label = hasPackageLock ? 'npm ci' : 'npm install --package-lock=false';

  await runCommand(npmPath, args, {
    cwd: frontendDir,
    env: {
      PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    log: {
      appId,
      phase: 'installing_frontend',
      label,
    },
  });
};

const installAppDependencies = async (
  appId: string,
  installDir: string,
  nodeVersion: string,
  pythonVersion: string,
  publishProgress: (phase: InstallAppResult['phase'], userMessage: string) => Promise<void>,
): Promise<void> => {
  await publishProgress('preparing_runtime', 'Preparando runtimes compartidos...');
  const nodeRuntime = await ensureRuntimeInstalled('node', nodeVersion);
  const pythonRuntime = await ensureRuntimeInstalled('python', pythonVersion);

  const backendDir = path.join(installDir, 'backend');
  const frontendDir = path.join(installDir, 'frontend');

  await publishProgress('installing_backend', 'Instalando dependencias del backend con uv...');
  await installBackendDependenciesWithUv(pythonRuntime.python as string, backendDir, appId);

  await publishProgress('installing_frontend', 'Instalando dependencias del frontend...');
  await installFrontendDependenciesWithNpm(nodeRuntime.node as string, nodeRuntime.npm as string, frontendDir, appId);
};

const flattenSingleTopLevelDirectory = async (targetDir: string): Promise<void> => {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'));

  if (visibleEntries.length !== 1 || !visibleEntries[0].isDirectory()) {
    return;
  }

  const topFolder = path.join(targetDir, visibleEntries[0].name);
  const children = await fs.readdir(topFolder);
  for (const child of children) {
    await fs.rename(path.join(topFolder, child), path.join(targetDir, child));
  }
  await fs.rm(topFolder, { recursive: true, force: true });
};

const findExistingFile = async (baseDir: string, candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    const attempt = path.join(baseDir, candidate);

    try {
      const stat = await fs.stat(attempt);
      if (stat.isFile()) {
        return attempt;
      }
    } catch {
      // keep searching
    }
  }

  return null;
};

const resolveRuntimeExecutables = async (runtimeRoot: string, type: 'node' | 'python'): Promise<RuntimeBinarySet> => {
  const root = runtimeRoot;

  if (type === 'node') {
    const node = await findExistingFile(root, [
      path.join('bin', 'node'),
      'node.exe',
      path.join('node', 'bin', 'node'),
      path.join('node', 'node.exe'),
    ]);
    const npm = await findExistingFile(root, [
      path.join('bin', 'npm'),
      path.join('bin', 'npm.cmd'),
      'npm.cmd',
      path.join('node', 'bin', 'npm'),
      path.join('node', 'npm.cmd'),
    ]);

    if (!node || !npm) {
      throw new Error('runtime_node_executable_not_found');
    }

    return {
      rootDir: root,
      node,
      npm,
    };
  }

  const python = await findExistingFile(root, [
    path.join('bin', 'python3'),
    path.join('bin', 'python'),
    'python.exe',
    path.join('python', 'bin', 'python3'),
    path.join('python', 'bin', 'python'),
    path.join('python', 'python.exe'),
  ]);
  const pip = await findExistingFile(root, [
    path.join('bin', 'pip3'),
    path.join('bin', 'pip'),
    path.join('Scripts', 'pip.exe'),
    'pip.exe',
    path.join('python', 'bin', 'pip3'),
    path.join('python', 'bin', 'pip'),
    path.join('python', 'Scripts', 'pip.exe'),
    path.join('python', 'pip.exe'),
  ]);

  if (!python) {
    throw new Error('runtime_python_executable_not_found');
  }

  return {
    rootDir: root,
    python,
    pip: pip ?? undefined,
  };
};

const ensureRuntimeInstalled = async (
  type: 'node' | 'python',
  rawVersion: string,
): Promise<RuntimeBinarySet> => {
  const platformAlias = resolvePlatformAlias();
  if (!RUNTIME_PLATFORM_ALIASES.has(platformAlias)) {
    throw new Error(`unsupported_platform_${platformAlias}`);
  }

  const version = type === 'node' ? normalizeNodeRuntimeVersion(rawVersion) : normalizeVersionForFolder(rawVersion);
  const lockKey = `${type}:${version}:${platformAlias}`;
  const pending = runtimeLocks.get(lockKey);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const targetRoot = path.join(getRuntimesRoot(), type, version, platformAlias);
    const readyPath = path.join(targetRoot, '.ready');

    try {
      await fs.access(readyPath);
      await clearMacQuarantine(targetRoot);
      return await resolveRuntimeExecutables(targetRoot, type);
    } catch {
      // continue with extraction
    }

    const resourcesRoot = getBundledResourcesRoot();
    const runtimeVersionDir = path.join(resourcesRoot, type, version);
    const runtimeArchive = await findRuntimeArchive(runtimeVersionDir, platformAlias);

    if (!runtimeArchive) {
      throw new Error(`runtime_archive_missing_${type}_${version}_${platformAlias}`);
    }

    try {
      const runtimeChecksumFile = await findRuntimeChecksumFile(runtimeVersionDir, runtimeArchive, platformAlias);
      if (runtimeChecksumFile) {
        const checksumRaw = await fs.readFile(runtimeChecksumFile, 'utf8');
        const expected = checksumRaw.trim().split(/\s+/)[0];
        if (expected) {
          const current = await hashFileSha256(runtimeArchive);
          if (current !== expected) {
            throw new Error(`runtime_checksum_mismatch_${type}_${version}_${platformAlias}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('runtime_checksum_mismatch')) {
        throw error;
      }
      // Missing checksum file is tolerated in dev mode.
    }

    const tempDir = path.join(getTempRoot(), `${type}-${version}-${platformAlias}-${Date.now()}`);
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await extractArchive(runtimeArchive, tempDir);
    await flattenSingleTopLevelDirectory(tempDir);

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rename(tempDir, targetRoot);
    await fs.writeFile(readyPath, new Date().toISOString(), 'utf8');
    await clearMacQuarantine(targetRoot);

    return await resolveRuntimeExecutables(targetRoot, type);
  })();

  runtimeLocks.set(lockKey, task);

  try {
    return await task;
  } finally {
    runtimeLocks.delete(lockKey);
  }
};

const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const escapeWindowsBatchValue = (value: string): string => value.replace(/%/g, '%%').replace(/"/g, '""');
const quotePowerShellSingle = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const getCodexAuthFilePath = (): string => path.join(getCodexHome(), 'auth.json');

const getRuntimePathEntries = (runtime: RuntimeBinarySet): string[] => {
  const entries = new Set<string>();
  for (const executable of Object.values(runtime)) {
    if (typeof executable === 'string') {
      entries.add(path.dirname(executable));
    }
  }

  return [...entries];
};

const existsDirectory = async (dir: string): Promise<boolean> => {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

const getAppLocalToolPathEntries = async (record: InstalledAppRecord): Promise<string[]> => {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(record.installDir, 'backend', '.venv', 'Scripts'),
          path.join(record.installDir, 'frontend', 'node_modules', '.bin'),
        ]
      : [
          path.join(record.installDir, 'backend', '.venv', 'bin'),
          path.join(record.installDir, 'frontend', 'node_modules', '.bin'),
        ];
  const entries: string[] = [];
  for (const candidate of candidates) {
    if (await existsDirectory(candidate)) {
      entries.push(candidate);
    }
  }
  return entries;
};

const getCodexToolEnvironment = async (
  appId?: string,
  pythonRuntime?: RuntimeBinarySet,
): Promise<Record<string, string>> => {
  const cacheKey = (appId ?? 'global').replace(/[^a-zA-Z0-9._-]/g, '_');
  const cacheRoot = path.join(getForgerMetadataRoot(), 'tool-cache', cacheKey);
  const uvCacheDir = path.join(cacheRoot, 'uv');
  const pipCacheDir = path.join(cacheRoot, 'pip');
  const npmCacheDir = path.join(cacheRoot, 'npm');
  await Promise.all([
    fs.mkdir(uvCacheDir, { recursive: true }),
    fs.mkdir(pipCacheDir, { recursive: true }),
    fs.mkdir(npmCacheDir, { recursive: true }),
  ]);

  const env: Record<string, string> = {
    UV_CACHE_DIR: uvCacheDir,
    PIP_CACHE_DIR: pipCacheDir,
    NPM_CONFIG_CACHE: npmCacheDir,
  };

  if (pythonRuntime?.python) {
    env.UV_PYTHON = pythonRuntime.python;
  }

  const record = appId ? registry.apps[appId] : undefined;
  if (record) {
    env.UV_PROJECT_ENVIRONMENT = path.join(record.installDir, 'backend', '.venv');
    const manifest = await resolveInstalledManifest(record.installDir);
    const backendService = findManifestService(manifest, 'backend', './backend');
    const backendDir = path.join(record.installDir, 'backend');
    const manifestEnvironment =
      backendService?.environment && typeof backendService.environment === 'object'
        ? backendService.environment
        : {};
    Object.assign(env, translateManifestEnvironment(manifestEnvironment, backendDir));
  }

  return env;
};

const resolveCodexCliPath = async (baseDir: string): Promise<string | null> => {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join('node_modules', '.bin', 'codex.cmd'),
          path.join('node_modules', '.bin', 'codex'),
        ]
      : [
    path.join('node_modules', '.bin', 'codex'),
    path.join('node_modules', '.bin', 'codex.cmd'),
        ];

  return await findExistingFile(baseDir, candidates);
};

const getInstalledCodexCliVersion = async (baseDir: string): Promise<string | null> => {
  const packageJsonPath = path.join(baseDir, 'node_modules', '@openai', 'codex', 'package.json');
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

const ensureCodexCliInstalled = async (): Promise<string> => {
  const existing = await resolveCodexCliPath(getCodexRoot());
  const installedVersion = existing ? await getInstalledCodexCliVersion(getCodexRoot()) : null;
  if (existing && installedVersion === CODEX_CLI_VERSION) {
    return existing;
  }
  if (existing && installedVersion !== CODEX_CLI_VERSION) {
    await appendInstallLog('codex_auth:version_mismatch', {
      installedVersion,
      expectedVersion: CODEX_CLI_VERSION,
    });
  }

  const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
  const codexRoot = getCodexRoot();
  await fs.mkdir(codexRoot, { recursive: true });

  const packageJsonPath = path.join(codexRoot, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(
        {
          name: 'forger-codex-runtime',
          private: true,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  await runCommand(
    nodeRuntime.npm as string,
    ['install', '--no-audit', '--no-fund', `@openai/codex@${CODEX_CLI_VERSION}`],
    {
    cwd: codexRoot,
    env: {
      PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    log: {
      phase: 'codex_auth',
      label: 'install codex cli',
    },
    },
  );

  const installed = await resolveCodexCliPath(codexRoot);
  if (!installed) {
    throw new Error('codex_cli_install_failed');
  }

  return installed;
};

const getCodexAuthStatus = async (): Promise<CodexAuthStatus> => {
  const authFilePath = getCodexAuthFilePath();
  const codexHome = getCodexHome();
  const codexCliPath = await resolveCodexCliPath(getCodexRoot());

  let authenticated = false;
  try {
    const raw = await fs.readFile(authFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    authenticated = Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
  } catch {
    authenticated = false;
  }

  return {
    installed: Boolean(codexCliPath),
    authenticated,
    authFilePath,
    codexHome,
    codexCliPath: codexCliPath ?? undefined,
  };
};

const connectCodexAuth = async (): Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields> => {
  try {
    const codexCliPath = await ensureCodexCliInstalled();
    const codexHome = getCodexHome();
    await fs.mkdir(codexHome, { recursive: true });

    if (process.platform === 'darwin') {
      const loginCommand = `export CODEX_HOME=${shellQuote(codexHome)}; ${shellQuote(codexCliPath)} login`;
      await runCommand(
        '/usr/bin/osascript',
        [
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          `do script ${JSON.stringify(loginCommand)}`,
          '-e',
          'end tell',
        ],
        { cwd: app.getPath('userData') },
      );

      return {
        success: true,
        userMessage: 'Abrimos Terminal para completar el login de Codex con ChatGPT.',
      };
    }

    if (process.platform === 'win32') {
      const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      const nodePathPrefix = [
        ...getRuntimePathEntries(nodeRuntime),
        path.dirname(codexCliPath),
      ].join(';');
      const loginLogPath = path.join(getLogsRoot(), 'codex-login.log');
      const loginScriptPath = path.join(getTempRoot(), 'codex-login.cmd');
      const loginScript = [
        '@echo off',
        'title Forger Codex Login',
        `set "CODEX_HOME=${escapeWindowsBatchValue(codexHome)}"`,
        `set "FORGER_CODEX_LOGIN_LOG=${escapeWindowsBatchValue(loginLogPath)}"`,
        `set "PATH=${escapeWindowsBatchValue(nodePathPrefix)};%PATH%"`,
        'echo [%DATE% %TIME%] Batch started >> "%FORGER_CODEX_LOGIN_LOG%"',
        'echo CODEX_HOME=%CODEX_HOME% >> "%FORGER_CODEX_LOGIN_LOG%"',
        'echo PATH=%PATH% >> "%FORGER_CODEX_LOGIN_LOG%"',
        'where node >> "%FORGER_CODEX_LOGIN_LOG%" 2>&1',
        'where npm >> "%FORGER_CODEX_LOGIN_LOG%" 2>&1',
        'where codex >> "%FORGER_CODEX_LOGIN_LOG%" 2>&1',
        'echo [%DATE% %TIME%] Running codex login >> "%FORGER_CODEX_LOGIN_LOG%"',
        `"${escapeWindowsBatchValue(codexCliPath)}" login`,
        'set "FORGER_CODEX_LOGIN_EXIT=%ERRORLEVEL%"',
        'echo [%DATE% %TIME%] Codex login exited with code %FORGER_CODEX_LOGIN_EXIT% >> "%FORGER_CODEX_LOGIN_LOG%"',
        'echo.',
        'echo Codex login finished with exit code %FORGER_CODEX_LOGIN_EXIT%. You can close this window.',
        'pause',
      ].join('\r\n');

      await fs.mkdir(path.dirname(loginLogPath), { recursive: true });
      await fs.mkdir(path.dirname(loginScriptPath), { recursive: true });
      await fs.writeFile(
        loginLogPath,
        [
          `[${new Date().toISOString()}] Forger prepared Codex login.`,
          `codexHome=${codexHome}`,
          `codexCliPath=${codexCliPath}`,
          `loginScriptPath=${loginScriptPath}`,
          `nodePathPrefix=${nodePathPrefix}`,
          '',
        ].join('\r\n'),
        'utf8',
      );
      await fs.writeFile(loginScriptPath, `${loginScript}\r\n`, 'utf8');

      const launchCommand = [
        '$ErrorActionPreference = "Stop"',
        `Start-Process -FilePath ${quotePowerShellSingle('cmd.exe')} -ArgumentList ${quotePowerShellSingle(`/d /k call "${loginScriptPath}"`)} -WorkingDirectory ${quotePowerShellSingle(app.getPath('userData'))}`,
      ].join('; ');

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand],
          {
            cwd: app.getPath('userData'),
            stdio: 'ignore',
            windowsHide: true,
          },
        );

        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error(`powershell Start-Process exited with code ${code ?? 'unknown'}`));
        });
      });

      await appendInstallLog('codex_auth:terminal_opened', {
        platform: process.platform,
        codexHome,
        codexCliPath,
        loginScriptPath,
        loginLogPath,
        nodePathPrefix,
      });

      return {
        success: true,
        userMessage: 'Abrimos una consola para completar el login de Codex con ChatGPT.',
      };
    }

    await runCommand(codexCliPath, ['login'], {
      cwd: app.getPath('userData'),
      env: {
        CODEX_HOME: codexHome,
      },
      log: {
        phase: 'codex_auth',
        label: 'codex login',
      },
    });

    return {
      success: true,
      userMessage: 'Login de Codex completado.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'codex_connect_failed');
    await appendInstallLog('codex_auth:failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos iniciar el login de Codex.',
      ...diagnostic,
    };
  }
};

const disconnectCodexAuth = async (): Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields> => {
  try {
    await fs.rm(getCodexAuthFilePath(), { force: true });
    return {
      success: true,
      userMessage: 'Sesion de Codex desconectada.',
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'codex_logout_failed');
    return {
      success: false,
      userMessage: 'No pudimos cerrar la sesion de Codex.',
      ...diagnostic,
    };
  }
};

const reinstallCodex = async (): Promise<{ success: boolean; userMessage: string; status?: CodexAuthStatus } & FailureDiagnosticFields> => {
  try {
    await fs.rm(getCodexRoot(), { recursive: true, force: true });
    await fs.rm(getCodexHome(), { recursive: true, force: true });
    await fs.mkdir(getCodexRoot(), { recursive: true });
    await fs.mkdir(getCodexHome(), { recursive: true });
    await ensureCodexCliInstalled();
    const status = await getCodexAuthStatus();
    return {
      success: true,
      userMessage: 'Codex fue reinstalado. Vuelve a conectar ChatGPT para usar agentes desde Forger.',
      status,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'codex_reinstall_failed');
    await appendInstallLog('codex_auth:reinstall_failed', {
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos reinstalar Codex.',
      ...diagnostic,
      status: await getCodexAuthStatus().catch(() => undefined),
    };
  }
};

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
  const uvArgs = ['-m', 'uv', 'sync', '--no-install-project', '--no-dev'];

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

const installAppRuntime = async (appId: string): Promise<InstallAppResult> => {
  const catalogApp = catalogApps.find((entry) => entry.id === appId);
  if (!catalogApp) {
    return runtimeError('La app no esta disponible para instalar.', 'catalog_app_missing');
  }

  const toolGate = await getOfficialToolsService().getInstallGate(appId);
  if (toolGate && !toolGate.canInstall) {
    return runtimeError(
      'Esta app necesita herramientas oficiales instaladas y configuradas antes de instalarse.',
      'required_app_tools_missing',
    );
  }

  const initialRecord: InstalledAppRecord = {
    appId,
    category: catalogApp.category,
    name: catalogApp.name ?? appId,
    description: catalogApp.description ?? '',
    version: catalogApp.latestVersion ?? '0.0.0',
    installDir: '',
    requiredNodeVersion: DEFAULT_NODE_VERSION,
    requiredPythonVersion: DEFAULT_PYTHON_VERSION,
    status: 'installing',
    userMessage: 'Preparando instalacion...',
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
    });

    const current = registry.apps[appId];
    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: 'installing',
        userMessage,
      });
    }
  };

  try {
    await publishProgress('starting', 'Iniciando instalacion...');

    const nodeVersion = DEFAULT_NODE_VERSION;
    const pythonVersion = catalogApp.requiredPythonVersion
      ? normalizeVersionForFolder(catalogApp.requiredPythonVersion)
      : DEFAULT_PYTHON_VERSION;

    await publishProgress('downloading', 'Descargando app...');
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

    await publishProgress('extracting', 'Preparando archivos de la app...');
    await appendInstallLog('install:extracting', {
      appId,
      installDir,
      privateAppsRoot: getPrivateAppsRoot(),
    });
    await validateArchiveEntries(download.zipPath);
    await extractArchive(download.zipPath, installDir);
    await flattenSingleTopLevelDirectory(installDir);
    await clearMacQuarantine(installDir);
    await normalizeInstalledAgentContext(installDir, appId);
    await ensureGlobalAgentsContext(getForgerHomeRoot());
    await ensureAppGitRepository(installDir);
    const originalCommitSha = await getOriginalCommitSha(installDir);
    await ensureUserModifiedBranch(installDir);

    await publishProgress('preparing_runtime', 'Preparando runtimes compartidos...');
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

    await publishProgress('installing_backend', 'Instalando dependencias del backend con uv...');
    await installBackendDependenciesWithUv(pythonRuntime.python as string, backendDir, appId);

    await publishProgress('installing_frontend', 'Instalando dependencias del frontend...');
    await installFrontendDependenciesWithNpm(nodeRuntime.node as string, nodeRuntime.npm as string, frontendDir, appId);

    const installed: InstalledAppRecord = {
      appId,
      category: catalogApp.category,
      name: catalogApp.name ?? appId,
      description: catalogApp.description ?? '',
      version: download.version,
      installDir,
      requiredNodeVersion: nodeVersion,
      requiredPythonVersion: pythonVersion,
      status: 'installed',
      userMessage: 'Instalada y lista para abrir.',
      originalCommitSha,
      installedAt: initialRecord.installedAt,
    };
    await upsertInstalledRecord(installed);

    emitInstallProgress(appId, {
      success: true,
      phase: 'completed',
      userMessage: 'Instalacion completada.',
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
      userMessage: 'Instalacion completada.',
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
        userMessage: 'No se pudo instalar. Puedes reintentar.',
      });
    }

    emitInstallProgress(appId, {
      success: false,
      phase: 'failed',
      userMessage: 'No se pudo completar la instalacion. Reintenta.',
      ...diagnostic,
    });

    ensureCatalogStatuses();

    return {
      success: false,
      phase: 'failed',
      userMessage: 'No se pudo completar la instalacion. Reintenta.',
      ...diagnostic,
    };
  }
};

const updateAppRuntime = async (appId: string): Promise<InstallAppResult> => {
  const record = registry.apps[appId];
  const catalogApp = catalogApps.find((entry) => entry.id === appId);
  if (!record?.installDir) {
    return runtimeError('Primero instala esta app.', 'app_not_installed');
  }
  if (!catalogApp) {
    return runtimeError('No pudimos revisar la version disponible.', 'catalog_app_missing');
  }
  if (runningApps.has(appId)) {
    return runtimeError('Deten la app antes de actualizarla.', 'app_running');
  }
  if (record.status === 'conflict') {
    return runtimeError('Esta app ya tiene una actualizacion con conflicto pendiente.', 'app_update_conflict');
  }
  if (!isVersionNewer(catalogApp.latestVersion, record.version)) {
    return {
      success: true,
      phase: 'completed',
      userMessage: 'Ya tienes la version mas reciente.',
    };
  }

  const publishProgress = async (phase: InstallAppResult['phase'], userMessage: string): Promise<void> => {
    emitInstallProgress(appId, { success: true, phase, userMessage });
    const current = registry.apps[appId];
    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: phase === 'conflict' ? 'conflict' : 'installing',
        userMessage,
      });
    }
    await appendInstallLog('update:progress', { appId, phase, userMessage });
  };

  const startedAt = new Date().toISOString();
  const targetVersion = catalogApp.latestVersion ?? catalogApp.version ?? '0.0.0';
  let preUpdateUserHead = '';
  let stageDir: string | null = null;

  const abortUpdateAndRestoreInstalled = async (userMessage: string, technicalCode: string): Promise<InstallAppResult> => {
    const current = registry.apps[appId] ?? record;
    await upsertInstalledRecord({
      ...current,
      status: 'installed',
      userMessage,
    });
    await appendInstallLog('update:blocked', { appId, detail: technicalCode, userMessage });
    ensureCatalogStatuses();
    return runtimeError(userMessage, technicalCode);
  };

  try {
    await publishProgress('checking_update', 'Revisando actualizacion disponible...');
    await ensureAppGitRepository(record.installDir);
    await ensureUserModifiedBranch(record.installDir);
    const installedManifest = await resolveInstalledManifest(record.installDir);
    const preservedInstallPaths = collectPersistentInstallPaths(installedManifest);
    const status = await getUserVisibleGitStatusLines(record.installDir);
    if (status.length > 0) {
      return await abortUpdateAndRestoreInstalled(
        'Antes de actualizar, guarda o descarta los cambios pendientes de esta app.',
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
        updateBackup.userMessage || 'No pudimos respaldar tus datos antes de actualizar.',
        updateBackup.technicalCode || 'backup_failed',
      );
    }

    await publishProgress('downloading', 'Descargando actualizacion...');
    const download = await fetchDownloadBundle(catalogApp);
    await validateArchiveEntries(download.zipPath);

    stageDir = path.join(getTempRoot(), `${appId}-update-${Date.now()}`);
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.mkdir(stageDir, { recursive: true });
    await publishProgress('extracting', 'Preparando version nueva...');
    await extractArchive(download.zipPath, stageDir);
    await flattenSingleTopLevelDirectory(stageDir);
    await clearMacQuarantine(stageDir);

    await runCommand('git', ['checkout', 'main'], { cwd: record.installDir });
    await syncReleaseIntoInstalledApp(stageDir, record.installDir, preservedInstallPaths);
    await normalizeInstalledAgentContext(record.installDir, appId);
    await ensureGlobalAgentsContext(getForgerHomeRoot());

    await publishProgress('updating_base', 'Guardando la version nueva...');
    const baseCommitSha = await gitCommitAllExcept(
      record.installDir,
      `forger(base): update ${download.version}`,
      preservedInstallPaths,
    );
    await upsertInstalledRecord({
      ...record,
      status: 'installing',
      userMessage: 'Combinando la actualizacion con tus cambios...',
      pendingUpdate: {
        fromVersion: record.version,
        targetVersion: download.version,
        preUpdateUserHead,
        baseCommitSha,
        backup: updateBackup.backup,
        startedAt,
      },
    });

    await publishProgress('merging_user_changes', 'Combinando la actualizacion con tus cambios...');
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
        userMessage: 'No pudimos combinar automaticamente la actualizacion con tus cambios.',
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
        userMessage: 'La actualizacion necesita ayuda para combinarse con tus cambios.',
        ...diagnostic,
      });
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      ensureCatalogStatuses();
      return {
        success: false,
        phase: 'conflict',
        userMessage: 'La actualizacion necesita ayuda para combinarse con tus cambios.',
        ...diagnostic,
      };
    }

    const nodeVersion = normalizeNodeRuntimeVersion(catalogApp.requiredNodeVersion ?? record.requiredNodeVersion);
    const pythonVersion = catalogApp.requiredPythonVersion
      ? normalizeVersionForFolder(catalogApp.requiredPythonVersion)
      : record.requiredPythonVersion;
    await installAppDependencies(appId, record.installDir, nodeVersion, pythonVersion, publishProgress);

    await upsertInstalledRecord({
      ...record,
      version: download.version,
      requiredNodeVersion: nodeVersion,
      requiredPythonVersion: pythonVersion,
      status: 'installed',
      userMessage: 'Actualizacion instalada y lista para abrir.',
      pendingUpdate: undefined,
    });
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    ensureCatalogStatuses();
    emitInstallProgress(appId, {
      success: true,
      phase: 'completed',
      userMessage: 'Actualizacion completada.',
    });
    return {
      success: true,
      phase: 'completed',
      userMessage: 'Actualizacion completada.',
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
      userMessage: 'No pudimos actualizar la app. Puedes reintentar.',
    });
    ensureCatalogStatuses();
    return {
      success: false,
      phase: 'failed',
      userMessage: 'No pudimos actualizar la app. Puedes reintentar.',
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
  const agents = installed ? await resolveInstalledAgents(appId) : [];

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
    promptTemplates: installed ? await resolveInstalledPromptTemplates(appId) : [],
    agents,
    codexConversation: installed && agents.length > 0 ? { enabled: true } : undefined,
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

const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`startup_timeout_${url}`);
};

const getFreePort = async (): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('port_not_available'));
      }
      server.close();
    });
    server.on('error', reject);
  });
};

const proxyHttpRequest = async (
  targetBaseUrl: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  pathPrefix = '',
): Promise<void> => {
  const targetUrl = new URL(incoming.url ?? '/', targetBaseUrl);
  if (pathPrefix && targetUrl.pathname.startsWith(pathPrefix)) {
    targetUrl.pathname = targetUrl.pathname.slice(pathPrefix.length) || '/';
  }
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
  });
  const response = await fetch(targetUrl, {
    method: incoming.method,
    headers: filterProxyRequestHeaders(incoming.headers),
    body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : fetchBodyFromBuffer(body),
  });
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    if (['content-type', 'cache-control', 'etag', 'last-modified'].includes(key.toLowerCase())) {
      outgoing.setHeader(key, value);
    }
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
};

const filterProxyRequestHeaders = (headers: IncomingMessage['headers']): Record<string, string> => {
  const allowed = new Set(['accept', 'accept-language', 'content-type']);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!allowed.has(key.toLowerCase()) || typeof value !== 'string') {
      continue;
    }
    result[key] = value;
  }
  return result;
};

const fetchBodyFromBuffer = (body: Buffer): ArrayBuffer =>
  body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;

const createLocalAppProxy = async (
  backendUrl: string,
  rawFrontendUrl: string,
): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const target = requestUrl.pathname.startsWith('/__forger_api') ? backendUrl : rawFrontendUrl;
    const prefix = requestUrl.pathname.startsWith('/__forger_api') ? '/__forger_api' : '';
    void proxyHttpRequest(target, request, response, prefix).catch(() => {
      response.statusCode = 502;
      response.end('Forger app proxy failed.');
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('proxy_port_not_available'));
      }
    });
    server.on('error', reject);
  });
  return { server, url: `http://127.0.0.1:${port}` };
};

const closeServer = async (server: http.Server): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const terminateProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.killed) {
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      cwd: app.getPath('userData'),
    }).catch(() => {
      // best effort
    });
    return;
  }

  child.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const markAppRuntimeStatus = async (
  appId: string,
  status: Exclude<AppStatus, 'not_installed'>,
  userMessage: string,
): Promise<void> => {
  const current = registry.apps[appId];
  if (!current) {
    return;
  }

  const nextStatus: Exclude<AppStatus, 'not_installed' | 'running'> = status === 'running' ? 'installed' : status;
  await upsertInstalledRecord({
    ...current,
    status: nextStatus,
    userMessage,
  });
  ensureCatalogStatuses();
};

const closeAppWindow = (appId: string): void => {
  const existing = appWindows.get(appId);
  appWindows.delete(appId);
  if (existing && !existing.isDestroyed()) {
    existing.close();
  }
};

const withAppLocale = (frontendUrl: string, locale?: string): string => {
  if (!locale) {
    return frontendUrl;
  }
  const url = new URL(frontendUrl);
  url.searchParams.set('forgerLocale', locale);
  return url.toString();
};

const openOrFocusAppWindow = async (
  appId: string,
  appName: string,
  frontendUrl: string,
  locale?: string,
): Promise<void> => {
  const localizedFrontendUrl = withAppLocale(frontendUrl, locale);
  const existing = appWindows.get(appId);
  if (existing && !existing.isDestroyed()) {
    if (existing.webContents.getURL() !== localizedFrontendUrl) {
      await existing.loadURL(localizedFrontendUrl).catch(() => {
        // keep current URL if reload fails
      });
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.show();
    existing.focus();
    return;
  }

  const appPreloadPath = path.join(__dirname, '..', 'preload', 'app.js');
  const appWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#F6F3EE',
    title: appName,
    autoHideMenuBar: true,
    webPreferences: {
      preload: appPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  appWindows.set(appId, appWindow);
  const expectedOrigin = new URL(localizedFrontendUrl).origin;
  const isAllowedAppUrl = (targetUrl: string): boolean => {
    try {
      return new URL(targetUrl).origin === expectedOrigin;
    } catch {
      return false;
    }
  };
  const openExternalUrl = (targetUrl: string): void => {
    try {
      const protocol = new URL(targetUrl).protocol;
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        void shell.openExternal(targetUrl);
      }
    } catch {
      // Ignore invalid navigation targets.
    }
  };

  appWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppUrl(targetUrl)) {
      event.preventDefault();
      openExternalUrl(targetUrl);
    }
  });
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAppUrl(url)) {
      void appWindow.loadURL(url);
      return { action: 'deny' };
    }
    openExternalUrl(url);
    return { action: 'deny' };
  });
  appWindow.on('closed', () => {
    appWindows.delete(appId);
    appCodexTaskManager?.rejectPendingPermissionsForApp(appId);
    appCodexConversationManager?.rejectPendingPermissionsForApp(appId);
    if (!stoppingApps.has(appId) && runningApps.has(appId)) {
      void stopInstalledApp(appId);
    }
  });

  await appWindow.loadURL(localizedFrontendUrl);
};

const findManifestService = (
  manifest: AppManifest | null,
  name: string,
  fallbackContext: string,
): AppManifestService | null => {
  const services = Array.isArray(manifest?.services) ? manifest.services : [];
  return services.find((service) => service.name === name)
    ?? services.find((service) => service.context === fallbackContext)
    ?? null;
};

const replaceCommandOption = (args: string[], option: string, value: string): string[] => {
  const next = [...args];
  const index = next.indexOf(option);
  if (index >= 0) {
    if (index + 1 < next.length) {
      next[index + 1] = value;
    } else {
      next.push(value);
    }
    return next;
  }
  next.push(option, value);
  return next;
};

const splitManifestCommand = (command: string | undefined): string[] =>
  command?.trim().split(/\s+/).filter(Boolean) ?? [];

const resolvePythonAppImport = (appPath: string): { appImport: string; pythonPath: string } => {
  const cleanPath = appPath.replace(/\\/g, '/').replace(/\.py$/i, '');
  const parts = cleanPath.split('/').filter(Boolean);
  const srcIndex = parts.indexOf('src');
  const moduleParts = srcIndex >= 0 ? parts.slice(srcIndex + 1) : parts;
  const pythonPath = srcIndex >= 0 ? parts.slice(0, srcIndex + 1).join('/') : '.';
  return {
    appImport: `${moduleParts.length ? moduleParts.join('.') : 'app.main'}:app`,
    pythonPath,
  };
};

const mergePythonPath = (
  environment: Record<string, string>,
  cwd: string,
  pythonPath: string,
): Record<string, string> => {
  const resolvedPythonPath = path.resolve(cwd, pythonPath);
  const currentPythonPath = environment.PYTHONPATH ?? process.env.PYTHONPATH;
  return {
    ...environment,
    PYTHONPATH: currentPythonPath
      ? `${resolvedPythonPath}${path.delimiter}${currentPythonPath}`
      : resolvedPythonPath,
  };
};

const translateManifestEnvironment = (
  environment: Record<string, string>,
  backendDir: string,
): Record<string, string> => {
  const appRoot = path.dirname(backendDir);
  const appDataDir = path.join(backendDir, 'data');
  const placeholders: Record<string, string> = {
    '{app_root}': appRoot,
    '{backend}': backendDir,
    '{app_data}': appDataDir,
  };
  const translated = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => {
      let resolved = value;
      for (const [placeholder, replacement] of Object.entries(placeholders)) {
        resolved = resolved.split(placeholder).join(replacement);
      }
      return [key, resolved];
    }),
  );
  const databaseUrl = translated.DATABASE_URL;
  const sqliteAppPrefix = 'sqlite:////app/';
  if (typeof databaseUrl === 'string' && databaseUrl.startsWith(sqliteAppPrefix)) {
    const relativeDbPath = databaseUrl.slice(sqliteAppPrefix.length);
    translated.DATABASE_URL = `sqlite:///${path.join(backendDir, relativeDbPath)}`;
  }
  return translated;
};

const ensureSqliteDatabaseParent = async (environment: Record<string, string>): Promise<void> => {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl?.startsWith('sqlite:///')) {
    return;
  }
  const filePath = databaseUrl.slice('sqlite:///'.length);
  if (!path.isAbsolute(filePath)) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const summarizeBackendEnvironment = (environment: Record<string, string>): Record<string, string> => {
  const summary: Record<string, string> = {};
  for (const key of ['DATABASE_URL', 'PYTHONPATH', 'CORS_ORIGINS']) {
    const value = environment[key];
    if (typeof value === 'string' && value.trim()) {
      summary[key] = value;
    }
  }
  return summary;
};

const buildBackendProcessConfig = (
  service: AppManifestService | null,
  backendDir: string,
  python: string,
  port: number,
): { command: string; args: string[]; cwd: string; environment: Record<string, string> } => {
  const rawArgs = splitManifestCommand(service?.command);
  const fastapiIndex = rawArgs.indexOf('fastapi');
  const uvicornIndex = rawArgs.indexOf('uvicorn');
  const manifestEnvironment = service?.environment && typeof service.environment === 'object' ? service.environment : {};
  const environment = translateManifestEnvironment(manifestEnvironment, backendDir);
  const cwd = service?.context ? path.resolve(path.join(path.dirname(backendDir), service.context)) : backendDir;

  if (fastapiIndex >= 0 && rawArgs[fastapiIndex + 1] === 'dev') {
    const appPath = rawArgs[fastapiIndex + 2] && !rawArgs[fastapiIndex + 2].startsWith('-')
      ? rawArgs[fastapiIndex + 2]
      : 'src/app/main.py';
    const resolvedApp = resolvePythonAppImport(appPath);
    let args = ['-m', 'uvicorn', resolvedApp.appImport];
    args = replaceCommandOption(args, '--host', '127.0.0.1');
    args = replaceCommandOption(args, '--port', String(port));
    if (!args.includes('--reload')) {
      args.push('--reload');
    }
    return {
      command: python,
      args,
      cwd,
      environment: mergePythonPath(environment, cwd, resolvedApp.pythonPath),
    };
  }

  if (uvicornIndex >= 0) {
    const appImport = rawArgs[uvicornIndex + 1] && !rawArgs[uvicornIndex + 1].startsWith('-')
      ? rawArgs[uvicornIndex + 1]
      : 'app.main:app';
    let args = ['-m', 'uvicorn', appImport];
    args = replaceCommandOption(args, '--host', '127.0.0.1');
    args = replaceCommandOption(args, '--port', String(port));
    if (isDev && !args.includes('--reload')) {
      args.push('--reload');
    }
    return { command: python, args, cwd, environment };
  }

  const args = ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)];
  if (isDev) {
    args.push('--reload');
  }
  return { command: python, args, cwd, environment };
};

const normalizeHealthcheckPath = (healthcheck: string | undefined): string => {
  const value = healthcheck?.trim() || '/health';
  return value.startsWith('/') ? value : `/${value}`;
};

const openInstalledAppUnlocked = async (
  appId: string,
  locale?: string,
  options: { openWindow?: boolean } = {},
): Promise<OpenAppResult> => {
  const shouldOpenWindow = options.openWindow !== false;
  const record = registry.apps[appId];
  if (!record || !record.installDir) {
    return {
      success: false,
      userMessage: 'Primero instala esta app.',
      technicalCode: 'app_not_installed',
    };
  }
  if (record.status === 'conflict') {
    return {
      success: false,
      userMessage: 'Esta app necesita resolver una actualizacion antes de abrirse.',
      technicalCode: 'app_update_conflict',
    };
  }

  const running = runningApps.get(appId);
  if (running) {
    if (shouldOpenWindow) {
      await openOrFocusAppWindow(appId, record.name, running.frontendUrl, locale);
    }
    return {
      success: true,
      userMessage: 'La app ya esta en ejecucion.',
      backendUrl: running.backendUrl,
      frontendUrl: running.frontendUrl,
    };
  }

  const manifest = await resolveInstalledManifest(record.installDir);
  const appSecretsValidationError = getManifestAppSecretsValidationError(manifest);
  if (appSecretsValidationError) {
    return {
      success: false,
      userMessage: appSecretsValidationError,
      technicalCode: 'invalid_app_secrets_manifest',
    };
  }
  const appSecretDeclarations = normalizeManifestAppSecrets(manifest);
  let resolvedSecrets;
  try {
    resolvedSecrets = await getSecretsStore().resolveAppEnv(appId, appSecretDeclarations);
  } catch (error) {
    if (isSecretsVaultUnavailableError(error)) {
      return {
        success: false,
        userMessage: 'No pudimos leer los secretos guardados. Revisa el espacio seguro antes de abrir esta app.',
        technicalCode: 'secrets_vault_unavailable',
      };
    }
    if (error instanceof Error && error.message === 'secrets_encryption_unavailable') {
      return {
        success: false,
        userMessage: 'El sistema no tiene disponible el almacenamiento seguro de secretos.',
        technicalCode: 'secrets_encryption_unavailable',
      };
    }
    throw error;
  }
  if (resolvedSecrets.missingRequired.length > 0) {
    const missingLabels = resolvedSecrets.missingRequired
      .map((secret) => secret.label ?? secret.name)
      .join(', ');
    return {
      success: false,
      userMessage: `Conecta los secretos requeridos antes de abrir esta app: ${missingLabels}.`,
      technicalCode: 'required_app_secrets_missing',
    };
  }

  const nodeVersion = normalizeNodeRuntimeVersion(record.requiredNodeVersion);
  await appendInstallLog('open:start', {
    appId,
    installDir: record.installDir,
    requiredNodeVersion: nodeVersion,
    requiredPythonVersion: record.requiredPythonVersion,
    connectedSecrets: Object.keys(resolvedSecrets.env),
    logPath: getInstallLogPath(),
  });

  const nodeRuntime = await ensureRuntimeInstalled('node', nodeVersion);
  await ensureRuntimeInstalled('python', record.requiredPythonVersion);

  const backendService = findManifestService(manifest, 'backend', './backend');
  const frontendService = findManifestService(manifest, 'frontend', './frontend');
  const backendDir = path.join(record.installDir, 'backend');
  const frontendDir = path.join(record.installDir, 'frontend');
  const venv = getVenvExecutables(backendDir);

  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const rawFrontendUrl = `http://127.0.0.1:${frontendPort}`;
  const proxy = await createLocalAppProxy(backendUrl, rawFrontendUrl);
  const frontendUrl = proxy.url;
  const backendConfig = buildBackendProcessConfig(backendService, backendDir, venv.python, backendPort);
  const frontendArgs = ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(frontendPort)];
  const backendHealthcheckPath = normalizeHealthcheckPath(backendService?.healthcheck);
  await ensureSqliteDatabaseParent(backendConfig.environment);

  await appendInstallLog('open:spawn', {
    appId,
    backend: {
      command: backendConfig.command,
      args: backendConfig.args,
      cwd: backendConfig.cwd,
      url: backendUrl,
      healthcheck: backendHealthcheckPath,
      environment: summarizeBackendEnvironment({
        ...backendConfig.environment,
        CORS_ORIGINS: `${frontendUrl},${rawFrontendUrl},http://127.0.0.1:${frontendPort}`,
      }),
    },
    frontend: {
      command: nodeRuntime.npm,
      args: frontendArgs,
      cwd: frontendService?.context ? path.resolve(path.join(record.installDir, frontendService.context)) : frontendDir,
      url: frontendUrl,
    },
  });

  const backend = spawn(
    backendConfig.command,
    backendConfig.args,
    {
      cwd: backendConfig.cwd,
      env: {
        ...process.env,
        ...backendConfig.environment,
        ...resolvedSecrets.env,
        CORS_ORIGINS: `${frontendUrl},${rawFrontendUrl},http://127.0.0.1:${frontendPort}`,
        FORGER_APP_ID: appId,
        FORGER_APP_GRANT_SECRET: appFolderGrantSecret,
      },
      stdio: 'pipe',
    },
  );

  const frontend = spawn(nodeRuntime.npm as string, frontendArgs, {
    cwd: frontendService?.context ? path.resolve(path.join(record.installDir, frontendService.context)) : frontendDir,
    env: {
      ...process.env,
      ...(frontendService?.environment && typeof frontendService.environment === 'object' ? frontendService.environment : {}),
      ...resolvedSecrets.env,
      VITE_API_BASE_URL: `${frontendUrl}/__forger_api`,
      PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    shell: requiresWindowsShell(nodeRuntime.npm as string),
    stdio: 'pipe',
  });

  backend.stdout.on('data', (chunk) => {
    void appendInstallLog('open:backend:stdout', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  backend.stderr.on('data', (chunk) => {
    void appendInstallLog('open:backend:stderr', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  backend.on('error', (error) => {
    void appendInstallLog('open:backend:error', {
      appId,
      error: serializeErrorForInstallLog(error),
    });
  });

  frontend.stdout.on('data', (chunk) => {
    void appendInstallLog('open:frontend:stdout', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  frontend.stderr.on('data', (chunk) => {
    void appendInstallLog('open:frontend:stderr', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  frontend.on('error', (error) => {
    void appendInstallLog('open:frontend:error', {
      appId,
      error: serializeErrorForInstallLog(error),
    });
  });

  const onProcessCrash = async (): Promise<void> => {
    if (stoppingApps.has(appId)) {
      return;
    }

    closeAppWindow(appId);
    await markAppRuntimeStatus(appId, 'error', 'La app se detuvo por un error. Inicia de nuevo.');
    emitRuntimeStatus({
      appId,
      status: 'error',
      userMessage: 'La app se detuvo por un error. Inicia de nuevo.',
    });

    runningApps.delete(appId);
    await closeServer(proxy.server).catch(() => undefined);
  };

  backend.once('exit', (code, signal) => {
    void appendInstallLog('open:backend:exit', {
      appId,
      code,
      signal,
    });
    void onProcessCrash();
  });

  frontend.once('exit', (code, signal) => {
    void appendInstallLog('open:frontend:exit', {
      appId,
      code,
      signal,
    });
    void onProcessCrash();
  });

  runningApps.set(appId, {
    appId,
    backend,
    frontend,
    backendUrl,
    frontendUrl,
    rawFrontendUrl,
    proxyServer: proxy.server,
  });

  try {
    await waitForHttpOk(`${backendUrl}${backendHealthcheckPath}`, 60_000);
    await waitForHttpOk(rawFrontendUrl, 60_000);
    await waitForHttpOk(frontendUrl, 60_000);
    if (shouldOpenWindow) {
      await openOrFocusAppWindow(appId, record.name, frontendUrl, locale);
    }
    await appendInstallLog('open:ready', {
      appId,
      backendUrl,
      frontendUrl,
    });

    await markAppRuntimeStatus(appId, 'running', 'App en ejecucion.');
    emitRuntimeStatus({
      appId,
      status: 'running',
      userMessage: 'App en ejecucion.',
      backendUrl,
      frontendUrl,
    });

    ensureCatalogStatuses();

    return {
      success: true,
      userMessage: 'App abierta correctamente.',
      backendUrl,
      frontendUrl,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'open_failed');
    await appendInstallLog('open:failed', {
      appId,
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });

    await terminateProcess(backend);
    await terminateProcess(frontend);
    await closeServer(proxy.server).catch(() => undefined);
    runningApps.delete(appId);
    closeAppWindow(appId);
    await markAppRuntimeStatus(appId, 'error', 'No pudimos iniciar la app. Reintenta.');

    return {
      success: false,
      userMessage: 'No pudimos iniciar la app. Reintenta.',
      ...diagnostic,
    };
  }
};

const stopInstalledAppUnlocked = async (appId: string): Promise<StopAppResult> => {
  const running = runningApps.get(appId);
  if (!running) {
    return {
      success: true,
      userMessage: 'La app ya estaba detenida.',
    };
  }

  stoppingApps.add(appId);
  try {
    closeAppWindow(appId);
    await terminateProcess(running.backend);
    await terminateProcess(running.frontend);
    await closeServer(running.proxyServer).catch(() => undefined);
    runningApps.delete(appId);
  } finally {
    stoppingApps.delete(appId);
  }

  await markAppRuntimeStatus(appId, 'installed', 'App detenida.');
  emitRuntimeStatus({
    appId,
    status: 'installed',
    userMessage: 'App detenida.',
  });
  ensureCatalogStatuses();
  await syncAppToCloudIfEnabled(appId).catch((error) => {
    void appendInstallLog('cloud_sync:auto_error', {
      appId,
      error: serializeErrorForInstallLog(error),
    });
  });

  return {
    success: true,
    userMessage: 'App detenida correctamente.',
  };
};

const openInstalledApp = async (appId: string, locale?: string): Promise<OpenAppResult> =>
  await withAppLifecycleLock(appId, async () => await openInstalledAppUnlocked(appId, locale));

const stopInstalledApp = async (appId: string): Promise<StopAppResult> =>
  await withAppLifecycleLock(appId, async () => await stopInstalledAppUnlocked(appId));

const restartInstalledApp = async (
  appId: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<OpenAppResult> =>
  await withAppLifecycleLock(appId, async () => {
    await appendInstallLog('restart:start', { appId });
    options.onProgress?.('Deteniendo la app...');
    const stop = await stopInstalledAppUnlocked(appId);
    await appendInstallLog('restart:stop_done', { appId, result: stop });
    if (!stop.success) {
      await appendInstallLog('restart:failed', { appId, phase: 'stop', result: stop });
      options.onProgress?.('No pude detener la app.');
      return {
        success: false,
        userMessage: stop.userMessage || 'No pudimos detener la app para reiniciarla.',
        technicalCode: stop.technicalCode ?? 'restart_stop_failed',
      };
    }

    options.onProgress?.('App detenida. Iniciando servicios locales y esperando que quede lista...');
    await appendInstallLog('restart:open_start', { appId });
    const open = await openInstalledAppUnlocked(appId);
    if (!open.success) {
      await appendInstallLog('restart:failed', { appId, phase: 'open', result: open });
      options.onProgress?.('La app se detuvo, pero no pude volver a abrirla.');
      if (!runningApps.has(appId)) {
        const current = registry.apps[appId];
        const nextStatus = current?.status === 'error' ? 'error' : 'installed';
        await markAppRuntimeStatus(appId, nextStatus, open.userMessage || 'La app quedo detenida.');
        emitRuntimeStatus({
          appId,
          status: nextStatus,
          userMessage: open.userMessage || 'La app quedo detenida.',
        });
      }
      return {
        ...open,
        userMessage: open.userMessage || 'La app se detuvo, pero no pudimos volver a abrirla.',
        technicalCode: open.technicalCode ?? 'restart_open_failed',
      };
    }

    await appendInstallLog('restart:ready', {
      appId,
      backendUrl: open.backendUrl,
      frontendUrl: open.frontendUrl,
    });
    options.onProgress?.('App reiniciada correctamente.');
    return {
      ...open,
      userMessage: 'App reiniciada correctamente.',
    };
  });

const getRuntimeStatus = (appId: string): RuntimeStatus => {
  const running = runningApps.get(appId);
  const record = registry.apps[appId];

  if (running) {
    return {
      appId,
      status: 'running',
      userMessage: 'App en ejecucion.',
      backendUrl: running.backendUrl,
      frontendUrl: running.frontendUrl,
    };
  }

  if (!record) {
    return {
      appId,
      status: 'not_installed',
      userMessage: 'Aun no instalada.',
    };
  }

  return {
    appId,
    status: record.status,
    userMessage: record.userMessage,
  };
};

const handleCloudRelayRequest = async (request: CloudRelayRequest): Promise<CloudRelayResponse> => {
  try {
    const open = await openInstalledAppUnlocked(request.app_id, undefined, { openWindow: false });
    if (!open.success) {
      return relayError(request.request_id, 424, open.technicalCode ?? 'app_open_failed');
    }
    const running = runningApps.get(request.app_id);
    if (!running) {
      return relayError(request.request_id, 424, 'app_not_running');
    }
    const pathValue = request.path?.startsWith('/') ? request.path : `/${request.path || ''}`;
    if (pathValue.includes('..') || pathValue.toLowerCase().startsWith('/__forger_internal')) {
      if (pathValue.toLowerCase().startsWith('/__forger_internal/forger_app/')) {
        return await handleCloudForgerAppRequest(request, pathValue);
      }
      return relayError(request.request_id, 403, 'path_blocked');
    }
    const target = new URL(pathValue, running.frontendUrl);
    const response = await fetch(target, {
      method: request.method,
      headers: request.headers ?? {},
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : fetchBodyFromBuffer(Buffer.from(request.body ?? [])),
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (['content-type', 'cache-control', 'etag', 'last-modified'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    return {
      request_id: request.request_id,
      status: response.status,
      headers,
      body: [...Buffer.from(await response.arrayBuffer())],
    };
  } catch (error) {
    return relayError(request.request_id, 502, error instanceof Error ? error.message : 'relay_failed');
  }
};

const handleCloudForgerAppRequest = async (
  request: CloudRelayRequest,
  pathValue: string,
): Promise<CloudRelayResponse> => {
  try {
    if (request.method !== 'POST') {
      return relayJson(request.request_id, 405, { error: 'method_not_allowed' });
    }

    const body = parseRelayJsonBody(request.body);
    const action = pathValue.replace(/^\/__forger_internal\/forger_app\/?/i, '').replace(/\/+$/, '');
    const json = async (value: unknown, status = 200): Promise<CloudRelayResponse> =>
      relayJson(request.request_id, status, value);

    if (action === 'ai-subscription-status') {
      const status = await getCodexAuthStatus();
      return json({ connected: status.authenticated });
    }

    if (action === 'context') {
      return json({ agents: await resolveInstalledAgents(request.app_id) });
    }

    if (action === 'codex-task/start') {
      if (!appCodexTaskManager) {
        return json({ error: 'app_codex_task_manager_unavailable' }, 503);
      }
      const task = await appCodexTaskManager.start(request.app_id, body as unknown as AppCodexTaskStartInput);
      return json(task);
    }

    if (action === 'codex-task/get') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      return json(appCodexTaskManager?.get(request.app_id, runId) ?? null);
    }

    if (action === 'codex-task/cancel') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      return json(appCodexTaskManager?.cancel(request.app_id, runId) ?? { success: false });
    }

    return json({ error: 'unknown_forger_app_action' }, 404);
  } catch (error) {
    return relayJson(request.request_id, 500, {
      error: error instanceof Error ? error.message : 'forger_app_request_failed',
    });
  }
};

const parseRelayJsonBody = (body?: number[]): Record<string, unknown> => {
  if (!body || body.length === 0) {
    return {};
  }
  const raw = Buffer.from(body).toString('utf8');
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
};

const relayJson = (requestId: string, status: number, value: unknown): CloudRelayResponse => ({
  request_id: requestId,
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: [...Buffer.from(JSON.stringify(value))],
});

const relayError = (requestId: string, status: number, message: string): CloudRelayResponse => ({
  request_id: requestId,
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: [...Buffer.from(message)],
});

const getWindowState = (window: BrowserWindow): WindowControlState => ({
  isMaximized: window.isMaximized(),
  isFullScreen: window.isFullScreen(),
  usesCustomFrame: useCustomWindowFrame,
});

const emitWindowState = (window: BrowserWindow): void => {
  if (!window.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.windowStateChanged, getWindowState(window));
  }
};

const registerWindowStateEvents = (window: BrowserWindow): void => {
  const notify = () => emitWindowState(window);
  window.on('maximize', notify);
  window.on('unmaximize', notify);
  window.on('restore', notify);
  window.on('enter-full-screen', notify);
  window.on('leave-full-screen', notify);
};

const getInvokingWindow = (event: IpcMainInvokeEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender);

const findSqliteFile = async (searchDir: string): Promise<string | null> => {
  const extensions = ['.db', '.sqlite', '.sqlite3'];
  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });
    const file = entries.find(
      (entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)),
    );
    if (file) {
      return path.join(searchDir, file.name);
    }
  } catch {
    // directory may not exist
  }
  return null;
};

const resolveAppDbPath = async (appId: string): Promise<string | null> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return null;
  }
  const backendDir = path.join(record.installDir, 'backend');
  const found = await findSqliteFile(backendDir);
  if (found) {
    return found;
  }
  // Fallback: search one level deeper (e.g. backend/data/)
  try {
    const entries = await fs.readdir(backendDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = await findSqliteFile(path.join(backendDir, entry.name));
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const createWindow = async (): Promise<void> => {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#F6F3EE',
    title: isDev ? 'Forger Dev' : 'Forger',
    frame: !useCustomWindowFrame,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  registerWindowStateEvents(mainWindow);
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    desktopErrorReporter?.reportRendererProcessGone(details);
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }
};

const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC_CHANNELS.listInstalledApps, async () => {
    return Object.values(registry.apps).map(toAppSummary);
  });

  ipcMain.handle(IPC_CHANNELS.listCatalogApps, async () => {
    catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    return catalogApps;
  });

  ipcMain.handle(IPC_CHANNELS.installApp, async (_event, appId: string) => {
    return await installAppRuntime(appId);
  });

  ipcMain.handle(IPC_CHANNELS.updateApp, async (_event, appId: string) => {
    return await updateAppRuntime(appId);
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

  ipcMain.handle(IPC_CHANNELS.getCloudSyncSettings, async () => cloudSyncSettings);
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
    const prompt = buildCodexPromptWithAppContext({
      appId,
      displayName: resolveSelectedAppDisplayName(appId),
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

  ipcMain.handle(IPC_CHANNELS.getSettings, async () => settings);
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
  ipcMain.handle(IPC_CHANNELS.getDesktopUpdateState, async () => getDesktopUpdater().getState());
  ipcMain.handle(IPC_CHANNELS.checkDesktopUpdates, async () => await getDesktopUpdater().check());
  ipcMain.handle(IPC_CHANNELS.downloadDesktopUpdate, async () => await getDesktopUpdater().download());
  ipcMain.handle(IPC_CHANNELS.installDesktopUpdate, async () => await getDesktopUpdater().install());
  ipcMain.handle(IPC_CHANNELS.getForgerAccount, async () => publicForgerAccount(forgerAccount));
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
      forgerAccount = result;
      await forgerAccountStore?.save(forgerAccount);
      await cloudDeviceManager?.start();
    }
    catalogApps = await listCatalogFromBackend();
    return { ...publicForgerAccount(forgerAccount), success: result.success, userMessage: result.userMessage, technicalCode: result.technicalCode };
  });
  ipcMain.handle(IPC_CHANNELS.logoutForgerAccount, async () => {
    cloudDeviceManager?.stop();
    await forgerBackendClient?.logoutAccount();
    forgerAccount = { authenticated: false };
    await forgerAccountStore?.clear();
    catalogApps = await listCatalogFromBackend();
    return { ...publicForgerAccount(forgerAccount), success: true };
  });
  ipcMain.handle(IPC_CHANNELS.getCloudDevices, async () => {
    return cloudDeviceManager ? await cloudDeviceManager.getState() : { devices: [], connected: false };
  });
  ipcMain.handle(IPC_CHANNELS.generateDevicePairingCode, async () => {
    return cloudDeviceManager
      ? await cloudDeviceManager.generatePairingCode()
      : { devices: [], connected: false, success: false, userMessage: 'No pudimos preparar este equipo.', technicalCode: 'cloud_device_manager_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.submitAppRating, async (_event, input: SubmitAppRatingInput) => {
    const result = forgerBackendClient
      ? await forgerBackendClient.submitAppRating(input)
      : { success: false, userMessage: 'No pudimos guardar tu review.', technicalCode: 'backend_client_missing' };
    catalogApps = await listCatalogFromBackend();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.submitAppFeedback, async (_event, input: SubmitAppFeedbackInput) => {
    return forgerBackendClient
      ? await forgerBackendClient.submitAppFeedback(input)
      : { success: false, userMessage: 'No pudimos enviar el feedback.', technicalCode: 'backend_client_missing' };
  });
  ipcMain.handle(IPC_CHANNELS.submitDesktopErrorReport, async (_event, input: DesktopErrorReportPreview) => {
    const report: DesktopErrorReportPreview = {
      ...input,
      desktopVersion: input.desktopVersion || app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      occurredAt: input.occurredAt || new Date().toISOString(),
    };
    return forgerBackendClient
      ? await forgerBackendClient.submitDesktopErrorReport(report)
      : { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode: 'backend_client_missing' };
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
  ipcMain.handle(IPC_CHANNELS.listAgentTools, async () => AGENT_TOOL_PACKAGES);
  ipcMain.handle(IPC_CHANNELS.getAgentToolSettings, async () => agentToolSettings);
  ipcMain.handle(IPC_CHANNELS.updateAgentToolApproval, async (_event, input: UpdateAgentToolApprovalInput) => {
    return await updateAgentToolApproval(input);
  });
  ipcMain.handle(IPC_CHANNELS.listOfficialTools, async () => await getOfficialToolsService().list());
  ipcMain.handle(IPC_CHANNELS.refreshOfficialTools, async () => await getOfficialToolsService().refresh());
  ipcMain.handle(IPC_CHANNELS.activateOfficialTool, async (_event, toolId: string) => {
    return await getOfficialToolsService().activate(toolId);
  });
  ipcMain.handle(IPC_CHANNELS.configureOfficialTool, async (_event, input: ConfigureOfficialToolInput) => {
    return await getOfficialToolsService().configure(input);
  });
  ipcMain.handle(IPC_CHANNELS.deactivateOfficialTool, async (_event, toolId: string) => {
    return await getOfficialToolsService().deactivate(toolId);
  });
  ipcMain.handle(IPC_CHANNELS.getAppToolsInstallGate, async (_event, appId: string): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().getInstallGate(appId);
  });
  ipcMain.handle(IPC_CHANNELS.setAppToolGrant, async (_event, input: SetAppToolGrantInput): Promise<AppToolsInstallGate | null> => {
    return await getOfficialToolsService().setAppToolGrant(input);
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
    const enrichedPrompt = input.appId
      ? buildCodexPromptWithAppContext({
          appId: input.appId,
          displayName: resolveSelectedAppDisplayName(input.appId),
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForApp(input.appId),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        })
      : buildCodexPromptForFreeChat({
          userPrompt: input.prompt,
          userLanguage: input.userLanguage,
          officialToolsContext: await buildForgerToolsContextForFreeChat(),
          sharedFilesRootName: path.basename(getPrivateDataRoot()),
          sharedFiles: sharedPromptFiles,
        });
    return await chatOrchestrator.startRun({
      ...input,
      appId: input.appId ?? null,
      prompt: enrichedPrompt,
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

  ipcMain.handle(IPC_CHANNELS.filesPickForChat, async () => {
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) {
      return [];
    }
    return await getFileLibrary().pickFileInfo(result.filePaths);
  });
  ipcMain.handle(IPC_CHANNELS.filesStageForChat, async (_event, input: FilesStageForChatInput) => {
    return await getFileLibrary().stageFileForChat(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDiscardStagedForChat, async (_event, input: FilesDiscardStagedForChatInput) => {
    return await getFileLibrary().discardStagedFilesForChat(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesList, async (_event, input?: FilesListInput) => {
    return await getFileLibrary().list(input ?? {});
  });
  ipcMain.handle(IPC_CHANNELS.filesListCategories, async () => {
    return await getFileLibrary().listCategories();
  });
  ipcMain.handle(IPC_CHANNELS.filesCreateCategory, async (_event, input: FilesCreateCategoryInput) => {
    return await getFileLibrary().createCategory(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesRenameCategory, async (_event, input: FilesRenameCategoryInput) => {
    return await getFileLibrary().renameCategory(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDeleteCategory, async (_event, input: FilesDeleteCategoryInput) => {
    return await getFileLibrary().deleteCategory(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesImport, async (_event, input: FilesImportInput) => {
    return await getFileLibrary().importFiles(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesMove, async (_event, input: FilesMoveInput) => {
    return await getFileLibrary().moveFiles(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesRename, async (_event, input: FilesRenameInput) => {
    return await getFileLibrary().renameFile(input);
  });
  ipcMain.handle(IPC_CHANNELS.filesDelete, async (_event, input: FilesDeleteInput) => {
    return await getFileLibrary().deleteFiles(input);
  });

  ipcMain.handle(IPC_CHANNELS.appSelectExternalFolder, async (event): Promise<AppExternalFolderSelection> => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }

    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
    };
    const result = ownerWindow && !ownerWindow.isDestroyed()
      ? await dialog.showOpenDialog(ownerWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedPath = await fs.realpath(result.filePaths[0]);
    return signAppFolderGrant(appId, selectedPath);
  });

  ipcMain.handle(IPC_CHANNELS.appAiSubscriptionStatus, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const status = await getCodexAuthStatus();
    return { connected: status.authenticated };
  });

  ipcMain.handle(IPC_CHANNELS.appGetContext, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      return {};
    }
    return {
      agents: await resolveInstalledAgents(appId),
    };
  });

  ipcMain.handle(IPC_CHANNELS.appToolsListAvailable, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    return await getOfficialToolsService().listToolsForApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.appToolsGetStatus, async (event, toolId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    const available = await getOfficialToolsService().listToolsForApp(appId);
    return available.find((tool) => tool.id === toolId) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.appToolsCall, async (event, input: CallOfficialToolInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    return await getOfficialToolsService().callFromApp(appId, input);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexTaskStart, async (event, input: AppCodexTaskStartInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appCodexTaskManager) {
      throw new Error('app_codex_task_manager_unavailable');
    }
    try {
      return await appCodexTaskManager.start(appId, input);
    } catch (error) {
      desktopErrorReporter?.reportAppCodexStartFailure({
        appId,
        operation: 'app.codex-task.start',
        error,
      });
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.appCodexTaskGet, async (event, runId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexTaskManager) {
      return null;
    }
    return appCodexTaskManager.get(appId, runId);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexTaskCancel, async (event, runId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexTaskManager) {
      return { success: false };
    }
    return appCodexTaskManager.cancel(appId, runId);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexTaskApprovePermission, async (
    event,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexTaskManager) {
      return { success: false };
    }
    return appCodexTaskManager.approvePermission(appId, runId, requestId, decision);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationCreate, async (event, input: AppCodexConversationCreateInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appCodexConversationManager) {
      throw new Error('app_codex_conversation_manager_unavailable');
    }
    try {
      return await appCodexConversationManager.create(appId, input ?? {});
    } catch (error) {
      desktopErrorReporter?.reportAppCodexStartFailure({
        appId,
        operation: 'app.codex-conversation.create',
        error,
      });
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationSendMessage, async (
    event,
    input: AppCodexConversationSendMessageInput,
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appCodexConversationManager) {
      throw new Error('app_codex_conversation_manager_unavailable');
    }
    try {
      return await appCodexConversationManager.sendMessage(appId, input);
    } catch (error) {
      desktopErrorReporter?.reportAppCodexStartFailure({
        appId,
        operation: 'app.codex-conversation.send-message',
        error,
      });
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationGet, async (event, conversationId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexConversationManager) {
      return null;
    }
    return await appCodexConversationManager.get(appId, conversationId);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationList, async (event) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexConversationManager) {
      return [];
    }
    return await appCodexConversationManager.list(appId);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationDelete, async (event, conversationId: string) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexConversationManager) {
      return { success: false };
    }
    return await appCodexConversationManager.delete(appId, conversationId);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationCancelRun, async (
    event,
    conversationId: string,
    runId: string,
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexConversationManager) {
      return { success: false };
    }
    return await appCodexConversationManager.cancel(appId, conversationId, runId);
  });

  ipcMain.handle(IPC_CHANNELS.appCodexConversationApprovePermission, async (
    event,
    conversationId: string,
    runId: string,
    requestId: string,
    decision: 'allow' | 'deny',
  ) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId || !appCodexConversationManager) {
      return { success: false };
    }
    return appCodexConversationManager.approvePermission(appId, conversationId, runId, requestId, decision);
  });

  ipcMain.handle(IPC_CHANNELS.dbListTables, async (_event, appId: string) => {
    if (!BetterSqlite3) {
      return { error: 'db_module_unavailable' };
    }
    const dbPath = await resolveAppDbPath(appId);
    if (!dbPath) {
      return { error: 'db_file_not_found' };
    }
    try {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      type SqliteMasterRow = { name: string };
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as SqliteMasterRow[];
      db.close();
      return { tables: rows.map((row) => row.name), dbPath };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'db_list_tables_failed';
      return { error: detail };
    }
  });

  ipcMain.handle(IPC_CHANNELS.dbQueryTable, async (_event, appId: string, tableName: string, limit = 1000) => {
    if (!BetterSqlite3) {
      return { error: 'db_module_unavailable' };
    }
    const dbPath = await resolveAppDbPath(appId);
    if (!dbPath) {
      return { error: 'db_file_not_found' };
    }
    try {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      const safeName = tableName.replace(/"/g, '""');
      const stmt = db.prepare(`SELECT * FROM "${safeName}" LIMIT ?`);
      const rawRows = stmt.all(limit) as Record<string, unknown>[];
      const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : (stmt.columns().map((col) => col.name));
      const rows = rawRows.map((row) => columns.map((col) => row[col] ?? null));
      type CountRow = { total: number };
      const countRow = db.prepare(`SELECT COUNT(*) as total FROM "${safeName}"`).get() as CountRow;
      db.close();
      return { columns, rows, total: countRow?.total ?? rows.length };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'db_query_failed';
      return { error: detail };
    }
  });

  ipcMain.handle(IPC_CHANNELS.automationsList, async () => {
    if (!automationManager) {
      return [];
    }
    return automationManager.list();
  });
  ipcMain.handle(IPC_CHANNELS.automationsCreate, async (_event, input: AutomationUpsertInput) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.create(input);
  });
  ipcMain.handle(IPC_CHANNELS.automationsUpdate, async (_event, input: AutomationUpsertInput & { id: string }) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.update(input);
  });
  ipcMain.handle(IPC_CHANNELS.automationsDelete, async (_event, id: string) => {
    if (!automationManager) {
      return { success: false, technicalCode: 'automation_manager_unavailable' };
    }
    return await automationManager.delete(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsPause, async (_event, id: string) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.pause(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsResume, async (_event, id: string) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.resume(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsRunNow, async (_event, id: string) => {
    if (!automationManager) {
      throw new Error('automation_manager_unavailable');
    }
    return await automationManager.runNow(id);
  });
  ipcMain.handle(IPC_CHANNELS.automationsListRuns, async (_event, automationId: string) => {
    if (!automationManager) {
      return [];
    }
    return await automationManager.listRuns(automationId);
  });
  ipcMain.handle(IPC_CHANNELS.automationsGetRunTranscript, async (_event, runId: string) => {
    if (!automationManager) {
      return null;
    }
    return await automationManager.getRunTranscript(runId);
  });

  ipcMain.handle(IPC_CHANNELS.windowMinimize, async (event) => {
    getInvokingWindow(event)?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.windowToggleMaximize, async (event) => {
    const window = getInvokingWindow(event);
    if (!window) {
      throw new Error('window_not_found');
    }

    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }

    return getWindowState(window);
  });

  ipcMain.handle(IPC_CHANNELS.windowClose, async (event) => {
    const window = getInvokingWindow(event);
    if (!window) {
      return;
    }
    if (window === mainWindow) {
      app.quit();
      return;
    }
    window.close();
  });

  ipcMain.handle(IPC_CHANNELS.windowGetState, async (event) => {
    const window = getInvokingWindow(event);
    if (!window) {
      throw new Error('window_not_found');
    }

    return getWindowState(window);
  });
};

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
  secretsStore = new SecretsStore(app.getPath('userData'));
  officialToolsService = getOfficialToolsService();
  await officialToolsService.load();
  await loadAgentToolSettings();
  forgerAccountStore = new ForgerAccountStore(getForgerAccountPath());
  forgerAccount = await forgerAccountStore.load();
  await loadCloudSyncSettings();
  memoryStore = new MemoryStore(getForgerMetadataRoot());
  await loadRegistry();
  await startDevCatalogService();
  forgerBackendClient = new ForgerBackendClient({
    backendBaseUrl,
    localCatalogJsonUrl: () => localCatalogJsonUrl,
    token: () => forgerAccount.token,
    mapBackendCategory,
    toCatalogStatus,
    getUserMessage: (slug) => registry.apps[slug]?.userMessage,
  });
  cloudDeviceManager = new CloudDeviceManager({
    filePath: getCloudDevicePath(),
    backendBaseUrl,
    backendClient: () => forgerBackendClient,
    token: () => forgerAccount.token,
    getInstalledApps: () => Object.values(registry.apps).map(toAppSummary),
    handleRelayRequest: handleCloudRelayRequest,
  });
  await cloudDeviceManager.start();
  forgerMcpServer = new ForgerMcpServer({
    getAppVersion: () => app.getVersion(),
    getToolDefinitions: () => AGENT_TOOL_DEFINITIONS,
    getToolSettings: () => agentToolSettings,
    appendInstallLog,
    requestPermission: async (runId, request) => {
      const taskDecision = await (appCodexTaskManager?.requestPermission(runId, request) ?? Promise.resolve(null));
      if (taskDecision !== null) {
        return taskDecision;
      }
      const conversationDecision = await (appCodexConversationManager?.requestPermission(runId, request) ?? Promise.resolve(null));
      if (conversationDecision !== null) {
        return conversationDecision;
      }
      return chatOrchestrator?.requestExternalPermission(runId, request) ?? null;
    },
    listCatalog: async () => {
      catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return catalogApps;
    },
    listInstalledApps: () => Object.values(registry.apps).map(toAppSummary),
    checkUpdates: async () => {
      catalogApps = await listCatalogFromBackend();
      ensureCatalogStatuses();
      return Object.values(registry.apps)
        .map((record) => toAppSummary(record))
        .filter((summary) => summary.updateAvailable);
    },
    getRuntimeStatus,
    openApp: openInstalledApp,
    stopApp: stopInstalledApp,
    restartApp: restartInstalledApp,
    refreshAppView: async (appId) => {
      const appWindow = appWindows.get(appId);
      const running = runningApps.get(appId);
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.webContents.reloadIgnoringCache();
        return { success: true, userMessage: 'Vista reiniciada correctamente.' };
      }
      if (running) {
        const record = registry.apps[appId];
        await openOrFocusAppWindow(appId, record?.name ?? appId, running.frontendUrl);
        return { success: true, userMessage: 'Vista abierta correctamente.' };
      }
      return { success: false, userMessage: 'La app no esta abierta.', technicalCode: 'app_not_running' };
    },
    updateApp: updateAppRuntime,
    memoryList: async (input, access) => await getMemoryStore().list(input, access),
    memoryCreate: async (input, access) => await getMemoryStore().create(input, access),
    memoryUpdate: async (input, access) => await getMemoryStore().update(input, access),
    memoryDelete: async (id, access) => await getMemoryStore().delete(id, access),
    listOfficialToolActionIdsForApp: async (appId) => await getOfficialToolsService().listAgentActionIdsForApp(appId),
    validateOfficialTool: async (input, access) => await getOfficialToolsService().validateAgentCall(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
    }),
    callOfficialTool: async (input, access) => await getOfficialToolsService().callFromAgent(input, {
      appId: access.appId,
      requireAppGrant: access.caller === 'app-agent',
    }),
    onToolProgress: (input) => chatOrchestrator?.appendExternalProgress(input.runId, input.message),
    onToolFailure: (input) => desktopErrorReporter?.reportForgerMcpToolFailure(input),
    onHttpFailure: (input) => desktopErrorReporter?.reportForgerMcpHttpFailure(input),
  });
  await forgerMcpServer.start();
  appMcpManager = new AppMcpManager({
    getInstalledApp: (appId) => registry.apps[appId],
    resolveInstalledManifest,
    ensureRuntimeInstalled,
    getVenvExecutables,
    getFreePort,
    splitManifestCommand,
    ensurePathInside,
    translateManifestEnvironment,
    ensureSqliteDatabaseParent,
    getRuntimePathEntries,
    waitForHttpOk,
    terminateProcess,
    appendInstallLog,
    truncateForInstallLog,
    serializeErrorForInstallLog,
    onMcpStartFailed: (input) => desktopErrorReporter?.reportAppMcpStartFailure(input),
  });
  fileLibrary = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
  await fileLibrary.cleanupStagedFilesForChat().catch((error) => {
    void appendInstallLog('files:chat_staging_cleanup_failed', {
      error: serializeErrorForInstallLog(error),
    });
  });
  chatOrchestrator = new ChatOrchestrator({
    forgerHomeRoot: getForgerHomeRoot(),
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    legacyMetadataRoot: getLegacyForgerMetadataRoot(),
    codexHome: getCodexHome(),
    agentContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? registry.apps[appId] : undefined;
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
      const record = appId ? registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    createForgerMcpSession: (runId, appId) =>
      forgerMcpServer?.createSession(runId, appId, {
        caller: appId === 'forger' ? 'free-chat' : 'desktop-chat',
        appIds: appId === 'forger' ? Object.keys(registry.apps) : [appId],
      }) ?? null,
    releaseForgerMcpSession: (token) => forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds.length > 0 ? appIds : Object.keys(registry.apps), runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    onUpdateConflictResolved: async (appId: string) => {
      const current = registry.apps[appId];
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
    onRunUpdated: (event) => {
      if (event.run.status === 'failed') {
        desktopErrorReporter?.reportChatRunFailure({
          appId: event.run.appId,
          runId: event.run.runId,
          errorCode: event.run.errorCode,
          message: event.run.userMessage,
        });
      }
      emitChatRunUpdated(event as { run: unknown });
    },
  });
  appCodexTaskManager = new AppCodexTaskManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? registry.apps[appId] : undefined;
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
      const record = appId ? registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    resolvePromptTemplates: resolveInstalledPromptTemplates,
    createForgerMcpSession: (runId, appId) =>
      forgerMcpServer?.createSession(runId, appId, { caller: 'app-agent', appIds: [appId] }) ?? null,
    releaseForgerMcpSession: (token) => forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApp,
    buildForgerToolsContext: buildForgerToolsContextForApp,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onTaskUpdated: (event) => {
      desktopErrorReporter?.reportAppCodexTaskEvent(event);
      const target = appWindows.get(event.task.appId);
      if (target && !target.isDestroyed()) {
        target.webContents.send(IPC_CHANNELS.appCodexTaskUpdated, event);
      }
    },
  });
  appCodexConversationManager = new AppCodexConversationManager({
    privateAppsRoot: getPrivateAppsRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getCodexPathEntries: async (appId?: string) => {
      const pathEntries = new Set<string>();
      const record = appId ? registry.apps[appId] : undefined;
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
      const record = appId ? registry.apps[appId] : undefined;
      const appPythonRuntime = record
        ? await ensureRuntimeInstalled('python', record.requiredPythonVersion)
        : undefined;
      return await getCodexToolEnvironment(appId, appPythonRuntime);
    },
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    hasCodexConversation: hasInstalledCodexConversation,
    resolveAgents: resolveInstalledAgents,
    createForgerMcpSession: (runId, appId) =>
      forgerMcpServer?.createSession(runId, appId, { caller: 'app-agent', appIds: [appId] }) ?? null,
    releaseForgerMcpSession: (token) => forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApp,
    buildForgerToolsContext: buildForgerToolsContextForApp,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    canRequestPermission: (appId: string) => {
      const target = appWindows.get(appId);
      return Boolean(target && !target.isDestroyed());
    },
    onConversationEvent: (event) => {
      desktopErrorReporter?.reportAppCodexConversationEvent(event);
      const target = appWindows.get(event.conversation.appId);
      if (target && !target.isDestroyed()) {
        target.webContents.send(IPC_CHANNELS.appCodexConversationEvent, event);
      }
    },
  });
  automationManager = new AutomationManager({
    forgerHomeRoot: getForgerHomeRoot(),
    metadataRoot: getForgerMetadataRoot(),
    codexHome: getCodexHome(),
    getInstalledApps: () => Object.values(registry.apps).map(toAppSummary),
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getCodexPathEntries: async () => {
      const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
      return getRuntimePathEntries(nodeRuntime);
    },
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    createForgerMcpSession: (runId, appId, appIds) =>
      forgerMcpServer?.createSession(runId, appId, { caller: 'automation', appIds }) ?? null,
    releaseForgerMcpSession: (token) => forgerMcpServer?.releaseSession(token),
    buildMemoryContext: buildMemoryContextForApps,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    onAutomationUpdated: (event) => {
      if (event.run?.status === 'failed') {
        desktopErrorReporter?.reportAutomationRunFailure({
          automationId: event.automation.id,
          runId: event.run.id,
          selectedAppIds: event.automation.selectedAppIds,
          error: event.run.error ?? event.run.userMessage ?? 'automation_run_failed',
        });
      }
      emitAutomationUpdated(event as { automation: unknown; run?: unknown });
    },
  });
  await automationManager.initialize();

  registerIpcHandlers();
  ensureCatalogStatuses();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('before-quit', () => {
  automationManager?.dispose();
  appMcpManager?.dispose();
  cloudDeviceManager?.stop();
  devCatalogService?.stop();
  forgerMcpServer?.stop();
  forgerMcpServer = null;
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
