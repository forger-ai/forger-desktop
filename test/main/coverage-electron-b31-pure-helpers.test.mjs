import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('BDD: remote agent heartbeats and disconnects reject unsafe identifiers and preserve safe aliases', () => {
  const heartbeat = require('../../dist-electron/main/cloud-device-personal-agents.js');
  const messages = require('../../dist-electron/main/cloud-device-message-normalizers.js');

  assert.deepEqual(heartbeat.normalizePersonalAgentHeartbeat({ ids: 'bad', agents: 'bad', count: Number.NaN }), {
    supported: false, count: 0, ids: [], agents: [], activeSessionRequestIds: [],
  });
  assert.deepEqual(heartbeat.normalizePersonalAgentHeartbeat({
    ids: [], count: Number.NaN, activeSessionRequestIds: [],
    agents: [null, { id: 'safe', name: 7 }, { id: '../bad', name: 'Bad' }, { id: 'safe', name: ' Safe ', description: 7 }],
  }), {
    supported: false, count: 1, ids: ['safe'], agents: [{ id: 'safe', name: 'Safe' }], activeSessionRequestIds: [],
  });
  assert.deepEqual(heartbeat.normalizePersonalAgentHeartbeat({ ids: ['one'], agents: null, count: 5 }), {
    supported: false, count: 1, ids: ['one'], agents: [{ id: 'one', name: 'one' }], activeSessionRequestIds: [],
  });

  assert.deepEqual(messages.normalizeAgentAccessRequest({
    request_id: '1', agent_id: 'agent', requestedByDeviceName: ' Phone ', agentName: ' Helper ',
  }), { requestId: '1', agentId: 'agent', agentName: 'Helper', requestedByDeviceName: 'Phone' });
  assert.equal(messages.normalizeAgentAccessDisconnectRequest({ agent_id: '../bad' }), null);
  assert.equal(messages.normalizeAgentAccessDisconnectRequest({ session_id: 'bad.session' }), null);
  assert.deepEqual(messages.normalizeAgentAccessDisconnectRequest({}), {});
  assert.deepEqual(messages.normalizeAgentAccessDisconnectRequest({ requestedByDeviceId: 7 }), { requestedByDeviceId: 7 });
});

test('BDD: small public helpers retain conservative defaults at malformed boundaries', async () => {
  const { buildCodexAuthEnvironment } = require('../../dist-electron/main/codex-auth-helpers.js');
  const { assertAllowedMcpServers } = require('../../dist-electron/main/codex-run-isolation.js');
  const { normalizeConnectionStatus } = require('../../dist-electron/main/connections/status.js');
  const { parseSendInput } = require('../../dist-electron/main/connections/modules/gmail/mime.js');
  const jsonl = require('../../dist-electron/main/app-agent/jsonl.js');
  const { hydratePersistedPersonalAgentRuns } = require('../../dist-electron/main/llm-runs-hydration.js');

  assert.equal(buildCodexAuthEnvironment({ codexHome: '/codex', codexCliPath: '/bin/codex', nodePathEntries: [], baseEnv: {}, delimiter: ':' }).PATH, '/bin');
  assert.doesNotThrow(() => assertAllowedMcpServers('{"type":"other"}\n{}', '', new Set()));
  assert.doesNotThrow(() => assertAllowedMcpServers('{"item":{"type":"mcp_tool_call","server":42}}', '', new Set()));
  assert.deepEqual(normalizeConnectionStatus(null), { connected: false, status: 'needs_setup' });
  assert.deepEqual(normalizeConnectionStatus({ connected: true, message: '', technicalCode: '', capabilities: [] }), {
    connected: true, status: 'connected', capabilities: [],
  });
  assert.deepEqual(normalizeConnectionStatus({ message: 'Connect', technicalCode: 'setup_required' }), {
    connected: false, status: 'needs_setup', message: 'Connect', technicalCode: 'setup_required',
  });
  assert.equal(parseSendInput({ to: ['a@example.com'], subject: 42, body: 'Hi', attachments: [{}] }), null);
  assert.deepEqual(parseSendInput({ to: ['a@example.com'], subject: 'Hi', body: 'Body', attachments: [{}] }), {
    to: ['a@example.com'], subject: 'Hi', body: 'Body',
  });
  assert.equal(jsonl.parseCodexTaskJsonl('first\nsecond', ''), 'first\nsecond');
  assert.equal(jsonl.parseClaudeTaskJsonl('first\nsecond', ''), 'first\nsecond');
  assert.deepEqual(jsonl.parseClaudeConversationJsonl('first\nsecond', ''), { assistantText: 'first\nsecond', threadId: undefined });

  let listed = false;
  await hydratePersistedPersonalAgentRuns({
    agentStore: { listAgents: async () => { listed = true; return []; } },
    llmRunsStore: { recordPersonalAgentConversationEvent: () => assert.fail('no run should be emitted') },
  });
  assert.equal(listed, true);
});

test('BDD: account persistence accepts camel-case API payloads and remains logged out without a token', async () => {
  const { ForgerAccountStore, normalizeForgerAccountUser, publicForgerAccount } = require('../../dist-electron/main/forger-account-store.js');
  assert.equal(normalizeForgerAccountUser({ id: 1, email: 42 }), undefined);
  assert.equal(normalizeForgerAccountUser({ id: 1, email: 'snake@example.com', display_name: 'Snake Name' }).displayName, 'Snake Name');
  const user = normalizeForgerAccountUser({
    id: '7', email: 'person@example.com', displayName: 'Person', firstName: 'First', last_name: 'Last',
    subscriptionTier: 'pro', usernameChangedAt: 'then', username_change_available_at: 'later',
  });
  assert.deepEqual(user, {
    id: 7, email: 'person@example.com', username: undefined, firstName: 'First', lastName: 'Last',
    confirmed: false, subscriptionTier: 'pro', usernameChangedAt: 'then', usernameChangeAvailableAt: 'later', displayName: 'Person',
  });
  assert.deepEqual(publicForgerAccount({ authenticated: true, confirmationRequired: true, user }), {
    authenticated: false, confirmationRequired: true, user,
  });

  const root = await mkdtemp(path.join(tmpdir(), 'forger-b31-account-'));
  const filePath = path.join(root, 'account.json');
  const store = new ForgerAccountStore(filePath);
  await store.save({ authenticated: true, user });
  assert.equal(JSON.parse(await readFile(filePath, 'utf8')).authenticated, true);
  assert.equal((await store.load()).authenticated, false);
  await store.clear();
  await rm(root, { recursive: true, force: true });
});

test('BDD: encryption refuses absent session keys through both public entry points', () => {
  const { RemoteSessionCrypto } = require('../../dist-electron/main/remote-crypto.js');
  const crypto = new RemoteSessionCrypto();
  assert.throws(() => crypto.encrypt('session', {}), /remote_session_key_missing/);
  assert.throws(() => crypto.encryptForKey('session', 'missing', {}), /remote_session_key_missing/);
});

test('BDD: manifest prompts support templates without variables and validate declared replacements', () => {
  const { renderManifestAgentPrompt } = require('../../dist-electron/main/manifest-agent-prompts.js');
  assert.equal(renderManifestAgentPrompt({
    agent: { id: 'helper', prompts: { initial: { body: 'No variables.' } } }, kind: 'initial', appRoot: '/app',
  }), 'No variables.');
  assert.equal(renderManifestAgentPrompt({
    agent: { id: 'helper', prompts: { initial: { body: 'Hello {{ name }}', variables: { name: { type: 'string', required: false } } } } },
    kind: 'initial', appRoot: '/app', variables: { name: 'World' },
  }), 'Hello World');
});

test('BDD: personal-agent spawn responses are localized and omit blank optional fields', async () => {
  const { executePersonalAgentSpawnTool } = require('../../dist-electron/main/forger-mcp/personal-agent-spawn-tool.js');
  const denied = await executePersonalAgentSpawnTool({ caller: 'app-agent', locale: 'en-US' }, {}, {});
  assert.equal(denied.userMessage, 'This agent does not have permission to create other agents.');
  const base = { caller: 'personal-agent', personalAgentId: 'creator', personalAgentCanSpawnAgents: true, locale: 'en' };
  assert.equal((await executePersonalAgentSpawnTool(base, { name: ' ' }, { createPersonalAgentFromAgent: async () => ({}) })).userMessage, 'Give the new agent a name.');
  assert.equal((await executePersonalAgentSpawnTool({ ...base, locale: 'es' }, { name: ' ' }, { createPersonalAgentFromAgent: async () => ({}) })).userMessage, 'Indica un nombre para el nuevo agente.');
  const inputs = [];
  const created = { id: 'child', name: 'Child' };
  const success = await executePersonalAgentSpawnTool({ ...base, locale: 'es' }, { name: ' Child ', description: ' ' }, {
    createPersonalAgentFromAgent: async (input) => { inputs.push(input); return created; },
  });
  assert.deepEqual(inputs, [{ creatorAgentId: 'creator', name: 'Child' }]);
  assert.equal(success.userMessage, 'Child fue creado y agregado a tus agentes disponibles.');
  await executePersonalAgentSpawnTool(base, {
    name: 'Child', description: 'Description', purpose: 'Purpose', instructions: 'Instructions', groupId: 'team',
  }, {
    createPersonalAgentFromAgent: async (input) => { inputs.push(input); return created; },
  });
  assert.deepEqual(inputs[1], {
    creatorAgentId: 'creator', name: 'Child', description: 'Description', purpose: 'Purpose', instructions: 'Instructions', groupId: 'team',
  });
});
