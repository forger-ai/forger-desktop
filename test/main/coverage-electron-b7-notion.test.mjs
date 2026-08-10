import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  notionToolModule,
  NOTION_INTEGRATION_TOKEN_SECRET,
} = require('../../dist-electron/main/connections/modules/notion/index.js');

const jsonResponse = (payload, status = 200) => new Response(
  payload === undefined ? undefined : JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } },
);

const createSecretsStore = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
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

const createContext = (initial = { [`notion:${NOTION_INTEGRATION_TOKEN_SECRET}`]: 'secret-token' }) => ({
  metadataRoot: '/tmp/forger-notion-b7',
  secretsStore: createSecretsStore(initial),
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => false,
  getGmailOAuthClientId: async () => '',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
});

const execute = (actionId, input = {}, context = createContext()) => notionToolModule.execute({
  toolId: 'notion',
  actionId,
  input,
}, context);

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

test('Given a Notion integration, all read and database flows preserve API boundaries', async () => {
  await withFetch(
    (url) => {
      if (url.endsWith('/users/me')) return jsonResponse({ id: 'bot-1', name: '   ' });
      if (url.endsWith('/search')) return jsonResponse({ results: [{ id: 'page-1' }] });
      if (url.endsWith('/pages/page%2F1')) return jsonResponse({ id: 'page/1' });
      if (url.endsWith('/databases/db%2F1/query')) return jsonResponse({ results: [{ id: 'row-1' }] });
      if (url.endsWith('/databases/db%2F1')) return jsonResponse({ id: 'db/1' });
      throw new Error(`Unexpected Notion request: ${url}`);
    },
    async (calls) => {
      const status = await execute('notion.connection.status');
      assert.deepEqual(status, {
        success: true,
        data: { connected: true, subject: 'bot-1', username: 'Notion integration' },
      });

      const search = await execute('notion.search', {
        query: ' roadmap ',
        filterObject: 'database',
        pageSize: 500,
      });
      assert.equal(search.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
        query: 'roadmap',
        page_size: 100,
        filter: { value: 'database', property: 'object' },
      });
      assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer secret-token');
      assert.equal(calls.at(-1).init.headers['Notion-Version'], '2022-06-28');
      assert.equal(calls.at(-1).init.headers['content-type'], 'application/json; charset=utf-8');

      assert.equal((await execute('notion.get_page', { pageId: ' page/1 ' })).data.id, 'page/1');
      assert.equal((await execute('notion.get_database', { databaseId: ' db/1 ' })).data.id, 'db/1');

      const query = await execute('notion.query_database', {
        databaseId: 'db/1',
        filter: { property: 'Done', checkbox: { equals: false } },
        sorts: [{ property: 'Name', direction: 'ascending' }],
        pageSize: -10,
      });
      assert.equal(query.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
        page_size: 1,
        filter: { property: 'Done', checkbox: { equals: false } },
        sorts: [{ property: 'Name', direction: 'ascending' }],
      });

      await execute('notion.search', { query: 42, filterObject: 'invalid' });
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { query: '', page_size: 20 });

      await execute('notion.query_database', {
        databaseId: 'db/1',
        filter: [],
        sorts: 'invalid',
      });
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), { page_size: 20 });
    },
  );
});

test('Given valid parents, Notion create and update flows only send accepted fields', async () => {
  await withFetch(
    () => jsonResponse({ id: 'saved-page' }),
    async (calls) => {
      const pageChild = await execute('notion.create_page', {
        parentPageId: 'parent-page',
        title: ' New page ',
        children: [{ object: 'block' }],
      });
      assert.equal(pageChild.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
        parent: { page_id: 'parent-page' },
        properties: {
          title: { title: [{ text: { content: 'New page' } }] },
        },
        children: [{ object: 'block' }],
      });

      const databaseChild = await execute('notion.create_page', {
        parentPageId: 'ignored-parent',
        databaseId: 'db-parent',
        title: 'Database child',
        properties: { Name: { title: [] } },
        children: 'invalid',
      });
      assert.equal(databaseChild.success, true);
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
        parent: { database_id: 'db-parent' },
        properties: { Name: { title: [] } },
      });

      const updated = await execute('notion.update_page', {
        pageId: 'saved/page',
        properties: { Done: { checkbox: true } },
        archived: false,
      });
      assert.equal(updated.success, true);
      assert.equal(calls.at(-1).init.method, 'PATCH');
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {
        properties: { Done: { checkbox: true } },
        archived: false,
      });

      await execute('notion.update_page', {
        pageId: 'saved/page',
        properties: [],
        archived: 'no',
      });
      assert.deepEqual(JSON.parse(calls.at(-1).init.body), {});
    },
  );
});

test('Given malformed inputs, Notion rejects every scoped mutation before network access', async () => {
  const cases = [
    ['notion.get_page', {}, 'notion_page_required'],
    ['notion.get_database', { databaseId: 123 }, 'notion_database_required'],
    ['notion.query_database', { databaseId: '   ' }, 'notion_database_required'],
    ['notion.create_page', { title: 'Title' }, 'notion_create_input_invalid'],
    ['notion.create_page', { title: ' ', parentPageId: 'parent' }, 'notion_create_input_invalid'],
    ['notion.update_page', { pageId: [] }, 'notion_page_required'],
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Network must not be reached');
  };
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

test('When Notion fails, API, HTTP, runtime and non-Error failures remain deterministic', async () => {
  const failures = [
    [() => jsonResponse({ code: 'object_not_found' }, 404), 'notion_api_object_not_found'],
    [() => jsonResponse([], 429), 'notion_http_429'],
    [() => new Response('not-json', { status: 500 }), 'notion_http_500'],
    [() => { throw new Error('network offline'); }, 'network offline'],
    [() => { throw 'opaque failure'; }, 'notion_search_failed'],
  ];
  for (const [response, expectedCode] of failures) {
    await withFetch(response, async () => {
      const result = await execute('notion.search', {});
      assert.equal(result.success, false);
      assert.equal(result.technicalCode, expectedCode);
    });
  }

  const actionFailures = [
    ['notion.get_page', { pageId: 'p' }, 'notion_get_page_failed'],
    ['notion.get_database', { databaseId: 'd' }, 'notion_get_database_failed'],
    ['notion.query_database', { databaseId: 'd' }, 'notion_query_database_failed'],
    ['notion.create_page', { parentPageId: 'p', title: 'Title' }, 'notion_create_page_failed'],
    ['notion.update_page', { pageId: 'p' }, 'notion_update_page_failed'],
  ];
  for (const [actionId, input, fallback] of actionFailures) {
    await withFetch(
      () => { throw fallback; },
      async () => assert.equal((await execute(actionId, input)).technicalCode, fallback),
    );
  }

  await withFetch(
    () => jsonResponse(undefined, 204),
    async () => assert.deepEqual((await execute('notion.get_page', { pageId: 'empty' })).data, {}),
  );
});

test('When Notion validation fails, connection status does not expose credentials', async () => {
  const disconnected = await execute('notion.connection.status', {}, createContext({}));
  assert.deepEqual(disconnected, { success: true, data: { connected: false } });

  await withFetch(
    () => jsonResponse({ code: 123 }, 401),
    async () => {
      const result = await execute('notion.connection.status');
      assert.deepEqual(result, {
        success: true,
        data: { connected: false, technicalCode: 'notion_http_401' },
      });
    },
  );

  await withFetch(
    () => { throw new Error('offline'); },
    async () => {
      const result = await execute('notion.connection.status');
      assert.equal(result.data.technicalCode, 'notion_validation_failed');
    },
  );
});
