import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSidekickVoiceProfile } from '../../dist-electron/main/sidekick-voice-profile.js';

const ttsState = {
  config: { defaultModel: 'kokoro', defaultVoice: 'ef_dora', maxTextCharacters: 2_000 },
  voices: [
    { id: 'ef_dora', model: 'kokoro', language: 'Spanish', locale: 'es-CL', installed: true, enabled: true },
  ],
};

const resolveLanguages = (voiceConfig = {}) => resolveSidekickVoiceProfile({
  voiceConfig: { conversationTtlMinutes: 30, ...voiceConfig },
}, ttsState).sttLanguages;

test('Sidekick voice defaults new and legacy profiles to the Spanish-English subset', () => {
  assert.deepEqual(resolveLanguages(), ['es', 'en']);
  assert.deepEqual(resolveLanguages({ sttLanguages: ['fr'] }), ['es', 'en']);
});

test('Sidekick voice follows the selected voice only when explicitly configured', () => {
  assert.deepEqual(resolveLanguages({ sttLanguageMode: 'voice' }), ['es']);
});

test('Sidekick voice preserves explicit auto, fixed, and subset choices', () => {
  assert.equal(resolveLanguages({ sttLanguageMode: 'auto' }), undefined);
  assert.deepEqual(resolveLanguages({ sttLanguageMode: 'fixed', sttLanguages: ['EN'] }), ['en']);
  assert.deepEqual(resolveLanguages({ sttLanguageMode: 'subset', sttLanguages: ['ES', 'en', 'en'] }), ['es', 'en']);
});
