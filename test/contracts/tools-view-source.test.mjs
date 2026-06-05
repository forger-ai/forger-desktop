import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('ToolsView lists official tools from runtime state instead of hardcoding Gmail only', async () => {
  const source = await readFile(path.join(repoRoot, 'src/renderer/views/ToolsView.tsx'), 'utf8');
  assert.match(source, /officialTools\.map\(\(tool\) => \(\{/);
  assert.match(source, /officialToolById\.get\(selectedTool\)/);
  assert.match(source, /OfficialToolDetail/);
  assert.doesNotMatch(source, /export type SelectedTool = 'forger' \| 'gmail' \| null/);
});
