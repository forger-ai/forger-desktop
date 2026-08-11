import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildCodexMcpArgs,
  CodexCliAdapter,
  getMcpApprovalMode,
  parseCodexJsonl,
} = require('../../dist-electron/main/llm-provider/adapters/codex-cli-adapter.js');
const { DisallowedMcpServerError } = require('../../dist-electron/main/codex-run-isolation.js');

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const baseInput = (overrides = {}) => ({
  cliPath: '/opt/codex',
  pathEntries: ['/usr/bin'],
  environment: { CUSTOM: 'yes' },
  workingDir: '/workspace',
  sharedRoots: ['/shared'],
  prompt: 'hello',
  model: 'gpt-5.2',
  reasoningEffort: 'medium',
  permissionMode: 'approve',
  networkAccess: false,
  timeoutMs: 1_000,
  runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
  ...overrides,
});

test('Codex command resolution uses direct binaries and validates Windows shims', async (t) => {
  const adapter = new CodexCliAdapter();
  assert.deepEqual(await adapter.resolveCommand('/opt/codex', ['/usr/bin']), {
    command: '/opt/codex',
    prefixArgs: [],
    pathEntries: ['/opt', '/usr/bin'],
  });

  await withPlatform('win32', async () => {
    assert.deepEqual(await adapter.resolveCommand('C:\\tools\\codex.exe', ['C:\\bin']), {
      command: 'C:\\tools\\codex.exe',
      prefixArgs: [],
      pathEntries: ['.', 'C:\\bin'],
    });
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-codex-command-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const binOne = path.join(root, 'bin-one');
  const binTwo = path.join(root, 'bin-two');
  const packageBin = path.join(root, 'node_modules', '.bin');
  const cliPath = path.join(packageBin, 'codex.cmd');
  const entrypoint = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  await fs.mkdir(binOne, { recursive: true });
  await fs.mkdir(binTwo, { recursive: true });
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.mkdir(packageBin, { recursive: true });
  await fs.writeFile(cliPath, '', 'utf8');

  await withPlatform('win32', async () => {
    await assert.rejects(adapter.resolveCommand(cliPath, [binOne]), /codex_js_entrypoint_missing/);
    await fs.mkdir(path.join(binOne, 'node.exe'));
    await assert.rejects(adapter.resolveCommand(cliPath, [binOne]), /codex_js_entrypoint_missing/);
    await fs.rm(path.join(binOne, 'node.exe'), { recursive: true });
    await fs.writeFile(path.join(binTwo, 'node'), '', 'utf8');
    await assert.rejects(adapter.resolveCommand(cliPath, [binOne, binTwo]), /codex_js_entrypoint_missing/);
    await fs.writeFile(entrypoint, '', 'utf8');
    assert.deepEqual(await adapter.resolveCommand(cliPath, [binOne, binTwo]), {
      command: path.join(binTwo, 'node'),
      prefixArgs: [entrypoint],
      pathEntries: [binTwo, packageBin, binOne, binTwo],
    });
  });
});

test('Codex task, conversation, and automation runs expose command arguments and streams', async () => {
  const adapter = new CodexCliAdapter();
  const captures = [];
  const output = [];
  const child = {};
  const capture = async (command, args, options) => {
    captures.push({ command, args, options });
    options.onChild?.(child);
    options.onStdout('stdout-event');
    options.onStderr('stderr-event');
    return {
      code: captures.length,
      stdout: [
        JSON.stringify({ type: 'thread.started', thread_id: `thread-${captures.length}` }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      ].join('\n'),
      stderr: '',
    };
  };
  const mcpServers = [{
    name: 'forger',
    url: 'http://127.0.0.1:1234/mcp',
    tokenEnvVar: 'FORGER_TOKEN',
    token: 'secret',
    toolTimeoutSec: 30,
  }];
  const common = baseInput({
    codexHome: '/codex-home',
    sharedRoots: undefined,
    mcpServers,
    addDirs: ['/extra'],
    imagePaths: ['/image.png'],
    networkAccess: true,
    inactivityTimeoutMs: 250,
    onChild: (value) => output.push(['child', value]),
    onOutput: (...value) => output.push(value),
    runCommandCapture: capture,
  });

  const task = await adapter.runTask(common);
  const resumed = await adapter.runConversation({ ...common, threadId: 'resume-1' });
  await adapter.runConversation({ ...common, imagePaths: undefined, threadId: 'resume-2' });
  const fresh = await adapter.runConversation({
    ...common,
    mcpServers: undefined,
    addDirs: undefined,
    imagePaths: undefined,
    threadId: null,
  });
  await adapter.runConversation({ ...common, codexHome: undefined, threadId: null });
  const automated = await adapter.runAutomation({
    ...common,
    model: '',
    reasoningEffort: undefined,
    resolvedCommand: { command: '/node', prefixArgs: ['codex.js'], pathEntries: ['/node-bin'] },
  });
  const resolvedAutomation = await adapter.runAutomation({
    ...common,
    model: 'gpt-custom',
    reasoningEffort: 'high',
    resolvedCommand: undefined,
  });
  await adapter.runAutomation({
    ...common,
    mcpServers: undefined,
    codexHome: undefined,
    resolvedCommand: { command: '/node', prefixArgs: [], pathEntries: [] },
  });

  assert.equal(task.threadId, 'thread-1');
  assert.equal(resumed.threadId, 'thread-2');
  assert.equal(fresh.threadId, 'thread-4');
  assert.equal(automated.threadId, 'thread-6');
  assert.equal(resolvedAutomation.threadId, 'thread-7');
  assert.ok(captures[0].args.includes('--image'));
  assert.ok(captures[0].args.includes('--add-dir'));
  assert.ok(captures[1].args.includes('resume'));
  assert.equal(captures[1].args.includes('--add-dir'), false);
  assert.ok(captures[3].args.includes('-C'));
  assert.ok(captures[4].args.includes('--ask-for-approval'));
  assert.equal(captures[5].command, '/node');
  assert.ok(captures[5].args.includes('model_reasoning_effort="low"'));
  assert.ok(captures[5].args.includes('gpt-5.2'));
  assert.ok(captures[6].args.includes('gpt-custom'));
  assert.ok(captures[6].args.includes('model_reasoning_effort="high"'));
  assert.equal(captures[0].options.env.CODEX_HOME, '/codex-home');
  assert.equal(captures[0].options.env.FORGER_ALLOWED_ROOTS, '/workspace');
  assert.equal(captures[0].options.env.FORGER_TOKEN, 'secret');
  assert.equal(captures[0].options.env.CUSTOM, 'yes');
  assert.equal(captures[0].options.inactivityTimeoutMs, 250);
  assert.ok(output.some(([stream, text]) => stream === 'stdout' && text === 'stdout-event'));
  assert.ok(output.some(([stream, text]) => stream === 'stderr' && text === 'stderr-event'));
  assert.ok(output.some(([kind, value]) => kind === 'child' && value === child));

  const originalPath = process.env.PATH;
  delete process.env.PATH;
  const defaults = await adapter.runTask(baseInput({
    environment: {},
    pathEntries: [],
    sharedRoots: undefined,
    mcpServers: undefined,
    addDirs: undefined,
    imagePaths: undefined,
    codexHome: undefined,
    inactivityTimeoutMs: undefined,
    onOutput: undefined,
    onChild: undefined,
    runCommandCapture: async (_command, _args, options) => {
      assert.equal(options.env.CODEX_HOME, undefined);
      return { code: 0, stdout: '', stderr: 'plain fallback' };
    },
  })).finally(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });
  assert.equal(defaults.assistantText, 'plain fallback');
});

test('Codex chat retries unsupported custom models and removes generated homes', async (t) => {
  const adapter = new CodexCliAdapter();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-codex-chat-root-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'auth.json'), '{}', 'utf8');
  const attempts = [];
  const meta = [];
  let generatedHome;
  const result = await adapter.runChat(baseInput({
    rootCodexHome: root,
    codexHome: undefined,
    model: 'gpt-unsupported',
    reasoningEffort: 'high',
    threadId: undefined,
    mcpServers: [{ name: 'forger', url: 'http://mcp', tokenEnvVar: 'TOKEN', token: 'secret' }],
    onOutput: (...entry) => meta.push(entry),
    runCommandCapture: async (_command, args, options) => {
      attempts.push(args);
      generatedHome = options.env.CODEX_HOME;
      options.onStdout('chunk');
      options.onStderr('warning');
      return args.includes('gpt-unsupported')
        ? { code: 1, stdout: '', stderr: "The 'gpt-unsupported' model is not supported" }
        : { code: 0, stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fallback success' } }), stderr: '' };
    },
  }));

  assert.equal(result.assistantText, 'fallback success');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1].includes('gpt-5.2'));
  assert.ok(meta.some(([stream, text]) => stream === 'meta' && /Reintentando/.test(text)));
  assert.ok(meta.some(([stream, text]) => stream === 'stdout' && text === 'chunk'));
  assert.ok(meta.some(([stream, text]) => stream === 'stderr' && text === 'warning'));
  await assert.rejects(fs.stat(generatedHome), /ENOENT/);

  const noServersMeta = [];
  await adapter.runChat(baseInput({
    rootCodexHome: root,
    codexHome: undefined,
    sharedRoots: undefined,
    mcpServers: undefined,
    onOutput: (...entry) => noServersMeta.push(entry),
    runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
  }));
  assert.ok(noServersMeta.some(([stream, text]) => stream === 'meta' && text.includes('allowedMcpServers=(none)')));
});

test('Codex chat retries thrown unsupported-model errors and resumes existing threads', async () => {
  const adapter = new CodexCliAdapter();
  const attempts = [];
  const result = await adapter.runChat(baseInput({
    rootCodexHome: '/root-home',
    codexHome: '/provided-home',
    model: 'custom-model',
    threadId: 'thread-1',
    mcpServers: undefined,
    sharedRoots: undefined,
    inactivityTimeoutMs: undefined,
    onOutput: () => undefined,
    runCommandCapture: async (_command, args, options) => {
      attempts.push({ args, options });
      if (args.includes('custom-model')) {
        throw new Error('model custom-model is unsupported');
      }
      return { code: 0, stdout: JSON.stringify({ type: 'thread.started', thread_id: 'thread-2' }), stderr: '' };
    },
  }));
  assert.equal(result.threadId, 'thread-2');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].args.includes('resume'));
  assert.equal(attempts[0].options.inactivityTimeoutMs, 1_800_000);
});

test('Codex chat preserves disallowed MCP failures and classifies public failure codes', async () => {
  const adapter = new CodexCliAdapter();
  await assert.rejects(adapter.runChat(baseInput({
    rootCodexHome: '/root-home',
    codexHome: '/provided-home',
    mcpServers: [],
    runCommandCapture: async () => ({
      code: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'rogue' } }),
      stderr: '',
    }),
  })), (error) => error instanceof DisallowedMcpServerError && error.serverName === 'rogue');

  const cases = [
    [{ code: 1, stdout: '401 Unauthorized Failed to refresh token', stderr: '' }, 'codex_auth_expired'],
    [new Error('timed out due to inactivity after 100ms'), 'timeout'],
    [{ code: 1, stdout: "The 'gpt-5.2' model is not supported", stderr: '' }, 'model_unsupported'],
    [{ code: 1, stdout: 'HTTP 429 Too Many Requests', stderr: '' }, 'quota_exceeded'],
    [{ code: 1, stdout: '', stderr: '' }, 'capability_unavailable'],
  ];
  for (const [failure, expectedCode] of cases) {
    await assert.rejects(adapter.runChat(baseInput({
      rootCodexHome: '/root-home',
      codexHome: '/provided-home',
      runCommandCapture: async () => {
        if (failure instanceof Error) throw failure;
        return failure;
      },
    })), (error) => {
      assert.equal(error.chatCode, expectedCode);
      assert.equal(typeof error.parsedRun.assistantText, 'string');
      return true;
    });
  }
});

test('Codex output parsing keeps latest structured result and safe plain fallback', () => {
  assert.deepEqual(parseCodexJsonl('', ''), { assistantText: '', toolEvents: 0 });
  assert.deepEqual(parseCodexJsonl('', 'first\nsecond'), { assistantText: 'first\nsecond', threadId: undefined, usageDelta: undefined, toolEvents: 0 });
  assert.deepEqual(parseCodexJsonl([
    JSON.stringify({ type: 'thread.started', thread_id: 1 }),
    JSON.stringify({}),
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: null }),
    JSON.stringify({ type: 'item.completed', item: {} }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 5 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
    JSON.stringify({ type: 'turn.completed', usage: null }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, cached_input_tokens: 'bad', output_tokens: Number.NaN, reasoning_output_tokens: 3 } }),
    JSON.stringify({ type: 'other_tool_event' }),
  ].join('\n'), ''), {
    assistantText: 'final',
    threadId: 'thread-1',
    usageDelta: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 3, turns: 1 },
    toolEvents: 2,
  });
});

test('Codex MCP arguments assign approval modes and timeout defaults', () => {
  const forger = { name: 'forger', url: 'http://forger', tokenEnvVar: 'FORGER_TOKEN', token: 'secret' };
  const app = { name: 'app_demo', url: 'http://app', tokenEnvVar: 'APP_TOKEN', token: 'secret', toolTimeoutSec: 12 };
  assert.equal(getMcpApprovalMode(forger), 'auto');
  assert.equal(getMcpApprovalMode(app), 'approve');
  const args = buildCodexMcpArgs([forger, app]);
  assert.ok(args.includes('mcp_servers.forger.tool_timeout_sec=600'));
  assert.ok(args.includes('mcp_servers.app_demo.tool_timeout_sec=12'));
  assert.ok(args.includes('apps.forger.open_world_enabled=true'));
  assert.equal(buildCodexMcpArgs([]).length, 0);
});
