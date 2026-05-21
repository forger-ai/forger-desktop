
import type { App } from 'electron';
import type os from 'node:os';
import type path from 'node:path';

import type { StoredForgerAccount } from '../forger-account-store';

interface PathConfigDeps {
  app: App;
  forgerAccount: StoredForgerAccount;
  isDev: boolean;
  os: typeof os;
  path: typeof path;
}

const PLATFORM_KEY_BY_RUNTIME: Record<NodeJS.Platform, string> = {
  darwin: 'darwin',
  win32: 'win32',
  linux: 'linux',
  aix: 'linux',
  android: 'linux',
  freebsd: 'linux',
  openbsd: 'linux',
  sunos: 'linux',
  cygwin: 'win32',
  netbsd: 'linux',
  haiku: 'linux',
};

export const createPathConfigController = (deps: PathConfigDeps) => {
  const { app, forgerAccount, isDev, os, path } = deps;

  const normalizeVersionForFolder = (value: string): string => {
    const normalized = value.trim().replace(/^v/i, '').replace(/[^0-9A-Za-z._-]/g, '-');
    return normalized || 'unknown';
  };

  const normalizeNodeRuntimeVersion = (value?: string | null): string => {
    const raw = value?.trim();
    if (!raw) {
      return '22';
    }
    const match = raw.match(/\d+/);
    return match ? match[0] : '22';
  };

  const resolvePlatformAlias = (): string => {
    const platformPrefix = PLATFORM_KEY_BY_RUNTIME[process.platform] ?? process.platform;
    return `${platformPrefix}_${process.arch}`;
  };

  const getRegistryPath = () => path.join(app.getPath('userData'), 'app_registry.json');
  const getRegistryBackupPath = () => `${getRegistryPath()}.bak`;
  const getRuntimesRoot = () => path.join(app.getPath('userData'), 'runtimes');
  const getTempRoot = () => path.join(app.getPath('userData'), 'tmp');
  const getLogsRoot = () => path.join(app.getPath('userData'), 'logs');
  const getInstallLogPath = () => path.join(getLogsRoot(), 'install.log');
  const getForgerHomeRoot = () => path.join(os.homedir(), isDev ? 'Forger-dev' : 'Forger');
  const getPrivateAppsRoot = () => path.join(getForgerHomeRoot(), 'apps');
  const getPrivateDataRoot = () => path.join(getForgerHomeRoot(), 'data');
  const getBackupsRoot = () => path.join(getForgerHomeRoot(), 'backups');
  const getForgerMetadataRoot = () => path.join(getForgerHomeRoot(), '.forger');
  const getLegacyForgerMetadataRoot = () => path.join(getPrivateAppsRoot(), '.forger');
  const getCodexRoot = () => path.join(app.getPath('userData'), 'codex-cli');
  const getCodexHome = () => path.join(app.getPath('userData'), 'codex-home');
  const getClaudeRoot = () => path.join(app.getPath('userData'), 'claude-code-cli');
  const getAgentToolSettingsPath = () => path.join(getForgerMetadataRoot(), 'agent-tools.json');
  const getSettingsPath = () => path.join(getForgerMetadataRoot(), 'settings.json');
  const getPromptOverridesPath = () => path.join(getForgerMetadataRoot(), 'prompt-overrides.json');
  const getForgerAccountPath = () => path.join(getForgerMetadataRoot(), 'account.json');
  const getCloudDevicePath = () => path.join(getForgerMetadataRoot(), 'cloud-device.json');
  const getCloudIdentityPath = () => path.join(getForgerMetadataRoot(), 'cloud-identity.json');
  const getCloudSyncSettingsPath = () => path.join(getForgerMetadataRoot(), 'cloud-sync.json');
  const getCloudDeviceAccountStorageKey = () => forgerAccount.user?.id ? `user-${forgerAccount.user.id}` : undefined;

  return {
    normalizeVersionForFolder,
    normalizeNodeRuntimeVersion,
    resolvePlatformAlias,
    getRegistryPath,
    getRegistryBackupPath,
    getRuntimesRoot,
    getTempRoot,
    getLogsRoot,
    getInstallLogPath,
    getForgerHomeRoot,
    getPrivateAppsRoot,
    getPrivateDataRoot,
    getBackupsRoot,
    getForgerMetadataRoot,
    getLegacyForgerMetadataRoot,
    getCodexRoot,
    getCodexHome,
    getClaudeRoot,
    getAgentToolSettingsPath,
    getSettingsPath,
    getPromptOverridesPath,
    getForgerAccountPath,
    getCloudDevicePath,
    getCloudIdentityPath,
    getCloudSyncSettingsPath,
    getCloudDeviceAccountStorageKey,
  };
};
