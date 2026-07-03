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
  assert.match(source, /onUploadSocial\(publishAppId, publishVisibility, publishCategory\)/);
  assert.match(source, /window\.forger\.updateSocialAppVisibility\(app\.id, visibility\)/);
});

test('Social app cards do not label the account owner direct-share apps as shared with you', async () => {
  const source = await readSource('src/renderer/views/SocialView.tsx');

  assert.match(source, /const isOwnedByAccount = accountUserId !== undefined && app\.owner\.id === accountUserId;/);
  assert.match(source, /<Chip size="small" label=\{visibilityLabel\(app, t, isOwnedByAccount\)\} variant="outlined" \/>/);
  assert.match(source, /if \(!isOwnedByAccount && app\.accessReason === 'direct_share'\) return t\.social\.visibility\.directShare;/);
});

test('Social profile owned apps expose localized edit-info controls through the existing update bridge', async () => {
  const source = await readSource('src/renderer/views/SocialView.tsx');
  const viewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const esSource = await readSource('src/renderer/i18n/es.ts');
  const enSource = await readSource('src/renderer/i18n/en.ts');

  assert.match(viewSource, /<SocialView[\s\S]*\bt=\{t\}/);
  assert.match(source, /onEditInfo=\{openEditAppInfoDialog\}/);
  assert.match(source, /window\.forger\.updateSocialApp\(\{/);
  assert.match(source, /window\.forger\.deleteSocialApp\(app\.id\)/);
  assert.match(source, /setMyApps\(\(current\) => current\.filter\(\(entry\) => entry\.id !== app\.id\)\)/);
  assert.match(source, /setProfileApps\(\(current\) => current\.filter\(\(entry\) => entry\.id !== app\.id\)\)/);
  assert.match(source, /setMyApps\(\(current\) => current\.map\(\(entry\) => entry\.id === updated\.id \? updated : entry\)\)/);
  assert.match(source, /setProfileApps\(\(current\) => current\.map\(\(entry\) => entry\.id === updated\.id \? updated : entry\)\)/);
  assert.match(source, /label=\{t\.social\.editAppNameLabel\}/);
  assert.match(source, /label=\{t\.social\.editAppShortDescriptionLabel\}/);
  assert.match(source, /label=\{t\.social\.editAppDescriptionLabel\}/);
  assert.match(source, /label=\{t\.social\.editAppCategoryLabel\}/);
  assert.match(source, /label=\{t\.social\.editAppVisibilityLabel\}/);
  assert.match(source, /\{t\.social\.unpublishAction\}/);
  assert.match(source, /t\.social\.unpublishConfirmAction/);
  assert.match(esSource, /editAppInfoAction: 'Editar info'/);
  assert.match(esSource, /unpublishAction: 'Retirar publicación'/);
  assert.match(enSource, /editAppInfoAction: 'Edit info'/);
  assert.match(enSource, /unpublishAction: 'Unpublish'/);
});

test('Desktop Social bridge has a dedicated user-app visibility update IPC', async () => {
  const ipcSource = await readSource('src/shared/ipc.ts');
  const preloadSource = await readSource('src/preload/index.ts');
  const apiSource = await readSource('src/shared/types/desktop-api.ts');
  const mainSource = await readSource('src/main/ipc/main-handlers.ts');

  assert.match(ipcSource, /updateSocialAppVisibility: 'forger:social:apps:update-visibility'/);
  assert.match(ipcSource, /deleteSocialApp: 'forger:social:apps:delete'/);
  assert.match(preloadSource, /updateSocialAppVisibility: \(userAppId, visibility\) => ipcRenderer\.invoke\(IPC_CHANNELS\.updateSocialAppVisibility, userAppId, visibility\)/);
  assert.match(preloadSource, /deleteSocialApp: \(userAppId\) => ipcRenderer\.invoke\(IPC_CHANNELS\.deleteSocialApp, userAppId\)/);
  assert.match(apiSource, /updateSocialAppVisibility: \(userAppId: number, visibility: Exclude<SocialUserAppVisibility, 'restricted'>\) => Promise<SocialUserApp>;/);
  assert.match(apiSource, /deleteSocialApp: \(userAppId: number\) => Promise<BasicActionResult>;/);
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.updateSocialAppVisibility, async \(_event, userAppId: number, visibility: Exclude<SocialUserAppVisibility, 'restricted'>\)/);
  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.deleteSocialApp, async \(_event, userAppId: number\)/);
});
