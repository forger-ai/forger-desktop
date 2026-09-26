import assert from 'node:assert/strict';
import test from 'node:test';
import { registerWhatsAppAgentChannelIpcHandlers } from '../../dist-electron/main/ipc/whatsapp-agent-channel-handlers.js';
import { IPC_CHANNELS } from '../../dist-electron/shared/ipc.js';

const fixture = () => {
  const handlers = new Map();
  const calls = [];
  const service = Object.fromEntries(['listActivity', 'setEnabled', 'cancelRequest', 'retryDelivery', 'dismissRequest', 'updateAlias', 'getPolicyOptions', 'putBinding']
    .map((name) => [name, async (...args) => { calls.push([name, ...args]); return name; }]));
  registerWhatsAppAgentChannelIpcHandlers({ IPC_CHANNELS, ipcMain: { handle: (id, handler) => handlers.set(id, handler) }, getWhatsAppAgentChannelService: () => service });
  return { calls, invoke: (name, input) => {
    assert.equal(typeof handlers.get(IPC_CHANNELS[name]), 'function', `missing IPC ${name}`);
    return handlers.get(IPC_CHANNELS[name])(null, input);
  } };
};
const key = { connectionId: 'account', agentId: 'agent', chatId: 'chat' };

test('Desktop exposes activity and local recovery actions with validated request identities', async () => {
  const f = fixture();
  await f.invoke('personalAgentWhatsAppActivityList', key);
  await f.invoke('personalAgentWhatsAppBindingSetEnabled', { ...key, enabled: false, expectedConfigurationVersion: 3 });
  for (const [api, method] of [['RequestCancel', 'cancelRequest'], ['DeliveryRetry', 'retryDelivery'], ['RequestDismiss', 'dismissRequest']]) {
    await f.invoke(`personalAgentWhatsApp${api}`, { ...key, requestId: 'req', ownerId: 'spoofed' });
    assert.deepEqual(f.calls.at(-1), [method, key, 'req']);
  }
  assert.deepEqual(f.calls[0], ['listActivity', key]);
  assert.deepEqual(f.calls[1], ['setEnabled', key, false, 3]);
  await f.invoke('personalAgentWhatsAppAliasUpdate', { connectionId: 'account', agentId: 'agent', alias: ' Ana ' });
  assert.deepEqual(f.calls.at(-1), ['updateAlias', 'account', 'agent', 'Ana']);
  await f.invoke('personalAgentWhatsAppPolicyOptionsGet', { agentId: 'agent' });
  assert.deepEqual(f.calls.at(-1), ['getPolicyOptions', 'agent']);
});

test('Malformed recovery commands never reach the channel service', async () => {
  const f = fixture();
  for (const [api, input] of [
    ['ActivityList', null], ['RequestCancel', { ...key, requestId: '' }], ['DeliveryRetry', { ...key, requestId: 4 }],
    ['RequestDismiss', { ...key, chatId: '../', requestId: null }],
    ['BindingSetEnabled', { ...key, enabled: 'yes' }], ['BindingSetEnabled', { ...key, enabled: true, expectedConfigurationVersion: -1 }],
    ['AliasUpdate', null], ['AliasUpdate', { connectionId: 'account', agentId: 'agent', alias: 'Ana\nOFF' }],
    ['PolicyOptionsGet', null],
  ]) await assert.rejects(async () => f.invoke(`personalAgentWhatsApp${api}`, input), /whatsapp_agent_invalid_input/);
  assert.deepEqual(f.calls, []);
});

test('Channel configuration forwards explicit grants and its own revision, never injected owner fields', async () => {
  const f = fixture();
  const policy = { appIds: ['app'], toolIds: [], connectionGrants: [{ type: 'slack', actions: ['slack.read'], multiple: false, connectionIds: ['slack-1'] }],
    peerAgentIds: [], networkAccess: false, sharedMemoryIds: ['memory'], sharedFiles: [{ id: 'imported', path: 'files/example.txt', name: 'example.txt' }] };
  const input = { ...key, alias: 'Ana', enabled: true, purpose: 'Help', scope: '', participantsAllowed: [], allowAgentCapabilities: true,
    expectedConfigurationVersion: 4, policy };
  await f.invoke('personalAgentWhatsAppBindingPut', { ...input, ownerId: 'spoofed' });
  assert.deepEqual(f.calls[0], ['putBinding', input]);
  for (const invalid of [null, { ...policy, networkAccess: 'yes' }, { ...policy, appIds: [1] }, { ...policy, sharedFiles: [{ path: '/etc/passwd' }] },
    { ...policy, connectionGrants: [{ type: 'slack', actions: [], multiple: 'yes' }] }]) {
    await assert.rejects(async () => f.invoke('personalAgentWhatsAppBindingPut', { ...input, policy: invalid }), /whatsapp_agent_invalid_input/);
  }
  assert.equal(f.calls.length, 1);
});

test('Policy rejects oversized and malformed selections and normalizes imported file metadata', async () => {
  const { validateWhatsAppChannelPolicy } = await import('../../dist-electron/main/ipc/whatsapp-channel-policy-input.js');
  const policy = { appIds: [], toolIds: [], peerAgentIds: [], networkAccess: false, sharedMemoryIds: [], connectionGrants: [] };
  for (const bad of [[], false, { ...policy, connectionGrants: {} }, { ...policy, connectionGrants: Array(65).fill({}) }, { ...policy, sharedFiles: {} }, { ...policy, sharedFiles: Array(65).fill({}) }, { ...policy, appIds: Array(129).fill('app') }, { ...policy, appIds: [''] }, { ...policy, appIds: ['x'.repeat(257)] }, { ...policy, connectionGrants: [null] }]) assert.throws(() => validateWhatsAppChannelPolicy(bad), /whatsapp_agent_invalid_input/);
  for (const bad of [null, { id: 'f', path: 'x', name: '' }, ...['/etc/file', 'a\\b', 'c:file', 'a/../b', 'a/./b', 'a//b'].map(path => ({ id: 'f', path }))]) assert.throws(() => validateWhatsAppChannelPolicy({ ...policy, sharedFiles: [bad] }), /whatsapp_agent_invalid_input/);
  const files = [{ id: ' f ', path: 'docs/file', relativePath: 'docs/file', name: ' File ', sizeBytes: 0, source: 'attached', modifiedAt: 'today' }, { id: 'g', path: 'file', sizeBytes: -1, source: 'mentioned' }, { id: 'h', path: 'file', sizeBytes: 1.5 }, { id: 'i', path: 'file', sizeBytes: '1' }];
  const normalized = validateWhatsAppChannelPolicy({ ...policy, appIds: [' a ', 'a'], sharedFiles: files, connectionGrants: [{ type: 'slack', actions: [], multiple: false }] });
  assert.deepEqual(normalized.appIds, ['a']);
  assert.equal(normalized.sharedFiles[0].name, 'File');
  assert.equal(normalized.sharedFiles[0].sizeBytes, 0);
  assert.equal(normalized.sharedFiles[1].sizeBytes, undefined);
  const f = fixture();
  await f.invoke('personalAgentWhatsAppBindingSetEnabled', { ...key, enabled: false });
  for (const version of ['1', 1.5]) await assert.rejects(async () => f.invoke('personalAgentWhatsAppBindingSetEnabled', { ...key, enabled: false, expectedConfigurationVersion: version }));
});

test('minimal explicit policy remains valid with no shared files', async () => {
  const { validateWhatsAppChannelPolicy } = await import('../../dist-electron/main/ipc/whatsapp-channel-policy-input.js');
  const policy = { appIds: [], toolIds: [], peerAgentIds: [], networkAccess: false, sharedMemoryIds: [], connectionGrants: [] };
  assert.deepEqual(validateWhatsAppChannelPolicy(policy), policy);
});
