import type { AgentEffort, AgentProvider, CodexReasoningEffort } from './agent-runtime';
import type { PermissionRequest } from './chat';

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
  permissionRequest?: PermissionRequest;
}

export interface AppCodexTaskEvent {
  task: AppCodexTaskSummary;
}

export type AppCodexConversationRole = 'user' | 'assistant';

export type AppCodexConversationRunStatus =
  | 'queued'
  | 'running'
  | 'needs_permission'
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
  permissionRequest?: PermissionRequest;
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
  locale?: string;
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
  workspacePath?: string;
  provider?: AgentProvider;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  effort?: AgentEffort;
  locale?: string;
  attachments?: AppCodexConversationAttachment[];
}

export interface AppCodexConversationEvent {
  type:
    | 'conversation.created'
    | 'conversation.deleted'
    | 'message.created'
    | 'run.started'
    | 'run.needs_permission'
    | 'run.progress'
    | 'run.steering.accepted'
    | 'run.message.completed'
    | 'run.completed'
    | 'run.failed'
    | 'run.canceled';
  conversation: AppCodexConversation;
  run?: AppCodexConversationRun;
  message?: AppCodexConversationMessage;
  progress?: string;
}

export type AppAgentRunEventType =
  | 'thread.created'
  | 'run.started'
  | 'run.progress'
  | 'run.message'
  | 'run.needs_permission'
  | 'run.steering.accepted'
  | 'run.completed'
  | 'run.failed'
  | 'run.canceled';

export interface AppAgentRuntimeInput {
  provider?: string;
  model?: string;
  effort?: AgentEffort | 'default';
  modelParams?: Record<string, unknown>;
}

export interface AppAgentThreadCreateInput {
  title?: string;
  manifestAgentId?: string;
  initialPrompt: string;
  runtime?: AppAgentRuntimeInput;
  workspacePath?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type AppAgentPromptVariables = Record<string, unknown>;

export interface AppManifestAgentStartInput {
  agentId: string;
  title?: string;
  variables?: AppAgentPromptVariables;
  runtime?: AppAgentRuntimeInput;
  workspacePath?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AppManifestAgentResumeInput {
  threadId: string;
  variables?: AppAgentPromptVariables;
  runtime?: AppAgentRuntimeInput;
  workspacePath?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AppManifestAgentSteerInput {
  threadId: string;
  runId: string;
  variables?: AppAgentPromptVariables;
  runtime?: AppAgentRuntimeInput;
  workspacePath?: string;
}

export interface AppManifestAgentStopInput {
  threadId: string;
  runId?: string;
}

export interface AppAgentThreadRunStartInput {
  desktopThreadId: string;
  message: string;
  context?: string;
  runtime?: AppAgentRuntimeInput;
  workspacePath?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface AppAgentThreadRunControlInput {
  desktopThreadId: string;
  desktopRunId: string;
}

export interface AppAgentThreadRunSteerInput extends AppAgentThreadRunControlInput {
  message: string;
  context?: string;
  runtime?: AppAgentRuntimeInput;
  workspacePath?: string;
}

export interface AppAgentThreadSummary {
  desktop_thread_id: string;
  manifest_agent_id?: string;
  title: string;
  status: string;
  active_run?: AppAgentRunSummary;
  messages?: Array<{
    id: string;
    role: string;
    content: string;
    created_at: string;
  }>;
  progressLog?: string[];
}

export interface AppAgentRunSummary {
  desktop_thread_id: string;
  desktop_run_id: string;
  status: string;
  error?: string;
  resultText?: string;
  progressLog?: string[];
}

export interface AppAgentThreadEvent {
  type: AppAgentRunEventType;
  desktop_thread_id: string;
  desktop_run_id?: string;
  thread?: AppAgentThreadSummary;
  run?: AppAgentRunSummary;
  message?: string;
  progress?: string;
}

export interface AppAgentThreadSteerResult {
  accepted: boolean;
  mode: 'live' | 'queued_for_next_run' | 'requires_cancel_resume';
}
