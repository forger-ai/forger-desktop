import { systemPreferences } from 'electron';

import type { MicrophonePermissionStatus } from '../../shared/types/desktop-api';

const normalizeMicrophonePermissionStatus = (value: unknown): MicrophonePermissionStatus => {
  if (
    value === 'not-determined' ||
    value === 'granted' ||
    value === 'denied' ||
    value === 'restricted' ||
    value === 'unknown'
  ) {
    return value;
  }
  return 'unknown';
};

export const getMicrophonePermissionStatus = (): MicrophonePermissionStatus => {
  if (process.platform !== 'darwin' || typeof systemPreferences.getMediaAccessStatus !== 'function') {
    return 'unsupported';
  }
  return normalizeMicrophonePermissionStatus(systemPreferences.getMediaAccessStatus('microphone'));
};

export const requestMicrophonePermission = async (): Promise<MicrophonePermissionStatus> => {
  if (process.platform !== 'darwin' || typeof systemPreferences.askForMediaAccess !== 'function') {
    return getMicrophonePermissionStatus();
  }
  const granted = await systemPreferences.askForMediaAccess('microphone');
  return granted ? 'granted' : getMicrophonePermissionStatus();
};
