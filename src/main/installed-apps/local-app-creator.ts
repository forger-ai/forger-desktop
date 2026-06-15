import type fs from 'node:fs/promises';
import type path from 'node:path';
import type * as Electron from 'electron';

import type {
  CreateLocalAppInput,
  CreateLocalAppResult,
  FailureDiagnosticFields,
  InstallAppResult,
} from '../../shared/types';
import type { AppManifest, InstalledAppRecord } from '../core/main-process-types';

interface LocalAppCreatorDeps {
  DEFAULT_NODE_VERSION: string;
  DEFAULT_PYTHON_VERSION: string;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  app: Electron.App;
  emitInstallProgress: (appId: string, progress: InstallAppResult) => void;
  failureDiagnostic: (error: unknown, fallbackCode: string) => FailureDiagnosticFields;
  fs: typeof fs;
  getPrivateAppsRoot: () => string;
  installAppDependencies: (
    appId: string,
    installDir: string,
    nodeVersion: string,
    pythonVersion: string,
    publishProgress: (phase: InstallAppResult['phase'], userMessage: string) => Promise<void>,
  ) => Promise<void>;
  normalizeInstalledAgentContext: (installDir: string, appId: string) => Promise<void>;
  path: typeof path;
  registry: { apps: Record<string, InstalledAppRecord> };
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  upsertInstalledRecord: (record: InstalledAppRecord) => Promise<void>;
  ensureAppGitRepository: (cwd: string) => Promise<void>;
  ensureUserModifiedBranch: (cwd: string) => Promise<void>;
  getOriginalCommitSha: (cwd: string) => Promise<string | undefined>;
}

const MAX_FIELD_LENGTH = 4000;

const cleanText = (value: unknown): string =>
  typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LENGTH)
    : '';

const slugify = (value: string): string => {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'my-app';
};

const isSkippableSkeletonEntry = (entryName: string): boolean =>
  entryName === '.git'
  || entryName === 'node_modules'
  || entryName === '.venv'
  || entryName === 'dist'
  || entryName === 'build'
  || entryName === '.DS_Store'
  || entryName === '__pycache__'
  || entryName === '.pytest_cache'
  || entryName === '.ruff_cache'
  || entryName === 'coverage';

const escapeHtmlText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const updateManifest = (manifest: AppManifest, input: { appId: string; name: string; description: string; purpose: string }): AppManifest => {
  const rawCatalog = (manifest as Record<string, unknown>).catalog;
  const catalog = rawCatalog && typeof rawCatalog === 'object' && !Array.isArray(rawCatalog)
    ? { ...(rawCatalog as Record<string, unknown>) }
    : {};
  delete catalog.capabilities;
  delete catalog.permissions;

  return {
    ...manifest,
    name: input.appId,
    version: '0.1.0',
    description: input.description || input.purpose,
    remoteTunnel: true,
    localNetworkShare: true,
    catalog: {
      ...catalog,
      display_name: input.name,
      short_description: input.description,
      description: input.purpose,
      category: 'productividad',
      supported_platforms: ['darwin_arm64', 'darwin_x64', 'win32_x64'],
      status: 'draft',
    },
    tools: { required: [], optional: [] },
    appSecrets: [],
    promptTemplates: [],
    agents: [],
    cloudMessaging: { enabled: false, defaultDelivery: 'persistent' },
  };
};

export const createLocalAppCreator = (deps: LocalAppCreatorDeps) => {
  const {
    DEFAULT_NODE_VERSION,
    DEFAULT_PYTHON_VERSION,
    appendInstallLog,
    app,
    emitInstallProgress,
    failureDiagnostic,
    fs,
    getPrivateAppsRoot,
    installAppDependencies,
    normalizeInstalledAgentContext,
    path,
    registry,
    serializeErrorForInstallLog,
    upsertInstalledRecord,
    ensureAppGitRepository,
    ensureUserModifiedBranch,
    getOriginalCommitSha,
  } = deps;

  const resolveSkeletonRoot = async (): Promise<string> => {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'app-skeletons', 'vite-fastapi-sqlite')]
      : [
          path.resolve(app.getAppPath(), '..', 'skeletons', 'vite-fastapi-sqlite'),
          path.resolve(app.getAppPath(), '..', '..', 'skeletons', 'vite-fastapi-sqlite'),
        ];
    for (const candidate of candidates) {
      const manifest = path.join(candidate, 'manifest.json');
      try {
        const stat = await fs.stat(manifest);
        if (stat.isFile()) {
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
    throw new Error('app_skeleton_not_found');
  };

  const uniqueAppId = async (baseSlug: string): Promise<string> => {
    const privateAppsRoot = getPrivateAppsRoot();
    for (let index = 0; index < 100; index += 1) {
      const suffix = index === 0 ? '' : `-${index + 1}`;
      const candidate = `${baseSlug}${suffix}`;
      if (registry.apps[candidate]) {
        continue;
      }
      try {
        await fs.access(path.join(privateAppsRoot, candidate));
      } catch {
        return candidate;
      }
    }
    throw new Error('app_slug_unavailable');
  };

  const copySkeleton = async (skeletonRoot: string, installDir: string): Promise<void> => {
    await fs.cp(skeletonRoot, installDir, {
      recursive: true,
      filter: (source) => !source.split(path.sep).some(isSkippableSkeletonEntry),
    });
  };

  const writeGeneratedManifest = async (
    installDir: string,
    input: { appId: string; name: string; description: string; purpose: string },
  ): Promise<AppManifest> => {
    const manifestPath = path.join(installDir, 'manifest.json');
    const parsed = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as AppManifest;
    const manifest = updateManifest(parsed, input);
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
  };

  const writeFrontendHtmlTitle = async (
    installDir: string,
    input: { name: string },
  ): Promise<void> => {
    const indexPath = path.join(installDir, 'frontend', 'index.html');
    let html: string;
    try {
      html = await fs.readFile(indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    const title = `<title>${escapeHtmlText(input.name)}</title>`;
    const nextHtml = /<title>[\s\S]*?<\/title>/i.test(html)
      ? html.replace(/<title>[\s\S]*?<\/title>/i, title)
      : html.replace(/<\/head>/i, `    ${title}\n  </head>`);
    await fs.writeFile(indexPath, nextHtml, 'utf8');
  };

  const createLocalAppFromSkeleton = async (
    rawInput: CreateLocalAppInput,
    locale?: string,
  ): Promise<CreateLocalAppResult> => {
    void locale;
    const name = cleanText(rawInput.name);
    const description = cleanText(rawInput.description);
    const purpose = cleanText(rawInput.purpose);
    const lookAndFeel = cleanText(rawInput.lookAndFeel);
    const agentPrompt = cleanText(rawInput.agentPrompt);
    if (!name || !description || !purpose) {
      return {
        success: false,
        userMessage: 'Completa nombre, descripcion y que hace la app.',
        technicalCode: 'local_app_create_missing_fields',
      };
    }

    const baseSlug = slugify(name);
    const appId = await uniqueAppId(baseSlug);
    const installDir = path.join(getPrivateAppsRoot(), appId);
    const initialRecord: InstalledAppRecord = {
      appId,
      category: 'productividad',
      name,
      description,
      version: '0.1.0',
      installDir,
      status: 'installing',
      userMessage: 'Creando app local...',
      lastErrorOperation: undefined,
      requiredNodeVersion: DEFAULT_NODE_VERSION,
      requiredPythonVersion: DEFAULT_PYTHON_VERSION,
      installedAt: new Date().toISOString(),
      privateLocal: true,
    };

    await upsertInstalledRecord(initialRecord);
    await appendInstallLog('local_app_create:start', { appId, name, installDir });

    const publishProgress = async (phase: InstallAppResult['phase'], userMessage: string): Promise<void> => {
      emitInstallProgress(appId, { success: true, phase, userMessage });
      const current = registry.apps[appId];
      if (current) {
        await upsertInstalledRecord({ ...current, status: 'installing', userMessage, lastErrorOperation: undefined });
      }
    };

    try {
      const skeletonRoot = await resolveSkeletonRoot();
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(installDir), { recursive: true });
      await publishProgress('extracting', 'Preparando la base de la app...');
      await copySkeleton(skeletonRoot, installDir);
      await writeGeneratedManifest(installDir, { appId, name, description, purpose });
      await writeFrontendHtmlTitle(installDir, { name });
      await normalizeInstalledAgentContext(installDir, appId);
      await ensureAppGitRepository(installDir);
      const originalCommitSha = await getOriginalCommitSha(installDir);
      await ensureUserModifiedBranch(installDir);
      await installAppDependencies(
        appId,
        installDir,
        DEFAULT_NODE_VERSION,
        DEFAULT_PYTHON_VERSION,
        publishProgress,
      );

      const installed: InstalledAppRecord = {
        ...initialRecord,
        status: 'installed',
        userMessage: 'App creada y lista para conversar.',
        lastErrorOperation: undefined,
        originalCommitSha,
        localNetworkShareSupported: true,
        remoteTunnelSupported: true,
      };
      await upsertInstalledRecord(installed);
      emitInstallProgress(appId, {
        success: true,
        phase: 'completed',
        userMessage: 'App creada y lista para conversar.',
        progress: 1,
      });
      await appendInstallLog('local_app_create:completed', { appId, installDir });
      return {
        success: true,
        userMessage: 'App creada y lista para conversar.',
        app: { appId, name, description, purpose, ...(agentPrompt ? { agentPrompt } : {}), ...(lookAndFeel ? { lookAndFeel } : {}) },
      };
    } catch (error) {
      const diagnostic = failureDiagnostic(error, 'local_app_create_failed');
      await appendInstallLog('local_app_create:failed', {
        appId,
        installDir,
        error: serializeErrorForInstallLog(error),
      });
      await upsertInstalledRecord({
        ...initialRecord,
        status: 'error',
        userMessage: 'No pudimos crear la app local.',
        lastErrorOperation: 'install',
      });
      return {
        success: false,
        userMessage: 'No pudimos crear la app local.',
        ...diagnostic,
      };
    }
  };

  return {
    createLocalAppFromSkeleton,
    slugify,
    updateManifest,
  };
};
