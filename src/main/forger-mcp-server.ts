import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentToolDefinition,
  AgentToolId,
  AgentToolSettings,
  AppSummary,
  AppPromptMutationResult,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptReviewItem,
  AppPromptTestInput,
  AppPromptTestResult,
  AppToolGrantRequestPreview,
  AppToolGrantRequestResult,
  CatalogApp,
  OpenAppResult,
  RuntimeStatus,
  StopAppResult,
  InstallAppResult,
  CallOfficialToolInput,
  CallOfficialToolResult,
  MemoryCreateInput,
  MemoryEntry,
  MemoryListInput,
  MemoryUpdateInput,
  AgentRuntime,
  ChatCreatedAppRequest,
  ChatQuestion,
  ChatQuestionRequest,
  CreateLocalAppInput,
  CreateLocalAppResult,
  SetAppToolGrantInput,
  SpeechToTextProcessResult,
  SpeechToTextState,
  TextToSpeechState,
  TextToSpeechSynthesizeInput,
  TextToSpeechSynthesizeResult,
} from '../shared/types';
import { buildFailureDiagnostic } from '../shared/error-diagnostics';
import { getSharedCopy } from '../shared/i18n';
import { getMcpToolAnnotations, getMcpToolInputSchema, type McpToolAnnotations } from './forger-mcp/tool-metadata';

export interface ForgerMcpSessionRef {
  url: string;
  token: string;
}

interface AgentMcpSession {
  runId: string;
  appId: string;
  caller: 'desktop-chat' | 'app-agent' | 'automation' | 'free-chat' | 'personal-agent';
  personalAgentId?: string;
  appIds: string[];
  officialToolActionIds: string[];
  locale?: string;
  token: string;
  createdAt: string;
}

export interface ForgerMcpSessionAccess {
  caller: AgentMcpSession['caller'];
  personalAgentId?: string;
  appIds?: string[];
  officialToolActionIds?: string[];
  locale?: string;
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
  ) => Promise<boolean | null> | null;
  listCatalog: () => Promise<CatalogApp[]>;
  listInstalledApps: () => AppSummary[];
  checkUpdates: () => Promise<AppSummary[]>;
  createLocalApp: (input: CreateLocalAppInput, locale?: string) => Promise<CreateLocalAppResult>;
  addAppToPersonalAgent?: (input: { agentId: string; appId: string }) => Promise<{ success: boolean; appId: string; alreadyGranted: boolean; userMessage: string; technicalCode?: string }>;
  finishSocialAppInstall: (input: { quarantineId: string }, locale?: string) => Promise<InstallAppResult & { appId?: string }>;
  deleteQuarantinedSocialApp: (input: { quarantineId: string }, locale?: string) => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  recordCreatedApp?: (runId: string, createdApp: ChatCreatedAppRequest) => void;
  registerQuestion: (
    runId: string,
    input: { questions: ChatQuestion[] },
  ) => Promise<ChatQuestionRequest>;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  openApp: (appId: string) => Promise<OpenAppResult>;
  stopApp: (appId: string) => Promise<StopAppResult>;
  restartApp: (appId: string, options?: { onProgress?: (message: string) => void }) => Promise<OpenAppResult>;
  refreshAppView: (appId: string) => Promise<{ success: boolean; userMessage?: string; technicalCode?: string }>;
  updateApp: (appId: string, locale?: string) => Promise<InstallAppResult>;
  listAppPrompts: (appId: string) => Promise<AppPromptReviewItem[]>;
  testAppPrompt: (input: AppPromptTestInput) => Promise<AppPromptTestResult>;
  updateAppPrompt: (input: AppPromptReviewInput) => Promise<AppPromptMutationResult>;
  restoreAppPrompt: (input: AppPromptRestoreInput) => Promise<AppPromptMutationResult>;
  previewAppToolGrant: (
    input: Pick<SetAppToolGrantInput, 'appId' | 'toolId'>,
    locale?: string,
  ) => Promise<AppToolGrantRequestPreview>;
  setAppToolGrant: (input: SetAppToolGrantInput, locale?: string) => Promise<AppToolGrantRequestResult>;
  memoryList: (input: MemoryListInput, access: MemoryAccessInput) => Promise<MemoryEntry[]>;
  memoryCreate: (input: MemoryCreateInput, access: MemoryAccessInput) => Promise<MemoryEntry>;
  memoryUpdate: (input: MemoryUpdateInput, access: MemoryAccessInput) => Promise<MemoryEntry>;
  memoryDelete: (id: string, access: MemoryAccessInput) => Promise<{ success: boolean }>;
  listOfficialToolActionIdsForApp: (appId: string) => Promise<Set<string>>;
  validateOfficialTool: (
    input: CallOfficialToolInput,
    access: { caller: AgentMcpSession['caller']; appId: string; locale?: string },
  ) => Promise<CallOfficialToolResult | null>;
  callOfficialTool: (
    input: CallOfficialToolInput,
    access: { caller: AgentMcpSession['caller']; appId: string; locale?: string },
  ) => Promise<CallOfficialToolResult>;
  getSpeechToTextState: () => Promise<SpeechToTextState>;
  getTextToSpeechState: () => Promise<TextToSpeechState>;
  synthesizeTextToSpeech: (
    input: TextToSpeechSynthesizeInput,
    access: { caller: AgentMcpSession['caller']; appId: string },
  ) => Promise<TextToSpeechSynthesizeResult>;
  processSpeechToText: (
    input: { path: string; task: 'transcribe' | 'translate'; language?: string; model?: string },
    access: { caller: AgentMcpSession['caller']; appId: string },
  ) => Promise<SpeechToTextProcessResult>;
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

interface ForgerMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
}

interface MemoryAccessInput {
  caller: AgentMcpSession['caller'];
  appId?: string;
  appIds?: string[];
  runId?: string;
}

const INTERNAL_MCP_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    id: 'forger_ask_question',
    packageId: 'forger:internal',
    name: 'Hacer preguntas',
    description: 'Registra preguntas estructuradas para que la persona responda antes de continuar.',
    category: 'consulta',
    risk: 'bajo',
    defaultRequiresApproval: false,
  },
];

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
      personalAgentId: access?.personalAgentId,
      appIds: access?.appIds ?? (appId === 'forger' ? [] : [appId]),
      officialToolActionIds: access?.officialToolActionIds ?? [],
      locale: access?.locale,
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
      return { jsonrpc: '2.0', id, result: { tools: await this.getMcpTools(session) } };
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

  private async getMcpTools(session: AgentMcpSession): Promise<ForgerMcpTool[]> {
    const allowedOfficialActions = session.caller === 'app-agent'
      ? await this.options.listOfficialToolActionIdsForApp(session.appId)
      : session.caller === 'personal-agent'
        ? new Set(session.officialToolActionIds)
        : null;
    const tools = this.getAllToolDefinitions().filter((tool) => {
      if (tool.id === 'forger_add_app_to_personal_agent' && session.caller !== 'personal-agent') {
        return false;
      }
      if (!isOfficialTool(tool.id)) {
        return true;
      }
      return allowedOfficialActions ? allowedOfficialActions.has(tool.id) : true;
    }).map((tool) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: getMcpToolInputSchema(tool.id),
      annotations: getMcpToolAnnotations(tool),
    }));
    await this.options.appendInstallLog('agent_tool:mcp_tools_list_built', {
      appId: session.appId,
      runId: session.runId,
      caller: session.caller,
      toolCount: tools.length,
      nativeApprovalMode: 'auto',
      forgerPermissionBroker: true,
      tools: tools.map((tool) => ({
        name: tool.name,
        annotations: tool.annotations,
      })),
    });
    return tools;
  }

  private isAgentToolId(value: unknown): value is AgentToolId {
    return typeof value === 'string' && this.getAllToolDefinitions().some((tool) => tool.id === value);
  }

  private getAllToolDefinitions(): AgentToolDefinition[] {
    return [
      ...this.options.getToolDefinitions(),
      ...INTERNAL_MCP_TOOL_DEFINITIONS,
    ];
  }

  private async ensureToolApproval(
    session: AgentMcpSession,
    tool: AgentToolDefinition,
  ): Promise<ToolApprovalResult> {
    const copy = getSharedCopy(session.locale).agentTools;
    if (isMemoryTool(tool.id) || isInternalMcpTool(tool.id)) {
      return {
        approved: true,
        required: false,
        status: 'not_required',
        userMessage: isMemoryTool(tool.id) ? copy.memoryApprovalNotRequired : copy.approvalNotRequired,
      };
    }
    if (session.caller === 'automation') {
      await this.options.appendInstallLog('agent_tool:approval_skipped', {
        appId: session.appId,
        runId: session.runId,
        toolId: tool.id,
        reason: 'automation_non_interactive',
      });
      return {
        approved: true,
        required: false,
        status: 'not_required',
        userMessage: copy.approvalNotRequired,
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
        userMessage: copy.approvalNotRequired,
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
        userMessage: copy.approvalUnavailable,
      };
    }
    await this.options.appendInstallLog('agent_tool:approval_requested', {
      appId: session.appId,
      runId: session.runId,
      toolId: tool.id,
      toolName: tool.name,
    });
    this.emitToolProgress(session, tool.id, copy.approvalWaiting(tool.name));
    const approved = await requestPermission;
    if (approved === null) {
      return {
        approved: false,
        required: true,
        status: 'unavailable',
        userMessage: copy.approvalUnavailable,
      };
    }
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
      userMessage: approved ? copy.approvalReceived : copy.approvalRejected,
    };
  }

  private async executeAppToolGrantRequest(
    session: AgentMcpSession,
    args: Record<string, unknown>,
  ): Promise<AppToolGrantRequestResult & { authorization?: { required: boolean; status: string; userMessage: string } }> {
    const input = parseAppToolGrantRequestInput(args);
    if (!input) {
      return {
        success: false,
        appId: getToolAppId(session, args),
        userMessage: getAppToolGrantMcpCopy(session.locale).invalidInput,
        technicalCode: 'app_tool_grant_input_invalid',
      };
    }
    if (session.caller === 'personal-agent' && !session.appIds.includes(input.appId)) {
      return {
        success: false,
        appId: input.appId,
        userMessage: getSharedCopy(session.locale).tools.unavailable,
        technicalCode: 'personal_agent_app_not_granted',
      };
    }
    const preview = await this.options.previewAppToolGrant(input, session.locale);
    if (!preview.success) {
      return preview;
    }
    if (preview.alreadyGranted) {
      return {
        ...preview,
        gate: null,
        authorization: {
          required: false,
          status: 'not_required',
          userMessage: getAppToolGrantMcpCopy(session.locale).alreadyGranted,
        },
      };
    }

    const copy = getAppToolGrantMcpCopy(session.locale);
    const displayReason = cleanString(args.reason) || preview.declaration?.reason || preview.tool?.description || '';
    const warning = preview.warning ? ` ${preview.warning}` : '';
    const requestPermission = this.options.requestPermission(session.runId, {
      pluginId: 'forger-app-tools',
      permission: `optional_tool:${input.appId}:${input.toolId}`,
      reason: `${copy.requestBody(preview.appName ?? input.appId, preview.tool?.name ?? input.toolId, displayReason)}${warning}`,
      risk: 'medium',
      resource: copy.requestTitle(preview.tool?.name ?? input.toolId),
    });
    if (!requestPermission) {
      return {
        ...preview,
        success: false,
        userMessage: copy.approvalUnavailable,
        technicalCode: 'permission_unavailable',
        authorization: {
          required: true,
          status: 'unavailable',
          userMessage: copy.approvalUnavailable,
        },
      };
    }
    await this.options.appendInstallLog('agent_tool:app_tool_grant_requested', {
      appId: input.appId,
      runId: session.runId,
      toolId: input.toolId,
      toolName: preview.tool?.name,
      warning: preview.warning ?? null,
    });
    this.emitToolProgress(session, 'forger_request_app_tool_grant', copy.waiting(preview.tool?.name ?? input.toolId));
    const approved = await requestPermission;
    if (!approved) {
      await this.options.appendInstallLog('agent_tool:app_tool_grant_resolved', {
        appId: input.appId,
        runId: session.runId,
        toolId: input.toolId,
        approved,
      });
      return {
        ...preview,
        success: false,
        userMessage: approved === null ? copy.approvalUnavailable : copy.rejected,
        technicalCode: approved === null ? 'permission_unavailable' : 'app_tool_grant_rejected',
        authorization: {
          required: true,
          status: approved === null ? 'unavailable' : 'denied',
          userMessage: approved === null ? copy.approvalUnavailable : copy.rejected,
        },
      };
    }
    const result = await this.options.setAppToolGrant({ ...input, granted: true }, session.locale);
    await this.options.appendInstallLog('agent_tool:app_tool_grant_resolved', {
      appId: input.appId,
      runId: session.runId,
      toolId: input.toolId,
      approved: true,
      warning: result.warning ?? null,
    });
    return {
      ...result,
      authorization: {
        required: true,
        status: 'approved',
        userMessage: copy.approved,
      },
    };
  }

  private async executeAgentTool(
    session: AgentMcpSession,
    toolId: AgentToolId,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const copy = getSharedCopy(session.locale).agentTools;
    const tool = this.getAllToolDefinitions().find((candidate) => candidate.id === toolId);
    if (!tool) {
      await this.options.appendInstallLog('agent_tool:not_found', {
        appId: session.appId,
        runId: session.runId,
        toolId,
        args,
      });
      return { success: false, userMessage: getSharedCopy(session.locale).tools.unavailable, technicalCode: 'tool_not_found' };
    }

    await this.options.appendInstallLog('agent_tool:call_received', {
      appId: session.appId,
      runId: session.runId,
      toolId,
      args,
      requiresApproval: Boolean(this.options.getToolSettings().approvals[tool.id]),
    });

    if (isOfficialTool(toolId)) {
      if (session.caller === 'personal-agent' && !session.officialToolActionIds.includes(toolId)) {
        const result = {
          success: false,
          userMessage: getSharedCopy(session.locale).tools.unavailable,
          technicalCode: 'personal_agent_tool_not_granted',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      const officialToolId = getOfficialToolIdForAction(toolId);
      const validation = await this.options.validateOfficialTool(
        { toolId: officialToolId, actionId: toolId, input: args },
        { caller: session.caller, appId: session.appId, locale: session.locale },
      );
      if (validation) {
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result: validation });
        return validation;
      }
    }

    if (toolId === 'forger_request_app_tool_grant') {
      const result = await this.executeAppToolGrantRequest(session, args);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
    }

    const approval = await this.ensureToolApproval(session, tool);
    if (!approval.approved) {
      await this.options.appendInstallLog('agent_tool:call_cancelled', {
        appId: session.appId,
        runId: session.runId,
        toolId,
        reason: 'forger_permission_denied_or_unavailable',
      });
      return withToolAuthorization(
        {
          success: false,
          userMessage: approval.status === 'unavailable'
            ? copy.approvalDisplayFailed
            : copy.canceledByUser,
          technicalCode: approval.status === 'unavailable' ? 'permission_unavailable' : 'permission_denied',
        },
        approval,
      );
    }

    await this.options.appendInstallLog('agent_tool:call', {
      appId: session.appId,
      toolId,
      runId: session.runId,
    });
    this.emitToolProgress(session, toolId, toolId === 'forger_restart_app' ? copy.restartPreparing : '');

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

    if (toolId === 'forger_create_app') {
      const input = parseCreateLocalAppToolInput(args);
      if (!input) {
        const result = {
          success: false,
          userMessage: 'Completa nombre, descripcion y proposito para crear la app.',
          technicalCode: 'create_app_input_invalid',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.createLocalApp(input, session.locale);
      if (result.success && result.app?.appId) {
        this.options.recordCreatedApp?.(session.runId, {
          appId: result.app.appId,
          name: result.app.name,
          description: result.app.description,
          purpose: result.app.purpose,
          ...(result.app.lookAndFeel ? { lookAndFeel: result.app.lookAndFeel } : {}),
        });
      }
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_add_app_to_personal_agent') {
      const requestedAppId = cleanString(args.appId);
      if (session.caller !== 'personal-agent' || !session.personalAgentId || !this.options.addAppToPersonalAgent) {
        const result = {
          success: false,
          appId: requestedAppId,
          userMessage: 'Esta herramienta solo esta disponible para agentes personales.',
          technicalCode: 'personal_agent_context_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      if (!requestedAppId) {
        const result = {
          success: false,
          appId: '',
          userMessage: 'Indica la app instalada que quieres agregar al agente.',
          technicalCode: 'personal_agent_app_id_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.addAppToPersonalAgent({ agentId: session.personalAgentId, appId: requestedAppId });
      if (result.success && !session.appIds.includes(result.appId)) {
        session.appIds.push(result.appId);
      }
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_finish_social_app_install' || toolId === 'forger_delete_quarantined_social_app') {
      const requestedQuarantineId = cleanString(args.quarantineId) || session.appId;
      if (!session.appId.startsWith('review-') || requestedQuarantineId !== session.appId) {
        const result = {
          success: false,
          userMessage: 'Esta herramienta solo esta disponible desde un chat de revision de app Social.',
          technicalCode: 'social_app_review_context_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = toolId === 'forger_finish_social_app_install'
        ? await this.options.finishSocialAppInstall({ quarantineId: requestedQuarantineId }, session.locale)
        : await this.options.deleteQuarantinedSocialApp({ quarantineId: requestedQuarantineId }, session.locale);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_ask_question') {
      const input = parseQuestionToolInput(args);
      if (!input) {
        const result = {
          success: false,
          userMessage: 'La pregunta necesita entre una y cinco preguntas con dos o tres opciones.',
          technicalCode: 'question_input_invalid',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      try {
        const questionRequest = await this.options.registerQuestion(session.runId, input);
        const result = { success: true, questionRequest };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      } catch (error) {
        const code = error instanceof Error ? error.message : 'question_register_failed';
        const result = {
          success: false,
          userMessage: code === 'active_question_exists'
            ? 'Este chat ya tiene una pregunta pendiente.'
            : 'No pudimos registrar la pregunta para este chat.',
          technicalCode: code,
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
    }

    if (toolId === 'forger_list_app_prompts') {
      const appId = getToolAppId(session, args);
      const prompts = await this.options.listAppPrompts(appId);
      const result = { success: true, prompts };
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_test_app_prompt') {
      const appId = getToolAppId(session, args);
      const kind = parsePromptReviewKind(args.kind);
      if (!kind) {
        const result = { success: false, valid: false, errors: [copy.invalidPromptKind], technicalCode: 'app_prompt_kind_invalid' };
        await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.testAppPrompt({
        appId,
        kind,
        id: String(args.id ?? ''),
        ...(typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
        ...(isPlainRecord(args.variables) ? { variables: args.variables } : {}),
      });
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
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
              ? copy.memoryCreatedGlobal
              : copy.memoryCreatedApp,
          };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
          return result;
        }

        if (toolId === 'memory_update') {
          const memory = await this.options.memoryUpdate(args as unknown as MemoryUpdateInput, memoryAccess(session));
          const result = {
            success: true,
            memory,
            userMessage: copy.memoryUpdated,
          };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
          return result;
        }

        if (toolId === 'memory_delete') {
          const result = await this.options.memoryDelete(String(args.id ?? ''), memoryAccess(session));
          const response = { ...result, userMessage: result.success ? copy.memoryDeleted : copy.memoryNotFound };
          await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result: response });
          return response;
        }
      } catch (error) {
        const result = {
          success: false,
          userMessage: memoryErrorMessage(error, session.locale),
          ...buildFailureDiagnostic({ error, fallbackCode: 'memory_error' }),
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
    }

    if (isOfficialTool(toolId)) {
      const officialToolId = getOfficialToolIdForAction(toolId);
      const result = await this.options.callOfficialTool(
        { toolId: officialToolId, actionId: toolId, input: args },
        { caller: session.caller, appId: session.appId, locale: session.locale },
      );
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_speech_to_text_status') {
      const result = { success: true, state: await this.options.getSpeechToTextState() };
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_text_to_speech_status') {
      const result = { success: true, state: await this.options.getTextToSpeechState() };
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_text_to_speech_voices') {
      const state = await this.options.getTextToSpeechState();
      const result = { success: true, models: state.models, voices: state.voices };
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_synthesize_speech') {
      const text = cleanString(args.text);
      const model = cleanString(args.model);
      const voice = cleanString(args.voice);
      if (!text || !model || !voice) {
        const result = { success: false, userMessage: 'Text, model, and voice are required.', technicalCode: 'text_to_speech_arguments_required' };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.synthesizeTextToSpeech({
        text,
        model,
        voice,
        ...(typeof args.speed === 'number' ? { speed: args.speed } : {}),
        ...(args.format === 'wav' || args.format === 'mp3' || args.format === 'opus' ? { format: args.format } : {}),
      }, { caller: session.caller, appId: session.appId });
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_transcribe_audio' || toolId === 'forger_translate_audio') {
      const audioPath = cleanString(args.path);
      if (!audioPath) {
        const result = { success: false, userMessage: 'Audio path is required.', technicalCode: 'speech_audio_path_required' };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.processSpeechToText(
        {
          path: audioPath,
          task: toolId === 'forger_translate_audio' ? 'translate' : 'transcribe',
          ...(typeof args.language === 'string' && args.language.trim() ? { language: args.language.trim() } : {}),
          ...(typeof args.model === 'string' && args.model.trim() ? { model: args.model.trim() } : {}),
        },
        { caller: session.caller, appId: session.appId },
      );
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    const appId = getToolAppId(session, args);
    if (session.caller === 'personal-agent' && isAppScopedTool(toolId) && !session.appIds.includes(appId)) {
      const result = {
        success: false,
        userMessage: getSharedCopy(session.locale).tools.unavailable,
        technicalCode: 'personal_agent_app_not_granted',
      };
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

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
      const result = await this.options.updateApp(appId, session.locale);
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_update_app_prompt') {
      const kind = parsePromptReviewKind(args.kind);
      if (!kind) {
        const result = { success: false, userMessage: copy.invalidPromptKind, technicalCode: 'app_prompt_kind_invalid' };
        await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.updateAppPrompt({
        appId,
        kind,
        id: String(args.id ?? ''),
        prompt: String(args.prompt ?? ''),
        ...parsePromptRuntimeOverride(args),
      });
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_restore_app_prompt') {
      const kind = parsePromptReviewKind(args.kind);
      if (!kind) {
        const result = { success: false, userMessage: copy.invalidPromptKind, technicalCode: 'app_prompt_kind_invalid' };
        await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = await this.options.restoreAppPrompt({
        appId,
        kind,
        id: String(args.id ?? ''),
      });
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    const result = { success: false, userMessage: getSharedCopy(session.locale).tools.unavailable, technicalCode: 'tool_not_found' };
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

const isMemoryTool = (toolId: AgentToolId): boolean => toolId.startsWith('memory_');

const OFFICIAL_TOOL_ACTION_PREFIXES: Record<string, string> = {
  'gmail.': 'gmail',
  'forger_chrome_extension.': 'forger_chrome_extension',
  'whatsapp.': 'whatsapp',
};

const isOfficialTool = (toolId: AgentToolId): boolean =>
  Object.keys(OFFICIAL_TOOL_ACTION_PREFIXES).some((prefix) => toolId.startsWith(prefix));

const getOfficialToolIdForAction = (toolId: AgentToolId): string => {
  for (const [prefix, officialToolId] of Object.entries(OFFICIAL_TOOL_ACTION_PREFIXES)) {
    if (toolId.startsWith(prefix)) {
      return officialToolId;
    }
  }
  return toolId;
};

const isInternalMcpTool = (toolId: AgentToolId): boolean => toolId === 'forger_ask_question';

const APP_SCOPED_TOOLS = new Set<AgentToolId>([
  'forger_request_app_tool_grant',
  'forger_list_app_prompts',
  'forger_test_app_prompt',
  'forger_update_app_prompt',
  'forger_restore_app_prompt',
  'forger_get_app_runtime_status',
  'forger_open_app',
  'forger_stop_app',
  'forger_restart_app',
  'forger_refresh_app_view',
  'forger_update_app',
  'forger_finish_social_app_install',
  'forger_delete_quarantined_social_app',
]);

const isAppScopedTool = (toolId: AgentToolId): boolean => APP_SCOPED_TOOLS.has(toolId);

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const parseAppToolGrantRequestInput = (
  args: Record<string, unknown>,
): Pick<SetAppToolGrantInput, 'appId' | 'toolId'> | null => {
  const appId = cleanString(args.appId);
  const toolId = cleanString(args.toolId);
  if (!appId || !toolId) {
    return null;
  }
  return { appId, toolId };
};

const getAppToolGrantMcpCopy = (locale?: string) => {
  const isEnglish = locale?.toLowerCase().startsWith('en');
  return isEnglish
    ? {
      invalidInput: 'Choose the installed app and optional official tool to allow.',
      alreadyGranted: 'This optional tool is already allowed for the app.',
      requestTitle: (toolName: string) => `Forger wants to activate this optional tool in this app: ${toolName}`,
      requestBody: (appName: string, toolName: string, reason: string) =>
        `Forger quiere activar esta herramienta opcional en esta aplicación: permitir / no. App: ${appName}. Tool: ${toolName}.${reason ? ` Reason: ${reason}.` : ''}`,
      waiting: (toolName: string) => `Waiting for permission to activate ${toolName} for this app...`,
      approved: 'The optional tool was allowed for this app.',
      rejected: 'The optional tool was not allowed for this app.',
      approvalUnavailable: 'Could not show the optional tool approval prompt.',
    }
    : {
      invalidInput: 'Elige la app instalada y la herramienta oficial opcional que quieres permitir.',
      alreadyGranted: 'Esta herramienta opcional ya esta permitida para la app.',
      requestTitle: (toolName: string) => `Forger quiere activar esta herramienta opcional en esta aplicación: ${toolName}`,
      requestBody: (appName: string, toolName: string, reason: string) =>
        `Forger quiere activar esta herramienta opcional en esta aplicación: permitir / no. App: ${appName}. Herramienta: ${toolName}.${reason ? ` Motivo: ${reason}.` : ''}`,
      waiting: (toolName: string) => `Esperando permiso para activar ${toolName} en esta app...`,
      approved: 'La herramienta opcional quedo permitida para esta app.',
      rejected: 'La herramienta opcional no fue permitida para esta app.',
      approvalUnavailable: 'No se pudo mostrar la aprobacion de herramienta opcional.',
    };
};

const parseCreateLocalAppToolInput = (args: Record<string, unknown>): Required<Pick<CreateLocalAppInput, 'name' | 'description' | 'purpose'>> & Pick<CreateLocalAppInput, 'lookAndFeel'> | null => {
  const name = cleanString(args.name);
  const description = cleanString(args.description);
  const purpose = cleanString(args.purpose);
  const lookAndFeel = cleanString(args.lookAndFeel);
  if (!name || !description || !purpose) {
    return null;
  }
  return {
    name,
    description,
    purpose,
    ...(lookAndFeel ? { lookAndFeel } : {}),
  };
};

const parseQuestionToolInput = (args: Record<string, unknown>): { questions: ChatQuestion[] } | null => {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 5) {
    return null;
  }

  const questionIds = new Set<string>();
  const questions: ChatQuestion[] = [];
  for (const rawQuestion of args.questions) {
    if (!isPlainRecord(rawQuestion)) {
      return null;
    }
    const id = cleanString(rawQuestion.id);
    const question = cleanString(rawQuestion.question);
    if (!id || !question || questionIds.has(id) || !Array.isArray(rawQuestion.options) || rawQuestion.options.length < 2 || rawQuestion.options.length > 3) {
      return null;
    }
    questionIds.add(id);
    const optionIds = new Set<string>();
    const options = [];
    for (const rawOption of rawQuestion.options) {
      if (!isPlainRecord(rawOption)) {
        return null;
      }
      const optionId = cleanString(rawOption.id);
      const label = cleanString(rawOption.label);
      const description = cleanString(rawOption.description);
      if (!optionId || !label || !description || optionIds.has(optionId)) {
        return null;
      }
      optionIds.add(optionId);
      options.push({ id: optionId, label, description });
    }
    questions.push({ id, question, options });
  }
  return { questions };
};

const parsePromptReviewKind = (value: unknown): 'promptTemplate' | 'agent' | 'agentPrompt' | null => {
  if (value === 'promptTemplate' || value === 'agent' || value === 'agentPrompt') {
    return value;
  }
  return null;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const parsePromptRuntimeOverride = (
  args: Record<string, unknown>,
): Pick<AppPromptReviewInput, 'runtime' | 'provider' | 'model' | 'effort' | 'reasoningEffort'> => {
  const runtime = parseAgentRuntime(args.runtime);
  const provider = parseAgentProvider(args.provider);
  const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
  const effort = parseAgentEffort(args.effort);
  const reasoningEffort = parseCodexReasoningEffort(args.reasoningEffort);
  return {
    ...(runtime ? { runtime } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
};

const parseAgentRuntime = (value: unknown): AgentRuntime | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = parseAgentProvider(record.provider);
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : undefined;
  const effort = parseAgentEffort(record.effort);
  if (!provider || !model || !effort) {
    return undefined;
  }
  return { provider, model, effort };
};

const parseAgentProvider = (value: unknown): 'codex' | 'claude' | undefined =>
  value === 'codex' || value === 'claude' ? value : undefined;

const parseAgentEffort = (value: unknown): AgentRuntime['effort'] | undefined =>
  value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
    ? value
    : undefined;

const parseCodexReasoningEffort = (value: unknown): AppPromptReviewInput['reasoningEffort'] | undefined =>
  value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined;

const memoryAccess = (session: AgentMcpSession): MemoryAccessInput => ({
  caller: session.caller,
  appId: session.appId === 'forger' ? undefined : session.appId,
  appIds: session.appIds,
  runId: session.runId,
});

const memoryErrorMessage = (error: unknown, locale?: string): string => {
  const copy = getSharedCopy(locale).agentTools;
  const code = error instanceof Error ? error.message : 'memory_error';
  if (code === 'memory_scope_forbidden') {
    return copy.memoryScopeForbidden;
  }
  if (code === 'memory_text_required') {
    return copy.memoryTextRequired;
  }
  if (code === 'memory_app_required') {
    return copy.memoryAppRequired;
  }
  if (code === 'memory_not_found') {
    return copy.memoryNotFound;
  }
  return copy.memoryOperationFailed;
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
