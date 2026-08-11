import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { SidekickVoiceSessionManager } = require('../../dist-electron/main/sidekick-voice-session-manager.js');

class FakeClock {
  now = 1_000;
  nextId = 1;
  timers = new Map();

  setTimer = (callback, delayMs) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clearTimer = (id) => this.timers.delete(id);

  advance(ms) {
    const target = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

const eventually = async (predicate, label) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed_out_waiting_for:${label}`);
};

const speech = (amplitude = 2_000, samples = 8) => {
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, amplitude, true);
  return pcm;
};

const harnessFor = ({ overrides = {}, options = {}, start = true } = {}) => {
  const clock = new FakeClock();
  const listeners = { wake: new Set(), pcm: new Set(), disconnect: new Set() };
  const calls = { screens: [], starts: [], stops: [], messages: [], speech: [], events: [], unsubscribes: 0 };
  const subscribe = (kind) => (listener) => {
    listeners[kind].add(listener);
    return () => {
      calls.unsubscribes += 1;
      listeners[kind].delete(listener);
    };
  };
  const deps = {
    subscribeWake: subscribe('wake'),
    subscribePcm: subscribe('pcm'),
    subscribeDisconnect: subscribe('disconnect'),
    startTransientMicrophone: async (input) => {
      calls.starts.push(input);
      return { recordingId: `recording-${input.sessionId}` };
    },
    stopTransientMicrophone: async (input) => calls.stops.push(input),
    transcribePcmBuffer: async () => 'turn on the light',
    createOrReuseConversation: async (input) => ({ conversationId: input.existingConversationId ?? 'conversation-1' }),
    sendMessageAndWaitForOutcome: async (input) => {
      calls.messages.push(input);
      return { mode: 'end', text: 'Done.' };
    },
    sendScreen: async (input) => calls.screens.push(input),
    speakWithTts: async (input) => {
      calls.speech.push(input);
      await input.onPlaybackStarted();
    },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (event) => calls.events.push(event),
    ...overrides,
  };
  const manager = new SidekickVoiceSessionManager(deps, {
    maxListeningMs: 100,
    speechOnsetTimeoutMs: 100,
    silenceAfterSpeechMs: 10,
    maxSessionMs: 1_000,
    speechStartChunks: 1,
    terminalStateDwellMs: 20,
    terminalScreenTimeoutMs: 20,
    microphoneStopTimeoutMs: 20,
    speechCancellationTimeoutMs: 20,
    followUpOnsetTimeoutMs: 100,
    runSettleTimeoutMs: 20,
    ...options,
  });
  if (start) manager.start();
  const emitPcm = (pcm = speech(), extra = {}) => {
    const session = manager.getActiveSession('sidekick-1');
    for (const listener of listeners.pcm) listener({
      sidekickId: 'sidekick-1',
      recordingId: session ? `recording-${session.sessionId}` : undefined,
      pcm,
      ...extra,
    });
  };
  return { manager, deps, clock, calls, listeners, emitPcm };
};

const reachAgent = async (harness) => {
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.starts.length === 1, 'microphone-start');
  harness.emitPcm();
  harness.clock.advance(10);
  return completion;
};

test('voice manager validates integer and hysteresis contracts and isolates lifecycle observers', async () => {
  const base = harnessFor({ start: false });
  assert.throws(() => new SidekickVoiceSessionManager(base.deps, { speechStartChunks: 1.5 }), /speechStartChunks_invalid/);
  assert.throws(() => new SidekickVoiceSessionManager(base.deps, { maxFollowUpTurns: 1.5 }), /maxFollowUpTurns_invalid/);
  assert.throws(() => new SidekickVoiceSessionManager(base.deps, {
    speechStartRmsThreshold: 100,
    speechContinueRmsThreshold: 101,
  }), /speech_threshold_hysteresis_invalid/);

  const withoutDisconnect = harnessFor({
    start: false,
    overrides: {
      subscribeDisconnect: undefined,
      onEvent: () => { throw new Error('observer failed'); },
    },
  });
  withoutDisconnect.manager.onEvent(() => { throw new Error('listener failed'); });
  withoutDisconnect.manager.start();
  withoutDisconnect.manager.start();
  withoutDisconnect.manager.emit({ type: 'session.finished', eventSequence: 1, occurredAt: 1, result: { sidekickId: 'x', status: 'ignored' } });
  for (const listener of withoutDisconnect.listeners.wake) listener({ sidekickId: ' ' });
  await eventually(() => true, 'wake-dispatched');
  assert.equal(withoutDisconnect.manager.getVisiblePhase('missing'), 'idle');
  assert.deepEqual(withoutDisconnect.manager.listActiveSessions(), []);
  await withoutDisconnect.manager.reconcileScreen('missing');
  assert.deepEqual(withoutDisconnect.calls.screens.at(-1), { sidekickId: 'missing', screen: 'idle' });

  const session = withoutDisconnect.manager.createSession('sidekick-1');
  session.phase = 'transcript';
  session.transcript = 'User said this';
  session.assistantText = 'Assistant said this';
  withoutDisconnect.manager.active.set('sidekick-1', session);
  assert.equal(withoutDisconnect.manager.getVisiblePhase('sidekick-1'), 'transcript');
  await withoutDisconnect.manager.reconcileScreen('sidekick-1');
  assert.deepEqual(withoutDisconnect.calls.screens.at(-1), {
    sidekickId: 'sidekick-1',
    screen: 'transcript',
    transcript: 'User said this',
    response: 'Assistant said this',
  });
  withoutDisconnect.manager.active.delete('sidekick-1');
  withoutDisconnect.manager.terminalStates.set('sidekick-1', { sessionId: session.sessionId, phase: 'error', timer: 99 });
  assert.equal(withoutDisconnect.manager.getVisiblePhase('sidekick-1'), 'error');
  await withoutDisconnect.manager.reconcileScreen('sidekick-1');
  await withoutDisconnect.manager.dispose();
  assert.equal(withoutDisconnect.calls.unsubscribes, 2);

  const native = harnessFor({ start: false, overrides: { now: undefined, setTimer: undefined, clearTimer: undefined } });
  assert.equal(typeof native.manager.now(), 'number');
  const timer = native.manager.setTimer(() => undefined, 60_000);
  native.manager.clearTimer(timer);
  native.manager.clearTimer(undefined);
  await native.manager.dispose();
});

test('voice wake replacement rechecks disposal and child identity after speaking cancellation', async () => {
  const disposed = harnessFor();
  const old = disposed.manager.createSession('sidekick-1');
  old.phase = 'speaking';
  old.completion = Promise.resolve().then(() => {
    disposed.manager.disposed = true;
  });
  disposed.manager.active.set('sidekick-1', old);
  const disposedResult = await disposed.manager.triggerWake({ sidekickId: 'sidekick-1' });
  assert.equal(disposedResult.technicalCode, 'sidekick_voice_manager_disposed');

  const occupied = harnessFor();
  const speaking = occupied.manager.createSession('sidekick-1');
  speaking.phase = 'speaking';
  speaking.completion = Promise.resolve();
  occupied.manager.active.set('sidekick-1', speaking);
  const occupiedResult = await occupied.manager.triggerWake({ sidekickId: 'sidekick-1' });
  assert.equal(occupiedResult.technicalCode, 'sidekick_voice_session_active');
  occupied.manager.active.clear();
  await occupied.manager.dispose();
});

test('voice PCM ingestion rejects stale or malformed chunks and preserves the first asynchronous STT error', async () => {
  let appendAttempt = 0;
  const firstFailure = new Error('first append failed');
  const harness = harnessFor({
    overrides: {
      createRealtimeSttSession: async () => ({
        appendPcm: async () => {
          appendAttempt += 1;
          throw appendAttempt === 1 ? firstFailure : new Error('second append failed');
        },
        finish: async () => 'unused',
        cancel: async () => undefined,
      }),
      transcribePcmBuffer: undefined,
    },
  });
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.starts.length === 1, 'capture-started');
  const session = harness.manager.active.get('sidekick-1');
  harness.manager.receivePcm({ sidekickId: 'missing', pcm: speech() });
  harness.manager.receivePcm({ sidekickId: 'sidekick-1', recordingId: 'wrong', pcm: speech() });
  harness.manager.receivePcm({ sidekickId: 'sidekick-1', pcm: [], recordingId: session.recordingId });
  harness.manager.receivePcm({ sidekickId: 'sidekick-1', pcm: new Uint8Array(), recordingId: session.recordingId });
  harness.manager.receivePcm({ sidekickId: 'sidekick-1', pcm: new Uint8Array(40_000), recordingId: session.recordingId });
  harness.manager.receivePcm({ sidekickId: 'sidekick-1', pcm: new Uint8Array([1]), recordingId: session.recordingId, sampleRate: -1 });
  await session.pcmWork;
  session.captureRequested = false;
  session.acceptingPcm = true;
  harness.manager.receivePcm({ sidekickId: 'sidekick-1', pcm: speech(), recordingId: session.recordingId, sampleRate: 48_000 });
  await session.pcmWork;
  assert.equal(session.pcmError, firstFailure);
  assert.equal(session.sampleRate, 48_000);
  session.captureRequested = false;
  harness.manager.requestCaptureFinish(session);
  harness.manager.requestCaptureFinish(session);
  assert.equal((await completion).technicalCode, 'first append failed');

  const detector = harnessFor({ overrides: { detectSpeech: () => false } });
  const detectorCompletion = detector.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => detector.calls.starts.length === 1, 'detector-started');
  detector.emitPcm(speech(), { recordingId: undefined });
  detector.clock.advance(100);
  assert.equal((await detectorCompletion).status, 'silence');
  await detector.manager.dispose();

  const positiveDetector = harnessFor({ overrides: { detectSpeech: () => true } });
  const positiveCompletion = positiveDetector.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => positiveDetector.calls.starts.length === 1, 'positive-detector-started');
  positiveDetector.emitPcm(speech());
  positiveDetector.clock.advance(10);
  assert.equal((await positiveCompletion).status, 'completed');
  await positiveDetector.manager.dispose();
});

test('voice agent failures cover empty replies, missing playback ACK, settle timeout, and abort during settle', async () => {
  const empty = harnessFor({ overrides: { sendMessageAndWaitForOutcome: async () => ({ mode: 'end', text: '   ' }) } });
  assert.equal((await reachAgent(empty)).technicalCode, 'sidekick_voice_agent_response_empty');
  await empty.manager.dispose();

  const noAck = harnessFor({ overrides: { speakWithTts: async (input) => noAck.calls.speech.push(input) } });
  assert.equal((await reachAgent(noAck)).technicalCode, 'sidekick_voice_playback_start_unconfirmed');
  await noAck.manager.dispose();

  const neverSettles = new Promise(() => undefined);
  const timed = harnessFor({
    overrides: {
      sendMessageAndWaitForOutcome: async () => ({ mode: 'end', text: 'Spoken.', runSettled: neverSettles }),
      recordSpokenMessage: async () => { throw new Error('receipt persistence unavailable'); },
      speakWithTts: async (input) => {
        timed.calls.speech.push(input);
        await input.onPlaybackStarted();
        await input.onPlaybackStarted();
      },
    },
  });
  const timedCompletion = reachAgent(timed);
  await eventually(() => timed.calls.speech.length === 1, 'speech-started');
  timed.clock.advance(20);
  assert.equal((await timedCompletion).technicalCode, 'sidekick_voice_run_settle_timeout');
  await timed.manager.dispose();

  const interrupted = harnessFor({
    overrides: {
      sendMessageAndWaitForOutcome: async () => ({ mode: 'end', text: 'Spoken.', runSettled: neverSettles }),
    },
  });
  const interruptedCompletion = reachAgent(interrupted);
  await eventually(() => interrupted.calls.speech.length === 1, 'interrupted-speech-started');
  await interrupted.manager.cancel('sidekick-1');
  assert.equal((await interruptedCompletion).status, 'cancelled');
  await interrupted.manager.dispose();
});

test('voice conversations normalize TTL, reject blank identities, and clear stale terminal receipts', async () => {
  const harness = harnessFor();
  const session = harness.manager.createSession('sidekick-1');
  harness.manager.deps.getConversationTtlMs = async () => Number.NaN;
  assert.equal((await harness.manager.resolveConversation(session)).conversationId, 'conversation-1');
  harness.manager.deps.getConversationTtlMs = async () => 250;
  harness.manager.conversations.clear();
  await harness.manager.resolveConversation(session);
  assert.equal(harness.manager.conversations.get('sidekick-1').expiresAt, harness.clock.now + 250);
  harness.manager.deps.createOrReuseConversation = async () => ({ conversationId: ' ' });
  harness.manager.conversations.clear();
  await assert.rejects(harness.manager.resolveConversation(session), /conversation_id_required/);

  const stale = harness.manager.createSession('sidekick-1');
  harness.manager.scheduleTerminalIdle(stale);
  harness.manager.terminalStates.set('sidekick-1', { sessionId: 'newer-session', phase: 'error', timer: 123 });
  harness.clock.advance(20);
  assert.equal(harness.manager.terminalStates.get('sidekick-1').sessionId, 'newer-session');
  harness.manager.clearTerminalState('sidekick-1');
  assert.equal(harness.manager.terminalStates.has('sidekick-1'), false);
  await harness.manager.dispose();
});

test('voice deadlines ignore late settlements and abort races observe the default cancellation identity', async () => {
  const harness = harnessFor();
  let resolveLate;
  const lateResolution = new Promise((resolve) => { resolveLate = resolve; });
  const timedResolution = harness.manager.withDeadline(lateResolution, 10, 'late_resolution');
  harness.clock.advance(10);
  await assert.rejects(timedResolution, /late_resolution/);
  resolveLate('late');
  await new Promise((resolve) => setImmediate(resolve));

  let rejectLate;
  const lateRejection = new Promise((_resolve, reject) => { rejectLate = reject; });
  const timedRejection = harness.manager.withDeadline(lateRejection, 10, 'late_rejection');
  harness.clock.advance(10);
  await assert.rejects(timedRejection, /late_rejection/);
  rejectLate(new Error('too late'));
  await new Promise((resolve) => setImmediate(resolve));

  const session = harness.manager.createSession('sidekick-1');
  session.controller.abort();
  const laterFailure = Promise.reject(new Error('adapter rejected later'));
  await assert.rejects(harness.manager.raceWithAbort(laterFailure, session), /sidekick_voice_cancelled/);
  harness.manager.active.set('sidekick-1', session);
  harness.manager.abortSession(session, 'cancelled');

  const pendingSession = harness.manager.createSession('pending');
  const pendingRace = harness.manager.raceWithAbort(new Promise(() => undefined), pendingSession);
  pendingSession.controller.abort();
  await assert.rejects(pendingRace, /sidekick_voice_cancelled/);
  harness.manager.active.set('sidekick-1', harness.manager.createSession('sidekick-1'));
  harness.manager.abortSession(session, 'cancelled');
  await harness.manager.dispose();

  const uncleared = harnessFor({ overrides: { clearTimer: () => undefined } });
  assert.equal(await uncleared.manager.withDeadline(Promise.resolve('done'), 10, 'must_not_fire'), 'done');
  uncleared.clock.advance(10);
  await uncleared.manager.dispose();
});

test('voice rendering, cleanup, and primitive adapter failures remain best effort', async () => {
  const harness = harnessFor({ overrides: { sendScreen: async () => { throw new Error('screen offline'); } } });
  const session = harness.manager.createSession('sidekick-1');
  harness.manager.active.set('sidekick-1', session);
  session.transcript = 'Hello';
  session.assistantText = 'Hi';
  await assert.rejects(harness.manager.transition(session, 'transcript'), /screen offline/);
  await harness.manager.transitionBestEffort(session, 'thinking');

  session.microphoneState = 'started';
  session.recordingId = undefined;
  harness.manager.deps.stopTransientMicrophone = async (input) => harness.calls.stops.push(input);
  await harness.manager.stopMicrophone(session, 'complete');
  assert.equal('recordingId' in harness.calls.stops.at(-1), false);
  await harness.manager.stopMicrophone(session, 'complete');
  harness.manager.active.delete('sidekick-1');
  await harness.manager.dispose();

  const primitive = harnessFor({
    overrides: {
      startTransientMicrophone: async () => { throw null; },
      sendScreen: async () => undefined,
    },
  });
  const result = await primitive.manager.triggerWake({ sidekickId: 'sidekick-1' });
  assert.equal(result.technicalCode, 'sidekick_voice_session_failed');
  await primitive.manager.dispose();
});
