import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  claudeAllowedToolsArgs,
  ClaudeCliAdapter,
  parseClaudeJsonl,
  writeClaudeMcpConfig,
} = require('../../dist-electron/main/llm-provider/adapters/claude-cli-adapter.js');
const { DisallowedMcpServerError } = require('../../dist-electron/main/codex-run-isolation.js');

const baseInput = (overrides = {}) => ({
  cliPath: '/opt/claude',
  pathEntries: ['/usr/bin'],
  environment: { CUSTOM: 'yes' },
  workingDir: '/workspace',
  sharedRoots: ['/shared'],
  prompt: 'hello',
  model: 'claude-sonnet',
  effort: 'medium',
  permissionMode: 'safe',
  timeoutMs: 1_000,
  runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
  ...overrides,
});

const mcpServer = (overrides = {}) => ({
  name: 'forger',
  url: 'http://127.0.0.1:1234/mcp',
  tokenEnvVar: 'FORGER_TOKEN',
  token: 'secret',
  ...overrides,
});

test('Claude MCP config writes bearer environment references without storing tokens', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-claude-config-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const configPath = await writeClaudeMcpConfig(root, [mcpServer()]);
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(config, {
    mcpServers: {
      forger: {
        type: 'http',
        url: 'http://127.0.0.1:1234/mcp',
        headers: { Authorization: 'Bearer ${FORGER_TOKEN}' },
      },
    },
  });
  assert.equal(JSON.stringify(config).includes('secret'), false);
});

test('Claude allowed tools keep safe Bash access and sanitize MCP names', () => {
  assert.deepEqual(claudeAllowedToolsArgs([]), ['--allowedTools', 'Bash']);
  assert.deepEqual(claudeAllowedToolsArgs([], 'unsafe'), []);
  assert.deepEqual(claudeAllowedToolsArgs([
    mcpServer(),
    mcpServer(),
    mcpServer({ name: 'app_demo' }),
    mcpServer({ name: 'invalid.name' }),
  ], 'safe'), ['--allowedTools', 'Bash,mcp__forger__*,mcp__app_demo__*']);
  assert.deepEqual(claudeAllowedToolsArgs([mcpServer()], 'unsafe'), ['--allowedTools', 'mcp__forger__*']);
});

test('Claude run passes provider inputs, streams output, and removes temporary MCP config', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-claude-run-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const adapter = new ClaudeCliAdapter();
  const output = [];
  const child = {};
  let captured;
  const result = await adapter.run(baseInput({
    workingDir: root,
    configWorkspaceRoot: root,
    mcpServers: [mcpServer()],
    addDirs: ['/extra'],
    imagePaths: ['/image.png'],
    threadId: 'thread-old',
    inactivityTimeoutMs: 250,
    onChild: (value) => output.push(['child', value]),
    onOutput: (...entry) => output.push(entry),
    runCommandCapture: async (command, args, options) => {
      captured = { command, args, options };
      options.onChild(child);
      options.onStdout('out');
      options.onStderr('err');
      const configPath = args[args.indexOf('--mcp-config') + 1];
      assert.equal((await fs.stat(configPath)).isFile(), true);
      return {
        code: 0,
        stdout: [
          JSON.stringify({ type: 'assistant', message: { content: 'draft', usage: { input_tokens: 2, output_tokens: 1 } } }),
          JSON.stringify({ type: 'result', session_id: 'thread-new', result: 'done' }),
        ].join('\n'),
        stderr: '',
      };
    },
  }));

  assert.equal(result.assistantText, 'done');
  assert.equal(result.threadId, 'thread-new');
  assert.equal(result.conversationId, 'thread-new');
  assert.equal(captured.command, '/opt/claude');
  assert.ok(captured.args.includes('--resume'));
  assert.ok(captured.args.includes('--image'));
  assert.ok(captured.args.includes('--add-dir'));
  assert.ok(captured.args.includes('--mcp-config'));
  assert.equal(captured.options.env.FORGER_ALLOWED_ROOTS, [root, '/shared'].join(path.delimiter));
  assert.equal(captured.options.env.FORGER_TOKEN, 'secret');
  assert.equal(captured.options.env.CUSTOM, 'yes');
  assert.equal(captured.options.inactivityTimeoutMs, 250);
  assert.ok(output.some(([kind, value]) => kind === 'child' && value === child));
  assert.ok(output.some(([stream, text]) => stream === 'stdout' && text === 'out'));
  assert.ok(output.some(([stream, text]) => stream === 'stderr' && text === 'err'));
  assert.ok(output.some(([stream, text]) => stream === 'meta' && text.includes('allowedMcpServers=forger')));
  await assert.rejects(fs.stat(captured.args[captured.args.indexOf('--mcp-config') + 1]), /ENOENT/);
});

test('Claude run supports no-server defaults, caller-owned nonzero handling, and input thread fallback', async () => {
  const adapter = new ClaudeCliAdapter();
  const originalPath = process.env.PATH;
  delete process.env.PATH;
  let captured;
  try {
    const result = await adapter.run(baseInput({
      pathEntries: [],
      environment: {},
      sharedRoots: undefined,
      mcpServers: undefined,
      addDirs: undefined,
      imagePaths: undefined,
      threadId: 'existing',
      throwOnNonZero: false,
      alwaysIncludeMcpConfig: false,
      onOutput: undefined,
      inactivityTimeoutMs: undefined,
      runCommandCapture: async (command, args, options) => {
        captured = { command, args, options };
        return { code: 7, stdout: JSON.stringify({ type: 'text', text: 'kept' }), stderr: '' };
      },
    }));
    assert.equal(result.code, 7);
    assert.equal(result.assistantText, 'kept');
    assert.equal(result.threadId, 'existing');
    assert.equal(result.conversationId, 'existing');
    assert.equal(captured.args.includes('--mcp-config'), false);
    assert.equal(captured.args.includes('--image'), false);
    assert.equal(captured.args.includes('--add-dir'), false);
    assert.equal(captured.options.inactivityTimeoutMs, 1_000);
    assert.equal(captured.options.env.FORGER_ALLOWED_ROOTS, '/workspace');
    assert.equal(captured.options.env.PATH, '/opt');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }

  const noThread = await adapter.run(baseInput({
    threadId: null,
    runCommandCapture: async () => ({ code: 0, stdout: '', stderr: '' }),
  }));
  assert.equal(noThread.threadId, undefined);
  assert.equal(noThread.conversationId, null);
});

test('Claude run can include an empty MCP config and tolerates cleanup failure', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b26-claude-empty-config-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const adapter = new ClaudeCliAdapter();
  const originalRm = fs.rm;
  let configPath;
  fs.rm = async () => {
    throw new Error('cleanup_failed');
  };
  try {
    const result = await adapter.run(baseInput({
      workingDir: root,
      alwaysIncludeMcpConfig: true,
      mcpServers: [],
      onOutput: () => undefined,
      runCommandCapture: async (_command, args) => {
        configPath = args[args.indexOf('--mcp-config') + 1];
        assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), { mcpServers: {} });
        return { code: 0, stdout: 'plain answer', stderr: '' };
      },
    }));
    assert.equal(result.assistantText, 'plain answer');
    assert.equal((await fs.stat(configPath)).isFile(), true);
  } finally {
    fs.rm = originalRm;
    await fs.rm(configPath, { force: true });
  }
});

test('Claude run rejects disallowed tools, quota failures, and ordinary nonzero exits', async () => {
  const adapter = new ClaudeCliAdapter();
  await assert.rejects(adapter.run(baseInput({
    mcpServers: [],
    runCommandCapture: async () => ({
      code: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'rogue' } }),
      stderr: '',
    }),
  })), (error) => error instanceof DisallowedMcpServerError && error.serverName === 'rogue');

  const cases = [
    [{ code: 1, stdout: '', stderr: 'HTTP 429 Too Many Requests' }, 'quota_exceeded', /quota exceeded/],
    [{ code: 1, stdout: '', stderr: 'ordinary failure' }, undefined, /ordinary failure/],
    [{ code: 1, stdout: 'stdout failure', stderr: '' }, undefined, /stdout failure/],
    [{ code: 1, stdout: '', stderr: '' }, undefined, /claude_exec_failed/],
    [{ code: 0, stdout: JSON.stringify({ type: 'result', result: 'rate limit exceeded' }), stderr: '' }, 'quota_exceeded', /quota exceeded/],
  ];
  for (const [commandResult, chatCode, message] of cases) {
    await assert.rejects(adapter.run(baseInput({ runCommandCapture: async () => commandResult })), (error) => {
      assert.equal(error.chatCode, chatCode);
      assert.match(error.message, message);
      return true;
    });
  }
});

test('Claude JSONL parsing accepts legacy ids, usage shapes, text forms, and malformed lines', () => {
  assert.deepEqual(parseClaudeJsonl('', ''), { assistantText: '', toolEvents: 0 });
  assert.deepEqual(parseClaudeJsonl('', 'plain one\nplain two'), {
    assistantText: 'plain one\nplain two',
    threadId: undefined,
    usageDelta: undefined,
    toolEvents: 0,
  });

  const parsed = parseClaudeJsonl([
    JSON.stringify({ type: 3, sessionId: ' session-1 ' }),
    JSON.stringify({ type: 'tool.started', conversation_id: 'ignored-later' }),
    JSON.stringify({ type: 'usage', usage: { inputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, outputTokens: 5 } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ text: 'one' }, null, 3, { text: 5 }, { text: 'two' }] } }),
    JSON.stringify({ text: 'top-level' }),
    JSON.stringify({ result: 'result text' }),
  ].join('\n'), '');
  assert.deepEqual(parsed, {
    assistantText: 'result text',
    threadId: 'session-1',
    usageDelta: { inputTokens: 6, cachedInputTokens: 3, outputTokens: 5, reasoningOutputTokens: 0, turns: 1 },
    toolEvents: 1,
  });

  assert.deepEqual(parseClaudeJsonl([
    JSON.stringify({ conversation_id: 'conversation-1', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }),
    JSON.stringify({ message: null }),
    JSON.stringify({ message: 2 }),
    JSON.stringify({ message: { content: 4 } }),
    JSON.stringify({ message: { content: 'content text', usage: { input_tokens: Number.NaN, cache_read_input_tokens: 'bad', cache_creation_input_tokens: 0, output_tokens: 1 } } }),
  ].join('\n'), ''), {
    assistantText: 'content text',
    threadId: 'conversation-1',
    usageDelta: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, turns: 1 },
    toolEvents: 0,
  });
});
