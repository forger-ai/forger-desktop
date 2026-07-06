import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { clearDistModule, withMockedElectron } from './electron-test-helpers.mjs';

const require = createRequire(import.meta.url);
const {
  normalizeMobilePairingRequest,
  normalizeSocketDevice,
  normalizeAppAccessRequest,
  remoteRequestId,
} = require('../../dist-electron/main/cloud-device-message-normalizers.js');

const tmpRoot = async (name) => await fs.mkdtemp(path.join(os.tmpdir(), `forger-${name}-`));

const createSafeStorage = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (buffer) => buffer.toString('utf8').replace(/^sealed:/, ''),
});

test('normalizeMobilePairingRequest converts cloud snake_case pairing payloads into the internal summary', () => {
  const normalized = normalizeMobilePairingRequest({
    id: 12,
    mobile_device_id: 91,
    desktop_device_id: 74,
    status: 'accepted',
    code: 'ABCD2345',
    code_expires_at: '2026-07-04T10:05:00Z',
    expires_at: '2026-07-04T10:10:00Z',
    mobile_device: {
      id: 91,
      device_uid: 'phone-uid',
      name: 'Felipe iPhone',
      kind: 'mobile',
      platform: 'ios',
      public_key: 'phone-public-key',
      key_fingerprint: 'phone-fingerprint',
      paired: true,
      online: true,
      last_seen_at: '2026-07-04T09:59:00Z',
    },
    desktop_device: {
      id: 74,
      device_uid: 'desktop-uid',
      name: 'Work Mac',
    },
  });

  assert.deepEqual(normalized, {
    id: 12,
    mobileDeviceId: 91,
    desktopDeviceId: 74,
    status: 'accepted',
    code: 'ABCD2345',
    codeExpiresAt: '2026-07-04T10:05:00Z',
    expiresAt: '2026-07-04T10:10:00Z',
    mobileDevice: {
      id: 91,
      deviceUid: 'phone-uid',
      name: 'Felipe iPhone',
      kind: 'mobile',
      platform: 'ios',
      publicKey: 'phone-public-key',
      keyFingerprint: 'phone-fingerprint',
      paired: true,
      online: true,
      lastSeenAt: '2026-07-04T09:59:00Z',
      installedApps: [],
    },
    desktopDevice: {
      id: 74,
      deviceUid: 'desktop-uid',
      name: 'Work Mac',
      kind: 'desktop',
      platform: undefined,
      publicKey: undefined,
      keyFingerprint: undefined,
      paired: false,
      online: false,
      lastSeenAt: undefined,
      installedApps: [],
    },
  });
});

test('normalizeMobilePairingRequest accepts camelCase payloads and defaults unknown statuses to pending', () => {
  const normalized = normalizeMobilePairingRequest({
    id: 13,
    mobileDeviceId: 91,
    desktopDeviceId: 74,
    status: 'processing',
    codeExpiresAt: '2026-07-04T10:05:00Z',
    expiresAt: '2026-07-04T10:10:00Z',
    mobileDevice: { id: 91, deviceUid: 'phone-uid', name: 'Felipe iPhone', kind: 'mobile' },
    desktopDevice: { id: 74 },
  });

  assert.equal(normalized.status, 'pending');
  assert.equal(normalized.code, undefined);
  assert.equal(normalized.codeExpiresAt, '2026-07-04T10:05:00Z');
  assert.equal(normalized.expiresAt, '2026-07-04T10:10:00Z');
  assert.equal(normalized.mobileDevice.deviceUid, 'phone-uid');
  assert.equal(normalized.desktopDevice.id, 74);
});

test('normalizeMobilePairingRequest rejects malformed pairing payloads instead of crashing the channel', () => {
  const validRequest = {
    id: 14,
    mobile_device_id: 91,
    desktop_device_id: 74,
    expires_at: '2026-07-04T10:10:00Z',
    mobile_device: { id: 91 },
    desktop_device: { id: 74 },
  };

  assert.equal(normalizeMobilePairingRequest(null), null);
  assert.equal(normalizeMobilePairingRequest('pairing_requested'), null);
  assert.equal(normalizeMobilePairingRequest({ ...validRequest, id: 'not-a-number' }), null);
  assert.equal(normalizeMobilePairingRequest({ ...validRequest, mobile_device_id: undefined }), null);
  assert.equal(normalizeMobilePairingRequest({ ...validRequest, mobile_device: undefined }), null);
  assert.equal(normalizeMobilePairingRequest({ ...validRequest, desktop_device: 'desktop' }), null);
  assert.equal(normalizeMobilePairingRequest({ ...validRequest, expires_at: undefined }), null);
});

test('normalizeSocketDevice fills defaults, flags mobile devices, and rejects unusable entries', () => {
  assert.equal(normalizeSocketDevice(null), null);
  assert.equal(normalizeSocketDevice('device'), null);
  assert.equal(normalizeSocketDevice({ id: 'not-a-number' }), null);

  assert.deepEqual(normalizeSocketDevice({ id: 5 }), {
    id: 5,
    deviceUid: '',
    name: 'Forger Device',
    kind: 'desktop',
    platform: undefined,
    publicKey: undefined,
    keyFingerprint: undefined,
    paired: false,
    online: false,
    lastSeenAt: undefined,
    installedApps: [],
  });

  const byDeviceKind = normalizeSocketDevice({ id: 6, device_kind: 'mobile', deviceUid: 'phone-uid' });
  assert.equal(byDeviceKind.kind, 'mobile');
  assert.equal(byDeviceKind.deviceUid, 'phone-uid');
});

test('normalizeAppAccessRequest only accepts local_network or remote_tunnel share modes', () => {
  assert.equal(normalizeAppAccessRequest({ request_id: 'r-1', app_id: 'finance-os', mode: 'ftp' }), null);
  assert.equal(normalizeAppAccessRequest({ request_id: 'r-1', app_id: 'finance-os' }), null);

  assert.deepEqual(
    normalizeAppAccessRequest({ requestId: 'r-2', appId: 'finance-os', mode: 'local_network', requestedByDeviceId: 91 }),
    { requestId: 'r-2', appId: 'finance-os', mode: 'local_network', requestedByDeviceId: 91 },
  );
});

test('remoteRequestId resolves identifier aliases and falls back to empty for unusable values', () => {
  assert.equal(remoteRequestId({}), '');
  assert.equal(remoteRequestId({ request_id: '   ' }), '');
  assert.equal(remoteRequestId({ id: true }), '');
  assert.equal(remoteRequestId({ id: Number.NaN }), '');
  assert.equal(remoteRequestId({ remote_session_request_id: 12 }), '12');
  assert.equal(remoteRequestId({ requestId: '  req-7  ' }), 'req-7');
});

test('CloudDeviceStorage discards persisted device records without credentials and mints a fresh identity', async (t) => {
  const root = await tmpRoot('cloud-device-storage-missing-secret');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  await withMockedElectron({ safeStorage: createSafeStorage() }, async (require) => {
    clearDistModule('main/cloud-device-storage.js');
    const { CloudDeviceStorage } = require('../../dist-electron/main/cloud-device-storage.js');
    const filePath = path.join(root, 'cloud-device.json');
    await fs.writeFile(filePath, JSON.stringify({ deviceUid: 'legacy-uid' }), 'utf8');

    const storage = new CloudDeviceStorage({ filePath, accountStorageKey: () => undefined });
    assert.equal(await storage.load(), null);

    const created = await storage.loadOrCreate();
    assert.notEqual(created.deviceUid, 'legacy-uid');
    assert.match(created.deviceSecret, /^[0-9a-f]{64}$/);

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    assert.equal(persisted.encrypted, true);
    assert.equal(persisted.deviceUid, created.deviceUid);
  });
});
