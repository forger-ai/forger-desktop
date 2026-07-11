import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridge } = require('../../dist-electron/main/desktop-runtime-bridge.js');

const APP_ID = 'sidekick-demo';
const SECRET = 'sidekick-bridge-secret';

const sign = ({ method, path, body = '' }) => {
  const timestamp = new Date().toISOString();
  const bodySha = createHash('sha256').update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-forger-app-id': APP_ID,
    'x-forger-timestamp': timestamp,
    'x-forger-body-sha256': bodySha,
    'x-forger-signature': createHmac('sha256', SECRET)
      .update([method, path, timestamp, bodySha].join('\n'))
      .digest('hex'),
  };
};

const request = async (bridge, path, { method = 'GET', body } = {}) => {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const response = await fetch(`${bridge.url}${path}`, {
    method,
    headers: sign({ method, path, body: rawBody }),
    body: method === 'GET' ? undefined : rawBody,
  });
  return { response, payload: await response.json() };
};

const createBridge = async ({ capabilities = {}, onScreen, onSpeak } = {}) => {
  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: (appId) => appId === APP_ID ? { installDir: '/tmp/sidekick-demo' } : undefined,
    getConversationManager: () => null,
    resolveInstalledAgents: async () => [],
    renderManifestAgentPrompt: () => '',
    getAppPlatformCapabilities: async () => ({
      speechToText: false,
      audioInput: false,
      textToSpeech: false,
      sidekickDisplay: false,
      sidekickSpeech: false,
      ...capabilities,
    }),
    listSidekicksForApp: async () => [{
      sidekickId: 'sk-1',
      name: 'Desk Sidekick',
      status: 'online',
      capabilities: ['display.screens', 'speaker.playback'],
      ipAddress: '192.0.2.4',
      pairingSecret: 'must-not-leak',
    }],
    sendSidekickScreen: async (_appId, input) => {
      onScreen?.(input);
      return { success: true };
    },
    speakThroughSidekick: async (_appId, input) => {
      onSpeak?.(input);
      return { success: true, playbackId: 'play-1', samplesPlayed: 16_000 };
    },
    appendInstallLog: async () => undefined,
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
  });
  await bridge.start();
  bridge.secrets.set(APP_ID, SECRET);
  return bridge;
};

test('Sidekick runtime routes require a narrow manifest capability before listing devices', async () => {
  const denied = await createBridge();
  try {
    const result = await request(denied, `/v1/apps/${APP_ID}/sidekicks`);
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'desktop_runtime_sidekick_capability_required');
  } finally {
    await denied.stop();
  }

  const allowed = await createBridge({ capabilities: { sidekickDisplay: true } });
  try {
    const result = await request(allowed, `/v1/apps/${APP_ID}/sidekicks`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, {
      sidekicks: [{
        sidekickId: 'sk-1',
        name: 'Desk Sidekick',
        status: 'online',
        capabilities: ['display.screens', 'speaker.playback'],
      }],
    });
  } finally {
    await allowed.stop();
  }
});

test('Sidekick screen route validates and forwards a bounded screen.set request through Desktop', async () => {
  const forwarded = [];
  const bridge = await createBridge({ capabilities: { sidekickDisplay: true }, onScreen: (input) => forwarded.push(input) });
  try {
    const path = `/v1/apps/${APP_ID}/sidekicks/screen`;
    const accepted = await request(bridge, path, {
      method: 'POST',
      body: { sidekickId: 'sk-1', template: 'card', icon: 'info', title: 'Ready', body: 'Your report is complete.' },
    });
    assert.equal(accepted.response.status, 200);
    assert.deepEqual(accepted.payload, { success: true });
    assert.deepEqual(forwarded, [{ sidekickId: 'sk-1', template: 'card', icon: 'info', title: 'Ready', body: 'Your report is complete.' }]);

    const rejected = await request(bridge, path, {
      method: 'POST',
      body: { sidekickId: 'sk-1', template: 'html', text: '<script>bad()</script>' },
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.payload.error, 'desktop_runtime_sidekick_screen_invalid');
    assert.equal(forwarded.length, 1);
  } finally {
    await bridge.stop();
  }
});

test('Sidekick speech route requires both TTS and Sidekick speech capabilities and validates synthesis input', async () => {
  const missingTts = await createBridge({ capabilities: { sidekickSpeech: true } });
  try {
    const result = await request(missingTts, `/v1/apps/${APP_ID}/sidekicks/speak`, {
      method: 'POST',
      body: { sidekickId: 'sk-1', text: 'Hello', model: 'kokoro', voice: 'af_heart' },
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'desktop_runtime_textToSpeech_capability_required');
  } finally {
    await missingTts.stop();
  }

  const forwarded = [];
  const bridge = await createBridge({
    capabilities: { sidekickSpeech: true, textToSpeech: true },
    onSpeak: (input) => forwarded.push(input),
  });
  try {
    const path = `/v1/apps/${APP_ID}/sidekicks/speak`;
    const invalid = await request(bridge, path, {
      method: 'POST',
      body: { sidekickId: 'sk-1', text: '', model: 'kokoro', voice: 'af_heart', speed: 99 },
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error, 'desktop_runtime_sidekick_speech_invalid');
    assert.equal(forwarded.length, 0);

    const accepted = await request(bridge, path, {
      method: 'POST',
      body: { sidekickId: 'sk-1', text: 'Hello', model: 'kokoro', voice: 'af_heart', speed: 1.1 },
    });
    assert.equal(accepted.response.status, 200);
    assert.deepEqual(accepted.payload, { success: true, playbackId: 'play-1', samplesPlayed: 16_000 });
    assert.deepEqual(forwarded, [{ sidekickId: 'sk-1', text: 'Hello', model: 'kokoro', voice: 'af_heart', speed: 1.1 }]);
  } finally {
    await bridge.stop();
  }
});
