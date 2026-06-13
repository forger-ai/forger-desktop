export type LlmRunKind =
  | 'personal_agent_conversation'
  | 'app_agent_thread'
  | 'app_prompt_task';

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
  startedAt: string;
  updatedAt: string;
}

export interface LlmRunsSnapshot {
  items: LlmRunSnapshotItem[];
  activeCount: number;
  errorCount: number;
  updatedAt: string;
}
