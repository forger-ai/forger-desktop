import type { AgentRunActivity } from './agent-run-activity';

export type LlmRunKind =
  | 'desktop_chat'
  | 'personal_agent_conversation'
  | 'app_agent_thread'
  | 'app_prompt_task'
  | 'workflow_node';

export type LlmRunStatus =
  | 'queued'
  | 'running'
  | 'needs_permission'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface LlmRunSnapshotItem {
  id: string;
  kind: LlmRunKind;
  sourceId: string;
  appId?: string;
  appName: string;
  title: string;
  status: LlmRunStatus;
  progress?: string;
  error?: string;
  activity?: AgentRunActivity;
  startedAt: string;
  updatedAt: string;
}

export interface LlmRunsSnapshot {
  items: LlmRunSnapshotItem[];
  activeCount: number;
  errorCount: number;
  updatedAt: string;
}
