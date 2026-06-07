import { safeStorage } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSummary, CloudDeviceSummary, CloudDevicesState, LocalNetworkShareResult, LocalNetworkShareStatus, MobilePairingRequestSummary, RemoteNetworkShareResult, RemoteNetworkShareStatus } from '../shared/types';
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
  handleRemoteSessionRequest?: (request: RemoteSessionRequest) => Promise<RemoteNetworkShareResult>;
  handleAppAccessRequest?: (request: AppAccessRequest) => Promise<AppAccessResult>;
  handleAppControlRequest?: (request: AppControlRequest) => Promise<AppControlResult>;
  onAuthenticationInvalid?: (technicalCode: string) => Promise<void> | void;
  reconnectDelayMs?: number;
  socketMonitorIntervalMs?: number;
  socketStaleAfterMs?: number;
}

interface RemoteSessionRequest {
  requestId: string;
  appId: string;
  requestedByDeviceId?: number;
}

type AppAccessMode = 'local_network' | 'remote_tunnel';
type AppAccessResult = LocalNetworkShareResult | RemoteNetworkShareResult;

interface AppAccessRequest {
  requestId: string;
  appId: string;
  mode: AppAccessMode;
  requestedByDeviceId?: number;
}

type AppControlAction = 'stop_app';
type AppControlResultStatus = 'preparing' | 'done' | 'error';

interface AppControlResult {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
}

interface AppControlRequest {
  requestId: string;
  appId: string;
  action: AppControlAction;
  requestedByDeviceId?: number;
}

type RemoteSessionRequestReportStatus = 'preparing' | 'ready' | 'error';

const HEARTBEAT_INTERVAL_MS = 20_000;
const SOCKET_RECONNECT_DELAY_MS = 5_000;
const SOCKET_MONITOR_INTERVAL_MS = 15_000;
const SOCKET_STALE_AFTER_MS = 65_000;
const REMOTE_SESSION_REQUESTED = 'remote_session_requested';
const APP_ACCESS_REQUESTED = 'app_access_requested';
const APP_CONTROL_REQUESTED = 'app_control_requested';
const MOBILE_PAIRING_REQUESTED = 'mobile_pairing_requested';

const technicalCodeForError = (error: unknown, fallback: string): string =>
  error instanceof Error
    ? typeof (error as Error & { technicalCode?: unknown }).technicalCode === 'string'
      ? (error as Error & { technicalCode: string }).technicalCode
      : error.message
    : fallback;

const isAuthenticationInvalidError = (technicalCode: string): boolean => /_failed_401$/.test(technicalCode);

const statusTechnicalCode = (status: LocalNetworkShareStatus | RemoteNetworkShareStatus): string | undefined =>
  typeof (status as { technicalCode?: unknown }).technicalCode === 'string'
    ? (status as { technicalCode: string }).technicalCode
    : undefined;

export class CloudDeviceManager {
  private stored: StoredCloudDevice | null = null;
  private devices: CloudDeviceSummary[] = [];
  private pairingRequests: MobilePairingRequestSummary[] = [];
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
      await this.loadRegisteredDevice();
      if (generation !== this.generation) {
        return;
      }
      if (!this.stored?.cloudId) {
        this.lastMessage = undefined;
        this.lastTechnicalCode = undefined;
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
    this.pairingRequests = [];
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
        await this.loadRegisteredDevice();
        if (this.stored?.cloudId) {
          await this.refreshDevices();
          this.connectSocket(this.generation);
        }
      } catch (error) {
        await this.handleCloudError(error, 'No pudimos revisar los dispositivos conectados.', 'cloud_devices_state_failed');
      }
    }
    return this.state();
  }

  async registerCloudDevice(input: { name: string }): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const sessionKey = this.options.accountStorageKey();
      if (this.activeSessionKey && this.activeSessionKey !== sessionKey) {
        this.stop();
      }
      this.activeSessionKey = sessionKey;
      const device = await this.registerDevice(input.name);
      await this.refreshDevices();
      this.connectSocket(this.generation);
      this.lastMessage = `${device.name} esta registrado en Forger Cloud.`;
      this.lastTechnicalCode = undefined;
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos registrar este equipo en Forger Cloud.', 'cloud_device_register_failed');
      return { ...this.state(), success: false };
    }
  }

  async generatePairingCode(): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const sessionKey = this.options.accountStorageKey();
      if (this.activeSessionKey && this.activeSessionKey !== sessionKey) {
        this.stop();
      }
      this.activeSessionKey = sessionKey;
      await this.loadRegisteredDevice();
      const device = this.currentDevice;
      if (!device) {
        throw new Error('cloud_device_not_registered');
      }
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

  async acceptMobilePairingRequest(requestId: number): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const request = await this.options.backendClient()?.acceptMobilePairingRequest(requestId);
      if (!request) {
        throw new Error('backend_client_missing');
      }
      this.upsertPairingRequest(request);
      this.lastMessage = `Codigo listo para ${request.mobileDevice.name}.`;
      this.lastTechnicalCode = undefined;
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos aceptar la solicitud del dispositivo movil.', 'mobile_pairing_accept_failed');
      return { ...this.state(), success: false };
    }
  }

  async rejectMobilePairingRequest(requestId: number): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const request = await this.options.backendClient()?.rejectMobilePairingRequest(requestId);
      if (!request) {
        throw new Error('backend_client_missing');
      }
      this.upsertPairingRequest(request);
      this.lastMessage = `Solicitud de ${request.mobileDevice.name} rechazada.`;
      this.lastTechnicalCode = undefined;
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos rechazar la solicitud del dispositivo movil.', 'mobile_pairing_reject_failed');
      return { ...this.state(), success: false };
    }
  }

  private state(): CloudDevicesState {
    return {
      currentDevice: this.currentDevice,
      devices: this.devices,
      pairingRequests: this.pairingRequests,
      connected: this.connected,
      registrationRequired: Boolean(this.options.token()) && !this.currentDevice,
      pairingCode: this.pairingCode,
      pairingExpiresAt: this.pairingExpiresAt,
      userMessage: this.lastMessage,
      technicalCode: this.lastTechnicalCode,
    };
  }

  private async registerDevice(name: string): Promise<CloudDeviceSummary> {
    const client = this.options.backendClient();
    if (!client) {
      throw new Error('backend_client_missing');
    }
    const stored = await this.loadOrCreateStored();
    const device = await client.registerDevice({
      deviceUid: stored.deviceUid,
      deviceSecret: stored.deviceSecret,
      name: name.trim() || os.hostname() || 'Forger Desktop',
      platform: `${process.platform}_${process.arch}`,
      deviceKind: 'desktop',
      ...(await this.options.getCloudIdentity()),
    });
    this.currentDevice = device;
    this.stored = { ...stored, cloudId: device.id };
    await this.saveStored(this.stored);
    return device;
  }

  private async loadRegisteredDevice(): Promise<CloudDeviceSummary | undefined> {
    const stored = await this.loadStored();
    if (!stored?.cloudId) {
      this.currentDevice = undefined;
      return undefined;
    }
    this.stored = stored;
    this.currentDevice = this.currentDevice ?? {
      id: stored.cloudId,
      deviceUid: stored.deviceUid,
      name: os.hostname() || 'Forger Desktop',
      kind: 'desktop',
      paired: true,
      online: false,
      installedApps: [],
    };
    return this.currentDevice;
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
    if (typeof client.listMobilePairingRequests === 'function') {
      this.pairingRequests = await client.listMobilePairingRequests().catch(() => this.pairingRequests);
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
    const installedApps = this.options.getInstalledApps();
    const runtimeStatuses = Object.fromEntries(installedApps.map((app) => [
      app.id,
      {
        executionPhase: app.executionPhase,
        executionMode: app.executionMode,
        connectMode: app.connectMode,
      },
    ]));
    this.socket.send(JSON.stringify({
      command: 'message',
      identifier,
      data: JSON.stringify({
        action: 'heartbeat',
        installed_apps: installedApps,
        runtime_statuses: runtimeStatuses,
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
      if (parsed.message.type === APP_CONTROL_REQUESTED) {
        await this.handleAppControlRequested(parsed.message);
        return;
      }
      if (parsed.message.type === APP_ACCESS_REQUESTED) {
        await this.handleAppAccessRequested(parsed.message);
        return;
      }
      if (parsed.message.type === REMOTE_SESSION_REQUESTED) {
        await this.handleRemoteSessionRequested(parsed.message);
        return;
      }
      if (parsed.message.type === MOBILE_PAIRING_REQUESTED) {
        this.handleMobilePairingRequested(parsed.message);
        return;
      }
      await this.options.handleFriendshipEvent?.(parsed.message);
      return;
    }
  }

  private handleMobilePairingRequested(message: Record<string, unknown>): void {
    const request = this.normalizeMobilePairingRequest(message.request ?? message);
    if (!request) {
      this.lastTechnicalCode = 'mobile_pairing_request_invalid';
      return;
    }
    this.upsertPairingRequest(request);
    this.lastMessage = `${request.mobileDevice.name} quiere conectarse a este equipo.`;
    this.lastTechnicalCode = undefined;
  }

  private normalizeMobilePairingRequest(value: unknown): MobilePairingRequestSummary | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = Number(record.id);
    const mobileDeviceId = Number(record.mobile_device_id ?? record.mobileDeviceId);
    const desktopDeviceId = Number(record.desktop_device_id ?? record.desktopDeviceId);
    const mobileDevice = this.normalizeSocketDevice(record.mobile_device ?? record.mobileDevice);
    const desktopDevice = this.normalizeSocketDevice(record.desktop_device ?? record.desktopDevice);
    const status = typeof record.status === 'string' && ['pending', 'accepted', 'rejected', 'confirmed', 'expired'].includes(record.status)
      ? record.status as MobilePairingRequestSummary['status']
      : 'pending';
    const expiresAt = typeof record.expires_at === 'string' ? record.expires_at : typeof record.expiresAt === 'string' ? record.expiresAt : '';
    if (!Number.isFinite(id) || !Number.isFinite(mobileDeviceId) || !Number.isFinite(desktopDeviceId) || !mobileDevice || !desktopDevice || !expiresAt) {
      return null;
    }
    return {
      id,
      mobileDeviceId,
      desktopDeviceId,
      status,
      code: typeof record.code === 'string' ? record.code : undefined,
      codeExpiresAt: typeof record.code_expires_at === 'string' ? record.code_expires_at : typeof record.codeExpiresAt === 'string' ? record.codeExpiresAt : undefined,
      expiresAt,
      mobileDevice,
      desktopDevice,
    };
  }

  private normalizeSocketDevice(value: unknown): CloudDeviceSummary | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isFinite(id)) return null;
    return {
      id,
      deviceUid: typeof record.device_uid === 'string' ? record.device_uid : typeof record.deviceUid === 'string' ? record.deviceUid : '',
      name: typeof record.name === 'string' ? record.name : 'Forger Device',
      kind: record.kind === 'mobile' || record.device_kind === 'mobile' ? 'mobile' : 'desktop',
      platform: typeof record.platform === 'string' ? record.platform : undefined,
      publicKey: typeof record.public_key === 'string' ? record.public_key : undefined,
      keyFingerprint: typeof record.key_fingerprint === 'string' ? record.key_fingerprint : undefined,
      paired: Boolean(record.paired),
      online: Boolean(record.online),
      lastSeenAt: typeof record.last_seen_at === 'string' ? record.last_seen_at : undefined,
      installedApps: [],
    };
  }

  private upsertPairingRequest(request: MobilePairingRequestSummary): void {
    this.pairingRequests = [
      request,
      ...this.pairingRequests.filter((entry) => entry.id !== request.id),
    ];
  }

  private async handleRemoteSessionRequested(message: Record<string, unknown>): Promise<void> {
    const request = this.normalizeRemoteSessionRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'remote_session_request_invalid';
      const requestId = this.remoteRequestId(message);
      const appId = this.remoteRequestAppId(message);
      if (requestId) {
        await this.reportRemoteSessionRequest({
          requestId,
          appId: appId || 'unknown',
          status: 'error',
          technicalCode: 'remote_session_request_invalid',
        });
      }
      return;
    }
    if (!this.options.handleRemoteSessionRequest) {
      await this.reportRemoteSessionRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode: 'remote_session_handler_missing',
      });
      return;
    }
    await this.reportRemoteSessionRequest({
      requestId: request.requestId,
      appId: request.appId,
      status: 'preparing',
    });
    try {
      const result = await this.options.handleRemoteSessionRequest(request);
      const remoteStatus = result.status;
      await this.reportRemoteSessionRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: result.success ? 'ready' : 'error',
        remoteStatus,
        portalUrl: remoteStatus.portalUrl,
        frontendUrl: remoteStatus.frontendUrl,
        technicalCode: result.technicalCode ?? remoteStatus.technicalCode,
      });
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'remote_session_request_failed');
      await this.reportRemoteSessionRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode,
      });
    }
  }

  private async handleAppAccessRequested(message: Record<string, unknown>): Promise<void> {
    const request = this.normalizeAppAccessRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'app_access_request_invalid';
      const requestId = this.remoteRequestId(message);
      const appId = this.remoteRequestAppId(message);
      if (requestId) {
        await this.reportAppAccessRequest({
          requestId,
          appId: appId || 'unknown',
          status: 'error',
          technicalCode: 'app_access_request_invalid',
        });
      }
      return;
    }
    if (!this.options.handleAppAccessRequest) {
      await this.reportAppAccessRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode: 'app_access_handler_missing',
      });
      return;
    }
    await this.reportAppAccessRequest({
      requestId: request.requestId,
      appId: request.appId,
      status: 'preparing',
    });
    try {
      const result = await this.options.handleAppAccessRequest(request);
      await this.reportAppAccessRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: result.success ? 'ready' : 'error',
        accessStatus: result.status,
        technicalCode: result.technicalCode ?? statusTechnicalCode(result.status),
      });
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'app_access_request_failed');
      await this.reportAppAccessRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode,
      });
    }
  }

  private async handleAppControlRequested(message: Record<string, unknown>): Promise<void> {
    const request = this.normalizeAppControlRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'app_control_request_invalid';
      const requestId = this.remoteRequestId(message);
      const appId = this.remoteRequestAppId(message);
      if (requestId) {
        await this.reportAppControlRequest({
          requestId,
          appId: appId || 'unknown',
          status: 'error',
          technicalCode: 'app_control_request_invalid',
        });
      }
      return;
    }
    if (!this.options.handleAppControlRequest) {
      await this.reportAppControlRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode: 'app_control_handler_missing',
      });
      return;
    }
    await this.reportAppControlRequest({
      requestId: request.requestId,
      appId: request.appId,
      status: 'preparing',
    });
    try {
      const result = await this.options.handleAppControlRequest(request);
      await this.reportAppControlRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: result.success ? 'done' : 'error',
        technicalCode: result.technicalCode,
      });
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'app_control_request_failed');
      await this.reportAppControlRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode,
      });
    }
  }

  private normalizeRemoteSessionRequest(message: Record<string, unknown>): RemoteSessionRequest | null {
    const requestId = this.remoteRequestId(message);
    const appId = this.remoteRequestAppId(message);
    if (!requestId || !appId || !isSafeRemoteAppId(appId)) {
      return null;
    }
    const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
    return {
      requestId,
      appId,
      ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}),
    };
  }

  private normalizeAppAccessRequest(message: Record<string, unknown>): AppAccessRequest | null {
    const requestId = this.remoteRequestId(message);
    const appId = this.remoteRequestAppId(message);
    const mode = this.appAccessMode(message);
    if (!requestId || !appId || !isSafeRemoteAppId(appId) || !mode) {
      return null;
    }
    const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
    return {
      requestId,
      appId,
      mode,
      ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}),
    };
  }

  private normalizeAppControlRequest(message: Record<string, unknown>): AppControlRequest | null {
    const requestId = this.remoteRequestId(message);
    const appId = this.remoteRequestAppId(message);
    const action = this.appControlAction(message);
    if (!requestId || !appId || !isSafeRemoteAppId(appId) || !action) {
      return null;
    }
    const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
    return {
      requestId,
      appId,
      action,
      ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}),
    };
  }

  private appAccessMode(message: Record<string, unknown>): AppAccessMode | null {
    const value = message.mode;
    return value === 'local_network' || value === 'remote_tunnel' ? value : null;
  }

  private appControlAction(message: Record<string, unknown>): AppControlAction | null {
    const value = message.action;
    return value === 'stop_app' ? value : null;
  }

  private remoteRequestId(message: Record<string, unknown>): string {
    const value = message.request_id ?? message.requestId ?? message.remote_session_request_id ?? message.id;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return '';
  }

  private remoteRequestAppId(message: Record<string, unknown>): string {
    const value = message.app_id ?? message.appId;
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  private async reportRemoteSessionRequest(input: {
    requestId: string;
    appId: string;
    status: RemoteSessionRequestReportStatus;
    remoteStatus?: RemoteNetworkShareStatus;
    portalUrl?: string;
    frontendUrl?: string;
    technicalCode?: string;
  }): Promise<void> {
    try {
      await this.options.backendClient()?.reportRemoteSessionRequest(input);
    } catch {
      // Cloud request reporting is visible status only; it must not break local session preparation.
    }
  }

  private async reportAppAccessRequest(input: {
    requestId: string;
    appId: string;
    status: RemoteSessionRequestReportStatus;
    accessStatus?: LocalNetworkShareStatus | RemoteNetworkShareStatus;
    technicalCode?: string;
  }): Promise<void> {
    try {
      await this.options.backendClient()?.reportAppAccessRequest(input);
    } catch {
      // Cloud request reporting is visible status only; it must not break local app startup.
    }
  }

  private async reportAppControlRequest(input: {
    requestId: string;
    appId: string;
    status: AppControlResultStatus;
    technicalCode?: string;
  }): Promise<void> {
    try {
      await this.options.backendClient()?.reportAppControlRequest(input);
    } catch {
      // Cloud request reporting is visible status only; it must not break local app control.
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
    const existing = await this.loadStored();
    if (existing) {
      return existing;
    }
    this.stored = {
      deviceUid: randomUUID(),
      deviceSecret: randomBytes(32).toString('hex'),
    };
    await this.saveStored(this.stored);
    return this.stored;
  }

  private async loadStored(): Promise<StoredCloudDevice | null> {
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
      return null;
    }
    return null;
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

const isSafeRemoteAppId = (appId: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(appId) && !appId.includes('..') && !appId.startsWith('__forger_');
