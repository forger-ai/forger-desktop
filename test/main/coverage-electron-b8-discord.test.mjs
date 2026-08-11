import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { discordToolModule } = require('../../dist-electron/main/connections/modules/token-service-connectors/discord.js');

const context = {
  metadataRoot: '/tmp/forger-discord-b8',
  secretsStore: {
    getToolSecret: async (_toolId, name) => name === 'bot_token' ? 'discord-token' : null,
    hasToolSecret: async () => true,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
};

const execute = (actionId, input = {}) => discordToolModule.execute({ toolId: 'discord', actionId, input }, context);
const response = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
const withFetch = async (handler, operation) => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = previous;
  }
};

test('Given a Discord bot, guild, message and thread flows remain scoped to encoded resource ids', async () => {
  await withFetch(
    (rawUrl, init) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/users/@me')) return response({ id: 'bot-1', username: 'ForgerBot' });
      if (url.pathname.endsWith('/users/@me/guilds')) return response([{ id: 'guild-1' }]);
      if (url.pathname.includes('/messages') && init.method === 'GET') return response([{ id: 'message-1' }]);
      if (url.pathname.includes('/reactions/') && init.method === 'PUT') return response(undefined, 204);
      if (init.method === 'DELETE') return response(undefined, 204);
      return response({ id: 'created' });
    },
    async (calls) => {
      assert.deepEqual((await execute('discord.connection.status')).data, {
        connected: true, subject: 'bot-1', username: 'ForgerBot',
      });
      assert.equal((await execute('discord.list_guilds')).data.guilds.length, 1);
      assert.equal((await execute('discord.list_channels', { guildId: ' guild/1 ' })).success, true);
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/guilds/guild%2F1/channels');

      await execute('discord.read_messages', { channelId: 'channel/1', limit: 5 });
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/channels/channel%2F1/messages');
      assert.equal(new URL(calls.at(-1).url).searchParams.get('limit'), '5');
      await execute('discord.read_messages', { channelId: 'channel' });
      assert.equal(new URL(calls.at(-1).url).searchParams.get('limit'), '25');

      const sent = await execute('discord.send_message', { channelId: 'channel/1', content: ' Hello ' });
      assert.equal(sent.data.message.id, 'created');
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/channels/channel%2F1/messages');
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { content: 'Hello' });

      assert.equal((await execute('discord.create_channel', { guildId: 'guild/1', name: ' General ' })).success, true);
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/guilds/guild%2F1/channels');

      assert.equal((await execute('discord.create_thread', {
        channelId: 'channel/1', messageId: 'message/1', name: ' Thread ',
      })).success, true);
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/channels/channel%2F1/messages/message%2F1/threads');
      assert.equal((await execute('discord.create_thread', {
        channelId: 'channel/1', name: 'Standalone',
      })).success, true);
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/channels/channel%2F1/threads');

      assert.equal((await execute('discord.add_reaction', {
        channelId: 'channel/1', messageId: 'message/1', emoji: 'thumb/up',
      })).data.reacted, true);
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/channels/channel%2F1/messages/message%2F1/reactions/thumb%2Fup/@me');

      assert.equal((await execute('discord.delete_message', {
        channelId: 'channel/1', messageId: 'message/1',
      })).data.deleted, true);
      assert.equal(new URL(calls.at(-1).url).pathname, '/api/v10/channels/channel%2F1/messages/message%2F1');
      assert.equal(calls.every((call) => call.init.headers.get('authorization') === 'Bot discord-token'), true);
    },
  );
});

test('Given malformed Discord inputs, every mutation rejects before reaching the API', async () => {
  const cases = [
    ['discord.list_channels', {}, 'discord_guild_required'],
    ['discord.read_messages', {}, 'discord_channel_required'],
    ['discord.send_message', { content: 'x' }, 'discord_channel_required'],
    ['discord.send_message', { channelId: 'channel' }, 'discord_content_required'],
    ['discord.create_channel', { name: 'general' }, 'discord_guild_required'],
    ['discord.create_channel', { guildId: 'guild' }, 'discord_name_required'],
    ['discord.create_thread', { name: 'thread' }, 'discord_channel_required'],
    ['discord.create_thread', { channelId: 'channel' }, 'discord_name_required'],
    ['discord.add_reaction', { messageId: 'message', emoji: 'x' }, 'discord_channel_required'],
    ['discord.add_reaction', { channelId: 'channel', emoji: 'x' }, 'discord_message_required'],
    ['discord.add_reaction', { channelId: 'channel', messageId: 'message' }, 'discord_emoji_required'],
    ['discord.delete_message', { messageId: 'message' }, 'discord_channel_required'],
    ['discord.delete_message', { channelId: 'channel' }, 'discord_message_required'],
  ];
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network must not be reached'); };
  try {
    for (const [actionId, input, technicalCode] of cases) {
      assert.equal((await execute(actionId, input)).technicalCode, technicalCode, actionId);
    }
  } finally {
    globalThis.fetch = previous;
  }
});
