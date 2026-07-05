import type { CallOfficialToolResult } from '../../../shared/types';
import type { InternalToolModule } from '../types';
import { ConnectorApiError, createTokenConnectorModule } from '../token-connector';

export const TRELLO_TOOL_ID = 'trello';
export const TRELLO_API_KEY_SECRET = 'api_key';
export const TRELLO_API_TOKEN_SECRET = 'api_token';

const TRELLO_API_BASE = 'https://api.trello.com/1';

const callTrelloApi = async (
  secrets: Record<string, string>,
  method: 'GET' | 'POST',
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
  return await response.json();
};

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, numeric));
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
  description: 'Revisa tableros y crea tarjetas de Trello usando una API key y token guardados localmente en secretos.',
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
                url: { type: 'string' },
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
            fields: 'name,desc,due,url',
          }) as Array<Record<string, unknown>>;
          const limit = clampLimit(input.limit, 50, 200);
          return {
            success: true,
            data: {
              cards: cards.slice(0, limit).map((card) => ({
                id: card.id,
                name: card.name,
                description: card.desc,
                dueDate: card.due,
                url: card.url,
              })),
            },
          };
        } catch (error) {
          return toResult(error, 'trello_list_cards_failed');
        }
      },
    },
    {
      id: 'trello.create_card',
      name: 'Crear tarjeta',
      description: 'Crea una tarjeta nueva en una columna.',
      risk: 'high',
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
  ],
});
