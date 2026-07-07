import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, fail, json, list, moduleFrom, objectSchema, proof, record, req, schema, secret } from './helpers';

const version = (s: Record<string, string>) => clean(s.api_version) || 'v23.0';
const api = (s: Record<string, string>, path: string, init: RequestInit = {}) => {
  const url = new URL(`https://graph.facebook.com/${version(s)}${path}`);
  const appProof = proof(s.access_token, clean(s.app_secret)); if (appProof) url.searchParams.set('appsecret_proof', appProof);
  return json(url.toString(), { ...init, headers: { Authorization: `Bearer ${s.access_token}`, ...(init.headers ?? {}) } }, 'whatsapp_business');
};
const phone = (input: Record<string, unknown>, s: Record<string, string>) => clean(input.phoneNumberId) || s.phone_number_id;

const sendMessage = (id: string, name: string, bodyFor: (input: Record<string, unknown>) => Record<string, unknown> | null): TokenConnectorActionDefinition => ({
  id, name, description: `${name} por WhatsApp Business Cloud.`, risk: 'high',
  inputSchema: schema({ to: { type: 'string' }, body: { type: 'string' }, templateName: { type: 'string' }, languageCode: { type: 'string' }, mediaId: { type: 'string' }, mediaType: { type: 'string' }, phoneNumberId: { type: 'string' } }),
  outputSchema: objectSchema('message'),
  run: async ({ input, secrets }) => {
    const to = req(input, 'to', 'whatsapp_business_to_required'); if (typeof to !== 'string') return to;
    const phoneNumber = phone(input, secrets); if (!phoneNumber) return fail('whatsapp_business_phone_number_required');
    const body = bodyFor(input); if (!body) return fail('whatsapp_business_input_invalid');
    return { success: true, userMessage: 'Mensaje enviado por WhatsApp Business.', data: { message: await api(secrets, `/${phoneNumber}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', to, ...body }) }) } };
  },
});

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'whatsapp_business.list_phone_numbers', name: 'Listar numeros', description: 'Lista numeros de la cuenta WABA.', risk: 'low',
    inputSchema: schema(), outputSchema: arraySchema('phoneNumbers'),
    run: async ({ secrets }) => {
      const data = record(await api(secrets, `/${secrets.business_account_id}/phone_numbers`));
      return { success: true, data: { phoneNumbers: list(data.data) } };
    },
  },
  sendMessage('whatsapp_business.send_text_message', 'Enviar texto', (input) => clean(input.body) ? { type: 'text', text: { body: clean(input.body), preview_url: input.previewUrl === true } } : null),
  sendMessage('whatsapp_business.send_template_message', 'Enviar template', (input) => clean(input.templateName) && clean(input.languageCode) ? {
    type: 'template',
    template: { name: clean(input.templateName), language: { code: clean(input.languageCode) }, ...(Array.isArray(input.components) ? { components: input.components } : {}) },
  } : null),
  {
    id: 'whatsapp_business.upload_media', name: 'Subir media', description: 'Sube media desde contenido base64 provisto.', risk: 'high',
    inputSchema: schema({ base64Content: { type: 'string' }, filename: { type: 'string' }, mimeType: { type: 'string' }, phoneNumberId: { type: 'string' } }, ['base64Content', 'filename', 'mimeType']),
    outputSchema: objectSchema('media'),
    run: async ({ input, secrets }) => {
      const content = req(input, 'base64Content', 'whatsapp_business_media_required'); const filename = req(input, 'filename', 'whatsapp_business_filename_required'); const mime = req(input, 'mimeType', 'whatsapp_business_mime_required');
      if (typeof content !== 'string') return content; if (typeof filename !== 'string') return filename; if (typeof mime !== 'string') return mime;
      const phoneNumber = phone(input, secrets); if (!phoneNumber) return fail('whatsapp_business_phone_number_required');
      const form = new FormData(); form.set('messaging_product', 'whatsapp'); form.set('file', new Blob([Buffer.from(content, 'base64')], { type: mime }), filename);
      return { success: true, data: { media: await api(secrets, `/${phoneNumber}/media`, { method: 'POST', body: form }) } };
    },
  },
  sendMessage('whatsapp_business.send_media_message', 'Enviar media', (input) => {
    const mediaType = clean(input.mediaType); const mediaId = clean(input.mediaId);
    return ['image', 'document', 'video', 'audio'].includes(mediaType) && mediaId ? { type: mediaType, [mediaType]: { id: mediaId, caption: clean(input.caption) || undefined } } : null;
  }),
  {
    id: 'whatsapp_business.mark_message_read', name: 'Marcar leido', description: 'Marca un mensaje como leido.', risk: 'medium',
    inputSchema: schema({ messageId: { type: 'string' }, phoneNumberId: { type: 'string' } }, ['messageId']), outputSchema: schema({ markedRead: { type: 'boolean' } }, ['markedRead']),
    run: async ({ input, secrets }) => {
      const message = req(input, 'messageId', 'whatsapp_business_message_required'); if (typeof message !== 'string') return message;
      const phoneNumber = phone(input, secrets); if (!phoneNumber) return fail('whatsapp_business_phone_number_required');
      await api(secrets, `/${phoneNumber}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: message }) });
      return { success: true, data: { markedRead: true } };
    },
  },
  {
    id: 'whatsapp_business.get_business_profile', name: 'Leer perfil', description: 'Lee perfil de WhatsApp Business.', risk: 'medium',
    inputSchema: schema({ phoneNumberId: { type: 'string' } }), outputSchema: objectSchema('profile'),
    run: async ({ input, secrets }) => {
      const phoneNumber = phone(input, secrets); if (!phoneNumber) return fail('whatsapp_business_phone_number_required');
      const data = record(await api(secrets, `/${phoneNumber}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`));
      return { success: true, data: { profile: record(list(data.data)[0]) } };
    },
  },
  {
    id: 'whatsapp_business.update_business_profile', name: 'Actualizar perfil', description: 'Actualiza perfil de WhatsApp Business.', risk: 'high',
    inputSchema: schema({ about: { type: 'string' }, description: { type: 'string' }, email: { type: 'string' }, phoneNumberId: { type: 'string' } }), outputSchema: schema({ updated: { type: 'boolean' } }, ['updated']),
    run: async ({ input, secrets }) => {
      const phoneNumber = phone(input, secrets); if (!phoneNumber) return fail('whatsapp_business_phone_number_required');
      await api(secrets, `/${phoneNumber}/whatsapp_business_profile`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', about: clean(input.about) || undefined, description: clean(input.description) || undefined, email: clean(input.email) || undefined }) });
      return { success: true, data: { updated: true } };
    },
  },
];

export const whatsappBusinessToolModule = moduleFrom({
  id: 'whatsapp_business', name: 'WhatsApp Business Cloud', description: 'Envia mensajes oficiales de WhatsApp Business Cloud.',
  secrets: [secret('access_token', 'Access token de Meta', 'Token con permisos de WhatsApp Business.'), secret('business_account_id', 'WhatsApp Business Account ID', 'ID de la cuenta WABA.'), secret('phone_number_id', 'Phone Number ID', 'ID del numero emisor.', false), secret('api_version', 'Version Graph API', 'Si se deja vacia usa v23.0.', false), secret('app_secret', 'App secret', 'Opcional para appsecret_proof.', false)],
  validate: async (secrets) => { const data = record(await api(secrets, `/${secrets.business_account_id}/phone_numbers`)); return { ok: true, data: { subject: secrets.business_account_id, phoneNumber: clean(record(list(data.data)[0]).display_phone_number), workspace: 'WhatsApp Business Cloud' } }; },
  actions,
});
