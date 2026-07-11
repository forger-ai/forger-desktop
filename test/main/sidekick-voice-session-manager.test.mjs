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

const speech = (samples = 160) => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, 2_000, true);
  return bytes;
};

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
    },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEvent: (event) => calls.events.push(event),
    ...overrides,
  };
  const manager = new SidekickVoiceSessionManager(deps, {
    maxListeningMs: 10_000,
    silenceAfterSpeechMs: 500,
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
  assert.equal(harness.calls.sttAppends.length, 1);
  assert.equal(harness.calls.messages[0].content, 'enciende la luz');
  assert.equal(harness.calls.speech[0].text, 'La luz quedó encendida.');
  assert.equal(harness.calls.microphoneStarts.length, 1);
  assert.equal(harness.calls.microphoneStops[0].reason, 'complete');
  assert.equal(harness.manager.getActiveSession('sidekick-1'), null);
  assert.equal(/pcm|audio|chunk/i.test(JSON.stringify({ result, observed })), false);
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
  assert.deepEqual(harness.calls.screens.map((screen) => screen.screen), ['listening', 'idle']);
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
  assert.deepEqual(harness.calls.screens.map((screen) => screen.screen), ['listening', 'transcribing', 'error', 'idle']);
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
