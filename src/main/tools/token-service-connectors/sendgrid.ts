import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, fail, json, list, moduleFrom, objectSchema, record, req, schema, secret } from './helpers';

const api = (key: string, path: string, init: RequestInit = {}) =>
  json(`https://api.sendgrid.com/v3${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) } }, 'sendgrid');
const emails = (value: unknown) => list(value).map(clean).filter(Boolean);

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'sendgrid.send_email', name: 'Enviar email', description: 'Envia un email.', risk: 'high',
    inputSchema: schema({ fromEmail: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, text: { type: 'string' }, html: { type: 'string' } }, ['fromEmail', 'to', 'subject']),
    outputSchema: schema({ accepted: { type: 'boolean' } }, ['accepted']),
    run: async ({ input, secrets }) => {
      const from = req(input, 'fromEmail', 'sendgrid_from_required'); const subject = req(input, 'subject', 'sendgrid_subject_required'); const to = emails(input.to);
      if (typeof from !== 'string') return from; if (typeof subject !== 'string') return subject; if (!to.length) return fail('sendgrid_to_required');
      await api(secrets.api_key, '/mail/send', { method: 'POST', body: JSON.stringify({ personalizations: [{ to: to.map((email) => ({ email })) }], from: { email: from }, subject, content: [{ type: 'text/plain', value: clean(input.text) || clean(input.html) }] }) });
      return { success: true, data: { accepted: true } };
    },
  },
  {
    id: 'sendgrid.send_template_email', name: 'Enviar template', description: 'Envia un dynamic template.', risk: 'high',
    inputSchema: schema({ fromEmail: { type: 'string' }, to: { type: 'array', items: { type: 'string' } }, templateId: { type: 'string' }, dynamicTemplateData: { type: 'object' } }, ['fromEmail', 'to', 'templateId']),
    outputSchema: schema({ accepted: { type: 'boolean' } }, ['accepted']),
    run: async ({ input, secrets }) => {
      const from = req(input, 'fromEmail', 'sendgrid_from_required'); const template = req(input, 'templateId', 'sendgrid_template_required'); const to = emails(input.to);
      if (typeof from !== 'string') return from; if (typeof template !== 'string') return template; if (!to.length) return fail('sendgrid_to_required');
      await api(secrets.api_key, '/mail/send', { method: 'POST', body: JSON.stringify({ personalizations: [{ to: to.map((email) => ({ email })), dynamic_template_data: record(input.dynamicTemplateData) }], from: { email: from }, template_id: template }) });
      return { success: true, data: { accepted: true } };
    },
  },
  {
    id: 'sendgrid.list_templates', name: 'Listar templates', description: 'Lista templates.', risk: 'low',
    inputSchema: schema(), outputSchema: arraySchema('templates'),
    run: async ({ secrets }) => ({ success: true, data: { templates: list(record(await api(secrets.api_key, '/templates?generations=dynamic')).templates) } }),
  },
  {
    id: 'sendgrid.get_template', name: 'Leer template', description: 'Obtiene un template.', risk: 'medium',
    inputSchema: schema({ templateId: { type: 'string' } }, ['templateId']), outputSchema: objectSchema('template'),
    run: async ({ input, secrets }) => { const id = req(input, 'templateId', 'sendgrid_template_required'); return typeof id === 'string' ? { success: true, data: { template: await api(secrets.api_key, `/templates/${id}`) } } : id; },
  },
  {
    id: 'sendgrid.list_contacts', name: 'Listar contactos', description: 'Busca contactos.', risk: 'medium',
    inputSchema: schema({ query: { type: 'string' } }), outputSchema: arraySchema('contacts'),
    run: async ({ input, secrets }) => {
      const data = record(await api(secrets.api_key, '/marketing/contacts/search', { method: 'POST', body: JSON.stringify({ query: clean(input.query) || 'email LIKE "%@%"' }) }));
      return { success: true, data: { contacts: list(data.result) } };
    },
  },
  {
    id: 'sendgrid.upsert_contact', name: 'Guardar contacto', description: 'Crea o actualiza contactos.', risk: 'high',
    inputSchema: schema({ contacts: { type: 'array', items: { type: 'object' } }, listIds: { type: 'array', items: { type: 'string' } } }, ['contacts']), outputSchema: objectSchema('job'),
    run: async ({ input, secrets }) => Array.isArray(input.contacts) ? { success: true, data: { job: await api(secrets.api_key, '/marketing/contacts', { method: 'PUT', body: JSON.stringify({ contacts: input.contacts, list_ids: input.listIds }) }) } } : fail('sendgrid_contacts_required'),
  },
  {
    id: 'sendgrid.delete_contact', name: 'Eliminar contactos', description: 'Elimina contactos.', risk: 'high',
    inputSchema: schema({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']), outputSchema: schema({ deleted: { type: 'boolean' } }, ['deleted']),
    run: async ({ input, secrets }) => {
      const ids = list(input.ids).map(clean).filter(Boolean); if (!ids.length) return fail('sendgrid_contact_ids_required');
      await api(secrets.api_key, `/marketing/contacts?ids=${encodeURIComponent(ids.join(','))}`, { method: 'DELETE' });
      return { success: true, data: { deleted: true } };
    },
  },
  {
    id: 'sendgrid.get_suppressions', name: 'Leer suppressions', description: 'Lista suppressions globales.', risk: 'medium',
    inputSchema: schema(), outputSchema: arraySchema('suppressions'),
    run: async ({ secrets }) => ({ success: true, data: { suppressions: list(await api(secrets.api_key, '/asm/suppressions/global')) } }),
  },
];

export const sendgridToolModule = moduleFrom({
  id: 'sendgrid', name: 'SendGrid', description: 'Envia emails y administra templates/contactos de SendGrid.',
  secrets: [secret('api_key', 'API key de SendGrid', 'API key con permisos necesarios.')],
  validate: async (secrets) => {
    const profile = record(await api(secrets.api_key, '/user/profile'));
    return { ok: true, data: { email: clean(profile.email), username: clean(profile.username) } };
  },
  actions,
});
