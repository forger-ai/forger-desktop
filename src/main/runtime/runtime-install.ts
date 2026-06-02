import type fs from 'node:fs/promises';
import type path from 'node:path';

import { getSharedCopy } from '../../shared/i18n';
import type { InstallAppResult } from '../../shared/types';
import type { RuntimeBinarySet } from '../core/main-process-types';

interface RuntimeInstallDeps {
  DEFAULT_NODE_VERSION: string;
  DEFAULT_PYTHON_VERSION: string;
  app: Electron.App;
  clearMacQuarantine: (targetPath: string) => Promise<void>;
  extractArchive: (archivePath: string, destination: string) => Promise<void>;
  findRuntimeArchive: (baseDir: string, platformAlias: string) => Promise<string | null>;
  findRuntimeChecksumFile: (baseDir: string, archivePath: string, platformAlias: string) => Promise<string | null>;
  fs: typeof fs;
  getBundledResourcesRoot: () => string;
  getRuntimesRoot: () => string;
  getTempRoot: () => string;
  hashFileSha256: (filePath: string) => Promise<string>;
  installBackendDependenciesWithUv: (pythonPath: string, backendDir: string, appId: string) => Promise<void>;
  normalizeNodeRuntimeVersion: (value?: string | null) => string;
  normalizeVersionForFolder: (value: string) => string;
  path: typeof path;
  resolvePlatformAlias: () => string;
  runCommand: (
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv; log?: { appId?: string; phase?: string; label?: string } },
  ) => Promise<void>;
  runtimeLocks: Map<string, Promise<RuntimeBinarySet>>;
}

export const createRuntimeInstallController = (deps: RuntimeInstallDeps) => {
  const { fs, path, runtimeLocks, getBundledResourcesRoot, getTempRoot, getRuntimesRoot, resolvePlatformAlias, normalizeVersionForFolder, normalizeNodeRuntimeVersion, findRuntimeArchive, findRuntimeChecksumFile, hashFileSha256, extractArchive, clearMacQuarantine, runCommand, installBackendDependenciesWithUv } = deps;
const RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'win32_x64']);
const PYTHON_DARWIN_RUNTIME_REVISION = 'python-darwin-disable-library-validation-2026-06-02';

interface RuntimeReadyMetadata {
  installedAt: string;
  desktopVersion: string;
  runtimeRevision?: string | null;
  archiveSha256?: string | null;
}

const fileExists = async (filePath: string): Promise<boolean> => {
  const stat = await fs.stat(filePath).catch(() => null);
  return Boolean(stat?.isFile());
};

const desktopVersion = (): string => {
  const appWithVersion = deps.app as Electron.App & { getVersion?: () => string };
  return typeof appWithVersion.getVersion === 'function' ? appWithVersion.getVersion() : 'unknown';
};

const runtimeRevisionFor = (type: 'node' | 'python', platformAlias: string): string | null =>
  type === 'python' && platformAlias === 'darwin_arm64' ? PYTHON_DARWIN_RUNTIME_REVISION : null;

const runtimeRequiresCurrentReadyMetadata = (type: 'node' | 'python', platformAlias: string): boolean =>
  runtimeRevisionFor(type, platformAlias) !== null;

const readRuntimeReadyMetadata = async (readyPath: string): Promise<RuntimeReadyMetadata | null> => {
  try {
    const raw = await fs.readFile(readyPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RuntimeReadyMetadata>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.installedAt !== 'string') {
      return null;
    }
    return {
      installedAt: parsed.installedAt,
      desktopVersion: typeof parsed.desktopVersion === 'string' ? parsed.desktopVersion : 'unknown',
      runtimeRevision: typeof parsed.runtimeRevision === 'string' ? parsed.runtimeRevision : null,
      archiveSha256: typeof parsed.archiveSha256 === 'string' ? parsed.archiveSha256 : null,
    };
  } catch {
    return null;
  }
};

const isRuntimeReadyMetadataCurrent = (
  metadata: RuntimeReadyMetadata | null,
  type: 'node' | 'python',
  platformAlias: string,
  archiveSha256: string,
): boolean => {
  const runtimeRevision = runtimeRevisionFor(type, platformAlias);
  if (!runtimeRevision) {
    return true;
  }
  return Boolean(
    metadata &&
    metadata.runtimeRevision === runtimeRevision &&
    metadata.archiveSha256 === archiveSha256,
  );
};

const writeRuntimeReadyMetadata = async (
  readyPath: string,
  type: 'node' | 'python',
  platformAlias: string,
  archiveSha256: string,
): Promise<void> => {
  const metadata: RuntimeReadyMetadata = {
    installedAt: new Date().toISOString(),
    desktopVersion: desktopVersion(),
    runtimeRevision: runtimeRevisionFor(type, platformAlias),
    archiveSha256,
  };
  await fs.writeFile(readyPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
};

const installFrontendDependenciesWithNpm = async (
  nodePath: string,
  npmPath: string,
  frontendDir: string,
  appId: string,
): Promise<void> => {
  const hasPackageLock = await fileExists(path.join(frontendDir, 'package-lock.json'));
  const args = hasPackageLock ? ['ci'] : ['install', '--package-lock=false'];
  const label = hasPackageLock ? 'npm ci' : 'npm install --package-lock=false';

  await runCommand(npmPath, args, {
    cwd: frontendDir,
    env: {
      PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    log: {
      appId,
      phase: 'installing_frontend',
      label,
    },
  });
};

const installAppDependencies = async (
  appId: string,
  installDir: string,
  nodeVersion: string,
  pythonVersion: string,
  publishProgress: (phase: InstallAppResult['phase'], userMessage: string) => Promise<void>,
  messages = getSharedCopy().install,
): Promise<void> => {
  await publishProgress('preparing_runtime', messages.preparingRuntime);
  const nodeRuntime = await ensureRuntimeInstalled('node', nodeVersion);
  const pythonRuntime = await ensureRuntimeInstalled('python', pythonVersion);

  const backendDir = path.join(installDir, 'backend');
  const frontendDir = path.join(installDir, 'frontend');

  await publishProgress('installing_backend', messages.installingBackend);
  await installBackendDependenciesWithUv(pythonRuntime.python as string, backendDir, appId);

  await publishProgress('installing_frontend', messages.installingFrontend);
  await installFrontendDependenciesWithNpm(nodeRuntime.node as string, nodeRuntime.npm as string, frontendDir, appId);
};

const flattenSingleTopLevelDirectory = async (targetDir: string): Promise<void> => {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'));

  if (visibleEntries.length !== 1 || !visibleEntries[0].isDirectory()) {
    return;
  }

  const topFolder = path.join(targetDir, visibleEntries[0].name);
  const children = await fs.readdir(topFolder);
  for (const child of children) {
    await fs.rename(path.join(topFolder, child), path.join(targetDir, child));
  }
  await fs.rm(topFolder, { recursive: true, force: true });
};

const findExistingFile = async (baseDir: string, candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    const attempt = path.join(baseDir, candidate);

    try {
      const stat = await fs.stat(attempt);
      if (stat.isFile()) {
        return attempt;
      }
    } catch {
      // keep searching
    }
  }

  return null;
};

const resolveRuntimeExecutables = async (runtimeRoot: string, type: 'node' | 'python'): Promise<RuntimeBinarySet> => {
  const root = runtimeRoot;

  if (type === 'node') {
    const node = await findExistingFile(root, [
      path.join('bin', 'node'),
      'node.exe',
      path.join('node', 'bin', 'node'),
      path.join('node', 'node.exe'),
    ]);
    const npm = await findExistingFile(root, [
      path.join('bin', 'npm'),
      path.join('bin', 'npm.cmd'),
      'npm.cmd',
      path.join('node', 'bin', 'npm'),
      path.join('node', 'npm.cmd'),
    ]);

    if (!node || !npm) {
      throw new Error('runtime_node_executable_not_found');
    }

    return {
      rootDir: root,
      node,
      npm,
    };
  }

  const python = await findExistingFile(root, [
    path.join('bin', 'python3'),
    path.join('bin', 'python'),
    'python.exe',
    path.join('python', 'bin', 'python3'),
    path.join('python', 'bin', 'python'),
    path.join('python', 'python.exe'),
  ]);
  const pip = await findExistingFile(root, [
    path.join('bin', 'pip3'),
    path.join('bin', 'pip'),
    path.join('Scripts', 'pip.exe'),
    'pip.exe',
    path.join('python', 'bin', 'pip3'),
    path.join('python', 'bin', 'pip'),
    path.join('python', 'Scripts', 'pip.exe'),
    path.join('python', 'pip.exe'),
  ]);

  if (!python) {
    throw new Error('runtime_python_executable_not_found');
  }

  return {
    rootDir: root,
    python,
    pip: pip ?? undefined,
  };
};

const ensureRuntimeInstalled = async (
  type: 'node' | 'python',
  rawVersion: string,
): Promise<RuntimeBinarySet> => {
  const platformAlias = resolvePlatformAlias();
  if (!RUNTIME_PLATFORM_ALIASES.has(platformAlias)) {
    throw new Error(`unsupported_platform_${platformAlias}`);
  }

  const version = type === 'node' ? normalizeNodeRuntimeVersion(rawVersion) : normalizeVersionForFolder(rawVersion);
  const lockKey = `${type}:${version}:${platformAlias}`;
  const pending = runtimeLocks.get(lockKey);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const targetRoot = path.join(getRuntimesRoot(), type, version, platformAlias);
    const readyPath = path.join(targetRoot, '.ready');

    const resourcesRoot = getBundledResourcesRoot();
    const runtimeVersionDir = path.join(resourcesRoot, type, version);
    let runtimeArchive: string | null = null;
    let runtimeArchiveSha256 = '';

    const resolveRuntimeArchive = async (): Promise<string> => {
      if (runtimeArchive) {
        return runtimeArchive;
      }
      runtimeArchive = await findRuntimeArchive(runtimeVersionDir, platformAlias);

      if (!runtimeArchive) {
        throw new Error(`runtime_archive_missing_${type}_${version}_${platformAlias}`);
      }

      try {
        const runtimeChecksumFile = await findRuntimeChecksumFile(runtimeVersionDir, runtimeArchive, platformAlias);
        if (runtimeChecksumFile) {
          const checksumRaw = await fs.readFile(runtimeChecksumFile, 'utf8');
          const expected = checksumRaw.trim().split(/\s+/)[0];
          if (expected) {
            const current = await hashFileSha256(runtimeArchive);
            if (current !== expected) {
              throw new Error(`runtime_checksum_mismatch_${type}_${version}_${platformAlias}`);
            }
            runtimeArchiveSha256 = expected;
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('runtime_checksum_mismatch')) {
          throw error;
        }
        // Missing checksum file is tolerated in dev mode.
      }

      if (!runtimeArchiveSha256) {
        runtimeArchiveSha256 = await hashFileSha256(runtimeArchive);
      }
      return runtimeArchive;
    };

    try {
      await fs.access(readyPath);
      if (runtimeRequiresCurrentReadyMetadata(type, platformAlias)) {
        await resolveRuntimeArchive();
        const readyMetadata = await readRuntimeReadyMetadata(readyPath);
        if (!isRuntimeReadyMetadataCurrent(readyMetadata, type, platformAlias, runtimeArchiveSha256)) {
          await fs.rm(targetRoot, { recursive: true, force: true });
          throw new Error('runtime_ready_metadata_stale');
        }
      }
      await clearMacQuarantine(targetRoot);
      return await resolveRuntimeExecutables(targetRoot, type);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('runtime_checksum_mismatch')) {
        throw error;
      }
      // continue with extraction
    }

    const archiveToExtract = await resolveRuntimeArchive();

    const tempDir = path.join(getTempRoot(), `${type}-${version}-${platformAlias}-${Date.now()}`);
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await extractArchive(archiveToExtract, tempDir);
    await flattenSingleTopLevelDirectory(tempDir);

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rename(tempDir, targetRoot);
    await clearMacQuarantine(targetRoot);
    await writeRuntimeReadyMetadata(readyPath, type, platformAlias, runtimeArchiveSha256);

    return await resolveRuntimeExecutables(targetRoot, type);
  })();

  runtimeLocks.set(lockKey, task);

  try {
    return await task;
  } finally {
    runtimeLocks.delete(lockKey);
  }
};

  return { fileExists, installFrontendDependenciesWithNpm, installAppDependencies, flattenSingleTopLevelDirectory, findExistingFile, resolveRuntimeExecutables, ensureRuntimeInstalled };
};
