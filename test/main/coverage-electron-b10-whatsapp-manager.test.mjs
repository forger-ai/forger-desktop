import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fsPromises = require('node:fs/promises');
const {
  WhatsAppConnectionManager,
  createWhatsAppConnectionManager,
} = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const { encodeStableMessageRef } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');

class FakeStore {
  constructor(root) {
    this.root = root;
    this.chats = new Map();
    this.messages = [];
    this.attachments = new Map();
    this.canSend = true;
    this.upsertedMessages = [];
    this.upsertedChats = [];
    this.failedAttachments = [];
    this.updatedAttachment = undefined;
    this.clearCount = 0;
    this.rememberSendCount = 0;
  }

  async load() {}
  async storageStatus() { return { kind: 'fake' }; }
  authDirectory() { return join(this.root, 'auth'); }
  downloadsDirectory() { return join(this.root, 'downloads'); }
  async clear() { this.clearCount += 1; }
  async listChats(input) { return { chats: [...this.chats.values()], input }; }
  async readMessages(input) { this.lastRead = input; return this.messages; }
  async getChat(chatId) { return this.chats.get(chatId); }
  async canSendNow() { return this.canSend; }
  async upsertMessages(messages) { this.upsertedMessages.push(...messages); }
  async upsertChat(chat) { this.upsertedChats.push(chat); }
  async rememberSend() { this.rememberSendCount += 1; }
  encodeRef(ref) { return `encoded:${ref.id ?? ref.messageId}`; }
  async getAttachment(id) { return this.attachments.get(id); }
  async markAttachmentDownloaded(input) { this.lastDownloaded = input; return this.updatedAttachment; }
  async markAttachmentFailed(id, message) { this.failedAttachments.push([id, message]); }
}

const createContext = (root, logs = [], events = []) => ({
  metadataRoot: root,
  locale: 'en',
  appendLog: (...args) => logs.push(args),
  emitEvent: (event) => events.push(event),
});

const directChat = (chatId = '56912345678@s.whatsapp.net', phoneNumber) => ({
  chatId,
  chatType: 'direct',
  title: 'Friend',
  ...(phoneNumber ? { phoneNumber } : {}),
});

const sentRawMessage = (messageId = 'M1') => ({
  key: { remoteJid: '56912345678@s.whatsapp.net', id: messageId, fromMe: true },
  messageTimestamp: 1,
  message: { conversation: 'Sent message' },
});

test('Given observed chats, manager commands validate, send, read, describe, pair, and reset without leaking unsafe input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-manager-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FakeStore(root);
  const logs = [];
  const events = [];
  const context = createContext(root, logs, events);
  const manager = new WhatsAppConnectionManager(store, async () => ({}));

  assert.deepEqual(await manager.listChats({ query: 'friend' }), { chats: [], input: { query: 'friend' } });
  assert.equal((await manager.readMessages(context, { chatId: ' ' })).technicalCode, 'whatsapp_chat_id_required');
  store.messages = [{
    chatId: '56912345678@s.whatsapp.net',
    messageId: 'read-1',
    stableMessageRef: { chatId: '56912345678@s.whatsapp.net', messageId: 'read-1', fromMe: false },
    attachments: [{ attachmentId: 'a', kind: 'file', messageType: 'document', downloaded: false, downloadStatus: 'pending' }],
  }];
  assert.equal((await manager.readMessages(context, { chatId: '56912345678' })).messages[0].stableMessageRef, 'encoded:read-1');

  for (const input of [
    { chatId: '', text: 'hello' },
    { chatId: '56912345678', text: 2 },
    { chatId: '56912345678', text: ' ' },
    { chatId: '56912345678', text: 'x'.repeat(4_001) },
  ]) assert.equal((await manager.sendMessage(context, input)).technicalCode, 'whatsapp_send_input_invalid');
  assert.equal((await manager.sendMessage(context, { chatId: '56912345678', text: 'hello' })).technicalCode, 'whatsapp_chat_not_observed');
  const chatId = '56912345678@s.whatsapp.net';
  store.chats.set(chatId, directChat(chatId));
  store.canSend = false;
  assert.equal((await manager.sendMessage(context, { chatId, text: 'hello' })).technicalCode, 'whatsapp_send_rate_limited');
  store.canSend = true;
  manager.ensureStarted = async () => undefined;
  manager.socket = { sendMessage: async () => undefined };
  const sentWithoutPayload = await manager.sendMessage(context, { chatId, text: ' hello ' });
  assert.equal(sentWithoutPayload.sent, true);
  assert.ok(Number.isInteger(sentWithoutPayload.timestamp));
  assert.ok(Math.abs(sentWithoutPayload.timestamp - Math.floor(Date.now() / 1000)) <= 1);
  let quotedOptions;
  manager.socket = { sendMessage: async (_chatId, _content, options) => { quotedOptions = options; return sentRawMessage('M2'); } };
  const sent = await manager.sendMessage(context, {
    chatId,
    text: 'hello',
    replyToMessageRef: encodeStableMessageRef({ remoteJid: chatId, id: 'quoted', fromMe: false }),
  });
  assert.deepEqual(quotedOptions, { quoted: { key: { remoteJid: chatId, id: 'quoted', fromMe: false } } });
  assert.equal(sent.stableMessageRef, 'encoded:M2');
  assert.equal(store.upsertedMessages.at(-1).stableMessageRef.id, 'M2');
  assert.equal(store.rememberSendCount, 2);
  manager.socket = {};
  assert.equal((await manager.sendMessage(context, { chatId, text: 'without method' })).sent, true);
  manager.socket = null;
  assert.equal((await manager.sendMessage(context, { chatId, text: 'without socket' })).sent, true);

  assert.equal((await manager.getChatDetails(context, { chatId: '' })).technicalCode, 'whatsapp_chat_not_observed');
  assert.equal((await manager.getChatDetails(context, { chatId: '56999999999' })).technicalCode, 'whatsapp_chat_not_observed');
  assert.equal((await manager.getChatDetails(context, { chatId })).phoneNumber, '56912345678');
  store.chats.set(chatId, directChat(chatId, 'stored-number'));
  assert.equal((await manager.getChatDetails(context, { chatId })).phoneNumber, 'stored-number');
  const groupId = '120363123456789@g.us';
  store.chats.set(groupId, { chatId: groupId, chatType: 'group' });
  manager.socket = { groupMetadata: async () => null };
  assert.equal((await manager.getChatDetails(context, { chatId: groupId })).metadata, null);
  manager.socket = { groupMetadata: async () => ({ participants: [{ id: 'one', admin: 'admin' }, 'raw'] }) };
  assert.deepEqual((await manager.getChatDetails(context, { chatId: groupId })).metadata.participants, [{ id: 'one', admin: 'admin' }, 'raw']);
  manager.socket = { groupMetadata: async () => ({}) };
  assert.deepEqual((await manager.getChatDetails(context, { chatId: groupId })).metadata.participants, []);
  manager.socket = {};
  assert.equal((await manager.getChatDetails(context, { chatId: groupId })).metadata, null);
  const channelId = '120363123456789@newsletter';
  store.chats.set(channelId, { chatId: channelId, chatType: 'channel' });
  manager.socket = { newsletterMetadata: async () => ({ name: 'Channel' }) };
  assert.deepEqual((await manager.getChatDetails(context, { chatId: channelId })).metadata, { name: 'Channel' });
  manager.socket = { newsletterMetadata: async () => { throw new Error('private'); } };
  assert.equal((await manager.getChatDetails(context, { chatId: channelId })).metadata, null);

  manager.ensureStarted = async () => { manager.socket ??= {}; };
  assert.equal((await manager.startPairing(context, { method: 'pairing_code' })).technicalCode, 'whatsapp_pairing_phone_invalid');
  assert.equal((await manager.startPairing(context, { method: 'pairing_code', phoneNumber: 2 })).technicalCode, 'whatsapp_pairing_phone_invalid');
  assert.equal((await manager.startPairing(context, { method: 'pairing_code', phoneNumber: '123' })).technicalCode, 'whatsapp_pairing_phone_invalid');
  manager.socket = {};
  assert.equal((await manager.startPairing(context, { method: 'pairing_code', phoneNumber: '+56 9 1234 5678' })).technicalCode, 'whatsapp_pairing_code_unavailable');
  manager.connected = true;
  manager.socket = { requestPairingCode: async (phone) => `code:${phone}` };
  assert.equal((await manager.startPairing(context, { method: 'pairing_code', phoneNumber: '+56 9 1234 5678' })).pairingCode, 'code:56912345678');
  manager.waitForQr = async () => null;
  manager.connected = true;
  assert.deepEqual(await manager.startPairing(context, { method: 'qr' }), { status: 'already_connected' });
  manager.connected = false;
  manager.socket = null;
  manager.lastDisconnectReason = 'pairing_closed';
  assert.equal((await manager.startPairing(context, { method: 'qr' })).technicalCode, 'pairing_closed');
  manager.lastDisconnectReason = undefined;
  assert.equal((await manager.startPairing(context, { method: 'qr' })).technicalCode, 'whatsapp_qr_unavailable');
  manager.waitForQr = async () => 'qr-value';
  assert.equal((await manager.startPairing(context, { method: 'qr' })).status, 'qr_ready');

  manager.socket = { end: (error) => logs.push(['ended', error.message]) };
  await manager.stopListening();
  await manager.stopListening();
  manager.socket = { end: (error) => logs.push(['ended', error.message]) };
  await manager.disconnect(context);
  await manager.resetLocalSession();
  assert.ok(store.clearCount >= 2);
  assert.ok(events.some((event) => event.phase === 'reset'));
});

test('Given attachment records, downloads reuse safe files, use the injected Baileys loader, hash bytes, and persist failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-attachments-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FakeStore(root);
  const context = createContext(root);
  let downloadedValue = Buffer.from('downloaded');
  let downloadFailure;
  let reupload;
  const loader = async () => ({
    downloadMediaMessage: async (_message, type, options, transport) => {
      assert.equal(type, 'buffer');
      assert.deepEqual(options, {});
      reupload = transport.reuploadRequest;
      if (downloadFailure !== undefined) throw downloadFailure;
      return downloadedValue;
    },
  });
  const manager = new WhatsAppConnectionManager(store, loader);
  manager.ensureStarted = async () => undefined;

  assert.equal((await manager.downloadAttachment(context, { attachmentId: 3 })).technicalCode, 'whatsapp_attachment_id_required');
  assert.equal((await manager.downloadAttachment(context, { attachmentId: ' ' })).technicalCode, 'whatsapp_attachment_id_required');
  assert.equal((await manager.downloadAttachment(context, { attachmentId: 'missing' })).technicalCode, 'whatsapp_attachment_not_observed');
  const existingPath = join(root, 'existing.bin');
  await writeFile(existingPath, 'existing', 'utf8');
  store.attachments.set('existing', {
    attachmentId: 'existing', localPath: existingPath, fileName: 'name.bin', mimeType: 'application/octet-stream', sizeBytes: 8,
    sha256: 'old-sha', downloadedAt: '2026-08-10T00:00:00Z',
  });
  assert.deepEqual(await manager.downloadAttachment(context, { attachmentId: 'existing' }), {
    attachmentId: 'existing', filePath: existingPath, fileName: 'name.bin', mimeType: 'application/octet-stream', sizeBytes: 8,
    sha256: 'old-sha', downloadedAt: '2026-08-10T00:00:00Z',
  });
  const minimalPath = join(root, 'minimal.bin');
  await writeFile(minimalPath, 'minimal', 'utf8');
  store.attachments.set('minimal-existing', { attachmentId: 'minimal-existing', localPath: minimalPath });
  assert.deepEqual(await manager.downloadAttachment(context, { attachmentId: 'minimal-existing' }), {
    attachmentId: 'minimal-existing', filePath: minimalPath,
  });
  store.attachments.set('directory', { attachmentId: 'directory', localPath: root });
  assert.equal((await manager.downloadAttachment(context, { attachmentId: 'directory' })).technicalCode, 'whatsapp_attachment_raw_message_missing');
  store.attachments.set('raw-missing', { attachmentId: 'raw-missing' });
  assert.equal((await manager.downloadAttachment(context, { attachmentId: 'raw-missing' })).technicalCode, 'whatsapp_attachment_raw_message_missing');

  const withoutDownloader = new WhatsAppConnectionManager(store, async () => ({}));
  withoutDownloader.ensureStarted = async () => undefined;
  store.attachments.set('no-loader', { attachmentId: 'no-loader', rawMessageJson: '{}' });
  assert.equal((await withoutDownloader.downloadAttachment(context, { attachmentId: 'no-loader' })).technicalCode, 'whatsapp_attachment_download_unavailable');

  store.attachments.set('download', { attachmentId: 'download', rawMessageJson: '{}', fileName: '../../ unsafe file?.png', mimeType: 'image/png' });
  manager.socket = { updateMediaMessage: async (message) => ({ message }) };
  store.updatedAttachment = { fileName: 'safe.png', mimeType: 'image/png', downloadedAt: 'now' };
  const downloaded = await manager.downloadAttachment(context, { attachmentId: 'download' });
  assert.equal(downloaded.sizeBytes, Buffer.byteLength('downloaded'));
  assert.equal(downloaded.fileName, 'safe.png');
  assert.equal(basename(downloaded.filePath), 'download-..-..-unsafe-file-.png');
  assert.deepEqual(await reupload({ id: 1 }), { message: { id: 1 } });
  assert.equal((await readFile(downloaded.filePath, 'utf8')), 'downloaded');

  downloadedValue = Uint8Array.from([1, 2, 3]);
  manager.socket = {};
  store.updatedAttachment = undefined;
  store.attachments.set('no-name', { attachmentId: 'no-name', rawMessageJson: '{}' });
  const withoutName = await manager.downloadAttachment(context, { attachmentId: 'no-name' });
  assert.equal(withoutName.fileName, undefined);
  assert.equal(reupload, undefined);

  store.attachments.set('bad-json', { attachmentId: 'bad-json', rawMessageJson: '{bad' });
  assert.equal((await manager.downloadAttachment(context, { attachmentId: 'bad-json' })).technicalCode, 'whatsapp_attachment_download_failed');
  downloadFailure = new Error('media_failed');
  store.attachments.set('error', { attachmentId: 'error', rawMessageJson: '{}' });
  await manager.downloadAttachment(context, { attachmentId: 'error' });
  downloadFailure = 'offline';
  store.attachments.set('value-error', { attachmentId: 'value-error', rawMessageJson: '{}' });
  await manager.downloadAttachment(context, { attachmentId: 'value-error' });
  assert.deepEqual(store.failedAttachments.slice(-2), [['error', 'media_failed'], ['value-error', 'unknown_error']]);

  downloadFailure = undefined;
  const longAttachmentId = `../${'i'.repeat(220)}`;
  const adversarialNames = [
    { attachmentId: 'empty-name', fileName: '', expectedBaseName: 'empty-name-attachment.bin' },
    { attachmentId: 'blank-name', fileName: '   ', expectedBaseName: 'blank-name-attachment' },
    { attachmentId: 'dot-name', fileName: '.', expectedBaseName: 'dot-name-attachment' },
    { attachmentId: 'dotdot-name', fileName: '..', expectedBaseName: 'dotdot-name-attachment' },
    {
      attachmentId: 'separator-name',
      fileName: '../../unsafe\\name',
      expectedBaseName: 'separator-name-..-..-unsafe-name',
    },
    { attachmentId: 'long-name', fileName: 'x'.repeat(220), expectedBaseName: `long-name-${'x'.repeat(100)}` },
    {
      attachmentId: longAttachmentId,
      fileName: 'safe.bin',
      expectedBaseName: `..-${'i'.repeat(97)}-safe.bin`,
    },
  ];
  const downloadsRoot = store.downloadsDirectory();
  for (const fixture of adversarialNames) {
    store.attachments.set(fixture.attachmentId, {
      attachmentId: fixture.attachmentId,
      rawMessageJson: '{}',
      fileName: fixture.fileName,
    });
    const result = await manager.downloadAttachment(context, { attachmentId: fixture.attachmentId });
    const relativePath = relative(downloadsRoot, result.filePath);
    assert.equal(basename(result.filePath), fixture.expectedBaseName);
    assert.equal(isAbsolute(relativePath), false);
    assert.notEqual(relativePath, '..');
    assert.equal(relativePath.startsWith(`..${sep}`), false);
    assert.equal((await readFile(result.filePath)).byteLength, 3);
  }

  const originalChmod = fsPromises.chmod;
  fsPromises.chmod = async () => { throw new Error('chmod_denied'); };
  try {
    store.attachments.set('chmod-download', {
      attachmentId: 'chmod-download',
      rawMessageJson: '{}',
      fileName: 'file.bin',
    });
    const result = await manager.downloadAttachment(context, { attachmentId: 'chmod-download' });
    assert.equal(await readFile(result.filePath, 'utf8'), '\u0001\u0002\u0003');
  } finally {
    fsPromises.chmod = originalChmod;
  }
});

test('Given injected Baileys variants, startup negotiates safe fallbacks, logging redacts shapes, and event failures remain observable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-start-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const contextLogs = [];
  const events = [];
  const context = createContext(root, contextLogs, events);
  const missingStore = new FakeStore(join(root, 'missing'));
  await assert.rejects(new WhatsAppConnectionManager(missingStore, async () => ({})).start(context), /whatsapp_baileys_api_unavailable/);
  await assert.rejects(new WhatsAppConnectionManager(missingStore, async () => ({ useMultiFileAuthState: async () => ({}) })).start(context), /whatsapp_baileys_api_unavailable/);

  const starts = [];
  const buildLoader = ({ state = {}, versionMode = 'missing', browserMode = 'missing', socketFactory = 'default', saveCreds } = {}) => async () => {
    const handlers = new Map();
    const socket = { ev: { on: (event, handler) => handlers.set(event, handler) }, end: () => undefined };
    const module = {
      useMultiFileAuthState: async (directory) => {
        await mkdir(join(directory, 'nested'), { recursive: true });
        await writeFile(join(directory, 'creds.json'), '{}', 'utf8');
        await writeFile(join(directory, 'nested', 'key.json'), '{}', 'utf8');
        return { state, saveCreds: saveCreds ?? (async () => undefined) };
      },
    };
    if (versionMode !== 'missing') {
      module.fetchLatestBaileysVersion = async () => {
        if (versionMode === 'throw') throw new Error('version_failed');
        if (versionMode === 'throw-value') throw 'version_failed';
        if (versionMode === 'not-array') return { version: 'bad' };
        if (versionMode === 'wrong-length') return { version: [1, 2] };
        if (versionMode === 'non-integer') return { version: [1, 2, 3.5] };
        return { version: [1, 2, 3] };
      };
    }
    if (browserMode === 'valid') module.Browsers = { macOS: (name) => ['Desktop', name] };
    if (browserMode === 'invalid') module.Browsers = { macOS: 'not-a-function' };
    if (socketFactory === 'named') module.makeWASocket = (config) => { starts.push({ config, handlers, socket }); return socket; };
    else module.default = (config) => { starts.push({ config, handlers, socket }); return socket; };
    return module;
  };

  for (const options of [
    { state: null },
    { state: { registered: true }, versionMode: 'not-array', browserMode: 'invalid' },
    { state: { creds: { registered: false, me: {}, account: {} } }, versionMode: 'wrong-length' },
    { state: { creds: { registered: false, me: {}, account: {} } }, versionMode: 'non-integer' },
    { state: { creds: { registered: false, me: {}, account: {} } }, versionMode: 'throw' },
    { state: { creds: { registered: false, me: {}, account: {} } }, versionMode: 'throw-value' },
    { state: { creds: { registered: false, me: {}, account: {} } }, versionMode: 'valid', browserMode: 'valid', socketFactory: 'named' },
  ]) {
    const manager = new WhatsAppConnectionManager(new FakeStore(join(root, `case-${starts.length}`)), buildLoader(options));
    await manager.start(context);
  }
  const configured = starts.at(-1).config;
  assert.deepEqual(configured.version, [1, 2, 3]);
  assert.deepEqual(configured.browser, ['Desktop', 'Forger']);
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) configured.logger[level]();
  configured.logger.info(
    'first',
    'second',
    new Error('direct-error'),
    {
      class: 'socket', msg: 'connected', jid: 'jid', addr: 'addr', id: 'id', retryCount: 2, sender: 'sender', author: 'author', messageType: true,
      ignored: { secret: true }, trace: 'trace',
      node: { passive: true, connectType: 'wifi', connectReason: 'user', pull: false, ignored: 'x' },
      msgAttrs: { from: 'a', type: 'b', id: 'c', participant: 'd', offline: 'e', t: 'f', ignored: 'g' },
    },
    { error: new Error('nested-error') },
    { error: { type: 'Boom', message: 'broken', stack: 'stack' } },
    { err: {} },
    null,
  );
  configured.logger.debug({ node: {}, msgAttrs: {} });
  assert.equal(configured.logger.child(), configured.logger);
  assert.ok(contextLogs.some(([name, payload]) => name === 'official_tool:whatsapp_baileys_log' && payload.message === 'first second'));

  const eventStart = starts.at(-1);
  eventStart.handlers.get('creds.update')({ registered: true });
  eventStart.handlers.get('connection.update')({ connection: 'open' });
  eventStart.handlers.get('messages.upsert')({ messages: [] });
  eventStart.handlers.get('messages.upsert')(null);
  eventStart.handlers.get('messaging-history.set')(null);
  eventStart.handlers.get('chats.upsert')([]);
  eventStart.handlers.get('chats.upsert')(null);
  eventStart.handlers.get('chats.update')([]);
  eventStart.handlers.get('chats.update')(null);
  eventStart.handlers.get('contacts.upsert')([]);
  eventStart.handlers.get('contacts.upsert')(null);
  eventStart.handlers.get('contacts.update')([]);
  eventStart.handlers.get('contacts.update')(null);
  await new Promise((resolve) => setImmediate(resolve));

  const rejectingManager = new WhatsAppConnectionManager(new FakeStore(join(root, 'rejecting')), buildLoader({
    state: { registered: true },
    saveCreds: async () => { throw new Error('save_failed'); },
  }));
  await rejectingManager.start(context);
  const rejecting = starts.at(-1);
  rejectingManager.ingestMessages = async () => { throw new Error('messages_failed'); };
  rejectingManager.ingestHistoryPayload = async () => { throw new Error('history_failed'); };
  rejectingManager.ingestChats = async () => { throw new Error('chats_failed'); };
  rejectingManager.ingestContacts = async () => { throw new Error('contacts_failed'); };
  rejecting.handlers.get('creds.update')({});
  rejecting.handlers.get('messages.upsert')({ messages: [{}] });
  rejecting.handlers.get('messaging-history.set')({});
  rejecting.handlers.get('chats.upsert')([{}]);
  rejecting.handlers.get('chats.update')([{}]);
  rejecting.handlers.get('contacts.upsert')([{}]);
  rejecting.handlers.get('contacts.update')([{}]);
  await new Promise((resolve) => setImmediate(resolve));
  for (const code of ['whatsapp_creds_save_failed', 'whatsapp_message_ingest_failed', 'whatsapp_history_ingest_failed', 'whatsapp_chat_ingest_failed', 'whatsapp_contact_ingest_failed']) {
    assert.ok(contextLogs.some(([name]) => name === `official_tool:${code}`));
  }

  const noLogContext = createContext(root);
  delete noLogContext.appendLog;
  const noLogManager = new WhatsAppConnectionManager(new FakeStore(join(root, 'no-log')), buildLoader({ versionMode: 'throw' }));
  await noLogManager.start(noLogContext);
  starts.at(-1).config.logger.info('silent');

  const defaultLoaderManager = createWhatsAppConnectionManager({ metadataRoot: join(root, 'factory') });
  assert.equal(defaultLoaderManager.store.root, undefined);
  assert.equal(typeof (await defaultLoaderManager.loadBaileys()).makeWASocket, 'function');
});

test('Given incoming events and timers, stale generations are ignored while histories, reconnects, waits, and optional runtime events settle deterministically', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-events-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FakeStore(root);
  const logs = [];
  const events = [];
  const context = createContext(root, logs, events);
  const manager = new WhatsAppConnectionManager(store, async () => ({}));

  manager.handleConnectionUpdate({}, context, 999);
  manager.handleConnectionUpdate(null, context);
  manager.handleConnectionUpdate({ qr: 'qr' }, context);
  manager.handleConnectionUpdate({ connection: 'close' }, context);
  manager.authenticated = true;
  manager.handleConnectionUpdate({ connection: 'close' }, context);
  manager.clearReconnectTimer();
  manager.handleConnectionUpdate({ connection: 'close', lastDisconnect: 'bad' }, context);
  manager.clearReconnectTimer();
  manager.handleConnectionUpdate({ connection: 'close', lastDisconnect: { error: 'bad' } }, context);
  manager.clearReconnectTimer();
  for (const error of [
    new Error('forger_whatsapp_deactivated'),
    new Error('Logged Out remotely'),
    Object.assign(new Error('other'), { statusCode: 515 }),
    Object.assign(new Error('other'), { output: { statusCode: 515 } }),
    { statusCode: 'bad', output: null },
  ]) {
    manager.handleConnectionUpdate({ connection: 'close', lastDisconnect: { error } }, context);
    manager.clearReconnectTimer();
  }
  manager.handleConnectionUpdate({ connection: 'open' }, context);
  assert.ok(events.some((event) => event.phase === 'disconnected'));

  await manager.ingestMessages([], context);
  await manager.ingestMessages([null]);
  await manager.ingestMessages([sentRawMessage('I1')]);
  await manager.ingestMessages([sentRawMessage('I2')]);
  await manager.ingestChats([null]);
  await manager.ingestChats([{ id: '120363123456789@g.us', name: 'Team' }]);
  await manager.ingestChats([{ id: '56912345678@s.whatsapp.net', name: 'Friend' }]);
  await manager.ingestContacts([null]);
  await manager.ingestContacts([{ id: '56911112222@s.whatsapp.net', name: 'Person' }]);
  await manager.ingestMessages([sentRawMessage('I3')]);
  await manager.ingestHistoryPayload(null, context);
  await manager.ingestHistoryPayload({ messages: [], chats: [], contacts: [] }, context);
  await manager.ingestHistoryPayload({ messages: 'bad', chats: 'bad', contacts: 'bad' }, context);
  manager.emitRuntimeEvent({ ...context, emitEvent: undefined }, 'starting');
  manager.emitRuntimeEvent(context, 'history_sync', { reason: 'reason', counts: { messages: 1 } });

  const originalSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (callback) => {
      queueMicrotask(callback);
      return { unref() {} };
    };
    manager.latestQr = 'ready';
    assert.equal(await manager.waitForQr(), 'ready');
    manager.latestQr = null;
    manager.connected = true;
    assert.equal(await manager.waitForQr(), null);
    manager.connected = false;
    assert.equal(await manager.waitForQr(), null);
    manager.needsReconnect = true;
    await manager.waitForConnectionUpdate();
    manager.needsReconnect = false;
    manager.latestQr = null;
    await manager.waitForConnectionUpdate();

    manager.ensureStarted = async () => { throw new Error('reconnect_failed'); };
    manager.scheduleReconnect(context);
    manager.scheduleReconnect(context);
    await new Promise((resolve) => setImmediate(resolve));
    const noLog = { ...context, appendLog: undefined };
    manager.scheduleReconnect(noLog);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  manager.clearReconnectTimer();
  assert.ok(logs.some(([name]) => name === 'official_tool:whatsapp_reconnect_failed'));

  manager.ensureStarted = WhatsAppConnectionManager.prototype.ensureStarted;
  manager.socket = {};
  manager.needsReconnect = false;
  await manager.ensureStarted(context);
  manager.socket = null;
  let releaseStart;
  manager.start = async () => await new Promise((resolve) => { releaseStart = resolve; });
  const first = manager.ensureStarted(context);
  const second = manager.ensureStarted(context);
  releaseStart();
  await Promise.all([first, second]);
  assert.equal(manager.starting, null);
});

test('Given filesystem edge cases, auth discovery, serialization, permission failures, and path limits keep stable behavior', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-files-b10-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new FakeStore(root);
  const manager = new WhatsAppConnectionManager(store, async () => ({}));
  assert.equal(await manager.hasPairedAuthState(), false);
  assert.equal(await manager.hasAuthArtifacts(), false);
  await mkdir(store.authDirectory(), { recursive: true });
  await writeFile(join(store.authDirectory(), 'creds.json'), '{bad', 'utf8');
  assert.equal(await manager.hasPairedAuthState(), false);
  await writeFile(join(store.authDirectory(), 'creds.json'), JSON.stringify({ creds: { registered: true } }), 'utf8');
  assert.equal(await manager.hasPairedAuthState(), true);
  assert.equal(await manager.hasAuthArtifacts(), true);
  manager.ensureStarted = async () => undefined;
  store.messages = [];
  await manager.readMessages(createContext(root), { chatId: '56912345678' });

  manager.socket = { user: { id: '56912345678:1@s.whatsapp.net' } };
  manager.latestQr = 'qr';
  manager.lastDisconnectReason = 'closed';
  manager.needsReconnect = true;
  const status = await manager.status();
  assert.equal(status.phoneNumber, '569123456781');
  assert.equal(status.lastDisconnectReason, 'closed');
  assert.equal(status.needsReconnect, true);

  const serialized = manager.serializeMessage({
    stableMessageRef: { messageId: 'all' },
    attachments: [
      { attachmentId: 'all', kind: 'image', messageType: 'image', mimeType: 'image/png', fileName: 'a.png', caption: 'caption', sizeBytes: 3, sha256: 'sha', downloaded: true, downloadStatus: 'downloaded' },
      { attachmentId: 'minimal', kind: 'file', messageType: 'document', downloaded: false, downloadStatus: 'pending' },
    ],
  });
  assert.equal(serialized.attachments[0].sha256, 'sha');
  assert.equal(serialized.attachments[1].mimeType, undefined);

  const originalChmod = fsPromises.chmod;
  fsPromises.chmod = async () => { throw new Error('chmod_denied'); };
  try {
    const loader = async () => ({
      useMultiFileAuthState: async (directory) => {
        await mkdir(join(directory, 'nested'), { recursive: true });
        await writeFile(join(directory, 'nested', 'key'), 'x', 'utf8');
        return { state: {}, saveCreds: async () => undefined };
      },
      default: () => ({}),
    });
    await new WhatsAppConnectionManager(new FakeStore(join(root, 'chmod-start')), loader).start(createContext(root));
  } finally {
    fsPromises.chmod = originalChmod;
  }
});
