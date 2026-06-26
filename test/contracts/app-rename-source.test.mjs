import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);
const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('installed app rename has a dedicated IPC bridge and typed API result', async () => {
  const ipcSource = await readSource('src/shared/ipc.ts');
  const preloadSource = await readSource('src/preload/index.ts');
  const apiSource = await readSource('src/shared/types/desktop-api.ts');

  assert.match(ipcSource, /renameInstalledApp: 'forger:rename-installed-app'/);
  assert.match(preloadSource, /renameInstalledApp: \(input\) => ipcRenderer\.invoke\(IPC_CHANNELS\.renameInstalledApp, input\)/);
  assert.match(apiSource, /export interface RenameInstalledAppInput/);
  assert.match(apiSource, /renameInstalledApp: \(input: RenameInstalledAppInput\) => Promise<RenameInstalledAppResult>;/);
});

test('installed app rename updates visible metadata without changing technical identity', async () => {
  const mainSource = await readSource('src/main/ipc/main-handlers.ts');

  assert.match(mainSource, /ipcMain\.handle\(IPC_CHANNELS\.renameInstalledApp/);
  assert.match(mainSource, /parsed\.catalog = \{ \.\.\.catalog, display_name: name \};/);
  assert.match(mainSource, /await upsertInstalledRecord\(\{ \.\.\.record, name \}\);/);
  assert.doesNotMatch(mainSource, /parsed\.name = name/);
  assert.match(mainSource, /record\.publishedSocialSource\?\.userAppId \?\? record\.socialSource\?\.userAppId/);
});

test('remix upload keeps remix source separate from the user publication source', async () => {
  const mainSource = await readSource('src/main/ipc/main-handlers.ts');
  const recordTypeSource = await readSource('src/main/core/main-process-types.ts');
  const catalogTypeSource = await readSource('src/shared/types/catalog.ts');

  assert.match(mainSource, /remixSourceUserAppId: record\.socialSource\?\.userAppId/);
  assert.match(mainSource, /publishedSocialSource: \{/);
  assert.doesNotMatch(mainSource, /socialSource: \{\s*\.\.\.record\.socialSource/);
  assert.match(recordTypeSource, /publishedSocialSource\?: \{/);
  assert.match(catalogTypeSource, /publishedSocialSource\?: \{/);
});

test('renderer exposes localized rename controls for owned apps and remixes', async () => {
  const appViewActionsSource = await readSource('src/renderer/views/app-view/AppViewActions.tsx');
  const rendererViewSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const dialogsSource = await readSource('src/renderer/app/RendererAppDialogs.tsx');
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const esSource = await readSource('src/renderer/i18n/es.ts');
  const enSource = await readSource('src/renderer/i18n/en.ts');

  assert.match(appViewActionsSource, /canRenameApp = canUploadSocial/);
  assert.match(appViewActionsSource, /label: t\.social\.renameAppAction/);
  assert.match(rendererViewSource, /label: t\.social\.renameAppAction/);
  assert.match(dialogsSource, /renameAppDialog\.isRemix \? t\.social\.renameAppRemixBody/);
  assert.match(controllerSource, /getDesktopApi\(\)\.renameInstalledApp\(\{ appId, name: nextName \}\)/);
  assert.match(controllerSource, /const name = app\?\.name \?\? appId; setSocialUploadDialog/);
  assert.match(esSource, /renameAppAction: 'Cambiar nombre'/);
  assert.match(enSource, /renameAppAction: 'Rename'/);
});
