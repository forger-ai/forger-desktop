import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TextToSpeechServiceManager } = require('../../dist-electron/main/text-to-speech-service.js');

const createHarness = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-tts-test-'));
  const commands = [];
  const manager = new TextToSpeechServiceManager({
    appendInstallLog: async () => {},
    ensureRuntimeInstalled: async () => ({ python: process.execPath }),
    fs,
    getFreePort: async () => 46123,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getPrivateDataRoot: () => path.join(root, 'data'),
    getServiceSourcePath: () => path.join(root, 'server.py'),
    path,
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (args.includes('-m') && args.includes('venv')) {
        const venvPython = process.platform === 'win32'
          ? path.join(path.join(root, 'metadata', 'text-to-speech', '.venv'), 'Scripts', 'python.exe')
          : path.join(path.join(root, 'metadata', 'text-to-speech', '.venv'), 'bin', 'python');
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

test('TextToSpeechServiceManager reports defaults and installs separately from speech to text', async () => {
  const harness = await createHarness();
  try {
    const initial = await harness.manager.getState();
    assert.equal(initial.status, 'not_installed');
    assert.equal(initial.config.maxTextCharacters, 4000);
    assert.equal(initial.config.maxConcurrentJobs, 1);
    assert.equal(initial.models[0].id, 'kokoro');
    assert.equal(initial.voices.some((voice) => voice.id === 'af_heart' && voice.language === 'English'), true);

    harness.manager.start = async () => await harness.manager.getState();
    const state = await harness.manager.install();
    assert.equal(state.installed, true);
    assert.equal(harness.commands.length >= 2, true);
    assert.equal(harness.commands[0].args.at(-1).includes('text-to-speech'), true);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('TextToSpeechServiceManager validates explicit model and voice parameters', async () => {
  const harness = await createHarness();
  try {
    assert.equal((await harness.manager.synthesize({ text: '', model: 'kokoro', voice: 'af_heart' })).technicalCode, 'text_to_speech_text_required');
    assert.equal((await harness.manager.synthesize({ text: 'hello', model: '', voice: 'af_heart' })).technicalCode, 'text_to_speech_model_required');
    assert.equal((await harness.manager.synthesize({ text: 'hello', model: 'kokoro', voice: '' })).technicalCode, 'text_to_speech_voice_required');

    await fs.mkdir(path.join(harness.root, 'metadata', 'text-to-speech'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'metadata', 'text-to-speech', 'installed.json'), '{}');
    await harness.manager.updateConfig({ enabledVoices: [] });
    const result = await harness.manager.synthesize({ text: 'hello', model: 'kokoro', voice: 'af_heart' });
    assert.equal(result.technicalCode, 'text_to_speech_voice_not_loaded');
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('TextToSpeechServiceManager only exposes app environment while running and allowed', async () => {
  const harness = await createHarness();
  try {
    assert.deepEqual(harness.manager.environmentForApp(true), {});
    assert.deepEqual(harness.manager.environmentForApp(false), {});
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('TextToSpeechServiceManager exposes active synthesis queue from the server', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(path.join(harness.root, 'metadata', 'text-to-speech'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'metadata', 'text-to-speech', 'installed.json'), '{}');
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 46123;
    harness.manager.token = 'test-token';
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({ ok: true, activeJobs: 1, queuedJobs: 1 });
      if (pathname === '/v1/models') return Response.json({ models: [{ id: 'kokoro', label: 'Kokoro', installed: true }] });
      if (pathname === '/v1/voices') return Response.json({ voices: [{ id: 'af_heart', model: 'kokoro', label: 'Heart', language: 'English', installed: true }] });
      if (pathname === '/v1/jobs') return Response.json({ jobs: [
        { id: 'job-1', status: 'queued', model: 'kokoro', voice: 'af_heart', textLength: 12, createdAt: 'now', updatedAt: 'now' },
        { id: 'job-2', status: 'completed', model: 'kokoro', voice: 'af_heart', textLength: 4, createdAt: 'now', updatedAt: 'now' },
      ] });
      return Response.json({});
    };

    const state = await harness.manager.getState();
    assert.equal(state.queue.length, 1);
    assert.equal(state.queue[0].id, 'job-1');
    assert.equal(state.health.queuedJobs, 1);
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('TextToSpeechServiceManager returns reportable JSON when synthesize server fails', async () => {
  const harness = await createHarness();
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(path.join(harness.root, 'metadata', 'text-to-speech'), { recursive: true });
    await fs.writeFile(path.join(harness.root, 'metadata', 'text-to-speech', 'installed.json'), '{}');
    harness.manager.child = { killed: false, kill: () => {} };
    harness.manager.port = 46123;
    harness.manager.token = 'test-token';
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/health') return Response.json({ ok: true, activeJobs: 0, queuedJobs: 0 });
      if (pathname === '/v1/models') return Response.json({ models: [{ id: 'kokoro', label: 'Kokoro', installed: true }] });
      if (pathname === '/v1/voices') return Response.json({ voices: [{ id: 'af_heart', model: 'kokoro', label: 'Heart', language: 'English', installed: true }] });
      if (pathname === '/v1/jobs') return Response.json({ jobs: [] });
      if (pathname === '/v1/synthesize') {
        return Response.json({
          success: false,
          service: 'text_to_speech',
          operation: 'synthesize',
          technicalCode: 'kokoro_pipeline_load_failed',
          userMessage: 'Text to speech failed.',
          reportable: true,
          details: { model: 'kokoro', voice: 'af_heart', textLength: 5, audioPath: '/Users/example-private/nope.wav' },
        }, { status: 500 });
      }
      return Response.json({});
    };

    const result = await harness.manager.synthesize({ text: 'hello', model: 'kokoro', voice: 'af_heart' });
    assert.equal(result.success, false);
    assert.equal(result.service, 'text_to_speech');
    assert.equal(result.operation, 'synthesize');
    assert.equal(result.technicalCode, 'kokoro_pipeline_load_failed');
    assert.equal(result.reportable, true);
    assert.deepEqual(result.details, { model: 'kokoro', voice: 'af_heart', textLength: 5 });
  } finally {
    globalThis.fetch = originalFetch;
    harness.manager.child = null;
    harness.manager.stop();
    await harness.cleanup();
  }
});
