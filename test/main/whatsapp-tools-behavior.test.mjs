import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyWhatsAppJid,
  decodeStableMessageRef,
  encodeStableMessageRef,
  normalizeBaileysMessage,
  phoneNumberFromJid,
} = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');
const { WhatsAppLocalStore } = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const { whatsappToolModule, __resetWhatsAppToolForTests } = require('../../dist-electron/main/connections/modules/whatsapp/index.js');

const createContext = (metadataRoot, events = []) => ({
  metadataRoot,
  locale: 'es',
  secretsStore: {
    hasToolSecret: async () => false,
    getToolSecret: async () => undefined,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
  getFreePort: async () => 0,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client-id',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
  appendLog: async () => undefined,
  emitEvent: (event) => events.push(event),
});

test('WhatsApp normalizer classifies direct, group, and channel messages with stable refs', () => {
  assert.equal(classifyWhatsAppJid('56912345678@s.whatsapp.net'), 'direct');
  assert.equal(classifyWhatsAppJid('120363123456789@g.us'), 'group');
  assert.equal(classifyWhatsAppJid('120363123456789@newsletter'), 'channel');
  assert.equal(phoneNumberFromJid('56912345678@s.whatsapp.net'), '56912345678');

  const message = normalizeBaileysMessage({
    key: {
      remoteJid: '120363123456789@g.us',
      id: 'ABC123',
      fromMe: false,
      participant: '56911111111@s.whatsapp.net',
    },
    pushName: 'Felipe',
    messageTimestamp: 1_777_777,
    message: { extendedTextMessage: { text: 'Hola grupo' } },
  });
  assert.equal(message.chatType, 'group');
  assert.equal(message.isGroup, true);
  assert.equal(message.senderDisplayName, 'Felipe');
  assert.equal(message.text, 'Hola grupo');
  const encoded = encodeStableMessageRef(message.stableMessageRef);
  assert.deepEqual(decodeStableMessageRef(encoded), message.stableMessageRef);

  const mediaMessage = normalizeBaileysMessage({
    key: {
      remoteJid: '56912345678@s.whatsapp.net',
      id: 'IMG1',
      fromMe: false,
    },
    message: {
      imageMessage: {
        caption: 'Foto',
        mimetype: 'image/jpeg',
        fileName: '../bad.jpg',
        fileLength: 123,
        fileSha256: Buffer.from('hash'),
      },
    },
  });
  assert.equal(mediaMessage.hasAttachments, true);
  assert.equal(mediaMessage.attachments.length, 1);
  assert.equal(mediaMessage.attachments[0].kind, 'image');
  assert.equal(mediaMessage.attachments[0].mimeType, 'image/jpeg');
  assert.equal(mediaMessage.attachments[0].sizeBytes, 123);
});

test('WhatsApp local store lists chats, reads messages, and enforces observed-chat sending', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-store-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new WhatsAppLocalStore(root);
  const manager = new WhatsAppConnectionManager(store);
  await manager.ingestMessages([
    {
      key: { remoteJid: '56912345678@s.whatsapp.net', id: 'M1', fromMe: false },
      messageTimestamp: 1,
      message: { conversation: 'Hola' },
    },
    {
      key: { remoteJid: '120363123456789@newsletter', id: 'C1', fromMe: false },
      messageTimestamp: 2,
      message: { conversation: 'Canal' },
    },
  ]);

  const chats = await manager.listChats({ limit: 10 });
  assert.deepEqual(chats.chats.map((chat) => [chat.chatId, chat.chatType]).sort(), [
    ['120363123456789@newsletter', 'channel'],
    ['56912345678@s.whatsapp.net', 'direct'],
  ].sort());
  const read = await manager.readMessages(createContext(root), { chatId: '56912345678@s.whatsapp.net' });
  assert.equal(read.messages[0].text, 'Hola');
  assert.equal(typeof read.messages[0].stableMessageRef, 'string');

  const unknownSend = await manager.sendMessage(createContext(root), {
    chatId: '56999999999@s.whatsapp.net',
    text: 'No debe enviar',
  });
  assert.equal(unknownSend.technicalCode, 'whatsapp_chat_not_observed');
});

test('WhatsApp SQLite store starts clean and keeps more than 200 messages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-sqlite-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'official-tools', 'whatsapp'), { recursive: true });
  await writeFile(join(root, 'official-tools', 'whatsapp', 'index.json'), JSON.stringify({
    chats: {
      '56900000000@s.whatsapp.net': {
        chatId: '56900000000@s.whatsapp.net',
        chatType: 'direct',
        updatedAt: new Date().toISOString(),
      },
    },
  }), 'utf8');

  const manager = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));
  assert.equal((await manager.listChats({})).chats.length, 0);

  await manager.ingestMessages(Array.from({ length: 250 }, (_, index) => ({
    key: { remoteJid: '56912345678@s.whatsapp.net', id: `M${index}`, fromMe: false },
    messageTimestamp: index + 1,
    message: { conversation: `Mensaje ${index}` },
  })));

  const read = await manager.readMessages(createContext(root), {
    chatId: '56912345678@s.whatsapp.net',
    limit: 250,
  });
  assert.equal(read.messages.length, 250);
  assert.equal(read.messages[0].text, 'Mensaje 249');
  assert.equal(read.messages[249].text, 'Mensaje 0');
});

test('WhatsApp contacts and chat metadata make list_chats searchable by saved name', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-search-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const manager = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));
  await manager.ingestContacts([{
    id: '56911112222@s.whatsapp.net',
    name: 'Kupa',
    notify: 'Juan',
  }]);
  await manager.ingestChats([{
    id: '120363123456789@g.us',
    name: 'Kupa equipo',
    unreadCount: 2,
  }]);

  const direct = await manager.listChats({ query: 'kupa', chatType: 'direct' });
  assert.equal(direct.chats.length, 1);
  assert.equal(direct.chats[0].title, 'Kupa');
  assert.equal(direct.chats[0].phoneNumber, '56911112222');

  const groups = await manager.listChats({ query: 'KUPA', chatType: 'group' });
  assert.equal(groups.chats.length, 1);
  assert.equal(groups.chats[0].title, 'Kupa equipo');
  assert.equal(groups.chats[0].unreadCount, 2);
});

test('WhatsApp manager emits runtime events for pairing, reconnect, and history sync', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-events-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const events = [];
  const context = createContext(root, events);
  const manager = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));
  manager.ensureStarted = async () => undefined;

  manager.handleConnectionUpdate({ qr: 'qr-token' }, context);
  manager.handleConnectionUpdate({ connection: 'open' }, context);
  manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 515 }, message: 'restart required' } },
  }, context);
  await manager.ingestHistoryPayload({
    messages: [{
      key: { remoteJid: '56912345678@s.whatsapp.net', id: 'M1', fromMe: false },
      messageTimestamp: 1,
      message: { conversation: 'Hola' },
    }],
    chats: [{ id: '120363123456789@g.us', name: 'Equipo' }],
    contacts: [{ id: '56911112222@s.whatsapp.net', name: 'Kupa' }],
  }, context);

  assert.deepEqual(events.map((event) => event.phase), [
    'qr_available',
    'connected',
    'reconnecting',
    'history_sync',
    'messages_ingested',
    'chats_ingested',
    'contacts_ingested',
    'sync_ready',
  ]);
  assert.equal(events[0].toolId, 'whatsapp');
  assert.equal(typeof events[0].timestamp, 'string');
  assert.equal(events[0].status.qrAvailable, true);
  assert.equal(events[1].status.connected, true);
  assert.equal(events[2].status.needsReconnect, true);
  assert.deepEqual(events[3].counts, { messages: 1, chats: 1, contacts: 1 });
  assert.deepEqual(events.at(-1).counts, { messages: 1, chats: 1, contacts: 1 });
});

test('WhatsApp manager returns group details and official module rejects invalid send input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-manager-'));
  t.after(async () => {
    __resetWhatsAppToolForTests();
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const store = new WhatsAppLocalStore(root);
  const manager = new WhatsAppConnectionManager(store);
  await manager.ingestMessages([{
    key: { remoteJid: '120363123456789@g.us', id: 'G1', fromMe: false, participant: '56911111111@s.whatsapp.net' },
    message: { conversation: 'Grupo' },
  }]);
  manager.socket = {
    groupMetadata: async () => ({
      id: '120363123456789@g.us',
      subject: 'Equipo',
      desc: 'Trabajo',
      announce: false,
      restrict: true,
      ephemeralDuration: 86400,
      participants: [{ id: '56911111111@s.whatsapp.net', admin: 'admin' }],
    }),
  };
  manager.needsReconnect = false;

  const details = await manager.getChatDetails(context, { chatId: '120363123456789@g.us' });
  assert.equal(details.type, 'group');
  assert.equal(details.metadata.subject, 'Equipo');
  assert.equal(details.metadata.ephemeralDuration, 86400);
  assert.deepEqual(details.metadata.participants[0], { id: '56911111111@s.whatsapp.net', admin: 'admin' });

  const invalid = await whatsappToolModule.execute({
    toolId: 'whatsapp',
    actionId: 'whatsapp.send_message',
    input: { chatId: '', text: '' },
  }, context);
  assert.equal(invalid.technicalCode, 'whatsapp_send_input_invalid');
});

test('WhatsApp attachment download rejects unknown ids and returns existing local downloads', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-attachments-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const store = new WhatsAppLocalStore(root);
  const manager = new WhatsAppConnectionManager(store);
  await manager.ingestMessages([{
    key: { remoteJid: '56912345678@s.whatsapp.net', id: 'IMG1', fromMe: false },
    message: {
      imageMessage: {
        caption: 'Foto',
        mimetype: 'image/jpeg',
        fileName: '../../unsafe.jpg',
        fileLength: 10,
      },
    },
  }]);
  const read = await manager.readMessages(context, { chatId: '56912345678@s.whatsapp.net' });
  assert.equal(read.messages[0].hasAttachments, true);
  assert.equal(read.messages[0].attachments.length, 1);
  assert.equal(read.messages[0].attachments[0].rawMessageJson, undefined);
  const attachmentId = read.messages[0].attachments[0].attachmentId;

  const unknown = await manager.downloadAttachment(context, { attachmentId: 'missing' });
  assert.equal(unknown.technicalCode, 'whatsapp_attachment_not_observed');

  const localPath = join(store.downloadsDirectory(), 'existing.jpg');
  await mkdir(store.downloadsDirectory(), { recursive: true });
  await writeFile(localPath, 'image-bytes', 'utf8');
  await store.markAttachmentDownloaded({ attachmentId, localPath, sizeBytes: 11, sha256: 'sha' });
  const existing = await manager.downloadAttachment(context, { attachmentId });
  assert.equal(existing.filePath, localPath);
  assert.equal(existing.sizeBytes, 11);
  assert.equal(existing.sha256, 'sha');
});

test('WhatsApp manager treats Baileys restart-required disconnect as reconnectable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-reconnect-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const store = new WhatsAppLocalStore(root);
  const manager = new WhatsAppConnectionManager(store);
  manager.authenticated = true;
  let reconnectAttempts = 0;
  manager.ensureStarted = async () => {
    reconnectAttempts += 1;
  };

  manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: {
      error: Object.assign(new Error('Stream Errored (restart required)'), {
        output: { statusCode: 515 },
      }),
    },
  }, context);

  const statusAfterClose = await manager.status();
  assert.equal(statusAfterClose.connected, false);
  assert.equal(statusAfterClose.needsReconnect, true);
  assert.equal(statusAfterClose.lastDisconnectReason, 'Stream Errored (restart required)');

  await new Promise((resolve) => {
    setTimeout(resolve, 1_650);
  });
  assert.equal(reconnectAttempts, 1);
});

test('WhatsApp manager reconnects lost sockets but does not loop generic connection failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-lost-connection-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const manager = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));
  manager.authenticated = true;
  let reconnectAttempts = 0;
  manager.ensureStarted = async () => {
    reconnectAttempts += 1;
  };

  manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: {
      error: new Error('Connection was lost'),
    },
  }, context);
  await new Promise((resolve) => {
    setTimeout(resolve, 1_650);
  });
  assert.equal(reconnectAttempts, 1);

  manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: {
      error: new Error('Connection Failure'),
    },
  }, context);
  await new Promise((resolve) => {
    setTimeout(resolve, 1_650);
  });
  assert.equal(reconnectAttempts, 1);
});

test('WhatsApp status starts the socket when auth exists after app restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-status-start-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const store = new WhatsAppLocalStore(root);
  await mkdir(store.authDirectory(), { recursive: true });
  await writeFile(join(store.authDirectory(), 'creds.json'), JSON.stringify({ registered: true }), 'utf8');
  const manager = new WhatsAppConnectionManager(store);
  let started = 0;
  manager.ensureStarted = async () => {
    started += 1;
    manager.connected = true;
  };

  const status = await manager.status(context);

  assert.equal(started, 1);
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
});

test('WhatsApp credentials with registered false are not configured', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-unregistered-creds-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new WhatsAppLocalStore(root);
  await mkdir(store.authDirectory(), { recursive: true });
  await writeFile(join(store.authDirectory(), 'creds.json'), JSON.stringify({ registered: false }), 'utf8');
  const manager = new WhatsAppConnectionManager(store);

  const status = await manager.status();

  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.needsReconnect, undefined);
});

test('WhatsApp QR identity is configured before registered becomes true', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-paired-identity-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new WhatsAppLocalStore(root);
  await mkdir(store.authDirectory(), { recursive: true });
  await writeFile(join(store.authDirectory(), 'creds.json'), JSON.stringify({
    registered: false,
    me: { id: 'business-device' },
    account: { details: 'paired' },
  }), 'utf8');
  const manager = new WhatsAppConnectionManager(store);

  const status = await manager.status();

  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
});

test('WhatsApp close before authentication does not require reconnection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-pre-auth-close-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const manager = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));

  manager.handleConnectionUpdate({
    connection: 'close',
    lastDisconnect: { error: new Error('Connection Failure') },
  }, context);

  const status = await manager.status();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.needsReconnect, undefined);
});

test('WhatsApp pairing fetches the latest protocol version through the injected loader', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-latest-version-'));
  const store = new WhatsAppLocalStore(root);
  const latestVersion = [2, 3000, 1043857760];
  let fetchLatestCalls = 0;
  let socketConfig;
  let manager;
  const loadBaileys = async () => ({
    fetchLatestBaileysVersion: async () => {
      fetchLatestCalls += 1;
      return { version: latestVersion, isLatest: true };
    },
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined }),
    default: (config) => {
      socketConfig = config;
      return {
        ev: {
          on: (event, handler) => {
            if (event === 'connection.update') {
              queueMicrotask(() => handler({ qr: 'fresh-versioned-qr' }));
            }
          },
        },
        end: () => undefined,
      };
    },
  });
  manager = new WhatsAppConnectionManager(store, loadBaileys);
  t.after(async () => {
    await manager.disconnect();
    await rm(root, { recursive: true, force: true });
  });

  const result = await manager.startPairing(createContext(root), { method: 'qr' });

  assert.equal(fetchLatestCalls, 1);
  assert.deepEqual(socketConfig?.version, latestVersion);
  assert.equal(result.status, 'qr_ready');
});

test('WhatsApp pairing failure before QR is recoverable instead of pending', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-pairing-failure-'));
  const store = new WhatsAppLocalStore(root);
  let manager;
  const loadBaileys = async () => ({
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1043857760], isLatest: true }),
    useMultiFileAuthState: async () => ({ state: {}, saveCreds: async () => undefined }),
    default: () => ({
      ev: {
        on: (event, handler) => {
          if (event === 'connection.update') {
            queueMicrotask(() => handler({
              connection: 'close',
              lastDisconnect: { error: new Error('Connection Failure') },
            }));
          }
        },
      },
      end: () => undefined,
    }),
  });
  manager = new WhatsAppConnectionManager(store, loadBaileys);
  manager.waitForQr = async () => null;
  t.after(async () => {
    await manager.disconnect();
    await rm(root, { recursive: true, force: true });
  });

  const result = await manager.startPairing(createContext(root), { method: 'qr' });

  assert.equal(result.success, false);
  assert.equal(result.recoverable, true);
  assert.notEqual(result.status, 'qr_pending');
  assert.equal(typeof result.technicalCode, 'string');
});

test('WhatsApp QR pairing clears stale auth before starting a fresh QR session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-whatsapp-stale-auth-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const context = createContext(root);
  const store = new WhatsAppLocalStore(root);
  await mkdir(store.authDirectory(), { recursive: true });
  await writeFile(join(store.authDirectory(), 'creds.json'), JSON.stringify({ registered: true }), 'utf8');
  const manager = new WhatsAppConnectionManager(store);
  let ended = false;
  let startedAfterClear = false;
  manager.socket = {
    end: () => {
      ended = true;
    },
  };
  manager.ensureStarted = async () => {
    const status = await manager.status();
    startedAfterClear = status.configured === false;
    manager.latestQr = 'fresh-qr';
  };

  const result = await manager.startPairing(context, { method: 'qr' });

  assert.equal(ended, true);
  assert.equal(startedAfterClear, true);
  assert.equal(result.status, 'qr_ready');
  assert.equal(typeof result.qrDataUrl, 'string');
  assert.equal((await manager.status()).configured, false);
});
