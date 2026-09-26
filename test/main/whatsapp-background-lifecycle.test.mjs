import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConnectionsService } = require('../../dist-electron/main/connections-service.js');
const {
  startWhatsAppAgentChannel,
  initializeWhatsAppAgentChannel,
  createWhatsAppChannelHistoryReader,
  createWhatsAppChannelAgentReader,
} = require('../../dist-electron/main/core/whatsapp-agent-channel-startup.js');

test('a configured WhatsApp connection can start listening after the agent runtime is ready and stop before shutdown', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-whatsapp-lifecycle-'));
  const calls = [];
  const module = {
    definition: { type: 'whatsapp', displayName: 'WhatsApp', description: '', setupKind: 'qr_pairing', supportsMultiple: true, statusActionId: 'whatsapp.connection.status', secretsSchema: [], actions: [] },
    listInstances: async () => [],
    configure: async () => ({ success: true, userMessage: 'ok' }),
    disconnect: async () => ({ success: true, userMessage: 'ok' }),
    status: async () => ({ connected: false, status: 'needs_setup' }),
    execute: async () => ({ success: true, data: {} }),
    start: async () => { calls.push('start'); },
    stop: async () => { calls.push('stop'); },
  };
  const service = new ConnectionsService({ metadataRoot, modules: [module], secretsStore: {} });
  try {
    await service.load();
    assert.deepEqual(calls, []);
    await service.startType('whatsapp');
    await service.stopType('whatsapp');
    assert.deepEqual(calls, ['start', 'stop']);
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('WhatsApp channel startup keeps listening tied to successful initialization and closes on startup failure', async () => {
  const calls = [];
  const channel = {
    initialize: async () => calls.push('initialize'),
    handleLiveMessage: async () => undefined,
    close: () => calls.push('close'),
  };
  assert.equal(await startWhatsAppAgentChannel(undefined, null), null);
  assert.equal(await startWhatsAppAgentChannel(channel, null), channel);
  assert.deepEqual(calls, ['initialize']);

  await assert.rejects(
    startWhatsAppAgentChannel(channel, { startType: async () => { throw new Error('startup_failed'); } }),
    /startup_failed/,
  );
  assert.deepEqual(calls, ['initialize', 'initialize', 'close']);

  const state = { connectionsService: { startType: async (type) => calls.push(`start:${type}`) }, whatsappAgentChannelService: null };
  const logger = { step: async (_event, callback) => await callback() };
  await initializeWhatsAppAgentChannel(state, () => channel, logger, () => calls.push('failed'));
  assert.equal(state.whatsappAgentChannelService, channel);
  assert.equal(calls.at(-1), 'start:whatsapp');

  const reader = createWhatsAppChannelHistoryReader(() => ({ readChannelHistory: async (input) => input }));
  assert.deepEqual(await reader({ limit: 3 }), { limit: 3 });
  assert.equal(createWhatsAppChannelHistoryReader(undefined), undefined);
  const policyReader = createWhatsAppChannelAgentReader(() => ({ getCurrentPolicyAgent: async input => ({ agentId: input.agentId }) }));
  assert.deepEqual(await policyReader({ agentId: 'bound-agent' }), { agentId: 'bound-agent' });
  assert.equal(createWhatsAppChannelAgentReader(undefined), undefined);
});

test('WhatsApp startup forwards a live message to the channel service', async () => {
  const whatsappModule = require('../../dist-electron/main/connections/modules/whatsapp/index.js');
  const originalSetter = whatsappModule.setLiveWhatsAppMessageHandler;
  let handler;
  whatsappModule.setLiveWhatsAppMessageHandler = (next) => { handler = next; };
  try {
    const received = [];
    const channel = {
      initialize: async () => undefined,
      handleLiveMessage: async (input) => received.push(input),
    };
    await startWhatsAppAgentChannel(channel, null);
    const message = { text: 'Casa, consulta' };
    await handler({ connectionId: 'wa-1', message, newlyStored: true });
    assert.deepEqual(received, [{ connectionId: 'wa-1', message }]);
  } finally {
    whatsappModule.setLiveWhatsAppMessageHandler = originalSetter;
    originalSetter(null);
  }
});
