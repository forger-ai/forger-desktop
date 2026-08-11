import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRuntimeInstallController } = require('../../dist-electron/main/runtime/runtime-install.js');

const fsWithAvailableDisk = () => Object.assign(Object.create(fs), {
  statfs: async () => ({ bavail: 2 * 1024 * 1024, bsize: 1024 }),
});

const fixture = async (t, name) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  return root;
};

const controllerFor = (root, overrides = {}) => {
  const calls = [];
  const deps = {
    app: {},
    appendInstallLog: async (event, payload) => calls.push(['log', event, payload]),
    clearMacQuarantine: async (target) => calls.push(['quarantine', target]),
    extractArchive: async (_archive, destination) => {
      await fs.mkdir(path.join(destination, 'runtime', 'bin'), { recursive: true });
      await fs.writeFile(path.join(destination, 'runtime', 'bin', 'python3'), '', 'utf8');
    },
    findRuntimeArchive: async () => path.join(root, 'archive.tgz'),
    findRuntimeChecksumFile: async () => null,
    fs: fsWithAvailableDisk(),
    getBundledResourcesRoot: () => path.join(root, 'resources'),
    getRuntimesRoot: () => path.join(root, 'runtimes'),
    getTempRoot: () => path.join(root, 'temp'),
    hashFileSha256: async () => 'archive-sha',
    installBackendDependenciesWithUv: async () => undefined,
    normalizeNodeRuntimeVersion: (value) => value,
    normalizeVersionForFolder: (value) => value,
    path,
    resolvePlatformAlias: () => 'darwin_arm64',
    runCommand: async () => undefined,
    runtimeLocks: new Map(),
    ...overrides,
  };
  return { calls, controller: createRuntimeInstallController(deps), deps };
};

test('runtime install tolerates unavailable disk metrics and replaces invalid ready metadata', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-ready');
  await fs.writeFile(path.join(root, 'archive.tgz'), 'archive', 'utf8');
  const target = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  await fs.mkdir(path.join(target, 'bin'), { recursive: true });
  await fs.writeFile(path.join(target, 'bin', 'python3'), 'old', 'utf8');
  await fs.writeFile(path.join(target, '.ready'), JSON.stringify({ installedAt: 123 }), 'utf8');
  const fsWithoutDiskStats = {
    ...fs,
    statfs: async () => { throw new Error('statfs unavailable'); },
  };
  const { controller } = controllerFor(root, { fs: fsWithoutDiskStats });
  const runtime = await controller.ensureRuntimeInstalled('python', '3.12.0');
  assert.equal(runtime.python, path.join(target, 'bin', 'python3'));
  const ready = JSON.parse(await fs.readFile(path.join(target, '.ready'), 'utf8'));
  assert.equal(ready.desktopVersion, 'unknown');

  const secondRoot = path.join(root, 'second');
  const secondTarget = path.join(secondRoot, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  await fs.mkdir(path.join(secondTarget, 'bin'), { recursive: true });
  await fs.writeFile(path.join(secondTarget, 'bin', 'python3'), 'old', 'utf8');
  await fs.writeFile(path.join(secondTarget, '.ready'), JSON.stringify({ installedAt: 'now' }), 'utf8');
  await fs.writeFile(path.join(secondRoot, 'archive.tgz'), 'archive', 'utf8');
  const { controller: fallbacks } = controllerFor(secondRoot);
  assert.equal((await fallbacks.ensureRuntimeInstalled('python', '3.12.0')).python, path.join(secondTarget, 'bin', 'python3'));
});

test('runtime install preserves checksum mismatch from an existing macOS Python runtime', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-ready-checksum');
  const archive = path.join(root, 'archive.tgz');
  const checksum = path.join(root, 'archive.sha256');
  const target = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  await fs.mkdir(path.join(target, 'bin'), { recursive: true });
  await fs.writeFile(path.join(target, 'bin', 'python3'), '', 'utf8');
  await fs.writeFile(path.join(target, '.ready'), JSON.stringify({ installedAt: 'now' }), 'utf8');
  await fs.writeFile(archive, 'archive', 'utf8');
  await fs.writeFile(checksum, 'expected archive.tgz\n', 'utf8');
  const { controller } = controllerFor(root, {
    findRuntimeArchive: async () => archive,
    findRuntimeChecksumFile: async () => checksum,
    hashFileSha256: async () => 'actual',
  });
  await assert.rejects(
    controller.ensureRuntimeInstalled('python', '3.12.0'),
    /runtime_checksum_mismatch_python_3.12.0_darwin_arm64/,
  );
});

test('runtime flatten leaves unrelated layouts intact and propagates non-transient rename errors', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-flatten');
  const flat = path.join(root, 'flat');
  await fs.mkdir(flat);
  await fs.writeFile(path.join(flat, 'visible.txt'), 'visible', 'utf8');
  const { controller } = controllerFor(root);
  await controller.flattenSingleTopLevelDirectory(flat);
  assert.equal(await fs.readFile(path.join(flat, 'visible.txt'), 'utf8'), 'visible');

  const nested = path.join(root, 'nested');
  await fs.mkdir(path.join(nested, 'wrapper'), { recursive: true });
  await fs.writeFile(path.join(nested, 'wrapper', 'child'), 'child', 'utf8');
  const originalRename = fs.rename;
  const fatal = Object.assign(new Error('fatal rename'), { code: 'EIO' });
  const { controller: fatalController } = controllerFor(root, {
    fs: { ...fs, rename: async () => { throw fatal; } },
  });
  await assert.rejects(fatalController.flattenSingleTopLevelDirectory(nested), (error) => error === fatal);
  const primitiveController = controllerFor(root, {
    fs: { ...fs, rename: async () => { throw 'rename denied'; } },
  }).controller;
  await assert.rejects(primitiveController.flattenSingleTopLevelDirectory(nested), (error) => error === 'rename denied');
  assert.equal(typeof originalRename, 'function');
});

test('runtime frontend verification surfaces primitive errors and logs failed optional repairs', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-repair');
  const frontend = path.join(root, 'frontend');
  const packageDir = path.join(frontend, 'node_modules', 'builder');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(frontend, 'package-lock.json'), '{}', 'utf8');
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'builder', optionalDependencies: { '@scope/native': '1.2.3' },
  }), 'utf8');
  let command = 0;
  const { calls, controller } = controllerFor(root, {
    runCommand: async () => {
      command += 1;
      if (command === 2) {
        const error = new Error('probe failed');
        error.stderr = "Cannot find module '@scope/native'";
        throw error;
      }
      if (command === 3) throw 'repair denied';
    },
  });
  await assert.rejects(
    controller.installFrontendDependenciesWithNpm(process.execPath, process.execPath, frontend, 'app'),
    (error) => error === 'repair denied',
  );
  assert.ok(calls.some(([kind, event, payload]) => kind === 'log' && event === 'frontend:native_optional_repair:failed' && payload.error === 'repair denied'));

  const primitive = controllerFor(root, {
    runCommand: async (_binary, args) => {
      if (args[0] === '-e') throw 'plain verification failure';
    },
  }).controller;
  await assert.rejects(
    primitive.installFrontendDependenciesWithNpm(process.execPath, process.execPath, frontend, 'app'),
    (error) => error === 'plain verification failure',
  );
});

test('runtime optional dependency search skips incomplete, ranged, and malformed packages', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-package-search');
  const frontend = path.join(root, 'frontend');
  const modules = path.join(frontend, 'node_modules');
  await fs.mkdir(path.join(modules, '@scope', 'ranged'), { recursive: true });
  await fs.mkdir(path.join(modules, 'array-deps'), { recursive: true });
  await fs.mkdir(path.join(modules, 'malformed'), { recursive: true });
  await fs.writeFile(path.join(modules, 'plain-file'), 'not a directory', 'utf8');
  await fs.writeFile(path.join(modules, '@scope', 'scope-file'), 'not a directory', 'utf8');
  await fs.writeFile(path.join(modules, '@scope', 'ranged', 'package.json'), JSON.stringify({ optionalDependencies: { native: '^1.2.3' } }), 'utf8');
  await fs.writeFile(path.join(modules, 'array-deps', 'package.json'), JSON.stringify({ optionalDependencies: [] }), 'utf8');
  await fs.writeFile(path.join(modules, 'malformed', 'package.json'), '{bad', 'utf8');
  let calls = 0;
  const verificationError = Object.assign(new Error('probe'), { stderr: "Cannot find package 'native'" });
  const { controller } = controllerFor(root, {
    runCommand: async (_binary, args) => {
      calls += 1;
      if (args[0] === '-e') throw verificationError;
    },
  });
  await assert.rejects(
    controller.installFrontendDependenciesWithNpm(process.execPath, process.execPath, frontend, 'app'),
    (error) => error === verificationError,
  );
  assert.equal(calls, 2);

  const previousPath = process.env.PATH;
  delete process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  const nullFailure = controllerFor(root, {
    runCommand: async (_binary, args) => {
      if (args[0] === '-e') throw null;
    },
  }).controller;
  await assert.rejects(
    nullFailure.installFrontendDependenciesWithNpm(process.execPath, process.execPath, frontend, 'app'),
    (error) => error === null,
  );
});

test('runtime optional repair uses folder identity and reports Error failures', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-repair-error');
  const frontend = path.join(root, 'frontend');
  const packageDir = path.join(frontend, 'node_modules', 'anonymous-builder');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ optionalDependencies: { native: '1.2.3' } }), 'utf8');
  let calls = 0;
  const repairError = new Error('repair failed');
  const harness = controllerFor(root, {
    runCommand: async (_binary, args) => {
      calls += 1;
      if (args[0] === '-e') {
        const error = new Error('probe');
        error.stdout = "Cannot find package 'native'";
        throw error;
      }
      if (calls === 3) throw repairError;
    },
  });
  await assert.rejects(
    harness.controller.installFrontendDependenciesWithNpm(process.execPath, process.execPath, frontend, 'app'),
    (error) => error === repairError,
  );
  const failed = harness.calls.find(([, event]) => event === 'frontend:native_optional_repair:failed');
  assert.equal(failed[2].requiredBy, 'anonymous-builder');
  assert.equal(failed[2].error, 'repair failed');
});

test('runtime executable resolution skips directories and returns optional pip absence', async (t) => {
  const root = await fixture(t, 'forger-runtime-b21-executables');
  await fs.mkdir(path.join(root, 'bin', 'python3'), { recursive: true });
  await fs.writeFile(path.join(root, 'bin', 'python'), '', 'utf8');
  const { controller } = controllerFor(root);
  assert.equal(await controller.findExistingFile(root, ['missing', path.join('bin', 'python3'), path.join('bin', 'python')]), path.join(root, 'bin', 'python'));
  assert.deepEqual(await controller.resolveRuntimeExecutables(root, 'python'), {
    pip: undefined,
    python: path.join(root, 'bin', 'python'),
    rootDir: root,
  });
});

test('Given an extracted runtime without Python, a blocked cleanup preserves the executable error', async (t) => {
  const root = await fixture(t, 'forger-runtime-b33-cleanup');
  const targetRoot = path.join(root, 'runtimes', 'python', '3.12.0', 'darwin_arm64');
  await fs.writeFile(path.join(root, 'archive.tgz'), 'archive', 'utf8');

  let cleanupArmed = false;
  let cleanupAttempts = 0;
  const controlledFs = Object.assign(fsWithAvailableDisk(), {
    rename: async (source, target) => {
      await fs.rename(source, target);
      if (target === targetRoot) cleanupArmed = true;
    },
    rm: async (target, options) => {
      if (cleanupArmed && target === targetRoot) {
        cleanupAttempts += 1;
        throw new Error('cleanup_blocked');
      }
      await fs.rm(target, options);
    },
  });
  const { controller } = controllerFor(root, {
    extractArchive: async (_archive, destination) => {
      await fs.mkdir(destination, { recursive: true });
    },
    fs: controlledFs,
  });

  await assert.rejects(
    controller.ensureRuntimeInstalled('python', '3.12.0'),
    /runtime_python_executable_not_found/,
  );
  assert.equal(cleanupAttempts, 1);
  assert.equal((await fs.stat(targetRoot)).isDirectory(), true);
});
