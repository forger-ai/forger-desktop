export type RemoteActivityKind = 'app' | 'agent';
export type RemoteActivityTransport = 'remote_tunnel';
export type RemoteActivityState = 'preparing' | 'active' | 'error' | 'closed';

export interface RemoteActivityRequester {
  id: number;
  name: string;
  platform?: string;
}

export interface RemoteActivityItem {
  id: string;
  kind: RemoteActivityKind;
  transport: RemoteActivityTransport;
  targetId: string;
  targetName: string;
  state: RemoteActivityState;
  requesterMobileDevice?: RemoteActivityRequester;
  startedAt: string;
  updatedAt: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface RemoteActivitySnapshot {
  activities: RemoteActivityItem[];
  activeCount: number;
  preparingCount: number;
  errorCount: number;
  updatedAt: string;
}
