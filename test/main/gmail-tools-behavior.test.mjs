import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildRawEmail,
  parseSendInput,
  toBase64Url,
} = require('../../dist-electron/main/tools/gmail/mime.js');
const {
  GmailApiError,
  readAttachment,
  readMessage,
  readThread,
  searchMessages,
  sendMessage,
} = require('../../dist-electron/main/tools/gmail/client.js');
const {
  GmailOAuthError,
  refreshGmailAccessToken,
  runGmailOAuthFlow,
} = require('../../dist-electron/main/tools/gmail/oauth.js');
const { gmailToolModule } = require('../../dist-electron/main/tools/gmail/index.js');
const {
  GMAIL_REFRESH_TOKEN_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_ID_SECRET,
  GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET,
} = require('../../dist-electron/main/tools/gmail/types.js');

const decodeBase64Url = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
};

const createSecretsStore = (overrides = {}) => ({
  hasToolSecret: async () => false,
  getToolSecret: async () => undefined,
  setToolSecret: async () => ({ success: true }),
  deleteToolSecrets: async () => undefined,
  ...overrides,
});

const createGmailContext = (overrides = {}) => ({
  metadataRoot: '/tmp/forger-gmail-test',
  locale: 'es',
  secretsStore: createSecretsStore({
    getToolSecret: async (_toolId, secretName) => (
      secretName === GMAIL_REFRESH_TOKEN_SECRET ? 'refresh-token' : undefined
    ),
    hasToolSecret: async (_toolId, secretName) => secretName === GMAIL_REFRESH_TOKEN_SECRET,
  }),
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client-id',
  exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
  refreshGmailOAuthAccessToken: async () => ({ access_token: 'access-token' }),
  appendLog: async () => undefined,
  ...overrides,
});

test('Gmail send input rejects invalid recipients and external-looking relative attachments', () => {
  assert.equal(parseSendInput(null), null);
  assert.equal(parseSendInput({
    to: ['valid@example.com', 'bad-address'],
    subject: 'Subject',
    body: 'Body',
  }), null);
  assert.equal(parseSendInput({
    to: ['valid@example.com'],
    subject: '',
    body: 'Body',
    attachments: [{ filePath: '/tmp/report.csv' }, null, [], { filePath: 123 }],
  }), null);
  assert.equal(parseSendInput({
    to: ['valid@example.com'],
    subject: 'Subject',
  }), null);

  const parsed = parseSendInput({
    to: [' user@example.com '],
    cc: ['copy@example.com'],
    bcc: [' hidden@example.com '],
    subject: '  Reporte  ',
    body: 'Hola',
    attachments: [
      { filePath: 'relative.txt', filename: 'ignored.txt' },
      { filePath: '/tmp/report.csv', filename: 'report.csv', mimeType: ' text/csv ' },
    ],
  });
  assert.deepEqual(parsed, {
    to: ['user@example.com'],
    cc: ['copy@example.com'],
    bcc: ['hidden@example.com'],
    subject: 'Reporte',
    body: 'Hola',
    attachments: [{ filePath: '/tmp/report.csv', filename: 'report.csv', mimeType: 'text/csv' }],
  });

  const htmlParsed = parseSendInput({
    to: ['user@example.com'],
    subject: 'HTML',
    bodyHtml: '<h1>Hola</h1><p>Mensaje <strong>importante</strong></p>',
  });
  assert.equal(htmlParsed.body, 'Hola\nMensaje importante');
  assert.equal(htmlParsed.bodyHtml, '<h1>Hola</h1><p>Mensaje <strong>importante</strong></p>');
});

test('Gmail MIME builder creates base64url text and multipart attachment payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-gmail-mime-'));
  const attachmentPath = join(root, 'movements.csv');
  const emptyAttachmentPath = join(root, 'empty.txt');
  const unknownAttachmentPath = join(root, 'archive.unknownext');
  await writeFile(attachmentPath, 'date,amount\n2026-05-21,10\n', 'utf8');
  await writeFile(emptyAttachmentPath, '', 'utf8');
  await writeFile(unknownAttachmentPath, 'opaque', 'utf8');
  const originalDateNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 1_800_000_000_000;
  Math.random = () => 0.123456789;

  try {
    const textRaw = await buildRawEmail({
      to: ['user@example.com'],
      subject: 'Hola',
      body: 'Texto simple',
    });
    const textEmail = decodeBase64Url(textRaw);
    assert.match(textEmail, /Content-Type: text\/plain/);
    assert.match(textEmail, /Texto simple/);

    const textWithCopies = decodeBase64Url(await buildRawEmail({
      to: ['user@example.com'],
      cc: ['copy@example.com'],
      bcc: ['audit@example.com'],
      subject: 'Copias',
      body: 'Texto con copias',
      attachments: [],
    }));
    assert.match(textWithCopies, /^Cc: copy@example.com$/m);
    assert.match(textWithCopies, /^Bcc: audit@example.com$/m);

    const htmlRaw = await buildRawEmail({
      to: ['user@example.com'],
      subject: 'HTML',
      body: 'Hola texto',
      bodyHtml: '<p>Hola <strong>HTML</strong></p>',
    });
    const htmlEmail = decodeBase64Url(htmlRaw);
    assert.match(htmlEmail, /Content-Type: multipart\/alternative; boundary="forger-alt-/);
    assert.match(htmlEmail, /Content-Type: text\/plain; charset="UTF-8"/);
    assert.match(htmlEmail, /Content-Type: text\/html; charset="UTF-8"/);
    assert.match(htmlEmail, /Hola texto/);
    assert.match(htmlEmail, /<p>Hola <strong>HTML<\/strong><\/p>/);

    const multipartRaw = await buildRawEmail({
      to: ['user@example.com'],
      cc: ['copy@example.com'],
      bcc: ['audit@example.com'],
      subject: 'Movimientos ñ',
      body: 'Adjunto',
      attachments: [{ filePath: attachmentPath, filename: 'movimientos.unknownext', mimeType: 'text/csv' }],
    });
    const multipart = decodeBase64Url(multipartRaw);
    assert.match(multipart, /Content-Type: multipart\/mixed; boundary="forger-/);
    assert.match(multipart, /Subject: =\?UTF-8\?B\?/);
    assert.match(multipart, /Cc: copy@example.com/);
    assert.match(multipart, /Content-Type: text\/csv; name="movimientos.unknownext"/);
    assert.match(multipart, /Content-Disposition: attachment; filename="movimientos.unknownext"/);
    assert.match(multipart, /ZGF0ZSxhbW91bnQK/);
    assert.equal(toBase64Url('a+b/c=').includes('+'), false);

    const htmlMultipartRaw = await buildRawEmail({
      to: ['user@example.com'],
      subject: 'HTML adjunto',
      body: 'Fallback',
      bodyHtml: '<p>Con <em>adjunto</em></p>',
      attachments: [{ filePath: attachmentPath, filename: 'movimientos.csv', mimeType: 'text/csv' }],
    });
    const htmlMultipart = decodeBase64Url(htmlMultipartRaw);
    assert.match(htmlMultipart, /Content-Type: multipart\/mixed; boundary="forger-/);
    assert.match(htmlMultipart, /Content-Type: multipart\/alternative; boundary="forger-alt-/);
    assert.match(htmlMultipart, /Content-Type: text\/html; charset="UTF-8"/);
    assert.match(htmlMultipart, /<p>Con <em>adjunto<\/em><\/p>/);
    assert.match(htmlMultipart, /Content-Disposition: attachment; filename="movimientos.csv"/);

    const inferredRaw = await buildRawEmail({
      to: ['user@example.com'],
      subject: 'Archive',
      body: 'Adjunto sin tipo declarado',
      attachments: [{ filePath: unknownAttachmentPath }],
    });
    const inferred = decodeBase64Url(inferredRaw);
    assert.match(inferred, /Content-Type: application\/octet-stream; name="archive.unknownext"/);
    assert.doesNotMatch(inferred, /^Cc:/m);
    assert.doesNotMatch(inferred, /^Bcc:/m);

    const emptyRaw = await buildRawEmail({
      to: ['user@example.com'],
      subject: 'Empty',
      body: 'Adjunto vacio',
      attachments: [{ filePath: emptyAttachmentPath }],
    });
    const empty = decodeBase64Url(emptyRaw);
    assert.match(empty, /Content-Disposition: attachment; filename="empty.txt"/);
  } finally {
    Date.now = originalDateNow;
    Math.random = originalRandom;
    await rm(root, { recursive: true, force: true });
  }
});

test('Gmail OAuth refresh requires Forger auth, stored refresh token, and access token response', async () => {
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({ isForgerAccountAuthenticated: () => false })),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'forger_account_required',
  );
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      secretsStore: createSecretsStore({ getToolSecret: async () => undefined }),
    })),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_oauth_not_connected',
  );
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      getGmailOAuthClientId: async () => '   ',
    })),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_oauth_client_missing',
  );
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      refreshGmailOAuthAccessToken: async () => {
        throw Object.assign(new Error('Backend refresh failed'), { technicalCode: 'gmail_refresh_backend_down' });
      },
    })),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_refresh_backend_down',
  );
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      refreshGmailOAuthAccessToken: async () => ({}),
    })),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_oauth_access_token_missing',
  );
  assert.equal(await refreshGmailAccessToken(createGmailContext()), 'access-token');
});

test('Gmail OAuth refresh can use self OAuth credentials without Forger auth', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: 'self-access-token' }), { status: 200 });
  };

  try {
    const token = await refreshGmailAccessToken(createGmailContext({
      isForgerAccountAuthenticated: () => false,
      secretsStore: createSecretsStore({
        getToolSecret: async (_toolId, secretName) => {
          if (secretName === GMAIL_REFRESH_TOKEN_SECRET) return 'refresh-token';
          if (secretName === GMAIL_SELF_OAUTH_CLIENT_ID_SECRET) return 'self-client-id';
          if (secretName === GMAIL_SELF_OAUTH_CLIENT_SECRET_SECRET) return 'self-client-secret';
          return undefined;
        },
      }),
    }));

    assert.equal(token, 'self-access-token');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    const body = calls[0].init.body;
    assert.equal(body.get('client_id'), 'self-client-id');
    assert.equal(body.get('client_secret'), 'self-client-secret');
    assert.equal(body.get('refresh_token'), 'refresh-token');
    assert.equal(body.get('grant_type'), 'refresh_token');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gmail API client clamps search limits and handles sparse Gmail payloads', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('q') === 'empty') {
      return new Response(JSON.stringify({ messages: null }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/threads/thread-empty')) {
      return new Response(JSON.stringify({ messages: null }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/missing-data/attachments/att-1')) {
      return new Response(JSON.stringify({ size: 10 }), { status: 200 });
    }
    return new Response('not json', { status: 500 });
  };

  try {
    const context = createGmailContext();
    assert.deepEqual(await searchMessages(context, 'empty', 0), []);
    assert.equal(new URL(calls[0].url).searchParams.get('maxResults'), '1');
    assert.deepEqual(await readThread(context, 'thread-empty'), { id: 'thread-empty', messages: [] });
    await assert.rejects(
      () => readAttachment(context, 'missing-data', 'att-1'),
      (error) => error instanceof GmailApiError && error.technicalCode === 'gmail_attachment_data_missing',
    );
    await assert.rejects(
      () => readMessage(context, 'server-error'),
      (error) => error instanceof GmailApiError
        && error.technicalCode === 'gmail_api_request_failed'
        && error.message === 'gmail_http_500',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gmail API client decodes messages, attachments, sends raw payloads, and maps HTTP errors', async () => {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('q') === 'from:bank') {
      return new Response(JSON.stringify({ messages: [{ id: 'm-1', threadId: 't-1' }] }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-1') && parsed.searchParams.get('format') === 'metadata') {
      return new Response(JSON.stringify({ id: 'm-1', threadId: 't-1', snippet: 'snippet' }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-2')) {
      return new Response(JSON.stringify({
        id: 'm-2',
        threadId: 't-2',
        payload: {
          headers: [{ name: 'Subject', value: 'Hello' }],
          parts: [
            { mimeType: 'text/plain', body: { data: toBase64Url('Body text') } },
            { filename: 'invoice.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att-1', size: 7 } },
          ],
        },
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-2/attachments/att-1')) {
      return new Response(JSON.stringify({ data: toBase64Url('PDFDATA') }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/send')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer access-token');
      assert.equal(JSON.parse(init.body).raw, 'raw-message');
      return new Response(JSON.stringify({ id: 'sent-1', threadId: 'thread-sent' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 });
  };

  try {
    const context = createGmailContext();
    assert.deepEqual(await searchMessages(context, 'from:bank', 100), [{
      id: 'm-1',
      threadId: 't-1',
      snippet: 'snippet',
    }]);
    const message = await readMessage(context, 'm-2');
    assert.equal(message.headers.subject, 'Hello');
    assert.equal(message.textBody, 'Body text');
    assert.deepEqual(message.attachments, [{
      attachmentId: 'att-1',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      size: 7,
    }]);
    assert.equal((await readAttachment(context, 'm-2', 'att-1')).toString('utf8'), 'PDFDATA');
    assert.deepEqual(await sendMessage(context, 'raw-message'), { id: 'sent-1', threadId: 'thread-sent' });
    await assert.rejects(
      () => readMessage(context, 'missing'),
      (error) => error instanceof GmailApiError && error.technicalCode === 'gmail_api_permission_denied',
    );
    assert.equal(calls.every((call) => call.init.headers.Authorization === 'Bearer access-token'), true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gmail API client normalizes malformed Gmail payload branches', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('q') === 'sparse') {
      return new Response(JSON.stringify({
        messages: [
          { id: null, threadId: 'thread-missing-id' },
          { id: 'missing-thread', threadId: null },
          { id: 'm-sparse', threadId: 't-sparse' },
        ],
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-sparse') && parsed.searchParams.get('format') === 'metadata') {
      return new Response(JSON.stringify({ snippet: 42 }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-sparse') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: null,
        threadId: undefined,
        snippet: 42,
        payload: {
          headers: [
            null,
            { name: 42, value: 'bad-name' },
            { name: 'From', value: 99 },
            { name: 'Subject', value: 'Sparse message' },
          ],
          parts: [
            { filename: ' sparse.txt ', mimeType: 99, body: { attachmentId: 'att-sparse', size: 'big' } },
            { body: { data: toBase64Url('fallback body') } },
          ],
        },
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/threads/t-sparse') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({ id: 123, messages: [await (await globalThis.fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/m-sparse?format=full')).json()] }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/send')) {
      assert.equal(init.headers['Content-Type'], 'application/json');
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected request' } }), { status: 500 });
  };

  try {
    const context = createGmailContext();
    assert.deepEqual(await searchMessages(context, 'sparse', 3), [{
      id: 'm-sparse',
      threadId: 't-sparse',
      snippet: undefined,
    }]);
    const message = await readMessage(context, 'm-sparse');
    assert.equal(message.id, '');
    assert.equal(message.threadId, '');
    assert.equal(message.snippet, undefined);
    assert.deepEqual(message.headers, { subject: 'Sparse message' });
    assert.equal(message.textBody, 'fallback body');
    assert.deepEqual(message.attachments, [{
      attachmentId: 'att-sparse',
      filename: 'sparse.txt',
      mimeType: undefined,
      size: undefined,
    }]);
    assert.deepEqual(await readThread(context, 't-sparse'), { id: '123', messages: [message] });
    assert.deepEqual(await sendMessage(context, 'raw-message'), { id: '', threadId: undefined });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gmail official tool reports connection status and sanitizes invalid action input', async () => {
  const disconnected = await gmailToolModule.execute({
    toolId: 'gmail',
    actionId: 'gmail.connection.status',
  }, createGmailContext({
    secretsStore: createSecretsStore({ hasToolSecret: async () => false }),
  }));
  assert.deepEqual(disconnected, { success: true, data: { connected: false } });

  const invalidSend = await gmailToolModule.execute({
    toolId: 'gmail',
    actionId: 'gmail.send_email',
    input: { to: ['not-an-email'], subject: 'Hi', body: 'Body' },
  }, createGmailContext());
  assert.equal(invalidSend.success, false);
  assert.equal(invalidSend.technicalCode, 'gmail_send_input_invalid');
});

test('Gmail official tool normalizes invalid read/search inputs and generic send failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-gmail-invalid-attachment-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const invalidSearch = await gmailToolModule.execute({
    toolId: 'gmail',
    actionId: 'gmail.search_messages',
    input: [],
  }, createGmailContext());
  assert.equal(invalidSearch.technicalCode, 'gmail_search_input_invalid');

  const invalidRead = await gmailToolModule.execute({
    toolId: 'gmail',
    actionId: 'gmail.read_thread',
    input: [],
  }, createGmailContext());
  assert.equal(invalidRead.technicalCode, 'gmail_read_input_invalid');

  const invalidAttachmentRead = await gmailToolModule.execute({
    toolId: 'gmail',
    actionId: 'gmail.read_attachment',
    input: [],
  }, createGmailContext());
  assert.equal(invalidAttachmentRead.technicalCode, 'gmail_read_attachment_input_invalid');

  const blankInputs = await Promise.all([
    gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: '   ', maxResults: Number.NaN },
    }, createGmailContext()),
    gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_thread',
      input: { threadId: ' ', messageId: ' ' },
    }, createGmailContext()),
    gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_attachment',
      input: { messageId: 'm-1' },
    }, createGmailContext()),
  ]);
  assert.deepEqual(blankInputs.map((result) => result.success), [false, false, false]);

  const invalidAttachmentSend = await gmailToolModule.execute({
    toolId: 'gmail',
    actionId: 'gmail.send_email',
    input: {
      to: ['user@example.com'],
      subject: 'Subject',
      body: 'Body',
      attachments: [{ filePath: root, filename: 'directory.txt' }],
    },
  }, createGmailContext());
  assert.equal(invalidAttachmentSend.success, false);
  assert.equal(invalidAttachmentSend.technicalCode, 'gmail_send_attachment_invalid');
  assert.equal(invalidAttachmentSend.userMessage, 'No pudimos completar la accion de Gmail.');
});

test('Gmail official tool executes search, read, attachment, and send actions through the Gmail client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-gmail-actions-'));
  const attachmentPath = join(root, 'source.txt');
  await writeFile(attachmentPath, 'attached from disk', 'utf8');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages') && parsed.searchParams.get('q') === 'from:bank') {
      return new Response(JSON.stringify({ messages: [{ id: 'm-1', threadId: 't-1' }] }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-1') && parsed.searchParams.get('format') === 'metadata') {
      return new Response(JSON.stringify({ id: 'm-1', threadId: 't-1', snippet: 'result' }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/threads/t-1') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: 't-1',
        messages: [{
          id: 'm-thread-1',
          threadId: 't-1',
          payload: {
            headers: [{ name: 'Subject', value: 'Thread' }],
            body: { data: toBase64Url('Thread body') },
          },
        }],
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-2') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: 'm-2',
        threadId: 't-2',
        payload: {
          headers: [{ name: 'Subject', value: 'Attachment' }],
          parts: [
            { filename: 'bank/report.csv', mimeType: 'text/csv', body: { attachmentId: 'att-1', size: 11 } },
          ],
        },
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/message-only') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: 'message-only',
        threadId: 'thread-message-only',
        payload: {
          headers: [{ name: 'Subject', value: 'Message only' }],
          body: { data: toBase64Url('Single message body') },
        },
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-2/attachments/att-1')) {
      return new Response(JSON.stringify({ data: toBase64Url('csv-content') }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/send')) {
      const rawEmail = decodeBase64Url(JSON.parse(init.body).raw);
      assert.match(rawEmail, /To: user@example.com/);
      assert.match(rawEmail, /Content-Type: text\/plain/);
      return new Response(JSON.stringify({ id: 'sent-2', threadId: 'sent-thread' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected request' } }), { status: 500 });
  };

  try {
    const context = createGmailContext({ metadataRoot: root });
    const search = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: ' from:bank ', maxResults: 500 },
    }, context);
    assert.equal(search.success, true);
    assert.deepEqual(search.data.messages, [{ id: 'm-1', threadId: 't-1', snippet: 'result' }]);

    const read = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_thread',
      input: { threadId: 't-1' },
    }, context);
    assert.equal(read.success, true);
    assert.equal(read.data.messages[0].textBody, 'Thread body');

    const messageOnly = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_thread',
      input: { messageId: 'message-only' },
    }, context);
    assert.equal(messageOnly.success, true);
    assert.equal(messageOnly.data.textBody, 'Single message body');

    const attachment = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_attachment',
      input: { messageId: 'm-2', filename: 'bank/report.csv' },
    }, context);
    assert.equal(attachment.success, true);
    assert.equal(attachment.data.filename, 'bank/report.csv');
    assert.equal(attachment.data.dataBase64, Buffer.from('csv-content').toString('base64'));
    assert.match(attachment.data.filePath, /report\.csv$/);

    const sent = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.send_email',
      input: {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Message',
        bodyHtml: '<p><strong>Message</strong></p>',
        attachments: [{ filePath: attachmentPath }],
      },
    }, context);
    assert.equal(sent.success, true);
    assert.deepEqual(sent.data, { id: 'sent-2', threadId: 'sent-thread' });
    assert.equal(calls.every((call) => call.init.headers.Authorization === 'Bearer access-token'), true);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('Gmail official tool handles configured status, missing attachments, and unknown actions', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages/missing-attachment') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: 'missing-attachment',
        threadId: 'thread',
        payload: {
          headers: [],
          parts: [{ filename: 'other.csv', body: { attachmentId: 'att-2', size: 4 } }],
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected request' } }), { status: 500 });
  };

  try {
    const status = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.connection.status',
    }, createGmailContext());
    assert.deepEqual(status, { success: true, data: { connected: true } });

    const missingAttachment = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_attachment',
      input: { messageId: 'missing-attachment', filename: 'report.csv' },
    }, createGmailContext());
    assert.equal(missingAttachment.success, false);
    assert.equal(missingAttachment.technicalCode, 'gmail_attachment_not_found');

    const unknown = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.archive_message',
    }, createGmailContext());
    assert.equal(unknown.success, false);
    assert.equal(unknown.technicalCode, 'gmail_action_unknown');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('Gmail OAuth configure and refresh failures keep safe user-facing messages', async () => {
  const configure = await gmailToolModule.configure(createGmailContext({
    isForgerAccountAuthenticated: () => false,
  }));
  assert.equal(configure.success, false);
  assert.equal(configure.technicalCode, 'forger_account_required');

  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      getGmailOAuthClientId: async () => '   ',
    })),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_oauth_client_missing',
  );
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      refreshGmailOAuthAccessToken: async () => {
        throw Object.assign(new Error('Refresh token expired'), { technicalCode: 'invalid_grant' });
      },
    })),
    (error) => error instanceof GmailOAuthError
      && error.technicalCode === 'invalid_grant'
      && error.message === 'Refresh token expired',
  );
  await assert.rejects(
    () => refreshGmailAccessToken(createGmailContext({
      refreshGmailOAuthAccessToken: async () => {
        throw new Error('');
      },
    })),
    (error) => error instanceof GmailOAuthError
      && error.technicalCode === 'gmail_oauth_backend_refresh_failed'
      && error.message === 'Forger Cloud no pudo renovar Gmail.',
  );
  const openFailed = await gmailToolModule.configure(createGmailContext({
    openExternalUrl: async () => {
      throw 'browser failed';
    },
  }));
  assert.equal(openFailed.success, false);
  assert.equal(openFailed.technicalCode, 'gmail_oauth_failed');
});

test('Gmail OAuth flow uses a local callback and stores the refresh token without real OAuth', async () => {
  const savedSecrets = [];
  const logs = [];
  let exchangedInput;
  const context = createGmailContext({
    getGmailOAuthClientId: async () => '  gmail-client-id  ',
    secretsStore: createSecretsStore({
      setToolSecret: async (toolId, secretName, value) => {
        savedSecrets.push({ toolId, secretName, value });
        return { success: true };
      },
    }),
    exchangeGmailOAuthCode: async (input) => {
      exchangedInput = input;
      return { refresh_token: 'stored-refresh-token' };
    },
    openExternalUrl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get('client_id'), 'gmail-client-id');
      assert.equal(parsed.searchParams.get('access_type'), 'offline');
      assert.equal(parsed.searchParams.get('prompt'), 'consent');
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('state', state);
      callbackUrl.searchParams.set('code', 'oauth-code');
      const response = await fetch(callbackUrl);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Forger/);
    },
    appendLog: async (event, payload) => {
      logs.push({ event, payload });
    },
  });

  await runGmailOAuthFlow(context);

  assert.equal(exchangedInput.clientId, 'gmail-client-id');
  assert.equal(exchangedInput.code, 'oauth-code');
  assert.match(exchangedInput.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/gmail\/callback$/);
  assert.equal(savedSecrets.length, 1);
  assert.equal(savedSecrets[0].toolId, 'gmail');
  assert.equal(savedSecrets[0].secretName, 'oauth_refresh_token');
  assert.equal(savedSecrets[0].value, 'stored-refresh-token');
  assert.equal(logs.some((entry) => entry.event === 'gmail_oauth:completed'), true);
});

test('Gmail OAuth callback rejects bad state, Google errors, missing code, exchange timeout, and secret save failures', async () => {
  const runRejectedCallback = async (mutateCallbackUrl, overrides = {}) => {
    const logs = [];
    const context = createGmailContext({
      getGmailOAuthClientId: async () => 'gmail-client-id',
      openExternalUrl: async (url) => {
        const parsed = new URL(url);
        const callbackUrl = new URL(parsed.searchParams.get('redirect_uri'));
        callbackUrl.searchParams.set('state', parsed.searchParams.get('state'));
        mutateCallbackUrl(callbackUrl, parsed);
        const response = await fetch(callbackUrl);
        assert.notEqual(response.status, 200);
        assert.match(await response.text(), /Forger/);
      },
      appendLog: async (event, payload) => logs.push({ event, payload }),
      ...overrides,
    });
    await assert.rejects(
      () => runGmailOAuthFlow(context),
      (error) => error instanceof GmailOAuthError,
    );
    return logs;
  };

  const stateLogs = await runRejectedCallback((callbackUrl) => {
    callbackUrl.searchParams.set('state', 'wrong-state');
    callbackUrl.searchParams.set('code', 'oauth-code');
  });
  assert.equal(stateLogs.some((entry) => entry.event === 'gmail_oauth:state_mismatch'), true);

  const deniedLogs = await runRejectedCallback((callbackUrl) => {
    callbackUrl.searchParams.set('error', 'access_denied');
  });
  assert.equal(deniedLogs.some((entry) => entry.event === 'gmail_oauth:google_error'), true);

  await runRejectedCallback((callbackUrl) => {
    callbackUrl.searchParams.set('error', 'server_error');
  });

  const codeLogs = await runRejectedCallback(() => undefined);
  assert.equal(codeLogs.some((entry) => entry.event === 'gmail_oauth:code_missing'), true);

  await runRejectedCallback((callbackUrl) => {
    callbackUrl.searchParams.set('code', 'oauth-code');
  }, {
    exchangeGmailOAuthCode: async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
  });

  const refreshMissingLogs = await runRejectedCallback((callbackUrl) => {
    callbackUrl.searchParams.set('code', 'oauth-code');
  }, {
    exchangeGmailOAuthCode: async () => ({}),
  });
  assert.equal(refreshMissingLogs.some((entry) => entry.event === 'gmail_oauth:refresh_token_missing'), true);

  const secretLogs = await runRejectedCallback((callbackUrl) => {
    callbackUrl.searchParams.set('code', 'oauth-code');
  }, {
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    secretsStore: createSecretsStore({
      setToolSecret: async () => ({
        success: false,
        userMessage: 'No pudimos guardar Gmail.',
        technicalCode: 'secret_vault_failed',
      }),
    }),
  });
  assert.equal(secretLogs.some((entry) => entry.event === 'gmail_oauth:secret_save_failed'), true);
});

test('Gmail OAuth callback handles non-callback pages, auth loss during exchange, and fallback secret errors', async () => {
  let authenticated = true;
  const savedSecrets = [];
  const logs = [];
  const context = createGmailContext({
    getGmailOAuthClientId: async () => 'gmail-client-id',
    isForgerAccountAuthenticated: () => authenticated,
    openExternalUrl: async (url) => {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri');
      const state = parsed.searchParams.get('state');
      const notFound = await fetch(new URL('/oauth/gmail/not-found', redirectUri));
      assert.equal(notFound.status, 404);
      assert.match(await notFound.text(), /Forger/);

      authenticated = false;
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set('state', state);
      callbackUrl.searchParams.set('code', 'oauth-code');
      const response = await fetch(callbackUrl);
      assert.equal(response.status, 500);
    },
    appendLog: async (event, payload) => logs.push({ event, payload }),
  });

  await assert.rejects(
    () => runGmailOAuthFlow(context),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'forger_account_required',
  );
  assert.equal(logs.some((entry) => entry.event === 'gmail_oauth:callback_received'), true);

  const fallbackSecretContext = createGmailContext({
    getGmailOAuthClientId: async () => 'gmail-client-id',
    openExternalUrl: async (url) => {
      const parsed = new URL(url);
      const callbackUrl = new URL(parsed.searchParams.get('redirect_uri'));
      callbackUrl.searchParams.set('state', parsed.searchParams.get('state'));
      callbackUrl.searchParams.set('code', 'oauth-code');
      const response = await fetch(callbackUrl);
      assert.equal(response.status, 500);
    },
    exchangeGmailOAuthCode: async () => ({ refresh_token: 'refresh-token' }),
    secretsStore: createSecretsStore({
      setToolSecret: async (...args) => {
        savedSecrets.push(args);
        return { success: false };
      },
    }),
  });
  await assert.rejects(
    () => runGmailOAuthFlow(fallbackSecretContext),
    (error) => error instanceof GmailOAuthError && error.technicalCode === 'gmail_oauth_secret_save_failed',
  );
  assert.equal(savedSecrets.length, 1);
});

test('Gmail official tool saves large attachments without inline payload and maps API errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-gmail-large-attachment-'));
  const previousFetch = globalThis.fetch;
  const largeBuffer = Buffer.alloc((2 * 1024 * 1024) + 1, 'a');
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages/m-large') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: 'm-large',
        threadId: 'thread',
        payload: {
          headers: [],
          parts: [{ filename: 'large.txt', mimeType: 'text/plain', body: { attachmentId: 'att-large', size: largeBuffer.byteLength } }],
        },
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-large/attachments/att-large')) {
      return new Response(JSON.stringify({ data: toBase64Url(largeBuffer.toString('utf8')) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'Denied' } }), { status: 403 });
  };

  try {
    const large = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_attachment',
      input: { messageId: 'm-large', attachmentId: 'att-large' },
    }, createGmailContext({ metadataRoot: root }));
    assert.equal(large.success, true);
    assert.equal(large.data.inlineBase64Available, false);
    assert.equal('dataBase64' in large.data, false);

    const apiError = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.search_messages',
      input: { query: 'from:denied' },
    }, createGmailContext({ metadataRoot: root }));
    assert.equal(apiError.success, false);
    assert.equal(apiError.technicalCode, 'gmail_api_permission_denied');
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('Gmail official tool rejects attachments above the local read limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-gmail-too-large-attachment-'));
  const previousFetch = globalThis.fetch;
  const tooLargeBuffer = Buffer.alloc((25 * 1024 * 1024) + 1, 'x');
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages/m-too-large') && parsed.searchParams.get('format') === 'full') {
      return new Response(JSON.stringify({
        id: 'm-too-large',
        threadId: 'thread',
        payload: {
          headers: [],
          parts: [{ filename: '../too-large.txt', mimeType: 'text/plain', body: { attachmentId: 'att-too-large', size: tooLargeBuffer.byteLength } }],
        },
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/messages/m-too-large/attachments/att-too-large')) {
      return new Response(JSON.stringify({ data: toBase64Url(tooLargeBuffer) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: 'unexpected request' } }), { status: 500 });
  };

  try {
    const result = await gmailToolModule.execute({
      toolId: 'gmail',
      actionId: 'gmail.read_attachment',
      input: { messageId: 'm-too-large', filename: '../too-large.txt' },
    }, createGmailContext({ metadataRoot: root }));
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'gmail_attachment_too_large');
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
