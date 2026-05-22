import { safeStorage } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSummary, CloudDeviceSummary, CloudDevicesState } from '../shared/types';
import type { ForgerBackendClient } from './forger-backend-client';

interface StoredCloudDevice {
  deviceUid: string;
  deviceSecret: string;
  cloudId?: number;
}

interface CloudDeviceManagerOptions {
  filePath: string;
  accountStorageKey: () => string | undefined;
  backendBaseUrl: string;
  backendClient: () => ForgerBackendClient | null;
  token: () => string | undefined;
  getCloudIdentity: () => Promise<{ publicKey: string; keyFingerprint: string }>;
  getInstalledApps: () => AppSummary[];
  handleFriendshipEvent?: (event: unknown) => Promise<void> | void;
  onAuthenticationInvalid?: (technicalCode: string) => Promise<void> | void;
  reconnectDelayMs?: number;
  socketMonitorIntervalMs?: number;
  socketStaleAfterMs?: number;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const SOCKET_RECONNECT_DELAY_MS = 5_000;
const SOCKET_MONITOR_INTERVAL_MS = 15_000;
const SOCKET_STALE_AFTER_MS = 65_000;

const technicalCodeForError = (error: unknown, fallback: string): string =>
  error instanceof Error
    ? typeof (error as Error & { technicalCode?: unknown }).technicalCode === 'string'
      ? (error as Error & { technicalCode: string }).technicalCode
      : error.message
    : fallback;

const isAuthenticationInvalidError = (technicalCode: string): boolean => /_failed_401$/.test(technicalCode);

export class CloudDeviceManager {
  private stored: StoredCloudDevice | null = null;
  private devices: CloudDeviceSummary[] = [];
  private currentDevice: CloudDeviceSummary | undefined;
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private socketMonitorTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private lastSocketActivityAt = 0;
  private pairingCode: string | undefined;
  private pairingExpiresAt: string | undefined;
  private lastMessage: string | undefined;
  private lastTechnicalCode: string | undefined;
  private storedPath: string | undefined;
  private activeSessionKey: string | undefined;
  private generation = 0;

  constructor(private readonly options: CloudDeviceManagerOptions) {}

  async start(): Promise<void> {
    const sessionKey = this.options.accountStorageKey();
    if (this.activeSessionKey && this.activeSessionKey !== sessionKey) {
      this.stop();
    }
    this.activeSessionKey = sessionKey;
    const generation = ++this.generation;
    if (!this.options.token()) {
      this.stop();
      return;
    }
    try {
      await this.ensureRegistered();
      if (generation !== this.generation) {
        return;
      }
      await this.refreshDevices();
      if (generation !== this.generation) {
        return;
      }
      this.connectSocket(generation);
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos conectar este equipo con Forger Cloud.', 'cloud_device_start_failed');
    }
  }

  stop(): void {
    this.generation += 1;
    this.connected = false;
    this.clearSocketTimers();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.stored = null;
    this.storedPath = undefined;
    this.devices = [];
    this.currentDevice = undefined;
    this.pairingCode = undefined;
    this.pairingExpiresAt = undefined;
    this.lastMessage = undefined;
    this.lastTechnicalCode = undefined;
    this.activeSessionKey = undefined;
  }

  async getState(): Promise<CloudDevicesState> {
    if (this.options.token()) {
      try {
        const sessionKey = this.options.accountStorageKey();
        if (this.activeSessionKey && this.activeSessionKey !== sessionKey) {
          this.stop();
        }
        this.activeSessionKey = sessionKey;
        await this.ensureRegistered();
        await this.refreshDevices();
        this.connectSocket(this.generation);
      } catch (error) {
        await this.handleCloudError(error, 'No pudimos revisar los dispositivos conectados.', 'cloud_devices_state_failed');
      }
    }
    return this.state();
  }

  async generatePairingCode(): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const sessionKey = this.options.accountStorageKey();
      if (this.activeSessionKey && this.activeSessionKey !== sessionKey) {
        this.stop();
      }
      this.activeSessionKey = sessionKey;
      const device = await this.ensureRegistered();
      const code = this.randomPairingCode();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await this.options.backendClient()?.createDevicePairingCode({
        deviceId: device.id,
        codeDigest: this.digestCode(code),
        expiresAt,
      });
      this.pairingCode = code;
      this.pairingExpiresAt = expiresAt;
      this.lastMessage = 'Codigo listo para emparejar este equipo.';
      this.lastTechnicalCode = undefined;
      this.connectSocket(this.generation);
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos generar el codigo de emparejamiento.', 'pairing_failed');
      return { ...this.state(), success: false };
    }
  }

  private state(): CloudDevicesState {
    return {
      currentDevice: this.currentDevice,
      devices: this.devices,
      connected: this.connected,
      pairingCode: this.pairingCode,
      pairingExpiresAt: this.pairingExpiresAt,
      userMessage: this.lastMessage,
      technicalCode: this.lastTechnicalCode,
    };
  }

  private async ensureRegistered(): Promise<CloudDeviceSummary> {
    const client = this.options.backendClient();
    if (!client) {
      throw new Error('backend_client_missing');
    }
    const stored = await this.loadOrCreateStored();
    const device = await client.registerDevice({
      deviceUid: stored.deviceUid,
      deviceSecret: stored.deviceSecret,
      name: os.hostname() || 'Forger Desktop',
      platform: `${process.platform}_${process.arch}`,
      ...(await this.options.getCloudIdentity()),
    });
    this.currentDevice = device;
    this.stored = { ...stored, cloudId: device.id };
    await this.saveStored(this.stored);
    return device;
  }

  private async handleCloudError(error: unknown, userMessage: string, fallbackCode: string): Promise<void> {
    const technicalCode = technicalCodeForError(error, fallbackCode);
    this.lastMessage = userMessage;
    this.lastTechnicalCode = technicalCode;
    const onAuthenticationInvalid = this.options.onAuthenticationInvalid;
    if (isAuthenticationInvalidError(technicalCode) && onAuthenticationInvalid) {
      await onAuthenticationInvalid(technicalCode);
    }
  }

  private async refreshDevices(): Promise<void> {
    const client = this.options.backendClient();
    if (!client) {
      return;
    }
    this.devices = await client.listDevices();
    if (this.stored?.cloudId) {
      this.currentDevice = this.devices.find((device) => device.id === this.stored?.cloudId) ?? this.currentDevice;
    }
  }

  private connectSocket(generation = this.generation): void {
    if (!this.stored) {
      return;
    }
    if (this.socket) {
      this.ensureSocketHealth(generation);
    }
    if (this.socket) {
      return;
    }
    const url = new URL('/cable', this.options.backendBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device_uid', this.stored.deviceUid);
    url.searchParams.set('device_secret', this.stored.deviceSecret);
    const token = this.options.token();
    if (token) url.searchParams.set('token', token);

    const socket = new WebSocket(url.toString());
    this.socket = socket;
    this.lastSocketActivityAt = Date.now();
    const deviceIdentifier = JSON.stringify({ channel: 'DeviceChannel' });
    const friendshipIdentifier = JSON.stringify({ channel: 'FriendshipChannel' });

    socket.addEventListener('open', () => {
      if (generation !== this.generation || this.socket !== socket) {
        socket.close();
        return;
      }
      this.recordSocketActivity();
      socket.send(JSON.stringify({ command: 'subscribe', identifier: deviceIdentifier }));
      socket.send(JSON.stringify({ command: 'subscribe', identifier: friendshipIdentifier }));
      this.startSocketMonitor(deviceIdentifier, generation);
    });

    socket.addEventListener('message', (event) => {
      if (generation !== this.generation || this.socket !== socket) {
        return;
      }
      void this.handleSocketMessage(deviceIdentifier, event.data.toString());
    });

    socket.addEventListener('error', () => {
      this.forceReconnectSocket(generation, 'cloud_socket_error');
    });

    socket.addEventListener('close', () => {
      if (generation !== this.generation || this.socket !== socket) {
        return;
      }
      this.connected = false;
      this.socket = null;
      this.clearSocketTimers();
      this.scheduleReconnect(generation);
    });
  }

  private sendHeartbeat(identifier: string): void {
    if (!this.socket) {
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.forceReconnectSocket(this.generation, 'cloud_socket_not_open');
      return;
    }
    this.socket.send(JSON.stringify({
      command: 'message',
      identifier,
      data: JSON.stringify({
        action: 'heartbeat',
        installed_apps: this.options.getInstalledApps(),
        runtime_statuses: {},
      }),
    }));
  }

  private async handleSocketMessage(identifier: string, raw: string): Promise<void> {
    let parsed: { type?: string; message?: Record<string, unknown> & { type?: string } };
    try {
      parsed = JSON.parse(raw) as { type?: string; message?: Record<string, unknown> & { type?: string } };
    } catch {
      this.lastTechnicalCode = 'cloud_socket_message_invalid';
      return;
    }
    this.recordSocketActivity();
    if (parsed.type === 'ping') {
      return;
    }
    if (parsed.type === 'confirm_subscription') {
      if (raw.includes('DeviceChannel')) {
        this.connected = true;
        this.sendHeartbeat(identifier);
        if (!this.heartbeatTimer) {
          this.heartbeatTimer = setInterval(() => this.sendHeartbeat(identifier), HEARTBEAT_INTERVAL_MS);
        }
      }
      return;
    }
    if (parsed.type === 'reject_subscription') {
      this.connected = false;
      this.socket?.close();
      return;
    }
    if (parsed.message) {
      await this.options.handleFriendshipEvent?.(parsed.message);
      return;
    }
  }

  private clearSocketTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socketMonitorTimer) {
      clearInterval(this.socketMonitorTimer);
      this.socketMonitorTimer = null;
    }
  }

  private ensureSocketHealth(generation: number): void {
    if (!this.socket) {
      return;
    }
    if (this.socket.readyState !== WebSocket.OPEN && this.socket.readyState !== WebSocket.CONNECTING) {
      this.forceReconnectSocket(generation, 'cloud_socket_not_open');
      return;
    }
    const staleAfterMs = this.options.socketStaleAfterMs ?? SOCKET_STALE_AFTER_MS;
    if (this.lastSocketActivityAt > 0 && Date.now() - this.lastSocketActivityAt > staleAfterMs) {
      this.forceReconnectSocket(generation, 'cloud_socket_stale');
    }
  }

  private forceReconnectSocket(generation: number, technicalCode: string): void {
    if (generation !== this.generation) {
      return;
    }
    this.lastTechnicalCode = technicalCode;
    this.connected = false;
    this.clearSocketTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.close();
    }
    this.scheduleReconnect(generation);
  }

  private recordSocketActivity(): void {
    this.lastSocketActivityAt = Date.now();
    this.lastTechnicalCode = undefined;
  }

  private scheduleReconnect(generation: number): void {
    if (!this.options.token()) {
      return;
    }
    setTimeout(() => {
      if (generation === this.generation) {
        this.connectSocket(generation);
      }
    }, this.options.reconnectDelayMs ?? SOCKET_RECONNECT_DELAY_MS);
  }

  private startSocketMonitor(identifier: string, generation: number): void {
    if (this.socketMonitorTimer) {
      return;
    }
    this.socketMonitorTimer = setInterval(() => {
      if (generation !== this.generation) {
        this.clearSocketTimers();
        return;
      }
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        this.forceReconnectSocket(generation, 'cloud_socket_not_open');
        return;
      }
      const staleAfterMs = this.options.socketStaleAfterMs ?? SOCKET_STALE_AFTER_MS;
      if (Date.now() - this.lastSocketActivityAt > staleAfterMs) {
        this.forceReconnectSocket(generation, 'cloud_socket_stale');
        return;
      }
      if (this.connected) {
        this.sendHeartbeat(identifier);
      }
    }, this.options.socketMonitorIntervalMs ?? SOCKET_MONITOR_INTERVAL_MS);
  }

  private async loadOrCreateStored(): Promise<StoredCloudDevice> {
    const filePath = this.currentFilePath();
    if (this.stored && this.storedPath === filePath) {
      return this.stored;
    }
    this.stored = null;
    this.storedPath = filePath;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredCloudDevice & { encrypted?: boolean };
      if (parsed.encrypted && safeStorage.isEncryptionAvailable()) {
        parsed.deviceSecret = safeStorage.decryptString(Buffer.from(parsed.deviceSecret, 'base64'));
      }
      if (parsed.deviceUid && parsed.deviceSecret) {
        this.stored = parsed;
        return parsed;
      }
    } catch {
      // Create below.
    }
    this.stored = {
      deviceUid: randomUUID(),
      deviceSecret: randomBytes(32).toString('hex'),
    };
    await this.saveStored(this.stored);
    return this.stored;
  }

  private currentFilePath(): string {
    const accountStorageKey = this.options.accountStorageKey()?.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!accountStorageKey) {
      return this.options.filePath;
    }
    const extension = path.extname(this.options.filePath);
    const basename = path.basename(this.options.filePath, extension);
    return path.join(path.dirname(this.options.filePath), `${basename}-${accountStorageKey}${extension}`);
  }

  private async saveStored(stored: StoredCloudDevice): Promise<void> {
    const filePath = this.storedPath ?? this.currentFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = safeStorage.isEncryptionAvailable()
      ? {
          ...stored,
          encrypted: true,
          deviceSecret: safeStorage.encryptString(stored.deviceSecret).toString('base64'),
        }
      : stored;
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private randomPairingCode(): string {
    let code = '';
    while (code.length < 8) {
      code += randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    }
    return code.slice(0, 8);
  }

  private digestCode(code: string): string {
    return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
  }
}
