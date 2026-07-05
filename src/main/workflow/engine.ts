import type {
  Workflow,
  WorkflowConditionExpression,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeRunStatus,
} from '../../shared/types';

export interface WorkflowNodeState {
  status: WorkflowNodeRunStatus;
  output?: Record<string, unknown>;
  summary?: string;
  error?: string;
}

export interface WorkflowRunContext {
  trigger: Record<string, unknown>;
  nodes: Record<string, WorkflowNodeState>;
}

const TERMINAL_STATUSES: ReadonlySet<WorkflowNodeRunStatus> = new Set([
  'succeeded',
  'failed',
  'skipped',
  'canceled',
]);

export const isTerminalNodeStatus = (status: WorkflowNodeRunStatus): boolean =>
  TERMINAL_STATUSES.has(status);

export const MAX_WORKFLOW_NODES = 30;

export const validateWorkflowGraph = (nodes: WorkflowNode[], edges: WorkflowEdge[]): void => {
  if (nodes.length === 0) {
    throw new Error('workflow_nodes_required');
  }
  if (nodes.length > MAX_WORKFLOW_NODES) {
    throw new Error('workflow_too_many_nodes');
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (!node.id.trim()) {
      throw new Error('workflow_node_id_required');
    }
    if (ids.has(node.id)) {
      throw new Error('workflow_node_id_duplicated');
    }
    ids.add(node.id);
  }
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error('workflow_edge_unknown_node');
    }
    if (edge.from === edge.to) {
      throw new Error('workflow_edge_self_reference');
    }
  }
  topologicalOrder(nodes, edges);
};

export const topologicalOrder = (nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] => {
  const incoming = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    order.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) {
        queue.push(next);
      }
    }
  }
  if (order.length !== nodes.length) {
    throw new Error('workflow_graph_has_cycle');
  }
  return order;
};

const isConditionNode = (node: WorkflowNode | undefined): boolean => node?.type === 'condition';

/**
 * Whether an edge fires given the terminal state of its source node.
 * For condition nodes, `success` is the truthy branch and `error` the falsy branch.
 */
export const edgeTaken = (
  edge: WorkflowEdge,
  sourceNode: WorkflowNode | undefined,
  sourceState: WorkflowNodeState | undefined,
): boolean => {
  if (!sourceState || !isTerminalNodeStatus(sourceState.status)) {
    return false;
  }
  if (sourceState.status === 'skipped' || sourceState.status === 'canceled') {
    return false;
  }
  if (edge.condition === 'always') {
    return true;
  }
  if (isConditionNode(sourceNode) && sourceState.status === 'succeeded') {
    const result = sourceState.output?.result === true;
    return edge.condition === 'success' ? result : !result;
  }
  return edge.condition === 'success'
    ? sourceState.status === 'succeeded'
    : sourceState.status === 'failed';
};

export interface WorkflowReadiness {
  ready: string[];
  skipped: string[];
}

/**
 * Computes which pending nodes can start now and which will never start
 * because none of their incoming edges fired.
 */
export const resolveNodeReadiness = (
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  states: Record<string, WorkflowNodeState>,
): WorkflowReadiness => {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const ready: string[] = [];
  const skipped: string[] = [];
  for (const node of nodes) {
    if (states[node.id]?.status !== 'pending') {
      continue;
    }
    const incoming = edges.filter((edge) => edge.to === node.id);
    if (incoming.length === 0) {
      ready.push(node.id);
      continue;
    }
    const allSourcesFinished = incoming.every((edge) => {
      const sourceState = states[edge.from];
      return sourceState ? isTerminalNodeStatus(sourceState.status) : false;
    });
    if (!allSourcesFinished) {
      continue;
    }
    const anyTaken = incoming.some((edge) => edgeTaken(edge, nodesById.get(edge.from), states[edge.from]));
    if (anyTaken) {
      ready.push(node.id);
    } else {
      skipped.push(node.id);
    }
  }
  return { ready, skipped };
};

/**
 * A failed node counts as handled when at least one outgoing error/always
 * edge routes the failure to another node.
 */
export const isFailureHandled = (nodeId: string, edges: WorkflowEdge[]): boolean =>
  edges.some((edge) => edge.from === nodeId && (edge.condition === 'error' || edge.condition === 'always'));

export const computeRunOutcome = (
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  states: Record<string, WorkflowNodeState>,
): { status: 'succeeded' | 'failed' | 'canceled'; error?: string } => {
  const canceled = nodes.find((node) => states[node.id]?.status === 'canceled');
  if (canceled) {
    return { status: 'canceled' };
  }
  const unhandledFailure = nodes.find(
    (node) => states[node.id]?.status === 'failed' && !isFailureHandled(node.id, edges),
  );
  if (unhandledFailure) {
    return {
      status: 'failed',
      error: states[unhandledFailure.id]?.error ?? `workflow_node_failed:${unhandledFailure.id}`,
    };
  }
  return { status: 'succeeded' };
};

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export const lookupContextPath = (context: WorkflowRunContext, rawPath: string): unknown => {
  const segments = rawPath.split('.').map((segment) => segment.trim()).filter(Boolean);
  let current: unknown = context;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
};

const stringifyTemplateValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

/**
 * Interpolates {{path}} placeholders. A string that is exactly one
 * placeholder resolves to the raw context value, preserving its type.
 */
export const resolveTemplateValue = (value: unknown, context: WorkflowRunContext): unknown => {
  if (typeof value === 'string') {
    const exactMatch = /^\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}$/.exec(value);
    if (exactMatch) {
      return lookupContextPath(context, exactMatch[1] as string);
    }
    return value.replace(TEMPLATE_PATTERN, (_match, path: string) =>
      stringifyTemplateValue(lookupContextPath(context, path)));
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveTemplateValue(item, context),
      ]),
    );
  }
  return value;
};

export const renderTemplateString = (text: string, context: WorkflowRunContext): string =>
  text.replace(TEMPLATE_PATTERN, (_match, path: string) =>
    stringifyTemplateValue(lookupContextPath(context, path)));

const toComparableNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const isEmptyValue = (value: unknown): boolean => {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
};

export const evaluateConditionExpression = (
  expression: WorkflowConditionExpression,
  context: WorkflowRunContext,
): boolean => {
  const left = resolveTemplateValue(expression.left, context);
  const right = expression.right !== undefined ? resolveTemplateValue(expression.right, context) : undefined;

  switch (expression.operator) {
    case 'is_empty':
      return isEmptyValue(left);
    case 'is_not_empty':
      return !isEmptyValue(left);
    case 'equals':
      return stringifyTemplateValue(left) === stringifyTemplateValue(right);
    case 'not_equals':
      return stringifyTemplateValue(left) !== stringifyTemplateValue(right);
    case 'contains':
      return stringifyTemplateValue(left).toLowerCase().includes(stringifyTemplateValue(right).toLowerCase());
    case 'not_contains':
      return !stringifyTemplateValue(left).toLowerCase().includes(stringifyTemplateValue(right).toLowerCase());
    case 'greater_than': {
      const leftNumber = toComparableNumber(left);
      const rightNumber = toComparableNumber(right);
      return leftNumber !== null && rightNumber !== null && leftNumber > rightNumber;
    }
    case 'less_than': {
      const leftNumber = toComparableNumber(left);
      const rightNumber = toComparableNumber(right);
      return leftNumber !== null && rightNumber !== null && leftNumber < rightNumber;
    }
    default:
      return false;
  }
};

export const buildRunContext = (
  trigger: Record<string, unknown>,
  states: Record<string, WorkflowNodeState>,
): WorkflowRunContext => ({ trigger, nodes: states });

export const summarizeWorkflow = (workflow: Workflow): string =>
  `${workflow.name} (${workflow.nodes.length} nodos, ${workflow.edges.length} conexiones)`;
