import type {
  CloudAppShareKind,
  CloudAppShareMessageDetail,
  CloudDeviceSummary,
  MobilePairingRequestSummary,
  CloudFriendship,
  CloudFriendUser,
  CloudMessage,
  CloudMessageDelivery,
  CloudMessageEnvelope,
  SocialUserAppStatus,
  SocialUserAppVisibility,
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
        const normalized = {
          id: appId,
          name: typeof app.name === 'string' ? app.name : appId,
          status: typeof app.status === 'string' ? app.status : 'installed',
          version: typeof app.version === 'string' ? app.version : undefined,
          localNetworkShareSupported: app.local_network_share_supported === true || app.localNetworkShareSupported === true,
          remoteTunnelSupported: app.remote_tunnel_supported === true || app.remoteTunnelSupported === true,
        };
        const executionPhase = normalizeExecutionPhase(app.execution_phase ?? app.executionPhase);
        const executionMode = normalizeExecutionMode(app.execution_mode ?? app.executionMode);
        const connectMode = normalizeConnectMode(app.connect_mode ?? app.connectMode);
        return {
          ...normalized,
          ...(executionPhase !== undefined ? { executionPhase } : {}),
          ...(executionMode !== undefined ? { executionMode } : {}),
          ...(connectMode !== undefined ? { connectMode } : {}),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : [];
  return {
    id,
    deviceUid: typeof record.device_uid === 'string' ? record.device_uid : '',
    name: typeof record.name === 'string' ? record.name : 'Forger Desktop',
    kind: record.kind === 'mobile' || record.device_kind === 'mobile' ? 'mobile' : 'desktop',
    platform: typeof record.platform === 'string' ? record.platform : undefined,
    publicKey: typeof record.public_key === 'string' ? record.public_key : undefined,
    keyFingerprint: typeof record.key_fingerprint === 'string' ? record.key_fingerprint : undefined,
    paired: Boolean(record.paired),
    online: Boolean(record.online),
    lastSeenAt: typeof record.last_seen_at === 'string' ? record.last_seen_at : undefined,
    installedApps: apps,
  };
};

const normalizeExecutionPhase = (value: unknown): CloudDeviceSummary['installedApps'][number]['executionPhase'] =>
  value === 'stopped' || value === 'starting' || value === 'running' || value === 'error'
    ? value
    : undefined;

const normalizeExecutionMode = (value: unknown): CloudDeviceSummary['installedApps'][number]['executionMode'] =>
  value === 'forger' || value === 'local_network' || value === 'remote_tunnel'
    ? value
    : value === null
      ? null
      : undefined;

const normalizeConnectMode = (value: unknown): CloudDeviceSummary['installedApps'][number]['connectMode'] =>
  value === 'local_network' || value === 'remote_tunnel'
    ? value
    : value === null
      ? null
      : undefined;

export const normalizeMobilePairingRequest = (value: unknown): MobilePairingRequestSummary | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const mobileDeviceId = Number(record.mobile_device_id);
  const desktopDeviceId = Number(record.desktop_device_id);
  const mobileDevice = normalizeCloudDevice(record.mobile_device);
  const desktopDevice = normalizeCloudDevice(record.desktop_device);
  const status = typeof record.status === 'string' && ['pending', 'accepted', 'rejected', 'confirmed', 'expired'].includes(record.status)
    ? record.status as MobilePairingRequestSummary['status']
    : 'pending';
  const expiresAt = typeof record.expires_at === 'string' ? record.expires_at : '';
  if (!Number.isFinite(id) || !Number.isFinite(mobileDeviceId) || !Number.isFinite(desktopDeviceId) || !mobileDevice || !desktopDevice || !expiresAt) {
    return undefined;
  }
  return {
    id,
    mobileDeviceId,
    desktopDeviceId,
    status,
    code: typeof record.code === 'string' ? record.code : undefined,
    codeExpiresAt: typeof record.code_expires_at === 'string' ? record.code_expires_at : undefined,
    expiresAt,
    mobileDevice,
    desktopDevice,
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
  const type = record.type === 'CloudAppShareMessage' ? 'CloudAppShareMessage' : 'CloudTextMessage';
  const deliveryMode: CloudMessage['deliveryMode'] = record.delivery_mode === 'ephemeral' ? 'ephemeral' : 'persistent';
  const source: CloudMessage['source'] = record.source === 'app' ? 'app' : 'user';
  const base = {
    id: typeof record.id === 'number' ? record.id : Number.isFinite(Number(record.id)) ? Number(record.id) : undefined,
    type,
    sender,
    recipient,
    deliveryMode,
    source,
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
  if (type === 'CloudAppShareMessage') {
    const appShare = normalizeCloudAppShareMessageDetail(record.app_share);
    if (!appShare) {
      return undefined;
    }
    return { ...base, type, appShare };
  }
  return { ...base, type };
};

export const normalizeCloudMessageDelivery = (value: unknown): CloudMessageDelivery | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const sender = normalizeCloudUser(record.sender);
  const recipient = normalizeCloudUser(record.recipient);
  const targetUserId = Number(record.target_user_id);
  const targetCloudDeviceId = Number(record.target_cloud_device_id);
  const clientMessageId = typeof record.client_message_id === 'string' ? record.client_message_id : '';
  if (!Number.isFinite(id) || !sender || !recipient || !Number.isFinite(targetUserId)
    || !Number.isFinite(targetCloudDeviceId) || !clientMessageId) {
    return undefined;
  }
  const appShare = normalizeCloudAppShareMessageDetail(record.app_share);
  return {
    id,
    sender,
    recipient,
    targetUserId,
    targetCloudDeviceId,
    friendshipId: Number.isFinite(Number(record.friendship_id)) ? Number(record.friendship_id) : undefined,
    clientMessageId,
    messageType: record.message_type === 'CloudAppShareMessage' ? 'CloudAppShareMessage' : 'CloudTextMessage',
    deliveryMode: record.delivery_mode === 'ephemeral' ? 'ephemeral' : 'persistent',
    source: record.source === 'app' ? 'app' : 'user',
    sourceAppId: typeof record.source_app_id === 'string' ? record.source_app_id : undefined,
    sourceAppName: typeof record.source_app_name === 'string' ? record.source_app_name : undefined,
    deviceUid: typeof record.device_uid === 'string' ? record.device_uid : undefined,
    keyFingerprint: typeof record.key_fingerprint === 'string' ? record.key_fingerprint : undefined,
    ciphertext: typeof record.ciphertext === 'string' ? record.ciphertext : '',
    metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : {},
    appShare,
    expiresAt: typeof record.expires_at === 'string' ? record.expires_at : new Date(0).toISOString(),
    createdAt: typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
    ackedAt: typeof record.acked_at === 'string' ? record.acked_at : undefined,
  };
};

const normalizeCloudAppShareMessageDetail = (value: unknown): CloudAppShareMessageDetail | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  const userAppId = Number(record.user_app_id);
  const shareKind = normalizeCloudAppShareKind(record.share_kind);
  const app = normalizeCloudAppShareApp(record.app);
  const appNameSnapshot = typeof record.app_name_snapshot === 'string' ? record.app_name_snapshot : '';
  const appSlugSnapshot = typeof record.app_slug_snapshot === 'string' ? record.app_slug_snapshot : '';
  const appOwnerUsernameSnapshot = typeof record.app_owner_username_snapshot === 'string' ? record.app_owner_username_snapshot : '';
  if (!Number.isFinite(id) || !Number.isFinite(userAppId) || !shareKind || !app || !appNameSnapshot || !appSlugSnapshot || !appOwnerUsernameSnapshot) {
    return undefined;
  }
  const userAppShareId = Number(record.user_app_share_id);
  const share = normalizeCloudAppShareLink(record.share);
  return {
    id,
    userAppId,
    userAppShareId: Number.isFinite(userAppShareId) ? userAppShareId : undefined,
    shareKind,
    appVisibilityAtSend: normalizeSocialUserAppVisibility(record.app_visibility_at_send),
    appNameSnapshot,
    appSlugSnapshot,
    appOwnerUsernameSnapshot,
    app,
    share,
  };
};

const normalizeCloudAppShareKind = (value: unknown): CloudAppShareKind | undefined =>
  value === 'public_app' || value === 'friends_link' || value === 'friend_link' ? value : undefined;

const normalizeSocialUserAppVisibility = (value: unknown): SocialUserAppVisibility =>
  value === 'public' || value === 'friends' || value === 'private' || value === 'restricted' ? value : 'restricted';

const normalizeSocialUserAppStatus = (value: unknown): SocialUserAppStatus =>
  value === 'published' || value === 'suspended' || value === 'deleted' ? value : 'deleted';

const normalizeCloudAppShareApp = (value: unknown): CloudAppShareMessageDetail['app'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isFinite(id)) {
    return undefined;
  }
  return {
    id,
    status: normalizeSocialUserAppStatus(record.status),
    visibility: normalizeSocialUserAppVisibility(record.visibility),
    available: Boolean(record.available),
  };
};

const normalizeCloudAppShareLink = (value: unknown): CloudAppShareMessageDetail['share'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = Number(record.id);
  if (!Number.isFinite(id)) {
    return undefined;
  }
  const maxUses = Number(record.max_uses);
  return {
    id,
    scope: typeof record.scope === 'string' ? record.scope : '',
    code: typeof record.code === 'string' ? record.code : undefined,
    deepLink: typeof record.deep_link === 'string' ? record.deep_link : undefined,
    revokedAt: typeof record.revoked_at === 'string' ? record.revoked_at : undefined,
    expiresAt: typeof record.expires_at === 'string' ? record.expires_at : undefined,
    maxUses: Number.isFinite(maxUses) ? maxUses : undefined,
    usedCount: Number.isFinite(Number(record.used_count)) ? Number(record.used_count) : 0,
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
