import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createTokenConnectorModule, ConnectorApiError } = require('../../dist-electron/main/connections/modules/token-connector.js');
const { slackToolModule } = require('../../dist-electron/main/connections/modules/slack/index.js');
const { trelloToolModule } = require('../../dist-electron/main/connections/modules/trello/index.js');
const { INTERNAL_TOOL_MODULES } = require('../../dist-electron/main/tools/index.js');
const { validateOutputAgainstSchema } = require('../../dist-electron/main/workflow/output-schema.js');
const { getMcpToolInputSchema } = require('../../dist-electron/main/forger-mcp/tool-metadata.js');

const createSecretsStore = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async setToolSecret(toolId, name, value) {
      values.set(`${toolId}:${name}`, value);
      return { success: true, userMessage: 'ok' };
    },
    async getToolSecret(toolId, name) {
      return values.get(`${toolId}:${name}`) ?? null;
    },
    async hasToolSecret(toolId, name) {
      return values.has(`${toolId}:${name}`);
    },
    async deleteToolSecrets(toolId) {
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${toolId}:`)) {
          values.delete(key);
        }
      }
      return { success: true, userMessage: 'ok' };
    },
  };
};

const createContext = (secretsStore) => ({
  metadataRoot: '/tmp/forger-test',
  secretsStore,
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => false,
  getGmailOAuthClientId: async () => '',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
});

const withMockedFetch = async (handler, operation) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const binaryResponse = (payload, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (name) => headers[name.toLowerCase()] ?? null,
  },
  arrayBuffer: async () => Buffer.from(payload),
});

test('slack and trello connector modules are connection modules, not internal tools', () => {
  const ids = INTERNAL_TOOL_MODULES.map((module) => module.definition.id);
  assert.equal(ids.includes('slack'), false);
  assert.equal(ids.includes('trello'), false);
  const slackSecrets = slackToolModule.definition.secrets;
  assert.equal(slackSecrets.length, 1);
  assert.equal(slackSecrets[0].manual, true, 'slack secrets are manual local tokens');
  assert.equal(trelloToolModule.definition.secrets.every((secret) => secret.manual), true);
  assert.equal(slackToolModule.definition.runtime, 'builtin');
});

test('token connector configure stores secrets, validates them and reports status', async () => {
  const secretsStore = createSecretsStore();
  const context = createContext(secretsStore);

  const missing = await slackToolModule.configure(context, { toolId: 'slack' });
  assert.equal(missing.success, false);
  assert.equal(missing.technicalCode, 'connector_secrets_required');

  await withMockedFetch(
    (url) => url.endsWith('/auth.test')
      ? jsonResponse({ ok: true, team: 'Forger HQ', user: 'bot' })
      : jsonResponse({ ok: false, error: 'unknown_method' }),
    async () => {
      const configured = await slackToolModule.configure(context, {
        toolId: 'slack',
        secrets: { bot_token: ' xoxb-token ' },
      });
      assert.equal(configured.success, true);
      assert.equal(secretsStore.values.get('slack:bot_token'), 'xoxb-token', 'token stored trimmed');
      assert.equal(await slackToolModule.isConfigured(context), true);

      const status = await slackToolModule.execute(
        { toolId: 'slack', actionId: 'slack.connection.status', input: {} },
        context,
      );
      assert.equal(status.success, true);
      assert.equal(status.data.connected, true);
      assert.equal(status.data.team, 'Forger HQ');
    },
  );

  await withMockedFetch(
    () => jsonResponse({ ok: false, error: 'invalid_auth' }),
    async () => {
      const invalid = await slackToolModule.configure(context, {
        toolId: 'slack',
        secrets: { bot_token: 'xoxb-bad' },
      });
      assert.equal(invalid.success, false);
      assert.equal(invalid.technicalCode, 'slack_api_invalid_auth');
    },
  );
});

test('slack actions call the API with the stored token and map errors', async () => {
  const secretsStore = createSecretsStore({ 'slack:bot_token': 'xoxb-token' });
  const context = createContext(secretsStore);

  await withMockedFetch(
    (url) => {
      if (url.endsWith('/conversations.list')) {
        return jsonResponse({ ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, num_members: 5 }] });
      }
      if (url.endsWith('/chat.postMessage')) {
        return jsonResponse({ ok: true, channel: 'C1', ts: '123.456' });
      }
      return jsonResponse({ ok: false, error: 'unknown_method' });
    },
    async (calls) => {
      const channels = await slackToolModule.execute(
        { toolId: 'slack', actionId: 'slack.list_channels', input: {} },
        context,
      );
      assert.equal(channels.success, true);
      assert.deepEqual(channels.data.channels, [{ id: 'C1', name: 'general', isPrivate: false, memberCount: 5 }]);
      assert.equal(calls[0].options.headers.Authorization, 'Bearer xoxb-token');

      const sent = await slackToolModule.execute(
        { toolId: 'slack', actionId: 'slack.send_message', input: { channelId: 'C1', text: 'hola' } },
        context,
      );
      assert.equal(sent.success, true);
      assert.equal(sent.data.ts, '123.456');

      const invalidInput = await slackToolModule.execute(
        { toolId: 'slack', actionId: 'slack.send_message', input: { channelId: '', text: '' } },
        context,
      );
      assert.equal(invalidInput.success, false);
      assert.equal(invalidInput.technicalCode, 'slack_send_input_invalid');
    },
  );

  await withMockedFetch(
    () => jsonResponse({ ok: false, error: 'channel_not_found' }),
    async () => {
      const failed = await slackToolModule.execute(
        { toolId: 'slack', actionId: 'slack.read_messages', input: { channelId: 'C404' } },
        context,
      );
      assert.equal(failed.success, false);
      assert.equal(failed.technicalCode, 'slack_api_channel_not_found');
    },
  );
});

test('trello actions use key/token pair and create cards', async () => {
  const secretsStore = createSecretsStore({
    'trello:api_key': 'key-1',
    'trello:api_token': 'token-1',
  });
  const context = createContext(secretsStore);

  await withMockedFetch(
    (url, options) => {
      if (url.includes('/members/me/boards')) {
        return jsonResponse([{ id: 'b1', name: 'Proyectos', url: 'https://trello.com/b/b1' }]);
      }
      if (url.includes('/boards/b1/lists')) {
        return jsonResponse([{ id: 'l1', name: 'Por hacer' }]);
      }
      if (url.includes('/cards') && options.method === 'POST') {
        return jsonResponse({ id: 'card-1', name: 'Nueva tarjeta', url: 'https://trello.com/c/card-1' });
      }
      return jsonResponse({}, 404);
    },
    async (calls) => {
      const boards = await trelloToolModule.execute(
        { toolId: 'trello', actionId: 'trello.list_boards', input: {} },
        context,
      );
      assert.equal(boards.success, true);
      assert.equal(boards.data.boards[0].name, 'Proyectos');
      assert.ok(calls[0].url.includes('key=key-1'));
      assert.ok(calls[0].url.includes('token=token-1'));

      const lists = await trelloToolModule.execute(
        { toolId: 'trello', actionId: 'trello.list_lists', input: { boardId: 'b1' } },
        context,
      );
      assert.equal(lists.success, true);
      assert.equal(lists.data.lists[0].id, 'l1');

      const card = await trelloToolModule.execute(
        { toolId: 'trello', actionId: 'trello.create_card', input: { listId: 'l1', name: 'Nueva tarjeta' } },
        context,
      );
      assert.equal(card.success, true);
      assert.equal(card.data.id, 'card-1');

      const badInput = await trelloToolModule.execute(
        { toolId: 'trello', actionId: 'trello.create_card', input: { listId: '', name: '' } },
        context,
      );
      assert.equal(badInput.success, false);
      assert.equal(badInput.technicalCode, 'trello_create_input_invalid');
    },
  );
});

test('trello card actions filter, update, delete, comment, download, and upload safely', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-trello-actions-'));
  const uploadPath = join(metadataRoot, 'upload.txt');
  await writeFile(uploadPath, 'archivo local', 'utf8');
  const secretsStore = createSecretsStore({
    'trello:api_key': 'key-1',
    'trello:api_token': 'token-1',
  });
  const context = { ...createContext(secretsStore), metadataRoot };

  try {
    await withMockedFetch(
      (url, options) => {
        if (url.includes('/lists/list-1/cards') && options.method === 'GET') {
          return jsonResponse([
            {
              id: 'card-1',
              name: 'Enviar informe',
              desc: 'Con adjunto',
              due: '2026-07-08T12:00:00.000Z',
              dueComplete: false,
              url: 'https://trello.com/c/card-1',
              idList: 'list-1',
              closed: false,
              idLabels: ['label-1'],
              idMembers: ['member-1'],
            },
            {
              id: 'card-2',
              name: 'Otro trabajo',
              desc: '',
              due: null,
              dueComplete: false,
              url: 'https://trello.com/c/card-2',
              idList: 'list-1',
              closed: false,
              idLabels: ['label-2'],
              idMembers: [],
            },
          ]);
        }
        if (url.includes('/cards/card-1') && options.method === 'PUT') {
          return jsonResponse({
            id: 'card-1',
            name: 'Enviar informe final',
            desc: 'Actualizada',
            due: '2026-07-09T12:00:00.000Z',
            dueComplete: true,
            url: 'https://trello.com/c/card-1',
            idList: 'list-2',
            closed: false,
          });
        }
        if (url.includes('/cards/card-1/actions/comments') && options.method === 'POST') {
          return jsonResponse({ id: 'comment-1', data: { text: 'Listo' }, date: '2026-07-07T12:00:00.000Z' });
        }
        if (url.includes('/cards/card-1/attachments') && options.method === 'GET') {
          return jsonResponse([
            {
              id: 'att-1',
              name: 'informe.pdf',
              url: 'https://api.trello.com/1/cards/card-1/attachments/att-1/download/informe.pdf',
              bytes: 7,
              mimeType: 'application/pdf',
              date: '2026-07-07T12:00:00.000Z',
            },
          ]);
        }
        if (url.includes('/cards/card-1/attachments/att-1/download/informe.pdf')) {
          return binaryResponse('PDFDATA', 200, {
            'content-type': 'application/pdf',
            'content-length': '7',
          });
        }
        if (url.includes('/cards/card-1/attachments') && options.method === 'POST') {
          assert.ok(options.body instanceof FormData);
          return jsonResponse({ id: 'att-2', name: 'upload.txt', bytes: 13, mimeType: 'text/plain' });
        }
        if (url.includes('/cards/card-1') && options.method === 'DELETE') {
          return jsonResponse({});
        }
        return jsonResponse({}, 404);
      },
      async (calls) => {
        const filtered = await trelloToolModule.execute(
          {
            toolId: 'trello',
            actionId: 'trello.filter_cards',
            input: { listId: 'list-1', query: 'informe', labelIds: ['label-1'], memberIds: ['member-1'], limit: 10 },
          },
          context,
        );
        assert.equal(filtered.success, true);
        assert.deepEqual(filtered.data.cards.map((card) => card.id), ['card-1']);

        const updated = await trelloToolModule.execute(
          {
            toolId: 'trello',
            actionId: 'trello.update_card',
            input: { cardId: 'card-1', name: 'Enviar informe final', listId: 'list-2', dueComplete: true },
          },
          context,
        );
        assert.equal(updated.success, true);
        assert.equal(updated.data.card.name, 'Enviar informe final');

        const commented = await trelloToolModule.execute(
          { toolId: 'trello', actionId: 'trello.comment_card', input: { cardId: 'card-1', text: 'Listo' } },
          context,
        );
        assert.equal(commented.success, true);
        assert.equal(commented.data.comment.id, 'comment-1');

        const attachments = await trelloToolModule.execute(
          { toolId: 'trello', actionId: 'trello.list_card_attachments', input: { cardId: 'card-1' } },
          context,
        );
        assert.equal(attachments.success, true);
        assert.equal(attachments.data.attachments[0].id, 'att-1');
        assert.equal(JSON.stringify(attachments).includes('token-1'), false);

        const downloaded = await trelloToolModule.execute(
          {
            toolId: 'trello',
            actionId: 'trello.download_attachment',
            input: { cardId: 'card-1', attachmentId: 'att-1', fileName: 'informe.pdf' },
          },
          context,
        );
        assert.equal(downloaded.success, true);
        assert.equal(await readFile(downloaded.data.filePath, 'utf8'), 'PDFDATA');
        assert.equal(downloaded.data.size, 7);
        assert.equal(JSON.stringify(downloaded).includes('token-1'), false);

        const uploaded = await trelloToolModule.execute(
          {
            toolId: 'trello',
            actionId: 'trello.upload_attachment',
            input: { cardId: 'card-1', filePath: uploadPath, name: 'upload.txt' },
          },
          context,
        );
        assert.equal(uploaded.success, true);
        assert.equal(uploaded.data.attachment.id, 'att-2');

        const deleted = await trelloToolModule.execute(
          { toolId: 'trello', actionId: 'trello.delete_card', input: { cardId: 'card-1' } },
          context,
        );
        assert.equal(deleted.success, true);
        assert.deepEqual(deleted.data, { id: 'card-1', deleted: true });

        const updateCall = calls.find((call) => call.url.includes('/cards/card-1') && call.options.method === 'PUT');
        assert.ok(updateCall.url.includes('name=Enviar+informe+final'));
        assert.ok(updateCall.url.includes('idList=list-2'));
        assert.ok(updateCall.url.includes('dueComplete=true'));
        assert.equal(JSON.stringify({ filtered, updated, commented, attachments, downloaded, uploaded, deleted }).includes('token-1'), false);
      },
    );
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});


test('connector actions declare contracts and real outputs conform to them', async () => {
  for (const module of [slackToolModule, trelloToolModule]) {
    for (const action of module.definition.actions) {
      assert.ok(action.outputSchema, `${action.id} declares an output schema`);
      const inputSchema = getMcpToolInputSchema(action.id);
      assert.equal(inputSchema.type, 'object', `${action.id} has an MCP input schema`);
    }
  }

  const secretsStore = createSecretsStore({ 'slack:bot_token': 'xoxb-token' });
  const context = createContext(secretsStore);
  await withMockedFetch(
    (url) => {
      if (url.endsWith('/conversations.list')) {
        return jsonResponse({ ok: true, channels: [{ id: 'C1', name: 'general', is_private: false, num_members: 5 }] });
      }
      if (url.endsWith('/chat.postMessage')) {
        return jsonResponse({ ok: true, channel: 'C1', ts: '123.456' });
      }
      if (url.endsWith('/conversations.history')) {
        return jsonResponse({ ok: true, messages: [{ user: 'U1', text: 'hola', ts: '1.2' }] });
      }
      return jsonResponse({ ok: false, error: 'unknown_method' });
    },
    async () => {
      const cases = [
        ['slack.list_channels', {}],
        ['slack.send_message', { channelId: 'C1', text: 'hola' }],
        ['slack.read_messages', { channelId: 'C1' }],
      ];
      for (const [actionId, input] of cases) {
        const result = await slackToolModule.execute({ toolId: 'slack', actionId, input }, context);
        assert.equal(result.success, true, actionId);
        const schema = slackToolModule.definition.actions.find((action) => action.id === actionId).outputSchema;
        const errors = validateOutputAgainstSchema(result.data, schema);
        assert.deepEqual(errors, [], `${actionId} output matches its declared schema`);
      }
    },
  );
});

test('token connector factory rejects unknown actions and missing secrets on execute', async () => {
  const secretsStore = createSecretsStore();
  const context = createContext(secretsStore);
  const module = createTokenConnectorModule({
    id: 'demo',
    name: 'Demo',
    description: 'Conector de prueba',
    version: '0.0.1',
    connectionStatusActionId: 'demo.connection.status',
    secrets: [{ name: 'token', label: 'Token', required: true, usage: 'test' }],
    validate: async () => ({ ok: true }),
    actions: [
      {
        id: 'demo.connection.status',
        name: 'Estado',
        description: 'estado',
        risk: 'low',
        run: async () => ({ success: true }),
      },
      {
        id: 'demo.explode',
        name: 'Explota',
        description: 'lanza error',
        risk: 'low',
        run: async () => {
          throw new ConnectorApiError('demo_boom');
        },
      },
    ],
  });

  const status = await module.execute({ toolId: 'demo', actionId: 'demo.connection.status', input: {} }, context);
  assert.equal(status.data.connected, false, 'status without secrets reports disconnected');

  const missing = await module.execute({ toolId: 'demo', actionId: 'demo.explode', input: {} }, context);
  assert.equal(missing.technicalCode, 'connector_secrets_required');

  await secretsStore.setToolSecret('demo', 'token', 'x');
  const unknown = await module.execute({ toolId: 'demo', actionId: 'demo.nope', input: {} }, context);
  assert.equal(unknown.technicalCode, 'connector_action_unknown');

  const thrown = await module.execute({ toolId: 'demo', actionId: 'demo.explode', input: {} }, context);
  assert.equal(thrown.success, false);
  assert.equal(thrown.technicalCode, 'demo_boom');
});
