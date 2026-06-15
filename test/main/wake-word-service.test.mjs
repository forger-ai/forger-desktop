import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WakeWordServiceManager } = require('../../dist-electron/main/wake-word-service.js');

const createHarness = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-wake-word-test-'));
  const commands = [];
  let nextPort = 46124;
  const detected = [];
  const manager = new WakeWordServiceManager({
    appendInstallLog: async () => {},
    ensureRuntimeInstalled: async () => ({ python: process.execPath }),
    fs,
    getFreePort: async () => nextPort++,
    getMetadataRoot: () => path.join(root, 'metadata'),
    getServiceSourcePath: () => path.join(root, 'wake-server.py'),
    path,
    onWakeDetected: (event) => detected.push(event),
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (args.includes('-m') && args.includes('venv')) {
        const venvPython = process.platform === 'win32'
          ? path.join(root, 'metadata', 'wake-word', '.venv', 'Scripts', 'python.exe')
          : path.join(root, 'metadata', 'wake-word', '.venv', 'bin', 'python');
        await fs.mkdir(path.dirname(venvPython), { recursive: true });
        await fs.writeFile(venvPython, '');
      }
    },
  });
  return {
    root,
    manager,
    commands,
    detected,
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
  };
};

test('WakeWordServiceManager owns openwakeword install and validates dependencies', async () => {
  const harness = await createHarness();
  try {
    harness.manager.start = async () => await harness.manager.getState();
    const state = await harness.manager.install();

    assert.equal(state.installed, true);
    assert.equal(state.repairRequired, false);
    const pipInstall = harness.commands.find((command) => command.args.includes('pip') && command.args.includes('install'));
    assert.equal(pipInstall.args.includes('openwakeword'), true);
    assert.equal(pipInstall.args.includes('onnxruntime'), true);
    assert.equal(harness.commands.some((command) => command.args.includes('-c') && command.args.join(' ').includes('openwakeword')), true);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('WakeWordServiceManager defaults to Hey Jarvis and normalizes legacy aliases', async () => {
  const harness = await createHarness();
  try {
    const initial = await harness.manager.getState();
    assert.equal(initial.config.modelId, 'hey jarvis');
    assert.equal(initial.models[0].id, 'hey jarvis');

    const next = await harness.manager.updateConfig({
      modelId: 'hey_jarvis',
      threshold: 0.61,
      patience: 3,
      cooldownMs: 1200,
    });
    assert.equal(next.config.modelId, 'hey jarvis');
    assert.equal(next.config.threshold, 0.61);
    assert.equal(next.config.patience, 3);
    assert.equal(next.config.cooldownMs, 1200);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('WakeWordServiceManager starts from enabled config and ignores legacy autoStart', async () => {
  const harness = await createHarness();
  try {
    const wakeRoot = path.join(harness.root, 'metadata', 'wake-word');
    await fs.mkdir(wakeRoot, { recursive: true });
    await fs.writeFile(path.join(wakeRoot, 'config.json'), JSON.stringify({
      enabled: true,
      autoStart: false,
      modelId: 'hey jarvis',
      threshold: 0.5,
      patience: 2,
      cooldownMs: 2500,
    }));
    let started = false;
    harness.manager.start = async () => {
      started = true;
      return await harness.manager.getState();
    };

    const state = await harness.manager.startIfConfigured();

    assert.equal(started, true);
    assert.equal(state.config.enabled, true);
    assert.equal('autoStart' in state.config, false);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('WakeWordServiceManager reports repair-needed only for wake dependencies', async () => {
  const harness = await createHarness();
  try {
    const wakeRoot = path.join(harness.root, 'metadata', 'wake-word');
    await fs.mkdir(wakeRoot, { recursive: true });
    await fs.writeFile(path.join(wakeRoot, 'installed.json'), JSON.stringify({
      installedAt: '2026-06-14T00:00:00.000Z',
      schemaVersion: 1,
      dependencies: ['fastapi', 'uvicorn'],
    }));

    const state = await harness.manager.getState();
    assert.equal(state.installed, true);
    assert.equal(state.repairRequired, true);
    assert.equal(state.dependencyIssues.some((issue) => issue.dependency === 'openwakeword'), true);
    assert.equal(state.dependencyIssues.some((issue) => issue.dependency === 'faster-whisper'), false);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});

test('WakeWordServiceManager records detection events for Free Chat activation', async () => {
  const harness = await createHarness();
  try {
    await harness.manager.updateConfig({ deviceId: 'mic-1', modelId: 'hey jarvis' });
    const state = await harness.manager.recordDetected({ confidence: 0.82 });

    assert.equal(state.status, 'detected');
    assert.equal(state.lastDetection.deviceId, 'mic-1');
    assert.equal(state.lastDetection.modelId, 'hey jarvis');
    assert.equal(state.lastDetection.confidence, 0.82);
    assert.equal(harness.detected.length, 1);
  } finally {
    harness.manager.stop();
    await harness.cleanup();
  }
});
