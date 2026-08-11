import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { appendDesktopLog, sanitizeDesktopLogString, sanitizeDesktopLogValue, serializeError } = require('../../dist-electron/main/desktop-logger.js');

test('desktop logger redacts nested encodings, truncates fields, and isolates circular values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b24-logger-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const encoded = `${'\\'.repeat(1_024)}"token":"secret"`;
  const sanitized = sanitizeDesktopLogString([
    'key value',
    'token value-without-separator',
    '"token" value-without-separator',
    encoded,
    `message=${'x'.repeat(120_100)}`,
  ].join(' '));
  assert.doesNotMatch(sanitizeDesktopLogString('private_key=secret api_key=also-secret'), /secret/);
  assert.match(sanitized, /truncated/);

  const array = [];
  array.push(array);
  assert.deepEqual(sanitizeDesktopLogValue(array), ['[Circular]']);
  const object = {};
  object.self = object;
  object.apiKey = 'secret';
  object.value = Symbol('visible');
  assert.deepEqual(sanitizeDesktopLogValue(object), { self: '[Circular]', apiKey: '[REDACTED]', value: 'Symbol(visible)' });
  assert.equal(sanitizeDesktopLogValue(1), 1);
  assert.equal(sanitizeDesktopLogValue(true), true);
  assert.equal(sanitizeDesktopLogValue(null), null);
  assert.equal(sanitizeDesktopLogValue(undefined), undefined);

  const error = new Error('token=secret');
  error.stack = '';
  error.cause = error;
  const serialized = serializeError(error);
  assert.equal(serialized.stack, undefined);
  assert.deepEqual(serialized.cause, { message: '[Circular error]' });
  assert.deepEqual(serializeError(Symbol('primitive')), { message: 'Symbol(primitive)' });

  await appendDesktopLog({ metadataRoot: root, service: 'desktop-main', event: 'event' });
  const written = JSON.parse((await fs.readFile(path.join(root, 'logs', 'forger-desktop.jsonl'), 'utf8')).trim());
  assert.equal(written.level, 'info');

  const blocked = path.join(root, 'blocked');
  await fs.writeFile(blocked, 'file');
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const originalWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  try {
    await appendDesktopLog({ metadataRoot: blocked, service: 'desktop-main', event: 'failure' });
  } finally {
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  assert.equal(warned, true);
});
