import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getDraft,
  getProfile,
  listChanges,
  listDrafts,
  listLabels,
  listThreads,
  modifyThread,
  moveThread,
  readMessage,
  readThread,
  searchMessages,
  sendDraft,
  sendMessage,
} = require('../../dist-electron/main/connections/modules/gmail/client.js');
const {
  GmailOAuthError,
  refreshGmailAccessToken,
  runGmailOAuthFlow,
} = require('../../dist-electron/main/connections/modules/gmail/oauth.js');
const {
  GMAIL_REFRESH_TOKEN_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_ID_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET,
} = require('../../dist-electron/main/connections/modules/gmail/types.js');

const createSecretsStore = (overrides = {}) => ({
  hasToolSecret: async () => true,
  getToolSecret: async (_toolId, secretName) => (
    secretName === GMAIL_REFRESH_TOKEN_SECRET ? 'refresh-token' : undefined
  ),
  setToolSecret: async () => ({ success: true }),
  deleteToolSecrets: async () => undefined,
  ...overrides,
});

const createContext = (overrides = {}) => ({
  metadataRoot: '/tmp/forger-b25-gmail',
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

const gmailJson = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test('Gmail client preserves safe defaults for incomplete upstream records', async () => {
  const previousFetch = globalThis.fetch;
  let historyCall = 0;
  let labelsCall = 0;
  let threadsCall = 0;
  globalThis.fetch = async (url, init = {}) => {
    const request = new URL(url);
    const { pathname } = request;

    if (pathname.endsWith('/profile')) return gmailJson({});
    if (pathname.endsWith('/labels')) {
      labelsCall += 1;
      return gmailJson(labelsCall === 1 ? {} : { labels: [{ id: 'label-without-name' }] });
    }
    if (pathname.endsWith('/messages') && request.searchParams.has('q')) {
      return gmailJson({ messages: [{}, { id: 'missing-thread' }, { id: 'message-1', threadId: 'thread-1' }] });
    }
    if (pathname.endsWith('/messages/message-1')) {
      return gmailJson({ snippet: 42, payload: { headers: [{ name: 7, value: 8 }] } });
    }
    if (pathname.endsWith('/messages/sparse')) return gmailJson(null);
    if (pathname.endsWith('/messages/with-snippet')) return gmailJson({ snippet: 'Visible snippet' });
    if (pathname.endsWith('/threads') && !init.method) {
      threadsCall += 1;
      if (threadsCall === 2) return gmailJson({});
      return gmailJson({ threads: [{}, { id: 'thread-empty' }, { id: 'thread-fallback' }, { id: 'thread-label' }] });
    }
    if (pathname.endsWith('/threads/thread-empty') && request.searchParams.get('format') === 'metadata') {
      return gmailJson({ messages: null });
    }
    if (pathname.endsWith('/threads/thread-fallback') && request.searchParams.get('format') === 'metadata') {
      return gmailJson({
        messages: [{
          id: 'latest-message',
          threadId: 'fallback-id',
          snippet: 'latest snippet',
          payload: { headers: [] },
        }],
      });
    }
    if (pathname.endsWith('/threads/thread-label') && request.searchParams.get('format') === 'metadata') {
      return gmailJson({ messages: [{ id: 'label-message', threadId: 'label-thread', labelIds: ['HAS_ATTACHMENT'] }] });
    }
    if (pathname.endsWith('/threads/sparse') && request.searchParams.get('format') === 'full') return gmailJson({});
    if (pathname.endsWith('/history')) {
      historyCall += 1;
      if (historyCall === 1) return gmailJson({});
      return gmailJson({
        history: [{
          messagesAdded: null,
          labelsAdded: [null, { message: {} }, { message: { id: 'added', threadId: '', labelIds: [] } }],
          labelsRemoved: [{ message: { id: 'removed', threadId: 'thread-r', labelIds: ['STARRED'] } }],
        }],
      });
    }
    if (pathname.endsWith('/threads/mutated/modify')) return gmailJson({});
    if (pathname.endsWith('/threads/mutated/trash')) return gmailJson({});
    if (pathname.endsWith('/threads/mutated') && request.searchParams.get('format') === 'full') return gmailJson({});
    if (pathname.endsWith('/drafts') && !init.method) return gmailJson({});
    if (pathname.endsWith('/drafts/sparse')) return gmailJson({});
    if (pathname.endsWith('/messages/send')) return gmailJson({});
    if (pathname.endsWith('/drafts/send')) return gmailJson({});
    throw new Error(`Unexpected Gmail request: ${request} ${init.method ?? 'GET'}`);
  };

  try {
    const context = createContext();
    assert.deepEqual(await getProfile(context), { emailAddress: '', messagesTotal: undefined, threadsTotal: undefined, historyId: undefined });
    assert.deepEqual(await listLabels(context), []);
    assert.deepEqual(await listLabels(context), []);

    const messages = await searchMessages(context, 'sparse');
    assert.deepEqual(messages, [{
      id: 'message-1',
      threadId: 'thread-1',
      unread: false,
      starred: false,
      hasAttachments: false,
    }]);
    assert.deepEqual(await readMessage(context, 'sparse'), {
      id: '',
      threadId: '',
      snippet: undefined,
      headers: {},
      labelIds: [],
      textBody: undefined,
      htmlBody: undefined,
      attachments: [],
    });
    assert.equal((await readMessage(context, 'with-snippet')).snippet, 'Visible snippet');

    const threads = await listThreads(context);
    assert.equal(threads.threads.length, 2);
    assert.equal(threads.threads[0].threadId, 'fallback-id');
    assert.equal(threads.threads[0].snippet, 'latest snippet');
    assert.equal(threads.threads[1].hasAttachments, true);
    assert.deepEqual(await listThreads(context), { threads: [] });
    assert.deepEqual(await readThread(context, 'sparse'), { id: 'sparse', messages: [] });

    assert.deepEqual(await listChanges(context, { startHistoryId: 'start' }), { changes: [] });
    assert.deepEqual(await listChanges(context, { startHistoryId: 'start' }), {
      changes: [
        { messageId: 'added', type: 'label_added' },
        { messageId: 'removed', threadId: 'thread-r', labelIds: ['STARRED'], type: 'label_removed' },
      ],
    });

    assert.deepEqual(await modifyThread(context, { threadId: 'mutated' }), { id: 'mutated', messages: [] });
    assert.deepEqual(await moveThread(context, { threadId: 'mutated', destination: 'trash' }), { id: 'mutated', messages: [] });
    assert.deepEqual(await listDrafts(context), { drafts: [] });
    assert.deepEqual(await getDraft(context, { draftId: 'sparse' }), { id: '' });
    assert.deepEqual(await sendMessage(context, 'raw'), { id: '', threadId: undefined });
    assert.deepEqual(await sendDraft(context, { draftId: 'sparse' }), { id: '', threadId: undefined });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gmail callback renders a safe fallback when the backend rejects with an opaque value', async () => {
  const context = createContext({
    secretsStore: createSecretsStore({
      setToolSecret: async () => { throw 'opaque secret failure'; },
    }),
    openExternalUrl: async (url) => {
      const authorization = new URL(url);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      callback.searchParams.set('code', 'oauth-code');
      const response = await fetch(callback);
      assert.equal(response.status, 500);
      assert.match(await response.text(), /Forger/);
    },
  });

  await assert.rejects(
    () => runGmailOAuthFlow(context),
    (error) => error === 'opaque secret failure',
  );
});

test('Gmail self-managed refresh maps malformed and failed Google token responses', async () => {
  const previousFetch = globalThis.fetch;
  const context = createContext({
    isForgerAccountAuthenticated: () => false,
    secretsStore: createSecretsStore({
      getToolSecret: async (_toolId, secretName) => {
        if (secretName === GMAIL_REFRESH_TOKEN_SECRET) return 'refresh-token';
        if (secretName === GMAIL_SELF_OAUTH_CLIENT_ID_SECRET) return 'self-client';
        if (secretName === GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET) return 'self-secret';
        return undefined;
      },
    }),
  });

  try {
    globalThis.fetch = async () => new Response('{', { status: 500 });
    await assert.rejects(
      () => refreshGmailAccessToken(context),
      (error) => error instanceof GmailOAuthError
        && error.technicalCode === 'gmail_oauth_google_refresh_failed'
        && error.message === 'Google no devolvio access token.',
    );

    globalThis.fetch = async () => gmailJson({ error: 'invalid_grant', error_description: 'Refresh revoked' }, 200);
    await assert.rejects(
      () => refreshGmailAccessToken(context),
      (error) => error instanceof GmailOAuthError
        && error.technicalCode === 'gmail_oauth_google_refresh_failed'
        && error.message === 'Refresh revoked',
    );

    globalThis.fetch = async () => { throw new Error('Google offline'); };
    await assert.rejects(
      () => refreshGmailAccessToken(context),
      (error) => error instanceof GmailOAuthError
        && error.technicalCode === 'gmail_oauth_google_refresh_failed'
        && error.message === 'Google offline',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
