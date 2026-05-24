import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url);

const readSource = (path) => readFile(join(repoRoot.pathname, path), 'utf8');

test('chat message panel constrains long plain text and progress overflow', async () => {
  const source = await readSource('src/renderer/views/chat/ChatMessagesPanel.tsx');

  assert.match(source, /overflowX:\s*'hidden'/);
  assert.match(source, /minWidth:\s*0/);
  assert.match(source, /overflowWrap:\s*'anywhere'/);
  assert.match(source, /wordBreak:\s*'break-word'/);
  assert.match(source, /whiteSpace:\s*'pre-wrap'/);
});

test('markdown messages contain code and table overflow locally', async () => {
  const source = await readSource('src/renderer/views/chat/MarkdownMessage.tsx');

  assert.match(source, /'& pre'/);
  assert.match(source, /overflowX:\s*'auto'/);
  assert.match(source, /'& pre code'/);
  assert.match(source, /whiteSpace:\s*'pre'/);
  assert.match(source, /overflowWrap:\s*'normal'/);
  assert.match(source, /'& table'/);
  assert.match(source, /display:\s*'block'/);
  assert.match(source, /maxWidth:\s*'100%'/);
  assert.match(source, /'& img, & video'/);
});
