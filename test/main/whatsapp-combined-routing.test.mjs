import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { dispatchLiveWhatsAppMessage } = require('../../dist-electron/main/connections/modules/whatsapp/live-routing.js');
const base = { chatId: 'group@g.us', isGroup: true, senderId: '123@s.whatsapp.net', stableMessageRef: { id: 'm1' }, timestamp: 10, text: 'Forger, Repo: ask @helper to review', fromMe: false };

test('one live message reaches repository collaboration or a personal agent, never both', async () => {
  const received = []; const agents = [];
  const input = { connectionId: 'account', message: base, newlyStored: true, onRepositoryMessage: async (message) => { received.push(message); return true; }, onAgentMessage: async (message) => agents.push(message) };
  await dispatchLiveWhatsAppMessage(input);
  assert.equal(received.length, 1); assert.equal(agents.length, 0);
  assert.equal(received[0].timestamp, 10000); assert.equal(received[0].identityVerified, true);
  await dispatchLiveWhatsAppMessage({ ...input, message: { ...base, text: '@helper review this', replyToMessageId: 'previous' }, onRepositoryMessage: async () => false });
  assert.equal(agents.length, 1); assert.equal(agents[0].message.replyToMessageId, 'previous');
});

test('direct, incomplete and automated messages cannot become repository work; ordinary agent routing remains available', async () => {
  let repositories = 0; let agents = 0;
  for (const message of [{ ...base, isGroup: false }, { ...base, senderId: undefined }, { ...base, timestamp: undefined }, { ...base, text: undefined }]) {
    await dispatchLiveWhatsAppMessage({ connectionId: 'account', message, newlyStored: false, onRepositoryMessage: async () => { repositories++; return true; }, onAgentMessage: async () => { agents++; } });
  }
  assert.equal(repositories, 0); assert.equal(agents, 4);
  await dispatchLiveWhatsAppMessage({ connectionId: 'account', message: base, newlyStored: true });
});

test('repository routing errors fail closed instead of sending the same request to a different agent', async () => {
  await assert.rejects(dispatchLiveWhatsAppMessage({ connectionId: 'account', message: base, newlyStored: true, onRepositoryMessage: async () => { throw Error('routing unavailable'); }, onAgentMessage: async () => assert.fail('must not fall through') }), /routing unavailable/);
});

test('configured groups reserve explicit repository commands while ordinary, unknown and offline routing remains unclaimed', async () => {
  const { RepositoryCollaborationService } = require('../../dist-electron/main/repository-collaboration/service.js');
  const service = Object.create(RepositoryCollaborationService.prototype);
  let calls = 0; let configured = false;
  service.started = false;
  service.store = { findGroup: () => configured ? { enabled: false } : undefined };
  service.handleMessage = async () => { calls++; };
  const message = { live: true, connectionId: 'account', chatId: 'group', text: 'Forger, Repo: request for @Forger' };
  assert.equal(await service.routeMessage(message), false);
  service.started = true;
  assert.equal(await service.routeMessage(message), false);
  configured = true;
  assert.equal(await service.routeMessage({ ...message, text: '@helper hello' }), false);
  assert.equal(await service.routeMessage({ ...message, live: false }), false);
  assert.equal(await service.routeMessage(message), true);
  assert.equal(calls, 1);
});
