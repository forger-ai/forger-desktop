import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, fail, json, list, moduleFrom, objectSchema, record, schema, secret } from './helpers';

const api = async (token: string, method: string, payload?: Record<string, unknown>) => {
  const data = record(await json(`https://api.telegram.org/bot${token}/${method}`, {
    method: payload ? 'POST' : 'GET',
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  }, 'telegram'));
  if (data.ok === false) return fail('telegram_api_error', clean(data.description) || 'Telegram rechazo la accion.');
  return data.result;
};

const isApiFailure = (value: unknown): value is ReturnType<typeof fail> =>
  record(value).success === false;

const mapped = (
  id: string,
  name: string,
  method: string,
  required: string[],
  map: Record<string, string>,
  output = 'message',
): TokenConnectorActionDefinition => ({
  id, name, description: `${name} usando Telegram Bot API.`, risk: 'high',
  inputSchema: schema(Object.fromEntries(Object.keys(map).map((key) => [key, { type: 'string' }])), required),
  outputSchema: output === 'deleted' ? schema({ deleted: { type: 'boolean' } }, ['deleted']) : objectSchema(output),
  run: async ({ input, secrets }) => {
    for (const key of required) if (!clean(input[key])) return fail(`telegram_${key}_required`);
    const payload = Object.fromEntries(Object.entries(map).map(([from, to]) => [to, clean(input[from])]));
    const result = await api(secrets.bot_token, method, payload);
    if (isApiFailure(result)) return result;
    return output === 'deleted'
      ? { success: true, data: { deleted: result === true } }
      : { success: true, data: { [output]: result } };
  },
});

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'telegram.get_updates', name: 'Leer updates', description: 'Lee updates pendientes del bot.', risk: 'high',
    inputSchema: schema({ offset: { type: 'number' }, limit: { type: 'number' } }), outputSchema: arraySchema('updates'),
    run: async ({ input, secrets }) => {
      const updates = await api(secrets.bot_token, 'getUpdates', { offset: input.offset, limit: input.limit ?? 25 });
      if (isApiFailure(updates)) return updates;
      return { success: true, data: { updates: list(updates) } };
    },
  },
  mapped('telegram.send_message', 'Enviar mensaje', 'sendMessage', ['chatId', 'text'], { chatId: 'chat_id', text: 'text' }),
  mapped('telegram.send_photo', 'Enviar foto', 'sendPhoto', ['chatId', 'photo'], { chatId: 'chat_id', photo: 'photo', caption: 'caption' }),
  mapped('telegram.send_document', 'Enviar documento', 'sendDocument', ['chatId', 'document'], { chatId: 'chat_id', document: 'document', caption: 'caption' }),
  mapped('telegram.edit_message_text', 'Editar mensaje', 'editMessageText', ['chatId', 'messageId', 'text'], { chatId: 'chat_id', messageId: 'message_id', text: 'text' }),
  mapped('telegram.delete_message', 'Eliminar mensaje', 'deleteMessage', ['chatId', 'messageId'], { chatId: 'chat_id', messageId: 'message_id' }, 'deleted'),
  mapped('telegram.answer_callback_query', 'Responder callback', 'answerCallbackQuery', ['callbackQueryId'], { callbackQueryId: 'callback_query_id', text: 'text' }, 'result'),
];

export const telegramToolModule = moduleFrom({
  id: 'telegram', name: 'Telegram', description: 'Opera un bot de Telegram con token local.',
  secrets: [secret('bot_token', 'Bot token de Telegram', 'Token entregado por BotFather.')],
  validate: async (secrets) => {
    const result = await api(secrets.bot_token, 'getMe');
    if (isApiFailure(result)) {
      return { ok: false, technicalCode: result.technicalCode };
    }
    const bot = record(result);
    return { ok: true, data: { subject: String(bot.id ?? ''), username: clean(bot.username) || clean(bot.first_name) } };
  },
  actions,
});
