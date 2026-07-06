import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, fail, json, list, moduleFrom, objectSchema, record, req, schema, secret } from './helpers';

const api = (token: string, path: string, init: RequestInit = {}) =>
  json(`https://api.figma.com/v1${path}`, { ...init, headers: { 'X-Figma-Token': token, ...(init.headers ?? {}) } }, 'figma');

const fileReq = (input: Record<string, unknown>) => req(input, 'fileKey', 'figma_file_key_required');

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'figma.get_file', name: 'Leer archivo', description: 'Obtiene un archivo de Figma.', risk: 'medium',
    inputSchema: schema({ fileKey: { type: 'string' }, depth: { type: 'number' } }, ['fileKey']), outputSchema: objectSchema('file'),
    run: async ({ input, secrets }) => {
      const fileKey = fileReq(input); if (typeof fileKey !== 'string') return fileKey;
      const suffix = typeof input.depth === 'number' ? `?depth=${input.depth}` : '';
      return { success: true, data: { file: await api(secrets.access_token, `/files/${encodeURIComponent(fileKey)}${suffix}`) } };
    },
  },
  {
    id: 'figma.get_file_nodes', name: 'Leer nodos', description: 'Obtiene nodos de un archivo.', risk: 'medium',
    inputSchema: schema({ fileKey: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } } }, ['fileKey', 'nodeIds']), outputSchema: objectSchema('nodes'),
    run: async ({ input, secrets }) => {
      const fileKey = fileReq(input); if (typeof fileKey !== 'string') return fileKey;
      const ids = list(input.nodeIds).map(clean).filter(Boolean); if (!ids.length) return fail('figma_node_ids_required');
      return { success: true, data: { nodes: record((await api(secrets.access_token, `/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids.join(','))}`) as Record<string, unknown>).nodes) } };
    },
  },
  {
    id: 'figma.get_images', name: 'Renderizar imagenes', description: 'Genera URLs temporales de imagenes.', risk: 'medium',
    inputSchema: schema({ fileKey: { type: 'string' }, nodeIds: { type: 'array', items: { type: 'string' } }, format: { type: 'string' } }, ['fileKey', 'nodeIds']), outputSchema: objectSchema('images'),
    run: async ({ input, secrets }) => {
      const fileKey = fileReq(input); if (typeof fileKey !== 'string') return fileKey;
      const ids = list(input.nodeIds).map(clean).filter(Boolean); if (!ids.length) return fail('figma_node_ids_required');
      const data = record(await api(secrets.access_token, `/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(ids.join(','))}&format=${clean(input.format) || 'png'}`));
      return { success: true, data: { images: record(data.images) } };
    },
  },
  {
    id: 'figma.get_comments', name: 'Listar comentarios', description: 'Lista comentarios de un archivo.', risk: 'medium',
    inputSchema: schema({ fileKey: { type: 'string' } }, ['fileKey']), outputSchema: arraySchema('comments'),
    run: async ({ input, secrets }) => {
      const fileKey = fileReq(input); if (typeof fileKey !== 'string') return fileKey;
      return { success: true, data: { comments: list(record(await api(secrets.access_token, `/files/${encodeURIComponent(fileKey)}/comments`)).comments) } };
    },
  },
  {
    id: 'figma.create_comment', name: 'Crear comentario', description: 'Crea un comentario en Figma.', risk: 'high',
    inputSchema: schema({ fileKey: { type: 'string' }, message: { type: 'string' }, nodeId: { type: 'string' } }, ['fileKey', 'message']), outputSchema: objectSchema('comment'),
    run: async ({ input, secrets }) => {
      const fileKey = fileReq(input); const message = req(input, 'message', 'figma_message_required');
      if (typeof fileKey !== 'string') return fileKey; if (typeof message !== 'string') return message;
      return { success: true, userMessage: 'Comentario creado en Figma.', data: { comment: await api(secrets.access_token, `/files/${encodeURIComponent(fileKey)}/comments`, { method: 'POST', body: JSON.stringify({ message }) }) } };
    },
  },
  {
    id: 'figma.delete_comment', name: 'Eliminar comentario', description: 'Elimina un comentario.', risk: 'high',
    inputSchema: schema({ fileKey: { type: 'string' }, commentId: { type: 'string' } }, ['fileKey', 'commentId']), outputSchema: schema({ deleted: { type: 'boolean' } }, ['deleted']),
    run: async ({ input, secrets }) => {
      const fileKey = fileReq(input); const commentId = req(input, 'commentId', 'figma_comment_required');
      if (typeof fileKey !== 'string') return fileKey; if (typeof commentId !== 'string') return commentId;
      await api(secrets.access_token, `/files/${encodeURIComponent(fileKey)}/comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
      return { success: true, data: { deleted: true } };
    },
  },
  {
    id: 'figma.get_team_projects', name: 'Listar proyectos', description: 'Lista proyectos de un equipo.', risk: 'low',
    inputSchema: schema({ teamId: { type: 'string' } }, ['teamId']), outputSchema: arraySchema('projects'),
    run: async ({ input, secrets }) => {
      const teamId = req(input, 'teamId', 'figma_team_required'); if (typeof teamId !== 'string') return teamId;
      return { success: true, data: { projects: list(record(await api(secrets.access_token, `/teams/${encodeURIComponent(teamId)}/projects`)).projects) } };
    },
  },
  {
    id: 'figma.get_project_files', name: 'Listar archivos', description: 'Lista archivos de un proyecto.', risk: 'low',
    inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']), outputSchema: arraySchema('files'),
    run: async ({ input, secrets }) => {
      const projectId = req(input, 'projectId', 'figma_project_required'); if (typeof projectId !== 'string') return projectId;
      return { success: true, data: { files: list(record(await api(secrets.access_token, `/projects/${encodeURIComponent(projectId)}/files`)).files) } };
    },
  },
];

export const figmaToolModule = moduleFrom({
  id: 'figma', name: 'Figma', description: 'Lee archivos, nodos, imagenes y comentarios de Figma.',
  secrets: [secret('access_token', 'Token de acceso de Figma', 'Personal Access Token u OAuth token de Figma.')],
  validate: async (secrets) => {
    const me = record(await api(secrets.access_token, '/me'));
    return { ok: true, data: { subject: clean(me.id), email: clean(me.email), username: clean(me.handle) } };
  },
  actions,
});
