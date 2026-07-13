import {
  SIDEKICK_DEFAULT_CONVERSATION_TTL_MINUTES,
  SIDEKICK_DEFAULT_STT_LANGUAGE_SUBSET,
  SIDEKICK_MAX_CONVERSATION_TTL_MINUTES,
  SIDEKICK_MIN_CONVERSATION_TTL_MINUTES,
} from '../shared/types';
import type {
  SidekickSummary,
  SidekickVoiceConfig,
  TextToSpeechState,
  TextToSpeechVoice,
} from '../shared/types';

const VOICE_LANGUAGE_LOCALES: Record<string, string> = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  italian: 'it',
  portuguese: 'pt-BR',
  japanese: 'ja',
  'mandarin chinese': 'zh-CN',
  chinese: 'zh-CN',
  hindi: 'hi',
};

export const canonicalSidekickLocale = (value: string | undefined): string | undefined => {
  if (!value?.trim()) return undefined;
  try {
    return Intl.getCanonicalLocales(value.trim())[0];
  } catch {
    return undefined;
  }
};

export const localeForSidekickVoice = (
  voice: Pick<TextToSpeechVoice, 'locale' | 'language'>,
): string | undefined => canonicalSidekickLocale(voice.locale) ??
  canonicalSidekickLocale(VOICE_LANGUAGE_LOCALES[voice.language.trim().toLowerCase()]);

export interface ResolvedSidekickVoiceProfile {
  model: string;
  voice: string;
  locale: string;
  /**
   * Idiomas permitidos para el STT (ISO-639-1). `undefined` = autodeteccion
   * libre; un elemento = idioma fijo; varios = subset restringido.
   */
  sttLanguages?: string[];
  conversationTtlMs: number;
}

const resolveSttLanguages = (
  voiceConfig: Pick<SidekickVoiceConfig, 'sttLanguageMode' | 'sttLanguages'>,
  locale: string,
): string[] | undefined => {
  const configured = [...new Set(
    (voiceConfig.sttLanguages ?? [])
      .map((code) => code.trim().toLowerCase())
      .filter((code) => /^[a-z]{2}$/.test(code)),
  )];
  switch (voiceConfig.sttLanguageMode) {
    case 'voice': {
      const voiceLanguage = locale.split('-')[0].toLowerCase();
      return /^[a-z]{2}$/.test(voiceLanguage) ? [voiceLanguage] : undefined;
    }
    case 'auto':
      return undefined;
    case 'fixed':
      if (configured.length >= 1) return [configured[0]];
      break;
    case 'subset':
      if (configured.length >= 2) return configured;
      if (configured.length === 0) return [...SIDEKICK_DEFAULT_STT_LANGUAGE_SUBSET];
      break;
    default:
      return [...SIDEKICK_DEFAULT_STT_LANGUAGE_SUBSET];
  }
  return [...SIDEKICK_DEFAULT_STT_LANGUAGE_SUBSET];
};

export const resolveSidekickVoiceProfile = (
  sidekick: Pick<SidekickSummary, 'voiceConfig'>,
  ttsState: Pick<TextToSpeechState, 'config' | 'voices'>,
): ResolvedSidekickVoiceProfile => {
  const configuredModel = sidekick.voiceConfig.model?.trim();
  const configuredVoice = sidekick.voiceConfig.voice?.trim();
  const selected = configuredModel && configuredVoice
    ? ttsState.voices.find((voice) => voice.model === configuredModel && voice.id === configuredVoice && voice.installed && voice.enabled)
    : ttsState.voices.find((voice) => (
      voice.model === ttsState.config.defaultModel && voice.id === ttsState.config.defaultVoice && voice.installed && voice.enabled
    )) ?? ttsState.voices.find((voice) => voice.installed && voice.enabled);
  if (!selected) {
    throw new Error(configuredModel || configuredVoice ? 'sidekick_voice_configured_voice_unavailable' : 'sidekick_voice_tts_voice_required');
  }
  const locale = localeForSidekickVoice(selected);
  if (!locale) throw new Error('sidekick_voice_locale_unavailable');
  const ttlMinutes = Number.isInteger(sidekick.voiceConfig.conversationTtlMinutes) &&
    sidekick.voiceConfig.conversationTtlMinutes >= SIDEKICK_MIN_CONVERSATION_TTL_MINUTES &&
    sidekick.voiceConfig.conversationTtlMinutes <= SIDEKICK_MAX_CONVERSATION_TTL_MINUTES
    ? sidekick.voiceConfig.conversationTtlMinutes
    : SIDEKICK_DEFAULT_CONVERSATION_TTL_MINUTES;
  return {
    model: selected.model,
    voice: selected.id,
    locale,
    sttLanguages: resolveSttLanguages(sidekick.voiceConfig, locale),
    conversationTtlMs: ttlMinutes * 60_000,
  };
};
