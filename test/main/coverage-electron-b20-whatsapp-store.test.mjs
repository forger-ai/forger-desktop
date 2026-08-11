import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { clearDistModule } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);

const tmpRoot = async (name) => fs.mkdtemp(path.join(os.tmpdir(), `forger-b20-${name}-`));

const loadRealStore = () => {
  clearDistModule('main/connections/modules/whatsapp/store.js');
  return require('../../dist-electron/main/connections/modules/whatsapp/store.js');
};

const makeRef = (id, fromMe = false) => ({
  remoteJid: '56911112222@s.whatsapp.net',
  id,
  fromMe,
});

test('Given SQLite support is unavailable, when the local store loads, then it fails closed before accepting data', async (t) => {
  const root = await tmpRoot('whatsapp-no-sqlite');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const optionalPath = require.resolve('../../dist-electron/main/runtime/optional-better-sqlite.js');
  require(optionalPath);
  const originalModule = require.cache[optionalPath];
  require.cache[optionalPath] = {
    id: optionalPath,
    filename: optionalPath,
    loaded: true,
    exports: { loadOptionalBetterSqlite: () => null },
  };

  try {
    const { WhatsAppLocalStore } = loadRealStore();
    await assert.rejects(new WhatsAppLocalStore(root).load(), /whatsapp_sqlite_unavailable/);
  } finally {
    require.cache[optionalPath] = originalModule;
    clearDistModule('main/connections/modules/whatsapp/store.js');
  }
});

test('Given observed chats and messages, when filtering, paginating, and reading history, then normalized records are stable', async (t) => {
  const root = await tmpRoot('whatsapp-index');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { WhatsAppLocalStore } = loadRealStore();
  const store = new WhatsAppLocalStore(root);
  await store.load();
  await store.load();

  await store.upsertChat({
    chatId: '56911112222@s.whatsapp.net',
    chatType: 'direct',
    title: 'Alice',
    phoneNumber: '56911112222',
    aliases: [' Friend ', 'Friend', '', undefined],
    lastMessageRef: makeRef('m2'),
    unreadCount: 0,
    isMuted: false,
    updatedAt: '2026-01-03T00:00:00.000Z',
  });
  await store.upsertChat({
    chatId: '120363000000001@g.us',
    chatType: 'group',
    isMuted: true,
    updatedAt: '',
  });
  await store.upsertChat({
    chatId: '120363000000002@newsletter',
    chatType: 'channel',
    title: 'News',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const firstPage = await store.listChats({ limit: 1, cursor: '0' });
  assert.equal(firstPage.chats.length, 1);
  assert.equal(firstPage.nextCursor, '1');
  const secondPage = await store.listChats({ limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.chats.length, 1);
  assert.equal((await store.listChats({ chatType: 'direct', query: ' FRIEND ', limit: 500 })).chats[0].chatId, '56911112222@s.whatsapp.net');
  assert.equal((await store.listChats({ query: 5, limit: Number.NaN, cursor: -1 })).chats.length, 3);
  assert.equal((await store.listChats({ query: '   ', limit: 0, cursor: 'invalid' })).chats.length, 1);
  assert.equal((await store.listChats({ cursor: '-2' })).chats.length, 3);

  const direct = await store.getChat('56911112222@s.whatsapp.net');
  assert.equal(direct.title, 'Alice');
  assert.equal(direct.isMuted, false);
  assert.equal(direct.unreadCount, 0);
  assert.deepEqual(direct.lastMessageRef, makeRef('m2'));
  assert.deepEqual(direct.aliases, ['56911112222', 'Alice', 'Friend']);
  assert.equal(await store.getChat('missing'), null);

  const fullAttachment = {
    attachmentId: 'attachment-full',
    stableMessageRef: makeRef('m2'),
    chatId: '56911112222@s.whatsapp.net',
    kind: 'image',
    messageType: 'imageMessage',
    mimeType: 'image/jpeg',
    fileName: 'photo.jpg',
    caption: 'Photo',
    sizeBytes: 12,
    sha256: 'sha',
    downloaded: true,
    downloadStatus: 'downloaded',
    localPath: '/tmp/photo.jpg',
    downloadedAt: '2026-01-02T00:00:00.000Z',
    error: 'old error',
    rawMessageJson: '{"image":true}',
  };
  const minimalAttachment = {
    attachmentId: 'attachment-minimal',
    stableMessageRef: makeRef('m1'),
    chatId: '56911112222@s.whatsapp.net',
    kind: 'document',
    messageType: 'documentMessage',
    downloaded: false,
    downloadStatus: 'not_downloaded',
  };
  await store.upsertMessages([
    {
      stableMessageRef: makeRef('m1'),
      chatId: '56911112222@s.whatsapp.net',
      chatType: 'direct',
      fromMe: false,
      timestamp: 10,
      messageType: 'documentMessage',
      isGroup: false,
      isChannel: false,
      hasAttachments: true,
      attachments: [minimalAttachment],
    },
    {
      stableMessageRef: makeRef('m2', true),
      chatId: '56911112222@s.whatsapp.net',
      chatType: 'direct',
      senderId: 'sender',
      senderDisplayName: 'Alice',
      fromMe: true,
      timestamp: 20,
      text: 'Hello',
      messageType: 'imageMessage',
      isGroup: true,
      isChannel: true,
      hasAttachments: true,
      attachments: [{ ...fullAttachment, stableMessageRef: makeRef('m2', true) }],
    },
    {
      stableMessageRef: makeRef('m0'),
      chatId: '56911112222@s.whatsapp.net',
      chatType: 'direct',
      fromMe: false,
      timestamp: 0,
      text: '',
      messageType: 'conversation',
      isGroup: false,
      isChannel: false,
      hasAttachments: false,
      attachments: [],
    },
  ]);

  const messages = await store.readMessages({ chatId: '56911112222@s.whatsapp.net', limit: 500 });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].text, 'Hello');
  assert.equal(messages[0].attachments[0].downloaded, true);
  assert.equal(messages[1].senderId, undefined);
  assert.equal(messages[2].timestamp, undefined);
  assert.deepEqual((await store.readMessages({
    chatId: '56911112222@s.whatsapp.net',
    beforeMessageRef: store.encodeRef(makeRef('m2', true)),
    limit: 0,
  })).map((message) => message.stableMessageRef.id), ['m1']);
  assert.equal((await store.readMessages({ chatId: '56911112222@s.whatsapp.net', beforeMessageRef: store.encodeRef(makeRef('missing')) })).length, 3);
  assert.equal((await store.readMessages({ chatId: '56911112222@s.whatsapp.net', beforeMessageRef: 'invalid', limit: Number.NaN })).length, 3);

  await store.clear();
});

test('Given send throttling and attachment state, when updates occur, then rate limits and download metadata are persisted', async (t) => {
  const root = await tmpRoot('whatsapp-state');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { WhatsAppLocalStore } = loadRealStore();
  const store = new WhatsAppLocalStore(root);

  assert.equal(await store.canSendNow(), true);
  await store.rememberSend();
  assert.equal(await store.canSendNow(), false);
  await store.rememberSend();

  await store.upsertMessages([{
    stableMessageRef: makeRef('attachment-message'),
    chatId: '56911112222@s.whatsapp.net',
    chatType: 'direct',
    fromMe: false,
    timestamp: 30,
    messageType: 'imageMessage',
    isGroup: false,
    isChannel: false,
    hasAttachments: true,
    attachments: [{
      attachmentId: 'attachment',
      stableMessageRef: makeRef('attachment-message'),
      chatId: '56911112222@s.whatsapp.net',
      kind: 'image',
      messageType: 'imageMessage',
      sizeBytes: 5,
      sha256: 'original-sha',
      downloaded: false,
      downloadStatus: 'not_downloaded',
    }],
  }]);

  assert.equal(await store.getAttachment('missing'), null);
  await store.markAttachmentFailed('attachment', 'download failed');
  assert.equal((await store.getAttachment('attachment')).error, 'download failed');
  const downloaded = await store.markAttachmentDownloaded({ attachmentId: 'attachment', localPath: '/tmp/downloaded' });
  assert.equal(downloaded.downloaded, true);
  assert.equal(downloaded.sizeBytes, 5);
  assert.equal(downloaded.sha256, 'original-sha');
  assert.equal(await store.markAttachmentDownloaded({ attachmentId: 'missing', localPath: '/tmp/missing', sizeBytes: 1, sha256: 'new' }), null);

  const BetterSqlite3 = require('../../dist-electron/main/runtime/optional-better-sqlite.js').loadOptionalBetterSqlite();
  const db = new BetterSqlite3(store.databasePath());
  db.prepare("UPDATE kv SET value = ? WHERE key = 'last_send_at'").run('2000-01-01T00:00:00.000Z');
  db.prepare("INSERT INTO kv (key, value) VALUES ('last_sync_at', ?)").run('2026-01-01T00:00:00.000Z');
  assert.equal(await store.canSendNow(), true);

  const nested = path.join(store.downloadsDirectory(), 'nested');
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, 'payload.bin'), '12345');
  await fs.symlink(nested, path.join(store.downloadsDirectory(), 'directory-link'));
  await fs.symlink(path.join(root, 'absent'), path.join(store.downloadsDirectory(), 'dangling-link'));
  const status = await store.storageStatus();
  assert.equal(status.chatCount, 1);
  assert.equal(status.messageCount, 1);
  assert.equal(status.attachmentCount, 1);
  assert.equal(status.downloadedAttachmentCount, 1);
  assert.equal(status.downloadsBytes, 5);
  assert.equal(status.lastMessageAt, '1970-01-01T00:00:30.000Z');
  assert.equal(status.lastSyncAt, '2026-01-01T00:00:00.000Z');
  db.close();

  await store.clear();
  await store.clear();
});

test('Given corrupt persisted references or an invalid internal state, when records are read, then the store refuses them explicitly', async (t) => {
  const root = await tmpRoot('whatsapp-corrupt');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { WhatsAppLocalStore } = loadRealStore();
  const store = new WhatsAppLocalStore(root);
  await store.load();
  const BetterSqlite3 = require('../../dist-electron/main/runtime/optional-better-sqlite.js').loadOptionalBetterSqlite();
  const db = new BetterSqlite3(store.databasePath());
  db.prepare("INSERT INTO chats (chat_id, chat_type, updated_at) VALUES ('corrupt', 'direct', '2026-01-01T00:00:00.000Z')").run();
  db.prepare(`INSERT INTO messages (
    stable_ref, chat_id, chat_type, from_me, message_type, is_group, is_channel, has_attachments
  ) VALUES ('invalid', 'corrupt', 'direct', 0, 'conversation', 0, 0, 0)`).run();
  await assert.rejects(store.readMessages({ chatId: 'corrupt' }), /whatsapp_stored_message_ref_invalid/);

  db.prepare(`INSERT INTO attachments (
    attachment_id, stable_ref, chat_id, kind, message_type, download_status
  ) VALUES ('corrupt-attachment', 'invalid', 'corrupt', 'image', 'imageMessage', 'not_downloaded')`).run();
  await assert.rejects(store.getAttachment('corrupt-attachment'), /whatsapp_stored_attachment_ref_invalid/);
  db.close();

  await store.clear();
  store.loaded = true;
  await assert.rejects(store.listChats({}), /whatsapp_store_not_loaded/);
  store.loaded = false;
});
