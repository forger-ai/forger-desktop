import assert from 'node:assert/strict';
import test from 'node:test';

import { buildListeningCuePcm, SidekickVoiceRuntime } from '../../dist-electron/main/sidekick-voice-runtime.js';

const voiceState = {
  config: { defaultModel: 'kokoro', defaultVoice: 'voice-en', maxTextCharacters: 20 },
  voices: [
    { id: 'voice-en', model: 'kokoro', locale: 'en-US', installed: true, enabled: true },
    { id: 'voice-es', model: 'kokoro', locale: 'es', installed: true, enabled: true },
  ],
};

const sidekick = (overrides = {}) => ({
  sidekickId: 'sidekick-1',
  name: 'Desk',
  status: 'online',
  capabilities: ['display.screens'],
  personalAgentId: 'agent-1',
  voiceConfig: { model: 'kokoro', voice: 'voice-en', locale: 'en-US', conversationTtlMinutes: 30 },
  speakerPlayback: { status: 'idle' },
  microphoneRecording: { status: 'idle' },
  microphoneRecordings: [],
  idleConfig: { screens: ['eyes'], rotateSeconds: 15 },
  ...overrides,
});

const createHarness = (overrides = {}) => {
  const state = {
    sidekick: sidekick(),
    startResult: null,
    stopResult: { success: true },
    transcribeResult: { success: true, text: ' hello ' },
    screenResult: { success: true },
    cueResult: { success: true },
    speakResult: { success: true },
  };
  const calls = { starts: [], stops: [], uploads: [], screens: [], cues: [], speaks: [], messages: [], logs: [], cancels: [] };
  const service = {
    getState: async () => ({ desktopId: 'desktop', sidekicks: state.sidekick ? [state.sidekick] : [], detectedUsb: [] }),
    startMicrophoneRecording: async (input) => {
      calls.starts.push(input);
      return state.startResult ?? {
        success: true,
        sidekicks: [{ ...state.sidekick, microphoneRecording: { status: 'recording', recordingId: 'recording-1' } }],
      };
    },
    stopMicrophoneRecording: async (input) => { calls.stops.push(input); return state.stopResult; },
    sendScreen: async (input) => { calls.screens.push(input); return state.screenResult; },
    playSpeakerPcm: async (input) => { calls.cues.push(input); return state.cueResult; },
    speak: async (input) => { calls.speaks.push(input); return state.speakResult; },
    notifyVoiceStateChanged: () => undefined,
  };
  const listeners = new Set();
  const conversationManager = {
    onConversationEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    getConversation: async (id) => id === 'conversation-1' ? { id, agentId: 'agent-1' } : null,
    sendSidekickMessage: async () => ({ activeRun: { id: 'run-1' } }),
    cancelRun: async (runId) => { calls.cancels.push(runId); return true; },
    canReuseSidekickConversation: async () => true,
    createSidekickConversation: async () => ({ id: 'conversation-new' }),
  };
  const store = {
    listAgents: async () => [{ id: 'agent-1' }],
    findLatestSidekickConversation: async () => null,
    addMessage: async (input) => calls.messages.push(input),
  };
  const deps = {
    getSidekickService: () => service,
    getSpeechToTextService: () => ({
      processUpload: async (input) => { calls.uploads.push(input); return state.transcribeResult; },
    }),
    getTextToSpeechService: () => ({ getState: async () => voiceState }),
    getPersonalAgentStore: () => store,
    getPersonalAgentConversationManager: () => conversationManager,
    appendLog: async (name, payload) => calls.logs.push({ name, payload }),
    ...overrides,
  };
  return { runtime: new SidekickVoiceRuntime(deps), state, calls, service, store, conversationManager, listeners, deps };
};

const abortedSignal = (reason = new Error('cancelled')) => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

test('given the listening cue, generated PCM has bounded silence, tone, and fades', () => {
  const pcm = buildListeningCuePcm();
  assert.equal(pcm.length, 4_320);
  assert.equal(pcm[0], 0);
  assert.equal(pcm[2_400], 0);
  assert.equal(pcm.some((sample) => sample !== 0), true);
  assert.ok(Math.abs(pcm.at(-1)) < 1_000);
});

test('given microphone, transcription, and screen adapters, success and safe failures are preserved', async () => {
  const harness = createHarness();
  const adapters = harness.runtime.manager.deps;

  await assert.rejects(adapters.startTransientMicrophone({ sidekickId: 'sidekick-1', signal: abortedSignal() }), /cancelled/);
  harness.state.startResult = { success: false, technicalCode: 'mic_denied' };
  await assert.rejects(adapters.startTransientMicrophone({ sidekickId: 'sidekick-1', signal: new AbortController().signal }), /mic_denied/);
  harness.state.startResult = { success: false };
  await assert.rejects(adapters.startTransientMicrophone({ sidekickId: 'sidekick-1', signal: new AbortController().signal }), /sidekick_voice_microphone_start_failed/);
  harness.state.startResult = { success: true, sidekicks: [] };
  await assert.rejects(adapters.startTransientMicrophone({ sidekickId: 'sidekick-1', signal: new AbortController().signal }), /recording_id_missing/);
  harness.state.startResult = null;
  assert.deepEqual(await adapters.startTransientMicrophone({ sidekickId: 'sidekick-1', signal: new AbortController().signal }), { recordingId: 'recording-1' });

  harness.state.sidekick = null;
  await adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' });
  harness.state.sidekick = sidekick({ microphoneRecording: { status: 'idle' } });
  await adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' });
  harness.state.sidekick = sidekick({ microphoneRecording: { status: 'error' } });
  await adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' });
  harness.state.sidekick = sidekick({ microphoneRecording: { status: 'recording', recordingId: 'recording-1' } });
  await adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' });
  harness.state.stopResult = { success: false, technicalCode: 'sidekick_microphone_recording_not_active' };
  await adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' });
  harness.state.stopResult = { success: false, technicalCode: 'stop_failed' };
  await assert.rejects(adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' }), /stop_failed/);
  harness.state.stopResult = { success: false };
  await assert.rejects(adapters.stopTransientMicrophone({ sidekickId: 'sidekick-1' }), /sidekick_voice_microphone_stop_failed/);

  harness.state.sidekick = sidekick({ voiceConfig: { ...sidekick().voiceConfig, sttLanguageMode: 'voice' } });
  await assert.rejects(adapters.transcribePcmBuffer({
    sidekickId: 'sidekick-1', chunks: [], sampleRate: 16_000, signal: abortedSignal(),
  }), /cancelled/);
  assert.equal(await adapters.transcribePcmBuffer({
    sidekickId: 'sidekick-1', chunks: [Uint8Array.from([0, 0])], sampleRate: 16_000, signal: new AbortController().signal,
  }), 'hello');
  assert.equal(harness.calls.uploads.at(-1).language, 'en');
  harness.state.sidekick = sidekick({ voiceConfig: { ...sidekick().voiceConfig, sttLanguageMode: 'subset', sttLanguages: ['es', 'en'] } });
  await adapters.transcribePcmBuffer({ sidekickId: 'sidekick-1', chunks: [], sampleRate: 16_000, signal: new AbortController().signal });
  assert.deepEqual(harness.calls.uploads.at(-1).languages, ['es', 'en']);
  harness.state.sidekick = sidekick({ voiceConfig: { ...sidekick().voiceConfig, sttLanguageMode: 'auto' } });
  harness.state.transcribeResult = { success: true };
  assert.equal(await adapters.transcribePcmBuffer({ sidekickId: 'sidekick-1', chunks: [], sampleRate: 16_000, signal: new AbortController().signal }), '');
  assert.equal('language' in harness.calls.uploads.at(-1), false);
  harness.state.transcribeResult = { success: false, technicalCode: 'stt_failed' };
  await assert.rejects(adapters.transcribePcmBuffer({ sidekickId: 'sidekick-1', chunks: [], sampleRate: 16_000, signal: new AbortController().signal }), /stt_failed/);
  harness.state.transcribeResult = { success: false };
  await assert.rejects(adapters.transcribePcmBuffer({ sidekickId: 'sidekick-1', chunks: [], sampleRate: 16_000, signal: new AbortController().signal }), /sidekick_voice_transcription_failed/);
  let transcribeSignalReads = 0;
  const abortAfterUpload = {
    get aborted() { transcribeSignalReads += 1; return transcribeSignalReads >= 2; },
    reason: new Error('cancel-after-upload'),
  };
  await assert.rejects(adapters.transcribePcmBuffer({
    sidekickId: 'sidekick-1', chunks: [], sampleRate: 16_000, signal: abortAfterUpload,
  }), /cancel-after-upload/);

  harness.state.screenResult = { success: true };
  await adapters.sendScreen({ sidekickId: 'sidekick-1', screen: 'idle' });
  await adapters.sendScreen({ sidekickId: 'sidekick-1', screen: 'transcript', transcript: 'heard', response: 'reply' });
  await adapters.sendScreen({ sidekickId: 'sidekick-1', screen: 'thinking' });
  assert.deepEqual(harness.calls.screens.map((entry) => entry.template), ['idle', 'transcript', 'state']);
  harness.state.screenResult = { success: false, technicalCode: 'screen_failed' };
  await assert.rejects(adapters.sendScreen({ sidekickId: 'sidekick-1', screen: 'idle' }), /screen_failed/);
  harness.state.screenResult = { success: false };
  await assert.rejects(adapters.sendScreen({ sidekickId: 'sidekick-1', screen: 'idle' }), /sidekick_voice_screen_failed/);
  assert.equal(await adapters.getConversationTtlMs('sidekick-1'), 30 * 60_000);
  assert.deepEqual(await adapters.createOrReuseConversation({ sidekickId: 'sidekick-1', ttlMs: 1 }), { conversationId: 'conversation-new' });
  harness.conversationManager.sendSidekickMessage = async () => ({ activeRun: undefined });
  await assert.rejects(adapters.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'hello', signal: new AbortController().signal,
  }), /run_id_missing/);
  harness.state.cueResult = { success: true };
  await adapters.playListeningCue({ sidekickId: 'sidekick-1', sessionId: 'session', signal: new AbortController().signal });
  await adapters.recordSpokenMessage({ sidekickId: 'sidekick-1', conversationId: 'conversation-1', text: 'spoken' });
  harness.state.speakResult = { success: true };
  await adapters.speakWithTts({
    sidekickId: 'sidekick-1', text: 'spoken', signal: new AbortController().signal, onPlaybackStarted: () => undefined,
  });
  assert.equal(harness.runtime.getVisiblePhase('sidekick-1'), 'idle');
  await harness.runtime.dispose();
});

test('given device events, PCM lifecycle, playback, disconnect, and reconcile errors remain observable', async () => {
  const harness = createHarness();
  const wakeEvents = [];
  const pcmEvents = [];
  const disconnects = [];
  const unsubscribeWake = harness.runtime.manager.deps.subscribeWake((event) => wakeEvents.push(event));
  const unsubscribePcm = harness.runtime.manager.deps.subscribePcm((event) => pcmEvents.push(event));
  harness.runtime.manager.deps.subscribeDisconnect((event) => disconnects.push(event));

  harness.runtime.onWakeDetected({ sidekickId: 'sidekick-1' });
  assert.equal(wakeEvents.length, 1);
  unsubscribeWake();
  harness.runtime.onWakeDetected({ sidekickId: 'sidekick-1', epochMs: 0 });
  assert.equal(wakeEvents.length, 1);

  const pcm = Uint8Array.from([0, 0, 1, 0]);
  harness.runtime.onMicrophonePcm({ sidekickId: 'sidekick-1', recordingId: 'recording-1', chunkSequence: 1, pcm });
  harness.runtime.onMicrophonePcm({ sidekickId: 'sidekick-1', recordingId: 'recording-1', chunkSequence: 2, pcm });
  assert.equal(pcmEvents.length, 2);
  unsubscribePcm();
  harness.runtime.onSidekickState({ desktopId: 'desktop', sidekicks: [], detectedUsb: [] });
  assert.equal(harness.runtime.microphonePreprocessors.size, 0);

  harness.runtime.manager.reconcileScreen = async () => { throw 'reconcile-offline'; };
  harness.runtime.onSidekickState({ desktopId: 'desktop', sidekicks: [sidekick({ status: 'online' })], detectedUsb: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.logs.at(-1).payload.technicalCode, 'reconcile-offline');
  harness.runtime.manager.reconcileScreen = async () => { throw new Error('reconcile-error'); };
  harness.runtime.deviceStatuses.delete('sidekick-1');
  harness.runtime.onSidekickState({ desktopId: 'desktop', sidekicks: [sidekick({ status: 'online' })], detectedUsb: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.calls.logs.at(-1).payload.technicalCode, 'reconcile-error');
  harness.runtime.onSidekickState({
    desktopId: 'desktop', sidekicks: [sidekick({ speakerPlayback: { status: 'playing' } })], detectedUsb: [],
  });
  harness.runtime.onSidekickState({ desktopId: 'desktop', sidekicks: [sidekick({ status: 'offline' })], detectedUsb: [] });
  assert.deepEqual(disconnects, [{ sidekickId: 'sidekick-1' }]);

  harness.runtime.manager.disconnect = async () => ({ status: 'cancelled' });
  await harness.runtime.onSidekickSessionInvalidated({ sidekickId: 'sidekick-1', reason: 'forgotten' });
  assert.equal(harness.calls.logs.at(-1).payload.activeSessionCancelled, true);
  await harness.runtime.dispose();
});

test('given direct cue, spoken-message, and TTS work, aborts and service errors clean every waiter', async () => {
  const harness = createHarness();
  await assert.rejects(harness.runtime.playListeningCue({ sidekickId: 'sidekick-1', sessionId: 's', signal: abortedSignal() }), /cancelled/);
  harness.state.cueResult = { success: false, technicalCode: 'cue_failed' };
  await assert.rejects(harness.runtime.playListeningCue({ sidekickId: 'sidekick-1', sessionId: 's', signal: new AbortController().signal }), /cue_failed/);
  harness.state.cueResult = { success: false };
  await assert.rejects(harness.runtime.playListeningCue({ sidekickId: 'sidekick-1', sessionId: 's', signal: new AbortController().signal }), /sidekick_voice_listening_cue_failed/);
  harness.state.cueResult = { success: true };
  await harness.runtime.playListeningCue({ sidekickId: 'sidekick-1', sessionId: 's', signal: new AbortController().signal });

  await harness.runtime.recordSpokenMessage({ sidekickId: 'sidekick-1', conversationId: 'missing', text: 'No record' });
  await harness.runtime.recordSpokenMessage({ sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'run', text: 'Spoken' });
  assert.equal(harness.calls.messages[0].kind, 'spoken');

  await assert.rejects(harness.runtime.speakWithTts({
    sidekickId: 'sidekick-1', text: 'hello', signal: abortedSignal(), onPlaybackStarted: () => undefined,
  }), /cancelled/);
  harness.state.speakResult = { success: false, technicalCode: 'tts_failed' };
  await assert.rejects(harness.runtime.speakWithTts({
    sidekickId: 'sidekick-1', text: 'hello', signal: new AbortController().signal, onPlaybackStarted: () => undefined,
  }), /tts_failed/);
  harness.state.speakResult = { success: false };
  await assert.rejects(harness.runtime.speakWithTts({
    sidekickId: 'sidekick-1', text: 'hello', signal: new AbortController().signal, onPlaybackStarted: () => undefined,
  }), /sidekick_voice_tts_failed/);
  harness.state.speakResult = { success: true };
  await harness.runtime.speakWithTts({
    sidekickId: 'sidekick-1', text: 'a message longer than max', signal: new AbortController().signal, onPlaybackStarted: () => undefined,
  });
  assert.equal(harness.calls.speaks.at(-1).text.length, 20);

  const alreadyAborted = abortedSignal();
  const waiter = harness.runtime.waitForPlaybackStarted('sidekick-1', alreadyAborted);
  await assert.rejects(waiter.promise, /cancelled/);
  waiter.cancel();
  assert.equal(harness.runtime.playbackStartedListeners.size, 0);

  const active = new AbortController();
  const activeWaiter = harness.runtime.waitForPlaybackStarted('sidekick-1', active.signal);
  const started = [...harness.runtime.playbackStartedListeners.get('sidekick-1')][0];
  started();
  started();
  await activeWaiter.promise;
  activeWaiter.cancel();

  let abortListener;
  const fakeAbort = {
    aborted: false,
    reason: undefined,
    addEventListener: (_name, listener) => { abortListener = listener; },
    removeEventListener: () => undefined,
  };
  const fallbackWaiter = harness.runtime.waitForPlaybackStarted('sidekick-1', fakeAbort);
  abortListener();
  abortListener();
  await assert.rejects(fallbackWaiter.promise, /sidekick_voice_cancelled/);
  fallbackWaiter.cancel();

  let reads = 0;
  const lateAbortSignal = {
    get aborted() { reads += 1; return reads >= 3; },
    reason: new Error('late-cancel'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  await assert.rejects(harness.runtime.speakWithTts({
    sidekickId: 'sidekick-1', text: 'late', signal: lateAbortSignal, onPlaybackStarted: () => undefined,
  }), /late-cancel/);

  harness.state.sidekick = null;
  await assert.rejects(harness.runtime.requireSidekick('missing'), /sidekick_not_registered/);
  await harness.runtime.dispose();
});

test('given agent run races, buffered completion, missing runs, failures, and cancellation settle exactly once', async () => {
  const harness = createHarness();
  let listener;
  harness.conversationManager.onConversationEvent = (next) => { listener = next; return () => undefined; };
  harness.conversationManager.sendSidekickMessage = async () => {
    listener({ type: 'ignored', conversation: { id: 'other', messages: [] } });
    listener({ type: 'progress', conversation: { id: 'conversation-1', messages: [] } });
    listener({
      type: 'run.completed',
      conversation: { id: 'conversation-1', messages: [{ role: 'assistant', kind: 'message', runId: 'run-buffered', content: '' }] },
      run: { id: 'run-buffered' },
    });
    return { activeRun: { id: 'run-buffered' } };
  };
  const buffered = await harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'hello', signal: new AbortController().signal,
  });
  assert.equal(buffered.text, '');
  listener({ type: 'run.completed', conversation: { id: 'conversation-1', messages: [] }, run: { id: 'run-buffered' } });

  harness.conversationManager.sendSidekickMessage = async () => ({ activeRun: undefined });
  await assert.rejects(harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'missing', signal: new AbortController().signal,
  }), /run_id_missing/);

  const abortBeforeSendWithoutReason = {
    aborted: true,
    reason: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  await assert.rejects(harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'abort-before-send', signal: abortBeforeSendWithoutReason,
  }), /sidekick_voice_cancelled/);

  let afterSendAbortReads = 0;
  const abortAfterSendWithoutReason = {
    get aborted() { afterSendAbortReads += 1; return afterSendAbortReads >= 2; },
    reason: undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  harness.conversationManager.sendSidekickMessage = async () => ({ activeRun: { id: 'run-abort-without-reason' } });
  await assert.rejects(harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'abort-after-send', signal: abortAfterSendWithoutReason,
  }), /sidekick_voice_cancelled/);

  for (const [type, error, expected] of [
    ['run.failed', 'agent_failed', /agent_failed/],
    ['run.canceled', undefined, /sidekick_voice_agent_run.canceled/],
  ]) {
    harness.conversationManager.sendSidekickMessage = async () => ({ activeRun: { id: `run-${type}` } });
    const pending = harness.runtime.sendMessageAndWaitForOutcome({
      sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: type, signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    listener({ type, conversation: { id: 'conversation-1', messages: [] }, run: { id: `run-${type}`, error } });
    await assert.rejects(pending, expected);
  }

  let resolveSend;
  harness.conversationManager.sendSidekickMessage = async () => await new Promise((resolve) => { resolveSend = resolve; });
  const abortController = new AbortController();
  const afterSend = harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'abort', signal: abortController.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  abortController.abort(new Error('abort-after-send'));
  resolveSend({ activeRun: { id: 'run-after-send' } });
  await assert.rejects(afterSend, /abort-after-send/);

  let fakeAbortListener;
  const fakeSignal = {
    aborted: false,
    reason: undefined,
    addEventListener: (_name, next) => { fakeAbortListener = next; },
    removeEventListener: () => undefined,
  };
  harness.conversationManager.sendSidekickMessage = async () => ({ activeRun: { id: 'run-fallback-abort' } });
  const fallbackAbort = harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'abort', signal: fakeSignal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  fakeAbortListener();
  await assert.rejects(fallbackAbort, /sidekick_voice_cancelled/);

  harness.conversationManager.sendSidekickMessage = async () => ({ activeRun: { id: 'run-outcome' } });
  const outcome = harness.runtime.sendMessageAndWaitForOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', content: 'outcome', signal: new AbortController().signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  listener({ type: 'run.completed', conversation: { id: 'conversation-1', messages: [] }, run: { id: 'wrong-run' } });
  assert.equal(harness.runtime.resolveAgentToolOutcome({
    sidekickId: 'sidekick-1', conversationId: 'conversation-1', runId: 'run-outcome', mode: 'end', text: 'done',
  }).accepted, true);
  const resolvedOutcome = await outcome;
  listener({ type: 'run.completed', conversation: { id: 'conversation-1', messages: [] }, run: { id: 'run-outcome' } });
  await resolvedOutcome.runSettled;
  await harness.runtime.dispose();
});

test('given voice logging, ordered events survive one failed append and dispose drains the queue', async () => {
  const names = [];
  let attempts = 0;
  const harness = createHarness({
    appendLog: async (name) => {
      attempts += 1;
      if (attempts === 1) throw new Error('log-offline');
      names.push(name);
    },
  });
  harness.runtime.logVoiceEvent({
    type: 'session.started', eventSequence: 1, occurredAt: 0,
    session: { sidekickId: 'sidekick-1', sessionId: 'session-1' },
  });
  harness.runtime.logVoiceEvent({
    type: 'phase.changed', eventSequence: 2, occurredAt: 1,
    session: { sidekickId: 'sidekick-1', sessionId: 'session-1', phase: 'thinking', heardSpeech: true, receivedSamples: 10 },
  });
  harness.runtime.logVoiceEvent({
    type: 'session.finished', eventSequence: 3, occurredAt: 2,
    result: { sidekickId: 'sidekick-1', sessionId: 'session-1', status: 'completed', technicalCode: undefined },
  });
  await harness.runtime.dispose();
  assert.deepEqual(names, ['sidekick:voice_phase_changed', 'sidekick:voice_session_finished']);

  const noLog = createHarness({ appendLog: undefined });
  noLog.runtime.logVoiceEvent({
    type: 'session.started', eventSequence: 1, occurredAt: 0,
    session: { sidekickId: 'sidekick-1', sessionId: 'session-1' },
  });
  await noLog.runtime.dispose();
});
