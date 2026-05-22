import { LocalNetworkShareManager } from '../local-network-share-manager';
import type {
  LocalNetworkShareResult,
  LocalNetworkShareStatus,
  OpenAppResult,
  RuntimeStatus,
} from '../../shared/types';
import type { RunningAppProcess } from './main-process-types';

interface LocalNetworkShareControllerOptions {
  runningApps: Map<string, RunningAppProcess>;
  openInstalledApp: (appId: string, locale?: string, options?: { openWindow?: boolean }) => Promise<OpenAppResult>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  emitRuntimeStatus: (status: RuntimeStatus) => void;
}

export interface LocalNetworkShareController {
  manager: LocalNetworkShareManager | null;
  getStatus: (appId: string) => LocalNetworkShareStatus;
  start: (appId: string) => Promise<LocalNetworkShareResult>;
  stop: (appId: string) => Promise<LocalNetworkShareResult>;
}

export const createLocalNetworkShareController = (
  options: LocalNetworkShareControllerOptions,
): LocalNetworkShareController => {
  let manager: LocalNetworkShareManager | null = null;

  const emitShareStatus = (appId: string, localNetworkShare: LocalNetworkShareStatus): void => {
    options.emitRuntimeStatus({ ...options.getRuntimeStatus(appId), localNetworkShare });
  };

  const getManager = (): LocalNetworkShareManager => {
    if (!manager) {
      manager = new LocalNetworkShareManager({
        runningApps: options.runningApps,
        openInstalledApp: options.openInstalledApp,
        appendInstallLog: options.appendInstallLog,
        onConnected: (status) => emitShareStatus(status.appId, status),
      });
    }
    return manager;
  };

  return {
    get manager() {
      return manager;
    },
    set manager(value) {
      manager = value;
    },
    getStatus: (appId) => manager?.status(appId) ?? { active: false, appId },
    start: async (appId) => {
      const result = await getManager().start(appId);
      emitShareStatus(appId, result.status);
      return result;
    },
    stop: async (appId) => {
      const result = await getManager().stop(appId);
      emitShareStatus(appId, result.status);
      return result;
    },
  };
};
