import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WakeWordSession, WakeWordState } from '@shared/types';

import { WakeWordClientRunner } from '@renderer/services/WakeWordClientRunner';

type FakeTrack = MediaStreamTrack & { stop: ReturnType<typeof vi.fn> };

const makeTrack = (): FakeTrack => ({ stop: vi.fn() } as unknown as FakeTrack);

const makeStream = (audioTrackCount = 1) => {
  const audioTracks = Array.from({ length: audioTrackCount }, makeTrack);
  const otherTracks = audioTrackCount === 0 ? [makeTrack()] : [];
  const tracks = [...audioTracks, ...otherTracks];
  return {
    stream: {
      getAudioTracks: vi.fn(() => audioTracks),
      getTracks: vi.fn(() => tracks),
    } as unknown as MediaStream,
    audioTracks,
    tracks,
  };
};

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static nextSampleRate = 48_000;
  static nextSourceConnect: (() => void) | undefined;
  static nextProcessorConnect: (() => void) | undefined;
  static rejectClose = false;

  readonly sampleRate = FakeAudioContext.nextSampleRate;
  readonly destination = {} as AudioDestinationNode;
  readonly source = {
    connect: vi.fn(() => FakeAudioContext.nextSourceConnect?.()),
    disconnect: vi.fn(),
  };
  readonly processor = {
    connect: vi.fn(() => FakeAudioContext.nextProcessorConnect?.()),
    disconnect: vi.fn(),
    onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null,
  };
  readonly close = vi.fn(async () => {
    if (FakeAudioContext.rejectClose) throw new Error('context-close-failed');
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource = vi.fn(() => this.source as unknown as MediaStreamAudioSourceNode);
  createScriptProcessor = vi.fn(() => this.processor as unknown as ScriptProcessorNode);

  static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.nextSampleRate = 48_000;
    FakeAudioContext.nextSourceConnect = undefined;
    FakeAudioContext.nextProcessorConnect = undefined;
    FakeAudioContext.rejectClose = false;
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn(() => { this.readyState = FakeWebSocket.CLOSED; });

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  error(): void {
    this.onerror?.(new Event('error'));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  closed(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

const makeState = (overrides: Partial<WakeWordState> = {}): WakeWordState => ({
  status: 'listening',
  installed: true,
  running: true,
  repairRequired: false,
  config: {
    enabled: true,
    deviceId: 'default',
    modelId: 'hey-forger',
    threshold: 0.72,
    patience: 2,
    cooldownMs: 1_500,
    ...overrides.config,
  },
  models: [],
  runtime: {
    state: 'waiting_for_audio_session',
    modelId: 'hey-forger',
    updatedAt: '2026-08-10T12:00:00.000Z',
  },
  dependencyIssues: [],
  ...overrides,
});

const makeSession = (overrides: Partial<WakeWordSession> = {}): WakeWordSession => ({
  sessionId: 'session-1',
  url: 'ws://127.0.0.1:4321/wake',
  token: 'token with spaces',
  sampleRate: 16_000,
  format: 'pcm_s16le',
  config: makeState().config,
  ...overrides,
});

const createApi = () => {
  const state = makeState();
  return {
    wakeWordCreateSession: vi.fn(async () => makeSession()),
    wakeWordRecordDetected: vi.fn(async () => state),
    wakeWordRecordDiagnostic: vi.fn(async () => state),
    wakeWordRecordReady: vi.fn(async () => state),
    wakeWordRecordUnavailable: vi.fn(async () => state),
  };
};

const diagnostics = (api: ReturnType<typeof createApi>, event: string) =>
  api.wakeWordRecordDiagnostic.mock.calls
    .map(([input]) => input)
    .filter((input) => input.event === event);

const audioEvent = (samples: number[]) => ({
  inputBuffer: {
    getChannelData: vi.fn(() => new Float32Array(samples)),
  },
}) as unknown as AudioProcessingEvent;

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('WakeWordClientRunner browser service', () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  let getDisplayMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    FakeAudioContext.reset();
    FakeWebSocket.reset();
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    getUserMedia = vi.fn(async () => makeStream().stream);
    getDisplayMedia = vi.fn(async () => makeStream().stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, getDisplayMedia },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  });

  it('does nothing after disposal and stops cleanly when wake word is disabled', async () => {
    const api = createApi();
    const runner = new WakeWordClientRunner(api);

    await runner.ensure(makeState({ running: false }));
    await runner.ensure(makeState({ config: { ...makeState().config, enabled: false } }));
    runner.stop();
    runner.dispose();
    await runner.ensure(makeState());

    expect(api.wakeWordCreateSession).not.toHaveBeenCalled();
  });

  it('starts once per signature, sends bounded PCM, handles messages, and stops the live session', async () => {
    const api = createApi();
    api.wakeWordRecordDiagnostic.mockRejectedValueOnce(new Error('diagnostics-offline'));
    const stream = makeStream();
    getUserMedia.mockResolvedValueOnce(stream.stream);
    FakeAudioContext.nextSampleRate = 16_000;
    FakeAudioContext.rejectClose = true;
    const runner = new WakeWordClientRunner(api);
    const state = makeState();

    await runner.ensure(state);
    await runner.ensure(state);

    expect(api.wakeWordCreateSession).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    const socket = FakeWebSocket.instances[0];
    const context = FakeAudioContext.instances[0];
    expect(socket.url).toBe('ws://127.0.0.1:4321/wake?token=token%20with%20spaces');
    expect(socket.binaryType).toBe('arraybuffer');
    expect(context.source.connect).toHaveBeenCalledWith(context.processor);
    expect(context.processor.connect).toHaveBeenCalledWith(context.destination);

    context.processor.onaudioprocess?.(audioEvent([-2, 2, 0.5]));
    expect(socket.send).not.toHaveBeenCalled();

    socket.open();
    expect(JSON.parse(String(socket.send.mock.calls[0][0]))).toEqual({
      type: 'start',
      sampleRate: 16_000,
      format: 'pcm_s16le',
      modelId: 'hey-forger',
      threshold: 0.72,
      patience: 2,
      cooldownMs: 1_500,
    });

    context.processor.onaudioprocess?.(audioEvent([-2, 2, 0.5]));
    context.processor.onaudioprocess?.(audioEvent([]));
    const pcm = new Int16Array(socket.send.mock.calls[1][0] as ArrayBuffer);
    expect(Array.from(pcm)).toEqual([-32767, 32767, 16383]);
    expect((socket.send.mock.calls[2][0] as ArrayBuffer).byteLength).toBe(2);
    expect(diagnostics(api, 'first_audio_frame_sent')).toHaveLength(1);

    socket.message(JSON.stringify({ type: 'wake_ready' }));
    socket.message(JSON.stringify({ type: 'wake_confidence', modelId: 'model-a', confidence: 0.8 }));
    vi.setSystemTime(1_200);
    socket.message(JSON.stringify({ type: 'wake_confidence', confidence: 0.4 }));
    vi.setSystemTime(1_600);
    socket.message(JSON.stringify({ type: 'wake_confidence' }));
    socket.message(JSON.stringify({ type: 'wake_unavailable', technicalCode: 'model_crashed' }));
    socket.message(JSON.stringify({ type: 'wake_detected', modelId: 'model-a' }));
    socket.message(JSON.stringify({ type: 'wake_detected', confidence: 0.6 }));
    socket.message(JSON.stringify({ type: 'unknown' }));
    socket.message('{bad json');
    await flushMicrotasks();

    expect(api.wakeWordRecordReady.mock.calls.map(([input]) => input)).toEqual([
      { modelId: 'hey-forger' },
      { modelId: 'model-a', confidence: 0.8 },
      { modelId: 'hey-forger', confidence: 0 },
    ]);
    expect(api.wakeWordRecordUnavailable).toHaveBeenCalledWith({
      modelId: 'hey-forger',
      technicalCode: 'model_crashed',
    });
    expect(api.wakeWordRecordDetected).toHaveBeenCalledWith({
      deviceId: 'default',
      modelId: 'model-a',
      confidence: 1,
    });
    expect(api.wakeWordRecordDetected).toHaveBeenCalledWith({
      deviceId: 'default',
      modelId: 'hey-forger',
      confidence: 0.6,
    });

    runner.stop('test_complete');
    context.processor.onaudioprocess?.(audioEvent([0.2]));
    await flushMicrotasks();
    expect(JSON.parse(String(socket.send.mock.calls.at(-1)?.[0]))).toEqual({ type: 'end' });
    expect(stream.tracks[0].stop).toHaveBeenCalledOnce();
    expect(context.processor.disconnect).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('shares an identical pending start and ignores it after cancellation', async () => {
    const api = createApi();
    const deferred = Promise.withResolvers<WakeWordSession>();
    api.wakeWordCreateSession.mockReturnValue(deferred.promise);
    const runner = new WakeWordClientRunner(api);

    const first = runner.ensure(makeState());
    const second = runner.ensure(makeState());
    expect(api.wakeWordCreateSession).toHaveBeenCalledOnce();
    runner.stop('canceled_pending_start');
    deferred.resolve(makeSession());
    await Promise.all([first, second]);

    expect(diagnostics(api, 'stale_generation_ignored')).toEqual([
      expect.objectContaining({ technicalCode: 'after_session_created' }),
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('normalizes an empty configured and session device to the default microphone', async () => {
    const api = createApi();
    const state = makeState({ config: { ...makeState().config, deviceId: '' } });
    api.wakeWordCreateSession.mockResolvedValueOnce(makeSession({
      config: { ...state.config, deviceId: '' },
    }));
    const runner = new WakeWordClientRunner(api);

    await runner.ensure(state);

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(diagnostics(api, 'ensure_start')).toContainEqual(expect.objectContaining({ deviceId: 'default' }));
    expect(diagnostics(api, 'session_created')).toContainEqual(expect.objectContaining({ deviceId: 'default' }));
    runner.dispose();
  });

  it('stops an old active session and restarts when configuration changes', async () => {
    const api = createApi();
    const runner = new WakeWordClientRunner(api);

    await runner.ensure(makeState());
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    await runner.ensure(makeState({ config: { ...makeState().config, threshold: 0.91 } }));

    expect(api.wakeWordCreateSession).toHaveBeenCalledTimes(2);
    expect(firstSocket.close).toHaveBeenCalledOnce();
    expect(diagnostics(api, 'stop_requested')).toEqual([
      expect.objectContaining({ technicalCode: 'config_changed' }),
    ]);
    runner.dispose();
  });

  it('cancels a start after microphone access and releases the newly opened stream', async () => {
    const api = createApi();
    const media = Promise.withResolvers<MediaStream>();
    const stream = makeStream();
    getUserMedia.mockReturnValue(media.promise);
    const runner = new WakeWordClientRunner(api);
    const state = makeState({ config: { ...makeState().config, deviceId: 'microphone-1' } });
    api.wakeWordCreateSession.mockResolvedValueOnce(makeSession({ config: state.config }));

    const pending = runner.ensure(state);
    await flushMicrotasks();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'microphone-1' } } });
    runner.stop('cancel_media');
    media.resolve(stream.stream);
    await pending;

    expect(stream.tracks[0].stop).toHaveBeenCalledOnce();
    expect(diagnostics(api, 'stale_generation_ignored')).toContainEqual(
      expect.objectContaining({ technicalCode: 'after_media_stream_opened' }),
    );
  });

  it('classifies a rejected stale start separately from a current failure and permits retries', async () => {
    const api = createApi();
    const staleMedia = Promise.withResolvers<MediaStream>();
    getUserMedia.mockReturnValueOnce(staleMedia.promise);
    const runner = new WakeWordClientRunner(api);
    const staleStart = runner.ensure(makeState());
    await flushMicrotasks();
    runner.stop('cancel_before_failure');
    staleMedia.reject(new Error('permission-late'));
    await staleStart;
    expect(diagnostics(api, 'stale_generation_ignored')).toContainEqual(
      expect.objectContaining({ technicalCode: 'ensure_failed' }),
    );

    api.wakeWordCreateSession
      .mockRejectedValueOnce(new Error('session-down'))
      .mockRejectedValueOnce(null)
      .mockResolvedValue(makeSession());
    await expect(runner.ensure(makeState())).rejects.toThrow('session-down');
    await expect(runner.ensure(makeState())).rejects.toBeNull();
    await expect(runner.ensure(makeState())).resolves.toBeUndefined();

    expect(diagnostics(api, 'ensure_failed')).toContainEqual(
      expect.objectContaining({ technicalCode: 'session-down' }),
    );
    expect(diagnostics(api, 'ensure_failed')).toContainEqual(
      expect.objectContaining({ technicalCode: 'wake_stream_failed' }),
    );
    runner.dispose();
  });

  it('supports system-audio capture and rejects unavailable or silent display streams', async () => {
    const systemState = makeState({ config: { ...makeState().config, deviceId: 'system-audio:display-1' } });

    const unavailableApi = createApi();
    unavailableApi.wakeWordCreateSession.mockResolvedValueOnce(makeSession({ config: systemState.config }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, getDisplayMedia: undefined },
    });
    await expect(new WakeWordClientRunner(unavailableApi).ensure(systemState))
      .rejects.toThrow('system_audio_capture_unavailable');

    const silentApi = createApi();
    silentApi.wakeWordCreateSession.mockResolvedValueOnce(makeSession({ config: systemState.config }));
    const silent = makeStream(0);
    getDisplayMedia.mockResolvedValueOnce(silent.stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, getDisplayMedia },
    });
    await expect(new WakeWordClientRunner(silentApi).ensure(systemState))
      .rejects.toThrow('system_audio_track_missing');
    expect(silent.tracks[0].stop).toHaveBeenCalledOnce();

    const successApi = createApi();
    successApi.wakeWordCreateSession.mockResolvedValueOnce(makeSession({ config: systemState.config }));
    const captured = makeStream();
    getDisplayMedia.mockResolvedValueOnce(captured.stream);
    const runner = new WakeWordClientRunner(successApi);
    await runner.ensure(systemState);
    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    runner.dispose();
  });

  it('reports socket errors, send failures, and the ready timeout without leaking exceptions', async () => {
    const api = createApi();
    const runner = new WakeWordClientRunner(api);
    await runner.ensure(makeState());
    const socket = FakeWebSocket.instances[0];

    socket.error();
    expect(api.wakeWordRecordUnavailable).toHaveBeenCalledWith({
      modelId: 'hey-forger',
      technicalCode: 'wake_websocket_failed',
    });
    socket.send.mockImplementationOnce(() => { throw new Error('send exploded'); });
    socket.open();
    expect(diagnostics(api, 'start_send_failed')).toContainEqual(
      expect.objectContaining({ technicalCode: 'send exploded' }),
    );
    expect(api.wakeWordRecordUnavailable).toHaveBeenCalledWith({
      modelId: 'hey-forger',
      technicalCode: 'wake_start_send_failed',
    });

    runner.stop('replace_failed_socket');
    await runner.ensure(makeState({ config: { ...makeState().config, threshold: 0.8 } }));
    const fallbackSocket = FakeWebSocket.instances[1];
    fallbackSocket.send.mockImplementationOnce(() => { throw 'non-error'; });
    fallbackSocket.open();
    expect(diagnostics(api, 'start_send_failed')).toContainEqual(
      expect.objectContaining({ technicalCode: 'wake_start_send_failed' }),
    );

    runner.stop('replace_fallback_socket');
    await runner.ensure(makeState({ config: { ...makeState().config, threshold: 0.85 } }));
    const timeoutSocket = FakeWebSocket.instances[2];
    timeoutSocket.open();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(diagnostics(api, 'ready_timeout')).toHaveLength(1);
    expect(api.wakeWordRecordUnavailable).toHaveBeenCalledWith({
      modelId: 'hey-forger',
      technicalCode: 'wake_ready_timeout',
    });
    runner.dispose();
  });

  it('ignores stale socket callbacks and closes a current remote close exactly once', async () => {
    const api = createApi();
    const runner = new WakeWordClientRunner(api);
    await runner.ensure(makeState());
    const socket = FakeWebSocket.instances[0];
    const context = FakeAudioContext.instances[0];

    socket.message(JSON.stringify({ type: 'wake_unavailable' }));
    socket.open();
    socket.readyState = FakeWebSocket.CLOSED;
    context.processor.onaudioprocess?.(audioEvent([0.1]));
    socket.closed();
    expect(context.processor.disconnect).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();

    runner.stop('make_callbacks_stale');
    socket.error();
    socket.onopen?.(new Event('open'));
    socket.message(JSON.stringify({ type: 'wake_detected' }));
    socket.closed();
    expect(diagnostics(api, 'stale_generation_ignored').map((entry) => entry.technicalCode)).toEqual(
      expect.arrayContaining(['socket_error', 'socket_open', 'socket_close']),
    );
    expect(api.wakeWordRecordDetected).not.toHaveBeenCalled();
  });

  it('aborts before transfer when connection changes generation and cleans partial construction failures', async () => {
    const api = createApi();
    const runner = new WakeWordClientRunner(api);
    FakeAudioContext.nextProcessorConnect = () => runner.stop('generation_changed_during_connect');

    await runner.ensure(makeState());
    expect(diagnostics(api, 'stale_generation_ignored')).toContainEqual(
      expect.objectContaining({ technicalCode: 'before_transfer' }),
    );
    expect(FakeAudioContext.instances[0].processor.disconnect).toHaveBeenCalledOnce();

    FakeAudioContext.nextProcessorConnect = undefined;
    FakeAudioContext.nextSourceConnect = () => { throw new Error('source-connect-failed'); };
    await expect(runner.ensure(makeState())).rejects.toThrow('source-connect-failed');
    const failedContext = FakeAudioContext.instances[1];
    expect(failedContext.processor.disconnect).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances[1].close).toHaveBeenCalledOnce();
  });

  it('does not fire a ready timeout after a canceled generation', async () => {
    const api = createApi();
    const runner = new WakeWordClientRunner(api);
    await runner.ensure(makeState());
    const socket = FakeWebSocket.instances[0];
    socket.open();
    runner.stop('before_ready_timeout');

    await vi.advanceTimersByTimeAsync(15_000);
    expect(diagnostics(api, 'ready_timeout')).toHaveLength(0);
  });
});
