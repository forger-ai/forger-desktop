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
  backendBaseUrl: string;
  backendClient: () => ForgerBackendClient | null;
  token: () => string | undefined;
  getCloudIdentity: () => Promise<{ publicKey: string; keyFingerprint: string }>;
  getInstalledApps: () => AppSummary[];
  handleRelayRequest: (request: CloudRelayRequest) => Promise<CloudRelayResponse>;
  handleFriendshipEvent?: (event: unknown) => Promise<void> | void;
  onAuthenticationInvalid?: (technicalCode: string) => Promise<void> | void;
}

export interface CloudRelayRequest {
  request_id: string;
  app_id: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: number[];
}

export interface CloudRelayResponse {
  request_id: string;
  status: number;
  headers: Record<string, string>;
  body: number[];
}

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
  private connected = false;
  private pairingCode: string | undefined;
  private pairingExpiresAt: string | undefined;
  private lastMessage: string | undefined;
  private lastTechnicalCode: string | undefined;

  constructor(private readonly options: CloudDeviceManagerOptions) {}

  async start(): Promise<void> {
    if (!this.options.token()) {
      this.stop();
      return;
    }
    try {
      await this.ensureRegistered();
      await this.refreshDevices();
      this.connectSocket();
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos conectar este equipo con Forger Cloud.', 'cloud_device_start_failed');
    }
  }

  stop(): void {
    this.connected = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  async getState(): Promise<CloudDevicesState> {
    if (this.options.token()) {
      try {
        await this.ensureRegistered();
        await this.refreshDevices();
        this.connectSocket();
      } catch (error) {
        await this.handleCloudError(error, 'No pudimos revisar los dispositivos conectados.', 'cloud_devices_state_failed');
      }
    }
    return this.state();
  }

  async generatePairingCode(): Promise<CloudDevicesState & { success: boolean }> {
    try {
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
      this.connectSocket();
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
    if (isAuthenticationInvalidError(technicalCode)) {
      await this.options.onAuthenticationInvalid?.(technicalCode);
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

  private connectSocket(): void {
    if (!this.stored || this.socket) {
      return;
    }
    const url = new URL('/cable', this.options.backendBaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('device_uid', this.stored.deviceUid);
    url.searchParams.set('device_secret', this.stored.deviceSecret);

    const socket = new WebSocket(url.toString());
    this.socket = socket;
    const deviceIdentifier = JSON.stringify({ channel: 'DeviceChannel' });
    const friendshipIdentifier = JSON.stringify({ channel: 'FriendshipChannel' });

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ command: 'subscribe', identifier: deviceIdentifier }));
      socket.send(JSON.stringify({ command: 'subscribe', identifier: friendshipIdentifier }));
    });

    socket.addEventListener('message', (event) => {
      void this.handleSocketMessage(deviceIdentifier, event.data.toString());
    });

    socket.addEventListener('close', () => {
      this.connected = false;
      this.socket = null;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.options.token()) {
        setTimeout(() => this.connectSocket(), 5000);
      }
    });
  }

  private sendHeartbeat(identifier: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
    const parsed = JSON.parse(raw) as { type?: string; message?: CloudRelayRequest & { type?: string } };
    if (parsed.type === 'ping') {
      return;
    }
    if (parsed.type === 'confirm_subscription') {
      if (raw.includes('DeviceChannel')) {
        this.connected = true;
        this.sendHeartbeat(identifier);
        if (!this.heartbeatTimer) {
          this.heartbeatTimer = setInterval(() => this.sendHeartbeat(identifier), 20_000);
        }
      }
      return;
    }
    if (parsed.type === 'reject_subscription') {
      this.connected = false;
      this.socket?.close();
      return;
    }
    if (parsed.message?.type !== 'relay_request') {
      if (parsed.message) {
        await this.options.handleFriendshipEvent?.(parsed.message);
      }
      return;
    }
    const response = await this.options.handleRelayRequest(parsed.message);
    this.socket?.send(JSON.stringify({
      command: 'message',
      identifier,
      data: JSON.stringify({
        action: 'relay_response',
        ...response,
      }),
    }));
  }

  private async loadOrCreateStored(): Promise<StoredCloudDevice> {
    if (this.stored) {
      return this.stored;
    }
    try {
      const raw = await fs.readFile(this.options.filePath, 'utf8');
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

  private async saveStored(stored: StoredCloudDevice): Promise<void> {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    const payload = safeStorage.isEncryptionAvailable()
      ? {
          ...stored,
          encrypted: true,
          deviceSecret: safeStorage.encryptString(stored.deviceSecret).toString('base64'),
        }
      : stored;
    await fs.writeFile(this.options.filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  private randomPairingCode(): string {
    return randomBytes(5).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase();
  }

  private digestCode(code: string): string {
    return createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
  }
}
