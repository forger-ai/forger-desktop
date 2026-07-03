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
  assert.match(viewSource, /contentEditable=\{intelligenceProviderConfigured\}/);
  assert.doesNotMatch(viewSource, /codexConfigured/);
  assert.match(viewSource, /inputProviderMissingPlaceholder/);
  assert.match(viewSource, /inputProviderMissingTitle/);
  assert.match(viewSource, /inputProviderMissingAction/);
  assert.match(viewSource, /onConfigureIntelligenceProvider/);
  assert.match(viewSource, /quotaCodexRequired/);
  assert.match(viewSource, /!isSending\s*&&\s*canSendCurrentMode\s*&&\s*\(serializeComposerText\(\)\.trim\(\)/);
});

test('chat readiness is based on any configured intelligence provider', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const panelSource = await readSource('src/renderer/views/chat/ChatMessagesPanel.tsx');
  const esSectionsSource = await readSource('src/renderer/i18n/locales/esSections.ts');
  const enSectionsSource = await readSource('src/renderer/i18n/locales/enSections.ts');

  assert.match(controllerSource, /const intelligenceProviderConfigured = codexAuthStatus\.authenticated \|\| claudeAuthStatus\.authenticated/);
  assert.match(controllerSource, /const codexProviderConfigured = codexAuthStatus\.authenticated/);
  assert.match(controllerSource, /intelligenceProviderConfigured=\{intelligenceProviderConfigured\}/);
  assert.match(controllerSource, /codexProviderConfigured=\{codexProviderConfigured\}/);
  assert.match(panelSource, /intelligenceProviderMissingBody/);
  assert.match(panelSource, /configureIntelligenceProvider/);
  assert.match(panelSource, /agentThinking/);
  assert.match(esSectionsSource, /Conecta una cuenta de IA para chatear/);
  assert.match(esSectionsSource, /Conectar IA/);
  assert.match(enSectionsSource, /Connect an AI account to chat/);
  assert.match(enSectionsSource, /Connect AI/);
  assert.match(esSectionsSource, /Conecta ChatGPT\/Codex o Claude para conversar con Forger/);
  assert.match(esSectionsSource, /Conectar proveedor/);
  assert.match(enSectionsSource, /Connect ChatGPT\/Codex or Claude to chat with Forger/);
  assert.match(enSectionsSource, /Connect provider/);
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
  assert.match(questionComposerSource, /setCurrentQuestionIndex\(\(current\) => Math\.max\(0, current - 1\)\)/);
  assert.match(questionComposerSource, /questionPrevious/);
  assert.match(questionComposerSource, /questionNext/);
  assert.match(questionComposerSource, /fullWidth/);
  assert.match(questionComposerSource, /questions\.every\(\(question\) => hasAnswer\(answersByQuestionId\[question\.id\]\)\)/);
  assert.match(questionComposerSource, /Tooltip title=\{option\.description\}/);
  assert.match(questionComposerSource, /InfoOutlinedIcon/);
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
  assert.match(controllerSource, /const targetConversationId = request\.chatId/);
  assert.doesNotMatch(controllerSource, /request\.chatId[\s\S]{0,120}activeConversationIdRef\.current/);
  assert.match(controllerSource, /answers:\s*response\.answers\.map/);
  assert.match(controllerSource, /description: answer\.description/);
  assert.match(controllerSource, /freeText:\s*response\.freeText\?\.trim\(\)\s*\|\|\s*''/);
  assert.match(controllerSource, /getDesktopApi\(\)\.chatStartRun\(\{/);
});
