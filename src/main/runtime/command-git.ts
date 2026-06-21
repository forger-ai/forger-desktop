import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { createHash as createHashFn } from 'node:crypto';
import type fs from 'node:fs/promises';
import type path from 'node:path';
import type yauzl from 'yauzl';

import type { AppManifest } from '../core/main-process-types';
import type { SpawnProcess } from './process-spawn';

interface CommandRunLog {
  appId?: string;
  phase?: string;
  label?: string;
}

interface CommandRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log?: CommandRunLog;
  timeoutMs?: number;
}

interface CommandCaptureOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface CommandCaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type AppendInstallLog = (event: string, payload?: Record<string, unknown>) => Promise<void>;

interface CommandGitDeps {
  BUNDLED_GIT_VERSION: string;
  appendInstallLog: AppendInstallLog;
  app: Electron.App;
  createHash: typeof createHashFn;
  findRuntimeArchive: (baseDir: string, platformAlias: string) => Promise<string | null>;
  findRuntimeChecksumFile: (baseDir: string, archivePath: string, platformAlias: string) => Promise<string | null>;
  fs: typeof fs;
  getBundledResourcesRoot: () => string;
  getRuntimesRoot: () => string;
  getTempRoot: () => string;
  normalizeVersionForFolder: (value: string) => string;
  path: typeof path;
  resolvePlatformAlias: () => string;
  runtimePlatformTokens: (platformAlias: string) => string[];
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  spawn: SpawnProcess;
  stripArchiveExtension: (archiveName: string) => string;
  syncDirectory: (directoryPath: string) => Promise<void>;
  truncateForInstallLog: (value: string) => string;
  yauzl: typeof yauzl;
}

export const createCommandGitController = (deps: CommandGitDeps) => {
  const { fs, path, spawn, app, createHash, appendInstallLog, serializeErrorForInstallLog, truncateForInstallLog, getBundledResourcesRoot, getRuntimesRoot, getTempRoot, findRuntimeArchive, findRuntimeChecksumFile, BUNDLED_GIT_VERSION, runtimePlatformTokens, stripArchiveExtension, normalizeVersionForFolder, syncDirectory, resolvePlatformAlias, yauzl } = deps;
const gitToolLocks = new Map<string, Promise<string | null>>();
class CommandFailedError extends Error {
  constructor(
    command: string,
    args: string[],
    cwd: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    stdout: string,
    stderr: string,
  ) {
    super(`Command failed: ${command} ${args.join(' ')} (code ${code ?? 'null'}, signal ${signal ?? 'null'})`);
    this.name = 'CommandFailedError';
    Object.assign(this, { command, args, cwd, code, signal, stdout, stderr });
  }
}

class CommandTimeoutError extends Error {
  constructor(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    stdout: string,
    stderr: string,
  ) {
    super('command_timeout');
    this.name = 'CommandTimeoutError';
    Object.assign(this, { command, args, cwd, timeoutMs, stdout, stderr });
  }
}

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
};

const FLATTEN_RETRY_DELAYS_MS = [25, 100];

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;

const shouldRetryFlattenMove = (error: unknown): boolean =>
  ['EPERM', 'EACCES', 'ENOTEMPTY'].includes(errorCode(error) ?? '');

const runCommand = async (
  command: string,
  args: string[],
  options: CommandRunOptions,
): Promise<void> => {
  if (options.log) {
    await appendInstallLog('command:start', {
      appId: options.log.appId,
      phase: options.log.phase,
      label: options.log.label,
      command,
      args,
      cwd: options.cwd,
      shell: false,
    });
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: false,
      stdio: 'pipe',
    });

    let stderr = '';
    let stdout = '';
    let settled = false;
    const timeoutMs = options.timeoutMs;
    const timer = timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGTERM');
          if (options.log) {
            void appendInstallLog('command:timeout', {
              appId: options.log.appId,
              phase: options.log.phase,
              label: options.log.label,
              command,
              args,
              cwd: options.cwd,
              shell: false,
              timeoutMs,
              stdout: truncateForInstallLog(stdout),
              stderr: truncateForInstallLog(stderr),
            });
          }
          reject(new CommandTimeoutError(command, args, options.cwd, timeoutMs, stdout, stderr));
        }, timeoutMs)
      : null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (options.log) {
        void appendInstallLog('command:error', {
          appId: options.log.appId,
          phase: options.log.phase,
          label: options.log.label,
          command,
          args,
          cwd: options.cwd,
          shell: false,
          error: serializeErrorForInstallLog(error),
          stdout: truncateForInstallLog(stdout),
          stderr: truncateForInstallLog(stderr),
        });
      }
      reject(error);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (options.log) {
        void appendInstallLog('command:exit', {
          appId: options.log.appId,
          phase: options.log.phase,
          label: options.log.label,
          command,
          args,
          cwd: options.cwd,
          shell: false,
          code,
          signal,
          stdout: truncateForInstallLog(stdout),
          stderr: truncateForInstallLog(stderr),
        });
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new CommandFailedError(command, args, options.cwd, code, signal, stdout, stderr));
    });
  });
};

const runCommandCapture = async (
  command: string,
  args: string[],
  options: CommandCaptureOptions,
): Promise<CommandCaptureResult> => {
  return await new Promise<CommandCaptureResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      shell: false,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('command_timeout'));
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code: number | null) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
};

const zipDirectory = async (sourceDir: string, zipPath: string): Promise<void> => {
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  if (process.platform === 'win32') {
    const escapedSource = path.join(sourceDir, '*').replace(/'/g, "''");
    const escapedZip = zipPath.replace(/'/g, "''");
    await runCommand(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${escapedSource}' -DestinationPath '${escapedZip}' -Force`],
      { cwd: sourceDir },
    );
    return;
  }

  await runCommand('zip', ['-qry', zipPath, '.'], { cwd: sourceDir });
};

const canRunCommand = async (command: string, args: string[]): Promise<boolean> => {
  try {
    await runCommand(command, args, {
      cwd: app.getPath('userData'),
    });
    return true;
  } catch {
    return false;
  }
};

const existsFile = async (filePath: string): Promise<boolean> => {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
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
    const source = path.join(topFolder, child);
    const target = path.join(targetDir, child);
    await fs.rm(target, { recursive: true, force: true });

    for (const delayMs of [0, ...FLATTEN_RETRY_DELAYS_MS]) {
      if (delayMs > 0) {
        await wait(delayMs);
        await appendInstallLog('flatten:move_retry', { operation: 'flatten', sourceName: child, targetName: child, delayMs });
      }

      try {
        await fs.rename(source, target);
        break;
      } catch (error) {
        if (!shouldRetryFlattenMove(error)) {
          throw error;
        }
        if (delayMs === FLATTEN_RETRY_DELAYS_MS[FLATTEN_RETRY_DELAYS_MS.length - 1]) {
          await appendInstallLog('flatten:move_fallback', { operation: 'flatten', sourceName: child, targetName: child, errorCode: errorCode(error) });
          await fs.rm(target, { recursive: true, force: true });
          await fs.cp(source, target, { recursive: true });
          await fs.rm(source, { recursive: true, force: true });
          break;
        }
      }
    }
  }
  await fs.rm(topFolder, { recursive: true, force: true });
  await appendInstallLog('flatten:success', { operation: 'flatten', sourceName: topEntry.name, childCount: children.length });
};

const appendProcessPathEntry = (entry: string): void => {
  const currentPath = process.env.PATH ?? '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);
  if (entries.some((existing) => existing.toLowerCase() === entry.toLowerCase())) {
    return;
  }

  process.env.PATH = [entry, currentPath].filter(Boolean).join(path.delimiter);
};

const findGitExecutableOutsidePath = async (): Promise<string | null> => {
  const localAppData = process.env.LocalAppData;
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'git.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
          path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'git.exe'),
          ...(localAppData
            ? [
                path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
                path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
              ]
            : []),
        ]
      : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];

  for (const candidate of candidates) {
    if (!candidate || !(await existsFile(candidate))) {
      continue;
    }
    if (await canRunCommand(candidate, ['--version'])) {
      return candidate;
    }
  }

  return null;
};

const makeDiscoveredGitAvailable = async (): Promise<boolean> => {
  const gitPath = await findGitExecutableOutsidePath();
  if (!gitPath) {
    return false;
  }

  appendProcessPathEntry(path.dirname(gitPath));
  return await canRunCommand('git', ['--version']);
};

const configureBundledGitEnvironment = (root: string): void => {
  appendProcessPathEntry(path.join(root, 'bin'));
  appendProcessPathEntry(path.join(root, 'cmd'));
  process.env.GIT_EXEC_PATH = path.join(root, 'libexec', 'git-core');
  process.env.GIT_TEMPLATE_DIR = path.join(root, 'share', 'git-core', 'templates');
};

const resolveGitExecutableInRoot = async (root: string): Promise<string | null> => {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(root, 'cmd', 'git.exe'),
          path.join(root, 'bin', 'git.exe'),
          path.join(root, 'mingw64', 'bin', 'git.exe'),
        ]
      : [
          path.join(root, 'bin', 'git'),
          path.join(root, 'cmd', 'git'),
        ];

  for (const candidate of candidates) {
    if ((await existsFile(candidate)) && (await canRunCommand(candidate, ['--version']))) {
      return candidate;
    }
  }

  return null;
};

const ensureBundledGitAvailable = async (): Promise<boolean> => {
  const platformAlias = resolvePlatformAlias();
  if (!['darwin_arm64', 'darwin_x64', 'linux_x64', 'win32_x64'].includes(platformAlias)) {
    return false;
  }

  const lockKey = `git:${BUNDLED_GIT_VERSION}:${platformAlias}`;
  const pending = gitToolLocks.get(lockKey);
  const gitPath = pending
    ? await pending
    : await (async () => {
        const task = (async (): Promise<string | null> => {
          const targetRoot = path.join(getRuntimesRoot(), 'git', BUNDLED_GIT_VERSION, platformAlias);
          const readyPath = path.join(targetRoot, '.ready');

          try {
            await fs.access(readyPath);
            return await resolveGitExecutableInRoot(targetRoot);
          } catch {
            // continue with extraction
          }

          const resourcesRoot = getBundledResourcesRoot();
          const gitVersionDir = path.join(resourcesRoot, 'git', BUNDLED_GIT_VERSION);
          const gitArchive = await findRuntimeArchive(gitVersionDir, platformAlias);
          if (!gitArchive) {
            return null;
          }

          const checksumFile = await findRuntimeChecksumFile(gitVersionDir, gitArchive, platformAlias);
          if (checksumFile) {
            const checksumRaw = await fs.readFile(checksumFile, 'utf8');
            const expected = checksumRaw.trim().split(/\s+/)[0];
            if (expected && (await hashFileSha256(gitArchive)) !== expected) {
              throw new Error(`git_checksum_mismatch_${BUNDLED_GIT_VERSION}_${platformAlias}`);
            }
          }

          const tempDir = path.join(getTempRoot(), `git-${BUNDLED_GIT_VERSION}-${platformAlias}-${Date.now()}`);
          await fs.mkdir(path.dirname(targetRoot), { recursive: true });
          await fs.rm(tempDir, { recursive: true, force: true });
          await extractArchive(gitArchive, tempDir);
          await flattenSingleTopLevelDirectory(tempDir);
          await fs.rm(targetRoot, { recursive: true, force: true });
          await fs.mkdir(path.dirname(targetRoot), { recursive: true });
          await fs.rename(tempDir, targetRoot);
          await fs.writeFile(readyPath, new Date().toISOString(), 'utf8');
          return await resolveGitExecutableInRoot(targetRoot);
        })();

        gitToolLocks.set(lockKey, task);
        try {
          return await task;
        } finally {
          gitToolLocks.delete(lockKey);
        }
      })();

  if (!gitPath) {
    return false;
  }

  configureBundledGitEnvironment(path.dirname(path.dirname(gitPath)));
  return await canRunCommand('git', ['--version']);
};

const ensureGitAvailable = async (): Promise<void> => {
  if (process.platform === 'darwin' && (await ensureBundledGitAvailable())) {
    return;
  }

  if (await canRunCommand('git', ['--version'])) {
    return;
  }

  if (await ensureBundledGitAvailable()) {
    return;
  }

  if (await makeDiscoveredGitAvailable()) {
    return;
  }

  if (process.platform === 'darwin') {
    if (await canRunCommand('brew', ['--version'])) {
      await runCommand('brew', ['install', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    }
  } else if (process.platform === 'win32') {
    if (await canRunCommand('winget', ['--version'])) {
      await runCommand(
        'winget',
        ['install', '--id', 'Git.Git', '-e', '--accept-package-agreements', '--accept-source-agreements'],
        { cwd: app.getPath('userData') },
      ).catch(() => undefined);
    }
  } else {
    if (await canRunCommand('apt-get', ['--version'])) {
      await runCommand('apt-get', ['update'], { cwd: app.getPath('userData') }).catch(() => undefined);
      await runCommand('apt-get', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('dnf', ['--version'])) {
      await runCommand('dnf', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('yum', ['--version'])) {
      await runCommand('yum', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('apk', ['--version'])) {
      await runCommand('apk', ['add', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    }
  }

  if (
    !(await canRunCommand('git', ['--version'])) &&
    !(await ensureBundledGitAvailable()) &&
    !(await makeDiscoveredGitAvailable())
  ) {
    throw new Error('git_unavailable');
  }
};

const ensureGitMainBranch = async (cwd: string): Promise<void> => {
  await runCommand('git', ['checkout', 'main'], { cwd }).catch(async () => {
    await runCommand('git', ['checkout', '-B', 'main'], { cwd });
  });
};

const LOCAL_GIT_EXCLUDE_RULES = [
  '',
  '# Forger runtime artifacts',
  'backend/.venv/',
  'backend/__pycache__/',
  'backend/**/__pycache__/',
  'backend/**/*.pyc',
  'backend/.ruff_cache/',
  'backend/.pytest_cache/',
  'backend/data/',
  'frontend/node_modules/',
  'frontend/dist/',
  'frontend/.vite/',
  'frontend/tsconfig.tsbuildinfo',
  '.DS_Store',
];

const ensureForgerLocalGitExcludes = async (cwd: string): Promise<void> => {
  const result = await runCommandCapture('git', ['rev-parse', '--git-path', 'info/exclude'], {
    cwd,
    timeoutMs: 5_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'git_exclude_path_failed');
  }

  const excludePath = path.resolve(cwd, result.stdout.trim());
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
  const missingRules = LOCAL_GIT_EXCLUDE_RULES.filter((rule) => rule && !existing.split('\n').includes(rule));
  if (missingRules.length === 0) {
    return;
  }

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await fs.appendFile(excludePath, `${prefix}${missingRules.join('\n')}\n`, 'utf8');
};

const ensureAppGitRepository = async (cwd: string): Promise<void> => {
  await ensureGitAvailable();

  const isRepo = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    .then(() => true)
    .catch(() => false);

  if (!isRepo) {
    await runCommand('git', ['init', '-b', 'main'], { cwd }).catch(async () => {
      await runCommand('git', ['init'], { cwd });
      await ensureGitMainBranch(cwd);
    });
    await runCommand('git', ['config', 'user.email', 'forger@local.invalid'], { cwd }).catch(() => undefined);
    await runCommand('git', ['config', 'user.name', 'Forger'], { cwd }).catch(() => undefined);
    await ensureForgerLocalGitExcludes(cwd);
    await runCommand('git', ['add', '-A'], { cwd }).catch(() => undefined);
    await runCommand('git', ['commit', '--allow-empty', '-m', 'forger: initial state'], { cwd }).catch(
      () => undefined,
    );
    return;
  }

  await runCommand('git', ['config', 'user.email', 'forger@local.invalid'], { cwd }).catch(() => undefined);
  await runCommand('git', ['config', 'user.name', 'Forger'], { cwd }).catch(() => undefined);
  await ensureGitMainBranch(cwd);
  await ensureForgerLocalGitExcludes(cwd);
};

const ensureUserModifiedBranch = async (cwd: string): Promise<void> => {
  await runCommand('git', ['checkout', 'user-modified'], { cwd }).catch(async () => {
    await runCommand('git', ['checkout', '-b', 'user-modified'], { cwd });
  });
};

const getGitStatusLines = async (cwd: string): Promise<string[]> => {
  const result = await runCommandCapture('git', ['status', '--porcelain'], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'git_status_failed');
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
};

const normalizeGitStatusPath = (line: string): string => {
  const rawPath = line.slice(3).trim();
  const renamedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath;
  return renamedPath.replace(/\\/g, '/');
};

const isRuntimeArtifactStatusLine = (line: string): boolean => {
  const filePath = normalizeGitStatusPath(line);
  return (
    filePath === 'frontend/node_modules' ||
    filePath.startsWith('frontend/node_modules/') ||
    filePath === 'frontend/package-lock.json' ||
    filePath === 'backend/.venv' ||
    filePath.startsWith('backend/.venv/') ||
    filePath === 'backend/data' ||
    filePath.startsWith('backend/data/') ||
    filePath === 'frontend/dist' ||
    filePath.startsWith('frontend/dist/') ||
    filePath === 'frontend/.vite' ||
    filePath.startsWith('frontend/.vite/') ||
    filePath.includes('/__pycache__/') ||
    filePath.endsWith('/__pycache__') ||
    filePath.endsWith('.pyc') ||
    filePath.endsWith('tsconfig.tsbuildinfo') ||
    filePath === '.DS_Store'
  );
};

const getUserVisibleGitStatusLines = async (cwd: string): Promise<string[]> =>
  (await getGitStatusLines(cwd)).filter((line) => !isRuntimeArtifactStatusLine(line));

const getGitHead = async (cwd: string): Promise<string | null> => {
  const result = await runCommandCapture('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 5_000 }).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
};

const getOriginalCommitSha = async (cwd: string): Promise<string | undefined> => {
  const result = await runCommandCapture('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    cwd,
    timeoutMs: 5_000,
  }).catch(() => null);
  if (!result || result.code !== 0) {
    return (await getGitHead(cwd)) ?? undefined;
  }
  return result.stdout.split('\n')[0]?.trim() || ((await getGitHead(cwd)) ?? undefined);
};

const clearMacQuarantine = async (targetPath: string): Promise<void> => {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    await fs.access(targetPath);
  } catch {
    return;
  }

  await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetPath], {
    cwd: path.dirname(targetPath),
  }).catch(() => {
    // Best effort: if no xattr is present we can continue.
  });
};

const extractArchive = async (archivePath: string, destination: string): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await runCommand(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
        ],
        { cwd: destination },
      );
      return;
    }

    await runCommand('unzip', ['-q', archivePath, '-d', destination], { cwd: destination });
    return;
  }

  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    await runCommand('tar', ['-xzf', archivePath, '-C', destination], { cwd: destination });
    return;
  }

  throw new Error(`unsupported_archive_format_${archivePath}`);
};

const listZipEntries = async (archivePath: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (openError: Error | null, zipFile?: yauzl.ZipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('archive_open_failed'));
        return;
      }

      const entries: string[] = [];
      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        reject(error);
      };

      zipFile.once('error', fail);
      zipFile.on('entry', (entry: yauzl.Entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.once('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        resolve(entries);
      });
      zipFile.readEntry();
    });
  });

const validateArchiveEntries = async (archivePath: string): Promise<void> => {
  const entries = archivePath.endsWith('.zip')
    ? await listZipEntries(archivePath)
    : archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')
      ? await (async () => {
          const listResult = await runCommandCapture('tar', ['-tzf', archivePath], {
            cwd: path.dirname(archivePath),
            timeoutMs: 30_000,
          });
          if (listResult.code !== 0) {
            throw new Error(listResult.stderr || listResult.stdout || 'archive_list_failed');
          }
          return listResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        })()
      : null;

  if (!entries) {
    throw new Error(`unsupported_archive_format_${archivePath}`);
  }

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      parts.includes('..') ||
      parts.includes('.git') ||
      normalized.includes('/.git/') ||
      normalized.endsWith('/.git')
    ) {
      throw new Error(`unsafe_archive_entry_${normalized}`);
    }
  }
};

const normalizeRelativeInstallPath = (value: string): string | null => {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    return null;
  }
  return normalized;
};

const runtimeArtifactRoots = [
  'backend/.venv',
  'backend/data',
  'frontend/node_modules',
  'frontend/dist',
  'frontend/.vite',
];

const isPathAtOrInside = (filePath: string, rootPath: string): boolean =>
  filePath === rootPath || filePath.startsWith(`${rootPath}/`);

const collectPersistentInstallPaths = (manifest: AppManifest | null): string[] => {
  const paths = new Set(runtimeArtifactRoots);
  for (const service of manifest?.services ?? []) {
    for (const volume of service.volumes ?? []) {
      if (!volume?.persist || typeof volume.source !== 'string') {
        continue;
      }
      const normalized = normalizeRelativeInstallPath(volume.source);
      if (normalized) {
        paths.add(normalized);
      }
    }
  }
  return [...paths].sort();
};

const isPreservedInstallPath = (relativePath: string, preservedPaths: string[]): boolean => {
  const normalized = normalizeRelativeInstallPath(relativePath);
  return Boolean(normalized && preservedPaths.some((preservedPath) => isPathAtOrInside(normalized, preservedPath)));
};

const gitCommitAllExcept = async (cwd: string, message: string, excludedPaths: string[]): Promise<string> => {
  await runCommand('git', ['add', '-A'], { cwd });
  const safeExcludedPaths = excludedPaths
    .map((entry) => normalizeRelativeInstallPath(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (safeExcludedPaths.length > 0) {
    await runCommand('git', ['reset', '--', ...safeExcludedPaths], { cwd });
  }
  await runCommand('git', ['commit', '--allow-empty', '-m', message], { cwd });
  const head = await getGitHead(cwd);
  if (!head) {
    throw new Error('missing_git_head_after_commit');
  }
  return head;
};

const removeTrackedFilesMissingFromStage = async (
  stageDir: string,
  installDir: string,
  preservedPaths: string[],
): Promise<void> => {
  const result = await runCommandCapture('git', ['ls-files', '-z'], { cwd: installDir, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || 'git_ls_files_failed');
  }
  const trackedPaths = result.stdout.split('\0').filter(Boolean);
  await Promise.all(
    trackedPaths.map(async (trackedPath) => {
      const normalized = normalizeRelativeInstallPath(trackedPath);
      if (!normalized || isPreservedInstallPath(normalized, preservedPaths)) {
        return;
      }
      const stagedPath = path.join(stageDir, normalized);
      const stagedStat = await fs.stat(stagedPath).catch(() => null);
      if (stagedStat) {
        return;
      }
      await fs.rm(path.join(installDir, normalized), { recursive: true, force: true });
    }),
  );
};

const copyReleaseContentsForUpdate = async (
  sourceDir: string,
  targetDir: string,
  preservedPaths: string[],
  relativeRoot = '',
): Promise<void> => {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') {
      throw new Error('unsafe_staged_git_entry');
    }
    const relativePath = normalizeRelativeInstallPath(path.posix.join(relativeRoot, entry.name));
    if (!relativePath || isPreservedInstallPath(relativePath, preservedPaths)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    const targetStat = await fs.lstat(targetPath).catch(() => null);
    if (targetStat && targetStat.isDirectory() !== entry.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
    }

    if (entry.isDirectory()) {
      await copyReleaseContentsForUpdate(sourcePath, targetPath, preservedPaths, relativePath);
      continue;
    }

    await fs.cp(sourcePath, targetPath, {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
    });
  }
};

const syncReleaseIntoInstalledApp = async (
  stageDir: string,
  installDir: string,
  preservedPaths: string[],
): Promise<void> => {
  await copyReleaseContentsForUpdate(stageDir, installDir, preservedPaths);
  await removeTrackedFilesMissingFromStage(stageDir, installDir, preservedPaths);
};

  return { CommandTimeoutError, hashFileSha256, runCommand, runCommandCapture, zipDirectory, canRunCommand, existsFile, appendProcessPathEntry, findGitExecutableOutsidePath, makeDiscoveredGitAvailable, configureBundledGitEnvironment, resolveGitExecutableInRoot, ensureBundledGitAvailable, ensureGitAvailable, ensureGitMainBranch, ensureForgerLocalGitExcludes, ensureAppGitRepository, ensureUserModifiedBranch, getGitStatusLines, getUserVisibleGitStatusLines, getGitHead, getOriginalCommitSha, clearMacQuarantine, extractArchive, listZipEntries, validateArchiveEntries, normalizeRelativeInstallPath, collectPersistentInstallPaths, gitCommitAllExcept, copyReleaseContentsForUpdate, syncReleaseIntoInstalledApp };
};
