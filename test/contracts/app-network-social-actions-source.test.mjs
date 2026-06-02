import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);
const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('catalog network share actions are not gated by early access', async () => {
  const source = await readSource('src/renderer/views/CatalogView.tsx');

  assert.match(source, /const canShareLocalNetwork = primaryAction === 'open'[\s\S]*app\.localNetworkShareSupported === true;/);
  assert.match(source, /const canShareRemoteNetwork = primaryAction === 'open'[\s\S]*app\.remoteTunnelSupported === true;/);
  assert.match(source, /const canStopRemoteNetwork = Boolean\(app\.remoteNetworkShare\?\.active\)/);
  assert.doesNotMatch(source, /const canShareLocalNetwork = earlyAccessEnabled/);
  assert.doesNotMatch(source, /const canShareRemoteNetwork = earlyAccessEnabled/);
  assert.doesNotMatch(source, /const canStopRemoteNetwork = earlyAccessEnabled/);
});

test('installed Apps cards expose network and Social actions in the primary menu', async () => {
  const source = await readSource('src/renderer/app/RendererAppView.tsx');

  assert.match(source, /const canShareLocalNetwork = canUseAppActionMenu && app\.localNetworkShareSupported === true;/);
  assert.match(source, /const canShareRemoteNetwork = canUseAppActionMenu && app\.remoteTunnelSupported === true;/);
  assert.match(source, /const canStopRemoteNetwork = canUseAppActionMenu[\s\S]*Boolean\(app\.remoteNetworkShare\?\.active\)/);
  assert.match(source, /const isPrivateLocal = app\.privateLocal === true;/);
  assert.match(source, /const canUploadSocial = canUseAppActionMenu && isPrivateLocal;/);
  assert.match(source, /beta=\{isPrivateLocal \|\| isBeta \|\| isEarlyAccess\}/);
  assert.match(source, /betaLabel=\{isPrivateLocal \? t\.beta\.privateLocalBadge : isEarlyAccess \? t\.beta\.earlyAccessBadge : 'Beta'\}/);
  assert.match(source, /primaryMenuActions=\{\[[\s\S]*t\.localNetwork\.menuAction[\s\S]*handleStartLocalNetworkShare\(app\.id\)[\s\S]*t\.remoteNetwork\.menuAction[\s\S]*handleStartRemoteNetworkShare\(app\.id\)[\s\S]*t\.remoteNetwork\.stop[\s\S]*handleStopRemoteNetworkShare\(app\.id\)[\s\S]*Subir a Social[\s\S]*handleUploadSocial\(app\.id\)/);
});

test('app detail view receives and renders network and Social action menu items', async () => {
  const viewSource = await readSource('src/renderer/views/AppView.tsx');
  const actionsSource = await readSource('src/renderer/views/app-view/AppViewActions.tsx');
  const rendererSource = await readSource('src/renderer/app/RendererAppView.tsx');

  assert.match(viewSource, /onStartLocalNetworkShare: \(appId: string\) => void;/);
  assert.match(viewSource, /onStartRemoteNetworkShare: \(appId: string\) => void;/);
  assert.match(viewSource, /onStopRemoteNetworkShare: \(appId: string\) => void;/);
  assert.match(viewSource, /onUploadSocial: \(appId: string\) => void;/);
  assert.match(viewSource, /<AppViewActions[\s\S]*onStartLocalNetworkShare=\{onStartLocalNetworkShare\}[\s\S]*onStartRemoteNetworkShare=\{onStartRemoteNetworkShare\}[\s\S]*onStopRemoteNetworkShare=\{onStopRemoteNetworkShare\}[\s\S]*onUploadSocial=\{onUploadSocial\}/);

  assert.match(actionsSource, /const canShareLocalNetwork = canUseAppActionMenu && details\.app\.localNetworkShareSupported === true;/);
  assert.match(actionsSource, /const canShareRemoteNetwork = canUseAppActionMenu && details\.app\.remoteTunnelSupported === true;/);
  assert.match(actionsSource, /const canStopRemoteNetwork = canUseAppActionMenu[\s\S]*Boolean\(details\.app\.remoteNetworkShare\?\.active\)/);
  assert.match(actionsSource, /const canUploadSocial = canUseAppActionMenu && details\.app\.privateLocal === true;/);
  assert.match(actionsSource, /const appMenuActions = \[[\s\S]*t\.localNetwork\.menuAction[\s\S]*onStartLocalNetworkShare\(appId\)[\s\S]*t\.remoteNetwork\.menuAction[\s\S]*onStartRemoteNetworkShare\(appId\)[\s\S]*t\.remoteNetwork\.stop[\s\S]*onStopRemoteNetworkShare\(appId\)[\s\S]*Subir a Social[\s\S]*onUploadSocial\(appId\)/);
  assert.match(actionsSource, /<ButtonGroup variant="contained"[\s\S]*aria-haspopup="menu"[\s\S]*<Menu/);

  assert.match(rendererSource, /<AppView[\s\S]*onStartLocalNetworkShare=\{handleStartLocalNetworkShare\}[\s\S]*onStartRemoteNetworkShare=\{handleStartRemoteNetworkShare\}[\s\S]*onStopRemoteNetworkShare=\{handleStopRemoteNetworkShare\}[\s\S]*onUploadSocial=\{\(appId\) => void handleUploadSocial\(appId\)\}/);
});
