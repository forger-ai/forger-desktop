import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath) => fs.readFile(path.resolve(relativePath), 'utf8');

test('chat state migrates legacy conversations into locked chat modes', async () => {
  const source = await readSource('src/renderer/chat-state.ts');
  const sharedSource = await readSource('src/shared/types/chat.ts');

  assert.match(sharedSource, /export type ChatMode = 'create_app' \| 'edit_app' \| 'free_chat' \| 'social_app_review'/);
  assert.match(source, /mode\?: ChatMode/);
  assert.match(source, /conversation\.appId === 'forger' \? 'free_chat' : 'edit_app'/);
  assert.match(source, /mode === 'edit_app' \|\| mode === 'social_app_review' \? \(conversation\.targetAppId \?\? conversation\.appId\) : null/);
});

test('renderer starts on Chat and binds the mode selector before starting runs', async () => {
  const source = await readSource('src/renderer/app/RendererAppController.tsx');
  const viewSource = await readSource('src/renderer/views/ChatView.tsx');

  assert.match(source, /useState<View>\('chat'\)/);
  assert.match(source, /modeOverride\?: \{ mode: ChatMode; targetAppId\?: string \| null \}/);
  assert.match(source, /conversationForPrompt/);
  assert.match(source, /chatMode: activeChatMode/);
  assert.match(source, /targetAppId: activeTargetAppId/);
  assert.match(source, /chatMode, targetAppId: chatMode === 'edit_app' \? chatScopeId : null/);
  assert.match(viewSource, /pendingModeOverride/);
  assert.match(viewSource, /sendComposerMessage/);
});

test('renderer keeps MCP-created apps in the current chat flow', async () => {
  const source = await readSource('src/renderer/app/RendererAppController.tsx');

  assert.match(source, /if \(run\.createdApp\) \{[\s\S]*usageAnalytics\.localAppCreated\(\{ appId: run\.createdApp\.appId[\s\S]*void refreshApps\(\); \}/);
  assert.doesNotMatch(source, /run\.createdApp[\s\S]{0,120}startCreatedAppConversation/);
});

test('chat history drawer orders conversations and groups by recent activity', async () => {
  const source = await readSource('src/renderer/views/ChatView.tsx');
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');

  assert.match(controllerSource, /\.sort\(\(a, b\) => Date\.parse\(b\.updatedAt\) - Date\.parse\(a\.updatedAt\)\)/);
  assert.match(source, /const historyItemTimestamp = \(item: ConversationHistoryItem\)/);
  assert.match(source, /const sortHistoryItemsByRecentActivity = \(items: ConversationHistoryItem\[\]\)/);
  assert.match(source, /const historyGroupTimestamp = \(group: ConversationHistoryGroup\)/);
  assert.match(source, /const sortHistoryGroupsByRecentActivity = \(groups: ConversationHistoryGroup\[\]\)/);
  assert.match(source, /return sortHistoryGroupsByRecentActivity\(\[/);
  assert.match(source, /items: sortHistoryItemsByRecentActivity\(createAppItems\)/);
  assert.match(source, /items: sortHistoryItemsByRecentActivity\(reviewAppItems\)/);
  assert.match(source, /items: sortHistoryItemsByRecentActivity\(group\.items\)/);
  assert.match(source, /items: sortHistoryItemsByRecentActivity\(freeChatItems\)/);
});

test('chat locks provider for active conversations but keeps model and effort editable', async () => {
  const source = await readSource('src/renderer/views/ChatView.tsx');

  assert.match(source, /disabled=\{providerLocked \|\| isSending \|\| providerOptions\.length === 0\}/);
  assert.match(source, /disabled=\{isSending \|\| activeModelOptions\.length <= 1\}/);
  assert.match(source, /disabled=\{isSending\}/);
  assert.doesNotMatch(source, /disabled=\{providerLocked \|\| isSending \|\| activeModelOptions\.length <= 1\}/);
  assert.doesNotMatch(source, /disabled=\{providerLocked \|\| isSending\}/);
});

test('product docs stay as a skill, not a chat-mode injection', async () => {
  const freeChatStart = await readSource('src/main/prompt-builder/prompts/chat/free-chat-start.md');
  const createMode = await readSource('src/main/prompt-builder/prompts/partials/chat-modes/create-app.md');
  const editMode = await readSource('src/main/prompt-builder/prompts/partials/chat-modes/edit-app.md');
  const userMessageBuilder = await readSource('src/main/prompt-builder/user-message.ts');

  assert.doesNotMatch(freeChatStart, /forger-product-docs|Forger Documentation|Documentación de Forger/);
  assert.doesNotMatch(createMode, /forger-product-docs|Forger Documentation|Documentación de Forger/);
  assert.doesNotMatch(editMode, /forger-product-docs|Forger Documentation|Documentación de Forger/);
  assert.doesNotMatch(userMessageBuilder, /forger-product-docs|productDocs|Forger Documentation|Documentación de Forger/);
});

test('create app mode tells agents to inspect local and online shadcn components after creation', async () => {
  const createMode = await readSource('src/main/prompt-builder/prompts/partials/chat-modes/create-app.md');

  assert.match(createMode, /After `forger_create_app` succeeds, treat the created app as `APP_ROOT`/);
  assert.match(createMode, /inventory local shadcn components and query the online shadcn registry/);
  assert.match(createMode, /shadcn@latest -- list @shadcn --limit 200 --cwd \./);
  assert.match(createMode, /shadcn@latest -- search @shadcn --query "date" --limit 50 --cwd \./);
  assert.match(createMode, /shadcn@latest -- add <component> --cwd \./);
  assert.match(createMode, /Do not assume the local workspace is the complete component catalog/);
});

test('create and edit app modes require frontend patterns skill before visual changes', async () => {
  const createMode = await readSource('src/main/prompt-builder/prompts/partials/chat-modes/create-app.md');
  const editMode = await readSource('src/main/prompt-builder/prompts/partials/chat-modes/edit-app.md');

  assert.match(createMode, /forger-frontend-patterns/);
  assert.match(createMode, /before building or changing visual UI, layout, routing, interactions, mobile behavior, or frontend UX/);
  assert.match(editMode, /forger-frontend-patterns/);
  assert.match(editMode, /before proposing or implementing visual changes/);
});

test('renderer separates installed Apps from curated Catalog in navigation and content', async () => {
  const sidebarSource = await readSource('src/renderer/components/Sidebar.tsx');
  const settingsSource = await readSource('src/renderer/views/SettingsView.tsx');
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const englishSource = await readSource('src/renderer/i18n/en.ts');
  const spanishSource = await readSource('src/renderer/i18n/es.ts');

  assert.match(sidebarSource, /id: 'chat'[\s\S]*id: 'apps'[\s\S]*id: 'catalog'/);
  assert.doesNotMatch(sidebarSource, /id: 'docs' as const, icon:/);
  assert.match(sidebarSource, /id: 'friends'/);
  assert.match(sidebarSource, /defaultNav\.filter\(\(item\) => item\.id !== 'friends' \|\| showForumNav\)/);
  assert.match(settingsSource, /view: 'docs'[\s\S]*t\.settings\.advancedSurfaces\.docs/);
  assert.match(viewSource, /const installedViewApps = useMemo<CatalogApp\[]>/);
  assert.match(viewSource, /currentView === 'apps' \? renderInstalledAppsView\(\) : null/);
  assert.match(viewSource, /<CatalogView\s+apps=\{catalogApps\}/);
  assert.match(viewSource, /currentView === 'docs'[\s\S]*<DocsView/);
  assert.match(viewSource, /currentView === 'friends'[\s\S]*<SocialView/);
  assert.match(viewSource, /settingsInitialSubview/);
  assert.match(viewSource, /openLlmProviderSettings/);
  assert.match(viewSource, /initialSubview=\{settingsInitialSubview \?\? undefined\}/);
  assert.match(settingsSource, /initialSubview\?: SettingsSubview/);
  assert.match(settingsSource, /setSettingsSubview\(initialSubview\)/);
  assert.doesNotMatch(settingsSource, /llmProviderHowItWorksTitle/);
  assert.match(settingsSource, /providerDefaultModelLabel/);
  assert.match(settingsSource, /chatGptLogoUrl/);
  assert.doesNotMatch(settingsSource, /agentDefaultModelsTitle/);
  assert.match(englishSource, /Forger uses local agent tools/);
  assert.match(spanishSource, /Forger usa herramientas locales de agente/);
  assert.match(viewSource, /initialProfileUsername=\{socialProfileUsername\}/);
  assert.match(viewSource, /onSend=\{\(modeOverride\) => void handleSendMessage\(undefined, modeOverride\)\}/);
});

test('friend chat app share cards install through structured app share data', async () => {
  const source = await readSource('src/renderer/views/FriendChatWindowView.tsx');

  assert.match(source, /const appShareInstallInput = \(message: CloudMessage\) =>/);
  assert.match(source, /message\.appShare\.shareKind === 'public_app'[\s\S]*appId: message\.appShare\.userAppId/);
  assert.match(source, /const shareCode = message\.appShare\.share\?\.code;[\s\S]*shareCode \? \{ shareCode \} : null/);
  assert.match(source, /message\.appShare\.share\?\.revokedAt/);
  assert.match(source, /!message\.appShare\.app\.available/);
  assert.match(source, /window\.forger\.installSocialApp\(input, navigator\.language\)/);
});
