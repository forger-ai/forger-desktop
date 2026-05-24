import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';

import type {
  AppAgent,
  AppAgentRuntimeInput,
  AppCodexConversationEvent,
  AppCodexConversationSendMessageInput,
  AppCodexTaskStartInput,
  AppManifestAgentResumeInput,
  AppManifestAgentStartInput,
  AppManifestAgentSteerInput,
  AgentProvider,
} from '../shared/types';
import type { AppAgentTaskManager } from './app-agent-task-manager';
import type { AppAgentConversationManager } from './app-agent-conversation-manager';
import {
  buildManifestAgentResumePrompt,
  buildManifestAgentStartPrompt,
  buildManifestAgentSteerPrompt,
  toAppAgentRunSummary,
  toAppAgentRunSummaryForId,
  toAppAgentThreadSummary,
} from './app-agent/conversation-helpers';
import type { ManifestAgentPromptKind } from './manifest-agent-prompts';
import { REMOVED_FORGER_APP_BRIDGE_MESSAGE } from './ipc/agent-handlers';

const MAX_BODY_BYTES = 96 * 1024 * 1024;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export interface DesktopRuntimeBridgeOptions {
  getInstalledApp: (appId: string) => { installDir?: string } | undefined;
  getConversationManager: () => AppAgentConversationManager | null;
  getTaskManager?: () => AppAgentTaskManager | null;
  getTaskStatus?: (appId: string) => Promise<Record<string, unknown>>;
  renderManifestAgentPrompt: (input: {
    agent: AppAgent;
    kind: ManifestAgentPromptKind;
    variables?: Record<string, unknown>;
    appRoot: string;
  }) => string;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  maxBodyBytes?: number;
}

export class DesktopRuntimeBridge {
  private server: http.Server | null = null;
  private eventServer: WebSocketServer | null = null;
  private url: string | null = null;
  private readonly secrets: Map<string, string>;
  private readonly eventClients: Map<string, Set<WebSocket>>;

  public constructor(private readonly options: DesktopRuntimeBridgeOptions) {
    this.secrets = new Map<string, string>();
    this.eventClients = new Map<string, Set<WebSocket>>();
  }

  public async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.eventServer = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket as Socket, head);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo | null;
    if (!address?.port) {
      throw new Error('desktop_runtime_bridge_address_unavailable');
    }
    this.url = `http://127.0.0.1:${address.port}`;
    await this.options.appendInstallLog('desktop_runtime_bridge:started', { url: this.url });
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    const eventServer = this.eventServer;
    this.eventServer = null;
    this.url = null;
    for (const clients of this.eventClients.values()) {
      for (const client of clients) {
        client.close();
      }
    }
    this.eventClients.clear();
    this.secrets.clear();
    eventServer?.close();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  public environmentForApp(appId: string): Record<string, string> {
    if (!this.url) return {};
    const secret = this.secretForApp(appId);
    return {
      FORGER_DESKTOP_RUNTIME_URL: this.url,
      FORGER_DESKTOP_RUNTIME_APP_ID: appId,
      FORGER_DESKTOP_RUNTIME_SECRET: secret,
    };
  }

  private secretForApp(appId: string): string {
    const existing = this.secrets.get(appId);
    if (existing) return existing;
    const secret = randomBytes(32).toString('hex');
    this.secrets.set(appId, secret);
    return secret;
  }

  public publishAgentEvent(event: AppCodexConversationEvent): void {
    const appId = event.conversation.appId;
    const clients = this.eventClients.get(appId);
    if (!clients || clients.size === 0) return;
    const envelope = this.signedAgentEvent(appId, event);
    const raw = JSON.stringify(envelope);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const bodyText = await readBody(request, this.options.maxBodyBytes ?? MAX_BODY_BYTES);
      const appId = this.authorize(request, method, url.pathname, bodyText);
      const result = await this.route(appId, method, url.pathname, bodyText);
      writeJson(response, 200, result);
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500;
      await this.options.appendInstallLog('desktop_runtime_bridge:error', {
        status,
        error: this.options.serializeErrorForInstallLog(error),
      });
      writeJson(response, status, {
        error: error instanceof Error ? error.message : 'desktop_runtime_bridge_error',
      });
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: import('node:net').Socket, head: Buffer): Promise<void> {
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const match = url.pathname.match(/^\/v1\/apps\/([^/]+)\/agent-events$/);
      if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      const appId = this.authorize(request, method, url.pathname, '');
      if (decodeURIComponent(match[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      this.eventServer?.handleUpgrade(request, socket, head, (client: WebSocket) => {
        const clients = this.eventClients.get(appId) ?? new Set<WebSocket>();
        clients.add(client);
        this.eventClients.set(appId, clients);
        client.on('close', () => {
          clients.delete(client);
          if (clients.size === 0) {
            this.eventClients.delete(appId);
          }
        });
        client.send(JSON.stringify(this.signedSystemEvent(appId, 'desktop_runtime.connected')));
      });
    } catch (error) {
      const status = error instanceof BridgeError ? error.status : 500;
      await this.options.appendInstallLog('desktop_runtime_bridge:websocket_error', {
        status,
        error: this.options.serializeErrorForInstallLog(error),
      });
      socket.write(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`);
      socket.destroy();
    }
  }

  private authorize(request: IncomingMessage, method: string, pathname: string, bodyText: string): string {
    const appId = header(request, 'x-forger-app-id');
    const timestamp = header(request, 'x-forger-timestamp');
    const signature = header(request, 'x-forger-signature');
    const bodySha = header(request, 'x-forger-body-sha256');
    if (!appId || !timestamp || !signature || !bodySha) {
      throw new BridgeError(401, 'desktop_runtime_signature_required');
    }
    if (!this.options.getInstalledApp(appId)) {
      throw new BridgeError(403, 'desktop_runtime_app_forbidden');
    }
    const expectedBodySha = sha256(bodyText);
    if (bodySha !== expectedBodySha) {
      throw new BridgeError(401, 'desktop_runtime_body_hash_invalid');
    }
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_WINDOW_MS) {
      throw new BridgeError(401, 'desktop_runtime_timestamp_invalid');
    }
    const secret = this.secrets.get(appId);
    if (!secret) {
      throw new BridgeError(401, 'desktop_runtime_secret_unknown');
    }
    const payload = [method.toUpperCase(), pathname, timestamp, bodySha].join('\n');
    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    if (!safeEqual(signature, expected)) {
      throw new BridgeError(401, 'desktop_runtime_signature_invalid');
    }
    return appId;
  }

  private async route(appId: string, method: string, pathname: string, bodyText: string): Promise<unknown> {
    const taskStatusMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/agent-tasks\/status$/);
    if (taskStatusMatch) {
      if (decodeURIComponent(taskStatusMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      if (method !== 'GET') {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      const taskManager = this.options.getTaskManager?.() ?? null;
      const status = await (this.options.getTaskStatus?.(appId) ?? Promise.resolve({}));
      return {
        available: Boolean(taskManager),
        ...status,
      };
    }

    const taskMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/agent-tasks(?:\/([^/]+))?(?:\/cancel)?$/);
    if (taskMatch) {
      if (decodeURIComponent(taskMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      const taskManager = this.options.getTaskManager?.() ?? null;
      if (!taskManager) {
        throw new BridgeError(503, 'desktop_runtime_agent_task_manager_unavailable');
      }
      const runId = taskMatch[2] ? decodeURIComponent(taskMatch[2]) : '';
      const isCancel = pathname.endsWith('/cancel');
      const body = parseJsonBody(bodyText);

      if (method === 'POST' && !runId && !isCancel) {
        return await taskManager.start(appId, body as unknown as AppCodexTaskStartInput);
      }
      if (method === 'GET' && runId && !isCancel) {
        return taskManager.get(appId, runId);
      }
      if (method === 'POST' && runId && isCancel) {
        return taskManager.cancel(appId, runId);
      }
      throw new BridgeError(404, 'desktop_runtime_route_not_found');
    }

    const removedFreeformThreadMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/agent-threads(?:\/([^/]+))?$/);
    if (method === 'POST' && removedFreeformThreadMatch) {
      if (decodeURIComponent(removedFreeformThreadMatch[1]) !== appId) {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      throw new BridgeError(410, REMOVED_FORGER_APP_BRIDGE_MESSAGE);
    }

    const manager = this.options.getConversationManager();
    if (!manager) {
      throw new BridgeError(503, 'desktop_runtime_agent_manager_unavailable');
    }

    const agentStartMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/agents\/([^/]+)\/start$/);
    if (agentStartMatch) {
      if (decodeURIComponent(agentStartMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      if (method !== 'POST') {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      const agentId = decodeURIComponent(agentStartMatch[2]).trim();
      if (!agentId) {
        throw new BridgeError(400, 'manifest_agent_required');
      }
      const body = parseJsonBody(bodyText) as unknown as Omit<AppManifestAgentStartInput, 'agentId'>;
      const prompt = await this.renderManifestAgentPrompt(appId, agentId, 'initial', body.variables);
      const conversation = await manager.create(appId, {
        title: body.title,
        agentId,
        metadata: {
          ...(body.metadata ?? {}),
          agentId,
          manifestAgentId: agentId,
          promptApi: 'manifest-http',
          initialPromptApplied: true,
        },
      });
      const started = await manager.sendMessage(appId, {
        conversationId: conversation.conversationId,
        message: buildManifestAgentStartPrompt(prompt),
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
        ...normalizeRuntime(body.runtime),
      });
      const summary = toAppAgentThreadSummary(started);
      if (!summary) {
        throw new BridgeError(500, 'manifest_agent_thread_start_failed');
      }
      return { ...summary, manifest_agent_id: agentId };
    }

    const resumeMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/agent-threads\/([^/]+)\/resume$/);
    if (resumeMatch) {
      if (decodeURIComponent(resumeMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      if (method !== 'POST') {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      const threadId = decodeURIComponent(resumeMatch[2]);
      const body = parseJsonBody(bodyText) as unknown as AppManifestAgentResumeInput;
      const agentId = await this.manifestAgentIdForThread(manager, appId, threadId);
      const prompt = await this.renderManifestAgentPrompt(appId, agentId, 'resume', body.variables);
      const conversation = await manager.sendMessage(appId, {
        conversationId: threadId,
        message: buildManifestAgentResumePrompt(prompt),
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
        ...normalizeRuntime(body.runtime),
      });
      return toAppAgentRunSummary(threadId, conversation.activeRun, conversation.messages) ?? {
        desktop_thread_id: threadId,
        desktop_run_id: '',
        status: 'queued',
      };
    }

    const steerMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/agent-threads\/([^/]+)\/runs\/([^/]+)\/steer$/);
    if (steerMatch) {
      if (decodeURIComponent(steerMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      if (method !== 'POST') {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      const threadId = decodeURIComponent(steerMatch[2]);
      const runId = decodeURIComponent(steerMatch[3]);
      const body = parseJsonBody(bodyText) as unknown as AppManifestAgentSteerInput;
      const agentId = await this.manifestAgentIdForThread(manager, appId, threadId);
      const prompt = await this.renderManifestAgentPrompt(appId, agentId, 'steer', body.variables);
      return await manager.steerRun(appId, threadId, runId, {
        message: buildManifestAgentSteerPrompt(prompt),
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
        ...normalizeRuntime(body.runtime),
      });
    }

    const match = pathname.match(/^\/v1\/apps\/([^/]+)\/agent-threads(?:\/([^/]+))?(?:\/runs(?:\/([^/]+))?)?(?:\/cancel)?$/);
    if (!match || decodeURIComponent(match[1]) !== appId) {
      throw new BridgeError(404, 'desktop_runtime_route_not_found');
    }
    const threadId = match[2] ? decodeURIComponent(match[2]) : '';
    const runId = match[3] ? decodeURIComponent(match[3]) : '';
    const isCancel = pathname.endsWith('/cancel');

    if (method === 'POST' && !threadId && !runId) {
      throw new BridgeError(410, REMOVED_FORGER_APP_BRIDGE_MESSAGE);
    }

    if (method === 'POST' && threadId && !runId && !isCancel) {
      throw new BridgeError(410, REMOVED_FORGER_APP_BRIDGE_MESSAGE);
    }

    if (method === 'GET' && threadId && !runId) {
      return toAppAgentThreadSummary(await manager.get(appId, threadId));
    }

    if (method === 'GET' && threadId && runId) {
      const conversation = await manager.get(appId, threadId);
      return toAppAgentRunSummaryForId(conversation, threadId, runId);
    }

    if (method === 'POST' && threadId && runId && isCancel) {
      return await manager.cancel(appId, threadId, runId);
    }

    throw new BridgeError(404, 'desktop_runtime_route_not_found');
  }

  private async renderManifestAgentPrompt(
    appId: string,
    agentId: string,
    kind: ManifestAgentPromptKind,
    variables: Record<string, unknown> | undefined,
  ): Promise<string> {
    const record = this.options.getInstalledApp(appId);
    const appRoot = record?.installDir;
    if (!appRoot) {
      throw new BridgeError(404, 'app_not_installed');
    }
    const agent = (await this.options.resolveInstalledAgents(appId)).find((item) => item.id === agentId);
    if (!agent) {
      throw new BridgeError(404, 'manifest_agent_not_found');
    }
    return this.options.renderManifestAgentPrompt({
      agent,
      kind,
      variables,
      appRoot,
    });
  }

  private async manifestAgentIdForThread(
    manager: AppAgentConversationManager,
    appId: string,
    threadId: string,
  ): Promise<string> {
    const metadata = await manager.getMetadata(appId, threadId);
    const agentId = typeof metadata?.manifestAgentId === 'string' && metadata.manifestAgentId.trim()
      ? metadata.manifestAgentId.trim()
      : typeof metadata?.agentId === 'string' && metadata.agentId.trim()
        ? metadata.agentId.trim()
        : '';
    if (!agentId) {
      throw new BridgeError(400, 'manifest_agent_thread_agent_missing');
    }
    return agentId;
  }

  private signedSystemEvent(appId: string, type: string): Record<string, unknown> {
    return this.signEnvelope(appId, {
      event_id: randomBytes(16).toString('hex'),
      app_id: appId,
      type,
      thread_id: '',
      run_id: '',
      status: 'connected',
      created_at: new Date().toISOString(),
      payload: {},
    });
  }

  private signedAgentEvent(appId: string, event: AppCodexConversationEvent): Record<string, unknown> {
    const threadId = event.conversation.conversationId;
    const runId = event.run?.runId ?? '';
    const payload = {
      conversation: toAppAgentThreadSummary(event.conversation),
      ...(event.run ? { run: toAppAgentRunSummary(threadId, event.run, event.conversation.messages) } : {}),
      ...(event.message ? {
        message: {
          id: event.message.messageId,
          role: event.message.role,
          content: event.message.text,
          created_at: event.message.createdAt,
        },
      } : {}),
      ...(event.progress ? { progress: event.progress } : {}),
    };
    return this.signEnvelope(appId, {
      event_id: randomBytes(16).toString('hex'),
      app_id: appId,
      type: normalizeAgentEventType(event.type),
      thread_id: threadId,
      run_id: runId,
      status: event.run?.status ?? event.conversation.activeRun?.status ?? 'idle',
      created_at: new Date().toISOString(),
      payload,
    });
  }

  private signEnvelope(appId: string, envelope: Record<string, unknown>): Record<string, unknown> {
    const secret = this.secrets.get(appId);
    if (!secret) {
      throw new BridgeError(401, 'desktop_runtime_secret_unknown');
    }
    const payload = envelope.payload ?? {};
    const payloadSha = sha256(stableJson(payload));
    const signaturePayload = [
      String(envelope.app_id ?? ''),
      String(envelope.event_id ?? ''),
      String(envelope.type ?? ''),
      String(envelope.thread_id ?? ''),
      String(envelope.run_id ?? ''),
      String(envelope.created_at ?? ''),
      payloadSha,
    ].join('\n');
    return {
      ...envelope,
      signature: createHmac('sha256', secret).update(signaturePayload).digest('hex'),
    };
  }
}

class BridgeError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const parseJsonBody = (bodyText: string): Record<string, unknown> => {
  if (!bodyText) {
    return {};
  }
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BridgeError(400, 'desktop_runtime_body_invalid');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    throw new BridgeError(400, 'desktop_runtime_body_invalid');
  }
};

const readBody = async (request: IncomingMessage, maxBodyBytes: number): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new BridgeError(413, 'desktop_runtime_body_too_large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
};

const header = (request: IncomingMessage, name: string): string =>
  typeof request.headers[name] === 'string' ? request.headers[name] : '';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeRuntime = (runtime: AppAgentRuntimeInput | undefined): Partial<AppCodexConversationSendMessageInput> => {
  const provider = runtime?.provider === 'codex' || runtime?.provider === 'claude'
    ? runtime.provider as AgentProvider
    : undefined;
  const model = typeof runtime?.model === 'string' && runtime.model !== 'auto' ? runtime.model : undefined;
  const effort = runtime?.effort && runtime.effort !== 'default' ? runtime.effort : undefined;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
};

const normalizeAgentEventType = (type: string): string => {
  if (type === 'conversation.created') return 'thread.created';
  if (type === 'message.created') return 'run.message';
  if (type === 'run.message.completed') return 'assistant.message.appended';
  return type;
};

const stableJson = (value: unknown): string => JSON.stringify(sortJson(value));

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
};
