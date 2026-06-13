import type { BrowserWindow } from 'electron';

import type {
  CloudDeviceSummary,
  RemoteActivityItem,
  RemoteActivityRequester,
  RemoteActivitySnapshot,
  RemoteAgentSessionStatus,
  RemoteNetworkShareStatus,
} from '../shared/types';
import { IPC_CHANNELS } from '../shared/ipc';

type RemoteActivityUpsert = Pick<RemoteActivityItem, 'id' | 'kind' | 'targetId' | 'targetName' | 'state'> & {
  requesterMobileDevice?: RemoteActivityRequester;
  lastError?: string;
};

interface RemoteActivityStoreOptions {
  getMainWindow: () => BrowserWindow | null;
  now?: () => Date;
}

export class RemoteActivityStore {
  private readonly activities = new Map<string, RemoteActivityItem>();

  public constructor(private readonly options: RemoteActivityStoreOptions) {}

  public snapshot(): RemoteActivitySnapshot {
    const activities = Array.from(this.activities.values())
      .filter((activity) => activity.state !== 'closed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      activities,
      activeCount: activities.filter((activity) => activity.state === 'active').length,
      preparingCount: activities.filter((activity) => activity.state === 'preparing').length,
      errorCount: activities.filter((activity) => activity.state === 'error').length,
      updatedAt: this.isoNow(),
    };
  }

  public recordRequest(input: RemoteActivityUpsert): RemoteActivitySnapshot {
    return this.upsert(input);
  }

  public recordAppStatus(input: {
    id?: string;
    appId: string;
    appName: string;
    status: RemoteNetworkShareStatus;
    requesterMobileDevice?: RemoteActivityRequester;
    lastError?: string;
  }): RemoteActivitySnapshot {
    return this.upsert({
      id: input.id ?? `app:${input.appId}`,
      kind: 'app',
      targetId: input.appId,
      targetName: input.appName,
      state: appActivityState(input.status),
      ...(input.requesterMobileDevice ? { requesterMobileDevice: input.requesterMobileDevice } : {}),
      lastError: input.lastError ?? input.status.technicalCode,
    });
  }

  public recordAgentStatus(input: {
    id?: string;
    agentId: string;
    agentName: string;
    status: RemoteAgentSessionStatus;
    requesterMobileDevice?: RemoteActivityRequester;
    lastError?: string;
  }): RemoteActivitySnapshot {
    return this.upsert({
      id: input.id ?? `agent:${input.agentId}`,
      kind: 'agent',
      targetId: input.agentId,
      targetName: input.agentName,
      state: agentActivityState(input.status),
      ...(input.requesterMobileDevice ? { requesterMobileDevice: input.requesterMobileDevice } : {}),
      lastError: input.lastError ?? input.status.technicalCode,
    });
  }

  public clear(id: string): RemoteActivitySnapshot {
    this.activities.delete(id);
    return this.emit();
  }

  public requesterFromDeviceId(deviceId: number | undefined, devices: CloudDeviceSummary[]): RemoteActivityRequester | undefined {
    if (!Number.isFinite(deviceId)) {
      return undefined;
    }
    const device = devices.find((entry) => entry.id === deviceId && entry.kind === 'mobile');
    if (!device) {
      return undefined;
    }
    return {
      id: device.id,
      name: safeDisplayText(device.name, 'Mobile device'),
      ...(device.platform ? { platform: safeDisplayText(device.platform, 'mobile') } : {}),
    };
  }

  private upsert(input: RemoteActivityUpsert): RemoteActivitySnapshot {
    const previous = this.activities.get(input.id);
    const now = this.isoNow();
    const lastError = sanitizeLastError(input.lastError);
    const item: RemoteActivityItem = {
      id: input.id,
      kind: input.kind,
      transport: 'remote_tunnel',
      targetId: input.targetId,
      targetName: safeDisplayText(input.targetName, input.targetId),
      state: input.state,
      ...(input.requesterMobileDevice ?? previous?.requesterMobileDevice ? { requesterMobileDevice: input.requesterMobileDevice ?? previous?.requesterMobileDevice } : {}),
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      ...(lastError || previous?.lastError ? { lastError: lastError ?? previous?.lastError } : {}),
      ...(lastError ? { lastErrorAt: now } : previous?.lastErrorAt ? { lastErrorAt: previous.lastErrorAt } : {}),
    };
    this.activities.set(input.id, item);
    if (item.state === 'closed') {
      this.activities.delete(input.id);
    }
    return this.emit();
  }

  private emit(): RemoteActivitySnapshot {
    const snapshot = this.snapshot();
    const window = this.options.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.remoteActivityChanged, snapshot);
    }
    return snapshot;
  }

  private isoNow(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

const appActivityState = (status: RemoteNetworkShareStatus): RemoteActivityItem['state'] => {
  if (status.state === 'preparing') return 'preparing';
  if (status.state === 'error') return 'error';
  if (status.state === 'closed' || status.state === 'inactive' || status.active === false) return 'closed';
  return 'active';
};

const agentActivityState = (status: RemoteAgentSessionStatus): RemoteActivityItem['state'] => {
  if (status.state === 'preparing') return 'preparing';
  if (status.state === 'error') return 'error';
  if (status.state === 'closed' || status.state === 'inactive' || status.active === false) return 'closed';
  return 'active';
};

const safeDisplayText = (value: string, fallback: string): string => {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, 120) || fallback;
};

const sanitizeLastError = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const text = value
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]')
    .trim();
  return text.slice(0, 160) || undefined;
};
