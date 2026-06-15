import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);

const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('renderer chat appends run messages through the shared dedupe helper', async () => {
  const chatStateSource = await readSource('src/renderer/chat-state.ts');
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');

  assert.match(chatStateSource, /export const appendChatMessageOnce/);
  assert.match(chatStateSource, /conversation\.messages\.some\(\(existingMessage\) => existingMessage\.id === message\.id\)/);
  assert.match(chatStateSource, /export const appendChatMessageToConversationOnce/);
  assert.match(controllerSource, /appendChatMessageToConversationOnce/);
  assert.match(controllerSource, /const targetConversationId = runConversationId \?\? runConversationIdByRunRef\.current\.get\(run\.runId\) \?\? activeConversationIdRef\.current; if \(!targetConversationId\)/);
  assert.match(controllerSource, /deliveredRunRepliesRef\.current\.add\(dedupeKey\);\s*const foundConversation/);
  assert.match(controllerSource, /appendChatMessageToConversationOnce\(currentConversations, targetConversationId, \{ id: messageId, role: 'assistant'/);
});

test('remote tunnel ready dialog and topbar expose stop actions without using LLM runs state', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const dialogsSource = await readSource('src/renderer/app/RendererAppDialogs.tsx');
  const topbarSource = await readSource('src/renderer/components/Topbar.tsx');
  const enSource = await readSource('src/renderer/i18n/en.ts');
  const esSource = await readSource('src/renderer/i18n/es.ts');

  assert.match(controllerSource, /RemoteTunnelReadyDialogState[\s\S]*appId: string/);
  assert.match(controllerSource, /setRemoteTunnelReadyDialog\(\{ open: true, appId: status\.appId/);
  assert.match(controllerSource, /const stopReadyRemoteTunnel = async \(\) =>/);
  assert.match(controllerSource, /await handleStopRemoteNetworkShare\(appId\); closeRemoteTunnelReadyDialog\(\)/);
  assert.match(dialogsSource, /stopReadyRemoteTunnel/);
  assert.match(dialogsSource, /\{t\.remoteNetwork\.stop\}/);
  assert.match(topbarSource, /StopCircleRounded/);
  assert.match(topbarSource, /canStopRemoteActivity\(activity\)/);
  assert.match(topbarSource, /window\.forger\.stopRemoteNetworkShare\(activity\.targetId\)/);
  assert.match(topbarSource, /t\.remoteActivity\.stop/);
  assert.match(enSource, /stop: 'Stop access'/);
  assert.match(esSource, /stop: 'Detener acceso'/);
  assert.doesNotMatch(topbarSource, /setLlm|llmRun|LlmRunsDrawer[\s\S]{0,200}stopRemoteNetworkShare/);
});

test('topbar does not expose microphone or live wake controls', async () => {
  const topbarSource = await readSource('src/renderer/components/Topbar.tsx');

  assert.match(topbarSource, /DeviceHubRounded/);
  assert.match(topbarSource, /t\.remoteActivity\.open/);
  assert.doesNotMatch(topbarSource, /MicRounded/);
  assert.doesNotMatch(topbarSource, /<Switch[\s>]/);
  assert.doesNotMatch(topbarSource, /t\.liveVoiceInput\./);
  assert.doesNotMatch(topbarSource, /liveVoiceInput(GetState|UpdateConfig|CreateSession|Stop|Wake)/);
  assert.doesNotMatch(topbarSource, /onLiveVoiceInputChanged/);
  assert.doesNotMatch(topbarSource, /wakeWord(Enabled|Listening|Status|Statuses|Toggle|Title|Description)/);
  assert.doesNotMatch(topbarSource, /session\.consumers\.map/);
  assert.doesNotMatch(topbarSource, /session\.wakeTargets\.map/);
  assert.doesNotMatch(topbarSource, /handleStopLiveVoiceDevice/);
});

test('settings exposes wake word as a separate service from speech and text to speech', async () => {
  const settingsSource = await readSource('src/renderer/views/SettingsView.tsx');
  const enSource = await readSource('src/renderer/i18n/en.ts');
  const esSource = await readSource('src/renderer/i18n/es.ts');

  assert.match(settingsSource, /key: 'speechToText'[\s\S]{0,240}setSettingsSubview\('speechToText'\)/);
  assert.match(settingsSource, /key: 'wakeWord'[\s\S]{0,240}setSettingsSubview\('wakeWord'\)/);
  assert.match(settingsSource, /key: 'textToSpeech'[\s\S]{0,240}setSettingsSubview\('textToSpeech'\)/);
  assert.doesNotMatch(settingsSource, /key: 'liveVoiceInput'[\s\S]{0,240}setSettingsSubview\('liveVoiceInput'\)/);
  assert.match(settingsSource, /window\.forger\.wakeWordUpdateConfig/);
  assert.doesNotMatch(settingsSource, /window\.forger\.speechToTextUpdateConfig\([\s\S]{0,260}(wakeThreshold|wakeModelId|wakeDeviceId)/);
  assert.match(enSource, /wakeWord: 'Install and run local Hey Jarvis detection with openWakeWord\.'/);
  assert.match(esSource, /wakeWord: 'Instala y ejecuta detección local de Hey Jarvis con openWakeWord\.'/);
});

test('wake word settings use enabled as the only startup control', async () => {
  const settingsSource = await readSource('src/renderer/views/SettingsView.tsx');
  const wakeWordTypesSource = await readSource('src/shared/types/wake-word.ts');
  const wakeWordServiceSource = await readSource('src/main/wake-word-service.ts');
  const enSource = await readSource('src/renderer/i18n/en.ts');
  const esSource = await readSource('src/renderer/i18n/es.ts');

  assert.match(settingsSource, /wakeWordUpdateConfig\(\{\s*enabled: draft\.enabled/);
  assert.doesNotMatch(settingsSource, /wakeWordAutoStart/);
  assert.doesNotMatch(settingsSource, /autoStart: draft\.autoStart/);
  assert.doesNotMatch(wakeWordTypesSource, /autoStart: boolean/);
  assert.match(wakeWordServiceSource, /if \(!this\.config\.enabled\) return await this\.getState\(\);/);
  assert.doesNotMatch(wakeWordServiceSource, /config\.autoStart/);
  assert.doesNotMatch(enSource, /wakeWordAutoStart/);
  assert.doesNotMatch(esSource, /wakeWordAutoStart/);
});

test('wake word runner serializes session creation and ignores stale socket closes', async () => {
  const appViewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const runnerSource = await readSource('src/renderer/services/WakeWordClientRunner.ts');

  assert.match(appViewSource, /new WakeWordClientRunner\(api\)/);
  assert.doesNotMatch(appViewSource, /forgerWake(Stream|Start|Generation)Ref/);
  assert.match(runnerSource, /private pendingStart/);
  assert.match(runnerSource, /private generation = 0/);
  assert.match(runnerSource, /this\.pendingStart\?\.wakeSignature === wakeSignature/);
  assert.match(runnerSource, /!this\.isCurrent\(generation\)/);
  assert.match(runnerSource, /this\.activeSession\?\.generation !== generation/);
  assert.doesNotMatch(appViewSource, /waiting_for_microphone/);
});

test('wake word runner records diagnostic milestones without raw audio payloads', async () => {
  const appViewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const runnerSource = await readSource('src/renderer/services/WakeWordClientRunner.ts');
  const ipcSource = await readSource('src/shared/ipc.ts');
  const desktopApiSource = await readSource('src/shared/types/desktop-api.ts');
  const wakeWordTypesSource = await readSource('src/shared/types/wake-word.ts');

  assert.match(ipcSource, /wakeWordRecordDiagnostic: 'forger:wake-word:record-diagnostic'/);
  assert.match(desktopApiSource, /wakeWordRecordDiagnostic: \(input: WakeWordDiagnosticEvent\) => Promise<WakeWordState>/);
  for (const event of [
    'ensure_start',
    'session_created',
    'media_stream_opened',
    'socket_open',
    'start_sent',
    'ready_timeout',
    'ready_received',
    'first_audio_frame_sent',
    'socket_close',
    'ensure_failed',
    'start_send_failed',
    'stale_generation_ignored',
    'stop_requested',
  ]) {
    assert.match(runnerSource, new RegExp(`recordDiagnostic\\('${event}'`));
  }
  assert.match(runnerSource, /const activeSocket = new WebSocket/);
  assert.match(runnerSource, /activeSocket\.send\(JSON\.stringify/);
  assert.match(runnerSource, /let startSent = false/);
  assert.doesNotMatch(runnerSource, /activeSocket = null/);
  assert.doesNotMatch(runnerSource, /let socket/);
  assert.match(appViewSource, /runner\.dispose\(\)/);
  assert.doesNotMatch(wakeWordTypesSource, /interface WakeWordDiagnosticEvent[\s\S]{0,500}(pcm|buffer|raw)/i);
});

test('wake word server logs protocol milestones and timeouts', async () => {
  const serverSource = await readSource('resources/wake-word/server.py');

  for (const event of [
    'start_received',
    'model_loading',
    'first_audio_frame',
    'wake_start_timeout',
    'wake_model_load_timeout',
  ]) {
    assert.match(serverSource, new RegExp(event));
  }
  assert.match(serverSource, /asyncio\.wait_for\(websocket\.receive\(\), timeout=15 if not start_received else None\)/);
  assert.match(serverSource, /asyncio\.wait_for\(asyncio\.to_thread\(create_wake_detector, model_id\), timeout=30\)/);
});

test('wake word threshold editor accepts decimal drafts', async () => {
  const settingsSource = await readSource('src/renderer/views/SettingsView.tsx');

  assert.match(settingsSource, /value\.replace\(',', '\.'\)/);
  assert.match(settingsSource, /\/\^\\d\*\(\[\.,\]\\d\*\)\?\$\/\.test\(nextValue\)/);
});
