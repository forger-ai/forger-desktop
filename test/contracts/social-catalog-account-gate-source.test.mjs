import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);
const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('catalog stays visible while Social downloads require a Forger Cloud account at install time', async () => {
  const catalogSource = await readSource('src/renderer/views/CatalogView.tsx');
  const englishSource = await readSource('src/renderer/i18n/locales/enSections.ts');
  const spanishSource = await readSource('src/renderer/i18n/locales/esSections.ts');

  assert.doesNotMatch(catalogSource, /t\.sections\.catalog\.signInRequired/);
  assert.match(catalogSource, /const visibleApps = filteredApps/);
  assert.match(catalogSource, /const \[socialDownloadAccountDialogOpen, setSocialDownloadAccountDialogOpen\] = useState\(false\);/);
  assert.match(catalogSource, /if \(isSocialCatalogApp\)[\s\S]*if \(!signedIn\)[\s\S]*setSocialDownloadAccountDialogOpen\(true\);[\s\S]*return;/);
  assert.match(catalogSource, /<Dialog open=\{socialDownloadAccountDialogOpen\}/);
  assert.match(catalogSource, /t\.sections\.catalog\.signInDownloadTitle/);
  assert.match(catalogSource, /t\.sections\.catalog\.signInDownloadBody/);
  assert.match(catalogSource, /onOpenCloudModal\(\);/);

  assert.match(spanishSource, /Cuenta de Forger Cloud requerida/);
  assert.match(spanishSource, /Para descargar apps del catálogo Social debes tener una cuenta en forger\.cloud\./);
  assert.match(englishSource, /Forger Cloud account required/);
  assert.match(englishSource, /To download apps from the Social catalog, you need an account on forger\.cloud\./);
});

test('app detail installs use the same Social account gate before review or download', async () => {
  const controllerSource = await readSource('src/renderer/app/RendererAppController.tsx');
  const rendererSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const appViewSource = await readSource('src/renderer/views/AppView.tsx');
  const appViewActionsSource = await readSource('src/renderer/views/app-view/AppViewActions.tsx');

  assert.match(appViewSource, /<AppViewActions[\s\S]*onInstall=\{onInstall\}/);
  assert.match(appViewActionsSource, /<Button variant="contained" startIcon=\{<DownloadRounded \/>\} onClick=\{\(\) => onInstall\(appId\)\}>/);
  assert.match(rendererSource, /<AppView[\s\S]*onInstall=\{\(appId\) => void handleInstall\(appId\)\}/);
  assert.match(controllerSource, /const \[socialDownloadAccountRequiredOpen, setSocialDownloadAccountRequiredOpen\] = useState\(false\);/);
  assert.match(controllerSource, /if \(social \|\| socialCatalogApp\)[\s\S]*if \(!forgerAccount\.authenticated \|\| !forgerAccount\.user\?\.confirmed\)[\s\S]*setSocialDownloadAccountRequiredOpen\(true\);[\s\S]*return;/);
  assert.match(controllerSource, /setSocialDownloadAccountRequiredOpen, errorReportDialog/);
  assert.match(rendererSource, /<Dialog open=\{Boolean\(socialDownloadAccountRequiredOpen\)\}/);
  assert.match(rendererSource, /setCloudModalOpen\(true\);/);
});
