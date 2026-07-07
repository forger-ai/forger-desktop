import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CallOfficialToolResult } from '../../../../shared/types';
import type { InternalToolModule } from '../../../tools/types';
import { ConnectorApiError, createTokenConnectorModule } from '../token-connector';

export const TRELLO_TOOL_ID = 'trello';
export const TRELLO_API_KEY_SECRET = 'api_key';
export const TRELLO_API_TOKEN_SECRET = 'api_token';

const TRELLO_API_BASE = 'https://api.trello.com/1';
const MAX_TRELLO_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const callTrelloApi = async (
  secrets: Record<string, string>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  params: Record<string, string> = {},
): Promise<unknown> => {
  const url = new URL(`${TRELLO_API_BASE}${path}`);
  url.searchParams.set('key', secrets[TRELLO_API_KEY_SECRET] as string);
  url.searchParams.set('token', secrets[TRELLO_API_TOKEN_SECRET] as string);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, { method });
  if (!response.ok) {
    throw new ConnectorApiError(`trello_http_${response.status}`);
  }
  if (response.status === 204) {
    return {};
  }
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (contentType && !contentType.toLowerCase().includes('json')) {
    return {};
  }
  return await response.json().catch(() => ({}));
};

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const cleanStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map(cleanString).filter(Boolean))]
    : [];

const cleanBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, numeric));
};

const sanitizeFileName = (value: unknown, fallback: string): string => {
  const cleaned = cleanString(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
};

const cardFields = 'name,desc,due,dueComplete,url,idList,closed,idLabels,idMembers';

const normalizeCard = (card: Record<string, unknown>): Record<string, unknown> => ({
  id: card.id,
  name: card.name,
  description: card.desc,
  dueDate: card.due,
  dueComplete: card.dueComplete,
  url: card.url,
  listId: card.idList,
  closed: card.closed,
  labelIds: Array.isArray(card.idLabels) ? card.idLabels : [],
  memberIds: Array.isArray(card.idMembers) ? card.idMembers : [],
});

const normalizeAttachment = (attachment: Record<string, unknown>): Record<string, unknown> => ({
  id: attachment.id,
  name: attachment.name,
  bytes: attachment.bytes,
  mimeType: attachment.mimeType,
  date: attachment.date,
});

const filterCards = (
  cards: Array<Record<string, unknown>>,
  input: Record<string, unknown>,
): Array<Record<string, unknown>> => {
  const query = cleanString(input.query).toLowerCase();
  const labelIds = cleanStringList(input.labelIds);
  const memberIds = cleanStringList(input.memberIds);
  const dueBefore = cleanString(input.dueBefore);
  const dueAfter = cleanString(input.dueAfter);
  const dueComplete = cleanBoolean(input.dueComplete);
  return cards.filter((card) => {
    if (query) {
      const haystack = `${cleanString(card.name)} ${cleanString(card.desc)}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    const cardLabels = new Set(Array.isArray(card.idLabels) ? card.idLabels.map(cleanString) : []);
    if (labelIds.some((labelId) => !cardLabels.has(labelId))) return false;
    const cardMembers = new Set(Array.isArray(card.idMembers) ? card.idMembers.map(cleanString) : []);
    if (memberIds.some((memberId) => !cardMembers.has(memberId))) return false;
    if (dueComplete !== undefined && card.dueComplete !== dueComplete) return false;
    const due = cleanString(card.due);
    if (dueBefore && (!due || due > dueBefore)) return false;
    if (dueAfter && (!due || due < dueAfter)) return false;
    return true;
  });
};

const callTrelloDownload = async (
  secrets: Record<string, string>,
  attachmentUrl: string,
): Promise<{ buffer: Buffer; contentType?: string; size?: number }> => {
  const url = new URL(attachmentUrl);
  url.searchParams.set('key', secrets[TRELLO_API_KEY_SECRET] as string);
  url.searchParams.set('token', secrets[TRELLO_API_TOKEN_SECRET] as string);
  const response = await fetch(url);
  if (!response.ok) {
    throw new ConnectorApiError(`trello_http_${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_TRELLO_ATTACHMENT_BYTES) {
    throw new ConnectorApiError('trello_attachment_too_large');
  }
  const declaredSize = Number(response.headers?.get?.('content-length') ?? 0);
  return {
    buffer,
    contentType: response.headers?.get?.('content-type') ?? undefined,
    size: Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : buffer.byteLength,
  };
};

const callTrelloUpload = async (
  secrets: Record<string, string>,
  cardId: string,
  input: { filePath: string; name?: string },
): Promise<unknown> => {
  if (!path.isAbsolute(input.filePath)) {
    throw new ConnectorApiError('trello_upload_path_invalid');
  }
  const stat = await fs.stat(input.filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new ConnectorApiError('trello_upload_file_missing');
  }
  if (stat.size > MAX_TRELLO_ATTACHMENT_BYTES) {
    throw new ConnectorApiError('trello_attachment_too_large');
  }
  const fileName = sanitizeFileName(input.name, path.basename(input.filePath));
  const fileBuffer = await fs.readFile(input.filePath);
  const url = new URL(`${TRELLO_API_BASE}/cards/${encodeURIComponent(cardId)}/attachments`);
  url.searchParams.set('key', secrets[TRELLO_API_KEY_SECRET] as string);
  url.searchParams.set('token', secrets[TRELLO_API_TOKEN_SECRET] as string);
  const body = new FormData();
  body.append('name', fileName);
  body.append('file', new Blob([fileBuffer]), fileName);
  const response = await fetch(url, { method: 'POST', body });
  if (!response.ok) {
    throw new ConnectorApiError(`trello_http_${response.status}`);
  }
  return await response.json().catch(() => ({}));
};

const toResult = (error: unknown, fallbackCode: string): CallOfficialToolResult => ({
  success: false,
  userMessage: 'No pudimos completar la accion de Trello. Revisa la conexion y los permisos de las credenciales.',
  technicalCode: error instanceof ConnectorApiError
    ? error.technicalCode
    : error instanceof Error ? error.message : fallbackCode,
});

export const trelloToolModule: InternalToolModule = createTokenConnectorModule({
  id: TRELLO_TOOL_ID,
  name: 'Trello',
  description: 'Revisa tableros, administra tarjetas y trabaja con adjuntos de Trello usando una API key y token guardados localmente en secretos.',
  version: '0.1.0',
  connectionStatusActionId: 'trello.connection.status',
  secrets: [
    {
      name: TRELLO_API_KEY_SECRET,
      label: 'API key de Trello',
      required: true,
      usage: 'API key generada en trello.com/power-ups/admin. Se guarda cifrada en este equipo.',
    },
    {
      name: TRELLO_API_TOKEN_SECRET,
      label: 'Token de Trello',
      required: true,
      usage: 'Token de usuario autorizado para esa API key. Se guarda cifrado en este equipo.',
    },
  ],
  changelog: ['Conector local de Trello con credenciales en secretos.'],
  copy: {
    secretsMissing: 'Conecta Trello agregando la API key y el token en la configuracion de la herramienta.',
    connected: 'Trello quedo conectado.',
    connectFailed: 'No pudimos validar las credenciales de Trello. Revisa la API key y el token.',
  },
  validate: async (secrets) => {
    try {
      const me = await callTrelloApi(secrets, 'GET', '/members/me', { fields: 'username,fullName' }) as Record<string, unknown>;
      return {
        ok: true,
        data: {
          username: typeof me.username === 'string' ? me.username : undefined,
          fullName: typeof me.fullName === 'string' ? me.fullName : undefined,
        },
      };
    } catch (error) {
      return {
        ok: false,
        technicalCode: error instanceof ConnectorApiError ? error.technicalCode : 'trello_validation_failed',
      };
    }
  },
  actions: [
    {
      id: 'trello.connection.status',
      name: 'Estado de conexion',
      description: 'Revisa si las credenciales de Trello estan conectadas.',
      risk: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean' },
          username: { type: 'string' },
          fullName: { type: 'string' },
        },
        required: ['connected'],
      },
      run: async () => ({ success: true, data: { connected: true } }),
    },
    {
      id: 'trello.list_boards',
      name: 'Listar tableros',
      description: 'Lista los tableros de la cuenta conectada.',
      risk: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          boards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                url: { type: 'string' },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['boards'],
      },
      run: async ({ secrets }) => {
        try {
          const boards = await callTrelloApi(secrets, 'GET', '/members/me/boards', {
            fields: 'name,url,closed',
            filter: 'open',
          }) as Array<Record<string, unknown>>;
          return {
            success: true,
            data: {
              boards: boards.map((board) => ({ id: board.id, name: board.name, url: board.url })),
            },
          };
        } catch (error) {
          return toResult(error, 'trello_list_boards_failed');
        }
      },
    },
    {
      id: 'trello.list_lists',
      name: 'Listar columnas',
      description: 'Lista las columnas de un tablero.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          boardId: { type: 'string', description: 'ID del tablero de Trello.' },
        },
        required: ['boardId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          lists: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['lists'],
      },
      run: async ({ input, secrets }) => {
        const boardId = cleanString(input.boardId);
        if (!boardId) {
          return { success: false, userMessage: 'Indica el tablero de Trello.', technicalCode: 'trello_board_required' };
        }
        try {
          const lists = await callTrelloApi(secrets, 'GET', `/boards/${encodeURIComponent(boardId)}/lists`, {
            fields: 'name,closed',
            filter: 'open',
          }) as Array<Record<string, unknown>>;
          return {
            success: true,
            data: { lists: lists.map((list) => ({ id: list.id, name: list.name })) },
          };
        } catch (error) {
          return toResult(error, 'trello_list_lists_failed');
        }
      },
    },
    {
      id: 'trello.list_cards',
      name: 'Listar tarjetas',
      description: 'Lista las tarjetas de una columna.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'ID de la columna de Trello.' },
          limit: { type: 'number', description: 'Maximo de tarjetas a devolver.' },
        },
        required: ['listId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                dueDate: { type: 'string' },
                dueComplete: { type: 'boolean' },
                url: { type: 'string' },
                listId: { type: 'string' },
                closed: { type: 'boolean' },
                labelIds: { type: 'array', items: { type: 'string' } },
                memberIds: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['cards'],
      },
      run: async ({ input, secrets }) => {
        const listId = cleanString(input.listId);
        if (!listId) {
          return { success: false, userMessage: 'Indica la columna de Trello.', technicalCode: 'trello_list_required' };
        }
        try {
          const cards = await callTrelloApi(secrets, 'GET', `/lists/${encodeURIComponent(listId)}/cards`, {
            fields: cardFields,
          }) as Array<Record<string, unknown>>;
          const limit = clampLimit(input.limit, 50, 200);
          return {
            success: true,
            data: {
              cards: cards.slice(0, limit).map(normalizeCard),
            },
          };
        } catch (error) {
          return toResult(error, 'trello_list_cards_failed');
        }
      },
    },
    {
      id: 'trello.filter_cards',
      name: 'Filtrar tarjetas',
      description: 'Busca y filtra tarjetas de un tablero o columna.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          boardId: { type: 'string', description: 'ID del tablero de Trello.' },
          listId: { type: 'string', description: 'ID de la columna de Trello.' },
          query: { type: 'string', description: 'Texto a buscar en titulo o descripcion.' },
          closed: { type: 'boolean', description: 'Incluye solo tarjetas cerradas si es true, abiertas si es false.' },
          labelIds: { type: 'array', items: { type: 'string' } },
          memberIds: { type: 'array', items: { type: 'string' } },
          dueBefore: { type: 'string', description: 'Fecha maxima de vencimiento ISO 8601.' },
          dueAfter: { type: 'string', description: 'Fecha minima de vencimiento ISO 8601.' },
          dueComplete: { type: 'boolean' },
          limit: { type: 'number', description: 'Maximo de tarjetas a devolver.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                dueDate: { type: 'string' },
                dueComplete: { type: 'boolean' },
                url: { type: 'string' },
                listId: { type: 'string' },
                closed: { type: 'boolean' },
                labelIds: { type: 'array', items: { type: 'string' } },
                memberIds: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['cards'],
      },
      run: async ({ input, secrets }) => {
        const boardId = cleanString(input.boardId);
        const listId = cleanString(input.listId);
        if (!boardId && !listId) {
          return { success: false, userMessage: 'Indica un tablero o una columna de Trello.', technicalCode: 'trello_cards_scope_required' };
        }
        const closed = cleanBoolean(input.closed);
        const remoteFilter = closed === true ? 'closed' : closed === false ? 'open' : 'all';
        try {
          const cards = await callTrelloApi(
            secrets,
            'GET',
            listId
              ? `/lists/${encodeURIComponent(listId)}/cards`
              : `/boards/${encodeURIComponent(boardId)}/cards`,
            { fields: cardFields, filter: remoteFilter },
          ) as Array<Record<string, unknown>>;
          const limit = clampLimit(input.limit, 50, 500);
          return {
            success: true,
            data: { cards: filterCards(cards, input).slice(0, limit).map(normalizeCard) },
          };
        } catch (error) {
          return toResult(error, 'trello_filter_cards_failed');
        }
      },
    },
    {
      id: 'trello.create_card',
      name: 'Crear tarjeta',
      description: 'Crea una tarjeta nueva en una columna.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'ID de la columna de Trello.' },
          name: { type: 'string', description: 'Titulo de la tarjeta.' },
          description: { type: 'string', description: 'Descripcion de la tarjeta.' },
          dueDate: { type: 'string', description: 'Fecha de vencimiento en formato aceptado por Trello.' },
        },
        required: ['listId', 'name'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['id'],
      },
      run: async ({ input, secrets }) => {
        const listId = cleanString(input.listId);
        const name = cleanString(input.name);
        if (!listId || !name) {
          return { success: false, userMessage: 'Completa columna y titulo para crear la tarjeta.', technicalCode: 'trello_create_input_invalid' };
        }
        const description = cleanString(input.description);
        const dueDate = cleanString(input.dueDate);
        try {
          const card = await callTrelloApi(secrets, 'POST', '/cards', {
            idList: listId,
            name,
            ...(description ? { desc: description } : {}),
            ...(dueDate ? { due: dueDate } : {}),
          }) as Record<string, unknown>;
          return {
            success: true,
            userMessage: 'Tarjeta creada en Trello.',
            data: { id: card.id, name: card.name, url: card.url },
          };
        } catch (error) {
          return toResult(error, 'trello_create_card_failed');
        }
      },
    },
    {
      id: 'trello.update_card',
      name: 'Editar tarjeta',
      description: 'Edita una tarjeta existente de Trello.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'ID de la tarjeta.' },
          name: { type: 'string' },
          description: { type: 'string' },
          listId: { type: 'string' },
          dueDate: { type: 'string' },
          dueComplete: { type: 'boolean' },
          closed: { type: 'boolean' },
        },
        required: ['cardId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          card: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              description: { type: 'string' },
              dueDate: { type: 'string' },
              dueComplete: { type: 'boolean' },
              url: { type: 'string' },
              listId: { type: 'string' },
              closed: { type: 'boolean' },
            },
            required: ['id'],
          },
        },
        required: ['card'],
      },
      run: async ({ input, secrets }) => {
        const cardId = cleanString(input.cardId);
        if (!cardId) {
          return { success: false, userMessage: 'Indica la tarjeta de Trello.', technicalCode: 'trello_card_required' };
        }
        const params: Record<string, string> = {};
        const name = cleanString(input.name);
        const description = cleanString(input.description);
        const listId = cleanString(input.listId);
        const dueDate = cleanString(input.dueDate);
        const dueComplete = cleanBoolean(input.dueComplete);
        const closed = cleanBoolean(input.closed);
        if (name) params.name = name;
        if (description) params.desc = description;
        if (listId) params.idList = listId;
        if (dueDate) params.due = dueDate;
        if (dueComplete !== undefined) params.dueComplete = String(dueComplete);
        if (closed !== undefined) params.closed = String(closed);
        if (Object.keys(params).length === 0) {
          return { success: false, userMessage: 'Indica al menos un cambio para la tarjeta.', technicalCode: 'trello_update_input_empty' };
        }
        try {
          const card = await callTrelloApi(secrets, 'PUT', `/cards/${encodeURIComponent(cardId)}`, params) as Record<string, unknown>;
          return { success: true, userMessage: 'Tarjeta actualizada en Trello.', data: { card: normalizeCard(card) } };
        } catch (error) {
          return toResult(error, 'trello_update_card_failed');
        }
      },
    },
    {
      id: 'trello.delete_card',
      name: 'Eliminar tarjeta',
      description: 'Elimina una tarjeta de Trello.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'ID de la tarjeta.' },
        },
        required: ['cardId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          deleted: { type: 'boolean' },
        },
        required: ['id', 'deleted'],
      },
      run: async ({ input, secrets }) => {
        const cardId = cleanString(input.cardId);
        if (!cardId) {
          return { success: false, userMessage: 'Indica la tarjeta de Trello.', technicalCode: 'trello_card_required' };
        }
        try {
          await callTrelloApi(secrets, 'DELETE', `/cards/${encodeURIComponent(cardId)}`);
          return { success: true, userMessage: 'Tarjeta eliminada de Trello.', data: { id: cardId, deleted: true } };
        } catch (error) {
          return toResult(error, 'trello_delete_card_failed');
        }
      },
    },
    {
      id: 'trello.comment_card',
      name: 'Comentar tarjeta',
      description: 'Agrega un comentario a una tarjeta de Trello.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'ID de la tarjeta.' },
          text: { type: 'string', description: 'Comentario a publicar.' },
        },
        required: ['cardId', 'text'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          comment: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              date: { type: 'string' },
            },
            required: ['id'],
          },
        },
        required: ['comment'],
      },
      run: async ({ input, secrets }) => {
        const cardId = cleanString(input.cardId);
        const text = cleanString(input.text);
        if (!cardId || !text) {
          return { success: false, userMessage: 'Completa tarjeta y comentario.', technicalCode: 'trello_comment_input_invalid' };
        }
        try {
          const comment = await callTrelloApi(secrets, 'POST', `/cards/${encodeURIComponent(cardId)}/actions/comments`, { text }) as Record<string, unknown>;
          const data = comment.data && typeof comment.data === 'object' ? comment.data as Record<string, unknown> : {};
          return {
            success: true,
            userMessage: 'Comentario agregado en Trello.',
            data: { comment: { id: comment.id, text: data.text, date: comment.date } },
          };
        } catch (error) {
          return toResult(error, 'trello_comment_card_failed');
        }
      },
    },
    {
      id: 'trello.list_card_attachments',
      name: 'Listar adjuntos de tarjeta',
      description: 'Lista los adjuntos de una tarjeta de Trello sin descargar contenido.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'ID de la tarjeta.' },
        },
        required: ['cardId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                bytes: { type: 'number' },
                mimeType: { type: 'string' },
                date: { type: 'string' },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['attachments'],
      },
      run: async ({ input, secrets }) => {
        const cardId = cleanString(input.cardId);
        if (!cardId) {
          return { success: false, userMessage: 'Indica la tarjeta de Trello.', technicalCode: 'trello_card_required' };
        }
        try {
          const attachments = await callTrelloApi(secrets, 'GET', `/cards/${encodeURIComponent(cardId)}/attachments`, {
            fields: 'name,bytes,mimeType,date,url',
          }) as Array<Record<string, unknown>>;
          return { success: true, data: { attachments: attachments.map(normalizeAttachment) } };
        } catch (error) {
          return toResult(error, 'trello_list_card_attachments_failed');
        }
      },
    },
    {
      id: 'trello.download_attachment',
      name: 'Descargar adjunto',
      description: 'Descarga un adjunto de Trello al almacenamiento privado local de Forger.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'ID de la tarjeta.' },
          attachmentId: { type: 'string', description: 'ID del adjunto.' },
          fileName: { type: 'string', description: 'Nombre local opcional.' },
        },
        required: ['cardId', 'attachmentId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string' },
          fileName: { type: 'string' },
          filePath: { type: 'string' },
          size: { type: 'number' },
          sha256: { type: 'string' },
          mimeType: { type: 'string' },
        },
        required: ['attachmentId', 'fileName', 'filePath', 'size', 'sha256'],
      },
      run: async ({ input, secrets, context }) => {
        const cardId = cleanString(input.cardId);
        const attachmentId = cleanString(input.attachmentId);
        if (!cardId || !attachmentId) {
          return { success: false, userMessage: 'Indica tarjeta y adjunto de Trello.', technicalCode: 'trello_attachment_input_invalid' };
        }
        try {
          const attachments = await callTrelloApi(secrets, 'GET', `/cards/${encodeURIComponent(cardId)}/attachments`, {
            fields: 'name,bytes,mimeType,date,url',
          }) as Array<Record<string, unknown>>;
          const attachment = attachments.find((candidate) => candidate.id === attachmentId);
          const attachmentUrl = cleanString(attachment?.url);
          if (!attachment || !attachmentUrl) {
            return { success: false, userMessage: 'No encontramos ese adjunto de Trello.', technicalCode: 'trello_attachment_not_found' };
          }
          const fileName = sanitizeFileName(input.fileName, cleanString(attachment.name) || `${attachmentId}.bin`);
          const downloaded = await callTrelloDownload(secrets, attachmentUrl);
          const downloadsRoot = path.join(context.metadataRoot, 'downloads', cardId);
          await fs.mkdir(downloadsRoot, { recursive: true, mode: 0o700 });
          const filePath = path.join(downloadsRoot, `${Date.now()}-${fileName}`);
          await fs.writeFile(filePath, downloaded.buffer, { mode: 0o600 });
          return {
            success: true,
            userMessage: 'Adjunto descargado desde Trello.',
            data: {
              attachmentId,
              fileName,
              filePath,
              size: downloaded.size ?? downloaded.buffer.byteLength,
              sha256: createHash('sha256').update(downloaded.buffer).digest('hex'),
              mimeType: cleanString(attachment.mimeType) || downloaded.contentType,
            },
          };
        } catch (error) {
          return toResult(error, 'trello_download_attachment_failed');
        }
      },
    },
    {
      id: 'trello.upload_attachment',
      name: 'Subir adjunto',
      description: 'Sube un archivo local autorizado como adjunto de una tarjeta de Trello.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          cardId: { type: 'string', description: 'ID de la tarjeta.' },
          filePath: { type: 'string', description: 'Ruta absoluta del archivo local autorizado.' },
          name: { type: 'string', description: 'Nombre visible opcional del adjunto.' },
        },
        required: ['cardId', 'filePath'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          attachment: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              bytes: { type: 'number' },
              mimeType: { type: 'string' },
            },
            required: ['id'],
          },
        },
        required: ['attachment'],
      },
      run: async ({ input, secrets }) => {
        const cardId = cleanString(input.cardId);
        const filePath = cleanString(input.filePath);
        if (!cardId || !filePath) {
          return { success: false, userMessage: 'Indica tarjeta y archivo para subir a Trello.', technicalCode: 'trello_upload_input_invalid' };
        }
        try {
          const attachment = await callTrelloUpload(secrets, cardId, {
            filePath,
            name: cleanString(input.name) || undefined,
          }) as Record<string, unknown>;
          return {
            success: true,
            userMessage: 'Adjunto subido a Trello.',
            data: { attachment: normalizeAttachment(attachment) },
          };
        } catch (error) {
          return toResult(error, 'trello_upload_attachment_failed');
        }
      },
    },
  ],
});
