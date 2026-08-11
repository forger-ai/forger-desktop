import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioRuntimeBrokerRequest } from '@shared/types';
import {
  enumerateAudioRuntimeDevices,
  playRuntimeAudio,
} from '@renderer/app/audio-runtime-browser';

type PlayAudioRequest = Extract<AudioRuntimeBrokerRequest, { type: 'play_audio' }>;

const request = (overrides: Partial<PlayAudioRequest> = {}): PlayAudioRequest => ({
  requestId: 'request-1',
  type: 'play_audio',
  playbackId: 'playback-1',
  audioDataBase64: btoa('audio'),
  mimeType: 'audio/wav',
  ...overrides,
});

const mediaDevice = (values: Partial<MediaDeviceInfo> & Pick<MediaDeviceInfo, 'kind'>): MediaDeviceInfo => ({
  deviceId: '',
  groupId: '',
  label: '',
  toJSON: () => ({}),
  ...values,
});

const setMediaDevices = (value: Partial<MediaDevices> | undefined) => {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value,
  });
};

interface AudioMockOptions {
  duration?: number;
  failure?: unknown;
  errorEvent?: boolean;
  sinkFailure?: boolean;
  withSink?: boolean;
}

const installAudioMock = (options: AudioMockOptions = {}) => {
  const instances: MockAudio[] = [];
  class MockAudio {
    duration = options.duration ?? Number.NaN;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readonly play = vi.fn(async () => {
      if (options.failure !== undefined) {
        throw options.failure;
      }
      queueMicrotask(() => {
        if (options.errorEvent) {
          this.onerror?.();
        } else {
          this.onended?.();
        }
      });
    });
    readonly setSinkId = vi.fn(async () => {
      if (options.sinkFailure) {
        throw new Error('sink unavailable');
      }
    });

    constructor(readonly src: string) {
      instances.push(this);
    }
  }
  if (!options.withSink) {
    delete (MockAudio.prototype as Partial<MockAudio>).setSinkId;
  }
  vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio);
  return instances;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('browser audio runtime', () => {
  it('returns no devices when the browser media boundary is unavailable', async () => {
    setMediaDevices(undefined);
    await expect(enumerateAudioRuntimeDevices()).resolves.toEqual({
      inputDevices: [],
      outputDevices: [],
    });
  });

  it('requests labels, stops the probe, and maps microphones, speakers, and system audio', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const stop = vi.fn();
    const enumerateDevices = vi.fn()
      .mockResolvedValueOnce([
        mediaDevice({ kind: 'videoinput', deviceId: 'camera', label: '' }),
        mediaDevice({ kind: 'audiooutput', deviceId: '', label: '' }),
      ])
      .mockResolvedValueOnce([
        mediaDevice({ kind: 'audioinput', deviceId: '', label: '', groupId: '' }),
        mediaDevice({ kind: 'audioinput', deviceId: 'default', label: 'Studio mic', groupId: 'inputs' }),
        mediaDevice({ kind: 'videoinput', deviceId: 'camera', label: 'Camera' }),
        mediaDevice({ kind: 'audiooutput', deviceId: '', label: '', groupId: '' }),
        mediaDevice({ kind: 'audiooutput', deviceId: 'default', label: 'Headphones', groupId: 'outputs' }),
        mediaDevice({ kind: 'audiooutput', deviceId: 'speaker-3', label: '', groupId: '' }),
      ]);
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    setMediaDevices({ enumerateDevices, getUserMedia } as Partial<MediaDevices>);

    await expect(enumerateAudioRuntimeDevices()).resolves.toEqual({
      inputDevices: [
        {
          id: 'audioinput-0',
          label: 'Default microphone',
          kind: 'microphone',
          default: true,
          supported: true,
        },
        {
          id: 'default',
          label: 'Studio mic',
          kind: 'microphone',
          groupId: 'inputs',
          default: true,
          supported: true,
        },
        {
          id: 'system-audio:default',
          label: 'System audio',
          kind: 'system_audio',
          default: false,
          supported: true,
          requiresDisplayCapture: true,
        },
      ],
      outputDevices: [
        {
          id: 'audiooutput-0',
          label: 'Default speaker',
          kind: 'speaker',
          default: true,
          supported: true,
        },
        {
          id: 'default',
          label: 'Headphones',
          kind: 'speaker',
          groupId: 'outputs',
          default: true,
          supported: true,
        },
        {
          id: 'speaker-3',
          label: 'Speaker 3',
          kind: 'speaker',
          default: false,
          supported: true,
        },
      ],
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it('does not request permission when every audio device already has a label', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('iPhone');
    const enumerateDevices = vi.fn().mockResolvedValue([
      mediaDevice({ kind: 'audioinput', deviceId: 'mic', label: 'Built-in microphone' }),
      mediaDevice({ kind: 'audiooutput', deviceId: 'speaker', label: 'Built-in speaker' }),
    ]);
    const getUserMedia = vi.fn();
    setMediaDevices({ enumerateDevices, getUserMedia } as Partial<MediaDevices>);

    const result = await enumerateAudioRuntimeDevices();
    expect(result.inputDevices[0]?.label).toBe('Built-in microphone');
    expect(result.outputDevices[0]?.label).toBe('Built-in speaker');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(enumerateDevices).toHaveBeenCalledOnce();
  });

  it('contains denied label probes and supplies a default speaker on unsupported platforms', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('iPhone');
    const enumerateDevices = vi.fn().mockResolvedValue([
      mediaDevice({ kind: 'audioinput', deviceId: 'mic-1', label: '' }),
      mediaDevice({ kind: 'audioinput', deviceId: 'mic-2', label: '' }),
    ]);
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
    setMediaDevices({ enumerateDevices, getUserMedia } as Partial<MediaDevices>);

    const result = await enumerateAudioRuntimeDevices();
    expect(result.inputDevices).toEqual([
      { id: 'mic-1', label: 'Default microphone', kind: 'microphone', default: true, supported: true },
      { id: 'mic-2', label: 'Microphone 2', kind: 'microphone', default: false, supported: true },
    ]);
    expect(result.outputDevices).toEqual([
      { id: 'default', label: 'Default speaker', kind: 'speaker', default: true, supported: true },
    ]);
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
  });

  it('plays audio on the selected output and always releases playback resources', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const instances = installAudioMock({ duration: 2.5, withSink: true });
    const activePlaybacks = new Map<string, HTMLAudioElement>();

    await expect(playRuntimeAudio(activePlaybacks, request({ outputDeviceId: 'speaker-2' }))).resolves.toEqual({
      success: true,
      durationSeconds: 2.5,
    });
    expect(instances[0].src).toBe('blob:audio');
    expect(instances[0].setSinkId).toHaveBeenCalledWith('speaker-2');
    expect(instances[0].play).toHaveBeenCalledOnce();
    expect(activePlaybacks.size).toBe(0);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:audio');
  });

  it('continues with the default output when sink selection fails and omits unknown duration', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const instances = installAudioMock({ sinkFailure: true, withSink: true });

    await expect(playRuntimeAudio(new Map(), request({ outputDeviceId: 'speaker-2', mimeType: '' }))).resolves.toEqual({
      success: true,
    });
    expect(instances[0].setSinkId).toHaveBeenCalledWith('speaker-2');
  });

  it('skips sink selection for default or unsupported outputs', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const defaultInstances = installAudioMock({ withSink: true });
    await expect(playRuntimeAudio(new Map(), request({ outputDeviceId: 'default' }))).resolves.toEqual({ success: true });
    expect(defaultInstances[0].setSinkId).not.toHaveBeenCalled();

    const unsupportedInstances = installAudioMock({ withSink: false });
    await expect(playRuntimeAudio(new Map(), request({ outputDeviceId: 'speaker-2' }))).resolves.toEqual({ success: true });
    expect(unsupportedInstances[0].play).toHaveBeenCalledOnce();
  });

  it('reports playback promise, media event, and non-error failures safely', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:audio');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    installAudioMock({ failure: new Error('decoder failed') });
    await expect(playRuntimeAudio(new Map(), request())).resolves.toEqual({
      success: false,
      error: 'decoder failed',
    });

    installAudioMock({ errorEvent: true });
    await expect(playRuntimeAudio(new Map(), request())).resolves.toEqual({
      success: false,
      error: 'audio_playback_failed',
    });

    installAudioMock({ failure: 'unknown' });
    await expect(playRuntimeAudio(new Map(), request())).resolves.toEqual({
      success: false,
      error: 'audio_playback_failed',
    });
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
  });
});
