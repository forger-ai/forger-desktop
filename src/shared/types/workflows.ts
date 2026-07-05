import type { AgentRuntime } from './agent-runtime';
import type { AgentToolId } from './tools';
import type { AutomationFrequency, AutomationMissedRunPolicy } from './automations';

export type WorkflowTrigger =
  | { type: 'manual' }
  | {
      type: 'scheduled';
      frequency: AutomationFrequency;
      missedRunPolicy?: AutomationMissedRunPolicy;
      missedRunWindowMinutes?: number;
    };

export type WorkflowEdgeCondition = 'success' | 'error' | 'always';

export interface WorkflowEdge {
  from: string;
  to: string;
  condition: WorkflowEdgeCondition;
}

export interface WorkflowNodePosition {
  x: number;
  y: number;
}

export interface WorkflowNodeBase {
  id: string;
  name: string;
  position?: WorkflowNodePosition;
  requiresApproval?: boolean;
  timeoutMs?: number;
}

export interface WorkflowLlmAgentNode extends WorkflowNodeBase {
  type: 'llm_agent';
  prompt: string;
  runtime?: AgentRuntime;
  toolIds: AgentToolId[];
  appIds: string[];
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowForgerAgentNode extends WorkflowNodeBase {
  type: 'forger_agent';
  agentId: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowConnectorNode extends WorkflowNodeBase {
  type: 'connector';
  toolId: string;
  actionId: string;
  input: Record<string, unknown>;
}

export type WorkflowConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty';

export interface WorkflowConditionExpression {
  /** Template path evaluated against run context, e.g. {{nodes.check.output.total}}. */
  left: string;
  operator: WorkflowConditionOperator;
  right?: string;
}

export interface WorkflowConditionNode extends WorkflowNodeBase {
  type: 'condition';
  expression: WorkflowConditionExpression;
}

export type WorkflowNode =
  | WorkflowLlmAgentNode
  | WorkflowForgerAgentNode
  | WorkflowConnectorNode
  | WorkflowConditionNode;

export type WorkflowNodeType = WorkflowNode['type'];

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled: boolean;
  running: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun?: WorkflowRunSummary;
}

export interface WorkflowUpsertInput {
  id?: string;
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled?: boolean;
}

export type WorkflowRunTrigger = 'manual' | 'scheduled' | 'chat' | 'step';

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'canceled';

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'waiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'canceled';

export interface WorkflowNodeRun {
  nodeId: string;
  nodeName: string;
  nodeType: WorkflowNodeType;
  status: WorkflowNodeRunStatus;
  /** Resolved input passed to the node after template interpolation. */
  input?: Record<string, unknown>;
  /** Structured output produced by the node; consumed by downstream nodes. */
  output?: Record<string, unknown>;
  summary?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface WorkflowRunSummary {
  id: string;
  workflowId: string;
  trigger: WorkflowRunTrigger;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Node id waiting for user approval when status is waiting_approval. */
  pendingApprovalNodeId?: string;
  nodeRuns: WorkflowNodeRun[];
}

export interface WorkflowRun extends WorkflowRunSummary {
  transcript: string;
}

export interface WorkflowApproveNodeInput {
  runId: string;
  nodeId: string;
  approved: boolean;
}

export interface WorkflowUpdatedEvent {
  workflow: Workflow;
  run?: WorkflowRunSummary;
}
