import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentToolDefinition,
  AgentToolId,
  AgentToolSettings,
  AppSummary,
  CatalogApp,
  OpenAppResult,
  RuntimeStatus,
  StopAppResult,
  InstallAppResult,
  MemoryCreateInput,
  MemoryEntry,
  MemoryListInput,
  MemoryUpdateInput,
} from '../shared/types';
import { buildFailureDiagnostic } from '../shared/error-diagnostics';

export interface ForgerMcpSessionRef {
  url: string;
  token: string;
}

interface AgentMcpSession {
  runId: string;
  appId: string;
  caller: 'desktop-chat' | 'app-agent' | 'automation';
  appIds: string[];
  token: string;
  createdAt: string;
}

export interface ForgerMcpSessionAccess {
  caller: AgentMcpSession['caller'];
  appIds?: string[];
}

interface ForgerMcpServerOptions {
  getAppVersion: () => string;
  getToolDefinitions: () => AgentToolDefinition[];
  getToolSettings: () => AgentToolSettings;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  requestPermission: (
    runId: string,
    request: {
      pluginId: string;
      permission: string;
      reason: string;
      risk: 'low' | 'medium' | 'high';
      resource: string;
    },
  ) => Promise<boolean> | null;
  listCatalog: () => Promise<CatalogApp[]>;
  listInstalledApps: () => AppSummary[];
  checkUpdates: () => Promise<AppSummary[]>;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  openApp: (appId: string) => Promise<OpenAppResult>;
  stopApp: (appId: string) => Promise<StopAppResult>;
  restartApp: (appId: string, options?: { onProgress?: (message: string) => void }) => Promise<OpenAppResult>;
  refreshAppView: (appId: string) => Promise<{ success: boolean; userMessage?: string; technicalCode?: string }>;
  updateApp: (appId: string) => Promise<InstallAppResult>;
  memoryList: (input: MemoryListInput, access: MemoryAccessInput) => Promise<MemoryEntry[]>;
  memoryCreate: (input: MemoryCreateInput, access: MemoryAccessInput) => Promise<MemoryEntry>;
  memoryUpdate: (input: MemoryUpdateInput, access: MemoryAccessInput) => Promise<MemoryEntry>;
  memoryDelete: (id: string, access: MemoryAccessInput) => Promise<{ success: boolean }>;
  onToolProgress?: (input: { appId: string; runId: string; toolName?: unknown; message: string }) => void;
  onToolFailure?: (input: { appId: string; runId: string; toolName?: unknown; error: unknown }) => void;
  onHttpFailure?: (input: { appId?: string; runId?: string; error: unknown }) => void;
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

interface ToolApprovalResult {
  approved: boolean;
  required: boolean;
  status: 'not_required' | 'approved' | 'denied' | 'unavailable';
  userMessage: string;
}

interface MemoryAccessInput {
  caller: AgentMcpSession['caller'];
  appId?: string;
  appIds?: string[];
}

export class ForgerMcpServer {
  private readonly sessions = new Map<string, AgentMcpSession>();
  private server: http.Server | null = null;
  private url: string | null = null;

  public constructor(private readonly options: ForgerMcpServerOptions) {}

  public async start(): Promise<void> {
    if (this.server && this.url) {
      return;
    }

    const server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch((error) => {
        void this.options.appendInstallLog('agent_tool:mcp_http_error', {
          message: error instanceof Error ? error.message : 'internal_error',
          stack: error instanceof Error ? error.stack : undefined,
        });
        this.options.onHttpFailure?.({ error });
        sendMcpJson(response, 500, {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'internal_error',
          },
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('forger_mcp_server_address_unavailable');
    }

    this.server = server;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    await this.options.appendInstallLog('agent_tool:mcp_server_started', { url: this.url });
  }

  public stop(): void {
    this.server?.close();
    this.server = null;
    this.url = null;
    this.sessions.clear();
  }

  public createSession(runId: string, appId: string, access?: ForgerMcpSessionAccess): ForgerMcpSessionRef | null {
    if (!this.url) {
      void this.options.appendInstallLog('agent_tool:mcp_session_unavailable', { runId, appId });
      return null;
    }
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      runId,
      appId,
      caller: access?.caller ?? 'desktop-chat',
      appIds: access?.appIds ?? (appId === 'forger' ? [] : [appId]),
      token,
      createdAt: new Date().toISOString(),
    });
    void this.options.appendInstallLog('agent_tool:mcp_session_created', {
      runId,
      appId,
      url: this.url,
      tokenSuffix: token.slice(-6),
    });
    return { url: this.url, token };
  }

  public releaseSession(token: string): void {
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    void this.options.appendInstallLog('agent_tool:mcp_session_released', {
      runId: session?.runId ?? null,
      appId: session?.appId ?? null,
      tokenSuffix: token.slice(-6),
    });
  }

  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'POST' || requestPath !== '/mcp') {
      sendMcpJson(response, 404, { error: 'not_found' });
      return;
    }

    const token = getBearerToken(request);
    const session = token ? this.sessions.get(token) : null;
    if (!session) {
      void this.options.appendInstallLog('agent_tool:mcp_unauthorized', {
        path: requestPath,
        hasToken: Boolean(token),
      });
      sendMcpJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const raw = await readRequestBody(request);
      const parsed = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
      const requests = Array.isArray(parsed) ? parsed : [parsed];
      await this.options.appendInstallLog('agent_tool:mcp_http_request', {
        appId: session.appId,
        runId: session.runId,
        requestCount: requests.length,
        methods: requests.map((entry) => entry.method ?? null),
      });
      const results = (await Promise.all(requests.map((entry) => this.handleMcpRequest(session, entry))))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));

      if (results.length === 0) {
        response.writeHead(202);
        response.end();
        return;
      }

      sendMcpJson(response, 200, Array.isArray(parsed) ? results : results[0]);
    } catch (error) {
      this.options.onHttpFailure?.({ appId: session.appId, runId: session.runId, error });
      throw error;
    }
  }

  private async handleMcpRequest(
    session: AgentMcpSession,
    request: JsonRpcRequest,
  ): Promise<Record<string, unknown> | null> {
    const id = request.id ?? null;
    await this.options.appendInstallLog('agent_tool:mcp_request', {
      appId: session.appId,
      runId: session.runId,
      method: request.method ?? null,
      id,
    });
    if (!request.method) {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
    }

    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'forger', version: this.options.getAppVersion() },
        },
      };
    }

    if (request.method === 'notifications/initialized') {
      return null;
    }

    if (request.method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (request.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: this.getMcpTools() } };
    }

    if (request.method === 'tools/call') {
      return await this.handleToolCall(session, id, request.params);
    }

    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }

  private async handleToolCall(
    session: AgentMcpSession,
    id: string | number | null,
    rawParams: unknown,
  ): Promise<Record<string, unknown>> {
    const params = rawParams as { name?: unknown; arguments?: unknown } | undefined;
    const toolName = params?.name;
    await this.options.appendInstallLog('agent_tool:mcp_tools_call_received', {
      appId: session.appId,
      runId: session.runId,
      id,
      toolName,
      arguments: params?.arguments ?? null,
    });
    if (!this.isAgentToolId(toolName)) {
      await this.options.appendInstallLog('agent_tool:mcp_tools_call_rejected', {
        appId: session.appId,
        runId: session.runId,
        id,
        toolName,
        reason: 'unknown_tool',
      });
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } };
    }
    const args = params?.arguments && typeof params.arguments === 'object'
      ? (params.arguments as Record<string, unknown>)
      : {};
    try {
      const result = await this.executeAgentTool(session, toolName, args);
      await this.options.appendInstallLog('agent_tool:mcp_tools_call_completed', {
        appId: session.appId,
        runId: session.runId,
        id,
        toolName,
        isError: Boolean((result as { success?: unknown }).success === false),
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
          isError: Boolean((result as { success?: unknown }).success === false),
        },
      };
    } catch (error) {
      this.options.onToolFailure?.({ appId: session.appId, runId: session.runId, toolName, error });
      throw error;
    }
  }

  private getMcpTools(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return this.options.getToolDefinitions().map((tool) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: getMcpToolInputSchema(tool.id),
    }));
  }

  private isAgentToolId(value: unknown): value is AgentToolId {
    return typeof value === 'string' && this.options.getToolDefinitions().some((tool) => tool.id === value);
  }

  private async ensureToolApproval(
    session: AgentMcpSession,
    tool: AgentToolDefinition,
  ): Promise<ToolApprovalResult> {
    if (isMemoryTool(tool.id)) {
      return {
        approved: true,
        required: false,
        status: 'not_required',
        userMessage: 'La herramienta de memoria no requiere autorizacion adicional.',
      };
    }
    if (!this.options.getToolSettings().approvals[tool.id]) {
      await this.options.appendInstallLog('agent_tool:approval_skipped', {
        appId: session.appId,
        runId: session.runId,
        toolId: tool.id,
        reason: 'approval_not_required',
      });
      return {
        approved: true,
        required: false,
        status: 'not_required',
        userMessage: 'Esta herramienta no requirio autorizacion adicional.',
      };
    }
    const requestPermission = this.options.requestPermission(session.runId, {
      pluginId: 'forger-agent-tools',
      permission: tool.id,
      reason: tool.description,
      risk: tool.risk === 'alto' ? 'high' : tool.risk === 'medio' ? 'medium' : 'low',
      resource: tool.name,
    });
    if (!requestPermission) {
      await this.options.appendInstallLog('agent_tool:approval_unavailable', {
        appId: session.appId,
        runId: session.runId,
        toolId: tool.id,
        reason: 'chat_orchestrator_unavailable',
      });
      return {
        approved: false,
        required: true,
        status: 'unavailable',
        userMessage: 'No se pudo solicitar autorizacion para esta herramienta.',
      };
    }
    await this.options.appendInstallLog('agent_tool:approval_requested', {
      appId: session.appId,
      runId: session.runId,
      toolId: tool.id,
      toolName: tool.name,
    });
    this.emitToolProgress(session, tool.id, `Esperando autorizacion para ${tool.name}...`);
    const approved = await requestPermission;
    await this.options.appendInstallLog('agent_tool:approval_resolved', {
      appId: session.appId,
      runId: session.runId,
      toolId: tool.id,
      approved,
    });
    return {
      approved,
      required: true,
      status: approved ? 'approved' : 'denied',
      userMessage: approved
        ? 'Autorizacion recibida. La herramienta continuo con la accion solicitada.'
        : 'La autorizacion fue rechazada o cancelada.',
    };
  }

  private async executeAgentTool(
    session: AgentMcpSession,
    toolId: AgentToolId,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = this.options.getToolDefinitions().find((candidate) => candidate.id === toolId);
    if (!tool) {
      await this.options.appendInstallLog('agent_tool:not_found', {
        appId: session.appId,
        runId: session.runId,
        toolId,
        args,
      });
      return { success: false, userMessage: 'La herramienta no esta disponible.', technicalCode: 'tool_not_found' };
    }

    await this.options.appendInstallLog('agent_tool:call_received', {
      appId: session.appId,
      runId: session.runId,
      toolId,
      args,
      requiresApproval: Boolean(this.options.getToolSettings().approvals[tool.id]),
    });

    const approval = await this.ensureToolApproval(session, tool);
    if (!approval.approved) {
      await this.options.appendInstallLog('agent_tool:call_cancelled', {
        appId: session.appId,
        runId: session.runId,
        toolId,
        reason: 'forger_permission_denied_or_unavailable',
      });
      return withToolAuthorization(
        { success: false, userMessage: 'La accion fue cancelada por el usuario.', technicalCode: 'permission_denied' },
        approval,
      );
    }

    await this.options.appendInstallLog('agent_tool:call', {
      appId: session.appId,
      toolId,
      runId: session.runId,
    });
    this.emitToolProgress(session, toolId, toolId === 'forger_restart_app' ? 'Preparando reinicio de la app...' : '');

    if (toolId === 'forger_list_catalog') {
      const apps = await this.options.listCatalog();
      const result = { success: true, apps };
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_list_installed_apps') {
      const result = { success: true, apps: this.options.listInstalledApps() };
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_check_updates') {
      const updates = await this.options.checkUpdates();
      const result = { success: true, updates };
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (isMemoryTool(toolId)) {
      try {
        if (toolId === 'memory_list') {
          const memories = await this.options.memoryList(args, memoryAccess(session));
          const result = { success: true, memories };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
          return result;
        }

        if (toolId === 'memory_create') {
          const memory = await this.options.memoryCreate(
            { ...args, source: 'agent' } as MemoryCreateInput,
            memoryAccess(session),
          );
          const result = {
            success: true,
            memory,
            userMessage: memory.scope === 'global'
              ? 'He tomado nota de esto en la memoria de Forger. Puedes verla o eliminarla en Configuraciones > Memoria.'
              : 'He tomado nota de esto para esta app. Puedes administrarlo en Configuraciones > Memoria.',
          };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
          return result;
        }

        if (toolId === 'memory_update') {
          const memory = await this.options.memoryUpdate(args as unknown as MemoryUpdateInput, memoryAccess(session));
          const result = {
            success: true,
            memory,
            userMessage: 'He actualizado esa memoria. Puedes administrarla en Configuraciones > Memoria.',
          };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
          return result;
        }

        if (toolId === 'memory_delete') {
          const result = await this.options.memoryDelete(String(args.id ?? ''), memoryAccess(session));
          const response = { ...result, userMessage: result.success ? 'Elimine esa memoria.' : 'No encontre esa memoria.' };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result: response });
          return response;
        }
      } catch (error) {
        const result = {
          success: false,
          userMessage: memoryErrorMessage(error),
          ...buildFailureDiagnostic({ error, fallbackCode: 'memory_error' }),
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
    }

    const appId = getToolAppId(session, args);

    if (toolId === 'forger_get_app_runtime_status') {
      const result = { success: true, status: this.options.getRuntimeStatus(appId) };
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_open_app') {
      const result = await this.options.openApp(appId);
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_stop_app') {
      const result = await this.options.stopApp(appId);
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_restart_app') {
      const result = await this.options.restartApp(appId, {
        onProgress: (message) => this.emitToolProgress(session, toolId, message),
      });
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_refresh_app_view') {
      const result = await this.options.refreshAppView(appId);
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_update_app') {
      const result = await this.options.updateApp(appId);
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    const result = { success: false, userMessage: 'La herramienta no esta disponible.', technicalCode: 'tool_not_found' };
    await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
    return withToolAuthorization(result, approval);
  }

  private emitToolProgress(session: AgentMcpSession, toolId: AgentToolId, message: string): void {
    if (!message.trim()) {
      return;
    }
    this.options.onToolProgress?.({
      appId: session.appId,
      runId: session.runId,
      toolName: toolId,
      message,
    });
  }
}

const getMcpToolInputSchema = (toolId: AgentToolId): Record<string, unknown> => {
  if (toolId === 'memory_list') {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'app'] },
        appId: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'profile', 'workflow', 'constraint', 'fact'] },
      },
      additionalProperties: false,
    };
  }
  if (toolId === 'memory_create') {
    return {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'app'] },
        appId: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'profile', 'workflow', 'constraint', 'fact'] },
        text: { type: 'string' },
      },
      required: ['scope', 'kind', 'text'],
      additionalProperties: false,
    };
  }
  if (toolId === 'memory_update') {
    return {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'app'] },
        appId: { type: 'string' },
        kind: { type: 'string', enum: ['preference', 'profile', 'workflow', 'constraint', 'fact'] },
        text: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    };
  }
  if (toolId === 'memory_delete') {
    return {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    };
  }

  if (
    toolId === 'forger_get_app_runtime_status' ||
    toolId === 'forger_open_app' ||
    toolId === 'forger_stop_app' ||
    toolId === 'forger_restart_app' ||
    toolId === 'forger_refresh_app_view' ||
    toolId === 'forger_update_app'
  ) {
    return {
      type: 'object',
      properties: {
        appId: {
          type: 'string',
          description: 'ID de la app instalada sobre la que se ejecuta la herramienta.',
        },
      },
      required: ['appId'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
};

const isMemoryTool = (toolId: AgentToolId): boolean => toolId.startsWith('memory_');

const memoryAccess = (session: AgentMcpSession): MemoryAccessInput => ({
  caller: session.caller,
  appId: session.appId === 'forger' ? undefined : session.appId,
  appIds: session.appIds,
});

const memoryErrorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : 'memory_error';
  if (code === 'memory_scope_forbidden') {
    return 'No puedo operar memoria fuera del alcance permitido para esta conversación.';
  }
  if (code === 'memory_text_required') {
    return 'La memoria necesita un texto para guardarse.';
  }
  if (code === 'memory_app_required') {
    return 'La memoria de app necesita una app asociada.';
  }
  if (code === 'memory_not_found') {
    return 'No encontre esa memoria.';
  }
  return 'No pude completar la operacion de memoria.';
};

const getToolAppId = (session: AgentMcpSession, params: Record<string, unknown>): string => {
  const appId = typeof params.appId === 'string' && params.appId.trim() ? params.appId.trim() : session.appId;
  return appId;
};

const withToolAuthorization = (result: unknown, approval: ToolApprovalResult): unknown => {
  if (!approval.required || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  return {
    ...(result as Record<string, unknown>),
    authorization: {
      required: true,
      status: approval.status,
      userMessage: approval.userMessage,
    },
  };
};

const sendMcpJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

const getBearerToken = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header || Array.isArray(header)) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};
