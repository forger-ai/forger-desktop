import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');
const { refreshWhatsAppChannelAccess } = require('../../dist-electron/main/forger-mcp/whatsapp-channel-access.js');
const tools = ['forger_list_app_prompts', 'forger_test_app_prompt', 'forger_list_installed_apps', 'forger_transcribe_audio', 'forger_translate_audio', 'forger_create_app'];
const harness = async () => {
  const calls = [];
  let throwReader = false;
  const agent = { appIds: ['shared-app'], toolIds: tools, connectionGrants: [], peerAgentGrants: [] };
  const server = new ForgerMcpServer({
    getAppVersion: () => 'test', getToolDefinitions: () => tools.map(id => ({ id, packageId: 'forger', name: id, description: id, category: 'consulta', risk: 'bajo', defaultRequiresApproval: false })),
    getToolSettings: () => ({ approvals: {} }), appendInstallLog: async () => {}, requestPermission: () => null,
    listConnectionGrantsForApp: async () => [],
    getWhatsAppChannelAgent: async () => { if (throwReader) throw new Error('PRIVATE_AUTHORITY_FAILURE'); return agent; },
    listAppPrompts: async appId => { calls.push(appId); return [{ content: appId === 'private-app' ? 'PRIVATE_PROMPT' : 'Shared prompt' }]; },
    testAppPrompt: async input => { calls.push(input.appId); return { success: true, valid: true }; },
    listInstalledApps: () => [{ id: 'shared-app', name: 'Shared', path: '/private/install-path' }, { id: 'private-app', name: 'PRIVATE_APP' }],
    processSpeechToText: async input => { calls.push(input.path); return { success: true, text: 'PRIVATE_AUDIO' }; },
  });
  await server.start();
  const session = server.createSession('run', 'forger', { caller: 'personal-agent', personalAgentId: 'agent', personalAgentConversationId: 'conversation', whatsappChannel: { kind: 'whatsapp', bindingId: 'binding', revision: 1, connectionId: 'account', chatId: 'chat', allowAgentCapabilities: true } });
  const request = async (method, params) => {
    const response = await fetch(session.url, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return response.json();
  };
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    return response.result ? JSON.parse(response.result.content[0].text) : response;
  };
  return { server, agent, calls, call, request, failReader: () => { throwReader = true; } };
};

test('selected platform app actions remain limited to explicitly shared apps', async t => {
  const f = await harness(); t.after(() => f.server.stop());
  for (const name of ['forger_list_app_prompts', 'forger_test_app_prompt']) {
    const result = await f.call(name, { appId: 'private-app', kind: 'agent', id: 'test' });
    assert.equal(result.success, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal((await f.call('forger_list_app_prompts', { appId: 'shared-app' })).success, true);
  assert.deepEqual(f.calls, ['shared-app']);
  const apps = await f.call('forger_list_installed_apps');
  assert.deepEqual(apps.apps.map(app => app.id), ['shared-app']);
  assert.equal(apps.apps[0].path, undefined);
});

test('unsupported platform actions cannot turn a selected tool into arbitrary private-file access', async t => {
  const f = await harness(); t.after(() => f.server.stop());
  for (const name of ['forger_transcribe_audio', 'forger_translate_audio']) {
    const result = await f.call(name, { path: '/private/secret.wav' });
    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'whatsapp_channel_tool_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUDIO|secret.wav/);
  }
  assert.deepEqual(f.calls, []);
  const list = await f.request('tools/list');
  assert.ok(!list.result.tools.some(tool => ['forger_transcribe_audio', 'forger_translate_audio', 'forger_create_app'].includes(tool.name)));
});

test('authority lookup failures erase cached permissions and produce a safe denial', async t => {
  const f = await harness(); t.after(() => f.server.stop());
  await f.call('forger_list_app_prompts', { appId: 'shared-app' });
  f.failReader();
  const result = await f.call('forger_list_app_prompts', { appId: 'shared-app' });
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_AUTHORITY_FAILURE/);
  assert.equal(f.calls.length, 1);
  const session = { whatsappChannel: {}, personalAgentId: 'agent', personalAgentConversationId: 'conversation', runId: 'run', appIds: ['cached'], forgerToolActionIds: ['cached'], connectionGrants: [{ type: 'gmail', actions: ['read'] }] };
  assert.equal(await refreshWhatsAppChannelAccess(session, async () => { throw new Error('failure'); }), false);
  assert.deepEqual(session.appIds, []);
  assert.deepEqual(session.forgerToolActionIds, []);
  assert.deepEqual(session.connectionGrants, []);
});

test('filtering channel app discovery preserves the owner view and original app records', () => {
  const { whatsAppChannelVisibleApps } = require('../../dist-electron/main/forger-mcp/whatsapp-channel-access.js');
  const apps = [{ id: 'shared', name: 'Shared', path: '/private/install' }, { id: 'private', name: 'Private' }];
  assert.equal(whatsAppChannelVisibleApps({ appIds: [] }, apps), apps);
  assert.deepEqual(whatsAppChannelVisibleApps({ whatsappChannel: {}, appIds: ['shared'] }, apps), [{ id: 'shared', name: 'Shared' }]);
  assert.equal(apps[0].path, '/private/install');
});
