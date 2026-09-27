import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const { WhatsAppLocalStore } = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
const { phoneNumberFromJid, encodeStableMessageRef } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');
const pn = '56912349446@s.whatsapp.net';
const lid = '100000009446@lid';
const other = '56912340000@s.whatsapp.net';
const otherLid = '100000000000@lid';
const raw = (chatId, id, fromMe = true, participant) => ({
  key: { remoteJid: chatId, id, fromMe, ...(participant ? { participant } : {}), remoteJidAlt: pn },
  message: { conversation: '@kupita test' }, messageTimestamp: 123,
});
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'wa-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WhatsAppLocalStore(root);
  const received = [];
  const manager = new WhatsAppConnectionManager(store, { onLiveMessage: m => { received.push(m); } });
  manager.socket = { user: { id: pn.replace('@', ':51@'), lid: lid.replace('@', ':51@') } };
  return { root, store, manager, received };
};

test('phone labels exclude device suffixes and never treat private LIDs as phones', () => {
  assert.equal(phoneNumberFromJid('56912349446:51@s.whatsapp.net'), '56912349446');
  assert.equal(phoneNumberFromJid(lid), undefined);
  assert.equal(phoneNumberFromJid('not-a-phone@s.whatsapp.net'), undefined);
});

test('self PN and LID route together without changing references or admitting a different destination', async t => {
  const { manager, received } = await fixture(t);
  await manager.ingestUpsert({ type: 'notify', messages: [raw(pn, 'PN'), raw(lid, 'LID'), raw(other, 'OTHER')] });
  assert.deepEqual(new Set(received[0].chatIdentityIds), new Set([pn, lid]));
  assert.deepEqual(new Set(received[1].chatIdentityIds), new Set([pn, lid]));
  assert.deepEqual(received[2].chatIdentityIds, [other]);
  assert.equal(received[1].chatId, lid);
  assert.deepEqual(received[1].stableMessageRef, { remoteJid: lid, id: 'LID', fromMe: true });
  assert.equal((await manager.status()).phoneNumber, '56912349446');
});

test('verified member mappings remain consistent for selection, live authorization and history pagination', async t => {
  const { manager, store, root, received } = await fixture(t);
  manager.socket.signalRepository = { lidMapping: {
    getLIDForPN: async id => id === other ? otherLid : null,
    getPNForLID: async id => id === otherLid ? other : null,
  } };
  manager.socket.groupMetadata = async () => ({ id: 'group@g.us', participants: [{ id: otherLid, name: 'Member' }] });
  await manager.ingestMessages([raw(other, 'PHONE', false), raw(otherLid, 'PRIVATE', false)]);
  await manager.ingestUpsert({ type: 'notify', messages: [raw('group@g.us', 'GROUP', false, otherLid)] });
  assert.deepEqual(new Set(received[0].senderIdentityIds), new Set([other, otherLid]));
  assert.deepEqual(received[0].chatIdentityIds, ['group@g.us']);
  const details = await manager.getChatDetails({}, { chatId: 'group@g.us' });
  assert.deepEqual(new Set(details.metadata.participants[0].identityIds), new Set([other, otherLid]));
  const chats = await manager.listChats({});
  const selected = chats.chats.find(c => c.chatId === other);
  assert.deepEqual(new Set(selected.identityIds), new Set([other, otherLid]));
  const first = await manager.readMessages({}, { chatId: other, limit: 1 });
  const second = await manager.readMessages({}, { chatId: other, limit: 1, beforeMessageRef: first.messages[0].stableMessageRef });
  assert.equal(first.messages.length, 1);
  assert.equal(second.messages.length, 1);
  assert.notEqual(first.messages[0].stableMessageRef, second.messages[0].stableMessageRef);
  assert.equal((await manager.readMessages({}, { chatId: pn, beforeMessageRef: first.messages[0].stableMessageRef })).messages.length, 0);
  const restarted = new WhatsAppConnectionManager(new WhatsAppLocalStore(root));
  restarted.socket = { user: { id: pn } };
  assert.deepEqual(new Set(await restarted.resolveIdentityIds(other)), new Set([other, otherLid]));
  assert.equal((await restarted.readMessages({}, { chatId: other })).messages.length, 2);
  assert.equal((await store.readMessages({ chatId: other })).length, 1);
});

test('unverified and conflicting identity mappings fail closed and never follow display names or alternate message fields', async t => {
  const { manager, store, received } = await fixture(t);
  manager.socket.signalRepository = { lidMapping: {
    getLIDForPN: async () => otherLid,
    getPNForLID: async () => pn,
  } };
  await manager.ingestContacts([{ id: other, lid: otherLid, name: 'Same name' }]);
  await manager.ingestUpsert({ type: 'notify', messages: [raw(other, 'WRONG')] });
  assert.deepEqual(received[0].chatIdentityIds, [other]);
  await store.rememberIdentityPair(pn, other, otherLid);
  await store.rememberIdentityPair(pn, '56911111111@s.whatsapp.net', otherLid);
  assert.deepEqual(await manager.resolveIdentityIds(other), [other]);
  manager.socket = { user: { id: '56988888888@s.whatsapp.net' } };
  assert.deepEqual(await manager.resolveIdentityIds(lid), [lid]);
});

test('original outgoing references still suppress the echoed reply after identity resolution', async t => {
  const { manager, received, store } = await fixture(t);
  const sent = raw(lid, 'SENT');
  await manager.ingestMessages([raw(pn, 'OBSERVED')]);
  manager.socket.sendMessage = async () => sent;
  const result = await manager.sendMessage({}, { chatId: pn, text: 'response' });
  assert.equal(result.stableMessageRef, encodeStableMessageRef({ remoteJid: lid, id: 'SENT', fromMe: true }));
  assert.equal(await store.isKnownOutboundMessageRef(result.stableMessageRef), true);
  await manager.ingestUpsert({ type: 'notify', messages: [sent] });
  assert.deepEqual(received, []);
});

test('PN and LID copies preserve original refs while exposing the same deduplication set; equivalent outbound echoes are ignored', async t => {
  const { manager, received, store } = await fixture(t);
  await manager.ingestUpsert({ type: 'notify', messages: [raw(pn, 'COPY'), raw(lid, 'COPY')] });
  assert.deepEqual(new Set(received[0].equivalentStableMessageRefs), new Set(received[1].equivalentStableMessageRefs));
  assert.notEqual(encodeStableMessageRef(received[0].stableMessageRef), encodeStableMessageRef(received[1].stableMessageRef));
  await store.rememberSend(encodeStableMessageRef({ remoteJid: pn, id: 'OUTBOUND', fromMe: true }));
  await manager.ingestUpsert({ type: 'notify', messages: [raw(lid, 'OUTBOUND')] });
  assert.equal(received.length, 2);
});

test('missing mapping results and temporary errors keep only known verified associations', async t => {
  const { manager, store } = await fixture(t);
  manager.socket.signalRepository = { lidMapping: { getLIDForPN: async () => null, getPNForLID: async () => null } };
  assert.deepEqual(await manager.resolveIdentityIds(other), [other]);
  assert.deepEqual(await manager.resolveIdentityIds(otherLid), [otherLid]);
  manager.socket.signalRepository.lidMapping.getLIDForPN = async () => otherLid;
  assert.deepEqual(await manager.resolveIdentityIds(other), [other]);
  await store.rememberIdentityPair(pn, '56922222222@s.whatsapp.net', '20000000000@lid');
  manager.socket.signalRepository.lidMapping.getLIDForPN = async () => { throw new Error('offline'); };
  assert.deepEqual(new Set(await manager.resolveIdentityIds('56922222222@s.whatsapp.net')), new Set(['56922222222@s.whatsapp.net', '20000000000@lid']));
});

test('a changed socket during lookup never publishes the previous authenticated identities', async t => {
  const { manager } = await fixture(t);
  manager.socket.signalRepository = { lidMapping: {
    getLIDForPN: async () => otherLid,
    getPNForLID: async () => { manager.socket = {}; return other; },
  } };
  assert.deepEqual(await manager.resolveIdentityIds(other), [other]);
  manager.socket = { user: { id: pn, lid } };
  const remember = manager.store.rememberIdentityPair.bind(manager.store);
  manager.store.rememberIdentityPair = async (...args) => { await remember(...args); manager.socket = {}; };
  assert.deepEqual(await manager.resolveIdentityIds(pn), [pn]);
});

test('internal identity lookup is restricted to WhatsApp instances and has no public action', async t => {
  const { root } = await fixture(t);
  const { ConnectionsService } = require('../../dist-electron/main/connections-service.js');
  const { getWhatsAppIdentityIds } = require('../../dist-electron/main/connections/modules/whatsapp/index.js');
  const { BUILT_IN_CONNECTION_MODULES } = require('../../dist-electron/main/connections/index.js');
  const service = new ConnectionsService({ metadataRoot: root, secretsStore: {} });
  assert.deepEqual(await service.resolveWhatsAppIdentityIds('missing', pn), [pn]);
  const configured = await service.configure({ type: 'whatsapp', label: 'test' });
  assert.deepEqual(await service.resolveWhatsAppIdentityIds(configured.instance.id, pn), [pn]);
  assert.deepEqual(await getWhatsAppIdentityIds({ metadataRoot: root }, pn), [pn]);
  const module = BUILT_IN_CONNECTION_MODULES.find(m => m.definition.type === 'whatsapp');
  assert.ok(!module.definition.actions.some(a => a.id.includes('identity')));
});
