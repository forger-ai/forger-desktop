import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const { SpeechToTextServiceManager } = require('../../dist-electron/main/speech-to-text-service.js');

const INSTALL_MARKER = {
  installedAt: '2026-08-10T00:00:00.000Z',
  schemaVersion: 3,
  dependencies: ['fastapi', 'uvicorn', 'python-multipart', 'faster-whisper'],
};

const createFakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = true;
  child.kill = () => { child.killed = true; return true; };
  return child;
};

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-speech-b11-'));
  const installLogs = [];
  const commands = [];
  let nextPort = 46100;
  const deps = {
    appendInstallLog: async (event, payload) => installLogs.push({ event, payload }),
    ensureRuntimeInstalled: async () => ({ python: process.execPath }),
    fs,
    getFreePort: async () => nextPort++,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getPrivateAppsRoot: () => path.join(root, 'apps'),
    getPrivateDataRoot: () => path.join(root, 'data'),
    getServiceSourcePath: () => path.join(root, 'speech-server.py'),
    path,
    onDemandModelIdleTimeoutMs: 1,
    runCommand: async (command, args, options) => commands.push({ command, args, options }),
    ...overrides,
  };
  const manager = new SpeechToTextServiceManager(deps);
  const speechRoot = path.join(root, 'metadata', 'speech-to-text');
  return {
    root,
    speechRoot,
    deps,
    manager,
    installLogs,
    commands,
    install: async (marker = INSTALL_MARKER) => {
      await fs.mkdir(speechRoot, { recursive: true });
      await fs.writeFile(path.join(speechRoot, 'installed.json'), JSON.stringify(marker));
    },
    cleanup: async () => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }),
  };
};

const runningManager = (manager, port = 46100, token = 'secret-token') => {
  manager.child = { killed: true, kill: () => true };
  manager.port = port;
  manager.token = token;
};

test('given persisted service data, state normalization keeps safe jobs, files, health, and cached models', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    await harness.install();
    await fs.writeFile(path.join(harness.speechRoot, 'config.json'), JSON.stringify({
      model: ' custom-model ',
      maxConcurrentJobs: 99.8,
      maxRealtimeSessions: -4,
      autoStart: true,
    }));
    const modelRoot = path.join(harness.speechRoot, 'models');
    await fs.mkdir(path.join(modelRoot, 'nested', 'models--Systran--faster-whisper-small'), { recursive: true });
    await fs.mkdir(path.join(modelRoot, 'tiny'), { recursive: true });
    await fs.writeFile(path.join(modelRoot, 'not-a-model'), 'file');
    runningManager(harness.manager);

    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({ ok: false });
      if (pathname === '/v1/jobs') return Response.json({
        jobs: [
          null,
          [],
          { id: null, path: '/missing-id.wav' },
          { id: 'missing-path', path: null },
          { id: 'queued', path: '/queued.wav', task: 'translate', status: 'queued', createdAt: null, updatedAt: null, durationSeconds: 2, sizeBytes: 4, language: 'es', model: 'small', text: 'hola', error: 'pending', technicalCode: 'pending_code' },
          { id: 'running', path: '/running.wav', status: 'running' },
          { id: 'failed', path: '/failed.wav', status: 'unknown' },
          { id: 'done', path: '/done.wav', status: 'completed' },
        ],
      });
      return Response.json({
        processedFiles: [
          null,
          [],
          { path: null },
          { path: '/done.wav', task: 'translate', processedAt: null, durationSeconds: 2, sizeBytes: 4, language: 'es', model: 'small', textPreview: 'hola' },
        ],
      });
    };

    const state = await harness.manager.getState();
    assert.deepEqual(state.config, { model: 'custom-model', maxConcurrentJobs: 8, maxRealtimeSessions: 1, autoStart: true });
    assert.deepEqual(state.queue.map((job) => [job.id, job.status]), [
      ['queued', 'queued'],
      ['running', 'running'],
      ['failed', 'failed'],
    ]);
    assert.equal(state.queue[0].technicalCode, 'pending_code');
    assert.deepEqual(state.processedFiles, [{
      path: '/done.wav',
      task: 'translate',
      processedAt: '',
      durationSeconds: 2,
      sizeBytes: 4,
      language: 'es',
      model: 'small',
      textPreview: 'hola',
    }]);
    assert.deepEqual(state.health, {
      ok: false,
      model: 'custom-model',
      activeJobs: 0,
      queuedJobs: 0,
      activeRealtimeSessions: 0,
      realtimeQueueDepth: 0,
      realtimeActiveJobs: 0,
      lastRealtimeFactor: 0,
      vadMode: undefined,
    });
    assert.equal(state.modelOptions.find((option) => option.id === 'tiny').installed, true);
    assert.equal(state.modelOptions.find((option) => option.id === 'small').installed, true);
    assert.equal(state.modelOptions.find((option) => option.id === 'custom-model').installed, false);
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given local persisted history, stopped state accepts arrays and rejects malformed history safely', async () => {
  const harness = await createHarness();
  try {
    await harness.install({ ...INSTALL_MARKER, dependencies: ['fastapi', 4] });
    await fs.writeFile(path.join(harness.speechRoot, 'processed-files.json'), JSON.stringify([{ path: '/safe.wav' }]));
    let state = await harness.manager.getState();
    assert.equal(state.repairRequired, true);
    assert.equal(state.dependencyIssues.length, 3);
    assert.deepEqual(state.processedFiles, [{ path: '/safe.wav' }]);

    await fs.writeFile(path.join(harness.speechRoot, 'processed-files.json'), JSON.stringify({ processedFiles: [] }));
    state = await harness.manager.getState();
    assert.deepEqual(state.processedFiles, []);
    await fs.writeFile(path.join(harness.speechRoot, 'processed-files.json'), '{bad json');
    assert.deepEqual((await harness.manager.getState()).processedFiles, []);
    assert.equal(await harness.manager.isInstalled(), true);
    await harness.install({ installedAt: 'now', dependencies: 'invalid' });
    assert.equal((await harness.manager.getState()).dependencyIssues.length, 4);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given app permission and a running service, environment and realtime session expose only loopback credentials', async () => {
  const harness = await createHarness();
  try {
    harness.manager.start = async () => ({ installed: false, running: false, repairRequired: false });
    await assert.rejects(() => harness.manager.createRealtimeSession(), /speech_to_text_not_installed/);
    harness.manager.start = async () => ({ installed: true, running: false, repairRequired: false });
    await assert.rejects(() => harness.manager.createRealtimeSession(), /speech_to_text_not_running/);
    harness.manager.start = async () => ({ installed: true, running: false, repairRequired: true });
    await assert.rejects(() => harness.manager.createRealtimeSession(), /speech_to_text_repair_required/);

    runningManager(harness.manager, 46222, 'realtime-token');
    harness.manager.start = async () => ({ installed: true, running: true, repairRequired: false });
    assert.deepEqual(harness.manager.environmentForApp(true), {
      FORGER_SPEECH_TO_TEXT_URL: 'http://127.0.0.1:46222',
      FORGER_SPEECH_TO_TEXT_TOKEN: 'realtime-token',
    });
    assert.deepEqual(harness.manager.environmentForApp(false), {});
    assert.deepEqual(await harness.manager.createRealtimeSession(), {
      url: 'ws://127.0.0.1:46222/v1/realtime/transcribe',
      token: 'realtime-token',
      sampleRate: 16000,
      format: 'pcm_s16le',
    });
  } finally {
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given a valid installation, concurrent starts share one spawn and sanitize child diagnostics', async () => {
  const harness = await createHarness();
  const originalSpawn = childProcess.spawn;
  const spawned = [];
  let releaseHealth;
  let announceSpawn;
  const didSpawn = new Promise((resolve) => { announceSpawn = resolve; });
  try {
    await harness.install();
    childProcess.spawn = (...args) => {
      const child = createFakeChild();
      spawned.push({ child, args });
      announceSpawn();
      return child;
    };
    harness.manager.waitForHealth = async () => await new Promise((resolve) => { releaseHealth = resolve; });
    harness.manager.getState = async () => ({ installed: true, running: true, repairRequired: false });

    const first = harness.manager.start();
    const second = harness.manager.start();
    await didSpawn;
    assert.equal(spawned.length, 1);
    releaseHealth();
    assert.deepEqual(await Promise.all([first, second]), [
      { installed: true, running: true, repairRequired: false },
      { installed: true, running: true, repairRequired: false },
    ]);

    const child = spawned[0].child;
    const serviceLogs = [];
    harness.manager.appendServiceLog = async (event, payload) => serviceLogs.push({ event, payload });
    child.stdout.write('Bearer private-token /Users/private/audio.wav');
    child.stdout.write('');
    child.stderr.write('FORGER_SPEECH_TOKEN=private token=query&token=private');
    assert.match(serviceLogs[0].payload.diagnostic, /Bearer \[redacted\]/);
    assert.match(serviceLogs[0].payload.diagnostic, /\/Users\/\[redacted\]/);
    assert.doesNotMatch(serviceLogs[0].payload.diagnostic, /private-token/);

    child.emit('exit', 2);
    assert.equal(harness.manager.lastError, 'speech_server_exited_2');
    child.emit('exit', 0);
    assert.equal(harness.manager.lastError, undefined);
    child.emit('exit', null);
    assert.equal(harness.manager.lastError, undefined);
    child.emit('error', new Error(''));
    assert.equal(harness.manager.lastError, 'speech_server_spawn_failed');
  } finally {
    childProcess.spawn = originalSpawn;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given failed health checks, default startup reports repair and health failures without leaking processes', async () => {
  const originalSpawn = childProcess.spawn;
  const harness = await createHarness();
  try {
    await harness.install({ ...INSTALL_MARKER, dependencies: [] });
    let state = await harness.manager.start();
    assert.equal(state.repairRequired, true);
    assert.equal(state.lastError, 'speech_to_text_repair_required');

    await harness.install();
    const child = createFakeChild();
    childProcess.spawn = () => child;
    harness.manager.waitForHealth = async () => { throw 'health unavailable'; };
    harness.manager.getState = async () => ({ installed: true, running: false, repairRequired: false, lastError: harness.manager.lastError });
    state = await harness.manager.start();
    assert.equal(state.lastError, 'speech_health_failed');
    assert.equal(harness.manager.child, null);

    harness.manager.waitForHealth = async () => { throw new Error('health detail'); };
    state = await harness.manager.start();
    assert.equal(state.lastError, 'health detail');
  } finally {
    childProcess.spawn = originalSpawn;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given deterministic time, health polling retries once and reports both timeout contracts', async () => {
  const harness = await createHarness();
  const originalSetTimeout = globalThis.setTimeout;
  try {
    let calls = 0;
    harness.manager.fetchJson = async () => {
      calls += 1;
      if (calls === 1) throw new Error('booting');
      return { ok: true };
    };
    globalThis.setTimeout = (callback) => { callback(); return { unref() {} }; };
    await harness.manager.waitForHealth(10_000);
    assert.equal(calls, 2);
    await assert.rejects(() => harness.manager.waitForHealth(0), /speech_health_timeout/);

    const worker = { port: 46101, token: 'worker-token' };
    calls = 0;
    await harness.manager.waitForWorkerHealth(worker, 10_000);
    assert.equal(calls, 2);
    await assert.rejects(() => harness.manager.waitForWorkerHealth(worker, 0), /speech_model_worker_health_timeout/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given model-worker installation states, startup rejects unsafe states and reuses live workers', async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(() => harness.manager.startModelWorker('small'), /speech_to_text_not_installed/);
    await harness.install({ ...INSTALL_MARKER, dependencies: ['fastapi'] });
    await assert.rejects(() => harness.manager.startModelWorker('small'), /speech_to_text_repair_required/);
    await harness.install();

    const promised = { model: 'small', status: 'starting', startPromise: Promise.resolve({ model: 'small', status: 'ready' }) };
    harness.manager.modelWorkers.set('small', promised);
    assert.equal((await harness.manager.startModelWorker('small')).status, 'ready');

    let cleared = false;
    const idleTimer = setTimeout(() => {}, 10_000);
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = (timer) => { if (timer === idleTimer) cleared = true; return originalClearTimeout(timer); };
    try {
      const live = { model: 'small', child: { killed: true }, port: 46101, token: 'worker', status: 'idle', pinned: false, activeJobs: 0, queuedJobs: 0, idleTimer };
      harness.manager.modelWorkers.set('small', live);
      assert.equal((await harness.manager.startModelWorker('small')).status, 'ready');
      assert.equal(cleared, true);
      live.status = 'busy';
      assert.equal((await harness.manager.startModelWorker('small')).status, 'busy');
    } finally {
      globalThis.clearTimeout = originalClearTimeout;
    }
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given a spawned model worker, events and health failures produce deterministic worker states', async () => {
  const harness = await createHarness();
  const originalSpawn = childProcess.spawn;
  const children = [];
  try {
    await harness.install();
    childProcess.spawn = () => {
      const child = createFakeChild();
      children.push(child);
      return child;
    };
    harness.manager.waitForWorkerHealth = async () => undefined;
    const readyWorker = { model: 'small', child: null, port: null, token: null, status: 'stopped', pinned: false, activeJobs: 0, queuedJobs: 0 };
    assert.equal((await harness.manager.startModelWorkerInternal(readyWorker)).status, 'ready');
    children[0].stdout.write('Bearer worker-secret');
    children[0].stderr.write('/Users/person/model');
    children[0].emit('exit', 3);
    assert.equal(readyWorker.status, 'error');
    assert.equal(readyWorker.technicalCode, 'speech_model_worker_exited_3');
    children[0].emit('exit', 0);
    assert.equal(readyWorker.status, 'stopped');
    children[0].emit('exit', null);
    assert.equal(readyWorker.status, 'stopped');
    children[0].emit('error', new Error(''));
    assert.equal(readyWorker.technicalCode, 'speech_model_worker_spawn_failed');

    const failedWorker = { model: 'medium', child: null, port: null, token: null, status: 'stopped', pinned: false, activeJobs: 0, queuedJobs: 0 };
    harness.manager.waitForWorkerHealth = async () => { throw 'worker health unknown'; };
    await assert.rejects(() => harness.manager.startModelWorkerInternal(failedWorker), (error) => error === 'worker health unknown');
    assert.equal(failedWorker.status, 'error');
    assert.equal(failedWorker.technicalCode, 'speech_model_worker_health_failed');

    const detailedWorker = { model: 'large-v3', child: null, port: null, token: null, status: 'stopped', pinned: false, activeJobs: 0, queuedJobs: 0 };
    harness.manager.waitForWorkerHealth = async () => { throw new Error('worker health detail'); };
    await assert.rejects(() => harness.manager.startModelWorkerInternal(detailedWorker), /worker health detail/);
    assert.equal(detailedWorker.technicalCode, 'worker health detail');
  } finally {
    childProcess.spawn = originalSpawn;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given worker activity, idle scheduling honors pinning and stops only truly idle models', async () => {
  const harness = await createHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const callbacks = [];
  try {
    globalThis.setTimeout = (callback) => { callbacks.push(callback); return { id: callbacks.length }; };
    const pinned = { model: 'tiny', pinned: true, status: 'idle', child: null, port: null, token: null, activeJobs: 0, queuedJobs: 0 };
    harness.manager.scheduleModelWorkerIdleStop(pinned);
    assert.equal(callbacks.length, 0);

    const worker = { model: 'small', pinned: false, status: 'idle', child: { killed: true }, port: 1, token: 't', activeJobs: 1, queuedJobs: 0, idleTimer: { old: true }, lastUsedAt: 'now', technicalCode: 'old' };
    harness.manager.scheduleModelWorkerIdleStop(worker);
    callbacks.at(-1)();
    assert.equal(worker.status, 'idle');
    worker.activeJobs = 0;
    worker.queuedJobs = 1;
    callbacks.at(-1)();
    assert.equal(worker.status, 'idle');
    worker.queuedJobs = 0;
    worker.status = 'busy';
    callbacks.at(-1)();
    assert.equal(worker.status, 'busy');
    worker.status = 'idle';
    callbacks.at(-1)();
    assert.equal(worker.status, 'stopped');

    worker.idleTimer = { pending: true };
    harness.manager.stopModelWorker(worker, 'error');
    assert.equal(worker.status, 'error');
    harness.manager.modelWorkers.set('small', worker);
    harness.manager.modelWorkers.set('base', { ...worker, model: 'base', status: 'ready' });
    harness.manager.modelWorkers.set('medium', { ...worker, model: 'medium', status: 'ready', lastUsedAt: undefined, technicalCode: undefined });
    harness.manager.child = { killed: true };
    harness.manager.port = 1;
    harness.manager.token = 't';
    harness.manager.starting = true;
    const workers = harness.manager.buildModelWorkers({ activeJobs: 1, queuedJobs: 0, activeRealtimeSessions: 2 });
    assert.equal(workers[0].status, 'busy');
    assert.equal(workers[0].activeRealtimeSessions, 2);
    assert.equal(workers[1].technicalCode, 'old');
    assert.equal(workers[1].lastUsedAt, 'now');
    assert.equal(Object.hasOwn(workers[2], 'lastUsedAt'), false);

    delete harness.deps.onDemandModelIdleTimeoutMs;
    const defaultTimeoutWorker = { model: 'large-v3', pinned: false, status: 'idle', child: null, port: null, token: null, activeJobs: 0, queuedJobs: 0 };
    harness.manager.scheduleModelWorkerIdleStop(defaultTimeoutWorker);
    assert.equal(callbacks.length > 1, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given model or server failures, processing returns precise reportable contracts', async () => {
  const harness = await createHarness();
  const audioRoot = path.join(harness.root, 'data');
  const audioPath = path.join(audioRoot, 'sample.wav');
  try {
    await fs.mkdir(audioRoot, { recursive: true });
    await fs.writeFile(audioPath, 'audio');
    await harness.manager.allowUserSelectedPath(audioPath);

    harness.manager.start = async () => ({ installed: false, running: false, repairRequired: false });
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'speech_to_text_not_installed');
    harness.manager.start = async () => ({ installed: true, running: false, repairRequired: false });
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'speech_to_text_not_running');

    harness.manager.startModelWorker = async () => { throw 'worker failed'; };
    harness.manager.start = async () => ({ installed: true, running: true, repairRequired: false });
    assert.equal((await harness.manager.process({ path: audioPath, model: 'small' })).technicalCode, 'speech_model_worker_not_running');
    assert.equal(harness.manager.lastError, 'speech_model_worker_start_failed');

    harness.manager.startModelWorker = async () => { throw new Error('worker detail'); };
    assert.equal((await harness.manager.process({ path: audioPath, model: 'small' })).technicalCode, 'speech_model_worker_not_running');
    assert.equal(harness.manager.lastError, 'worker detail');

    const startingWorker = { model: 'small', child: { killed: true }, port: 46101, token: 'worker', status: 'starting', pinned: false, activeJobs: 0, queuedJobs: 0 };
    harness.manager.startModelWorker = async () => startingWorker;
    harness.manager.fetchJson = async () => ({ id: 'success', path: audioPath, task: 'translate', status: 'completed', createdAt: 'now', updatedAt: 'now', text: 'translated' });
    const success = await harness.manager.process({ path: audioPath, task: 'translate', model: 'small' });
    assert.equal(success.success, true);
    assert.equal(success.job.model, 'small');
    assert.equal(startingWorker.status, 'idle');

    harness.manager.startModelWorker = async () => null;
    const failedPayloads = [
      null,
      { id: 'failure', path: audioPath, task: 'transcribe', status: 'failed', error: 'decode failed', sizeBytes: 5, durationSeconds: 1, language: 'es' },
      { id: 'failure-code', path: audioPath, task: 'transcribe', status: 'failed', technicalCode: 'decode_code' },
    ];
    harness.manager.fetchJson = async () => failedPayloads.shift();
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'speech_to_text_failed');
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'decode failed');
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'decode_code');

    harness.manager.fetchJson = async () => { throw new Error('network_down'); };
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'network_down');
    harness.manager.fetchJson = async () => { throw ''; };
    assert.equal((await harness.manager.process({ path: audioPath })).technicalCode, 'speech_to_text_failed');
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given server responses, fetch and error normalization accept empty, invalid, nested, and safe detail payloads', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    runningManager(harness.manager);
    globalThis.fetch = async () => new Response('', { status: 200 });
    assert.equal(await harness.manager.fetchJson('/empty'), undefined);
    globalThis.fetch = async () => new Response('{bad json', { status: 200 });
    assert.equal(await harness.manager.fetchJson('/invalid'), undefined);

    globalThis.fetch = async () => new Response(JSON.stringify('bad'), { status: 500 });
    await assert.rejects(() => harness.manager.fetchJson('/bad'), /speech_invalid_error_response/);
    globalThis.fetch = async () => new Response(JSON.stringify({
      detail: {
        service: 'other',
        operation: 2,
        userMessage: 2,
        technicalCode: 2,
        reportable: 'yes',
        details: { diagnostic: 'Bearer secret', queueDepth: 3, enabled: true, empty: null, path: '/private' },
      },
    }), { status: 500 });
    let caught;
    try {
      await harness.manager.fetchJson('/defaults');
    } catch (error) {
      caught = error;
    }
    const normalized = harness.manager.normalizeServiceError(caught, 'translate');
    assert.equal(normalized.operation, 'translate');
    assert.equal(normalized.userMessage, 'Speech to text failed.');
    assert.equal(normalized.technicalCode, 'speech_to_text_failed');
    assert.equal(normalized.reportable, true);
    assert.deepEqual(normalized.details, { diagnostic: 'Bearer [redacted]', queueDepth: 3 });

    globalThis.fetch = async () => new Response(JSON.stringify({
      service: 'speech_to_text',
      operation: 'transcribe',
      userMessage: 'Could not decode.',
      technicalCode: 'decode_failed',
      reportable: false,
    }), { status: 422 });
    try {
      await harness.manager.fetchJson('/specific');
    } catch (error) {
      assert.deepEqual(harness.manager.normalizeServiceError(error, 'request'), {
        success: false,
        service: 'speech_to_text',
        operation: 'transcribe',
        userMessage: 'Could not decode.',
        technicalCode: 'decode_failed',
        reportable: false,
      });
    }

    harness.manager.port = null;
    await assert.rejects(() => harness.manager.fetchJson('/offline'), /speech_server_not_running/);
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given shared and explicitly selected audio, path resolution accepts only canonical authorized roots', async () => {
  const harness = await createHarness();
  const appRoot = path.join(harness.root, 'apps', 'demo');
  const extraRoot = path.join(harness.root, 'shared');
  const selectedRoot = path.join(harness.root, 'selected');
  try {
    await fs.mkdir(appRoot, { recursive: true });
    await fs.mkdir(extraRoot, { recursive: true });
    await fs.mkdir(selectedRoot, { recursive: true });
    const appFile = path.join(appRoot, 'app.wav');
    const sharedFile = path.join(extraRoot, 'shared.wav');
    const selectedFile = path.join(selectedRoot, 'selected.wav');
    await Promise.all([appFile, sharedFile, selectedFile].map((file) => fs.writeFile(file, 'audio')));

    assert.equal(await harness.manager.resolveAllowedAudioPath(appFile, { appAllowsSpeechToText: true, appInstallDir: appRoot }), await fs.realpath(appFile));
    assert.equal(await harness.manager.resolveAllowedAudioPath(sharedFile, { extraAllowedRoots: [extraRoot, path.join(harness.root, 'missing-root')] }), await fs.realpath(sharedFile));
    await harness.manager.allowUserSelectedPath(selectedFile);
    assert.equal(await harness.manager.resolveAllowedAudioPath(selectedFile, {}), await fs.realpath(selectedFile));
    await assert.rejects(() => harness.manager.resolveAllowedAudioPath(appFile, { appAllowsSpeechToText: false, appInstallDir: appRoot }), /speech_audio_path_not_allowed/);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given upload cleanup and logging failures, private audio is still deleted and runtime operations keep working', async () => {
  const realFs = fs;
  let rejectCleanup = true;
  let rejectAppend = true;
  const fakeFs = {
    ...realFs,
    rm: async (target, options) => {
      if (rejectCleanup && String(target).endsWith(`${path.sep}ephemeral`)) throw 'cleanup failed';
      return realFs.rm(target, options);
    },
    appendFile: async (...args) => {
      if (rejectAppend) throw new Error('disk full');
      return realFs.appendFile(...args);
    },
  };
  const harness = await createHarness({ fs: fakeFs });
  try {
    await harness.manager.load();
    assert.equal(harness.manager.ephemeralUploadCleanupPromise instanceof Promise, true);
    rejectAppend = false;
    await harness.manager.appendServiceLog('still-running', { path: '/private', diagnostic: 'Bearer secret', status: true, ignored: { nested: true } });

    rejectCleanup = false;
    harness.manager.ephemeralUploadCleanupPromise = null;
    harness.manager.process = async (input, access) => ({ success: true, input, access });
    const result = await harness.manager.processUpload({ filename: '....', data: new Uint8Array([1, 2]).buffer, ephemeral: true });
    assert.equal(path.basename(result.input.path).endsWith('-recording.webm'), true);
    assert.equal(result.access.ephemeral, true);
    await assert.rejects(() => fs.access(result.input.path));
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('given platform-specific environments and restart errors, paths and config remain deterministic', async () => {
  const harness = await createHarness();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.match(harness.manager.venvPythonPath(), /Scripts[\\/]python\.exe$/);
    Object.defineProperty(process, 'platform', originalPlatform);

    await harness.manager.updateConfig({ model: 42 });
    assert.equal(harness.manager.config.model, 'base');
    assert.equal(harness.manager.requiresRestart(
      { model: 'base', maxConcurrentJobs: 1, maxRealtimeSessions: 3, autoStart: false },
      { model: 'base', maxConcurrentJobs: 1, maxRealtimeSessions: 4, autoStart: false },
    ), true);

    harness.manager.child = { killed: true };
    harness.manager.port = 1;
    harness.manager.token = 't';
    harness.manager.start = async () => { throw 'restart unavailable'; };
    await harness.manager.updateConfig({ model: 'small', maxConcurrentJobs: Number.NaN, maxRealtimeSessions: Number.NaN });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.manager.lastError, 'speech_restart_failed');
    assert.equal(harness.installLogs.at(-1).event, 'speech_to_text:restart_failed');

    harness.manager.child = { killed: true };
    harness.manager.port = 1;
    harness.manager.token = 't';
    harness.manager.start = async () => { throw new Error('restart detail'); };
    await harness.manager.updateConfig({ maxConcurrentJobs: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.manager.lastError, 'restart detail');
  } finally {
    if (Object.getOwnPropertyDescriptor(process, 'platform').value !== originalPlatform.value) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});
