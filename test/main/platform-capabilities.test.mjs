import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appAllowsAgentRuntimeControl, appAllowsAudioInput, appAllowsSpeechToText, appAllowsTextToSpeech, appAllowsWorkspaceFolders, normalizePlatformCapabilities } = require('../../dist-electron/shared/platform-capabilities.js');
const { normalizeAppCapabilities } = require('../../dist-electron/shared/capabilities.js');

test('platformCapabilities grants speech-to-text runtime access separately from catalog capabilities', () => {
  assert.equal(appAllowsSpeechToText(undefined), false);
  assert.equal(appAllowsSpeechToText({ speechToText: true }), true);
  assert.equal(appAllowsTextToSpeech({ textToSpeech: true }), true);
  assert.equal(appAllowsAudioInput({ audioInput: true }), true);
  assert.equal(appAllowsWorkspaceFolders({ workspaceFolders: true }), true);
  assert.equal(appAllowsAgentRuntimeControl({ agentRuntimeControl: true }), true);
  assert.equal(appAllowsWorkspaceFolders({ workspaceFolders: { enabled: false, reason: 'Disabled.' } }), false);
  assert.equal(appAllowsAudioInput({ speechToText: true }), false);
  assert.equal(appAllowsAgentRuntimeControl({ agentRuntime: true }), false);
  assert.equal(appAllowsSpeechToText({ speechToText: { required: true, reason: 'Transcribe calls.' } }), true);
  assert.equal(appAllowsTextToSpeech({ textToSpeech: { required: true, reason: 'Read aloud.' } }), true);
  assert.deepEqual(normalizePlatformCapabilities({ speechToText: { required: true, reason: ' Transcribe calls. ' } }), {
    speechToText: { required: true, reason: 'Transcribe calls.' },
  });
  assert.deepEqual(normalizePlatformCapabilities({ textToSpeech: { required: true, reason: ' Read aloud. ' } }), {
    textToSpeech: { required: true, reason: 'Read aloud.' },
  });
  assert.deepEqual(normalizePlatformCapabilities({ audioInput: { required: true, reason: ' Capture raw audio. ' } }), {
    audioInput: { required: true, reason: 'Capture raw audio.' },
  });
  assert.deepEqual(normalizePlatformCapabilities({ workspaceFolders: { required: true, reason: ' Open project folders. ' } }), {
    workspaceFolders: { required: true, reason: 'Open project folders.' },
  });
  assert.deepEqual(normalizePlatformCapabilities({ agentRuntimeControl: { required: true, reason: ' Let this app choose task models. ' } }), {
    agentRuntimeControl: { required: true, reason: 'Let this app choose task models.' },
  });

  const decorative = normalizeAppCapabilities([{ id: 'speech_to_text' }, { id: 'ai_assisted_imports' }]);
  assert.deepEqual(decorative, [{ id: 'ai_assisted_imports' }]);
});
