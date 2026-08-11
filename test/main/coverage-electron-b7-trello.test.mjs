import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  trelloToolModule,
  TRELLO_API_KEY_SECRET,
  TRELLO_API_TOKEN_SECRET,
} = require('../../dist-electron/main/connections/modules/trello/index.js');

const createSecretsStore = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    async getToolSecret(toolId, name) {
      return values.get(`${toolId}:${name}`) ?? null;
    },
    async hasToolSecret(toolId, name) {
      return values.has(`${toolId}:${name}`);
    },
    async setToolSecret(toolId, name, value) {
      values.set(`${toolId}:${name}`, value);
      return { success: true };
    },
    async deleteToolSecrets() {},
  };
};

const connectedSecrets = {
  [`trello:${TRELLO_API_KEY_SECRET}`]: 'key-1',
  [`trello:${TRELLO_API_TOKEN_SECRET}`]: 'token-1',
};

const createContext = (metadataRoot = '/tmp/forger-trello-b7', initial = connectedSecrets) => ({
  metadataRoot,
  secretsStore: createSecretsStore(initial),
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => false,
  getGmailOAuthClientId: async () => '',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
});

const execute = (actionId, input = {}, context = createContext()) => trelloToolModule.execute({
  toolId: 'trello',
  actionId,
  input,
}, context);

const response = (payload, status = 200, headers = { 'content-type': 'application/json' }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => payload,
  arrayBuffer: async () => Buffer.from(payload ?? ''),
});

const withFetch = async (handler, operation) => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
};

test('Given Trello credentials, status validation and list cards preserve the API contract', async () => {
  await withFetch(
    (url) => {
      if (url.includes('/members/me')) return response({ username: 42, fullName: null });
      if (url.includes('/lists/list%2F1/cards')) {
        return response([
          {
            id: 'card-1', name: 'First', desc: 'Description', due: null, dueComplete: false,
            url: 'https://trello.test/c/1', idList: 'list/1', closed: false,
            idLabels: ['label-1'], idMembers: ['member-1'],
          },
          { id: 'card-2', name: 'Second', idLabels: null, idMembers: null },
        ]);
      }
      throw new Error(`Unexpected Trello request: ${url}`);
    },
    async (calls) => {
      const status = await execute('trello.connection.status');
      assert.deepEqual(status, {
        success: true,
        data: { connected: true, username: undefined, fullName: undefined },
      });

      const cards = await execute('trello.list_cards', { listId: ' list/1 ', limit: Infinity });
      assert.equal(cards.success, true);
      assert.equal(cards.data.cards.length, 2);
      assert.deepEqual(cards.data.cards[1].labelIds, []);
      assert.deepEqual(cards.data.cards[1].memberIds, []);
      const parsed = new URL(calls.at(-1).url);
      assert.equal(parsed.searchParams.get('key'), 'key-1');
      assert.equal(parsed.searchParams.get('token'), 'token-1');

      const oneCard = await execute('trello.list_cards', { listId: 'list/1', limit: -5 });
      assert.equal(oneCard.data.cards.length, 1);
    },
  );
});

test('Given board and list scopes, Trello filters every supported dimension and clamps limits', async () => {
  const cards = [
    { id: 'keep', name: 'Target task', desc: 'body', idLabels: ['l1'], idMembers: ['m1'], dueComplete: true, due: '2026-08-10' },
    { id: 'query', name: 'Other', desc: 'body', idLabels: ['l1'], idMembers: ['m1'], dueComplete: true, due: '2026-08-10' },
    { id: 'label', name: 'Target', idLabels: [], idMembers: ['m1'], dueComplete: true, due: '2026-08-10' },
    { id: 'member', name: 'Target', idLabels: ['l1'], idMembers: [], dueComplete: true, due: '2026-08-10' },
    { id: 'done', name: 'Target', idLabels: ['l1'], idMembers: ['m1'], dueComplete: false, due: '2026-08-10' },
    { id: 'late', name: 'Target', idLabels: ['l1'], idMembers: ['m1'], dueComplete: true, due: '2026-12-31' },
    { id: 'early', name: 'Target', idLabels: ['l1'], idMembers: ['m1'], dueComplete: true, due: '2025-01-01' },
    { id: 'no-due', name: 'Target', idLabels: ['l1'], idMembers: ['m1'], dueComplete: true },
    { id: 'sparse', name: 'Target sparse', idLabels: null, idMembers: null },
  ];

  await withFetch(
    () => response(cards),
    async (calls) => {
      const filtered = await execute('trello.filter_cards', {
        boardId: 'board-1',
        query: ' target ',
        closed: true,
        labelIds: ['l1', ' ', 'l1'],
        memberIds: ['m1'],
        dueBefore: '2026-09-01',
        dueAfter: '2026-01-01',
        dueComplete: true,
        limit: 900,
      });
      assert.deepEqual(filtered.data.cards.map((card) => card.id), ['keep']);
      let parsed = new URL(calls.at(-1).url);
      assert.equal(parsed.pathname, '/1/boards/board-1/cards');
      assert.equal(parsed.searchParams.get('filter'), 'closed');

      await execute('trello.filter_cards', { listId: 'list-1', closed: false, labelIds: 'bad', memberIds: null });
      parsed = new URL(calls.at(-1).url);
      assert.equal(parsed.pathname, '/1/lists/list-1/cards');
      assert.equal(parsed.searchParams.get('filter'), 'open');

      await execute('trello.filter_cards', { boardId: 'board-1', closed: 'all', limit: Number.NaN });
      parsed = new URL(calls.at(-1).url);
      assert.equal(parsed.searchParams.get('filter'), 'all');
    },
  );
});

test('Given malformed Trello inputs, scoped actions fail before making requests', async () => {
  const cases = [
    ['trello.list_lists', {}, 'trello_board_required'],
    ['trello.list_cards', { listId: 3 }, 'trello_list_required'],
    ['trello.filter_cards', {}, 'trello_cards_scope_required'],
    ['trello.create_card', { listId: 'list' }, 'trello_create_input_invalid'],
    ['trello.update_card', {}, 'trello_card_required'],
    ['trello.update_card', { cardId: 'card' }, 'trello_update_input_empty'],
    ['trello.delete_card', {}, 'trello_card_required'],
    ['trello.comment_card', { cardId: 'card', text: [] }, 'trello_comment_input_invalid'],
    ['trello.list_card_attachments', {}, 'trello_card_required'],
    ['trello.download_attachment', { cardId: 'card' }, 'trello_attachment_input_invalid'],
    ['trello.upload_attachment', { cardId: 'card' }, 'trello_upload_input_invalid'],
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network must not be reached'); };
  try {
    for (const [actionId, input, technicalCode] of cases) {
      const result = await execute(actionId, input);
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, technicalCode);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('When Trello action requests fail opaquely, each action returns its stable fallback code', async () => {
  const cases = [
    ['trello.list_boards', {}, 'trello_list_boards_failed'],
    ['trello.list_lists', { boardId: 'board' }, 'trello_list_lists_failed'],
    ['trello.list_cards', { listId: 'list' }, 'trello_list_cards_failed'],
    ['trello.filter_cards', { boardId: 'board' }, 'trello_filter_cards_failed'],
    ['trello.create_card', { listId: 'list', name: 'Card' }, 'trello_create_card_failed'],
    ['trello.update_card', { cardId: 'card', name: 'Name' }, 'trello_update_card_failed'],
    ['trello.delete_card', { cardId: 'card' }, 'trello_delete_card_failed'],
    ['trello.comment_card', { cardId: 'card', text: 'Text' }, 'trello_comment_card_failed'],
    ['trello.list_card_attachments', { cardId: 'card' }, 'trello_list_card_attachments_failed'],
  ];
  for (const [actionId, input, expectedCode] of cases) {
    await withFetch(
      () => { throw expectedCode; },
      async () => assert.equal((await execute(actionId, input)).technicalCode, expectedCode),
    );
  }

  await withFetch(
    () => response({}, 503),
    async () => assert.equal((await execute('trello.list_boards')).technicalCode, 'trello_http_503'),
  );
  await withFetch(
    () => { throw new Error('offline'); },
    async () => assert.equal((await execute('trello.list_boards')).technicalCode, 'offline'),
  );
});

test('When Trello returns empty response variants, the connector safely normalizes transport details', async () => {
  await withFetch(
    () => response(undefined, 204),
    async () => assert.equal((await execute('trello.delete_card', { cardId: 'card' })).success, true),
  );

  await withFetch(
    () => response('plain', 200, { 'content-type': 'text/plain' }),
    async () => assert.equal((await execute('trello.list_boards')).success, false),
  );

  await withFetch(
    () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('invalid json'); },
    }),
    async () => assert.equal((await execute('trello.list_boards')).success, false),
  );
});

test('Given attachment downloads, Trello enforces identity, size and private local persistence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-trello-b7-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await withFetch(
    (url) => {
      if (url.includes('/attachments')) {
        return response([
          { id: 'blank-url', name: 'blank.txt', url: ' ' },
          { id: 'download', name: '', mimeType: '', url: 'https://files.trello.test/file' },
        ]);
      }
      return response('payload', 200, {});
    },
    async () => {
      assert.equal((await execute('trello.download_attachment', {
        cardId: 'card', attachmentId: 'missing',
      }, createContext(root))).technicalCode, 'trello_attachment_not_found');
      assert.equal((await execute('trello.download_attachment', {
        cardId: 'card', attachmentId: 'blank-url',
      }, createContext(root))).technicalCode, 'trello_attachment_not_found');

      const downloaded = await execute('trello.download_attachment', {
        cardId: 'card', attachmentId: 'download', fileName: '  bad/name?.txt  ',
      }, createContext(root));
      assert.equal(downloaded.success, true);
      assert.equal(downloaded.data.fileName, 'bad-name-.txt');
      assert.equal(downloaded.data.size, 7);
      assert.equal(downloaded.data.mimeType, undefined);
    },
  );

  await withFetch(
    (url) => url.includes('/attachments')
      ? response([{ id: 'download', name: '', url: 'https://files.trello.test/file' }])
      : response('', 401),
    async () => assert.equal((await execute('trello.download_attachment', {
      cardId: 'card', attachmentId: 'download', fileName: '',
    }, createContext(root))).technicalCode, 'trello_http_401'),
  );

  await withFetch(
    (url) => url.includes('/attachments')
      ? response([{ id: 'huge', name: 'huge.bin', url: 'https://files.trello.test/huge' }])
      : response(Buffer.alloc(25 * 1024 * 1024 + 1), 200, { 'content-type': 'application/octet-stream' }),
    async () => assert.equal((await execute('trello.download_attachment', {
      cardId: 'card', attachmentId: 'huge',
    }, createContext(root))).technicalCode, 'trello_attachment_too_large'),
  );
});

test('Given attachment uploads, Trello accepts only absolute regular files within its size limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-trello-b7-upload-'));
  const filePath = join(root, 'local.txt');
  const hugePath = join(root, 'huge.bin');
  await writeFile(filePath, 'content', 'utf8');
  await writeFile(hugePath, 'x');
  await truncate(hugePath, 25 * 1024 * 1024 + 1);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal((await execute('trello.upload_attachment', {
    cardId: 'card', filePath: 'relative.txt',
  })).technicalCode, 'trello_upload_path_invalid');
  assert.equal((await execute('trello.upload_attachment', {
    cardId: 'card', filePath: join(root, 'missing.txt'),
  })).technicalCode, 'trello_upload_file_missing');
  assert.equal((await execute('trello.upload_attachment', {
    cardId: 'card', filePath: root,
  })).technicalCode, 'trello_upload_file_missing');
  assert.equal((await execute('trello.upload_attachment', {
    cardId: 'card', filePath: hugePath,
  })).technicalCode, 'trello_attachment_too_large');

  await withFetch(
    (_url, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(init.body instanceof FormData, true);
      return response({ id: 'att', name: 'local.txt', bytes: 7, mimeType: 'text/plain' });
    },
    async () => {
      const uploaded = await execute('trello.upload_attachment', {
        cardId: 'card/id', filePath, name: '  ',
      });
      assert.equal(uploaded.success, true);
      assert.equal(uploaded.data.attachment.id, 'att');
    },
  );

  await withFetch(
    () => response({}, 500),
    async () => assert.equal((await execute('trello.upload_attachment', {
      cardId: 'card', filePath, name: 'unsafe/name',
    })).technicalCode, 'trello_http_500'),
  );

  await withFetch(
    () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
    async () => assert.equal((await execute('trello.upload_attachment', {
      cardId: 'card', filePath,
    })).success, true),
  );
});

test('When Trello validation fails, status reports only stable diagnostic codes', async () => {
  assert.deepEqual(
    await execute('trello.connection.status', {}, createContext('/tmp/forger-trello-b7', {})),
    { success: true, data: { connected: false } },
  );

  await withFetch(
    () => response({}, 401),
    async () => assert.equal((await execute('trello.connection.status')).data.technicalCode, 'trello_http_401'),
  );
  await withFetch(
    () => { throw new Error('offline'); },
    async () => assert.equal((await execute('trello.connection.status')).data.technicalCode, 'trello_validation_failed'),
  );

  await withFetch(
    () => response({ username: 'person', fullName: 'Person Name' }),
    async () => assert.deepEqual((await execute('trello.connection.status')).data, {
      connected: true,
      username: 'person',
      fullName: 'Person Name',
    }),
  );
});

test('Given complete card payloads, Trello forwards optional creation, update and comment fields', async () => {
  await withFetch(
    (rawUrl, init) => {
      const url = new URL(rawUrl);
      if (url.pathname.endsWith('/actions/comments')) return response({ id: 'comment', date: '2026-08-10' });
      if (url.pathname.endsWith('/cards') && init.method === 'POST') {
        return response({ id: 'created', name: 'Card', url: 'https://trello.test/c/created' });
      }
      if (url.pathname.endsWith('/cards/card') && init.method === 'PUT') {
        return response({ id: 'card', name: 'Updated', idLabels: [], idMembers: [] });
      }
      throw new Error(`Unexpected Trello request: ${url}`);
    },
    async (calls) => {
      assert.equal((await execute('trello.create_card', {
        listId: 'list',
        name: 'Card',
        description: 'Description',
        dueDate: '2026-09-01',
      })).success, true);
      let request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('desc'), 'Description');
      assert.equal(request.searchParams.get('due'), '2026-09-01');

      assert.equal((await execute('trello.update_card', {
        cardId: 'card',
        name: 'Updated',
        description: 'Updated description',
        listId: 'new-list',
        dueDate: '2026-10-01',
        dueComplete: false,
        closed: true,
      })).success, true);
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('desc'), 'Updated description');
      assert.equal(request.searchParams.get('due'), '2026-10-01');
      assert.equal(request.searchParams.get('closed'), 'true');

      const comment = await execute('trello.comment_card', { cardId: 'card', text: 'Comment' });
      assert.equal(comment.success, true);
      assert.equal(comment.data.comment.text, undefined);
    },
  );
});
