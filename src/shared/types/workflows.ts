import type { AgentRuntime } from './agent-runtime';
import type { AgentToolId } from './tools';
import type { AutomationFrequency, AutomationMissedRunPolicy } from './automations';
import type { ConnectionSessionGrant } from './connections';

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
  /**
   * Reference to a list from a previous node (e.g. nodes.gmail.output.messages).
   * When set, the node runs once per item and templates can use
   * {{item.<field>}} and {{itemIndex}}. The node output becomes
   * { items: [...results], count }. Requires at least one incoming edge.
   */
  forEach?: string;
}

export interface WorkflowLlmAgentNode extends WorkflowNodeBase {
  type: 'llm_agent';
  prompt: string;
  runtime?: AgentRuntime;
  toolIds: AgentToolId[];
  appIds: string[];
  connectionGrants: ConnectionSessionGrant[];
  outputSchema?: Record<string, unknown>;
}

export interface WorkflowForgerAgentNode extends WorkflowNodeBase {
  type: 'forger_agent';
  agentId: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
}

export type WorkflowAppActionEffect = 'read' | 'write' | 'external' | 'destructive' | 'unknown';
export type WorkflowAppActionRisk = 'low' | 'medium' | 'high';

/** Immutable contract captured when an app action is added to a workflow. */
export interface WorkflowAppAction {
  title: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  effect: WorkflowAppActionEffect;
  risk: WorkflowAppActionRisk;
  idempotent: boolean;
  contractHash: string;
}

/** Live action definition returned by an installed app during preflight. */
export interface WorkflowAppActionDefinition extends WorkflowAppAction {
  toolName: string;
}

export interface WorkflowAppActionNode extends WorkflowNodeBase {
  type: 'app_action';
  appId: string;
  toolName: string;
  input: Record<string, unknown>;
  action: WorkflowAppAction;
}

export type WorkflowAppActionContractSnapshot = WorkflowAppAction;

export interface WorkflowAppActionCallInput {
  appId: string;
  toolName: string;
  input: Record<string, unknown>;
  expectedContractHash: string;
  timeoutMs: number;
  runId: string;
  nodeId: string;
  signal: AbortSignal;
}

export interface WorkflowConnectorNode extends WorkflowNodeBase {
  type: 'connector';
  toolId: string;
  actionId: string;
  input: Record<string, unknown>;
}

export interface WorkflowForgerToolNode extends WorkflowNodeBase {
  type: 'forger_tool';
  toolId: AgentToolId;
  input: Record<string, unknown>;
}

export interface WorkflowConnectionNode extends WorkflowNodeBase {
  type: 'connection';
  connectionType: string;
  actionId: string;
  connectionId?: string;
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
  | WorkflowAppActionNode
  | WorkflowLlmAgentNode
  | WorkflowForgerAgentNode
  | WorkflowForgerToolNode
  | WorkflowConnectionNode
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
  /** Monotonic identity of the current editable draft. */
  revision: number;
  /** Stable identity of the current editable draft snapshot. */
  revisionId: string;
  /** Last revision explicitly applied after a successful review. */
  appliedRevision?: number;
  /** Stable identity of the immutable applied snapshot. */
  appliedRevisionId?: string;
  /** Trigger belonging to the applied snapshot, independent from later draft edits. */
  appliedTrigger?: WorkflowTrigger;
  /** Readiness report for this exact draft. Saving another draft clears it. */
  review?: WorkflowReviewReport;
}

export interface WorkflowUpsertInput {
  id?: string;
  name: string;
  description?: string;
  trigger: WorkflowTrigger;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled?: boolean;
  /** Rejects a save based on a stale editor snapshot. */
  expectedRevision?: number;
}

export type WorkflowReviewStatus = 'ready' | 'blocked';

/** Static, zero-effect readiness report for one exact workflow definition. */
export interface WorkflowReviewReport {
  status: WorkflowReviewStatus;
  issues: string[];
  definitionHash: string;
}

export interface WorkflowApplyInput {
  definitionHash: string;
  expectedRevision: number;
}

export interface WorkflowRestoreRevisionInput {
  revisionId: string;
  expectedRevision: number;
}

/** Immutable definition snapshot kept in workflow history. */
export interface WorkflowRevision {
  id: string;
  workflowId: string;
  revision: number;
  definitionHash: string;
  createdAt: string;
  applied: boolean;
  appliedAt?: string;
  workflow: Workflow;
}

/** Revision metadata safe to expose to the renderer; definitions stay in main storage. */
export type WorkflowRevisionSummary = Omit<WorkflowRevision, 'workflow'>;

export type WorkflowRunTrigger = 'manual' | 'scheduled' | 'chat' | 'step';

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'completed_with_issues'
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
  /** Immutable workflow definition executed by this run. */
  workflowRevision: number;
  workflowRevisionId: string;
  definitionHash: string;
  /** Original failed run when this is a safe retry. */
  retryOfRunId?: string;
  /** True only when the run failed during preflight, before effects began. */
  safeToRetry?: boolean;
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
