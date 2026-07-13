import assert from 'node:assert/strict';
import test from 'node:test';

import { selectSidekickPersonalAgentId, SidekickVoiceRuntime } from '../../dist-electron/main/sidekick-voice-runtime.js';
import { resolveSidekickVoiceProfile } from '../../dist-electron/main/sidekick-voice-profile.js';

const agents = [{ id: 'agent-a' }, { id: 'agent-b' }];

test('Sidekick voice uses an explicit valid agent binding', () => {
  assert.equal(selectSidekickPersonalAgentId('agent-b', agents), 'agent-b');
  assert.throws(
    () => selectSidekickPersonalAgentId('agent-deleted', agents),
    /sidekick_voice_personal_agent_binding_invalid/,
  );
});

test('Sidekick voice only falls back automatically when exactly one agent exists', () => {
  assert.equal(selectSidekickPersonalAgentId(undefined, [{ id: 'only-agent' }]), 'only-agent');
  assert.throws(() => selectSidekickPersonalAgentId(undefined, []), /sidekick_voice_personal_agent_required/);
  assert.throws(() => selectSidekickPersonalAgentId(undefined, agents), /sidekick_voice_personal_agent_selection_required/);
});

const voiceState = {
  config: { defaultModel: 'kokoro', defaultVoice: 'af_heart', maxTextCharacters: 2_000 },
  voices: [
    { id: 'af_heart', model: 'kokoro', language: 'English', locale: 'en-US', installed: true, enabled: true },
    { id: 'ef_dora', model: 'kokoro', language: 'Spanish', locale: 'es', installed: true, enabled: true },
  ],
};

const sidekick = (status = 'online', overrides = {}) => ({
  sidekickId: 'sidekick-1',
  name: 'Escritorio',
  status,
  capabilities: ['display.screens'],
  voiceConfig: { model: 'kokoro', voice: 'ef_dora', locale: 'en-US', conversationTtlMinutes: 45 },
  speakerPlayback: { status: 'idle' },
  microphoneRecording: { status: 'idle' },
  microphoneRecordings: [],
  idleConfig: { screens: ['eyes'], rotateSeconds: 15 },
  ...overrides,
});

test('Sidekick voice profile uses exact voice metadata as locale source of truth', () => {
  assert.deepEqual(resolveSidekickVoiceProfile(sidekick(), voiceState), {
    model: 'kokoro',
    voice: 'ef_dora',
    locale: 'es',
    sttLanguages: ['es', 'en'],
    conversationTtlMs: 45 * 60_000,
  });
  assert.throws(
    () => resolveSidekickVoiceProfile({ voiceConfig: { model: 'kokoro', voice: 'missing', locale: 'es', conversationTtlMinutes: 30 } }, voiceState),
    /sidekick_voice_configured_voice_unavailable/,
  );
  assert.deepEqual(resolveSidekickVoiceProfile({
    voiceConfig: { conversationTtlMinutes: 99_999 },
  }, voiceState), {
    model: 'kokoro',
    voice: 'af_heart',
    locale: 'en-US',
    sttLanguages: ['es', 'en'],
    conversationTtlMs: 30 * 60_000,
  });
});

test('Sidekick voice profile resolves STT languages per mode', () => {
  const profileFor = (sttConfig) => resolveSidekickVoiceProfile(
    sidekick('online', { voiceConfig: { ...sidekick().voiceConfig, ...sttConfig } }),
    voiceState,
  ).sttLanguages;
  // New and legacy profiles default to the bilingual subset.
  assert.deepEqual(profileFor({}), ['es', 'en']);
  assert.deepEqual(profileFor({ sttLanguageMode: 'voice' }), ['es']);
  assert.equal(profileFor({ sttLanguageMode: 'auto' }), undefined);
  assert.deepEqual(profileFor({ sttLanguageMode: 'fixed', sttLanguages: ['en'] }), ['en']);
  assert.deepEqual(profileFor({ sttLanguageMode: 'subset', sttLanguages: ['es', 'en'] }), ['es', 'en']);
  // Subset without configured codes falls back to the default spanglish pair.
  assert.deepEqual(profileFor({ sttLanguageMode: 'subset' }), ['es', 'en']);
  // Invalid explicit configurations fall back to the safe bilingual default.
  assert.deepEqual(profileFor({ sttLanguageMode: 'fixed', sttLanguages: ['nope'] }), ['es', 'en']);
});

const runtimeDeps = (overrides = {}) => {
  const screens = [];
  const conversationManager = {
    onConversationEvent: () => () => undefined,
    sendSidekickMessage: async () => undefined,
  };
  return {
    screens,
    conversationManager,
    deps: {
      getSidekickService: () => ({
        getState: async () => ({ desktopId: 'desktop', sidekicks: [sidekick()], detectedUsb: [] }),
        sendScreen: async (input) => { screens.push(input); return { success: true }; },
      }),
      getSpeechToTextService: () => ({}),
      getTextToSpeechService: () => ({ getState: async () => voiceState }),
      getPersonalAgentStore: () => ({}),
      getPersonalAgentConversationManager: () => conversationManager,
      ...overrides,
    },
  };
};

const eventually = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition not reached');
};

test('Sidekick reconnect reconciles a stale device screen back to idle', async () => {
  const harness = runtimeDeps();
  const runtime = new SidekickVoiceRuntime(harness.deps);
  runtime.start();
  runtime.onSidekickState({ desktopId: 'desktop', sidekicks: [sidekick('offline')], detectedUsb: [] });
  runtime.onSidekickState({ desktopId: 'desktop', sidekicks: [sidekick('online')], detectedUsb: [] });
  await eventually(() => harness.screens.length === 1);
  assert.deepEqual(harness.screens[0], { sidekickId: 'sidekick-1', template: 'idle' });
  await runtime.dispose();
});

test('Sidekick reconnect without an active voice turn authoritatively restores the idle screen', async () => {
  const harness = runtimeDeps();
  const runtime = new SidekickVoiceRuntime(harness.deps);
  runtime.start();
  await runtime.onSidekickSessionInvalidated({ sidekickId: 'sidekick-1', reason: 'reconnected' });
  assert.deepEqual(harness.screens, [{ sidekickId: 'sidekick-1', template: 'idle' }]);
  await runtime.dispose();
});

test('Sidekick reconnect during capture cancels the turn, discards partial PCM, and restores idle', async () => {
  const screens = [];
  let currentSidekick = sidekick('online', {
    microphoneRecording: { status: 'recording', recordingId: 'recording-1' },
  });
  let transcriptionCalls = 0;
  let conversationCalls = 0;
  const service = {
    getState: async () => ({ desktopId: 'desktop', sidekicks: [currentSidekick], detectedUsb: [] }),
    sendScreen: async (input) => { screens.push(input); return { success: true }; },
    startMicrophoneRecording: async () => ({
      success: true,
      desktopId: 'desktop',
      sidekicks: [currentSidekick],
      detectedUsb: [],
    }),
    stopMicrophoneRecording: async () => ({ success: true, desktopId: 'desktop', sidekicks: [sidekick()], detectedUsb: [] }),
  };
  const harness = runtimeDeps({
    getSidekickService: () => service,
    getSpeechToTextService: () => ({
      processUpload: async () => {
        transcriptionCalls += 1;
        return { success: true, text: 'audio parcial' };
      },
    }),
    getPersonalAgentConversationManager: () => ({
      ...runtimeDeps().conversationManager,
      createSidekickConversation: async () => {
        conversationCalls += 1;
        return { id: 'conversation-unexpected' };
      },
    }),
  });
  const runtime = new SidekickVoiceRuntime(harness.deps);
  runtime.start();
  runtime.onWakeDetected({ sidekickId: 'sidekick-1', wakeId: 'wake-1', model: 'wn9_hiesp', wakeWord: 'Hi ESP', wordIndex: 1, detectedAtMs: 10 });
  await eventually(() => screens.some((screen) => screen.icon === 'listening'));
  const pcm = Buffer.alloc(640);
  for (let offset = 0; offset < pcm.byteLength; offset += 2) pcm.writeInt16LE(offset % 4 === 0 ? 12_000 : -12_000, offset);
  runtime.onMicrophonePcm({
    sidekickId: 'sidekick-1',
    recordingId: 'recording-1',
    chunkSequence: 0,
    pcm,
  });

  currentSidekick = sidekick('online');
  await runtime.onSidekickSessionInvalidated({ sidekickId: 'sidekick-1', reason: 'reconnected' });

  assert.equal(runtime.getActivePhase('sidekick-1'), undefined);
  assert.equal(transcriptionCalls, 0);
  assert.equal(conversationCalls, 0);
  assert.deepEqual(screens.at(-1), { sidekickId: 'sidekick-1', template: 'idle' });
  await runtime.dispose();
});

test('forgetting a Sidekick cancels its active voice turn before the device is removed', async () => {
  const screens = [];
  const recordingSidekick = sidekick('online', {
    microphoneRecording: { status: 'recording', recordingId: 'recording-forget' },
  });
  const service = {
    getState: async () => ({ desktopId: 'desktop', sidekicks: [recordingSidekick], detectedUsb: [] }),
    sendScreen: async (input) => { screens.push(input); return { success: true }; },
    startMicrophoneRecording: async () => ({
      success: true,
      desktopId: 'desktop',
      sidekicks: [recordingSidekick],
      detectedUsb: [],
    }),
    stopMicrophoneRecording: async () => ({ success: true, desktopId: 'desktop', sidekicks: [sidekick()], detectedUsb: [] }),
  };
  const runtime = new SidekickVoiceRuntime(runtimeDeps({ getSidekickService: () => service }).deps);
  runtime.start();
  runtime.onWakeDetected({ sidekickId: 'sidekick-1', wakeId: 'wake-forget', model: 'wn9_hiesp', wakeWord: 'Hi ESP', wordIndex: 1, detectedAtMs: 10 });
  await eventually(() => runtime.getActivePhase('sidekick-1') === 'listening');

  await runtime.onSidekickSessionInvalidated({ sidekickId: 'sidekick-1', reason: 'forgotten' });

  assert.equal(runtime.getActivePhase('sidekick-1'), undefined);
  assert.deepEqual(screens.at(-1), { sidekickId: 'sidekick-1', template: 'idle' });
  await runtime.dispose();
});

test('Sidekick conversation lookup survives runtime restart, expires by TTL, and rotates on agent change', async () => {
  let configuredAgentId = 'agent-a';
  let persisted = {
    id: 'conversation-a',
    agentId: 'agent-a',
    sidekickId: 'sidekick-1',
    updatedAt: new Date().toISOString(),
  };
  const creates = [];
  const store = {
    listAgents: async () => [{ id: 'agent-a' }, { id: 'agent-b' }],
    findLatestSidekickConversation: async ({ agentId }) => persisted?.agentId === agentId ? persisted : null,
  };
  const conversations = {
    getConversation: async (id) => persisted?.id === id ? persisted : null,
    canReuseSidekickConversation: async ({ conversationId, agentId }) =>
      persisted?.id === conversationId && persisted?.agentId === agentId,
    createSidekickConversation: async (input) => {
      creates.push(input);
      persisted = {
        id: `conversation-${input.agentId}-${creates.length}`,
        agentId: input.agentId,
        sidekickId: input.sidekickId,
        updatedAt: new Date().toISOString(),
      };
      return persisted;
    },
    onConversationEvent: () => () => undefined,
  };
  const deps = runtimeDeps({
    getSidekickService: () => ({
      getState: async () => ({
        desktopId: 'desktop',
        sidekicks: [sidekick('online', { personalAgentId: configuredAgentId })],
        detectedUsb: [],
      }),
    }),
    getPersonalAgentStore: () => store,
    getPersonalAgentConversationManager: () => conversations,
  }).deps;

  const firstRuntime = new SidekickVoiceRuntime(deps);
  assert.deepEqual(await firstRuntime.createOrReuseConversation({ sidekickId: 'sidekick-1', ttlMs: 30 * 60_000 }), {
    conversationId: 'conversation-a',
  });
  const restartedRuntime = new SidekickVoiceRuntime(deps);
  assert.deepEqual(await restartedRuntime.createOrReuseConversation({ sidekickId: 'sidekick-1', ttlMs: 30 * 60_000 }), {
    conversationId: 'conversation-a',
  });
  persisted.updatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  assert.match((await restartedRuntime.createOrReuseConversation({ sidekickId: 'sidekick-1', ttlMs: 30 * 60_000 })).conversationId, /agent-a/);
  configuredAgentId = 'agent-b';
  assert.match((await restartedRuntime.createOrReuseConversation({ sidekickId: 'sidekick-1', ttlMs: 30 * 60_000 })).conversationId, /agent-b/);
  assert.deepEqual(creates.map((entry) => entry.agentId), ['agent-a', 'agent-b']);
  await firstRuntime.dispose();
  await restartedRuntime.dispose();
});

test('Sidekick abort during profile resolution never starts an agent run afterwards', async () => {
  let resolveState;
  let sends = 0;
  const delayedState = new Promise((resolve) => { resolveState = resolve; });
  const harness = runtimeDeps({
    getSidekickService: () => ({ getState: async () => await delayedState }),
  });
  harness.conversationManager.sendSidekickMessage = async () => { sends += 1; };
  const runtime = new SidekickVoiceRuntime(harness.deps);
  const controller = new AbortController();
  const result = runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1',
    conversationId: 'conversation-1',
    content: 'Hola',
    signal: controller.signal,
  });
  controller.abort(new Error('sidekick_voice_cancelled'));
  resolveState({ desktopId: 'desktop', sidekicks: [sidekick()], detectedUsb: [] });
  await assert.rejects(result, /sidekick_voice_cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  await runtime.dispose();
});

test('BDD: runtime accepts a Sidekick MCP outcome only for its exact run, conversation and device', async () => {
  const listeners = new Set();
  let sent;
  let sends = 0;
  const harness = runtimeDeps({
    getPersonalAgentConversationManager: () => ({
      onConversationEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      sendSidekickMessage: async () => { sends += 1; return { activeRun: { id: 'run-voice-1' } }; },
      cancelRun: async () => true,
    }),
  });
  const runtime = new SidekickVoiceRuntime(harness.deps);
  const pending = runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'Hola',
    signal: new AbortController().signal,
  });
  await eventually(() => sends === 1);
  assert.equal(runtime.resolveAgentToolOutcome({
    sidekickId: 'wrong', conversationId: 'conversation-1', runId: 'run-voice-1', mode: 'end', text: 'No',
  }).accepted, false);
  assert.equal(runtime.resolveAgentToolOutcome({
    sidekickId: 'sidekick-1', conversationId: 'other', runId: 'run-voice-1', mode: 'end', text: 'No',
  }).accepted, false);
  assert.equal(runtime.resolveAgentToolOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'stale-run', mode: 'end', text: 'No',
  }).accepted, false);
  assert.equal(runtime.resolveAgentToolOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'run-voice-1', mode: 'wait', text: '¿Algo más?',
  }).accepted, true);
  sent = await pending;
  assert.equal(sent.mode, 'wait');
  assert.equal(sent.text, '¿Algo más?');
  assert.equal(sent.runId, 'run-voice-1');
  assert.equal(runtime.resolveAgentToolOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'run-voice-1', mode: 'end', text: 'Duplicado',
  }).accepted, false);
  for (const listener of listeners) listener({
    type: 'run.completed',
    conversation: { id: 'conversation-1', messages: [] },
    run: { id: 'run-voice-1' },
  });
  await sent.runSettled;
  await runtime.dispose();
});

test('BDD: runtime falls back to the completed run final text and abort cancels the real run', async () => {
  const listeners = new Set();
  const canceled = [];
  let latestSentRun;
  const manager = {
    onConversationEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    sendSidekickMessage: async () => { latestSentRun = 'run-fallback'; return { activeRun: { id: latestSentRun } }; },
    cancelRun: async (runId) => { canceled.push(runId); return true; },
  };
  const runtime = new SidekickVoiceRuntime(runtimeDeps({ getPersonalAgentConversationManager: () => manager }).deps);
  const fallback = runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'Hola',
    signal: new AbortController().signal,
  });
  await eventually(() => listeners.size === 1);
  for (const listener of listeners) listener({
    type: 'run.completed',
    conversation: {
      id: 'conversation-1',
      messages: [{ role: 'assistant', kind: 'message', runId: 'run-fallback', content: 'Respuesta final.' }],
    },
    run: { id: 'run-fallback' },
  });
  assert.deepEqual(await fallback, {
    mode: 'end', text: 'Respuesta final.', runId: 'run-fallback', runSettled: (await fallback).runSettled,
  });

  manager.sendSidekickMessage = async () => { latestSentRun = 'run-question'; return { activeRun: { id: latestSentRun } }; };
  const questionFallback = runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'Pregunta',
    signal: new AbortController().signal,
  });
  await eventually(() => latestSentRun === 'run-question');
  for (const listener of listeners) listener({
    type: 'run.completed',
    conversation: {
      id: 'conversation-1',
      messages: [{ role: 'assistant', kind: 'message', runId: 'run-question', content: '¿Qué prefieres?' }],
    },
    run: { id: 'run-question' },
  });
  assert.equal((await questionFallback).mode, 'wait');

  manager.sendSidekickMessage = async () => { latestSentRun = 'run-abort'; return { activeRun: { id: latestSentRun } }; };
  const controller = new AbortController();
  const aborted = runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'Otra', signal: controller.signal,
  });
  await eventually(() => latestSentRun === 'run-abort');
  controller.abort(new Error('sidekick_voice_cancelled'));
  await assert.rejects(aborted, /sidekick_voice_cancelled/);
  await eventually(() => canceled.includes('run-abort'));
  await runtime.dispose();
});

test('BDD: runtime confirms playback only after the Sidekick reports playing', async () => {
  let finishPlayback;
  let playbackStarted = 0;
  const service = {
    getState: async () => ({ desktopId: 'desktop', sidekicks: [sidekick()], detectedUsb: [] }),
    speak: async () => await new Promise((resolve) => { finishPlayback = resolve; }),
  };
  const harness = runtimeDeps({ getSidekickService: () => service });
  const runtime = new SidekickVoiceRuntime(harness.deps);
  const work = runtime.speakWithTts({
    sidekickId: 'sidekick-1',
    text: 'Hola',
    signal: new AbortController().signal,
    onPlaybackStarted: () => { playbackStarted += 1; },
  });
  await eventually(() => Boolean(finishPlayback));

  runtime.onSidekickState({
    desktopId: 'desktop',
    sidekicks: [sidekick('online', { speakerPlayback: { status: 'starting' } })],
    detectedUsb: [],
  });
  assert.equal(playbackStarted, 0);
  runtime.onSidekickState({
    desktopId: 'desktop',
    sidekicks: [sidekick('online', { speakerPlayback: { status: 'playing' } })],
    detectedUsb: [],
  });
  await eventually(() => playbackStarted === 1);
  finishPlayback({ success: true });
  await work;
  await runtime.dispose();
});
