import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

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
import { AutomationManager } from './automation-manager';
import { DevCatalogService } from './dev-catalog-service';
import { FileLibrary } from './file-library';
import { ForgerAccountStore, publicForgerAccount, type StoredForgerAccount } from './forger-account-store';
import { ForgerBackendClient } from './forger-backend-client';
import {
  FORGER_AGENT_CONTRACT_MARKER,
  FORGER_AGENT_CONTRACT_MARKER_PREFIX,
  FORGER_AGENT_CONTRACT_VERSION,
  buildGlobalForgerAgentsMarkdown,
} from './prompts/forger-base';
import { buildForgerAppAgentsMarkdown } from './prompts/apps-base';
import { buildCodexPromptWithAppContext } from './prompts/user-message';
import { SecretsStore, appSecretEnvName, isSecretsVaultUnavailableError } from './secrets-store';
import type {
  AgentToolApprovalSettings,
  AgentToolDefinition,
  AgentToolId,
  AgentToolPackageDefinition,
  AgentToolSettings,
  AppCategory,
  AppDetails,
  AppExternalFolderSelection,
  AppCodexTaskStartInput,
  AppCodexConversationCreateInput,
  AppCodexConversationSendMessageInput,
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
  CodexAuthStatus,
  ConnectAppSecretInput,
  CreateUserSecretInput,
  DeleteUserSecretInput,
  DisconnectAppSecretInput,
  FilesCreateCategoryInput,
  FilesDeleteCategoryInput,
  FilesDeleteInput,
  FilesImportInput,
  FilesListInput,
  FilesMoveInput,
  FilesRenameCategoryInput,
  FilesRenameInput,
  ForgerAccountLoginInput,
  ForgerAccountRegisterInput,
  InstallAppResult,
  OpenAppResult,
  RuntimeStatus,
  Settings,
  SharedFileRef,
  SubmitAppFeedbackInput,
  SubmitAppRatingInput,
  StopAppResult,
  UpdateAgentToolApprovalInput,
  UpdateUserSecretInput,
  VersionChangelog,
  WindowControlState,
} from '../shared/types';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const backendBaseUrl = process.env.FORGER_BACKEND_URL ?? 'http://127.0.0.1:3300';
let localCatalogJsonUrl: string | undefined;
const DEFAULT_NODE_VERSION = '24';
const DEFAULT_PYTHON_VERSION = '3.12';
const CODEX_CLI_VERSION = '0.125.0';
const CODEX_USAGE_DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
let devCatalogService: DevCatalogService | null = null;
const APP_FOLDER_GRANT_TTL_MS = 5 * 60 * 1000;
const appFolderGrantSecret = randomBytes(32).toString('base64url');
const useCustomWindowFrame = process.platform === 'win32';

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
}

interface AppManifestService {
  name?: string;
  type?: string;
  port?: number;
  command?: string;
  healthcheck?: string;
  context?: string;
  environment?: Record<string, string>;
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
  stack?: AppManifestStack;
  services?: AppManifestService[];
  mcp?: AppManifestMcp;
  scripts?: Record<string, string>;
  skills?: string[];
  appSecrets?: unknown;
}

interface AppManifestCodexConversation {
  enabled: boolean;
}

interface StackSkillTemplate {
  id: string;
  description: string;
  body: string;
}

interface CodexMcpServerConfig {
  name: string;
  url: string;
  token: string;
  tokenEnvVar: string;
  toolTimeoutSec?: number;
}

type AppMcpStatus = 'down' | 'starting' | 'up' | 'shutting_down';

interface AppMcpState {
  appId: string;
  status: AppMcpStatus;
  listeners: Set<string>;
  generation: number;
  process?: ChildProcessWithoutNullStreams;
  url?: string;
  token?: string;
  tokenEnvVar?: string;
  toolTimeoutSec?: number;
  startPromise?: Promise<CodexMcpServerConfig | null>;
  stopPromise?: Promise<void>;
  stopTimer?: NodeJS.Timeout;
}

let mainWindow: BrowserWindow | null = null;
let catalogApps: CatalogApp[] = [];
let settings: Settings = structuredClone(settingsSeed);
let registry: AppRegistry = { apps: {} };
let forgerAccount: StoredForgerAccount = { authenticated: false };
let forgerAccountStore: ForgerAccountStore | null = null;
let forgerBackendClient: ForgerBackendClient | null = null;
const runningApps = new Map<string, RunningAppProcess>();
const appWindows = new Map<string, BrowserWindow>();
const stoppingApps = new Set<string>();
const runtimeLocks = new Map<string, Promise<RuntimeBinarySet>>();
let chatOrchestrator: ChatOrchestrator | null = null;
let appCodexTaskManager: AppCodexTaskManager | null = null;
let appCodexConversationManager: AppCodexConversationManager | null = null;
let fileLibrary: FileLibrary | null = null;
let secretsStore: SecretsStore | null = null;
let automationManager: AutomationManager | null = null;
let appMcpManager: AppMcpManager | null = null;

const resolvePlatformAlias = (): string => {
  const platformPrefix = PLATFORM_KEY_BY_RUNTIME[process.platform] ?? process.platform;
  return `${platformPrefix}_${process.arch}`;
};

const getRegistryPath = () => path.join(app.getPath('userData'), 'app_registry.json');
const getRuntimesRoot = () => path.join(app.getPath('userData'), 'runtimes');
const getTempRoot = () => path.join(app.getPath('userData'), 'tmp');
const getLogsRoot = () => path.join(app.getPath('userData'), 'logs');
const getInstallLogPath = () => path.join(getLogsRoot(), 'install.log');
const getForgerHomeRoot = () => path.join(os.homedir(), isDev ? 'Forger-dev' : 'Forger');
const getPrivateAppsRoot = () => path.join(getForgerHomeRoot(), 'apps');
const getPrivateDataRoot = () => path.join(getForgerHomeRoot(), 'data');
const getForgerMetadataRoot = () => path.join(getForgerHomeRoot(), '.forger');
const getLegacyForgerMetadataRoot = () => path.join(getPrivateAppsRoot(), '.forger');
const getCodexRoot = () => path.join(app.getPath('userData'), 'codex-cli');
const getCodexHome = () => path.join(app.getPath('userData'), 'codex-home');
const getAgentToolSettingsPath = () => path.join(getForgerMetadataRoot(), 'agent-tools.json');
const getForgerAccountPath = () => path.join(getForgerMetadataRoot(), 'account.json');

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
        name: 'Reiniciar vista',
        description: 'Recarga la ventana de una app que ya esta abierta.',
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
];

const AGENT_TOOL_DEFINITIONS: AgentToolDefinition[] = AGENT_TOOL_PACKAGES.flatMap((toolPackage) => toolPackage.tools);

const AGENT_TOOL_IDS = new Set<AgentToolId>(AGENT_TOOL_DEFINITIONS.map((tool) => tool.id));

let agentToolSettings: AgentToolSettings = {
  approvals: AGENT_TOOL_DEFINITIONS.reduce((acc, tool) => {
    acc[tool.id] = tool.defaultRequiresApproval;
    return acc;
  }, {} as AgentToolApprovalSettings),
};

interface AgentMcpSession {
  runId: string;
  appId: string;
  token: string;
  createdAt: string;
}

interface ForgerMcpServerState {
  server: http.Server;
  url: string;
}

const agentMcpSessions = new Map<string, AgentMcpSession>();
let forgerMcpServer: ForgerMcpServerState | null = null;

const MAX_INSTALL_LOG_FIELD_LENGTH = 60_000;

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

const toAppSummary = (record: InstalledAppRecord): AppSummary => {
  const running = runningApps.get(record.appId);
  const catalog = catalogApps.find((entry) => entry.id === record.appId);
  const latestVersion = catalog?.latestVersion;
  const updateAvailable = isVersionNewer(latestVersion, record.version);
  const base = {
    capabilities: catalog?.capabilities,
    changelog: catalog?.changelog,
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

const normalizeManifestCodexConversation = (manifest: AppManifest | null): AppManifestCodexConversation | null => {
  if (!manifest || !manifest.codexConversation || typeof manifest.codexConversation !== 'object') {
    return null;
  }
  const candidate = manifest.codexConversation as Record<string, unknown>;
  return candidate.enabled === true ? { enabled: true } : null;
};

const resolveInstalledPromptTemplates = async (appId: string): Promise<AppPromptTemplate[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  return normalizeManifestPromptTemplates(await resolveInstalledManifest(record.installDir));
};

const resolveInstalledCodexConversation = async (appId: string): Promise<AppManifestCodexConversation | null> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return null;
  }
  return normalizeManifestCodexConversation(await resolveInstalledManifest(record.installDir));
};

const hasInstalledCodexConversation = async (appId: string): Promise<boolean> =>
  Boolean(await resolveInstalledCodexConversation(appId));

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
  const templates: StackSkillTemplate[] = [];
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

const copyDirectory = async (sourceDir: string, targetDir: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
};

const writeStackSkills = async (skillsRoot: string, stack: AppManifestStack, hasAppMcp = false): Promise<void> => {
  const templates = buildStackSkillTemplates(stack, hasAppMcp);
  for (const template of templates) {
    const targetDir = path.join(skillsRoot, template.id);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), template.body, 'utf8');
    await fs.writeFile(path.join(targetDir, 'README.md'), `${template.description}\n`, 'utf8');
  }
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

const loadRegistry = async (): Promise<void> => {
  const registryPath = getRegistryPath();

  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppRegistry>;
    if (parsed && parsed.apps && typeof parsed.apps === 'object') {
      registry = { apps: parsed.apps as Record<string, InstalledAppRecord> };
      return;
    }
  } catch {
    // no-op
  }

  registry = { apps: {} };
};

const saveRegistry = async (): Promise<void> => {
  const registryPath = getRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
};

const upsertInstalledRecord = async (record: InstalledAppRecord): Promise<void> => {
  registry.apps[record.appId] = record;
  await saveRegistry();
  emitRuntimeStatus({
    appId: record.appId,
    status: runningApps.has(record.appId) ? 'running' : record.status,
    userMessage: record.userMessage,
    backendUrl: runningApps.get(record.appId)?.backendUrl,
    frontendUrl: runningApps.get(record.appId)?.frontendUrl,
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

      reject(new Error(`command_failed_${code}: ${stdout}\n${stderr}`));
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

const validateArchiveEntries = async (archivePath: string): Promise<void> => {
  const listResult = archivePath.endsWith('.zip')
    ? await runCommandCapture('unzip', ['-Z', '-1', archivePath], { cwd: path.dirname(archivePath), timeoutMs: 30_000 })
    : archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')
      ? await runCommandCapture('tar', ['-tzf', archivePath], { cwd: path.dirname(archivePath), timeoutMs: 30_000 })
      : { code: 1, stdout: '', stderr: 'unsupported_archive_format' };

  if (listResult.code !== 0) {
    throw new Error(listResult.stderr || listResult.stdout || 'archive_list_failed');
  }

  const entries = listResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
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

const removeInstalledContentsPreservingGit = async (installDir: string): Promise<void> => {
  const entries = await fs.readdir(installDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name !== '.git')
      .map((entry) => fs.rm(path.join(installDir, entry.name), { recursive: true, force: true })),
  );
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
  await runCommand(nodeRuntime.npm as string, ['install'], {
    cwd: frontendDir,
    env: {
      PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    log: {
      appId,
      phase: 'installing_frontend',
      label: 'npm install',
    },
  });
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

const normalizeVersionForFolder = (value: string): string => {
  const [major, minor] = value.split('.');
  if (major && minor) {
    return `${major}.${minor}`;
  }
  return value;
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

  const version = normalizeVersionForFolder(rawVersion);
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

const ensureCodexCliInstalled = async (): Promise<string> => {
  const existing = await resolveCodexCliPath(getCodexRoot());
  if (existing) {
    return existing;
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

const connectCodexAuth = async (): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> => {
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
    const detail = error instanceof Error ? error.message : 'codex_auth_failed';
    await appendInstallLog('codex_auth:failed', {
      detail,
      error: serializeErrorForInstallLog(error),
    });
    return {
      success: false,
      userMessage: 'No pudimos iniciar el login de Codex.',
      technicalCode: detail,
    };
  }
};

const disconnectCodexAuth = async (): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> => {
  try {
    await fs.rm(getCodexAuthFilePath(), { force: true });
    return {
      success: true,
      userMessage: 'Sesion de Codex desconectada.',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'codex_logout_failed';
    return {
      success: false,
      userMessage: 'No pudimos cerrar la sesion de Codex.',
      technicalCode: detail,
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
    await runCommand(nodeRuntime.npm as string, ['install'], {
      cwd: frontendDir,
      env: {
        PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
      log: {
        appId,
        phase: 'installing_frontend',
        label: 'npm install',
      },
    });

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
    const detail = error instanceof Error ? error.message : 'install_failed_unknown';
    const current = registry.apps[appId];
    await appendInstallLog('install:failed', {
      appId,
      detail,
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
      technicalCode: detail,
    });

    ensureCatalogStatuses();

    return {
      success: false,
      phase: 'failed',
      userMessage: 'No se pudo completar la instalacion. Reintenta.',
      technicalCode: detail,
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
    await removeInstalledContentsPreservingGit(record.installDir);
    await copyDirectoryContents(stageDir, record.installDir);
    await normalizeInstalledAgentContext(record.installDir, appId);
    await ensureGlobalAgentsContext(getForgerHomeRoot());

    await publishProgress('updating_base', 'Guardando la version nueva...');
    const baseCommitSha = await gitCommitAll(record.installDir, `forger(base): update ${download.version}`);
    await upsertInstalledRecord({
      ...record,
      status: 'installing',
      userMessage: 'Combinando la actualizacion con tus cambios...',
      pendingUpdate: {
        fromVersion: record.version,
        targetVersion: download.version,
        preUpdateUserHead,
        baseCommitSha,
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
      await upsertInstalledRecord({
        ...record,
        status: 'conflict',
        userMessage: 'No pudimos combinar automaticamente la actualizacion con tus cambios.',
        pendingUpdate: {
          fromVersion: record.version,
          targetVersion: download.version,
          preUpdateUserHead,
          baseCommitSha,
          startedAt,
          message: merge.stderr || merge.stdout || 'merge_conflict',
        },
      });
      emitInstallProgress(appId, {
        success: false,
        phase: 'conflict',
        userMessage: 'La actualizacion necesita ayuda para combinarse con tus cambios.',
        technicalCode: merge.stderr || merge.stdout || 'merge_conflict',
      });
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
      ensureCatalogStatuses();
      return {
        success: false,
        phase: 'conflict',
        userMessage: 'La actualizacion necesita ayuda para combinarse con tus cambios.',
        technicalCode: merge.stderr || merge.stdout || 'merge_conflict',
      };
    }

    const nodeVersion = catalogApp.requiredNodeVersion ?? record.requiredNodeVersion;
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
    const detail = error instanceof Error ? error.message : 'update_failed_unknown';
    if (stageDir) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await appendInstallLog('update:failed', {
      appId,
      detail,
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
      technicalCode: detail,
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
    const detail = error instanceof Error ? error.message : 'restore_failed';
    return {
      success: false,
      userMessage: 'No pudimos restaurar la version anterior.',
      technicalCode: detail,
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
    promptTemplates: installed ? await resolveInstalledPromptTemplates(appId) : [],
    codexConversation: installed && await hasInstalledCodexConversation(appId) ? { enabled: true } : undefined,
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
    const detail = error instanceof Error ? error.message : 'uninstall_failed';
    return {
      success: false,
      userMessage: 'No pudimos eliminar la app.',
      technicalCode: detail,
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
    const detail = error instanceof Error ? error.message : 'install_welcome_failed';
    return {
      success: false,
      appId,
      usedCodex: false,
      userMessage: 'No pudimos preparar el mensaje inicial.',
      technicalCode: detail,
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

const openOrFocusAppWindow = async (appId: string, appName: string, frontendUrl: string): Promise<void> => {
  const existing = appWindows.get(appId);
  if (existing && !existing.isDestroyed()) {
    if (existing.webContents.getURL() !== frontendUrl) {
      await existing.loadURL(frontendUrl).catch(() => {
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
  const expectedOrigin = new URL(frontendUrl).origin;
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
    if (!stoppingApps.has(appId) && runningApps.has(appId)) {
      void stopInstalledApp(appId);
    }
  });

  await appWindow.loadURL(frontendUrl);
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

const findManifestMcp = (manifest: AppManifest | null): AppManifestMcp | null => {
  if (!manifest?.mcp || typeof manifest.mcp !== 'object') {
    return null;
  }
  if (manifest.mcp.type && manifest.mcp.type !== 'http') {
    return null;
  }
  if (!manifest.mcp.command || typeof manifest.mcp.command !== 'string') {
    return null;
  }
  return manifest.mcp;
};

const safeMcpServerName = (appId: string): string =>
  `app_${appId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

const safeMcpTokenEnvVar = (appId: string): string =>
  `FORGER_APP_MCP_TOKEN_${appId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`;

const translateMcpEnvironment = (
  environment: Record<string, string>,
  backendDir: string,
  cwd: string,
): Record<string, string> => {
  const translated = translateManifestEnvironment(environment, backendDir);
  if (typeof translated.PYTHONPATH === 'string' && translated.PYTHONPATH.trim()) {
    const entries = translated.PYTHONPATH.split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => path.isAbsolute(entry) ? entry : path.resolve(cwd, entry));
    translated.PYTHONPATH = entries.join(path.delimiter);
  }
  return translated;
};

const buildAppMcpProcessConfig = (
  mcp: AppManifestMcp,
  record: InstalledAppRecord,
  python: string,
  port: number,
  token: string,
): {
  command: string;
  args: string[];
  cwd: string;
  url: string;
  healthUrl: string;
  environment: Record<string, string>;
  tokenEnvVar: string;
  toolTimeoutSec: number;
} => {
  const rawArgs = splitManifestCommand(mcp.command);
  if (rawArgs.length === 0) {
    throw new Error('app_mcp_command_missing');
  }
  const backendDir = path.join(record.installDir, 'backend');
  const cwd = mcp.context ? path.resolve(path.join(record.installDir, mcp.context)) : backendDir;
  if (!ensurePathInside(record.installDir, cwd)) {
    throw new Error('app_mcp_context_outside_app');
  }
  const commandToken = rawArgs[0];
  const command = commandToken === 'python' || commandToken === 'python3' ? python : commandToken;
  const args = rawArgs.slice(1);
  const healthcheck = normalizeHealthcheckPath(mcp.healthcheck);
  const url = `http://127.0.0.1:${port}/mcp`;
  const tokenEnvVar = safeMcpTokenEnvVar(record.appId);
  const manifestEnvironment = mcp.environment && typeof mcp.environment === 'object' ? mcp.environment : {};
  const environment = translateMcpEnvironment(manifestEnvironment, backendDir, cwd);
  return {
    command,
    args,
    cwd,
    url,
    healthUrl: `http://127.0.0.1:${port}${healthcheck}`,
    environment: {
      ...environment,
      HOST: '127.0.0.1',
      PORT: String(port),
      FORGER_APP_ID: record.appId,
      FORGER_APP_MCP_TOKEN: token,
      [tokenEnvVar]: token,
    },
    tokenEnvVar,
    toolTimeoutSec: Math.max(1, Math.floor(mcp.toolTimeoutSec ?? 600)),
  };
};

class AppMcpManager {
  private readonly states = new Map<string, AppMcpState>();
  private readonly runListeners = new Map<string, Set<string>>();

  public async listenMcps(appIds: string[], runId: string): Promise<CodexMcpServerConfig[]> {
    const configs = await Promise.all(
      Array.from(new Set(appIds)).map((appId) => this.listenOne(appId, runId)),
    );
    return configs.filter((config): config is CodexMcpServerConfig => Boolean(config));
  }

  public releaseMcps(runId: string): void {
    const appIds = this.runListeners.get(runId);
    if (!appIds) {
      return;
    }
    this.runListeners.delete(runId);
    for (const appId of appIds) {
      const state = this.states.get(appId);
      if (!state) {
        continue;
      }
      state.listeners.delete(runId);
      if (state.listeners.size === 0) {
        this.scheduleStop(state);
      }
    }
  }

  public dispose(): void {
    for (const state of this.states.values()) {
      if (state.stopTimer) {
        clearTimeout(state.stopTimer);
      }
      if (state.process) {
        void terminateProcess(state.process);
      }
    }
    this.states.clear();
    this.runListeners.clear();
  }

  private async listenOne(appId: string, runId: string): Promise<CodexMcpServerConfig | null> {
    const record = registry.apps[appId];
    if (!record?.installDir) {
      return null;
    }
    const manifest = await resolveInstalledManifest(record.installDir);
    const mcp = findManifestMcp(manifest);
    if (!mcp) {
      return null;
    }

    const state = this.getState(appId);
    state.listeners.add(runId);
    const runApps = this.runListeners.get(runId) ?? new Set<string>();
    runApps.add(appId);
    this.runListeners.set(runId, runApps);

    if (state.stopTimer) {
      clearTimeout(state.stopTimer);
      state.stopTimer = undefined;
    }
    if (state.status === 'up' && state.url && state.token && state.tokenEnvVar) {
      return this.toConfig(state);
    }
    if (state.status === 'starting' && state.startPromise) {
      return await state.startPromise;
    }
    if (state.status === 'shutting_down' && state.stopPromise) {
      await state.stopPromise.catch(() => undefined);
    }
    if (state.status === 'up' && state.url && state.token && state.tokenEnvVar) {
      return this.toConfig(state);
    }
    state.startPromise = this.startOne(record, mcp, state);
    return await state.startPromise;
  }

  private async startOne(
    record: InstalledAppRecord,
    mcp: AppManifestMcp,
    state: AppMcpState,
  ): Promise<CodexMcpServerConfig | null> {
    const generation = state.generation + 1;
    state.generation = generation;
    state.status = 'starting';
    try {
      const pythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);
      const venv = getVenvExecutables(path.join(record.installDir, 'backend'));
      const port = await getFreePort();
      const token = randomBytes(32).toString('hex');
      const config = buildAppMcpProcessConfig(mcp, record, venv.python, port, token);
      await ensureSqliteDatabaseParent(config.environment);
      await appendInstallLog('app_mcp:start', {
        appId: record.appId,
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        url: config.url,
        healthUrl: config.healthUrl,
        pythonRuntime: pythonRuntime.rootDir,
      });
      const child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: {
          ...process.env,
          ...config.environment,
          PATH: [
            path.dirname(venv.python),
            ...getRuntimePathEntries(pythonRuntime),
            process.env.PATH ?? '',
          ].filter(Boolean).join(path.delimiter),
        },
        stdio: 'pipe',
      });
      child.stdout.on('data', (chunk) => {
        void appendInstallLog('app_mcp:stdout', {
          appId: record.appId,
          text: truncateForInstallLog(chunk.toString()),
        });
      });
      child.stderr.on('data', (chunk) => {
        void appendInstallLog('app_mcp:stderr', {
          appId: record.appId,
          text: truncateForInstallLog(chunk.toString()),
        });
      });
      child.once('exit', (code, signal) => {
        void appendInstallLog('app_mcp:exit', { appId: record.appId, code, signal });
        if (this.states.get(record.appId) === state && state.process === child) {
          state.process = undefined;
          state.url = undefined;
          state.token = undefined;
          state.tokenEnvVar = undefined;
          state.status = state.listeners.size > 0 ? 'down' : 'down';
        }
      });

      state.process = child;
      state.url = config.url;
      state.token = token;
      state.tokenEnvVar = config.tokenEnvVar;
      state.toolTimeoutSec = config.toolTimeoutSec;
      await waitForHttpOk(config.healthUrl, 30_000);
      if (state.generation !== generation || state.listeners.size === 0) {
        await terminateProcess(child);
        state.status = 'down';
        return null;
      }
      state.status = 'up';
      await appendInstallLog('app_mcp:ready', { appId: record.appId, url: config.url });
      return this.toConfig(state);
    } catch (error) {
      await appendInstallLog('app_mcp:start_failed', {
        appId: record.appId,
        error: serializeErrorForInstallLog(error),
      });
      if (state.process) {
        await terminateProcess(state.process).catch(() => undefined);
      }
      state.process = undefined;
      state.url = undefined;
      state.token = undefined;
      state.tokenEnvVar = undefined;
      state.status = 'down';
      return null;
    } finally {
      state.startPromise = undefined;
    }
  }

  private scheduleStop(state: AppMcpState): void {
    if (state.stopTimer || state.status === 'down') {
      return;
    }
    state.stopTimer = setTimeout(() => {
      state.stopTimer = undefined;
      if (state.listeners.size === 0) {
        state.stopPromise = this.stopOne(state);
      }
    }, 1_000);
  }

  private async stopOne(state: AppMcpState): Promise<void> {
    if (state.listeners.size > 0) {
      return;
    }
    if (state.status === 'starting' && state.startPromise) {
      await state.startPromise.catch(() => null);
      if (state.listeners.size > 0) {
        return;
      }
    }
    const child = state.process;
    state.status = 'shutting_down';
    state.generation += 1;
    if (child) {
      await appendInstallLog('app_mcp:stop', { appId: state.appId });
      await terminateProcess(child).catch(() => undefined);
    }
    if (state.listeners.size === 0) {
      state.process = undefined;
      state.url = undefined;
      state.token = undefined;
      state.tokenEnvVar = undefined;
      state.status = 'down';
    } else {
      state.status = 'down';
    }
    state.stopPromise = undefined;
  }

  private getState(appId: string): AppMcpState {
    const existing = this.states.get(appId);
    if (existing) {
      return existing;
    }
    const state: AppMcpState = {
      appId,
      status: 'down',
      listeners: new Set<string>(),
      generation: 0,
    };
    this.states.set(appId, state);
    return state;
  }

  private toConfig(state: AppMcpState): CodexMcpServerConfig | null {
    if (!state.url || !state.token || !state.tokenEnvVar) {
      return null;
    }
    return {
      name: safeMcpServerName(state.appId),
      url: state.url,
      token: state.token,
      tokenEnvVar: state.tokenEnvVar,
      toolTimeoutSec: state.toolTimeoutSec,
    };
  }
}

const normalizeHealthcheckPath = (healthcheck: string | undefined): string => {
  const value = healthcheck?.trim() || '/health';
  return value.startsWith('/') ? value : `/${value}`;
};

const openInstalledApp = async (appId: string): Promise<OpenAppResult> => {
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
    await openOrFocusAppWindow(appId, record.name, running.frontendUrl);
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

  await appendInstallLog('open:start', {
    appId,
    installDir: record.installDir,
    requiredNodeVersion: record.requiredNodeVersion,
    requiredPythonVersion: record.requiredPythonVersion,
    connectedSecrets: Object.keys(resolvedSecrets.env),
    logPath: getInstallLogPath(),
  });

  const nodeRuntime = await ensureRuntimeInstalled('node', record.requiredNodeVersion);
  await ensureRuntimeInstalled('python', record.requiredPythonVersion);

  const backendService = findManifestService(manifest, 'backend', './backend');
  const frontendService = findManifestService(manifest, 'frontend', './frontend');
  const backendDir = path.join(record.installDir, 'backend');
  const frontendDir = path.join(record.installDir, 'frontend');
  const venv = getVenvExecutables(backendDir);

  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
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
        CORS_ORIGINS: `${frontendUrl},http://127.0.0.1:${frontendPort}`,
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
        CORS_ORIGINS: `${frontendUrl},http://127.0.0.1:${frontendPort}`,
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
      VITE_API_BASE_URL: backendUrl,
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
  });

  try {
    await waitForHttpOk(`${backendUrl}${backendHealthcheckPath}`, 60_000);
    await waitForHttpOk(frontendUrl, 60_000);
    await openOrFocusAppWindow(appId, record.name, frontendUrl);
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
    const detail = error instanceof Error ? error.message : 'open_failed';
    await appendInstallLog('open:failed', {
      appId,
      detail,
      error: serializeErrorForInstallLog(error),
    });

    await terminateProcess(backend);
    await terminateProcess(frontend);
    runningApps.delete(appId);
    closeAppWindow(appId);
    await markAppRuntimeStatus(appId, 'error', 'No pudimos iniciar la app. Reintenta.');

    return {
      success: false,
      userMessage: 'No pudimos iniciar la app. Reintenta.',
      technicalCode: detail,
    };
  }
};

const stopInstalledApp = async (appId: string): Promise<StopAppResult> => {
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

  return {
    success: true,
    userMessage: 'App detenida correctamente.',
  };
};

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

const createForgerMcpSession = (runId: string, appId: string): { url: string; token: string } | null => {
  if (!forgerMcpServer) {
    void appendInstallLog('agent_tool:mcp_session_unavailable', { runId, appId });
    return null;
  }
  const token = randomBytes(32).toString('hex');
  agentMcpSessions.set(token, {
    runId,
    appId,
    token,
    createdAt: new Date().toISOString(),
  });
  void appendInstallLog('agent_tool:mcp_session_created', {
    runId,
    appId,
    url: forgerMcpServer.url,
    tokenSuffix: token.slice(-6),
  });
  return { url: forgerMcpServer.url, token };
};

const releaseForgerMcpSession = (token: string): void => {
  const session = agentMcpSessions.get(token);
  agentMcpSessions.delete(token);
  void appendInstallLog('agent_tool:mcp_session_released', {
    runId: session?.runId ?? null,
    appId: session?.appId ?? null,
    tokenSuffix: token.slice(-6),
  });
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

const sendMcpJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const getBearerToken = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header || Array.isArray(header)) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};

const getMcpToolInputSchema = (toolId: AgentToolId): Record<string, unknown> => {
  if (
    toolId === 'forger_get_app_runtime_status' ||
    toolId === 'forger_open_app' ||
    toolId === 'forger_stop_app' ||
    toolId === 'forger_restart_app' ||
    toolId === 'forger_refresh_app_view' ||
    toolId === 'forger_update_app'
  ) {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada sobre la que se ejecuta la herramienta.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
};

const getMcpTools = () =>
  AGENT_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.id,
    description: tool.description,
    inputSchema: getMcpToolInputSchema(tool.id),
  }));

const getToolAppId = (session: AgentMcpSession, params: Record<string, unknown>): string => {
  const appId = typeof params.appId === 'string' && params.appId.trim() ? params.appId.trim() : session.appId;
  return appId;
};

interface ToolApprovalResult {
  approved: boolean;
  required: boolean;
  status: 'not_required' | 'approved' | 'denied' | 'unavailable';
  userMessage: string;
}

const withToolAuthorization = (result: unknown, approval: ToolApprovalResult): unknown => {
  if (!approval.required || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  return {
    ...(result as Record<string, unknown>),
    authorization: {
      required: true,
      status: approval.status,
      userMessage: approval.userMessage,
    },
  };
};

const ensureToolApproval = async (session: AgentMcpSession, tool: AgentToolDefinition): Promise<ToolApprovalResult> => {
  if (!agentToolSettings.approvals[tool.id]) {
    await appendInstallLog('agent_tool:approval_skipped', {
      appId: session.appId,
      runId: session.runId,
      toolId: tool.id,
      reason: 'approval_not_required',
    });
    return {
      approved: true,
      required: false,
      status: 'not_required',
      userMessage: 'Esta herramienta no requirio autorizacion adicional.',
    };
  }
  if (!chatOrchestrator) {
    await appendInstallLog('agent_tool:approval_unavailable', {
      appId: session.appId,
      runId: session.runId,
      toolId: tool.id,
      reason: 'chat_orchestrator_unavailable',
    });
    return {
      approved: false,
      required: true,
      status: 'unavailable',
      userMessage: 'No se pudo solicitar autorizacion para esta herramienta.',
    };
  }
  await appendInstallLog('agent_tool:approval_requested', {
    appId: session.appId,
    runId: session.runId,
    toolId: tool.id,
    toolName: tool.name,
  });
  const approved = await chatOrchestrator.requestExternalPermission(session.runId, {
    pluginId: 'forger-agent-tools',
    permission: tool.id,
    reason: tool.description,
    risk: tool.risk === 'alto' ? 'high' : tool.risk === 'medio' ? 'medium' : 'low',
    resource: tool.name,
  });
  await appendInstallLog('agent_tool:approval_resolved', {
    appId: session.appId,
    runId: session.runId,
    toolId: tool.id,
    approved,
  });
  return {
    approved,
    required: true,
    status: approved ? 'approved' : 'denied',
    userMessage: approved
      ? 'Autorizacion recibida. La herramienta continuo con la accion solicitada.'
      : 'La autorizacion fue rechazada o cancelada.',
  };
};

const executeAgentTool = async (
  session: AgentMcpSession,
  toolId: AgentToolId,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const tool = AGENT_TOOL_DEFINITIONS.find((candidate) => candidate.id === toolId);
  if (!tool) {
    await appendInstallLog('agent_tool:not_found', {
      appId: session.appId,
      runId: session.runId,
      toolId,
      args,
    });
    return { success: false, userMessage: 'La herramienta no esta disponible.', technicalCode: 'tool_not_found' };
  }

  await appendInstallLog('agent_tool:call_received', {
    appId: session.appId,
    runId: session.runId,
    toolId,
    args,
    requiresApproval: Boolean(agentToolSettings.approvals[tool.id]),
  });

  const approval = await ensureToolApproval(session, tool);
  if (!approval.approved) {
    await appendInstallLog('agent_tool:call_cancelled', {
      appId: session.appId,
      runId: session.runId,
      toolId,
      reason: 'forger_permission_denied_or_unavailable',
    });
    return withToolAuthorization(
      { success: false, userMessage: 'La accion fue cancelada por el usuario.', technicalCode: 'permission_denied' },
      approval,
    );
  }

  await appendInstallLog('agent_tool:call', {
    appId: session.appId,
    toolId,
    runId: session.runId,
  });

  if (toolId === 'forger_list_catalog') {
    catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    const result = { success: true, apps: catalogApps };
    await appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_list_installed_apps') {
    const result = { success: true, apps: Object.values(registry.apps).map(toAppSummary) };
    await appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_check_updates') {
    catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    const updates = Object.values(registry.apps)
      .map((record) => toAppSummary(record))
      .filter((summary) => summary.updateAvailable);
    const result = { success: true, updates };
    await appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  const appId = getToolAppId(session, args);

  if (toolId === 'forger_get_app_runtime_status') {
    const result = { success: true, status: getRuntimeStatus(appId) };
    await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_open_app') {
    const result = await openInstalledApp(appId);
    await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_stop_app') {
    const result = await stopInstalledApp(appId);
    await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_restart_app') {
    const stop = await stopInstalledApp(appId);
    if (!stop.success) {
      await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result: stop });
      return withToolAuthorization(stop, approval);
    }
    const result = await openInstalledApp(appId);
    await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_refresh_app_view') {
    const window = appWindows.get(appId);
    const running = runningApps.get(appId);
    if (window && !window.isDestroyed()) {
      window.webContents.reloadIgnoringCache();
      const result = { success: true, userMessage: 'Vista reiniciada correctamente.' };
      await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }
    if (running) {
      const record = registry.apps[appId];
      await openOrFocusAppWindow(appId, record?.name ?? appId, running.frontendUrl);
      const result = { success: true, userMessage: 'Vista abierta correctamente.' };
      await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }
    const result = { success: false, userMessage: 'La app no esta abierta.', technicalCode: 'app_not_running' };
    await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  if (toolId === 'forger_update_app') {
    const result = await updateAppRuntime(appId);
    await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  const result = { success: false, userMessage: 'La herramienta no esta disponible.', technicalCode: 'tool_not_found' };
  await appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
  return withToolAuthorization(result, approval);
};

const handleMcpRequest = async (
  session: AgentMcpSession,
  request: JsonRpcRequest,
): Promise<Record<string, unknown> | null> => {
  const id = request.id ?? null;
  await appendInstallLog('agent_tool:mcp_request', {
    appId: session.appId,
    runId: session.runId,
    method: request.method ?? null,
    id,
  });
  if (!request.method) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
  }

  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'forger', version: app.getVersion() },
      },
    };
  }

  if (request.method === 'notifications/initialized') {
    return null;
  }

  if (request.method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (request.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: getMcpTools() } };
  }

  if (request.method === 'tools/call') {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    const toolName = params?.name;
    await appendInstallLog('agent_tool:mcp_tools_call_received', {
      appId: session.appId,
      runId: session.runId,
      id,
      toolName,
      arguments: params?.arguments ?? null,
    });
    if (!isAgentToolId(toolName)) {
      await appendInstallLog('agent_tool:mcp_tools_call_rejected', {
        appId: session.appId,
        runId: session.runId,
        id,
        toolName,
        reason: 'unknown_tool',
      });
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
    }
    const args = params?.arguments && typeof params.arguments === 'object'
      ? (params.arguments as Record<string, unknown>)
      : {};
    const result = await executeAgentTool(session, toolName, args);
    await appendInstallLog('agent_tool:mcp_tools_call_completed', {
      appId: session.appId,
      runId: session.runId,
      id,
      toolName,
      isError: Boolean((result as { success?: unknown }).success === false),
    });
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: Boolean((result as { success?: unknown }).success === false),
      },
    };
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
};

const startForgerMcpServer = async (): Promise<void> => {
  if (forgerMcpServer) {
    return;
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (request.method !== 'POST' || requestPath !== '/mcp') {
        sendMcpJson(response, 404, { error: 'not_found' });
        return;
      }

      const token = getBearerToken(request);
      const session = token ? agentMcpSessions.get(token) : null;
      if (!session) {
        void appendInstallLog('agent_tool:mcp_unauthorized', {
          path: requestPath,
          hasToken: Boolean(token),
        });
        sendMcpJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const raw = await readRequestBody(request);
      const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      await appendInstallLog('agent_tool:mcp_http_request', {
        appId: session.appId,
        runId: session.runId,
        requestCount: requests.length,
        methods: requests.map((entry) => entry.method ?? null),
      });
      const results = (await Promise.all(requests.map((entry) => handleMcpRequest(session, entry))))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));

      if (results.length === 0) {
        response.writeHead(202);
        response.end();
        return;
      }

      sendMcpJson(response, 200, Array.isArray(parsed) ? results : results[0]);
    })().catch((error) => {
      void appendInstallLog('agent_tool:mcp_http_error', {
        message: error instanceof Error ? error.message : 'internal_error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      sendMcpJson(response, 500, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'internal_error',
        },
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('forger_mcp_server_address_unavailable');
  }

  forgerMcpServer = {
    server,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };

  await appendInstallLog('agent_tool:mcp_server_started', { url: forgerMcpServer.url });
};

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

  ipcMain.handle(IPC_CHANNELS.openApp, async (_event, appId: string) => {
    return await openInstalledApp(appId);
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
    }
    catalogApps = await listCatalogFromBackend();
    return { ...publicForgerAccount(forgerAccount), success: result.success, userMessage: result.userMessage, technicalCode: result.technicalCode };
  });
  ipcMain.handle(IPC_CHANNELS.logoutForgerAccount, async () => {
    await forgerBackendClient?.logoutAccount();
    forgerAccount = { authenticated: false };
    await forgerAccountStore?.clear();
    catalogApps = await listCatalogFromBackend();
    return { ...publicForgerAccount(forgerAccount), success: true };
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
  ipcMain.handle(IPC_CHANNELS.getCodexAuthStatus, async () => await getCodexAuthStatus());
  ipcMain.handle(IPC_CHANNELS.openCodexUsageDashboard, async () => {
    try {
      await shell.openExternal(CODEX_USAGE_DASHBOARD_URL);
      return { success: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'open_codex_usage_failed';
      return { success: false, technicalCode: detail, userMessage: 'No pudimos abrir el panel de uso de Codex.' };
    }
  });
  ipcMain.handle(IPC_CHANNELS.connectCodexAuth, async () => await connectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.disconnectCodexAuth, async () => await disconnectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.listAgentTools, async () => AGENT_TOOL_PACKAGES);
  ipcMain.handle(IPC_CHANNELS.getAgentToolSettings, async () => agentToolSettings);
  ipcMain.handle(IPC_CHANNELS.updateAgentToolApproval, async (_event, input: UpdateAgentToolApprovalInput) => {
    return await updateAgentToolApproval(input);
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
    const enrichedPrompt = buildCodexPromptWithAppContext({
      appId: input.appId,
      displayName: resolveSelectedAppDisplayName(input.appId),
      userPrompt: input.prompt,
      userLanguage: input.userLanguage,
      sharedFilesRootName: path.basename(getPrivateDataRoot()),
      sharedFiles: sharedFiles.map((fileRef) => ({
        name: fileRef.name ?? path.basename(fileRef.path),
        relativePath: toPosixRelativePath(fileRef.relativePath ?? path.relative(getPrivateDataRoot(), fileRef.path)),
        sizeBytes: fileRef.sizeBytes ?? 0,
        modifiedAt: fileRef.modifiedAt ?? '',
        source: fileRef.source ?? 'mentioned',
      })),
    });
    return await chatOrchestrator.startRun({
      ...input,
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

  ipcMain.handle(IPC_CHANNELS.appCodexTaskStart, async (event, input: AppCodexTaskStartInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appCodexTaskManager) {
      throw new Error('app_codex_task_manager_unavailable');
    }
    return await appCodexTaskManager.start(appId, input);
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

  ipcMain.handle(IPC_CHANNELS.appCodexConversationCreate, async (event, input: AppCodexConversationCreateInput) => {
    const appId = resolveAppIdForWebContents(event.sender.id);
    if (!appId) {
      throw new Error('app_window_not_authorized');
    }
    if (!appCodexConversationManager) {
      throw new Error('app_codex_conversation_manager_unavailable');
    }
    return await appCodexConversationManager.create(appId, input ?? {});
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
    return await appCodexConversationManager.sendMessage(appId, input);
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
    getInvokingWindow(event)?.close();
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
  await ensureGlobalAgentsContext(getForgerHomeRoot());
  await fs.mkdir(getCodexRoot(), { recursive: true });
  await fs.mkdir(getCodexHome(), { recursive: true });
  secretsStore = new SecretsStore(app.getPath('userData'));
  await loadAgentToolSettings();
  forgerAccountStore = new ForgerAccountStore(getForgerAccountPath());
  forgerAccount = await forgerAccountStore.load();
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
  await startForgerMcpServer();
  appMcpManager = new AppMcpManager();
  fileLibrary = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
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
        const appNodeRuntime = await ensureRuntimeInstalled('node', record.requiredNodeVersion);
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
    createForgerMcpSession,
    releaseForgerMcpSession,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
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
        const appNodeRuntime = await ensureRuntimeInstalled('node', record.requiredNodeVersion);
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
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    onTaskUpdated: (event) => {
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
        const appNodeRuntime = await ensureRuntimeInstalled('node', record.requiredNodeVersion);
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
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    onConversationEvent: (event) => {
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
    createForgerMcpSession,
    releaseForgerMcpSession,
    listenAppMcps: async (appIds: string[], runId: string) =>
      await (appMcpManager?.listenMcps(appIds, runId) ?? Promise.resolve([])),
    releaseAppMcps: (runId: string) => {
      appMcpManager?.releaseMcps(runId);
    },
    onAutomationUpdated: (event) => {
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
  devCatalogService?.stop();
  forgerMcpServer?.server.close();
  forgerMcpServer = null;
  for (const running of runningApps.values()) {
    void terminateProcess(running.backend);
    void terminateProcess(running.frontend);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
