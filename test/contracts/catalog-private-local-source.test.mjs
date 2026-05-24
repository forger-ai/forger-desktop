import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);
const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('private local apps in error state keep the normal open action instead of catalog retry', async () => {
  const source = await readSource('src/renderer/views/CatalogView.tsx');

  assert.match(source, /const isPrivateLocal = app\.privateLocal === true;/);
  assert.match(source, /\|\| \(isPrivateLocal && app\.status === 'error'\)/);
  assert.match(source, /hasError && !isPrivateLocal \? 'retry'/);
  assert.match(source, /if \(hasError && !isPrivateLocal\)/);
});
