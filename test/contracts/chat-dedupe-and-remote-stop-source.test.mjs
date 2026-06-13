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
