import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopRuntimeBridge } = require('../../dist-electron/main/desktop-runtime-bridge.js');
const { AgentRuntimeRequestValidationError } = require('../../dist-electron/shared/agent-runtime-registry.js');

const APP_ID = 'finance-os';
const SECRET = 'b5-secret';

const sign = ({ method, pathname, body = '', appId = APP_ID, secret = SECRET }) => {
  const timestamp = new Date().toISOString();
  const bodySha = createHash('sha256').update(body).digest('hex');
  return {
    'content-type': 'application/json',
    'x-forger-app-id': appId,
    'x-forger-timestamp': timestamp,
    'x-forger-body-sha256': bodySha,
    'x-forger-signature': createHmac('sha256', secret)
      .update([method, pathname, timestamp, bodySha].join('\n'))
      .digest('hex'),
  };
};

const request = async (bridge, pathname, { method = 'GET', body, rawBody, appId = APP_ID } = {}) => {
  const raw = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
  const response = await fetch(`${bridge.url}${pathname}`, {
    method,
    headers: sign({ method, pathname, body: raw, appId }),
    body: method === 'GET' ? undefined : raw,
  });
  return { response, payload: await response.json() };
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const createBridge = async (overrides = {}) => {
  const logs = [];
  const defaultTaskManager = {
    start: async (_appId, input) => ({ runId: 'task-1', status: 'queued', input }),
    get: () => null,
    cancel: () => ({ success: false }),
  };
  const options = {
    getInstalledApp: (appId) => appId === APP_ID ? { installDir: '/private/apps/finance-os' } : undefined,
    getConversationManager: () => null,
    getTaskManager: () => defaultTaskManager,
    getTaskStatus: async () => ({ connected: true }),
    getAppContext: () => ({ locale: 'en', rawLocale: 'en-US' }),
    renderManifestAgentPrompt: ({ kind }) => `${kind} prompt`,
    resolveInstalledAgents: async () => [{ id: 'analyst', title: 'Analyst', prompts: {} }],
    getAppPlatformCapabilities: async () => ({
      speechToText: true,
      audioInput: true,
      textToSpeech: true,
      workspaceFolders: true,
      agentRuntimeControl: true,
    }),
    requestFolderGrant: async () => null,
    listFolderGrants: async () => [],
    revokeFolderGrant: async () => ({ revoked: false }),
    getAudioDevices: async () => ({
      inputDevices: [{ id: 'default', label: 'Mic', kind: 'microphone', supported: true }],
      outputDevices: [{ id: 'default', label: 'Speaker', kind: 'speaker', supported: true }],
    }),
    updateAudioInputDevices: async () => undefined,
    createLiveVoiceSession: async () => ({ sessionId: 'live-1' }),
    stopLiveVoiceSession: async () => ({ success: true }),
    processSpeechToText: async () => ({ success: true, text: 'text' }),
    synthesizeTextToSpeech: async () => ({
      success: true,
      audioDataBase64: Buffer.from('RIFF').toString('base64'),
      mimeType: 'audio/wav',
    }),
    playTextToSpeechAudio: async () => ({ success: true }),
    cancelTextToSpeechPlayback: async () => undefined,
    deleteTextToSpeechAudio: async () => undefined,
    appendInstallLog: async (event, payload) => logs.push([event, payload]),
    serializeErrorForInstallLog: (error) => ({ message: error instanceof Error ? error.message : String(error) }),
    ...overrides,
  };
  const bridge = new DesktopRuntimeBridge(options);
  await bridge.start();
  bridge.secrets.set(APP_ID, SECRET);
  return { bridge, logs, options, stop: () => bridge.stop() };
};

test('runtime bridge exposes official tools and connection setup through signed app-scoped routes', async (t) => {
  const toolCalls = [];
  const connectionCalls = [];
  const harness = await createBridge({
    officialTools: {
      listToolsForApp: async () => [{ id: 'browser', name: 'Browser' }],
      callFromApp: async (appId, input) => {
        toolCalls.push([appId, input]);
        return { success: true };
      },
    },
    connections: {
      listConnectionsForApp: async () => ({ types: [{ type: 'gmail' }], instances: [], requirements: [] }),
      configureFromApp: async (appId, input) => {
        connectionCalls.push(['configure', appId, input]);
        return input.label
          ? { success: true, instance: { id: 'gmail-1' } }
          : { success: true };
      },
      callFromApp: async (appId, input) => {
        connectionCalls.push(['call', appId, input]);
        return { success: true, input };
      },
    },
  });
  t.after(harness.stop);

  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/tools`)).payload.tools[0].id, 'browser');
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/tools/browser`)).payload.name, 'Browser');
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/tools/missing`)).response.status, 404);
  await request(harness.bridge, `/v1/apps/${APP_ID}/tools/browser/actions/open`, {
    method: 'POST', body: { input: { url: 'https://example.test' } },
  });
  await request(harness.bridge, `/v1/apps/${APP_ID}/tools/browser/actions/close`, {
    method: 'POST', body: { input: [] },
  });
  assert.deepEqual(toolCalls[0][1].input, { url: 'https://example.test' });
  assert.deepEqual(toolCalls[1][1].input, {});
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/tools/browser`, { method: 'POST', body: {} })).response.status, 404);
  assert.equal((await request(harness.bridge, '/v1/apps/other/tools')).response.status, 403);

  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections`)).payload.types[0].type, 'gmail');
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections`, { method: 'POST', body: {} })).response.status, 404);
  const setup = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/setup`, {
    method: 'POST', body: { label: ' Work ', connectionId: ' gmail-old ' },
  });
  assert.equal(setup.payload.success, true);
  assert.deepEqual(connectionCalls[0][2], { type: 'gmail', label: 'Work', connectionId: 'gmail-old' });
  const setupWithoutMetadata = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/setup`, {
    method: 'POST', body: {},
  });
  assert.equal(setupWithoutMetadata.payload.success, true);
  const setupWithCallerId = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/setup`, {
    method: 'POST', body: { connectionId: 'gmail-caller' },
  });
  assert.equal(setupWithCallerId.payload.success, true);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/setup`)).response.status, 404);

  const grant = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/grants/request`, { method: 'POST', body: {} });
  assert.equal(grant.payload.technicalCode, 'connection_grant_manifest_managed');
  const blankGrant = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/%20/grants/request`, { method: 'POST', body: {} });
  assert.equal(blankGrant.payload.technicalCode, 'connection_type_required');
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/grants/request`)).response.status, 404);

  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/status`)).payload.success, true);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/status`, { method: 'POST', body: {} })).response.status, 404);
  const action = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/actions/gmail.search`, {
    method: 'POST', body: { connectionId: ' gmail-1 ', input: { query: 'invoice' } },
  });
  assert.equal(action.payload.success, true);
  assert.equal(connectionCalls.at(-1)[2].connectionId, 'gmail-1');
  const actionWithoutMetadata = await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/actions/gmail.search`, {
    method: 'POST', body: { input: [] },
  });
  assert.equal(actionWithoutMetadata.payload.success, true);
  assert.deepEqual(connectionCalls.at(-1)[2].input, {});
  assert.equal(connectionCalls.at(-1)[2].connectionId, undefined);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections/gmail/actions/gmail.search`)).response.status, 404);
  assert.equal((await request(harness.bridge, '/v1/apps/other/connections')).response.status, 403);
});

test('runtime bridge reports unavailable tool and connection services without widening app authority', async (t) => {
  const harness = await createBridge({ officialTools: undefined, connections: undefined });
  t.after(harness.stop);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/tools`)).response.status, 503);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/connections`)).response.status, 503);

  const noSetup = await createBridge({
    connections: {
      listConnectionsForApp: async () => ({ types: [], instances: [], requirements: [] }),
      callFromApp: async () => ({ success: false }),
    },
  });
  t.after(noSetup.stop);
  assert.equal((await request(noSetup.bridge, `/v1/apps/${APP_ID}/connections/gmail/setup`, {
    method: 'POST', body: {},
  })).response.status, 503);
});

test('runtime bridge rejects mismatched folder, task and conversation routes before invoking app services', async (t) => {
  const harness = await createBridge();
  t.after(harness.stop);
  const cases = [
    ['/v1/apps/other/folder-grants/request', 'POST', 403],
    [`/v1/apps/${APP_ID}/folder-grants/request`, 'GET', 404],
    ['/v1/apps/other/folder-grants', 'GET', 403],
    [`/v1/apps/${APP_ID}/folder-grants/grant-1`, 'PATCH', 404],
    [`/v1/apps/${APP_ID}/agent-tasks/status`, 'POST', 404],
    ['/v1/apps/other/agent-tasks', 'POST', 403],
    [`/v1/apps/${APP_ID}/agent-tasks`, 'DELETE', 404],
    [`/v1/apps/${APP_ID}/not-a-route`, 'GET', 503],
  ];
  for (const [pathname, method, status] of cases) {
    assert.equal((await request(harness.bridge, pathname, { method, body: method === 'GET' ? undefined : {} })).response.status, status);
  }
  assert.deepEqual((await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants/grant-1`, {
    method: 'DELETE', body: {},
  })).payload, { revoked: false });
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants/request`, {
    method: 'POST', body: { grantToken: 'invalid-grant' },
  })).response.status, 403);
  assert.deepEqual((await request(harness.bridge, `/v1/apps/${APP_ID}/folder-grants`)).payload, { grants: [] });

  const missingCallbacks = await createBridge({ revokeFolderGrant: undefined });
  t.after(missingCallbacks.stop);
  assert.equal((await request(missingCallbacks.bridge, `/v1/apps/${APP_ID}/folder-grants`)).response.status, 503);

  const noCapabilities = await createBridge({ getAppPlatformCapabilities: undefined });
  t.after(noCapabilities.stop);
  assert.equal((await request(noCapabilities.bridge, `/v1/apps/${APP_ID}/folder-grants/request`, {
    method: 'POST', body: { grantToken: 'grant' },
  })).response.status, 403);
  assert.equal((await request(noCapabilities.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
    method: 'POST', body: { runtime: {} },
  })).response.status, 403);
});

test('runtime bridge contains manifest-agent route mismatches, missing metadata and unusable thread summaries', async (t) => {
  const manager = {
    create: async () => ({ conversationId: 'thread-empty', appId: APP_ID, messages: [] }),
    sendMessage: async (_appId, input) => input.conversationId === 'thread-empty'
      ? null
      : { conversationId: input.conversationId, appId: APP_ID, messages: [] },
    get: async () => ({ conversationId: 'thread-empty', appId: APP_ID, messages: [] }),
    getMetadata: async (_appId, threadId) => threadId === 'legacy'
      ? { agentId: ' analyst ' }
      : {},
    steerRun: async () => ({ accepted: true }),
    cancel: async () => ({ success: true }),
  };
  const harness = await createBridge({ getConversationManager: () => manager });
  t.after(harness.stop);
  const cases = [
    ['/v1/apps/other/agents/analyst/start', 'POST', 403],
    [`/v1/apps/${APP_ID}/agents/analyst/start`, 'GET', 404],
    [`/v1/apps/${APP_ID}/agents/%20/start`, 'POST', 400],
    ['/v1/apps/other/agent-threads/thread/resume', 'POST', 403],
    [`/v1/apps/${APP_ID}/agent-threads/thread/resume`, 'GET', 404],
    ['/v1/apps/other/agent-threads/thread/runs/run/steer', 'POST', 403],
    [`/v1/apps/${APP_ID}/agent-threads/thread/runs/run/steer`, 'GET', 404],
    [`/v1/apps/${APP_ID}/agent-threads/thread`, 'DELETE', 404],
  ];
  for (const [pathname, method, status] of cases) {
    assert.equal((await request(harness.bridge, pathname, { method, body: method === 'GET' ? undefined : {} })).response.status, status);
  }

  const failedStart = await request(harness.bridge, `/v1/apps/${APP_ID}/agents/analyst/start`, {
    method: 'POST', body: {},
  });
  assert.equal(failedStart.response.status, 500);
  assert.equal(failedStart.payload.error, 'manifest_agent_thread_start_failed');
  const missingMetadata = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/missing/resume`, {
    method: 'POST', body: {},
  });
  assert.equal(missingMetadata.response.status, 400);
  assert.equal(missingMetadata.payload.error, 'manifest_agent_thread_agent_missing');
  const legacyMetadata = await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/legacy/resume`, {
    method: 'POST', body: { workspacePath: '/shared/workspace' },
  });
  assert.equal(legacyMetadata.response.status, 200);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads`)).response.status, 404);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/thread/runs`, {
    method: 'POST', body: {},
  })).response.status, 410);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/agent-threads/legacy/runs/run/steer`, {
    method: 'POST', body: { workspacePath: '/shared/steer' },
  })).response.status, 200);

  const noRoot = await createBridge({
    getInstalledApp: (appId) => appId === APP_ID ? {} : undefined,
    getConversationManager: () => manager,
  });
  t.after(noRoot.stop);
  assert.equal((await request(noRoot.bridge, `/v1/apps/${APP_ID}/agents/analyst/start`, {
    method: 'POST', body: {},
  })).response.status, 404);

  const noAgent = await createBridge({
    getConversationManager: () => manager,
    resolveInstalledAgents: async () => [],
  });
  t.after(noAgent.stop);
  assert.equal((await request(noAgent.bridge, `/v1/apps/${APP_ID}/agents/analyst/start`, {
    method: 'POST', body: {},
  })).response.status, 404);

  const runningConversation = {
    conversationId: 'thread-runtime',
    appId: APP_ID,
    title: 'Runtime',
    messages: [],
    activeRun: { runId: 'run-runtime', status: 'running', progressLog: [] },
  };
  const runtime = await createBridge({
    getConversationManager: () => ({
      create: async () => runningConversation,
      sendMessage: async () => runningConversation,
      get: async () => runningConversation,
      getMetadata: async () => ({ manifestAgentId: 'analyst' }),
    }),
  });
  t.after(runtime.stop);
  const runtimeStart = await request(runtime.bridge, `/v1/apps/${APP_ID}/agents/analyst/start`, {
    method: 'POST',
    body: {
      workspacePath: '/shared/start',
      runtime: {
        provider: 'codex', model: 'gpt-5.4',
        workspace: { additionalFolderGrantIds: ['runtime-folder'] },
      },
    },
  });
  assert.equal(runtimeStart.response.status, 200);
  assert.equal((await request(runtime.bridge, '/v1/apps/other/agent-threads/thread/runs/run')).response.status, 404);
});

test('runtime bridge validates every runtime override before a task reaches the manager', async (t) => {
  const starts = [];
  const harness = await createBridge({
    getTaskManager: () => ({
      start: async (_appId, input) => { starts.push(input); return { runId: 'task-b5', status: 'queued' }; },
      get: () => null,
      cancel: () => ({ success: false }),
    }),
  });
  t.after(harness.stop);
  const pathname = `/v1/apps/${APP_ID}/agent-tasks`;
  const valid = await request(harness.bridge, pathname, {
    method: 'POST',
    body: {
      templateId: 'review',
      locale: 'es',
      arguments: { range: 'month' },
      variables: { month: 'May' },
      attachments: [{ id: 'a1' }],
      workspacePath: '/workspace',
      workspace: { cwdGrantId: ' root ', additionalFolderGrantIds: [' extra ', 'extra', 7, ''] },
      runtime: {
        provider: 'antigravity', model: ' gemini-test ', authProfileId: ' profile-1 ', effort: 'high',
        modelParams: { temperature: 0.2 }, permissionMode: 'unsafe',
        workspace: { additionalFolderGrantIds: [' runtime-folder '] },
      },
    },
  });
  assert.equal(valid.response.status, 200);
  assert.deepEqual(starts[0].workspace, { cwdGrantId: 'root', additionalFolderGrantIds: ['extra'] });
  assert.deepEqual(starts[0].runtime.workspace, { additionalFolderGrantIds: ['runtime-folder'] });
  const emptyWorkspace = await request(harness.bridge, pathname, {
    method: 'POST', body: { templateId: 'review', workspace: {}, runtime: {} },
  });
  assert.equal(emptyWorkspace.response.status, 200);
  assert.equal((await request(harness.bridge, pathname, { method: 'POST', body: {} })).response.status, 200);
  assert.equal((await request(harness.bridge, pathname, {
    method: 'POST', body: { workspace: { cwdGrantId: 'root-only' } },
  })).response.status, 200);

  const invalidRuntimeValues = [
    7,
    { provider: 'unsupported' },
    { model: 7 },
    { authProfileId: 7 },
    { effort: 7 },
  ];
  const expectedCodes = [
    'agent_runtime_invalid',
    'agent_runtime_provider_unsupported',
    'agent_runtime_model_invalid',
    'agent_runtime_auth_profile_invalid',
    'agent_runtime_effort_invalid',
  ];
  for (let index = 0; index < invalidRuntimeValues.length; index += 1) {
    const result = await request(harness.bridge, pathname, {
      method: 'POST', body: { templateId: 'review', runtime: invalidRuntimeValues[index] },
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error, expectedCodes[index]);
  }
});

test('runtime bridge maps validation and non-Error failures to safe HTTP responses', async (t) => {
  const invalid = await createBridge({
    getTaskManager: () => ({
      start: async () => { throw new AgentRuntimeRequestValidationError('runtime_rejected'); },
      get: () => null,
      cancel: () => ({ success: false }),
    }),
  });
  t.after(invalid.stop);
  const start = await request(invalid.bridge, `/v1/apps/${APP_ID}/agent-tasks`, {
    method: 'POST', body: { templateId: 'review' },
  });
  assert.equal(start.response.status, 400);
  assert.equal(start.payload.error, 'runtime_rejected');

  const crashed = await createBridge({ getTaskStatus: async () => { throw 'offline'; } });
  t.after(crashed.stop);
  const status = await request(crashed.bridge, `/v1/apps/${APP_ID}/agent-tasks/status`);
  assert.equal(status.response.status, 500);
  assert.equal(status.payload.error, 'desktop_runtime_bridge_error');
});

test('runtime bridge keeps secrets stable and contains raw HTTP and websocket edge requests', async (t) => {
  const context = await createBridge({ getAppContext: () => undefined });
  t.after(context.stop);
  assert.deepEqual((await request(context.bridge, `/v1/apps/${APP_ID}/context`)).payload, {
    locale: 'es', rawLocale: null,
  });

  context.bridge.secrets.delete(APP_ID);
  const generated = context.bridge.environmentForApp(APP_ID);
  const reused = context.bridge.environmentForApp(APP_ID);
  assert.equal(reused.FORGER_DESKTOP_RUNTIME_SECRET, generated.FORGER_DESKTOP_RUNTIME_SECRET);
  context.bridge.publishAgentEvent({ conversation: { appId: APP_ID } });
  await context.bridge.start();

  const sockets = [];
  const makeSocket = () => {
    const socket = {
      writes: [], destroyed: false,
      write(value) { this.writes.push(value); },
      destroy() { this.destroyed = true; },
    };
    sockets.push(socket);
    return socket;
  };
  await context.bridge.handleUpgrade({ headers: {} }, makeSocket(), Buffer.alloc(0));
  assert.match(sockets[0].writes[0], /404 Not Found/);

  const originalAuthorize = context.bridge.authorize;
  context.bridge.authorize = () => { throw new Error('upgrade crashed'); };
  await context.bridge.handleUpgrade({
    method: 'GET', url: `/v1/apps/${APP_ID}/agent-events`, headers: {},
  }, makeSocket(), Buffer.alloc(0));
  context.bridge.authorize = originalAuthorize;
  assert.match(sockets[1].writes[0], /500 Unauthorized/);

  const directResponse = {
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body) { this.body = body; },
  };
  await context.bridge.handle({
    headers: {},
    async *[Symbol.asyncIterator]() { yield 'raw-body'; },
  }, directResponse);
  assert.equal(directResponse.statusCode, 401);
});

test('runtime bridge cancels an in-flight transcription job without allowing its late result to overwrite state', async (t) => {
  const work = deferred();
  const harness = await createBridge({ processSpeechToText: async () => work.promise });
  t.after(harness.stop);
  const queued = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
    method: 'POST', body: { path: '/shared/audio.wav', task: 'translate', language: 'es', model: 'large' },
  });
  const jobId = queued.payload.jobId;
  const canceled = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${jobId}/cancel`, {
    method: 'POST', body: {},
  });
  assert.equal(canceled.payload.status, 'canceled');
  work.resolve({ success: true, text: 'late text', language: 'en', durationSeconds: 2, job: { model: 'large' } });
  await flush();
  const final = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${jobId}`);
  assert.equal(final.payload.status, 'canceled');
  assert.equal(final.payload.text, undefined);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/missing`)).response.status, 404);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${jobId}/cancel`)).response.status, 404);

  harness.bridge.secrets.set('other', SECRET);
  const originalGetInstalledApp = harness.options.getInstalledApp;
  harness.options.getInstalledApp = (appId) => appId === 'other' ? { installDir: '/private/apps/other' } : originalGetInstalledApp(appId);
  assert.equal((await request(harness.bridge, `/v1/apps/other/audio/file-transcription-jobs/${jobId}/cancel`, {
    method: 'POST', body: {}, appId: 'other',
  })).response.status, 404);
});

test('runtime bridge records failed asynchronous transcription jobs with complete public diagnostics', async (t) => {
  const failed = await createBridge({
    processSpeechToText: async () => ({
      success: false,
      text: 'partial',
      language: 'es',
      durationSeconds: 1.5,
      userMessage: 'Could not transcribe.',
      technicalCode: 'decoder_failed',
      reportable: true,
      job: { model: 'large' },
    }),
  });
  t.after(failed.stop);
  const queued = await request(failed.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
    method: 'POST', body: { path: '/shared/bad.wav' },
  });
  await flush();
  const result = await request(failed.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${queued.payload.jobId}`);
  assert.equal(result.payload.status, 'failed');
  assert.equal(result.payload.technicalCode, 'decoder_failed');
  assert.equal(result.payload.reportable, true);

  const crashed = await createBridge({ processSpeechToText: async () => { throw 'decoder crashed'; } });
  t.after(crashed.stop);
  const crash = await request(crashed.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
    method: 'POST', body: { path: '/shared/crash.wav' },
  });
  await flush();
  const crashResult = await request(crashed.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${crash.payload.jobId}`);
  assert.equal(crashResult.payload.status, 'failed');
  assert.equal(crashResult.payload.technicalCode, 'speech_to_text_failed');

  const errorCrash = await createBridge({ processSpeechToText: async () => { throw new Error('decoder_error'); } });
  t.after(errorCrash.stop);
  const errorJob = await request(errorCrash.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
    method: 'POST', body: { path: '/shared/error.wav' },
  });
  await flush();
  assert.equal((await request(errorCrash.bridge,
    `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${errorJob.payload.jobId}`)).payload.technicalCode, 'decoder_error');

  const rejected = deferred();
  const canceledCrash = await createBridge({ processSpeechToText: async () => rejected.promise });
  t.after(canceledCrash.stop);
  const canceledJob = await request(canceledCrash.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
    method: 'POST', body: { path: '/shared/canceled.wav' },
  });
  await request(canceledCrash.bridge,
    `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${canceledJob.payload.jobId}/cancel`,
    { method: 'POST', body: {} });
  rejected.reject(new Error('late decoder error'));
  await flush();
  assert.equal((await request(canceledCrash.bridge,
    `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${canceledJob.payload.jobId}`)).payload.status, 'canceled');
});

test('runtime bridge audio route guards fail closed when capabilities or concrete services are missing', async (t) => {
  const missing = await createBridge({
    getAudioDevices: undefined,
    createLiveVoiceSession: undefined,
    stopLiveVoiceSession: undefined,
    processSpeechToText: undefined,
    synthesizeTextToSpeech: undefined,
  });
  t.after(missing.stop);
  const cases = [
    [`/v1/apps/${APP_ID}/audio/devices`, 'GET', undefined, 503],
    [`/v1/apps/${APP_ID}/audio/transcriptions`, 'POST', {}, 503],
    [`/v1/apps/${APP_ID}/audio/transcriptions/%20`, 'DELETE', undefined, 400],
    [`/v1/apps/${APP_ID}/audio/transcriptions/consumer`, 'DELETE', undefined, 503],
    [`/v1/apps/${APP_ID}/audio/file-transcriptions`, 'POST', { path: '/audio.wav' }, 503],
    [`/v1/apps/${APP_ID}/audio/file-transcription-jobs`, 'POST', {}, 400],
    [`/v1/apps/${APP_ID}/audio/synthesis`, 'POST', { text: 'x', model: 'm', voice: 'v' }, 503],
  ];
  for (const [pathname, method, body, status] of cases) {
    assert.equal((await request(missing.bridge, pathname, { method, body })).response.status, status);
  }
  assert.equal((await request(missing.bridge, '/v1/apps/other/audio/devices')).response.status, 403);
  assert.equal((await request(missing.bridge, `/v1/apps/${APP_ID}/audio/devices`, {
    method: 'POST', body: {},
  })).response.status, 404);
  assert.equal((await request(missing.bridge, `/v1/apps/${APP_ID}/audio/transcriptions`)).response.status, 404);
  assert.equal((await request(missing.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`)).response.status, 404);
  assert.equal((await request(missing.bridge, `/v1/apps/${APP_ID}/audio/synthesis`)).response.status, 404);
  assert.equal((await request(missing.bridge, `/v1/apps/${APP_ID}/audio/say`)).response.status, 404);

  const noStatus = await createBridge({ getTaskManager: undefined, getTaskStatus: undefined });
  t.after(noStatus.stop);
  assert.deepEqual((await request(noStatus.bridge, `/v1/apps/${APP_ID}/agent-tasks/status`)).payload, { available: false });

  const unavailablePlayback = await createBridge({ playTextToSpeechAudio: undefined });
  t.after(unavailablePlayback.stop);
  const started = await request(unavailablePlayback.bridge, `/v1/apps/${APP_ID}/audio/say`, {
    method: 'POST', body: { text: 'Hello', model: 'm', voice: 'v' },
  });
  await flush();
  const playback = await request(unavailablePlayback.bridge, `/v1/apps/${APP_ID}/audio/playbacks/${started.payload.playbackId}`);
  assert.equal(playback.payload.technicalCode, 'desktop_runtime_audio_unavailable');

  const minimalSynthesis = await createBridge({ synthesizeTextToSpeech: async () => ({ success: false }) });
  t.after(minimalSynthesis.stop);
  const synthesis = await request(minimalSynthesis.bridge, `/v1/apps/${APP_ID}/audio/synthesis`, {
    method: 'POST', body: { text: 'Hello', model: 'm', voice: 'v', format: 'opus' },
  });
  assert.deepEqual(synthesis.payload, { success: false, model: 'm', voice: 'v', format: 'opus' });
  assert.equal((await request(minimalSynthesis.bridge, `/v1/apps/${APP_ID}/audio/synthesis`, {
    method: 'POST', body: { text: 'Hello', model: 'm', voice: 'v' },
  })).payload.format, 'wav');

  const liveInputs = [];
  const active = await createBridge({
    createLiveVoiceSession: async (_appId, input) => {
      liveInputs.push(input);
      return { sessionId: `live-${liveInputs.length}` };
    },
    processSpeechToText: async () => ({ success: true }),
  });
  t.after(active.stop);
  assert.equal((await request(active.bridge, `/v1/apps/${APP_ID}/audio`)).response.status, 404);
  assert.equal((await request(active.bridge, `/v1/apps/${APP_ID}/audio/transcriptions`, {
    method: 'POST', body: { deviceId: 'mic-1', task: 'transcribe', language: 'es' },
  })).response.status, 200);
  assert.equal((await request(active.bridge, `/v1/apps/${APP_ID}/audio/transcriptions`, {
    method: 'POST', body: { task: 'other' },
  })).response.status, 200);
  assert.deepEqual(liveInputs, [
    { consumerKind: 'app_transcript', deviceId: 'mic-1', task: 'transcribe', language: 'es' },
    { consumerKind: 'app_transcript' },
  ]);

  const withModel = await request(active.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`, {
    method: 'POST', body: { path: '/shared/audio.wav', model: 'medium' },
  });
  assert.equal(withModel.payload.model, 'medium');
  const withoutModel = await request(active.bridge, `/v1/apps/${APP_ID}/audio/file-transcriptions`, {
    method: 'POST', body: { path: '/shared/audio.wav' },
  });
  assert.equal(withoutModel.payload.model, undefined);
  const completedJob = await request(active.bridge, `/v1/apps/${APP_ID}/audio/file-transcription-jobs`, {
    method: 'POST', body: { path: '/shared/audio.wav' },
  });
  await flush();
  assert.equal((await request(active.bridge,
    `/v1/apps/${APP_ID}/audio/file-transcription-jobs/${completedJob.payload.jobId}`)).payload.status, 'completed');
  await active.bridge.runAudioFileTranscriptionJob('missing');

  const richSynthesis = await createBridge({
    synthesizeTextToSpeech: async () => ({
      success: true,
      model: 'returned-model',
      voice: 'returned-voice',
      format: 'mp3',
      audioDataBase64: 'UklGRg==',
      mimeType: 'audio/mpeg',
      durationSeconds: 2,
      language: 'es',
      locale: 'es-CL',
      userMessage: 'Audio ready.',
      technicalCode: 'audio_ready',
      reportable: true,
    }),
  });
  t.after(richSynthesis.stop);
  const rich = await request(richSynthesis.bridge, `/v1/apps/${APP_ID}/audio/synthesis`, {
    method: 'POST', body: { text: 'Hola', model: 'm', voice: 'v', format: 'mp3', speed: 1.2 },
  });
  assert.equal(rich.payload.locale, 'es-CL');
  assert.equal(rich.payload.reportable, true);
});

test('runtime bridge cancels queued speech playback and contains synthesis, playback and cleanup failures', async (t) => {
  const synthesis = deferred();
  const canceledIds = [];
  const deleted = [];
  const harness = await createBridge({
    synthesizeTextToSpeech: async () => synthesis.promise,
    cancelTextToSpeechPlayback: async (id) => canceledIds.push(id),
    deleteTextToSpeechAudio: async (audioPath) => deleted.push(audioPath),
  });
  t.after(harness.stop);
  const queued = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/say`, {
    method: 'POST', body: { text: 'Hello', model: 'model', voice: 'voice' },
  });
  const playbackId = queued.payload.playbackId;
  const canceled = await request(harness.bridge, `/v1/apps/${APP_ID}/audio/playbacks/${playbackId}/cancel`, {
    method: 'POST', body: {},
  });
  assert.equal(canceled.payload.status, 'canceled');
  assert.deepEqual(canceledIds, [playbackId]);
  synthesis.resolve({
    success: true,
    audioPath: '/private/tmp/speech.wav',
    audioDataBase64: Buffer.from('RIFF').toString('base64'),
    mimeType: 'audio/wav',
  });
  await flush();
  assert.deepEqual(deleted, ['/private/tmp/speech.wav']);
  assert.equal((await request(harness.bridge, `/v1/apps/${APP_ID}/audio/playbacks/missing`)).response.status, 404);

  const failures = [
    {
      synthesizeTextToSpeech: async () => ({ success: false }),
      expected: 'text_to_speech_failed',
    },
    {
      synthesizeTextToSpeech: async () => ({ success: true, audioDataBase64: 'UklGRg==', mimeType: 'audio/wav' }),
      playTextToSpeechAudio: async () => ({ success: false }),
      expected: 'text_to_speech_playback_failed',
    },
    {
      synthesizeTextToSpeech: async () => { throw 'synth crashed'; },
      expected: 'text_to_speech_playback_failed',
    },
  ];
  for (const scenario of failures) {
    const child = await createBridge(scenario);
    t.after(child.stop);
    const started = await request(child.bridge, `/v1/apps/${APP_ID}/audio/say`, {
      method: 'POST', body: { text: 'Hello', model: 'model', voice: 'voice' },
    });
    await flush();
    const status = await request(child.bridge, `/v1/apps/${APP_ID}/audio/playbacks/${started.payload.playbackId}`);
    assert.equal(status.payload.status, 'failed');
    assert.equal(status.payload.technicalCode, scenario.expected);
  }

  const cleanup = await createBridge({
    synthesizeTextToSpeech: async () => ({
      success: true,
      audioPath: '/private/tmp/ephemeral.wav',
      audioDataBase64: 'UklGRg==',
      mimeType: 'audio/wav',
    }),
    deleteTextToSpeechAudio: async () => { throw new Error('cleanup failed'); },
  });
  t.after(cleanup.stop);
  await request(cleanup.bridge, `/v1/apps/${APP_ID}/audio/say`, {
    method: 'POST', body: { text: 'Hello', model: 'model', voice: 'voice', speed: 1.1 },
  });
  await flush();
  assert.ok(cleanup.logs.some(([event]) => event === 'desktop_runtime_audio:ephemeral_cleanup_failed'));

  const play = deferred();
  const playing = await createBridge({
    synthesizeTextToSpeech: async () => ({ success: true, audioDataBase64: 'UklGRg==' }),
    playTextToSpeechAudio: async () => play.promise,
  });
  t.after(playing.stop);
  const inFlight = await request(playing.bridge, `/v1/apps/${APP_ID}/audio/say`, {
    method: 'POST', body: { text: 'Hello', model: 'model', voice: 'voice' },
  });
  await flush();
  await request(playing.bridge, `/v1/apps/${APP_ID}/audio/playbacks/${inFlight.payload.playbackId}/cancel`, {
    method: 'POST', body: {},
  });
  play.resolve({ success: true });
  await flush();
  assert.equal((await request(playing.bridge,
    `/v1/apps/${APP_ID}/audio/playbacks/${inFlight.payload.playbackId}`)).payload.status, 'canceled');
  await playing.bridge.runSpeechPlayback('missing', { text: 'x', model: 'm', voice: 'v' });
});

test('runtime bridge keeps bounded playback state and signs empty event fields canonically', async (t) => {
  const harness = await createBridge();
  t.after(harness.stop);
  harness.bridge.updatePlayback('missing', { status: 'failed' });
  harness.bridge.updateAudioFileTranscriptionJob('missing', { status: 'failed' });
  const statuses = ['running', 'failed', 'canceled'];
  for (let index = 0; index < 103; index += 1) {
    const id = `old-${String(index).padStart(3, '0')}`;
    harness.bridge.playbacks.set(id, {
      playbackId: id,
      appId: APP_ID,
      status: statuses[index] ?? 'completed',
      textLength: 1,
      model: 'm',
      voice: 'v',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(),
    });
  }
  harness.bridge.trimPlaybacks();
  assert.equal(harness.bridge.playbacks.has('old-000'), true);
  assert.equal(harness.bridge.playbacks.has('old-001'), false);
  assert.equal(harness.bridge.playbacks.has('old-002'), false);
  assert.equal(harness.bridge.playbacks.size, 101);
  const envelope = harness.bridge.signEnvelope(APP_ID, {});
  assert.equal(typeof envelope.signature, 'string');

  const response = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
  await harness.bridge.handle({
    headers: {},
    async *[Symbol.asyncIterator]() {},
  }, response);
  assert.equal(response.status, 401);
});
