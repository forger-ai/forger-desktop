import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const { RemoteAgentSessionService } = require('../../dist-electron/main/personal-agents/remote-session-service.js');

const now = '2026-01-01T00:00:00.000Z';

const conversation = (overrides = {}) => ({
  id: overrides.id ?? 'chat-1',
  agentId: overrides.agentId ?? 'agent-1',
  title: overrides.title ?? 'Remote chat',
  status: overrides.status ?? 'active',
  messages: overrides.messages ?? [],
  activeRun: overrides.activeRun,
  createdAt: now,
  updatedAt: now,
});

const createHarness = (overrides = {}) => {
  const eventListeners = [];
  const conversations = new Map((overrides.conversations ?? []).map((entry) => [entry.id, entry]));
  const manager = {
    onConversationEvent: (listener) => eventListeners.push(listener),
    createConversation: overrides.createConversation ?? (async ({ agentId, title }) => {
      const created = conversation({ id: `chat-${conversations.size + 1}`, agentId, title: title || 'Untitled' });
      conversations.set(created.id, created);
      return created;
    }),
    getConversation: overrides.getConversation ?? (async (id) => conversations.get(id) ?? null),
    sendMessage: overrides.sendMessage ?? (async ({ conversationId, content }) => {
      const current = conversations.get(conversationId);
      const updated = {
        ...current,
        messages: [...current.messages, { id: 'user-1', role: 'user', kind: 'message', content, createdAt: now }],
      };
      conversations.set(conversationId, updated);
      return updated;
    }),
  };
  const tunnels = [];
  const statuses = [];
  const closed = [];
  const logs = [];
  const tunnelProvider = overrides.tunnelProvider ?? {
    open: async ({ port }) => {
      const tunnel = {
        url: overrides.tunnelUrl ?? 'https://remote.example.test/path',
        closed: false,
        close: async () => { tunnel.closed = true; },
        port,
      };
      tunnels.push(tunnel);
      return tunnel;
    },
  };
  const service = new RemoteAgentSessionService({
    store: {
      requireAgent: overrides.requireAgent ?? (async (agentId) => ({ id: agentId, name: 'Remote agent', permissionMode: 'safe' })),
      listConversations: overrides.listConversations ?? (async (agentId) => [...conversations.values()].filter((entry) => entry.agentId === agentId)),
    },
    conversationManager: manager,
    tunnelProvider,
    appendInstallLog: overrides.appendInstallLog ?? (async (event, payload) => logs.push({ event, payload })),
    onStatusChanged: (status) => statuses.push(status),
    onSessionClosed: async (status) => closed.push(status),
  });
  return { closed, conversations, eventListeners, logs, manager, service, statuses, tunnels };
};

const authorizedHeaders = (status) => ({ Authorization: `Bearer ${status.authorizationToken}` });

const readWebSocketMessage = (socket) => new Promise((resolve, reject) => {
  socket.once('message', (data) => resolve(JSON.parse(data.toString())));
  socket.once('error', reject);
});

test('given session lifecycle variants, status, reuse, stop, and cleanup remain idempotent', async () => {
  const harness = createHarness();
  const defaultProviderService = new RemoteAgentSessionService({
    store: { requireAgent: async () => ({}) },
    conversationManager: { onConversationEvent: () => undefined },
  });
  assert.equal(defaultProviderService.status('never-started').state, 'inactive');
  await defaultProviderService.stopAll();

  assert.equal(harness.service.status('agent-1').state, 'inactive');
  assert.equal((await harness.service.stop('agent-1')).status.state, 'inactive');
  assert.equal(await harness.service.stopBySession('missing-session'), undefined);

  const first = await harness.service.start('agent-1');
  assert.equal(first.success, true);
  assert.equal(harness.service.status('agent-1'), first.status);
  assert.deepEqual(harness.service.activeSessionRequestIds(), []);
  const reusedWithoutRequest = await harness.service.start('agent-1');
  assert.equal(reusedWithoutRequest.status.sessionId, first.status.sessionId);
  const reused = await harness.service.start('agent-1', { requestId: 'request-1' });
  await harness.service.start('agent-1', { requestId: 'request-1' });
  assert.equal(reused.status.sessionId, first.status.sessionId);
  assert.deepEqual(harness.service.activeSessionRequestIds(), ['request-1']);

  const fakeSocket = { closed: false, close() { this.closed = true; } };
  harness.service.sessions.get('agent-1').sockets.add(fakeSocket);
  const stopped = await harness.service.stopBySession(first.status.sessionId);
  assert.equal(stopped.status.state, 'closed');
  assert.equal(fakeSocket.closed, true);
  assert.equal(harness.tunnels[0].closed, true);
  assert.deepEqual(harness.closed[0].requestIds, ['request-1']);
  assert.equal(harness.service.status('agent-1').state, 'inactive');

  const second = await harness.service.start('agent-2', { requestId: 'request-2' });
  const third = await harness.service.start('agent-3', { requestId: 'request-3' });
  assert.equal(second.success && third.success, true);
  await harness.service.stopAll();
  assert.deepEqual(harness.service.activeSessionRequestIds(), []);
});

test('given startup failures, peer identity and tunnel resources fail closed with stable status codes', async () => {
  const thrownValue = createHarness({ requireAgent: async () => { throw null; } });
  assert.equal((await thrownValue.service.start('agent-1')).technicalCode, 'personal_agent_not_found');

  const noTunnel = createHarness({
    tunnelProvider: { open: async () => { throw new Error('tunnel_unavailable'); } },
  });
  const failed = await noTunnel.service.start('agent-1');
  assert.equal(failed.technicalCode, 'tunnel_unavailable');
  assert.equal(failed.status.state, 'error');
  assert.equal(noTunnel.statuses.at(-1).status.state, 'error');

  const thrownTunnelValue = createHarness({
    tunnelProvider: { open: async () => { throw undefined; } },
  });
  assert.equal((await thrownTunnelValue.service.start('agent-1')).technicalCode, 'remote_agent_session_start_failed');

  const preListenFailure = createHarness({
    appendInstallLog: async () => { throw new Error('log_unavailable_before_listen'); },
  });
  assert.equal((await preListenFailure.service.start('agent-1')).technicalCode, 'log_unavailable_before_listen');

  let returnedTunnel;
  const readyLogFailure = createHarness({
    tunnelUrl: 'not a valid URL',
    appendInstallLog: async (event, payload) => {
      if (event === 'remote_agent_session:tunnel:ready') throw new Error(`log_failed:${payload.tunnelUrlOrigin}`);
    },
  });
  const originalOpen = readyLogFailure.service.provider.open;
  readyLogFailure.service.provider.open = async (input) => {
    returnedTunnel = await originalOpen(input);
    return returnedTunnel;
  };
  const failedAfterTunnel = await readyLogFailure.service.start('agent-1');
  assert.equal(failedAfterTunnel.technicalCode, 'log_failed:invalid_url');
  assert.equal(returnedTunnel.closed, true);
});

test('given bearer authentication and JSON variants, the HTTP surface rejects malformed and cross-agent requests', async () => {
  const locked = conversation({
    id: 'locked-chat',
    activeRun: { status: 'running', progress: [{ message: 'Working remotely' }] },
    messages: [{ id: 'system', role: 'system', kind: 'message', content: 'hidden', createdAt: now }],
  });
  const completed = conversation({
    id: 'completed-chat',
    activeRun: { status: 'completed', progress: [] },
    messages: [
      { id: 'intermediate', role: 'assistant', kind: 'intermediate', content: 'Last trace', createdAt: now },
      { id: 'assistant', role: 'assistant', kind: 'message', content: 'Visible answer', createdAt: now },
    ],
  });
  const foreign = conversation({ id: 'foreign-chat', agentId: 'agent-2' });
  const harness = createHarness({ conversations: [locked, completed, foreign] });
  const started = await harness.service.start('agent-1');
  const headers = authorizedHeaders(started.status);
  try {
    const wrongLength = await fetch(`${started.status.localUrl}/chats`, {
      headers: { Authorization: 'Bearer short' },
    });
    assert.equal(wrongLength.status, 401);
    const wrongSameLength = await fetch(`${started.status.localUrl}/chats`, {
      headers: { Authorization: `Bearer ${'x'.repeat(started.status.authorizationToken.length)}` },
    });
    assert.equal(wrongSameLength.status, 401);

    const list = await fetch(`${started.status.localUrl}/chats`, { headers });
    const listed = await list.json();
    assert.equal(listed.chats.find((chat) => chat.id === 'locked-chat').locked, true);
    assert.equal(listed.chats.find((chat) => chat.id === 'locked-chat').lastIntermediateMessage, 'Working remotely');
    assert.equal(listed.chats.find((chat) => chat.id === 'completed-chat').lastIntermediateMessage, 'Last trace');
    assert.equal(listed.chats.find((chat) => chat.id === 'completed-chat').lastMessage, 'Visible answer');

    const lockedResponse = await fetch(`${started.status.localUrl}/chats/locked-chat/message`, {
      method: 'POST', headers,
    });
    assert.equal(lockedResponse.status, 409);
    assert.equal((await lockedResponse.json()).error, 'chat_locked');

    const completedResponse = await fetch(`${started.status.localUrl}/chats/completed-chat/message`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 42 }),
    });
    assert.equal(completedResponse.status, 200);
    assert.equal((await completedResponse.json()).conversation.messages.at(-1).content, '');

    const emptyBody = await fetch(`${started.status.localUrl}/chats`, { method: 'POST', headers });
    assert.equal(emptyBody.status, 200);
    assert.equal((await emptyBody.json()).conversation.title, 'Untitled');
    const arrayBody = await fetch(`${started.status.localUrl}/chats`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '[]',
    });
    assert.equal(arrayBody.status, 200);

    const malformed = await fetch(`${started.status.localUrl}/chats`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(malformed.status, 400);
    assert.match((await malformed.json()).error, /JSON/);
    const tooLarge = await fetch(`${started.status.localUrl}/chats`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(70_000) }),
    });
    assert.equal(tooLarge.status, 400);
    assert.equal((await tooLarge.json()).error, 'remote_agent_body_too_large');

    const foreignResponse = await fetch(`${started.status.localUrl}/chats/foreign-chat`, { headers });
    assert.equal(foreignResponse.status, 400);
    assert.equal((await foreignResponse.json()).error, 'personal_agent_conversation_not_found');
    await assert.rejects(
      () => harness.service.requireSessionConversation('agent-1', '../unsafe'),
      /personal_agent_conversation_id_required/,
    );
  } finally {
    await harness.service.stopAll();
  }
});

test('given non-Buffer request chunks and unknown failures, request parsing preserves the public error contract', async () => {
  const harness = createHarness({ createConversation: async () => { throw null; } });
  const started = await harness.service.start('agent-1');
  try {
    let responseBody;
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(value) { responseBody = JSON.parse(value); },
    };
    const request = {
      method: 'POST',
      url: '/chats',
      headers: { authorization: `Bearer ${started.status.authorizationToken}` },
      async *[Symbol.asyncIterator]() { yield '{"title":"from string chunk"}'; },
    };
    await harness.service.handleRequest(
      { agentId: 'agent-1', sessionId: started.status.sessionId, token: started.status.authorizationToken },
      request,
      response,
    );
    assert.equal(response.statusCode, 400);
    assert.equal(responseBody.error, 'remote_agent_request_failed');

    const rootRequest = { method: 'GET', url: undefined, headers: request.headers };
    await harness.service.handleRequest(
      { agentId: 'agent-1', sessionId: started.status.sessionId, token: started.status.authorizationToken },
      rootRequest,
      response,
    );
    assert.equal(response.statusCode, 404);
  } finally {
    await harness.service.stopAll();
  }
});

test('given websocket peers, upgrade authentication, events, closed sockets, and stop all clean up deterministically', async () => {
  const chat = conversation({ id: 'chat-events' });
  const harness = createHarness({ conversations: [chat] });
  const started = await harness.service.start('agent-1');
  const session = harness.service.sessions.get('agent-1');
  try {
    const upgrade = session.server.listeners('upgrade')[0];
    const rejectedSocket = {
      output: '', destroyed: false,
      write(value) { this.output += value; },
      destroy() { this.destroyed = true; },
    };
    upgrade({ url: undefined, headers: {} }, rejectedSocket, Buffer.alloc(0));
    assert.match(rejectedSocket.output, /401 Unauthorized/);
    assert.equal(rejectedSocket.destroyed, true);

    const originalHandleUpgrade = session.websocketServer.handleUpgrade.bind(session.websocketServer);
    let missingSessionSocketClosed = false;
    session.websocketServer.handleUpgrade = (_request, _socket, _head, callback) => {
      harness.service.sessions.delete('agent-1');
      callback({ close: () => { missingSessionSocketClosed = true; } });
    };
    upgrade({
      url: '/chats/events',
      headers: { authorization: `Bearer ${started.status.authorizationToken}` },
    }, rejectedSocket, Buffer.alloc(0));
    assert.equal(missingSessionSocketClosed, true);
    harness.service.sessions.set('agent-1', session);
    session.websocketServer.handleUpgrade = originalHandleUpgrade;

    const socket = new WebSocket(started.status.localUrl.replace('http:', 'ws:') + '/chats/events', {
      headers: authorizedHeaders(started.status),
    });
    const connected = await readWebSocketMessage(socket);
    assert.equal(connected.type, 'connected');

    const eventPromise = readWebSocketMessage(socket);
    harness.eventListeners[0]({ type: 'conversation.updated', conversation: chat });
    const event = await eventPromise;
    assert.equal(event.chat.id, 'chat-events');

    const closedPeer = { readyState: WebSocket.CLOSED, send: () => { throw new Error('closed_socket_used'); } };
    session.sockets.add(closedPeer);
    harness.eventListeners[0]({ type: 'conversation.updated', conversation: chat });
    harness.eventListeners[0]({ type: 'conversation.updated', conversation: conversation({ agentId: 'other-agent' }) });
    session.sockets.delete(closedPeer);

    const closedPromise = new Promise((resolve) => socket.once('close', resolve));
    await harness.service.stop('agent-1');
    await closedPromise;
    assert.equal(session.sockets.size, 0);
  } finally {
    await harness.service.stopAll();
  }
});
