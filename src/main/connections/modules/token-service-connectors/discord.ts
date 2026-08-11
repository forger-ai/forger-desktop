import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, json, list, moduleFrom, objectSchema, record, req, schema, secret } from './helpers';

const api = (token: string, path: string, init: RequestInit = {}) =>
  json(`https://discord.com/api/v10${path}`, { ...init, headers: { Authorization: `Bot ${token}`, ...(init.headers ?? {}) } }, 'discord');

const actions: TokenConnectorActionDefinition[] = [
  {
    id: 'discord.list_guilds', name: 'Listar servidores', description: 'Lista servidores del bot.', risk: 'low',
    inputSchema: schema(), outputSchema: arraySchema('guilds'),
    run: async ({ secrets }) => ({ success: true, data: { guilds: list(await api(secrets.bot_token, '/users/@me/guilds')) } }),
  },
  {
    id: 'discord.list_channels', name: 'Listar canales', description: 'Lista canales de un servidor.', risk: 'low',
    inputSchema: schema({ guildId: { type: 'string' } }, ['guildId']), outputSchema: arraySchema('channels'),
    run: async ({ input, secrets }) => {
      const guild = req(input, 'guildId', 'discord_guild_required'); if (typeof guild !== 'string') return guild;
      return { success: true, data: { channels: list(await api(secrets.bot_token, `/guilds/${encodeURIComponent(guild)}/channels`)) } };
    },
  },
  {
    id: 'discord.read_messages', name: 'Leer mensajes', description: 'Lee mensajes recientes.', risk: 'high',
    inputSchema: schema({ channelId: { type: 'string' }, limit: { type: 'number' } }, ['channelId']), outputSchema: arraySchema('messages'),
    run: async ({ input, secrets }) => {
      const channel = req(input, 'channelId', 'discord_channel_required'); if (typeof channel !== 'string') return channel;
      return { success: true, data: { messages: list(await api(secrets.bot_token, `/channels/${encodeURIComponent(channel)}/messages?limit=${input.limit ?? 25}`)) } };
    },
  },
  {
    id: 'discord.send_message', name: 'Enviar mensaje', description: 'Envia un mensaje a un canal.', risk: 'high',
    inputSchema: schema({ channelId: { type: 'string' }, content: { type: 'string' } }, ['channelId', 'content']), outputSchema: objectSchema('message'),
    run: async ({ input, secrets }) => {
      const channel = req(input, 'channelId', 'discord_channel_required'); const content = req(input, 'content', 'discord_content_required');
      if (typeof channel !== 'string') return channel; if (typeof content !== 'string') return content;
      return { success: true, userMessage: 'Mensaje enviado a Discord.', data: { message: await api(secrets.bot_token, `/channels/${encodeURIComponent(channel)}/messages`, { method: 'POST', body: JSON.stringify({ content }) }) } };
    },
  },
  {
    id: 'discord.create_channel', name: 'Crear canal', description: 'Crea un canal en un servidor.', risk: 'high',
    inputSchema: schema({ guildId: { type: 'string' }, name: { type: 'string' } }, ['guildId', 'name']), outputSchema: objectSchema('channel'),
    run: async ({ input, secrets }) => {
      const guild = req(input, 'guildId', 'discord_guild_required'); const name = req(input, 'name', 'discord_name_required');
      if (typeof guild !== 'string') return guild; if (typeof name !== 'string') return name;
      return { success: true, data: { channel: await api(secrets.bot_token, `/guilds/${encodeURIComponent(guild)}/channels`, { method: 'POST', body: JSON.stringify({ name }) }) } };
    },
  },
  {
    id: 'discord.create_thread', name: 'Crear thread', description: 'Crea un thread en un canal.', risk: 'high',
    inputSchema: schema({ channelId: { type: 'string' }, messageId: { type: 'string' }, name: { type: 'string' } }, ['channelId', 'name']), outputSchema: objectSchema('thread'),
    run: async ({ input, secrets }) => {
      const channel = req(input, 'channelId', 'discord_channel_required'); const name = req(input, 'name', 'discord_name_required');
      if (typeof channel !== 'string') return channel; if (typeof name !== 'string') return name;
      const msg = clean(input.messageId);
      const encodedChannel = encodeURIComponent(channel);
      const path = msg
        ? `/channels/${encodedChannel}/messages/${encodeURIComponent(msg)}/threads`
        : `/channels/${encodedChannel}/threads`;
      return { success: true, data: { thread: await api(secrets.bot_token, path, { method: 'POST', body: JSON.stringify({ name, auto_archive_duration: 1440 }) }) } };
    },
  },
  {
    id: 'discord.add_reaction', name: 'Agregar reaccion', description: 'Agrega reaccion a un mensaje.', risk: 'high',
    inputSchema: schema({ channelId: { type: 'string' }, messageId: { type: 'string' }, emoji: { type: 'string' } }, ['channelId', 'messageId', 'emoji']),
    outputSchema: schema({ reacted: { type: 'boolean' } }, ['reacted']),
    run: async ({ input, secrets }) => {
      const channel = req(input, 'channelId', 'discord_channel_required'); const msg = req(input, 'messageId', 'discord_message_required'); const emoji = req(input, 'emoji', 'discord_emoji_required');
      if (typeof channel !== 'string') return channel; if (typeof msg !== 'string') return msg; if (typeof emoji !== 'string') return emoji;
      await api(secrets.bot_token, `/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(msg)}/reactions/${encodeURIComponent(emoji)}/@me`, { method: 'PUT' });
      return { success: true, data: { reacted: true } };
    },
  },
  {
    id: 'discord.delete_message', name: 'Eliminar mensaje', description: 'Elimina un mensaje.', risk: 'high',
    inputSchema: schema({ channelId: { type: 'string' }, messageId: { type: 'string' } }, ['channelId', 'messageId']), outputSchema: schema({ deleted: { type: 'boolean' } }, ['deleted']),
    run: async ({ input, secrets }) => {
      const channel = req(input, 'channelId', 'discord_channel_required'); const msg = req(input, 'messageId', 'discord_message_required');
      if (typeof channel !== 'string') return channel; if (typeof msg !== 'string') return msg;
      await api(secrets.bot_token, `/channels/${encodeURIComponent(channel)}/messages/${encodeURIComponent(msg)}`, { method: 'DELETE' });
      return { success: true, data: { deleted: true } };
    },
  },
];

export const discordToolModule = moduleFrom({
  id: 'discord', name: 'Discord', description: 'Opera servidores, canales y mensajes de Discord.',
  secrets: [secret('bot_token', 'Bot token de Discord', 'Token de bot de una app de Discord.')],
  validate: async (secrets) => {
    const bot = record(await api(secrets.bot_token, '/users/@me'));
    return { ok: true, data: { subject: clean(bot.id), username: clean(bot.username) } };
  },
  actions,
});
