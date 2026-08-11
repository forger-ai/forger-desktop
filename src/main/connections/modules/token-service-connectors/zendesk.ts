import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, basic, clean, host, json, moduleFrom, objectSchema, record, req, reqNum, schema, secret } from './helpers';

const base = (s: Record<string, string>) => `https://${host(s.subdomain)}.zendesk.com`;
const headers = (s: Record<string, string>) => ({ Authorization: basic(`${s.email}/token`, s.api_token) });
const api = (s: Record<string, string>, path: string, init: RequestInit = {}) =>
  json(`${base(s)}${path}`, { ...init, headers: { ...headers(s), ...(init.headers ?? {}) } }, 'zendesk');

const listAction = (id: string, name: string, path: string, key: string, risk: 'medium' | 'low'): TokenConnectorActionDefinition => ({
  id, name, description: `${name} de Zendesk.`, risk,
  inputSchema: schema({ limit: { type: 'number' } }), outputSchema: arraySchema(key),
  run: async ({ input, secrets }) => {
    const data = record(await api(secrets, `${path}?per_page=${input.limit ?? 25}`));
    return { success: true, data: { [key]: Array.isArray(data[key]) ? data[key] : [] } };
  },
});

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'zendesk.search', name: 'Buscar', description: 'Busca tickets, usuarios u objetos.', risk: 'medium',
    inputSchema: schema({ query: { type: 'string' } }, ['query']), outputSchema: arraySchema('results'),
    run: async ({ input, secrets }) => {
      const query = req(input, 'query', 'zendesk_query_required'); if (typeof query !== 'string') return query;
      return { success: true, data: { results: record(await api(secrets, `/api/v2/search.json?query=${encodeURIComponent(query)}`)).results ?? [] } };
    },
  },
  listAction('zendesk.list_tickets', 'Listar tickets', '/api/v2/tickets.json', 'tickets', 'medium'),
  listAction('zendesk.list_users', 'Listar usuarios', '/api/v2/users.json', 'users', 'medium'),
  {
    id: 'zendesk.get_ticket', name: 'Leer ticket', description: 'Obtiene un ticket.', risk: 'medium',
    inputSchema: schema({ ticketId: { type: 'number' } }, ['ticketId']), outputSchema: objectSchema('ticket'),
    run: async ({ input, secrets }) => {
      const id = reqNum(input, 'ticketId', 'zendesk_ticket_required'); if (typeof id !== 'number') return id;
      return { success: true, data: { ticket: record(record(await api(secrets, `/api/v2/tickets/${id}.json`)).ticket) } };
    },
  },
  {
    id: 'zendesk.create_ticket', name: 'Crear ticket', description: 'Crea un ticket.', risk: 'high',
    inputSchema: schema({ subject: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' }, type: { type: 'string' } }, ['subject', 'body']),
    outputSchema: objectSchema('ticket'),
    run: async ({ input, secrets }) => {
      const subject = req(input, 'subject', 'zendesk_subject_required'); const body = req(input, 'body', 'zendesk_body_required');
      if (typeof subject !== 'string') return subject; if (typeof body !== 'string') return body;
      const ticket = { subject, comment: { body }, priority: clean(input.priority) || undefined, type: clean(input.type) || undefined };
      const data = record(await api(secrets, '/api/v2/tickets.json', { method: 'POST', body: JSON.stringify({ ticket }) }));
      return { success: true, userMessage: 'Ticket creado en Zendesk.', data: { ticket: record(data.ticket) } };
    },
  },
  {
    id: 'zendesk.update_ticket', name: 'Actualizar ticket', description: 'Actualiza un ticket.', risk: 'high',
    inputSchema: schema({ ticketId: { type: 'number' }, subject: { type: 'string' }, status: { type: 'string' }, priority: { type: 'string' } }, ['ticketId']),
    outputSchema: objectSchema('ticket'),
    run: async ({ input, secrets }) => {
      const id = reqNum(input, 'ticketId', 'zendesk_ticket_required'); if (typeof id !== 'number') return id;
      const ticket = { subject: clean(input.subject) || undefined, status: clean(input.status) || undefined, priority: clean(input.priority) || undefined };
      const data = record(await api(secrets, `/api/v2/tickets/${id}.json`, { method: 'PUT', body: JSON.stringify({ ticket }) }));
      return { success: true, userMessage: 'Ticket actualizado en Zendesk.', data: { ticket: record(data.ticket) } };
    },
  },
  {
    id: 'zendesk.add_ticket_comment', name: 'Comentar ticket', description: 'Agrega comentario a un ticket.', risk: 'high',
    inputSchema: schema({ ticketId: { type: 'number' }, body: { type: 'string' }, public: { type: 'boolean' } }, ['ticketId', 'body']),
    outputSchema: objectSchema('ticket'),
    run: async ({ input, secrets }) => {
      const id = reqNum(input, 'ticketId', 'zendesk_ticket_required'); const body = req(input, 'body', 'zendesk_body_required');
      if (typeof id !== 'number') return id; if (typeof body !== 'string') return body;
      const data = record(await api(secrets, `/api/v2/tickets/${id}.json`, { method: 'PUT', body: JSON.stringify({ ticket: { comment: { body, public: input.public !== false } } }) }));
      return { success: true, data: { ticket: record(data.ticket) } };
    },
  },
];

export const zendeskToolModule = moduleFrom({
  id: 'zendesk', name: 'Zendesk', description: 'Busca y administra tickets de Zendesk.',
  secrets: [secret('subdomain', 'Subdominio de Zendesk', 'Ejemplo: acme para acme.zendesk.com.'), secret('email', 'Email de Zendesk', 'Email del usuario del token.'), secret('api_token', 'API token de Zendesk', 'Token de API de Zendesk.')],
  validate: async (secrets) => {
    const user = record(record(await api(secrets, '/api/v2/users/me.json')).user);
    return { ok: true, data: { subject: String(user.id ?? ''), email: clean(user.email), username: clean(user.name), workspace: host(secrets.subdomain) } };
  },
  actions,
});
