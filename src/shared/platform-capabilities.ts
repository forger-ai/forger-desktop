export interface PlatformSpeechToTextCapability {
  required: boolean;
  reason: string;
}

export interface PlatformTextToSpeechCapability {
  required: boolean;
  reason: string;
}

export interface PlatformAudioInputCapability {
  required: boolean;
  reason: string;
}

export interface PlatformWorkspaceFoldersCapability {
  required: boolean;
  reason: string;
}

export interface PlatformCapabilities {
  speechToText?: PlatformSpeechToTextCapability;
  textToSpeech?: PlatformTextToSpeechCapability;
  audioInput?: PlatformAudioInputCapability;
  workspaceFolders?: PlatformWorkspaceFoldersCapability;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const normalizePlatformCapabilities = (value: unknown): PlatformCapabilities => {
  if (!isRecord(value)) {
    return {};
  }
  const speechToText = value.speechToText;
  const textToSpeech = value.textToSpeech;
  const audioInput = value.audioInput;
  const workspaceFolders = value.workspaceFolders;
  const result: PlatformCapabilities = {};
  if (speechToText === true) {
    result.speechToText = { required: false, reason: '' };
  } else if (isRecord(speechToText)) {
    result.speechToText = {
      required: speechToText.required === true,
      reason: typeof speechToText.reason === 'string' ? speechToText.reason.trim() : '',
    };
  }
  if (textToSpeech === true) {
    result.textToSpeech = { required: false, reason: '' };
  } else if (isRecord(textToSpeech)) {
    result.textToSpeech = {
      required: textToSpeech.required === true,
      reason: typeof textToSpeech.reason === 'string' ? textToSpeech.reason.trim() : '',
    };
  }
  if (audioInput === true) {
    result.audioInput = { required: false, reason: '' };
  } else if (isRecord(audioInput)) {
    result.audioInput = {
      required: audioInput.required === true,
      reason: typeof audioInput.reason === 'string' ? audioInput.reason.trim() : '',
    };
  }
  if (workspaceFolders === true) {
    result.workspaceFolders = { required: false, reason: '' };
  } else if (isRecord(workspaceFolders) && workspaceFolders.enabled !== false) {
    result.workspaceFolders = {
      required: workspaceFolders.required === true,
      reason: typeof workspaceFolders.reason === 'string' ? workspaceFolders.reason.trim() : '',
    };
  }
  return result;
};

export const appAllowsSpeechToText = (value: unknown): boolean =>
  Boolean(normalizePlatformCapabilities(value).speechToText);

export const appAllowsTextToSpeech = (value: unknown): boolean =>
  Boolean(normalizePlatformCapabilities(value).textToSpeech);

export const appAllowsAudioInput = (value: unknown): boolean =>
  Boolean(normalizePlatformCapabilities(value).audioInput);

export const appAllowsWorkspaceFolders = (value: unknown): boolean =>
  Boolean(normalizePlatformCapabilities(value).workspaceFolders);
