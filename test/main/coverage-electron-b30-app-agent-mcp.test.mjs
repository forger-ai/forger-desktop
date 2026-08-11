import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildAntigravityArgs,
  parseAntigravityOutput,
  prepareAntigravityLogPath,
  readAntigravityLog,
  writeAntigravityMcpConfig,
} = require('../../dist-electron/main/app-agent/mcp.js');

const server = (name = 'forger') => ({
  name,
  url: `http://127.0.0.1/${name}`,
  token: `${name}-secret`,
  tokenEnvVar: `${name.toUpperCase()}_TOKEN`,
});

const fixture = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `forger-b30-${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
};

test('Given no MCP servers, when Antigravity setup runs, then it leaves the workspace untouched', async (t) => {
  const root = await fixture(t, 'mcp-empty');
  assert.equal(await writeAntigravityMcpConfig(root, []), null);
  await assert.rejects(fs.access(path.join(root, '.agents')));
});

test('Given a new workspace, when Antigravity MCP setup is cleaned, then the transient config is removed and the lock is reusable', async (t) => {
  const root = await fixture(t, 'mcp-new');
  const handle = await writeAntigravityMcpConfig(root, [server(), server('finance')]);
  assert.ok(handle);
  assert.deepEqual(JSON.parse(await fs.readFile(handle.configPath, 'utf8')), {
    mcpServers: {
      forger: { serverUrl: 'http://127.0.0.1/forger', headers: { Authorization: 'Bearer forger-secret' } },
      finance: { serverUrl: 'http://127.0.0.1/finance', headers: { Authorization: 'Bearer finance-secret' } },
    },
  });
  await handle.cleanup();
  await assert.rejects(fs.access(handle.configPath));

  const reused = await writeAntigravityMcpConfig(root, [server()]);
  await reused.cleanup();
});

test('Given an existing workspace config, when MCP setup is cleaned, then unrelated settings and exact bytes are restored', async (t) => {
  const root = await fixture(t, 'mcp-existing');
  const configPath = path.join(root, '.agents', 'mcp_config.json');
  const original = '{\n  "theme": "dark",\n  "mcpServers": { "existing": { "serverUrl": "http://old" } }\n}\n';
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, original);

  const handle = await writeAntigravityMcpConfig(root, [server()]);
  const merged = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.mcpServers.existing.serverUrl, 'http://old');
  assert.equal(merged.mcpServers.forger.headers.Authorization, 'Bearer forger-secret');
  await handle.cleanup();
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
});

test('Given malformed JSON shapes and a failed filesystem target, when setup runs, then it normalizes safely and releases its lock after errors', async (t) => {
  for (const [name, initial] of [
    ['invalid-json', '{'],
    ['array-root', '[]'],
    ['array-servers', '{"mcpServers":[]}'],
  ]) {
    const root = await fixture(t, `mcp-${name}`);
    const configPath = path.join(root, '.agents', 'mcp_config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, initial);
    const handle = await writeAntigravityMcpConfig(root, [server()]);
    assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers), ['forger']);
    await handle.cleanup();
  }

  const blockedRoot = await fixture(t, 'mcp-error');
  await fs.writeFile(path.join(blockedRoot, '.agents'), 'not-a-directory');
  await assert.rejects(writeAntigravityMcpConfig(blockedRoot, [server()]));
  await fs.rm(path.join(blockedRoot, '.agents'));
  const afterFailure = await writeAntigravityMcpConfig(blockedRoot, [server()]);
  await afterFailure.cleanup();
});

test('Given provider options, when Antigravity arguments are built, then sandbox and elevated modes are explicit', () => {
  assert.deepEqual(buildAntigravityArgs({ prompt: 'safe' }), [
    '--sandbox', '--print', 'safe', '--print-timeout', '5m',
  ]);
  assert.deepEqual(buildAntigravityArgs({
    prompt: 'configured',
    model: 'gemini-test',
    threadId: 'thread-1',
    addDirs: ['/shared/a', '/shared/b'],
    logFile: '/logs/run.log',
    hasMcpServers: true,
    timeout: '9m',
  }), [
    '--log-file', '/logs/run.log',
    '--model', 'gemini-test',
    '--conversation', 'thread-1',
    '--add-dir', '/shared/a',
    '--add-dir', '/shared/b',
    '--dangerously-skip-permissions',
    '--print', 'configured',
    '--print-timeout', '9m',
  ]);
  assert.ok(buildAntigravityArgs({ prompt: 'unsafe', permissionMode: 'unsafe' }).includes('--dangerously-skip-permissions'));
});

test('Given log labels and absent files, when Antigravity log helpers run, then paths are sanitized and reads fail closed', async (t) => {
  const root = await fixture(t, 'mcp-log');
  const sanitized = await prepareAntigravityLogPath(root, 'run / unsafe');
  assert.equal(path.basename(sanitized), 'antigravity-run-unsafe.log');
  const generated = await prepareAntigravityLogPath(root);
  assert.match(path.basename(generated), /^antigravity-[a-f0-9-]+\.log$/);
  assert.equal(await readAntigravityLog(), '');
  assert.equal(await readAntigravityLog(path.join(root, 'missing.log')), '');
  await fs.writeFile(sanitized, 'provider log');
  assert.equal(await readAntigravityLog(sanitized), 'provider log');
});

test('Given every documented conversation marker, when Antigravity output is parsed, then thread IDs, assistant text, and MCP events are extracted', () => {
  const markers = [
    'Print mode: conversation=print-id',
    'Created conversation created-id',
    'Streaming conversation stream-id',
    'conversationID="quoted-id"',
    'Conversation ID: generic-id',
    'agy --conversation cli-id',
  ];
  for (const marker of markers) {
    const parsed = parseAntigravityOutput('I will inspect\nFinal answer', `${marker}\nMCP tool: forger.read`, 'Llamando herramienta MCP finance.sync');
    assert.equal(parsed.assistantText, 'Final answer');
    assert.ok(parsed.threadId);
    assert.deepEqual(parsed.toolEvents.map((entry) => entry.label), ['forger.read', 'finance.sync']);
  }

  assert.deepEqual(parseAntigravityOutput([
    'I am preparing',
    'Authentication required.',
    'Waiting for authentication',
    'Or, paste the authorization code',
    'Visible answer',
  ].join('\n'), '', 'Calling MCP tool: app.run'), {
    assistantText: 'Visible answer',
    toolEvents: [{ type: 'mcp_tool_call', label: 'app.run' }],
  });
});
