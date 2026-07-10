import type { ForgerAppApi } from './types/app-api';

export type { AgentDefaults, AgentEffort, AgentModelOptions, AgentPermissionMode, AgentProvider, AgentProviderRuntimeRegistry, AgentRuntime, AgentRuntimeRecommendations, AgentRuntimeRequest, AntigravityEffort, AntigravityModelOption, ClaudeEffort, ClaudeModelOption, CodexModelOption, CodexReasoningEffort, CreateAgentProviderRuntimeRegistryInput, LlmProviderKey } from './types/agent-runtime';
export type { AgentRunActivity, AgentRunActivityCounts, AgentRunActivityItem, AgentRunActivityItemKind, AgentRunActivitySourceRef, AgentRunActivityStatus, AgentRunActivitySurface } from './types/agent-run-activity';
export {
  AGENT_MODEL_OPTIONS,
  AGENT_PROVIDER_OPTIONS,
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_EFFORT_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_AGENT_PERMISSION_MODE,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_ANTIGRAVITY_EFFORT,
  DEFAULT_ANTIGRAVITY_MODEL,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_AGENT_PROVIDER_RUNTIME_REGISTRY,
  createAgentProviderRuntimeRegistry,
  getAgentModelOptions,
  getAntigravityModelOption,
  getDefaultAgentDefaults,
  getClaudeModelOption,
  getCodexModelOption,
  getDefaultClaudeEffort,
  getDefaultAntigravityEffort,
  getDefaultCodexReasoningEffort,
  getClaudeSupportedEfforts,
  getCodexSupportedReasoningEfforts,
  getRuntimeSupportedEfforts,
  isAntigravityEffort,
  isAntigravityModel,
  isAgentProvider,
  isAgentPermissionMode,
  isAgentProviderPreference,
  isClaudeEffort,
  isClaudeModel,
  isCodexModel,
  isCodexReasoningEffort,
  getAntigravitySupportedEfforts,
  normalizeAgentProviderPreference,
  normalizeAgentProviderEffort,
  normalizeAgentProviderModel,
  normalizeAgentPermissionMode,
  normalizeAgentRuntime,
  normalizeRuntimeEffortForModel,
  normalizeAntigravityEffort,
  normalizeAntigravityModel,
  normalizeAntigravityModelAndEffort,
  normalizeClaudeEffort,
  normalizeClaudeModel,
  normalizeCodexModel,
  normalizeCodexReasoningEffort,
  resolveAntigravityCliModel,
  resolveAgentRuntime,
  runtimeFromDefaults,
  agentRuntimeEquals,
} from './agent-runtime-registry';
export type { PlatformAgentRuntimeControlCapability, PlatformAudioInputCapability, PlatformCapabilities, PlatformSpeechToTextCapability, PlatformTextToSpeechCapability, PlatformWorkspaceFoldersCapability } from './platform-capabilities';
export { appAllowsAgentRuntimeControl, appAllowsAudioInput, appAllowsSpeechToText, appAllowsTextToSpeech, appAllowsWorkspaceFolders, normalizePlatformCapabilities } from './platform-capabilities';
export type { ForgerAccountLoginInput, ForgerAccountProfileInput, ForgerAccountRegisterInput, ForgerAccountSession, ForgerAccountUser, SubscriptionTier, CloudDeviceAppSummary, CloudDeviceSummary, CloudDevicesState, MobileDesktopAuthorizationSummary, MobilePairingRequestSummary } from './types/account';
export type { CloudStorageBreakdown, CloudStorageUsage } from './types/cloud-storage';
export type { AppAgentPromptSet, AppAgentPromptTemplate, AppAgentPromptVariable, AppAgentPromptVariableType, AppAgent, AppPromptMutationResult, AppPromptRestoreInput, AppPromptReviewInput, AppPromptReviewItem, AppPromptReviewKind, AppPromptSettingSource, AppPromptTemplate, AppPromptTemplateArgument, AppPromptTemplateArgumentType, AppPromptTestInput, AppPromptTestResult, AppPromptValidationResult } from './types/prompts';
export type { AppCapability, AppCategory, AppConnectMode, AppExecutionMode, AppExecutionPhase, AppLastErrorOperation, AppStatus, AppSummary, CatalogPublicationStatus, VersionChangelog } from './types/catalog';
export { deriveAppExecutionState, withAppExecutionState } from './app-execution-state';
export type { AppExecutionState } from './app-execution-state';
export type { CatalogApp } from './types/catalog-app';
export type { AppRatingSummary, SubmitAppRatingInput, SubmitProductFeedbackInput } from './types/feedback';
export type { SubmitUsageEventInput, SubmitUsageEventResult, UsageEventName } from './types/usage-events';
export type {
  ConversationDiagnosticFileSummary,
  ConversationDiagnosticMessage,
  ConversationDiagnosticReportPreview,
  ConversationDiagnosticSource,
  PrepareConversationDiagnosticReportInput,
  SubmitConversationDiagnosticReportResult,
} from './types/diagnostics';
export type { CloudAppMessagePermissionDecision, CloudAppShareKind, CloudAppShareMessage, CloudAppShareMessageDetail, CloudFriendUser, CloudFriendship, CloudIdentityState, CloudMessage, CloudMessageDelivery, CloudMessageDeliveryMode, CloudMessageEnvelope, CloudMessageLocalState, CloudMessageSource, CloudMessageStatus, CloudMessageType, CloudSendAppShareInput, CloudSendMessageInput, CloudSocialEvent, CloudTextMessage, ForumComment, ForumContentStatus, ForumParticipationState, ForumParticipationStatus, ForumPost, ForumUserProfile, FriendshipStatus, FriendChatWindowOpenResult, PrepareSocialAppReviewInput, SocialAppQuarantineRecord, SocialAppQuarantineStatus, SocialUserApp, SocialUserAppAccessReason, SocialUserAppDownload, SocialUserAppList, SocialUserAppShare, SocialUserAppUpdateInput, SocialUserAppUploadAttempt, SocialUserAppUploadAttemptStatus, SocialUserAppUploadInput, SocialUserAppVersion, SocialUserProfile, SocialUserProfileDetail, SocialUserAppReviewState, SocialUserAppStatus, SocialUserAppVisibility } from './types/social';
export type { BasicActionResult, FailureDiagnosticFields } from './types/base';
export type { DeveloperModeSettings, DeveloperPathState, MemoryCreateInput, MemoryEntry, MemoryEvidence, MemoryKind, MemoryListInput, MemoryRevision, MemoryScope, MemorySource, MemoryStatus, MemoryUpdateInput, MemoryUsageEvent, Settings, UpdateAgentDefaultsInput, UpdateAppDeveloperSettingsInput, UpdateCodexDefaultsInput, UpdateDeveloperModeInput } from './types/settings';
export type { SpeechToTextConfig, SpeechToTextConfigInput, SpeechToTextDependencyIssue, SpeechToTextJob, SpeechToTextJobStatus, SpeechToTextModelOption, SpeechToTextModelWorker, SpeechToTextModelWorkerStatus, SpeechToTextProcessedFile, SpeechToTextProcessInput, SpeechToTextProcessResult, SpeechToTextRealtimeSession, SpeechToTextReportableError, SpeechToTextServiceStatus, SpeechToTextState, SpeechToTextTask, SpeechToTextUploadInput } from './types/speech-to-text';
export type { SidekickBatteryStatus, SidekickConfigureInput, SidekickDisplayInput, SidekickMicrophonePlaybackInput, SidekickMicrophonePlaybackResult, SidekickMicrophoneRecordingInput, SidekickMicrophoneRecordingState, SidekickMicrophoneRecordingStatus, SidekickMicrophoneRecordingSummary, SidekickMutationResult, SidekickState, SidekickStatus, SidekickSummary, SidekickUsbDevice } from './types/sidekicks';
export type { TextToSpeechAudioFormat, TextToSpeechConfig, TextToSpeechConfigInput, TextToSpeechJob, TextToSpeechJobStatus, TextToSpeechModelOption, TextToSpeechReportableError, TextToSpeechServiceStatus, TextToSpeechState, TextToSpeechSynthesizeInput, TextToSpeechSynthesizeResult, TextToSpeechVoice } from './types/text-to-speech';
export type { WakeWordConfig, WakeWordConfigInput, WakeWordDetectionEvent, WakeWordDiagnosticEvent, WakeWordModel, WakeWordRuntime, WakeWordRuntimeState, WakeWordServiceStatus, WakeWordSession, WakeWordState } from './types/wake-word';
export type { LiveVoiceInputConfig, LiveVoiceInputConfigInput, LiveVoiceInputConsumer, LiveVoiceInputConsumerKind, LiveVoiceInputDevice, LiveVoiceInputDeviceListInput, LiveVoiceInputDeviceSession, LiveVoiceInputMutationResult, LiveVoiceInputServiceStatus, LiveVoiceInputSession, LiveVoiceInputSessionInput, LiveVoiceInputSourceKind, LiveVoiceInputState, LiveVoiceInputStopInput, LiveVoiceInputTargetType, LiveVoiceInputTranscriptEvent, LiveVoiceInputTranscriptTask, LiveVoiceInputWakeEvent, LiveVoiceInputWakeModel, LiveVoiceInputWakeRuntime, LiveVoiceInputWakeRuntimeState, LiveVoiceInputWakeTarget } from './types/live-voice-input';
export type { AudioPlaybackStatus, AudioPlaybackSummary, AudioRuntimeBrokerRequest, AudioRuntimeBrokerResponse, AudioRuntimeDevices, AudioRuntimeInputDevice, AudioRuntimeInputDeviceKind, AudioRuntimeOutputDevice, AudioRuntimeOutputDeviceKind } from './types/audio-runtime';
export type { DesktopUpdateAsset, DesktopUpdateMetadata, DesktopUpdateReleaseNotes, DesktopUpdateReleaseSummary, DesktopUpdateState, DesktopUpdateStatus } from './types/updates';
export type { AntigravityAuthSessionEvent, AntigravityAuthSessionEventType, AntigravityAuthSessionStartResult, AntigravityAuthStatus, ClaudeAuthStatus, CodexAuthStatus, CodexRateLimitBucket, CodexRateLimitsStatus, CodexRateLimitWindow, DesktopErrorReportFileSummary, DesktopErrorReportInput, DesktopErrorReportPreview } from './types/auth';
export type { AgentProviderUsageEntry, AgentProviderUsageResult, AgentProviderUsageSource, AgentProviderUsageWindow, AgentProviderUsageWindowKind } from './types/provider-usage';
export type { LlmProviderAuthMode, LlmProviderInstallSource, LlmProviderProfileMetadata, LlmProviderProfileMutationResult, LlmProviderProfileStatus, LlmProviderProfileSummary, LlmProviderProfilesState, LlmProviderRuntimeAuthMode, SetActiveLlmProviderProfileInput, SetActiveLlmProviderProfileResult, UpdateLlmProviderProfileDefaultsInput } from './types/provider-profiles';
export type { AppAiSubscriptionStatus, CreateLocalAppInput, CreateLocalAppResult, InstallAppResult, InstallPhase, LocalNetworkShareResult, LocalNetworkShareStatus, MockActionResult, OpenAppResult, RemoteNetworkConnectionSummary, RemoteNetworkShareResult, RemoteNetworkShareState, RemoteNetworkShareStatus, RuntimeStatus, StopAppResult } from './types/runtime';
export type { RemoteActivityItem, RemoteActivityKind, RemoteActivityRequester, RemoteActivitySnapshot, RemoteActivityState, RemoteActivityTransport } from './types/remote-activity';
export type { AppBackupFileSummary, AppBackupReason, AppBackupSummary, CloudSyncSettings, CreateAppBackupInput, CreateAppBackupResult, CreateRemoteAppBackupInput, CreateRemoteAppBackupResult, DeleteAppBackupBatchEntry, DeleteAppBackupBatchFailure, DeleteAppBackupBatchInput, DeleteAppBackupBatchResult, DeleteAppBackupInput, RemoteAppBackupSummary, RemoteBackupSource, RemoteBackupType, RemoteBackupsState, RemoteBackupsUsage, RestoreAppBackupInput, RestoreRemoteAppBackupInput } from './types/backups';
export type { AppSecretConnection, AppSecretDeclaration, AppSecretsState, ConnectAppSecretInput, CreateUserSecretInput, DeleteUserSecretInput, DisconnectAppSecretInput, SecretMutationResult, UpdateUserSecretInput, UserSecretSummary } from './types/secrets';
export type { AgentToolApprovalId, AgentToolApprovalSettings, AgentToolCategory, AgentToolDefinition, AgentToolId, AgentToolPackageDefinition, AgentToolRisk, AgentToolSettings, AppToolDeclaration, AppToolGrantRequestPreview, AppToolGrantRequestResult, AppToolRequirementState, AppToolsInstallGate, CallOfficialToolInput, CallOfficialToolResult, ConfigureOfficialToolInput, ConnectionActionId, GetAppToolsInstallGateOptions, InstalledOfficialToolRecord, OfficialToolActionDefinition, OfficialToolDefinition, OfficialToolInstallState, OfficialToolRisk, OfficialToolRuntime, OfficialToolRuntimeEvent, OfficialToolRuntimePhase, OfficialToolsState, OfficialToolSecretDefinition, OfficialToolSummary, SetAppToolGrantInput, ToolMutationResult, UpdateAgentToolApprovalInput } from './types/tools';
export type { AppConnectionDeclaration, CallConnectionActionInput, CallConnectionActionResult, ConfigureConnectionInput, ConnectionActionDefinition, ConnectionActionRisk, ConnectionInstance, ConnectionMutationResult, ConnectionOAuthDefinition, ConnectionRequirementState, ConnectionsState, ConnectionSecretDefinition, ConnectionSessionGrant, ConnectionSetupKind, ConnectionStatus, ConnectionStatusInput, ConnectionStatusResult, ConnectionTypeDefinition, DisconnectConnectionInput, PersistedConnectionGrant, SafeConnectionIdentity } from './types/connections';
export type { ConnectionSetupGuide, ConnectionSetupGuideCopyKind, ConnectionSetupGuideCopyValue, ConnectionSetupGuideLink } from './types/connection-setup-guide';
export type { AppDetails, AppLocalChangeSummary, AppOperationSummary, AppUpdateConflictInfo, ChatApplyResult, ChatApplyRunInput, ChatApprovePermissionInput, ChatCancelRunInput, ChatCreatedAppRequest, ChatErrorCode, ChatGetRunInput, ChatMode, ChatQuestion, ChatQuestionOption, ChatQuestionRequest, ChatRun, ChatRunEvent, ChatRunStatus, ChatStartRunInput, ChatUndoInput, ChatUndoResult, InstallWelcomeResult, PermissionRequest, PreviewDiffFile, PreviewModel, RendererChatTraceEvent, RendererChatTraceEventName, SharedFileRef } from './types/chat';
export type { AppExternalFolderCanceled, AppExternalFolderGrant, AppExternalFolderSelection, DbListTablesError, DbListTablesResponse, DbListTablesResult, DbQueryTableError, DbQueryTableResponse, DbQueryTableResult, FilesActionResult, FilesCreateCategoryInput, FilesDeleteCategoryInput, FilesDeleteInput, FilesDiscardStagedForChatInput, FilesImportInput, FilesListInput, FilesMoveInput, FilesRenameCategoryInput, FilesRenameInput, FilesStageForChatInput, ForgerFileCategory, ForgerFileRecord, PickedChatFile } from './types/data';
export type { AppAgentPromptVariables, AppAgentRunEventType, AppAgentRunSummary, AppAgentRuntimeInput, AppAgentThreadCreateInput, AppAgentThreadEvent, AppAgentThreadRunControlInput, AppAgentThreadRunStartInput, AppAgentThreadRunSteerInput, AppAgentThreadSteerResult, AppAgentThreadSummary, AppAgentWorkspaceInput, AppCodexConversation, AppCodexConversationAttachment, AppCodexConversationCreateInput, AppCodexConversationEvent, AppCodexConversationMessage, AppCodexConversationRole, AppCodexConversationRun, AppCodexConversationRunStatus, AppCodexConversationSendMessageInput, AppCodexTaskArgumentValue, AppCodexTaskAttachment, AppCodexTaskEvent, AppCodexTaskFileArgument, AppCodexTaskStartInput, AppCodexTaskStatus, AppCodexTaskStringArgument, AppCodexTaskSummary, AppManifestAgentResumeInput, AppManifestAgentStartInput, AppManifestAgentSteerInput, AppManifestAgentStopInput } from './types/app-agents';
export type { ForgerAppApi } from './types/app-api';
export type { Automation, AutomationFrequency, AutomationFrequencyType, AutomationMissedRunPolicy, AutomationRun, AutomationRunStatus, AutomationRunSummary, AutomationRunTrigger, AutomationUpsertInput, WindowControlState } from './types/automations';
export { DEFAULT_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from './types/automations';
export type { Workflow, WorkflowApproveNodeInput, WorkflowConditionExpression, WorkflowConditionNode, WorkflowConditionOperator, WorkflowConnectionNode, WorkflowConnectorNode, WorkflowEdge, WorkflowEdgeCondition, WorkflowForgerAgentNode, WorkflowForgerToolNode, WorkflowLlmAgentNode, WorkflowNode, WorkflowNodePosition, WorkflowNodeRun, WorkflowNodeRunStatus, WorkflowNodeType, WorkflowRun, WorkflowRunStatus, WorkflowRunSummary, WorkflowRunTrigger, WorkflowTrigger, WorkflowUpdatedEvent, WorkflowUpsertInput } from './types/workflows';
export type { BackgroundTask, BackgroundTaskAppRef, BackgroundTaskEvent, BackgroundTaskRelatedEntity, BackgroundTaskResult, BackgroundTaskSource, BackgroundTaskStatus, BackgroundTaskStatusUpdate, BackgroundTaskUpsertInput } from './types/background-tasks';
export type { LlmRunKind, LlmRunSnapshotItem, LlmRunStatus, LlmRunsSnapshot } from './types/llm-runs';
export type { PersonalAgent, PersonalAgentConnectionGrant, PersonalAgentConversation, PersonalAgentConversationDraftUpdateInput, PersonalAgentConversationEvent, PersonalAgentConversationEventType, PersonalAgentConversationGetInput, PersonalAgentConversationOrigin, PersonalAgentConversationsListInput, PersonalAgentConversationStartInput, PersonalAgentConversationStatus, PersonalAgentCreateInput, PersonalAgentDeleteInput, PersonalAgentGrantOptionApp, PersonalAgentGrantOptionConnection, PersonalAgentGrantOptionPeerAgent, PersonalAgentGrantOptionTool, PersonalAgentGrantOptionToolAction, PersonalAgentGrantOptions, PersonalAgentHeartbeatSummary, PersonalAgentJournalEntry, PersonalAgentMemory, PersonalAgentMessage, PersonalAgentMessageAuthorType, PersonalAgentMessageFile, PersonalAgentMessageKind, PersonalAgentMessageRole, PersonalAgentMessageSendInput, PersonalAgentMessageSource, PersonalAgentPeerGrant, PersonalAgentPeerThread, PersonalAgentPeerThreadGetInput, PersonalAgentPeerThreadsListInput, PersonalAgentPermission, PersonalAgentRoutine, PersonalAgentRoutineDeleteInput, PersonalAgentRoutineListInput, PersonalAgentRoutineRun, PersonalAgentRoutineRunNowInput, PersonalAgentRoutineRunStatus, PersonalAgentRoutineRunSummary, PersonalAgentRoutineRunTrigger, PersonalAgentRoutineSetEnabledInput, PersonalAgentRoutineUpsertInput, PersonalAgentRun, PersonalAgentRunProgress, PersonalAgentRunStatus, PersonalAgentScheduledWakeup, PersonalAgentUpdatePermissionsInput, PersonalAgentWakeupCancelInput, PersonalAgentWakeupScheduleInput, PersonalAgentWakeupStatus, PersonalAgentWorkspaceEntry, PersonalAgentWorkspaceFile, PersonalAgentWorkspaceFileReadInput, PersonalAgentWorkspaceFileWriteInput, PersonalAgentWorkspaceListInput, RemoteAgentSessionResult, RemoteAgentSessionState, RemoteAgentSessionStatus } from './types/personal-agents';
export type { ForgerDeepLink, ForgerDesktopApi, RenameInstalledAppInput, RenameInstalledAppResult } from './types/desktop-api';

declare global {
  interface Window {
    forgerApp?: ForgerAppApi;
  }
}
