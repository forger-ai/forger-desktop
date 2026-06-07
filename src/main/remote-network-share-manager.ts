import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import type { RemoteNetworkShareResult, RemoteNetworkShareStatus } from '../shared/types';
import type { AppManifest, RunningAppProcess, RuntimeBinarySet } from './core/main-process-types';
import type { ForgerBackendClient } from './forger-backend-client';
import { RemoteSessionCrypto, type RemoteEnvelope } from './remote-crypto';
import { buildRemoteFrontend } from './remote-frontend-packager';
import { listenLocal, LocalTunnelProvider, type RemoteTunnel, type RemoteTunnelProvider } from './remote-tunnel-provider';

const REMOTE_RPC_PATH = '/__forger_remote_rpc';
const REMOTE_WS_PATH = '/__forger_remote_ws';
const REALTIME_WS_PATH = '/api/realtime/ws';
const BLOCKED_PREFIXES = ['/mcp', '/__forger_internal', '/__forger_remote_rpc', '/__forger_remote_ws'];
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_WS_FRAME_BYTES = 1024 * 1024;

interface ShareState {
  appId: string;
  server: http.Server;
  websocketServer: WebSocketServer;
  sessionRowId: number;
  sessionId: string;
  tunnel: RemoteTunnel;
  crypto: RemoteSessionCrypto;
  status: RemoteNetworkShareStatus;
  seenNonces: Set<string>;
  connectionKeyIds: Set<string>;
  remoteSockets: Set<WebSocket>;
}

export interface RemoteNetworkShareManagerOptions {
  runningApps: Map<string, RunningAppProcess>;
  openInstalledApp: (appId: string, locale?: string, options?: { openWindow?: boolean }) => Promise<{ success: boolean; userMessage: string; technicalCode?: string }>;
  resolveInstalledManifest: (appId: string) => Promise<AppManifest | null>;
  backendClient: () => ForgerBackendClient | null;
  backendBaseUrl: string;
  installDirForApp: (appId: string) => string | undefined;
  getCurrentDeviceId: () => Promise<number | undefined>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  emitRuntimeStatus: (appId: string, remoteNetworkShare: RemoteNetworkShareStatus) => void;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  normalizeNodeRuntimeVersion: (value?: string | null) => string;
  requiredNodeVersionForApp: (appId: string) => string | undefined;
  tunnelProvider?: RemoteTunnelProvider;
}

export class RemoteNetworkShareManager {
  private readonly shares = new Map<string, ShareState>();
  private readonly pendingStatuses = new Map<string, RemoteNetworkShareStatus>();
  private readonly provider: RemoteTunnelProvider;

  constructor(private readonly options: RemoteNetworkShareManagerOptions) {
    this.provider = options.tunnelProvider ?? new LocalTunnelProvider();
  }

  status(appId: string): RemoteNetworkShareStatus {
    return this.shares.get(appId)?.status ?? this.pendingStatuses.get(appId) ?? { active: false, appId, state: 'inactive' };
  }

  async start(appId: string): Promise<RemoteNetworkShareResult> {
    const existing = this.shares.get(appId);
    if (existing) {
      return { success: true, status: existing.status };
    }
    const manifest = await this.options.resolveInstalledManifest(appId);
    if (manifest?.remoteTunnel !== true) {
      return {
        success: false,
        technicalCode: 'remote_tunnel_not_supported',
        status: { active: false, appId, state: 'inactive' },
      };
    }
    const client = this.options.backendClient();
    const deviceId = await this.options.getCurrentDeviceId();
    if (!client || !deviceId) {
      return {
        success: false,
        technicalCode: 'forger_cloud_required',
        status: { active: false, appId, state: 'inactive' },
      };
    }
    const open = await this.options.openInstalledApp(appId, undefined, { openWindow: false });
    if (!open.success) {
      return {
        success: false,
        technicalCode: open.technicalCode ?? 'remote_tunnel_open_failed',
        status: { active: false, appId, state: 'inactive' },
      };
    }
    const running = this.options.runningApps.get(appId);
    if (!running) {
      return {
        success: false,
        technicalCode: 'app_not_running',
        status: { active: false, appId, state: 'inactive' },
      };
    }

    const preparingStatus: RemoteNetworkShareStatus = {
      active: true,
      appId,
      state: 'preparing',
    };
    this.pendingStatuses.set(appId, preparingStatus);
    this.options.emitRuntimeStatus(appId, preparingStatus);

    let sessionRowId: number | undefined;
    let sessionId = '';
    let server: http.Server | undefined;
    let websocketServer: WebSocketServer | undefined;
    let tunnel: RemoteTunnel | undefined;
    try {
      await this.options.appendInstallLog('remote_network_share:create_session:start', {
        appId,
        backendBaseUrlOrigin: sanitizeUrlOrigin(this.options.backendBaseUrl),
      });
      const created = await client.createRemoteTunnelSession({ deviceId, appId });
      sessionRowId = Number(created.id);
      sessionId = String(created.session_id || '');
      const handshakeUrl = String(created.handshake_url || '');
      if (!Number.isFinite(sessionRowId) || !sessionId || !handshakeUrl) {
        throw new Error('remote_tunnel_session_payload_invalid');
      }
      const sessionIdPrefix = sanitizeSessionIdPrefix(sessionId);
      await this.options.appendInstallLog('remote_network_share:create_session:ready', {
        appId,
        sessionIdPrefix,
        backendBaseUrlOrigin: sanitizeUrlOrigin(this.options.backendBaseUrl),
        handshakeUrl: sanitizeUrlDiagnostic(handshakeUrl, { sessionId }),
      });
      const crypto = new RemoteSessionCrypto();
      websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
      server = http.createServer((request, response) => {
        void this.handleRpc(appId, crypto, request, response);
      });
      server.on('upgrade', (request, socket, head) => {
        void this.handleRealtimeUpgrade(appId, crypto, websocketServer!, request, socket, head);
      });
      await this.options.appendInstallLog('remote_network_share:local_rpc:start', { appId, sessionIdPrefix });
      const port = await listenLocal(server);
      await this.options.appendInstallLog('remote_network_share:tunnel:start', { appId, sessionIdPrefix, port });
      tunnel = await this.provider.open({ port, appId, sessionId });
      await this.options.appendInstallLog('remote_network_share:tunnel:ready', {
        appId,
        sessionIdPrefix,
        tunnelUrl: sanitizeUrlDiagnostic(tunnel.url, { sessionId }),
      });
      const frontendDir = this.frontendDir(appId, manifest);
      const nodeVersion = this.options.normalizeNodeRuntimeVersion(this.options.requiredNodeVersionForApp(appId));
      const nodeRuntime = await this.options.ensureRuntimeInstalled('node', nodeVersion);
      if (!nodeRuntime.node || !nodeRuntime.npm) {
        throw new Error('remote_tunnel_node_runtime_missing');
      }
      await this.options.appendInstallLog('remote_network_share:frontend_build:start', {
        appId,
        sessionIdPrefix,
        nodeVersion,
        backendBaseUrlOrigin: sanitizeUrlOrigin(this.options.backendBaseUrl),
        handshakeUrl: sanitizeUrlDiagnostic(handshakeUrl, { sessionId }),
      });
      const { assets, hash } = await buildRemoteFrontend({
        frontendDir,
        sessionId,
        handshakeUrl,
        nodePath: nodeRuntime.node,
        npmPath: nodeRuntime.npm,
      });
      await this.options.appendInstallLog('remote_network_share:frontend_build:ready', {
        appId,
        sessionIdPrefix,
        assetCount: assets.length,
        frontendHashPresent: Boolean(hash),
      });
      await this.options.appendInstallLog('remote_network_share:upload:start', {
        appId,
        sessionIdPrefix,
        assetCount: assets.length,
        tunnelUrl: sanitizeUrlDiagnostic(tunnel.url, { sessionId }),
      });
      const uploaded = await client.uploadRemoteTunnelFrontend({
        sessionId: sessionRowId,
        assets,
        frontendHash: hash,
        tunnelUrl: tunnel.url,
        desktopPublicKeyJwk: crypto.desktopPublicKeyJwk(),
      });
      const uploadedFrontendUrl = String(uploaded.frontend_url || created.frontend_url || '');
      await this.options.appendInstallLog('remote_network_share:upload:ready', {
        appId,
        sessionIdPrefix,
        frontendUrl: sanitizeUrlDiagnostic(uploadedFrontendUrl, { sessionId }),
      });
      const status: RemoteNetworkShareStatus = {
        active: true,
        appId,
        state: 'waiting_for_session',
        sessionId,
        portalUrl: String(uploaded.portal_url || created.portal_url || ''),
        frontendUrl: uploadedFrontendUrl,
        tunnelUrl: tunnel.url,
        connectionCount: 0,
        connections: [],
      };
      const state: ShareState = {
        appId,
        server,
        websocketServer,
        sessionRowId,
        sessionId,
        tunnel,
        crypto,
        status,
        seenNonces: new Set(),
        connectionKeyIds: new Set(),
        remoteSockets: new Set(),
      };
      this.pendingStatuses.delete(appId);
      this.shares.set(appId, state);
      this.emit(state);
      await this.options.appendInstallLog('remote_network_share:started', {
        appId,
        sessionIdPrefix,
        tunnelUrl: sanitizeUrlDiagnostic(tunnel.url, { sessionId }),
        frontendUrl: sanitizeUrlDiagnostic(status.frontendUrl, { sessionId }),
      });
      return { success: true, status };
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : 'remote_tunnel_start_failed';
      await Promise.allSettled([
        tunnel?.close() ?? Promise.resolve(),
        closeWebSocketServer(websocketServer),
        closeServerIfListening(server),
        sessionRowId
          ? client.reportRemoteTunnelSession({ sessionId: sessionRowId, status: 'error', lastError: technicalCode })
          : Promise.resolve(),
      ]);
      if (sessionRowId) {
        await client.closeRemoteTunnelSession(sessionRowId);
      }
      const status: RemoteNetworkShareStatus = {
        active: false,
        appId,
        state: 'error',
        sessionId,
        technicalCode,
      };
      this.pendingStatuses.set(appId, status);
      this.options.emitRuntimeStatus(appId, status);
      await this.options.appendInstallLog('remote_network_share:start_failed', {
        appId,
        sessionIdPrefix: sanitizeSessionIdPrefix(sessionId),
        technicalCode,
      });
      return { success: false, technicalCode, status };
    }

  }

  async stop(appId: string): Promise<RemoteNetworkShareResult> {
    const state = this.shares.get(appId);
    if (!state) {
      this.pendingStatuses.delete(appId);
      return { success: true, status: { active: false, appId, state: 'inactive' } };
    }
    this.shares.delete(appId);
    this.pendingStatuses.delete(appId);
    await Promise.allSettled([
      state.tunnel.close(),
      closeWebSocketServer(state.websocketServer, state.remoteSockets),
      new Promise<void>((resolve) => state.server.close(() => resolve())),
      this.options.backendClient()?.closeRemoteTunnelSession(state.sessionRowId) ?? Promise.resolve(),
    ]);
    const status: RemoteNetworkShareStatus = { active: false, appId, state: 'closed' };
    this.options.emitRuntimeStatus(appId, status);
    await this.options.appendInstallLog('remote_network_share:stopped', {
      appId,
      sessionIdPrefix: sanitizeSessionIdPrefix(state.sessionId),
    });
    return { success: true, status };
  }

  async stopBySession(sessionId: string): Promise<RemoteNetworkShareResult | undefined> {
    const state = Array.from(this.shares.values()).find((share) => share.sessionId === sessionId);
    if (!state) {
      return undefined;
    }
    return await this.stop(state.appId);
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.shares.keys()).map((appId) => this.stop(appId)));
  }

  private async handleRpc(appId: string, crypto: RemoteSessionCrypto, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = Date.now();
    const state = this.shares.get(appId);
    const isRpcPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname === REMOTE_RPC_PATH;
    if (isRpcPath) {
      setRemoteRpcCorsHeaders(request, response);
    }
    if (isRpcPath && request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (!state || request.method !== 'POST' || !isRpcPath) {
      response.statusCode = 404;
      response.end('not_found');
      return;
    }
    let envelope: RemoteEnvelope | undefined;
    let payloadPath: string | undefined;
    let payloadMethod: string | undefined;
    let requestBytes = 0;
    try {
      envelope = JSON.parse((await readBody(request)).toString('utf8')) as RemoteEnvelope;
      if (state.seenNonces.has(envelope.nonce)) {
        throw new Error('remote_rpc_replay');
      }
      state.seenNonces.add(envelope.nonce);
      const payload = crypto.decrypt<{ method: string; path: string; headers: Record<string, string>; bodyBase64: string | null }>(envelope);
      payloadPath = payload.path;
      payloadMethod = payload.method;
      requestBytes = payload.bodyBase64 ? Buffer.byteLength(payload.bodyBase64, 'base64') : 0;
      if (isBlocked(payload.path)) {
        throw new Error('remote_rpc_path_blocked');
      }
      const running = this.options.runningApps.get(appId);
      if (!running) {
        throw new Error('app_not_running');
      }
      const target = new URL(payload.path, running.backendUrl);
      const proxiedHeaders: Record<string, string> = {
        accept: payload.headers.accept ?? 'application/json',
        'x-forger-remote-tunnel': 'true',
        'x-forger-remote-session-id': state.sessionId,
      };
      if (payload.headers['content-type']) {
        proxiedHeaders['content-type'] = payload.headers['content-type'];
      }
      const proxied = await fetch(target, {
        method: payload.method,
        headers: proxiedHeaders,
        body: payload.bodyBase64 && !['GET', 'HEAD'].includes(payload.method)
          ? Buffer.from(payload.bodyBase64, 'base64')
          : undefined,
      });
      const responseBody = Buffer.from(await proxied.arrayBuffer());
      await this.options.appendInstallLog('remote_network_share:rpc', {
        appId,
        sessionIdPrefix: sanitizeSessionIdPrefix(state.sessionId),
        method: payload.method,
        path: sanitizeUrlDiagnostic(payload.path),
        status: proxied.status,
        durationMs: Date.now() - startedAt,
        requestBytes,
        responseBytes: responseBody.byteLength,
      });
      const encrypted = crypto.encrypt(state.sessionId, {
        status: proxied.status,
        headers: Object.fromEntries([...proxied.headers.entries()].filter(([key]) => ['content-type', 'cache-control'].includes(key.toLowerCase()))),
        bodyBase64: responseBody.toString('base64'),
      });
      state.connectionKeyIds.add(envelope.keyId);
      state.status = { ...state.status, state: 'connected', connectionCount: state.connectionKeyIds.size };
      this.emit(state);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(encrypted));
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : 'remote_rpc_failed';
      await this.options.appendInstallLog('remote_network_share:rpc_failed', {
        appId,
        sessionIdPrefix: sanitizeSessionIdPrefix(state.sessionId),
        method: payloadMethod,
        path: sanitizeUrlDiagnostic(payloadPath),
        technicalCode,
        durationMs: Date.now() - startedAt,
        requestBytes,
        keyId: envelope?.keyId,
        hasBrowserPublicKey: Boolean(envelope?.browserPublicKeyJwk),
      });
      response.statusCode = 403;
      response.end(technicalCode);
    }
  }

  private async handleRealtimeUpgrade(
    appId: string,
    crypto: RemoteSessionCrypto,
    websocketServer: WebSocketServer,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const state = this.shares.get(appId);
    const pathName = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (!state || pathName !== REMOTE_WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const running = this.options.runningApps.get(appId);
    if (!running) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (remoteSocket) => {
      state.remoteSockets.add(remoteSocket);
      this.attachRealtimeSocket(state, running.backendUrl, crypto, remoteSocket);
    });
  }

  private attachRealtimeSocket(
    state: ShareState,
    backendUrl: string,
    crypto: RemoteSessionCrypto,
    remoteSocket: WebSocket,
  ): void {
    const backendSocket = new WebSocket(realtimeBackendUrl(backendUrl), {
      headers: remoteTunnelHeaders(state.sessionId),
      maxPayload: MAX_WS_FRAME_BYTES,
    });
    const pending: string[] = [];
    let browserKeyId = '';

    const closeBoth = (): void => {
      state.remoteSockets.delete(remoteSocket);
      if (remoteSocket.readyState === WebSocket.OPEN || remoteSocket.readyState === WebSocket.CONNECTING) {
        remoteSocket.close();
      }
      if (backendSocket.readyState === WebSocket.OPEN || backendSocket.readyState === WebSocket.CONNECTING) {
        backendSocket.close();
      }
    };

    backendSocket.on('open', () => {
      for (const raw of pending.splice(0)) {
        backendSocket.send(raw);
      }
    });
    backendSocket.on('message', (raw) => {
      if (!browserKeyId || remoteSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        const payload = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as unknown;
        remoteSocket.send(JSON.stringify(crypto.encryptForKey(state.sessionId, browserKeyId, payload)));
      } catch (error) {
        void this.options.appendInstallLog('remote_network_share:ws_backend_failed', {
          appId: state.appId,
          sessionIdPrefix: sanitizeSessionIdPrefix(state.sessionId),
          error: error instanceof Error ? error.message : 'remote_ws_backend_failed',
        });
        closeBoth();
      }
    });
    backendSocket.on('error', (error) => {
      void this.options.appendInstallLog('remote_network_share:ws_backend_error', {
        appId: state.appId,
        sessionIdPrefix: sanitizeSessionIdPrefix(state.sessionId),
        error: error instanceof Error ? error.message : 'remote_ws_backend_error',
      });
      closeBoth();
    });
    backendSocket.on('close', closeBoth);

    remoteSocket.on('message', (raw) => {
      try {
        const envelope = JSON.parse(Buffer.from(raw as Buffer).toString('utf8')) as RemoteEnvelope;
        if (envelope.sessionId !== state.sessionId) {
          throw new Error('remote_ws_session_mismatch');
        }
        if (state.seenNonces.has(envelope.nonce)) {
          throw new Error('remote_ws_replay');
        }
        state.seenNonces.add(envelope.nonce);
        const payload = crypto.decrypt<unknown>(envelope);
        browserKeyId = envelope.keyId;
        state.connectionKeyIds.add(envelope.keyId);
        state.status = { ...state.status, state: 'connected', connectionCount: state.connectionKeyIds.size };
        this.emit(state);
        const serialized = JSON.stringify(payload);
        if (backendSocket.readyState === WebSocket.OPEN) {
          backendSocket.send(serialized);
        } else if (backendSocket.readyState === WebSocket.CONNECTING) {
          pending.push(serialized);
        } else {
          throw new Error('remote_ws_backend_not_connected');
        }
      } catch (error) {
        void this.options.appendInstallLog('remote_network_share:ws_failed', {
          appId: state.appId,
          sessionIdPrefix: sanitizeSessionIdPrefix(state.sessionId),
          error: error instanceof Error ? error.message : 'remote_ws_failed',
        });
        closeBoth();
      }
    });
    remoteSocket.on('error', closeBoth);
    remoteSocket.on('close', closeBoth);
  }

  private frontendDir(appId: string, manifest: AppManifest): string {
    const frontend = manifest.services?.find((service) => service.name === 'frontend');
    return path.resolve(this.options.installDirForApp(appId) ?? process.cwd(), frontend?.context ?? './frontend');
  }

  private emit(state: ShareState): void {
    this.options.emitRuntimeStatus(state.appId, state.status);
    void this.options.backendClient()?.reportRemoteTunnelSession({
      sessionId: state.sessionRowId,
      status: state.status.state,
      tunnelUrl: state.status.tunnelUrl,
      connectionCount: state.status.connectionCount,
      lastError: state.status.technicalCode,
    });
  }
}

const readBody = async (request: IncomingMessage): Promise<Buffer> =>
  await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('remote_rpc_body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

const closeServerIfListening = async (server?: http.Server): Promise<void> => {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const closeWebSocketServer = async (
  server?: WebSocketServer,
  sockets?: Set<WebSocket>,
): Promise<void> => {
  for (const socket of sockets ?? []) {
    socket.close();
  }
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const realtimeBackendUrl = (backendUrl: string): string => {
  const url = new URL(REALTIME_WS_PATH, backendUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

const remoteTunnelHeaders = (sessionId: string): Record<string, string> => ({
  'x-forger-remote-tunnel': 'true',
  'x-forger-remote-session-id': sessionId,
});

const isBlocked = (requestPath: string): boolean => {
  const normalized = requestPath.toLowerCase();
  return normalized.includes('..') || BLOCKED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const setRemoteRpcCorsHeaders = (request: IncomingMessage, response: ServerResponse): void => {
  const origin = request.headers.origin;
  response.setHeader('access-control-allow-origin', typeof origin === 'string' && origin ? origin : '*');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'accept, bypass-tunnel-reminder, content-type');
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'Origin');
};

const sanitizeUrlOrigin = (value: unknown): string | null => {
  const diagnostic = sanitizeUrlDiagnostic(value);
  return typeof diagnostic.origin === 'string' ? diagnostic.origin : null;
};

const sanitizeUrlDiagnostic = (value: unknown, options: { sessionId?: string } = {}): Record<string, unknown> => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return { present: false, shape: 'empty' };
  }
  try {
    return serializeUrlDiagnostic(new URL(raw), 'absolute', options);
  } catch {
    // Continue below and try relative URL parsing without preserving the raw input.
  }
  try {
    return serializeUrlDiagnostic(new URL(raw, 'forger://relative'), 'relative', options);
  } catch {
    return { present: true, shape: 'invalid' };
  }
};

const serializeUrlDiagnostic = (
  url: URL,
  shape: 'absolute' | 'relative',
  options: { sessionId?: string },
): Record<string, unknown> => {
  const sessionPrefix = sanitizeSessionIdPrefix(options.sessionId);
  return {
    present: true,
    shape,
    ...(shape === 'absolute' ? { origin: redactSessionId(url.origin, options.sessionId, sessionPrefix) } : {}),
    path: redactSessionId(url.pathname || '/', options.sessionId, sessionPrefix),
    hasQuery: Boolean(url.search),
    hasFragment: Boolean(url.hash),
  };
};

const sanitizeSessionIdPrefix = (sessionId: unknown): string | null => {
  const value = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!value) {
    return null;
  }
  if (value.length <= 8) {
    return `${value.slice(0, Math.max(1, Math.ceil(value.length / 2)))}...`;
  }
  return `${value.slice(0, 8)}...`;
};

const redactSessionId = (value: string, sessionId: unknown, replacement: string | null): string => {
  const rawSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!rawSessionId || !replacement) {
    return value;
  }
  return [
    rawSessionId,
    encodeURIComponent(rawSessionId),
    rawSessionId.toLowerCase().replace(/[^a-z0-9]/g, ''),
  ].reduce((current, sensitive) => sensitive ? current.split(sensitive).join(replacement) : current, value);
};
