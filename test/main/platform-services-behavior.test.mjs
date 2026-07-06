import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

import { createIpcMainRecorder } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const { MemoryMaintenanceManager } = require('../../dist-electron/main/memory-maintenance-manager.js');
const { RemoteActivityStore } = require('../../dist-electron/main/remote-activity-store.js');
const { AudioRuntimeBroker } = require('../../dist-electron/main/audio-runtime-broker.js');
const { AppFolderGrantStore } = require('../../dist-electron/main/app-folder-grants.js');
const { openPersonalAgentSqliteDatabase } = require('../../dist-electron/main/personal-agents/sqlite.js');
const optionalBetterSqlite = require('../../dist-electron/main/runtime/optional-better-sqlite.js');
const {
  isUnsafePermissionMode,
  codexUnsafeArgs,
  codexWorkspaceArgs,
  claudePermissionArgs,
  claudeUnsafeRootArgs,
  windowsMountedDriveRoots,
} = require('../../dist-electron/main/agent-permission-mode.js');
const { withWorkspaceLock, acquireWorkspaceLock } = require('../../dist-electron/main/llm-provider/workspace-locks.js');
const { IPC_CHANNELS } = require('../../dist-electron/shared/ipc.js');

const NATIVE_HOST_PATH = join(process.cwd(), 'dist-electron', 'main', 'tools', 'chrome-extension', 'native-host.js');

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const waitFor = async (predicate, timeoutMs = 8_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await wait(20);
  }
  throw new Error('waitFor_timeout');
};

const frameNativeMessage = (message) => {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
};

const collectNativeMessages = (buffers) => {
  const data = Buffer.concat(buffers);
  const messages = [];
  let offset = 0;
  while (data.byteLength - offset >= 4) {
    const length = data.readUInt32LE(offset);
    if (data.byteLength - offset < 4 + length) {
      break;
    }
    messages.push(JSON.parse(data.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return messages;
};

test('chrome extension native host bridges stdio frames and the local websocket', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-native-host-'));
  const received = [];
  const server = new WebSocketServer({
    port: 0,
    // A slow accept keeps the socket CONNECTING while stdin already has
    // frames, covering the queue-until-open branch.
    verifyClient: (info, done) => {
      received.push({ url: info.req.url });
      setTimeout(() => done(true), 250);
    },
  });
  await new Promise((resolveReady) => server.once('listening', resolveReady));
  const port = server.address().port;
  const configPath = join(root, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ port, token: 'token-nativo' }), 'utf8');

  const stdoutChunks = [];
  const child = spawn(process.execPath, [NATIVE_HOST_PATH, configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill('SIGKILL');
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const socketMessages = [];
  const socketPromise = new Promise((resolveSocket) => {
    server.on('connection', (socket) => {
      socket.on('message', (raw) => socketMessages.push(JSON.parse(String(raw))));
      resolveSocket(socket);
    });
  });

  // Sent before the websocket handshake finishes: must be queued.
  child.stdin.write(frameNativeMessage({ type: 'early', id: 1 }));

  const socket = await socketPromise;
  await waitFor(() => socketMessages.length >= 1);
  assert.deepEqual(socketMessages[0], { type: 'early', id: 1 });
  assert.match(received[0].url, /token=token-nativo/);

  // A frame split across chunks still parses once complete.
  const frame = frameNativeMessage({ type: 'split', id: 2 });
  child.stdin.write(frame.subarray(0, 6));
  await wait(50);
  child.stdin.write(frame.subarray(6));
  await waitFor(() => socketMessages.length >= 2);
  assert.deepEqual(socketMessages[1], { type: 'split', id: 2 });

  // Garbage native frames are logged, not fatal.
  const garbage = Buffer.from('esto no es json', 'utf8');
  const garbageHeader = Buffer.alloc(4);
  garbageHeader.writeUInt32LE(garbage.byteLength, 0);
  child.stdin.write(Buffer.concat([garbageHeader, garbage]));

  // Messages from the websocket surface as framed stdout messages; broken
  // payloads only log.
  socket.send(JSON.stringify({ type: 'respuesta', ok: true }));
  socket.send('tampoco es json');
  await waitFor(() => collectNativeMessages(stdoutChunks).length >= 1);
  assert.deepEqual(collectNativeMessages(stdoutChunks)[0], { type: 'respuesta', ok: true });

  const exitCode = new Promise((resolveExit) => child.once('exit', resolveExit));
  socket.close();
  assert.equal(await exitCode, 0, 'socket close exits the host cleanly');
  assert.match(Buffer.concat(stderrChunks).toString(), /forger-chrome-extension-host/);
});

test('chrome extension native host fails fast on config and connection problems', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-native-host-bad-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const runHost = (args) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [NATIVE_HOST_PATH, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('exit', (code) => resolveRun({ code, stderr: Buffer.concat(stderr).toString() }));
  });

  const missing = await runHost([]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /bridge_config_missing/);

  const invalidPath = join(root, 'invalid.json');
  await writeFile(invalidPath, JSON.stringify({ port: 'nope', token: '' }), 'utf8');
  const invalid = await runHost([invalidPath]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /bridge_config_invalid/);

  const unreachablePath = join(root, 'unreachable.json');
  await writeFile(unreachablePath, JSON.stringify({ port: 1, token: 'x' }), 'utf8');
  const unreachable = await runHost([unreachablePath]);
  assert.equal(unreachable.code, 1, 'connection errors exit with failure');
});

const writeFakeCodexCli = async (root, { message = 'Mantenimiento listo', exitCode = 0, sleepMs = 0 } = {}) => {
  const cliPath = join(root, 'bin', 'fake-codex.js');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(cliPath, [
    '#!/usr/bin/env node',
    'require("node:fs").readFileSync(0, "utf8");',
    `setTimeout(() => { console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(message)} } })); process.exit(${exitCode}); }, ${sleepMs});`,
  ].join('\n'), 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const createMaintenanceHarness = async (overrides = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-memory-maint-'));
  const runs = [];
  const logs = [];
  const released = [];
  const manager = new MemoryMaintenanceManager({
    forgerHomeRoot: root,
    codexHome: join(root, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
    getCodexAuthenticated: async () => true,
    getCodexCliPath: async () => null,
    getCodexPathEntries: async () => [],
    buildMemoryContext: async () => 'CONTEXTO-MEMORIA',
    getMemoryStore: () => ({ recordMaintenanceRun: async (input) => { runs.push(input); } }),
    appendInstallLog: async (event, payload) => { logs.push({ event, payload }); },
    releaseForgerMcpSession: (token) => released.push(token),
    ...overrides,
  });
  return {
    manager,
    root,
    runs,
    logs,
    released,
    cleanup: async () => {
      manager.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
};

test('memory maintenance skips when codex is unavailable and records reasons', async () => {
  const noAuth = await createMaintenanceHarness({ getCodexAuthenticated: async () => false });
  try {
    await noAuth.manager.runNow();
    assert.equal(noAuth.runs[0].status, 'skipped');
    assert.match(noAuth.runs[0].summary, /not connected/);
  } finally {
    await noAuth.cleanup();
  }

  const wrongRuntime = await createMaintenanceHarness({
    getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-sonnet-5', effort: 'high' }),
  });
  try {
    await wrongRuntime.manager.runNow();
    assert.match(wrongRuntime.runs[0].summary, /not the selected maintenance runtime/);
  } finally {
    await wrongRuntime.cleanup();
  }

  const noCli = await createMaintenanceHarness();
  try {
    await noCli.manager.runNow();
    assert.match(noCli.runs[0].summary, /CLI is not available/);
  } finally {
    await noCli.cleanup();
  }
});

test('memory maintenance runs codex with the memory prompt and handles failures', async () => {
  const harness = await createMaintenanceHarness();
  const cliPath = await writeFakeCodexCli(harness.root);
  try {
    const sessions = [];
    const withCli = await createMaintenanceHarness({
      getCodexCliPath: async () => cliPath,
      createForgerMcpSession: (runId) => {
        sessions.push(runId);
        return { url: 'http://127.0.0.1:1/mcp', token: 'memoria-token' };
      },
    });
    await withCli.manager.initialize();
    await withCli.manager.runNow('scheduled');
    assert.equal(withCli.runs[0].status, 'succeeded');
    assert.ok(sessions[0].startsWith('memory-maintenance-'));
    assert.deepEqual(withCli.released, ['memoria-token'], 'the MCP session is always released');
    await withCli.cleanup();

    const failingCli = await writeFakeCodexCli(harness.root, { message: 'no pude', exitCode: 3 });
    const failing = await createMaintenanceHarness({ getCodexCliPath: async () => failingCli });
    await failing.manager.runNow();
    assert.equal(failing.runs[0].status, 'failed');
    assert.ok(failing.logs.some((entry) => entry.event === 'memory:maintenance_failed'));
    await failing.cleanup();

    const slowCli = await writeFakeCodexCli(harness.root, { sleepMs: 400 });
    const busy = await createMaintenanceHarness({ getCodexCliPath: async () => slowCli });
    const first = busy.manager.runNow();
    const second = busy.manager.runNow();
    await Promise.all([first, second]);
    assert.ok(
      busy.logs.some((entry) => entry.event === 'memory:maintenance_skipped' && entry.payload.reason === 'already_running'),
      'concurrent maintenance runs are skipped',
    );
    assert.equal(busy.runs.filter((run) => run.status === 'succeeded').length, 1);
    await busy.cleanup();
  } finally {
    await harness.cleanup();
  }
});

test('remote activity store tracks app and agent lifecycles for the renderer', () => {
  const sent = [];
  let destroyed = false;
  let currentWindow = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  let now = new Date('2026-07-05T10:00:00.000Z');
  const store = new RemoteActivityStore({ getMainWindow: () => currentWindow, now: () => now });

  store.recordAppStatus({
    appId: 'finance-os',
    appName: '  Finance   OS  ',
    status: { state: 'preparing', active: true },
  });
  now = new Date('2026-07-05T10:00:01.000Z');
  store.recordAppStatus({
    appId: 'finance-os',
    appName: 'Finance OS',
    status: { state: 'active', active: true },
    requesterMobileDevice: { id: 7, name: 'iPhone' },
  });
  now = new Date('2026-07-05T10:00:02.000Z');
  const withError = store.recordAgentStatus({
    agentId: 'agente-1',
    agentName: 'Agente',
    status: {
      state: 'error',
      active: false,
      technicalCode: 'fallo en https://tunel.forger.cloud/abc con token abcdefghijklmnopqrstuvwxyz012345678',
    },
  });

  assert.equal(withError.activeCount, 1);
  assert.equal(withError.errorCount, 1);
  const agentItem = withError.activities.find((item) => item.id === 'agent:agente-1');
  assert.match(agentItem.lastError, /\[redacted-url\]/);
  assert.match(agentItem.lastError, /\[redacted-token\]/);
  const appItem = withError.activities.find((item) => item.id === 'app:finance-os');
  assert.equal(appItem.targetName, 'Finance OS', 'names are normalized');
  assert.equal(appItem.requesterMobileDevice.name, 'iPhone');
  assert.equal(appItem.startedAt, '2026-07-05T10:00:00.000Z', 'start time survives updates');

  const closed = store.recordAgentStatus({
    agentId: 'agente-1',
    agentName: 'Agente',
    status: { state: 'closed', active: false },
  });
  assert.ok(!closed.activities.some((item) => item.id === 'agent:agente-1'), 'closed activities disappear');

  const requester = store.requesterFromDeviceId(7, [
    { id: 7, kind: 'mobile', name: '', platform: 'ios' },
    { id: 9, kind: 'desktop', name: 'Escritorio' },
  ]);
  assert.deepEqual(requester, { id: 7, name: 'Mobile device', platform: 'ios' });
  assert.equal(store.requesterFromDeviceId(9, [{ id: 9, kind: 'desktop', name: 'x' }]), undefined);
  assert.equal(store.requesterFromDeviceId(undefined, []), undefined);

  assert.ok(sent.every((entry) => entry.channel === IPC_CHANNELS.remoteActivityChanged));
  const sentBefore = sent.length;
  destroyed = true;
  store.clear('app:finance-os');
  assert.equal(sent.length, sentBefore, 'destroyed windows receive nothing');
  currentWindow = null;
  const empty = store.snapshot();
  assert.deepEqual(empty.activities, []);
});

test('audio runtime broker round-trips renderer responses, timeouts, and shutdown', async (t) => {
  const { handlers, ipcMain } = createIpcMainRecorder();
  const requests = [];
  const logs = [];
  let window = {
    isDestroyed: () => false,
    webContents: { send: (_channel, payload) => requests.push(payload) },
  };
  const broker = new AudioRuntimeBroker({
    IPC_CHANNELS,
    ipcMain,
    getMainWindow: () => window,
    appendInstallLog: async (event, payload) => { logs.push({ event, payload }); },
  });
  broker.registerIpcHandlers();
  broker.registerIpcHandlers();
  const respond = (response) => handlers.get(IPC_CHANNELS.audioRuntimeBrokerResponse)(null, response);

  const devicesPromise = broker.listDevices();
  await waitFor(() => requests.length >= 1);
  await respond({
    requestId: requests[0].requestId,
    success: true,
    result: {
      inputDevices: [
        { id: 'mic-1', label: ' Micro ', kind: 'microphone', default: true, groupId: 'g1' },
        { id: 'sys-1', label: '', kind: 'system_audio', supported: false, requiresDisplayCapture: true },
        { id: '', label: 'sin id' },
        'basura',
      ],
      outputDevices: [{ id: 'out-1', label: '' }, { id: '' }],
    },
  });
  const devices = await devicesPromise;
  assert.deepEqual(devices.inputDevices.map((device) => device.id), ['mic-1', 'sys-1']);
  assert.equal(devices.inputDevices[1].label, 'System audio');
  assert.equal(devices.inputDevices[1].requiresDisplayCapture, true);
  assert.deepEqual(devices.outputDevices, [{ id: 'out-1', label: 'Speaker', kind: 'speaker', default: false, supported: true }]);

  const playPromise = broker.playAudio({ playbackId: 'p1', audioDataBase64: 'AAA', mimeType: 'audio/wav', outputDeviceId: 'out-1' });
  await waitFor(() => requests.length >= 2);
  assert.equal(requests[1].outputDeviceId, 'out-1');
  await respond({ requestId: requests[1].requestId, success: true, result: { success: true, durationSeconds: 1.5 } });
  assert.deepEqual(await playPromise, { success: true, durationSeconds: 1.5 });

  const failPromise = broker.playAudio({ playbackId: 'p2', audioDataBase64: 'AAA', mimeType: 'audio/wav' });
  await waitFor(() => requests.length >= 3);
  await respond({ requestId: requests[2].requestId, success: false, error: 'sin salida' });
  await assert.rejects(failPromise, /sin salida/);
  await respond({ requestId: 'desconocido', success: true, result: {} });

  const cancelPromise = broker.cancelPlayback('p1');
  await waitFor(() => requests.length >= 4);
  await respond({ requestId: requests[3].requestId, success: true, result: {} });
  await cancelPromise;

  window = null;
  await broker.cancelPlayback('p2');
  assert.ok(logs.some((entry) => entry.event === 'audio_runtime_broker:cancel_failed'));

  window = { isDestroyed: () => false, webContents: { send: (_c, payload) => requests.push(payload) } };
  const stopped = broker.listDevices();
  await waitFor(() => requests.length >= 5);
  broker.stop();
  await assert.rejects(stopped, /audio_runtime_broker_stopped/);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const timedOut = broker.listDevices();
    t.mock.timers.tick(30_001);
    await assert.rejects(timedOut, /audio_runtime_broker_timeout/);
  } finally {
    t.mock.timers.reset();
  }
});

test('app folder grants persist, dedupe, revoke, and validate resolved paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-grants-'));
  try {
    const folder = join(root, 'compartida');
    await mkdir(folder, { recursive: true });
    const store = new AppFolderGrantStore(root);

    const created = await store.create('finance-os', folder);
    assert.equal(created.name, 'compartida');
    assert.equal(created.access, 'readWrite');

    const reused = await store.create('finance-os', folder);
    assert.equal(reused.grantId, created.grantId, 'same real path reuses the grant');
    assert.deepEqual((await store.list('finance-os')).map((grant) => grant.grantId), [created.grantId]);
    assert.deepEqual(await store.list('otra-app'), []);

    const resolved = await store.resolve('finance-os', created.grantId);
    assert.equal(resolved.realPath, await (await import('node:fs/promises')).realpath(folder));

    const fresh = new AppFolderGrantStore(root);
    assert.equal((await fresh.list('finance-os')).length, 1, 'grants survive reloads');

    await rm(folder, { recursive: true, force: true });
    await assert.rejects(store.resolve('finance-os', created.grantId), /folder_grant_path_missing/);

    assert.deepEqual(await store.revoke('finance-os', created.grantId), { revoked: true });
    assert.deepEqual(await store.revoke('finance-os', created.grantId), { revoked: false });
    assert.deepEqual(await store.list('finance-os'), []);
    await assert.rejects(store.resolve('finance-os', created.grantId), /folder_grant_not_found/);

    await writeFile(join(root, 'app-folder-grants.json'), JSON.stringify({ grants: [{ malformado: true }, null] }), 'utf8');
    const corrupt = new AppFolderGrantStore(root);
    assert.deepEqual(await corrupt.list('finance-os'), [], 'malformed grants are dropped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent permission mode maps to provider CLI arguments', () => {
  assert.equal(isUnsafePermissionMode('unsafe'), true);
  assert.equal(isUnsafePermissionMode('safe'), false);
  assert.equal(isUnsafePermissionMode('cualquier-cosa'), false);
  assert.deepEqual(codexUnsafeArgs('unsafe'), ['--dangerously-bypass-approvals-and-sandbox']);
  assert.deepEqual(codexUnsafeArgs(), []);
  assert.deepEqual(codexWorkspaceArgs('unsafe'), []);
  assert.deepEqual(codexWorkspaceArgs(), ['--sandbox', 'workspace-write']);
  assert.deepEqual(claudePermissionArgs(), ['--permission-mode', 'acceptEdits']);
  const unsafe = claudePermissionArgs('unsafe');
  assert.deepEqual(unsafe.slice(0, 2), ['--permission-mode', 'bypassPermissions']);
  assert.ok(unsafe.includes('--add-dir'));
  assert.deepEqual(claudeUnsafeRootArgs('darwin'), ['--add-dir', '/']);

  const originalSystemDrive = process.env.SystemDrive;
  const originalSystemRoot = process.env.SystemRoot;
  process.env.SystemDrive = 'C:';
  process.env.SystemRoot = 'C:\\Windows';
  try {
    const windowsArgs = claudeUnsafeRootArgs('win32');
    assert.ok(windowsArgs.length >= 2 && windowsArgs[0] === '--add-dir');
    assert.ok(windowsMountedDriveRoots().some((rootPath) => rootPath.startsWith('C:')));
  } finally {
    if (originalSystemDrive === undefined) delete process.env.SystemDrive; else process.env.SystemDrive = originalSystemDrive;
    if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot;
  }
});

test('workspace locks serialize work per key and tolerate failures and double release', async () => {
  const order = [];
  const first = withWorkspaceLock('clave', async () => {
    await wait(60);
    order.push('primero');
    return 1;
  });
  const second = withWorkspaceLock(' clave ', async () => {
    order.push('segundo');
    return 2;
  });
  const other = withWorkspaceLock('otra', async () => {
    order.push('paralela');
    return 3;
  });
  assert.deepEqual(await Promise.all([first, second, other]), [1, 2, 3]);
  assert.equal(order.indexOf('primero') < order.indexOf('segundo'), true, 'same key runs in order');

  await assert.rejects(withWorkspaceLock('clave', async () => { throw new Error('adentro'); }), /adentro/);
  const afterFailure = await withWorkspaceLock('clave', async () => 'sigue');
  assert.equal(afterFailure, 'sigue', 'a failed holder does not poison the lock');

  const release = await acquireWorkspaceLock('');
  let acquired = false;
  const pending = acquireWorkspaceLock('default').then((releaseSecond) => {
    acquired = true;
    releaseSecond();
  });
  await wait(30);
  assert.equal(acquired, false, 'empty keys share the default lock');
  release();
  release();
  await pending;
  assert.equal(acquired, true);
});

test('personal agent sqlite opens with better-sqlite3 and falls back to node:sqlite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-sqlite-'));
  const originalLoader = optionalBetterSqlite.loadOptionalBetterSqlite;
  try {
    const native = openPersonalAgentSqliteDatabase(join(root, 'agents.db'));
    assert.ok(native, 'better-sqlite3 opens when available');
    native.exec('CREATE TABLE t (id TEXT)');
    native.prepare('INSERT INTO t (id) VALUES (?)').run('a');
    assert.equal(native.prepare('SELECT COUNT(*) as c FROM t').get().c, 1);

    optionalBetterSqlite.loadOptionalBetterSqlite = () => null;
    const fallback = openPersonalAgentSqliteDatabase(join(root, 'fallback.db'));
    assert.ok(fallback, 'node:sqlite fallback opens a database');
    fallback.exec('CREATE TABLE f (id TEXT)');

    optionalBetterSqlite.loadOptionalBetterSqlite = () => function BrokenDriver() {
      throw new Error('driver roto');
    };
    const recovered = openPersonalAgentSqliteDatabase(join(root, 'recovered.db'));
    assert.ok(recovered, 'a broken native driver falls through to node:sqlite');
  } finally {
    optionalBetterSqlite.loadOptionalBetterSqlite = originalLoader;
    await rm(root, { recursive: true, force: true });
  }
});
