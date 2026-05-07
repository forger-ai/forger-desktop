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
  iconUrl?: string;
  beta?: boolean;
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
  title?: string;
  description?: string;
}

export interface AppPromptTemplate {
  id: string;
  title: string;
  description?: string;
  arguments?: AppPromptTemplateArgument[];
  acceptedFileTypes?: string[];
  prompt: string;
}

export interface AppAgent {
  id: string;
  title: string;
  description?: string;
  initialPrompt: string;
  legacy?: boolean;
}

export type AppPromptTemplateArgumentType = 'file' | 'string';

export interface AppPromptTemplateArgument {
  name: string;
  type: AppPromptTemplateArgumentType;
  required?: boolean;
  multiple?: boolean;
  acceptedFileTypes?: string[];
  maxBytes?: number;
  maxLength?: number;
}

export interface CatalogApp extends AppSummary {
  latestVersionId?: number;
  latestVersion?: string;
  requiredPythonVersion?: string;
  requiredNodeVersion?: string;
  checksumSha256?: string;
  downloadUrl?: string;
  capabilities?: AppCapability[];
  averageRating?: number;
  ratingsCount?: number;
  recentRatings?: AppRatingSummary[];
  currentUserRating?: AppRatingSummary;
}

export interface ForgerAccountUser {
  id: number;
  email: string;
  firstName?: string;
  lastName?: string;
  confirmed: boolean;
  subscriptionTier: SubscriptionTier;
}

export interface ForgerAccountSession {
  authenticated: boolean;
  confirmationRequired?: boolean;
  user?: ForgerAccountUser;
}

export type SubscriptionTier = 'free' | 'demo' | 'pro';

export interface ForgerAccountRegisterInput {
  firstName: string;
  lastName?: string;
  email: string;
  password: string;
  country?: string;
  age?: number;
  gender?: 'male' | 'female' | 'other';
  locale?: string;
}

export interface ForgerAccountLoginInput {
  email: string;
  password: string;
  locale?: string;
}

export interface CloudDeviceAppSummary {
  id: string;
  name: string;
  status: string;
  version?: string;
}

export interface CloudDeviceSummary {
  id: number;
  deviceUid: string;
  name: string;
  platform?: string;
  paired: boolean;
  online: boolean;
  lastSeenAt?: string;
  installedApps: CloudDeviceAppSummary[];
}

export interface CloudDevicesState {
  currentDevice?: CloudDeviceSummary;
  devices: CloudDeviceSummary[];
  connected: boolean;
  pairingCode?: string;
  pairingExpiresAt?: string;
  userMessage?: string;
  technicalCode?: string;
}

export interface AppRatingSummary {
  id: number;
  score: number;
  comment?: string | null;
  forgerResponse?: string | null;
  createdAt?: string;
  updatedAt?: string;
  user?: {
    firstName?: string;
    lastInitial?: string | null;
  };
}

export interface SubmitAppRatingInput {
  appId: string;
  score: number;
  comment?: string;
  locale?: string;
}

export interface SubmitAppFeedbackInput {
  appId: string;
  kind: 'bug' | 'idea' | 'support' | 'other';
  body: string;
  locale?: string;
}

export interface FailureDiagnosticFields {
  technicalCode?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}

export interface Settings {
  userEmail: string;
  plan: string;
  safeMode: boolean;
}

export type MemoryScope = 'global' | 'app';
export type MemoryKind = 'preference' | 'profile' | 'workflow' | 'constraint' | 'fact';
export type MemorySource = 'user' | 'agent' | 'settings' | 'automation';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  appId?: string;
  kind: MemoryKind;
  text: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryListInput {
  scope?: MemoryScope;
  appId?: string;
  kind?: MemoryKind;
}

export interface MemoryCreateInput {
  scope: MemoryScope;
  appId?: string;
  kind: MemoryKind;
  text: string;
  source?: MemorySource;
}

export interface MemoryUpdateInput {
  id: string;
  scope?: MemoryScope;
  appId?: string;
  kind?: MemoryKind;
  text?: string;
}

export type DesktopUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'unsupported'
  | 'error';

export interface DesktopUpdateReleaseNotes {
  summary?: string;
  changes: string[];
}

export interface DesktopUpdateAsset {
  platform: string;
  arch: string;
  kind: string;
  url: string;
  sha256?: string;
  size?: number;
}

export interface DesktopUpdateMetadata {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  releaseNotes: DesktopUpdateReleaseNotes;
  assets: DesktopUpdateAsset[];
}

export interface DesktopUpdateState {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  publishedAt?: string;
  releaseNotes?: DesktopUpdateReleaseNotes;
  asset?: DesktopUpdateAsset;
  downloadedPath?: string;
  progress?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  userMessage?: string;
  technicalCode?: string;
}

export interface CodexAuthStatus {
  installed: boolean;
  authenticated: boolean;
  authFilePath: string;
  codexHome: string;
  codexCliPath?: string;
}

export interface DesktopErrorReportInput {
  source: 'desktop' | 'renderer' | 'app' | 'codex' | 'automation' | 'update';
  operation?: string;
  message: string;
  technicalCode?: string;
  appId?: string;
  appVersion?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}

export interface DesktopErrorReportPreview extends DesktopErrorReportInput {
  desktopVersion?: string;
  platform?: string;
  arch?: string;
  occurredAt: string;
}

export interface AppAiSubscriptionStatus {
  connected: boolean;
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

export interface InstallAppResult extends FailureDiagnosticFields {
  success: boolean;
  phase: InstallPhase;
  userMessage: string;
}

export interface BasicActionResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
}

export type AppBackupReason = 'manual' | 'update' | 'pre_restore';
export type RemoteBackupType = 'backup' | 'sync_snapshot';
export type RemoteBackupSource = 'manual' | 'auto_sync';

export interface AppBackupFileSummary {
  sourceRelativePath: string;
  backupRelativePath: string;
  sha256: string;
  sizeBytes: number;
}

export interface AppBackupSummary {
  appId: string;
  appName: string;
  appVersion: string;
  backupId: string;
  createdAt: string;
  reason: AppBackupReason;
  fileCount: number;
  totalBytes: number;
  files: AppBackupFileSummary[];
}

export interface CreateAppBackupInput {
  appId: string;
  reason?: AppBackupReason;
}

export interface CreateAppBackupResult extends BasicActionResult {
  backup?: AppBackupSummary;
}

export interface DeleteAppBackupInput {
  appId: string;
  backupId: string;
}

export interface RestoreAppBackupInput {
  appId: string;
  backupId: string;
}

export interface RemoteAppBackupSummary {
  id: number;
  appId: string;
  appName: string;
  appVersion?: string;
  backupType: RemoteBackupType;
  source: RemoteBackupSource;
  metadata: Record<string, unknown>;
  fileCount: number;
  totalBytes: number;
  checksumSha256: string;
  createdAt: string;
  updatedAt?: string;
  downloadUrl?: string;
}

export interface RemoteBackupsUsage {
  usedBytes: number;
  limitBytes: number;
  backupCount: number;
  backupCountLimit: number;
}

export interface RemoteBackupsState {
  backups: RemoteAppBackupSummary[];
  usage: RemoteBackupsUsage;
}

export interface CreateRemoteAppBackupInput {
  appId: string;
  backupType: RemoteBackupType;
  source?: RemoteBackupSource;
}

export interface CreateRemoteAppBackupResult extends BasicActionResult {
  remoteBackup?: RemoteAppBackupSummary;
}

export interface RestoreRemoteAppBackupInput {
  remoteBackupId: number;
}

export interface CloudSyncSettings {
  appSync: Record<string, { autoSync: boolean }>;
}

export interface OpenAppResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
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

export interface StopAppResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage: string;
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
  | 'memory_list'
  | 'memory_create'
  | 'memory_update'
  | 'memory_delete'
  | 'forger_get_app_runtime_status'
  | 'forger_open_app'
  | 'forger_stop_app'
  | 'forger_restart_app'
  | 'forger_refresh_app_view'
  | 'forger_update_app';

export type AgentToolCategory = 'consulta' | 'app' | 'actualizacion' | 'vista' | 'memoria';

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

export interface AppLocalChangeSummary {
  id: string;
  title: string;
  createdAt?: string;
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
  localChanges?: AppLocalChangeSummary[];
  promptTemplates?: AppPromptTemplate[];
  agents?: AppAgent[];
  codexConversation?: { enabled: boolean };
}

export interface AppUpdateConflictInfo {
  fromVersion: string;
  targetVersion: string;
  startedAt: string;
  message?: string;
}

export interface InstallWelcomeResult extends FailureDiagnosticFields {
  success: boolean;
  appId: string;
  message?: string;
  usedCodex: boolean;
  userMessage: string;
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

export interface ChatApplyResult extends FailureDiagnosticFields {
  success: boolean;
  operationId?: string;
  commitSha?: string;
  userMessage?: string;
}

export interface ChatUndoResult extends FailureDiagnosticFields {
  success: boolean;
  revertedCommitSha?: string;
  userMessage?: string;
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
  staged?: boolean;
}

export interface FilesStageForChatInput {
  name?: string;
  mimeType: string;
  dataBase64: string;
}

export interface FilesDiscardStagedForChatInput {
  sourcePaths: string[];
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

export interface FilesActionResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage?: string;
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

export type AppCodexTaskStatus =
  | 'queued'
  | 'running'
  | 'needs_permission'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface AppCodexTaskAttachment {
  name: string;
  mimeType?: string;
  dataBase64: string;
}

export interface AppCodexTaskFileArgument {
  type: 'file';
  name: string;
  mimeType?: string;
  dataBase64: string;
}

export interface AppCodexTaskStringArgument {
  type: 'string';
  value: string;
}

export type AppCodexTaskArgumentValue =
  | string
  | number
  | boolean
  | null
  | AppCodexTaskStringArgument
  | AppCodexTaskFileArgument
  | AppCodexTaskFileArgument[];

export interface AppCodexTaskStartInput {
  templateId: string;
  locale?: string;
  arguments?: Record<string, AppCodexTaskArgumentValue>;
  variables?: Record<string, string | number | boolean | null>;
  attachments?: AppCodexTaskAttachment[];
}

export interface AppCodexTaskSummary {
  runId: string;
  appId: string;
  templateId: string;
  status: AppCodexTaskStatus;
  createdAt: string;
  updatedAt: string;
  resultText?: string;
  error?: string;
  progressLog?: string[];
}

export interface AppCodexTaskEvent {
  task: AppCodexTaskSummary;
}

export type AppCodexConversationRole = 'user' | 'assistant';

export type AppCodexConversationRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface AppCodexConversationMessage {
  messageId: string;
  role: AppCodexConversationRole;
  text: string;
  runId?: string;
  createdAt: string;
}

export interface AppCodexConversationRun {
  runId: string;
  status: AppCodexConversationRunStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progressLog?: string[];
}

export interface AppCodexConversation {
  conversationId: string;
  appId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AppCodexConversationMessage[];
  activeRun?: AppCodexConversationRun;
}

export interface AppCodexConversationCreateInput {
  title?: string;
  agentId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AppCodexConversationAttachment {
  name: string;
  mimeType?: string;
  dataBase64: string;
}

export interface AppCodexConversationSendMessageInput {
  conversationId: string;
  message: string;
  context?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  attachments?: AppCodexConversationAttachment[];
}

export interface AppCodexConversationEvent {
  type:
    | 'conversation.created'
    | 'conversation.deleted'
    | 'message.created'
    | 'run.started'
    | 'run.progress'
    | 'run.message.completed'
    | 'run.completed'
    | 'run.failed'
    | 'run.canceled';
  conversation: AppCodexConversation;
  run?: AppCodexConversationRun;
  message?: AppCodexConversationMessage;
  progress?: string;
}

export interface ForgerAppApi {
  getContext: () => Promise<{ locale?: string; agents?: AppAgent[] }>;
  getAiSubscriptionStatus: () => Promise<AppAiSubscriptionStatus>;
  selectExternalFolder: () => Promise<AppExternalFolderSelection>;
  startCodexTask: (input: AppCodexTaskStartInput) => Promise<AppCodexTaskSummary>;
  getCodexTask: (runId: string) => Promise<AppCodexTaskSummary | null>;
  cancelCodexTask: (runId: string) => Promise<{ success: boolean }>;
  onCodexTaskUpdated: (listener: (event: AppCodexTaskEvent) => void) => () => void;
  createCodexConversation: (input?: AppCodexConversationCreateInput) => Promise<AppCodexConversation>;
  sendCodexConversationMessage: (input: AppCodexConversationSendMessageInput) => Promise<AppCodexConversation>;
  getCodexConversation: (conversationId: string) => Promise<AppCodexConversation | null>;
  listCodexConversations: () => Promise<AppCodexConversation[]>;
  deleteCodexConversation: (conversationId: string) => Promise<{ success: boolean }>;
  cancelCodexConversationRun: (
    conversationId: string,
    runId: string,
  ) => Promise<{ success: boolean }>;
  onCodexConversationEvent: (listener: (event: AppCodexConversationEvent) => void) => () => void;
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
  listBackups: (appId?: string) => Promise<AppBackupSummary[]>;
  createBackup: (input: CreateAppBackupInput) => Promise<CreateAppBackupResult>;
  deleteBackup: (input: DeleteAppBackupInput) => Promise<BasicActionResult>;
  restoreBackup: (input: RestoreAppBackupInput) => Promise<BasicActionResult>;
  listRemoteBackups: (appId?: string) => Promise<RemoteBackupsState>;
  createRemoteBackup: (input: CreateRemoteAppBackupInput) => Promise<CreateRemoteAppBackupResult>;
  deleteRemoteBackup: (remoteBackupId: number) => Promise<BasicActionResult>;
  restoreRemoteBackup: (input: RestoreRemoteAppBackupInput) => Promise<BasicActionResult>;
  getCloudSyncSettings: () => Promise<CloudSyncSettings>;
  setAppAutoSync: (appId: string, autoSync: boolean) => Promise<CloudSyncSettings>;
  restoreAppUserVersion: (appId: string) => Promise<BasicActionResult>;
  resolveAppUpdateConflict: (appId: string) => Promise<{ runId: string; status: ChatRunStatus } | BasicActionResult>;
  uninstallApp: (appId: string) => Promise<BasicActionResult>;
  getAppDetails: (appId: string) => Promise<AppDetails | null>;
  installWelcome: (appId: string, userLanguage?: string) => Promise<InstallWelcomeResult>;
  openApp: (appId: string, locale?: string) => Promise<OpenAppResult>;
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
  getDesktopUpdateState: () => Promise<DesktopUpdateState>;
  checkDesktopUpdates: () => Promise<DesktopUpdateState>;
  downloadDesktopUpdate: () => Promise<DesktopUpdateState>;
  installDesktopUpdate: () => Promise<DesktopUpdateState>;
  onDesktopUpdateProgress: (listener: (event: DesktopUpdateState) => void) => () => void;
  getForgerAccount: () => Promise<ForgerAccountSession>;
  registerForgerAccount: (input: ForgerAccountRegisterInput) => Promise<ForgerAccountSession & { success: boolean; userMessage?: string; technicalCode?: string }>;
  loginForgerAccount: (input: ForgerAccountLoginInput) => Promise<ForgerAccountSession & { success: boolean; userMessage?: string; technicalCode?: string }>;
  logoutForgerAccount: () => Promise<ForgerAccountSession & { success: boolean }>;
  getCloudDevices: () => Promise<CloudDevicesState>;
  generateDevicePairingCode: () => Promise<CloudDevicesState & { success: boolean }>;
  submitAppRating: (input: SubmitAppRatingInput) => Promise<{ success: boolean; rating?: AppRatingSummary; userMessage?: string; technicalCode?: string }>;
  submitAppFeedback: (input: SubmitAppFeedbackInput) => Promise<{ success: boolean; userMessage?: string; technicalCode?: string }>;
  openExternalUrl: (url: string) => Promise<{ success: boolean; userMessage?: string } & FailureDiagnosticFields>;
  getCodexAuthStatus: () => Promise<CodexAuthStatus>;
  openCodexUsageDashboard: () => Promise<{ success: boolean; userMessage?: string } & FailureDiagnosticFields>;
  connectCodexAuth: () => Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields>;
  disconnectCodexAuth: () => Promise<{ success: boolean; userMessage: string } & FailureDiagnosticFields>;
  reinstallCodex: () => Promise<{ success: boolean; userMessage: string; status?: CodexAuthStatus } & FailureDiagnosticFields>;
  submitDesktopErrorReport: (input: DesktopErrorReportPreview) => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  onDesktopErrorReportRequested: (listener: (event: DesktopErrorReportPreview) => void) => () => void;
  listAgentTools: () => Promise<AgentToolPackageDefinition[]>;
  getAgentToolSettings: () => Promise<AgentToolSettings>;
  updateAgentToolApproval: (input: UpdateAgentToolApprovalInput) => Promise<AgentToolSettings>;
  memoryList: (input?: MemoryListInput) => Promise<MemoryEntry[]>;
  memoryCreate: (input: MemoryCreateInput) => Promise<MemoryEntry>;
  memoryUpdate: (input: MemoryUpdateInput) => Promise<MemoryEntry>;
  memoryDelete: (id: string) => Promise<{ success: boolean }>;
  chatStartRun: (input: ChatStartRunInput) => Promise<{ runId: string; status: ChatRunStatus }>;
  chatGetRun: (input: ChatGetRunInput) => Promise<ChatRun | null>;
  chatCancelRun: (input: ChatCancelRunInput) => Promise<{ success: boolean }>;
  chatApprovePermission: (input: ChatApprovePermissionInput) => Promise<{ success: boolean }>;
  chatApplyRun: (input: ChatApplyRunInput) => Promise<ChatApplyResult>;
  chatUndo: (input: ChatUndoInput) => Promise<ChatUndoResult>;
  onChatRunUpdated: (listener: (event: ChatRunEvent) => void) => () => void;
  filesPickForChat: () => Promise<PickedChatFile[]>;
  filesStageForChat: (input: FilesStageForChatInput) => Promise<PickedChatFile>;
  filesDiscardStagedForChat: (input: FilesDiscardStagedForChatInput) => Promise<FilesActionResult>;
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
