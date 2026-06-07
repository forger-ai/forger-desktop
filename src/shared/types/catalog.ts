import type { AppToolDeclaration } from './tools';

export type AppStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error' | 'conflict';
export type AppExecutionPhase = 'stopped' | 'starting' | 'running' | 'error';
export type AppExecutionMode = 'forger' | 'local_network' | 'remote_tunnel';
export type AppConnectMode = Extract<AppExecutionMode, 'local_network' | 'remote_tunnel'>;
export type CatalogPublicationStatus = 'draft' | 'coming' | 'beta' | 'production';

export type AppCategory = 'finanzas' | 'hogar' | 'salud' | 'productividad' | 'developer_tools';

export interface AppSummary {
  id: string;
  category: AppCategory;
  status: AppStatus;
  name?: string;
  description?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  iconUrl?: string;
  beta?: boolean;
  changelog?: VersionChangelog;
  capabilities?: AppCapability[];
  userMessage?: string;
  catalogStatus?: CatalogPublicationStatus;
  privateLocal?: boolean;
  tools?: {
    required?: AppToolDeclaration[];
    optional?: AppToolDeclaration[];
  };
  localNetworkShareSupported?: boolean;
  remoteTunnelSupported?: boolean;
  localNetworkShare?: import('./runtime').LocalNetworkShareStatus;
  remoteNetworkShare?: import('./runtime').RemoteNetworkShareStatus;
  executionPhase?: AppExecutionPhase;
  executionMode?: AppExecutionMode | null;
  connectMode?: AppConnectMode | null;
}

export interface VersionChangelog {
  version: string;
  summary?: string;
  changes: string[];
}

export interface AppCapability {
  id: string;
  title?: string;
  description?: string;
}
