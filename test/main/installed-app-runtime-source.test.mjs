import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('installed app runtime does not redeclare dependency names used by local helpers', async () => {
  const source = await readFile(path.join(root, 'src/main/runtime/installed-app-runtime.ts'), 'utf8');
  const depsBlock = source.match(/const \{(?<deps>[\s\S]*?)\} = deps;/)?.groups?.deps ?? '';

  assert.doesNotMatch(depsBlock, /\bloadDesktopWindow\b/);
  assert.match(source, /const loadDesktopWindow = async/);
});
