import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const adapterPath = require.resolve('../../dist-electron/main/llm-provider/adapters/antigravity-cli-adapter.js');

const loadAdapter = (state) => {
  const original = Module._load;
  Module._load = function mocked(request, parent, isMain) {
    if (request === '../../codex-run-isolation') return { assertAllowedMcpServers: (...args) => state.allowed.push(args) };
    if (request === '../../app-agent/mcp') return {
      buildAntigravityArgs: (input) => { state.args.push(input); return ['run']; },
      parseAntigravityOutput: () => state.parsed,
      prepareAntigravityLogPath: async (root, runId) => path.join(root, `${runId}.log`),
      readAntigravityLog: async () => 'log text',
      writeAntigravityMcpConfig: async () => state.mcpConfig,
    };
    if (request === '../../../shared/agent-runtime-registry') return { resolveAntigravityCliModel: () => 'cli-model' };
    if (request === '../provider-errors') return {
      detectProviderQuotaError: () => state.quota,
      createProviderQuotaError: () => new Error('quota'),
    };
    return original.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[adapterPath];
    return new (require(adapterPath).AntigravityCliAdapter)();
  } finally {
    Module._load = original;
  }
};

const inputFor = (overrides = {}) => ({
  runId: 'run', cliPath: '/bin/agy', workingDir: '/work', prompt: 'hello', pathEntries: [], environment: {}, timeoutMs: 100,
  runCommandCapture: async (_command, _args, options) => {
    options.onStdout('stdout chunk');
    options.onStderr('stderr chunk');
    return { code: 0, stdout: 'stdout', stderr: '' };
  },
  ...overrides,
});

test('Antigravity adapter builds isolated environments and reports success with and without optional metadata', async () => {
  const events = [];
  const outputs = [];
  const state = { allowed: [], args: [], quota: null, parsed: { assistantText: 'Answer', threadId: 'thread', toolEvents: [1] }, mcpConfig: null };
  const adapter = loadAdapter(state);
  const success = await adapter.run(inputFor({ onEvent: (event) => events.push(event), onOutput: (...args) => outputs.push(args) }));
  assert.equal(success.conversationId, 'thread');
  assert.equal(success.toolEvents, 1);
  assert.ok(events.some((event) => event.type === 'conversation'));
  assert.ok(outputs.some(([stream]) => stream === 'stderr'));

  let cleaned = 0;
  state.mcpConfig = { configPath: '/config', cleanup: async () => { cleaned += 1; throw new Error('cleanup'); } };
  state.parsed = { assistantText: '', threadId: null, toolEvents: [] };
  let captureOptions;
  const fallback = await adapter.run(inputFor({
    configWorkspaceRoot: '/config-root', model: 'model', effort: 'high', conversationId: 'existing',
    mcpServers: [{ name: 'tool', tokenEnvVar: 'TOOL_TOKEN', token: 'secret' }], sharedRoots: ['/shared'], pathEntries: ['/tools'],
    timeoutMode: 'inactivity', inactivityTimeoutMs: undefined,
    runCommandCapture: async (_command, _args, options) => { captureOptions = options; return { code: 0, stdout: '', stderr: '' }; },
  }));
  assert.match(fallback.assistantText, /Listo/);
  assert.equal(fallback.conversationId, 'existing');
  assert.equal(captureOptions.inactivityTimeoutMs, 100);
  assert.equal(captureOptions.env.TOOL_TOKEN, 'secret');
  assert.equal(cleaned, 1);

  state.mcpConfig = { configPath: '/config', cleanup: async () => { cleaned += 1; } };
  const previousPath = process.env.PATH;
  delete process.env.PATH;
  try {
    const noConversation = await adapter.run(inputFor());
    assert.equal(noConversation.conversationId, null);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('Antigravity adapter classifies quota, exit, and primitive execution failures', async () => {
  for (const scenario of [
    { quota: { code: 'quota' }, result: { code: 0, stdout: '', stderr: '' }, message: 'quota' },
    { quota: null, result: { code: 1, stdout: 'stdout failed', stderr: '' }, message: 'stdout failed' },
    { quota: null, result: { code: 1, stdout: '', stderr: 'stderr failed' }, message: 'stderr failed' },
    { quota: null, result: { code: 1, stdout: '', stderr: '' }, message: 'antigravity_exec_failed' },
  ]) {
    const events = [];
    const state = { allowed: [], args: [], quota: scenario.quota, parsed: { assistantText: '', threadId: null, toolEvents: [] }, mcpConfig: scenario.quota ? { configPath: '/config', cleanup: async () => undefined } : null };
    const adapter = loadAdapter(state);
    await assert.rejects(adapter.run(inputFor({
      onEvent: (event) => events.push(event),
      runCommandCapture: async () => scenario.result,
    })), new RegExp(scenario.message));
    assert.equal(events.at(-1).type, 'failed');
  }
  const state = { allowed: [], args: [], quota: null, parsed: {}, mcpConfig: null };
  const adapter = loadAdapter(state);
  await assert.rejects(adapter.run(inputFor({ runCommandCapture: async () => { throw 'primitive'; }, onEvent: () => undefined })), (error) => error === 'primitive');
});

test('Antigravity preserves the provider failure and cleans MCP config when the failed observer throws', async () => {
  const order = [];
  const providerFailure = new Error('provider failed');
  const state = {
    allowed: [],
    args: [],
    quota: null,
    parsed: {},
    mcpConfig: {
      configPath: '/config',
      cleanup: async () => { order.push('cleanup'); },
    },
  };
  const adapter = loadAdapter(state);

  await assert.rejects(adapter.run(inputFor({
    runCommandCapture: async () => {
      order.push('run');
      throw providerFailure;
    },
    onEvent: (event) => {
      if (event.type !== 'failed') return;
      order.push('failed-event');
      throw new Error('observer failed');
    },
  })), (error) => error === providerFailure);
  assert.deepEqual(order, ['run', 'failed-event', 'cleanup']);
});
