import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SpeechToTextServiceManager } = require('../../dist-electron/main/speech-to-text-service.js');

const VALID_INSTALL_MARKER = JSON.stringify({
  installedAt: '2026-06-14T00:00:00.000Z',
  schemaVersion: 3,
  dependencies: ['fastapi', 'uvicorn', 'python-multipart', 'faster-whisper'],
});

const createHarness = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-speech-test-'));
  const commands = [];
  let nextPort = 45124;
  const manager = new SpeechToTextServiceManager({
    appendInstallLog: async () => {},
    ensureRuntimeInstalled: async () => ({ python: process.execPath }),
    fs,
    getFreePort: async () => nextPort++,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getPrivateAppsRoot: () => path.join(root, 'apps'),
    getPrivateDataRoot: () => path.join(root, 'data'),
    getServiceSourcePath: () => path.join(root, 'server.py'),
    path,
    onDemandModelIdleTimeoutMs: 20,
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (args.includes('-m') && args.includes('venv')) {
        const venvPython = process.platform === 'win32'
          ? path.join(path.join(root, 'metadata', 'speech-to-text', '.venv'), 'Scripts', 'python.exe')
          : path.join(path.join(root, 'metadata', 'speech-to-text', '.venv'), 'bin', 'python');
        await fs.mkdir(path.dirname(venvPython), { recursive: true });
        await fs.writeFile(venvPython, '');
      }
    },
  });
  return {
    root,
    manager,
    commands,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

test('SpeechToTextServiceManager reports defaults before install and writes install marker', async () => {
  const harness = await createHarness();
  try {
    const initial = await harness.manager.getState();
    assert.equal(initial.status, 'not_installed');
    assert.equal(initial.modelWorkers[0].model, 'base');
    assert.equal(initial.modelWorkers[0].pinned, true);
    assert.deepEqual(initial.config, {
      model: 'base',
      maxConcurrentJobs: 1,
      maxRealtimeSessions: 3,
      autoStart: false,
    });
    assert.equal(initial.modelOptions.some((option) => option.id === 'base'), true);

    harness.manager.start = async () => await harness.manager.getState();
    const state = await harness.manager.install();
    assert.equal(state.installed, true);
    assert.equal(state.repairRequired, false);
    assert.equal(harness.commands.length >= 2, true);
    const pipInstall = harness.commands.find((command) => command.args.includes('pip') && command.args.includes('install'));
    assert.equal(pipInstall.args.includes('webrtcvad-wheels'), false);
    assert.equal(pipInstall.args.includes('openwakeword'), false);
    assert.equal(harness.commands.some((command) => command.args.includes('-c') && command.args.join(' ').includes('openwakeword')), false);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager does not require wake word dependencies', async () => {
  const harness = await createHarness();
  try {
    const speechRoot = path.join(harness.root, 'metadata', 'speech-to-text');
    await fs.mkdir(speechRoot, { recursive: true });
    await fs.writeFile(path.join(speechRoot, 'installed.json'), JSON.stringify({
      installedAt: '2026-06-14T00:00:00.000Z',
      schemaVersion: 3,
      dependencies: ['fastapi', 'uvicorn', 'python-multipart', 'faster-whisper'],
    }));

    const state = await harness.manager.getState();
    assert.equal(state.installed, true);
    assert.equal(state.repairRequired, false);
    assert.equal(state.dependencyIssues.some((issue) => issue.dependency === 'openwakeword'), false);
    assert.equal(state.dependencyIssues.some((issue) => issue.dependency === 'webrtcvad-wheels'), false);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager uses active model for file jobs when model is omitted', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    const speechRoot = path.join(harness.root, 'metadata', 'speech-to-text');
    const dataRoot = path.join(harness.root, 'data');
    const audioPath = path.join(dataRoot, 'sample.wav');
    const venvPython = process.platform === 'win32'
      ? path.join(speechRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(speechRoot, '.venv', 'bin', 'python');
    await fs.mkdir(speechRoot, { recursive: true });
    await fs.mkdir(path.dirname(venvPython), { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(path.join(speechRoot, 'installed.json'), VALID_INSTALL_MARKER);
    await fs.symlink(process.execPath, venvPython).catch(() => undefined);
    await fs.writeFile(path.join(harness.root, 'server.py'), 'setInterval(() => {}, 1000);', 'utf8');
    await fs.writeFile(audioPath, 'fake');
    await harness.manager.allowUserSelectedPath(audioPath);
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 45123;
    harness.manager.token = 'default-token';

    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({
        ok: true,
        model: 'base',
        activeJobs: 0,
        queuedJobs: 0,
        activeRealtimeSessions: 1,
        realtimeQueueDepth: 2,
        realtimeActiveJobs: 1,
        lastRealtimeFactor: 0.75,
        vadMode: 'webrtcvad',
      });
      if (pathname === '/v1/jobs') return Response.json({ jobs: [] });
      if (pathname === '/v1/processed-files') return Response.json({ processedFiles: [] });
      return Response.json({ id: 'job-1', path: audioPath, task: 'transcribe', status: 'completed', createdAt: 'now', updatedAt: 'now', model: 'base', text: 'hello' });
    };

    const result = await harness.manager.process({ path: audioPath, task: 'transcribe' });
    assert.equal(result.success, true);
    assert.equal(result.job.model, 'base');
    assert.equal(seen.some((url) => url.includes('127.0.0.1:45123/v1/transcribe')), true);
    const state = await harness.manager.getState();
    assert.deepEqual(state.health, {
      ok: true,
      model: 'base',
      activeJobs: 0,
      queuedJobs: 0,
      activeRealtimeSessions: 1,
      realtimeQueueDepth: 2,
      realtimeActiveJobs: 1,
      lastRealtimeFactor: 0.75,
      vadMode: 'webrtcvad',
    });
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager starts and reuses an on-demand model worker for file jobs', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    const speechRoot = path.join(harness.root, 'metadata', 'speech-to-text');
    const dataRoot = path.join(harness.root, 'data');
    const audioPath = path.join(dataRoot, 'sample.wav');
    const venvPython = process.platform === 'win32'
      ? path.join(speechRoot, '.venv', 'Scripts', 'python.exe')
      : path.join(speechRoot, '.venv', 'bin', 'python');
    await fs.mkdir(speechRoot, { recursive: true });
    await fs.mkdir(path.dirname(venvPython), { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(path.join(speechRoot, 'installed.json'), VALID_INSTALL_MARKER);
    await fs.symlink(process.execPath, venvPython).catch(() => undefined);
    await fs.writeFile(path.join(harness.root, 'server.py'), 'setInterval(() => {}, 1000);', 'utf8');
    await fs.writeFile(audioPath, 'fake');
    await harness.manager.allowUserSelectedPath(audioPath);
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 45123;
    harness.manager.token = 'default-token';

    const processUrls = [];
    globalThis.fetch = async (url) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/health') return Response.json({ ok: true, model: parsed.port === '45124' ? 'small' : 'base', activeJobs: 0, queuedJobs: 0, activeRealtimeSessions: 0 });
      if (parsed.pathname === '/v1/jobs') return Response.json({ jobs: [] });
      if (parsed.pathname === '/v1/processed-files') return Response.json({ processedFiles: [] });
      processUrls.push(String(url));
      return Response.json({ id: `job-${processUrls.length}`, path: audioPath, task: 'translate', status: 'completed', createdAt: 'now', updatedAt: 'now', model: 'small', text: 'hello' });
    };

    const first = await harness.manager.process({ path: audioPath, task: 'translate', model: 'small' });
    const second = await harness.manager.process({ path: audioPath, task: 'translate', model: 'small' });
    assert.equal(first.job.model, 'small');
    assert.equal(second.job.model, 'small');
    assert.equal(processUrls.length, 2);
    assert.equal(processUrls.every((url) => url.includes('127.0.0.1:45124/v1/translate')), true);

    const state = await harness.manager.getState();
    const worker = state.modelWorkers.find((entry) => entry.model === 'small');
    assert.equal(worker.status, 'idle');
    assert.equal(worker.pinned, false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopped = await harness.manager.getState();
    assert.equal(stopped.modelWorkers.find((entry) => entry.model === 'small').status, 'stopped');
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager starts only when autoStart is enabled', async () => {
  const harness = await createHarness();
  try {
    let starts = 0;
    const originalStart = harness.manager.start.bind(harness.manager);
    harness.manager.start = async () => {
      starts += 1;
      return await harness.manager.getState();
    };
    await harness.manager.startIfConfigured();
    assert.equal(starts, 0);

    await fs.mkdir(path.join(harness.root, 'metadata', 'speech-to-text'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'metadata', 'speech-to-text', 'installed.json'), VALID_INSTALL_MARKER);
    await harness.manager.updateConfig({ autoStart: true });
    await harness.manager.startIfConfigured();
    assert.equal(starts, 1);

    harness.manager.start = originalStart;
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager saves runtime config without waiting for restart healthcheck', async () => {
  const harness = await createHarness();
  try {
    let killed = false;
    harness.manager.child = {
      killed: false,
      kill: () => {
        killed = true;
      },
    };
    harness.manager.port = 45123;
    harness.manager.token = 'test-token';
    harness.manager.start = async () => await new Promise(() => {});

    const state = await Promise.race([
      harness.manager.updateConfig({ maxConcurrentJobs: 2, maxRealtimeSessions: 4 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('update_config_waited_for_restart')), 50)),
    ]);

    assert.equal(killed, true);
    assert.equal(state.status, 'starting');
    assert.equal(state.config.maxConcurrentJobs, 2);
    assert.equal(state.config.maxRealtimeSessions, 4);
  } finally {
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager rejects audio paths outside allowed roots', async () => {
  const harness = await createHarness();
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-speech-external-'));
  try {
    const audioPath = path.join(externalRoot, 'audio.wav');
    await fs.writeFile(audioPath, 'fake');
    await assert.rejects(
      () => harness.manager.process({ path: audioPath }),
      /speech_audio_path_not_allowed/,
    );
  } finally {
    harness.manager.stop();
    await fs.rm(externalRoot, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager only exposes app environment while running and allowed', async () => {
  const harness = await createHarness();
  try {
    assert.deepEqual(harness.manager.environmentForApp(true), {});
    assert.deepEqual(harness.manager.environmentForApp(false), {});
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager returns reportable JSON when server rejects processing', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    const speechRoot = path.join(harness.root, 'metadata', 'speech-to-text');
    const dataRoot = path.join(harness.root, 'data');
    const audioPath = path.join(dataRoot, 'sample.wav');
    await fs.mkdir(speechRoot, { recursive: true });
    await fs.mkdir(dataRoot, { recursive: true });
    await fs.writeFile(path.join(speechRoot, 'installed.json'), VALID_INSTALL_MARKER);
    await fs.writeFile(audioPath, 'fake');
    await harness.manager.allowUserSelectedPath(audioPath);
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 45123;
    harness.manager.token = 'test-token';
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({ ok: true, model: 'base', activeJobs: 0, queuedJobs: 0, activeRealtimeSessions: 0 });
      if (pathname === '/v1/jobs') return Response.json({ jobs: [] });
      if (pathname === '/v1/processed-files') return Response.json({ processedFiles: [] });
      if (pathname === '/v1/transcribe') {
        return Response.json({
          success: false,
          service: 'speech_to_text',
          operation: 'transcribe',
          technicalCode: 'speech_decode_failed',
          userMessage: 'Speech to text failed.',
          reportable: true,
          details: { sizeBytes: 123, path: '/Users/example-private/audio.wav' },
        }, { status: 500 });
      }
      return Response.json({});
    };

    const result = await harness.manager.process({ path: audioPath, task: 'transcribe' });
    assert.equal(result.success, false);
    assert.equal(result.service, 'speech_to_text');
    assert.equal(result.operation, 'transcribe');
    assert.equal(result.technicalCode, 'speech_decode_failed');
    assert.equal(result.reportable, true);
    assert.deepEqual(result.details, { sizeBytes: 123 });
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager treats ephemeral uploads as private and clears crash residue once', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    const speechRoot = path.join(harness.root, 'metadata', 'speech-to-text');
    const ephemeralRoot = path.join(speechRoot, 'temp-uploads', 'ephemeral');
    const crashResidue = path.join(ephemeralRoot, 'interrupted-sidekick.wav');
    await fs.mkdir(ephemeralRoot, { recursive: true });
    await fs.writeFile(crashResidue, 'private audio');
    await fs.writeFile(path.join(speechRoot, 'installed.json'), VALID_INSTALL_MARKER);
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 45123;
    harness.manager.token = 'test-token';

    let uploadedPath;
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({ ok: true, model: 'base', activeJobs: 0, queuedJobs: 0, activeRealtimeSessions: 0 });
      if (pathname === '/v1/jobs') return Response.json({ jobs: [] });
      if (pathname === '/v1/processed-files') return Response.json({ processedFiles: [] });
      const body = JSON.parse(String(init?.body));
      uploadedPath = body.path;
      assert.equal(body.ephemeral, true);
      assert.equal(await fs.readFile(uploadedPath, 'utf8'), 'new private audio');
      await assert.rejects(fs.access(crashResidue));
      return Response.json({
        id: 'ephemeral-job',
        path: uploadedPath,
        task: 'transcribe',
        status: 'completed',
        createdAt: 'now',
        updatedAt: 'now',
        model: 'base',
        text: 'private transcript',
      });
    };

    const result = await harness.manager.processUpload({
      filename: '../sidekick voice.wav',
      mimeType: 'audio/wav',
      data: Uint8Array.from(Buffer.from('new private audio')).buffer,
      task: 'transcribe',
      language: 'es',
      ephemeral: true,
    });

    assert.equal(result.success, true);
    assert.equal(result.text, 'private transcript');
    assert.equal(path.dirname(uploadedPath), await fs.realpath(ephemeralRoot));
    assert.equal(path.basename(uploadedPath).includes('..'), false);
    await assert.rejects(fs.access(uploadedPath));
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('SpeechToTextServiceManager keeps ordinary upload persistence behavior by default', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    const speechRoot = path.join(harness.root, 'metadata', 'speech-to-text');
    await fs.mkdir(speechRoot, { recursive: true });
    await fs.writeFile(path.join(speechRoot, 'installed.json'), VALID_INSTALL_MARKER);
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 45123;
    harness.manager.token = 'test-token';

    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(Object.hasOwn(body, 'ephemeral'), false);
      return Response.json({
        id: 'ordinary-job',
        path: body.path,
        task: 'transcribe',
        status: 'completed',
        createdAt: 'now',
        updatedAt: 'now',
        model: 'base',
        text: 'ordinary transcript',
      });
    };

    const result = await harness.manager.processUpload({
      filename: 'ordinary.wav',
      data: Uint8Array.from(Buffer.from('ordinary audio')).buffer,
    });

    assert.equal(result.success, true);
    assert.equal(path.basename(result.job.path).endsWith('-ordinary.wav'), true);
    assert.equal(result.job.path.includes(`${path.sep}ephemeral${path.sep}`), false);
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});
