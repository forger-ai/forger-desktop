import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import { getSharedCopy } from '../../../shared/i18n';
import type { InternalToolContext, InternalToolModule } from '../types';
import { createWhatsAppConnectionManager, WhatsAppConnectionManager } from './manager';
import {
  WHATSAPP_AUTH_STATE_SECRET,
  WHATSAPP_TOOL_ID,
  type WhatsAppChatDetailsInput,
  type WhatsAppDownloadAttachmentInput,
  type WhatsAppListChatsInput,
  type WhatsAppPairingInput,
  type WhatsAppReadMessagesInput,
  type WhatsAppSendMessageInput,
} from './types';

const definition: OfficialToolDefinition = {
  id: WHATSAPP_TOOL_ID,
  name: 'WhatsApp (no oficial)',
  description: 'Lee y envia mensajes de WhatsApp usando una conexion local no oficial basada en WhatsApp Web. Puede necesitar reconexion.',
  version: '0.1.0',
  runtime: 'builtin',
  official: true,
  secrets: [
    {
      name: WHATSAPP_AUTH_STATE_SECRET,
      label: 'Conexion local de WhatsApp',
      required: false,
      usage: 'La sesion de WhatsApp se guarda localmente en el workspace privado de Forger.',
    },
  ],
  actions: [
    {
      id: 'whatsapp.connection.status',
      name: 'Estado de conexion',
      description: 'Revisa si WhatsApp esta conectado o necesita reconexion.',
      risk: 'low',
    },
    {
      id: 'whatsapp.start_pairing',
      name: 'Conectar WhatsApp',
      description: 'Genera un QR o codigo para vincular WhatsApp como dispositivo local.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          method: {
            type: 'string',
            enum: ['qr', 'pairing_code'],
            description: 'Metodo de vinculacion.',
          },
          phoneNumber: { type: 'string', description: 'Numero de telefono requerido para pairing code.' },
        },
        required: ['method'],
      },
    },
    {
      id: 'whatsapp.list_chats',
      name: 'Listar chats',
      description: 'Lista chats de WhatsApp ya observados por Forger.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filtro por nombre, numero o texto conocido.' },
          chatType: {
            type: 'string',
            enum: ['direct', 'group', 'channel'],
            description: 'Tipo de chat a listar.',
          },
          limit: { type: 'number', description: 'Maximo de chats a devolver.' },
          cursor: { type: 'string', description: 'Cursor de paginacion.' },
        },
      },
    },
    {
      id: 'whatsapp.read_messages',
      name: 'Leer mensajes',
      description: 'Lee mensajes guardados de un chat observado e identifica si es directo, grupo o canal.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'ID del chat observado.' },
          limit: { type: 'number', description: 'Maximo de mensajes a leer.' },
          beforeMessageRef: { type: 'string', description: 'Referencia de mensaje para paginar hacia atras.' },
        },
        required: ['chatId'],
      },
    },
    {
      id: 'whatsapp.download_attachment',
      name: 'Descargar adjunto',
      description: 'Descarga bajo demanda un adjunto de WhatsApp previamente observado.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: 'ID del adjunto observado.' },
        },
        required: ['attachmentId'],
      },
    },
    {
      id: 'whatsapp.send_message',
      name: 'Enviar mensaje',
      description: 'Envia un mensaje a un chat de WhatsApp previamente observado.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'ID del chat observado.' },
          text: { type: 'string', description: 'Texto del mensaje.' },
          replyToMessageRef: { type: 'string', description: 'Referencia opcional del mensaje a responder.' },
        },
        required: ['chatId', 'text'],
      },
    },
    {
      id: 'whatsapp.get_chat_details',
      name: 'Ver detalle de chat',
      description: 'Obtiene detalles disponibles de un numero, grupo o canal de WhatsApp.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'ID del chat observado.' },
        },
        required: ['chatId'],
      },
    },
  ],
  changelog: ['Base experimental no oficial con Baileys para conexion local, lectura y envio controlado.'],
};

const managers = new Map<string, WhatsAppConnectionManager>();

const getManager = (context: InternalToolContext): WhatsAppConnectionManager => {
  const key = context.metadataRoot;
  const existing = managers.get(key);
  if (existing) {
    return existing;
  }
  const manager = createWhatsAppConnectionManager(context);
  managers.set(key, manager);
  return manager;
};

const configure = async (context: InternalToolContext): Promise<ToolMutationResult> => ({
  success: true,
  userMessage: getSharedCopy(context.locale).tools.whatsappActivated,
});

const execute = async (
  input: CallOfficialToolInput,
  context: InternalToolContext,
): Promise<CallOfficialToolResult> => {
  const toolManager = getManager(context);
  try {
    if (input.actionId === 'whatsapp.connection.status') {
      return { success: true, data: await toolManager.status(context) };
    }
    if (input.actionId === 'whatsapp.start_pairing') {
      const parsed = parsePairingInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica si quieres conectar WhatsApp con QR o codigo.', technicalCode: 'whatsapp_pairing_input_invalid' };
      }
      const data = await toolManager.startPairing(context, parsed);
      const failure = toFailureResult(data);
      return failure ?? { success: true, data };
    }
    if (input.actionId === 'whatsapp.list_chats') {
      return { success: true, data: await toolManager.listChats(parseListChatsInput(input.input)) };
    }
    if (input.actionId === 'whatsapp.read_messages') {
      const parsed = parseReadMessagesInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica el chat de WhatsApp que quieres leer.', technicalCode: 'whatsapp_read_input_invalid' };
      }
      const data = await toolManager.readMessages(context, parsed);
      const failure = toFailureResult(data);
      return failure ?? { success: true, data };
    }
    if (input.actionId === 'whatsapp.download_attachment') {
      const parsed = parseDownloadAttachmentInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica el adjunto de WhatsApp que quieres descargar.', technicalCode: 'whatsapp_download_attachment_input_invalid' };
      }
      const data = await toolManager.downloadAttachment(context, parsed);
      const failure = toFailureResult(data);
      return failure ?? { success: true, data };
    }
    if (input.actionId === 'whatsapp.send_message') {
      const parsed = parseSendMessageInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Completa el chat y el texto para enviar por WhatsApp.', technicalCode: 'whatsapp_send_input_invalid' };
      }
      const data = await toolManager.sendMessage(context, parsed);
      const failure = toFailureResult(data);
      return failure ?? { success: true, data };
    }
    if (input.actionId === 'whatsapp.get_chat_details') {
      const parsed = parseChatDetailsInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica el chat de WhatsApp que quieres revisar.', technicalCode: 'whatsapp_details_input_invalid' };
      }
      const data = await toolManager.getChatDetails(context, parsed);
      const failure = toFailureResult(data);
      return failure ?? { success: true, data };
    }
    return { success: false, userMessage: 'La accion de WhatsApp no esta disponible.', technicalCode: 'whatsapp_action_unknown' };
  } catch (error) {
    return {
      success: false,
      userMessage: 'No pudimos completar la accion de WhatsApp.',
      technicalCode: error instanceof Error ? error.message : 'whatsapp_action_failed',
    };
  }
};

export const whatsappToolModule: InternalToolModule = {
  definition,
  configure,
  execute,
  start: async (context) => {
    await getManager(context).status(context);
  },
  stop: async (context) => {
    await getManager(context).stopListening();
  },
  deactivate: async (context) => {
    const key = context.metadataRoot;
    const manager = managers.get(key);
    await manager?.disconnect(context);
    managers.delete(key);
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toFailureResult = (value: Record<string, unknown>): CallOfficialToolResult | null => {
  if (value.success !== false) {
    return null;
  }
  return {
    success: false,
    ...(typeof value.userMessage === 'string' ? { userMessage: value.userMessage } : {}),
    ...(typeof value.technicalCode === 'string' ? { technicalCode: value.technicalCode } : {}),
    ...(value.data !== undefined ? { data: value.data } : {}),
  };
};

const parsePairingInput = (input: unknown): WhatsAppPairingInput | null => {
  if (!isRecord(input)) {
    return null;
  }
  const method = input.method === 'pairing_code' ? 'pairing_code' : input.method === 'qr' ? 'qr' : null;
  if (!method) {
    return null;
  }
  return {
    method,
    ...(typeof input.phoneNumber === 'string' ? { phoneNumber: input.phoneNumber.trim() } : {}),
  };
};

const parseListChatsInput = (input: unknown): WhatsAppListChatsInput => {
  if (!isRecord(input)) {
    return {};
  }
  const chatType = input.chatType === 'direct' || input.chatType === 'group' || input.chatType === 'channel'
    ? input.chatType
    : undefined;
  return {
    ...(chatType ? { chatType } : {}),
    ...(typeof input.query === 'string' && input.query.trim() ? { query: input.query.trim() } : {}),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    ...(typeof input.cursor === 'string' ? { cursor: input.cursor.trim() } : {}),
  };
};

const parseReadMessagesInput = (input: unknown): WhatsAppReadMessagesInput | null => {
  if (!isRecord(input) || typeof input.chatId !== 'string' || !input.chatId.trim()) {
    return null;
  }
  return {
    chatId: input.chatId.trim(),
    ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
    ...(typeof input.beforeMessageRef === 'string' ? { beforeMessageRef: input.beforeMessageRef.trim() } : {}),
  };
};

const parseSendMessageInput = (input: unknown): WhatsAppSendMessageInput | null => {
  if (!isRecord(input) || typeof input.chatId !== 'string' || typeof input.text !== 'string') {
    return null;
  }
  const chatId = input.chatId.trim();
  const text = input.text.trim();
  if (!chatId || !text) {
    return null;
  }
  return {
    chatId,
    text,
    ...(typeof input.replyToMessageRef === 'string' ? { replyToMessageRef: input.replyToMessageRef.trim() } : {}),
  };
};

const parseChatDetailsInput = (input: unknown): WhatsAppChatDetailsInput | null => {
  if (!isRecord(input) || typeof input.chatId !== 'string' || !input.chatId.trim()) {
    return null;
  }
  return { chatId: input.chatId.trim() };
};

const parseDownloadAttachmentInput = (input: unknown): WhatsAppDownloadAttachmentInput | null => {
  if (!isRecord(input) || typeof input.attachmentId !== 'string' || !input.attachmentId.trim()) {
    return null;
  }
  return { attachmentId: input.attachmentId.trim() };
};

export const __resetWhatsAppToolForTests = (): void => {
  managers.clear();
};
