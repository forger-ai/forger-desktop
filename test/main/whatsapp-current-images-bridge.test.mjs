import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConnectionsService } = require('../../dist-electron/main/connections-service.js');
const { WhatsAppLocalStore } = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
const { normalizeBaileysMessage, encodeStableMessageRef } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');

test('the internal image bridge resolves only the configured WhatsApp account and preserves current-message scope', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-image-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'connections.json'), JSON.stringify({ version: 1,
    instances: { wa: { id: 'wa', type: 'whatsapp', label: 'Synthetic', status: 'connected' }, other: { id: 'other', type: 'gmail' } },
    defaults: { whatsapp: 'wa' }, appGrants: {}, agentGrants: {},
  }));
  const service = new ConnectionsService({ metadataRoot: root, secretsStore: {} });
  for (const id of ['missing', 'other']) {
    const result = await service.readWhatsAppCurrentImages(id, 'chat', 'reference', async () => true);
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'whatsapp_current_images_connection_unavailable');
    assert.equal(await service.hasWhatsAppCurrentImage(id, 'chat', 'reference'), false);
  }
  const unavailable = new ConnectionsService({ metadataRoot: root, secretsStore: {}, modules: [] });
  assert.equal((await unavailable.readWhatsAppCurrentImages('wa', 'chat', 'reference', async () => true)).success, false);
  assert.equal(await unavailable.hasWhatsAppCurrentImage('wa', 'chat', 'reference'), false);

  const store = new WhatsAppLocalStore(path.join(root, 'connections', 'whatsapp', 'wa'));
  const message = normalizeBaileysMessage({ key: { remoteJid: 'chat', id: 'current', fromMe: false }, message: { conversation: '@Kupita hola' } });
  await store.upsertMessages([message]);
  const ref = encodeStableMessageRef(message.stableMessageRef);
  assert.equal(await service.hasWhatsAppCurrentImage('wa', 'chat', ref), false);
  const photo = normalizeBaileysMessage({ key: { remoteJid: 'chat', id: 'photo', fromMe: false }, message: { imageMessage: { caption: '@Kupita qué opinas?', mimetype: 'image/png' } } });
  await store.upsertMessages([photo]);
  const photoRef = encodeStableMessageRef(photo.stableMessageRef);
  assert.equal(await service.hasWhatsAppCurrentImage('wa', 'chat', photoRef), true);
  assert.equal(await service.hasWhatsAppCurrentImage('wa', 'another-chat', photoRef), false);
  assert.equal(await service.hasWhatsAppCurrentImage('wa', 'chat', 'missing'), false);
  const current = await service.readWhatsAppCurrentImages(' wa ', 'chat', ref, async () => true);
  assert.equal(current.technicalCode, 'whatsapp_current_images_missing');
  const foreign = await service.readWhatsAppCurrentImages('wa', 'another-chat', ref, async () => true);
  assert.equal(foreign.technicalCode, 'whatsapp_current_images_not_found');
  let checks = 0;
  const revoked = await service.readWhatsAppCurrentImages('wa', 'chat', ref, async () => { checks++; return false; });
  assert.equal(revoked.success, false);
  assert.equal(revoked.images, undefined);
  assert.equal(checks, 1);
  await service.stopType('whatsapp');
});
