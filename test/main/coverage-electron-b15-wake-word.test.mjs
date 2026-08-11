import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WakeWordServiceManager,
  normalizeWakeWordConfig,
} = require('../../dist-electron/main/wake-word-service.js');

const completeMarker = {
  installedAt: '2026-08-10T00:00:00.000Z',
  schemaVersion: 1,
  dependencies: ['fastapi', 'uvicorn', 'openwakeword', 'onnxruntime', 'numpy'],
};

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const makeHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-wake-b15-'));
  const logs = [];
  const detections = [];
  let nextPort = 46810;
  const deps = {
    appendInstallLog: async (event, payload = {}) => logs.push({ event, payload }),
    ensureRuntimeInstalled: async () => ({ python: process.execPath }),
    fs,
    getFreePort: async () => nextPort++,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getServiceSourcePath: () => path.join(root, 'wake-server.js'),
    path,
    runCommand: async () => undefined,
    onWakeDetected: (event) => detections.push(event),
    ...overrides,
  };
  const manager = new WakeWordServiceManager(deps);
  const wakeRoot = path.join(root, 'metadata', 'wake-word');
  return {
    root,
    wakeRoot,
    manager,
    deps,
    logs,
    detections,
    async markInstalled(marker = completeMarker) {
      await fs.mkdir(wakeRoot, { recursive: true });
      await fs.writeFile(path.join(wakeRoot, 'installed.json'), JSON.stringify(marker));
    },
    async prepareExecutable() {
      const python = process.platform === 'win32'
        ? path.join(wakeRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(wakeRoot, '.venv', 'bin', 'python');
      await fs.mkdir(path.dirname(python), { recursive: true });
      await fs.symlink(process.execPath, python).catch(async () => fs.copyFile(process.execPath, python));
      await fs.writeFile(deps.getServiceSourcePath(), 'setInterval(() => {}, 1000);');
    },
    cleanup: async () => {
      manager.stop();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    },
  };
};

test('given malformed configuration, normalization clamps numeric bounds and accepts only known models', () => {
  assert.deepEqual(normalizeWakeWordConfig(null), {
    enabled: false,
    deviceId: '',
    modelId: 'hey jarvis',
    threshold: 0.5,
    patience: 2,
    cooldownMs: 2500,
  });
  const normalized = normalizeWakeWordConfig({
    enabled: true,
    deviceId: `  ${'d'.repeat(200)}  `,
    modelId: 'hey_mycroft',
    threshold: 5,
    patience: -4,
    cooldownMs: 100_000,
  });
  assert.equal(normalized.deviceId.length, 160);
  assert.equal(normalized.modelId, 'hey mycroft');
  assert.equal(normalized.threshold, 0.99);
  assert.equal(normalized.patience, 1);
  assert.equal(normalized.cooldownMs, 60_000);
  assert.equal(normalizeWakeWordConfig({ modelId: 3, threshold: 'bad' }).modelId, 'hey jarvis');
  assert.equal(normalizeWakeWordConfig({ modelId: 'alexa', threshold: 0.01, patience: 9, cooldownMs: 1 }).threshold, 0.05);
});

test('given disabled, missing, or repair-required installation state, startup stays stopped with explicit state', async () => {
  const harness = await makeHarness();
  try {
    assert.equal((await harness.manager.startIfConfigured()).status, 'not_installed');
    assert.equal((await harness.manager.start()).running, false);

    await harness.markInstalled({ schemaVersion: 0, dependencies: [] });
    const repair = await harness.manager.start();
    assert.equal(repair.repairRequired, true);
    assert.equal(repair.lastError, 'wake_word_repair_required');

    harness.manager.lastError = undefined;
    await harness.markInstalled({ schemaVersion: 1, dependencies: ['fastapi', 12, 'uvicorn'] });
    const partial = await harness.manager.getState();
    assert.equal(partial.dependencyIssues.some((issue) => issue.dependency === 'numpy'), true);
    await harness.markInstalled({ schemaVersion: 1, dependencies: null });
    assert.equal((await harness.manager.getState()).dependencyIssues.length, completeMarker.dependencies.length);
  } finally {
    await harness.cleanup();
  }
});

test('given concurrent startup, one service process is shared and reaches the audio-session boundary', async () => {
  const harness = await makeHarness();
  let releaseHealth;
  try {
    await harness.markInstalled();
    await harness.prepareExecutable();
    harness.manager.waitForHealth = async () => await new Promise((resolve) => { releaseHealth = resolve; });

    const first = harness.manager.start();
    const second = harness.manager.start();
    while (!releaseHealth) await new Promise((resolve) => setImmediate(resolve));
    releaseHealth();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.running, true);
    assert.equal(right.running, true);
    assert.equal(left.runtime.state, 'waiting_for_audio_session');

    const child = harness.manager.child;
    const repeated = await harness.manager.start();
    assert.equal(repeated.running, true);
    assert.equal(harness.manager.child, child);
    child.stderr.emit('data', ' wake diagnostic ');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.logs.at(-1).event, 'wake_word:stderr');
    harness.manager.stop();
    child.emit('error', new Error('late process error'));
    assert.equal(harness.manager.lastError, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('given process exit, spawn error, or health failure, runtime resources are cleared and errors are sanitized', async () => {
  for (const outcome of ['exit-ok', 'exit-error', 'spawn-empty-error', 'health-error', 'health-string']) {
    const harness = await makeHarness();
    try {
      await harness.markInstalled();
      await harness.prepareExecutable();
      harness.manager.waitForHealth = async () => {
        if (outcome === 'health-error') throw new Error('health unavailable');
        if (outcome === 'health-string') throw 'health unavailable';
      };
      const state = await harness.manager.start();
      if (outcome.startsWith('health')) {
        assert.equal(state.running, false);
        assert.equal(state.lastError, outcome === 'health-error' ? 'health unavailable' : 'wake_word_health_failed');
        continue;
      }
      const child = harness.manager.child;
      if (outcome === 'exit-ok') child.emit('exit', 0);
      if (outcome === 'exit-error') child.emit('exit', 7);
      if (outcome === 'spawn-empty-error') child.emit('error', { message: '' });
      assert.equal(harness.manager.child, null);
      assert.equal(harness.manager.port, null);
      assert.equal(harness.manager.token, null);
      if (outcome === 'exit-ok') assert.equal(harness.manager.lastError, undefined);
      if (outcome === 'exit-error') assert.equal(harness.manager.lastError, 'wake_word_server_exited_7');
      if (outcome === 'spawn-empty-error') assert.equal(harness.manager.lastError, 'wake_word_spawn_failed');
    } finally {
      await harness.cleanup();
    }
  }
});

test('given configuration transitions, enable starts, disable stops, and capture changes request a fresh session', async () => {
  const harness = await makeHarness();
  let starts = 0;
  try {
    harness.manager.start = async () => {
      starts += 1;
      return await harness.manager.getState();
    };
    await harness.manager.updateConfig({ enabled: true });
    assert.equal(starts, 1);

    const fakeChild = new EventEmitter();
    fakeChild.pid = undefined;
    fakeChild.kill = () => true;
    harness.manager.child = fakeChild;
    harness.manager.port = 1;
    harness.manager.token = 'token';
    await harness.manager.updateConfig({ enabled: true, deviceId: 'mic-2' });
    assert.equal(harness.manager.runtime.state, 'waiting_for_audio_session');

    harness.manager.runtime = { state: 'ready', modelId: 'hey jarvis', updatedAt: 'now' };
    await harness.manager.updateConfig({ enabled: true });
    assert.equal(harness.manager.runtime.state, 'ready');
    await harness.manager.updateConfig({ enabled: false });
    assert.equal(harness.manager.child, null);
    assert.equal(harness.manager.runtime.state, 'idle');
  } finally {
    await harness.cleanup();
  }
});

test('given session creation, installation and runtime preconditions produce distinct errors and a scoped token', async () => {
  const harness = await makeHarness();
  try {
    harness.manager.start = async () => ({ installed: false, repairRequired: false, running: false });
    await assert.rejects(() => harness.manager.createSession(), /wake_word_not_installed/);
    harness.manager.start = async () => ({ installed: true, repairRequired: false, running: false });
    await assert.rejects(() => harness.manager.createSession(), /wake_word_not_running/);
    harness.manager.start = async () => ({ installed: true, repairRequired: true, running: false });
    await assert.rejects(() => harness.manager.createSession(), /wake_word_repair_required/);

    harness.manager.port = 4567;
    harness.manager.token = 'secret';
    harness.manager.config = normalizeWakeWordConfig({ deviceId: 'mic' });
    harness.manager.start = async () => ({ installed: true, repairRequired: false, running: true });
    const session = await harness.manager.createSession();
    assert.match(session.sessionId, /^[0-9a-f-]+$/);
    assert.equal(session.url, 'ws://127.0.0.1:4567/v1/wake-word/listen');
    assert.equal(session.token, 'secret');
  } finally {
    await harness.cleanup();
  }
});

test('given renderer runtime events, readiness, unavailability, confidence, detection, and diagnostics are normalized', async () => {
  const harness = await makeHarness();
  try {
    await harness.manager.updateConfig({ deviceId: '', modelId: 'hey jarvis' });
    let state = await harness.manager.recordReady({ modelId: ' alexa ', confidence: 2 });
    assert.equal(state.runtime.modelId, 'alexa');
    assert.equal(state.runtime.confidence, 1);
    assert.equal(state.lastError, undefined);
    state = await harness.manager.recordReady();
    assert.equal(state.runtime.modelId, 'hey jarvis');
    assert.equal('confidence' in state.runtime, false);

    state = await harness.manager.recordUnavailable({ modelId: '', technicalCode: ' mic_missing ' });
    assert.equal(state.runtime.technicalCode, 'mic_missing');
    assert.equal(state.lastError, 'mic_missing');
    state = await harness.manager.recordUnavailable();
    assert.equal(state.lastError, 'mic_missing');

    state = await harness.manager.recordConfidence({ modelId: '', confidence: -1 });
    assert.equal(state.status, 'error');
    assert.equal(state.runtime.state, 'ready');
    harness.manager.lastError = undefined;
    harness.manager.runtime.state = 'detected';
    state = await harness.manager.recordConfidence({ confidence: 0.25 });
    assert.equal(state.runtime.state, 'detected');

    state = await harness.manager.recordDetected({ deviceId: '', modelId: '', confidence: 'bad' });
    assert.equal(state.lastDetection.deviceId, 'default');
    assert.equal(state.lastDetection.confidence, 1);
    assert.equal(harness.detections.length, 1);

    await harness.manager.recordDiagnostic({
      event: '',
      modelId: '',
      deviceId: '',
      technicalCode: ' code ',
      generation: 2,
      socketState: ' open ',
      audioTrackCount: 1,
      sampleRate: 16_000,
      frameBytes: 640,
    });
    await harness.manager.recordDiagnostic({ event: 'simple' });
    assert.equal(harness.logs.some((entry) => entry.event === 'wake_word:renderer:diagnostic'), true);
    assert.equal(harness.logs.some((entry) => entry.event === 'wake_word:renderer:simple'), true);
  } finally {
    await harness.cleanup();
  }
});

test('given every runtime phase, state reports error, detected, ready, listening, starting, installed, and absent statuses', async () => {
  const harness = await makeHarness();
  try {
    assert.equal((await harness.manager.getState()).status, 'not_installed');
    await harness.markInstalled();
    assert.equal((await harness.manager.getState()).status, 'installed');
    harness.manager.starting = true;
    assert.equal((await harness.manager.getState()).status, 'starting');
    harness.manager.starting = false;
    harness.manager.child = {};
    harness.manager.port = 1;
    harness.manager.token = 'token';
    assert.equal((await harness.manager.getState()).status, 'listening');
    harness.manager.runtime.state = 'ready';
    assert.equal((await harness.manager.getState()).status, 'ready');
    harness.manager.runtime.state = 'detected';
    assert.equal((await harness.manager.getState()).status, 'detected');
    harness.manager.lastError = 'broken';
    assert.equal((await harness.manager.getState()).status, 'error');
  } finally {
    harness.manager.child = null;
    await harness.cleanup();
  }
});

test('given health polling and HTTP boundaries, success, retry, timeout, authorization, and response errors are explicit', async () => {
  const harness = await makeHarness();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalNow = Date.now;
  try {
    await assert.rejects(() => harness.manager.fetchJson('/health'), /wake_word_not_running/);
    harness.manager.port = 1234;
    harness.manager.token = 'token';
    let attempts = 0;
    globalThis.fetch = async (_url, options) => {
      attempts += 1;
      assert.equal(options.headers.Authorization, 'Bearer token');
      if (attempts === 1) throw new Error('warming');
      if (attempts === 2) return new Response('no', { status: 503 });
      return Response.json({ ok: true });
    };
    globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
    await harness.manager.waitForHealth(10_000);
    assert.equal(attempts, 3);

    let now = 0;
    Date.now = () => { now += 10; return now; };
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(() => harness.manager.waitForHealth(15), /wake_word_health_timeout/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalNow;
    await harness.cleanup();
  }
});

test('given installation on POSIX and Windows, venv paths, environment, dependency validation, and marker persistence stay scoped', async () => {
  for (const platform of ['darwin', 'win32']) {
    const commands = [];
    const harness = await makeHarness({
      runCommand: async (command, args, options) => {
        commands.push({ command, args, options });
        if (args.includes('venv')) {
          const target = platform === 'win32'
            ? path.join(args.at(-1), 'Scripts', 'python.exe')
            : path.join(args.at(-1), 'bin', 'python');
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, '');
        }
      },
    });
    try {
      harness.manager.getState = async () => ({ installed: true });
      const state = await withPlatform(platform, () => harness.manager.install());
      assert.equal(state.installed, true);
      assert.equal(commands.length, 3);
      assert.match(commands[1].options.env.HF_HOME, /models$/);
      const marker = JSON.parse(await fs.readFile(path.join(harness.wakeRoot, 'installed.json'), 'utf8'));
      assert.deepEqual(marker.dependencies, completeMarker.dependencies);
    } finally {
      await harness.cleanup();
    }
  }
});
