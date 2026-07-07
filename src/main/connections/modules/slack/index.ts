import type { CallOfficialToolResult } from '../../../../shared/types';
import type { InternalToolModule } from '../../../tools/types';
import { ConnectorApiError, createTokenConnectorModule } from '../token-connector';

export const SLACK_TOOL_ID = 'slack';
export const SLACK_BOT_TOKEN_SECRET = 'bot_token';

const SLACK_API_BASE = 'https://slack.com/api';

interface SlackApiResponse {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

const callSlackApi = async (
  token: string,
  method: string,
  payload?: Record<string, unknown>,
): Promise<SlackApiResponse> => {
  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  if (!response.ok) {
    throw new ConnectorApiError(`slack_http_${response.status}`);
  }
  const data = await response.json() as SlackApiResponse;
  if (!data.ok) {
    throw new ConnectorApiError(`slack_api_${data.error ?? 'unknown_error'}`);
  }
  return data;
};

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const clampLimit = (value: unknown, fallback: number, max: number): number => {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(1, numeric));
};

const toResult = (error: unknown, fallbackCode: string): CallOfficialToolResult => ({
  success: false,
  userMessage: 'No pudimos completar la accion de Slack. Revisa la conexion y los permisos del token.',
  technicalCode: error instanceof ConnectorApiError
    ? error.technicalCode
    : error instanceof Error ? error.message : fallbackCode,
});

export const slackToolModule: InternalToolModule = createTokenConnectorModule({
  id: SLACK_TOOL_ID,
  name: 'Slack',
  description: 'Lee y envia mensajes de Slack usando un token de bot guardado localmente en secretos.',
  version: '0.1.0',
  connectionStatusActionId: 'slack.connection.status',
  secrets: [
    {
      name: SLACK_BOT_TOKEN_SECRET,
      label: 'Token de bot de Slack',
      required: true,
      usage: 'Token de bot (xoxb-...) de una app de Slack instalada en tu espacio. Se guarda cifrado en este equipo.',
    },
  ],
  changelog: ['Conector local de Slack con token en secretos.'],
  copy: {
    secretsMissing: 'Conecta Slack agregando el token de bot en la configuracion de la herramienta.',
    connected: 'Slack quedo conectado.',
    connectFailed: 'No pudimos validar el token de Slack. Revisa que sea un token de bot vigente.',
  },
  validate: async (secrets) => {
    try {
      const data = await callSlackApi(secrets[SLACK_BOT_TOKEN_SECRET] as string, 'auth.test');
      return {
        ok: true,
        data: {
          team: typeof data.team === 'string' ? data.team : undefined,
          user: typeof data.user === 'string' ? data.user : undefined,
        },
      };
    } catch (error) {
      return {
        ok: false,
        technicalCode: error instanceof ConnectorApiError ? error.technicalCode : 'slack_validation_failed',
      };
    }
  },
  actions: [
    {
      id: 'slack.connection.status',
      name: 'Estado de conexion',
      description: 'Revisa si el token de Slack esta conectado.',
      risk: 'low',
      outputSchema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean' },
          team: { type: 'string' },
          user: { type: 'string' },
        },
        required: ['connected'],
      },
      run: async () => ({ success: true, data: { connected: true } }),
    },
    {
      id: 'slack.list_channels',
      name: 'Listar canales',
      description: 'Lista los canales visibles para el token conectado.',
      risk: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximo de canales a devolver.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          channels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                isPrivate: { type: 'boolean' },
                memberCount: { type: 'number' },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['channels'],
      },
      run: async ({ input, secrets }) => {
        try {
          const data = await callSlackApi(secrets[SLACK_BOT_TOKEN_SECRET] as string, 'conversations.list', {
            limit: clampLimit(input.limit, 100, 200),
            types: 'public_channel,private_channel',
            exclude_archived: true,
          });
          const channels = Array.isArray(data.channels)
            ? (data.channels as Array<Record<string, unknown>>).map((channel) => ({
                id: channel.id,
                name: channel.name,
                isPrivate: channel.is_private === true,
                memberCount: channel.num_members,
              }))
            : [];
          return { success: true, data: { channels } };
        } catch (error) {
          return toResult(error, 'slack_list_channels_failed');
        }
      },
    },
    {
      id: 'slack.read_messages',
      name: 'Leer mensajes',
      description: 'Lee los mensajes recientes de un canal.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'ID del canal de Slack.' },
          limit: { type: 'number', description: 'Maximo de mensajes a leer.' },
        },
        required: ['channelId'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string' },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                user: { type: 'string' },
                text: { type: 'string' },
                ts: { type: 'string' },
                threadTs: { type: 'string' },
              },
            },
          },
        },
        required: ['channelId', 'messages'],
      },
      run: async ({ input, secrets }) => {
        const channelId = cleanString(input.channelId);
        if (!channelId) {
          return { success: false, userMessage: 'Indica el canal de Slack a leer.', technicalCode: 'slack_channel_required' };
        }
        try {
          const data = await callSlackApi(secrets[SLACK_BOT_TOKEN_SECRET] as string, 'conversations.history', {
            channel: channelId,
            limit: clampLimit(input.limit, 20, 100),
          });
          const messages = Array.isArray(data.messages)
            ? (data.messages as Array<Record<string, unknown>>).map((message) => ({
                user: message.user,
                text: message.text,
                ts: message.ts,
                threadTs: message.thread_ts,
              }))
            : [];
          return { success: true, data: { channelId, messages } };
        } catch (error) {
          return toResult(error, 'slack_read_messages_failed');
        }
      },
    },
    {
      id: 'slack.send_message',
      name: 'Enviar mensaje',
      description: 'Envia un mensaje a un canal de Slack.',
      risk: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'ID del canal de Slack.' },
          text: { type: 'string', description: 'Texto del mensaje.' },
        },
        required: ['channelId', 'text'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          ts: { type: 'string' },
        },
      },
      run: async ({ input, secrets }) => {
        const channelId = cleanString(input.channelId);
        const text = cleanString(input.text);
        if (!channelId || !text) {
          return { success: false, userMessage: 'Completa canal y mensaje para enviar a Slack.', technicalCode: 'slack_send_input_invalid' };
        }
        try {
          const data = await callSlackApi(secrets[SLACK_BOT_TOKEN_SECRET] as string, 'chat.postMessage', {
            channel: channelId,
            text,
          });
          return {
            success: true,
            userMessage: 'Mensaje enviado a Slack.',
            data: { channel: data.channel, ts: data.ts },
          };
        } catch (error) {
          return toResult(error, 'slack_send_message_failed');
        }
      },
    },
  ],
});
