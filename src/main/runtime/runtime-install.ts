import type fs from 'node:fs/promises';
import type path from 'node:path';

import { getSharedCopy } from '../../shared/i18n';
import type { InstallAppResult } from '../../shared/types';
import type { RuntimeBinarySet } from '../core/main-process-types';

interface RuntimeInstallDeps {
  DEFAULT_NODE_VERSION: string;
  DEFAULT_PYTHON_VERSION: string;
  appendInstallLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
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
const appendInstallLog = deps.appendInstallLog ?? (async () => undefined);
const RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'darwin_x64', 'linux_x64', 'win32_x64']);
const PYTHON_DARWIN_RUNTIME_REVISION = 'python-darwin-disable-library-validation-2026-06-02';
const FLATTEN_RETRY_DELAYS_MS = [25, 100];
const MIN_RUNTIME_INSTALL_FREE_BYTES = 1_024 * 1_024 * 1_024;
const FRONTEND_NATIVE_DEPENDENCY_PROBE = [
  'rollup',
  'vite',
  'esbuild',
  '@swc/core',
  'lightningcss',
];
const FRONTEND_NATIVE_DEPENDENCY_PROBE_SCRIPT = `
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const appRequire = createRequire(path.join(process.cwd(), 'package.json'));
const candidates = ${JSON.stringify(FRONTEND_NATIVE_DEPENDENCY_PROBE)};
(async () => {
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = appRequire.resolve(candidate);
    } catch (error) {
      if (error && error.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    await import(pathToFileURL(resolved).href);
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
`;

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

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const availableDiskBytes = async (dir: string): Promise<number | null> => {
  try {
    await fs.mkdir(dir, { recursive: true });
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
};

const createDiskSpaceError = (availableBytes: number, requiredBytes: number, scope: string): Error => {
  const error = new Error('disk_space_unavailable');
  (error as Error & { details?: Record<string, unknown> }).details = {
    availableBytes,
    requiredBytes,
    scope,
  };
  return error;
};

const assertEnoughDiskSpace = async (dir: string, requiredBytes: number, scope: string): Promise<void> => {
  const availableBytes = await availableDiskBytes(dir);
  if (availableBytes !== null && availableBytes < requiredBytes) {
    throw createDiskSpaceError(availableBytes, requiredBytes, scope);
  }
};

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

const shouldRetryFlattenMove = (error: unknown): boolean =>
  ['EPERM', 'EACCES', 'ENOTEMPTY'].includes(errorCode(error) ?? '');

const flattenLogPayload = (
  source: string,
  target: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  operation: 'flatten',
  sourceName: path.basename(source),
  targetName: path.basename(target),
  ...extra,
});

const moveFlattenChild = async (source: string, target: string): Promise<void> => {
  await fs.rm(target, { recursive: true, force: true });

  for (const delayMs of [0, ...FLATTEN_RETRY_DELAYS_MS]) {
    if (delayMs > 0) {
      await wait(delayMs);
      await appendInstallLog('flatten:move_retry', flattenLogPayload(source, target, { delayMs }));
    }

    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (!shouldRetryFlattenMove(error)) {
        throw error;
      }
      if (delayMs === FLATTEN_RETRY_DELAYS_MS[FLATTEN_RETRY_DELAYS_MS.length - 1]) {
        await appendInstallLog('flatten:move_fallback', flattenLogPayload(source, target, { errorCode: errorCode(error) }));
        await fs.rm(target, { recursive: true, force: true });
        await fs.cp(source, target, { recursive: true });
        await fs.rm(source, { recursive: true, force: true });
        return;
      }
    }
  }
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

interface OptionalDependencyDeclaration {
  name: string;
  requiredBy: string;
  version: string;
}

const commandErrorOutput = (error: unknown): string => {
  if (!error || typeof error !== 'object') {
    return error instanceof Error ? error.message : String(error ?? '');
  }
  const candidate = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return [candidate.message, candidate.stderr, candidate.stdout]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n');
};

const missingModuleFromError = (error: unknown): string | null => {
  const match = commandErrorOutput(error).match(
    /Cannot find (?:module|package)\s+['"]?((?:@[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\/)?[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)['"]?/i,
  );
  const name = match?.[1]?.trim();
  return name ?? null;
};

const isExactPackageVersion = (value: string): boolean =>
  /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.test(value);

const packageDirectories = async (nodeModulesDir: string): Promise<string[]> => {
  const entries = await fs.readdir(nodeModulesDir, { withFileTypes: true }).catch(() => []);
  const directories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (!entry.name.startsWith('@')) {
      directories.push(entryPath);
      continue;
    }
    const scopedEntries = await fs.readdir(entryPath, { withFileTypes: true }).catch(() => []);
    directories.push(...scopedEntries
      .filter((scopedEntry) => scopedEntry.isDirectory())
      .map((scopedEntry) => path.join(entryPath, scopedEntry.name)));
  }
  return directories;
};

const findOptionalDependencyDeclaration = async (
  frontendDir: string,
  dependencyName: string,
): Promise<OptionalDependencyDeclaration | null> => {
  const pending = [path.join(frontendDir, 'node_modules')];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeModulesDir = pending.shift() as string;
    if (visited.has(nodeModulesDir)) {
      continue;
    }
    visited.add(nodeModulesDir);
    for (const packageDir of await packageDirectories(nodeModulesDir)) {
      pending.push(path.join(packageDir, 'node_modules'));
      try {
        const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as {
          name?: unknown;
          optionalDependencies?: unknown;
        };
        const optionalDependencies = packageJson.optionalDependencies;
        if (!optionalDependencies || typeof optionalDependencies !== 'object' || Array.isArray(optionalDependencies)) {
          continue;
        }
        const version = (optionalDependencies as Record<string, unknown>)[dependencyName];
        if (typeof version !== 'string' || !isExactPackageVersion(version)) {
          continue;
        }
        return {
          name: dependencyName,
          requiredBy: typeof packageJson.name === 'string' ? packageJson.name : path.basename(packageDir),
          version,
        };
      } catch {
        // Ignore unrelated or incomplete package metadata while looking for the declaration.
      }
    }
  }
  return null;
};

const frontendCommandEnvironment = (nodePath: string): NodeJS.ProcessEnv => ({
  PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ''}`,
});

const verifyFrontendNativeDependencies = async (
  nodePath: string,
  frontendDir: string,
  appId: string,
): Promise<void> => {
  await runCommand(nodePath, ['-e', FRONTEND_NATIVE_DEPENDENCY_PROBE_SCRIPT], {
    cwd: frontendDir,
    env: frontendCommandEnvironment(nodePath),
    log: {
      appId,
      phase: 'installing_frontend',
      label: 'verify native optional dependencies',
    },
  });
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
    env: frontendCommandEnvironment(nodePath),
    log: {
      appId,
      phase: 'installing_frontend',
      label,
    },
  });

  try {
    await verifyFrontendNativeDependencies(nodePath, frontendDir, appId);
  } catch (verificationError) {
    const dependencyName = missingModuleFromError(verificationError);
    const declaration = dependencyName
      ? await findOptionalDependencyDeclaration(frontendDir, dependencyName)
      : null;
    if (!declaration) {
      throw verificationError;
    }

    await appendInstallLog('frontend:native_optional_repair:start', {
      appId,
      dependency: declaration.name,
      requiredBy: declaration.requiredBy,
      version: declaration.version,
    });
    try {
      await runCommand(npmPath, [
        'install',
        '--no-save',
        '--package-lock=false',
        '--include=optional',
        `${declaration.name}@${declaration.version}`,
      ], {
        cwd: frontendDir,
        env: frontendCommandEnvironment(nodePath),
        log: {
          appId,
          phase: 'installing_frontend',
          label: `repair optional dependency ${declaration.name}`,
        },
      });
      await verifyFrontendNativeDependencies(nodePath, frontendDir, appId);
      await appendInstallLog('frontend:native_optional_repair:success', {
        appId,
        dependency: declaration.name,
        requiredBy: declaration.requiredBy,
        version: declaration.version,
      });
    } catch (repairError) {
      await appendInstallLog('frontend:native_optional_repair:failed', {
        appId,
        dependency: declaration.name,
        requiredBy: declaration.requiredBy,
        version: declaration.version,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      });
      throw repairError;
    }
  }
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
  const visibleDirectories = visibleEntries.filter((entry) => entry.isDirectory());

  let topEntry: (typeof visibleDirectories)[number] | undefined;
  let children: string[] = [];

  for (const candidate of visibleDirectories) {
    const candidateFolder = path.join(targetDir, candidate.name);
    const candidateChildren = await fs.readdir(candidateFolder);
    const candidateChildNames = new Set(candidateChildren);
    const siblingEntries = visibleEntries.filter((entry) => entry.name !== candidate.name);
    if (siblingEntries.every((entry) => candidateChildNames.has(entry.name))) {
      topEntry = candidate;
      children = candidateChildren;
      break;
    }
  }

  if (!topEntry) {
    return;
  }

  const topFolder = path.join(targetDir, topEntry.name);

  await appendInstallLog('flatten:start', { operation: 'flatten', sourceName: topEntry.name, childCount: children.length });
  for (const child of children) {
    await moveFlattenChild(path.join(topFolder, child), path.join(targetDir, child));
  }
  await fs.rm(topFolder, { recursive: true, force: true });
  await appendInstallLog('flatten:success', { operation: 'flatten', sourceName: topEntry.name, childCount: children.length });
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
    await assertEnoughDiskSpace(path.dirname(targetRoot), MIN_RUNTIME_INSTALL_FREE_BYTES, `${type}_runtime`);
    await fs.rm(tempDir, { recursive: true, force: true });
    await extractArchive(archiveToExtract, tempDir);
    await flattenSingleTopLevelDirectory(tempDir);

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rename(tempDir, targetRoot);
    await clearMacQuarantine(targetRoot);

    try {
      const runtime = await resolveRuntimeExecutables(targetRoot, type);
      await writeRuntimeReadyMetadata(readyPath, type, platformAlias, runtimeArchiveSha256);
      return runtime;
    } catch (error) {
      await fs.rm(targetRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
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
