import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const { WhatsAppLocalStore } = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
const { normalizeBaileysContact } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');
const phone = '56912345678@s.whatsapp.net';
const lid = '100000000678@lid';
const owner = '56987654321@s.whatsapp.net';
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'wa-contact-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WhatsAppLocalStore(root);
  const manager = new WhatsAppConnectionManager(store);
  manager.socket = { user: { id: owner } };
  return { root, store, manager };
};

test('saved contact names survive push names, chat updates, messages and restart, and accept explicit renames', async t => {
  const { root, store, manager } = await fixture(t);
  await manager.ingestContacts([{ id: phone, name: '  Mamá  ', notify: 'Profile name' }]);
  await manager.ingestContacts([{ id: phone, notify: 'New profile name' }]);
  await manager.ingestChats([{ id: phone, name: 'Chat title' }]);
  await manager.ingestMessages([{ key: { remoteJid: phone, id: 'msg' }, pushName: 'Message name', message: { conversation: 'hi' } }]);
  assert.equal((await store.getChat(phone)).contactName, 'Mamá');
  assert.equal((await new WhatsAppLocalStore(root).getChat(phone)).contactName, 'Mamá');
  assert.equal((await manager.listChats({ query: 'mamá' })).chats[0].contactName, 'Mamá');
  await manager.ingestContacts([{ id: phone, name: 'Mamá casa' }]);
  assert.equal((await manager.getChatDetails({}, { chatId: phone })).chat.contactName, 'Mamá casa');
  assert.equal((await manager.listChats({ query: '+56 (9) 1234-5678' })).chats[0].phoneNumber, '56912345678');
  assert.equal((await manager.listChats({ query: '++' })).chats.length, 0);
});

test('only contact.name supplies a saved direct-contact name; group names remain titles', () => {
  assert.equal(normalizeBaileysContact({ id: phone, notify: 'Profile', verifiedName: 'Business' })[0].contactName, undefined);
  assert.equal(normalizeBaileysContact({ id: phone, name: ' ', notify: 'Profile' })[0].contactName, undefined);
  assert.equal(normalizeBaileysContact({ id: 'team@g.us', name: 'Team' })[0].contactName, undefined);
  assert.equal(normalizeBaileysContact({ id: 'team@g.us', name: 'Team' })[0].title, 'Team');
});

test('trusted equivalents enrich saved names and phones, while unknown LIDs and groups never invent phone numbers', async t => {
  const { store, manager } = await fixture(t);
  await manager.ingestContacts([{ id: phone, name: 'Saved contact' }]);
  await manager.ingestChats([{ id: lid, name: 'Profile' }, { id: '222@lid' }, { id: 'team@g.us', name: 'Team' }]);
  await store.rememberIdentityPair(owner, phone, lid);
  const chats = (await manager.listChats({})).chats;
  const direct = chats.find(c => c.chatId === lid);
  assert.equal(direct.contactName, 'Saved contact');
  assert.equal(direct.phoneNumber, '56912345678');
  assert.deepEqual(new Set(direct.identityIds), new Set([phone, lid]));
  assert.equal(chats.find(c => c.chatId === '222@lid').phoneNumber, undefined);
  assert.equal((await manager.getChatDetails({}, { chatId: '222@lid' })).phoneNumber, undefined);
  assert.deepEqual(new Set((await manager.listChats({ query: 'Saved contact' })).chats.map(c => c.chatId)), new Set([phone, lid]));
  assert.equal(chats.find(c => c.chatId === 'team@g.us').phoneNumber, undefined);
  assert.equal(chats.find(c => c.chatId === 'team@g.us').contactName, undefined);
  assert.equal((await manager.getChatDetails({}, { chatId: lid })).chat.contactName, 'Saved contact');
  assert.equal((await manager.getChatDetails({}, { chatId: lid })).phoneNumber, '56912345678');
  await manager.ingestContacts([{ id: lid, name: 'Local saved name' }]);
  assert.equal((await manager.getChatDetails({}, { chatId: lid })).chat.contactName, 'Local saved name');
});

test('phone search finds a LID-only observed chat through verified account pairs and excludes conflicted or other-account pairs', async t => {
  const { store, manager } = await fixture(t);
  await manager.ingestChats([{ id: lid, name: 'Observed profile' }]);
  await store.rememberIdentityPair(owner, phone, lid);
  assert.equal((await manager.listChats({ query: '+56 9 1234 5678' })).chats[0].chatId, lid);
  manager.socket = { user: { id: '56900000000@s.whatsapp.net' } };
  assert.equal((await manager.listChats({ query: '12345678' })).chats.length, 0);
  manager.socket = null;
  assert.equal((await manager.listChats({ query: '12345678' })).chats.length, 0);
  manager.socket = { user: { id: owner } };
  await store.invalidateIdentity(owner, lid);
  assert.equal((await manager.listChats({ query: '12345678' })).chats.length, 0);
});

test('legacy databases gain nullable saved-name storage without reclassifying titles or losing chats', async t => {
  const { root } = await fixture(t);
  const folder = join(root, 'connections', 'whatsapp', 'data');
  await mkdir(folder, { recursive: true });
  const Sqlite = require('better-sqlite3');
  const db = new Sqlite(join(folder, 'whatsapp.sqlite'));
  db.exec(`CREATE TABLE chats (chat_id TEXT PRIMARY KEY, chat_type TEXT NOT NULL, title TEXT, phone_number TEXT,
    last_message_ref TEXT, unread_count INTEGER, is_muted INTEGER, updated_at TEXT NOT NULL)`);
  db.prepare('INSERT INTO chats (chat_id, chat_type, title, updated_at) VALUES (?, ?, ?, ?)').run(phone, 'direct', 'Old title', '2026-01-01');
  db.close();
  const store = new WhatsAppLocalStore(root);
  assert.equal((await store.getChat(phone)).title, 'Old title');
  assert.equal((await store.getChat(phone)).contactName, undefined);
  await store.upsertChat({ chatId: phone, chatType: 'direct', contactName: 'Saved after migration', updatedAt: '2026-02-01' });
  assert.equal((await new WhatsAppLocalStore(root).getChat(phone)).contactName, 'Saved after migration');
});
