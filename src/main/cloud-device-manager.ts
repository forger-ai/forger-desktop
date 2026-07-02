import os from 'node:os';
import type { AppSummary, CloudDeviceSummary, CloudDevicesState, LocalNetworkShareStatus, MobileDesktopAuthorizationSummary, MobilePairingRequestSummary, PersonalAgentHeartbeatSummary, RemoteActivityKind, RemoteActivityRequester, RemoteActivityState, RemoteAgentSessionResult, RemoteAgentSessionStatus, RemoteNetworkShareResult, RemoteNetworkShareStatus } from '../shared/types';
import type { ForgerBackendClient } from './forger-backend-client';
import { normalizeAgentAccessRequestIds, normalizePersonalAgentHeartbeat } from './cloud-device-personal-agents';
import { CloudDeviceStorage, type StoredCloudDevice, digestPairingCode, randomPairingCode } from './cloud-device-storage';
import {
  type AgentAccessDisconnectRequest,
  type AgentAccessRequest,
  type AppAccessRequest,
  type AppAccessResult,
  type AppControlRequest,
  type AppControlResult,
  normalizeAgentAccessDisconnectRequest,
  normalizeAgentAccessRequest,
  normalizeAppAccessRequest,
  normalizeAppControlRequest,
  normalizeMobilePairingRequest,
  normalizeRemoteSessionRequest,
  remoteRequestAgentId,
  remoteRequestAppId,
  remoteRequestId,
  type RemoteSessionRequest,
} from './cloud-device-message-normalizers';

interface CloudDeviceManagerOptions {
  filePath: string;
  accountStorageKey: () => string | undefined;
  backendBaseUrl: string;
  backendClient: () => ForgerBackendClient | null;
  token: () => string | undefined;
  getCloudIdentity: () => Promise<{ publicKey: string; keyFingerprint: string }>;
  getInstalledApps: () => AppSummary[];
  getPersonalAgentHeartbeat?: () => Promise<PersonalAgentHeartbeatSummary> | PersonalAgentHeartbeatSummary;
  handleFriendshipEvent?: (event: unknown) => Promise<void> | void;
  handleRemoteSessionRequest?: (request: RemoteSessionRequest) => Promise<RemoteNetworkShareResult>;
  handleAppAccessRequest?: (request: AppAccessRequest) => Promise<AppAccessResult>;
  handleAgentAccessRequest?: (request: AgentAccessRequest) => Promise<RemoteAgentSessionResult>;
  handleAgentAccessDisconnect?: (request: AgentAccessDisconnectRequest) => Promise<RemoteAgentSessionResult | undefined>;
  handleAppControlRequest?: (request: AppControlRequest) => Promise<AppControlResult>;
  onRemoteActivity?: (event: RemoteCloudActivityEvent) => void;
  appendInstallLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  onAuthenticationInvalid?: (technicalCode: string) => Promise<void> | void;
  reconnectDelayMs?: number;
  socketMonitorIntervalMs?: number;
  socketStaleAfterMs?: number;
}

interface RemoteCloudActivityEvent {
  kind: RemoteActivityKind;
  targetId: string;
  targetName?: string;
  state: RemoteActivityState;
  requestId?: string;
  requestedByDeviceId?: number;
  requesterMobileDevice?: RemoteActivityRequester;
  technicalCode?: string;
}

type AppControlResultStatus = 'preparing' | 'done' | 'error';

type RemoteSessionRequestReportStatus = 'preparing' | 'ready' | 'error' | 'closed';

const HEARTBEAT_INTERVAL_MS = 20_000;
const SOCKET_RECONNECT_DELAY_MS = 5_000;
const SOCKET_MONITOR_INTERVAL_MS = 15_000;
const SOCKET_STALE_AFTER_MS = 65_000;
const REMOTE_SESSION_REQUESTED = 'remote_session_requested';
const APP_ACCESS_REQUESTED = 'app_access_requested';
const AGENT_ACCESS_REQUESTED = 'agent_access_requested';
const PERSONAL_AGENT_ACCESS_REQUESTED = 'personal_agent_access_requested';
const DESKTOP_AGENT_ACCESS_REQUESTED = 'desktop_agent_access_requested';
const AGENT_ACCESS_DISCONNECT_REQUESTED = 'agent_access_disconnect_requested';
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

const cloudAgentStatus = (status: RemoteAgentSessionStatus): RemoteAgentSessionStatus => ({
  active: status.active,
  agentId: status.agentId,
  state: status.state,
  sessionId: status.sessionId,
  tunnelUrl: status.tunnelUrl,
  authorizationToken: status.authorizationToken,
  allowedPaths: status.allowedPaths,
  technicalCode: status.technicalCode,
});

export class CloudDeviceManager {
  private stored: StoredCloudDevice | null = null;
  private readonly storage: CloudDeviceStorage;
  private devices: CloudDeviceSummary[] = [];
  private pairingRequests: MobilePairingRequestSummary[] = [];
  private mobileDesktopAuthorizations: MobileDesktopAuthorizationSummary[] = [];
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
  private activeSessionKey: string | undefined;
  private generation = 0;

  constructor(private readonly options: CloudDeviceManagerOptions) {
    this.storage = new CloudDeviceStorage({
      filePath: options.filePath,
      accountStorageKey: options.accountStorageKey,
    });
  }

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
        await this.registerDevice('');
        if (generation !== this.generation) {
          return;
        }
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
    this.storage.reset();
    this.devices = [];
    this.pairingRequests = [];
    this.mobileDesktopAuthorizations = [];
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
        if (!this.stored?.cloudId) {
          await this.registerDevice('');
        }
        await this.refreshDevices();
        this.connectSocket(this.generation);
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

  async updateCloudDeviceName(input: { name: string }): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const sessionKey = this.options.accountStorageKey();
      if (this.activeSessionKey && this.activeSessionKey !== sessionKey) {
        this.stop();
      }
      this.activeSessionKey = sessionKey;
      await this.loadRegisteredDevice();
      const device = this.currentDevice;
      const client = this.options.backendClient();
      if (!device || !client) {
        throw new Error('cloud_device_not_registered');
      }
      const updatedDevice = await client.updateDeviceName({
        deviceId: device.id,
        name: input.name,
      });
      this.currentDevice = updatedDevice;
      this.devices = this.devices.map((entry) => (entry.id === updatedDevice.id ? updatedDevice : entry));
      await this.refreshDevices();
      this.lastMessage = `${updatedDevice.name} esta actualizado.`;
      this.lastTechnicalCode = undefined;
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos actualizar el nombre de este equipo.', 'cloud_device_name_update_failed');
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
      const code = randomPairingCode();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await this.options.backendClient()?.createDevicePairingCode({
        deviceId: device.id,
        codeDigest: digestPairingCode(code),
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

  async deleteMobilePairingRequest(requestId: number): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const client = this.options.backendClient();
      if (!client) {
        throw new Error('backend_client_missing');
      }
      await client.deleteMobilePairingRequest(requestId);
      this.pairingRequests = this.pairingRequests.filter((entry) => entry.id !== requestId);
      await this.refreshDevices();
      this.lastMessage = 'Solicitud eliminada.';
      this.lastTechnicalCode = undefined;
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos eliminar la solicitud.', 'mobile_pairing_delete_failed');
      return { ...this.state(), success: false };
    }
  }

  async unlinkMobileDeviceFromDesktop(authorizationId: number): Promise<CloudDevicesState & { success: boolean }> {
    try {
      const client = this.options.backendClient();
      if (!client) {
        throw new Error('backend_client_missing');
      }
      await client.revokeMobileDesktopAuthorization(authorizationId);
      await this.refreshDevices();
      this.lastMessage = 'Dispositivo movil desvinculado de este Desktop.';
      this.lastTechnicalCode = undefined;
      return { ...this.state(), success: true };
    } catch (error) {
      await this.handleCloudError(error, 'No pudimos desvincular el dispositivo movil.', 'mobile_desktop_unlink_failed');
      return { ...this.state(), success: false };
    }
  }

  private state(): CloudDevicesState {
    return {
      currentDevice: this.currentDevice,
      devices: this.devices,
      pairingRequests: this.pairingRequests,
      mobileDesktopAuthorizations: this.mobileDesktopAuthorizations,
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
    const stored = await this.storage.loadOrCreate();
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
    await this.storage.save(this.stored);
    return device;
  }

  private async loadRegisteredDevice(): Promise<CloudDeviceSummary | undefined> {
    const stored = await this.storage.load();
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
    if (typeof client.listMobileDesktopAuthorizations === 'function') {
      this.mobileDesktopAuthorizations = await client.listMobileDesktopAuthorizations().catch(() => this.mobileDesktopAuthorizations);
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

  private async sendHeartbeat(identifier: string): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
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
    const personalAgents = await this.personalAgentHeartbeat();
    const activeAgentAccessRequestIds = normalizeAgentAccessRequestIds(personalAgents.activeSessionRequestIds);
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({
      command: 'message',
      identifier,
      data: JSON.stringify({
        action: 'heartbeat',
        installed_apps: installedApps,
        runtime_statuses: runtimeStatuses,
        agent_ids: personalAgents.ids,
        agent_count: personalAgents.count,
        agent_access_supported: personalAgents.supported,
        personal_agents: personalAgents,
        active_agent_access_request_ids: activeAgentAccessRequestIds,
        agent_session_reconciliation: true,
        personal_agent_sessions: {
          active_request_ids: activeAgentAccessRequestIds,
        },
        personal_agents_supported: personalAgents.supported,
        personal_agent_count: personalAgents.count,
        personal_agent_ids: personalAgents.ids,
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
        void this.sendHeartbeat(identifier);
        if (!this.heartbeatTimer) {
          this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(identifier), HEARTBEAT_INTERVAL_MS);
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
      if (
        parsed.message.type === AGENT_ACCESS_DISCONNECT_REQUESTED ||
        (
          parsed.message.action === 'disconnect' &&
          (
            parsed.message.type === AGENT_ACCESS_REQUESTED ||
            parsed.message.type === PERSONAL_AGENT_ACCESS_REQUESTED ||
            parsed.message.type === DESKTOP_AGENT_ACCESS_REQUESTED
          )
        )
      ) {
        await this.handleAgentAccessDisconnectRequested(parsed.message);
        return;
      }
      if (
        parsed.message.type === AGENT_ACCESS_REQUESTED ||
        parsed.message.type === PERSONAL_AGENT_ACCESS_REQUESTED ||
        parsed.message.type === DESKTOP_AGENT_ACCESS_REQUESTED
      ) {
        await this.handleAgentAccessRequested(parsed.message);
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
    const request = normalizeMobilePairingRequest(message.request ?? message);
    if (!request) {
      this.lastTechnicalCode = 'mobile_pairing_request_invalid';
      return;
    }
    this.upsertPairingRequest(request);
    this.lastMessage = `${request.mobileDevice.name} quiere conectarse a este equipo.`;
    this.lastTechnicalCode = undefined;
  }

  private upsertPairingRequest(request: MobilePairingRequestSummary): void {
    this.pairingRequests = [
      request,
      ...this.pairingRequests.filter((entry) => entry.id !== request.id),
    ];
  }

  private async handleRemoteSessionRequested(message: Record<string, unknown>): Promise<void> {
    const request = normalizeRemoteSessionRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'remote_session_request_invalid';
      const requestId = remoteRequestId(message);
      const appId = remoteRequestAppId(message);
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
    this.recordRemoteActivity({
      kind: 'app',
      targetId: request.appId,
      requestId: request.requestId,
      state: 'preparing',
      requestedByDeviceId: request.requestedByDeviceId,
    });
    try {
      const result = await this.options.handleRemoteSessionRequest(request);
      const remoteStatus = result.status;
      this.recordRemoteActivity({
        kind: 'app',
        targetId: request.appId,
        requestId: request.requestId,
        state: result.success ? 'active' : 'error',
        requestedByDeviceId: request.requestedByDeviceId,
        technicalCode: result.technicalCode ?? remoteStatus.technicalCode,
      });
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
      this.recordRemoteActivity({
        kind: 'app',
        targetId: request.appId,
        requestId: request.requestId,
        state: 'error',
        requestedByDeviceId: request.requestedByDeviceId,
        technicalCode,
      });
      await this.reportRemoteSessionRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode,
      });
    }
  }

  private async handleAppAccessRequested(message: Record<string, unknown>): Promise<void> {
    const request = normalizeAppAccessRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'app_access_request_invalid';
      const requestId = remoteRequestId(message);
      const appId = remoteRequestAppId(message);
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
    if (request.mode === 'remote_tunnel') {
      this.recordRemoteActivity({
        kind: 'app',
        targetId: request.appId,
        requestId: request.requestId,
        state: 'preparing',
        requestedByDeviceId: request.requestedByDeviceId,
      });
    }
    try {
      const result = await this.options.handleAppAccessRequest(request);
      if (request.mode === 'remote_tunnel') {
        this.recordRemoteActivity({
          kind: 'app',
          targetId: request.appId,
          requestId: request.requestId,
          state: result.success ? 'active' : 'error',
          requestedByDeviceId: request.requestedByDeviceId,
          technicalCode: result.technicalCode ?? statusTechnicalCode(result.status),
        });
      }
      await this.reportAppAccessRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: result.success ? 'ready' : 'error',
        accessStatus: result.status,
        technicalCode: result.technicalCode ?? statusTechnicalCode(result.status),
      });
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'app_access_request_failed');
      if (request.mode === 'remote_tunnel') {
        this.recordRemoteActivity({
          kind: 'app',
          targetId: request.appId,
          requestId: request.requestId,
          state: 'error',
          requestedByDeviceId: request.requestedByDeviceId,
          technicalCode,
        });
      }
      await this.reportAppAccessRequest({
        requestId: request.requestId,
        appId: request.appId,
        status: 'error',
        technicalCode,
      });
    }
  }

  private async handleAgentAccessRequested(message: Record<string, unknown>): Promise<void> {
    const request = normalizeAgentAccessRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'agent_access_request_invalid';
      const requestId = remoteRequestId(message);
      const agentId = remoteRequestAgentId(message);
      if (requestId) {
        await this.reportAgentAccessRequest({
          requestId,
          agentId: agentId || 'unknown',
          status: 'error',
          technicalCode: 'agent_access_request_invalid',
        });
      }
      return;
    }
    await this.logAgentAccess('agent_access:cloud_request_received', {
      requestId: request.requestId,
      agentId: request.agentId,
      requestedByDeviceId: request.requestedByDeviceId,
      requestedByDeviceName: request.requestedByDeviceName,
      hasAgentName: Boolean(request.agentName),
    });
    if (!this.options.handleAgentAccessRequest) {
      await this.reportAgentAccessRequest({
        requestId: request.requestId,
        agentId: request.agentId,
        status: 'error',
        technicalCode: 'agent_access_handler_missing',
      });
      return;
    }
    await this.reportAgentAccessRequest({
      requestId: request.requestId,
      agentId: request.agentId,
      status: 'preparing',
    });
    this.recordRemoteActivity({
      kind: 'agent',
      targetId: request.agentId,
      targetName: request.agentName,
      requestId: request.requestId,
      state: 'preparing',
      requestedByDeviceId: request.requestedByDeviceId,
    });
    try {
      await this.logAgentAccess('agent_access:tunnel_opening', {
        requestId: request.requestId,
        agentId: request.agentId,
      });
      const result = await this.options.handleAgentAccessRequest(request);
      await this.logAgentAccess('agent_access:tunnel_result', {
        requestId: request.requestId,
        agentId: request.agentId,
        success: result.success,
        state: result.status.state,
        hasSessionId: Boolean(result.status.sessionId),
        hasTunnelUrl: Boolean(result.status.tunnelUrl),
        hasAuthorizationToken: Boolean(result.status.authorizationToken),
        technicalCode: result.technicalCode ?? result.status.technicalCode,
      });
      this.recordRemoteActivity({
        kind: 'agent',
        targetId: request.agentId,
        targetName: request.agentName,
        requestId: request.requestId,
        state: result.success ? 'active' : 'error',
        requestedByDeviceId: request.requestedByDeviceId,
        technicalCode: result.technicalCode ?? result.status.technicalCode,
      });
      await this.reportAgentAccessRequest({
        requestId: request.requestId,
        agentId: request.agentId,
        status: result.success ? 'ready' : 'error',
        agentStatus: cloudAgentStatus(result.status),
        technicalCode: result.technicalCode ?? result.status.technicalCode,
      });
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'agent_access_request_failed');
      await this.logAgentAccess('agent_access:tunnel_error', {
        requestId: request.requestId,
        agentId: request.agentId,
        technicalCode,
      });
      this.recordRemoteActivity({
        kind: 'agent',
        targetId: request.agentId,
        targetName: request.agentName,
        requestId: request.requestId,
        state: 'error',
        requestedByDeviceId: request.requestedByDeviceId,
        technicalCode,
      });
      await this.reportAgentAccessRequest({
        requestId: request.requestId,
        agentId: request.agentId,
        status: 'error',
        technicalCode,
      });
    }
  }

  private async handleAgentAccessDisconnectRequested(message: Record<string, unknown>): Promise<void> {
    const request = normalizeAgentAccessDisconnectRequest(message);
    if (!request || (!request.agentId && !request.sessionId)) {
      this.lastTechnicalCode = 'agent_access_disconnect_request_invalid';
      const requestId = remoteRequestId(message);
      const agentId = remoteRequestAgentId(message);
      if (requestId) {
        await this.reportAgentAccessRequest({
          requestId,
          agentId: agentId || 'unknown',
          status: 'error',
          technicalCode: 'agent_access_disconnect_request_invalid',
        });
      }
      return;
    }
    if (!this.options.handleAgentAccessDisconnect) {
      if (request.requestId) {
        await this.reportAgentAccessRequest({
          requestId: request.requestId,
          agentId: request.agentId ?? 'unknown',
          status: 'error',
          technicalCode: 'agent_access_disconnect_handler_missing',
        });
      }
      return;
    }
    try {
      const result = await this.options.handleAgentAccessDisconnect(request);
      this.recordRemoteActivity({
        kind: 'agent',
        targetId: result?.status.agentId ?? request.agentId ?? 'unknown',
        requestId: request.requestId,
        state: result?.success === false ? 'error' : 'closed',
        requestedByDeviceId: request.requestedByDeviceId,
        technicalCode: result?.technicalCode ?? result?.status.technicalCode,
      });
      if (request.requestId) {
        await this.reportAgentAccessRequest({
          requestId: request.requestId,
          agentId: result?.status.agentId ?? request.agentId ?? 'unknown',
          status: result?.success === false ? 'error' : 'closed',
          agentStatus: result?.status ? cloudAgentStatus(result.status) : undefined,
          technicalCode: result?.technicalCode ?? result?.status.technicalCode,
        });
      }
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'agent_access_disconnect_request_failed');
      this.recordRemoteActivity({
        kind: 'agent',
        targetId: request.agentId ?? 'unknown',
        requestId: request.requestId,
        state: 'error',
        requestedByDeviceId: request.requestedByDeviceId,
        technicalCode,
      });
      if (request.requestId) {
        await this.reportAgentAccessRequest({
          requestId: request.requestId,
          agentId: request.agentId ?? 'unknown',
          status: 'error',
          technicalCode,
        });
      }
    }
  }

  private async handleAppControlRequested(message: Record<string, unknown>): Promise<void> {
    const request = normalizeAppControlRequest(message);
    if (!request) {
      this.lastTechnicalCode = 'app_control_request_invalid';
      const requestId = remoteRequestId(message);
      const appId = remoteRequestAppId(message);
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

  private async reportAgentAccessRequest(input: {
    requestId: string;
    agentId: string;
    status: RemoteSessionRequestReportStatus;
    agentStatus?: RemoteAgentSessionStatus;
    technicalCode?: string;
  }): Promise<void> {
    await this.logAgentAccess('agent_access:cloud_report_start', {
      requestId: input.requestId,
      agentId: input.agentId,
      status: input.status,
      hasAgentStatus: Boolean(input.agentStatus),
      hasSessionId: Boolean(input.agentStatus?.sessionId),
      hasTunnelUrl: Boolean(input.agentStatus?.tunnelUrl),
      hasAuthorizationToken: Boolean(input.agentStatus?.authorizationToken),
      technicalCode: input.technicalCode,
    });
    try {
      await this.options.backendClient()?.reportAgentAccessRequest(input);
      await this.logAgentAccess('agent_access:cloud_report_success', {
        requestId: input.requestId,
        agentId: input.agentId,
        status: input.status,
      });
    } catch (error) {
      const technicalCode = technicalCodeForError(error, 'agent_access_request_report_failed');
      this.lastTechnicalCode = technicalCode;
      await this.logAgentAccess('agent_access:cloud_report_failed', {
        requestId: input.requestId,
        agentId: input.agentId,
        status: input.status,
        technicalCode,
      });
      // Cloud request reporting is visible status only; it must not break local agent preparation.
    }
  }

  private async logAgentAccess(event: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.options.appendInstallLog) {
      return;
    }
    try {
      await this.options.appendInstallLog(event, payload);
    } catch {
      // Diagnostics should never affect device-channel handling.
    }
  }

  private async personalAgentHeartbeat(): Promise<PersonalAgentHeartbeatSummary> {
    if (!this.options.getPersonalAgentHeartbeat) {
      return { supported: false, count: 0, ids: [], agents: [] };
    }
    try {
      const summary = await this.options.getPersonalAgentHeartbeat();
      return normalizePersonalAgentHeartbeat(summary);
    } catch {
      return { supported: false, count: 0, ids: [], agents: [] };
    }
  }

  private recordRemoteActivity(event: Omit<RemoteCloudActivityEvent, 'requesterMobileDevice'>): void {
    this.options.onRemoteActivity?.({
      ...event,
      requesterMobileDevice: this.mobileRequesterFor(event.requestedByDeviceId),
    });
  }

  private mobileRequesterFor(deviceId: number | undefined): RemoteActivityRequester | undefined {
    if (!Number.isFinite(deviceId)) {
      return undefined;
    }
    const device = this.devices.find((entry) => entry.id === deviceId && entry.kind === 'mobile');
    if (!device) {
      return undefined;
    }
    return {
      id: device.id,
      name: device.name || 'Mobile device',
      ...(device.platform ? { platform: device.platform } : {}),
    };
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
        void this.sendHeartbeat(identifier);
      }
    }, this.options.socketMonitorIntervalMs ?? SOCKET_MONITOR_INTERVAL_MS);
  }

}
