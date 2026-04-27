export type AppStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error';

export type AppCategory = 'finanzas' | 'hogar' | 'salud' | 'productividad';

export interface AppSummary {
  id: string;
  category: AppCategory;
  status: AppStatus;
  name?: string;
  description?: string;
  version?: string;
  userMessage?: string;
}

export interface CatalogApp extends AppSummary {
  latestVersionId?: number;
  latestVersion?: string;
  requiredPythonVersion?: string;
  requiredNodeVersion?: string;
  checksumSha256?: string;
  downloadUrl?: string;
}

export interface Settings {
  userEmail: string;
  plan: string;
  safeMode: boolean;
}

export interface CodexAuthStatus {
  installed: boolean;
  authenticated: boolean;
  authFilePath: string;
  codexHome: string;
  codexCliPath?: string;
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface CodexModelOption {
  displayModelName: string;
  realModelName: string;
  defaultReasoningEffort: CodexReasoningEffort;
}

export interface MockActionResult {
  ok: true;
}

export type InstallPhase =
  | 'starting'
  | 'downloading'
  | 'extracting'
  | 'preparing_runtime'
  | 'installing_backend'
  | 'installing_frontend'
  | 'completed'
  | 'failed';

export interface InstallAppResult {
  success: boolean;
  phase: InstallPhase;
  userMessage: string;
  technicalCode?: string;
}

export interface BasicActionResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
}

export interface OpenAppResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
  backendUrl?: string;
  frontendUrl?: string;
}

export interface RuntimeStatus {
  appId: string;
  status: AppStatus;
  userMessage?: string;
  backendUrl?: string;
  frontendUrl?: string;
}

export interface StopAppResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
}

export type ChatRunStatus =
  | 'queued'
  | 'running'
  | 'needs_permission'
  | 'preview_ready'
  | 'applying'
  | 'applied'
  | 'undoing'
  | 'undone'
  | 'failed'
  | 'canceled';

export type ChatErrorCode =
  | 'auth_missing'
  | 'app_not_installed'
  | 'sandbox_violation'
  | 'permission_denied'
  | 'timeout'
  | 'canceled'
  | 'conflict'
  | 'capability_unavailable';

export interface SharedFileRef {
  path: string;
  id?: string;
  name?: string;
  relativePath?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  source?: 'attached' | 'mentioned';
}

export interface PermissionRequest {
  requestId: string;
  pluginId: string;
  permission: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  resource: string;
}

export interface PreviewDiffFile {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  diff: string;
}

export interface PreviewModel {
  summary: string;
  impact: string;
  riskLevel: 'low' | 'medium' | 'high';
  filesChanged: number;
  diffFiles: PreviewDiffFile[];
  checks: string[];
}

export interface ChatRun {
  runId: string;
  appId: string;
  prompt: string;
  threadId?: string | null;
  status: ChatRunStatus;
  createdAt: string;
  updatedAt: string;
  dangerMode: boolean;
  permissionRequest?: PermissionRequest;
  preview?: PreviewModel;
  errorCode?: ChatErrorCode;
  userMessage?: string;
  progressLog?: string[];
  operationId?: string;
  commitSha?: string;
}

export interface AppOperationSummary {
  operationId: string;
  runId?: string;
  commitSha?: string;
  title: string;
  summary: string;
  createdAt: string;
  revertedAt?: string;
}

export interface AppDetails {
  app: CatalogApp | AppSummary;
  installed: boolean;
  status: AppStatus;
  version?: string;
  latestVersion?: string;
  originalCommitSha?: string;
  installedAt?: string;
  operations: AppOperationSummary[];
}

export interface InstallWelcomeResult {
  success: boolean;
  appId: string;
  message?: string;
  usedCodex: boolean;
  userMessage: string;
  technicalCode?: string;
}

export interface ChatRunEvent {
  run: ChatRun;
}

export interface ChatStartRunInput {
  appId: string;
  prompt: string;
  threadId?: string | null;
  sharedFiles?: SharedFileRef[];
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  dangerMode?: boolean;
}

export interface ChatGetRunInput {
  runId: string;
}

export interface ChatCancelRunInput {
  runId: string;
}

export interface ChatApprovePermissionInput {
  runId: string;
  requestId: string;
  decision: 'allow' | 'deny';
}

export interface ChatApplyRunInput {
  runId: string;
}

export interface ChatUndoInput {
  appId: string;
  operationId?: string;
}

export interface ChatApplyResult {
  success: boolean;
  operationId?: string;
  commitSha?: string;
  userMessage?: string;
  technicalCode?: string;
}

export interface ChatUndoResult {
  success: boolean;
  revertedCommitSha?: string;
  userMessage?: string;
  technicalCode?: string;
}

export interface DbListTablesResult {
  tables: string[];
  dbPath: string;
  error?: never;
}

export interface DbListTablesError {
  tables?: never;
  dbPath?: never;
  error: string;
}

export type DbListTablesResponse = DbListTablesResult | DbListTablesError;

export interface DbQueryTableResult {
  columns: string[];
  rows: unknown[][];
  total: number;
  error?: never;
}

export interface DbQueryTableError {
  columns?: never;
  rows?: never;
  total?: never;
  error: string;
}

export type DbQueryTableResponse = DbQueryTableResult | DbQueryTableError;

export interface ForgerFileRecord {
  id: string;
  name: string;
  relativePath: string;
  categoryPath: string;
  sizeBytes: number;
  uploadedAt: string;
  modifiedAt: string;
  type: string;
  appId?: string;
}

export interface ForgerFileCategory {
  path: string;
  name: string;
  parentPath: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface PickedChatFile {
  sourcePath: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  type: string;
}

export interface FilesListInput {
  query?: string;
  categoryPath?: string;
  type?: string;
  sortBy?: 'name' | 'uploadedAt' | 'modifiedAt' | 'sizeBytes';
  sortDirection?: 'asc' | 'desc';
}

export interface FilesImportInput {
  sourcePaths: string[];
  categoryPath?: string;
  appId?: string;
}

export interface FilesMoveInput {
  fileIds: string[];
  categoryPath: string;
}

export interface FilesRenameInput {
  fileId: string;
  name: string;
}

export interface FilesDeleteInput {
  fileIds: string[];
}

export interface FilesCreateCategoryInput {
  parentPath?: string;
  name: string;
}

export interface FilesRenameCategoryInput {
  categoryPath: string;
  newName: string;
}

export interface FilesDeleteCategoryInput {
  categoryPath: string;
  mode: 'emptyOnly';
}

export interface FilesActionResult {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
}

export interface ForgerDesktopApi {
  listInstalledApps: () => Promise<AppSummary[]>;
  listCatalogApps: () => Promise<CatalogApp[]>;
  installApp: (appId: string) => Promise<InstallAppResult>;
  uninstallApp: (appId: string) => Promise<BasicActionResult>;
  getAppDetails: (appId: string) => Promise<AppDetails | null>;
  installWelcome: (appId: string) => Promise<InstallWelcomeResult>;
  openApp: (appId: string) => Promise<OpenAppResult>;
  stopApp: (appId: string) => Promise<StopAppResult>;
  getAppRuntimeStatus: (appId: string) => Promise<RuntimeStatus>;
  onInstallProgress: (listener: (event: { appId: string; progress: InstallAppResult }) => void) => () => void;
  onRuntimeStatusChanged: (listener: (event: RuntimeStatus) => void) => () => void;
  getSettings: () => Promise<Settings>;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  openCodexUsageDashboard: () => Promise<{ success: boolean; userMessage?: string; technicalCode?: string }>;
  connectCodexAuth: () => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  disconnectCodexAuth: () => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  chatStartRun: (input: ChatStartRunInput) => Promise<{ runId: string; status: ChatRunStatus }>;
  chatGetRun: (input: ChatGetRunInput) => Promise<ChatRun | null>;
  chatCancelRun: (input: ChatCancelRunInput) => Promise<{ success: boolean }>;
  chatApprovePermission: (input: ChatApprovePermissionInput) => Promise<{ success: boolean }>;
  chatApplyRun: (input: ChatApplyRunInput) => Promise<ChatApplyResult>;
  chatUndo: (input: ChatUndoInput) => Promise<ChatUndoResult>;
  onChatRunUpdated: (listener: (event: ChatRunEvent) => void) => () => void;
  filesPickForChat: () => Promise<PickedChatFile[]>;
  filesList: (input?: FilesListInput) => Promise<ForgerFileRecord[]>;
  filesListCategories: () => Promise<ForgerFileCategory[]>;
  filesCreateCategory: (input: FilesCreateCategoryInput) => Promise<ForgerFileCategory>;
  filesRenameCategory: (input: FilesRenameCategoryInput) => Promise<FilesActionResult>;
  filesDeleteCategory: (input: FilesDeleteCategoryInput) => Promise<FilesActionResult>;
  filesImport: (input: FilesImportInput) => Promise<ForgerFileRecord[]>;
  filesMove: (input: FilesMoveInput) => Promise<ForgerFileRecord[]>;
  filesRename: (input: FilesRenameInput) => Promise<ForgerFileRecord>;
  filesDelete: (input: FilesDeleteInput) => Promise<FilesActionResult>;
  dbListTables: (appId: string) => Promise<DbListTablesResponse>;
  dbQueryTable: (appId: string, tableName: string, limit?: number) => Promise<DbQueryTableResponse>;
}
