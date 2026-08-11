import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeCloudDevice,
  normalizeCloudUser,
  normalizeFriendship,
  normalizeCloudMessage,
  normalizeCloudMessageDelivery,
  normalizeMobileDesktopAuthorization,
  normalizeMobilePairingRequest,
} = require('../../dist-electron/main/forger-backend/cloud-normalizers.js');

const mobileDevice = {
  id: 11,
  device_uid: 'phone-11',
  name: 'Phone',
  kind: 'mobile',
  platform: 'ios',
  public_key: 'mobile-public-key',
  key_fingerprint: 'mobile-fingerprint',
  paired: true,
  online: true,
  last_seen_at: '2026-08-10T10:00:00Z',
};
const desktopDevice = {
  id: 22,
  device_uid: 'desktop-22',
  name: 'Desktop',
  kind: 'desktop',
  paired: true,
  online: true,
};
const sender = {
  id: 31,
  username: 'sender',
  display_name: 'Sender',
  first_name: 'Send',
  last_name: 'Er',
  online: true,
};
const recipient = { id: 32, username: 'recipient' };
const appShare = {
  id: 41,
  user_app_id: 42,
  user_app_share_id: 43,
  share_kind: 'friend_link',
  app_visibility_at_send: 'friends',
  app_name_snapshot: 'Finances',
  app_slug_snapshot: 'finances',
  app_owner_username_snapshot: 'sender',
  app: { id: 42, status: 'published', visibility: 'public', available: true },
  share: {
    id: 43,
    scope: 'friend',
    code: 'SHARE-43',
    deep_link: 'forger://share/43',
    revoked_at: '2026-08-11T10:00:00Z',
    expires_at: '2026-08-12T10:00:00Z',
    max_uses: 5,
    used_count: 2,
  },
};

test('cloud device and friendship summaries retain nullable execution and activity metadata', () => {
  const device = normalizeCloudDevice({
    id: 22,
    installed_apps: [{
      id: 'notes',
      execution_phase: 'running',
      executionMode: null,
      connectMode: null,
    }],
  });
  assert.deepEqual(device.installedApps[0], {
    id: 'notes',
    name: 'notes',
    status: 'installed',
    version: undefined,
    localNetworkShareSupported: false,
    remoteTunnelSupported: false,
    executionPhase: 'running',
    executionMode: null,
    connectMode: null,
  });

  const friend = normalizeCloudUser({
    ...recipient,
    devices: [{ id: 22, device_uid: 'desktop-22', key_fingerprint: 'fingerprint-22' }],
  });
  assert.equal(friend.devices[0].keyFingerprint, 'fingerprint-22');
  const friendship = normalizeFriendship({
    id: 71,
    status: 'accepted',
    requester_id: 31,
    addressee_id: 32,
    friend: recipient,
    created_at: '2026-08-10T09:00:00Z',
    updated_at: '2026-08-10T10:00:00Z',
    responded_at: '2026-08-10T09:05:00Z',
    last_message_at: '2026-08-10T09:50:00Z',
    unread_count: 2,
    last_read_at: '2026-08-10T09:45:00Z',
  });
  assert.equal(friendship.respondedAt, '2026-08-10T09:05:00Z');
  assert.equal(friendship.lastMessageAt, '2026-08-10T09:50:00Z');
  assert.equal(friendship.lastReadAt, '2026-08-10T09:45:00Z');
});

test('cloud pairing normalizer keeps a complete mobile-to-desktop request and safe defaults', () => {
  const normalized = normalizeMobilePairingRequest({
    id: 1,
    mobile_device_id: 11,
    desktop_device_id: 22,
    status: 'accepted',
    code: 'PAIR-1',
    code_expires_at: '2026-08-10T10:05:00Z',
    expires_at: '2026-08-10T10:10:00Z',
    mobile_device: mobileDevice,
    desktop_device: desktopDevice,
  });
  assert.deepEqual(normalized, {
    id: 1,
    mobileDeviceId: 11,
    desktopDeviceId: 22,
    status: 'accepted',
    code: 'PAIR-1',
    codeExpiresAt: '2026-08-10T10:05:00Z',
    expiresAt: '2026-08-10T10:10:00Z',
    mobileDevice: {
      id: 11, deviceUid: 'phone-11', name: 'Phone', kind: 'mobile', platform: 'ios',
      publicKey: 'mobile-public-key', keyFingerprint: 'mobile-fingerprint', paired: true, online: true,
      lastSeenAt: '2026-08-10T10:00:00Z', installedApps: [],
    },
    desktopDevice: {
      id: 22, deviceUid: 'desktop-22', name: 'Desktop', kind: 'desktop', platform: undefined,
      publicKey: undefined, keyFingerprint: undefined, paired: true, online: true,
      lastSeenAt: undefined, installedApps: [],
    },
  });
  const minimal = normalizeMobilePairingRequest({
    id: 2,
    mobile_device_id: 11,
    desktop_device_id: 22,
    status: 'unexpected',
    expires_at: '2026-08-10T10:10:00Z',
    mobile_device: mobileDevice,
    desktop_device: desktopDevice,
  });
  assert.equal(minimal.status, 'pending');
  assert.equal(minimal.code, undefined);
  assert.equal(minimal.codeExpiresAt, undefined);
});

test('cloud pairing and authorization reject incomplete identity links without throwing', () => {
  const pairing = {
    id: 1, mobile_device_id: 11, desktop_device_id: 22, expires_at: 'soon',
    mobile_device: mobileDevice, desktop_device: desktopDevice,
  };
  assert.equal(normalizeMobilePairingRequest(null), undefined);
  assert.equal(normalizeMobilePairingRequest('pairing'), undefined);
  for (const mutation of [
    { id: 'bad' }, { mobile_device_id: 'bad' }, { desktop_device_id: 'bad' },
    { mobile_device: null }, { desktop_device: null }, { expires_at: null },
  ]) assert.equal(normalizeMobilePairingRequest({ ...pairing, ...mutation }), undefined);

  const authorization = {
    id: 3,
    mobile_device_id: 11,
    desktop_device_id: 22,
    mobile_device: mobileDevice,
    desktop_device: desktopDevice,
  };
  assert.equal(normalizeMobileDesktopAuthorization(null), undefined);
  assert.equal(normalizeMobileDesktopAuthorization({ ...authorization, desktop_device_id: 'bad' }), undefined);
  assert.deepEqual(normalizeMobileDesktopAuthorization({
    ...authorization, active: false, revoked_at: '2026-08-10T10:30:00Z',
  }), {
    id: 3,
    mobileDeviceId: 11,
    desktopDeviceId: 22,
    active: false,
    revokedAt: '2026-08-10T10:30:00Z',
    mobileDevice: normalizeMobilePairingRequest(pairing).mobileDevice,
    desktopDevice: normalizeMobilePairingRequest(pairing).desktopDevice,
  });
});

test('cloud delivery normalizer maps a complete encrypted app-share delivery', () => {
  const normalized = normalizeCloudMessageDelivery({
    id: 51,
    sender,
    recipient,
    target_user_id: 32,
    target_cloud_device_id: 22,
    friendship_id: 91,
    client_message_id: 'client-51',
    message_type: 'CloudAppShareMessage',
    delivery_mode: 'ephemeral',
    source: 'app',
    source_app_id: 'finances',
    source_app_name: 'Finances',
    device_uid: 'desktop-22',
    key_fingerprint: 'desktop-fingerprint',
    ciphertext: 'encrypted-message',
    metadata: { correlationId: 'correlation-51' },
    app_share: appShare,
    expires_at: '2026-08-12T10:00:00Z',
    created_at: '2026-08-10T10:00:00Z',
    acked_at: '2026-08-10T10:01:00Z',
  });
  assert.equal(normalized.id, 51);
  assert.equal(normalized.sender.displayName, 'Sender');
  assert.equal(normalized.recipient.username, 'recipient');
  assert.equal(normalized.friendshipId, 91);
  assert.equal(normalized.messageType, 'CloudAppShareMessage');
  assert.equal(normalized.deliveryMode, 'ephemeral');
  assert.equal(normalized.source, 'app');
  assert.deepEqual(normalized.metadata, { correlationId: 'correlation-51' });
  assert.deepEqual(normalized.appShare.share, {
    id: 43,
    scope: 'friend',
    code: 'SHARE-43',
    deepLink: 'forger://share/43',
    revokedAt: '2026-08-11T10:00:00Z',
    expiresAt: '2026-08-12T10:00:00Z',
    maxUses: 5,
    usedCount: 2,
  });
});

test('cloud delivery normalizer supplies non-sensitive defaults and rejects invalid recipients', () => {
  const delivery = {
    id: 52,
    sender,
    recipient,
    target_user_id: 32,
    target_cloud_device_id: 22,
    client_message_id: 'client-52',
  };
  const normalized = normalizeCloudMessageDelivery(delivery);
  assert.equal(normalized.friendshipId, undefined);
  assert.equal(normalized.messageType, 'CloudTextMessage');
  assert.equal(normalized.deliveryMode, 'persistent');
  assert.equal(normalized.source, 'user');
  assert.equal(normalized.ciphertext, '');
  assert.deepEqual(normalized.metadata, {});
  assert.equal(normalized.appShare, undefined);
  assert.equal(normalized.expiresAt, new Date(0).toISOString());
  assert.equal(normalized.ackedAt, undefined);
  assert.equal(typeof normalized.createdAt, 'string');

  assert.equal(normalizeCloudMessageDelivery(null), undefined);
  assert.equal(normalizeCloudMessageDelivery('delivery'), undefined);
  for (const mutation of [
    { id: 'bad' }, { sender: null }, { recipient: null }, { target_user_id: 'bad' },
    { target_cloud_device_id: 'bad' }, { client_message_id: null },
  ]) assert.equal(normalizeCloudMessageDelivery({ ...delivery, ...mutation }), undefined);
});

test('cloud app-share normalization rejects corrupt nested records and preserves safe fallbacks', () => {
  const message = {
    id: 61,
    type: 'CloudAppShareMessage',
    sender,
    recipient,
    app_share: appShare,
  };
  const normalized = normalizeCloudMessage(message);
  assert.equal(normalized.type, 'CloudAppShareMessage');
  assert.equal(normalized.appShare.shareKind, 'friend_link');
  assert.equal(normalized.appShare.appVisibilityAtSend, 'friends');
  assert.deepEqual(normalized.appShare.app, {
    id: 42, status: 'published', visibility: 'public', available: true,
  });

  const malformedShares = [
    null,
    { ...appShare, id: 'bad' },
    { ...appShare, user_app_id: 'bad' },
    { ...appShare, share_kind: 'world' },
    { ...appShare, app_name_snapshot: null },
    { ...appShare, app_slug_snapshot: null },
    { ...appShare, app_owner_username_snapshot: null },
    { ...appShare, app: null },
    { ...appShare, app: { id: 'bad' } },
  ];
  for (const app_share of malformedShares) {
    assert.equal(normalizeCloudMessage({ ...message, app_share }), undefined);
  }

  const fallback = normalizeCloudMessage({
    ...message,
    app_share: {
      ...appShare,
      user_app_share_id: 'bad',
      share_kind: 'public_app',
      app_visibility_at_send: 'unknown',
      app: { id: 42, status: 'unknown', visibility: 'unknown', available: 0 },
      share: { id: 43, used_count: 'bad', max_uses: 'bad' },
    },
  });
  assert.equal(fallback.appShare.userAppShareId, undefined);
  assert.equal(fallback.appShare.appVisibilityAtSend, 'restricted');
  assert.deepEqual(fallback.appShare.app, {
    id: 42, status: 'deleted', visibility: 'restricted', available: false,
  });
  assert.deepEqual(fallback.appShare.share, {
    id: 43,
    scope: '',
    code: undefined,
    deepLink: undefined,
    revokedAt: undefined,
    expiresAt: undefined,
    maxUses: undefined,
    usedCount: 0,
  });
  assert.equal(normalizeCloudMessage({
    ...message, app_share: { ...appShare, share: null },
  }).appShare.share, undefined);
  assert.equal(normalizeCloudMessage({
    ...message, app_share: { ...appShare, share: { id: 'bad' } },
  }).appShare.share, undefined);
});
