import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appendDesktopLog } = require('../../dist-electron/main/desktop-logger.js');

test('DesktopLogger writes JSONL with service, event, stack traces, content, and redacted secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'forger-desktop-logger-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const error = new Error('unexpected failure');

  await appendDesktopLog({
    metadataRoot: root,
    level: 'error',
    service: 'tool:whatsapp',
    event: 'official_tool:whatsapp_message_ingest_failed',
    message: 'message content is intentionally logged',
    context: {
      chatId: '569123@s.whatsapp.net',
      text: 'normal content',
      accessToken: 'secret-token',
      creds: { noiseKey: 'secret-key' },
    },
    error,
  });

  const raw = await readFile(join(root, 'logs', 'forger-desktop.jsonl'), 'utf8');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.service, 'tool:whatsapp');
  assert.equal(entry.event, 'official_tool:whatsapp_message_ingest_failed');
  assert.equal(entry.message, 'message content is intentionally logged');
  assert.equal(entry.context.text, 'normal content');
  assert.equal(entry.context.accessToken, '[REDACTED]');
  assert.equal(entry.context.creds, '[REDACTED]');
  assert.equal(entry.error.message, 'unexpected failure');
  assert.match(entry.error.stack, /unexpected failure/);
});
