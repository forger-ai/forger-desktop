import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentToolDefinition, AgentToolId,
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
  CallConnectionActionInput,
  CallConnectionActionResult,
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConnectionSessionGrant,
  ConnectionsState,
  MemoryCreateInput,
  MemoryEntry,
  MemoryListInput,
  MemoryUpdateInput,
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
  Workflow,
  WorkflowApplyInput,
  WorkflowReviewReport,
  WorkflowRunSummary,
  WorkflowUpsertInput,
  AutomationFrequency,
  PersonalAgentPeerGrant,
  PersonalAgentPeerThread,
  PersonalAgentRoutine,
  PersonalAgentScheduledWakeup,
  SocialUserApp,
} from '../shared/types';
import type { PersonalAgentAskPeerInput, PersonalAgentAskPeerResult } from './personal-agents/agent-conversation-manager';
import { buildFailureDiagnostic } from '../shared/error-diagnostics';
import { getSharedCopy } from '../shared/i18n';
import { getMcpToolAnnotations, getMcpToolInputSchema, type McpToolAnnotations } from './forger-mcp/tool-metadata';
import {
  getChromeAppRuntimeUrlBlock,
  INTERNAL_MCP_TOOL_DEFINITIONS,
  PERSONAL_AGENT_PEER_TOOL_IDS,
  PERSONAL_AGENT_ROUTINE_TOOL_IDS,
  WORKFLOW_MANAGEMENT_TOOL_IDS,
  SIDEKICK_VOICE_TOOL_IDS,
  WORKFLOW_NODE_TOOL_IDS,
} from './forger-mcp/internal-tools';
import {
  executeConnectionManagementTool,
  getEffectiveConnectionGrants,
} from './forger-mcp/connection-tools';
import { executePersonalAgentRoutineTool } from './forger-mcp/personal-agent-routine-tools';
import { canUsePersonalAgentSpawnTool, executePersonalAgentSpawnTool, type PersonalAgentSpawnToolOptions } from './forger-mcp/personal-agent-spawn-tool';
import { executeWorkflowManagementTool } from './forger-mcp/workflow-management-tools';
import {
  cleanString,
  connectionActionGranted,
  getAppToolGrantMcpCopy,
  getBearerToken,
  getOfficialToolIdForAction,
  getToolAppId,
  isAppScopedTool,
  isConnectionAction,
  isConnectionManagementTool,
  isInternalMcpTool,
  isMemoryTool,
  isOfficialTool,
  isPlainRecord,
  memoryAccess,
  memoryErrorMessage,
  parseAppToolGrantRequestInput,
  parseCreateLocalAppToolInput,
  parsePublishedAppInfoUpdateInput,
  parsePromptReviewKind,
  parsePromptRuntimeOverride,
  parseQuestionToolInput,
  type PublishedAppInfoUpdateInput,
  readRequestBody,
  sendMcpJson,
  toConnectionCallInput,
  withToolAuthorization,
} from './forger-mcp-server-helpers';
export interface ForgerMcpSessionRef {
  url: string;
  token: string;
}
export interface AgentMcpSession {
  runId: string;
  appId: string;
  caller: 'desktop-chat' | 'app-agent' | 'automation' | 'free-chat' | 'personal-agent' | 'workflow';
  personalAgentId?: string;
  personalAgentConversationId?: string;
  personalAgentPeerThreadId?: string;
  personalAgentCallStackIds?: string[];
  personalAgentCanSpawnAgents?: boolean;
  /** Present only for runs originated by a Sidekick voice turn. */
  sidekick?: { sidekickId: string };
  appIds: string[];
  officialToolActionIds: string[];
  forgerToolActionIds: string[];
  connectionGrants: ConnectionSessionGrant[];
  locale?: string;
  token: string;
  createdAt: string;
}
export interface ForgerMcpSessionAccess {
  caller: AgentMcpSession['caller'];
  personalAgentId?: string;
  personalAgentConversationId?: string;
  personalAgentPeerThreadId?: string;
  personalAgentCallStackIds?: string[];
  personalAgentCanSpawnAgents?: boolean;
  sidekick?: { sidekickId: string };
  appIds?: string[];
  officialToolActionIds?: string[];
  forgerToolActionIds?: string[];
  connectionGrants?: ConnectionSessionGrant[];
  locale?: string;
}
interface ForgerMcpServerOptions extends PersonalAgentSpawnToolOptions {
  getAppVersion: () => string;
  getToolDefinitions: () => AgentToolDefinition[];
  getConnectionToolDefinitions?: () => Promise<AgentToolDefinition[]>;
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
  listInstalledApps: () => Array<AppSummary & { path?: string }>;
  checkUpdates: () => Promise<AppSummary[]>;
  createLocalApp: (input: CreateLocalAppInput, locale?: string) => Promise<CreateLocalAppResult>;
  updatePublishedAppInfo?: (
    input: PublishedAppInfoUpdateInput,
    locale?: string,
  ) => Promise<{ success: boolean; userMessage: string; app?: SocialUserApp; technicalCode?: string }>;
  addAppToPersonalAgent?: (input: { agentId: string; appId: string }) => Promise<{ success: boolean; appId: string; alreadyGranted: boolean; userMessage: string; technicalCode?: string }>;
  schedulePersonalAgentWakeup?: (input: { agentId: string; conversationId: string; runId: string; seconds: number; prompt: string }) => Promise<PersonalAgentScheduledWakeup>;
  cancelPersonalAgentWakeup?: (input: { wakeupId?: string; conversationId?: string }) => Promise<PersonalAgentScheduledWakeup | null>;
  createAgentRoutine?: (input: {
    agentId: string;
    name: string;
    prompt: string;
    frequency: AutomationFrequency;
    missedRunPolicy?: 'skip' | 'always' | 'within_window';
    missedRunWindowMinutes?: number;
    enabled?: boolean;
    authorizationText: string;
  }) => Promise<PersonalAgentRoutine>;
  listAgentRoutines?: (input: { agentId: string }) => Promise<PersonalAgentRoutine[]>;
  updateAgentRoutine?: (input: {
    agentId: string;
    routineId: string;
    name: string;
    prompt: string;
    frequency: AutomationFrequency;
    missedRunPolicy?: 'skip' | 'always' | 'within_window';
    missedRunWindowMinutes?: number;
    enabled?: boolean;
    authorizationText: string;
  }) => Promise<PersonalAgentRoutine>;
  deleteAgentRoutine?: (input: { agentId: string; routineId: string; authorizationText: string }) => Promise<{ success: boolean }>;
  listAgentPeers?: (input: { agentId: string }) => Promise<{ success: boolean; peers: PersonalAgentPeerGrant[]; recentThreads?: PersonalAgentPeerThread[] }>;
  askAgent?: (input: PersonalAgentAskPeerInput) => Promise<PersonalAgentAskPeerResult>;
  readAgentThread?: (input: { agentId: string; threadId: string }) => Promise<{ success: boolean; thread?: PersonalAgentPeerThread; userMessage?: string; technicalCode?: string }>;
  finishSocialAppInstall: (input: { quarantineId: string }, locale?: string) => Promise<InstallAppResult & { appId?: string }>;
  deleteQuarantinedSocialApp: (input: { quarantineId: string }, locale?: string) => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  recordCreatedApp?: (runId: string, createdApp: ChatCreatedAppRequest) => void;
  registerQuestion: (
    runId: string,
    input: { questions: ChatQuestion[] },
  ) => Promise<ChatQuestionRequest>;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  getAppViewSnapshot: (appId: string, input: { selector?: string; includeHtml?: boolean; maxChars?: number }) => Promise<Record<string, unknown>>;
  getAppRuntimeDiagnostics: (appId: string, input: { recentLines?: number }) => Promise<Record<string, unknown>>;
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
  listConnectionGrantsForApp: (appId: string) => Promise<ConnectionSessionGrant[]>;
  listConnectionsForSession: (grants: ConnectionSessionGrant[]) => Promise<ConnectionsState & { grants: ConnectionSessionGrant[] }>;
  callConnectionFromSession: (
    input: CallConnectionActionInput,
    grants: ConnectionSessionGrant[],
    access: { caller: AgentMcpSession['caller']; appId: string; locale?: string },
  ) => Promise<CallConnectionActionResult>;
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
  workflowGetNodeContext?: (nodeRunKey: string) => Record<string, unknown> | null;
  workflowCompleteNode?: (
    nodeRunKey: string,
    args: { output?: unknown; summary?: unknown },
  ) => { success: boolean; errors?: string[]; technicalCode?: string };
  workflowFailNode?: (
    nodeRunKey: string,
    args: { reason?: unknown },
  ) => { success: boolean; technicalCode?: string };
  resolveSidekickVoiceOutcome?: (input: {
    sidekickId: string;
    conversationId: string;
    runId: string;
    mode: 'end' | 'wait';
    text: string;
  }) => { accepted: boolean };
  workflowsList?: () => Workflow[];
  workflowsGet?: (workflowId: string) => Workflow | null;
  workflowsUpsert?: (input: WorkflowUpsertInput) => Promise<Workflow>;
  workflowsReview?: (workflowId: string) => Promise<WorkflowReviewReport>;
  workflowsApply?: (workflowId: string, input: WorkflowApplyInput) => Promise<Workflow>;
  workflowsRun?: (workflowId: string) => Promise<WorkflowRunSummary>;
  isWorkflowsEnabled?: () => boolean;
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
export interface ToolApprovalResult {
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
export interface MemoryAccessInput {
  caller: AgentMcpSession['caller'];
  appId?: string;
  appIds?: string[];
  runId?: string;
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
    const server = this.server;
    server?.close();
    server?.closeIdleConnections?.();
    server?.closeAllConnections?.();
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
      personalAgentConversationId: access?.personalAgentConversationId,
      personalAgentPeerThreadId: access?.personalAgentPeerThreadId,
      personalAgentCallStackIds: access?.personalAgentCallStackIds,
      personalAgentCanSpawnAgents: access?.personalAgentCanSpawnAgents,
      sidekick: access?.sidekick,
      appIds: access?.appIds ?? (appId === 'forger' ? [] : [appId]),
      officialToolActionIds: access?.officialToolActionIds ?? [],
      forgerToolActionIds: access?.forgerToolActionIds ?? access?.officialToolActionIds ?? [],
      connectionGrants: access?.connectionGrants ?? [],
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
    const argumentCount = params?.arguments
      && typeof params.arguments === 'object'
      && !Array.isArray(params.arguments)
      ? Object.keys(params.arguments).length
      : 0;
    await this.options.appendInstallLog('agent_tool:mcp_tools_call_received', {
      appId: session.appId,
      runId: session.runId,
      id,
      toolName,
      argumentCount,
    });
    const allToolDefinitions = await this.getAllToolDefinitions();
    if (typeof toolName !== 'string' || !allToolDefinitions.some((tool) => tool.id === toolName)) {
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
      const result = await this.executeAgentTool(session, toolName as AgentToolId, args, allToolDefinitions);
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
      : session.caller === 'personal-agent' || session.caller === 'workflow'
        ? new Set(session.forgerToolActionIds)
        : null;
    const connectionGrants = await getEffectiveConnectionGrants(session, this.options);
    const allowedConnectionActions = new Set(connectionGrants.flatMap((grant) => grant.actions));
    const allToolDefinitions = await this.getAllToolDefinitions();
    const tools = allToolDefinitions.filter((tool) => {
      if (WORKFLOW_MANAGEMENT_TOOL_IDS.has(tool.id) && !this.isWorkflowsEnabled()) {
        return false;
      }
      if (tool.id === 'forger_add_app_to_personal_agent' && session.caller !== 'personal-agent') {
        return false;
      }
      if (tool.id === 'forger_create_personal_agent' && !canUsePersonalAgentSpawnTool(session)) {
        return false;
      }
      if (PERSONAL_AGENT_PEER_TOOL_IDS.has(tool.id) && (session.caller !== 'personal-agent' || !session.personalAgentId || !session.personalAgentConversationId)) {
        return false;
      }
      if (PERSONAL_AGENT_ROUTINE_TOOL_IDS.has(tool.id) && (session.caller !== 'personal-agent' || !session.personalAgentId || !session.personalAgentConversationId)) {
        return false;
      }
      if (WORKFLOW_NODE_TOOL_IDS.has(tool.id) && session.caller !== 'workflow') {
        return false;
      }
      if (SIDEKICK_VOICE_TOOL_IDS.has(tool.id) && (session.caller !== 'personal-agent' || !session.sidekick || !session.personalAgentConversationId)) {
        return false;
      }
      if (WORKFLOW_MANAGEMENT_TOOL_IDS.has(tool.id) && (session.caller === 'workflow' || session.caller === 'app-agent')) {
        return false;
      }
      if (isConnectionAction(tool.id)) {
        return allowedConnectionActions.has(tool.id);
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

  private async getAllToolDefinitions(): Promise<AgentToolDefinition[]> {
    const connectionTools = await (this.options.getConnectionToolDefinitions?.() ?? Promise.resolve([]))
      .catch(() => []);
    const byId = new Map<AgentToolId, AgentToolDefinition>();
    for (const tool of [
      ...this.options.getToolDefinitions(),
      ...INTERNAL_MCP_TOOL_DEFINITIONS,
      ...connectionTools,
    ]) {
      byId.set(tool.id, tool);
    }
    return [...byId.values()];
  }

  private async ensureToolApproval(
    session: AgentMcpSession,
    tool: AgentToolDefinition,
  ): Promise<ToolApprovalResult> {
    const copy = getSharedCopy(session.locale).agentTools;
    const requiresApproval = this.options.getToolSettings().approvals[tool.id] ?? tool.defaultRequiresApproval;
    if (isMemoryTool(tool.id) || isInternalMcpTool(tool.id)) {
      return {
        approved: true,
        required: false,
        status: 'not_required',
        userMessage: isMemoryTool(tool.id) ? copy.memoryApprovalNotRequired : copy.approvalNotRequired,
      };
    }
    if (session.caller === 'automation' || session.caller === 'workflow') {
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
    if (!requiresApproval) {
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
    allToolDefinitions?: AgentToolDefinition[],
  ): Promise<unknown> {
    const copy = getSharedCopy(session.locale).agentTools;
    const tool = (allToolDefinitions ?? await this.getAllToolDefinitions()).find((candidate) => candidate.id === toolId);
    if (!tool) {
      await this.options.appendInstallLog('agent_tool:not_found', {
        appId: session.appId,
        runId: session.runId,
        toolId,
        argumentCount: Object.keys(args).length,
      });
      return { success: false, userMessage: getSharedCopy(session.locale).tools.unavailable, technicalCode: 'tool_not_found' };
    }

    await this.options.appendInstallLog('agent_tool:call_received', {
      appId: session.appId,
      runId: session.runId,
      toolId,
      argumentCount: Object.keys(args).length,
      requiresApproval: this.options.getToolSettings().approvals[tool.id] ?? tool.defaultRequiresApproval,
    });

    if (WORKFLOW_MANAGEMENT_TOOL_IDS.has(toolId) && !this.isWorkflowsEnabled()) {
      const result = { success: false, technicalCode: 'workflow_feature_disabled' };
      await this.options.appendInstallLog('agent_tool:call_result', {
        appId: session.appId,
        runId: session.runId,
        toolId,
        result,
      });
      return result;
    }

    if (isOfficialTool(toolId)) {
      if ((session.caller === 'personal-agent' || session.caller === 'workflow') && !session.forgerToolActionIds.includes(toolId)) {
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
      const runtimeUrlBlock = getChromeAppRuntimeUrlBlock({
        appId: session.appId,
        toolId,
        targetUrl: cleanString(args.url),
        status: this.options.getRuntimeStatus(session.appId),
      });
      if (runtimeUrlBlock) {
        await this.options.appendInstallLog('agent_tool:chrome_app_url_blocked', {
          appId: session.appId,
          runId: session.runId,
          toolId,
          url: cleanString(args.url),
          blockedRuntimeUrl: runtimeUrlBlock.blockedRuntimeUrl,
        });
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result: runtimeUrlBlock });
        return runtimeUrlBlock;
      }
    }

    if (isConnectionAction(toolId)) {
      const grants = await getEffectiveConnectionGrants(session, this.options);
      if (!connectionActionGranted(grants, toolId)) {
        const result = {
          success: false,
          userMessage: getSharedCopy(session.locale).tools.unavailable,
          technicalCode: 'connection_action_not_granted',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
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

    if (isConnectionManagementTool(toolId)) {
      const result = await executeConnectionManagementTool(session, toolId, args, this.options);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

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

    if (toolId === 'forger_update_published_app_info') {
      const input = parsePublishedAppInfoUpdateInput(args);
      if (!input) {
        const result = {
          success: false,
          userMessage: 'Indica la app publicada y al menos un campo de informacion para actualizar.',
          technicalCode: 'published_app_info_input_invalid',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return withToolAuthorization(result, approval);
      }
      const result = this.options.updatePublishedAppInfo
        ? await this.options.updatePublishedAppInfo(input, session.locale)
        : {
            success: false,
            userMessage: 'No pudimos actualizar la informacion publicada de esta app.',
            technicalCode: 'published_app_info_update_unavailable',
          };
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

    if (toolId === 'forger_create_personal_agent') {
      const result = await executePersonalAgentSpawnTool(session, args, this.options);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
    }

    if (PERSONAL_AGENT_ROUTINE_TOOL_IDS.has(toolId)) {
      const result = await executePersonalAgentRoutineTool(session, toolId, args, this.options);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
    }

    if (toolId === 'forger_list_agent_peers') {
      if (session.caller !== 'personal-agent' || !session.personalAgentId || !this.options.listAgentPeers) {
        const result = {
          success: false,
          userMessage: 'Esta herramienta solo esta disponible para agentes personales.',
          technicalCode: 'personal_agent_context_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      const result = await this.options.listAgentPeers({ agentId: session.personalAgentId });
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
    }

    if (toolId === 'forger_ask_agent') {
      if (session.caller !== 'personal-agent' || !session.personalAgentId || !session.personalAgentConversationId || !this.options.askAgent) {
        const result = {
          success: false,
          userMessage: 'Esta herramienta solo esta disponible dentro de una conversacion de agente personal.',
          technicalCode: 'personal_agent_context_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      const message = cleanString(args.message);
      const targetAgentId = cleanString(args.targetAgentId);
      const threadId = cleanString(args.threadId);
      if (!message || (!targetAgentId && !threadId)) {
        const result = {
          success: false,
          userMessage: 'Indica un mensaje y un targetAgentId o threadId.',
          technicalCode: 'personal_agent_peer_input_invalid',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      const result = await this.options.askAgent({
        callerAgentId: session.personalAgentId,
        callerConversationId: session.personalAgentConversationId,
        callerRunId: session.runId,
        callStackAgentIds: session.personalAgentCallStackIds,
        ...(targetAgentId ? { targetAgentId } : {}),
        ...(threadId ? { threadId } : {}),
        message,
      });
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
    }

    if (toolId === 'forger_read_agent_thread') {
      if (session.caller !== 'personal-agent' || !session.personalAgentId || !this.options.readAgentThread) {
        const result = {
          success: false,
          userMessage: 'Esta herramienta solo esta disponible para agentes personales.',
          technicalCode: 'personal_agent_context_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      const threadId = cleanString(args.threadId);
      if (!threadId) {
        const result = {
          success: false,
          userMessage: 'Indica el threadId a leer.',
          technicalCode: 'personal_agent_peer_thread_id_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
        return result;
      }
      const result = await this.options.readAgentThread({ agentId: session.personalAgentId, threadId });
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
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

    if (SIDEKICK_VOICE_TOOL_IDS.has(toolId)) {
      const text = cleanString(args.text);
      if (
        session.caller !== 'personal-agent' || !session.sidekick ||
        !session.personalAgentConversationId
      ) {
        const result = {
          success: false,
          accepted: false,
          technicalCode: 'sidekick_voice_context_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', {
          appId: session.appId, runId: session.runId, toolId, result,
        });
        return result;
      }
      if (!text) {
        const result = {
          success: false,
          accepted: false,
          technicalCode: 'sidekick_voice_response_text_required',
        };
        await this.options.appendInstallLog('agent_tool:call_result', {
          appId: session.appId, runId: session.runId, toolId, result,
        });
        return result;
      }
      if (text.length > 4_000) {
        const result = {
          success: false,
          accepted: false,
          userMessage: 'La respuesta de voz supera el largo permitido.',
          technicalCode: 'sidekick_voice_response_text_too_long',
        };
        await this.options.appendInstallLog('agent_tool:call_result', {
          appId: session.appId, runId: session.runId, toolId, result,
        });
        return result;
      }
      const mode = toolId === 'respond_and_wait' ? 'wait' as const : 'end' as const;
      const outcome = this.options.resolveSidekickVoiceOutcome?.({
        sidekickId: session.sidekick.sidekickId,
        conversationId: session.personalAgentConversationId,
        runId: session.runId,
        mode,
        text,
      }) ?? { accepted: false };
      const result = outcome.accepted
        ? { success: true, accepted: true, mode }
        : {
            success: false,
            accepted: false,
            technicalCode: 'sidekick_voice_outcome_not_pending',
          };
      await this.options.appendInstallLog('agent_tool:call_result', {
        appId: session.appId, runId: session.runId, toolId, result,
      });
      return result;
    }

    if (WORKFLOW_NODE_TOOL_IDS.has(toolId)) {
      const result = this.executeWorkflowNodeTool(session, toolId, args);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return result;
    }

    if (WORKFLOW_MANAGEMENT_TOOL_IDS.has(toolId)) {
      const result = await executeWorkflowManagementTool(session, toolId, args, this.options);
      await this.options.appendInstallLog('agent_tool:call_result', { appId: session.appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
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

    if (isConnectionAction(toolId)) {
      const grants = await getEffectiveConnectionGrants(session, this.options);
      const result = await this.options.callConnectionFromSession(
        toConnectionCallInput(toolId, args),
        grants,
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

    if (toolId === 'forger_get_app_view_snapshot') {
      const result = await this.options.getAppViewSnapshot(appId, {
        ...(cleanString(args.selector) ? { selector: cleanString(args.selector) } : {}),
        ...(typeof args.includeHtml === 'boolean' ? { includeHtml: args.includeHtml } : {}),
        ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
      });
      await this.options.appendInstallLog('agent_tool:call_result', { appId, runId: session.runId, toolId, result });
      return withToolAuthorization(result, approval);
    }

    if (toolId === 'forger_get_app_runtime_diagnostics') {
      const result = await this.options.getAppRuntimeDiagnostics(appId, {
        ...(typeof args.recentLines === 'number' ? { recentLines: args.recentLines } : {}),
      });
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

  private executeWorkflowNodeTool(
    session: AgentMcpSession,
    toolId: AgentToolId,
    args: Record<string, unknown>,
  ): unknown {
    if (session.caller !== 'workflow') {
      return {
        success: false,
        userMessage: 'Esta herramienta solo esta disponible dentro de un nodo de flujo.',
        technicalCode: 'workflow_node_context_required',
      };
    }
    if (toolId === 'workflow_get_context') {
      const context = this.options.workflowGetNodeContext?.(session.runId) ?? null;
      if (!context) {
        return { success: false, technicalCode: 'workflow_node_context_not_found' };
      }
      return { success: true, context };
    }
    if (toolId === 'workflow_complete_node') {
      const result = this.options.workflowCompleteNode?.(session.runId, {
        output: args.output,
        summary: args.summary,
      }) ?? { success: false, technicalCode: 'workflow_manager_unavailable' };
      if (!result.success && result.errors) {
        return {
          ...result,
          userMessage: `El output no cumple el esquema esperado: ${result.errors.join('; ')}. Corrige el output y vuelve a llamar workflow_complete_node.`,
        };
      }
      return result;
    }
    const result = this.options.workflowFailNode?.(session.runId, { reason: args.reason })
      ?? { success: false, technicalCode: 'workflow_manager_unavailable' };
    return result;
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

  private isWorkflowsEnabled(): boolean {
    return this.options.isWorkflowsEnabled?.() ?? true;
  }
}
