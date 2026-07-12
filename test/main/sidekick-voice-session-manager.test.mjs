import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SIDEKICK_VOICE_CONVERSATION_TTL_MS,
  SidekickVoiceSessionManager,
} = require('../../dist-electron/main/sidekick-voice-session-manager.js');

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

const eventually = async (predicate, message = 'condition not reached') => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};

const pcmAt = (amplitude, samples = 160) => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, amplitude, true);
  return bytes;
};

const speech = (samples = 160) => pcmAt(2_000, samples);

const createHarness = ({ buffered = false, overrides = {}, managerOptions = {} } = {}) => {
  const clock = new FakeClock();
  const listeners = { wake: new Set(), pcm: new Set(), disconnect: new Set() };
  const calls = {
    microphoneStarts: [],
    microphoneStops: [],
    screens: [],
    sttAppends: [],
    sttCancels: 0,
    bufferedTranscriptions: [],
    conversations: [],
    messages: [],
    speech: [],
    events: [],
    unsubscribes: 0,
  };
  let conversationNumber = 0;
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
      calls.microphoneStarts.push(input);
      return { recordingId: `recording-${input.sessionId}` };
    },
    stopTransientMicrophone: async (input) => {
      calls.microphoneStops.push(input);
    },
    ...(buffered ? {
      transcribePcmBuffer: async (input) => {
        calls.bufferedTranscriptions.push(input);
        return 'mensaje por buffer';
      },
    } : {
      createRealtimeSttSession: async () => ({
        appendPcm: async (pcm) => calls.sttAppends.push(Uint8Array.from(pcm)),
        finish: async () => 'enciende la luz',
        cancel: async () => { calls.sttCancels += 1; },
      }),
    }),
    createOrReuseConversation: async (input) => {
      calls.conversations.push(input);
      return { conversationId: input.existingConversationId ?? `conversation-${++conversationNumber}` };
    },
    sendMessageAndWaitForFinal: async (input) => {
      calls.messages.push(input);
      return 'La luz quedó encendida.';
    },
    sendScreen: async (input) => {
      calls.screens.push(input);
    },
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
    maxListeningMs: 10_000,
    speechOnsetTimeoutMs: 10_000,
    silenceAfterSpeechMs: 500,
    speechStartChunks: 1,
    maxSessionMs: 60_000,
    ...managerOptions,
  });
  manager.start();
  return {
    manager,
    clock,
    calls,
    emitWake: (sidekickId = 'sidekick-1') => {
      for (const listener of listeners.wake) listener({ sidekickId });
    },
    emitPcm: (pcm = speech(), sidekickId = 'sidekick-1') => {
      const active = manager.getActiveSession(sidekickId);
      for (const listener of listeners.pcm) listener({
        sidekickId,
        pcm,
        sampleRate: 16_000,
        recordingId: active ? `recording-${active.sessionId}` : undefined,
      });
    },
    emitDisconnect: (sidekickId = 'sidekick-1') => {
      for (const listener of listeners.disconnect) listener({ sidekickId });
    },
  };
};

const completeTurn = async (harness, sidekickId = 'sidekick-1') => {
  const startCount = harness.calls.microphoneStarts.length;
  const completion = harness.manager.triggerWake({ sidekickId });
  await eventually(() => harness.calls.microphoneStarts.length === startCount + 1);
  harness.emitPcm(speech(), sidekickId);
  harness.emitPcm(speech(), sidekickId);
  harness.clock.advance(500);
  return await completion;
};

test('BDD: a wake word completes listening, STT, agent, transcript and TTS without exposing PCM in state', async () => {
  const harness = createHarness();
  const observed = [];
  const unsubscribe = harness.manager.onEvent((event) => observed.push(event));

  const result = await completeTurn(harness);

  assert.deepEqual(result, {
    sessionId: result.sessionId,
    sidekickId: 'sidekick-1',
    status: 'completed',
    transcript: 'enciende la luz',
    assistantText: 'La luz quedó encendida.',
    conversationId: 'conversation-1',
  });
  assert.deepEqual(harness.calls.screens.map((screen) => screen.screen), [
    'listening', 'transcribing', 'thinking', 'speaking', 'idle',
  ]);
  assert.equal(harness.calls.sttAppends.length, 2);
  assert.equal(harness.calls.messages[0].content, 'enciende la luz');
  assert.equal(harness.calls.speech[0].text, 'La luz quedó encendida.');
  assert.equal(harness.calls.microphoneStarts.length, 1);
  assert.equal(harness.calls.microphoneStops[0].reason, 'complete');
  assert.equal(harness.manager.getActiveSession('sidekick-1'), null);
  assert.equal(/pcm|audio|chunk/i.test(JSON.stringify({ result, observed })), false);
  assert.deepEqual(
    observed.map((event) => event.eventSequence),
    observed.map((_event, index) => index + 1),
    'session events are strictly ordered for log/UI correlation',
  );
  unsubscribe();
  await harness.manager.dispose();
});

test('BDD: voice turns reuse the same personal-agent conversation for 30 minutes and rotate it after expiry', async () => {
  const harness = createHarness();
  await completeTurn(harness);
  harness.clock.advance(SIDEKICK_VOICE_CONVERSATION_TTL_MS - 1_000);
  await completeTurn(harness);
  harness.clock.advance(SIDEKICK_VOICE_CONVERSATION_TTL_MS + 1);
  await completeTurn(harness);

  assert.equal(harness.calls.conversations[0].ttlMs, SIDEKICK_VOICE_CONVERSATION_TTL_MS);
  assert.equal(harness.calls.conversations[0].existingConversationId, undefined);
  assert.equal(harness.calls.conversations[1].existingConversationId, 'conversation-1');
  assert.equal(harness.calls.conversations[2].existingConversationId, undefined);
  assert.deepEqual(harness.calls.messages.map((entry) => entry.conversationId), [
    'conversation-1', 'conversation-1', 'conversation-2',
  ]);
  await harness.manager.dispose();
});

test('BDD: silence stops the transient microphone and returns to idle without invoking agent or TTS', async () => {
  const harness = createHarness();
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.clock.advance(10_000);
  const result = await completion;

  assert.equal(result.status, 'silence');
  assert.equal(harness.calls.messages.length, 0);
  assert.equal(harness.calls.speech.length, 0);
  assert.equal(harness.calls.sttCancels, 1);
  assert.deepEqual(harness.calls.screens.map((screen) => screen.screen), ['listening', 'error']);
  assert.equal(harness.manager.getActiveSession('sidekick-1'), null, 'terminal dwell must not retain the turn');
  harness.clock.advance(1_500);
  await eventually(() => harness.calls.screens.at(-1)?.screen === 'idle');
  await harness.manager.dispose();
});

test('BDD: VAD requires sustained onset and uses a lower continuation threshold before ending speech', async () => {
  const harness = createHarness({
    managerOptions: {
      speechStartRmsThreshold: 1_000,
      speechContinueRmsThreshold: 700,
      speechStartChunks: 2,
    },
  });
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);

  harness.emitPcm(pcmAt(2_000));
  harness.emitPcm(pcmAt(200));
  assert.equal(harness.manager.getActiveSession('sidekick-1').heardSpeech, false, 'one loud spike is not speech onset');

  harness.emitPcm(pcmAt(1_200));
  harness.emitPcm(pcmAt(1_100));
  assert.equal(harness.manager.getActiveSession('sidekick-1').heardSpeech, true);
  harness.clock.advance(400);
  harness.emitPcm(pcmAt(800));
  harness.clock.advance(400);
  assert.equal(harness.manager.getActiveSession('sidekick-1').phase, 'listening', 'continuing voice extends the endpoint');
  harness.emitPcm(pcmAt(300));
  harness.clock.advance(100);

  assert.equal((await completion).status, 'completed');
  await harness.manager.dispose();
});

test('BDD: speaking is emitted only after playback reports that hardware started', async () => {
  let reportPlaybackStarted;
  let finishPlayback;
  const harness = createHarness({
    overrides: {
      speakWithTts: async (input) => {
        harness.calls.speech.push(input);
        reportPlaybackStarted = input.onPlaybackStarted;
        await new Promise((resolve) => { finishPlayback = resolve; });
      },
    },
  });
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.emitPcm();
  harness.emitPcm();
  harness.clock.advance(500);
  await eventually(() => Boolean(reportPlaybackStarted));

  assert.equal(harness.manager.getActiveSession('sidekick-1').phase, 'thinking');
  assert.equal(harness.calls.screens.some((screen) => screen.screen === 'speaking'), false);
  await reportPlaybackStarted();
  assert.equal(harness.manager.getActiveSession('sidekick-1').phase, 'speaking');
  finishPlayback();
  assert.equal((await completion).status, 'completed');
  await harness.manager.dispose();
});

test('BDD: buffered STT receives only ephemeral chunks and the manager clears them after the turn', async () => {
  const harness = createHarness({ buffered: true });
  const result = await completeTurn(harness);

  assert.equal(result.transcript, 'mensaje por buffer');
  assert.equal(harness.calls.bufferedTranscriptions.length, 1);
  assert.equal(harness.calls.bufferedTranscriptions[0].chunks.length, 0);
  assert.equal(harness.manager.listActiveSessions().length, 0);
  assert.equal(JSON.stringify(result).includes('pcm'), false);
  await harness.manager.dispose();
});

test('BDD: cancelling an active turn aborts STT, stops capture and renders idle', async () => {
  const harness = createHarness();
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);

  const cancelled = await harness.manager.cancel('sidekick-1');
  assert.equal((await completion).status, 'cancelled');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(harness.calls.microphoneStops[0].reason, 'cancelled');
  assert.equal(harness.calls.sttCancels, 1);
  assert.equal(harness.calls.screens.at(-1).screen, 'idle');
  assert.equal(await harness.manager.cancel('missing'), null);
  await harness.manager.dispose();
});

test('BDD: a hardware disconnect ends the turn without trying to continue to the agent', async () => {
  const harness = createHarness();
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.emitDisconnect();

  assert.equal((await completion).status, 'disconnected');
  assert.equal(harness.calls.microphoneStops[0].reason, 'disconnected');
  assert.equal(harness.calls.messages.length, 0);
  await harness.manager.dispose();
});

test('BDD: microphone stop has a hard deadline and still releases the session back to idle', async () => {
  const harness = createHarness({
    overrides: {
      stopTransientMicrophone: async (input) => {
        harness.calls.microphoneStops.push(input);
        if (harness.calls.microphoneStops.length === 1) {
          return await new Promise(() => undefined);
        }
      },
    },
    managerOptions: { microphoneStopTimeoutMs: 250 },
  });
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.emitPcm();
  harness.clock.advance(500);
  await eventually(() => harness.calls.microphoneStops.length === 1);
  harness.clock.advance(250);

  const result = await completion;
  assert.equal(result.status, 'error');
  assert.equal(result.technicalCode, 'sidekick_voice_microphone_stop_timeout');
  assert.equal(harness.calls.microphoneStops.length, 2, 'terminal cleanup retries an unconfirmed stop idempotently');
  assert.equal(harness.manager.getActiveSession('sidekick-1'), null);
  assert.equal(harness.calls.screens.at(-1).screen, 'error');
  harness.clock.advance(1_500);
  await eventually(() => harness.calls.screens.at(-1)?.screen === 'idle');
  await harness.manager.dispose();
});

test('BDD: a wake during speaking cancels playback and waits for its terminal ack before listening again', async () => {
  let releaseCancelledPlayback;
  let playbackAborted = false;
  const harness = createHarness({
    overrides: {
      speakWithTts: async (input) => {
        harness.calls.speech.push(input);
        await input.onPlaybackStarted();
        if (harness.calls.speech.length > 1) return;
        await new Promise((resolve) => {
          releaseCancelledPlayback = resolve;
          input.signal.addEventListener('abort', () => { playbackAborted = true; }, { once: true });
        });
      },
    },
    managerOptions: { speechCancellationTimeoutMs: 1_000 },
  });
  const first = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.emitPcm();
  harness.clock.advance(500);
  await eventually(() => harness.manager.getActiveSession('sidekick-1')?.phase === 'speaking');

  const second = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => playbackAborted);
  assert.equal(harness.calls.microphoneStarts.length, 1, 'new capture must wait for playback cancellation');
  releaseCancelledPlayback();
  await eventually(() => harness.calls.microphoneStarts.length === 2);
  assert.equal((await first).status, 'cancelled');

  harness.emitPcm();
  harness.clock.advance(500);
  assert.equal((await second).status, 'completed');
  assert.deepEqual(harness.calls.screens.map((screen) => screen.screen), [
    'listening', 'transcribing', 'thinking', 'speaking', 'idle',
    'listening', 'transcribing', 'thinking', 'speaking', 'idle',
  ]);
  await harness.manager.dispose();
});

test('BDD: firmware playback interruption terminates without error and the following wake starts listening', async () => {
  const harness = createHarness({
    overrides: {
      speakWithTts: async (input) => {
        harness.calls.speech.push(input);
        await input.onPlaybackStarted();
        if (harness.calls.speech.length === 1) throw new Error('sidekick_speaker_playback_interrupted');
      },
    },
  });
  const first = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.emitPcm();
  harness.clock.advance(500);
  const interrupted = await first;
  assert.equal(interrupted.status, 'cancelled');
  assert.equal(interrupted.technicalCode, 'sidekick_speaker_playback_interrupted');
  assert.equal(harness.calls.screens.some((screen) => screen.screen === 'error'), false);

  const second = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 2);
  assert.equal(harness.manager.getActiveSession('sidekick-1').phase, 'listening');
  harness.emitPcm();
  harness.clock.advance(500);
  assert.equal((await second).status, 'completed');
  await harness.manager.dispose();
});

test('BDD: an agent that exceeds the session deadline is aborted and never reaches TTS', async () => {
  const harness = createHarness({
    overrides: {
      sendMessageAndWaitForFinal: async (input) => {
        harness.calls.messages.push(input);
        return await new Promise(() => undefined);
      },
    },
    managerOptions: { maxSessionMs: 2_000 },
  });
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);
  harness.emitPcm();
  harness.clock.advance(500);
  await eventually(() => harness.manager.getActiveSession('sidekick-1')?.phase === 'thinking');
  harness.clock.advance(1_500);

  const result = await completion;
  assert.equal(result.status, 'timeout');
  assert.equal(harness.calls.messages[0].signal.aborted, true);
  assert.equal(harness.calls.speech.length, 0);
  assert.equal(harness.calls.screens.at(-1).screen, 'idle');
  await harness.manager.dispose();
});

test('BDD: STT failures show an error state and always recover the device to idle', async () => {
  const harness = createHarness({
    overrides: {
      createRealtimeSttSession: async () => ({
        appendPcm: async () => undefined,
        finish: async () => { throw new Error('stt_connection_lost'); },
        cancel: async () => { harness.calls.sttCancels += 1; },
      }),
    },
  });
  const result = await completeTurn(harness);

  assert.equal(result.status, 'error');
  assert.equal(result.technicalCode, 'stt_connection_lost');
  assert.deepEqual(harness.calls.screens.map((screen) => screen.screen), ['listening', 'transcribing', 'error']);
  harness.clock.advance(1_500);
  await eventually(() => harness.calls.screens.at(-1)?.screen === 'idle');
  assert.equal(harness.calls.speech.length, 0);
  await harness.manager.dispose();
});

test('BDD: duplicate wakes are ignored and disposal removes every hardware subscription', async () => {
  const harness = createHarness();
  const completion = harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  await eventually(() => harness.calls.microphoneStarts.length === 1);

  const duplicate = await harness.manager.triggerWake({ sidekickId: 'sidekick-1' });
  assert.equal(duplicate.status, 'ignored');
  assert.equal(duplicate.technicalCode, 'sidekick_voice_session_active');
  await harness.manager.dispose();
  assert.equal((await completion).status, 'cancelled');
  assert.equal(harness.calls.unsubscribes, 3);
  assert.equal((await harness.manager.triggerWake({ sidekickId: 'sidekick-1' })).status, 'ignored');
});

test('SidekickVoiceSessionManager validates its STT adapter, options and lifecycle', async () => {
  assert.throws(() => new SidekickVoiceSessionManager({}), /sidekick_voice_stt_adapter_required/);
  const harness = createHarness();
  assert.throws(() => new SidekickVoiceSessionManager({ ...harness.manager.deps }, { maxListeningMs: 0 }), /invalid/);
  harness.manager.start();
  assert.equal((await harness.manager.triggerWake({ sidekickId: '  ' })).technicalCode, 'sidekick_voice_sidekick_id_required');
  await harness.manager.dispose();
  await harness.manager.dispose();
  assert.throws(() => harness.manager.start(), /sidekick_voice_manager_disposed/);
});
