
import type { App } from 'electron';
import type os from 'node:os';
import type path from 'node:path';

import type { StoredForgerAccount } from '../forger-account-store';

interface PathConfigDeps {
  app: App;
  e2eProfileRoot?: string;
  forgerAccount: StoredForgerAccount;
  isDev: boolean;
  isTest?: boolean;
  os: typeof os;
  path: typeof path;
}

interface ConfigureUserDataDeps {
  app: Pick<App, 'getPath' | 'isPackaged' | 'setPath'>;
  e2eProfileRoot?: string;
  isDev: boolean;
  isTest?: boolean;
  path: typeof path;
}

const PLATFORM_KEY_BY_RUNTIME: Record<string, string> = {
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

const SUPPORTED_RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'darwin_x64', 'linux_x64', 'win32_x64']);

export const resolveRuntimePlatformAlias = (
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string => {
  const platformPrefix = PLATFORM_KEY_BY_RUNTIME[platform] ?? platform;
  const alias = `${platformPrefix}_${arch}`;
  if (!SUPPORTED_RUNTIME_PLATFORM_ALIASES.has(alias)) {
    throw new Error(`unsupported_platform_${platform}_${arch}`);
  }
  return alias;
};

export const getDesktopUserDataName = (isDev: boolean): string => (isDev ? 'forger-desktop-dev' : 'forger-desktop');

const resolveE2EProfileRoot = ({
  app,
  e2eProfileRoot,
  isTest,
  path,
}: Pick<ConfigureUserDataDeps, 'app' | 'e2eProfileRoot' | 'isTest' | 'path'>): string | null => {
  const candidate = e2eProfileRoot?.trim();
  if (!candidate || !isTest || app.isPackaged !== false || !path.isAbsolute(candidate)) {
    return null;
  }
  return path.resolve(candidate);
};

export const configureDesktopUserDataPath = ({ app, e2eProfileRoot, isDev, isTest, path }: ConfigureUserDataDeps): string | null => {
  const isolatedProfileRoot = resolveE2EProfileRoot({ app, e2eProfileRoot, isTest, path });
  if (isolatedProfileRoot) {
    const userDataPath = path.join(isolatedProfileRoot, 'user-data');
    app.setPath('userData', userDataPath);
    return userDataPath;
  }
  if (!isDev) {
    return null;
  }
  const userDataPath = path.join(app.getPath('appData'), getDesktopUserDataName(true));
  app.setPath('userData', userDataPath);
  return userDataPath;
};

export const createPathConfigController = (deps: PathConfigDeps) => {
  const { app, e2eProfileRoot, forgerAccount, isDev, isTest, os, path } = deps;
  const isolatedProfileRoot = resolveE2EProfileRoot({ app, e2eProfileRoot, isTest, path });

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

  const resolvePlatformAlias = (): string => resolveRuntimePlatformAlias();

  const getRegistryPath = () => path.join(app.getPath('userData'), 'app_registry.json');
  const getRegistryBackupPath = () => `${getRegistryPath()}.bak`;
  const getRuntimesRoot = () => path.join(app.getPath('userData'), 'runtimes');
  const getTempRoot = () => path.join(app.getPath('userData'), 'tmp');
  const getLogsRoot = () => path.join(app.getPath('userData'), 'logs');
  const getInstallLogPath = () => path.join(getLogsRoot(), 'install.log');
  const getForgerHomeRoot = () => isolatedProfileRoot
    ? path.join(isolatedProfileRoot, 'workspace')
    : path.join(os.homedir(), isDev ? 'Forger-dev' : 'Forger');
  const getPrivateAppsRoot = () => path.join(getForgerHomeRoot(), 'apps');
  const getPrivateDataRoot = () => path.join(getForgerHomeRoot(), 'data');
  const getBackupsRoot = () => path.join(getForgerHomeRoot(), 'backups');
  const getForgerMetadataRoot = () => path.join(getForgerHomeRoot(), '.forger');
  const getLegacyForgerMetadataRoot = () => path.join(getPrivateAppsRoot(), '.forger');
  const getCodexRoot = () => path.join(app.getPath('userData'), 'codex-cli');
  const getCodexHome = () => path.join(app.getPath('userData'), 'codex-home');
  const getClaudeRoot = () => path.join(app.getPath('userData'), 'claude-code-cli');
  const getAntigravityRoot = () => path.join(app.getPath('userData'), 'antigravity-cli');
  const getAgentToolSettingsPath = () => path.join(getForgerMetadataRoot(), 'agent-tools.json');
  const getSettingsPath = () => path.join(getForgerMetadataRoot(), 'settings.json');
  const getPromptOverridesPath = () => path.join(getForgerMetadataRoot(), 'prompt-overrides.json');
  const getForgerAccountPath = () => path.join(getForgerMetadataRoot(), 'account.json');
  const getCloudDevicePath = () => path.join(getForgerMetadataRoot(), 'cloud-device.json');
  const getCloudIdentityPath = () => path.join(getForgerMetadataRoot(), 'cloud-identity.json');
  const getSocialMessagesPath = () => path.join(getForgerMetadataRoot(), 'social-messages.sqlite');
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
    getAntigravityRoot,
    getAgentToolSettingsPath,
    getSettingsPath,
    getPromptOverridesPath,
    getForgerAccountPath,
    getCloudDevicePath,
    getCloudIdentityPath,
    getSocialMessagesPath,
    getCloudSyncSettingsPath,
    getCloudDeviceAccountStorageKey,
  };
};
