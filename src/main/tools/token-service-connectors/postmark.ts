import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, fail, json, list, moduleFrom, objectSchema, record, req, reqNum, schema, secret } from './helpers';

const api = (token: string, path: string, init: RequestInit = {}) =>
  json(`https://api.postmarkapp.com${path}`, { ...init, headers: { 'X-Postmark-Server-Token': token, Accept: 'application/json', ...(init.headers ?? {}) } }, 'postmark');

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'postmark.send_email', name: 'Enviar email', description: 'Envia un email.', risk: 'high',
    inputSchema: schema({ from: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' }, textBody: { type: 'string' }, htmlBody: { type: 'string' } }, ['from', 'to', 'subject']),
    outputSchema: objectSchema('message'),
    run: async ({ input, secrets }) => {
      const from = req(input, 'from', 'postmark_from_required'); const to = req(input, 'to', 'postmark_to_required'); const subject = req(input, 'subject', 'postmark_subject_required');
      if (typeof from !== 'string') return from; if (typeof to !== 'string') return to; if (typeof subject !== 'string') return subject;
      const message = await api(secrets.server_token, '/email', { method: 'POST', body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: clean(input.textBody), HtmlBody: clean(input.htmlBody) }) });
      return { success: true, data: { message } };
    },
  },
  {
    id: 'postmark.send_batch', name: 'Enviar batch', description: 'Envia varios emails.', risk: 'high',
    inputSchema: schema({ messages: { type: 'array', items: { type: 'object' } } }, ['messages']), outputSchema: arraySchema('messages'),
    run: async ({ input, secrets }) => Array.isArray(input.messages) ? { success: true, data: { messages: list(await api(secrets.server_token, '/email/batch', { method: 'POST', body: JSON.stringify(input.messages) })) } } : fail('postmark_messages_required'),
  },
  {
    id: 'postmark.list_templates', name: 'Listar templates', description: 'Lista templates.', risk: 'low',
    inputSchema: schema({ count: { type: 'number' } }), outputSchema: arraySchema('templates'),
    run: async ({ input, secrets }) => ({ success: true, data: { templates: list(record(await api(secrets.server_token, `/templates?Count=${input.count ?? 50}&Offset=0`)).Templates) } }),
  },
  {
    id: 'postmark.get_template', name: 'Leer template', description: 'Obtiene un template.', risk: 'medium',
    inputSchema: schema({ templateId: { type: 'number' } }, ['templateId']), outputSchema: objectSchema('template'),
    run: async ({ input, secrets }) => { const id = reqNum(input, 'templateId', 'postmark_template_required'); return typeof id === 'number' ? { success: true, data: { template: await api(secrets.server_token, `/templates/${id}`) } } : id; },
  },
  {
    id: 'postmark.create_template', name: 'Crear template', description: 'Crea un template.', risk: 'high',
    inputSchema: schema({ name: { type: 'string' }, subject: { type: 'string' }, htmlBody: { type: 'string' }, textBody: { type: 'string' } }, ['name', 'subject']), outputSchema: objectSchema('template'),
    run: async ({ input, secrets }) => {
      const name = req(input, 'name', 'postmark_name_required'); const subject = req(input, 'subject', 'postmark_subject_required');
      if (typeof name !== 'string') return name; if (typeof subject !== 'string') return subject;
      return { success: true, data: { template: await api(secrets.server_token, '/templates', { method: 'POST', body: JSON.stringify({ Name: name, Subject: subject, HtmlBody: clean(input.htmlBody), TextBody: clean(input.textBody) }) }) } };
    },
  },
  {
    id: 'postmark.update_template', name: 'Actualizar template', description: 'Actualiza un template.', risk: 'high',
    inputSchema: schema({ templateId: { type: 'number' }, name: { type: 'string' }, subject: { type: 'string' }, htmlBody: { type: 'string' }, textBody: { type: 'string' } }, ['templateId']), outputSchema: objectSchema('template'),
    run: async ({ input, secrets }) => {
      const id = reqNum(input, 'templateId', 'postmark_template_required'); if (typeof id !== 'number') return id;
      const body = { Name: clean(input.name) || undefined, Subject: clean(input.subject) || undefined, HtmlBody: clean(input.htmlBody) || undefined, TextBody: clean(input.textBody) || undefined };
      return { success: true, data: { template: await api(secrets.server_token, `/templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }) } };
    },
  },
  {
    id: 'postmark.get_message', name: 'Leer mensaje', description: 'Obtiene detalle de mensaje.', risk: 'medium',
    inputSchema: schema({ messageId: { type: 'string' } }, ['messageId']), outputSchema: objectSchema('message'),
    run: async ({ input, secrets }) => { const id = req(input, 'messageId', 'postmark_message_required'); return typeof id === 'string' ? { success: true, data: { message: await api(secrets.server_token, `/messages/outbound/${encodeURIComponent(id)}/details`) } } : id; },
  },
  {
    id: 'postmark.list_bounces', name: 'Listar bounces', description: 'Lista bounces.', risk: 'medium',
    inputSchema: schema({ count: { type: 'number' } }), outputSchema: arraySchema('bounces'),
    run: async ({ input, secrets }) => ({ success: true, data: { bounces: list(record(await api(secrets.server_token, `/bounces?count=${input.count ?? 50}&offset=0`)).Bounces) } }),
  },
];

export const postmarkToolModule = moduleFrom({
  id: 'postmark', name: 'Postmark', description: 'Envia emails y administra templates/bounces de Postmark.',
  secrets: [secret('server_token', 'Server API token de Postmark', 'Token del servidor de Postmark.')],
  validate: async (secrets) => {
    const server = record(await api(secrets.server_token, '/server'));
    return { ok: true, data: { subject: String(server.ID ?? ''), workspace: clean(server.Name) } };
  },
  actions,
});
