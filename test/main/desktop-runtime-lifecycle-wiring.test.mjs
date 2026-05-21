import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('main lifecycle wires assistant task status into the desktop runtime bridge', async () => {
  const source = await readFile(path.join(root, 'src/main/core/main-lifecycle.ts'), 'utf8');
  const bridgeBlock = source.match(/state\.desktopRuntimeBridge = new DesktopRuntimeBridge\(\{[\s\S]*?\n\s{2}\}\);/)?.[0] ?? '';

  assert.match(bridgeBlock, /getTaskManager:\s*\(\)\s*=>\s*state\.appAgentTaskManager/);
  assert.match(bridgeBlock, /getTaskStatus:\s*async\s*\(\)\s*=>/);
  assert.match(bridgeBlock, /getCodexAuthStatus\(\)\.catch/);
  assert.match(bridgeBlock, /getClaudeAuthStatus\(\)\.catch/);
  assert.match(bridgeBlock, /connected:\s*codex\s*\|\|\s*claude/);
});
