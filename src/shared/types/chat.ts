import type { AppStatus, AppSummary, VersionChangelog } from './catalog';
import type { CatalogApp } from './catalog-app';
import type { AgentEffort, AgentPermissionMode, AgentProvider, CodexReasoningEffort } from './agent-runtime';
import type { AppAgent, AppPromptReviewItem, AppPromptTemplate } from './prompts';
import type { FailureDiagnosticFields } from './base';
import type { SocialUserApp } from './social';

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
  | 'quota_exceeded'
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

export interface ChatQuestionOption {
  id: string;
  label: string;
  description: string;
}

export interface ChatQuestion {
  id: string;
  question: string;
  options: ChatQuestionOption[];
}

export interface ChatQuestionRequest {
  requestId: string;
  chatId: string;
  questions: ChatQuestion[];
  createdAt: string;
}

export type ChatMode = 'create_app' | 'edit_app' | 'free_chat' | 'social_app_review';

export interface ChatCreatedAppRequest {
  appId: string;
  name: string;
  description: string;
  purpose: string;
  lookAndFeel?: string;
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
  permissionMode: AgentPermissionMode;
  permissionRequest?: PermissionRequest;
  preview?: PreviewModel;
  errorCode?: ChatErrorCode;
  userMessage?: string;
  progressLog?: string[];
  operationId?: string;
  commitSha?: string;
  conversationId?: string;
  questionRequest?: ChatQuestionRequest;
  createdApp?: ChatCreatedAppRequest;
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
  promptReviews?: AppPromptReviewItem[];
  codexConversation?: { enabled: boolean };
  social?: {
    app: SocialUserApp;
    shareCode?: string;
    localAppId: string;
  };
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

export type RendererChatTraceEventName =
  | 'chat_run_event_received'
  | 'chat_run_message_append_attempt'
  | 'chat_run_message_appended'
  | 'chat_new_conversation_clicked';

export interface RendererChatTraceEvent {
  event: RendererChatTraceEventName;
  timestamp?: string;
  runId?: string;
  appId?: string;
  conversationId?: string | null;
  activeConversationId?: string | null;
  status?: ChatRunStatus;
  messageCount?: number;
  foundConversation?: boolean;
}

export interface ChatStartRunInput {
  appId?: string | null;
  chatMode?: ChatMode;
  targetAppId?: string | null;
  prompt: string;
  resumePrompt?: string;
  threadId?: string | null;
  conversationHistory?: Array<{
    role: 'assistant' | 'user';
    content: string;
  }>;
  userLanguage?: string;
  sharedFiles?: SharedFileRef[];
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  effort?: AgentEffort;
  dangerMode?: boolean;
  permissionMode?: AgentPermissionMode;
  networkAccess?: boolean;
  conversationId?: string;
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
