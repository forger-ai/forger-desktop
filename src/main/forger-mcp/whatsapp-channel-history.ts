import type { PersonalAgentWhatsAppChannel } from '../personal-agents/agent-conversation-manager';
import type { AgentMcpSession } from '../forger-mcp-server';

export const WHATSAPP_CHANNEL_HISTORY_TOOL = 'whatsapp_channel_history';

export interface WhatsAppChannelHistoryMessage {
  id: string;
  authorId: string;
  text: string;
  timestamp: string;
}

export interface WhatsAppChannelHistoryInput {
  channel: PersonalAgentWhatsAppChannel;
  runId: string;
  agentId: string;
  conversationId: string;
  limit: number;
  beforeMessageRef?: string;
}

export interface WhatsAppChannelHistoryResult {
  success: boolean;
  messages?: WhatsAppChannelHistoryMessage[];
  nextBeforeMessageRef?: string;
  userMessage?: string;
  technicalCode?: string;
}

export const WHATSAPP_CHANNEL_HISTORY_MCP_TOOL = {
  name: WHATSAPP_CHANNEL_HISTORY_TOOL,
  description: 'Lee mensajes paginados del chat de WhatsApp que activó este turno. El chat se toma de la sesión; no se puede elegir otro.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Máximo de mensajes a leer (predeterminado: 20).' },
      beforeMessageRef: { type: 'string', maxLength: 512, description: 'Cursor de una página anterior del mismo chat.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const parseWhatsAppChannelHistoryArgs = (raw: unknown): { limit: number; beforeMessageRef?: string } | null => {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return null;
  const args = (raw ?? {}) as Record<string, unknown>;
  if (Object.keys(args).some((key) => key !== 'limit' && key !== 'beforeMessageRef')) return null;
  const limit = args.limit === undefined ? 20 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) return null;
  const cursor = args.beforeMessageRef;
  if (cursor === undefined) return { limit };
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 512) return null;
  return { limit, beforeMessageRef: cursor };
};

export const whatsappChannelToolResponse = <T extends { success: boolean }>(
  id: string | number | null,
  result: T,
): Record<string, unknown> => ({
  jsonrpc: '2.0', id,
  result: {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: !result.success,
  },
});

export const readWhatsAppChannelHistory = async (
  session: AgentMcpSession,
  rawArguments: unknown,
  reader?: (input: WhatsAppChannelHistoryInput) => Promise<WhatsAppChannelHistoryResult>,
): Promise<WhatsAppChannelHistoryResult> => {
  if (
    session.caller !== 'personal-agent' || !session.personalAgentId ||
    !session.personalAgentConversationId || !session.whatsappChannel || !reader
  ) {
    return { success: false, userMessage: 'El contexto de WhatsApp no está disponible para este turno.', technicalCode: 'whatsapp_channel_unavailable' };
  }
  const args = parseWhatsAppChannelHistoryArgs(rawArguments);
  if (!args) {
    return { success: false, userMessage: 'Indica solo limit (1–50) y, opcionalmente, beforeMessageRef.', technicalCode: 'whatsapp_channel_input_invalid' };
  }
  try {
    return await reader({
      channel: session.whatsappChannel,
      runId: session.runId,
      agentId: session.personalAgentId,
      conversationId: session.personalAgentConversationId,
      ...args,
    });
  } catch {
    return { success: false, userMessage: 'No pude leer el historial de este chat.', technicalCode: 'whatsapp_channel_history_unavailable' };
  }
};
