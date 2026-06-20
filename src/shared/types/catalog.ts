import type { AppToolDeclaration } from './tools';

export type AppStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error' | 'conflict';
export type AppExecutionPhase = 'stopped' | 'starting' | 'running' | 'error';
export type AppExecutionMode = 'forger' | 'local_network' | 'remote_tunnel';
export type AppConnectMode = Extract<AppExecutionMode, 'local_network' | 'remote_tunnel'>;
export type AppLastErrorOperation = 'install' | 'open' | 'runtime' | 'update';
export type CatalogPublicationStatus = 'draft' | 'coming' | 'beta' | 'production';

export const APP_CATEGORIES = [
  'productivity',
  'finance',
  'home',
  'health',
  'learning',
  'utilities',
  'lifestyle',
  'developer_tools',
] as const;

export type AppCategory = typeof APP_CATEGORIES[number];

export interface AppSummary {
  id: string;
  category: AppCategory;
  status: AppStatus;
  name?: string;
  shortDescription?: string;
  description?: string;
  longDescription?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  iconUrl?: string;
  beta?: boolean;
  changelog?: VersionChangelog;
  capabilities?: AppCapability[];
  userMessage?: string;
  lastErrorOperation?: AppLastErrorOperation;
  catalogStatus?: CatalogPublicationStatus;
  privateLocal?: boolean;
  socialSource?: {
    userAppId: number;
    slug: string;
    ownerUsername: string;
    installId?: number;
  };
  socialUserAppId?: number;
  socialOwnerUsername?: string;
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
