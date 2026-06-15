import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);
const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('open and runtime app errors keep the normal open action instead of catalog retry', async () => {
  const helperSource = await readSource('src/renderer/app-error-actions.ts');
  const source = await readSource('src/renderer/views/CatalogView.tsx');
  const installedAppsSource = await readSource('src/renderer/app/RendererAppView.tsx');
  const appDetailsSource = await readSource('src/renderer/views/app-view/AppViewActions.tsx');

  assert.match(helperSource, /app\.lastErrorOperation === 'open' \|\| app\.lastErrorOperation === 'runtime'/);
  assert.match(helperSource, /app\.lastErrorOperation === 'update'/);
  assert.match(helperSource, /app\.lastErrorOperation === 'install'/);

  assert.match(source, /const isPrivateLocal = app\.privateLocal === true;/);
  assert.match(source, /const canOpenError = isOpenableError\(app\);/);
  assert.match(source, /canRecoverUpdateError \? 'update'/);
  assert.match(source, /canRetryInstallError \? 'retry'/);
  assert.match(source, /if \(canRecoverUpdateError\)[\s\S]*onUpdate\(app\.id\);/);
  assert.match(source, /if \(canRetryInstallError\)[\s\S]*onRetry\(app\.id\);/);
  assert.match(source, /onOpen\(app\.id\);/);

  assert.match(installedAppsSource, /const canOpenError = isOpenableError\(app\);/);
  assert.match(installedAppsSource, /canRecoverUpdateError \? 'update'/);
  assert.match(installedAppsSource, /if \(canRecoverUpdateError\)[\s\S]*handleUpdate\(app\.id\);/);
  assert.match(installedAppsSource, /if \(canRetryInstallError\)[\s\S]*handleRetry\(app\.id\);/);
  assert.match(installedAppsSource, /void handleOpen\(app\.id\);/);

  assert.match(appDetailsSource, /const canOpenError = isOpenableError\(details\.app\);/);
  assert.match(appDetailsSource, /canRecoverUpdateError \? \(/);
  assert.match(appDetailsSource, /canRetryInstallError \? \(/);
});
