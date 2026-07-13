import type { AgentPermissionMode, AgentRuntime } from './agent-runtime';
import type { AutomationFrequency, AutomationMissedRunPolicy } from './automations';
import type { FailureDiagnosticFields } from './base';
import type { AgentToolId, OfficialToolSummary } from './tools';
import type { AppSummary } from './catalog';
import type { ConnectionActionDefinition, ConnectionInstance, ConnectionTypeDefinition } from './connections';
import type { SharedFileRef } from './chat';
import type { AgentRunActivity } from './agent-run-activity';

export type PersonalAgentMessageRole = 'user' | 'assistant' | 'system';
export type PersonalAgentMessageKind = 'message' | 'intermediate' | 'spoken';
export type PersonalAgentMessageAuthorType = 'human' | 'agent' | 'system';
export type PersonalAgentMessageSource = 'human' | 'routine' | 'scheduled_wakeup' | 'sidekick';
export type PersonalAgentConversationOrigin = 'user' | 'agent' | 'routine' | 'sidekick';
export type PersonalAgentConversationStatus = 'active' | 'archived';
export type PersonalAgentRunStatus = 'queued' | 'running' | 'needs_permission' | 'completed' | 'failed' | 'canceled';
export type PersonalAgentRoutineRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type PersonalAgentRoutineRunTrigger = 'manual' | 'scheduled';
export type PersonalAgentWakeupStatus = 'scheduled' | 'fired' | 'canceled';

export interface PersonalAgent {
  id: string;
  name: string;
  description: string;
  purpose: string;
  instructions: string;
  permissionMode: AgentPermissionMode;
  networkAccess: boolean;
  canSpawnAgents: boolean;
  createdByAgentId?: string;
  groupId?: string;
  runtime?: AgentRuntime;
  appIds: string[];
  toolIds: AgentToolId[];
  connectionGrants: PersonalAgentConnectionGrant[];
  peerAgentGrants: PersonalAgentPeerGrant[];
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentConnectionGrant {
  type: string;
  actions: string[];
  multiple: boolean;
  connectionIds?: string[];
}

export interface PersonalAgentPeerGrant {
  agentId: string;
  name?: string;
  description?: string;
  criteria: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersonalAgentCreateInput {
  name: string;
  description?: string;
  purpose?: string;
  instructions?: string;
  permissionMode?: AgentPermissionMode;
  networkAccess?: boolean;
  canSpawnAgents?: boolean;
  groupId?: string | null;
  runtime?: AgentRuntime;
  appIds?: string[];
  toolIds?: AgentToolId[];
  connectionGrants?: PersonalAgentConnectionGrant[];
  peerAgentGrants?: PersonalAgentPeerGrant[];
}

export interface PersonalAgentDeleteInput {
  agentId: string;
}

export interface PersonalAgentUpdatePermissionsInput {
  agentId: string;
  permissionMode?: AgentPermissionMode;
  networkAccess?: boolean;
  canSpawnAgents?: boolean;
  groupId?: string | null;
  runtime?: AgentRuntime;
  appIds?: string[];
  toolIds?: AgentToolId[];
  connectionGrants?: PersonalAgentConnectionGrant[];
  peerAgentGrants?: PersonalAgentPeerGrant[];
}

export interface PersonalAgentGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentGroupCreateInput {
  name: string;
}

export interface PersonalAgentGroupUpdateInput {
  groupId: string;
  name: string;
}

export interface PersonalAgentGroupDeleteInput {
  groupId: string;
}

export interface PersonalAgentUpdateGroupInput {
  agentId: string;
  groupId: string | null;
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

export interface PersonalAgentGrantOptionPeerAgent {
  agentId: string;
  name: string;
  description?: string;
}

export interface PersonalAgentGrantOptions {
  apps: PersonalAgentGrantOptionApp[];
  tools: PersonalAgentGrantOptionTool[];
  connections: PersonalAgentGrantOptionConnection[];
  peerAgents: PersonalAgentGrantOptionPeerAgent[];
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
  origin: PersonalAgentConversationOrigin;
  readOnly: boolean;
  sidekickId?: string;
  initiatorAgentId?: string;
  initiatorAgentName?: string;
  peerThreadId?: string;
  routineId?: string;
  draftMessage?: string;
  scheduledWakeup?: PersonalAgentScheduledWakeup;
  createdAt: string;
  updatedAt: string;
  providerThreadId?: string | null;
  provider?: AgentRuntime['provider'] | null;
  messages: PersonalAgentMessage[];
  activeRun?: PersonalAgentRun;
  peerThreads?: PersonalAgentPeerThread[];
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
  authorType: PersonalAgentMessageAuthorType;
  authorAgentId?: string;
  authorAgentName?: string;
  source: PersonalAgentMessageSource;
  /** BCP-47 locale attached by trusted non-renderer voice input. */
  locale?: string;
  routineId?: string;
  wakeupId?: string;
  content: string;
  /** Sanitized visible activity captured while the run produced this message. */
  reasoning?: string;
  createdAt: string;
  files?: PersonalAgentMessageFile[];
}

export interface PersonalAgentMessageFile {
  id: string;
  messageId: string;
  agentId: string;
  conversationId: string;
  name: string;
  path: string;
  relativePath: string;
  sizeBytes?: number;
  source?: SharedFileRef['source'];
  createdAt: string;
}

export interface PersonalAgentMessageSendInput {
  conversationId: string;
  content: string;
  sharedFiles?: SharedFileRef[];
}

export interface PersonalAgentPeerThread {
  id: string;
  callerAgentId: string;
  callerAgentName?: string;
  targetAgentId: string;
  targetAgentName?: string;
  sourceConversationId: string;
  targetConversationId: string;
  parentThreadId?: string | null;
  rootThreadId?: string | null;
  createdByRunId?: string | null;
  title: string;
  status: 'active' | 'failed' | 'completed';
  createdAt: string;
  updatedAt: string;
  messages?: PersonalAgentMessage[];
  children?: PersonalAgentPeerThread[];
}

export interface PersonalAgentPeerThreadsListInput {
  agentId: string;
  conversationId?: string;
}

export interface PersonalAgentPeerThreadGetInput {
  threadId: string;
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
  activity?: AgentRunActivity;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentRoutineRunSummary {
  id: string;
  routineId: string;
  agentId: string;
  conversationId: string;
  trigger: PersonalAgentRoutineRunTrigger;
  status: PersonalAgentRoutineRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  messageId?: string;
}

export type PersonalAgentRoutineRun = PersonalAgentRoutineRunSummary;

export interface PersonalAgentRoutine {
  id: string;
  agentId: string;
  conversationId: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  missedRunPolicy: AutomationMissedRunPolicy;
  missedRunWindowMinutes?: number;
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  authorizationText: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: PersonalAgentRoutineRunSummary;
}

export interface PersonalAgentRoutineUpsertInput {
  id?: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  missedRunPolicy?: AutomationMissedRunPolicy;
  missedRunWindowMinutes?: number;
  enabled?: boolean;
  authorizationText: string;
}

export interface PersonalAgentRoutineListInput {
  agentId: string;
}

export interface PersonalAgentRoutineRunNowInput {
  routineId: string;
}

export interface PersonalAgentRoutineSetEnabledInput {
  routineId: string;
  enabled: boolean;
  authorizationText: string;
}

export interface PersonalAgentRoutineDeleteInput {
  routineId: string;
  authorizationText: string;
}

export interface PersonalAgentScheduledWakeup {
  id: string;
  agentId: string;
  conversationId: string;
  prompt: string;
  dueAt: string;
  status: PersonalAgentWakeupStatus;
  createdByRunId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonalAgentWakeupScheduleInput {
  seconds: number;
  prompt: string;
}

export interface PersonalAgentWakeupCancelInput {
  wakeupId?: string;
  conversationId?: string;
}

export interface PersonalAgentConversationDraftUpdateInput {
  conversationId: string;
  draftMessage: string;
}

export type PersonalAgentConversationEventType =
  | 'conversation.created'
  | 'message.created'
  | 'conversation.updated'
  | 'run.started'
  | 'run.progress'
  | 'run.completed'
  | 'run.failed'
  | 'run.canceled'
  | 'wakeup.scheduled'
  | 'wakeup.canceled'
  | 'routine.updated';

export interface PersonalAgentConversationEvent {
  type: PersonalAgentConversationEventType;
  conversation: PersonalAgentConversation;
  message?: PersonalAgentMessage;
  run?: PersonalAgentRun;
  progress?: PersonalAgentRunProgress;
  routine?: PersonalAgentRoutine;
  wakeup?: PersonalAgentScheduledWakeup;
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
