import type {
  AgentToolId,
  AutomationFrequency,
  ConnectionSessionGrant,
  WorkflowConditionExpression,
  WorkflowConditionOperator,
  WorkflowEdge,
  WorkflowEdgeCondition,
  WorkflowNode,
  WorkflowNodePosition,
  WorkflowTrigger,
  WorkflowUpsertInput,
} from '../../shared/types';
import type { WorkflowAppActionEffect, WorkflowAppActionRisk } from '../../shared/types/workflows';
import { normalizeAgentRuntime } from '../../shared/types';
import { connectionTypeForActionId, isBuiltInConnectionType } from '../../shared/connection-catalog';
import { validateWorkflowStructuredValueLimits } from './output-schema';
import {
  assertAuthenticWorkflowAppAction,
  workflowAppActionContractValue,
} from './revisions';

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

const APP_ACTION_EFFECTS: ReadonlySet<WorkflowAppActionEffect> = new Set([
  'read',
  'write',
  'external',
  'destructive',
  'unknown',
]);

const APP_ACTION_RISKS: ReadonlySet<WorkflowAppActionRisk> = new Set([
  'low',
  'medium',
  'high',
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

const connectionTypeForAction = (actionId: string): string => {
  return connectionTypeForActionId(actionId);
};

const sanitizeConnectionGrants = (value: unknown): ConnectionSessionGrant[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const grants: ConnectionSessionGrant[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const type = sanitizeText(record.type, 80);
    const actions = Array.isArray(record.actions)
      ? [...new Set(record.actions.map((action) => sanitizeText(action, 160)).filter(Boolean))]
      : [];
    const connectionIds = Array.isArray(record.connectionIds)
      ? [...new Set(record.connectionIds.map((id) => sanitizeText(id, 160)).filter(Boolean))]
      : [];
    if (!type || actions.length === 0) {
      continue;
    }
    grants.push({
      type,
      actions,
      multiple: record.multiple === true,
      ...(connectionIds.length ? { connectionIds } : {}),
    });
  }
  return grants;
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
  const forEach = sanitizeText(record.forEach, 500).replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const base = {
    id,
    name,
    ...(sanitizePosition(record.position) ? { position: sanitizePosition(record.position) as WorkflowNodePosition } : {}),
    ...(record.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(sanitizeTimeoutMs(record.timeoutMs) ? { timeoutMs: sanitizeTimeoutMs(record.timeoutMs) as number } : {}),
    ...(forEach ? { forEach } : {}),
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
      connectionGrants: sanitizeConnectionGrants(record.connectionGrants),
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

  if (record.type === 'app_action') {
    const appId = sanitizeNodeId(record.appId);
    const toolName = sanitizeText(record.toolName, 160);
    const actionRecord = record.action && typeof record.action === 'object' && !Array.isArray(record.action)
      ? record.action as Record<string, unknown>
      : null;
    const title = sanitizeText(actionRecord?.title, MAX_NAME_LENGTH);
    const description = sanitizeText(actionRecord?.description, 500);
    const inputSchema = sanitizeOutputSchema(actionRecord?.inputSchema);
    const outputSchema = sanitizeOutputSchema(actionRecord?.outputSchema);
    const effect = actionRecord?.effect as WorkflowAppActionEffect;
    const risk = actionRecord?.risk as WorkflowAppActionRisk;
    const contractHash = sanitizeText(actionRecord?.contractHash, 256);
    if (
      !appId
      || !toolName
      || !title
      || !inputSchema
      || !outputSchema
      || !APP_ACTION_EFFECTS.has(effect)
      || !APP_ACTION_RISKS.has(risk)
      || typeof actionRecord?.idempotent !== 'boolean'
      || !contractHash
    ) {
      return null;
    }
    const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input)
      ? record.input as Record<string, unknown>
      : {};
    const action = {
      title,
      ...(description ? { description } : {}),
      inputSchema,
      outputSchema,
      effect,
      risk,
      idempotent: actionRecord.idempotent,
      contractHash,
    };
    assertAuthenticWorkflowAppAction(toolName, action);
    if (
      validateWorkflowStructuredValueLimits(input).length > 0
      || validateWorkflowStructuredValueLimits(workflowAppActionContractValue(toolName, action)).length > 0
    ) {
      throw new Error('workflow_app_action_contract_limits_exceeded');
    }
    return {
      ...base,
      type: 'app_action',
      appId,
      toolName,
      input,
      action,
      ...(record.requiresApproval === false ? { requiresApproval: false } : {}),
    };
  }

  if (record.type === 'forger_tool') {
    const toolId = sanitizeText(record.toolId, 160);
    if (!toolId || (validToolIds && !validToolIds.has(toolId))) {
      return null;
    }
    const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input)
      ? record.input as Record<string, unknown>
      : {};
    return { ...base, type: 'forger_tool', toolId: toolId as AgentToolId, input };
  }

  if (record.type === 'connection') {
    const connectionType = sanitizeText(record.connectionType, 80);
    const actionId = sanitizeText(record.actionId, 160);
    if (!connectionType || !actionId) {
      return null;
    }
    const connectionId = sanitizeText(record.connectionId, 160);
    const input = record.input && typeof record.input === 'object' && !Array.isArray(record.input)
      ? record.input as Record<string, unknown>
      : {};
    return {
      ...base,
      type: 'connection',
      connectionType,
      actionId,
      ...(connectionId ? { connectionId } : {}),
      input,
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
    const connectionType = isBuiltInConnectionType(toolId) ? toolId : connectionTypeForAction(actionId);
    if (connectionType) {
      return { ...base, type: 'connection', connectionType, actionId, input };
    }
    if (!validToolIds || validToolIds.has(actionId)) {
      return { ...base, type: 'forger_tool', toolId: actionId as AgentToolId, input };
    }
    return null;
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
  input: unknown,
  validToolIds?: ReadonlySet<string>,
  options: { rejectInvalidNodes?: boolean } = {},
): WorkflowUpsertInput => {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const parsedNodes = Array.isArray(record.nodes)
    ? record.nodes.map((node) => sanitizeWorkflowNode(node, validToolIds))
    : [];
  if (options.rejectInvalidNodes && parsedNodes.some((node) => node === null)) {
    throw new Error('workflow_node_invalid');
  }
  const nodes = parsedNodes.filter((node): node is WorkflowNode => node !== null);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const hasId = Object.prototype.hasOwnProperty.call(record, 'id');
  const id = sanitizeNodeId(record.id);
  const description = sanitizeText(record.description, 500);
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(record, 'expectedRevision');
  const expectedRevision = typeof record.expectedRevision === 'number'
    && Number.isInteger(record.expectedRevision)
    && record.expectedRevision > 0
    ? record.expectedRevision
    : hasExpectedRevision ? 0 : undefined;
  return {
    ...(hasId ? { id } : {}),
    name: sanitizeText(record.name, MAX_NAME_LENGTH),
    ...(description ? { description } : {}),
    trigger: sanitizeWorkflowTrigger(record.trigger),
    nodes,
    edges: sanitizeWorkflowEdges(record.edges, nodeIds),
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
};
