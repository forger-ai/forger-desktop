import type { AppToolDeclaration } from './tools';

export type AppStatus = 'not_installed' | 'installing' | 'installed' | 'running' | 'error' | 'conflict';
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
  tools?: {
    required?: AppToolDeclaration[];
    optional?: AppToolDeclaration[];
  };
  localNetworkShare?: import('./runtime').LocalNetworkShareStatus;
  remoteNetworkShare?: import('./runtime').RemoteNetworkShareStatus;
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
