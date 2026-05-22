import type { ForgerAppApi } from './types/app-api';

export type { AgentDefaults, AgentEffort, AgentModelOptions, AgentProvider, AgentRuntime, AgentRuntimeRecommendations, AgentRuntimeRequest, ClaudeEffort, ClaudeModelOption, CodexModelOption, CodexReasoningEffort } from './types/agent-runtime';
export {
  AGENT_MODEL_OPTIONS,
  AGENT_PROVIDER_OPTIONS,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  getAgentModelOptions,
  getDefaultAgentDefaults,
  getClaudeModelOption,
  getCodexModelOption,
  getDefaultClaudeEffort,
  getDefaultCodexReasoningEffort,
  isAgentProvider,
  isAgentProviderPreference,
  isClaudeEffort,
  isClaudeModel,
  isCodexModel,
  isCodexReasoningEffort,
  normalizeAgentProviderPreference,
  normalizeAgentRuntime,
  normalizeClaudeEffort,
  normalizeClaudeModel,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  resolveAgentRuntime,
  runtimeFromDefaults,
  agentRuntimeEquals,
} from './agent-runtime-registry';
export type { ForgerAccountLoginInput, ForgerAccountProfileInput, ForgerAccountRegisterInput, ForgerAccountSession, ForgerAccountUser, SubscriptionTier, CloudDeviceAppSummary, CloudDeviceSummary, CloudDevicesState } from './types/account';
export type { AppAgentPromptSet, AppAgentPromptTemplate, AppAgentPromptVariable, AppAgentPromptVariableType, AppAgent, AppPromptMutationResult, AppPromptRestoreInput, AppPromptReviewInput, AppPromptReviewItem, AppPromptReviewKind, AppPromptSettingSource, AppPromptTemplate, AppPromptTemplateArgument, AppPromptTemplateArgumentType, AppPromptValidationResult } from './types/prompts';
export type { AppCapability, AppCategory, AppStatus, AppSummary, CatalogPublicationStatus, VersionChangelog } from './types/catalog';
export type { CatalogApp } from './types/catalog-app';
export type { AppRatingSummary, SubmitAppRatingInput, SubmitProductFeedbackInput } from './types/feedback';
export type { SubmitUsageEventInput, SubmitUsageEventResult, UsageEventName } from './types/usage-events';
export type { CloudAppMessagePermissionDecision, CloudFriendUser, CloudFriendship, CloudIdentityState, CloudMessage, CloudMessageDeliveryMode, CloudMessageEnvelope, CloudMessageSource, CloudMessageStatus, CloudSendMessageInput, CloudSocialEvent, FriendshipStatus, FriendChatWindowOpenResult } from './types/social';
export type { BasicActionResult, FailureDiagnosticFields } from './types/base';
export type { MemoryCreateInput, MemoryEntry, MemoryKind, MemoryListInput, MemoryScope, MemorySource, MemoryUpdateInput, Settings, UpdateAgentDefaultsInput, UpdateCodexDefaultsInput } from './types/settings';
export type { DesktopUpdateAsset, DesktopUpdateMetadata, DesktopUpdateReleaseNotes, DesktopUpdateState, DesktopUpdateStatus } from './types/updates';
export type { ClaudeAuthStatus, CodexAuthStatus, DesktopErrorReportInput, DesktopErrorReportPreview } from './types/auth';
export type { AppAiSubscriptionStatus, InstallAppResult, InstallPhase, LocalNetworkShareResult, LocalNetworkShareStatus, MockActionResult, OpenAppResult, RemoteNetworkConnectionSummary, RemoteNetworkShareResult, RemoteNetworkShareState, RemoteNetworkShareStatus, RuntimeStatus, StopAppResult } from './types/runtime';
export type { AppBackupFileSummary, AppBackupReason, AppBackupSummary, CloudSyncSettings, CreateAppBackupInput, CreateAppBackupResult, CreateRemoteAppBackupInput, CreateRemoteAppBackupResult, DeleteAppBackupInput, RemoteAppBackupSummary, RemoteBackupSource, RemoteBackupType, RemoteBackupsState, RemoteBackupsUsage, RestoreAppBackupInput, RestoreRemoteAppBackupInput } from './types/backups';
export type { AppSecretConnection, AppSecretDeclaration, AppSecretsState, ConnectAppSecretInput, CreateUserSecretInput, DeleteUserSecretInput, DisconnectAppSecretInput, SecretMutationResult, UpdateUserSecretInput, UserSecretSummary } from './types/secrets';
export type { AgentToolApprovalSettings, AgentToolCategory, AgentToolDefinition, AgentToolId, AgentToolPackageDefinition, AgentToolRisk, AgentToolSettings, AppToolDeclaration, AppToolRequirementState, AppToolsInstallGate, CallOfficialToolInput, CallOfficialToolResult, ConfigureOfficialToolInput, InstalledOfficialToolRecord, OfficialToolActionDefinition, OfficialToolDefinition, OfficialToolInstallState, OfficialToolRisk, OfficialToolRuntime, OfficialToolsState, OfficialToolSecretDefinition, OfficialToolSummary, SetAppToolGrantInput, ToolMutationResult, UpdateAgentToolApprovalInput } from './types/tools';
export type { AppDetails, AppLocalChangeSummary, AppOperationSummary, AppUpdateConflictInfo, ChatApplyResult, ChatApplyRunInput, ChatApprovePermissionInput, ChatCancelRunInput, ChatErrorCode, ChatGetRunInput, ChatRun, ChatRunEvent, ChatRunStatus, ChatStartRunInput, ChatUndoInput, ChatUndoResult, InstallWelcomeResult, PermissionRequest, PreviewDiffFile, PreviewModel, RendererChatTraceEvent, RendererChatTraceEventName, SharedFileRef } from './types/chat';
export type { AppExternalFolderCanceled, AppExternalFolderGrant, AppExternalFolderSelection, DbListTablesError, DbListTablesResponse, DbListTablesResult, DbQueryTableError, DbQueryTableResponse, DbQueryTableResult, FilesActionResult, FilesCreateCategoryInput, FilesDeleteCategoryInput, FilesDeleteInput, FilesDiscardStagedForChatInput, FilesImportInput, FilesListInput, FilesMoveInput, FilesRenameCategoryInput, FilesRenameInput, FilesStageForChatInput, ForgerFileCategory, ForgerFileRecord, PickedChatFile } from './types/data';
export type { AppAgentPromptVariables, AppAgentRunEventType, AppAgentRunSummary, AppAgentRuntimeInput, AppAgentThreadCreateInput, AppAgentThreadEvent, AppAgentThreadRunControlInput, AppAgentThreadRunStartInput, AppAgentThreadRunSteerInput, AppAgentThreadSteerResult, AppAgentThreadSummary, AppCodexConversation, AppCodexConversationAttachment, AppCodexConversationCreateInput, AppCodexConversationEvent, AppCodexConversationMessage, AppCodexConversationRole, AppCodexConversationRun, AppCodexConversationRunStatus, AppCodexConversationSendMessageInput, AppCodexTaskArgumentValue, AppCodexTaskAttachment, AppCodexTaskEvent, AppCodexTaskFileArgument, AppCodexTaskStartInput, AppCodexTaskStatus, AppCodexTaskStringArgument, AppCodexTaskSummary, AppManifestAgentResumeInput, AppManifestAgentStartInput, AppManifestAgentSteerInput, AppManifestAgentStopInput } from './types/app-agents';
export type { ForgerAppApi } from './types/app-api';
export type { Automation, AutomationFrequency, AutomationFrequencyType, AutomationRun, AutomationRunStatus, AutomationRunSummary, AutomationRunTrigger, AutomationUpsertInput, WindowControlState } from './types/automations';
export type { ForgerDeepLink, ForgerDesktopApi } from './types/desktop-api';

declare global {
  interface Window {
    forgerApp?: ForgerAppApi;
  }
}
