import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPersonalAgentMcpBindings } = require('../../dist-electron/main/core/personal-agent-mcp-bindings.js');

test('personal agent MCP bindings carry channel, voice, and grants into the run-scoped session', async () => {
  const sessions = [];
  const released = [];
  const listened = [];
  const server = {
    createSession: (...args) => {
      sessions.push(args);
      return { url: 'http://127.0.0.1:49001/mcp', token: 'session-token' };
    },
    releaseSession: (token) => released.push(`session:${token}`),
  };
  const appMcpManager = {
    listenMcps: async (appIds, runId) => {
      listened.push({ appIds, runId });
      return [{ name: 'installed-app' }];
    },
    releaseMcps: (runId) => released.push(`apps:${runId}`),
  };
  const registry = { apps: { installed: { installDir: '/private/apps/installed' }, missingRoot: {} } };
  const bindings = createPersonalAgentMcpBindings({
    getForgerMcpServer: () => server,
    getAppMcpManager: () => appMcpManager,
    getRegistry: () => registry,
  });
  const agent = {
    id: 'agent-1', canSpawnAgents: true,
    appIds: ['installed'], toolIds: ['memory_list'],
    connectionGrants: [{ type: 'whatsapp', actions: ['whatsapp.history'] }],
  };
  const channel = { kind: 'whatsapp', connectionId: 'connection-1', chatId: 'chat-1', bindingId: 'binding-1', revision: 3, allowAgentCapabilities: false };
  const context = {
    conversationId: 'conversation-1', peerThreadId: 'peer-1', callStackAgentIds: [agent.id],
    channel, sidekick: { sidekickId: 'desk', locale: 'es-CL' },
  };

  assert.deepEqual(bindings.createForgerMcpSession('run-1', agent, context), {
    url: 'http://127.0.0.1:49001/mcp', token: 'session-token',
  });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].slice(0, 2), ['run-1', 'forger']);
  assert.deepEqual(sessions[0][2], {
    caller: 'personal-agent',
    personalAgentId: agent.id,
    personalAgentConversationId: context.conversationId,
    personalAgentPeerThreadId: context.peerThreadId,
    personalAgentCallStackIds: [agent.id],
    personalAgentCanSpawnAgents: true,
    whatsappChannel: channel,
    sidekick: { sidekickId: 'desk' },
    appIds: ['installed'],
    officialToolActionIds: ['memory_list'],
    forgerToolActionIds: ['memory_list'],
    connectionGrants: agent.connectionGrants,
  });
  bindings.createForgerMcpSession('run-without-voice', agent, {
    conversationId: 'conversation-2', callStackAgentIds: [agent.id], channel,
  });
  assert.equal(sessions[1][2].sidekick, undefined);
  assert.deepEqual(await bindings.listenAppMcps(['installed', 'unknown', 'missingRoot'], 'run-1'), [{ name: 'installed-app' }]);
  assert.deepEqual(listened, [{ appIds: ['installed', 'missingRoot'], runId: 'run-1' }]);
  assert.deepEqual(await bindings.resolveAppTrustedRoots(['installed', 'missingRoot', 'unknown']), ['/private/apps/installed']);
  bindings.releaseForgerMcpSession('session-token');
  bindings.releaseAppMcps('run-1');
  assert.deepEqual(released, ['session:session-token', 'apps:run-1']);
});

test('personal agent MCP bindings keep optional integrations unavailable without leaking capabilities', async () => {
  const bindings = createPersonalAgentMcpBindings({
    getForgerMcpServer: () => null,
    getAppMcpManager: () => null,
    getRegistry: () => ({ apps: {} }),
  });
  const agent = { id: 'agent-1', canSpawnAgents: false, appIds: [], toolIds: [], connectionGrants: [] };
  assert.equal(bindings.createForgerMcpSession('run-2', agent, {
    conversationId: 'conversation-2', callStackAgentIds: [agent.id],
  }), null);
  assert.deepEqual(await bindings.listenAppMcps(['unknown'], 'run-2'), []);
  assert.deepEqual(await bindings.resolveAppTrustedRoots(['unknown']), []);
  assert.doesNotThrow(() => bindings.releaseForgerMcpSession('missing'));
  assert.doesNotThrow(() => bindings.releaseAppMcps('run-2'));
});
