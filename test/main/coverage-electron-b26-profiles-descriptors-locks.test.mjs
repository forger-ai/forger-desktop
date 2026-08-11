import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { codexCliAdapter } = require('../../dist-electron/main/llm-provider/adapters/codex-cli-adapter.js');
const { claudeCliAdapter } = require('../../dist-electron/main/llm-provider/adapters/claude-cli-adapter.js');
const { antigravityCliAdapter } = require('../../dist-electron/main/llm-provider/adapters/antigravity-cli-adapter.js');
const {
  getLlmProviderDescriptor,
  LLM_PROVIDER_DESCRIPTORS,
} = require('../../dist-electron/main/llm-provider/descriptors.js');
const { resolveLlmProviderAuthContext } = require('../../dist-electron/main/llm-provider/profile-resolver.js');
const { acquireWorkspaceLock, withWorkspaceLock } = require('../../dist-electron/main/llm-provider/workspace-locks.js');

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const descriptorInput = (overrides = {}) => ({
  runId: 'run-1',
  mode: 'conversation',
  cliPath: '/opt/provider',
  pathEntries: ['/opt/bin'],
  environment: { FORGER_TEST: 'yes' },
  mcpServers: [],
  workingDir: '/workspace',
  configWorkspaceRoot: '/config',
  sharedRoots: ['/shared'],
  addDirs: ['/added'],
  prompt: 'hello',
  model: '',
  effort: '',
  permissionMode: 'approve',
  timeoutMs: 1_000,
  inactivityTimeoutMs: 500,
  conversationId: 'conversation-input',
  threadId: null,
  runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
  ...overrides,
});

test('provider descriptors expose capabilities and delegate each Codex run mode', async () => {
  assert.deepEqual(Object.keys(LLM_PROVIDER_DESCRIPTORS), ['codex', 'claude', 'antigravity']);
  assert.equal(getLlmProviderDescriptor('codex').supportsSkills, false);
  assert.equal(getLlmProviderDescriptor('claude').supportsSkills, true);

  const original = {
    resolveCommand: codexCliAdapter.resolveCommand,
    runChat: codexCliAdapter.runChat,
    runTask: codexCliAdapter.runTask,
    runAutomation: codexCliAdapter.runAutomation,
    runConversation: codexCliAdapter.runConversation,
  };
  const calls = [];
  try {
    codexCliAdapter.resolveCommand = async (...args) => {
      calls.push(['resolve', ...args]);
      return { command: '/node', prefixArgs: ['codex.js'], pathEntries: ['/node-bin'] };
    };
    codexCliAdapter.runChat = async (input) => {
      calls.push(['chat', input]);
      return { code: null, assistantText: 'chat', conversationId: 'chat-conversation', toolEvents: 1 };
    };
    codexCliAdapter.runTask = async (input) => {
      calls.push(['task', input]);
      return { code: 2, assistantText: 'task', threadId: 'task-thread', toolEvents: 2 };
    };
    codexCliAdapter.runAutomation = async (input) => {
      calls.push(['automation', input]);
      return { assistantText: 'automation', toolEvents: 3 };
    };
    codexCliAdapter.runConversation = async (input) => {
      calls.push(['conversation', input]);
      return { code: 0, assistantText: 'conversation', toolEvents: 4 };
    };

    assert.deepEqual(await getLlmProviderDescriptor('codex').resolveCommand('/codex', ['/bin']), {
      command: '/node',
      prefixArgs: ['codex.js'],
      pathEntries: ['/node-bin'],
    });
    const chat = await getLlmProviderDescriptor('codex').run(descriptorInput({
      mode: 'chat',
      codexHome: '/codex-home',
      rootCodexHome: undefined,
      threadId: 'thread-1',
      networkAccess: true,
    }));
    await getLlmProviderDescriptor('codex').run(descriptorInput({
      mode: 'chat',
      codexHome: undefined,
      rootCodexHome: undefined,
      threadId: null,
    }));
    const task = await getLlmProviderDescriptor('codex').run(descriptorInput({ mode: 'task', model: 'gpt', effort: 'high' }));
    const automation = await getLlmProviderDescriptor('codex').run(descriptorInput({
      mode: 'automation',
      resolvedCommand: { command: '/resolved', prefixArgs: [], pathEntries: [] },
    }));
    const conversation = await getLlmProviderDescriptor('codex').run(descriptorInput());

    assert.deepEqual(chat, { code: 0, assistantText: 'chat', conversationId: 'chat-conversation', threadId: 'chat-conversation', usageDelta: undefined, toolEvents: 1, stdout: undefined, stderr: undefined });
    assert.equal(task.code, 2);
    assert.equal(task.threadId, 'task-thread');
    assert.equal(automation.code, 0);
    assert.equal(automation.threadId, undefined);
    assert.equal(conversation.assistantText, 'conversation');
    assert.equal(calls[1][1].model, 'gpt-5.2');
    assert.equal(calls[1][1].reasoningEffort, 'medium');
    assert.equal(calls[1][1].rootCodexHome, '/codex-home');
    assert.equal(calls[2][1].rootCodexHome, '');
    assert.equal(calls[2][1].threadId, undefined);
    assert.equal(calls[3][1].model, 'gpt');
    assert.equal(calls[3][1].reasoningEffort, 'high');
  } finally {
    Object.assign(codexCliAdapter, original);
  }
});

test('Claude and Antigravity descriptors preserve provider-specific public inputs', async () => {
  const originalClaude = claudeCliAdapter.run;
  const originalAntigravity = antigravityCliAdapter.run;
  const calls = [];
  try {
    claudeCliAdapter.run = async (input) => {
      calls.push(['claude', input]);
      return { code: 0, assistantText: 'claude', conversationId: 'claude-conversation', toolEvents: 0 };
    };
    antigravityCliAdapter.run = async (input) => {
      calls.push(['antigravity', input]);
      return { code: 0, assistantText: 'google', conversationId: 'google-conversation', toolEvents: 0 };
    };

    const claude = await getLlmProviderDescriptor('claude').run(descriptorInput({
      model: '',
      effort: '',
      alwaysIncludeMcpConfig: true,
      throwOnNonZero: false,
    }));
    const antigravity = await getLlmProviderDescriptor('antigravity').run(descriptorInput({
      model: 'gemini',
      effort: 'high',
      threadId: 'thread-google',
      timeoutMode: 'inactivity',
    }));

    assert.equal(claude.threadId, 'claude-conversation');
    assert.equal(calls[0][1].model, 'claude-sonnet-5');
    assert.equal(calls[0][1].effort, 'medium');
    assert.equal(calls[0][1].alwaysIncludeMcpConfig, true);
    assert.equal(antigravity.threadId, 'google-conversation');
    assert.equal(calls[1][1].conversationId, 'thread-google');
    assert.equal(calls[1][1].timeoutMode, 'inactivity');

    await getLlmProviderDescriptor('antigravity').run(descriptorInput({ threadId: undefined }));
    assert.equal(calls[2][1].conversationId, 'conversation-input');
  } finally {
    claudeCliAdapter.run = originalClaude;
    antigravityCliAdapter.run = originalAntigravity;
  }
});

const profile = (overrides = {}) => ({
  id: 'codex:work',
  provider: 'codex',
  label: 'Work',
  authMode: 'oauth',
  runtimeAuthMode: 'materialized',
  status: 'connected',
  active: true,
  ...overrides,
});

test('provider profile resolution rejects absent, mismatched, disconnected, and unsupported profiles', async () => {
  assert.equal(await resolveLlmProviderAuthContext('codex', undefined, async () => profile()), null);
  assert.equal(await resolveLlmProviderAuthContext('codex', 'codex:work'), null);
  await assert.rejects(
    resolveLlmProviderAuthContext('codex', 'codex:work', async () => null),
    /provider_auth_profile_not_found/,
  );
  await assert.rejects(
    resolveLlmProviderAuthContext('codex', 'codex:work', async () => profile({ id: 'codex:other' })),
    /provider_auth_profile_mismatch/,
  );
  await assert.rejects(
    resolveLlmProviderAuthContext('codex', 'codex:work', async () => profile({ provider: 'claude' })),
    /provider_auth_profile_mismatch/,
  );
  await assert.rejects(
    resolveLlmProviderAuthContext('codex', 'codex:work', async () => profile({ status: 'expired' })),
    /provider_auth_profile_not_connected/,
  );
  await assert.rejects(
    resolveLlmProviderAuthContext('codex', 'codex:work', async () => profile({ active: false })),
    /provider_auth_profile_not_active/,
  );
  await assert.rejects(
    resolveLlmProviderAuthContext('antigravity', 'antigravity:work', async () => profile({
      id: 'antigravity:work',
      provider: 'antigravity',
    })),
    /provider_auth_profile_unsupported/,
  );
});

test('provider profile resolution builds only provider-owned runtime environment', async () => {
  const codex = await resolveLlmProviderAuthContext('codex', 'codex:work', async () => profile({
    codexHome: '/profiles/codex',
    rootCodexHome: '/profiles/root',
  }));
  assert.deepEqual(codex, {
    profile: profile({ codexHome: '/profiles/codex', rootCodexHome: '/profiles/root' }),
    runtimeAuthMode: 'materialized',
    environment: { CODEX_HOME: '/profiles/codex' },
    codexHome: '/profiles/codex',
    rootCodexHome: '/profiles/root',
  });

  const claudeProfile = profile({
    id: 'claude:system',
    provider: 'claude',
    runtimeAuthMode: 'materialized',
    status: 'expired',
    connected: true,
    active: undefined,
    claudeConfigDir: '/profiles/claude',
  });
  assert.deepEqual(await resolveLlmProviderAuthContext('claude', 'claude:local-active', async () => claudeProfile), {
    profile: claudeProfile,
    runtimeAuthMode: 'materialized',
    environment: { CLAUDE_CONFIG_DIR: '/profiles/claude' },
  });

  const externalCodex = profile({ runtimeAuthMode: 'externalActiveOnly', codexHome: '/ignored', rootCodexHome: '/ignored-root' });
  assert.deepEqual(await resolveLlmProviderAuthContext('codex', 'codex:work', async () => externalCodex), {
    profile: externalCodex,
    runtimeAuthMode: 'externalActiveOnly',
    environment: {},
  });
  const materializedWithoutDirectories = profile({ codexHome: undefined, rootCodexHome: undefined });
  assert.deepEqual(await resolveLlmProviderAuthContext('codex', 'codex:work', async () => materializedWithoutDirectories), {
    profile: materializedWithoutDirectories,
    runtimeAuthMode: 'materialized',
    environment: {},
  });
});

test('workspace locks serialize equal normalized keys without blocking independent work', async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const order = [];
  const first = withWorkspaceLock(' workspace ', async () => {
    order.push('first-start');
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push('first-end');
    return 'first';
  });
  await firstStarted.promise;
  const second = withWorkspaceLock('workspace', async () => {
    order.push('second');
    return 'second';
  });
  const independent = await withWorkspaceLock('other', async () => 'independent');
  assert.equal(independent, 'independent');
  assert.deepEqual(order, ['first-start']);
  releaseFirst.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);

  await assert.rejects(withWorkspaceLock('workspace', async () => {
    throw new Error('callback_failed');
  }), /callback_failed/);
  assert.equal(await withWorkspaceLock('workspace', async () => 'recovered'), 'recovered');
});

test('manual workspace locks share the default key and release idempotently', async () => {
  const releaseFirst = await acquireWorkspaceLock(' ');
  let secondAcquired = false;
  const second = acquireWorkspaceLock('default').then((release) => {
    secondAcquired = true;
    release();
    release();
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false);
  releaseFirst();
  releaseFirst();
  await second;
  assert.equal(secondAcquired, true);

  const releaseFresh = await acquireWorkspaceLock('default');
  releaseFresh();
});
