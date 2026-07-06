import type { AgentPermissionMode, AgentRuntime } from './agent-runtime';
import type { FailureDiagnosticFields } from './base';
import type { AgentToolId, OfficialToolSummary } from './tools';
import type { AppSummary } from './catalog';
import type { ConnectionActionDefinition, ConnectionInstance, ConnectionTypeDefinition } from './connections';

export type PersonalAgentMessageRole = 'user' | 'assistant' | 'system';
export type PersonalAgentMessageKind = 'message' | 'intermediate';
export type PersonalAgentConversationStatus = 'active' | 'archived';
export type PersonalAgentRunStatus = 'queued' | 'running' | 'needs_permission' | 'completed' | 'failed' | 'canceled';

export interface PersonalAgent {
  id: string;
  name: string;
  description: string;
  purpose: string;
  instructions: string;
  permissionMode: AgentPermissionMode;
  networkAccess: boolean;
  runtime?: AgentRuntime;
  appIds: string[];
  toolIds: AgentToolId[];
  connectionGrants: PersonalAgentConnectionGrant[];
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentConnectionGrant {
  type: string;
  actions: string[];
  multiple: boolean;
  connectionIds?: string[];
}

export interface PersonalAgentCreateInput {
  name: string;
  description?: string;
  purpose?: string;
  instructions?: string;
  permissionMode?: AgentPermissionMode;
  networkAccess?: boolean;
  runtime?: AgentRuntime;
  appIds?: string[];
  toolIds?: AgentToolId[];
  connectionGrants?: PersonalAgentConnectionGrant[];
}

export interface PersonalAgentDeleteInput {
  agentId: string;
}

export interface PersonalAgentUpdatePermissionsInput {
  agentId: string;
  permissionMode?: AgentPermissionMode;
  networkAccess?: boolean;
  runtime?: AgentRuntime;
  appIds?: string[];
  toolIds?: AgentToolId[];
  connectionGrants?: PersonalAgentConnectionGrant[];
}

export interface PersonalAgentGrantOptionApp {
  appId: string;
  name: string;
  description?: string;
  status?: AppSummary['status'];
}

export interface PersonalAgentGrantOptionToolAction {
  id: AgentToolId;
  toolId: string;
  name: string;
  description: string;
  risk: string;
}

export interface PersonalAgentGrantOptionTool {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  status: OfficialToolSummary['status'];
  actions: PersonalAgentGrantOptionToolAction[];
}

export interface PersonalAgentGrantOptionConnection {
  type: string;
  displayName: string;
  description: string;
  configured: boolean;
  supportsMultiple: boolean;
  definition: ConnectionTypeDefinition;
  instances: ConnectionInstance[];
  actions: ConnectionActionDefinition[];
}

export interface PersonalAgentGrantOptions {
  apps: PersonalAgentGrantOptionApp[];
  tools: PersonalAgentGrantOptionTool[];
  connections: PersonalAgentGrantOptionConnection[];
}

export interface PersonalAgentPermission {
  id: string;
  agentId: string;
  kind: 'legacy' | 'app' | 'tool' | 'connection';
  targetId: string;
  permission: string;
  mode: AgentPermissionMode;
  granted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentConversation {
  id: string;
  agentId: string;
  title: string;
  status: PersonalAgentConversationStatus;
  createdAt: string;
  updatedAt: string;
  providerThreadId?: string | null;
  provider?: AgentRuntime['provider'] | null;
  messages: PersonalAgentMessage[];
  activeRun?: PersonalAgentRun;
}

export interface PersonalAgentConversationsListInput {
  agentId: string;
}

export interface PersonalAgentConversationStartInput {
  agentId: string;
  title?: string;
  initialMessage?: string;
}

export interface PersonalAgentConversationGetInput {
  conversationId: string;
}

export interface PersonalAgentMessage {
  id: string;
  agentId: string;
  conversationId: string;
  runId?: string;
  role: PersonalAgentMessageRole;
  kind: PersonalAgentMessageKind;
  content: string;
  createdAt: string;
}

export interface PersonalAgentMessageSendInput {
  conversationId: string;
  content: string;
}

export interface PersonalAgentRunProgress {
  id: string;
  agentId: string;
  conversationId: string;
  runId: string;
  message: string;
  createdAt: string;
}

export interface PersonalAgentRun {
  id: string;
  agentId: string;
  conversationId: string;
  status: PersonalAgentRunStatus;
  progress: PersonalAgentRunProgress[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type PersonalAgentConversationEventType =
  | 'conversation.created'
  | 'message.created'
  | 'run.started'
  | 'run.progress'
  | 'run.completed'
  | 'run.failed'
  | 'run.canceled';

export interface PersonalAgentConversationEvent {
  type: PersonalAgentConversationEventType;
  conversation: PersonalAgentConversation;
  message?: PersonalAgentMessage;
  run?: PersonalAgentRun;
  progress?: PersonalAgentRunProgress;
}

export interface PersonalAgentMemory {
  id: string;
  agentId: string;
  rememberWhen: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentJournalEntry {
  id: string;
  agentId: string;
  conversationId?: string;
  body: string;
  createdAt: string;
}

export interface PersonalAgentHeartbeatSummary {
  supported: boolean;
  count: number;
  ids: string[];
  agents: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  activeSessionRequestIds?: string[];
}

export interface PersonalAgentWorkspaceEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  children?: PersonalAgentWorkspaceEntry[];
}

export interface PersonalAgentWorkspaceListInput {
  agentId: string;
}

export interface PersonalAgentWorkspaceFileReadInput {
  agentId: string;
  relativePath: string;
}

export interface PersonalAgentWorkspaceFile {
  agentId: string;
  relativePath: string;
  content: string;
  updatedAt: string;
}

export interface PersonalAgentWorkspaceFileWriteInput {
  agentId: string;
  relativePath: string;
  content: string;
}

export type RemoteAgentSessionState = 'inactive' | 'preparing' | 'ready' | 'error' | 'closed';

export interface RemoteAgentSessionStatus {
  active: boolean;
  agentId: string;
  state: RemoteAgentSessionState;
  sessionId?: string;
  localUrl?: string;
  tunnelUrl?: string;
  authorizationToken?: string;
  allowedPaths?: string[];
  technicalCode?: string;
}

export interface RemoteAgentSessionResult extends FailureDiagnosticFields {
  success: boolean;
  userMessage?: string;
  status: RemoteAgentSessionStatus;
}
