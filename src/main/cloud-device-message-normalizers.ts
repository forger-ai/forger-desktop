import type { CloudDeviceSummary, LocalNetworkShareResult, MobilePairingRequestSummary, RemoteNetworkShareResult } from '../shared/types';
import { isSafeRemoteAppId, isSafeRemoteSessionId } from './cloud-device-personal-agents';

export interface RemoteSessionRequest {
  requestId: string;
  appId: string;
  requestedByDeviceId?: number;
}

export type AppAccessMode = 'local_network' | 'remote_tunnel';
export type AppAccessResult = LocalNetworkShareResult | RemoteNetworkShareResult;

export interface AppAccessRequest {
  requestId: string;
  appId: string;
  mode: AppAccessMode;
  requestedByDeviceId?: number;
}

export interface AgentAccessRequest {
  requestId: string;
  agentId: string;
  agentName?: string;
  requestedByDeviceId?: number;
  requestedByDeviceName?: string;
}

export interface AgentAccessDisconnectRequest {
  requestId?: string;
  agentId?: string;
  sessionId?: string;
  requestedByDeviceId?: number;
}

export type AppControlAction = 'stop_app';

export interface AppControlResult {
  success: boolean;
  userMessage?: string;
  technicalCode?: string;
}

export interface AppControlRequest {
  requestId: string;
  appId: string;
  action: AppControlAction;
  requestedByDeviceId?: number;
}

export const normalizeMobilePairingRequest = (value: unknown): MobilePairingRequestSummary | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const mobileDeviceId = Number(record.mobile_device_id ?? record.mobileDeviceId);
  const desktopDeviceId = Number(record.desktop_device_id ?? record.desktopDeviceId);
  const mobileDevice = normalizeSocketDevice(record.mobile_device ?? record.mobileDevice);
  const desktopDevice = normalizeSocketDevice(record.desktop_device ?? record.desktopDevice);
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
};

export const normalizeSocketDevice = (value: unknown): CloudDeviceSummary | null => {
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
};

export const normalizeRemoteSessionRequest = (message: Record<string, unknown>): RemoteSessionRequest | null => {
  const requestId = remoteRequestId(message);
  const appId = remoteRequestAppId(message);
  if (!requestId || !appId || !isSafeRemoteAppId(appId)) {
    return null;
  }
  const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
  return { requestId, appId, ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}) };
};

export const normalizeAppAccessRequest = (message: Record<string, unknown>): AppAccessRequest | null => {
  const requestId = remoteRequestId(message);
  const appId = remoteRequestAppId(message);
  const mode = appAccessMode(message);
  if (!requestId || !appId || !isSafeRemoteAppId(appId) || !mode) {
    return null;
  }
  const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
  return { requestId, appId, mode, ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}) };
};

export const normalizeAgentAccessRequest = (message: Record<string, unknown>): AgentAccessRequest | null => {
  const requestId = remoteRequestId(message);
  const agentId = remoteRequestAgentId(message);
  if (!requestId || !agentId || !isSafeRemoteAppId(agentId)) {
    return null;
  }
  const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
  const requestedByDeviceName = typeof (message.requested_by_device_name ?? message.requestedByDeviceName) === 'string'
    ? String(message.requested_by_device_name ?? message.requestedByDeviceName).trim()
    : '';
  const agentName = typeof (message.agent_name ?? message.agentName) === 'string'
    ? String(message.agent_name ?? message.agentName).trim()
    : '';
  return {
    requestId,
    agentId,
    ...(agentName ? { agentName } : {}),
    ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}),
    ...(requestedByDeviceName ? { requestedByDeviceName } : {}),
  };
};

export const normalizeAgentAccessDisconnectRequest = (message: Record<string, unknown>): AgentAccessDisconnectRequest | null => {
  const requestId = remoteRequestId(message);
  const agentId = remoteRequestAgentId(message);
  const sessionId = remoteRequestSessionId(message);
  if (agentId && !isSafeRemoteAppId(agentId)) return null;
  if (sessionId && !isSafeRemoteSessionId(sessionId)) return null;
  const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
  return {
    ...(requestId ? { requestId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}),
  };
};

export const normalizeAppControlRequest = (message: Record<string, unknown>): AppControlRequest | null => {
  const requestId = remoteRequestId(message);
  const appId = remoteRequestAppId(message);
  const action = appControlAction(message);
  if (!requestId || !appId || !isSafeRemoteAppId(appId) || !action) {
    return null;
  }
  const requestedByDeviceId = Number(message.requested_by_device_id ?? message.requestedByDeviceId);
  return { requestId, appId, action, ...(Number.isFinite(requestedByDeviceId) ? { requestedByDeviceId } : {}) };
};

export const remoteRequestId = (message: Record<string, unknown>): string => {
  const value = message.request_id ?? message.requestId ?? message.remote_session_request_id ?? message.id;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

export const remoteRequestAppId = (message: Record<string, unknown>): string => {
  const value = message.app_id ?? message.appId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};

export const remoteRequestAgentId = (message: Record<string, unknown>): string => {
  const value = message.agent_id ?? message.agentId ?? message.personal_agent_id ?? message.personalAgentId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};

const remoteRequestSessionId = (message: Record<string, unknown>): string => {
  const value = message.session_id ?? message.sessionId ?? message.remote_session_id ?? message.remoteSessionId;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
};

const appAccessMode = (message: Record<string, unknown>): AppAccessMode | null => {
  const value = message.mode;
  return value === 'local_network' || value === 'remote_tunnel' ? value : null;
};

const appControlAction = (message: Record<string, unknown>): AppControlAction | null => {
  const value = message.action;
  return value === 'stop_app' ? value : null;
};
