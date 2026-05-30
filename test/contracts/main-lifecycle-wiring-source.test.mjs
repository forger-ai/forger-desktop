import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('main process passes local app creator into lifecycle MCP wiring', async () => {
  const mainProcessSource = await readFile(path.join(root, 'src/main/core/main-process.ts'), 'utf8');
  const lifecycleSource = await readFile(path.join(root, 'src/main/core/main-lifecycle.ts'), 'utf8');
  const registrationBlock = mainProcessSource.match(/registerMainLifecycle\(\{[\s\S]*?\n\}\);/)?.[0] ?? '';

  assert.match(lifecycleSource, /createLocalApp:\s*createLocalAppFromSkeleton/);
  assert.match(registrationBlock, /\bcreateLocalAppFromSkeleton\b/);
});
