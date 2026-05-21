import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  DisallowedMcpServerError,
  assertAllowedMcpServers,
  codexWorkspaceNetworkConfigArgs,
  createIsolatedCodexHome,
  preparePersistentIsolatedCodexHome,
  removeIsolatedCodexHome,
} = require('../../dist-electron/main/codex-run-isolation.js');

const mcpCallLine = (server) => JSON.stringify({
  item: {
    type: 'mcp_tool_call',
    server,
    tool: 'import_movements',
  },
});

test('allows Codex MCP tool call aliases for configured app servers', () => {
  const allowed = new Set(['forger', 'app_finance-os']);
  assert.doesNotThrow(() => {
    assertAllowedMcpServers(
      [
        mcpCallLine('forger'),
        mcpCallLine('mcp_forger__'),
        mcpCallLine('app_finance-os'),
        mcpCallLine('mcp_app_finance_os__'),
      ].join('\n'),
      '',
      allowed,
    );
  });
});

test('rejects MCP tool calls for servers outside the configured run', () => {
  assert.throws(
    () => assertAllowedMcpServers(mcpCallLine('mcp_other_app__'), '', new Set(['app_finance-os'])),
    (error) => error instanceof DisallowedMcpServerError
      && error.message === 'disallowed_mcp_server:mcp_other_app__',
  );
});

test('ignores non-JSON and non-MCP output while scanning allowed MCP servers', () => {
  assert.doesNotThrow(() => {
    assertAllowedMcpServers([
      'plain text',
      JSON.stringify({ item: { type: 'agent_message', server: 'mcp_other_app__' } }),
      JSON.stringify({ type: 'mcp_tool_call', server: 'mcp_other_app__' }),
    ].join('\n'), '', new Set());
  });
});

test('builds network config args only when network access is enabled', () => {
  assert.deepEqual(codexWorkspaceNetworkConfigArgs(false), []);
  assert.deepEqual(codexWorkspaceNetworkConfigArgs(true), [
    '--config',
    'sandbox_workspace_write.network_access=true',
  ]);
});

test('isolated Codex homes copy auth and write only trusted project config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-codex-isolation-'));
  const source = path.join(root, 'source');
  const trustedRoot = path.join(root, 'trusted');
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'auth.json'), '{"token":"secret"}', 'utf8');

    const isolated = await createIsolatedCodexHome(source, {
      prefix: 'forger-test-codex-home',
      trustedRoots: [trustedRoot, trustedRoot],
      networkAccess: true,
    });
    assert.equal(await readFile(path.join(isolated, 'auth.json'), 'utf8'), '{"token":"secret"}');
    const isolatedConfig = await readFile(path.join(isolated, 'config.toml'), 'utf8');
    assert.match(isolatedConfig, /network_access = true/);
    assert.equal((isolatedConfig.match(/\[projects\./g) ?? []).length, 1);
    assert.match(isolatedConfig, /trust_level = "trusted"/);

    const persistent = path.join(root, 'persistent-home');
    assert.equal(await preparePersistentIsolatedCodexHome(source, persistent, {
      trustedRoots: [trustedRoot],
      networkAccess: false,
    }), persistent);
    const persistentConfig = await readFile(path.join(persistent, 'config.toml'), 'utf8');
    assert.doesNotMatch(persistentConfig, /network_access = true/);

	    await removeIsolatedCodexHome(isolated);
	    await assert.rejects(() => stat(isolated), /ENOENT/);
	    await removeIsolatedCodexHome(persistent);
	    assert.equal((await stat(persistent)).isDirectory(), true);

	    const invalidSource = path.join(root, 'invalid-source');
	    await mkdir(path.join(invalidSource, 'auth.json'), { recursive: true });
	    await assert.rejects(
	      () => createIsolatedCodexHome(invalidSource, {
	        prefix: 'forger-test-invalid-codex-home',
	        trustedRoots: [trustedRoot],
	      }),
	      /EISDIR|ENOTSUP|illegal operation|operation not permitted/i,
	    );
	  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
