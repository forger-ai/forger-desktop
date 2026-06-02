import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const readSource = (relativePath) => fs.readFile(path.resolve(relativePath), 'utf8');

test('chat state migrates legacy conversations into locked chat modes', async () => {
  const source = await readSource('src/renderer/chat-state.ts');
  const sharedSource = await readSource('src/shared/types/chat.ts');

  assert.match(sharedSource, /export type ChatMode = 'create_app' \| 'edit_app' \| 'free_chat'/);
  assert.match(source, /mode\?: ChatMode/);
  assert.match(source, /conversation\.appId === 'forger' \? 'free_chat' : 'edit_app'/);
  assert.match(source, /mode === 'edit_app' \? \(conversation\.targetAppId \?\? conversation\.appId\) : null/);
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

  assert.match(source, /if \(run\.createdApp\) \{ void refreshApps\(\); \}/);
  assert.doesNotMatch(source, /run\.createdApp[\s\S]{0,120}startCreatedAppConversation/);
});

test('renderer separates installed Apps from curated Catalog in navigation and content', async () => {
  const sidebarSource = await readSource('src/renderer/components/Sidebar.tsx');
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');

  assert.match(sidebarSource, /id: 'chat'[\s\S]*id: 'apps'[\s\S]*id: 'catalog'/);
  assert.match(sidebarSource, /id: 'friends'/);
  assert.match(sidebarSource, /showForumNav \? \[defaultNav\[3\]\] : \[\]/);
  assert.match(viewSource, /const installedViewApps = useMemo<CatalogApp\[]>/);
  assert.match(viewSource, /currentView === 'apps' \? renderInstalledAppsView\(\) : null/);
  assert.match(viewSource, /<CatalogView\s+apps=\{catalogApps\}/);
  assert.match(viewSource, /currentView === 'friends'[\s\S]*<ForumPanel/);
  assert.match(viewSource, /showForumNav=\{forumParticipation\.status === 'opted_in'\}/);
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
