import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { InternalToolContext } from '../types';
import {
  CHROME_EXTENSION_DEFAULT_TIMEOUT_MS,
  CHROME_EXTENSION_DEV_ID,
  CHROME_EXTENSION_MAX_WAIT_TIMEOUT_MS,
  CHROME_EXTENSION_NATIVE_HOST_NAME,
  CHROME_EXTENSION_WAIT_COMMAND_TIMEOUT_PADDING_MS,
  type ChromeExtensionChannel,
  type ChromeExtensionCommandEnvelope,
  type ChromeExtensionCommandResponse,
  type ChromeExtensionConnectionStatus,
  type ChromeExtensionNativeMessage,
  type ChromeExtensionSession,
} from './types';

interface ConnectedExtension {
  socket: WebSocket;
  extensionId: string;
  channel: ChromeExtensionChannel;
  connectedAt: string;
  lastHeartbeatAt: string;
}

interface PendingRequest {
  resolve: (value: ChromeExtensionCommandResponse) => void;
  timeout: NodeJS.Timeout;
}

interface BridgeState {
  server: http.Server;
  websocketServer: WebSocketServer;
  token: string;
  port: number;
  configPath: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const nowIso = (): string => new Date().toISOString();
const CHROME_EXTENSION_MAX_WEBSOCKET_PAYLOAD_BYTES = 64 * 1024 * 1024;

const isAllowedUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return parsed.hostname !== 'chrome.google.com' && parsed.hostname !== 'chromewebstore.google.com';
  } catch {
    return false;
  }
};

const nativeMessagingManifestPath = (): string => {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${CHROME_EXTENSION_NATIVE_HOST_NAME}.json`);
  }
  if (process.platform === 'linux') {
    return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${CHROME_EXTENSION_NATIVE_HOST_NAME}.json`);
  }
  if (process.platform === 'win32') {
    const root = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(root, 'Forger', 'ChromeNativeMessagingHosts', `${CHROME_EXTENSION_NATIVE_HOST_NAME}.json`);
  }
  return path.join(os.homedir(), `.${CHROME_EXTENSION_NATIVE_HOST_NAME}.json`);
};

const closeServer = async (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

export class ChromeExtensionBridgeManager {
  private bridge: BridgeState | null = null;
  private clients = new Map<string, ConnectedExtension>();
  private pending = new Map<string, PendingRequest>();
  private sessions = new Map<string, ChromeExtensionSession>();
  private nativeHostManifestPath: string | undefined;

  constructor(
    private readonly preferredChannel: ChromeExtensionChannel | 'auto' = process.env.FORGER_CHROME_EXTENSION_CHANNEL === 'dev' ? 'dev' : 'auto',
    private readonly productionExtensionId: string | null = cleanString(process.env.FORGER_CHROME_EXTENSION_ID) || null,
    private readonly maxWebSocketPayloadBytes: number = CHROME_EXTENSION_MAX_WEBSOCKET_PAYLOAD_BYTES,
  ) {}

  async start(context: InternalToolContext): Promise<void> {
    if (this.bridge) {
      return;
    }
    const token = crypto.randomBytes(24).toString('hex');
    const port = await context.getFreePort();
    const metadataDir = this.getMetadataDir(context);
    const configPath = path.join(metadataDir, 'bridge.json');
    await fs.mkdir(metadataDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ port, token }, null, 2), { encoding: 'utf8', mode: 0o600 });

    const websocketServer = new WebSocketServer({ noServer: true, maxPayload: this.maxWebSocketPayloadBytes });
    const server = http.createServer();
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (url.pathname !== '/chrome-extension-native-host' || url.searchParams.get('token') !== token) {
        socket.destroy();
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit('connection', websocket, request);
      });
    });
    websocketServer.on('connection', (socket) => this.registerNativeHostSocket(socket));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.bridge = { server, websocketServer, token, port, configPath };
    await this.loadSessions(context);
  }

  async configure(context: InternalToolContext): Promise<ChromeExtensionConnectionStatus> {
    await this.start(context);
    this.nativeHostManifestPath = await this.writeNativeMessagingManifest(context);
    return this.status(context);
  }

  async status(context: InternalToolContext): Promise<ChromeExtensionConnectionStatus> {
    await this.start(context);
    return {
      configured: this.getSelectedClient() !== null,
      connected: this.getSelectedClient() !== null,
      activeChannel: this.getSelectedClient()?.channel ?? null,
      connectedExtensions: [...this.clients.values()].map((client) => ({
        extensionId: client.extensionId,
        channel: client.channel,
        connectedAt: client.connectedAt,
        lastHeartbeatAt: client.lastHeartbeatAt,
      })),
      devExtensionId: CHROME_EXTENSION_DEV_ID,
      productionExtensionId: this.productionExtensionId,
      nativeHostName: CHROME_EXTENSION_NATIVE_HOST_NAME,
      ...(this.nativeHostManifestPath ? { nativeHostManifestPath: this.nativeHostManifestPath } : {}),
      sessions: [...this.sessions.values()],
    };
  }

  async isConfigured(context: InternalToolContext): Promise<boolean> {
    return (await this.status(context)).configured;
  }

  async sendCommand(
    context: InternalToolContext,
    action: string,
    input: { sessionId?: string; payload?: Record<string, unknown> },
    options?: { timeoutMs?: number },
  ): Promise<ChromeExtensionCommandResponse> {
    await this.start(context);
    const client = this.getSelectedClient();
    if (!client) {
      return {
        requestId: '',
        success: false,
        error: { code: 'chrome_extension_not_connected', message: 'Forger Chrome Extension is not connected.' },
      };
    }
    if (input.sessionId && !this.sessions.has(input.sessionId)) {
      return {
        requestId: '',
        success: false,
        error: { code: 'chrome_extension_session_not_found', message: 'The Chrome session is not available.' },
      };
    }

    const requestId = crypto.randomUUID();
    const envelope: ChromeExtensionCommandEnvelope = {
      requestId,
      action,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    };
    const commandTimeoutMs = Number.isFinite(options?.timeoutMs)
      ? Math.max(1, Math.floor(options?.timeoutMs ?? CHROME_EXTENSION_DEFAULT_TIMEOUT_MS))
      : CHROME_EXTENSION_DEFAULT_TIMEOUT_MS;
    const response = await new Promise<ChromeExtensionCommandResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          requestId,
          success: false,
          error: { code: 'chrome_extension_request_timeout', message: 'Chrome extension request timed out.' },
        });
      }, commandTimeoutMs);
      this.pending.set(requestId, { resolve, timeout });
      client.socket.send(JSON.stringify({ type: 'command', ...envelope }));
    });

    await this.applySessionMutation(context, action, client.channel, response);
    return response;
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve({ requestId: '', success: false, error: { code: 'chrome_extension_bridge_stopped' } });
    }
    this.pending.clear();
    for (const client of this.clients.values()) {
      client.socket.close();
    }
    this.clients.clear();
    if (this.bridge) {
      this.bridge.websocketServer.close();
      await closeServer(this.bridge.server).catch(() => undefined);
      this.bridge = null;
    }
  }

  parseOpenDedicatedTabInput(input: unknown): { payload: Record<string, unknown> } | null {
    if (!isRecord(input)) {
      return { payload: {} };
    }
    const url = cleanString(input.url);
    if (url && !isAllowedUrl(url)) {
      return null;
    }
    return { payload: url ? { url } : {} };
  }

  parseSessionInput(input: unknown): { sessionId: string; payload?: Record<string, unknown> } | null {
    if (!isRecord(input)) {
      return null;
    }
    const sessionId = cleanString(input.sessionId);
    if (!sessionId) {
      return null;
    }
    return { sessionId };
  }

  parseNavigateInput(input: unknown): { sessionId: string; payload: Record<string, unknown> } | null {
    if (!isRecord(input)) {
      return null;
    }
    const sessionId = cleanString(input.sessionId);
    const url = cleanString(input.url);
    if (!sessionId || !url || !isAllowedUrl(url)) {
      return null;
    }
    return { sessionId, payload: { url } };
  }

  parseSelectorInput(input: unknown, options?: { allowMissingSelector?: boolean; includeText?: boolean }): { sessionId: string; payload: Record<string, unknown> } | null {
    if (!isRecord(input)) {
      return null;
    }
    const sessionId = cleanString(input.sessionId);
    const selector = cleanString(input.selector);
    if (!sessionId || (!selector && !options?.allowMissingSelector)) {
      return null;
    }
    const payload: Record<string, unknown> = {};
    if (selector) {
      payload.selector = selector;
    }
    if (options?.includeText) {
      const text = typeof input.text === 'string' ? input.text : '';
      payload.text = text;
    }
    return { sessionId, payload };
  }

  parseWaitForSelectorInput(input: unknown): { sessionId: string; payload: Record<string, unknown>; commandTimeoutMs: number } | null {
    const parsed = this.parseSelectorInput(input);
    if (!parsed || !isRecord(input)) {
      return null;
    }
    const state = cleanString(input.state) || 'visible';
    if (!['attached', 'visible', 'hidden', 'detached'].includes(state)) {
      return null;
    }
    const rawTimeoutMs = input.timeoutMs;
    const timeoutMs = rawTimeoutMs === undefined
      ? CHROME_EXTENSION_DEFAULT_TIMEOUT_MS
      : typeof rawTimeoutMs === 'number' && Number.isFinite(rawTimeoutMs)
        ? Math.floor(rawTimeoutMs)
        : NaN;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > CHROME_EXTENSION_MAX_WAIT_TIMEOUT_MS) {
      return null;
    }
    parsed.payload.state = state;
    parsed.payload.timeoutMs = timeoutMs;
    return {
      ...parsed,
      commandTimeoutMs: Math.min(
        CHROME_EXTENSION_MAX_WAIT_TIMEOUT_MS + CHROME_EXTENSION_WAIT_COMMAND_TIMEOUT_PADDING_MS,
        timeoutMs + CHROME_EXTENSION_WAIT_COMMAND_TIMEOUT_PADDING_MS,
      ),
    };
  }

  parseSubmitFormInput(input: unknown): { sessionId: string; payload: Record<string, unknown> } | null {
    const parsed = this.parseSelectorInput(input);
    if (!parsed || !isRecord(input)) {
      return null;
    }
    const submitSelector = cleanString(input.submitSelector);
    if (submitSelector) {
      parsed.payload.submitSelector = submitSelector;
    }
    return parsed;
  }

  parseStylesInput(input: unknown, options: { includeStyles: boolean }): { sessionId: string; payload: Record<string, unknown> } | null {
    const parsed = this.parseSelectorInput(input);
    if (!parsed || !isRecord(input)) {
      return null;
    }
    if (Array.isArray(input.properties)) {
      parsed.payload.properties = input.properties
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 20);
    }
    if (!options.includeStyles) {
      return parsed;
    }
    if (!isRecord(input.styles)) {
      return null;
    }
    const styles = Object.fromEntries(Object.entries(input.styles)
      .filter(([property, value]) =>
        typeof property === 'string'
        && property.trim().length > 0
        && typeof value === 'string'
        && value.length <= 300
      ));
    if (Object.keys(styles).length === 0) {
      return null;
    }
    parsed.payload.styles = styles;
    return parsed;
  }

  private registerNativeHostSocket(socket: WebSocket): void {
    let clientKey: string | null = null;
    socket.on('message', (raw) => {
      let message: ChromeExtensionNativeMessage;
      try {
        message = JSON.parse(String(raw)) as ChromeExtensionNativeMessage;
      } catch {
        return;
      }
      if (message.type === 'hello' || message.type === 'heartbeat') {
        const extensionId = cleanString(message.extensionId);
        const channel = message.channel === 'production' ? 'production' : message.channel === 'dev' ? 'dev' : null;
        if (!this.isAllowedExtension(extensionId, channel)) {
          socket.close();
          return;
        }
        clientKey = `${channel}:${extensionId}`;
        const existing = this.clients.get(clientKey);
        this.clients.set(clientKey, {
          socket,
          extensionId,
          channel,
          connectedAt: existing?.connectedAt ?? nowIso(),
          lastHeartbeatAt: nowIso(),
        });
        return;
      }
      if (message.requestId) {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(message.requestId);
        pending.resolve({
          requestId: message.requestId,
          success: message.success === true,
          ...(message.data !== undefined ? { data: message.data } : {}),
          ...(message.error ? { error: normalizeNativeError(message.error) } : {}),
        });
      }
    });
    socket.on('error', (error) => {
      if (clientKey) {
        this.clients.delete(clientKey);
      }
      this.failPendingRequests('chrome_extension_bridge_socket_error', error.message || 'Chrome extension bridge socket failed.');
    });
    socket.on('close', () => {
      if (clientKey) {
        this.clients.delete(clientKey);
      }
      this.failPendingRequests('chrome_extension_bridge_disconnected', 'Chrome extension bridge disconnected.');
    });
  }

  private failPendingRequests(code: string, message: string): void {
    for (const [requestId, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.resolve({
        requestId,
        success: false,
        error: { code, message },
      });
    }
  }

  private isAllowedExtension(extensionId: string, channel: ChromeExtensionChannel | null): channel is ChromeExtensionChannel {
    if (!extensionId || !channel) {
      return false;
    }
    if (channel === 'dev') {
      return extensionId === CHROME_EXTENSION_DEV_ID;
    }
    return Boolean(this.productionExtensionId && extensionId === this.productionExtensionId);
  }

  private getSelectedClient(): ConnectedExtension | null {
    const connected = [...this.clients.values()].filter((client) => client.socket.readyState === WebSocket.OPEN);
    if (this.preferredChannel === 'dev') {
      return connected.find((client) => client.channel === 'dev') ?? null;
    }
    return connected.find((client) => client.channel === 'production') ?? connected.find((client) => client.channel === 'dev') ?? null;
  }

  private async applySessionMutation(
    context: InternalToolContext,
    action: string,
    channel: ChromeExtensionChannel,
    response: ChromeExtensionCommandResponse,
  ): Promise<void> {
    if (!response.success) {
      return;
    }
    if (action === 'open_dedicated_tab' && isRecord(response.data)) {
      const sessionId = cleanString(response.data.sessionId);
      const windowId = typeof response.data.windowId === 'number' ? response.data.windowId : NaN;
      const tabId = typeof response.data.tabId === 'number' ? response.data.tabId : NaN;
      if (sessionId && Number.isFinite(windowId) && Number.isFinite(tabId)) {
        this.sessions.set(sessionId, { sessionId, windowId, tabId, extensionChannel: channel, createdAt: nowIso(), updatedAt: nowIso() });
        await this.saveSessions(context);
      }
    }
    if (action === 'close_session' && isRecord(response.data)) {
      const sessionId = cleanString(response.data.sessionId);
      if (sessionId && this.sessions.delete(sessionId)) {
        await this.saveSessions(context);
      }
    }
    if (action === 'close_window' && isRecord(response.data)) {
      const sessionId = cleanString(response.data.sessionId);
      const windowId = typeof response.data.windowId === 'number' ? response.data.windowId : NaN;
      let changed = false;
      if (sessionId && this.sessions.delete(sessionId)) {
        changed = true;
      }
      if (Number.isFinite(windowId)) {
        for (const [storedSessionId, session] of this.sessions.entries()) {
          if (session.windowId === windowId) {
            this.sessions.delete(storedSessionId);
            changed = true;
          }
        }
      }
      if (changed) {
        await this.saveSessions(context);
      }
    }
  }

  private async writeNativeMessagingManifest(context: InternalToolContext): Promise<string> {
    if (!this.bridge) {
      throw new Error('chrome_extension_bridge_not_started');
    }
    const metadataDir = this.getMetadataDir(context);
    const launcherPath = path.join(metadataDir, 'forger-chrome-extension-native-host.sh');
    const nativeHostPath = path.join(__dirname, 'native-host.js');
    const launcher = [
      '#!/bin/sh',
      'set -eu',
      `export ELECTRON_RUN_AS_NODE=1`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(nativeHostPath)} ${JSON.stringify(this.bridge.configPath)}`,
      '',
    ].join('\n');
    await fs.writeFile(launcherPath, launcher, { encoding: 'utf8', mode: 0o700 });
    await fs.chmod(launcherPath, 0o700).catch(() => undefined);

    const allowedOrigins = [`chrome-extension://${CHROME_EXTENSION_DEV_ID}/`];
    if (this.productionExtensionId) {
      allowedOrigins.push(`chrome-extension://${this.productionExtensionId}/`);
    }
    const manifest = {
      name: CHROME_EXTENSION_NATIVE_HOST_NAME,
      description: 'Forger Chrome Extension native messaging host',
      path: launcherPath,
      type: 'stdio',
      allowed_origins: allowedOrigins,
    };
    const manifestPath = nativeMessagingManifestPath();
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o644 });
    context.appendLog?.('chrome_extension:native_host_registered', { manifestPath, allowedOrigins });
    return manifestPath;
  }

  private getMetadataDir(context: InternalToolContext): string {
    return path.join(context.metadataRoot, 'official-tools', 'chrome-extension');
  }

  private getSessionsPath(context: InternalToolContext): string {
    return path.join(this.getMetadataDir(context), 'sessions.json');
  }

  private async loadSessions(context: InternalToolContext): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.getSessionsPath(context), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      this.sessions = new Map(parsed.filter(isChromeExtensionSession).map((session) => [session.sessionId, session]));
    } catch {
      this.sessions = new Map();
    }
  }

  private async saveSessions(context: InternalToolContext): Promise<void> {
    const sessionsPath = this.getSessionsPath(context);
    await fs.mkdir(path.dirname(sessionsPath), { recursive: true });
    await fs.writeFile(sessionsPath, JSON.stringify([...this.sessions.values()], null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

const isChromeExtensionSession = (value: unknown): value is ChromeExtensionSession => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.sessionId === 'string'
    && typeof value.windowId === 'number'
    && typeof value.tabId === 'number'
    && (value.extensionChannel === 'dev' || value.extensionChannel === 'production')
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
};

const normalizeNativeError = (value: unknown): { message?: string; code?: string } => {
  if (isRecord(value)) {
    return {
      ...(typeof value.message === 'string' ? { message: value.message } : {}),
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
    };
  }
  return { message: typeof value === 'string' ? value : 'Chrome extension request failed.' };
};

export const __test = {
  isAllowedUrl,
};
