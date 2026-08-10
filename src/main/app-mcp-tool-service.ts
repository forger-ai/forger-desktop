import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AppSummary,
  WorkflowAppActionAnnotations,
  WorkflowAppActionCallInput,
  WorkflowAppActionCallResult,
  WorkflowAppActionCatalog,
  WorkflowAppActionDefinition,
  WorkflowAppActionEffect,
  WorkflowAppActionSelection,
} from '../shared/types';
import type { AppMcpServerConfig, RequiredAppMcpListenResult } from './app-mcp-manager';
import {
  isSafeAppActionJson,
  MAX_APP_ACTION_CATALOG_BYTES,
  MAX_APP_ACTION_INPUT_BYTES,
  MAX_APP_ACTION_SCHEMA_BYTES,
} from './workflow/app-action-json';

interface AppMcpManagerLike {
  listenRequiredMcps: (appIds: string[], runId: string) => Promise<RequiredAppMcpListenResult>;
  releaseMcps: (runId: string) => void;
}

interface ListedMcpTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
}

interface JsonSchemaValidationResult {
  valid: boolean;
}

type JsonSchemaValidator = (input: unknown) => JsonSchemaValidationResult;

interface AjvValidatorProvider {
  getValidator: (schema: Record<string, unknown>) => JsonSchemaValidator;
}

const loadSdkModule = createRequire(__filename);
const { AjvJsonSchemaValidator } = loadSdkModule('@modelcontextprotocol/sdk/validation/ajv') as {
  AjvJsonSchemaValidator: new () => AjvValidatorProvider;
};

export interface AppMcpToolClient {
  connect: () => Promise<void>;
  listTools: (params?: { cursor?: string }, options?: { signal?: AbortSignal; timeout?: number }) => Promise<{
    tools: ListedMcpTool[];
    nextCursor?: string;
  }>;
  callTool: (
    params: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<WorkflowAppActionCallResult>;
  terminateSession?: () => Promise<void>;
  close: () => Promise<void>;
}

export type AppMcpToolClientFactory = (
  config: AppMcpServerConfig,
  appId: string,
) => AppMcpToolClient | Promise<AppMcpToolClient>;

export interface AppMcpToolServiceOptions {
  appMcpManager: AppMcpManagerLike;
  getInstalledApps?: () => AppSummary[];
  clientFactory?: AppMcpToolClientFactory;
}

interface PreparedAction extends WorkflowAppActionDefinition {
  validateInput: JsonSchemaValidator;
  validateOutput: JsonSchemaValidator;
}

interface PreparedAppSession {
  client: AppMcpToolClient;
  actions: Map<string, PreparedAction>;
}

interface PreparedRunSession {
  apps: Map<string, PreparedAppSession>;
  released: boolean;
}

const DEFAULT_CALL_TIMEOUT_MS = 300_000;
const LIST_TIMEOUT_MS = 30_000;
const MAX_TOOL_PAGES = 20;
const MAX_LISTED_TOOLS = 100;
const MCP_CLEANUP_TIMEOUT_MS = 100;
const MAX_MCP_RESPONSE_BYTES = 4_000_000;

export class AppMcpToolService {
  private readonly sessions = new Map<string, PreparedRunSession>();
  private readonly ajv = new AjvJsonSchemaValidator();
  private readonly clientFactory: AppMcpToolClientFactory;

  public constructor(private readonly options: AppMcpToolServiceOptions) {
    this.clientFactory = options.clientFactory ?? createSdkAppMcpToolClient;
  }

  public async prepareAppActions(
    selections: WorkflowAppActionSelection[],
    runId: string,
    signal?: AbortSignal,
  ): Promise<WorkflowAppActionDefinition[]> {
    if (this.sessions.has(runId)) {
      throw new Error('workflow_app_action_session_exists');
    }
    const normalizedSelections = dedupeSelections(selections);
    const appIds = [...new Set(normalizedSelections.map((selection) => selection.appId))];
    const requiredToolsByApp = new Map<string, Set<string>>();
    for (const selection of normalizedSelections) {
      const required = requiredToolsByApp.get(selection.appId) ?? new Set<string>();
      required.add(selection.toolName);
      requiredToolsByApp.set(selection.appId, required);
    }
    const session: PreparedRunSession = { apps: new Map(), released: false };
    this.sessions.set(runId, session);
    try {
      const listened = await this.options.appMcpManager.listenRequiredMcps(appIds, runId);
      if (signal?.aborted) {
        throw new Error('workflow_app_action_canceled');
      }
      if (listened.failures.length > 0) {
        throw new Error(mapListenFailure(listened.failures[0]?.code));
      }
      const serverByApp = requireExactServers(appIds, listened.servers);
      for (const appId of appIds) {
        const config = serverByApp.get(appId) as AppMcpServerConfig;
        assertLoopbackMcpUrl(config.url);
        const client = await this.clientFactory(config, appId);
        try {
          await client.connect();
          const actions = await this.discoverActions(
            client,
            appId,
            { signal, timeout: LIST_TIMEOUT_MS },
            requiredToolsByApp.get(appId),
          );
          session.apps.set(appId, { client, actions });
        } catch (error) {
          await closeAppMcpToolClient(client);
          if (signal?.aborted || isAbortError(error)) {
            throw new Error('workflow_app_action_canceled');
          }
          throw normalizeListError(error);
        }
      }

      return normalizedSelections.map((selection) => {
        const action = session.apps.get(selection.appId)?.actions.get(selection.toolName);
        if (!action) {
          throw new Error('workflow_app_action_tool_not_found');
        }
        return publicDefinition(action);
      });
    } catch (error) {
      await this.releaseAppActions(runId);
      throw normalizePrepareError(error);
    }
  }

  public async listAppActions(appId: string): Promise<WorkflowAppActionCatalog> {
    const runId = `workflow-app-action-catalog:${randomUUID()}`;
    const session: PreparedRunSession = { apps: new Map(), released: false };
    this.sessions.set(runId, session);
    try {
      const listened = await this.options.appMcpManager.listenRequiredMcps([appId], runId);
      if (listened.failures.length > 0) {
        throw new Error(mapListenFailure(listened.failures[0]?.code));
      }
      const config = requireExactServers([appId], listened.servers).get(appId) as AppMcpServerConfig;
      assertLoopbackMcpUrl(config.url);
      const client = await this.clientFactory(config, appId);
      try {
        await client.connect();
        const actions = await this.discoverActions(client, appId);
        session.apps.set(appId, { client, actions });
        const app = this.options.getInstalledApps?.().find((entry) => entry.id === appId);
        const definitions = [...actions.values()];
        return {
          appId,
          appName: app?.name ?? definitions[0]?.appName ?? appId,
          ...(definitions[0]?.appVersion ? { appVersion: definitions[0].appVersion } : {}),
          actions: definitions.map(({ appId: _appId, appName: _appName, appVersion: _appVersion, validateInput: _validateInput, validateOutput: _validateOutput, ...action }) => action),
        };
      } catch (error) {
        await closeAppMcpToolClient(client);
        throw normalizeListError(error);
      }
    } finally {
      await this.releaseAppActions(runId);
    }
  }

  public async callAppAction(input: WorkflowAppActionCallInput): Promise<WorkflowAppActionCallResult> {
    const session = this.sessions.get(input.runId);
    const preparedApp = session?.apps.get(input.appId);
    const preparedAction = preparedApp?.actions.get(input.toolName);
    if (!session || session.released || !preparedApp || !preparedAction) {
      throw new Error('workflow_app_action_not_prepared');
    }
    if (!isRecord(input.input)
      || !isSafeAppActionJson(input.input, MAX_APP_ACTION_INPUT_BYTES)
      || !preparedAction.validateInput(input.input).valid) {
      throw new Error('workflow_app_action_input_invalid');
    }

    const callController = new AbortController();
    let timedOut = false;
    const abortFromCaller = (): void => callController.abort();
    if (input.signal?.aborted) {
      callController.abort();
    } else {
      input.signal?.addEventListener('abort', abortFromCaller, { once: true });
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      timedOut = true;
      callController.abort();
    }, timeoutMs);
    try {
      let currentActions: Map<string, PreparedAction>;
      try {
        currentActions = await this.discoverActions(
          preparedApp.client,
          input.appId,
          { signal: callController.signal, timeout: timeoutMs },
          new Set([input.toolName]),
        );
      } catch (error) {
        if (timedOut || isTimeoutError(error)) {
          throw new Error('workflow_app_action_timeout');
        }
        if (input.signal?.aborted || isAbortError(error)) {
          throw new Error('workflow_app_action_canceled');
        }
        throw normalizeListError(error);
      }
      const currentAction = currentActions.get(input.toolName);
      if (!currentAction) {
        throw new Error('workflow_app_action_tool_not_found');
      }
      if (!compatibleActionContract(preparedAction, currentAction)) {
        throw new Error('workflow_app_action_contract_changed');
      }
      if (!currentAction.validateInput(input.input).valid) {
        throw new Error('workflow_app_action_input_invalid');
      }
      if (input.signal?.aborted) {
        throw new Error('workflow_app_action_canceled');
      }

      let result: WorkflowAppActionCallResult;
      try {
        result = await preparedApp.client.callTool(
          { name: input.toolName, arguments: input.input },
          { signal: callController.signal, timeout: timeoutMs },
        );
      } catch (error) {
        if (timedOut || isTimeoutError(error)) {
          throw new Error('workflow_app_action_timeout');
        }
        if (input.signal?.aborted || isAbortError(error)) {
          throw new Error('workflow_app_action_canceled');
        }
        if (isStructuredOutputValidationError(error)) {
          throw new Error('workflow_app_action_output_invalid');
        }
        throw new Error('workflow_app_action_call_failed');
      }
      if (result.isError) {
        throw new Error('workflow_app_action_tool_error');
      }
      if (!isRecord(result.structuredContent)
        || !isSafeAppActionJson(result.structuredContent, MAX_APP_ACTION_INPUT_BYTES)
        || !currentAction.validateOutput(result.structuredContent).valid) {
        throw new Error('workflow_app_action_output_invalid');
      }
      return { structuredContent: result.structuredContent };
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  public async releaseAppActions(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session || session.released) {
      return;
    }
    session.released = true;
    this.sessions.delete(runId);
    await Promise.allSettled([...session.apps.values()].map(({ client }) => closeAppMcpToolClient(client)));
    this.options.appMcpManager.releaseMcps(runId);
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((runId) => this.releaseAppActions(runId)));
  }

  private async discoverActions(
    client: AppMcpToolClient,
    appId: string,
    options: { signal?: AbortSignal; timeout?: number } = { timeout: LIST_TIMEOUT_MS },
    requiredToolNames?: ReadonlySet<string>,
  ): Promise<Map<string, PreparedAction>> {
    const tools: ListedMcpTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      if (cursor && seenCursors.has(cursor)) {
        throw new Error('workflow_app_action_list_failed');
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
      pageCount += 1;
      if (pageCount > MAX_TOOL_PAGES) {
        throw new Error('workflow_app_action_list_failed');
      }
      const page = await client.listTools(cursor ? { cursor } : undefined, options);
      if (!Array.isArray(page.tools)
        || !isSafeAppActionJson(page.tools, MAX_APP_ACTION_CATALOG_BYTES)) {
        throw new Error('workflow_app_action_list_failed');
      }
      tools.push(...page.tools);
      if (tools.length > MAX_LISTED_TOOLS
        || !isSafeAppActionJson(tools, MAX_APP_ACTION_CATALOG_BYTES)) {
        throw new Error('workflow_app_action_list_failed');
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);

    const seen = new Set<string>();
    const actions = new Map<string, PreparedAction>();
    const app = this.options.getInstalledApps?.().find((entry) => entry.id === appId);
    for (const tool of tools) {
      const name = typeof tool.name === 'string' ? tool.name.trim() : '';
      if (!name) {
        continue;
      }
      if (seen.has(name)) {
        throw new Error('workflow_app_action_duplicate_tool');
      }
      seen.add(name);
      const execution = isRecord(tool.execution) ? tool.execution : {};
      if (execution.taskSupport === 'required') {
        if (requiredToolNames?.has(name)) {
          throw new Error('workflow_app_action_task_required_unsupported');
        }
        continue;
      }
      if (!isObjectSchema(tool.inputSchema)) {
        if (requiredToolNames?.has(name)) {
          throw new Error('workflow_app_action_schema_invalid');
        }
        continue;
      }
      if (!isObjectSchema(tool.outputSchema)) {
        if (requiredToolNames?.has(name)) {
          throw new Error('workflow_app_action_output_schema_required');
        }
        continue;
      }
      if (!isSafeAppActionJson(tool.inputSchema, MAX_APP_ACTION_SCHEMA_BYTES)
        || !isSafeAppActionJson(tool.outputSchema, MAX_APP_ACTION_SCHEMA_BYTES)) {
        if (requiredToolNames?.has(name)) {
          throw new Error('workflow_app_action_schema_invalid');
        }
        continue;
      }
      const annotations = sanitizeAnnotations(tool.annotations);
      let validateInput: JsonSchemaValidator;
      let validateOutput: JsonSchemaValidator;
      try {
        validateInput = this.ajv.getValidator(tool.inputSchema);
        validateOutput = this.ajv.getValidator(tool.outputSchema);
      } catch {
        throw new Error('workflow_app_action_schema_invalid');
      }
      actions.set(name, {
        appId,
        appName: app?.name ?? appId,
        ...(app?.version ? { appVersion: app.version } : {}),
        toolName: name,
        title: nonEmptyText(tool.title) ?? annotationTitle(tool.annotations) ?? name,
        ...(nonEmptyText(tool.description) ? { description: nonEmptyText(tool.description) } : {}),
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations,
        effect: deriveEffect(annotations),
        validateInput,
        validateOutput,
      });
    }
    return actions;
  }
}

const createSdkAppMcpToolClient: AppMcpToolClientFactory = (config) => {
  const expectedUrl = new URL(config.url);
  const secureLoopbackFetch: typeof fetch = async (input, init) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    assertLoopbackMcpUrl(requestUrl.toString());
    if (requestUrl.origin !== expectedUrl.origin) {
      throw new Error('workflow_app_action_invalid_mcp_url');
    }
    const response = await fetch(input, { ...init, redirect: 'error' });
    return limitMcpResponseBody(response);
  };
  const transport = new StreamableHTTPClientTransport(expectedUrl, {
    requestInit: {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: 'error',
    },
    fetch: secureLoopbackFetch,
    reconnectionOptions: {
      maxReconnectionDelay: 1,
      initialReconnectionDelay: 1,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client({ name: 'forger-workflow-app-actions', version: '1.0.0' }, { capabilities: {} });
  return {
    connect: async () => await client.connect(transport, { timeout: LIST_TIMEOUT_MS }),
    listTools: async (params, options) => await client.listTools(params, options),
    callTool: async (params, options) => {
      const result = await client.callTool(params, undefined, options);
      if ('toolResult' in result) {
        throw new Error('workflow_app_action_call_failed');
      }
      return result;
    },
    terminateSession: async () => await transport.terminateSession(),
    close: async () => await client.close(),
  };
};

const limitMcpResponseBody = (response: Response): Response => {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('workflow_app_action_response_too_large');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > MAX_MCP_RESPONSE_BYTES) {
          await reader.cancel('workflow_app_action_response_too_large').catch(() => undefined);
          controller.error(new Error('workflow_app_action_response_too_large'));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const closeAppMcpToolClient = async (client: AppMcpToolClient): Promise<void> => {
  if (client.terminateSession) {
    await settleCleanup(() => client.terminateSession?.());
  }
  await settleCleanup(() => client.close());
};

const settleCleanup = async (operation: () => void | Promise<void>): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve().then(operation).catch(() => undefined),
    new Promise<void>((resolve) => { timeout = setTimeout(resolve, MCP_CLEANUP_TIMEOUT_MS); }),
  ]);
  if (timeout) clearTimeout(timeout);
};

const assertLoopbackMcpUrl = (rawUrl: string): void => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('workflow_app_action_invalid_mcp_url');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || (hostname !== '127.0.0.1' && hostname !== '[::1]' && hostname !== '::1')) {
    throw new Error('workflow_app_action_invalid_mcp_url');
  }
  if (url.username || url.password) {
    throw new Error('workflow_app_action_invalid_mcp_url');
  }
};

const requireExactServers = (
  appIds: string[],
  servers: RequiredAppMcpListenResult['servers'],
): Map<string, AppMcpServerConfig> => {
  const result = new Map<string, AppMcpServerConfig>();
  for (const server of servers) {
    if (result.has(server.appId)) {
      throw new Error('workflow_app_action_start_failed');
    }
    result.set(server.appId, server.config);
  }
  if (result.size !== appIds.length || appIds.some((appId) => !result.has(appId))) {
    throw new Error('workflow_app_action_start_failed');
  }
  return result;
};

const mapListenFailure = (code: string | undefined): string => {
  switch (code) {
    case 'app_not_installed': return 'workflow_app_action_app_not_installed';
    case 'app_mcp_not_declared': return 'workflow_app_action_mcp_not_declared';
    case 'required_app_secrets_missing': return 'workflow_app_action_required_secrets_missing';
    case 'app_mcp_secrets_unavailable': return 'workflow_app_action_secrets_unavailable';
    default: return 'workflow_app_action_start_failed';
  }
};

const dedupeSelections = (selections: WorkflowAppActionSelection[]): WorkflowAppActionSelection[] => {
  const seen = new Set<string>();
  const result: WorkflowAppActionSelection[] = [];
  for (const selection of selections) {
    const appId = selection.appId.trim();
    const toolName = selection.toolName.trim();
    if (!appId || !toolName) {
      throw new Error('workflow_app_action_selection_invalid');
    }
    const key = `${appId}\u0000${toolName}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ appId, toolName });
    }
  }
  return result;
};

const publicDefinition = ({ validateInput: _validateInput, validateOutput: _validateOutput, ...definition }: PreparedAction): WorkflowAppActionDefinition => definition;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const compatibleActionContract = (prepared: PreparedAction, current: PreparedAction): boolean =>
  prepared.effect === current.effect
  && canonicalJson(prepared.inputSchema) === canonicalJson(current.inputSchema)
  && canonicalJson(prepared.outputSchema) === canonicalJson(current.outputSchema);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isObjectSchema = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.type === 'object';

const nonEmptyText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const sanitizeAnnotations = (value: unknown): WorkflowAppActionAnnotations => {
  const input = isRecord(value) ? value : {};
  return {
    ...(typeof input.readOnlyHint === 'boolean' ? { readOnlyHint: input.readOnlyHint } : {}),
    ...(typeof input.destructiveHint === 'boolean' ? { destructiveHint: input.destructiveHint } : {}),
    ...(typeof input.idempotentHint === 'boolean' ? { idempotentHint: input.idempotentHint } : {}),
    ...(typeof input.openWorldHint === 'boolean' ? { openWorldHint: input.openWorldHint } : {}),
  };
};

const annotationTitle = (value: unknown): string | undefined =>
  isRecord(value) ? nonEmptyText(value.title) : undefined;

const deriveEffect = (annotations: WorkflowAppActionAnnotations): WorkflowAppActionEffect => {
  if (annotations.destructiveHint === true) return 'destructive';
  if (annotations.openWorldHint === true) return 'external';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.readOnlyHint === false) return 'write';
  return 'unknown';
};

const normalizeListError = (error: unknown): Error => {
  const normalized = normalizeError(error, 'workflow_app_action_list_failed');
  return normalized.message === 'workflow_app_action_output_schema_required'
    ? normalized
    : new Error('workflow_app_action_list_failed');
};

const PREPARE_ERROR_CODES = new Set([
  'workflow_app_action_app_not_installed',
  'workflow_app_action_mcp_not_declared',
  'workflow_app_action_required_secrets_missing',
  'workflow_app_action_secrets_unavailable',
  'workflow_app_action_start_failed',
  'workflow_app_action_tool_not_found',
  'workflow_app_action_output_schema_required',
  'workflow_app_action_canceled',
]);

const normalizePrepareError = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : '';
  return PREPARE_ERROR_CODES.has(message) ? new Error(message) : new Error('workflow_app_action_list_failed');
};

const normalizeError = (error: unknown, fallback: string): Error => {
  if (error instanceof Error && error.message.startsWith('workflow_app_action_')) {
    return error;
  }
  return new Error(fallback);
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message));

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && /timeout|timed out|requesttimeout/i.test(`${error.name} ${error.message}`);

const isStructuredOutputValidationError = (error: unknown): boolean =>
  error instanceof Error && /structured content|output schema/i.test(error.message);
