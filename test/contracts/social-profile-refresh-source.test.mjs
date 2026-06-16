import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);
const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('Social view exposes the refreshed Cloud profile tabs and profile controls', async () => {
  const source = await readSource('src/renderer/views/SocialView.tsx');

  assert.match(source, /type FullSocialTab = 'friends' \| 'forum' \| 'profile' \| 'search';/);
  assert.match(source, /{ value: 'friends', label: 'Amigos' }/);
  assert.match(source, /{ value: 'forum', label: 'Foro' }/);
  assert.match(source, /{ value: 'profile', label: 'Mi perfil' }/);
  assert.match(source, /{ value: 'search', label: 'Buscar' }/);
  assert.doesNotMatch(source, /{ value: 'apps', label: 'Mis apps' }/);

  assert.match(source, /displayNameDraft/);
  assert.match(source, /onUpdateProfile\(\{ displayName: displayNameDraft \}\)/);
  assert.match(source, /window\.forger\.openExternalUrl\(url\)/);
  assert.match(source, /navigator\.clipboard\.writeText\(url\)/);
  assert.match(source, /onUploadSocial\(publishAppId, publishVisibility\)/);
  assert.match(source, /window\.forger\.updateSocialAppVisibility\(app\.id, visibility\)/);
});

test('Social app cards do not label the account owner direct-share apps as shared with you', async () => {
  const source = await readSource('src/renderer/views/SocialView.tsx');

  assert.match(source, /const isOwnedByAccount = accountUserId !== undefined && app\.owner\.id === accountUserId;/);
  assert.match(source, /<Chip size="small" label=\{visibilityLabel\(app, isOwnedByAccount\)\} variant="outlined" \/>/);
  assert.match(source, /if \(!isOwnedByAccount && app\.accessReason === 'direct_share'\) return 'Compartida contigo';/);
});

test('Desktop Social bridge has a dedicated user-app visibility update IPC', async () => {
  const ipcSource = await readSource('src/shared/ipc.ts');
  const preloadSource = await readSource('src/preload/index.ts');
  const apiSource = await readSource('src/shared/types/desktop-api.ts');
  const mainSource = await readSource('src/main/ipc/main-handlers.ts');

  assert.match(ipcSource, /updateSocialAppVisibility: 'forger:social:apps:update-visibility'/);
  assert.match(preloadSource, /updateSocialAppVisibility: \(userAppId, visibility\) => ipcRenderer\.invoke\(IPC_CHANNELS\.updateSocialAppVisibility, userAppId, visibility\)/);
  assert.match(apiSource, /updateSocialAppVisibility: \(userAppId: number, visibility: Exclude<SocialUserAppVisibility, 'restricted'>\) => Promise<SocialUserApp>;/);
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.updateSocialAppVisibility, async \(_event, userAppId: number, visibility: Exclude<SocialUserAppVisibility, 'restricted'>\)/);
});
