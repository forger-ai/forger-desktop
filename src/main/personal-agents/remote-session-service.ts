import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

import type { PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentMessage, PersonalAgentRunStatus, RemoteActivityRequester, RemoteAgentSessionResult, RemoteAgentSessionStatus } from '../../shared/types';
import { listenLocal, LocalTunnelProvider, type RemoteTunnel, type RemoteTunnelProvider } from '../remote-tunnel-provider';
import type { AgentConversationManager } from './agent-conversation-manager';
import type { AgentStore } from './agent-store';

interface RemoteAgentSessionServiceOptions {
  store: AgentStore;
  conversationManager: AgentConversationManager;
  appendInstallLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  tunnelProvider?: RemoteTunnelProvider;
  onStatusChanged?: (input: { agentId: string; agentName: string; status: RemoteAgentSessionStatus; requesterMobileDevice?: RemoteActivityRequester }) => void;
  onSessionClosed?: (input: { agentId: string; agentName: string; requestIds: string[]; status: RemoteAgentSessionStatus }) => Promise<void> | void;
}

interface RemoteAgentSession {
  agentId: string;
  agentName: string;
  requestIds: Set<string>;
  sessionId: string;
  token: string;
  server: http.Server;
  websocketServer: WebSocketServer;
  tunnel: RemoteTunnel;
  status: RemoteAgentSessionStatus;
  sockets: Set<WebSocket>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_WS_FRAME_BYTES = 256 * 1024;
const ALLOWED_REMOTE_AGENT_PATHS = [
  '/health',
  '/chats',
  '/chats/:id',
  '/chats/:id/message',
  '/chats/events',
];

export class RemoteAgentSessionService {
  private readonly sessions = new Map<string, RemoteAgentSession>();
  private readonly provider: RemoteTunnelProvider;

  public constructor(private readonly options: RemoteAgentSessionServiceOptions) {
    this.provider = options.tunnelProvider ?? new LocalTunnelProvider();
    this.options.conversationManager.onConversationEvent((event) => {
      this.broadcastConversationEvent(event);
    });
  }

  public status(agentId: string): RemoteAgentSessionStatus {
    return this.sessions.get(agentId)?.status ?? { active: false, agentId, state: 'inactive' };
  }

  public activeSessionRequestIds(): string[] {
    return [...this.sessions.values()]
      .flatMap((session) => [...session.requestIds])
      .filter((requestId, index, requestIds) => requestIds.indexOf(requestId) === index);
  }

  public async start(agentId: string, options: { requesterMobileDevice?: RemoteActivityRequester; requestId?: string } = {}): Promise<RemoteAgentSessionResult> {
    if (!isSafeAgentId(agentId)) {
      return {
        success: false,
        technicalCode: 'remote_agent_id_invalid',
        status: { active: false, agentId: 'unknown', state: 'error', technicalCode: 'remote_agent_id_invalid' },
      };
    }
    const existing = this.sessions.get(agentId);
    if (existing) {
      if (options.requestId) existing.requestIds.add(options.requestId);
      return { success: true, status: existing.status };
    }

    let agentName = agentId;
    try {
      const agent = await this.options.store.requireAgent(agentId);
      agentName = agent.name;
      if (agent.permissionMode === 'unsafe') {
        return {
          success: false,
          technicalCode: 'remote_agent_unsafe_permission_not_allowed',
          status: { active: false, agentId, state: 'error', technicalCode: 'remote_agent_unsafe_permission_not_allowed' },
        };
      }
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : 'personal_agent_not_found';
      return {
        success: false,
        technicalCode,
        status: { active: false, agentId, state: 'error', technicalCode },
      };
    }
    const sessionId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const preparing: RemoteAgentSessionStatus = { active: true, agentId, state: 'preparing', sessionId };
    this.options.onStatusChanged?.({ agentId, agentName, status: preparing, requesterMobileDevice: options.requesterMobileDevice });
    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
    const server = http.createServer((request, response) => {
      void this.handleRequest({ agentId, sessionId, token }, request, response);
    });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/chats/events' || !isAuthorized(request, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (remoteSocket) => {
        const active = this.sessions.get(agentId);
        if (!active) {
          remoteSocket.close();
          return;
        }
        active.sockets.add(remoteSocket);
        remoteSocket.on('close', () => {
          active.sockets.delete(remoteSocket);
        });
        remoteSocket.send(JSON.stringify({ type: 'connected', agentId, sessionId }));
      });
    });
    let tunnel: RemoteTunnel | undefined;
    try {
      await this.options.appendInstallLog?.('remote_agent_session:start', {
        agentId,
        sessionIdPrefix: sessionId.slice(0, 8),
      });
      const port = await listenLocal(server);
      await this.options.appendInstallLog?.('remote_agent_session:tunnel:start', {
        agentId,
        sessionIdPrefix: sessionId.slice(0, 8),
        port,
      });
      tunnel = await this.provider.open({ port, appId: `personal-agent-${agentId}`, sessionId });
      await this.options.appendInstallLog?.('remote_agent_session:tunnel:ready', {
        agentId,
        sessionIdPrefix: sessionId.slice(0, 8),
        tunnelUrlOrigin: safeUrlOrigin(tunnel.url),
      });
      const status: RemoteAgentSessionStatus = {
        active: true,
        agentId,
        state: 'ready',
        sessionId,
        localUrl: `http://127.0.0.1:${port}`,
        tunnelUrl: tunnel.url,
        authorizationToken: token,
        allowedPaths: ALLOWED_REMOTE_AGENT_PATHS,
      };
      this.sessions.set(agentId, {
        agentId,
        agentName,
        requestIds: new Set(options.requestId ? [options.requestId] : []),
        sessionId,
        token,
        server,
        websocketServer,
        tunnel,
        status,
        sockets: new Set(),
      });
      this.options.onStatusChanged?.({ agentId, agentName, status, requesterMobileDevice: options.requesterMobileDevice });
      return { success: true, status };
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : 'remote_agent_session_start_failed';
      await Promise.allSettled([
        tunnel?.close() ?? Promise.resolve(),
        closeWebSocketServer(websocketServer),
        closeServer(server),
      ]);
      const status: RemoteAgentSessionStatus = { ...preparing, active: false, state: 'error', technicalCode };
      this.options.onStatusChanged?.({ agentId, agentName, status, requesterMobileDevice: options.requesterMobileDevice });
      return {
        success: false,
        technicalCode,
        status,
      };
    }
  }

  public async stop(agentId: string): Promise<RemoteAgentSessionResult> {
    const session = this.sessions.get(agentId);
    if (!session) {
      return { success: true, status: { active: false, agentId, state: 'inactive' } };
    }
    this.sessions.delete(agentId);
    for (const socket of session.sockets) {
      socket.close();
    }
    await Promise.allSettled([
      closeWebSocketServer(session.websocketServer),
      session.tunnel.close(),
      closeServer(session.server),
    ]);
    const status: RemoteAgentSessionStatus = {
      active: false,
      agentId,
      state: 'closed',
      sessionId: session.sessionId,
    };
    this.options.onStatusChanged?.({ agentId, agentName: session.agentName, status });
    await this.options.onSessionClosed?.({ agentId, agentName: session.agentName, requestIds: [...session.requestIds], status });
    return { success: true, status };
  }

  public async stopBySession(sessionId: string): Promise<RemoteAgentSessionResult | undefined> {
    const session = [...this.sessions.values()].find((entry) => entry.sessionId === sessionId);
    if (!session) {
      return undefined;
    }
    return await this.stop(session.agentId);
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(async (agentId) => {
      await this.stop(agentId);
    }));
  }

  private async handleRequest(
    session: Pick<RemoteAgentSession, 'agentId' | 'sessionId' | 'token'>,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (!isAuthorized(request, session.token)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/chats') {
        const conversations = await this.options.store.listConversations(session.agentId);
        sendJson(response, 200, { chats: conversations.map(chatSummary) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/chats') {
        const body = await readJsonBody(request);
        const conversation = await this.options.conversationManager.createConversation({
          agentId: session.agentId,
          title: stringValue(body.title),
        });
        sendJson(response, 200, { chat: toRemoteChat(conversation), conversation });
        return;
      }

      const messageMatch = /^\/chats\/([a-zA-Z0-9_-]{1,120})\/message$/.exec(url.pathname);
      if (request.method === 'POST' && messageMatch) {
        const body = await readJsonBody(request);
        const conversationId = messageMatch[1];
        const conversation = await this.requireSessionConversation(session.agentId, conversationId);
        if (conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status)) {
          sendJson(response, 409, {
            error: 'chat_locked',
            chat: toRemoteChat(conversation),
            conversation,
          });
          return;
        }
        const updated = await this.options.conversationManager.sendMessage({
          conversationId: conversation.id,
          content: stringValue(body.content),
        });
        sendJson(response, 200, { chat: toRemoteChat(updated), conversation: updated });
        return;
      }

      const conversationMatch = /^\/chats\/([a-zA-Z0-9_-]{1,120})$/.exec(url.pathname);
      if (request.method === 'GET' && conversationMatch) {
        const conversation = await this.requireSessionConversation(session.agentId, conversationMatch[1]);
        sendJson(response, 200, { chat: toRemoteChat(conversation), conversation });
        return;
      }

      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : 'remote_agent_request_failed';
      sendJson(response, 400, { error: technicalCode });
    }
  }

  private async requireSessionConversation(agentId: string, conversationId: string): Promise<PersonalAgentConversation> {
    if (!isSafeAgentId(conversationId)) {
      throw new Error('personal_agent_conversation_id_required');
    }
    const conversation = await this.options.conversationManager.getConversation(conversationId);
    if (!conversation || conversation.agentId !== agentId) {
      throw new Error('personal_agent_conversation_not_found');
    }
    return conversation;
  }

  private broadcastConversationEvent(event: PersonalAgentConversationEvent): void {
    const session = this.sessions.get(event.conversation.agentId);
    if (!session) return;
    const payload = JSON.stringify({
      ...event,
      chat: toRemoteChat(event.conversation),
    });
    for (const socket of session.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    }
  }
}

const isSafeAgentId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value);

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const isAuthorized = (request: IncomingMessage, token: string): boolean => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
};

const readJsonBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error('remote_agent_body_too_large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};

const sendJson = (response: ServerResponse, statusCode: number, body: Record<string, unknown>): void => {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
};

const isTerminalRunStatus = (status: PersonalAgentRunStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

const toRemoteChat = (conversation: PersonalAgentConversation) => ({
  id: conversation.id,
  agentId: conversation.agentId,
  title: conversation.title,
  status: conversation.status,
  lastRunStatus: conversation.activeRun?.status ?? 'idle',
  locked: Boolean(conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status)),
  lastMessage: lastVisibleMessage(conversation.messages)?.content ?? '',
  lastIntermediateMessage: conversation.activeRun?.progress.at(-1)?.message ??
    conversation.messages.filter((message) => message.kind === 'intermediate').at(-1)?.content ??
    '',
  createdAt: conversation.createdAt,
  updatedAt: conversation.updatedAt,
});

const chatSummary = (conversation: PersonalAgentConversation) => toRemoteChat(conversation);

const lastVisibleMessage = (messages: PersonalAgentMessage[]): PersonalAgentMessage | undefined =>
  messages.filter((message) => message.kind !== 'intermediate' && message.role !== 'system').at(-1);

const safeUrlOrigin = (value: string): string => {
  try {
    return new URL(value).origin;
  } catch {
    return 'invalid_url';
  }
};

const closeServer = async (server: http.Server): Promise<void> =>
  await new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const closeWebSocketServer = async (server: WebSocketServer): Promise<void> =>
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
