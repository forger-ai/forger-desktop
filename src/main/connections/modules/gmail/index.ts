import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  OfficialToolDefinition,
  ToolMutationResult,
} from '../../../../shared/types';
import type { InternalToolContext, InternalToolModule } from '../../../tools/types';
import { getSharedCopy } from '../../../../shared/i18n';
import {
  deleteDraft,
  getDraft,
  getProfile,
  GmailApiError,
  listChanges,
  listDrafts,
  listLabels,
  listThreads,
  modifyThread,
  moveThread,
  readAttachment,
  readMessage,
  readThread,
  saveDraft,
  searchMessages,
  sendDraft,
  sendMessage,
  validateConnection,
} from './client';
import { buildRawEmail, parseSendInput } from './mime';
import { GmailOAuthError, runGmailOAuthFlow } from './oauth';
import {
  GMAIL_REFRESH_TOKEN_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_ID_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET,
  GMAIL_TOOL_ID,
  type GmailAttachmentSummary,
  type GmailDeleteDraftInput,
  type GmailGetDraftInput,
  type GmailListChangesInput,
  type GmailListDraftsInput,
  type GmailListThreadsInput,
  type GmailModifyThreadInput,
  type GmailMoveThreadInput,
  type GmailReadAttachmentInput,
  type GmailReadInput,
  type GmailSaveDraftInput,
  type GmailSearchInput,
  type GmailSendDraftInput,
} from './types';

const MAX_READ_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const gmailMessageSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    threadId: { type: 'string' },
    subject: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    date: { type: 'string' },
    snippet: { type: 'string' },
    labelIds: { type: 'array', items: { type: 'string' } },
    unread: { type: 'boolean' },
    starred: { type: 'boolean' },
    hasAttachments: { type: 'boolean' },
  },
};

const gmailSendInputProperties = {
  to: {
    type: 'array',
    items: { type: 'string' },
    description: 'Destinatarios, separados por linea o coma.',
  },
  cc: {
    type: 'array',
    items: { type: 'string' },
    description: 'Destinatarios en copia, separados por linea o coma.',
  },
  bcc: {
    type: 'array',
    items: { type: 'string' },
    description: 'Destinatarios en copia oculta, separados por linea o coma.',
  },
  subject: { type: 'string', description: 'Asunto del correo.' },
  body: { type: 'string', description: 'Cuerpo en texto plano o fallback del correo.' },
  bodyHtml: { type: 'string', description: 'Cuerpo HTML opcional. Si se entrega, Gmail recibe multipart/alternative.' },
  attachments: {
    type: 'array',
    description: 'Adjuntos locales que el agente ya tiene disponibles.',
    items: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        filename: { type: 'string' },
        mimeType: { type: 'string' },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
};

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
      id: 'gmail.get_profile',
      name: 'Perfil de Gmail',
      description: 'Obtiene el correo conectado y el historyId inicial de Gmail.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.list_labels',
      name: 'Listar etiquetas',
      description: 'Lista etiquetas y carpetas visibles de Gmail con contadores basicos.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.search_messages',
      name: 'Buscar correos',
      description: 'Busca correos en Gmail usando una consulta.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Consulta de busqueda de Gmail.' },
          maxResults: { type: 'number', description: 'Maximo de correos a devolver.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          messages: {
            type: 'array',
            items: gmailMessageSummarySchema,
          },
        },
        required: ['messages'],
      },
    },
    {
      id: 'gmail.list_threads',
      name: 'Listar conversaciones',
      description: 'Lista conversaciones de Gmail con metadata resumida y paginacion.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Consulta opcional de Gmail.' },
          labelIds: { type: 'array', items: { type: 'string' }, description: 'IDs de etiquetas para filtrar.' },
          maxResults: { type: 'number', description: 'Maximo de conversaciones a devolver.' },
          pageToken: { type: 'string', description: 'Token de pagina devuelto por Gmail.' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.read_thread',
      name: 'Leer conversacion',
      description: 'Lee una conversacion o mensaje de Gmail e incluye metadata de adjuntos.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'ID de conversacion a leer.' },
          messageId: { type: 'string', description: 'ID de mensaje a leer si no se usa threadId.' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.list_changes',
      name: 'Sincronizar cambios',
      description: 'Lista cambios de Gmail desde un historyId para sincronizacion incremental.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          startHistoryId: { type: 'string', description: 'historyId desde el que Gmail debe entregar cambios.' },
          maxResults: { type: 'number', description: 'Maximo de cambios a devolver.' },
          pageToken: { type: 'string', description: 'Token de pagina devuelto por Gmail.' },
        },
        required: ['startHistoryId'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.modify_thread',
      name: 'Modificar conversacion',
      description: 'Aplica cambios de etiquetas a una conversacion, incluyendo leido, no leido, destacado o archivado.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          addLabelIds: { type: 'array', items: { type: 'string' } },
          removeLabelIds: { type: 'array', items: { type: 'string' } },
          markRead: { type: 'boolean' },
          markUnread: { type: 'boolean' },
          star: { type: 'boolean' },
          unstar: { type: 'boolean' },
          archive: { type: 'boolean' },
        },
        required: ['threadId'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.move_thread',
      name: 'Mover conversacion',
      description: 'Mueve una conversacion a la papelera o la restaura desde la papelera.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
          destination: { type: 'string', enum: ['trash', 'untrash'] },
        },
        required: ['threadId', 'destination'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.read_attachment',
      name: 'Leer adjunto',
      description: 'Descarga un adjunto de Gmail y lo deja disponible para el agente.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'ID del mensaje que contiene el adjunto.' },
          attachmentId: { type: 'string', description: 'ID del adjunto.' },
          filename: { type: 'string', description: 'Nombre del adjunto si no se usa attachmentId.' },
        },
        required: ['messageId'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.list_drafts',
      name: 'Listar borradores',
      description: 'Lista borradores de Gmail con metadata de mensaje.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          maxResults: { type: 'number' },
          pageToken: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.get_draft',
      name: 'Leer borrador',
      description: 'Lee un borrador de Gmail por ID.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
        },
        required: ['draftId'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.save_draft',
      name: 'Guardar borrador',
      description: 'Crea o actualiza un borrador de Gmail sin enviarlo.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string', description: 'ID de borrador a actualizar. Si falta, se crea uno nuevo.' },
          threadId: { type: 'string', description: 'ID de conversacion donde responder.' },
          ...gmailSendInputProperties,
        },
        required: ['to', 'subject'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.delete_draft',
      name: 'Eliminar borrador',
      description: 'Elimina un borrador de Gmail.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
        },
        required: ['draftId'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.send_draft',
      name: 'Enviar borrador',
      description: 'Envia un borrador existente de Gmail.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
        },
        required: ['draftId'],
        additionalProperties: false,
      },
    },
    {
      id: 'gmail.send_email',
      name: 'Enviar correo',
      description: 'Envia un correo desde la cuenta conectada.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: gmailSendInputProperties,
        required: ['to', 'subject'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          threadId: { type: 'string' },
        },
      },
    },
  ],
  changelog: ['Base inicial para conexion OAuth y acciones Gmail.'],
};

type GmailToolFailureResult = CallOfficialToolResult & {
  success: false;
  userMessage: string;
};

const toToolResult = (error: unknown, fallbackMessage: string, fallbackCode: string): GmailToolFailureResult => {
  if (error instanceof GmailOAuthError) {
    return {
      success: false,
      userMessage: error.message,
      technicalCode: error.technicalCode,
    };
  }
  if (error instanceof GmailApiError) {
    if (error.technicalCode === 'gmail_scope_required') {
      return {
        success: false,
        userMessage: 'Reconecta Gmail para autorizar las nuevas acciones.',
        technicalCode: 'gmail_scope_required',
        data: { needsReconnect: true },
      };
    }
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
  const pageToken = typeof candidate.pageToken === 'string' ? candidate.pageToken.trim() : '';
  return { query, ...(maxResults ? { maxResults } : {}), ...(pageToken ? { pageToken } : {}) };
};

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const parseListThreadsInput = (input: unknown): GmailListThreadsInput | null => {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const query = typeof candidate.query === 'string' ? candidate.query.trim() : '';
  const labelIds = stringArray(candidate.labelIds);
  const pageToken = typeof candidate.pageToken === 'string' ? candidate.pageToken.trim() : '';
  return {
    ...(query ? { query } : {}),
    ...(labelIds.length > 0 ? { labelIds } : {}),
    ...(optionalNumber(candidate.maxResults) ? { maxResults: optionalNumber(candidate.maxResults) } : {}),
    ...(pageToken ? { pageToken } : {}),
  };
};

const parseListChangesInput = (input: unknown): GmailListChangesInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const startHistoryId = typeof candidate.startHistoryId === 'string' ? candidate.startHistoryId.trim() : '';
  const pageToken = typeof candidate.pageToken === 'string' ? candidate.pageToken.trim() : '';
  if (!startHistoryId) {
    return null;
  }
  return {
    startHistoryId,
    ...(optionalNumber(candidate.maxResults) ? { maxResults: optionalNumber(candidate.maxResults) } : {}),
    ...(pageToken ? { pageToken } : {}),
  };
};

const parseModifyThreadInput = (input: unknown): GmailModifyThreadInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const threadId = typeof candidate.threadId === 'string' ? candidate.threadId.trim() : '';
  if (!threadId) {
    return null;
  }
  const addLabelIds = new Set(stringArray(candidate.addLabelIds));
  const removeLabelIds = new Set(stringArray(candidate.removeLabelIds));
  if (candidate.markRead === true) removeLabelIds.add('UNREAD');
  if (candidate.markUnread === true) addLabelIds.add('UNREAD');
  if (candidate.star === true) addLabelIds.add('STARRED');
  if (candidate.unstar === true) removeLabelIds.add('STARRED');
  if (candidate.archive === true) removeLabelIds.add('INBOX');
  const add = [...addLabelIds].filter((labelId) => !removeLabelIds.has(labelId));
  const remove = [...removeLabelIds].filter((labelId) => !addLabelIds.has(labelId));
  if (add.length === 0 && remove.length === 0) {
    return null;
  }
  return {
    threadId,
    ...(add.length > 0 ? { addLabelIds: add } : {}),
    ...(remove.length > 0 ? { removeLabelIds: remove } : {}),
  };
};

const parseMoveThreadInput = (input: unknown): GmailMoveThreadInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const threadId = typeof candidate.threadId === 'string' ? candidate.threadId.trim() : '';
  const destination = candidate.destination === 'trash' || candidate.destination === 'untrash'
    ? candidate.destination
    : null;
  return threadId && destination ? { threadId, destination } : null;
};

const parseListDraftsInput = (input: unknown): GmailListDraftsInput | null => {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const pageToken = typeof candidate.pageToken === 'string' ? candidate.pageToken.trim() : '';
  return {
    ...(optionalNumber(candidate.maxResults) ? { maxResults: optionalNumber(candidate.maxResults) } : {}),
    ...(pageToken ? { pageToken } : {}),
  };
};

const parseDraftIdInput = <T extends GmailGetDraftInput | GmailDeleteDraftInput | GmailSendDraftInput>(
  input: unknown,
): T | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const draftId = typeof candidate.draftId === 'string' ? candidate.draftId.trim() : '';
  return draftId ? { draftId } as T : null;
};

const parseSaveDraftInput = (input: unknown): GmailSaveDraftInput | null => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const send = parseSendInput(input);
  if (!send) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const draftId = typeof candidate.draftId === 'string' ? candidate.draftId.trim() : '';
  const threadId = typeof candidate.threadId === 'string' ? candidate.threadId.trim() : '';
  return {
    ...send,
    ...(draftId ? { draftId } : {}),
    ...(threadId ? { threadId } : {}),
  };
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
  const directory = path.join(context.metadataRoot, 'connections', 'gmail', 'attachments', sanitizeFilename(messageId), randomUUID());
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, sanitizeFilename(attachment.filename));
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
};

const configure = async (
  context: InternalToolContext,
  input?: ConfigureOfficialToolInput,
): Promise<ToolMutationResult> => {
  const copy = getSharedCopy(context.locale);
  try {
    await runGmailOAuthFlow(context, {
      clientId: input?.secrets?.[GMAIL_SELF_OAUTH_CLIENT_ID_SECRET],
      clientSecret: input?.secrets?.[GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET],
    });
    return { success: true, userMessage: copy.tools.gmailConnected };
  } catch (error) {
    const result = toToolResult(error, copy.tools.gmailConnectFailed, 'gmail_oauth_failed');
    return {
      success: false,
      userMessage: result.userMessage,
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

    if (input.actionId === 'gmail.get_profile') {
      return { success: true, data: { profile: await getProfile(context) } };
    }

    if (input.actionId === 'gmail.list_labels') {
      return { success: true, data: { labels: await listLabels(context) } };
    }

    if (input.actionId === 'gmail.search_messages') {
      const parsed = parseSearchInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Ingresa una busqueda valida para Gmail.', technicalCode: 'gmail_search_input_invalid' };
      }
      const messages = await searchMessages(context, parsed.query, parsed.maxResults, parsed.pageToken);
      return { success: true, data: { messages } };
    }

    if (input.actionId === 'gmail.list_threads') {
      const parsed = parseListThreadsInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Ingresa filtros validos para listar conversaciones de Gmail.', technicalCode: 'gmail_list_threads_input_invalid' };
      }
      return { success: true, data: await listThreads(context, parsed) };
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

    if (input.actionId === 'gmail.list_changes') {
      const parsed = parseListChangesInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica un historyId valido para sincronizar Gmail.', technicalCode: 'gmail_list_changes_input_invalid' };
      }
      return { success: true, data: await listChanges(context, parsed) };
    }

    if (input.actionId === 'gmail.modify_thread') {
      const parsed = parseModifyThreadInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica una conversacion y al menos una modificacion de Gmail.', technicalCode: 'gmail_modify_thread_input_invalid' };
      }
      return { success: true, data: { thread: await modifyThread(context, parsed) } };
    }

    if (input.actionId === 'gmail.move_thread') {
      const parsed = parseMoveThreadInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica una conversacion y destino trash o untrash.', technicalCode: 'gmail_move_thread_input_invalid' };
      }
      return { success: true, data: { thread: await moveThread(context, parsed) } };
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

    if (input.actionId === 'gmail.list_drafts') {
      const parsed = parseListDraftsInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Ingresa paginacion valida para listar borradores de Gmail.', technicalCode: 'gmail_list_drafts_input_invalid' };
      }
      return { success: true, data: await listDrafts(context, parsed) };
    }

    if (input.actionId === 'gmail.get_draft') {
      const parsed = parseDraftIdInput<GmailGetDraftInput>(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica un borrador de Gmail valido.', technicalCode: 'gmail_get_draft_input_invalid' };
      }
      return { success: true, data: { draft: await getDraft(context, parsed) } };
    }

    if (input.actionId === 'gmail.save_draft') {
      const parsed = parseSaveDraftInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Completa destinatario, asunto y cuerpo del borrador en texto o HTML.', technicalCode: 'gmail_save_draft_input_invalid' };
      }
      return { success: true, userMessage: 'Borrador guardado.', data: { draft: await saveDraft(context, parsed, await buildRawEmail(parsed)) } };
    }

    if (input.actionId === 'gmail.delete_draft') {
      const parsed = parseDraftIdInput<GmailDeleteDraftInput>(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica un borrador de Gmail valido.', technicalCode: 'gmail_delete_draft_input_invalid' };
      }
      return { success: true, userMessage: 'Borrador eliminado.', data: await deleteDraft(context, parsed.draftId) };
    }

    if (input.actionId === 'gmail.send_draft') {
      const parsed = parseDraftIdInput<GmailSendDraftInput>(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Indica un borrador de Gmail valido.', technicalCode: 'gmail_send_draft_input_invalid' };
      }
      return { success: true, userMessage: 'Correo enviado.', data: await sendDraft(context, parsed) };
    }

    if (input.actionId === 'gmail.send_email') {
      const parsed = parseSendInput(input.input);
      if (!parsed) {
        return { success: false, userMessage: 'Completa destinatario, asunto y cuerpo del correo en texto o HTML.', technicalCode: 'gmail_send_input_invalid' };
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
