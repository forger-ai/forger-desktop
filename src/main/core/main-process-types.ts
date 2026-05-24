import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type http from 'node:http';

import type { AppBackupSummary, AppCategory, AppStatus, VersionChangelog } from '../../shared/types';
import type { Locale } from '../../shared/i18n';

export interface InstalledAppRecord {
  appId: string;
  name: string;
  description: string;
  category: AppCategory;
  version: string;
  installDir: string;
  status: Exclude<AppStatus, 'not_installed' | 'running'>;
  userMessage?: string;
  requiredNodeVersion: string;
  requiredPythonVersion: string;
  originalCommitSha?: string;
  installedAt?: string;
  privateLocal?: boolean;
  localNetworkShareSupported?: boolean;
  remoteTunnelSupported?: boolean;
  pendingUpdate?: {
    fromVersion: string;
    targetVersion: string;
    preUpdateUserHead: string;
    baseCommitSha?: string;
    backup?: AppBackupSummary;
    startedAt: string;
    message?: string;
  };
}

export interface AppRegistry {
  apps: Record<string, InstalledAppRecord>;
}

export interface RuntimeBinarySet {
  rootDir: string;
  node?: string;
  npm?: string;
  python?: string;
  pip?: string;
}

export interface RunningAppProcess {
  appId: string;
  backend: ChildProcessWithoutNullStreams;
  frontend: ChildProcessWithoutNullStreams;
  backendUrl: string;
  frontendUrl: string;
  rawFrontendUrl: string;
  proxyServer: http.Server;
  locale?: Locale;
  rawLocale?: string | null;
}

export interface AppManifestService {
  name?: string;
  type?: string;
  port?: number;
  command?: string;
  healthcheck?: string;
  context?: string;
  environment?: Record<string, string>;
  volumes?: AppManifestVolume[];
}

export interface AppManifestMcp {
  type?: string;
  context?: string;
  command?: string;
  healthcheck?: string;
  environment?: Record<string, string>;
  toolTimeoutSec?: number;
}

export interface AppManifestStackSection {
  language?: string;
  framework?: string;
  package_manager?: string;
  database?: string;
  bundler?: string;
  ui?: string;
}

export interface AppManifestStack {
  backend?: AppManifestStackSection;
  frontend?: AppManifestStackSection;
}

export interface AppManifest {
  name?: string;
  version?: string;
  description?: string;
  catalog?: unknown;
  changelog?: VersionChangelog[];
  promptTemplates?: unknown;
  codexConversation?: unknown;
  agents?: unknown;
  agentProviders?: unknown;
  stack?: AppManifestStack;
  services?: AppManifestService[];
  mcp?: AppManifestMcp;
  scripts?: Record<string, string>;
  skills?: string[];
  appSecrets?: unknown;
  tools?: unknown;
  agentRuntime?: {
    networkAccess?: boolean;
  };
  cloudMessaging?: {
    enabled?: boolean;
    defaultDelivery?: 'persistent' | 'ephemeral';
  };
  localNetworkShare?: boolean;
  remoteTunnel?: boolean;
}

export interface AppManifestVolume {
  source?: string;
  target?: string;
  persist?: boolean;
}

export interface StackSkillTemplate {
  id: string;
  description: string;
  body: string;
}
