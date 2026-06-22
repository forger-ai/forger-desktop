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
  AppAgentWorkspaceInput,
  AudioPlaybackSummary,
  AudioRuntimeDevices,
  CallOfficialToolInput,
  CallOfficialToolResult,
  LiveVoiceInputSession,
  OfficialToolSummary,
  SpeechToTextProcessResult,
  SpeechToTextTask,
  TextToSpeechSynthesizeResult,
} from '../shared/types';
import type { AppFolderGrantPublic } from './app-folder-grants';
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
import { normalizeLocale } from '../shared/i18n';
import { AgentRuntimeRequestValidationError } from '../shared/agent-runtime-registry';

const MAX_BODY_BYTES = 96 * 1024 * 1024;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

type AudioFileTranscriptionJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

interface AudioFileTranscriptionJob {
  jobId: string;
  appId: string;
  status: AudioFileTranscriptionJobStatus;
  path: string;
  task: SpeechToTextTask;
  model?: string;
  language?: string;
  text?: string;
  durationSeconds?: number;
  technicalCode?: string;
  userMessage?: string;
  reportable?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface DesktopRuntimeBridgeOptions {
  getInstalledApp: (appId: string) => { installDir?: string } | undefined;
  getConversationManager: () => AppAgentConversationManager | null;
  getTaskManager?: () => AppAgentTaskManager | null;
  getTaskStatus?: (appId: string) => Promise<Record<string, unknown>>;
  getAppContext?: (appId: string) => { locale?: string | null; rawLocale?: string | null } | undefined;
  renderManifestAgentPrompt: (input: {
    agent: AppAgent;
    kind: ManifestAgentPromptKind;
    variables?: Record<string, unknown>;
    appRoot: string;
  }) => string;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
  getAppPlatformCapabilities?: (appId: string) => Promise<{
    speechToText: boolean;
    audioInput: boolean;
    textToSpeech: boolean;
    workspaceFolders?: boolean;
    agentRuntimeControl?: boolean;
  }>;
  requestFolderGrant?: (appId: string, grantToken: string) => Promise<AppFolderGrantPublic | null>;
  listFolderGrants?: (appId: string) => Promise<AppFolderGrantPublic[]>;
  revokeFolderGrant?: (appId: string, grantId: string) => Promise<{ revoked: boolean }>;
  officialTools?: {
    listToolsForApp: (appId: string) => Promise<OfficialToolSummary[]>;
    callFromApp: (appId: string, input: CallOfficialToolInput) => Promise<CallOfficialToolResult>;
  };
  getAudioDevices?: () => Promise<AudioRuntimeDevices>;
  updateAudioInputDevices?: (input: AudioRuntimeDevices) => Promise<void>;
  createLiveVoiceSession?: (appId: string, input: {
    consumerKind: 'app_transcript';
    deviceId?: string;
    task?: 'transcribe' | 'translate';
    language?: string;
  }) => Promise<LiveVoiceInputSession>;
  stopLiveVoiceSession?: (appId: string, input: { consumerId: string }) => Promise<unknown>;
  processSpeechToText?: (appId: string, input: {
    path: string;
    task?: 'transcribe' | 'translate';
    language?: string;
    model?: string;
  }) => Promise<SpeechToTextProcessResult>;
  synthesizeTextToSpeech?: (input: {
    text: string;
    model: string;
    voice: string;
    speed?: number;
    format?: 'wav' | 'mp3' | 'opus';
  }) => Promise<TextToSpeechSynthesizeResult>;
  playTextToSpeechAudio?: (input: {
    playbackId: string;
    audioDataBase64: string;
    mimeType: string;
    outputDeviceId?: string;
  }) => Promise<{ success: boolean; durationSeconds?: number; error?: string }>;
  cancelTextToSpeechPlayback?: (playbackId: string) => Promise<void>;
  deleteTextToSpeechAudio?: (audioPath: string) => Promise<void>;
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
  private readonly runtimeEventClients: Map<string, Set<WebSocket>>;
  private readonly playbacks: Map<string, AudioPlaybackSummary>;
  private readonly audioFileTranscriptionJobs: Map<string, AudioFileTranscriptionJob>;

  public constructor(private readonly options: DesktopRuntimeBridgeOptions) {
    this.secrets = new Map<string, string>();
    this.eventClients = new Map<string, Set<WebSocket>>();
    this.runtimeEventClients = new Map<string, Set<WebSocket>>();
    this.playbacks = new Map<string, AudioPlaybackSummary>();
    this.audioFileTranscriptionJobs = new Map<string, AudioFileTranscriptionJob>();
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
    for (const clients of this.runtimeEventClients.values()) {
      for (const client of clients) {
        client.close();
      }
    }
    this.eventClients.clear();
    this.runtimeEventClients.clear();
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

  public publishRuntimeEvent(appId: string, type: string, payload: Record<string, unknown>): void {
    const clients = this.runtimeEventClients.get(appId);
    if (!clients || clients.size === 0) return;
    const raw = JSON.stringify(this.signedSystemEvent(appId, type, payload));
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
      const status = error instanceof BridgeError
        ? error.status
        : error instanceof AgentRuntimeRequestValidationError
          ? 400
          : 500;
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
      const match = url.pathname.match(/^\/v1\/apps\/([^/]+)\/(agent-events|runtime-events)$/);
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
        const clientsByApp = match[2] === 'runtime-events' ? this.runtimeEventClients : this.eventClients;
        const clients = clientsByApp.get(appId) ?? new Set<WebSocket>();
        clients.add(client);
        clientsByApp.set(appId, clients);
        client.on('close', () => {
          clients.delete(client);
          if (clients.size === 0) {
            clientsByApp.delete(appId);
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
    const audioResult = await this.routeAudio(appId, method, pathname, bodyText);
    if (audioResult.handled) return audioResult.result;

    const toolsResult = await this.routeOfficialTools(appId, method, pathname, bodyText);
    if (toolsResult.handled) return toolsResult.result;

    const contextMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/context$/);
    if (contextMatch) {
      if (decodeURIComponent(contextMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      if (method !== 'GET') {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      return this.appContext(appId);
    }

    const folderGrantRequestMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/folder-grants\/request$/);
    if (folderGrantRequestMatch) {
      if (decodeURIComponent(folderGrantRequestMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      if (method !== 'POST') {
        throw new BridgeError(404, 'desktop_runtime_route_not_found');
      }
      await this.assertWorkspaceFolderCapability(appId);
      const body = parseJsonBody(bodyText);
      const grantToken = cleanString(body.grantToken);
      if (!grantToken) {
        throw new BridgeError(400, 'desktop_runtime_folder_grant_token_required');
      }
      const grant = await (this.options.requestFolderGrant?.(appId, grantToken) ?? Promise.resolve(null));
      if (!grant) {
        throw new BridgeError(403, 'desktop_runtime_folder_grant_invalid');
      }
      return grant ? { canceled: false, ...grant } : { canceled: true };
    }

    const folderGrantsMatch = pathname.match(/^\/v1\/apps\/([^/]+)\/folder-grants(?:\/([^/]+))?(?:\/revoke)?$/);
    if (folderGrantsMatch) {
      if (decodeURIComponent(folderGrantsMatch[1]) !== appId) {
        throw new BridgeError(403, 'desktop_runtime_app_forbidden');
      }
      const grantId = folderGrantsMatch[2] ? decodeURIComponent(folderGrantsMatch[2]) : '';
      const isRevoke = pathname.endsWith('/revoke');
      if (method === 'GET' && !grantId) {
        await this.assertWorkspaceFolderCapability(appId);
        return { grants: await (this.options.listFolderGrants?.(appId) ?? Promise.resolve([])) };
      }
      if (((method === 'DELETE' && !isRevoke) || (method === 'POST' && isRevoke)) && grantId) {
        await this.assertWorkspaceFolderCapability(appId);
        return await (this.options.revokeFolderGrant?.(appId, grantId) ?? Promise.resolve({ revoked: false }));
      }
      throw new BridgeError(404, 'desktop_runtime_route_not_found');
    }

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
        if (body.runtime !== undefined) {
          await this.assertAgentRuntimeControlCapability(appId);
        }
        return await taskManager.start(appId, normalizeTaskStartInput(body));
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
      if (body.runtime !== undefined) {
        await this.assertAgentRuntimeControlCapability(appId);
      }
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
        workspace: normalizeWorkspace(body.workspace),
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
      if (body.runtime !== undefined) {
        await this.assertAgentRuntimeControlCapability(appId);
      }
      const agentId = await this.manifestAgentIdForThread(manager, appId, threadId);
      const prompt = await this.renderManifestAgentPrompt(appId, agentId, 'resume', body.variables);
      const conversation = await manager.sendMessage(appId, {
        conversationId: threadId,
        message: buildManifestAgentResumePrompt(prompt),
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
        workspace: normalizeWorkspace(body.workspace),
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
      if (body.runtime !== undefined) {
        await this.assertAgentRuntimeControlCapability(appId);
      }
      const agentId = await this.manifestAgentIdForThread(manager, appId, threadId);
      const prompt = await this.renderManifestAgentPrompt(appId, agentId, 'steer', body.variables);
      return await manager.steerRun(appId, threadId, runId, {
        message: buildManifestAgentSteerPrompt(prompt),
        workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
        workspace: normalizeWorkspace(body.workspace),
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

  private async routeOfficialTools(appId: string, method: string, pathname: string, bodyText: string): Promise<{ handled: boolean; result?: unknown }> {
    const match = pathname.match(/^\/v1\/apps\/([^/]+)\/tools(?:\/([^/]+))?(?:\/actions\/([^/]+))?$/);
    if (!match) return { handled: false };
    if (decodeURIComponent(match[1]) !== appId) {
      throw new BridgeError(403, 'desktop_runtime_app_forbidden');
    }
    const service = this.options.officialTools;
    if (!service) {
      throw new BridgeError(503, 'desktop_runtime_official_tools_unavailable');
    }

    const toolId = match[2] ? decodeURIComponent(match[2]).trim() : '';
    const actionId = match[3] ? decodeURIComponent(match[3]).trim() : '';
    if (method === 'GET' && !toolId && !actionId) {
      return { handled: true, result: { tools: await service.listToolsForApp(appId) } };
    }

    if (method === 'GET' && toolId && !actionId) {
      const tool = (await service.listToolsForApp(appId)).find((item) => item.id === toolId);
      if (!tool) {
        throw new BridgeError(404, 'desktop_runtime_tool_not_found');
      }
      return { handled: true, result: tool };
    }

    if (method === 'POST' && toolId && actionId) {
      const body = parseJsonBody(bodyText);
      return {
        handled: true,
        result: await service.callFromApp(appId, {
          toolId,
          actionId,
          input: isRecord(body.input) ? body.input : {},
        }),
      };
    }

    throw new BridgeError(404, 'desktop_runtime_route_not_found');
  }

  private async routeAudio(appId: string, method: string, pathname: string, bodyText: string): Promise<{ handled: boolean; result?: unknown }> {
    const match = pathname.match(/^\/v1\/apps\/([^/]+)\/audio(?:\/(.*))?$/);
    if (!match) return { handled: false };
    if (decodeURIComponent(match[1]) !== appId) {
      throw new BridgeError(403, 'desktop_runtime_app_forbidden');
    }
    const suffix = match[2] ?? '';

    if (suffix === 'devices' || suffix === 'input-devices' || suffix === 'output-devices') {
      if (method !== 'GET') throw new BridgeError(404, 'desktop_runtime_route_not_found');
      const devices = await this.getAudioDevices();
      if (suffix === 'input-devices') return { handled: true, result: { inputDevices: devices.inputDevices } };
      if (suffix === 'output-devices') return { handled: true, result: { outputDevices: devices.outputDevices } };
      return { handled: true, result: devices };
    }

    if (suffix === 'transcriptions') {
      if (method !== 'POST') throw new BridgeError(404, 'desktop_runtime_route_not_found');
      await this.assertAudioCapability(appId, 'speechToText');
      const body = parseJsonBody(bodyText);
      const session = await this.createAudioLiveSession(appId, 'app_transcript', body);
      return { handled: true, result: session };
    }

    const transcriptionStopMatch = suffix.match(/^transcriptions\/([^/]+)$/);
    if (transcriptionStopMatch) {
      if (method !== 'DELETE') throw new BridgeError(404, 'desktop_runtime_route_not_found');
      await this.assertAudioCapability(appId, 'speechToText');
      const consumerId = cleanString(decodeURIComponent(transcriptionStopMatch[1]));
      if (!consumerId) {
        throw new BridgeError(400, 'live_voice_consumer_required');
      }
      return { handled: true, result: await this.stopAudioLiveSession(appId, consumerId) };
    }

    if (suffix === 'file-transcriptions') {
      if (method !== 'POST') throw new BridgeError(404, 'desktop_runtime_route_not_found');
      await this.assertAudioCapability(appId, 'speechToText');
      const body = parseJsonBody(bodyText);
      return { handled: true, result: await this.processAudioFileTranscription(appId, body) };
    }

    const fileTranscriptionJobMatch = suffix.match(/^file-transcription-jobs(?:\/([^/]+))?(?:\/cancel)?$/);
    if (fileTranscriptionJobMatch) {
      await this.assertAudioCapability(appId, 'speechToText');
      const jobId = fileTranscriptionJobMatch[1] ? decodeURIComponent(fileTranscriptionJobMatch[1]) : '';
      const isCancel = suffix.endsWith('/cancel');
      if (method === 'POST' && !jobId && !isCancel) {
        const body = parseJsonBody(bodyText);
        return { handled: true, result: this.enqueueAudioFileTranscriptionJob(appId, body) };
      }
      if (method === 'GET' && jobId && !isCancel) {
        return { handled: true, result: this.audioFileTranscriptionJobForApp(appId, jobId) };
      }
      if (method === 'POST' && jobId && isCancel) {
        return { handled: true, result: this.cancelAudioFileTranscriptionJob(appId, jobId) };
      }
      throw new BridgeError(404, 'desktop_runtime_route_not_found');
    }

    if (suffix === 'synthesis') {
      if (method !== 'POST') throw new BridgeError(404, 'desktop_runtime_route_not_found');
      await this.assertAudioCapability(appId, 'textToSpeech');
      const body = parseJsonBody(bodyText);
      return { handled: true, result: await this.synthesizeSpeechForApp(body) };
    }

    if (suffix === 'say') {
      if (method !== 'POST') throw new BridgeError(404, 'desktop_runtime_route_not_found');
      await this.assertAudioCapability(appId, 'textToSpeech');
      const body = parseJsonBody(bodyText);
      return { handled: true, result: await this.enqueueSpeechPlayback(appId, body) };
    }

    const playbackMatch = suffix.match(/^playbacks\/([^/]+)(?:\/cancel)?$/);
    if (playbackMatch) {
      const playbackId = decodeURIComponent(playbackMatch[1]);
      const isCancel = suffix.endsWith('/cancel');
      if (method === 'GET' && !isCancel) {
        return { handled: true, result: this.playbackForApp(appId, playbackId) };
      }
      if (method === 'POST' && isCancel) {
        return { handled: true, result: await this.cancelPlayback(appId, playbackId) };
      }
    }

    throw new BridgeError(404, 'desktop_runtime_route_not_found');
  }

  private async getAudioDevices(): Promise<AudioRuntimeDevices> {
    if (!this.options.getAudioDevices) {
      throw new BridgeError(503, 'desktop_runtime_audio_unavailable');
    }
    const devices = await this.options.getAudioDevices();
    await this.options.updateAudioInputDevices?.(devices);
    return devices;
  }

  private async assertAudioCapability(appId: string, capability: 'speechToText' | 'audioInput' | 'textToSpeech'): Promise<void> {
    const capabilities = await this.options.getAppPlatformCapabilities?.(appId);
    if (!capabilities?.[capability]) {
      throw new BridgeError(403, `desktop_runtime_${capability}_capability_required`);
    }
  }

  private async assertWorkspaceFolderCapability(appId: string): Promise<void> {
    const capabilities = await (this.options.getAppPlatformCapabilities?.(appId) ?? Promise.resolve(null));
    if (!capabilities?.workspaceFolders) {
      throw new BridgeError(403, 'desktop_runtime_workspace_folders_not_allowed');
    }
    if (!this.options.requestFolderGrant || !this.options.listFolderGrants || !this.options.revokeFolderGrant) {
      throw new BridgeError(503, 'desktop_runtime_folder_grants_unavailable');
    }
  }

  private async assertAgentRuntimeControlCapability(appId: string): Promise<void> {
    const capabilities = await (this.options.getAppPlatformCapabilities?.(appId) ?? Promise.resolve(null));
    if (!capabilities?.agentRuntimeControl) {
      throw new BridgeError(403, 'desktop_runtime_agent_runtime_control_required');
    }
  }

  private async createAudioLiveSession(
    appId: string,
    consumerKind: 'app_transcript',
    body: Record<string, unknown>,
  ): Promise<LiveVoiceInputSession> {
    if (!this.options.createLiveVoiceSession) {
      throw new BridgeError(503, 'desktop_runtime_audio_unavailable');
    }
    const deviceId = cleanString(body.deviceId);
    const task = body.task === 'translate' ? 'translate' : body.task === 'transcribe' ? 'transcribe' : undefined;
    const language = cleanString(body.language);
    return await this.options.createLiveVoiceSession(appId, {
      consumerKind,
      ...(deviceId ? { deviceId } : {}),
      ...(task ? { task } : {}),
      ...(language ? { language } : {}),
    });
  }

  private async stopAudioLiveSession(appId: string, consumerId: string): Promise<unknown> {
    if (!this.options.stopLiveVoiceSession) {
      throw new BridgeError(503, 'desktop_runtime_audio_unavailable');
    }
    return await this.options.stopLiveVoiceSession(appId, { consumerId });
  }

  private async processAudioFileTranscription(appId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.processSpeechToText) {
      throw new BridgeError(503, 'desktop_runtime_audio_unavailable');
    }
    const path = cleanString(body.path);
    if (!path) {
      throw new BridgeError(400, 'speech_to_text_path_required');
    }
    const task: SpeechToTextTask = body.task === 'translate' ? 'translate' : 'transcribe';
    const language = cleanString(body.language);
    const model = cleanString(body.model);
    const result = await this.options.processSpeechToText(appId, {
      path,
      task,
      ...(language ? { language } : {}),
      ...(model ? { model } : {}),
    });
    return {
      success: result.success === true,
      task,
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(typeof result.language === 'string' ? { language: result.language } : {}),
      ...(typeof result.durationSeconds === 'number' ? { durationSeconds: result.durationSeconds } : {}),
      ...(typeof result.job?.model === 'string' ? { model: result.job.model } : model ? { model } : {}),
      ...(typeof result.userMessage === 'string' ? { userMessage: result.userMessage } : {}),
      ...(typeof result.technicalCode === 'string' ? { technicalCode: result.technicalCode } : {}),
      ...(result.reportable === true ? { reportable: true } : {}),
    };
  }

  private enqueueAudioFileTranscriptionJob(appId: string, body: Record<string, unknown>): Record<string, unknown> {
    const path = cleanString(body.path);
    if (!path) {
      throw new BridgeError(400, 'speech_to_text_path_required');
    }
    const task: SpeechToTextTask = body.task === 'translate' ? 'translate' : 'transcribe';
    const language = cleanString(body.language);
    const model = cleanString(body.model);
    const now = new Date().toISOString();
    const job: AudioFileTranscriptionJob = {
      jobId: randomBytes(16).toString('hex'),
      appId,
      status: 'queued',
      path,
      task,
      ...(language ? { language } : {}),
      ...(model ? { model } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.audioFileTranscriptionJobs.set(job.jobId, job);
    this.publishAudioFileTranscriptionJobEvent(job, 'desktop.audio.fileTranscription.queued');
    void this.runAudioFileTranscriptionJob(job.jobId);
    return this.publicAudioFileTranscriptionJob(job);
  }

  private async runAudioFileTranscriptionJob(jobId: string): Promise<void> {
    const queued = this.audioFileTranscriptionJobs.get(jobId);
    if (!queued || queued.status === 'canceled') return;
    this.updateAudioFileTranscriptionJob(jobId, { status: 'running' });
    const running = this.audioFileTranscriptionJobs.get(jobId);
    if (running) {
      this.publishAudioFileTranscriptionJobEvent(running, 'desktop.audio.fileTranscription.running');
    }
    try {
      const result = await this.processAudioFileTranscription(queued.appId, {
        path: queued.path,
        task: queued.task,
        ...(queued.language ? { language: queued.language } : {}),
        ...(queued.model ? { model: queued.model } : {}),
      });
      if (this.audioFileTranscriptionJobs.get(jobId)?.status === 'canceled') return;
      const status = result.success === true ? 'completed' : 'failed';
      const completedAt = new Date().toISOString();
      this.updateAudioFileTranscriptionJob(jobId, {
        status,
        completedAt,
        ...(typeof result.text === 'string' ? { text: result.text } : {}),
        ...(typeof result.language === 'string' ? { language: result.language } : {}),
        ...(typeof result.durationSeconds === 'number' ? { durationSeconds: result.durationSeconds } : {}),
        ...(typeof result.model === 'string' ? { model: result.model } : {}),
        ...(typeof result.technicalCode === 'string' ? { technicalCode: result.technicalCode } : {}),
        ...(typeof result.userMessage === 'string' ? { userMessage: result.userMessage } : {}),
        ...(result.reportable === true ? { reportable: true } : {}),
      });
      const job = this.audioFileTranscriptionJobs.get(jobId);
      if (job) {
        this.publishAudioFileTranscriptionJobEvent(job, status === 'completed'
          ? 'desktop.audio.fileTranscription.completed'
          : 'desktop.audio.fileTranscription.failed');
      }
    } catch (error) {
      if (this.audioFileTranscriptionJobs.get(jobId)?.status === 'canceled') return;
      this.updateAudioFileTranscriptionJob(jobId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        technicalCode: error instanceof Error ? error.message : 'speech_to_text_failed',
        userMessage: 'Audio transcription failed.',
      });
      const job = this.audioFileTranscriptionJobs.get(jobId);
      if (job) {
        this.publishAudioFileTranscriptionJobEvent(job, 'desktop.audio.fileTranscription.failed');
      }
    }
  }

  private audioFileTranscriptionJobForApp(appId: string, jobId: string): Record<string, unknown> {
    const job = this.audioFileTranscriptionJobs.get(jobId);
    if (!job || job.appId !== appId) {
      throw new BridgeError(404, 'audio_file_transcription_job_not_found');
    }
    return this.publicAudioFileTranscriptionJob(job);
  }

  private cancelAudioFileTranscriptionJob(appId: string, jobId: string): Record<string, unknown> {
    const job = this.audioFileTranscriptionJobs.get(jobId);
    if (!job || job.appId !== appId) {
      throw new BridgeError(404, 'audio_file_transcription_job_not_found');
    }
    if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'canceled') {
      this.updateAudioFileTranscriptionJob(jobId, {
        status: 'canceled',
        completedAt: new Date().toISOString(),
        userMessage: 'Audio transcription canceled.',
      });
    }
    return this.publicAudioFileTranscriptionJob(this.audioFileTranscriptionJobs.get(jobId) ?? job);
  }

  private updateAudioFileTranscriptionJob(jobId: string, patch: Partial<AudioFileTranscriptionJob>): void {
    const current = this.audioFileTranscriptionJobs.get(jobId);
    if (!current) return;
    this.audioFileTranscriptionJobs.set(jobId, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  private publishAudioFileTranscriptionJobEvent(job: AudioFileTranscriptionJob, type: string): void {
    this.publishRuntimeEvent(job.appId, type, {
      job: this.publicAudioFileTranscriptionJob(job),
    });
  }

  private publicAudioFileTranscriptionJob(job: AudioFileTranscriptionJob): Record<string, unknown> {
    return {
      jobId: job.jobId,
      status: job.status,
      task: job.task,
      ...(job.model ? { model: job.model } : {}),
      ...(job.language ? { language: job.language } : {}),
      ...(typeof job.text === 'string' ? { text: job.text } : {}),
      ...(typeof job.durationSeconds === 'number' ? { durationSeconds: job.durationSeconds } : {}),
      ...(job.technicalCode ? { technicalCode: job.technicalCode } : {}),
      ...(job.userMessage ? { userMessage: job.userMessage } : {}),
      ...(job.reportable === true ? { reportable: true } : {}),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    };
  }

  private async synthesizeSpeechForApp(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.synthesizeTextToSpeech) {
      throw new BridgeError(503, 'desktop_runtime_audio_unavailable');
    }
    const text = cleanString(body.text);
    const model = cleanString(body.model);
    const voice = cleanString(body.voice);
    if (!text || !model || !voice) {
      throw new BridgeError(400, 'text_to_speech_arguments_required');
    }
    const speed = typeof body.speed === 'number' ? body.speed : undefined;
    const format = body.format === 'mp3' || body.format === 'opus' ? body.format : 'wav';
    const result = await this.options.synthesizeTextToSpeech({
      text,
      model,
      voice,
      ...(typeof speed === 'number' ? { speed } : {}),
      format,
    });
    return {
      success: result.success === true,
      model: result.model ?? model,
      voice: result.voice ?? voice,
      format: result.format ?? format,
      ...(typeof result.audioDataBase64 === 'string' ? { audioDataBase64: result.audioDataBase64 } : {}),
      ...(typeof result.mimeType === 'string' ? { mimeType: result.mimeType } : {}),
      ...(typeof result.durationSeconds === 'number' ? { durationSeconds: result.durationSeconds } : {}),
      ...(typeof result.language === 'string' ? { language: result.language } : {}),
      ...(typeof result.locale === 'string' ? { locale: result.locale } : {}),
      ...(typeof result.userMessage === 'string' ? { userMessage: result.userMessage } : {}),
      ...(typeof result.technicalCode === 'string' ? { technicalCode: result.technicalCode } : {}),
      ...(result.reportable === true ? { reportable: true } : {}),
    };
  }

  private async enqueueSpeechPlayback(appId: string, body: Record<string, unknown>): Promise<{ success: true; playbackId: string; status: 'queued' }> {
    const text = cleanString(body.text);
    const model = cleanString(body.model);
    const voice = cleanString(body.voice);
    const outputDeviceId = cleanString(body.outputDeviceId);
    if (!text || !model || !voice) {
      throw new BridgeError(400, 'text_to_speech_arguments_required');
    }
    if (outputDeviceId) {
      const devices = await this.getAudioDevices();
      if (!devices.outputDevices.some((device) => device.id === outputDeviceId)) {
        throw new BridgeError(400, 'audio_output_device_not_found');
      }
    }
    const now = new Date().toISOString();
    const playbackId = randomBytes(16).toString('hex');
    const playback: AudioPlaybackSummary = {
      playbackId,
      appId,
      status: 'queued',
      textLength: text.length,
      model,
      voice,
      ...(outputDeviceId ? { outputDeviceId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.playbacks.set(playbackId, playback);
    void this.runSpeechPlayback(playbackId, { text, model, voice, outputDeviceId, speed: typeof body.speed === 'number' ? body.speed : undefined });
    return { success: true, playbackId, status: 'queued' };
  }

  private async runSpeechPlayback(
    playbackId: string,
    input: { text: string; model: string; voice: string; outputDeviceId?: string; speed?: number },
  ): Promise<void> {
    const playback = this.playbacks.get(playbackId);
    if (!playback || playback.status === 'canceled') return;
    this.updatePlayback(playbackId, { status: 'running' });
    let audioPath = '';
    try {
      if (!this.options.synthesizeTextToSpeech || !this.options.playTextToSpeechAudio) {
        throw new Error('desktop_runtime_audio_unavailable');
      }
      const synthesized = await this.options.synthesizeTextToSpeech({
        text: input.text,
        model: input.model,
        voice: input.voice,
        ...(typeof input.speed === 'number' ? { speed: input.speed } : {}),
        format: 'wav',
      });
      audioPath = cleanString(synthesized.audioPath);
      if (this.playbacks.get(playbackId)?.status === 'canceled') return;
      if (!synthesized.success || !synthesized.audioDataBase64) {
        this.updatePlayback(playbackId, {
          status: 'failed',
          userMessage: synthesized.userMessage ?? 'Text to speech failed.',
          technicalCode: synthesized.technicalCode ?? 'text_to_speech_failed',
        });
        return;
      }
      const played = await this.options.playTextToSpeechAudio({
        playbackId,
        audioDataBase64: synthesized.audioDataBase64,
        mimeType: synthesized.mimeType ?? 'audio/wav',
        ...(input.outputDeviceId ? { outputDeviceId: input.outputDeviceId } : {}),
      });
      if (this.playbacks.get(playbackId)?.status === 'canceled') return;
      if (played.success) {
        this.updatePlayback(playbackId, {
          status: 'completed',
          durationSeconds: played.durationSeconds ?? synthesized.durationSeconds,
          userMessage: 'Speech played.',
        });
      } else {
        this.updatePlayback(playbackId, {
          status: 'failed',
          technicalCode: played.error ?? 'text_to_speech_playback_failed',
          userMessage: 'Speech playback failed.',
        });
      }
    } catch (error) {
      if (this.playbacks.get(playbackId)?.status !== 'canceled') {
        this.updatePlayback(playbackId, {
          status: 'failed',
          technicalCode: error instanceof Error ? error.message : 'text_to_speech_playback_failed',
          userMessage: 'Speech playback failed.',
        });
      }
    } finally {
      if (audioPath) {
        await this.options.deleteTextToSpeechAudio?.(audioPath).catch((error: unknown) => {
          void this.options.appendInstallLog('desktop_runtime_audio:ephemeral_cleanup_failed', {
            playbackId,
            error: this.options.serializeErrorForInstallLog(error),
          });
        });
      }
      this.trimPlaybacks();
    }
  }

  private playbackForApp(appId: string, playbackId: string): AudioPlaybackSummary {
    const playback = this.playbacks.get(playbackId);
    if (!playback || playback.appId !== appId) {
      throw new BridgeError(404, 'audio_playback_not_found');
    }
    return playback;
  }

  private async cancelPlayback(appId: string, playbackId: string): Promise<AudioPlaybackSummary> {
    const playback = this.playbackForApp(appId, playbackId);
    if (playback.status !== 'completed' && playback.status !== 'failed' && playback.status !== 'canceled') {
      this.updatePlayback(playbackId, { status: 'canceled', userMessage: 'Speech playback canceled.' });
      await this.options.cancelTextToSpeechPlayback?.(playbackId);
    }
    return this.playbackForApp(appId, playbackId);
  }

  private updatePlayback(playbackId: string, patch: Partial<AudioPlaybackSummary>): void {
    const current = this.playbacks.get(playbackId);
    if (!current) return;
    this.playbacks.set(playbackId, {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  private trimPlaybacks(): void {
    const entries = [...this.playbacks.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    for (const playback of entries.slice(0, Math.max(0, entries.length - 100))) {
      if (playback.status === 'completed' || playback.status === 'failed' || playback.status === 'canceled') {
        this.playbacks.delete(playback.playbackId);
      }
    }
  }

  private appContext(appId: string): { locale: 'es' | 'en'; rawLocale: string | null } {
    const context = this.options.getAppContext?.(appId);
    const rawLocale = typeof context?.rawLocale === 'string' && context.rawLocale.trim()
      ? context.rawLocale.trim()
      : typeof context?.locale === 'string' && context.locale.trim()
        ? context.locale.trim()
        : null;
    return {
      locale: normalizeLocale(context?.locale ?? rawLocale),
      rawLocale,
    };
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

  private signedSystemEvent(appId: string, type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
    return this.signEnvelope(appId, {
      event_id: randomBytes(16).toString('hex'),
      app_id: appId,
      type,
      thread_id: '',
      run_id: '',
      status: 'connected',
      created_at: new Date().toISOString(),
      payload,
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

const cleanString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeTaskStartInput = (body: Record<string, unknown>): AppCodexTaskStartInput => {
  const workspace = normalizeWorkspace(body.workspace);
  const runtime = normalizeRuntimeInput(body.runtime);
  return {
    templateId: typeof body.templateId === 'string' ? body.templateId : '',
    ...(typeof body.locale === 'string' ? { locale: body.locale } : {}),
    ...(body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
      ? { arguments: body.arguments as AppCodexTaskStartInput['arguments'] }
      : {}),
    ...(body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
      ? { variables: body.variables as AppCodexTaskStartInput['variables'] }
      : {}),
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments as AppCodexTaskStartInput['attachments'] } : {}),
    ...(runtime ? { runtime } : {}),
    ...(typeof body.workspacePath === 'string' ? { workspacePath: body.workspacePath } : {}),
    ...(workspace ? { workspace } : {}),
  };
};

const normalizeRuntime = (runtime: AppAgentRuntimeInput | undefined): Partial<AppCodexConversationSendMessageInput> => {
  const normalized = normalizeRuntimeInput(runtime);
  const provider = normalized?.provider as AgentProvider | undefined;
  const model = normalized?.model;
  const effort = normalized?.effort as AppCodexConversationSendMessageInput['effort'];
  const workspace = normalizeWorkspace(normalized?.workspace);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(workspace ? { workspace } : {}),
  };
};

const normalizeRuntimeInput = (runtime: unknown): AppAgentRuntimeInput | undefined => {
  if (runtime === undefined || runtime === null) {
    return undefined;
  }
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new BridgeError(400, 'agent_runtime_invalid');
  }
  const record = runtime as Record<string, unknown>;
  let provider: AgentProvider | undefined;
  if (record.provider !== undefined) {
    if (record.provider !== 'codex' && record.provider !== 'claude' && record.provider !== 'antigravity') {
      throw new BridgeError(400, 'agent_runtime_provider_unsupported');
    }
    provider = record.provider;
  }
  let model: string | undefined;
  if (record.model !== undefined) {
    if (typeof record.model !== 'string') {
      throw new BridgeError(400, 'agent_runtime_model_invalid');
    }
    const trimmed = record.model.trim();
    if (trimmed && trimmed !== 'auto') {
      model = trimmed;
    }
  }
  let effort: AppAgentRuntimeInput['effort'] | undefined;
  if (record.effort !== undefined) {
    if (typeof record.effort !== 'string') {
      throw new BridgeError(400, 'agent_runtime_effort_invalid');
    }
    effort = record.effort === 'default' ? undefined : record.effort as AppAgentRuntimeInput['effort'];
  }
  const modelParams = record.modelParams && typeof record.modelParams === 'object' && !Array.isArray(record.modelParams)
    ? record.modelParams as Record<string, unknown>
    : undefined;
  const workspace = normalizeWorkspace(record.workspace);
  const normalized: AppAgentRuntimeInput = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(modelParams ? { modelParams } : {}),
    ...(record.permissionMode === 'safe' || record.permissionMode === 'unsafe' ? { permissionMode: record.permissionMode } : {}),
    ...(workspace ? { workspace } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeWorkspace = (workspace: unknown): AppAgentWorkspaceInput | undefined => {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    return undefined;
  }
  const raw = workspace as Record<string, unknown>;
  const cwdGrantId = typeof raw.cwdGrantId === 'string' && raw.cwdGrantId.trim()
    ? raw.cwdGrantId.trim()
    : undefined;
  const additionalFolderGrantIds = Array.isArray(raw.additionalFolderGrantIds)
    ? [...new Set(raw.additionalFolderGrantIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))]
    : [];
  if (!cwdGrantId && additionalFolderGrantIds.length === 0) {
    return undefined;
  }
  return {
    ...(cwdGrantId ? { cwdGrantId } : {}),
    ...(additionalFolderGrantIds.length > 0 ? { additionalFolderGrantIds } : {}),
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
