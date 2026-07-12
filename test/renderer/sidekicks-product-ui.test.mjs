import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const viewPath = new URL('../../src/renderer/views/SidekicksView.tsx', import.meta.url);
const voicePath = new URL('../../src/renderer/views/sidekicks/SidekickVoiceExperience.tsx', import.meta.url);
const agentsPath = new URL('../../src/renderer/views/AgentsView.tsx', import.meta.url);
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
  assert.match(source, /<Accordion[\s\S]*copy\.advancedTitle[\s\S]*TechnicalDetails/);
  assert.match(source, /sidekick\.time/);
  assert.match(source, /sidekick\.capabilities\.includes\('display\.screens'\)/);
  assert.match(source, /sidekick\.capabilities\.includes\('speaker\.playback'\)/);
});

test('Sidekicks product view exposes the idle rotation and voice assistant sections', async () => {
  const source = await fs.readFile(viewPath, 'utf8');
  assert.match(source, /sidekicksSetIdleConfig\(/);
  assert.match(source, /sidekicksSetIdleImage\(/);
  assert.match(source, /SIDEKICK_IDLE_SCREENS/);
  assert.match(source, /copy\.trainingTitle/);
  assert.match(source, /wake\.word\.local/);
  assert.match(source, /display\.idle-order/);
  assert.match(source, /copy\.screenMoveUp/);
  assert.match(source, /copy\.screenMoveDown/);
});

test('Sidekicks uses a compact list, a local detail view, and a confirmed danger area', async () => {
  const source = await fs.readFile(viewPath, 'utf8');
  assert.match(source, /ListItemButton/);
  assert.match(source, /ChevronRightRounded/);
  assert.match(source, /copy\.voiceReady/);
  assert.match(source, /copy\.voiceNeedsSetup/);
  assert.match(source, /copy\.backToSidekicks/);
  assert.match(source, /copy\.dangerTitle/);
  assert.match(source, /<Dialog[\s\S]*copy\.unlinkConfirmTitle/);
  assert.doesNotMatch(source, /window\.confirm/);
});

test('Sidekick setup offers truthful local speech preparation without blocking pairing', async () => {
  const source = await fs.readFile(viewPath, 'utf8');
  assert.match(source, /window\.forger\.speechToTextGetState\(\)/);
  assert.match(source, /window\.forger\.speechToTextInstall\(\)/);
  assert.match(source, /window\.forger\.textToSpeechInstall\(\)/);
  assert.match(source, /speechState\?\.repairRequired/);
  assert.match(source, /<LinearProgress/);
  assert.match(source, /copy\.voiceSetupOptional/);
  assert.match(source, /copy\.voiceSectionTitle[\s\S]*<SidekickLocalVoiceSetup/);
});

test('Sidekick voice settings persist defaults and expose exclusive read-only sessions', async () => {
  const [view, voice, agents] = await Promise.all([
    fs.readFile(viewPath, 'utf8'),
    fs.readFile(voicePath, 'utf8'),
    fs.readFile(agentsPath, 'utf8'),
  ]);
  assert.match(view, /sidekicksSetVoiceConfig\(/);
  assert.match(view, /personalAgentConversationsList\(/);
  assert.match(view, /origin === 'sidekick'/);
  assert.match(view, /conversation\.sidekickId === sidekick\.sidekickId/);
  assert.match(voice, /copy\.conversationExclusive/);
  assert.match(voice, /copy\.conversationReadOnly/);
  assert.match(voice, /conversationTtlMinutes/);
  assert.match(voice, /selectedVoiceDetails\?\.locale/);
  assert.match(voice, /effectiveRemoteVoice/);
  assert.match(voice, /effectiveRemoteLocale/);
  assert.doesNotMatch(voice, /remote\.voice \?\? selectedVoice/);
  assert.doesNotMatch(voice, /personalAgentSendMessage|personalAgentConversationDraftUpdate/);
  assert.match(agents, /item\.origin === 'sidekick'/);
  assert.match(agents, /conversation\.origin === 'sidekick'/);
  assert.match(agents, /sidekickReadOnlyThread/);
  assert.match(agents, /sidekicksGetState\(\)/);
});

test('Sidekick conversations merge live personal-agent events into the list and open dialog', async () => {
  const view = await fs.readFile(viewPath, 'utf8');

  assert.match(view, /onPersonalAgentConversationEvent/);
  assert.match(view, /event\.conversation\.origin !== 'sidekick'/);
  assert.match(view, /upsertSidekickConversation/);
  assert.match(view, /current\?\.id === event\.conversation\.id/);
  assert.doesNotMatch(view, /\[sidekick\.sidekickId\]: conversations\.filter/);
});

test('Sidekick detail surfaces wake beep failures without showing successful receipts', async () => {
  const view = await fs.readFile(viewPath, 'utf8');

  assert.match(view, /configuringWakeBeep\?\.status === 'failed'/);
  assert.match(view, /<Alert severity="warning">/);
  assert.doesNotMatch(view, /configuringWakeBeep\?\.status === 'completed'/);
});

test('Agents conversation hydration merges snapshots instead of replacing newer live events', async () => {
  const agents = await fs.readFile(agentsPath, 'utf8');

  assert.match(agents, /mergeConversationSnapshots/);
  assert.match(agents, /setConversations\(\(current\) => mergeConversationSnapshots\(/);
  assert.match(agents, /current\.filter\(\(item\) => item\.agentId === agentId\)/);
  assert.match(agents, /if \(!activeAgentId \|\| event\.conversation\.agentId !== activeAgentId\)/);
  assert.doesNotMatch(agents, /setConversations\(nextConversations\)/);
});

test('new Sidekick product copy exists in English and Spanish', async () => {
  const [english, spanish] = await Promise.all([
    fs.readFile(englishPath, 'utf8'),
    fs.readFile(spanishPath, 'utf8'),
  ]);
  for (const key of ['journeyTitle', 'technicalDetails', 'screenPresets', 'voiceTitle', 'agentTitle', 'timeSynced', 'forgetConfirm', 'voiceSettingsTitle', 'conversationsTitle', 'conversationExclusive', 'conversationReadOnly', 'voiceReady', 'voiceNeedsSetup', 'backToSidekicks', 'dangerTitle', 'unlinkConfirmTitle', 'screenMoveUp', 'screenMoveDown', 'voiceSetupOptional']) {
    assert.match(english, new RegExp(`${key}:`));
    assert.match(spanish, new RegExp(`${key}:`));
  }
  assert.match(english, /wake audio is processed temporarily and is not saved/);
  assert.match(spanish, /audio del wake se procesa de forma transitoria y no se guarda/);
});
