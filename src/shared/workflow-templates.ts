import type { Workflow, WorkflowEdge, WorkflowNode } from './types';

/**
 * Shared helpers for the workflow template language: strings that mix free
 * text with {{path}} references to previous node outputs or trigger data.
 * The renderer uses them to tokenize prompts into pills and to list the
 * fields available for mapping; tests exercise them as pure functions.
 */

export const TEMPLATE_REFERENCE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export type TemplateToken =
  | { type: 'text'; value: string }
  | { type: 'reference'; path: string };

/** Splits a template string into text and {{reference}} tokens. */
export const tokenizeTemplate = (value: string): TemplateToken[] => {
  const tokens: TemplateToken[] = [];
  let lastIndex = 0;
  const pattern = new RegExp(TEMPLATE_REFERENCE_PATTERN.source, 'g');
  for (let match = pattern.exec(value); match !== null; match = pattern.exec(value)) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: value.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'reference', path: match[1] as string });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) {
    tokens.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return tokens;
};

export const stringifyTemplateTokens = (tokens: TemplateToken[]): string =>
  tokens.map((token) => (token.type === 'text' ? token.value : `{{${token.path}}}`)).join('');

export const buildReference = (nodeId: string, fieldPath?: string): string =>
  fieldPath ? `nodes.${nodeId}.output.${fieldPath}` : `nodes.${nodeId}.output`;

export interface TemplateReferenceParts {
  kind: 'node' | 'trigger';
  nodeId?: string;
  fieldPath?: string;
}

/** Parses a reference path like nodes.<id>.output.<field> or trigger.<field>. */
export const parseReferencePath = (path: string): TemplateReferenceParts | null => {
  const segments = path.split('.');
  if (segments[0] === 'trigger') {
    return { kind: 'trigger', fieldPath: segments.slice(1).join('.') || undefined };
  }
  if (segments[0] === 'nodes' && segments[1]) {
    const nodeId = segments[1];
    if (segments[2] === 'output') {
      return { kind: 'node', nodeId, fieldPath: segments.slice(3).join('.') || undefined };
    }
    return { kind: 'node', nodeId, fieldPath: segments.slice(2).join('.') || undefined };
  }
  return null;
};

export interface AvailableField {
  /** Dot path inside the node output, e.g. "channels.0.name". Empty = whole output. */
  path: string;
  /** JSON-schema type or inferred sample type when known. */
  type?: string;
  /** Sample value from the latest run, when available. */
  sample?: unknown;
}

const MAX_FIELDS_PER_NODE = 40;
const MAX_SAMPLE_DEPTH = 3;

/** Lists field paths declared by a JSON-schema-like output schema. */
export const listSchemaFields = (
  schema: Record<string, unknown>,
  prefix = '',
  depth = 0,
): AvailableField[] => {
  if (depth > MAX_SAMPLE_DEPTH) {
    return [];
  }
  const type = typeof schema.type === 'string' ? schema.type : undefined;
  if (type === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
    const fields: AvailableField[] = [];
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!propertySchema || typeof propertySchema !== 'object') {
        continue;
      }
      const childPath = prefix ? `${prefix}.${key}` : key;
      const child = propertySchema as Record<string, unknown>;
      const childType = typeof child.type === 'string' ? child.type : undefined;
      fields.push({ path: childPath, type: childType });
      if (childType === 'object' || childType === 'array') {
        // The array branch below appends the `.0` sample index itself.
        fields.push(...listSchemaFields(child, childPath, depth + 1));
      }
      if (fields.length >= MAX_FIELDS_PER_NODE) {
        break;
      }
    }
    return fields.slice(0, MAX_FIELDS_PER_NODE);
  }
  if (type === 'array' && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    return listSchemaFields(schema.items as Record<string, unknown>, prefix ? `${prefix}.0` : '0', depth + 1);
  }
  return [];
};

/** Lists field paths observed in a sample output from a previous run. */
export const listSampleFields = (
  sample: unknown,
  prefix = '',
  depth = 0,
): AvailableField[] => {
  if (depth > MAX_SAMPLE_DEPTH || sample === null || sample === undefined) {
    return [];
  }
  if (Array.isArray(sample)) {
    return sample.length > 0 ? listSampleFields(sample[0], prefix ? `${prefix}.0` : '0', depth + 1) : [];
  }
  if (typeof sample !== 'object') {
    return [];
  }
  const fields: AvailableField[] = [];
  for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    const valueType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    fields.push({
      path: childPath,
      type: valueType,
      ...(valueType !== 'object' && valueType !== 'array' ? { sample: value } : {}),
    });
    if (valueType === 'object' || valueType === 'array') {
      fields.push(...listSampleFields(value, childPath, depth + 1));
    }
    if (fields.length >= MAX_FIELDS_PER_NODE) {
      break;
    }
  }
  return fields.slice(0, MAX_FIELDS_PER_NODE);
};

/** Merges declared schema fields with observed sample fields (schema wins). */
export const mergeAvailableFields = (
  schemaFields: AvailableField[],
  sampleFields: AvailableField[],
): AvailableField[] => {
  const byPath = new Map<string, AvailableField>();
  for (const field of sampleFields) {
    byPath.set(field.path, field);
  }
  for (const field of schemaFields) {
    const existing = byPath.get(field.path);
    byPath.set(field.path, existing ? { ...existing, ...field, sample: existing.sample } : field);
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_FIELDS_PER_NODE);
};

/** Ids of every node that can reach `nodeId` following the edges. */
export const listUpstreamNodeIds = (
  nodes: Pick<WorkflowNode, 'id'>[],
  edges: WorkflowEdge[],
  nodeId: string,
): string[] => {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const sources = incoming.get(edge.to) ?? [];
    sources.push(edge.from);
    incoming.set(edge.to, sources);
  }
  const visited = new Set<string>();
  const queue = [...(incoming.get(nodeId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    queue.push(...(incoming.get(current) ?? []));
  }
  const order = nodes.map((node) => node.id);
  return Array.from(visited).sort((a, b) => order.indexOf(a) - order.indexOf(b));
};

export interface ForEachJoinConflict {
  nodeId: string;
  parents: [string, string];
}

/**
 * A node may not join two independent forEach loops: when two of its direct
 * parents iterate (forEach) and neither is an ancestor of the other, their
 * iterations cannot be aligned. Nested loops are fine because the inner
 * forEach node is downstream of the outer one.
 */
export const findForEachJoinConflict = (
  nodes: Array<Pick<WorkflowNode, 'id' | 'forEach'>>,
  edges: WorkflowEdge[],
): ForEachJoinConflict | null => {
  const forEachIds = new Set(nodes.filter((node) => node.forEach).map((node) => node.id));
  if (forEachIds.size < 2) {
    return null;
  }
  for (const node of nodes) {
    const forEachParents = Array.from(new Set(
      edges.filter((edge) => edge.to === node.id && forEachIds.has(edge.from)).map((edge) => edge.from),
    ));
    if (forEachParents.length < 2) {
      continue;
    }
    for (let first = 0; first < forEachParents.length; first += 1) {
      for (let second = first + 1; second < forEachParents.length; second += 1) {
        const parentA = forEachParents[first] as string;
        const parentB = forEachParents[second] as string;
        const upstreamOfA = listUpstreamNodeIds(nodes, edges, parentA);
        const upstreamOfB = listUpstreamNodeIds(nodes, edges, parentB);
        if (!upstreamOfA.includes(parentB) && !upstreamOfB.includes(parentA)) {
          return { nodeId: node.id, parents: [parentA, parentB] };
        }
      }
    }
  }
  return null;
};

/** Fixed output contract of condition nodes. */
export const CONDITION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { result: { type: 'boolean' } },
  required: ['result'],
};

/** Fallback output contract of agent nodes without a declared schema. */
export const AGENT_FALLBACK_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { text: { type: 'string' } },
};

export interface UpstreamFieldSource {
  node: WorkflowNode;
  fields: AvailableField[];
}

/**
 * Resolves the fields each upstream node offers to `nodeId`, combining the
 * declared contract (connection/Forger tool action schema, agent outputSchema,
 * condition contract) with the sample output of the latest stored run.
 */
export const buildUpstreamFieldSources = (
  workflow: Pick<Workflow, 'nodes' | 'edges'>,
  nodeId: string,
  options: {
    /** Latest known output per node id, from stored runs. */
    outputSamples?: Record<string, unknown>;
    /** Declared output schema per connection action id. */
    connectionOutputSchemas?: Record<string, Record<string, unknown>>;
    /** Declared output schema per Forger tool action id. */
    forgerToolOutputSchemas?: Record<string, Record<string, unknown>>;
    /** @deprecated Legacy name kept while persisted drafts migrate away from connector nodes. */
    connectorOutputSchemas?: Record<string, Record<string, unknown>>;
  } = {},
): UpstreamFieldSource[] => {
  const upstreamIds = listUpstreamNodeIds(workflow.nodes, workflow.edges, nodeId);
  return upstreamIds
    .map((upstreamId) => workflow.nodes.find((node) => node.id === upstreamId))
    .filter((node): node is WorkflowNode => Boolean(node))
    .map((node) => {
      const schema = (() => {
        if (node.type === 'condition') {
          return CONDITION_OUTPUT_SCHEMA;
        }
        if (node.type === 'connection') {
          return options.connectionOutputSchemas?.[node.actionId]
            ?? options.connectorOutputSchemas?.[node.actionId];
        }
        if (node.type === 'forger_tool') {
          return options.forgerToolOutputSchemas?.[node.toolId]
            ?? options.connectorOutputSchemas?.[node.toolId];
        }
        if (node.type === 'app_action') {
          return node.contract?.outputSchema;
        }
        return node.outputSchema ?? AGENT_FALLBACK_OUTPUT_SCHEMA;
      })();
      const schemaFields = schema ? listSchemaFields(schema) : [];
      const sample = options.outputSamples?.[node.id];
      const sampleFields = sample !== undefined ? listSampleFields(sample) : [];
      return { node, fields: mergeAvailableFields(schemaFields, sampleFields) };
    });
};
