import type {
  AgentToolId,
  AutomationFrequency,
  WorkflowConditionExpression,
  WorkflowConditionOperator,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowNode,
  WorkflowNodePosition,
  WorkflowTrigger,
  WorkflowUpsertInput,
} from '../../shared/types';
import { normalizeAgentRuntime } from '../../shared/types';

const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 20_000;
const MIN_NODE_TIMEOUT_MS = 10_000;
const MAX_NODE_TIMEOUT_MS = 30 * 60_000;

const CONDITION_OPERATORS: ReadonlySet<WorkflowConditionOperator> = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'greater_than',
  'less_than',
  'is_empty',
  'is_not_empty',
]);

export const sanitizeText = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const sanitizeNodeId = (value: unknown): string => {
  const id = sanitizeText(value, 64);
  return NODE_ID_PATTERN.test(id) ? id : '';
};

const sanitizeAppIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => NODE_ID_PATTERN.test(item))));
};

const sanitizeToolIds = (value: unknown, validToolIds?: ReadonlySet<string>): AgentToolId[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && (!validToolIds || validToolIds.has(item))))) as AgentToolId[];
};

const sanitizePosition = (value: unknown): WorkflowNodePosition | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const x = typeof record.x === 'number' && Number.isFinite(record.x) ? record.x : null;
  const y = typeof record.y === 'number' && Number.isFinite(record.y) ? record.y : null;
  return x !== null && y !== null ? { x, y } : undefined;
};

const sanitizeTimeoutMs = (value: unknown): number | undefined => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.min(MAX_NODE_TIMEOUT_MS, Math.max(MIN_NODE_TIMEOUT_MS, Math.round(numeric)));
};

const sanitizeOutputSchema = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const sanitizeConditionExpression = (value: unknown): WorkflowConditionExpression => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const operator = CONDITION_OPERATORS.has(record.operator as WorkflowConditionOperator)
    ? record.operator as WorkflowConditionOperator
    : 'is_not_empty';
  const right = sanitizeText(record.right, 2_000);
  return {
    left: sanitizeText(record.left, 2_000),
    operator,
    ...(right && operator !== 'is_empty' && operator !== 'is_not_empty' ? { right } : {}),
  };
};

export const sanitizeWorkflowNode = (
  value: unknown,
  validToolIds?: ReadonlySet<string>,
): WorkflowNode | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = sanitizeNodeId(record.id);
  const name = sanitizeText(record.name, MAX_NAME_LENGTH);
  if (!id || !name) {
    return null;
  }
  const base = {
    id,
    name,
    ...(sanitizePosition(record.position) ? { position: sanitizePosition(record.position) as WorkflowNodePosition } : {}),
    ...(record.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(sanitizeTimeoutMs(record.timeoutMs) ? { timeoutMs: sanitizeTimeoutMs(record.timeoutMs) as number } : {}),
  };

  if (record.type === 'llm_agent') {
    const prompt = sanitizeText(record.prompt, MAX_PROMPT_LENGTH);
    if (!prompt) {
      return null;
    }
    const runtime = normalizeAgentRuntime(record.runtime);
    const outputSchema = sanitizeOutputSchema(record.outputSchema);
    return {
      ...base,
      type: 'llm_agent',
      prompt,
      ...(runtime ? { runtime } : {}),
      toolIds: sanitizeToolIds(record.toolIds, validToolIds),
      appIds: sanitizeAppIds(record.appIds),
      ...(outputSchema ? { outputSchema } : {}),
    };
  }

  if (record.type === 'forger_agent') {
    const agentId = sanitizeText(record.agentId, 128);
    const prompt = sanitizeText(record.prompt, MAX_PROMPT_LENGTH);
    if (!agentId || !prompt) {
      return null;
    }
    const outputSchema = sanitizeOutputSchema(record.outputSchema);
    return {
      ...base,
      type: 'forger_agent',
      agentId,
      prompt,
      ...(outputSchema ? { outputSchema } : {}),
    };
  }

  if (record.type === 'connector') {
    const toolId = sanitizeText(record.toolId, 128);
    const actionId = sanitizeText(record.actionId, 128);
    if (!toolId || !actionId) {
      return null;
    }
    const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input)
      ? record.input as Record<string, unknown>
      : {};
    return { ...base, type: 'connector', toolId, actionId, input };
  }

  if (record.type === 'condition') {
    return { ...base, type: 'condition', expression: sanitizeConditionExpression(record.expression) };
  }

  return null;
};

export const sanitizeWorkflowEdges = (value: unknown, nodeIds: ReadonlySet<string>): WorkflowEdge[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const edges: WorkflowEdge[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const from = sanitizeNodeId(record.from);
    const to = sanitizeNodeId(record.to);
    const condition: WorkflowEdgeCondition = record.condition === 'error' || record.condition === 'always'
      ? record.condition
      : 'success';
    if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) {
      continue;
    }
    const key = `${from}->${to}:${condition}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edges.push({ from, to, condition });
  }
  return edges;
};

export const sanitizeWorkflowFrequency = (value: unknown): AutomationFrequency => {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AutomationFrequency>
    : {};
  if (input.type === 'daily') {
    return { type: 'daily', timeOfDay: formatTimeOfDay(input.timeOfDay) };
  }
  if (input.type === 'weekly') {
    return {
      type: 'weekly',
      timeOfDay: formatTimeOfDay(input.timeOfDay),
      weeklyDay: normalizeWeeklyDay(input.weeklyDay),
    };
  }
  return { type: 'hourly' };
};

const formatTimeOfDay = (value: string | undefined): string => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  if (!match) {
    return '09:00';
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

const normalizeWeeklyDay = (value: unknown): number => {
  const day = typeof value === 'number' && Number.isInteger(value) ? value : 1;
  return Math.min(6, Math.max(0, day));
};

export const sanitizeWorkflowTrigger = (value: unknown): WorkflowTrigger => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  if (record.type !== 'scheduled') {
    return { type: 'manual' };
  }
  const missedRunPolicy = record.missedRunPolicy === 'skip' || record.missedRunPolicy === 'always' || record.missedRunPolicy === 'within_window'
    ? record.missedRunPolicy
    : undefined;
  const windowMinutes = typeof record.missedRunWindowMinutes === 'number' && Number.isFinite(record.missedRunWindowMinutes) && record.missedRunWindowMinutes > 0
    ? Math.min(30 * 24 * 60, Math.max(1, Math.round(record.missedRunWindowMinutes)))
    : undefined;
  return {
    type: 'scheduled',
    frequency: sanitizeWorkflowFrequency(record.frequency),
    ...(missedRunPolicy ? { missedRunPolicy } : {}),
    ...(windowMinutes ? { missedRunWindowMinutes: windowMinutes } : {}),
  };
};

export const sanitizeWorkflowUpsertInput = (
  input: WorkflowUpsertInput,
  validToolIds?: ReadonlySet<string>,
): Omit<WorkflowUpsertInput, 'id'> => {
  const nodes = Array.isArray(input.nodes)
    ? input.nodes
        .map((node) => sanitizeWorkflowNode(node, validToolIds))
        .filter((node): node is WorkflowNode => node !== null)
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const description = sanitizeText(input.description, 500);
  return {
    name: sanitizeText(input.name, MAX_NAME_LENGTH),
    ...(description ? { description } : {}),
    trigger: sanitizeWorkflowTrigger(input.trigger),
    nodes,
    edges: sanitizeWorkflowEdges(input.edges, nodeIds),
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  };
};
