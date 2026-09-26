import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const channel = { kind: 'whatsapp', connectionId: 'connection-1', chatId: 'group-1', bindingId: 'binding-1', revision: 3, allowAgentCapabilities: false };

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const waitFor = async (manager, conversationId, predicate) => {
  let last;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const conversation = await manager.getConversation(conversationId);
    last = conversation;
    if (predicate(conversation)) return conversation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for a personal agent run: ${last?.activeRun?.status} ${last?.activeRun?.error ?? ''}`);
};

const setup = async (runner, origin = 'user', options = {}) => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-steer-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-steer-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const manager = new AgentConversationManager({ store, runner, ...options });
  const agent = await store.createAgent({ name: 'Steer test agent' });
  const conversation = origin === 'whatsapp'
    ? await manager.createWhatsAppConversation({ agentId: agent.id })
    : await manager.createConversation({ agentId: agent.id });
  return { store, manager, conversation };
};

test('personal agent steer cancels the expected run and resumes in the same conversation with WhatsApp source', async () => {
  const oldRun = deferred();
  const oldStarted = deferred();
  const seenChannels = [];
  let runsStarted = 0;
  const { manager, conversation } = await setup(async ({ onProgress, mcpContext }) => {
    seenChannels.push(mcpContext.channel);
    runsStarted += 1;
    if (runsStarted === 1) {
      oldStarted.resolve();
      await oldRun.promise;
      onProgress('Stale progress');
      return { assistantText: 'Stale final' };
    }
    return { assistantText: 'Updated final' };
  }, 'whatsapp');
  let firstRunId;
  const first = await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Original task', channel });
  firstRunId = first.activeRun.id;
  await oldStarted.promise;

  const steered = await manager.steerMessage({
    conversationId: conversation.id,
    expectedRunId: firstRunId,
    content: 'Updated task',
    source: 'whatsapp',
    channel,
  });
  assert.notEqual(steered.activeRun.id, firstRunId);
  assert.equal(steered.messages.at(-1).source, 'whatsapp');
  assert.equal(steered.messages.at(-1).content, 'Updated task');
  oldRun.resolve();
  const completed = await waitFor(manager, conversation.id, (item) =>
    item.activeRun?.status === 'completed' && item.messages.some((message) => message.content === 'Updated final'));
  assert.equal(completed.messages.some((message) => message.content === 'Stale final'), false);
  assert.equal(completed.messages.some((message) => message.content === 'Stale progress'), false);
  assert.equal(completed.messages.find((message) => message.content === 'Updated final')?.source, 'whatsapp');
  assert.deepEqual(seenChannels, [channel, channel]);
});

test('WhatsApp messages carry a run-scoped channel into the MCP session', async () => {
  const seen = [];
  const { manager, conversation } = await setup(async ({ mcpContext }) => {
    seen.push(mcpContext.channel);
    return { assistantText: 'Done' };
  }, 'whatsapp');
  assert.equal(conversation.origin, 'whatsapp');
  assert.equal(conversation.readOnly, true);
  await assert.rejects(manager.sendMessage({ conversationId: conversation.id, content: 'Unbound human path' }), /personal_agent_conversation_read_only/);
  await assert.rejects(manager.steerMessage({ conversationId: conversation.id, content: 'Unbound human steer' }), /personal_agent_conversation_read_only/);
  await assert.rejects(manager.sendWhatsAppMessage({
    conversationId: conversation.id,
    content: 'Bad channel',
    channel: { ...channel, revision: -1 },
  }), /personal_agent_whatsapp_channel_invalid/);
  const started = await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'WhatsApp task', channel });
  assert.equal(started.messages[0].source, 'whatsapp');
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.deepEqual(seen, [channel]);
});

test('WhatsApp run entry rejects an ordinary personal-agent conversation', async () => {
  const { manager, conversation } = await setup(async () => ({ assistantText: 'Unexpected' }));
  await assert.rejects(manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Wrong thread', channel }), /personal_agent_whatsapp_conversation_required/);
  await assert.rejects(manager.steerMessage({ conversationId: conversation.id, content: 'Wrong thread', channel }), /personal_agent_whatsapp_conversation_required/);
});

test('WhatsApp capabilities require explicit selections and never inherit unsafe or spawning permissions', async () => {
  const seen = [];
  const { store, manager, conversation } = await setup(async ({ agent }) => {
    seen.push(agent);
    return { assistantText: 'Done' };
  }, 'whatsapp');
  await store.updateAgentPermissions({
    agentId: conversation.agentId,
    permissionMode: 'unsafe',
    networkAccess: true,
    canSpawnAgents: true,
    appIds: ['app-one'],
    toolIds: ['forger_list_catalog'],
    connectionGrants: [{ type: 'slack', actions: ['slack.send_message'], multiple: false, connectionIds: ['slack-one'] }],
  });
  await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Restricted task', channel });
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.equal(seen[0].permissionMode, 'safe');
  assert.equal(seen[0].networkAccess, false);
  assert.equal(seen[0].canSpawnAgents, false);
  assert.deepEqual(seen[0].appIds, []);
  assert.deepEqual(seen[0].toolIds, []);
  assert.deepEqual(seen[0].connectionGrants, []);
  assert.deepEqual(seen[0].peerAgentGrants, []);

  const fullConversation = await manager.createWhatsAppConversation({ agentId: conversation.agentId });
  await manager.sendWhatsAppMessage({
    conversationId: fullConversation.id, content: 'Full capability task',
    channel: { ...channel, bindingId: 'binding-full', allowAgentCapabilities: true, policy: { appIds: ['app-one', 'not-granted'], toolIds: ['forger_list_catalog'], connectionGrants: [{ type: 'slack', actions: ['slack.send_message'], multiple: false, connectionIds: ['slack-one'] }], peerAgentIds: [], networkAccess: false, sharedMemoryIds: [] } },
  });
  await waitFor(manager, fullConversation.id, (item) => item.activeRun?.status === 'completed');
  assert.equal(seen[1].permissionMode, 'safe');
  assert.equal(seen[1].networkAccess, false);
  assert.equal(seen[1].canSpawnAgents, false);
  assert.deepEqual(seen[1].appIds, ['app-one']);
  assert.deepEqual(seen[1].toolIds, ['forger_list_catalog']);
  assert.equal(seen[1].connectionGrants[0].type, 'slack');
});

test('personal agent steer rejects a stale run ID without replacing current work', async () => {
  const gate = deferred();
  const { manager, conversation } = await setup(async () => {
    await gate.promise;
    return { assistantText: 'Original final' };
  });
  const first = await manager.sendMessage({ conversationId: conversation.id, content: 'Original task' });
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'running');
  await assert.rejects(manager.steerMessage({
    conversationId: conversation.id,
    expectedRunId: 'other-run',
    content: 'Wrong correction',
  }), /personal_agent_run_mismatch/);
  const unchanged = await manager.getConversation(conversation.id);
  assert.equal(unchanged.activeRun.id, first.activeRun.id);
  assert.equal(unchanged.activeRun.status, 'running');
  gate.resolve();
});

test('personal agent steer requires the active run ID and cannot restart a completed run', async () => {
  const gate = deferred();
  const { manager, conversation } = await setup(async () => {
    await gate.promise;
    return { assistantText: 'Original final' };
  });
  const first = await manager.sendMessage({ conversationId: conversation.id, content: 'Original task' });
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'running');
  await assert.rejects(manager.steerMessage({
    conversationId: conversation.id,
    content: 'Correction without run identity',
  }), /personal_agent_run_id_required/);
  gate.resolve();
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  await assert.rejects(manager.steerMessage({
    conversationId: conversation.id,
    expectedRunId: first.activeRun.id,
    content: 'Late correction',
  }), /personal_agent_run_not_active/);
  const unchanged = await manager.getConversation(conversation.id);
  assert.equal(unchanged.messages.some((message) => message.content === 'Late correction'), false);
  assert.equal(unchanged.activeRun.id, first.activeRun.id);
});

test('a canceled queued personal-agent run cannot restart or publish after a steer', async () => {
  const gate = deferred();
  const { manager, conversation } = await setup(async ({ run }) => {
    if (run.id === firstRunId) {
      await gate.promise;
      return { assistantText: 'Old final' };
    }
    return { assistantText: 'New final' };
  });
  let firstRunId;
  const first = await manager.sendMessage({ conversationId: conversation.id, content: 'Original task' });
  firstRunId = first.activeRun.id;
  const steered = await manager.steerMessage({
    conversationId: conversation.id,
    expectedRunId: firstRunId,
    content: 'Correction',
  });
  assert.notEqual(steered.activeRun.id, firstRunId);
  gate.resolve();
  const completed = await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.equal(completed.messages.some((message) => message.content === 'Old final'), false);
});

test('two competing steers cannot both replace the same personal-agent run', async () => {
  const gate = deferred();
  const { manager, conversation } = await setup(async () => {
    await gate.promise;
    return { assistantText: 'Final' };
  });
  const first = await manager.sendMessage({ conversationId: conversation.id, content: 'Original task' });
  const results = await Promise.allSettled([
    manager.steerMessage({ conversationId: conversation.id, expectedRunId: first.activeRun.id, content: 'First correction' }),
    manager.steerMessage({ conversationId: conversation.id, expectedRunId: first.activeRun.id, content: 'Second correction' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && /personal_agent_run_mismatch/.test(result.reason.message)).length, 1);
  gate.resolve();
});

test('steer rejects mismatched channel provenance, blank corrections, and scheduled wakeups', async () => {
  const { store, manager, conversation } = await setup(async () => ({ assistantText: 'Unused' }), 'whatsapp');
  await assert.rejects(manager.steerMessage({
    conversationId: conversation.id, expectedRunId: 'run-1', content: 'Correction',
    source: 'human', channel,
  }), /personal_agent_channel_source_mismatch/);
  await assert.rejects(manager.steerMessage({
    conversationId: conversation.id, expectedRunId: 'run-1', content: '  ', channel,
  }), /personal_agent_message_required/);
  await store.scheduleWakeup({
    agentId: conversation.agentId,
    conversationId: conversation.id,
    prompt: 'Wake later',
    dueAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await assert.rejects(manager.steerMessage({
    conversationId: conversation.id, expectedRunId: 'run-1', content: 'Correction', channel,
  }), /personal_agent_wakeup_active/);
  assert.equal(await manager.cancelRun('missing-run'), false);
});

test('a WhatsApp run fails before a provider without channel isolation can access its workspace', async () => {
  let runnerCalls = 0;
  const { manager, conversation } = await setup(async () => {
    runnerCalls += 1;
    return { assistantText: 'Should not run' };
  }, 'whatsapp', {
    getAgentRuntime: async () => ({ provider: 'antigravity', model: 'gemini', effort: 'medium' }),
  });
  await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Restricted task', channel });
  const failed = await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'failed');
  assert.match(failed.activeRun.error, /personal_agent_whatsapp_runtime_unsupported/);
  assert.equal(runnerCalls, 0);
});

test('provider thread identity persists after completion and reaches the next turn', async () => {
  const seenThreadIds = [];
  const { store, manager, conversation } = await setup(async ({ conversation: runningConversation }) => {
    seenThreadIds.push(runningConversation.providerThreadId);
    return { assistantText: 'Completed', providerThreadId: 'provider-thread-1' };
  }, 'user', {
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' }),
  });
  await manager.sendMessage({ conversationId: conversation.id, content: 'First task' });
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.equal((await store.requireConversation(conversation.id)).providerThreadId, 'provider-thread-1');
  await manager.sendMessage({ conversationId: conversation.id, content: 'Second task' });
  await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed' && item.messages.filter((message) => message.content === 'Completed').length === 2);
  assert.deepEqual(seenThreadIds, [undefined, 'provider-thread-1']);
});

test('WhatsApp progress is attributed to its chat and canceled runs cannot publish provider output', async () => {
  const { manager, conversation } = await setup(async ({ onProgress }) => {
    onProgress('Working on the chat request');
    return { assistantText: 'Done' };
  }, 'whatsapp');
  await manager.sendWhatsAppMessage({ conversationId: conversation.id, content: 'Task', channel });
  const completed = await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'completed');
  assert.equal(completed.messages.find((message) => message.content === 'Working on the chat request')?.source, 'whatsapp');
  const activityCount = manager.activities.size;
  manager.canceledRunIds.add(completed.activeRun.id);
  manager.handleProviderOutput({
    run: completed.activeRun,
    agent: await manager.options.store.requireAgent(conversation.agentId),
    conversation: completed,
    onProgress: () => { throw new Error('stale progress escaped'); },
  }, 'codex', 'stdout', 'stale output');
  assert.equal(manager.activities.size, activityCount);
  manager.canceledRunIds.delete(completed.activeRun.id);
});

test('a run already settled before execution does not start again', async () => {
  let runnerCalls = 0;
  const { store, manager, conversation } = await setup(async () => {
    runnerCalls += 1;
    return { assistantText: 'Unexpected' };
  });
  const run = await store.createRun({ agentId: conversation.agentId, conversationId: conversation.id });
  await store.updateRunStatus({ runId: run.id, status: 'canceled' });
  await manager.executeRun(conversation.id, run.id, {
    conversationId: conversation.id, callStackAgentIds: [conversation.agentId],
  });
  assert.equal(runnerCalls, 0);
});

test('a startup event failure releases preparation and fails the run', async () => {
  let runnerCalls = 0;
  const { manager, conversation } = await setup(async () => {
    runnerCalls += 1;
    return { assistantText: 'Unexpected' };
  }, 'user', {
    onConversationEvent: (event) => {
      if (event.type === 'run.started') throw new Error('startup event unavailable');
    },
  });
  await manager.sendMessage({ conversationId: conversation.id, content: 'Task' });
  const failed = await waitFor(manager, conversation.id, (item) => item.activeRun?.status === 'failed');
  assert.match(failed.activeRun.error, /startup event unavailable/);
  assert.equal(manager.runPreparations.size, 0);
  assert.equal(runnerCalls, 0);
});

test('child cancellation waits for exit, handles a raced exit, and rejects an unconfirmed kill', async () => {
  const { manager } = await setup(async () => ({ assistantText: 'Unused' }));
  const alreadyExited = new EventEmitter();
  alreadyExited.exitCode = 0;
  alreadyExited.signalCode = null;
  await manager.waitForChildExit(alreadyExited);

  const exiting = new EventEmitter();
  exiting.exitCode = null;
  exiting.signalCode = null;
  const pending = manager.waitForChildExit(exiting);
  queueMicrotask(() => {
    exiting.signalCode = 'SIGKILL';
    exiting.emit('exit');
  });
  await pending;
  assert.equal(exiting.listenerCount('exit'), 0);

  const raced = new EventEmitter();
  raced.exitCode = null;
  raced.signalCode = null;
  const once = raced.once.bind(raced);
  raced.once = (event, listener) => {
    once(event, listener);
    raced.exitCode = 0;
    return raced;
  };
  await manager.waitForChildExit(raced);
  assert.equal(raced.listenerCount('exit'), 0);

  const unconfirmed = new EventEmitter();
  unconfirmed.exitCode = null;
  unconfirmed.signalCode = null;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return { unref: () => undefined };
  };
  try {
    await assert.rejects(manager.waitForChildExit(unconfirmed), /personal_agent_cancellation_unconfirmed/);
    assert.equal(unconfirmed.listenerCount('exit'), 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('run cancellation state clears even if recording its failure also fails', async () => {
  const { manager, conversation } = await setup(async () => ({ assistantText: 'Unused' }));
  const runId = 'run-with-failing-store';
  manager.canceledRunIds.add(runId);
  manager.executeRun = async () => { throw new Error('provider failed'); };
  manager.failRun = async () => { throw new Error('failure persistence failed'); };
  await assert.rejects(manager.executeRunSafely(conversation.id, runId, {
    conversationId: conversation.id, callStackAgentIds: [conversation.agentId],
  }), /failure persistence failed/);
  assert.equal(manager.canceledRunIds.has(runId), false);
});
