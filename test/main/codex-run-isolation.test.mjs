import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DisallowedMcpServerError,
  assertAllowedMcpServers,
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
