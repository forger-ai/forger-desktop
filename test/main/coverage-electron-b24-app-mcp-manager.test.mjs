import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const appMcpManagerPath = require.resolve('../../dist-electron/main/app-mcp-manager.js');
const processSpawnPath = require.resolve('../../dist-electron/main/runtime/process-spawn.js');
const realProcessSpawn = require(processSpawnPath);
const { AppMcpManager } = require(appMcpManagerPath);

const loadManagerWithSpawn = (spawnProcess) => {
  const originalLoad = Module._load;
  const cached = require.cache[appMcpManagerPath];
  Module._load = function mocked(request, parent, isMain) {
    if (request === './runtime/process-spawn') {
      return { ...realProcessSpawn, spawnProcess };
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  try {
    delete require.cache[appMcpManagerPath];
    return require(appMcpManagerPath).AppMcpManager;
  } finally {
    Module._load = originalLoad;
    if (cached) require.cache[appMcpManagerPath] = cached;
    else delete require.cache[appMcpManagerPath];
  }
};

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
};

const managerFor = (overrides = {}) => new AppMcpManager({
  getInstalledApp: () => null,
  resolveInstalledManifest: async () => null,
  ensureRuntimeInstalled: async () => ({ rootDir: '/runtime', python: '/runtime/python' }),
  ensureBackendPythonEnvironment: async () => undefined,
  getVenvExecutables: () => ({ python: '/venv/python', pip: '/venv/pip' }),
  getFreePort: async () => 1234,
  splitManifestCommand: (command) => command?.split(' ') ?? [],
  ensurePathInside: () => true,
  translateManifestEnvironment: (env) => ({ ...env }),
  ensureSqliteDatabaseParent: async () => undefined,
  getRuntimePathEntries: () => [],
  waitForHttpOk: async () => undefined,
  terminateProcess: async () => undefined,
  appendInstallLog: async () => undefined,
  truncateForInstallLog: (value) => value,
  serializeErrorForInstallLog: (error) => ({ error: String(error) }),
  ...overrides,
});

test('app MCP manager contains listener failures, secret rotation, pending starts, timers, and PYTHONPATH roots', async () => {
  const manager = managerFor();
  manager.listenOne = async () => { throw new Error('unexpected'); };
  assert.deepEqual(await manager.listenOneWithResult('app', 'run'), { appId: 'app', code: 'app_mcp_start_failed' });

  const failures = [];
  const secretFailure = managerFor({
    resolveAppSecretsEnvironment: async () => { throw new Error('vault unavailable'); },
    onMcpStartFailed: (input) => failures.push(input),
  });
  assert.equal(await secretFailure.resolveSecrets('app', {}, 'run', (code) => failures.push(code)), null);
  assert.equal(failures[0], 'app_mcp_secrets_unavailable');

  let released;
  const pending = managerFor();
  const state = pending.getState('app');
  state.status = 'starting';
  state.startPromise = new Promise((resolve) => { released = resolve; });
  const stopping = pending.stopOne(state);
  released(null);
  await stopping;
  assert.equal(state.status, 'down');

  const rotating = managerFor();
  const rotatingState = rotating.getState('app');
  rotatingState.status = 'starting';
  rotatingState.startPromise = Promise.reject(new Error('old start'));
  rotatingState.stopTimer = setTimeout(() => undefined, 60_000);
  await rotating.restartForSecretsChange(rotatingState);
  assert.equal(rotatingState.stopTimer, undefined);

  const disposal = managerFor();
  const disposalState = disposal.getState('app');
  disposalState.stopTimer = setTimeout(() => undefined, 60_000);
  disposal.dispose();
  assert.equal(disposal.states.size, 0);

  const config = manager.buildProcessConfig(
    { command: 'python server.py', environment: { PYTHONPATH: `relative${path.delimiter}/absolute` } },
    { appId: 'my.app', installDir: '/apps/my-app', requiredPythonVersion: '3.12' },
    '/runtime/python', '/venv/python', 1234, 'token', {},
  );
  assert.equal(config.environment.PYTHONPATH, `/apps/my-app/backend/relative${path.delimiter}/absolute`);

  const changed = managerFor({
    getInstalledApp: () => ({ appId: 'app', installDir: '/apps/app', requiredPythonVersion: '3.12' }),
    resolveInstalledManifest: async () => ({ mcp: { command: 'python server.py' } }),
    resolveAppSecretsEnvironment: async () => ({ env: {}, missingRequired: [], secretValues: [], fingerprint: 'new' }),
  });
  const changedState = changed.getState('app');
  changedState.status = 'up';
  changedState.secretsFingerprint = 'old';
  let restarted = false;
  changed.restartForSecretsChange = async (target) => { restarted = true; target.status = 'down'; };
  changed.startOne = async () => ({ name: 'app', url: 'http://mcp', token: 't', tokenEnvVar: 'TOKEN' });
  assert.ok(await changed.listenOne('app', 'run', () => undefined));
  assert.equal(restarted, true);

  changed.options.getPathEntries = async () => ['/custom'];
  assert.deepEqual(await changed.resolvePathEntries('app', '/venv/python', { rootDir: '/runtime' }), ['/custom']);
});

test('app MCP public listen retries after failing diagnostics and always clears failed start state', async () => {
  for (const diagnosticFailure of ['log', 'callback']) {
    const children = [];
    const PublicManager = loadManagerWithSpawn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    let healthChecks = 0;
    let diagnosticFailures = 0;
    const terminated = [];
    const manager = new PublicManager({
      ...managerFor().options,
      getInstalledApp: () => ({ appId: 'app', installDir: '/apps/app', requiredPythonVersion: '3.12' }),
      resolveInstalledManifest: async () => ({ mcp: { command: 'python server.py' } }),
      resolveAppSecretsEnvironment: async () => ({ env: {}, missingRequired: [], secretValues: [], fingerprint: 'same' }),
      waitForHttpOk: async () => {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error('health failed');
      },
      terminateProcess: async (child) => { terminated.push(child); },
      appendInstallLog: async (event) => {
        if (diagnosticFailure === 'log' && event === 'app_mcp:start_failed' && diagnosticFailures === 0) {
          diagnosticFailures += 1;
          throw new Error('log failed');
        }
      },
      onMcpStartFailed: () => {
        if (diagnosticFailure === 'callback' && diagnosticFailures === 0) {
          diagnosticFailures += 1;
          throw new Error('callback failed');
        }
      },
    });

    try {
      assert.deepEqual(await manager.listenRequiredMcps(['app'], 'failed-run'), {
        servers: [],
        failures: [{ appId: 'app', code: 'app_mcp_start_failed' }],
      });
      const failedState = manager.states.get('app');
      assert.equal(failedState.status, 'down');
      assert.equal(failedState.startPromise, undefined);
      assert.equal(failedState.process, undefined);
      assert.deepEqual(terminated, [children[0]]);

      const retried = await manager.listenRequiredMcps(['app'], 'retry-run');
      assert.equal(retried.failures.length, 0);
      assert.equal(retried.servers.length, 1);
      assert.equal(retried.servers[0].appId, 'app');
      assert.equal(manager.states.get('app').status, 'up');
      assert.equal(manager.states.get('app').startPromise, undefined);
      assert.equal(children.length, 2);
    } finally {
      manager.dispose();
    }
  }
});
