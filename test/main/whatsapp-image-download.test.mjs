import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, createHash, createHmac } from 'node:crypto';
const require = createRequire(import.meta.url);
const { Response } = require('undici');
const { downloadImageStream } = require('../../dist-electron/main/connections/modules/whatsapp/image-download.js');
const collect = async iterable => { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return Buffer.concat(chunks); };
const fixture = () => {
  const key = { remoteJid: 'chat', id: 'photo', fromMe: false };
  const keys = { iv: Buffer.alloc(16, 1), cipherKey: Buffer.alloc(32, 2), macKey: Buffer.alloc(32, 3) };
  const plain = Buffer.from('synthetic bytes');
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const encrypted = Buffer.concat([ciphertext, createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)]);
  const media = { url: 'https://mmg.whatsapp.net/media', directPath: '/media', mediaKey: Buffer.alloc(32, 4).toString('base64'), fileSha256: createHash('sha256').update(plain).digest(), fileEncSha256: createHash('sha256').update(encrypted).digest() };
  const input = { message: { key, message: { imageMessage: media } }, expected: key, authorize: async () => true, keys: async () => keys, reupload: async () => { throw new Error('unexpected'); }, fetch: async () => new Response(encrypted) };
  return { input, media, plain, encrypted };
};
test('owned fetch verifies ciphertext, MAC and plaintext before yielding any image bytes', async () => {
  const f = fixture(); assert.deepEqual(await collect(downloadImageStream(f.input)), f.plain);
  for (const field of ['fileSha256', 'fileEncSha256']) {
    const f = fixture(); f.media[field] = Buffer.alloc(32);
    await assert.rejects(collect(downloadImageStream(f.input)), /image_integrity/);
  }
  const bad = fixture(); delete bad.media.fileEncSha256; bad.encrypted[bad.encrypted.length - 1] ^= 1;
  await assert.rejects(collect(downloadImageStream(bad.input)), /image_integrity/);
});
test('deadline aborts a stalled response body after headers and releases the fetch stream', async () => {
  const f = fixture(); let aborted = false;
  f.input.timeoutMs = 20;
  f.input.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) {
    options.signal.addEventListener('abort', () => { aborted = true; controller.error(options.signal.reason); }, { once: true });
  } }));
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_timeout/);
  assert.equal(aborted, true);
});
test('deadline bounds stalled reupload and keys operations without accumulating per-chunk races', async () => {
  for (const operation of ['reupload', 'keys']) {
    const f = fixture(); f.input.timeoutMs = 20;
    if (operation === 'reupload') f.input.fetch = async () => new Response('', { status: 404 });
    f.input[operation] = async () => new Promise(() => {});
    await assert.rejects(collect(downloadImageStream(f.input)), /image_download_timeout/);
  }
});
test('expired media retries reupload only once and rejects a changed message or source', async () => {
  const f = fixture(); let calls = 0;
  f.input.fetch = async () => ++calls === 1 ? new Response('', { status: 410 }) : new Response(f.encrypted);
  f.input.reupload = async message => message;
  assert.deepEqual(await collect(downloadImageStream(f.input)), f.plain); assert.equal(calls, 2);
  f.input.fetch = async () => new Response('', { status: 404 });
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_failed/);
  f.input.reupload = async () => ({ key: { ...f.input.expected, id: 'other' }, message: { imageMessage: f.media } });
  await assert.rejects(collect(downloadImageStream(f.input)), /image_source_invalid/);
});
test('revoked permission, oversized ciphertext, missing body and malformed key return no plaintext', async () => {
  const f = fixture(); f.input.authorize = async () => false;
  await assert.rejects(collect(downloadImageStream(f.input)), /image_access_revoked/);
  const huge = fixture(); huge.input.fetch = async () => new Response(Buffer.alloc(10 * 1024 * 1024 + 27));
  await assert.rejects(collect(downloadImageStream(huge.input)), /image_download_size/);
  const missing = fixture(); missing.input.fetch = async () => new Response(null);
  await assert.rejects(collect(downloadImageStream(missing.input)), /image_body_missing/);
  for (const key of [null, '', Buffer.alloc(1), { bad: true }]) {
    const f = fixture(); f.media.mediaKey = key;
    await assert.rejects(collect(downloadImageStream(f.input)), /image_key_invalid/);
  }
});
test('byte metadata accepts persisted buffers and numeric arrays but rejects malformed values', async () => {
  for (const value of [Buffer.alloc(32, 4).toJSON(), Object.fromEntries(Array.from({ length: 32 }, (_, i) => [String(i), 4]))]) {
    const f = fixture(); f.media.mediaKey = value; delete f.media.fileSha256; delete f.media.fileEncSha256; delete f.media.directPath;
    assert.deepEqual(await collect(downloadImageStream(f.input)), f.plain);
  }
  for (const value of [{}, { type: 'Buffer' }, { type: 'Buffer', data: false }, { type: 'Wrong', data: [] }, { 0: 'bad' }, { 0: -1 }, { 0: 256 }, { 0: 1.5 }, 42]) {
    const f = fixture(); f.media.mediaKey = value;
    await assert.rejects(collect(downloadImageStream(f.input)), /image_key_invalid/);
  }
});
test('truncated ciphertext and revoked permission after decryption yield no output', async () => {
  const f = fixture(); f.input.fetch = async () => new Response(Buffer.alloc(10));
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_invalid/);
  const revoked = fixture(); let calls = 0; revoked.input.authorize = async () => ++calls === 1;
  await assert.rejects(collect(downloadImageStream(revoked.input)), /image_access_revoked/);
  for (const status of [404, 500]) {
    const f = fixture(); f.input.fetch = async () => new Response(null, { status }); f.input.reupload = async message => message;
    await assert.rejects(collect(downloadImageStream(f.input)), /image_download_failed/);
  }
});
test('encrypted padding cannot bypass the plaintext byte limit', async () => {
  const f = fixture(); const plain = Buffer.alloc(10 * 1024 * 1024 + 1);
  const keys = await f.input.keys(); const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const encrypted = Buffer.concat([ciphertext, createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)]);
  delete f.media.fileEncSha256; delete f.media.fileSha256; f.input.fetch = async () => new Response(encrypted);
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_size/);
});
test('control operations arriving after the deadline fail without an unhandled promise rejection', async () => {
  const f = fixture(); f.input.timeoutMs = 5;
  f.input.fetch = async () => { await new Promise(resolve => setTimeout(resolve, 20)); return new Response(f.encrypted); };
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_timeout/);
});
test('dispatcher preserves prototype methods and the original receiver for all callbacks', () => {
  const { createImageDownloadDispatcher } = require('../../dist-electron/main/connections/modules/whatsapp/image-download.js');
  class Handler {
    marker = 'original';
    onConnect() { assert.equal(this.marker, 'original'); this.connected = true; }
    onHeaders() { assert.equal(this.connected, true); this.body = 'ready'; return true; }
    onData() { assert.equal(this.body, 'ready'); }
  }
  const original = new Handler();
  const dispatcher = createImageDownloadDispatcher({ dispatch(_options, handler) {
    assert.equal(handler.marker, 'original'); assert.equal(handler.onUnknown, undefined);
    handler.onConnect(); handler.onHeaders(200, [], () => {}, 'OK'); handler.onData(); return true;
  } });
  assert.equal(dispatcher.dispatch({ origin: 'https://mmg.whatsapp.net', path: '/media' }, original), true);
  assert.equal(original.body, 'ready');
});
test('deadline independently bounds a broken fetch body and does not await stalled cancellation', async () => {
  const f = fixture(); let canceled = false; let released = false;
  f.input.timeoutMs = 20;
  f.input.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => new Promise(() => {}),
    cancel: () => { canceled = true; return new Promise(() => {}); },
    releaseLock: () => { released = true; },
  }) } });
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_timeout/);
  assert.equal(canceled, true); assert.equal(released, true);
});
test('cancellation errors do not leak an unhandled rejection while releasing a failed body', async () => {
  const f = fixture(); let released = false;
  f.input.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => { throw new Error('socket disconnected'); },
    cancel: async () => { throw new Error('already errored'); },
    releaseLock: () => { released = true; },
  }) } });
  await assert.rejects(collect(downloadImageStream(f.input)), /socket disconnected/);
  assert.equal(released, true);
});
test('dispatcher accepts headers when the downstream handler has no header callback', () => {
  const { createImageDownloadDispatcher } = require('../../dist-electron/main/connections/modules/whatsapp/image-download.js');
  const dispatcher = createImageDownloadDispatcher({ dispatch(_options, handler) {
    assert.equal(handler.onHeaders(200, [], () => {}, 'OK'), true);
    return true;
  } });
  assert.equal(dispatcher.dispatch({ origin: 'https://mmg.whatsapp.net', path: '/media' }, {}), true);
});
test('a permission result completing exactly after the deadline cannot revive an aborted download', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.input.timeoutMs = 20;
  f.input.authorize = async () => { t.mock.timers.tick(20); return true; };
  f.input.fetch = async () => assert.fail('The expired permission check must not begin a download');
  await assert.rejects(collect(downloadImageStream(f.input)), /image_download_timeout/);
});
