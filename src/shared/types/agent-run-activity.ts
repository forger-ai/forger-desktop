export type AgentRunActivitySurface =
  | 'desktop_chat'
  | 'personal_agent_conversation'
  | 'app_agent_thread'
  | 'app_prompt_task'
  | 'workflow_node';

export type AgentRunActivityStatus =
  | 'queued'
  | 'running'
  | 'needs_permission'
  | 'completed'
  | 'failed'
  | 'canceled';

export type AgentRunActivityItemKind =
  | 'status'
  | 'assistant_note'
  | 'mcp_call'
  | 'file_read'
  | 'file_write'
  | 'command'
  | 'connected_service'
  | 'permission'
  | 'error';

export type AgentRunActivityItemStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface AgentRunActivitySourceRef {
  appId?: string;
  appName?: string;
  conversationId?: string;
  threadId?: string;
  taskId?: string;
  workflowId?: string;
  workflowName?: string;
  nodeId?: string;
  nodeName?: string;
  agentId?: string;
  agentName?: string;
  title?: string;
}

export interface AgentRunActivityItem {
  id: string;
  kind: AgentRunActivityItemKind;
  summary: string;
  status?: AgentRunActivityItemStatus;
  technicalLabel?: string;
  technicalDetails?: string;
  createdAt: string;
}

export interface AgentRunActivityCounts {
  total: number;
  mcpCalls: number;
  fileReads: number;
  fileWrites: number;
  commands: number;
  connectedServices: number;
  permissions: number;
  notes: number;
  errors: number;
}

export interface AgentRunActivity {
  runId: string;
  surface: AgentRunActivitySurface;
  status: AgentRunActivityStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary: string;
  items: AgentRunActivityItem[];
  counts: AgentRunActivityCounts;
  redactions: string[];
  sourceRef?: AgentRunActivitySourceRef;
}
