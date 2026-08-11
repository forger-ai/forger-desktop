import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCommandGitController } = require('../../dist-electron/main/runtime/command-git.js');

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
  }
}

const createHarness = (overrides = {}) => {
  const root = overrides.root ?? path.join(os.tmpdir(), 'forger-b23-command-git');
  const calls = [];
  const deps = {
    BUNDLED_GIT_VERSION: '2.50.0',
    appendInstallLog: async (event, payload = {}) => calls.push(['log', event, payload]),
    app: { getPath: () => root },
    createHash,
    findRuntimeArchive: async () => null,
    findRuntimeChecksumFile: async () => null,
    fs,
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'tmp'),
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runtimePlatformTokens: () => ['darwin_arm64'],
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    spawn: () => {
      throw new Error('spawn_not_configured');
    },
    stripArchiveExtension: (archiveName) => archiveName.replace(/\.(zip|tar\.gz|tgz)$/i, ''),
    syncDirectory: async () => undefined,
    truncateForInstallLog: (value) => value,
    yauzl: { open: () => undefined },
    ...overrides,
  };
  return { root, calls, controller: createCommandGitController(deps) };
};

const makeExitSpawn = (resultFor) => (command, args) => {
  const child = new FakeChildProcess();
  queueMicrotask(() => {
    const result = resultFor(command, args) ?? {};
    if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
    child.emit('exit', Object.hasOwn(result, 'code') ? result.code : 0, result.signal ?? null);
    if (result.lateError) child.emit('error', new Error(result.lateError));
  });
  return child;
};

test('Given command processes, when exit, timeout, capture, and late events race, then settlement stays single and diagnostics preserve null codes', async () => {
  const children = [];
  const successful = createHarness({
    spawn: () => {
      const child = new FakeChildProcess();
      children.push(child);
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        child.emit('error', new Error('late_error'));
      });
      return child;
    },
  });
  await successful.controller.runCommand('git', ['status'], { cwd: '/tmp/app' });
  assert.equal((await successful.controller.runCommandCapture('git', ['status'], { cwd: '/tmp/app' })).code, 0);

  const nullExit = createHarness({
    spawn: makeExitSpawn(() => ({ code: null, signal: 'SIGTERM' })),
  });
  await assert.rejects(
    nullExit.controller.runCommand('git', ['status'], { cwd: '/tmp/app' }),
    /code null, signal SIGTERM/,
  );

  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let lateTimeout;
  try {
    globalThis.setTimeout = (callback) => {
      lateTimeout = callback;
      return 123;
    };
    globalThis.clearTimeout = () => undefined;
    const lateTimer = createHarness({ spawn: makeExitSpawn(() => ({ code: 0 })) });
    await lateTimer.controller.runCommand('git', ['status'], { cwd: '/tmp/app', timeoutMs: 10 });
    lateTimeout();
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }

  const previousPath = process.env.PATH;
  try {
    delete process.env.PATH;
    successful.controller.appendProcessPathEntry('/private/git/bin');
    assert.equal(process.env.PATH, '/private/git/bin');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test('Given a bundled Git archive with a nested root, when atomic moves are transiently blocked, then retries fall back to a complete copy and concurrent callers share the install', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b23-git-flatten-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'resources', 'git', '2.50.0', 'git.tar.gz');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.writeFile(archive, 'archive');
  let blockedMoves = 0;
  const fsWithBlockedRename = {
    ...fs,
    rename: async (source, target) => {
      if (source.endsWith(`${path.sep}bin`) && blockedMoves < 3) {
        blockedMoves += 1;
        throw Object.assign(new Error('blocked'), { code: 'EPERM' });
      }
      return await fs.rename(source, target);
    },
  };
  const extraction = createHarness({
    root,
    fs: fsWithBlockedRename,
    findRuntimeArchive: async () => archive,
    spawn: (command, args) => {
      const child = new FakeChildProcess();
      queueMicrotask(async () => {
        if (command === 'tar') {
          const destination = args[args.indexOf('-C') + 1];
          const nested = path.join(destination, 'git-2.50.0');
          await fs.mkdir(path.join(nested, 'bin'), { recursive: true });
          await fs.mkdir(path.join(nested, 'libexec', 'git-core'), { recursive: true });
          await fs.mkdir(path.join(nested, 'share', 'git-core', 'templates'), { recursive: true });
          await fs.writeFile(path.join(nested, 'bin', 'git'), 'binary');
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  });

  const [first, second] = await Promise.all([
    extraction.controller.ensureBundledGitAvailable(),
    extraction.controller.ensureBundledGitAvailable(),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(blockedMoves, 3);
  assert.equal(await fs.readFile(path.join(root, 'runtimes', 'git', '2.50.0', 'darwin_arm64', 'bin', 'git'), 'utf8'), 'binary');
  assert.ok(extraction.calls.some((call) => call[1] === 'flatten:move_retry'));
  assert.ok(extraction.calls.some((call) => call[1] === 'flatten:move_fallback'));

  const unsupported = createHarness({ resolvePlatformAlias: () => 'freebsd_arm64' });
  assert.equal(await unsupported.controller.ensureBundledGitAvailable(), false);

  const nonRetryRoot = path.join(root, 'non-retry');
  const fsWithFatalRename = {
    ...fs,
    rename: async (source, target) => {
      if (source.endsWith(`${path.sep}bin`)) throw new Error('fatal_move');
      return await fs.rename(source, target);
    },
  };
  const nonRetry = createHarness({
    root: nonRetryRoot,
    fs: fsWithFatalRename,
    findRuntimeArchive: async () => archive,
    spawn: (command, args) => {
      const child = new FakeChildProcess();
      queueMicrotask(async () => {
        if (command === 'tar') {
          const destination = args[args.indexOf('-C') + 1];
          await fs.mkdir(path.join(destination, 'git-root', 'bin'), { recursive: true });
          await fs.writeFile(path.join(destination, 'git-root', 'bin', 'git'), 'binary');
        }
        child.emit('exit', 0, null);
      });
      return child;
    },
  });
  await assert.rejects(nonRetry.controller.ensureBundledGitAvailable(), /fatal_move/);
});

test('Given Git metadata commands with partial or empty diagnostics, when repository helpers fail, then stdout and stable fallback codes are retained', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b23-git-errors-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'app');
  await fs.mkdir(path.join(cwd, '.git', 'info'), { recursive: true });
  await fs.writeFile(path.join(cwd, '.git', 'info', 'exclude'), 'existing\n');

  const makeFailureController = (target, diagnostic) => createHarness({
    root,
    spawn: makeExitSpawn((_command, args) => {
      const joined = args.join(' ');
      if (joined === '--version') return { code: 0 };
      if (joined === target) return { code: 1, ...diagnostic };
      if (joined === 'rev-parse HEAD') return { code: 0, stdout: 'fallback-head\n' };
      return { code: 0, stdout: '.git/info/exclude\n' };
    }),
  }).controller;

  await assert.rejects(
    makeFailureController('rev-parse --git-path info/exclude', { stdout: 'exclude stdout' }).ensureForgerLocalGitExcludes(cwd),
    /exclude stdout/,
  );
  await assert.rejects(
    makeFailureController('rev-parse --git-path info/exclude', {}).ensureForgerLocalGitExcludes(cwd),
    /git_exclude_path_failed/,
  );
  await assert.rejects(
    makeFailureController('status --porcelain', { stdout: 'status stdout' }).getGitStatusLines(cwd),
    /status stdout/,
  );
  await assert.rejects(
    makeFailureController('status --porcelain', {}).getGitStatusLines(cwd),
    /git_status_failed/,
  );
  assert.equal(
    await makeFailureController('rev-list --max-parents=0 HEAD', { code: 0, stdout: '' }).getOriginalCommitSha(cwd),
    'fallback-head',
  );
  const noHead = createHarness({
    spawn: makeExitSpawn((_command, args) => args.join(' ') === 'rev-list --max-parents=0 HEAD'
      ? { code: 0, stdout: '' }
      : { code: 1 }),
  }).controller;
  assert.equal(await noHead.getOriginalCommitSha(cwd), undefined);

  const zipWithoutFile = createHarness({
    yauzl: { open: (_archive, _options, callback) => callback(null, null) },
  }).controller;
  await assert.rejects(zipWithoutFile.listZipEntries('/tmp/archive.zip'), /archive_open_failed/);

  for (const diagnostic of [{ stdout: 'tar stdout' }, {}]) {
    const controller = makeFailureController('-tzf /tmp/archive.tgz', diagnostic);
    await assert.rejects(
      controller.validateArchiveEntries('/tmp/archive.tgz'),
      diagnostic.stdout ? /tar stdout/ : /archive_list_failed/,
    );
  }

  for (const diagnostic of [{ stdout: 'ls stdout' }, {}]) {
    const stage = path.join(root, `stage-${diagnostic.stdout ?? 'empty'}`);
    const installed = path.join(root, `installed-${diagnostic.stdout ?? 'empty'}`);
    await fs.mkdir(stage, { recursive: true });
    await fs.mkdir(installed, { recursive: true });
    const controller = makeFailureController('ls-files -z', diagnostic);
    await assert.rejects(
      controller.syncReleaseIntoInstalledApp(stage, installed, []),
      diagnostic.stdout ? /ls stdout/ : /git_ls_files_failed/,
    );
  }

  const trailingNewline = createHarness({
    root,
    spawn: makeExitSpawn((_command, args) => args.join(' ') === 'rev-parse --git-path info/exclude'
      ? { stdout: '.git/info/exclude\n' }
      : { code: 0 }),
  }).controller;
  await trailingNewline.ensureForgerLocalGitExcludes(cwd);
  assert.match(await fs.readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8'), /frontend\/dist/);

  assert.deepEqual(trailingNewline.collectPersistentInstallPaths(), [
    'backend/.venv',
    'backend/data',
    'frontend/.vite',
    'frontend/dist',
    'frontend/node_modules',
  ]);
  assert.deepEqual(trailingNewline.collectPersistentInstallPaths({ services: [{}] }), [
    'backend/.venv',
    'backend/data',
    'frontend/.vite',
    'frontend/dist',
    'frontend/node_modules',
  ]);
});
