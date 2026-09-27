import assert from 'node:assert/strict';
import { createCipheriv, createHmac } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { WhatsAppLocalStore } = require('../../dist-electron/main/connections/modules/whatsapp/store.js');
const { normalizeBaileysMessage, encodeStableMessageRef } = require('../../dist-electron/main/connections/modules/whatsapp/normalizer.js');
const { readCurrentMessageImages, normalizeImage, MAX_IMAGE_BYTES } = require('../../dist-electron/main/connections/modules/whatsapp/current-images.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3x8AAAAASUVORK5CYII=', 'base64');
const fixture = async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-current-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new WhatsAppLocalStore(root); await store.load();
  const current = normalizeBaileysMessage({ key: { remoteJid: 'chat@lid', id: 'current', fromMe: false }, message: { imageMessage: { caption: '@Kupita describe', mimetype: 'image/png' } } });
  const older = normalizeBaileysMessage({ key: { remoteJid: 'chat@lid', id: 'older', fromMe: false }, message: { imageMessage: { mimetype: 'image/png' } } });
  await store.upsertMessages([current, older]);
  const downloaded = [];
  const ports = { download: async attachment => { downloaded.push(attachment.attachmentId); return (async function* () { yield png; })(); }, codec: async () => ({ data: png.toString('base64'), mimeType: 'image/png' }) };
  return { root, store, current, ports, downloaded, scope: { chatId: 'phone@s.whatsapp.net', identityIds: ['chat@lid'], stableMessageRef: encodeStableMessageRef(current.stableMessageRef) } };
};
test('only the durable invoking message supplies images, including authenticated counterpart identity', async t => {
  const f = await fixture(t);
  const result = await readCurrentMessageImages(f.store, f.scope, f.ports);
  assert.equal(result.success, true); assert.equal(result.images.length, 1);
  assert.deepEqual(f.downloaded, [f.current.attachments[0].attachmentId]);
  assert.equal(JSON.stringify(result).includes(f.root), false);
});
test('foreign or nonexistent message references never authorize downloads', async t => {
  const f = await fixture(t);
  assert.equal((await readCurrentMessageImages(f.store, { ...f.scope, identityIds: [] }, f.ports)).success, false);
  assert.equal((await readCurrentMessageImages(f.store, { ...f.scope, stableMessageRef: 'forged' }, f.ports)).success, false);
  assert.deepEqual(f.downloaded, []);
});
test('stream byte limit stops before accumulating oversized media', async t => {
  const f = await fixture(t); let closed = false;
  f.ports.download = async () => (async function* () { try { yield Buffer.alloc(MAX_IMAGE_BYTES); yield Buffer.alloc(1); assert.fail('stream must stop'); } finally { closed = true; } })();
  const result = await readCurrentMessageImages(f.store, f.scope, f.ports);
  assert.equal(result.success, false); assert.equal(closed, true); assert.equal(result.images, undefined);
});
test('cached files outside downloads or symlinks cannot be read', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'private.png'); await writeFile(outside, png);
  await f.store.markAttachmentDownloaded({ attachmentId: f.current.attachments[0].attachmentId, localPath: outside, sizeBytes: png.length, sha256: '' });
  assert.equal((await readCurrentMessageImages(f.store, f.scope, f.ports)).success, false);
  const link = path.join(f.store.downloadsDirectory(), 'linked.png'); await symlink(outside, link);
  await f.store.markAttachmentDownloaded({ attachmentId: f.current.attachments[0].attachmentId, localPath: link, sizeBytes: png.length, sha256: '' });
  assert.equal((await readCurrentMessageImages(f.store, f.scope, f.ports)).success, false);
  assert.deepEqual(f.downloaded, []);
});
test('format and dimensions are validated before decoding and output is resized and bounded', async () => {
  let called = 0;
  const codec = async (_bytes, dimensions) => { called++; assert.equal(dimensions.width, 1); return { data: png.toString('base64'), mimeType: 'image/png' }; };
  await normalizeImage(png, codec); assert.equal(called, 1);
  await assert.rejects(normalizeImage(Buffer.from('not an image'), codec));
  const bomb = Buffer.from(png); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20);
  await assert.rejects(normalizeImage(bomb, codec)); assert.equal(called, 1);
});
test('a bounded regular cached photo is reused without a network download', async t => {
  const f = await fixture(t); const cached = path.join(f.store.downloadsDirectory(), 'photo.png'); await writeFile(cached, png);
  await f.store.markAttachmentDownloaded({ attachmentId: f.current.attachments[0].attachmentId, localPath: cached, sizeBytes: png.length, sha256: '' });
  assert.equal((await readCurrentMessageImages(f.store, f.scope, f.ports)).success, true);
  assert.deepEqual(f.downloaded, []);
});
test('JPEG dimensions are read before decode and unsupported or malformed headers are rejected', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 7, 8, 0, 4, 0, 3]);
  assert.deepEqual(await normalizeImage(jpeg, async (_bytes, size) => { assert.deepEqual(size, { width: 3, height: 4 }); return { data: 'AA==', mimeType: 'image/jpeg' }; }), { data: 'AA==', mimeType: 'image/jpeg' });
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_IMAGE_BYTES + 1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), Buffer.from([0xff, 0xd8, 0, 0, 0, 0]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 99])]) {
    await assert.rejects(normalizeImage(bytes));
  }
  await assert.rejects(normalizeImage(png, async () => ({ data: '', mimeType: 'image/png' })));
  await assert.rejects(normalizeImage(png, async () => ({ data: Buffer.alloc(9 * 1024 * 1024).toString('base64'), mimeType: 'image/png' })));
});
test('download errors and photos with oversized declared lengths fail without exposing details', async t => {
  const f = await fixture(t);
  f.ports.download = async () => { throw new Error('/private/credentials'); };
  const result = await readCurrentMessageImages(f.store, f.scope, f.ports);
  assert.equal(result.success, false); assert.equal(JSON.stringify(result).includes('/private'), false);
  f.current.attachments[0].sizeBytes = MAX_IMAGE_BYTES + 1; await f.store.upsertMessages([f.current]);
  assert.equal((await readCurrentMessageImages(f.store, f.scope, f.ports)).success, false);
});
test('ordinary text or unsupported media cannot select an earlier photo', async t => {
  const f = await fixture(t);
  const text = normalizeBaileysMessage({ key: { remoteJid: 'chat@lid', id: 'text', fromMe: false }, message: { conversation: '@Kupita describe' } });
  await f.store.upsertMessages([text]);
  const result = await readCurrentMessageImages(f.store, { ...f.scope, stableMessageRef: encodeStableMessageRef(text.stableMessageRef) }, f.ports);
  assert.equal(result.success, false); assert.equal(result.technicalCode, 'whatsapp_current_images_missing'); assert.deepEqual(f.downloaded, []);
});
test('authority is rechecked before download, after download and after encoding', async t => {
  for (const revokeAt of [1, 2, 3, 4]) {
    const f = await fixture(t); let checks = 0;
    f.ports.authorize = async () => ++checks !== revokeAt;
    const result = await readCurrentMessageImages(f.store, f.scope, f.ports);
    assert.equal(result.success, false); assert.equal(result.images, undefined);
    if (revokeAt <= 2) assert.deepEqual(f.downloaded, []);
  }
});
test('media sources and redirect dispatch stay on the WhatsApp media host', () => {
  const { safeImageDownloadMessage, createImageDownloadDispatcher } = require('../../dist-electron/main/connections/modules/whatsapp/image-download.js');
  const key = { remoteJid: 'chat', id: 'photo', fromMe: false };
  const raw = (url, directPath = '/media') => ({ key, message: { imageMessage: { url, directPath }, conversation: 'ignored' } });
  assert.deepEqual(Object.keys(safeImageDownloadMessage(raw('https://mmg.whatsapp.net/a'), key).message), ['imageMessage']);
  for (const input of [null, {}, raw('http://mmg.whatsapp.net/a'), raw('https://evil.invalid/a'), raw('https://user@mmg.whatsapp.net/a'), raw('https://mmg.whatsapp.net/a', '//evil.invalid/a'), raw('https://mmg.whatsapp.net/a', '/a\\b'), raw('https://mmg.whatsapp.net/a', 3), raw(undefined), { ...raw('https://mmg.whatsapp.net/a'), key: { ...key, id: 'other' } }]) {
    assert.throws(() => safeImageDownloadMessage(input, key));
  }
  const errors = []; let calls = 0; let response;
  const dispatcher = createImageDownloadDispatcher({ dispatch(_options, handler) { calls++; response = handler; return true; } });
  const handler = { onError: error => errors.push(error.message), onHeaders: () => true };
  assert.equal(dispatcher.dispatch({ origin: 'https://evil.invalid', path: '/image' }, handler), false);
  assert.equal(calls, 0);
  assert.equal(dispatcher.dispatch({ origin: 'https://mmg.whatsapp.net', path: '/image' }, handler), true);
  assert.equal(response.onHeaders(302, [], () => {}, ''), false);
  assert.equal(response.onHeaders(200, [], () => {}, ''), true);
  assert.deepEqual(errors, ['image_source_invalid', 'image_redirect_denied']);
});
test('manager streams a scoped photo and validates reuploaded source before fetching again', async t => {
  const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
  const { Response } = require('undici');
  const f = await fixture(t);
  const raw = JSON.parse(f.current.attachments[0].rawMessageJson);
  raw.message.imageMessage.url = 'https://mmg.whatsapp.net/media';
  raw.message.imageMessage.mediaKey = Buffer.alloc(32, 1);
  f.current.attachments[0].rawMessageJson = JSON.stringify(raw); await f.store.upsertMessages([f.current]);
  const keys = { iv: Buffer.alloc(16, 1), cipherKey: Buffer.alloc(32, 2), macKey: Buffer.alloc(32, 3) };
  const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(png), cipher.final()]);
  const encrypted = Buffer.concat([ciphertext, createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)]);
  let reupload = false;
  const manager = new WhatsAppConnectionManager(f.store, { imageCodec: f.ports.codec, imageFetch: async (_url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal); assert.ok(options.dispatcher);
    return reupload ? new Response('', { status: 410 }) : new Response(encrypted);
  } }, async () => ({ getMediaKeys: async () => keys }));
  manager.ensureStarted = async () => {};
  manager.socket = { updateMediaMessage: async () => ({ ...raw, message: { imageMessage: { url: 'https://evil.invalid/photo' } } }) };
  assert.equal((await manager.readCurrentImages({}, 'chat@lid', f.scope.stableMessageRef, async () => true)).success, true);
  reupload = true;
  assert.equal((await manager.readCurrentImages({}, 'chat@lid', f.scope.stableMessageRef, async () => true)).success, false);
});
test('default Electron codec rejects invalid decodes, resizes either orientation and bounds its encoded output', async () => {
  const Module = require('node:module'); const original = Module._load;
  let size = { width: 1, height: 1 }; let empty = false; let largePng = false; const resized = [];
  const decoded = { getSize: () => size, isEmpty: () => empty, resize: options => { resized.push(options); return decoded; }, toPNG: () => largePng ? Buffer.alloc(2 * 1024 * 1024 + 1) : png, toJPEG: quality => { assert.equal(quality, 85); return Buffer.from('jpeg'); } };
  Module._load = function(id, ...args) { return id === 'electron' ? { nativeImage: { createFromBuffer: () => decoded } } : original.call(this, id, ...args); };
  try {
    assert.equal((await normalizeImage(png)).mimeType, 'image/png');
    for (const next of [{ width: 0, height: 1 }, { width: 1, height: 0 }, { width: 10000, height: 10000 }]) { size = next; await assert.rejects(normalizeImage(png)); }
    size = { width: 1, height: 1 }; empty = true; await assert.rejects(normalizeImage(png)); empty = false;
    size = { width: 4000, height: 2000 }; await normalizeImage(png);
    size = { width: 2000, height: 4000 }; await normalizeImage(png);
    assert.deepEqual(resized, [{ width: 2048 }, { height: 2048 }]);
    largePng = true; assert.equal((await normalizeImage(png)).mimeType, 'image/jpeg');
  } finally { Module._load = original; }
});
test('image count and total encoded size are bounded independently', async t => {
  const f = await fixture(t); const message = { ...f.current, attachments: Array.from({ length: 5 }, () => f.current.attachments[0]) };
  f.store.getMessageInChat = async () => message;
  assert.equal((await readCurrentMessageImages(f.store, f.scope, f.ports)).success, false);
  message.attachments.pop();
  f.ports.codec = async () => ({ data: Buffer.alloc(3 * 1024 * 1024).toString('base64'), mimeType: 'image/png' });
  assert.equal((await readCurrentMessageImages(f.store, f.scope, f.ports)).success, false);
});
test('manager rejects missing payload, changed sockets and revoked reupload while allowing valid refresh', async t => {
  const { WhatsAppConnectionManager } = require('../../dist-electron/main/connections/modules/whatsapp/manager.js');
  const { Response } = require('undici');
  for (const mode of ['missing-payload', 'changed-socket', 'changed-generation', 'missing-reupload', 'revoked-before-reupload', 'revoked-after-reupload', 'valid-reupload']) {
    const f = await fixture(t);
    const raw = JSON.parse(f.current.attachments[0].rawMessageJson);
    raw.message.imageMessage.url = 'https://mmg.whatsapp.net/media'; raw.message.imageMessage.mediaKey = Buffer.alloc(32, 1);
    const keys = { iv: Buffer.alloc(16, 1), cipherKey: Buffer.alloc(32, 2), macKey: Buffer.alloc(32, 3) };
    const cipher = createCipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
    const ciphertext = Buffer.concat([cipher.update(png), cipher.final()]);
    const encrypted = Buffer.concat([ciphertext, createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10)]);
    f.current.attachments[0].rawMessageJson = JSON.stringify(raw);
    if (mode === 'missing-payload') delete f.current.attachments[0].rawMessageJson;
    f.store.getMessageInChat = async () => f.current;
    let calls = 0; let allowed = true; let manager;
    manager = new WhatsAppConnectionManager(f.store, { imageCodec: f.ports.codec, imageFetch: async () => {
      if (mode === 'revoked-before-reupload') allowed = false;
      return ++calls === 1 ? new Response('', { status: 404 }) : new Response(encrypted);
    } }, async () => {
      if (mode === 'changed-socket') manager.socket = null;
      if (mode === 'changed-generation') manager.sessionGeneration++;
      return { getMediaKeys: async () => keys };
    });
    manager.ensureStarted = async () => {};
    manager.socket = mode === 'missing-reupload' ? {} : { updateMediaMessage: async () => {
      if (mode === 'revoked-after-reupload') allowed = false;
      return raw;
    } };
    const result = await manager.readCurrentImages({}, 'chat@lid', f.scope.stableMessageRef, async () => allowed);
    assert.equal(result.success, mode === 'valid-reupload', mode);
  }
});
