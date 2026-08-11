import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');

const createProviderHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-provider-conversation-b15-'));
  const metadataRoot = path.join(root, 'metadata');
  const forgerHomeRoot = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  await fs.mkdir(codexHome, { recursive: true });
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const manager = new AgentConversationManager({ store, metadataRoot, codexHome, ...overrides });
  const agent = await store.createAgent({
    name: 'Provider agent',
    appIds: ['connected-app'],
    networkAccess: true,
    runtime: { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
  });
  const conversation = await store.createConversation({ agentId: agent.id, title: 'Provider run' });
  const run = await store.createRun({ agentId: agent.id, conversationId: conversation.id });
  const workspaceRoot = await store.workspaceRootForAgent(agent.id);
  return {
    root, metadataRoot, forgerHomeRoot, codexHome, store, manager, agent, conversation, run, workspaceRoot,
    input(runtime = { provider: 'codex', model: 'gpt-5.4', effort: 'medium', permissionMode: 'safe' }) {
      return {
        agent,
        conversation,
        run,
        runtime,
        prompt: 'Perform the provider task.',
        workspaceRoot,
        sharedRoots: [],
        trustedRoots: [workspaceRoot],
        mcpContext: { conversationId: conversation.id, callStackAgentIds: [agent.id] },
        onProgress: () => undefined,
      };
    },
    cleanup: async () => await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }),
  };
};

const writeExecutable = async (root, name, body) => {
  const file = path.join(root, name);
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await fs.chmod(file, 0o755);
  return file;
};

test('given missing provider prerequisites, unavailable runtime and workspace fail before launching a process', async () => {
  const harness = await createProviderHarness();
  try {
    const missingOptions = new AgentConversationManager({ store: harness.store });
    await assert.rejects(() => missingOptions.runWithConfiguredProvider(harness.input()), /personal_agent_runtime_unavailable/);

    harness.manager.options.getAgentRuntime = async () => undefined;
    const withoutRuntime = harness.input(undefined);
    withoutRuntime.runtime = undefined;
    await assert.rejects(() => harness.manager.runWithConfiguredProvider(withoutRuntime), /personal_agent_runtime_unavailable/);

    harness.manager.options.getAgentRuntime = async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' });
    const missingWorkspace = harness.input();
    missingWorkspace.workspaceRoot = path.join(harness.root, 'missing-workspace');
    await assert.rejects(() => harness.manager.runWithConfiguredProvider(missingWorkspace), /personal_agent_workspace_missing/);
  } finally {
    await harness.cleanup();
  }
});

test('given a Codex provider run with MCPs, process output, thread persistence, logs, and cleanup stay scoped', async () => {
  const released = [];
  const cli = await writeExecutable(os.tmpdir(), `forger-codex-b15-${process.pid}.cjs`, [
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'provider-thread-b15' }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Provider completed.' } }));",
  ].join('\n'));
  const harness = await createProviderHarness({
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium', permissionMode: 'safe' }),
    getCodexCliPath: async () => cli,
    getCodexAuthenticated: async () => true,
    ensureGitAvailable: async () => undefined,
    listenAppMcps: async () => [{
      name: 'app_connected',
      url: 'http://127.0.0.1:49002/mcp',
      token: 'app-token',
      tokenEnvVar: 'FORGER_APP_MCP_TOKEN',
      toolTimeoutSec: 30,
    }],
    releaseAppMcps: (runId) => released.push(`app:${runId}`),
    createForgerMcpSession: () => ({ url: 'http://127.0.0.1:49001/mcp', token: 'forger-token' }),
    releaseForgerMcpSession: (token) => released.push(`forger:${token}`),
  });
  try {
    const progress = [];
    const input = harness.input();
    input.onProgress = (message, options) => progress.push({ message, options });
    const result = await harness.manager.runWithConfiguredProvider(input);
    assert.equal(result.assistantText, 'Provider completed.');
    assert.equal(input.conversation.providerThreadId, 'provider-thread-b15');
    assert.equal((await harness.store.requireConversation(input.conversation.id)).providerThreadId, 'provider-thread-b15');
    assert.deepEqual(released.sort(), [`app:${harness.run.id}`, 'forger:forger-token'].sort());
    assert.equal(harness.manager.activeChildren.has(harness.run.id), false);
    assert.equal(progress.length > 0, true);
    assert.match(await fs.readFile(path.join(harness.metadataRoot, 'personal-agents', 'runs', `${harness.run.id}.log`), 'utf8'), /Provider completed/);
  } finally {
    await harness.cleanup();
    await fs.rm(cli, { force: true });
  }
});

test('given absent optional provider integrations, defaults run without MCP cleanup callbacks or environment suppliers', async () => {
  const cli = await writeExecutable(os.tmpdir(), `forger-codex-defaults-b15-${process.pid}.cjs`,
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'No integrations.' } }));");
  const harness = await createProviderHarness({
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' }),
    getCodexCliPath: async () => cli,
    getCodexAuthenticated: async () => true,
  });
  try {
    const input = harness.input();
    input.runtime = undefined;
    const result = await harness.manager.runWithConfiguredProvider(input);
    assert.equal(result.assistantText, 'No integrations.');
  } finally {
    await harness.cleanup();
    await fs.rm(cli, { force: true });
  }
});

test('given Antigravity, its workspace config root and non-Codex isolation path execute successfully', async () => {
  const cli = await writeExecutable(os.tmpdir(), `forger-antigravity-b15-${process.pid}.cjs`, "console.log('Antigravity completed.');");
  const harness = await createProviderHarness({
    getAgentRuntime: async () => ({ provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium' }),
    getAntigravityCliPath: async () => cli,
    getAntigravityAuthenticated: async () => true,
  });
  try {
    const result = await harness.manager.runWithConfiguredProvider(
      harness.input({ provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium', permissionMode: 'safe' }),
    );
    assert.match(result.assistantText, /Antigravity completed/);
  } finally {
    await harness.cleanup();
    await fs.rm(cli, { force: true });
  }
});

test('given each nonzero provider output shape, stderr, stdout, and fallback technical errors are selected deterministically', async () => {
  for (const mode of ['stderr', 'stdout', 'empty']) {
    const cli = await writeExecutable(os.tmpdir(), `forger-codex-fail-${mode}-b15-${process.pid}.cjs`, [
      `if (${JSON.stringify(mode)} === 'stderr') process.stderr.write('stderr failure');`,
      `if (${JSON.stringify(mode)} === 'stdout') process.stdout.write('stdout failure');`,
      'process.exitCode = 7;',
    ].join('\n'));
    const harness = await createProviderHarness({
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' }),
      getCodexCliPath: async () => cli,
      getCodexAuthenticated: async () => true,
    });
    try {
      await assert.rejects(
        () => harness.manager.runWithConfiguredProvider(harness.input()),
        new RegExp(mode === 'stderr' ? 'stderr failure' : mode === 'stdout' ? 'stdout failure' : 'codex_personal_agent_exec_failed'),
      );
      assert.equal(harness.manager.activeChildren.has(harness.run.id), false);
    } finally {
      await harness.cleanup();
      await fs.rm(cli, { force: true });
    }
  }
});

test('given provider activity output, structured receipts, visible progress, quiet activity, and missing runs take distinct paths', async () => {
  const harness = await createProviderHarness();
  const progress = [];
  try {
    const input = harness.input();
    input.onProgress = (message, options) => progress.push({ message, options });
    harness.manager.handleProviderOutput(input, 'codex', 'stdout', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Visible.' } }));
    harness.manager.handleProviderOutput(input, 'codex', 'meta', 'Codex internal lifecycle metadata');
    harness.manager.handleProviderOutput(input, 'codex', 'stderr', '');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(progress.some((entry) => entry.message.includes('Visible')), true);

    const unknownInput = { ...input, run: { ...input.run, id: 'missing-run' } };
    harness.manager.handleProviderOutput(unknownInput, 'codex', 'meta', 'working');
    await new Promise((resolve) => setImmediate(resolve));

    const incompleteActivity = harness.manager.createActivityForRun(input.run, input.agent, input.conversation);
    incompleteActivity.counts.total = undefined;
    harness.manager.activities.set(input.run.id, incompleteActivity);
    harness.manager.handleProviderOutput(input, 'codex', 'stderr', 'plain diagnostic');
  } finally {
    await harness.cleanup();
  }
});

test('given execution-level provider drift and unusual progress, the running run fails before launch and empty receipts are ignored', async () => {
  const harness = await createProviderHarness({
    getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' }),
    runner: async ({ onProgress }) => {
      onProgress(42);
      onProgress('');
      return { assistantText: 'unreachable' };
    },
  });
  try {
    await harness.store.updateConversationProvider({
      conversationId: harness.conversation.id,
      provider: 'codex',
      providerThreadId: 'old-thread',
    });
    await assert.rejects(
      () => harness.manager.executeRun(harness.conversation.id, harness.run.id, {
        conversationId: harness.conversation.id,
        callStackAgentIds: [harness.agent.id],
      }),
      /personal_agent_provider_changed_new_conversation_required/,
    );
    await harness.manager.failRun(harness.run.id, new Error('provider drift'));
  } finally {
    await harness.cleanup();
  }
});

test('given a runtime on a conversation without a provider thread, null continuity and nonstring progress complete normally', async () => {
  let capturedProgress;
  const harness = await createProviderHarness({
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-5.4', effort: 'medium' }),
    runner: async ({ onProgress }) => {
      onProgress(42);
      onProgress('');
      capturedProgress = true;
      return { assistantText: 'Progress normalized.' };
    },
  });
  try {
    const originalRequire = harness.store.requireConversation.bind(harness.store);
    let first = true;
    harness.store.requireConversation = async (conversationId) => {
      const conversation = await originalRequire(conversationId);
      if (first) {
        first = false;
        return { ...conversation, providerThreadId: undefined };
      }
      return conversation;
    };
    await harness.manager.executeRun(harness.conversation.id, harness.run.id, {
      conversationId: harness.conversation.id,
      callStackAgentIds: [harness.agent.id],
    });
    assert.equal(capturedProgress, true);
    assert.equal((await harness.store.getRun(harness.run.id)).status, 'completed');
  } finally {
    await harness.cleanup();
  }
});

test('given prompt edge cases, absent current turns, memories, agent labels, file fallbacks, and no visible transcript remain explicit', async () => {
  const harness = await createProviderHarness();
  try {
    await harness.store.createMemory({
      agentId: harness.agent.id,
      title: 'Preference',
      content: 'Be concise.',
    });
    const fakeConversation = {
      ...harness.conversation,
      messages: [
        { id: 'system', role: 'system', kind: 'message', authorType: 'system', content: 'Hidden.' },
        { id: 'spoken', role: 'assistant', kind: 'spoken', authorType: 'human', content: 'Spoken.' },
      ],
    };
    let prompt = await harness.manager.buildPrompt(harness.agent, fakeConversation, harness.run, {
      conversationId: fakeConversation.id,
      callStackAgentIds: [harness.agent.id],
    });
    assert.match(prompt, /No visible messages yet/);
    assert.match(prompt, /Current user message:\n$/);
    assert.match(prompt, /Preference: Be concise/);

    harness.manager.options.store = {
      ...harness.store,
      listMemories: async () => [{ title: 'No timing', content: 'Remember this.', rememberWhen: '' }],
    };
    assert.match(await harness.manager.buildConversationBootstrap(harness.agent), /No timing: Remember this\./);
    harness.manager.options.store.listMemories = async () => [{
      title: 'Timed', content: 'Use before reviews.', rememberWhen: 'a review begins',
    }];
    assert.match(await harness.manager.buildConversationBootstrap(harness.agent), /remember when: a review begins/);
    harness.manager.options.store = harness.store;

    fakeConversation.messages = [
      { id: 'one', runId: 'older', role: 'user', kind: 'message', authorType: 'agent', content: 'Agent fallback.', files: [{ name: 'raw.txt', path: '/tmp/raw.txt' }] },
      { id: 'two', runId: 'older', role: 'assistant', kind: 'message', authorType: 'agent', content: 'Self fallback.', files: [] },
    ];
    prompt = await harness.manager.buildPrompt(harness.agent, fakeConversation, harness.run, {
      conversationId: fakeConversation.id,
      callStackAgentIds: [harness.agent.id],
    });
    assert.match(prompt, /user \(Agent\): Agent fallback/);
    assert.match(prompt, /assistant \(Provider agent\): Self fallback/);
    assert.match(prompt, /raw\.txt \(\/tmp\/raw\.txt\)/);
  } finally {
    await harness.cleanup();
  }
});
