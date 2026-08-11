import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gmailToolModule } = require('../../dist-electron/main/connections/modules/gmail/index.js');
const {
  GMAIL_REFRESH_TOKEN_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_ID_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET,
} = require('../../dist-electron/main/connections/modules/gmail/types.js');

const createSecretsStore = (overrides = {}) => ({
  hasToolSecret: async (_toolId, secretName) => secretName === GMAIL_REFRESH_TOKEN_SECRET,
  getToolSecret: async (_toolId, secretName) => (
    secretName === GMAIL_REFRESH_TOKEN_SECRET ? 'refresh-token' : undefined
  ),
  setToolSecret: async () => ({ success: true }),
  deleteToolSecrets: async () => undefined,
  ...overrides,
});

const createContext = (overrides = {}) => ({
  metadataRoot: '/tmp/forger-gmail-b7',
  locale: 'es',
  secretsStore: createSecretsStore(),
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client',
  exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
  refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
  appendLog: async () => undefined,
  ...overrides,
});

const execute = (actionId, input, context = createContext()) => gmailToolModule.execute({
  toolId: 'gmail',
  actionId,
  ...(input === undefined ? {} : { input }),
}, context);

const withFetch = async (handler, operation) => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(new URL(url), init, calls.length);
  };
  try {
    return await operation(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
};

const gmailJson = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('Given a connected Gmail account, mailbox and synchronization actions preserve pagination', async () => {
  await withFetch(
    (url) => {
      if (url.pathname.endsWith('/profile')) {
        return gmailJson({ emailAddress: 'person@example.com', messagesTotal: 2, threadsTotal: 1, historyId: 'h1' });
      }
      if (url.pathname.endsWith('/labels')) {
        return gmailJson({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }] });
      }
      if (url.pathname.endsWith('/threads')) return gmailJson({ threads: [], nextPageToken: 'next', resultSizeEstimate: 0 });
      if (url.pathname.endsWith('/history')) return gmailJson({ historyId: 'h2', history: [], nextPageToken: 'h-next' });
      if (url.pathname.endsWith('/messages')) return gmailJson({ messages: [] });
      throw new Error(`Unexpected Gmail request: ${url}`);
    },
    async (calls) => {
      assert.deepEqual(await execute('gmail.connection.status'), { success: true, data: { connected: true } });
      assert.equal((await execute('gmail.get_profile')).data.profile.emailAddress, 'person@example.com');
      assert.equal((await execute('gmail.list_labels')).data.labels[0].id, 'INBOX');

      const noFilters = await execute('gmail.list_threads');
      assert.equal(noFilters.success, true);
      let request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('maxResults'), '20');

      const threads = await execute('gmail.list_threads', {
        query: ' label:inbox ',
        labelIds: [' INBOX ', 7, '', 'STARRED'],
        maxResults: 3,
        pageToken: ' page-2 ',
      });
      assert.equal(threads.success, true);
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('q'), 'label:inbox');
      assert.deepEqual(request.searchParams.getAll('labelIds'), ['INBOX', 'STARRED']);
      assert.equal(request.searchParams.get('maxResults'), '3');
      assert.equal(request.searchParams.get('pageToken'), 'page-2');

      await execute('gmail.list_threads', {
        query: 4,
        labelIds: 'INBOX',
        maxResults: Number.NaN,
        pageToken: 5,
      });
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('q'), null);
      assert.equal(request.searchParams.get('pageToken'), null);

      const changes = await execute('gmail.list_changes', {
        startHistoryId: ' h1 ', maxResults: 7, pageToken: ' h-page ',
      });
      assert.equal(changes.data.historyId, 'h2');
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('startHistoryId'), 'h1');
      assert.equal(request.searchParams.get('maxResults'), '7');
      assert.equal(request.searchParams.get('pageToken'), 'h-page');

      await execute('gmail.list_changes', { startHistoryId: 'h1', maxResults: Infinity, pageToken: 4 });
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('maxResults'), '100');
      assert.equal(request.searchParams.get('pageToken'), null);

      const search = await execute('gmail.search_messages', {
        query: ' subject:report ', maxResults: 2, pageToken: ' message-page ',
      });
      assert.equal(search.success, true);
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('q'), 'subject:report');
      assert.equal(request.searchParams.get('maxResults'), '2');
      assert.equal(request.searchParams.get('pageToken'), 'message-page');

      assert.equal((await execute('gmail.search_messages', { query: 5 })).technicalCode, 'gmail_search_input_invalid');
    },
  );
});

test('Given a Gmail thread, mutation parsers resolve labels deterministically and enforce destinations', async () => {
  await withFetch(
    (url, init) => {
      if (url.pathname.endsWith('/modify')) {
        return gmailJson({ id: 'thread-1', request: JSON.parse(init.body) });
      }
      if (url.pathname.endsWith('/trash') || url.pathname.endsWith('/untrash')) {
        return gmailJson({ id: 'thread-1' });
      }
      if (url.pathname.endsWith('/threads/thread-1')) {
        return gmailJson({ id: 'thread-1', messages: [] });
      }
      throw new Error(`Unexpected Gmail request: ${url}`);
    },
    async (calls) => {
      const modified = await execute('gmail.modify_thread', {
        threadId: ' thread-1 ',
        addLabelIds: ['CUSTOM', 'CONFLICT', 7],
        removeLabelIds: ['OLD', 'CONFLICT', null],
        markRead: true,
        markUnread: true,
        star: true,
        unstar: true,
        archive: true,
      });
      assert.equal(modified.success, true);
      const modifyCall = calls.find((call) => new URL(call.url).pathname.endsWith('/modify'));
      assert.deepEqual(JSON.parse(modifyCall.init.body), {
        addLabelIds: ['CUSTOM'],
        removeLabelIds: ['OLD', 'INBOX'],
      });

      assert.equal((await execute('gmail.modify_thread', {
        threadId: 'thread-1', addLabelIds: ['ONLY_ADD'],
      })).success, true);
      assert.equal((await execute('gmail.modify_thread', {
        threadId: 'thread-1', removeLabelIds: ['ONLY_REMOVE'],
      })).success, true);

      assert.equal((await execute('gmail.move_thread', {
        threadId: 'thread-1', destination: 'trash',
      })).success, true);
      assert.equal((await execute('gmail.move_thread', {
        threadId: 'thread-1', destination: 'untrash',
      })).success, true);
    },
  );
});

test('Given Gmail drafts, list, get, create, update, delete and send form one complete flow', async () => {
  const draftMessage = {
    id: 'message-1',
    threadId: 'thread-1',
    payload: { headers: [{ name: 'Subject', value: 'Draft' }], body: { data: '' } },
  };
  await withFetch(
    (url, init) => {
      if (url.pathname.endsWith('/drafts') && init.method === 'POST') {
        return gmailJson({ id: 'created', message: draftMessage });
      }
      if (url.pathname.endsWith('/drafts/draft-1') && init.method === 'PUT') {
        return gmailJson({ id: 'draft-1', message: draftMessage });
      }
      if (url.pathname.endsWith('/drafts/draft-1') && init.method === 'DELETE') return gmailJson({});
      if (url.pathname.endsWith('/drafts/send')) return gmailJson({ id: 'sent', threadId: 'thread-1' });
      if (url.pathname.endsWith('/drafts/draft-1')) return gmailJson({ id: 'draft-1', message: draftMessage });
      if (url.pathname.endsWith('/drafts')) return gmailJson({ drafts: [], nextPageToken: 'next', resultSizeEstimate: 0 });
      throw new Error(`Unexpected Gmail request: ${url}`);
    },
    async (calls) => {
      assert.equal((await execute('gmail.list_drafts')).success, true);
      let request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('maxResults'), '20');

      await execute('gmail.list_drafts', { maxResults: 2, pageToken: ' next ' });
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('maxResults'), '2');
      assert.equal(request.searchParams.get('pageToken'), 'next');

      await execute('gmail.list_drafts', { maxResults: Number.NaN, pageToken: 1 });
      request = new URL(calls.at(-1).url);
      assert.equal(request.searchParams.get('maxResults'), '20');

      assert.equal((await execute('gmail.get_draft', { draftId: ' draft-1 ' })).data.draft.id, 'draft-1');

      const created = await execute('gmail.save_draft', {
        to: ['person@example.com'], subject: 'Draft', body: 'Body',
      });
      assert.equal(created.data.draft.id, 'created');

      const updated = await execute('gmail.save_draft', {
        draftId: ' draft-1 ', threadId: ' thread-1 ',
        to: ['person@example.com'], subject: 'Draft', bodyHtml: '<p>Body</p>',
      });
      assert.equal(updated.data.draft.id, 'draft-1');

      assert.deepEqual((await execute('gmail.delete_draft', { draftId: ' draft-1 ' })).data, {
        id: 'draft-1', deleted: true,
      });
      assert.equal((await execute('gmail.send_draft', { draftId: ' draft-1 ' })).data.id, 'sent');
    },
  );
});

test('Given malformed Gmail action inputs, every parser rejects unsafe values before network access', async () => {
  const cases = [
    ['gmail.list_threads', [], 'gmail_list_threads_input_invalid'],
    ['gmail.list_changes', undefined, 'gmail_list_changes_input_invalid'],
    ['gmail.list_changes', { startHistoryId: [] }, 'gmail_list_changes_input_invalid'],
    ['gmail.modify_thread', null, 'gmail_modify_thread_input_invalid'],
    ['gmail.modify_thread', { threadId: 'thread' }, 'gmail_modify_thread_input_invalid'],
    ['gmail.modify_thread', { threadId: 9, markRead: true }, 'gmail_modify_thread_input_invalid'],
    ['gmail.modify_thread', { threadId: 'thread', addLabelIds: ['SAME'], removeLabelIds: ['SAME'] }, 'gmail_modify_thread_input_invalid'],
    ['gmail.move_thread', [], 'gmail_move_thread_input_invalid'],
    ['gmail.move_thread', { threadId: 'thread', destination: 'archive' }, 'gmail_move_thread_input_invalid'],
    ['gmail.move_thread', { threadId: 2, destination: 'trash' }, 'gmail_move_thread_input_invalid'],
    ['gmail.read_attachment', { messageId: 7, filename: 'file.txt' }, 'gmail_read_attachment_input_invalid'],
    ['gmail.list_drafts', 'bad', 'gmail_list_drafts_input_invalid'],
    ['gmail.get_draft', [], 'gmail_get_draft_input_invalid'],
    ['gmail.get_draft', { draftId: 1 }, 'gmail_get_draft_input_invalid'],
    ['gmail.save_draft', null, 'gmail_save_draft_input_invalid'],
    ['gmail.save_draft', { draftId: 1, to: ['bad'], subject: 'x', body: 'x' }, 'gmail_save_draft_input_invalid'],
    ['gmail.delete_draft', null, 'gmail_delete_draft_input_invalid'],
    ['gmail.send_draft', { draftId: ' ' }, 'gmail_send_draft_input_invalid'],
  ];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network must not be reached'); };
  try {
    for (const [actionId, input, technicalCode] of cases) {
      const result = await execute(actionId, input);
      assert.equal(result.success, false, actionId);
      assert.equal(result.technicalCode, technicalCode, actionId);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('When Gmail reports scope, OAuth, runtime and opaque failures, diagnostics stay stable', async () => {
  await withFetch(
    () => gmailJson({ error: { message: 'Request had insufficient authentication scopes.' } }, 403),
    async () => {
      const result = await execute('gmail.get_profile');
      assert.deepEqual(result, {
        success: false,
        userMessage: 'Reconecta Gmail para autorizar las nuevas acciones.',
        technicalCode: 'gmail_scope_required',
        data: { needsReconnect: true },
      });
    },
  );

  const oauth = await execute('gmail.get_profile', undefined, createContext({
    refreshGmailOAuthAccessToken: async () => {
      throw Object.assign(new Error('Session expired'), { technicalCode: 'gmail_session_expired' });
    },
  }));
  assert.equal(oauth.success, false);
  assert.equal(oauth.technicalCode, 'gmail_session_expired');
  assert.equal(oauth.userMessage, 'Session expired');

  const runtime = await execute('gmail.connection.status', undefined, createContext({
    secretsStore: createSecretsStore({ hasToolSecret: async () => { throw new Error('keychain unavailable'); } }),
  }));
  assert.equal(runtime.technicalCode, 'keychain unavailable');

  const opaque = await execute('gmail.connection.status', undefined, createContext({
    secretsStore: createSecretsStore({ hasToolSecret: async () => { throw 'opaque failure'; } }),
  }));
  assert.equal(opaque.technicalCode, 'gmail_action_failed');
});

test('Given dangerous attachment names, Gmail stores a bounded file under its private metadata root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-gmail-b7-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withFetch(
    (url) => {
      if (url.pathname.endsWith('/messages/message-id')) {
        return gmailJson({
          id: 'message-id',
          threadId: 'thread-id',
          payload: {
            headers: [],
            parts: [{ filename: '..', mimeType: 'application/octet-stream', body: { attachmentId: 'att-1', size: 7 } }],
          },
        });
      }
      if (url.pathname.endsWith('/messages/message-id/attachments/att-1')) {
        return gmailJson({ data: Buffer.from('payload').toString('base64url') });
      }
      throw new Error(`Unexpected Gmail request: ${url}`);
    },
    async () => {
      const result = await execute('gmail.read_attachment', {
        messageId: 'message-id', attachmentId: 'att-1', filename: 'ignored',
      }, createContext({ metadataRoot: root }));
      assert.equal(result.success, true);
      assert.equal(result.data.filename, '..');
      assert.equal(result.data.filePath.startsWith(root), true);
      assert.equal(await readFile(result.data.filePath, 'utf8'), 'payload');
      assert.equal(result.data.filePath.endsWith('/attachment'), true);

      const missing = await execute('gmail.read_attachment', {
        messageId: 'message-id', attachmentId: 'missing',
      }, createContext({ metadataRoot: root }));
      assert.equal(missing.technicalCode, 'gmail_attachment_not_found');
    },
  );
});

test('When Gmail is configured with self OAuth, credentials are stored only after a valid loopback callback', async () => {
  const nativeFetch = globalThis.fetch;
  const saved = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      assert.equal(init.method, 'POST');
      return gmailJson({ access_token: 'access', refresh_token: 'new-refresh' });
    }
    return nativeFetch(url, init);
  };
  const context = createContext({
    secretsStore: createSecretsStore({
      setToolSecret: async (toolId, secretName, value) => {
        saved.push({ toolId, secretName, value });
        return { success: true };
      },
    }),
    openExternalUrl: async (url) => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', 'authorization-code');
      const response = await nativeFetch(callback);
      assert.equal(response.status, 200);
    },
  });
  try {
    const configured = await gmailToolModule.configure(context, {
      toolId: 'gmail',
      secrets: {
        [GMAIL_SELF_OAUTH_CLIENT_ID_SECRET]: ' self-client ',
        [GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET]: ' self-secret ',
      },
    });
    assert.equal(configured.success, true);
    assert.equal(saved.some((entry) => entry.secretName === GMAIL_REFRESH_TOKEN_SECRET && entry.value === 'new-refresh'), true);
    assert.equal(saved.some((entry) => entry.secretName === GMAIL_SELF_OAUTH_CLIENT_ID_SECRET && entry.value === 'self-client'), true);
    assert.equal(saved.some((entry) => entry.secretName === GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET && entry.value === 'self-secret'), true);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
