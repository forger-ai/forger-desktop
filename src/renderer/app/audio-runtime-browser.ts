import type {
  AudioRuntimeBrokerRequest,
  AudioRuntimeDevices,
} from '@shared/types';

const platformSupportsSystemAudioCapture = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|Win|Linux/.test(navigator.platform);

export const enumerateAudioRuntimeDevices = async (): Promise<AudioRuntimeDevices> => {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputDevices: [], outputDevices: [] };
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((device) => (device.kind === 'audioinput' || device.kind === 'audiooutput') && !device.label)) {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    probe?.getTracks().forEach((track) => track.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const inputDevices = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      id: device.deviceId || `audioinput-${index}`,
      label: device.label || (index === 0 ? 'Default microphone' : `Microphone ${index + 1}`),
      kind: 'microphone' as const,
      ...(device.groupId ? { groupId: device.groupId } : {}),
      default: index === 0 || device.deviceId === 'default',
      supported: true,
    }));
  const systemAudioDevices = platformSupportsSystemAudioCapture()
    ? [{
      id: 'system-audio:default',
      label: 'System audio',
      kind: 'system_audio' as const,
      default: inputDevices.length === 0,
      supported: true,
      requiresDisplayCapture: true,
    }]
    : [];
  const outputDevices = devices
    .filter((device) => device.kind === 'audiooutput')
    .map((device, index) => ({
      id: device.deviceId || `audiooutput-${index}`,
      label: device.label || (index === 0 ? 'Default speaker' : `Speaker ${index + 1}`),
      kind: 'speaker' as const,
      ...(device.groupId ? { groupId: device.groupId } : {}),
      default: index === 0 || device.deviceId === 'default',
      supported: true,
    }));
  return {
    inputDevices: [...inputDevices, ...systemAudioDevices],
    outputDevices: outputDevices.length > 0 ? outputDevices : [{
      id: 'default',
      label: 'Default speaker',
      kind: 'speaker',
      default: true,
      supported: true,
    }],
  };
};

export const playRuntimeAudio = async (
  activePlaybacks: Map<string, HTMLAudioElement>,
  input: Extract<AudioRuntimeBrokerRequest, { type: 'play_audio' }>,
): Promise<{ success: boolean; durationSeconds?: number; error?: string }> => {
  const objectUrl = decodeAudioDataUrl(input.audioDataBase64, input.mimeType);
  const audio = new Audio(objectUrl);
  activePlaybacks.set(input.playbackId, audio);
  try {
    if (input.outputDeviceId && input.outputDeviceId !== 'default' && 'setSinkId' in audio) {
      await (audio as HTMLAudioElement & { setSinkId: (sinkId: string) => Promise<void> }).setSinkId(input.outputDeviceId).catch(() => undefined);
    }
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio_playback_failed'));
      void audio.play().catch(reject);
    });
    return {
      success: true,
      ...(Number.isFinite(audio.duration) ? { durationSeconds: audio.duration } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'audio_playback_failed',
    };
  } finally {
    activePlaybacks.delete(input.playbackId);
    URL.revokeObjectURL(objectUrl);
  }
};

const decodeAudioDataUrl = (audioDataBase64: string, mimeType: string): string => {
  const raw = atob(audioDataBase64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType || 'audio/wav' }));
};
