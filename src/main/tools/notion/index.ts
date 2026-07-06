import type { CallOfficialToolResult } from '../../../shared/types';
import type { InternalToolModule } from '../types';
import { ConnectorApiError, createTokenConnectorModule } from '../token-connector';

export const NOTION_TOOL_ID = 'notion';
export const NOTION_INTEGRATION_TOKEN_SECRET = 'integration_token';

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const notionFetch = async (
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const normalizedHeaders = new Headers(init.headers);
  const headers: Record<string, string> = {};
  normalizedHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  headers.Authorization = `Bearer ${token}`;
  headers['Notion-Version'] = NOTION_VERSION;
  headers.Accept = 'application/json';
  if (init.body && !normalizedHeaders.has('content-type')) {
    headers['content-type'] = 'application/json; charset=utf-8';
  }
  const response = await fetch(`${NOTION_API_BASE}${path}`, { ...init, headers });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = isRecord(data) ? cleanString(data.code) : '';
    throw new ConnectorApiError(code ? `notion_api_${code}` : `notion_http_${response.status}`);
  }
  return data;
};

const toResult = (error: unknown, fallbackCode: string): CallOfficialToolResult => ({
  success: false,
  userMessage: 'No pudimos completar la accion de Notion. Revisa el token y que la pagina o base este compartida con la integracion.',
  technicalCode: error instanceof ConnectorApiError
    ? error.technicalCode
    : error instanceof Error ? error.message : fallbackCode,
});

const pageParent = (input: Record<string, unknown>): Record<string, unknown> | null => {
  const pageId = cleanString(input.parentPageId);
  const databaseId = cleanString(input.databaseId);
  if (databaseId) {
    return { database_id: databaseId };
  }
  if (pageId) {
    return { page_id: pageId };
  }
  return null;
};

const titleProperties = (title: string): Record<string, unknown> => ({
  title: {
    title: [{ text: { content: title } }],
  },
});

export const notionToolModule: InternalToolModule = createTokenConnectorModule({
  id: NOTION_TOOL_ID,
  name: 'Notion',
  description: 'Busca, lee y actualiza paginas y bases de Notion usando un token de integracion guardado localmente.',
  version: '0.1.0',
  connectionStatusActionId: 'notion.connection.status',
  secrets: [
    {
      name: NOTION_INTEGRATION_TOKEN_SECRET,
      label: 'Token de integracion de Notion',
      required: true,
      usage: 'Internal Integration Secret de Notion. Las paginas o bases deben estar compartidas con esa integracion. Se guarda cifrado en este equipo.',
    },
  ],
  changelog: ['Conector local de Notion con token de integracion.'],
  copy: {
    secretsMissing: 'Conecta Notion agregando el token de integracion.',
    connected: 'Notion quedo conectado.',
    connectFailed: 'No pudimos validar el token de Notion. Revisa el token y permisos de la integracion.',
  },
  validate: async (secrets) => {
    try {
      const user = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, '/users/me') as Record<string, unknown>;
      return {
        ok: true,
        data: {
          subject: cleanString(user.id),
          username: cleanString(user.name) || 'Notion integration',
        },
      };
    } catch (error) {
      return {
        ok: false,
        technicalCode: error instanceof ConnectorApiError ? error.technicalCode : 'notion_validation_failed',
      };
    }
  },
  actions: [
    {
      id: 'notion.connection.status',
      name: 'Estado de conexion',
      description: 'Revisa si el token de Notion esta conectado.',
      risk: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean' },
          username: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['connected'],
      },
      run: async () => ({ success: true, data: { connected: true } }),
    },
    {
      id: 'notion.search',
      name: 'Buscar',
      description: 'Busca paginas o bases compartidas con la integracion.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          filterObject: { type: 'string', description: 'page o database.' },
          pageSize: { type: 'number' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: { results: { type: 'array', items: { type: 'object' } } },
        required: ['results'],
      },
      run: async ({ input, secrets }) => {
        try {
          const filterObject = cleanString(input.filterObject);
          const body: Record<string, unknown> = {
            query: cleanString(input.query),
            page_size: typeof input.pageSize === 'number' ? Math.min(100, Math.max(1, Math.round(input.pageSize))) : 20,
          };
          if (filterObject === 'page' || filterObject === 'database') {
            body.filter = { value: filterObject, property: 'object' };
          }
          const data = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, '/search', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return { success: true, data };
        } catch (error) {
          return toResult(error, 'notion_search_failed');
        }
      },
    },
    {
      id: 'notion.get_page',
      name: 'Leer pagina',
      description: 'Obtiene una pagina de Notion.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
      },
      run: async ({ input, secrets }) => {
        const pageId = cleanString(input.pageId);
        if (!pageId) {
          return { success: false, userMessage: 'Indica la pagina de Notion.', technicalCode: 'notion_page_required' };
        }
        try {
          const data = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, `/pages/${encodeURIComponent(pageId)}`);
          return { success: true, data };
        } catch (error) {
          return toResult(error, 'notion_get_page_failed');
        }
      },
    },
    {
      id: 'notion.get_database',
      name: 'Leer base',
      description: 'Obtiene una base de datos de Notion.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: { databaseId: { type: 'string' } },
        required: ['databaseId'],
      },
      run: async ({ input, secrets }) => {
        const databaseId = cleanString(input.databaseId);
        if (!databaseId) {
          return { success: false, userMessage: 'Indica la base de Notion.', technicalCode: 'notion_database_required' };
        }
        try {
          const data = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, `/databases/${encodeURIComponent(databaseId)}`);
          return { success: true, data };
        } catch (error) {
          return toResult(error, 'notion_get_database_failed');
        }
      },
    },
    {
      id: 'notion.query_database',
      name: 'Consultar base',
      description: 'Consulta una base de datos de Notion.',
      risk: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          databaseId: { type: 'string' },
          filter: { type: 'object' },
          sorts: { type: 'array', items: { type: 'object' } },
          pageSize: { type: 'number' },
        },
        required: ['databaseId'],
      },
      run: async ({ input, secrets }) => {
        const databaseId = cleanString(input.databaseId);
        if (!databaseId) {
          return { success: false, userMessage: 'Indica la base de Notion.', technicalCode: 'notion_database_required' };
        }
        try {
          const body: Record<string, unknown> = {
            page_size: typeof input.pageSize === 'number' ? Math.min(100, Math.max(1, Math.round(input.pageSize))) : 20,
          };
          if (isRecord(input.filter)) body.filter = input.filter;
          if (Array.isArray(input.sorts)) body.sorts = input.sorts;
          const data = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, `/databases/${encodeURIComponent(databaseId)}/query`, {
            method: 'POST',
            body: JSON.stringify(body),
          });
          return { success: true, data };
        } catch (error) {
          return toResult(error, 'notion_query_database_failed');
        }
      },
    },
    {
      id: 'notion.create_page',
      name: 'Crear pagina',
      description: 'Crea una pagina en Notion bajo una pagina o base compartida.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          parentPageId: { type: 'string' },
          databaseId: { type: 'string' },
          title: { type: 'string' },
          properties: { type: 'object' },
          children: { type: 'array', items: { type: 'object' } },
        },
        required: ['title'],
      },
      run: async ({ input, secrets }) => {
        const title = cleanString(input.title);
        const parent = pageParent(input);
        if (!title || !parent) {
          return { success: false, userMessage: 'Completa titulo y pagina o base parent de Notion.', technicalCode: 'notion_create_input_invalid' };
        }
        try {
          const properties = isRecord(input.properties) ? input.properties : titleProperties(title);
          const data = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, '/pages', {
            method: 'POST',
            body: JSON.stringify({
              parent,
              properties,
              ...(Array.isArray(input.children) ? { children: input.children } : {}),
            }),
          });
          return { success: true, userMessage: 'Pagina creada en Notion.', data };
        } catch (error) {
          return toResult(error, 'notion_create_page_failed');
        }
      },
    },
    {
      id: 'notion.update_page',
      name: 'Actualizar pagina',
      description: 'Actualiza propiedades o estado archivado de una pagina de Notion.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          properties: { type: 'object' },
          archived: { type: 'boolean' },
        },
        required: ['pageId'],
      },
      run: async ({ input, secrets }) => {
        const pageId = cleanString(input.pageId);
        if (!pageId) {
          return { success: false, userMessage: 'Indica la pagina de Notion.', technicalCode: 'notion_page_required' };
        }
        try {
          const body: Record<string, unknown> = {};
          if (isRecord(input.properties)) body.properties = input.properties;
          if (typeof input.archived === 'boolean') body.archived = input.archived;
          const data = await notionFetch(secrets[NOTION_INTEGRATION_TOKEN_SECRET] as string, `/pages/${encodeURIComponent(pageId)}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          return { success: true, userMessage: 'Pagina actualizada en Notion.', data };
        } catch (error) {
          return toResult(error, 'notion_update_page_failed');
        }
      },
    },
  ],
});
