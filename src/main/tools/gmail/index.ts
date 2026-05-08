import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../shared/types';
import type { InternalToolContext, InternalToolModule } from '../types';
import {
  GmailApiError,
  readAttachment,
  readMessage,
  readThread,
  searchMessages,
  sendMessage,
  validateConnection,
} from './client';
import { buildRawEmail, parseSendInput } from './mime';
import { GmailOAuthError, runGmailOAuthFlow } from './oauth';
import {
  GMAIL_REFRESH_TOKEN_SECRET,
  GMAIL_TOOL_ID,
  type GmailAttachmentSummary,
  type GmailReadAttachmentInput,
  type GmailReadInput,
  type GmailSearchInput,
} from './types';

const MAX_READ_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const definition: OfficialToolDefinition = {
  id: GMAIL_TOOL_ID,
  name: 'Gmail',
  description: 'Busca, lee y envia correos de Gmail. Requiere iniciar sesion en Forger antes de conectar la cuenta de Google.',
  version: '0.1.0',
  runtime: 'builtin',
  official: true,
  secrets: [
    {
      name: GMAIL_REFRESH_TOKEN_SECRET,
      label: 'Conexion OAuth de Gmail',
      required: true,
      usage: 'Permite renovar el acceso a Gmail sin volver a conectar la cuenta.',
    },
  ],
  actions: [
    {
      id: 'gmail.connection.status',
      name: 'Estado de conexion',
      description: 'Revisa si Gmail esta conectado.',
      risk: 'low',
    },
    {
      id: 'gmail.search_messages',
      name: 'Buscar correos',
      description: 'Busca correos en Gmail usando una consulta.',
      risk: 'medium',
    },
    {
      id: 'gmail.read_thread',
      name: 'Leer conversacion',
      description: 'Lee una conversacion o mensaje de Gmail e incluye metadata de adjuntos.',
      risk: 'high',
    },
    {
      id: 'gmail.read_attachment',
      name: 'Leer adjunto',
      description: 'Descarga un adjunto de Gmail y lo deja disponible para el agente.',
      risk: 'high',
    },
    {
      id: 'gmail.send_email',
      name: 'Enviar correo',
      description: 'Envia un correo desde la cuenta conectada.',
      risk: 'high',
    },
  ],
  changelog: ['Base inicial para conexion OAuth y acciones Gmail.'],
};

const toToolResult = (error: unknown, fallbackMessage: string, fallbackCode: string): CallOfficialToolResult => {
  if (error instanceof GmailOAuthError) {
    return {
      success: false,
      userMessage: error.message,
      technicalCode: error.technicalCode,
    };
  }
  if (error instanceof GmailApiError) {
    return {
      success: false,
      userMessage: fallbackMessage,
      technicalCode: error.technicalCode,
    };
  }
  return {
    success: false,
    userMessage: fallbackMessage,
    technicalCode: error instanceof Error ? error.message : fallbackCode,
  };
};

const parseSearchInput = (input: unknown): GmailSearchInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const query = typeof candidate.query === 'string' ? candidate.query.trim() : '';
  if (!query) {
    return null;
  }
  const maxResults = typeof candidate.maxResults === 'number' && Number.isFinite(candidate.maxResults)
    ? candidate.maxResults
    : undefined;
  return { query, ...(maxResults ? { maxResults } : {}) };
};

const parseReadInput = (input: unknown): GmailReadInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const threadId = typeof candidate.threadId === 'string' ? candidate.threadId.trim() : '';
  const messageId = typeof candidate.messageId === 'string' ? candidate.messageId.trim() : '';
  if (!threadId && !messageId) {
    return null;
  }
  return {
    ...(threadId ? { threadId } : {}),
    ...(messageId ? { messageId } : {}),
  };
};

const parseReadAttachmentInput = (input: unknown): GmailReadAttachmentInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const messageId = typeof candidate.messageId === 'string' ? candidate.messageId.trim() : '';
  const attachmentId = typeof candidate.attachmentId === 'string' ? candidate.attachmentId.trim() : '';
  const filename = typeof candidate.filename === 'string' ? candidate.filename.trim() : '';
  if (!messageId || (!attachmentId && !filename)) {
    return null;
  }
  return {
    messageId,
    ...(attachmentId ? { attachmentId } : {}),
    ...(filename ? { filename } : {}),
  };
};

const sanitizeFilename = (value: string): string => {
  const sanitized = value.replace(/[/:\\]/g, '-').replace(/[\x00-\x1F\x7F]/g, '').trim();
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'attachment';
};

const findAttachmentByInput = async (
  context: InternalToolContext,
  input: GmailReadAttachmentInput,
): Promise<GmailAttachmentSummary | null> => {
  const message = await readMessage(context, input.messageId);
  if (input.attachmentId) {
    return message.attachments.find((attachment) => attachment.attachmentId === input.attachmentId) ?? null;
  }
  const normalizedFilename = input.filename?.toLowerCase();
  return message.attachments.find((attachment) => attachment.filename.toLowerCase() === normalizedFilename) ?? null;
};

const saveAttachment = async (
  context: InternalToolContext,
  messageId: string,
  attachment: GmailAttachmentSummary,
  buffer: Buffer,
): Promise<string> => {
  if (buffer.byteLength > MAX_READ_ATTACHMENT_BYTES) {
    throw new Error('gmail_attachment_too_large');
  }
  const directory = path.join(context.metadataRoot, 'official-tools', 'gmail', 'attachments', sanitizeFilename(messageId), randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, sanitizeFilename(attachment.filename));
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
};

const configure = async (context: InternalToolContext): Promise<ToolMutationResult> => {
  try {
    await runGmailOAuthFlow(context);
    return { success: true, userMessage: 'Gmail conectado.' };
  } catch (error) {
    const result = toToolResult(error, 'No pudimos conectar Gmail.', 'gmail_oauth_failed');
    return {
      success: false,
      userMessage: result.userMessage ?? 'No pudimos conectar Gmail.',
      technicalCode: result.technicalCode,
    };
  }
};

const execute = async (
  input: CallOfficialToolInput,
  context: InternalToolContext,
): Promise<CallOfficialToolResult> => {
  try {
    if (input.actionId === 'gmail.connection.status') {
      const hasRefreshToken = await context.secretsStore.hasToolSecret(GMAIL_TOOL_ID, GMAIL_REFRESH_TOKEN_SECRET);
      if (!hasRefreshToken) {
        return { success: true, data: { connected: false } };
      }
      await validateConnection(context);
      return { success: true, data: { connected: true } };
    }

    if (input.actionId === 'gmail.search_messages') {
      const parsed = parseSearchInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Ingresa una busqueda valida para Gmail.', technicalCode: 'gmail_search_input_invalid' };
      }
      const messages = await searchMessages(context, parsed.query, parsed.maxResults);
      return { success: true, data: { messages } };
    }

    if (input.actionId === 'gmail.read_thread') {
      const parsed = parseReadInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica un mensaje o conversacion de Gmail para leer.', technicalCode: 'gmail_read_input_invalid' };
      }
      const data = parsed.threadId
        ? await readThread(context, parsed.threadId)
        : await readMessage(context, parsed.messageId as string);
      return { success: true, data };
    }

    if (input.actionId === 'gmail.read_attachment') {
      const parsed = parseReadAttachmentInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica el mensaje y el adjunto de Gmail para leer.', technicalCode: 'gmail_read_attachment_input_invalid' };
      }
      const attachment = await findAttachmentByInput(context, parsed);
      if (!attachment) {
        return { success: false, userMessage: 'No encontramos ese adjunto en el correo.', technicalCode: 'gmail_attachment_not_found' };
      }
      const buffer = await readAttachment(context, parsed.messageId, attachment.attachmentId);
      const filePath = await saveAttachment(context, parsed.messageId, attachment, buffer);
      return {
        success: true,
        data: {
          messageId: parsed.messageId,
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: buffer.byteLength,
          filePath,
          inlineBase64Available: buffer.byteLength <= MAX_INLINE_ATTACHMENT_BYTES,
          ...(buffer.byteLength <= MAX_INLINE_ATTACHMENT_BYTES ? { dataBase64: buffer.toString('base64') } : {}),
        },
      };
    }

    if (input.actionId === 'gmail.send_email') {
      const parsed = parseSendInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Completa destinatario, asunto y cuerpo del correo.', technicalCode: 'gmail_send_input_invalid' };
      }
      const sent = await sendMessage(context, await buildRawEmail(parsed));
      return { success: true, userMessage: 'Correo enviado.', data: sent };
    }

    return { success: false, userMessage: 'La accion de Gmail no esta disponible.', technicalCode: 'gmail_action_unknown' };
  } catch (error) {
    return toToolResult(error, 'No pudimos completar la accion de Gmail.', 'gmail_action_failed');
  }
};

export const gmailToolModule: InternalToolModule = {
  definition,
  configure,
  execute,
};
