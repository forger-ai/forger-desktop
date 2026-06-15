import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';

import type {
  LocalNetworkShareResult,
  LocalNetworkShareStatus,
  OpenAppResult,
} from '../shared/types';
import type { RunningAppProcess } from './core/main-process-types';

const COOKIE_NAME = 'forger_lan_share';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const BLOCKED_PATH_PREFIXES = ['/.git', '/file:', '/__forger_internal'];
const REQUEST_HEADERS = new Set(['accept', 'accept-language', 'content-type']);
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'last-modified']);

interface ShareState {
  appId: string;
  server: http.Server;
  url: string;
  connectUrl?: string;
  token?: string;
  sessions: Set<string>;
  connectedAt?: string;
}

interface ProxyToRunningAppInput {
  request: IncomingMessage;
  response: ServerResponse;
  targetBaseUrl: string;
  publicBaseUrl: string;
  privateBaseUrl: string;
}

export interface LocalNetworkShareManagerOptions {
  runningApps: Map<string, RunningAppProcess>;
  openInstalledApp: (appId: string, locale?: string, options?: { openWindow?: boolean }) => Promise<OpenAppResult>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  onConnected?: (status: LocalNetworkShareStatus) => void;
}

export class LocalNetworkShareManager {
  private readonly shares = new Map<string, ShareState>();

  constructor(private readonly options: LocalNetworkShareManagerOptions) {}

  public async start(appId: string): Promise<LocalNetworkShareResult> {
    const existing = this.shares.get(appId);
    if (existing) {
      return {
        success: true,
        userMessage: 'Red local activa.',
        status: this.toStatus(existing),
      };
    }

    const open = await this.options.openInstalledApp(appId, undefined, { openWindow: false });
    if (!open.success) {
      return {
        success: false,
        userMessage: open.userMessage,
        technicalCode: open.technicalCode ?? 'local_network_open_failed',
        status: this.inactiveStatus(appId),
      };
    }

    const running = this.options.runningApps.get(appId);
    if (!running) {
      return {
        success: false,
        userMessage: 'La app no esta en ejecucion.',
        technicalCode: 'app_not_running',
        status: this.inactiveStatus(appId),
      };
    }

    const token = randomToken();
    const state: ShareState = {
      appId,
      server: http.createServer(),
      url: '',
      token,
      sessions: new Set(),
    };
    state.server.on('request', (request, response) => {
      void this.handleRequest(state, request, response);
    });

    const port = await listenLan(state.server);
    const host = firstLanAddress();
    state.url = `http://${host}:${port}`;
    state.connectUrl = `${state.url}/connect/${encodeURIComponent(token)}`;
    this.shares.set(appId, state);
    await this.options.appendInstallLog('local_network_share:started', { appId, url: state.url });
    return {
      success: true,
      userMessage: 'Red local activa.',
      status: this.toStatus(state),
    };
  }

  public async stop(appId: string): Promise<LocalNetworkShareResult> {
    const state = this.shares.get(appId);
    if (!state) {
      return {
        success: true,
        userMessage: 'Red local detenida.',
        status: this.inactiveStatus(appId),
      };
    }
    this.shares.delete(appId);
    await new Promise<void>((resolve) => state.server.close(() => resolve()));
    await this.options.appendInstallLog('local_network_share:stopped', { appId });
    return {
      success: true,
      userMessage: 'Red local detenida.',
      status: this.inactiveStatus(appId),
    };
  }

  public async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.shares.keys()).map((appId) => this.stop(appId)));
  }

  public status(appId: string): LocalNetworkShareStatus {
    const state = this.shares.get(appId);
    return state ? this.toStatus(state) : this.inactiveStatus(appId);
  }

  private async handleRequest(state: ShareState, request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const rawUrl = request.url ?? '/';
      const requestUrl = new URL(rawUrl, state.url || 'http://127.0.0.1');
      if (request.method === 'GET' && requestUrl.pathname.startsWith('/connect/')) {
        this.consumeToken(state, decodeURIComponent(requestUrl.pathname.slice('/connect/'.length)));
        const sessionToken = randomToken();
        state.sessions.add(sessionToken);
        state.connectedAt = new Date().toISOString();
        this.options.onConnected?.(this.toStatus(state));
        await this.options.appendInstallLog('local_network_share:connected', { appId: state.appId, connectedAt: state.connectedAt });
        response.statusCode = 302;
        response.setHeader('set-cookie', `${COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`);
        response.setHeader('location', '/');
        response.end();
        return;
      }

      const sessionToken = readCookie(request, COOKIE_NAME);
      if (!sessionToken || !state.sessions.has(sessionToken)) {
        response.statusCode = 401;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end('local_network_share_session_required');
        return;
      }

      const pathValue = rawUrl || requestUrl.pathname || '/';
      if (isBlockedPath(pathValue)) {
        response.statusCode = 403;
        response.end('path_blocked');
        return;
      }

      const running = this.options.runningApps.get(state.appId);
      if (!running) {
        response.statusCode = 424;
        response.end('app_not_running');
        void this.stop(state.appId).catch((error) => {
          void this.options.appendInstallLog('local_network_share:stop_failed', {
            appId: state.appId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      await proxyToRunningApp({
        request,
        response,
        targetBaseUrl: running.frontendUrl,
        publicBaseUrl: state.url,
        privateBaseUrl: running.frontendUrl,
      });
    } catch (error) {
      await this.options.appendInstallLog('local_network_share:error', {
        appId: state.appId,
        message: error instanceof Error ? error.message : String(error),
      });
      response.statusCode = 502;
      response.end('local_network_share_failed');
    }
  }

  private consumeToken(state: ShareState, token: string): void {
    if (!state.token || !safeEqual(state.token, token)) {
      throw new Error('local_network_share_token_invalid');
    }
    state.token = undefined;
    state.connectUrl = undefined;
  }

  private toStatus(state: ShareState): LocalNetworkShareStatus {
    return {
      active: true,
      appId: state.appId,
      url: state.url,
      connectUrl: state.connectUrl,
      connectedAt: state.connectedAt,
    };
  }

  private inactiveStatus(appId: string): LocalNetworkShareStatus {
    return { active: false, appId };
  }
}

const listenLan = async (server: http.Server): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
        return;
      }
      /* c8 ignore next -- Node returns an address object after a successful TCP listen. */
      reject(new Error('local_network_port_unavailable'));
    });
  });

const firstLanAddress = (): string => {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
};

const proxyToRunningApp = async (input: ProxyToRunningAppInput): Promise<void> => {
  const targetUrl = new URL(input.request.url ?? '/', input.targetBaseUrl);
  const body = await readBody(input.request);
  const bodyBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  const proxied = await fetch(targetUrl, {
    method: input.request.method,
    headers: filterRequestHeaders(input.request.headers),
    body: input.request.method === 'GET' || input.request.method === 'HEAD'
      ? undefined
      : bodyBuffer,
  });

  input.response.statusCode = proxied.status;
  const contentType = proxied.headers.get('content-type') ?? '';
  for (const [key, value] of proxied.headers.entries()) {
    if (RESPONSE_HEADERS.has(key.toLowerCase())) {
      input.response.setHeader(key, value);
    }
  }
  const raw = Buffer.from(await proxied.arrayBuffer());
  if (isTextResponse(contentType)) {
    const text = raw.toString('utf8')
      .replaceAll(input.privateBaseUrl, input.publicBaseUrl)
      .replaceAll('http://localhost', `http://${new URL(input.publicBaseUrl).host}`)
      .replaceAll('http://127.0.0.1', `http://${new URL(input.publicBaseUrl).host}`);
    input.response.setHeader('cache-control', 'no-store');
    input.response.end(text);
    return;
  }
  input.response.end(raw);
};

const readBody = async (request: IncomingMessage): Promise<Buffer> =>
  await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('local_network_body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });

const filterRequestHeaders = (headers: IncomingMessage['headers']): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REQUEST_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
};

const isBlockedPath = (pathValue: string): boolean => {
  const normalized = pathValue.toLowerCase();
  if (normalized.includes('..')) return true;
  try {
    if (decodeURIComponent(normalized).includes('..')) return true;
  } catch {
    return true;
  }
  return BLOCKED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const readCookie = (request: IncomingMessage, name: string): string | null => {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
};

const isTextResponse = (contentType: string): boolean => {
  const normalized = contentType.toLowerCase();
  return normalized.includes('text/html')
    || normalized.includes('javascript')
    || normalized.includes('text/css')
    || normalized.includes('application/json');
};

const randomToken = (): string => randomBytes(32).toString('base64url');

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};
