import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);

const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('chat composer keeps per-conversation drafts and stays editable while a run is active', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const viewSource = await readSource('src/renderer/views/ChatView.tsx');

  assert.match(controllerSource, /chatDraftsByConversation/);
  assert.match(controllerSource, /activeChatDraftKey\s*=\s*activeConversationId\s*\?\?\s*selectedAppId\s*\?\?\s*FREE_CHAT_APP_ID/);
  assert.match(controllerSource, /setChatDraft\(targetConversationId as string,\s*''\)/);
  assert.match(viewSource, /contentEditable=\{codexConfigured\}/);
  assert.match(viewSource, /!isSending\s*&&\s*canSendCurrentMode\s*&&\s*\(serializeComposerText\(\)\.trim\(\)/);
});

test('question actions replace the composer and answer through the chat start-run path with an envelope prompt', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const viewSource = await readSource('src/renderer/views/ChatView.tsx');
  const questionComposerSource = await readSource('src/renderer/views/chat/QuestionComposer.tsx');
  const panelSource = await readSource('src/renderer/views/chat/ChatMessagesPanel.tsx');

  assert.doesNotMatch(panelSource, /message\.action\?\.type === 'question'/);
  assert.match(viewSource, /activeQuestionAction/);
  assert.match(viewSource, /QuestionComposer/);
  assert.doesNotMatch(viewSource, /function QuestionComposer/);
  assert.match(questionComposerSource, /questionFreeTextPlaceholder/);
  assert.match(questionComposerSource, /\{currentQuestionIndex \+ 1\}\/\{questions\.length\}/);
  assert.match(questionComposerSource, /setCurrentQuestionIndex\(\(current\) => current \+ 1\)/);
  assert.match(questionComposerSource, /questionNext/);
  assert.match(questionComposerSource, /fullWidth/);
  assert.doesNotMatch(questionComposerSource, /setFreeText\(''\)/);
  assert.match(questionComposerSource, /mode: 'options'/);
  assert.match(questionComposerSource, /mode === 'freeText'/);
  assert.match(questionComposerSource, /optionId: '__free_text__'/);
  assert.doesNotMatch(viewSource, /questionBadge/);
  assert.match(controllerSource, /run\.questionRequest/);
  assert.match(controllerSource, /conversations: chatConversations/);
  assert.match(controllerSource, /CHAT_STORAGE_KEY/);
  assert.match(controllerSource, /type:\s*'forger\.question_response'/);
  assert.match(controllerSource, /chatId:\s*request\.chatId/);
  assert.match(controllerSource, /questionRequestId:\s*request\.requestId/);
  assert.match(controllerSource, /answers:\s*response\.answers\.map/);
  assert.match(controllerSource, /freeText:\s*response\.freeText\?\.trim\(\)\s*\|\|\s*''/);
  assert.match(controllerSource, /getDesktopApi\(\)\.chatStartRun\(\{/);
});
