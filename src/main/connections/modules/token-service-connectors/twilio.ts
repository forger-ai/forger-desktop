import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, basic, clean, form, json, moduleFrom, objectSchema, record, req, schema, secret } from './helpers';

const base = (s: Record<string, string>) => `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.account_sid)}`;
const headers = (s: Record<string, string>) => ({ Authorization: basic(s.api_key_sid, s.api_key_secret) });
const api = (s: Record<string, string>, path: string, init: RequestInit = {}) =>
  json(`${base(s)}${path}`, { ...init, headers: { ...headers(s), ...(init.headers ?? {}) } }, 'twilio');

const send = (id: string, name: string, whatsapp = false): TokenConnectorActionDefinition => ({
  id, name, description: `${name} con Twilio.`, risk: 'high',
  inputSchema: schema({ from: { type: 'string' }, to: { type: 'string' }, body: { type: 'string' } }, ['from', 'to', 'body']),
  outputSchema: objectSchema('message'),
  run: async ({ input, secrets }) => {
    const from = req(input, 'from', 'twilio_from_required'); const to = req(input, 'to', 'twilio_to_required'); const body = req(input, 'body', 'twilio_body_required');
    if (typeof from !== 'string') return from; if (typeof to !== 'string') return to; if (typeof body !== 'string') return body;
    const normalize = (value: string) => whatsapp && !value.startsWith('whatsapp:') ? `whatsapp:${value}` : value;
    const message = await form(`${base(secrets)}/Messages.json`, { From: normalize(from), To: normalize(to), Body: body }, headers(secrets), 'twilio');
    return { success: true, data: { message } };
  },
});

const getBySid = (id: string, name: string, kind: 'Message' | 'Call'): TokenConnectorActionDefinition => ({
  id, name, description: `${name} de Twilio.`, risk: 'medium',
  inputSchema: schema({ [`${kind.toLowerCase()}Sid`]: { type: 'string' } }, [`${kind.toLowerCase()}Sid`]), outputSchema: objectSchema(kind.toLowerCase()),
  run: async ({ input, secrets }) => {
    const sid = req(input, `${kind.toLowerCase()}Sid`, `twilio_${kind.toLowerCase()}_required`);
    return typeof sid === 'string' ? { success: true, data: { [kind.toLowerCase()]: await api(secrets, `/${kind}s/${sid}.json`) } } : sid;
  },
});

const actions: TokenConnectorActionDefinition[] = [
  send('twilio.send_sms', 'Enviar SMS'),
  send('twilio.send_whatsapp_message', 'Enviar WhatsApp', true),
  {
    id: 'twilio.list_messages', name: 'Listar mensajes', description: 'Lista mensajes.', risk: 'medium',
    inputSchema: schema({ limit: { type: 'number' } }), outputSchema: arraySchema('messages'),
    run: async ({ input, secrets }) => {
      const data = record(await api(secrets, `/Messages.json?PageSize=${input.limit ?? 25}`));
      return { success: true, data: { messages: Array.isArray(data.messages) ? data.messages : [] } };
    },
  },
  getBySid('twilio.get_message', 'Leer mensaje', 'Message'),
  {
    id: 'twilio.create_call', name: 'Crear llamada', description: 'Inicia una llamada con URL TwiML.', risk: 'high',
    inputSchema: schema({ from: { type: 'string' }, to: { type: 'string' }, url: { type: 'string' } }, ['from', 'to', 'url']),
    outputSchema: objectSchema('call'),
    run: async ({ input, secrets }) => {
      const from = req(input, 'from', 'twilio_from_required'); const to = req(input, 'to', 'twilio_to_required'); const url = req(input, 'url', 'twilio_url_required');
      if (typeof from !== 'string') return from; if (typeof to !== 'string') return to; if (typeof url !== 'string') return url;
      return { success: true, data: { call: await form(`${base(secrets)}/Calls.json`, { From: from, To: to, Url: url }, headers(secrets), 'twilio') } };
    },
  },
  {
    id: 'twilio.list_calls', name: 'Listar llamadas', description: 'Lista llamadas.', risk: 'medium',
    inputSchema: schema({ limit: { type: 'number' } }), outputSchema: arraySchema('calls'),
    run: async ({ input, secrets }) => {
      const data = record(await api(secrets, `/Calls.json?PageSize=${input.limit ?? 25}`));
      return { success: true, data: { calls: Array.isArray(data.calls) ? data.calls : [] } };
    },
  },
  getBySid('twilio.get_call', 'Leer llamada', 'Call'),
];

export const twilioToolModule = moduleFrom({
  id: 'twilio', name: 'Twilio', description: 'Envia SMS, WhatsApp y llamadas de Twilio.',
  secrets: [secret('account_sid', 'Account SID de Twilio', 'SID de la cuenta.'), secret('api_key_sid', 'API Key SID de Twilio', 'SID de API key.'), secret('api_key_secret', 'API Key Secret de Twilio', 'Secret de API key.')],
  validate: async (secrets) => {
    const account = record(await api(secrets, '.json'));
    return { ok: true, data: { subject: clean(account.sid) || secrets.account_sid, workspace: clean(account.friendly_name) } };
  },
  actions,
});
