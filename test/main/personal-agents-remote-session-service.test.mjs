import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('../../dist-electron/main/personal-agents/agent-store.js');
const { AgentConversationManager } = require('../../dist-electron/main/personal-agents/agent-conversation-manager.js');
const { RemoteAgentSessionService } = require('../../dist-electron/main/personal-agents/remote-session-service.js');

test('remote agent session service is allowlisted, localhost-only, and backed by personal agent conversations', async () => {
  const metadataRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-remote-meta-'));
  const forgerHomeRoot = await mkdtemp(path.join(tmpdir(), 'forger-personal-agents-remote-home-'));
  const store = new AgentStore({ metadataRoot, forgerHomeRoot });
  const conversationManager = new AgentConversationManager({
    store,
    runner: async ({ onProgress }) => {
      onProgress('Remote bridge progress');
      return { assistantText: 'Remote bridge ready.' };
    },
  });
  const logs = [];
  const tunnels = [];
  const statuses = [];
  const closedSessions = [];
  const service = new RemoteAgentSessionService({
    store,
    conversationManager,
    appendInstallLog: async (event, payload) => logs.push({ event, payload }),
    onStatusChanged: (event) => statuses.push(event),
    onSessionClosed: (event) => closedSessions.push(event),
    tunnelProvider: {
      open: async ({ port, appId, sessionId }) => {
        const tunnel = {
          url: `https://${appId}-${sessionId.slice(0, 8)}.example.test`,
          port,
          closed: false,
          close: async () => {
            tunnel.closed = true;
          },
        };
        tunnels.push(tunnel);
        return tunnel;
      },
    },
  });

  try {
    const invalid = await service.start('../unsafe');
    assert.equal(invalid.success, false);
    assert.equal(invalid.technicalCode, 'remote_agent_id_invalid');

    const missing = await service.start('agent-missing');
    assert.equal(missing.success, false);
    assert.equal(missing.technicalCode, 'personal_agent_not_found');

    const unsafeAgent = await store.createAgent({ name: 'Unsafe remote', permissionMode: 'unsafe' });
    const unsafe = await service.start(unsafeAgent.id);
    assert.equal(unsafe.success, false);
    assert.equal(unsafe.technicalCode, 'remote_agent_unsafe_permission_not_allowed');

    const agent = await store.createAgent({ name: 'Research partner' });
    const requesterMobileDevice = { id: 91, name: 'Felipe iPhone' };
    const started = await service.start(agent.id, { requesterMobileDevice, requestId: 'agent-request-1' });
    assert.equal(started.success, true);
    assert.equal(started.status.state, 'ready');
    const reused = await service.start(agent.id, { requestId: 'agent-request-2' });
    assert.equal(reused.success, true);
    assert.equal(reused.status.sessionId, started.status.sessionId);
    assert.deepEqual(service.activeSessionRequestIds(), ['agent-request-1', 'agent-request-2']);
    assert.equal(tunnels.length, 1);
    assert.deepEqual(statuses.map((entry) => ({
      state: entry.status.state,
      requester: entry.requesterMobileDevice?.name,
    })), [
      { state: 'preparing', requester: 'Felipe iPhone' },
      { state: 'ready', requester: 'Felipe iPhone' },
    ]);
    assert.match(started.status.localUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.match(started.status.tunnelUrl, /^https:\/\/personal-agent-/);
    assert.equal(typeof started.status.authorizationToken, 'string');
    assert.deepEqual(started.status.allowedPaths, [
      '/health',
      '/chats',
      '/chats/:id',
      '/chats/:id/message',
      '/chats/events',
    ]);
    assert.equal(started.status.localUrl.includes(agent.name), false);
    assert.equal(started.status.tunnelUrl.includes(agent.name), false);

    const health = await fetch(`${started.status.localUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const unauthorized = await fetch(`${started.status.localUrl}/chats`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    const session = service.sessions.get(agent.id);
    const headers = {
      Authorization: `Bearer ${session.token}`,
      'Content-Type': 'application/json',
    };
    const startedConversationResponse = await fetch(`${started.status.localUrl}/chats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Launch plan' }),
    });
    assert.equal(startedConversationResponse.status, 200);
    const startedConversation = await startedConversationResponse.json();
    assert.equal(startedConversation.conversation.agentId, agent.id);
    assert.equal(startedConversation.conversation.messages.length, 0);
    assert.equal(startedConversation.chat.lastRunStatus, 'idle');

    const chatsResponse = await fetch(`${started.status.localUrl}/chats`, { headers });
    assert.equal(chatsResponse.status, 200);
    const chatsPayload = await chatsResponse.json();
    assert.equal(chatsPayload.chats[0].id, startedConversation.conversation.id);

    const messageResponse = await fetch(`${started.status.localUrl}/chats/${startedConversation.conversation.id}/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: 'Draft a first pass.',
      }),
    });
    assert.equal(messageResponse.status, 200);
    const messagePayload = await messageResponse.json();
    assert.equal(messagePayload.conversation.messages.length, 1);
    assert.equal(messagePayload.conversation.title, 'Draft a first pass.');
    const completedMessageConversation = await waitForRemoteConversation(started.status.localUrl, headers, startedConversation.conversation.id, (conversation) =>
      conversation.messages.length === 3);
    assert.equal(completedMessageConversation.messages[1].kind, 'intermediate');
    assert.equal(completedMessageConversation.messages[2].content, 'Remote bridge ready.');
    const blocked = await fetch(`${started.status.localUrl}/debug/raw-memory`, {
      method: 'GET',
      headers,
    });
    assert.equal(blocked.status, 404);
    const stoppedBySession = await service.stopBySession(started.status.sessionId);
    assert.equal(stoppedBySession.success, true);
    assert.equal(stoppedBySession.status.state, 'closed');
    assert.deepEqual(service.activeSessionRequestIds(), []);
    assert.deepEqual(closedSessions.map((entry) => ({
      agentId: entry.agentId,
      requestIds: entry.requestIds,
      state: entry.status.state,
    })), [
      { agentId: agent.id, requestIds: ['agent-request-1', 'agent-request-2'], state: 'closed' },
    ]);
    assert.equal(tunnels[0].closed, true);
    assert.deepEqual(logs.map((entry) => entry.event), [
      'remote_agent_session:start',
      'remote_agent_session:tunnel:start',
      'remote_agent_session:tunnel:ready',
    ]);
  } finally {
    await service.stopAll();
    await rm(metadataRoot, { recursive: true, force: true });
    await rm(forgerHomeRoot, { recursive: true, force: true });
  }
});

const waitForRemoteConversation = async (localUrl, headers, conversationId, predicate) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${localUrl}/chats/${conversationId}`, { headers });
    assert.equal(response.status, 200);
    const payload = await response.json();
    if (predicate(payload.conversation)) {
      return payload.conversation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('remote_conversation_wait_timeout');
};
