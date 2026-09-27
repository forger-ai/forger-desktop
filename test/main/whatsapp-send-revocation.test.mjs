import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
const { WhatsAppAgentOutbox } = require('../../dist-electron/main/personal-agents/whatsapp-channel/outbox.js');
const { WhatsAppRepositoryTransport } = require('../../dist-electron/main/repository-collaboration/whatsapp-transport.js');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const boundary of ['startup', 'quote']) {
  test(`revocation during WhatsApp ${boundary} suppresses sending at the final socket boundary`, async () => {
    const reached = deferred(); const release = deferred(); let allowed = true; let sends = 0;
    const pause = async () => { reached.resolve(); await release.promise; };
    const manager = new WhatsAppConnectionManager({
      getChat: async () => ({}), canSendNow: async () => true,
      readMessages: async () => { if (boundary === 'quote') await pause(); return []; },
      rememberSend: async () => {},
    });
    manager.ensureStarted = async () => { if (boundary === 'startup') await pause(); };
    manager.socket = { sendMessage: async () => { sends++; return null; } };
    const pending = manager.sendMessage({ authorizeWhatsAppSend: async () => allowed }, {
      chatId: 'group@g.us', text: 'private result', replyToMessageId: 'origin',
    });
    await reached.promise; allowed = false; release.resolve();
    const result = await pending;
    assert.equal(sends, 0);
    assert.equal(result.technicalCode, 'whatsapp_send_authorization_revoked');
    assert.deepEqual(result.data, { deliveryState: 'not_sent', retryable: false });
  });
}

test('repository send propagates live permission to the host transport boundary', async () => {
  let checks = 0;
  const transport = new WhatsAppRepositoryTransport({ call: async (_input, options) => {
    assert.equal(typeof options?.authorizeWhatsAppSend, 'function');
    assert.equal(await options.authorizeWhatsAppSend(), false);
    return { success: false, technicalCode: 'whatsapp_send_authorization_revoked' };
  } });
  await assert.rejects(transport.sendMessage({ connectionId: 'account', chatId: 'group@g.us', text: 'private',
    canSend: async () => ++checks === 1,
  }));
  assert.equal(checks, 2);
});

for (const change of ['pause', 'policy', 'cancel', 'close', 'delete', 'missing', 'revision', 'delivery', 'none']) {
  test(`personal-channel ${change} during transport preparation revokes the final send`, async () => {
    const reached = deferred(); const release = deferred(); let authorized = 'unchecked'; let deleted = false; let missing = false;
    const binding = { enabled: true, configurationVersion: 1 };
    const request = { connectionId: 'account', chatId: 'group@g.us', agentId: 'agent', requestId: 'request',
      deliveryState: 'pending', responseText: 'private', revision: 1, retryAt: 0, status: 'completed' };
    const outbox = new WhatsAppAgentOutbox({
      listActivity: () => missing ? [] : [request], getBinding: () => deleted ? undefined : binding, nextSendAt: () => 0,
      updateRequest: (_id, value) => Object.assign(request, value),
      claimDelivery: () => {}, reserveSend: () => {}, markDelivery: () => {}, markTurnStatus: () => {},
    }, { sendReply: async (input) => {
      reached.resolve(); await release.promise;
      authorized = input.authorizeSend ? await input.authorizeSend() : true;
      return { sent: false, definiteFailure: true, retryable: false };
    } });
    try {
      const pending = outbox.flushAccount('account'); await reached.promise;
      if (change === 'pause') binding.enabled = false;
      if (change === 'policy') binding.configurationVersion++;
      if (change === 'cancel') request.status = 'canceled';
      if (change === 'close') outbox.close();
      if (change === 'delete') deleted = true;
      if (change === 'missing') missing = true;
      if (change === 'revision') request.revision++;
      if (change === 'delivery') request.deliveryState = 'failed';
      release.resolve(); await pending; assert.equal(authorized, change === 'none');
    } finally { outbox.close(); }
  });
}

test('final authorization permits a current send and callback failure never sends', async () => {
  let sends = 0;
  const manager = new WhatsAppConnectionManager({ getChat: async () => ({}), canSendNow: async () => true, rememberSend: async () => {} });
  manager.ensureStarted = async () => {};
  manager.socket = { sendMessage: async () => { sends++; return null; } };
  await manager.sendMessage({ authorizeWhatsAppSend: async () => true }, { chatId: 'group@g.us', text: 'authorized' });
  assert.equal(sends, 1);
  await assert.rejects(manager.sendMessage({ authorizeWhatsAppSend: async () => { throw Error('authority unavailable'); } }, { chatId: 'group@g.us', text: 'withheld' }), /authority unavailable/);
  assert.equal(sends, 1);
});

test('live group intake strips device suffixes while preserving identity namespaces and rejecting malformed senders', async () => {
  const received = [];
  const manager = new WhatsAppConnectionManager({
    upsertMessages: async () => [], upsertChat: async () => {}, isKnownOutboundMessageRef: async () => false,
  }, { onLiveMessage: async (message) => received.push(message) });
  manager.resolveIdentityIds = async id => [id];
  for (const [index, participant] of ['123:4@s.whatsapp.net', '123:9@lid', 'not-a-user', '123@evil.net'].entries()) {
    await manager.ingestUpsert({ type: 'notify', messages: [{
      key: { remoteJid: 'group@g.us', id: `sender-${index}`, fromMe: false, participant },
      message: { conversation: 'Forger, Project: review' }, messageTimestamp: 12345,
    }] });
  }
  assert.deepEqual(received.map(message => message.senderId), ['123@s.whatsapp.net', '123@lid', undefined, undefined]);
});

test('a reply reference from another chat never reaches the WhatsApp socket', async () => {
  const { encodeStableMessageRef } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');
  let sends = 0;
  const manager = new WhatsAppConnectionManager({ getChat: async () => ({}), canSendNow: async () => true });
  manager.ensureStarted = async () => {};
  manager.socket = { sendMessage: async () => { sends++; } };
  await assert.rejects(manager.sendMessage({}, { chatId: 'selected@g.us', text: 'reply',
    replyToMessageRef: encodeStableMessageRef({ remoteJid: 'private@g.us', id: 'other-chat', fromMe: false }),
  }), /whatsapp_reply_chat_mismatch/);
  assert.equal(sends, 0);
});
