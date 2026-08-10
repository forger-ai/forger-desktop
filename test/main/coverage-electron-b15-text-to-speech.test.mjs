import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TextToSpeechServiceManager } = require('../../dist-electron/main/text-to-speech-service.js');

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const createHarness = async (overrides = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-tts-b15-'));
  const installLogs = [];
  const commands = [];
  let nextPort = 46900;
  const deps = {
    appendInstallLog: async (event, payload = {}) => installLogs.push({ event, payload }),
    ensureRuntimeInstalled: async () => ({ python: process.execPath }),
    fs,
    getFreePort: async () => nextPort++,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getPrivateDataRoot: () => path.join(root, 'private'),
    getServiceSourcePath: () => path.join(root, 'server.py'),
    path,
    runCommand: async (command, args, options) => commands.push({ command, args, options }),
    ...overrides,
  };
  const manager = new TextToSpeechServiceManager(deps);
  const serviceRoot = path.join(root, 'metadata', 'text-to-speech');
  return {
    root,
    serviceRoot,
    manager,
    deps,
    commands,
    installLogs,
    async markInstalled() {
      await fs.mkdir(serviceRoot, { recursive: true });
      await fs.writeFile(path.join(serviceRoot, 'installed.json'), '{}');
    },
    async writeConfig(value) {
      await fs.mkdir(serviceRoot, { recursive: true });
      await fs.writeFile(path.join(serviceRoot, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
    },
    async prepareExecutable(source = 'setInterval(() => {}, 1000);') {
      const python = process.platform === 'win32'
        ? path.join(serviceRoot, '.venv', 'Scripts', 'python.exe')
        : path.join(serviceRoot, '.venv', 'bin', 'python');
      await fs.mkdir(path.dirname(python), { recursive: true });
      await fs.symlink(process.execPath, python).catch(async () => fs.copyFile(process.execPath, python));
      await fs.writeFile(deps.getServiceSourcePath(), source);
    },
    async cleanup() {
      manager.stop();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    },
  };
};

const attachRunningService = (manager) => {
  manager.child = { pid: undefined, kill: () => true };
  manager.port = 46901;
  manager.token = 'tts-secret';
};

test('given persisted and updated configuration, defaults, bounds, unique voices, and restart fields are normalized', async () => {
  const harness = await createHarness();
  try {
    await harness.writeConfig('not-json');
    assert.equal((await harness.manager.getState()).config.maxTextCharacters, 4000);
    await harness.writeConfig(null);
    assert.equal((await harness.manager.getState()).config.defaultVoice, 'af_heart');

    await harness.manager.updateConfig({
      autoStart: true,
      maxTextCharacters: 99_999,
      maxConcurrentJobs: -4,
      enabledVoices: ['af_heart', '', 'af_heart', 17],
      defaultModel: ' custom ',
      defaultVoice: ' voice ',
    });
    let state = await harness.manager.getState();
    assert.equal(state.config.maxTextCharacters, 20_000);
    assert.equal(state.config.maxConcurrentJobs, 1);
    assert.deepEqual(state.config.enabledVoices, ['af_heart', '17']);
    assert.equal(state.config.defaultModel, 'custom');
    assert.equal(state.config.defaultVoice, 'voice');

    await harness.manager.updateConfig({
      maxTextCharacters: 0.2,
      maxConcurrentJobs: 12,
      enabledVoices: null,
      defaultModel: ' ',
      defaultVoice: 9,
    });
    state = await harness.manager.getState();
    assert.equal(state.config.maxTextCharacters, 1);
    assert.equal(state.config.maxConcurrentJobs, 8);
    assert.equal(state.config.defaultModel, 'kokoro');
    assert.equal(state.config.defaultVoice, 'af_heart');
  } finally {
    await harness.cleanup();
  }
});

test('given autostart settings and installation state, startup happens only when both preconditions hold', async () => {
  const harness = await createHarness();
  let starts = 0;
  try {
    assert.equal((await harness.manager.startIfConfigured()).status, 'not_installed');
    assert.equal((await harness.manager.start()).status, 'not_installed');
    harness.manager.start = async () => { starts += 1; return await harness.manager.getState(); };
    await harness.writeConfig({ autoStart: true });
    assert.equal((await harness.manager.startIfConfigured()).status, 'not_installed');
    await harness.markInstalled();
    assert.equal((await harness.manager.startIfConfigured()).installed, true);
    assert.equal(starts, 1);
  } finally {
    await harness.cleanup();
  }
});

test('given installation on POSIX and Windows, commands, cache isolation, interpreter paths, and marker are correct', async () => {
  for (const platform of ['darwin', 'win32']) {
    const harness = await createHarness();
    try {
      harness.manager.start = async () => await harness.manager.getState();
      const state = await withPlatform(platform, () => harness.manager.install());
      assert.equal(state.installed, true);
      assert.equal(harness.commands.length, 2);
      assert.equal(harness.commands[0].args.includes('venv'), true);
      assert.equal(harness.commands[1].command.endsWith(platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python')), true);
      assert.match(harness.commands[1].options.env.HF_HOME, /models$/);
      assert.equal(JSON.parse(await fs.readFile(path.join(harness.serviceRoot, 'installed.json'), 'utf8')).installedAt.length > 0, true);
    } finally {
      await harness.cleanup();
    }
  }
});

test('given concurrent real startup, one process is shared and diagnostics are sanitized before persistence', async () => {
  const harness = await createHarness();
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
    const child = harness.manager.child;
    assert.equal((await harness.manager.start()).running, true);
    assert.equal(harness.manager.child, child);
    assert.deepEqual(harness.manager.environmentForApp(false), {});
    assert.deepEqual(harness.manager.environmentForApp(true), {
      FORGER_TEXT_TO_SPEECH_URL: `http://127.0.0.1:${harness.manager.port}`,
      FORGER_TEXT_TO_SPEECH_TOKEN: harness.manager.token,
    });

    child.stdout.emit('data', 'Bearer abc FORGER_TTS_TOKEN=secret /Users/private/file?token=hidden');
    child.stderr.emit('data', '');
    child.stderr.emit('data', `problem ${'x'.repeat(2100)}`);
    const logPath = path.join(harness.serviceRoot, 'logs', 'server.jsonl');
    let log;
    for (let attempt = 0; attempt < 100 && !log?.includes('[redacted]'); attempt += 1) {
      try {
        log = await fs.readFile(logPath, 'utf8');
      } catch {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    assert.equal(log.includes('secret'), false);
    assert.equal(log.includes('/Users/private'), false);
    assert.equal(log.includes('[redacted]'), true);
    harness.manager.stop();
    child.emit('error', new Error('late process error'));
    assert.equal(harness.manager.lastError, undefined);
  } finally {
    await harness.cleanup();
  }
});

test('given exits, spawn errors, and failed health, process state and diagnostic errors remain deterministic', async () => {
  for (const outcome of ['exit-zero', 'exit-null', 'exit-error', 'spawn-error', 'spawn-empty', 'health-error', 'health-string']) {
    const harness = await createHarness();
    let child;
    try {
      await harness.markInstalled();
      await harness.prepareExecutable();
      harness.manager.waitForHealth = async () => {
        if (outcome === 'health-error') throw new Error('health unavailable');
        if (outcome === 'health-string') throw 'health unavailable';
      };
      const state = await harness.manager.start();
      child = harness.manager.child;
      if (outcome.startsWith('health')) {
        assert.equal(state.running, false);
        assert.equal(state.lastError, outcome === 'health-error' ? 'health unavailable' : 'text_to_speech_health_failed');
        continue;
      }
      if (outcome === 'exit-zero') child.emit('exit', 0);
      if (outcome === 'exit-null') child.emit('exit', null);
      if (outcome === 'exit-error') child.emit('exit', 9);
      if (outcome === 'spawn-error') child.emit('error', new Error('cannot spawn'));
      if (outcome === 'spawn-empty') child.emit('error', { message: '' });
      assert.equal(harness.manager.child, null);
      if (outcome === 'exit-zero' || outcome === 'exit-null') assert.equal(harness.manager.lastError, undefined);
      if (outcome === 'exit-error') assert.equal(harness.manager.lastError, 'text_to_speech_server_exited_9');
      if (outcome === 'spawn-error') assert.equal(harness.manager.lastError, 'cannot spawn');
      if (outcome === 'spawn-empty') assert.equal(harness.manager.lastError, 'text_to_speech_spawn_failed');
    } finally {
      if (child?.pid) child.kill();
      await harness.cleanup();
    }
  }
});

test('given service state payloads, models, voices, health, and every job shape are normalized safely', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    await harness.markInstalled();
    await harness.manager.updateConfig({ enabledVoices: ['voice-1'] });
    attachRunningService(harness.manager);
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({ ok: false, activeJobs: null, queuedJobs: undefined });
      if (pathname === '/v1/models') return Response.json({ models: [null, {}, { id: 'model-1', label: null, installed: true }, { id: '', label: 'skip' }] });
      if (pathname === '/v1/voices') return Response.json({ voices: [null, {}, { id: 'voice-1', model: 'model-1', label: null, language: null, locale: 'en', installed: true }, { id: '', model: '' }] });
      if (pathname === '/v1/jobs') return Response.json({ jobs: [
        null,
        { id: 'queued', status: 'queued', model: 'model-1', voice: 'voice-1', createdAt: null, updatedAt: null, textLength: 2, format: 'wav', durationSeconds: 1, error: 'e', technicalCode: 'c' },
        { id: 'running', status: 'running', model: 'model-1', voice: 'voice-1' },
        { id: 'done', status: 'completed', model: 'model-1', voice: 'voice-1', format: 'bad' },
        {},
        { id: '', status: 'mystery', model: '', voice: '' },
      ] });
      throw new Error('unexpected route');
    };
    let state = await harness.manager.getState();
    assert.equal(state.status, 'running');
    assert.equal(state.models[0].label, 'model-1');
    assert.equal(state.voices[0].enabled, true);
    assert.equal(state.voices[0].locale, 'en');
    assert.deepEqual(state.health, { ok: false, activeJobs: 0, queuedJobs: 0 });
    assert.deepEqual(state.queue.map((job) => job.id), ['queued', 'running']);

    globalThis.fetch = async () => { throw new Error('offline'); };
    state = await harness.manager.getState();
    assert.equal('health' in state, false);
    assert.equal(state.models[0].installed, true);
    harness.manager.child = null;
    harness.manager.starting = true;
    assert.equal((await harness.manager.getState()).status, 'starting');
    harness.manager.starting = false;
    harness.manager.lastError = 'known failure';
    assert.equal((await harness.manager.getState()).lastError, 'known failure');
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    await harness.cleanup();
  }
});

test('given synthesis input and server responses, validation, defaults, complete audio metadata, and errors are observable', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    assert.equal((await harness.manager.synthesize({ text: null, model: 2, voice: [] })).technicalCode, 'text_to_speech_text_required');
    await harness.markInstalled();
    await harness.manager.updateConfig({ maxTextCharacters: 5, enabledVoices: ['af_heart'] });
    assert.equal((await harness.manager.synthesize({ text: '123456', model: 'kokoro', voice: 'af_heart' })).technicalCode, 'text_to_speech_text_too_long');
    harness.manager.start = async () => ({ running: false, installed: false });
    assert.equal((await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart' })).technicalCode, 'text_to_speech_not_installed');
    harness.manager.start = async () => ({ running: false, installed: true });
    assert.equal((await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart' })).technicalCode, 'text_to_speech_not_running');

    harness.manager.start = async () => ({ running: true, installed: true });
    attachRunningService(harness.manager);
    let request;
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), options };
      return Response.json({
        success: true,
        text: 'hey',
        model: 'kokoro',
        voice: 'af_heart',
        language: 'English',
        locale: 'en-US',
        format: 'mp3',
        audioPath: '/private/audio.mp3',
        audioDataBase64: 'YWJj',
        mimeType: 'audio/mpeg',
        durationSeconds: 1.2,
        userMessage: 'ok',
        technicalCode: 'ok',
        service: 'text_to_speech',
        operation: 'synthesize',
        reportable: false,
        details: { voice: 'af_heart', queueDepth: 0, unsafe: 'drop', diagnostic: 'Bearer secret' },
      });
    };
    let result = await harness.manager.synthesize({ text: ' hey ', model: ' kokoro ', voice: ' af_heart ', speed: Infinity });
    assert.equal(result.success, true);
    assert.equal(result.audioDataBase64, 'YWJj');
    assert.deepEqual(result.details, { voice: 'af_heart', queueDepth: 0, diagnostic: 'Bearer [redacted]' });
    assert.equal(JSON.parse(request.options.body).speed, 1);
    assert.equal(JSON.parse(request.options.body).format, 'wav');
    assert.equal(request.options.headers.authorization, 'Bearer tts-secret');

    globalThis.fetch = async () => new Response('', { status: 200 });
    result = await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart', speed: 1.5, format: 'opus' });
    assert.equal(result.technicalCode, 'text_to_speech_invalid_response');

    globalThis.fetch = async () => { throw 'offline'; };
    result = await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart' });
    assert.equal(result.technicalCode, 'text_to_speech_failed');
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    await harness.cleanup();
  }
});

test('given HTTP errors, payload fallbacks and reportable detail sanitization preserve useful diagnostics only', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    await harness.markInstalled();
    harness.manager.start = async () => ({ running: true, installed: true });
    attachRunningService(harness.manager);
    const responses = [
      Response.json({ success: false, technicalCode: 'specific', details: { httpStatus: 503, reportable: true, secret: 'drop', diagnostic: 'FORGER_PRIVATE_TOKEN=bad' } }, { status: 503 }),
      Response.json({ success: false, technicalCode: 'fallbacks' }, { status: 500 }),
      Response.json({}, { status: 429 }),
    ];
    globalThis.fetch = async () => responses.shift();
    let result = await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart' });
    assert.equal(result.technicalCode, 'specific');
    assert.deepEqual(result.details, { httpStatus: 503, reportable: true, diagnostic: 'FORGER_TOKEN=[redacted]' });
    result = await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart' });
    assert.equal(result.operation, 'synthesize');
    assert.equal(result.userMessage, 'Text to speech failed.');
    assert.equal(result.reportable, true);
    result = await harness.manager.synthesize({ text: 'hey', model: 'kokoro', voice: 'af_heart' });
    assert.equal(result.technicalCode, 'text_to_speech_http_429');
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    await harness.cleanup();
  }
});

test('given restart-required config changes, successful and rejected background restarts update lifecycle state', async () => {
  for (const failure of [null, new Error('restart broke'), 'restart broke']) {
    const harness = await createHarness();
    try {
      await harness.markInstalled();
      attachRunningService(harness.manager);
      let starts = 0;
      harness.manager.start = async () => {
        starts += 1;
        if (failure) throw failure;
        return { running: true, installed: true };
      };
      await harness.manager.updateConfig({ maxConcurrentJobs: 2 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(starts, 1);
      if (failure) {
        assert.equal(harness.manager.lastError, failure instanceof Error ? 'restart broke' : 'text_to_speech_restart_failed');
        assert.equal(harness.installLogs.at(-1).event, 'text_to_speech:restart_failed');
      }

      attachRunningService(harness.manager);
      starts = 0;
      await harness.manager.updateConfig({ defaultVoice: 'am_adam' });
      assert.equal(starts, 0);
    } finally {
      harness.manager.child = null;
      await harness.cleanup();
    }
  }
});

test('given health polling and raw HTTP boundaries, retries, timeout, custom headers, empty bodies, and invalid JSON are handled', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalNow = Date.now;
  try {
    await assert.rejects(() => harness.manager.fetchJson('/health'), /text_to_speech_server_not_running/);
    harness.manager.port = 46901;
    harness.manager.token = 'token';
    let attempts = 0;
    globalThis.fetch = async (_url, _options) => {
      attempts += 1;
      if (attempts < 3) throw new Error('warming');
      return new Response(null, { status: 204 });
    };
    globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 1; };
    await harness.manager.waitForHealth(10_000);
    assert.equal(attempts, 3);
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers['x-test'], 'yes');
      return new Response(null, { status: 204 });
    };
    assert.equal(await harness.manager.fetchJson('/empty', { headers: { 'x-test': 'yes' } }), undefined);

    globalThis.fetch = async () => new Response('{bad', { status: 200 });
    assert.equal(await harness.manager.fetchJson('/invalid'), undefined);
    let now = 0;
    Date.now = () => { now += 10; return now; };
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(() => harness.manager.waitForHealth(15), /text_to_speech_health_timeout/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalNow;
    await harness.cleanup();
  }
});

test('given a logging filesystem failure, service diagnostics never break runtime operations', async () => {
  const harness = await createHarness();
  try {
    harness.manager.deps.fs = { ...fs, mkdir: async () => { throw new Error('readonly'); } };
    await harness.manager.appendServiceLog('event', { code: null, queueDepth: 1, ignored: Symbol('x') });
  } finally {
    harness.manager.deps.fs = fs;
    await harness.cleanup();
  }
});
