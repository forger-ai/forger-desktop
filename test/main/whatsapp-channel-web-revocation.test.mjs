import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const until = async (check) => {
  for (let i = 0; i < 500; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('timed out');
};
const policy = { appIds: [], toolIds: [], connectionGrants: [], peerAgentIds: [], sharedMemoryIds: [], networkAccess: true };
const channel = { kind: 'whatsapp', connectionId: 'account', chatId: 'chat', bindingId: 'binding', revision: 1, allowAgentCapabilities: false, policy };

for (const action of ['disable', 'delete']) test(`global internet ${action} terminates a real active provider child before confirming save`, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-child-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadataRoot = path.join(root, 'meta');
  const codexHome = path.join(root, 'codex-home');
  await mkdir(codexHome);
  const cli = path.join(root, 'fake-provider.cjs');
  const receipt = path.join(root, 'launched.json');
  await writeFile(cli, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv));\nsetInterval(()=>{}, 1000);\n`, { mode: 0o755 });
  const store = new AgentStore({ metadataRoot, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'Test', networkAccess: true, runtime: { provider: 'codex', model: 'test', effort: 'low' } });
  const manager = new AgentConversationManager({ store, metadataRoot, codexHome, getCodexCliPath: async () => cli, getCodexAuthenticated: async () => true, getAgentRuntime: async () => agent.runtime });
  t.after(() => { for (const child of manager.activeChildren.values()) child.kill(); });
  const conversation = await manager.createWhatsAppConversation({ agentId: agent.id });
  const admitted = await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Search public facts', channel });
  await until(async () => { try { return (await readFile(receipt, 'utf8')).length > 0; } catch { return false; } });
  assert.ok(JSON.parse(await readFile(receipt, 'utf8')).includes('web_search="live"'));
  const child = manager.activeChildren.get(admitted.activeRun.id);
  assert.ok(child);
  if (action === 'delete') await store.deleteAgent(agent.id);
  else await store.updateAgentPermissions({ agentId: agent.id, networkAccess: false });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  if (action === 'delete') assert.equal(await store.getAgent(agent.id), null);
  else assert.equal((await store.getRun(admitted.activeRun.id)).status, 'canceled');
  await until(() => !manager.activeChildren.has(admitted.activeRun.id));
  if (action !== 'delete') assert.equal((await store.requireConversation(conversation.id)).messages.some(m => m.role === 'assistant'), false);
});

test('revocation observers are scoped, await cancellation, retain denied permission on failure and unsubscribe', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-observers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const a = await store.createAgent({ name: 'A', networkAccess: true });
  const b = await store.createAgent({ name: 'B', networkAccess: true });
  let calls = 0;
  const unsubscribe = store.onNetworkAccessRevoked(a.id, async () => { calls++; throw new Error('cancellation-unconfirmed'); });
  await store.updateAgentPermissions({ agentId: b.id, networkAccess: false });
  await store.updateAgentPermissions({ agentId: a.id, networkAccess: true });
  assert.equal(calls, 0);
  await assert.rejects(store.updateAgentPermissions({ agentId: a.id, networkAccess: false }), /cancellation-unconfirmed/);
  assert.equal((await store.requireAgent(a.id)).networkAccess, false);
  assert.equal(calls, 1);
  // A repeat denial retries a cancellation that could not be confirmed.
  await assert.rejects(store.updateAgentPermissions({ agentId: a.id, networkAccess: false }), /cancellation-unconfirmed/);
  assert.equal(calls, 2);
  unsubscribe();
  await store.updateAgentPermissions({ agentId: a.id, networkAccess: false });
  assert.equal(calls, 2);
});

test('revocation during preparation blocks launch and does not deadlock permission saving', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-preparing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'A', networkAccess: true });
  let release;
  let preparing = false;
  let runtimeCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const manager = new AgentConversationManager({ store, metadataRoot: root,
    getAgentRuntime: async () => { if (++runtimeCalls > 1) { preparing = true; await gate; } return { provider: 'codex', model: 'test' }; },
    runner: async () => { calls++; return { assistantText: 'Unexpected launch' }; },
  });
  const conversation = await manager.createWhatsAppConversation({ agentId: agent.id });
  const admitted = await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Search', channel });
  await until(() => preparing);
  const update = store.updateAgentPermissions({ agentId: agent.id, networkAccess: false });
  await until(async () => !(await store.requireAgent(agent.id)).networkAccess);
  release();
  await update;
  await until(async () => (await store.getRun(admitted.activeRun.id)).status === 'canceled');
  assert.equal(calls, 0);
});

test('repeated revocation retries stopping a provider already marked canceled after unconfirmed exit', async (t) => {
  const { EventEmitter } = await import('node:events');
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-cancel-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'A', networkAccess: true });
  let finish;
  const manager = new AgentConversationManager({ store, metadataRoot: root, runner: async () => await new Promise(resolve => { finish = resolve; }) });
  const conversation = await manager.createWhatsAppConversation({ agentId: agent.id });
  const admitted = await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Search', channel });
  await until(() => Boolean(finish));
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => true });
  manager.activeChildren.set(admitted.activeRun.id, child);
  const originalWait = manager.waitForChildExit.bind(manager);
  let stops = 0;
  manager.waitForChildExit = async target => {
    stops++;
    if (stops === 1) throw new Error('personal_agent_cancellation_unconfirmed');
    const waiting = originalWait(target);
    target.signalCode = 'SIGTERM';
    target.emit('exit');
    await waiting;
  };
  await assert.rejects(store.updateAgentPermissions({ agentId: agent.id, networkAccess: false }), /cancellation_unconfirmed/);
  assert.equal((await store.getRun(admitted.activeRun.id)).status, 'canceled');
  assert.equal(child.signalCode, null);
  await store.updateAgentPermissions({ agentId: agent.id, networkAccess: false });
  assert.equal(stops, 2);
  assert.equal(child.signalCode, 'SIGTERM');
  finish({ assistantText: 'Late result' });
  await until(() => store.networkRevocationListeners.size === 0);
  assert.equal((await store.requireConversation(conversation.id)).messages.some(m => m.role === 'assistant'), false);
});

test('revoking global internet leaves a concurrent default-off chat running', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-narrow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'A', networkAccess: true });
  const runs = [];
  const manager = new AgentConversationManager({ store, metadataRoot: root, runner: input => new Promise(resolve => runs.push({ input, resolve })) });
  const a = await manager.createWhatsAppConversation({ agentId: agent.id });
  const b = await manager.createWhatsAppConversation({ agentId: agent.id });
  await manager.sendWhatsAppMessage({ conversationId: a.id, content: 'Search', channel });
  await manager.sendWhatsAppMessage({ conversationId: b.id, content: 'Offline', channel: { ...channel, chatId: 'other', bindingId: 'other', policy: { ...policy, networkAccess: false } } });
  await until(() => runs.length === 2);
  await store.updateAgentPermissions({ agentId: agent.id, networkAccess: false });
  assert.equal((await store.requireConversation(a.id)).activeRun.status, 'canceled');
  assert.equal((await store.requireConversation(b.id)).activeRun.status, 'running');
  for (const run of runs) run.resolve({ assistantText: 'Finished' });
  await until(async () => (await store.requireConversation(b.id)).activeRun.status === 'completed');
});

test('saving already-denied global internet does not interrupt an offline answer with a stale checked chat policy', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-stale-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'A', networkAccess: false });
  let finish;
  const manager = new AgentConversationManager({ store, metadataRoot: root, runner: input => {
    assert.equal(input.agent.networkAccess, false);
    return new Promise(resolve => { finish = resolve; });
  } });
  const conversation = await manager.createWhatsAppConversation({ agentId: agent.id });
  await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Offline response', channel });
  await until(() => Boolean(finish));
  await store.updateAgentPermissions({ agentId: agent.id, networkAccess: false });
  assert.equal((await store.requireConversation(conversation.id)).activeRun.status, 'running');
  finish({ assistantText: 'Normal offline answer' });
  await until(async () => (await store.requireConversation(conversation.id)).activeRun.status === 'completed');
});

test('an admitted channel invalidated during preparation is checked again immediately before launch', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wa-web-prelaunch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AgentStore({ metadataRoot: root, forgerHomeRoot: root });
  const agent = await store.createAgent({ name: 'A', networkAccess: true });
  let release;
  let calls = 0;
  let current = true;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new AgentConversationManager({ store, metadataRoot: root,
    getAgentRuntime: async () => { if (++calls > 1) await gate; return { provider: 'codex', model: 'test' }; },
    runner: async () => { assert.fail('obsolete channel must not launch'); },
  });
  const conversation = await manager.createWhatsAppConversation({ agentId: agent.id });
  const admitted = await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Search', channel, isChannelCurrent: () => current });
  await until(() => calls > 1);
  current = false;
  release();
  await until(async () => (await store.getRun(admitted.activeRun.id)).status === 'failed');
  assert.match((await store.getRun(admitted.activeRun.id)).error, /channel_reconfigured/);
  assert.equal(manager.runPreparations.size, 0);
  // Cancellation may race a completed deletion between its initial lookup and lock acquisition.
  assert.equal(await manager.cancelRunUnlocked('run-removed-concurrently'), false);
});
