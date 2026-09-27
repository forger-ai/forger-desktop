import assert from 'node:assert/strict';
import test from 'node:test';
import { refreshWhatsAppChannelAccess, whatsAppChannelToolAllowed } from '../../dist-electron/main/forger-mcp/whatsapp-channel-access.js';

const channelSession = () => ({ caller: 'personal-agent', personalAgentId: 'agent', personalAgentConversationId: 'conv', runId: 'run',
  whatsappChannel: { kind: 'whatsapp', connectionId: 'account', chatId: 'chat', bindingId: 'binding', revision: 2, allowAgentCapabilities: true },
  appIds: ['old-app'], forgerToolActionIds: ['memory_list'], officialToolActionIds: ['memory_list'], connectionGrants: [] });
const current = { appIds: ['current-app'], toolIds: ['forger_chrome_extension.get_page'], connectionGrants: [{ type: 'slack', actions: ['slack.read'], connectionIds: ['slack-1'] }], peerAgentGrants: [{ agentId: 'peer' }] };

test('Channel actions revalidate live state and discard revoked snapshot permissions', async () => {
  const session = channelSession();
  const calls = [];
  assert.equal(await refreshWhatsAppChannelAccess(session, async input => { calls.push(input); return current; }), true);
  assert.deepEqual(session.appIds, ['current-app']);
  assert.equal(whatsAppChannelToolAllowed(session, 'memory_list'), false);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_chrome_extension.get_page'), true);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_delete_app'), false);
  assert.equal(whatsAppChannelToolAllowed(session, 'slack.read'), true);
  assert.equal(whatsAppChannelToolAllowed(session, 'slack.write'), false);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_ask_agent', { targetAgentId: 'peer' }), true);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_ask_agent', { targetAgentId: 'stranger' }), false);
  assert.equal(calls[0].runId, 'run');
  assert.equal(await refreshWhatsAppChannelAccess(session, async () => null), false);
  assert.deepEqual(session.appIds, []);
  assert.equal(whatsAppChannelToolAllowed(session, 'slack.read'), false);
});

test('Missing authority fails closed for channel sessions, ordinary sessions keep their contract', async () => {
  for (const change of [{}, { personalAgentId: undefined }, { personalAgentConversationId: undefined }]) {
    const session = { ...channelSession(), ...change };
    assert.equal(await refreshWhatsAppChannelAccess(session, undefined), false);
  }
  const ordinary = { ...channelSession(), whatsappChannel: undefined };
  assert.equal(await refreshWhatsAppChannelAccess(ordinary), true);
  assert.equal(whatsAppChannelToolAllowed(ordinary, 'memory_list'), true);
});

test('thread continuation proceeds to scoped thread lookup only when a peer remains granted', async () => {
  const session = channelSession();
  await refreshWhatsAppChannelAccess(session, async () => current);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_ask_agent', { threadId: 'own' }), true);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_ask_agent', { threadId: ' ' }), false);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_ask_agent', {}), false);
  await refreshWhatsAppChannelAccess(session, async () => null);
  assert.equal(whatsAppChannelToolAllowed(session, 'forger_ask_agent', { threadId: 'own' }), false);
});
