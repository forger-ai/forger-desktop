import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

import type { RemoteNetworkShareResult, RemoteNetworkShareStatus } from '../shared/types';
import type { AppManifest, RunningAppProcess } from './core/main-process-types';
import type { ForgerBackendClient } from './forger-backend-client';
import { RemoteSessionCrypto, type RemoteEnvelope } from './remote-crypto';
import { buildRemoteFrontend } from './remote-frontend-packager';
import { listenLocal, LocalTunnelProvider, type RemoteTunnel, type RemoteTunnelProvider } from './remote-tunnel-provider';

const REMOTE_RPC_PATH = '/__forger_remote_rpc';
const BLOCKED_PREFIXES = ['/mcp', '/__forger_internal', '/__forger_remote_rpc'];
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface ShareState {
  appId: string;
  server: http.Server;
  sessionRowId: number;
  sessionId: string;
  tunnel: RemoteTunnel;
  crypto: RemoteSessionCrypto;
  status: RemoteNetworkShareStatus;
  seenNonces: Set<string>;
  connectionKeyIds: Set<string>;
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
      return { success: true, userMessage: 'Túnel remoto activo.', status: existing.status };
    }
    const manifest = await this.options.resolveInstalledManifest(appId);
    if (manifest?.remoteTunnel !== true) {
      return {
        success: false,
        userMessage: 'Esta app no declara soporte para túneles remotos.',
        technicalCode: 'remote_tunnel_not_supported',
        status: { active: false, appId, state: 'inactive' },
      };
    }
    const client = this.options.backendClient();
    const deviceId = await this.options.getCurrentDeviceId();
    if (!client || !deviceId) {
      return {
        success: false,
        userMessage: 'Conecta Forger Cloud antes de compartir por internet.',
        technicalCode: 'forger_cloud_required',
        status: { active: false, appId, state: 'inactive' },
      };
    }
    const open = await this.options.openInstalledApp(appId, undefined, { openWindow: false });
    if (!open.success) {
      return {
        success: false,
        userMessage: open.userMessage,
        technicalCode: open.technicalCode ?? 'remote_tunnel_open_failed',
        status: { active: false, appId, state: 'inactive' },
      };
    }
    const running = this.options.runningApps.get(appId);
    if (!running) {
      return {
        success: false,
        userMessage: 'La app no está en ejecución.',
        technicalCode: 'app_not_running',
        status: { active: false, appId, state: 'inactive' },
      };
    }

    const preparingStatus: RemoteNetworkShareStatus = {
      active: true,
      appId,
      state: 'preparing',
      userMessage: 'Preparando túnel remoto.',
    };
    this.pendingStatuses.set(appId, preparingStatus);
    this.options.emitRuntimeStatus(appId, preparingStatus);

    let sessionRowId: number | undefined;
    let sessionId = '';
    let server: http.Server | undefined;
    let tunnel: RemoteTunnel | undefined;
    try {
      await this.options.appendInstallLog('remote_network_share:create_session:start', { appId });
      const created = await client.createRemoteTunnelSession({ deviceId, appId });
      sessionRowId = Number(created.id);
      sessionId = String(created.session_id || '');
      const handshakeUrl = String(created.handshake_url || '');
      if (!Number.isFinite(sessionRowId) || !sessionId || !handshakeUrl) {
        throw new Error('remote_tunnel_session_payload_invalid');
      }
      const crypto = new RemoteSessionCrypto();
      server = http.createServer((request, response) => {
        void this.handleRpc(appId, crypto, request, response);
      });
      await this.options.appendInstallLog('remote_network_share:local_rpc:start', { appId, sessionId });
      const port = await listenLocal(server);
      await this.options.appendInstallLog('remote_network_share:tunnel:start', { appId, sessionId, port });
      tunnel = await this.provider.open({ port, appId, sessionId });
      await this.options.appendInstallLog('remote_network_share:tunnel:ready', { appId, sessionId, tunnelUrl: tunnel.url });
      const frontendDir = this.frontendDir(appId, manifest);
      await this.options.appendInstallLog('remote_network_share:frontend_build:start', { appId, sessionId, frontendDir });
      const { assets, hash } = await buildRemoteFrontend({
        frontendDir,
        sessionId,
        handshakeUrl,
      });
      await this.options.appendInstallLog('remote_network_share:frontend_build:ready', { appId, sessionId, assetCount: assets.length, hash });
      await this.options.appendInstallLog('remote_network_share:upload:start', { appId, sessionId, assetCount: assets.length });
      const uploaded = await client.uploadRemoteTunnelFrontend({
        sessionId: sessionRowId,
        assets,
        frontendHash: hash,
        tunnelUrl: tunnel.url,
        desktopPublicKeyJwk: crypto.desktopPublicKeyJwk(),
      });
      await this.options.appendInstallLog('remote_network_share:upload:ready', { appId, sessionId });
      const status: RemoteNetworkShareStatus = {
        active: true,
        appId,
        state: 'waiting_for_session',
        sessionId,
        portalUrl: String(uploaded.portal_url || created.portal_url || ''),
        frontendUrl: String(uploaded.frontend_url || created.frontend_url || ''),
        tunnelUrl: tunnel.url,
        connectionCount: 0,
        connections: [],
        userMessage: 'Túnel esperando sesión.',
      };
      const state: ShareState = { appId, server, sessionRowId, sessionId, tunnel, crypto, status, seenNonces: new Set(), connectionKeyIds: new Set() };
      this.pendingStatuses.delete(appId);
      this.shares.set(appId, state);
      this.emit(state);
      await this.options.appendInstallLog('remote_network_share:started', { appId, sessionId, tunnelUrl: tunnel.url });
      return { success: true, userMessage: 'Túnel remoto activo.', status };
    } catch (error) {
      const technicalCode = error instanceof Error ? error.message : 'remote_tunnel_start_failed';
      await Promise.allSettled([
        tunnel?.close() ?? Promise.resolve(),
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
        userMessage: 'No pudimos preparar el túnel remoto.',
      };
      this.pendingStatuses.set(appId, status);
      this.options.emitRuntimeStatus(appId, status);
      await this.options.appendInstallLog('remote_network_share:start_failed', { appId, sessionId, technicalCode });
      return { success: false, userMessage: status.userMessage ?? 'No pudimos preparar el túnel remoto.', technicalCode, status };
    }

  }

  async stop(appId: string): Promise<RemoteNetworkShareResult> {
    const state = this.shares.get(appId);
    if (!state) {
      this.pendingStatuses.delete(appId);
      return { success: true, userMessage: 'Túnel remoto detenido.', status: { active: false, appId, state: 'inactive' } };
    }
    this.shares.delete(appId);
    this.pendingStatuses.delete(appId);
    await Promise.allSettled([
      state.tunnel.close(),
      new Promise<void>((resolve) => state.server.close(() => resolve())),
      this.options.backendClient()?.closeRemoteTunnelSession(state.sessionRowId) ?? Promise.resolve(),
    ]);
    const status: RemoteNetworkShareStatus = { active: false, appId, state: 'closed', userMessage: 'Túnel remoto detenido.' };
    this.options.emitRuntimeStatus(appId, status);
    await this.options.appendInstallLog('remote_network_share:stopped', { appId, sessionId: state.sessionId });
    return { success: true, userMessage: 'Túnel remoto detenido.', status };
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
        sessionId: state.sessionId,
        method: payload.method,
        path: payload.path,
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
        sessionId: state.sessionId,
        method: payloadMethod,
        path: payloadPath,
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

const isBlocked = (requestPath: string): boolean => {
  const normalized = requestPath.toLowerCase();
  return normalized.includes('..') || BLOCKED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const setRemoteRpcCorsHeaders = (request: IncomingMessage, response: ServerResponse): void => {
  const origin = request.headers.origin;
  response.setHeader('access-control-allow-origin', typeof origin === 'string' && origin ? origin : '*');
  response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  response.setHeader('access-control-allow-headers', 'accept, content-type');
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'Origin');
};
