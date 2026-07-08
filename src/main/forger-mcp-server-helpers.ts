import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AgentRuntime,
  AgentToolId,
  AppPromptReviewInput,
  CallConnectionActionInput,
  ChatQuestion,
  ConnectionSessionGrant,
  CreateLocalAppInput,
  SetAppToolGrantInput,
} from '../shared/types';
import { getSharedCopy } from '../shared/i18n';
import { CONNECTION_ACTION_PREFIXES, connectionTypeForActionId } from '../shared/connection-catalog';
import type { AgentMcpSession, MemoryAccessInput, ToolApprovalResult } from './forger-mcp-server';

export const isMemoryTool = (toolId: AgentToolId): boolean => toolId.startsWith('memory_');

const OFFICIAL_TOOL_ACTION_PREFIXES: Record<string, string> = {
  'forger_chrome_extension.': 'forger_chrome_extension',
};

export const isOfficialTool = (toolId: AgentToolId): boolean =>
  Object.keys(OFFICIAL_TOOL_ACTION_PREFIXES).some((prefix) => toolId.startsWith(prefix));

export const isConnectionAction = (toolId: AgentToolId): boolean =>
  Object.keys(CONNECTION_ACTION_PREFIXES).some((prefix) => toolId.startsWith(prefix));

export const isConnectionManagementTool = (toolId: AgentToolId): boolean =>
  toolId === 'forger_connection_list' ||
  toolId === 'forger_connection_status';

export const getOfficialToolIdForAction = (toolId: AgentToolId): string => {
  for (const [prefix, officialToolId] of Object.entries(OFFICIAL_TOOL_ACTION_PREFIXES)) {
    if (toolId.startsWith(prefix)) {
      return officialToolId;
    }
  }
  return toolId;
};

const getConnectionTypeForAction = (toolId: string): string | null => {
  return connectionTypeForActionId(toolId) || null;
};

export const dedupeConnectionGrants = (grants: ConnectionSessionGrant[]): ConnectionSessionGrant[] => {
  const byType = new Map<string, ConnectionSessionGrant>();
  for (const grant of grants) {
    const existing = byType.get(grant.type);
    byType.set(grant.type, existing
      ? {
          type: grant.type,
          actions: [...new Set([...existing.actions, ...grant.actions])],
          multiple: existing.multiple || grant.multiple,
          ...(existing.connectionIds ?? grant.connectionIds ? { connectionIds: [...new Set([...(existing.connectionIds ?? []), ...(grant.connectionIds ?? [])])] } : {}),
        }
      : grant);
  }
  return [...byType.values()];
};

export const connectionActionGranted = (grants: ConnectionSessionGrant[], actionId: string): boolean =>
  grants.some((grant) => grant.actions.includes(actionId));

export const toConnectionCallInput = (
  actionId: AgentToolId,
  args: Record<string, unknown>,
): CallConnectionActionInput => {
  const type = getConnectionTypeForAction(actionId) ?? '';
  const connectionId = cleanString(args.connectionId);
  const input = { ...args };
  delete input.connectionId;
  return {
    type,
    actionId,
    input,
    ...(connectionId ? { connectionId } : {}),
  };
};

export const isInternalMcpTool = (toolId: AgentToolId): boolean =>
  toolId === 'forger_ask_question'
  || toolId === 'forger_list_agent_peers'
  || toolId === 'forger_ask_agent'
  || toolId === 'forger_read_agent_thread'
  || toolId.startsWith('workflow_')
  || toolId.startsWith('forger_connection_');

const APP_SCOPED_TOOLS = new Set<AgentToolId>([
  'forger_request_app_tool_grant',
  'forger_list_app_prompts',
  'forger_test_app_prompt',
  'forger_update_app_prompt',
  'forger_restore_app_prompt',
  'forger_get_app_runtime_status',
  'forger_get_app_view_snapshot',
  'forger_get_app_runtime_diagnostics',
  'forger_open_app',
  'forger_stop_app',
  'forger_restart_app',
  'forger_refresh_app_view',
  'forger_update_app',
  'forger_finish_social_app_install',
  'forger_delete_quarantined_social_app',
]);

export const isAppScopedTool = (toolId: AgentToolId): boolean => APP_SCOPED_TOOLS.has(toolId);

export const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export const parseAppToolGrantRequestInput = (
  args: Record<string, unknown>,
): Pick<SetAppToolGrantInput, 'appId' | 'toolId'> | null => {
  const appId = cleanString(args.appId);
  const toolId = cleanString(args.toolId);
  if (!appId || !toolId) {
    return null;
  }
  return { appId, toolId };
};

export const getAppToolGrantMcpCopy = (locale?: string) => {
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

export const parseCreateLocalAppToolInput = (args: Record<string, unknown>): Required<Pick<CreateLocalAppInput, 'name' | 'description' | 'purpose'>> & Pick<CreateLocalAppInput, 'lookAndFeel'> | null => {
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

export const parseQuestionToolInput = (args: Record<string, unknown>): { questions: ChatQuestion[] } | null => {
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

export const parsePromptReviewKind = (value: unknown): 'promptTemplate' | 'agent' | 'agentPrompt' | null => {
  if (value === 'promptTemplate' || value === 'agent' || value === 'agentPrompt') {
    return value;
  }
  return null;
};

export const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const parsePromptRuntimeOverride = (
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

export const memoryAccess = (session: AgentMcpSession): MemoryAccessInput => ({
  // Workflow nodes get automation-like memory access: scoped to their apps.
  caller: session.caller === 'workflow' ? 'automation' : session.caller,
  appId: session.appId === 'forger' ? undefined : session.appId,
  appIds: session.appIds,
  runId: session.runId,
});

export const memoryErrorMessage = (error: unknown, locale?: string): string => {
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

export const workflowMcpErrorMessage = (code: string): string => {
  if (code === 'workflow_not_found') {
    return 'No encontramos ese flujo.';
  }
  if (code === 'workflow_name_required') {
    return 'El flujo necesita un nombre.';
  }
  if (code === 'workflow_nodes_required') {
    return 'El flujo necesita al menos un nodo.';
  }
  if (code === 'workflow_graph_has_cycle') {
    return 'Las conexiones del flujo forman un ciclo; un flujo debe avanzar siempre hacia adelante.';
  }
  if (code === 'workflow_too_many_nodes') {
    return 'El flujo tiene demasiados nodos.';
  }
  if (code === 'workflow_edge_unknown_node' || code === 'workflow_edge_self_reference') {
    return 'Alguna conexion del flujo referencia nodos invalidos.';
  }
  if (code === 'workflow_foreach_join_not_allowed') {
    return 'Un paso no puede recibir conexiones de dos repeticiones (forEach) independientes; las repeticiones anidadas si estan permitidas.';
  }
  if (code === 'workflow_foreach_requires_upstream') {
    return 'Un paso con forEach necesita un paso anterior que produzca la lista a iterar.';
  }
  if (code === 'workflow_node_id_required' || code === 'workflow_node_id_duplicated') {
    return 'Cada nodo necesita un id unico.';
  }
  return 'No pudimos completar la operacion sobre el flujo.';
};

export const getToolAppId = (session: AgentMcpSession, params: Record<string, unknown>): string => {
  const appId = typeof params.appId === 'string' && params.appId.trim() ? params.appId.trim() : session.appId;
  return appId;
};

export const withToolAuthorization = (result: unknown, approval: ToolApprovalResult): unknown => {
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

export const sendMcpJson = (response: ServerResponse, statusCode: number, payload: unknown): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

export const readRequestBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const getBearerToken = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header || Array.isArray(header)) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
};
