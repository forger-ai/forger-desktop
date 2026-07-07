import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, json, moduleFrom, objectSchema, record, req, schema, secret } from './helpers';

const api = (token: string, pathOrUrl: string, init: RequestInit = {}) => {
  const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `https://api.calendly.com${pathOrUrl}`;
  return json(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }, 'calendly');
};
const idFromUri = (uri: string) => clean(uri).split('/').filter(Boolean).pop() ?? clean(uri);
const userUri = async (token: string, input: Record<string, unknown>) =>
  clean(input.userUri) || clean(record(record(await api(token, '/users/me')).resource).uri);

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'calendly.list_event_types', name: 'Listar tipos de evento', description: 'Lista tipos de evento.', risk: 'low',
    inputSchema: schema({ userUri: { type: 'string' }, limit: { type: 'number' } }), outputSchema: arraySchema('eventTypes'),
    run: async ({ input, secrets }) => {
      const uri = await userUri(secrets.personal_access_token, input);
      const data = record(await api(secrets.personal_access_token, `https://api.calendly.com/event_types?user=${encodeURIComponent(uri)}&count=${input.limit ?? 25}`));
      return { success: true, data: { eventTypes: Array.isArray(data.collection) ? data.collection : [] } };
    },
  },
  {
    id: 'calendly.list_available_times', name: 'Listar disponibilidad', description: 'Lista horarios disponibles.', risk: 'medium',
    inputSchema: schema({ eventTypeUri: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' } }, ['eventTypeUri', 'startTime', 'endTime']), outputSchema: arraySchema('availableTimes'),
    run: async ({ input, secrets }) => {
      const eventType = req(input, 'eventTypeUri', 'calendly_event_type_required'); const start = req(input, 'startTime', 'calendly_start_required'); const end = req(input, 'endTime', 'calendly_end_required');
      if (typeof eventType !== 'string') return eventType; if (typeof start !== 'string') return start; if (typeof end !== 'string') return end;
      const data = record(await api(secrets.personal_access_token, `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(eventType)}&start_time=${encodeURIComponent(start)}&end_time=${encodeURIComponent(end)}`));
      return { success: true, data: { availableTimes: Array.isArray(data.collection) ? data.collection : [] } };
    },
  },
  {
    id: 'calendly.list_scheduled_events', name: 'Listar eventos', description: 'Lista eventos programados.', risk: 'medium',
    inputSchema: schema({ userUri: { type: 'string' }, organizationUri: { type: 'string' }, limit: { type: 'number' } }), outputSchema: arraySchema('events'),
    run: async ({ input, secrets }) => {
      const org = clean(input.organizationUri); const user = org ? '' : await userUri(secrets.personal_access_token, input);
      const qs = new URLSearchParams({ count: String(input.limit ?? 25), ...(org ? { organization: org } : { user }) });
      const data = record(await api(secrets.personal_access_token, `/scheduled_events?${qs.toString()}`));
      return { success: true, data: { events: Array.isArray(data.collection) ? data.collection : [] } };
    },
  },
  {
    id: 'calendly.get_event', name: 'Leer evento', description: 'Obtiene un evento.', risk: 'medium',
    inputSchema: schema({ eventUri: { type: 'string' } }, ['eventUri']), outputSchema: objectSchema('event'),
    run: async ({ input, secrets }) => {
      const event = req(input, 'eventUri', 'calendly_event_required'); if (typeof event !== 'string') return event;
      return { success: true, data: { event: record(record(await api(secrets.personal_access_token, `/scheduled_events/${idFromUri(event)}`)).resource) } };
    },
  },
  {
    id: 'calendly.list_invitees', name: 'Listar invitados', description: 'Lista invitados de un evento.', risk: 'medium',
    inputSchema: schema({ eventUri: { type: 'string' }, limit: { type: 'number' } }, ['eventUri']), outputSchema: arraySchema('invitees'),
    run: async ({ input, secrets }) => {
      const event = req(input, 'eventUri', 'calendly_event_required'); if (typeof event !== 'string') return event;
      const data = record(await api(secrets.personal_access_token, `/scheduled_events/${idFromUri(event)}/invitees?count=${input.limit ?? 25}`));
      return { success: true, data: { invitees: Array.isArray(data.collection) ? data.collection : [] } };
    },
  },
  {
    id: 'calendly.cancel_event', name: 'Cancelar evento', description: 'Cancela un evento programado.', risk: 'high',
    inputSchema: schema({ eventUri: { type: 'string' }, reason: { type: 'string' } }, ['eventUri']), outputSchema: objectSchema('event'),
    run: async ({ input, secrets }) => {
      const event = req(input, 'eventUri', 'calendly_event_required'); if (typeof event !== 'string') return event;
      const data = record(await api(secrets.personal_access_token, `/scheduled_events/${idFromUri(event)}/cancellation`, { method: 'POST', body: JSON.stringify({ reason: clean(input.reason) || 'Canceled from Forger.' }) }));
      return { success: true, userMessage: 'Evento cancelado en Calendly.', data: { event: record(data.resource) } };
    },
  },
];

export const calendlyToolModule = moduleFrom({
  id: 'calendly', name: 'Calendly', description: 'Lee disponibilidad y eventos de Calendly.',
  secrets: [secret('personal_access_token', 'Personal Access Token de Calendly', 'PAT generado en Calendly.')],
  validate: async (secrets) => {
    const resource = record(record(await api(secrets.personal_access_token, '/users/me')).resource);
    return { ok: true, data: { subject: clean(resource.uri), email: clean(resource.email), username: clean(resource.name) } };
  },
  actions,
});
