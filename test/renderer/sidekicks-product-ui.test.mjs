import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const viewPath = new URL('../../src/renderer/views/SidekicksView.tsx', import.meta.url);
const englishPath = new URL('../../src/renderer/i18n/en.ts', import.meta.url);
const spanishPath = new URL('../../src/renderer/i18n/es.ts', import.meta.url);

test('Sidekicks product view keeps privileged device actions behind the preload API', async () => {
  const source = await fs.readFile(viewPath, 'utf8');
  assert.match(source, /window\.forger\.sidekicksSendScreen\(input\)/);
  assert.match(source, /window\.forger\.sidekicksSpeak\(/);
  assert.match(source, /window\.forger\.textToSpeechGetState\(\)/);
  assert.match(source, /window\.forger\.personalAgentsList\(\)/);
  assert.match(source, /window\.forger\.sidekicksSetPersonalAgent\(/);
  assert.doesNotMatch(source, /WebSocket|SerialPort|nodeIntegration/);
});

test('Sidekicks product view defaults to compatible USB and hides diagnostics in an accordion', async () => {
  const source = await fs.readFile(viewPath, 'utf8');
  assert.match(source, /filter\(\(device\) => device\.likelySidekick\)/);
  assert.match(source, /<Accordion[\s\S]*copy\.technicalDetails/);
  assert.match(source, /sidekick\.time/);
  assert.match(source, /sidekick\.capabilities\.includes\('display\.screens'\)/);
  assert.match(source, /sidekick\.capabilities\.includes\('speaker\.playback'\)/);
});

test('new Sidekick product copy exists in English and Spanish', async () => {
  const [english, spanish] = await Promise.all([
    fs.readFile(englishPath, 'utf8'),
    fs.readFile(spanishPath, 'utf8'),
  ]);
  for (const key of ['journeyTitle', 'technicalDetails', 'screenPresets', 'voiceTitle', 'agentTitle', 'timeSynced', 'forgetConfirm']) {
    assert.match(english, new RegExp(`${key}:`));
    assert.match(spanish, new RegExp(`${key}:`));
  }
});
