import type { AgentMcpSession } from '../forger-mcp-server';
import { listWhatsAppChannelFiles, readWhatsAppChannelFile } from '../personal-agents/whatsapp-channel-context';
import { refreshWhatsAppChannelAccess, type WhatsAppChannelAgentReader } from './whatsapp-channel-access';

export const WHATSAPP_CHANNEL_FILE_TOOLS = [
  {
    name: 'whatsapp_channel_files_list',
    description: 'Lista únicamente archivos compartidos explícitamente con este chat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'whatsapp_channel_files_read',
    description: 'Lee una página de texto de un archivo devuelto por whatsapp_channel_files_list.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export const callWhatsAppChannelFileTool = async (
  session: AgentMcpSession,
  tool: string,
  raw: unknown,
  read?: WhatsAppChannelAgentReader,
): Promise<{ success: boolean; [key: string]: unknown }> => {
  const unavailable = { success: false, technicalCode: 'whatsapp_channel_unavailable' };
  if (session.caller !== 'personal-agent' || !session.whatsappChannel || !session.whatsappChannelWorkspaceRoot) return unavailable;
  try {
    if (!await refreshWhatsAppChannelAccess(session, read)) return unavailable;
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('invalid_input');
    const args = (raw ?? {}) as Record<string, unknown>;
    let result;
    if (tool === 'whatsapp_channel_files_list') {
      if (Object.keys(args).length) throw new Error('invalid_input');
      result = { files: await listWhatsAppChannelFiles(session.whatsappChannelWorkspaceRoot) };
    } else {
      if (tool !== 'whatsapp_channel_files_read' || typeof args.path !== 'string' || Object.keys(args).some(key => key !== 'path' && key !== 'offset')) throw new Error('invalid_input');
      if (args.offset !== undefined && typeof args.offset !== 'number') throw new Error('invalid_input');
      result = await readWhatsAppChannelFile(session.whatsappChannelWorkspaceRoot, args.path, args.offset as number | undefined);
    }
    // A large read may overlap a local pause or permission change.
    if (!await refreshWhatsAppChannelAccess(session, read)) return unavailable;
    return { success: true, ...result };
  } catch {
    return { success: false, technicalCode: 'whatsapp_channel_file_unavailable', userMessage: 'No pude leer ese archivo compartido como texto.' };
  }
};
