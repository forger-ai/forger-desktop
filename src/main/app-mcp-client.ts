import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { WorkflowAppActionDefinition } from '../shared/types/workflows';

export interface AppMcpClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
}

export interface AppMcpActionCallInput {
  toolName: string;
  input: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type McpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DISCOVERY_PAGES = 5;
const MAX_DISCOVERED_TOOLS = 100;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_STRUCTURED_CONTENT_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_KEYS = 5_000;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SUPPORTED_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'null',
  'integer',
  'number',
  'string',
  'boolean',
]);
const COMMON_SCHEMA_KEYS = new Set(['type', 'enum', 'title', 'description']);
const SCHEMA_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  object: new Set([...COMMON_SCHEMA_KEYS, 'properties', 'required', 'additionalProperties']),
  array: new Set([...COMMON_SCHEMA_KEYS, 'items', 'minItems', 'maxItems']),
  string: new Set([...COMMON_SCHEMA_KEYS, 'minLength', 'maxLength']),
  number: COMMON_SCHEMA_KEYS,
  integer: COMMON_SCHEMA_KEYS,
  boolean: COMMON_SCHEMA_KEYS,
  null: COMMON_SCHEMA_KEYS,
};

const requireLoopbackUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('app_mcp_url_invalid');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || port < 1
    || url.pathname !== '/mcp'
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error('app_mcp_url_not_loopback');
  }
  return url;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]' && !Array.isArray(value);

const isObjectSchema = (value: unknown): value is Record<string, unknown> =>
  Object(value).type === 'object';

const schemaTypeMatchers: Record<string, (value: unknown) => boolean> = {
  null: (value) => value === null,
  object: (value) => isRecord(value),
  array: (value) => Array.isArray(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
};

const schemaValueMatchesType = (value: unknown, type: string): boolean =>
  schemaTypeMatchers[type](value);

const isOptionalNonNegativeInteger = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);

const isWorkflowSafeSchema = (schema: Record<string, unknown>): boolean => {
  const type = schema.type;
  if (typeof type !== 'string' || !SUPPORTED_SCHEMA_TYPES.has(type)) return false;
  const allowedKeys = SCHEMA_KEYS_BY_TYPE[type];
  if (!allowedKeys || Object.keys(schema).some((key) => !allowedKeys.has(key))) return false;
  if (schema.title !== undefined && typeof schema.title !== 'string') return false;
  if (schema.description !== undefined && typeof schema.description !== 'string') return false;
  if (
    schema.enum !== undefined
    && (
      !Array.isArray(schema.enum)
      || schema.enum.length === 0
      || !schema.enum.every((value) => schemaValueMatchesType(value, type))
    )
  ) return false;
  if (type === 'object') {
    if (!isRecord(schema.properties) || schema.additionalProperties !== false) return false;
    const propertyNames = new Set(Object.keys(schema.properties));
    const required = schema.required;
    if (
      required !== undefined
      && (
        !Array.isArray(required)
        || required.some((key) => typeof key !== 'string' || !propertyNames.has(key))
        || new Set(required).size !== required.length
      )
    ) return false;
    return Object.values(schema.properties)
      .every((propertySchema) => isRecord(propertySchema) && isWorkflowSafeSchema(propertySchema));
  }
  if (type === 'array') {
    if (!isRecord(schema.items) || !isWorkflowSafeSchema(schema.items)) return false;
    if (!isOptionalNonNegativeInteger(schema.minItems) || !isOptionalNonNegativeInteger(schema.maxItems)) {
      return false;
    }
    const minItems = schema.minItems;
    const maxItems = schema.maxItems;
    return typeof minItems !== 'number' || typeof maxItems !== 'number' || minItems <= maxItems;
  }
  if (type === 'string') {
    if (!isOptionalNonNegativeInteger(schema.minLength) || !isOptionalNonNegativeInteger(schema.maxLength)) {
      return false;
    }
    const minLength = schema.minLength;
    const maxLength = schema.maxLength;
    return typeof minLength !== 'number' || typeof maxLength !== 'number' || minLength <= maxLength;
  }
  return true;
};

const assertBoundedJson = (
  value: unknown,
  technicalCode: string,
  maxBytes: number,
): void => {
  let keys = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error(technicalCode);
    if (
      entry === null
      || typeof entry === 'string'
      || typeof entry === 'boolean'
      || (typeof entry === 'number' && Number.isFinite(entry))
    ) return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!isRecord(entry)) throw new Error(technicalCode);
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(technicalCode);
    for (const [key, nested] of Object.entries(entry)) {
      if (UNSAFE_OBJECT_KEYS.has(key) || ++keys > MAX_JSON_KEYS) {
        throw new Error(technicalCode);
      }
      visit(nested, depth + 1);
    }
  };
  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(technicalCode);
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(technicalCode);
};

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
};

const isFullyAnnotated = (
  annotations: McpTool['annotations'],
): annotations is Required<Pick<NonNullable<McpTool['annotations']>,
  'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>> &
  NonNullable<McpTool['annotations']> => Boolean(
    annotations
    && typeof annotations.readOnlyHint === 'boolean'
    && typeof annotations.destructiveHint === 'boolean'
    && typeof annotations.idempotentHint === 'boolean'
    && typeof annotations.openWorldHint === 'boolean',
  );

const toActionDefinition = (tool: McpTool): WorkflowAppActionDefinition | null => {
  const title = tool.title?.trim() || tool.annotations?.title?.trim();
  const description = tool.description?.trim();
  if (
    !tool.name.trim()
    || !title
    || !description
    || !isObjectSchema(tool.inputSchema)
    || !isObjectSchema(tool.outputSchema)
    || !isWorkflowSafeSchema(tool.inputSchema)
    || !isWorkflowSafeSchema(tool.outputSchema)
    || !isFullyAnnotated(tool.annotations)
  ) {
    return null;
  }
  try {
    assertBoundedJson(tool.inputSchema, 'app_mcp_schema_invalid', MAX_SCHEMA_BYTES);
    assertBoundedJson(tool.outputSchema, 'app_mcp_schema_invalid', MAX_SCHEMA_BYTES);
  } catch {
    return null;
  }
  const effect = tool.annotations.destructiveHint
    ? 'destructive' as const
    : tool.annotations.openWorldHint
      ? 'external' as const
      : tool.annotations.readOnlyHint
        ? 'read' as const
        : 'write' as const;
  const risk = effect === 'destructive'
    ? 'high' as const
    : effect === 'read'
      ? 'low' as const
      : 'medium' as const;
  const contract = {
    toolName: tool.name,
    title,
    description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    effect,
    risk,
    idempotent: tool.annotations.idempotentHint,
  };
  return {
    ...contract,
    contractHash: createHash('sha256')
      .update(JSON.stringify(stableValue(contract)))
      .digest('hex'),
  };
};

export class AppMcpClient {
  private readonly url: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;
  private closed = false;

  public constructor(options: AppMcpClientOptions) {
    this.url = requireLoopbackUrl(options.url);
    this.token = options.token.trim();
    if (!this.token) throw new Error('app_mcp_token_required');
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  public async listActions(): Promise<WorkflowAppActionDefinition[]> {
    const client = await this.getClient();
    const actions: WorkflowAppActionDefinition[] = [];
    const seenCursors = new Set<string>();
    let pageCount = 0;
    let toolCount = 0;
    let cursor: string | undefined;
    do {
      pageCount += 1;
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: this.timeoutMs,
        maxTotalTimeout: this.timeoutMs,
      });
      toolCount += result.tools.length;
      if (toolCount > MAX_DISCOVERED_TOOLS) {
        throw new Error('app_mcp_discovery_limit_exceeded');
      }
      actions.push(...result.tools.flatMap((tool) => {
        const action = toActionDefinition(tool);
        return action ? [action] : [];
      }));
      cursor = result.nextCursor;
      if (cursor && (seenCursors.has(cursor) || pageCount === MAX_DISCOVERY_PAGES)) {
        throw new Error('app_mcp_discovery_cursor_invalid');
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    if (new Set(actions.map((action) => action.toolName)).size !== actions.length) {
      throw new Error('app_mcp_duplicate_action');
    }
    return actions;
  }

  public async callAction(input: AppMcpActionCallInput): Promise<Record<string, unknown>> {
    assertBoundedJson(input.input, 'app_mcp_action_input_invalid', MAX_STRUCTURED_CONTENT_BYTES);
    const client = await this.getClient();
    const timeout = Math.max(1, Math.floor(input.timeoutMs ?? this.timeoutMs));
    const result = await client.callTool(
      { name: input.toolName, arguments: input.input },
      undefined,
      { signal: input.signal, timeout, maxTotalTimeout: timeout },
    );
    if ('toolResult' in result || result.isError) {
      throw new Error('app_mcp_action_failed');
    }
    if (!isRecord(result.structuredContent)) {
      throw new Error('app_mcp_structured_content_required');
    }
    assertBoundedJson(
      result.structuredContent,
      'app_mcp_structured_content_invalid',
      MAX_STRUCTURED_CONTENT_BYTES,
    );
    return result.structuredContent;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = this.connectPromise;
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    if (client) {
      await client.close();
      return;
    }
    if (pending) {
      await pending.then((connected) => connected.close()).catch(() => undefined);
    }
  }

  private async getClient(): Promise<Client> {
    if (this.closed) throw new Error('app_mcp_client_closed');
    if (this.client) return this.client;
    this.connectPromise ??= this.connect();
    try {
      return await this.connectPromise;
    } catch (error) {
      this.connectPromise = null;
      throw error;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client({ name: 'forger-desktop-app-actions', version: '1.0.0' }, {
      capabilities: {},
    });
    const transport = new StreamableHTTPClientTransport(this.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: 'error',
      },
    });
    try {
      await client.connect(transport, {
        timeout: this.timeoutMs,
        maxTotalTimeout: this.timeoutMs,
      });
      if (this.closed) {
        await client.close();
        throw new Error('app_mcp_client_closed');
      }
      this.client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}
