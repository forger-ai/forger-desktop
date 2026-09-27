import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { readCurrentMessageImages, normalizeImage, MAX_IMAGE_BYTES } = require('../../dist-electron/main/connections/modules/whatsapp/current-images.js');

test('JPEG padding and terminal markers cannot bypass dimension validation', async () => {
  let decoded = false;
  const codec = async () => { decoded = true; throw new Error('invalid header reached decoder'); };
  for (const bytes of [
    [0xff, 0xd8, 0xff, 0xff, 0xff, 0xff], // Padding exhausts the marker header.
    [0xff, 0xd8, 0xff, 0xd9, 0, 0], // End of image without dimensions.
    [0xff, 0xd8, 0xff, 0xda, 0, 0], // Scan data without a frame header.
  ]) await assert.rejects(normalizeImage(Buffer.from(bytes), codec), /unsupported/);
  assert.equal(decoded, false);
});

const cacheFixture = async t => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'forger-image-cache-edge-'));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'downloads');
  await fs.mkdir(directory);
  const photo = path.join(directory, 'photo.png');
  await fs.writeFile(photo, 'synthetic');
  let downloads = 0, decodes = 0;
  const store = {
    downloadsDirectory: () => directory,
    getMessageInChat: async (ref, chatIds) => {
      assert.equal(ref, 'current'); assert.deepEqual(chatIds, ['chat']);
      return { attachments: [{ kind: 'image', localPath: photo }] };
    },
  };
  const read = () => readCurrentMessageImages(store, { stableMessageRef: 'current', chatId: 'chat', identityIds: [] }, {
    download: async () => { downloads++; throw new Error('cache failure cannot choose a different source'); },
    codec: async () => { decodes++; throw new Error('unsafe cache reached decoder'); },
  });
  const denied = async () => {
    const result = await read();
    assert.equal(result.success, false);
    assert.equal(result.images, undefined);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(downloads, 0); assert.equal(decodes, 0);
  };
  return { root, directory, photo, store, denied };
};

test('a symlink replacing the entire downloads root is rejected', async t => {
  const f = await cacheFixture(t);
  const replacement = path.join(f.root, 'replacement');
  await fs.rename(f.directory, replacement);
  await fs.symlink(replacement, f.directory);
  await f.denied();
});

test('cache containment is rechecked when a file changes after lstat', async t => {
  const f = await cacheFixture(t);
  const outside = path.join(f.root, 'outside.png');
  await fs.writeFile(outside, 'private synthetic image');
  const original = fs.realpath;
  let changed = false;
  // Deterministically model replacement between lstat and canonicalization.
  fs.realpath = async (target, ...args) => {
    if (target === f.photo && !changed) {
      changed = true;
      await fs.unlink(f.photo);
      await fs.symlink(outside, f.photo);
    }
    return original(target, ...args);
  };
  try { await f.denied(); assert.equal(changed, true); }
  finally { fs.realpath = original; }
});

test('opened directories and oversized cached files are rejected before decoding', async t => {
  const directory = await cacheFixture(t);
  await fs.unlink(directory.photo);
  await fs.mkdir(directory.photo);
  await directory.denied();
  const oversized = await cacheFixture(t);
  await fs.truncate(oversized.photo, MAX_IMAGE_BYTES + 1);
  await oversized.denied();
});

test('a cached file growing after stat remains bounded and its descriptor is closed', async t => {
  const f = await cacheFixture(t);
  await fs.truncate(f.photo, MAX_IMAGE_BYTES);
  const original = fs.open;
  let closed = false, grown = false;
  fs.open = async (target, ...args) => {
    const handle = await original(target, ...args);
    if (target === f.photo) {
      const stat = handle.stat.bind(handle), close = handle.close.bind(handle);
      handle.stat = async () => {
        const snapshot = await stat();
        await fs.truncate(f.photo, MAX_IMAGE_BYTES + 1);
        grown = true;
        return snapshot;
      };
      handle.close = async () => { closed = true; return close(); };
    }
    return handle;
  };
  try { await f.denied(); assert.equal(grown, true); assert.equal(closed, true); }
  finally { fs.open = original; }
});
