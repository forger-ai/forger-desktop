import type {
  CloudDeviceSummary,
  CloudFriendship,
  CloudFriendUser,
  CloudMessage,
  CloudMessageEnvelope,
} from '../../shared/types';

export const normalizeCloudDevice = (value: unknown): CloudDeviceSummary | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isFinite(id)) {
    return undefined;
  }
  const apps = Array.isArray(record.installed_apps)
    ? record.installed_apps
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return undefined;
        }
        const app = entry as Record<string, unknown>;
        const appId = typeof app.id === 'string' ? app.id : '';
        if (!appId) {
          return undefined;
        }
        return {
          id: appId,
          name: typeof app.name === 'string' ? app.name : appId,
          status: typeof app.status === 'string' ? app.status : 'installed',
          version: typeof app.version === 'string' ? app.version : undefined,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  return {
    id,
    deviceUid: typeof record.device_uid === 'string' ? record.device_uid : '',
    name: typeof record.name === 'string' ? record.name : 'Forger Desktop',
    platform: typeof record.platform === 'string' ? record.platform : undefined,
    publicKey: typeof record.public_key === 'string' ? record.public_key : undefined,
    keyFingerprint: typeof record.key_fingerprint === 'string' ? record.key_fingerprint : undefined,
    paired: Boolean(record.paired),
    online: Boolean(record.online),
    lastSeenAt: typeof record.last_seen_at === 'string' ? record.last_seen_at : undefined,
    installedApps: apps,
  };
};

export const normalizeCloudUser = (value: unknown): CloudFriendUser | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const username = typeof record.username === 'string' ? record.username : '';
  if (!Number.isFinite(id) || !username) {
    return undefined;
  }
  return {
    id,
    username,
    firstName: typeof record.first_name === 'string' ? record.first_name : undefined,
    lastName: typeof record.last_name === 'string' ? record.last_name : undefined,
    online: typeof record.online === 'boolean' ? record.online : undefined,
    devices: Array.isArray(record.devices)
      ? record.devices.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const device = entry as Record<string, unknown>;
          const deviceId = Number(device.id);
          const deviceUid = typeof device.device_uid === 'string' ? device.device_uid : '';
          if (!Number.isFinite(deviceId) || !deviceUid) return [];
          return [{
            id: deviceId,
            deviceUid,
            publicKey: typeof device.public_key === 'string' ? device.public_key : undefined,
            keyFingerprint: typeof device.key_fingerprint === 'string' ? device.key_fingerprint : undefined,
            online: Boolean(device.online),
          }];
        })
      : [],
  };
};

export const normalizeFriendship = (value: unknown): CloudFriendship | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const friend = normalizeCloudUser(record.friend);
  const status = record.status === 'accepted' || record.status === 'declined' || record.status === 'canceled' ? record.status : 'pending';
  if (!Number.isFinite(id) || !friend) {
    return undefined;
  }
  return {
    id,
    status,
    requesterId: Number(record.requester_id ?? 0),
    addresseeId: Number(record.addressee_id ?? 0),
    friend,
    createdAt: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : new Date().toISOString(),
    respondedAt: typeof record.responded_at === 'string' ? record.responded_at : undefined,
    lastMessageAt: typeof record.last_message_at === 'string' ? record.last_message_at : undefined,
    unreadCount: Number.isFinite(Number(record.unread_count)) ? Number(record.unread_count) : 0,
    lastReadAt: typeof record.last_read_at === 'string' ? record.last_read_at : undefined,
  };
};

export const normalizeCloudMessage = (value: unknown): CloudMessage | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sender = normalizeCloudUser(record.sender);
  const recipient = normalizeCloudUser(record.recipient);
  if (!sender || !recipient) {
    return undefined;
  }
  const envelopes = Array.isArray(record.envelopes)
    ? record.envelopes.map((entry) => normalizeCloudMessageEnvelope(entry)).filter(Boolean) as CloudMessageEnvelope[]
    : [];
  return {
    id: typeof record.id === 'number' ? record.id : Number.isFinite(Number(record.id)) ? Number(record.id) : undefined,
    sender,
    recipient,
    deliveryMode: record.delivery_mode === 'ephemeral' ? 'ephemeral' : 'persistent',
    source: record.source === 'app' ? 'app' : 'user',
    sourceAppId: typeof record.source_app_id === 'string' ? record.source_app_id : undefined,
    sourceAppName: typeof record.source_app_name === 'string' ? record.source_app_name : undefined,
    status: normalizeCloudMessageStatus(record.status),
    clientMessageId: typeof record.client_message_id === 'string' ? record.client_message_id : undefined,
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : {},
    envelopes,
    deliveredAt: typeof record.delivered_at === 'string' ? record.delivered_at : undefined,
    createdAt: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
  };
};

const normalizeCloudMessageEnvelope = (value: unknown): CloudMessageEnvelope | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ciphertext = typeof record.ciphertext === 'string' ? record.ciphertext : '';
  if (!ciphertext) {
    return undefined;
  }
  return {
    id: Number.isFinite(Number(record.id)) ? Number(record.id) : undefined,
    deviceUid: typeof record.device_uid === 'string' ? record.device_uid : undefined,
    keyFingerprint: typeof record.key_fingerprint === 'string' ? record.key_fingerprint : undefined,
    ciphertext,
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : {},
    readAt: typeof record.read_at === 'string' ? record.read_at : undefined,
  };
};

const normalizeCloudMessageStatus = (value: unknown): CloudMessage['status'] =>
  value === 'delivered' || value === 'not_delivered' || value === 'pending_permission' || value === 'blocked'
    ? value
    : 'stored';
