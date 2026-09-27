import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLlmProviderRunService } = require('../../dist-electron/main/llm-provider/run-service.js');
for (const provider of ['codex', 'claude']) {
  test(`WhatsApp ${provider} restricts native tools and cannot inherit unsafe runtime mode`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-runtime-'));
    try {
      const service = createLlmProviderRunService();
      let actual;
      await service.run({ surface: 'personal_agent', mode: 'conversation', runtime: { provider, model: 'test-model', effort: 'medium', permissionMode: 'unsafe' }, localToolPolicy: 'mcp-only',
        threadId: 'PRIVATE_PREVIOUS_SESSION', sharedRoots: ['/private'], addDirs: ['/private'], imagePaths: ['/private/image.png'], cliPath: '/test/provider', checkReady: false, pathEntries: [], environment: {}, workingDir: root, prompt: 'Summarize this chat.', timeoutMs: 1000,
        mcpServers: [{ name: 'forger', url: 'http://127.0.0.1:1234/mcp', token: 'synthetic', tokenEnvVar: 'FORGER_MCP_TOKEN' }],
        runCommandCapture: async (command, args, options) => { actual = { command, args, options }; return { code: 0, stdout: '', stderr: '' }; } });
      assert.ok(actual);
      assert.ok(!actual.args.includes('PRIVATE_PREVIOUS_SESSION'));
      assert.ok(!actual.args.includes('/private'));
      assert.ok(!actual.args.includes('/private/image.png'));
      assert.ok(!actual.args.includes('--resume'));
      assert.ok(!actual.args.includes('resume'));
      assert.ok(!actual.args.includes('--dangerously-bypass-approvals-and-sandbox'));
      assert.ok(!actual.args.includes('bypassPermissions'));
      if (provider === 'codex') {
        assert.ok(actual.args.includes('features.shell_tool=false'));
        assert.ok(actual.args.includes('features.view_image=false'));
        assert.ok(actual.args.includes('default_permissions="forger_channel"'));
        assert.ok(actual.args.some(value => value.startsWith('permissions.forger_channel.filesystem=')));
        assert.ok(!actual.args.includes('--sandbox'));
      } else {
        assert.equal(actual.args[actual.args.indexOf('--tools') + 1], '');
        assert.ok(actual.args.includes('--strict-mcp-config'));
        assert.equal(actual.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
        assert.equal(actual.options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1');
        assert.ok(actual.args.includes('dontAsk'));
        assert.ok(!actual.args.some(value => value.includes('Bash')));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('real Codex OS sandbox reads a shared fixture and denies private sibling reads and writes', async (t) => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const exec = promisify(execFile);
  const cli = process.env.FORGER_CODEX_SANDBOX_TEST_CLI || 'codex';
  let help;
  try { help = await exec(cli, ['sandbox', '--help'], { timeout: 10_000 }); }
  catch { return t.skip('Codex CLI unavailable; adapter contract remains covered without a provider'); }
  if (process.platform !== 'darwin' || !help.stdout.includes('--permission-profile')) return t.skip('This host lacks the tested native Codex sandbox interface');
  const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-sandbox-'));
  try {
    const workspace = path.join(root, 'channel');
    await mkdir(workspace);
    const shared = path.join(workspace, 'shared.txt');
    const privateFile = path.join(root, 'private.txt');
    await writeFile(shared, 'shared-fixture');
    await writeFile(privateFile, 'private-fixture');
    const { codexChannelToolArgs } = require('../../dist-electron/main/llm-provider/channel-tool-policy.js');
    const args = ['sandbox', ...codexChannelToolArgs(workspace), '--permission-profile', 'forger_channel', '--'];
    const allowed = await exec(cli, [...args, '/bin/cat', shared], { timeout: 10_000 });
    assert.equal(allowed.stdout, 'shared-fixture');
    await assert.rejects(exec(cli, [...args, '/bin/cat', privateFile], { timeout: 10_000 }), error => {
      assert.equal(error.stdout, '');
      assert.match(error.stderr, /not permitted|Permission denied/);
      return true;
    });
    await assert.rejects(exec(cli, [...args, '/bin/sh', '-c', 'printf changed > "$1"', '--', privateFile], { timeout: 10_000 }));
    assert.equal(await readFile(privateFile, 'utf8'), 'private-fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('channel runtime rejects an adapter without an isolation contract before launching it', async () => {
  let launched = false;
  await assert.rejects(createLlmProviderRunService().run({
    surface: 'personal_agent', mode: 'conversation', runtime: { provider: 'antigravity', model: 'test', effort: 'medium' },
    localToolPolicy: 'mcp-only', checkReady: false, cliPath: '/test/provider', pathEntries: [], environment: {}, workingDir: '/test', prompt: 'test', timeoutMs: 1000,
    runCommandCapture: async () => { launched = true; return { code: 0, stdout: '', stderr: '' }; },
  }), /requires_codex_or_claude/);
  assert.equal(launched, false);
});

for (const mode of ['chat', 'task', 'automation']) {
  test(`Codex channel restrictions remain present for ${mode} execution`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-adapter-'));
    try {
      const calls = [];
      await createLlmProviderRunService().run({
        surface: 'personal_agent', mode, runtime: { provider: 'codex', model: 'test', effort: 'medium', permissionMode: 'unsafe' },
        localToolPolicy: 'mcp-only', checkReady: false, cliPath: '/test/provider', pathEntries: [], environment: {}, workingDir: root, prompt: 'test', timeoutMs: 1000,
        codexHomePlan: { type: 'provided', path: root },
        runCommandCapture: async (_command, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
      });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes('features.shell_tool=false'));
      assert.ok(calls[0].includes('default_permissions="forger_channel"'));
      assert.ok(!calls[0].includes('--dangerously-bypass-approvals-and-sandbox'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const provider of ['codex', 'claude']) {
  for (const networkAccess of [false, true]) {
    for (const mode of ['conversation', 'chat', 'task', 'automation']) {
      test(`${provider} channel ${mode} exposes public search only when internet is effective: ${networkAccess}`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-web-'));
        try {
          const calls = [];
          await createLlmProviderRunService().run({
            surface: 'personal_agent', mode, runtime: { provider, model: 'test', effort: 'medium', permissionMode: 'unsafe' },
            localToolPolicy: 'mcp-only', networkAccess, threadId: 'private-thread', checkReady: false,
            cliPath: '/test/provider', pathEntries: [], environment: {}, workingDir: root, prompt: 'Find a public fact.', timeoutMs: 1000,
            codexHomePlan: { type: 'provided', path: root },
            mcpServers: [{ name: 'forger', url: 'http://127.0.0.1:1234/mcp', token: 'synthetic', tokenEnvVar: 'FORGER_MCP_TOKEN' }],
            runCommandCapture: async (_command, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
          });
          assert.equal(calls.length, 1);
          const [args] = calls;
          assert.ok(!args.includes('private-thread'));
          assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
          if (provider === 'codex') {
            assert.ok(args.includes(`web_search="${networkAccess ? 'live' : 'disabled'}"`));
            assert.ok(args.includes('permissions.forger_channel.network.enabled=false'));
            for (const feature of ['shell_tool', 'plugins', 'apps', 'memories', 'js_repl', 'multi_agent']) {
              assert.ok(args.includes(`features.${feature}=false`));
            }
          } else {
            assert.equal(args[args.indexOf('--tools') + 1], networkAccess ? 'WebSearch' : '');
            assert.equal(args[args.indexOf('--allowedTools') + 1], networkAccess ? 'WebSearch,mcp__forger__*' : 'mcp__forger__*');
            assert.ok(args.includes('dontAsk'));
            assert.ok(!args.some(arg => /WebFetch|Bash|Read|Edit|Write/.test(arg)));
          }
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    }
  }
}

for (const networkAccess of [false, true]) {
  test(`Codex resumed adapter and model fallback retain the channel web boundary: ${networkAccess}`, async () => {
    const { CodexCliAdapter } = require('../../dist-electron/main/llm-provider/adapters/codex-cli-adapter.js');
    const root = await mkdtemp(path.join(tmpdir(), 'forger-channel-web-fallback-'));
    try {
      const calls = [];
      const input = { cliPath: '/test/provider', pathEntries: [], environment: {}, workingDir: root, codexHome: root, rootCodexHome: root,
        model: 'gpt-unsupported', reasoningEffort: 'low', timeoutMs: 1000, prompt: 'Search public data', localToolPolicy: 'mcp-only', networkAccess,
        runCommandCapture: async (_command, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } };
      const adapter = new CodexCliAdapter();
      await adapter.runConversation({ ...input, threadId: 'isolated-thread' });
      assert.ok(calls[0].includes('resume'));
      await adapter.runChat({ ...input, runCommandCapture: async (_command, args) => {
        calls.push(args);
        return args.includes('gpt-unsupported')
          ? { code: 1, stdout: '', stderr: "The 'gpt-unsupported' model is not supported" }
          : { code: 0, stdout: '', stderr: '' };
      } });
      assert.equal(calls.length, 3);
      for (const args of calls) {
        assert.ok(args.includes(`web_search="${networkAccess ? 'live' : 'disabled'}"`));
        assert.ok(args.includes('permissions.forger_channel.network.enabled=false'));
        assert.ok(args.includes('features.shell_tool=false'));
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
