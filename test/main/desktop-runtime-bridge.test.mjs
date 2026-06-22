import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridge } = require('../../dist-electron/main/desktop-runtime-bridge.js');

const APP_ID = 'finance-os';
const SECRET = 'test-secret';

const sign = ({ method, path, body = '', secret = SECRET, appId = APP_ID, bodySha, timestamp = new Date().toISOString() }) => {
  const sha = bodySha ?? createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update([method, path, timestamp, sha].join('\n'))
    .digest('hex');
  return {
    'content-type': 'application/json',
    'x-forger-app-id': appId,
    'x-forger-timestamp': timestamp,
    'x-forger-body-sha256': sha,
    'x-forger-signature': signature,
  };
};

const request = async (bridge, path, { method = 'GET', body, rawBody: explicitRawBody, headers } = {}) => {
  const rawBody = explicitRawBody ?? (body === undefined ? '' : JSON.stringify(body));
  const response = await fetch(`${bridge.url}${path}`, {
    method,
    headers: headers ?? sign({ method, path, body: rawBody }),
    body: method === 'GET' ? undefined : rawBody,
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
};

const waitFor = async (predicate, timeoutMs = 1000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
};

const createBridge = async (options = {}) => {
  const tasks = new Map();
  const taskStarts = [];
  const taskManager = {
    async start(appId, input) {
      taskStarts.push({ appId, input });
      const task = {
        runId: 'run-1',
        appId,
        templateId: input.templateId,
        status: 'queued',
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        progressLog: [],
      };
      tasks.set(task.runId, task);
      return task;
    },
    get(appId, runId) {
      const task = tasks.get(runId);
      return task?.appId === appId ? task : null;
    },
    cancel(appId, runId) {
      const task = tasks.get(runId);
      return { success: Boolean(task && task.appId === appId) };
    },
  };
  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: options.getInstalledApp ?? ((appId) => (appId === APP_ID ? { id: appId, installDir: '/tmp/finance-os' } : null)),
    getConversationManager: options.getConversationManager ?? (() => null),
    getTaskManager: options.getTaskManager ?? (() => taskManager),
    getTaskStatus: options.getTaskStatus ?? (async () => ({ connected: true, codex: true, claude: false })),
    getAppContext: options.getAppContext ?? (() => ({ locale: 'en', rawLocale: 'en-US' })),
    getAppPlatformCapabilities: options.getAppPlatformCapabilities ?? (async () => ({
      speechToText: true,
      audioInput: true,
      textToSpeech: true,
    })),
    requestFolderGrant: options.requestFolderGrant,
    listFolderGrants: options.listFolderGrants,
    revokeFolderGrant: options.revokeFolderGrant,
    officialTools: options.officialTools,
    getAudioDevices: options.getAudioDevices ?? (async () => ({
      inputDevices: [
        { id: 'default', label: 'Default microphone', kind: 'microphone', default: true, supported: true },
        { id: 'system-audio:default', label: 'System audio', kind: 'system_audio', default: false, supported: true, requiresDisplayCapture: true },
      ],
      outputDevices: [
        { id: 'default', label: 'Default speaker', kind: 'speaker', default: true, supported: true },
        { id: 'speaker-2', label: 'External speaker', kind: 'speaker', default: false, supported: true },
      ],
    })),
    updateAudioInputDevices: options.updateAudioInputDevices ?? (async () => undefined),
    createLiveVoiceSession: options.createLiveVoiceSession ?? (async (_appId, input) => ({
      sessionId: 'session-1',
      deviceId: input.deviceId ?? 'default',
      consumerId: 'transcript-1',
      url: 'ws://127.0.0.1:1234/v1/realtime/transcribe',
      token: 'token',
      sampleRate: 16000,
      format: 'pcm_s16le',
      mode: 'transcript',
    })),
    stopLiveVoiceSession: options.stopLiveVoiceSession ?? (async (_appId, input) => ({ success: true, consumerId: input.consumerId })),
    processSpeechToText: options.processSpeechToText ?? (async (_appId, input) => ({
      success: true,
      text: input.task === 'translate' ? 'hello translated' : 'hello transcribed',
      language: input.language ?? 'en',
      durationSeconds: 1.2,
      userMessage: 'Audio transcribed.',
      job: {
        id: 'job-1',
        path: input.path,
        task: input.task ?? 'transcribe',
        status: 'completed',
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        model: input.model ?? 'base',
        text: 'hello transcribed',
      },
    })),
    synthesizeTextToSpeech: options.synthesizeTextToSpeech ?? (async () => ({
      success: true,
      audioPath: '/tmp/forger-tts.wav',
      audioDataBase64: Buffer.from('RIFF').toString('base64'),
      mimeType: 'audio/wav',
      durationSeconds: 0.1,
    })),
    playTextToSpeechAudio: options.playTextToSpeechAudio ?? (async () => ({ success: true, durationSeconds: 0.1 })),
    cancelTextToSpeechPlayback: options.cancelTextToSpeechPlayback ?? (async () => undefined),
    deleteTextToSpeechAudio: options.deleteTextToSpeechAudio ?? (async () => undefined),
    resolveInstalledAgents: options.resolveInstalledAgents ?? (async () => [{ id: 'analyst', title: 'Analyst', prompts: {} }]),
    renderManifestAgentPrompt: options.renderManifestAgentPrompt ?? (({ kind, variables }) => `${kind}:${variables?.topic ?? 'default'}`),
    appendInstallLog: async (event, payload) => options.logs?.push([event, payload]),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    maxBodyBytes: options.maxBodyBytes ?? 1024,
  });
  await bridge.start();
  if (options.seedSecret !== false) {
    bridge.secrets.set(APP_ID, SECRET);
  }
  return {
    bridge,
    taskManager,
    tasks,
    taskStarts,
    stop: async () => {
      await bridge.stop();
    },
  };
};

const websocketMessage = (client) => new Promise((resolve, reject) => {
  client.once('message', (raw) => {
    try {
      resolve(JSON.parse(raw.toString()));
    } catch (error) {
      reject(error);
    }
  });
  client.once('error', reject);
});

const conversation = {
  conversationId: 'thread-1',
  appId: APP_ID,
  title: 'Budget review',
  messages: [
    {
      messageId: 'msg-1',
      role: 'user',
      text: 'Review May',
      createdAt: '2026-05-17T00:00:00.000Z',
    },
  ],
  activeRun: {
    runId: 'run-9',
    status: 'running',
    progressLog: ['starting'],
  },
};

test('desktop runtime bridge starts once, exposes per-app environment, and clears it on stop', async () => {
  const logs = [];
  const harness = await createBridge({ logs, seedSecret: false });
  try {
    const env = harness.bridge.environmentForApp(APP_ID);
    assert.equal(env.FORGER_DESKTOP_RUNTIME_URL, harness.bridge.url);
    assert.equal(env.FORGER_DESKTOP_RUNTIME_APP_ID, APP_ID);
    assert.equal(env.FORGER_DESKTOP_RUNTIME_SECRET, harness.bridge.secrets.get(APP_ID));
    const firstUrl = harness.bridge.url;
    await harness.bridge.start();
    assert.equal(harness.bridge.url, firstUrl);
    assert.equal(logs.filter(([event]) => event === 'desktop_runtime_bridge:started').length, 1);
  } finally {
    await harness.stop();
  }

  assert.deepEqual(harness.bridge.environmentForApp(APP_ID), {});
  await harness.bridge.stop();
});

test('desktop runtime bridge rejects a listener without an assigned port', async (t) => {
  const http = require('node:http');
  const originalCreateServer = http.createServer;
  const fakeServer = new EventEmitter();
  fakeServer.listen = (_port, _host, callback) => callback();
  fakeServer.once = fakeServer.once.bind(fakeServer);
  fakeServer.on = fakeServer.on.bind(fakeServer);
  fakeServer.close = (callback) => callback?.();
  fakeServer.address = () => null;
  http.createServer = () => fakeServer;
  t.after(() => {
    http.createServer = originalCreateServer;
  });

  const bridge = new DesktopRuntimeBridge({
    getInstalledApp: () => null,
    getConversationManager: () => null,
    getTaskManager: () => null,
    appendInstallLog: async () => undefined,
    serializeErrorForInstallLog: (error) => ({ message: String(error) }),
  });

  await assert.rejects(bridge.start(), /desktop_runtime_bridge_address_unavailable/);
});

test('desktop runtime task endpoints require signatures', async () => {
  const harness = await createBridge();
  try {
    const { response, payload } = await request(
      harness.bridge,
      `/v1/apps/${APP_ID}/agent-tasks/status`,
      { headers: {} },
    );
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_signature_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task status reports unavailable without a task manager', async () => {
  const harness = await createBridge({
    getTaskManager: () => null,
    getTaskStatus: async (appId) => ({ appId, connected: false }),
  });
  try {
    const { response, payload } = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { available: false, appId: APP_ID, connected: false });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime app context reports signed locale and rejects unsupported methods', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/context`;
    const { response, payload } = await request(harness.bridge, path);
    assert.equal(response.status, 200);
    assert.deepEqual(payload, { locale: 'en', rawLocale: 'en-US' });

    const wrongMethod = await request(harness.bridge, path, { method: 'POST', body: {} });
    assert.equal(wrongMethod.response.status, 404);
    assert.equal(wrongMethod.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime app context normalizes missing locale fallback and app mismatch', async () => {
  const harness = await createBridge({ getAppContext: () => ({ locale: 'fr-CA', rawLocale: '' }) });
  try {
    const path = `/v1/apps/${APP_ID}/context`;
    const { payload } = await request(harness.bridge, path);
    assert.deepEqual(payload, { locale: 'es', rawLocale: 'fr-CA' });

    const mismatchPath = '/v1/apps/other-app/context';
    harness.bridge.secrets.set('other-app', SECRET);
    const mismatch = await request(harness.bridge, mismatchPath, {
      headers: sign({ method: 'GET', path: mismatchPath, appId: APP_ID }),
    });
    assert.equal(mismatch.response.status, 403);
    assert.equal(mismatch.payload.error, 'desktop_runtime_app_forbidden');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime folder grant endpoints require workspace capability and Desktop-signed selection tokens', async () => {
  const grants = new Map();
  const requestCalls = [];
  const harness = await createBridge({
    getAppPlatformCapabilities: async () => ({
      speechToText: false,
      audioInput: false,
      textToSpeech: false,
      workspaceFolders: true,
    }),
    requestFolderGrant: async (appId, grantToken) => {
      requestCalls.push({ appId, grantToken });
      if (grantToken !== 'valid-selection-token') return null;
      const grant = {
        grantId: 'grant-1',
        path: '/Users/person/Documents/Budget',
        realPath: '/Users/person/Documents/Budget',
        name: 'Budget',
        access: 'readWrite',
        createdAt: '2026-05-17T00:00:00.000Z',
      };
      grants.set(grant.grantId, grant);
      return grant;
    },
    listFolderGrants: async () => [...grants.values()],
    revokeFolderGrant: async (_appId, grantId) => ({ revoked: grants.delete(grantId) }),
  });
  try {
    const missingToken = await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants/request`, {
      method: 'POST',
      body: {},
    });
    assert.equal(missingToken.response.status, 400);
    assert.equal(missingToken.payload.error, 'desktop_runtime_folder_grant_token_required');

    const invalidToken = await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants/request`, {
      method: 'POST',
      body: { grantToken: 'invalid' },
    });
    assert.equal(invalidToken.response.status, 403);
    assert.equal(invalidToken.payload.error, 'desktop_runtime_folder_grant_invalid');

    const created = await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants/request`, {
      method: 'POST',
      body: { grantToken: 'valid-selection-token' },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.canceled, false);
    assert.equal(created.payload.grantId, 'grant-1');
    assert.deepEqual(requestCalls, [
      { appId: APP_ID, grantToken: 'invalid' },
      { appId: APP_ID, grantToken: 'valid-selection-token' },
    ]);

    const listed = await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants`);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.grants.length, 1);
    assert.equal(listed.payload.grants[0].grantId, 'grant-1');

    const revoked = await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants/grant-1/revoke`, {
      method: 'POST',
      body: {},
    });
    assert.equal(revoked.response.status, 200);
    assert.deepEqual(revoked.payload, { revoked: true });

    const afterRevoke = await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants`);
    assert.deepEqual(afterRevoke.payload.grants, []);
  } finally {
    await harness.stop();
  }

  const denied = await createBridge({
    getAppPlatformCapabilities: async () => ({
      speechToText: false,
      audioInput: false,
      textToSpeech: false,
      workspaceFolders: false,
    }),
    requestFolderGrant: async () => null,
    listFolderGrants: async () => [],
    revokeFolderGrant: async () => ({ revoked: false }),
  });
  try {
    const result = await request(denied.bridge, `/v1/apps/${APP_ID}/folder-grants`);
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'desktop_runtime_workspace_folders_not_allowed');
  } finally {
    await denied.stop();
  }
});

test('desktop runtime audio device routes return signed input and output devices', async () => {
  const updates = [];
  const harness = await createBridge({
    updateAudioInputDevices: async (devices) => updates.push(devices),
  });
  try {
    const path = `/v1/apps/${APP_ID}/audio/devices`;
    const { response, payload } = await request(harness.bridge, path);
    assert.equal(response.status, 200);
    assert.equal(payload.inputDevices[0].id, 'default');
    assert.equal(payload.inputDevices[1].kind, 'system_audio');
    assert.equal(payload.inputDevices[1].requiresDisplayCapture, true);
    assert.equal(payload.outputDevices[1].id, 'speaker-2');
    assert.equal(payload.inputDevices[0].audioDataBase64, undefined);
    assert.equal(payload.outputDevices[0].audioPath, undefined);
    assert.equal(updates.length, 1);

    const inputOnly = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/input-devices`);
    assert.deepEqual(Object.keys(inputOnly.payload), ['inputDevices']);
    const outputOnly = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/output-devices`);
    assert.deepEqual(Object.keys(outputOnly.payload), ['outputDevices']);

    const wrongMethod = await request(harness.bridge, path, { method: 'POST', body: {} });
    assert.equal(wrongMethod.response.status, 404);
    assert.equal(wrongMethod.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime audio routes keep capability gates independent', async () => {
  const calls = [];
  const harness = await createBridge({
    getAppPlatformCapabilities: async () => ({
      speechToText: true,
      audioInput: false,
      textToSpeech: false,
    }),
    createLiveVoiceSession: async (_appId, input) => {
      calls.push(input);
      return {
        sessionId: 'session-1',
        deviceId: input.deviceId ?? 'default',
        consumerId: 'consumer-1',
        url: 'ws://127.0.0.1:1234/v1/realtime/transcribe',
        token: 'token',
        sampleRate: 16000,
        format: 'pcm_s16le',
        mode: 'transcript',
      };
    },
  });
  try {
    const transcript = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/transcriptions`, {
      method: 'POST',
      body: { deviceId: 'default', task: 'translate', language: 'en' },
    });
    assert.equal(transcript.response.status, 200);
    assert.equal(transcript.payload.mode, 'transcript');
    assert.equal(calls[0].consumerKind, 'app_transcript');
    assert.equal(calls[0].task, 'translate');
    assert.equal(calls[0].language, 'en');

    const raw = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/raw-streams`, {
      method: 'POST',
      body: { deviceId: 'default' },
    });
    assert.equal(raw.response.status, 404);
    assert.equal(raw.payload.error, 'desktop_runtime_route_not_found');

    const say = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/say`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro', voice: 'af_heart' },
    });
    assert.equal(say.response.status, 403);
    assert.equal(say.payload.error, 'desktop_runtime_textToSpeech_capability_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime live transcription sessions can be stopped by consumer id', async () => {
  const stops = [];
  const harness = await createBridge({
    stopLiveVoiceSession: async (appId, input) => {
      stops.push({ appId, input });
      return { success: true, consumerId: input.consumerId };
    },
  });
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/transcriptions/transcript-1`, {
      method: 'DELETE',
    });

    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, { success: true, consumerId: 'transcript-1' });
    assert.deepEqual(stops, [{ appId: APP_ID, input: { consumerId: 'transcript-1' } }]);

    const wrongMethod = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/transcriptions/transcript-1`, {
      method: 'POST',
      body: {},
    });
    assert.equal(wrongMethod.response.status, 404);
    assert.equal(wrongMethod.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime live transcription stop requires speech capability', async () => {
  const harness = await createBridge({
    getAppPlatformCapabilities: async () => ({
      speechToText: false,
      audioInput: true,
      textToSpeech: true,
    }),
  });
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/transcriptions/transcript-1`, {
      method: 'DELETE',
    });

    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'desktop_runtime_speechToText_capability_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime audio file transcription route delegates through speech service without leaking paths', async () => {
  const calls = [];
  const harness = await createBridge({
    processSpeechToText: async (appId, input) => {
      calls.push({ appId, input });
      return {
        success: true,
        text: 'hola mundo',
        language: 'es',
        durationSeconds: 2.5,
        userMessage: 'Audio transcribed.',
        job: {
          id: 'job-1',
          path: input.path,
          task: input.task ?? 'transcribe',
          status: 'completed',
          createdAt: '2026-05-17T00:00:00.000Z',
          updatedAt: '2026-05-17T00:00:00.000Z',
          model: input.model ?? 'base',
        },
      };
    },
  });
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`, {
      method: 'POST',
      body: { path: '/tmp/finance-os/audio.webm', task: 'translate', language: 'es', model: 'small' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(calls, [{
      appId: APP_ID,
      input: { path: '/tmp/finance-os/audio.webm', task: 'translate', language: 'es', model: 'small' },
    }]);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.text, 'hola mundo');
    assert.equal(result.payload.task, 'translate');
    assert.equal(result.payload.language, 'es');
    assert.equal(result.payload.model, 'small');
    assert.equal(result.payload.path, undefined);

    const wrongMethod = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`);
    assert.equal(wrongMethod.response.status, 404);
    assert.equal(wrongMethod.payload.error, 'desktop_runtime_route_not_found');

    const missingPath = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`, {
      method: 'POST',
      body: { task: 'transcribe' },
    });
    assert.equal(missingPath.response.status, 400);
    assert.equal(missingPath.payload.error, 'speech_to_text_path_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime async audio file transcription jobs publish runtime updates without leaking paths', async () => {
  const calls = [];
  const harness = await createBridge({
    processSpeechToText: async (appId, input) => {
      calls.push({ appId, input });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        success: true,
        text: 'hola async',
        language: input.language ?? 'es',
        durationSeconds: 3,
        userMessage: 'Audio transcribed.',
        job: {
          id: 'job-1',
          path: input.path,
          task: input.task ?? 'transcribe',
          status: 'completed',
          model: input.model ?? 'large-v3',
        },
      };
    },
  });
  const eventsPath = `/v1/apps/${APP_ID}/runtime-events`;
  const client = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}${eventsPath}`, {
    headers: sign({ method: 'GET', path: eventsPath }),
  });
  try {
    const connected = await websocketMessage(client);
    assert.equal(connected.type, 'desktop_runtime.connected');
    const events = [];
    client.on('message', (raw) => events.push(JSON.parse(raw.toString())));

    const created = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
      method: 'POST',
      body: { path: '/tmp/finance-os/audio.webm', task: 'translate', language: 'es', model: 'large-v3' },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.status, 'queued');
    assert.equal(created.payload.task, 'translate');
    assert.equal(created.payload.model, 'large-v3');
    assert.equal(created.payload.path, undefined);

    const completed = await waitFor(() => events.find((event) => event.type === 'desktop.audio.fileTranscription.completed'), 1000);
    assert.ok(completed);
    const queued = events.find((event) => event.type === 'desktop.audio.fileTranscription.queued');
    assert.ok(queued);
    assert.equal(queued.type, 'desktop.audio.fileTranscription.queued');
    assert.equal(queued.payload.job.jobId, created.payload.jobId);
    assert.equal(queued.payload.job.path, undefined);

    const running = events.find((event) => event.type === 'desktop.audio.fileTranscription.running');
    assert.ok(running);
    assert.equal(running.type, 'desktop.audio.fileTranscription.running');

    assert.equal(completed.type, 'desktop.audio.fileTranscription.completed');
    assert.equal(completed.payload.job.text, 'hola async');
    assert.equal(completed.payload.job.status, 'completed');
    assert.equal(completed.payload.job.path, undefined);

    const fetched = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${created.payload.jobId}`);
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.payload.status, 'completed');
    assert.equal(fetched.payload.text, 'hola async');
    assert.equal(fetched.payload.path, undefined);
    assert.deepEqual(calls, [{
      appId: APP_ID,
      input: { path: '/tmp/finance-os/audio.webm', task: 'translate', language: 'es', model: 'large-v3' },
    }]);
  } finally {
    client.close();
    await harness.stop();
  }
});

test('desktop runtime audio file transcription requires speech capability', async () => {
  const harness = await createBridge({
    getAppPlatformCapabilities: async () => ({
      speechToText: false,
      audioInput: true,
      textToSpeech: true,
    }),
  });
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`, {
      method: 'POST',
      body: { path: '/tmp/audio.wav' },
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'desktop_runtime_speechToText_capability_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime audio synthesis route returns audio bytes without internal path', async () => {
  const calls = [];
  const harness = await createBridge({
    synthesizeTextToSpeech: async (input) => {
      calls.push(input);
      return {
        success: true,
        audioPath: '/tmp/generated.wav',
        audioDataBase64: Buffer.from('wav-data').toString('base64'),
        mimeType: 'audio/wav',
        model: input.model,
        voice: input.voice,
        format: input.format,
        durationSeconds: 0.4,
      };
    },
  });
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/synthesis`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro', voice: 'af_heart', speed: 1.1, format: 'mp3' },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(calls, [{ text: 'hello', model: 'kokoro', voice: 'af_heart', speed: 1.1, format: 'mp3' }]);
    assert.equal(result.payload.success, true);
    assert.equal(result.payload.audioDataBase64, Buffer.from('wav-data').toString('base64'));
    assert.equal(result.payload.mimeType, 'audio/wav');
    assert.equal(result.payload.audioPath, undefined);

    const missingArgs = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/synthesis`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro' },
    });
    assert.equal(missingArgs.response.status, 400);
    assert.equal(missingArgs.payload.error, 'text_to_speech_arguments_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime audio synthesis requires text to speech capability', async () => {
  const harness = await createBridge({
    getAppPlatformCapabilities: async () => ({
      speechToText: true,
      audioInput: true,
      textToSpeech: false,
    }),
  });
  try {
    const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/synthesis`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro', voice: 'af_heart' },
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'desktop_runtime_textToSpeech_capability_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime /say queues playback, tracks status, and cleans ephemeral audio', async () => {
  const synthCalls = [];
  const playCalls = [];
  const deleted = [];
  const harness = await createBridge({
    synthesizeTextToSpeech: async (input) => {
      synthCalls.push(input);
      return {
        success: true,
        audioPath: '/tmp/generated.wav',
        audioDataBase64: Buffer.from('wav-data').toString('base64'),
        mimeType: 'audio/wav',
        durationSeconds: 0.2,
      };
    },
    playTextToSpeechAudio: async (input) => {
      playCalls.push(input);
      return { success: true, durationSeconds: 0.2 };
    },
    deleteTextToSpeechAudio: async (audioPath) => {
      deleted.push(audioPath);
    },
  });
  try {
    const say = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/say`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro', voice: 'af_heart', speed: 1.1, outputDeviceId: 'speaker-2' },
    });
    assert.equal(say.response.status, 200);
    assert.equal(say.payload.success, true);
    assert.equal(say.payload.status, 'queued');
    assert.equal(typeof say.payload.playbackId, 'string');
    assert.equal(say.payload.audioPath, undefined);
    assert.equal(say.payload.audioDataBase64, undefined);
    assert.deepEqual(synthCalls[0], { text: 'hello', model: 'kokoro', voice: 'af_heart', speed: 1.1, format: 'wav' });
    assert.equal(playCalls[0].outputDeviceId, 'speaker-2');

    const completed = await waitFor(async () => {
      const result = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/playbacks/${say.payload.playbackId}`);
      return result.payload.status === 'completed' ? result : null;
    });
    assert.ok(completed);
    assert.equal(completed.payload.durationSeconds, 0.2);
    assert.deepEqual(deleted, ['/tmp/generated.wav']);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime /say validates arguments and output devices', async () => {
  const harness = await createBridge();
  try {
    const missing = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/say`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro' },
    });
    assert.equal(missing.response.status, 400);
    assert.equal(missing.payload.error, 'text_to_speech_arguments_required');

    const invalidDevice = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/say`, {
      method: 'POST',
      body: { text: 'hello', model: 'kokoro', voice: 'af_heart', outputDeviceId: 'missing-speaker' },
    });
    assert.equal(invalidDevice.response.status, 400);
    assert.equal(invalidDevice.payload.error, 'audio_output_device_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject invalid body hashes', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const body = JSON.stringify({ templateId: 'recommend_budget' });
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      body: { templateId: 'recommend_budget' },
      headers: sign({ method: 'POST', path, body, bodySha: 'bad-hash' }),
    });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_body_hash_invalid');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject stale timestamps, unknown secrets, and bad signatures', async () => {
  const stale = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const { response, payload } = await request(stale.bridge, path, {
      headers: sign({ method: 'GET', path, timestamp: '2020-01-01T00:00:00.000Z' }),
    });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_timestamp_invalid');
  } finally {
    await stale.stop();
  }

  const missingSecret = await createBridge({ seedSecret: false });
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const { response, payload } = await request(missingSecret.bridge, path);
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_secret_unknown');
  } finally {
    await missingSecret.stop();
  }

  const badSignature = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const { response, payload } = await request(badSignature.bridge, path, {
      headers: sign({ method: 'GET', path, secret: 'wrong-secret' }),
    });
    assert.equal(response.status, 401);
    assert.equal(payload.error, 'desktop_runtime_signature_invalid');
  } finally {
    await badSignature.stop();
  }
});

test('desktop runtime task endpoints reject invalid JSON bodies', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      rawBody: '{"templateId":',
    });
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'desktop_runtime_body_invalid');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject non-object JSON bodies', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      rawBody: '[]',
    });
    assert.equal(response.status, 400);
    assert.equal(payload.error, 'desktop_runtime_body_invalid');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints reject wrong apps', async () => {
  const harness = await createBridge();
  try {
    const path = '/v1/apps/missing-app/agent-tasks/status';
    const { response, payload } = await request(harness.bridge, path, {
      headers: sign({ method: 'GET', path, appId: 'missing-app' }),
    });
    assert.equal(response.status, 403);
    assert.equal(payload.error, 'desktop_runtime_app_forbidden');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task routes reject path/header mismatches, unavailable managers, and unsupported methods', async () => {
  const mismatch = await createBridge({
    getInstalledApp: (appId) => ({ id: appId }),
  });
  try {
    mismatch.bridge.secrets.set('other-app', SECRET);
    const path = '/v1/apps/other-app/agent-tasks/status';
    const { response, payload } = await request(mismatch.bridge, path, {
      headers: sign({ method: 'GET', path, appId: APP_ID }),
    });
    assert.equal(response.status, 403);
    assert.equal(payload.error, 'desktop_runtime_app_forbidden');

    const taskPath = '/v1/apps/other-app/agent-tasks/run-1';
    const task = await request(mismatch.bridge, taskPath, {
      headers: sign({ method: 'GET', path: taskPath, appId: APP_ID }),
    });
    assert.equal(task.response.status, 403);
    assert.equal(task.payload.error, 'desktop_runtime_app_forbidden');
  } finally {
    await mismatch.stop();
  }

  const unavailable = await createBridge({ getTaskManager: () => null });
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const { response, payload } = await request(unavailable.bridge, path, {
      method: 'POST',
      body: { templateId: 'recommend_budget' },
    });
    assert.equal(response.status, 503);
    assert.equal(payload.error, 'desktop_runtime_agent_task_manager_unavailable');
  } finally {
    await unavailable.stop();
  }

  const unsupported = await createBridge();
  try {
    const statusPath = `/v1/apps/${APP_ID}/agent-tasks/status`;
    const status = await request(unsupported.bridge, statusPath, { method: 'POST', body: {} });
    assert.equal(status.response.status, 404);
    assert.equal(status.payload.error, 'desktop_runtime_route_not_found');

    const taskPath = `/v1/apps/${APP_ID}/agent-tasks/run-1`;
    const task = await request(unsupported.bridge, taskPath, { method: 'POST', body: {} });
    assert.equal(task.response.status, 404);
    assert.equal(task.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await unsupported.stop();
  }
});

test('desktop runtime task endpoints start, get, and cancel tasks', async () => {
  const harness = await createBridge();
  try {
    const start = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
      method: 'POST',
      body: { templateId: 'recommend_budget', arguments: { month: '5' } },
    });
    assert.equal(start.response.status, 200);
    assert.equal(start.payload.runId, 'run-1');
    assert.equal(start.payload.templateId, 'recommend_budget');

    const get = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks/run-1`);
    assert.equal(get.response.status, 200);
    assert.equal(get.payload.runId, 'run-1');

    const cancel = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks/run-1/cancel`, {
      method: 'POST',
      body: {},
    });
    assert.equal(cancel.response.status, 200);
    assert.deepEqual(cancel.payload, { success: true });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints normalize workspace input for task starts', async () => {
  const harness = await createBridge();
  try {
    const start = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
      method: 'POST',
      body: {
        templateId: 'recommend_budget',
        workspacePath: 'reports/may',
        workspace: {
          cwdGrantId: '  grant-cwd  ',
          additionalFolderGrantIds: [' grant-extra ', 'grant-extra', '', 7],
        },
      },
    });
    assert.equal(start.response.status, 200);
    assert.equal(harness.taskStarts.length, 1);
    assert.deepEqual(harness.taskStarts[0].input, {
      templateId: 'recommend_budget',
      workspacePath: 'reports/may',
      workspace: {
        cwdGrantId: 'grant-cwd',
        additionalFolderGrantIds: ['grant-extra'],
      },
    });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime task endpoints gate and pass runtime control', async () => {
  const denied = await createBridge();
  try {
    const deniedStart = await request(denied.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
      method: 'POST',
      body: {
        templateId: 'recommend_budget',
        runtime: { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
      },
    });
    assert.equal(deniedStart.response.status, 403);
    assert.equal(deniedStart.payload.error, 'desktop_runtime_agent_runtime_control_required');
    assert.equal(denied.taskStarts.length, 0);
  } finally {
    await denied.stop();
  }

  const allowed = await createBridge({
    getAppPlatformCapabilities: async () => ({ agentRuntimeControl: true }),
  });
  try {
    const allowedStart = await request(allowed.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
      method: 'POST',
      body: {
        templateId: 'recommend_budget',
        runtime: { provider: 'codex', model: 'gpt-5.4', effort: 'medium' },
      },
    });
    assert.equal(allowedStart.response.status, 200);
    assert.deepEqual(allowed.taskStarts[0].input.runtime, {
      provider: 'codex',
      model: 'gpt-5.4',
      effort: 'medium',
    });
  } finally {
    await allowed.stop();
  }
});

test('desktop runtime task endpoints reject oversized payloads', async () => {
  const harness = await createBridge({ maxBodyBytes: 8 });
  try {
    const path = `/v1/apps/${APP_ID}/agent-tasks`;
    const body = JSON.stringify({ templateId: 'recommend_budget' });
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      body: { templateId: 'recommend_budget' },
      headers: sign({ method: 'POST', path, body }),
    });
    assert.equal(response.status, 413);
    assert.equal(payload.error, 'desktop_runtime_body_too_large');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge serves manifest-first conversation thread routes and normalizes runtime options', async () => {
  const calls = [];
  const manager = {
    async create(appId, input) {
      calls.push(['create', appId, input]);
      return { ...conversation, title: input.title ?? conversation.title };
    },
    async sendMessage(appId, input) {
      calls.push(['sendMessage', appId, input]);
      return conversation;
    },
    async get(appId, threadId) {
      calls.push(['get', appId, threadId]);
      return threadId === conversation.conversationId ? conversation : null;
    },
    async cancel(appId, threadId, runId) {
      calls.push(['cancel', appId, threadId, runId]);
      return { success: true };
    },
    async getMetadata() {
      return { manifestAgentId: 'analyst' };
    },
    async steerRun(appId, threadId, runId, input) {
      calls.push(['steerRun', appId, threadId, runId, input]);
      return { accepted: true, mode: 'queued_for_next_run' };
    },
  };
  const harness = await createBridge({
    getConversationManager: () => manager,
    getAppPlatformCapabilities: async () => ({ agentRuntimeControl: true }),
  });
  try {
    const createPath = `/v1/apps/${APP_ID}/agents/analyst/start`;
    const created = await request(harness.bridge, createPath, {
      method: 'POST',
      body: {
        title: 'Budget review',
        variables: { topic: 'May' },
        metadata: { source: 'test' },
      },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.desktop_thread_id, 'thread-1');
    assert.equal(calls[0][2].metadata.promptApi, 'manifest-http');
    assert.equal(calls[0][2].metadata.manifestAgentId, 'analyst');
    assert.equal(calls[1][2].message, 'initial:May');

    const runPath = `/v1/apps/${APP_ID}/agent-threads/thread-1/resume`;
    const run = await request(harness.bridge, runPath, {
      method: 'POST',
      body: {
        variables: { topic: 'June' },
        workspacePath: '/tmp/workspace',
        runtime: { provider: 'claude', model: 'auto', effort: 'high' },
      },
    });
    assert.equal(run.response.status, 200);
    assert.equal(run.payload.desktop_run_id, 'run-9');
    assert.equal(calls[2][2].message, 'resume:June');
    assert.equal(calls[2][2].provider, 'claude');
    assert.equal(calls[2][2].model, undefined);
    assert.equal(calls[2][2].effort, 'high');

    await request(harness.bridge, runPath, {
      method: 'POST',
      body: {
        variables: { topic: 'July' },
        runtime: { provider: 'codex', model: 'gpt-5.3-codex', effort: 'default' },
      },
    });
    assert.equal(calls[3][2].message, 'resume:July');
    assert.equal(calls[3][2].provider, 'codex');
    assert.equal(calls[3][2].model, 'gpt-5.3-codex');
    assert.equal(calls[3][2].effort, undefined);

    const invalidRuntime = await request(harness.bridge, runPath, {
      method: 'POST',
      body: {
        variables: { topic: 'August' },
        runtime: { provider: 'unknown', model: 'auto', effort: 'default' },
      },
    });
    assert.equal(invalidRuntime.response.status, 400);
    assert.equal(invalidRuntime.payload.error, 'agent_runtime_provider_unsupported');

    const steer = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9/steer`, {
      method: 'POST',
      body: { variables: { topic: 'steer' } },
    });
    assert.equal(steer.response.status, 200);
    assert.deepEqual(steer.payload, { accepted: true, mode: 'queued_for_next_run' });
    assert.equal(calls[4][0], 'steerRun');
    assert.equal(calls[4][4].message, 'steer:steer');

    const thread = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1`);
    assert.equal(thread.response.status, 200);
    assert.equal(thread.payload.active_run.desktop_run_id, 'run-9');

    const runStatus = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9`);
    assert.equal(runStatus.response.status, 200);
    assert.equal(runStatus.payload.status, 'running');

    const missingRun = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/missing`);
    assert.equal(missingRun.response.status, 200);
    assert.equal(missingRun.payload, null);

    const cancel = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9/cancel`, {
      method: 'POST',
      body: {},
    });
    assert.equal(cancel.response.status, 200);
    assert.deepEqual(cancel.payload, { success: true });
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge gates manifest agent runtime control', async () => {
  const manager = {
    async create() {
      return conversation;
    },
    async sendMessage() {
      return conversation;
    },
    async getMetadata() {
      return { manifestAgentId: 'analyst' };
    },
    async steerRun() {
      return { accepted: true, mode: 'queued_for_next_run' };
    },
  };
  const harness = await createBridge({ getConversationManager: () => manager });
  try {
    const start = await request(harness.bridge, `/v1/apps/${APP_ID}/agents/analyst/start`, {
      method: 'POST',
      body: { variables: { topic: 'start' }, runtime: { provider: 'codex', model: 'gpt-5.4' } },
    });
    assert.equal(start.response.status, 403);
    assert.equal(start.payload.error, 'desktop_runtime_agent_runtime_control_required');

    const resume = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/resume`, {
      method: 'POST',
      body: { variables: { topic: 'resume' }, runtime: { provider: 'codex', model: 'gpt-5.4' } },
    });
    assert.equal(resume.response.status, 403);
    assert.equal(resume.payload.error, 'desktop_runtime_agent_runtime_control_required');

    const steer = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-1/runs/run-9/steer`, {
      method: 'POST',
      body: { variables: { topic: 'steer' }, runtime: { provider: 'codex', model: 'gpt-5.4' } },
    });
    assert.equal(steer.response.status, 403);
    assert.equal(steer.payload.error, 'desktop_runtime_agent_runtime_control_required');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge includes active and historical conversation run result text', async () => {
  const resultConversation = {
    conversationId: 'thread-results',
    appId: APP_ID,
    title: 'Result review',
    messages: [
      {
        messageId: 'msg-user',
        role: 'user',
        text: 'Start',
        runId: 'run-active',
        createdAt: '2026-05-17T00:00:00.000Z',
      },
      {
        messageId: 'msg-old-user',
        role: 'user',
        text: 'Old request',
        runId: 'run-old',
        createdAt: '2026-05-17T00:00:01.000Z',
      },
      {
        messageId: 'msg-unrelated',
        role: 'assistant',
        text: 'Ignore me',
        runId: 'other-run',
        createdAt: '2026-05-17T00:00:02.000Z',
      },
      {
        messageId: 'msg-old',
        role: 'assistant',
        text: 'Historical result',
        runId: 'run-old',
        createdAt: '2026-05-17T00:00:03.000Z',
      },
      {
        messageId: 'msg-active',
        role: 'assistant',
        text: 'Active result',
        runId: 'run-active',
        createdAt: '2026-05-17T00:00:04.000Z',
      },
    ],
    activeRun: {
      runId: 'run-active',
      status: 'completed',
      progressLog: ['done'],
    },
  };
  const harness = await createBridge({
    getConversationManager: () => ({
      create: async () => resultConversation,
      sendMessage: async () => resultConversation,
      get: async (_appId, threadId) => (threadId === resultConversation.conversationId ? resultConversation : null),
      cancel: async () => ({ success: true }),
    }),
  });
  try {
    const thread = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results`);
    assert.equal(thread.response.status, 200);
    assert.equal(thread.payload.active_run.resultText, 'Active result');

    const active = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results/runs/run-active`);
    assert.equal(active.response.status, 200);
    assert.equal(active.payload.resultText, 'Active result');

    const historical = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results/runs/run-old`);
    assert.equal(historical.response.status, 200);
    assert.deepEqual(historical.payload, {
      desktop_thread_id: 'thread-results',
      desktop_run_id: 'run-old',
      status: 'completed',
      resultText: 'Historical result',
    });

    const missingRun = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread-results/runs/missing`);
    assert.equal(missingRun.response.status, 200);
    assert.equal(missingRun.payload, null);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge rejects invalid conversation thread requests', async () => {
  const harness = await createBridge({
    getConversationManager: () => ({
      create: async () => conversation,
      sendMessage: async () => ({ ...conversation, activeRun: undefined }),
      get: async () => null,
      cancel: async () => ({ success: false }),
    }),
  });
  try {
    const createPath = `/v1/apps/${APP_ID}/agent-threads`;
    const missingPrompt = await request(harness.bridge, createPath, {
      method: 'POST',
      body: { initialPrompt: '   ' },
    });
    assert.equal(missingPrompt.response.status, 410);
    assert.match(missingPrompt.payload.error, /forgerApp bridge has been removed/);

    const wrongAppPath = '/v1/apps/other-app/agent-threads';
    const wrongAppBody = JSON.stringify({ initialPrompt: 'hello' });
    const wrongApp = await request(harness.bridge, wrongAppPath, {
      method: 'POST',
      rawBody: wrongAppBody,
      headers: sign({ method: 'POST', path: wrongAppPath, body: wrongAppBody }),
    });
    assert.equal(wrongApp.response.status, 404);
    assert.equal(wrongApp.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge handles queued conversation runs and unsupported conversation routes', async () => {
  const harness = await createBridge({
    getConversationManager: () => ({
      create: async () => conversation,
      sendMessage: async () => ({ ...conversation, activeRun: undefined }),
      get: async () => conversation,
      cancel: async () => ({ success: false }),
      getMetadata: async () => ({ manifestAgentId: 'analyst' }),
    }),
  });
  try {
    const runPath = `/v1/apps/${APP_ID}/agent-threads/thread-1/resume`;
    const queued = await request(harness.bridge, runPath, {
      method: 'POST',
      body: { variables: { topic: 'Queue this' } },
    });
    assert.equal(queued.response.status, 200);
    assert.deepEqual(queued.payload, {
      desktop_thread_id: 'thread-1',
      desktop_run_id: '',
      status: 'queued',
    });

    const unsupported = await request(harness.bridge, runPath, { method: 'DELETE' });
    assert.equal(unsupported.response.status, 404);
    assert.equal(unsupported.payload.error, 'desktop_runtime_route_not_found');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge reports removed freeform thread routes before manager availability', async () => {
  const harness = await createBridge();
  try {
    const path = `/v1/apps/${APP_ID}/agent-threads`;
    const { response, payload } = await request(harness.bridge, path, {
      method: 'POST',
      body: { initialPrompt: 'hello' },
    });
    assert.equal(response.status, 410);
    assert.match(payload.error, /forgerApp bridge has been removed/);
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge signs websocket system and agent events', async () => {
  const harness = await createBridge();
  const path = `/v1/apps/${APP_ID}/agent-events`;
  const headers = sign({ method: 'GET', path });
  const client = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}${path}`, { headers });
  try {
    const connected = await websocketMessage(client);
    assert.equal(connected.type, 'desktop_runtime.connected');
    assert.equal(connected.app_id, APP_ID);
    assert.ok(connected.signature);

    harness.bridge.publishAgentEvent({
      type: 'run.message.completed',
      conversation,
      run: conversation.activeRun,
      message: {
        messageId: 'msg-2',
        role: 'assistant',
        text: 'Done',
        createdAt: '2026-05-17T00:01:00.000Z',
      },
      progress: { label: 'Finished' },
    });
    const event = await websocketMessage(client);
    assert.equal(event.type, 'assistant.message.appended');
    assert.equal(event.thread_id, 'thread-1');
    assert.equal(event.run_id, 'run-9');
    assert.equal(event.payload.message.content, 'Done');
    assert.ok(event.signature);

    client.close();
    await new Promise((resolve) => client.once('close', resolve));
    harness.bridge.publishAgentEvent({ type: 'conversation.created', conversation });
  } finally {
    client.close();
    await harness.stop();
  }
});

test('desktop runtime bridge refuses to sign agent events when the app secret has been cleared', async () => {
  const harness = await createBridge();
  try {
    harness.bridge.eventClients.set(APP_ID, new Set([
      {
        close: () => {},
        readyState: WebSocket.OPEN,
        send: () => {},
      },
    ]));
    harness.bridge.secrets.delete(APP_ID);
    assert.throws(
      () => harness.bridge.publishAgentEvent({ type: 'message.created', conversation }),
      /desktop_runtime_secret_unknown/,
    );
  } finally {
    await harness.stop();
  }
});

test('desktop runtime bridge signs minimal agent events and skips closed clients', async () => {
  const harness = await createBridge();
  const sent = [];
  try {
    harness.bridge.eventClients.set(APP_ID, new Set([
      {
        close: () => {},
        readyState: WebSocket.OPEN,
        send: (raw) => sent.push(JSON.parse(raw)),
      },
      {
        close: () => {},
        readyState: WebSocket.CLOSED,
        send: () => {
          throw new Error('closed_client_should_not_receive');
        },
      },
    ]));

    harness.bridge.publishAgentEvent({
      type: 'conversation.created',
      conversation: {
        ...conversation,
        activeRun: undefined,
        messages: [],
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'thread.created');
    assert.equal(sent[0].status, 'idle');
    assert.equal(sent[0].payload.run, undefined);
    assert.deepEqual(sent[0].payload.conversation.messages, []);
    assert.ok(sent[0].signature);

    harness.bridge.publishAgentEvent({
      type: 'custom.desktop.event',
      conversation: {
        ...conversation,
        activeRun: undefined,
        messages: [],
      },
    });
    assert.equal(sent[1].type, 'custom.desktop.event');
  } finally {
    await harness.stop();
  }
});

test('desktop runtime websocket upgrades reject unsigned event clients and unknown routes', async () => {
  const logs = [];
  const harness = await createBridge({ logs });
  try {
    const mismatchPath = '/v1/apps/other-app/agent-events';
    const mismatch = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}${mismatchPath}`, {
      headers: sign({ method: 'GET', path: mismatchPath, appId: APP_ID }),
    });
    const mismatchClose = await new Promise((resolve) => {
      mismatch.once('error', () => undefined);
      mismatch.once('close', (code) => resolve(code));
    });
    assert.equal(mismatchClose, 1006);

    const unsigned = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}/v1/apps/${APP_ID}/agent-events`);
    const unsignedClose = await new Promise((resolve) => {
      unsigned.once('error', () => undefined);
      unsigned.once('close', (code) => resolve(code));
    });
    assert.equal(unsignedClose, 1006);

    const unknown = new WebSocket(`${harness.bridge.url.replace('http:', 'ws:')}/v1/apps/${APP_ID}/unknown-events`);
    const unknownClose = await new Promise((resolve) => {
      unknown.once('error', () => undefined);
      unknown.once('close', (code) => resolve(code));
    });
    assert.equal(unknownClose, 1006);
    assert.ok(logs.some(([event]) => event === 'desktop_runtime_bridge:websocket_error'));
  } finally {
    await harness.stop();
  }
});
