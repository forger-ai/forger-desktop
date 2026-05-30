import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { Settings, UpdateAppDeveloperSettingsInput, DeveloperPathState } from '../../shared/types';
import type { InstalledAppRecord, AppRegistry, RuntimeBinarySet } from './main-process-types';
import {
  buildEffectiveDeveloperPathEntries,
  splitPathEntries,
  validateDeveloperPathEntries,
} from '../runtime/developer-paths';

interface DeveloperPathServiceDeps {
  defaultNodeVersion: string;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  fs: typeof fs;
  getAppLocalToolPathEntries: (record: InstalledAppRecord) => Promise<string[]>;
  getRuntimePathEntries: (runtime: RuntimeBinarySet) => string[];
  normalizeNodeRuntimeVersion: (version?: string | null) => string;
  normalizeSettings: (input?: Partial<Settings>) => Settings;
  path: typeof path;
  registry: AppRegistry;
  settings: () => Settings;
  systemPath: () => string | undefined;
  upsertInstalledRecord: (record: InstalledAppRecord) => Promise<void>;
}

export const createDeveloperPathService = (deps: DeveloperPathServiceDeps) => {
  const getStoredDeveloperPathEntries = (appId?: string): string[] => {
    const current = deps.normalizeSettings(deps.settings()).developerMode;
    if (!current.enabled) {
      return [];
    }
    const appEntries = appId ? deps.registry.apps[appId]?.developerPathEntries ?? [] : [];
    return [...current.pathEntries, ...appEntries];
  };

  const getForgerRuntimePathEntries = async (appId?: string): Promise<string[]> => {
    const entries = new Set<string>();
    const codexNodeRuntime = await deps.ensureRuntimeInstalled('node', deps.defaultNodeVersion);
    for (const entry of deps.getRuntimePathEntries(codexNodeRuntime)) {
      entries.add(entry);
    }
    const record = appId ? deps.registry.apps[appId] : undefined;
    if (record) {
      for (const entry of await deps.getAppLocalToolPathEntries(record)) {
        entries.add(entry);
      }
      const appNodeRuntime = await deps.ensureRuntimeInstalled('node', deps.normalizeNodeRuntimeVersion(record.requiredNodeVersion));
      const appPythonRuntime = await deps.ensureRuntimeInstalled('python', record.requiredPythonVersion);
      for (const entry of deps.getRuntimePathEntries(appNodeRuntime)) {
        entries.add(entry);
      }
      for (const entry of deps.getRuntimePathEntries(appPythonRuntime)) {
        entries.add(entry);
      }
    }
    return [...entries];
  };

  const getAgentPathEntries = async (appId?: string): Promise<string[]> => [
    ...await getForgerRuntimePathEntries(appId),
    ...getStoredDeveloperPathEntries(appId),
  ];

  const getDeveloperPathState = async (appId?: string): Promise<DeveloperPathState> => {
    const current = deps.normalizeSettings(deps.settings()).developerMode;
    const runtimePathEntries = await getForgerRuntimePathEntries(appId);
    const appPathEntries = appId ? deps.registry.apps[appId]?.developerPathEntries ?? [] : [];
    const systemPath = deps.systemPath();
    const systemPathEntries = splitPathEntries(systemPath, deps.path.delimiter);
    return {
      enabled: current.enabled,
      globalPathEntries: current.pathEntries,
      appPathEntries,
      runtimePathEntries,
      systemPathEntries,
      effectivePathEntries: buildEffectiveDeveloperPathEntries({
        enabled: current.enabled,
        runtimePathEntries,
        globalPathEntries: current.pathEntries,
        appPathEntries,
        systemPath,
        delimiter: deps.path.delimiter,
      }),
    };
  };

  const updateAppDeveloperSettings = async (input: UpdateAppDeveloperSettingsInput): Promise<DeveloperPathState> => {
    const record = deps.registry.apps[input.appId];
    if (!record) {
      throw new Error('developer_app_not_installed');
    }
    const pathEntries = await validateDeveloperPathEntries(input.pathEntries, { fs: deps.fs, path: deps.path });
    await deps.upsertInstalledRecord({ ...record, developerPathEntries: pathEntries });
    return await getDeveloperPathState(input.appId);
  };

  return {
    getAgentPathEntries,
    getDeveloperPathState,
    updateAppDeveloperSettings,
  };
};
