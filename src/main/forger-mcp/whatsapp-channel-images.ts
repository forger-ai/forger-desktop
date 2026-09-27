import type { WhatsAppCurrentMessageImagesResult } from '../connections/modules/whatsapp/types';
import type { AgentMcpSession } from '../forger-mcp-server';
import { refreshWhatsAppChannelAccess, type WhatsAppChannelAccessInput, type WhatsAppChannelAgentReader } from './whatsapp-channel-access';

export const WHATSAPP_CHANNEL_IMAGES_TOOL = 'whatsapp_channel_current_images';
export type WhatsAppChannelImageReader = (input: WhatsAppChannelAccessInput) => Promise<WhatsAppCurrentMessageImagesResult>;

export const WHATSAPP_CHANNEL_IMAGES_MCP_TOOL = {
  name: WHATSAPP_CHANNEL_IMAGES_TOOL,
  description: 'Muestra las fotos del mensaje de WhatsApp que activó este turno. No permite elegir otro mensaje, chat ni archivo. Requiere permiso vigente para descargar adjuntos.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const whatsAppChannelImagesAllowed = (session: AgentMcpSession): boolean =>
  session.caller === 'personal-agent' && Boolean(session.personalAgentId && session.personalAgentConversationId && session.whatsappChannel) &&
  session.connectionGrants.some(grant => grant.type === 'whatsapp' && grant.actions.includes('whatsapp.download_attachment') &&
    (grant.connectionIds === undefined || grant.connectionIds.includes(session.whatsappChannel!.connectionId)));

const unavailable = (): WhatsAppCurrentMessageImagesResult => ({
  success: false, technicalCode: 'whatsapp_channel_images_unavailable',
  userMessage: 'No puedo acceder a las fotos de este mensaje con los permisos actuales.',
});

/** The model cannot choose a file or message. Authority owns resolution and byte validation. */
export const readWhatsAppChannelImages = async (
  session: AgentMcpSession,
  rawArguments: unknown,
  readAgent?: WhatsAppChannelAgentReader,
  reader?: WhatsAppChannelImageReader,
): Promise<WhatsAppCurrentMessageImagesResult> => {
  if (rawArguments !== undefined && (rawArguments === null || typeof rawArguments !== 'object' || Array.isArray(rawArguments) || Object.keys(rawArguments).length > 0)) {
    return { success: false, technicalCode: 'whatsapp_channel_input_invalid', userMessage: 'Esta herramienta no recibe argumentos; solo lee las fotos del mensaje actual.' };
  }
  if (!reader || !await refreshWhatsAppChannelAccess(session, readAgent) || !whatsAppChannelImagesAllowed(session)) return unavailable();
  try {
    const result = await reader({
      channel: session.whatsappChannel!, runId: session.runId,
      agentId: session.personalAgentId!, conversationId: session.personalAgentConversationId!,
    });
    // Do not release downloaded bytes after a permission change, cancellation or rebind.
    if (!await refreshWhatsAppChannelAccess(session, readAgent) || !whatsAppChannelImagesAllowed(session)) return unavailable();
    return result;
  } catch {
    return { success: false, technicalCode: 'whatsapp_channel_images_read_failed', userMessage: 'No pude leer las fotos de este mensaje.' };
  }
};

/** Images travel as MCP content, never as text, file paths, or logged tool data. */
export const whatsAppChannelImagesResponse = (id: string | number | null, result: WhatsAppCurrentMessageImagesResult): Record<string, unknown> => {
  const images = result.success ? result.images ?? [] : [];
  const metadata = {
    success: result.success,
    ...(result.success ? { imageCount: images.length } : {}),
    ...(result.userMessage ? { userMessage: result.userMessage } : {}),
    ...(result.technicalCode ? { technicalCode: result.technicalCode } : {}),
  };
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(metadata) }, ...images.map(({ data, mimeType }) => ({ type: 'image', data, mimeType }))],
      isError: !result.success,
    },
  };
};
