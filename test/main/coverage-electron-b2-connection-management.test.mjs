import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  executeConnectionManagementTool,
  getEffectiveConnectionGrants,
} = require('../../dist-electron/main/forger-mcp/connection-tools.js');
const {
  getWhatsAppPairingPresentation,
} = require('../../dist-electron/shared/connections-pairing.js');

const chatSession = (overrides = {}) => ({
  caller: 'chat',
  appId: 'desktop',
  locale: 'en',
  connectionGrants: [],
  ...overrides,
});

const createConnectionOptions = () => {
  const calls = [];
  const appGrants = [{ type: 'gmail', actions: ['gmail.connection.status'], multiple: false }];
  const state = {
    types: [{ type: 'gmail', name: 'Gmail' }, { type: 'slack', name: 'Slack' }],
    instances: [{ id: 'gmail-1', type: 'gmail' }, { id: 'slack-1', type: 'slack' }],
    grants: [
      { type: 'gmail', actions: ['gmail.connection.status'], multiple: false },
      { type: 'slack', actions: ['slack.connection.status'], multiple: false },
    ],
  };
  return {
    appGrants,
    calls,
    state,
    options: {
      listConnectionGrantsForApp: async (appId) => {
        calls.push(['listConnectionGrantsForApp', appId]);
        return appGrants;
      },
      listConnectionsForSession: async (grants) => {
        calls.push(['listConnectionsForSession', grants]);
        return state;
      },
      callConnectionFromSession: async (input, grants, access) => {
        calls.push(['callConnectionFromSession', input, grants, access]);
        return { success: true, data: { connected: true } };
      },
    },
  };
};

test('connection management resolves app grants and deduplicates explicit session grants', async () => {
  const harness = createConnectionOptions();
  const appSession = chatSession({ caller: 'app-agent', appId: 'finance' });
  assert.deepEqual(await getEffectiveConnectionGrants(appSession, harness.options), harness.appGrants);
  assert.deepEqual(harness.calls[0], ['listConnectionGrantsForApp', 'finance']);

  const explicit = await getEffectiveConnectionGrants(chatSession({
    connectionGrants: [
      { type: 'gmail', actions: ['gmail.messages.list'], multiple: false, connectionIds: ['gmail-1'] },
      { type: 'gmail', actions: ['gmail.connection.status'], multiple: true, connectionIds: ['gmail-1', 'gmail-2'] },
    ],
  }), harness.options);
  assert.deepEqual(explicit, [{
    type: 'gmail',
    actions: ['gmail.messages.list', 'gmail.connection.status'],
    multiple: true,
    connectionIds: ['gmail-1', 'gmail-2'],
  }]);
});

test('connection management lists all connections or filters a requested type', async () => {
  const harness = createConnectionOptions();
  const session = chatSession({ connectionGrants: harness.state.grants });

  assert.deepEqual(
    await executeConnectionManagementTool(session, 'forger_connection_list', { type: '   ' }, harness.options),
    { success: true, ...harness.state },
  );
  assert.deepEqual(
    await executeConnectionManagementTool(session, 'forger_connection_list', { type: ' gmail ' }, harness.options),
    {
      success: true,
      types: [harness.state.types[0]],
      instances: [harness.state.instances[0]],
      grants: [harness.state.grants[0]],
    },
  );
});

test('connection status validates type, forwards optional instance identity, and rejects unknown tools', async () => {
  const harness = createConnectionOptions();
  const session = chatSession({ locale: 'es', connectionGrants: harness.state.grants });

  assert.deepEqual(
    await executeConnectionManagementTool(session, 'forger_connection_status', { type: null }, harness.options),
    { success: false, userMessage: 'Connection type is required.', technicalCode: 'connection_type_required' },
  );

  assert.equal((await executeConnectionManagementTool(session, 'forger_connection_status', {
    type: ' gmail ',
    connectionId: ' gmail-1 ',
  }, harness.options)).success, true);
  assert.equal((await executeConnectionManagementTool(session, 'forger_connection_status', {
    type: 'slack',
    connectionId: ' ',
  }, harness.options)).success, true);

  const statusCalls = harness.calls.filter((call) => call[0] === 'callConnectionFromSession');
  assert.deepEqual(statusCalls[0].slice(1), [
    { type: 'gmail', actionId: 'gmail.connection.status', input: {}, connectionId: 'gmail-1' },
    harness.state.grants,
    { caller: 'chat', appId: 'desktop', locale: 'es' },
  ]);
  assert.deepEqual(statusCalls[1][1], {
    type: 'slack',
    actionId: 'slack.connection.status',
    input: {},
  });

  const unknown = await executeConnectionManagementTool(session, 'unknown_tool', {}, harness.options);
  assert.equal(unknown.success, false);
  assert.equal(unknown.technicalCode, 'tool_not_found');
  assert.equal(typeof unknown.userMessage, 'string');
});

test('WhatsApp pairing presentation normalizes every visible setup state', () => {
  assert.deepEqual(getWhatsAppPairingPresentation(null), { kind: 'idle' });
  assert.deepEqual(getWhatsAppPairingPresentation(undefined), { kind: 'idle' });

  assert.deepEqual(getWhatsAppPairingPresentation({
    success: false,
    userMessage: '  Pairing failed  ',
    technicalCode: 'pairing_failed',
  }), { kind: 'error', message: 'Pairing failed' });
  assert.deepEqual(getWhatsAppPairingPresentation({
    success: false,
    userMessage: ' ',
    technicalCode: ' qr_failed ',
  }), { kind: 'error', message: 'qr_failed' });
  assert.deepEqual(getWhatsAppPairingPresentation({ success: false, userMessage: null }), {
    kind: 'error',
    message: 'whatsapp_pairing_failed',
  });

  assert.deepEqual(getWhatsAppPairingPresentation({
    success: true,
    data: { qrDataUrl: ' data:image/png;base64,abc ', expiresAt: ' 2026-08-10T10:00:00Z ' },
  }), {
    kind: 'qr',
    qrDataUrl: 'data:image/png;base64,abc',
    expiresAt: '2026-08-10T10:00:00Z',
  });
  assert.deepEqual(getWhatsAppPairingPresentation({
    success: true,
    data: { qrDataUrl: 'data:image/png;base64,def', expiresAt: ' ' },
  }), { kind: 'qr', qrDataUrl: 'data:image/png;base64,def' });

  assert.deepEqual(getWhatsAppPairingPresentation({
    success: true,
    data: { pairingCode: ' 1234-5678 ', expiresAt: '2026-08-10T11:00:00Z' },
  }), {
    kind: 'pairing_code',
    pairingCode: '1234-5678',
    expiresAt: '2026-08-10T11:00:00Z',
  });
  assert.deepEqual(getWhatsAppPairingPresentation({
    success: true,
    data: { pairingCode: '8765-4321' },
  }), { kind: 'pairing_code', pairingCode: '8765-4321' });

  assert.deepEqual(getWhatsAppPairingPresentation({ success: true, data: { status: ' waiting ' } }), {
    kind: 'waiting',
    status: 'waiting',
  });
  assert.deepEqual(getWhatsAppPairingPresentation({ success: true, data: [] }), { kind: 'waiting' });
  assert.deepEqual(getWhatsAppPairingPresentation({ success: true, data: 'invalid' }), { kind: 'waiting' });
});
