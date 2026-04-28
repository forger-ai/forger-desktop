export type AppStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error' | 'conflict';

export type AppCategory = 'finanzas' | 'hogar' | 'salud' | 'productividad';

export interface AppSummary {
  id: string;
  category: AppCategory;
  status: AppStatus;
  name?: string;
  description?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  changelog?: VersionChangelog;
  capabilities?: AppCapability[];
  userMessage?: string;
}

export interface VersionChangelog {
  version: string;
  summary?: string;
  changes: string[];
}

export interface AppCapability {
  id: string;
  title: string;
  description?: string;
}

export interface CatalogApp extends AppSummary {
  latestVersionId?: number;
  latestVersion?: string;
  requiredPythonVersion?: string;
  requiredNodeVersion?: string;
  checksumSha256?: string;
  downloadUrl?: string;
  capabilities?: AppCapability[];
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
  | 'checking_update'
  | 'updating_base'
  | 'merging_user_changes'
  | 'conflict'
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

export interface AppSecretDeclaration {
  name: string;
  required: boolean;
  usage: string;
  label?: string;
}

export interface UserSecretSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppSecretConnection {
  appSecret: AppSecretDeclaration;
  envName: string;
  connected: boolean;
  userSecretId?: string;
  userSecretName?: string;
}

export interface AppSecretsState {
  appId: string;
  appName: string;
  appSecrets: AppSecretConnection[];
  userSecrets: UserSecretSummary[];
}

export interface SecretMutationResult {
  success: boolean;
  userMessage: string;
  technicalCode?: string;
}

export interface CreateUserSecretInput {
  name: string;
  value: string;
}

export interface UpdateUserSecretInput {
  id: string;
  name: string;
  value?: string;
}

export interface DeleteUserSecretInput {
  id: string;
}

export interface ConnectAppSecretInput {
  appId: string;
  appSecretName: string;
  userSecretId: string;
}

export interface DisconnectAppSecretInput {
  appId: string;
  appSecretName: string;
}

export type AgentToolId =
  | 'forger_list_catalog'
  | 'forger_list_installed_apps'
  | 'forger_check_updates'
  | 'forger_get_app_runtime_status'
  | 'forger_open_app'
  | 'forger_stop_app'
  | 'forger_restart_app'
  | 'forger_refresh_app_view'
  | 'forger_update_app';

export type AgentToolCategory = 'consulta' | 'app' | 'actualizacion' | 'vista';

export type AgentToolRisk = 'bajo' | 'medio' | 'alto';

export interface AgentToolDefinition {
  id: AgentToolId;
  packageId: string;
  name: string;
  description: string;
  category: AgentToolCategory;
  risk: AgentToolRisk;
  defaultRequiresApproval: boolean;
}

export interface AgentToolPackageDefinition {
  id: string;
  name: string;
  description: string;
  icon: 'forger';
  tools: AgentToolDefinition[];
}

export type AgentToolApprovalSettings = Record<AgentToolId, boolean>;

export interface AgentToolSettings {
  approvals: AgentToolApprovalSettings;
}

export interface UpdateAgentToolApprovalInput {
  toolId: AgentToolId;
  requiresApproval: boolean;
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
  | 'dirty_worktree'
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
  updateAvailable?: boolean;
  changelog?: VersionChangelog;
  conflictInfo?: AppUpdateConflictInfo;
  originalCommitSha?: string;
  installedAt?: string;
  operations: AppOperationSummary[];
}

export interface AppUpdateConflictInfo {
  fromVersion: string;
  targetVersion: string;
  startedAt: string;
  message?: string;
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
  userLanguage?: string;
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

export interface AppExternalFolderGrant {
  canceled: false;
  path: string;
  grantToken: string;
  expiresAt: string;
}

export interface AppExternalFolderCanceled {
  canceled: true;
}

export type AppExternalFolderSelection = AppExternalFolderGrant | AppExternalFolderCanceled;

export interface ForgerAppApi {
  selectExternalFolder: () => Promise<AppExternalFolderSelection>;
}

export type AutomationFrequencyType = 'hourly' | 'daily' | 'weekly';

export interface AutomationFrequency {
  type: AutomationFrequencyType;
  timeOfDay?: string;
  weeklyDay?: number;
}

export type AutomationRunTrigger = 'manual' | 'scheduled';
export type AutomationRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AutomationRunSummary {
  id: string;
  automationId: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  userMessage?: string;
  userMessages?: string[];
  transcriptPreview?: string;
}

export interface Automation {
  id: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  selectedAppIds: string[];
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: AutomationRunSummary;
}

export interface AutomationRun extends AutomationRunSummary {
  transcript: string;
}

export interface AutomationUpsertInput {
  id?: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  selectedAppIds: string[];
  enabled?: boolean;
}

export interface WindowControlState {
  isMaximized: boolean;
  isFullScreen: boolean;
  usesCustomFrame: boolean;
}

export interface ForgerDesktopApi {
  listInstalledApps: () => Promise<AppSummary[]>;
  listCatalogApps: () => Promise<CatalogApp[]>;
  installApp: (appId: string) => Promise<InstallAppResult>;
  updateApp: (appId: string) => Promise<InstallAppResult>;
  restoreAppUserVersion: (appId: string) => Promise<BasicActionResult>;
  resolveAppUpdateConflict: (appId: string) => Promise<{ runId: string; status: ChatRunStatus } | BasicActionResult>;
  uninstallApp: (appId: string) => Promise<BasicActionResult>;
  getAppDetails: (appId: string) => Promise<AppDetails | null>;
  installWelcome: (appId: string, userLanguage?: string) => Promise<InstallWelcomeResult>;
  openApp: (appId: string) => Promise<OpenAppResult>;
  stopApp: (appId: string) => Promise<StopAppResult>;
  getAppRuntimeStatus: (appId: string) => Promise<RuntimeStatus>;
  getAppSecrets: (appId: string) => Promise<AppSecretsState>;
  listUserSecrets: () => Promise<UserSecretSummary[]>;
  createUserSecret: (input: CreateUserSecretInput) => Promise<SecretMutationResult>;
  updateUserSecret: (input: UpdateUserSecretInput) => Promise<SecretMutationResult>;
  deleteUserSecret: (input: DeleteUserSecretInput) => Promise<SecretMutationResult>;
  connectAppSecret: (input: ConnectAppSecretInput) => Promise<SecretMutationResult>;
  disconnectAppSecret: (input: DisconnectAppSecretInput) => Promise<SecretMutationResult>;
  onInstallProgress: (listener: (event: { appId: string; progress: InstallAppResult }) => void) => () => void;
  onRuntimeStatusChanged: (listener: (event: RuntimeStatus) => void) => () => void;
  getSettings: () => Promise<Settings>;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  openCodexUsageDashboard: () => Promise<{ success: boolean; userMessage?: string; technicalCode?: string }>;
  connectCodexAuth: () => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  disconnectCodexAuth: () => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  listAgentTools: () => Promise<AgentToolPackageDefinition[]>;
  getAgentToolSettings: () => Promise<AgentToolSettings>;
  updateAgentToolApproval: (input: UpdateAgentToolApprovalInput) => Promise<AgentToolSettings>;
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
  automationsList: () => Promise<Automation[]>;
  automationsCreate: (input: AutomationUpsertInput) => Promise<Automation>;
  automationsUpdate: (input: AutomationUpsertInput & { id: string }) => Promise<Automation>;
  automationsDelete: (id: string) => Promise<FilesActionResult>;
  automationsPause: (id: string) => Promise<Automation>;
  automationsResume: (id: string) => Promise<Automation>;
  automationsRunNow: (id: string) => Promise<AutomationRunSummary>;
  automationsListRuns: (automationId: string) => Promise<AutomationRunSummary[]>;
  automationsGetRunTranscript: (runId: string) => Promise<AutomationRun | null>;
  onAutomationUpdated: (listener: (event: { automation: Automation; run?: AutomationRunSummary }) => void) => () => void;
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<WindowControlState>;
  closeWindow: () => Promise<void>;
  getWindowState: () => Promise<WindowControlState>;
  onWindowStateChanged: (listener: (state: WindowControlState) => void) => () => void;
}

declare global {
  interface Window {
    forgerApp?: ForgerAppApi;
  }
}
