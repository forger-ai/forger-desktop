type JsonSchema = Record<string, unknown>;

const stringArray = (): JsonSchema => ({
  type: 'array',
  items: { type: 'string' },
  uniqueItems: true,
});

const objectValue = (): JsonSchema => ({ type: 'object' });

const positionSchema: JsonSchema = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
  required: ['x', 'y'],
  additionalProperties: false,
};

const baseNodeProperties: Record<string, JsonSchema> = {
  id: { type: 'string', minLength: 1, maxLength: 64 },
  name: { type: 'string', minLength: 1, maxLength: 120 },
  position: positionSchema,
  requiresApproval: { type: 'boolean' },
  timeoutMs: { type: 'number', minimum: 10_000, maximum: 1_800_000 },
  forEach: { type: 'string', maxLength: 500 },
};

const nodeSchema = (
  type: string,
  properties: Record<string, JsonSchema>,
  required: string[],
): JsonSchema => ({
  type: 'object',
  properties: {
    ...baseNodeProperties,
    type: { type: 'string', const: type },
    ...properties,
  },
  required: ['id', 'name', 'type', ...required],
  additionalProperties: false,
});

const appActionContractSchema: JsonSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 500 },
    inputSchema: objectValue(),
    outputSchema: objectValue(),
    effect: { type: 'string', enum: ['read', 'write', 'external', 'destructive', 'unknown'] },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    idempotent: { type: 'boolean' },
    contractHash: { type: 'string', minLength: 64, maxLength: 64 },
  },
  required: [
    'title', 'inputSchema', 'outputSchema', 'effect', 'risk', 'idempotent', 'contractHash',
  ],
  additionalProperties: false,
};

const runtimeSchema: JsonSchema = {
  type: 'object',
  properties: {
    provider: { type: 'string', enum: ['codex', 'claude', 'antigravity'] },
    model: { type: 'string' },
    effort: { type: 'string' },
    permissionMode: { type: 'string', enum: ['safe', 'unsafe'] },
    authProfileId: { type: 'string' },
  },
  required: ['provider', 'model', 'effort'],
  additionalProperties: false,
};

const connectionGrantSchema: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    connectionIds: stringArray(),
    actions: stringArray(),
    multiple: { type: 'boolean' },
  },
  required: ['type', 'actions', 'multiple'],
  additionalProperties: false,
};

const workflowNodeSchemas: JsonSchema[] = [
  nodeSchema('app_action', {
    appId: { type: 'string', minLength: 1, maxLength: 64 },
    toolName: { type: 'string', minLength: 1, maxLength: 160 },
    input: objectValue(),
    action: appActionContractSchema,
  }, ['appId', 'toolName', 'input', 'action']),
  nodeSchema('llm_agent', {
    prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
    runtime: runtimeSchema,
    toolIds: stringArray(),
    appIds: stringArray(),
    connectionGrants: { type: 'array', items: connectionGrantSchema },
    outputSchema: objectValue(),
  }, ['prompt', 'toolIds', 'appIds', 'connectionGrants']),
  nodeSchema('forger_agent', {
    agentId: { type: 'string', minLength: 1, maxLength: 128 },
    prompt: { type: 'string', minLength: 1, maxLength: 20_000 },
    outputSchema: objectValue(),
  }, ['agentId', 'prompt']),
  nodeSchema('forger_tool', {
    toolId: { type: 'string', minLength: 1, maxLength: 128 },
    input: objectValue(),
  }, ['toolId', 'input']),
  nodeSchema('connection', {
    connectionType: { type: 'string', minLength: 1, maxLength: 80 },
    actionId: { type: 'string', minLength: 1, maxLength: 160 },
    connectionId: { type: 'string', maxLength: 160 },
    input: objectValue(),
  }, ['connectionType', 'actionId', 'input']),
  nodeSchema('condition', {
    expression: {
      type: 'object',
      properties: {
        left: { type: 'string', minLength: 1, maxLength: 2_000 },
        operator: {
          type: 'string',
          enum: [
            'equals', 'not_equals', 'contains', 'not_contains', 'greater_than',
            'less_than', 'is_empty', 'is_not_empty',
          ],
        },
        right: { type: 'string', maxLength: 2_000 },
      },
      required: ['left', 'operator'],
      additionalProperties: false,
    },
  }, ['expression']),
];

const triggerSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { type: { type: 'string', const: 'manual' } },
      required: ['type'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        type: { type: 'string', const: 'scheduled' },
        frequency: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['hourly', 'daily', 'weekly'] },
            timeOfDay: { type: 'string', description: 'HH:MM para daily/weekly.' },
            weeklyDay: { type: 'number', minimum: 0, maximum: 6 },
          },
          required: ['type'],
          additionalProperties: false,
        },
        missedRunPolicy: { type: 'string', enum: ['skip', 'always', 'within_window'] },
        missedRunWindowMinutes: { type: 'number', minimum: 1 },
      },
      required: ['type', 'frequency'],
      additionalProperties: false,
    },
  ],
};

export const WORKFLOW_UPSERT_INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'ID del flujo existente. Omitir para crear uno nuevo.' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 500 },
    expectedRevision: { type: 'number', minimum: 1, description: 'Revision leida antes de editar.' },
    trigger: triggerSchema,
    nodes: {
      type: 'array',
      minItems: 1,
      items: { oneOf: workflowNodeSchemas },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          condition: { type: 'string', enum: ['success', 'error', 'always'] },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
  },
  required: ['name', 'trigger', 'nodes', 'edges'],
  additionalProperties: false,
  allOf: [{
    if: { required: ['id'] },
    then: { required: ['expectedRevision'] },
  }],
};
