import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-conversation-b15-'));
  const metadataRoot = path.join(root, 'metadata');
  const forgerHomeRoot = path.join(root, 'home');
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const events = [];
  const manager = new AgentConversationManager({
    store,
    metadataRoot,
    runner: async () => ({ assistantText: 'Completed by the agent.' }),
    onConversationEvent: (event) => events.push(event),
    ...overrides,
  });
  return {
    root,
    metadataRoot,
    forgerHomeRoot,
    store,
    manager,
    events,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }),
  };
};

const createPeerFixture = async (harness) => {
  const caller = await harness.store.createAgent({ name: 'Planner' });
  const target = await harness.store.createAgent({ name: 'Reviewer' });
  const other = await harness.store.createAgent({ name: 'Other' });
  await harness.store.updateAgentPermissions({
    agentId: caller.id,
    peerAgentGrants: [{ agentId: target.id, criteria: 'Review plans.' }],
  });
  const callerConversation = await harness.store.createConversation({ agentId: caller.id, title: 'Plan' });
  const callerRun = await harness.store.createRun({ agentId: caller.id, conversationId: callerConversation.id });
  await harness.store.updateRunStatus({ runId: callerRun.id, status: 'completed' });
  return { caller, target, other, callerConversation, callerRun };
};

test('given listeners and conversation lookup, creation emits normalized events and unsubscribe is final', async () => {
  const harness = await createHarness();
  const observed = [];
  try {
    const unsubscribe = harness.manager.onConversationEvent((event) => observed.push(event.type));
    const agent = await harness.store.createAgent({ name: 'Listener agent' });
    const conversation = await harness.manager.createConversation({ agentId: agent.id, title: 'Visible' });
    assert.equal((await harness.manager.getConversation(conversation.id)).id, conversation.id);
    assert.equal((await harness.manager.getConversation({ conversationId: conversation.id })).id, conversation.id);
    await assert.rejects(() => harness.manager.getConversation({ conversationId: '' }), /personal_agent_conversation_id_required/);
    unsubscribe();
    await harness.manager.createConversation({ agentId: agent.id, title: 'Not observed' });
    assert.deepEqual(observed, ['conversation.created']);
  } finally {
    await harness.cleanup();
  }
});

test('given sidekick conversation invariants, reuse checks reject each mismatch and preserve provider continuity', async () => {
  const agent = { id: 'agent-1', runtime: undefined, permissionMode: 'safe' };
  let conversation;
  let runtime;
  const store = {
    getConversation: async () => conversation,
    requireAgent: async () => agent,
  };
  const manager = new AgentConversationManager({
    store,
    getAgentRuntime: async () => runtime,
  });
  const input = { conversationId: 'conversation-1', sidekickId: 'sidekick-1', agentId: agent.id };
  const valid = {
    id: input.conversationId,
    origin: 'sidekick',
    readOnly: true,
    sidekickId: input.sidekickId,
    agentId: agent.id,
    status: 'active',
  };
  for (const candidate of [
    null,
    { ...valid, origin: 'human' },
    { ...valid, readOnly: false },
    { ...valid, sidekickId: 'other' },
    { ...valid, agentId: 'other' },
    { ...valid, status: 'archived' },
    { ...valid, activeRun: { status: 'running' } },
  ]) {
    conversation = candidate;
    assert.equal(await manager.canReuseSidekickConversation(input), false);
  }
  conversation = { ...valid, activeRun: { status: 'completed' } };
  runtime = undefined;
  assert.equal(await manager.canReuseSidekickConversation(input), true);
  runtime = { provider: 'codex' };
  conversation.provider = undefined;
  assert.equal(await manager.canReuseSidekickConversation(input), true);
  conversation.provider = 'codex';
  assert.equal(await manager.canReuseSidekickConversation(input), true);
  conversation.provider = 'claude';
  assert.equal(await manager.canReuseSidekickConversation(input), false);
});

test('given a Sidekick turn, mismatches are blocked while model and voice reach its scoped run context', async () => {
  let runnerInput;
  const harness = await createHarness({
    runner: async (input) => {
      runnerInput = input;
      input.onProgress('Preparando voz.');
      return { assistantText: 'Hablado.' };
    },
  });
  try {
    const agent = await harness.store.createAgent({ name: 'Voice agent' });
    const ordinary = await harness.manager.createConversation({ agentId: agent.id });
    await assert.rejects(() => harness.manager.sendSidekickMessage({
      conversationId: ordinary.id,
      sidekickId: 'desk',
      content: 'Hola',
      locale: 'es-CL',
    }), /personal_agent_sidekick_conversation_mismatch/);
    const sidekick = await harness.manager.createSidekickConversation({ agentId: agent.id, sidekickId: 'desk' });
    await assert.rejects(() => harness.manager.sendSidekickMessage({
      conversationId: sidekick.id,
      sidekickId: 'other',
      content: 'Hola',
      locale: 'es-CL',
    }), /personal_agent_sidekick_conversation_mismatch/);
    await harness.manager.sendSidekickMessage({
      conversationId: sidekick.id,
      sidekickId: 'desk',
      content: 'Hola',
      locale: 'es-CL',
      model: 'kokoro',
      voice: 'af_heart',
    });
    while (!runnerInput) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(runnerInput.mcpContext.sidekick, {
      sidekickId: 'desk', locale: 'es-CL', model: 'kokoro', voice: 'af_heart',
    });
  } finally {
    await harness.cleanup();
  }
});

test('given scheduled messages, system provenance and both settlement callback outcomes are persisted', async () => {
  for (const failure of [null, new Error('scheduled failure')]) {
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const harness = await createHarness({
      runner: async () => {
        if (failure) throw failure;
        return { assistantText: 'Scheduled complete.' };
      },
    });
    try {
      const agent = await harness.store.createAgent({ name: 'Scheduler' });
      const conversation = await harness.manager.createConversation({ agentId: agent.id });
      const queued = await harness.manager.sendScheduledMessage({
        conversationId: conversation.id,
        content: 'Run routine.',
        source: 'routine',
        routineId: 'routine-1',
        wakeupId: null,
        onRunSettled: settle,
      });
      const result = await settled;
      assert.equal(result.success, !failure);
      assert.equal(queued.messages[0].authorType, 'system');
      assert.equal(queued.messages[0].routineId, 'routine-1');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given a blank message, no run or title mutation is created', async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.store.createAgent({ name: 'Blank guard' });
    const conversation = await harness.manager.createConversation({ agentId: agent.id, title: 'Original' });
    await assert.rejects(
      () => harness.manager.sendMessage({ conversationId: conversation.id, content: '   ' }),
      /personal_agent_message_required/,
    );
    assert.equal((await harness.store.requireConversation(conversation.id)).title, 'Original');
  } finally {
    await harness.cleanup();
  }
});

test('given a nonempty human draft and shared files, sending clears the draft and builds a safe complete transcript', async () => {
  let runnerInput;
  const harness = await createHarness({
    resolveAppTrustedRoots: async () => [
      '', 17, path.join(os.tmpdir(), 'missing-b15-root'), harness?.root,
      harness?.root,
    ],
    runner: async (input) => { runnerInput = input; return { assistantText: '' }; },
  });
  try {
    const agent = await harness.store.createAgent({ name: 'Transcript agent', appIds: ['one', 'one'] });
    const conversation = await harness.manager.createConversation({ agentId: agent.id });
    await harness.store.addMessage({
      agentId: agent.id,
      conversationId: conversation.id,
      role: 'assistant',
      authorType: 'agent',
      authorAgentId: agent.id,
      content: 'Peer note.',
    });
    await harness.store.addMessage({
      agentId: agent.id,
      conversationId: conversation.id,
      role: 'user',
      authorType: 'system',
      content: 'System note.',
    });
    await harness.store.updateConversationDraft({ conversationId: conversation.id, draftMessage: 'discard me' });
    const absoluteFile = path.join(harness.root, 'shared', 'report.txt');
    await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
    await fs.writeFile(absoluteFile, 'report');
    await harness.manager.sendMessage({
      conversationId: conversation.id,
      content: 'One two three four five six seven eight nine ten',
      sharedFiles: [
        { path: absoluteFile, relativePath: 'report.txt', name: 'report.txt', sizeBytes: 6, source: 'attached' },
        { path: 'relative.txt', relativePath: '', name: 'relative.txt', source: 'attached' },
      ],
    });
    while (!runnerInput) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await harness.store.requireConversation(conversation.id)).draftMessage, undefined);
    assert.equal(runnerInput.trustedRoots.includes(path.dirname(absoluteFile)), true);
    assert.equal(runnerInput.trustedRoots.includes(path.resolve(harness.root)), true);
    assert.match(runnerInput.prompt, /assistant \(Transcript agent\): Peer note/);
    assert.match(runnerInput.prompt, /user \(System\): System note/);
    assert.match(runnerInput.prompt, /report\.txt \(report\.txt\), 6 bytes/);
  } finally {
    await harness.cleanup();
  }
});

test('given peer calls, empty input, source mismatch, missing targets, self-calls, cycles, depth, and grants fail explicitly', async () => {
  const harness = await createHarness();
  try {
    const fixture = await createPeerFixture(harness);
    const base = {
      callerAgentId: fixture.caller.id,
      callerConversationId: fixture.callerConversation.id,
      callerRunId: fixture.callerRun.id,
      targetAgentId: fixture.target.id,
      message: 'Review this.',
    };
    assert.equal((await harness.manager.askPeerAgent({ ...base, message: ' ' })).technicalCode, 'personal_agent_peer_message_required');
    const otherConversation = await harness.store.createConversation({ agentId: fixture.other.id });
    await assert.rejects(() => harness.manager.askPeerAgent({ ...base, callerConversationId: otherConversation.id }), /personal_agent_peer_source_conversation_mismatch/);
    await assert.rejects(() => harness.manager.askPeerAgent({ ...base, targetAgentId: ' ' }), /personal_agent_peer_target_required/);
    await assert.rejects(() => harness.manager.askPeerAgent({ ...base, targetAgentId: fixture.caller.id }), /personal_agent_peer_self_call_blocked/);
    await assert.rejects(() => harness.manager.askPeerAgent({ ...base, callStackAgentIds: [fixture.caller.id, fixture.target.id] }), /personal_agent_peer_cycle_blocked/);
    await assert.rejects(() => harness.manager.askPeerAgent({ ...base, callStackAgentIds: [fixture.caller.id, 'a', 'b', 'c', 'd'] }), /personal_agent_peer_depth_exceeded/);
    await harness.store.updateAgentPermissions({ agentId: fixture.caller.id, peerAgentGrants: [] });
    await assert.rejects(() => harness.manager.askPeerAgent(base), /personal_agent_peer_not_granted/);
    await assert.rejects(() => harness.manager.askPeerAgent({ ...base, threadId: 'missing' }), /personal_agent_peer_thread_not_found/);
  } finally {
    await harness.cleanup();
  }
});

test('given an authorized peer, a new thread and a continued thread retain provenance and return the latest answer', async () => {
  let calls = 0;
  const harness = await createHarness({
    runner: async () => ({ assistantText: `Peer answer ${++calls}.` }),
  });
  try {
    const fixture = await createPeerFixture(harness);
    const first = await harness.manager.askPeerAgent({
      callerAgentId: fixture.caller.id,
      callerConversationId: fixture.callerConversation.id,
      callerRunId: fixture.callerRun.id,
      targetAgentId: fixture.target.id,
      callStackAgentIds: null,
      message: 'Please review the launch plan in detail today.',
    });
    assert.equal(first.success, true);
    assert.equal(first.response, 'Peer answer 1.');
    assert.equal(first.thread.messages[0].authorAgentId, fixture.caller.id);
    const second = await harness.manager.askPeerAgent({
      callerAgentId: fixture.caller.id,
      callerConversationId: fixture.callerConversation.id,
      callerRunId: fixture.callerRun.id,
      threadId: first.thread.id,
      message: 'Continue.',
    });
    assert.equal(second.response, 'Peer answer 2.');

    const targetConversation = await harness.store.requireConversation(first.thread.targetConversationId);
    const blockingRun = await harness.store.createRun({ agentId: fixture.target.id, conversationId: targetConversation.id });
    await assert.rejects(() => harness.manager.askPeerAgent({
      callerAgentId: fixture.caller.id,
      callerConversationId: fixture.callerConversation.id,
      callerRunId: fixture.callerRun.id,
      threadId: first.thread.id,
      message: 'Overlapping request.',
    }), /personal_agent_run_active/);
    await harness.store.updateRunStatus({ runId: blockingRun.id, status: 'canceled' });

    const wrongSource = await harness.store.createConversation({ agentId: fixture.caller.id });
    await assert.rejects(() => harness.manager.askPeerAgent({
      callerAgentId: fixture.caller.id,
      callerConversationId: wrongSource.id,
      callerRunId: fixture.callerRun.id,
      threadId: first.thread.id,
      message: 'Not allowed.',
    }), /personal_agent_peer_thread_not_allowed/);
    await harness.store.updateAgentPermissions({ agentId: fixture.caller.id, peerAgentGrants: [] });
    await assert.rejects(() => harness.manager.askPeerAgent({
      callerAgentId: fixture.caller.id,
      callerConversationId: fixture.callerConversation.id,
      callerRunId: fixture.callerRun.id,
      threadId: first.thread.id,
      message: 'Grant revoked.',
    }), /personal_agent_peer_not_granted/);
  } finally {
    await harness.cleanup();
  }
});

test('given nested peer work, the child thread links to its parent and provider continuity is enforced', async () => {
  const harness = await createHarness();
  try {
    const first = await createPeerFixture(harness);
    const legal = await harness.store.createAgent({ name: 'Legal' });
    await harness.store.updateAgentPermissions({
      agentId: first.target.id,
      peerAgentGrants: [{ agentId: legal.id, criteria: 'Check legal details.' }],
    });
    const parent = await harness.manager.askPeerAgent({
      callerAgentId: first.caller.id,
      callerConversationId: first.callerConversation.id,
      callerRunId: first.callerRun.id,
      targetAgentId: first.target.id,
      message: 'Review budget.',
    });
    const targetConversation = await harness.store.requireConversation(parent.thread.targetConversationId);
    const targetRun = targetConversation.activeRun;
    const nested = await harness.manager.askPeerAgent({
      callerAgentId: first.target.id,
      callerConversationId: targetConversation.id,
      callerRunId: targetRun.id,
      targetAgentId: legal.id,
      message: 'Check contract.',
    });
    assert.equal(nested.thread.parentThreadId, parent.thread.id);

    harness.manager.options.getAgentRuntime = async () => ({ provider: 'claude', permissionMode: 'safe' });
    await harness.store.updateConversationProvider({
      conversationId: parent.thread.targetConversationId,
      provider: 'codex',
      providerThreadId: 'thread-codex',
    });
    await assert.rejects(() => harness.manager.askPeerAgent({
      callerAgentId: first.caller.id,
      callerConversationId: first.callerConversation.id,
      callerRunId: first.callerRun.id,
      threadId: parent.thread.id,
      message: 'Provider changed.',
    }), /personal_agent_provider_changed_new_conversation_required/);
  } finally {
    await harness.cleanup();
  }
});

test('given failed and text-thrown peer runs, the thread is failed with a stable technical code', async () => {
  for (const failure of [new Error('peer exploded'), 'peer exploded']) {
    const harness = await createHarness({ runner: async () => { throw failure; } });
    try {
      const fixture = await createPeerFixture(harness);
      const result = await harness.manager.askPeerAgent({
        callerAgentId: fixture.caller.id,
        callerConversationId: fixture.callerConversation.id,
        callerRunId: fixture.callerRun.id,
        targetAgentId: fixture.target.id,
        message: 'Fail safely.',
      });
      assert.equal(result.success, false);
      assert.equal(result.status, 'failed');
      assert.equal(result.technicalCode, failure instanceof Error ? 'peer exploded' : 'personal_agent_peer_run_failed');
      assert.equal(result.thread.status, 'failed');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given peer persistence temporarily returns no refreshed thread, original transcript fallbacks stay useful', async () => {
  for (const outcome of ['empty', 'nonassistant', 'failure']) {
    const failure = outcome === 'failure' ? new Error('peer failed without refresh') : null;
    const harness = await createHarness({
      runner: async () => {
        if (failure) throw failure;
        return { assistantText: 'Stored answer not reloaded.' };
      },
    });
    try {
      const fixture = await createPeerFixture(harness);
      if (outcome === 'nonassistant') {
        const createPeerThread = harness.store.createPeerThread.bind(harness.store);
        harness.store.createPeerThread = async (input) => ({
          ...await createPeerThread(input),
          messages: [{ role: 'user', kind: 'message', content: 'No assistant answer.' }],
        });
      }
      harness.store.getPeerThread = async () => null;
      const result = await harness.manager.askPeerAgent({
        callerAgentId: fixture.caller.id,
        callerConversationId: fixture.callerConversation.id,
        callerRunId: fixture.callerRun.id,
        targetAgentId: fixture.target.id,
        message: 'Use fallback thread.',
      });
      if (failure) {
        assert.equal(result.status, 'failed');
      } else {
        assert.equal(result.status, 'completed');
        assert.equal(result.response, undefined);
        assert.equal(result.userMessage, 'El agente destino termino sin texto visible.');
      }
    } finally {
      await harness.cleanup();
    }
  }
});

test('given a peer timeout, the running transcript is returned without blocking and can be canceled', async () => {
  const harness = await createHarness();
  const originalSetTimeout = globalThis.setTimeout;
  try {
    const fixture = await createPeerFixture(harness);
    harness.manager.executeRunSafely = async () => await new Promise(() => {});
    globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
    const result = await harness.manager.askPeerAgent({
      callerAgentId: fixture.caller.id,
      callerConversationId: fixture.callerConversation.id,
      callerRunId: fixture.callerRun.id,
      targetAgentId: fixture.target.id,
      message: 'Long-running review.',
    });
    assert.equal(result.status, 'timeout');
    const target = await harness.store.requireConversation(result.thread.targetConversationId);
    await harness.manager.cancelRun(target.activeRun.id);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await harness.cleanup();
  }
});

test('given cancellation with an active child, SIGTERM is sent exactly once and activity reaches canceled', async () => {
  const harness = await createHarness();
  try {
    const agent = await harness.store.createAgent({ name: 'Cancelable' });
    const conversation = await harness.store.createConversation({ agentId: agent.id });
    const run = await harness.store.createRun({ agentId: agent.id, conversationId: conversation.id });
    let signal;
    const child = { killed: false, kill: (nextSignal) => { signal = nextSignal; child.killed = true; } };
    harness.manager.activeChildren.set(run.id, child);
    assert.equal(await harness.manager.cancelRun(run.id), true);
    assert.equal(signal, 'SIGTERM');
    assert.equal((await harness.store.getRun(run.id)).status, 'canceled');
  } finally {
    await harness.cleanup();
  }
});

test('given private lifecycle edge cases, missing runs, conversations, activity, and metadata return safely', async () => {
  const harness = await createHarness();
  try {
    const missingRunManager = new AgentConversationManager({
      store: {
        addRunProgress: async () => ({ id: 'progress' }),
        getRun: async () => null,
      },
    });
    await missingRunManager.recordProgress('missing-run', 'ignored');
    await harness.manager.emitActivityProgress('missing-run');
    await assert.rejects(() => harness.manager.requireUpdatedConversation('missing'), /personal_agent_conversation_not_found/);
    assert.equal(harness.manager.withActivityRun(undefined), undefined);
    harness.manager.persistActivity('missing-run');
    const noMetadata = new AgentConversationManager({ store: harness.store });
    noMetadata.activities.set('run', { runId: 'run' });
    noMetadata.persistActivity('run');
    await harness.manager.failRun('missing-run', new Error('ignored'));
    const agent = await harness.store.createAgent({ name: 'Terminal failure guard' });
    const conversation = await harness.store.createConversation({ agentId: agent.id });
    const run = await harness.store.createRun({ agentId: agent.id, conversationId: conversation.id });
    await harness.store.updateRunStatus({ runId: run.id, status: 'completed' });
    await harness.manager.failRun(run.id, null);
    const failedRun = await harness.store.createRun({ agentId: agent.id, conversationId: conversation.id });
    await harness.manager.failRun(failedRun.id, null);
    assert.equal((await harness.store.getRun(failedRun.id)).error, 'personal_agent_run_failed');

    const progressRun = await harness.store.createRun({ agentId: agent.id, conversationId: conversation.id });
    await harness.manager.recordProgress(progressRun.id, 'Direct progress');
    assert.equal(harness.manager.activities.has(progressRun.id), true);
    assert.equal(harness.manager.withActivityRun({ ...progressRun, id: 'untracked' }).activity, undefined);

    let activityEvent;
    const off = harness.manager.onConversationEvent((event) => { activityEvent = event; });
    harness.manager.activities.set(progressRun.id, { runId: progressRun.id });
    await harness.manager.emitActivityProgress(progressRun.id);
    off();
    assert.equal(activityEvent.progress.message, '');
  } finally {
    await harness.cleanup();
  }
});
