import { Notification } from 'electron';
import { randomBytes } from 'node:crypto';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import { IPC_CHANNELS } from '../../shared/ipc';
import type { CloudDeviceManager } from '../cloud-device-manager';
import type { CloudIdentityStore, EncryptedCloudText } from '../cloud-identity-store';
import type { ForgerBackendClient } from '../forger-backend-client';
import { SocialMessageStore, type StoredSocialMessage } from './social-message-store';
import type { AppRegistry, RuntimeBinarySet } from '../core/main-process-types';
import type {
  CloudFriendUser,
  CloudMessage,
  CloudMessageDelivery,
  CloudMessageEnvelope,
  CloudSendAppShareInput,
  CloudSendMessageInput,
  CloudSocialEvent,
  FriendChatWindowOpenResult,
} from '../../shared/types';
import type { StoredForgerAccount } from '../forger-account-store';

interface CloudSocialRelayDeps {
  BetterSqlite3: typeof import('better-sqlite3') | null;
  CLAUDE_CODE_VERSION: string;
  DEFAULT_NODE_VERSION: string;
  CloudIdentityStore: typeof CloudIdentityStore;
  app: Electron.App;
  appWindows: Map<string, Electron.BrowserWindow>;
  canRunCommand: (command: string, args: string[]) => Promise<boolean>;
  cloudDeviceManager: CloudDeviceManager | null;
  cloudIdentityStore: CloudIdentityStore | null;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  existsFile: (filePath: string) => Promise<boolean>;
  forgerAccount: StoredForgerAccount;
  forgerBackendClient: ForgerBackendClient | null;
  friendChatWindows: Map<number, Electron.BrowserWindow>;
  fs: typeof fs;
  getClaudeRoot: () => string;
  getCloudIdentityPath: () => string;
  getSocialMessagesPath: () => string;
  getRuntimePathEntries: (runtime: RuntimeBinarySet) => string[];
  mainWindow: Electron.BrowserWindow | null;
  openOrFocusFriendChatWindowForFriend: (friend: CloudFriendUser) => Promise<FriendChatWindowOpenResult>;
  path: typeof path;
  registry: AppRegistry;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  runCommandCapture: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<{ code?: number | null; stdout: string; stderr: string }>;
}

export const createCloudSocialRelayController = (deps: CloudSocialRelayDeps) => {
  let { cloudIdentityStore } = deps;
  let socialMessageStore: SocialMessageStore | null = null;
  const { BetterSqlite3, CLAUDE_CODE_VERSION, DEFAULT_NODE_VERSION, CloudIdentityStore, app, appWindows, canRunCommand, cloudDeviceManager, ensureRuntimeInstalled, existsFile, forgerAccount, forgerBackendClient, friendChatWindows, fs, getClaudeRoot, getCloudIdentityPath, getSocialMessagesPath, getRuntimePathEntries, mainWindow, openOrFocusFriendChatWindowForFriend, path, registry, runCommand, runCommandCapture } = deps;

const findSqliteFile = async (searchDir: string): Promise<string | null> => {
  const extensions = ['.db', '.sqlite', '.sqlite3'];
  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });
    const file = entries.find(
      (entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)),
    );
    if (file) {
      return path.join(searchDir, file.name);
    }
  } catch {
    // directory may not exist
  }
  return null;
};

const resolveManagedClaudeCliPath = async (baseDir: string): Promise<string | null> => {
  const candidates = process.platform === 'win32'
    ? [
        path.join(baseDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
        path.join(baseDir, 'node_modules', '.bin', 'claude.cmd'),
        path.join(baseDir, 'node_modules', '.bin', 'claude'),
      ]
    : [
        path.join(baseDir, 'node_modules', '.bin', 'claude'),
        path.join(baseDir, 'node_modules', '.bin', 'claude.cmd'),
      ];
  for (const candidate of candidates) {
    if ((await existsFile(candidate)) && (await canRunCommand(candidate, ['--version']))) {
      return candidate;
    }
  }
  return null;
};

const resolveSystemClaudeCliPath = async (): Promise<string | null> => {
  try {
    const result = await runCommandCapture(
      process.platform === 'win32' ? 'where' : 'which',
      ['claude'],
      { cwd: app.getPath('userData'), timeoutMs: 10_000 },
    );
    if (result.code !== 0) {
      return null;
    }
    const candidate = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (!candidate) {
      return null;
    }
    return await canRunCommand(candidate, ['--version']) ? candidate : null;
  } catch {
    return null;
  }
};

const resolveClaudeCli = async (): Promise<{ path: string; source: 'managed' | 'system' } | null> => {
  const managed = await resolveManagedClaudeCliPath(getClaudeRoot());
  if (managed) {
    return { path: managed, source: 'managed' };
  }
  const system = await resolveSystemClaudeCliPath();
  return system ? { path: system, source: 'system' } : null;
};

const getInstalledClaudeCliVersion = async (baseDir: string): Promise<string | null> => {
  const packageJsonPath = path.join(baseDir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
};

const ensureClaudeCliInstalled = async (): Promise<string> => {
  const existing = await resolveManagedClaudeCliPath(getClaudeRoot());
  const installedVersion = existing ? await getInstalledClaudeCliVersion(getClaudeRoot()) : null;
  if (existing && installedVersion === CLAUDE_CODE_VERSION) {
    return existing;
  }
  const claudeRoot = getClaudeRoot();
  await fs.mkdir(claudeRoot, { recursive: true });
  const packageJsonPath = path.join(claudeRoot, 'package.json');
  if (!(await existsFile(packageJsonPath))) {
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify({
        name: 'forger-claude-code-runtime',
        private: true,
        description: 'Forger-managed Claude Code runtime',
      }, null, 2),
      'utf8',
    );
  }
  const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
  if (!nodeRuntime.npm) {
    throw new Error('runtime_npm_executable_not_found');
  }
  await runCommand(
    nodeRuntime.npm,
    ['install', '--no-audit', '--no-fund', `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`],
    {
      cwd: claudeRoot,
      env: {
        PATH: [...getRuntimePathEntries(nodeRuntime), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
      },
      log: {
        phase: 'claude_auth',
        label: 'install claude code cli',
      },
    },
  );
  const installed = await resolveManagedClaudeCliPath(claudeRoot);
  if (!installed) {
    throw new Error('claude_cli_install_failed');
  }
  return installed;
};

const resolveAppDbPath = async (appId: string): Promise<string | null> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return null;
  }
  const backendDir = path.join(record.installDir, 'backend');
  const found = await findSqliteFile(backendDir);
  if (found) {
    return found;
  }
  // Fallback: search one level deeper (e.g. backend/data/)
  try {
    const entries = await fs.readdir(backendDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = await findSqliteFile(path.join(backendDir, entry.name));
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const getCloudIdentityStore = (): CloudIdentityStore => {
  if (!cloudIdentityStore) {
    cloudIdentityStore = new CloudIdentityStore(getCloudIdentityPath());
  }
  return cloudIdentityStore;
};

const getSocialMessageStore = (): SocialMessageStore => {
  if (!socialMessageStore) {
    socialMessageStore = new SocialMessageStore({
      BetterSqlite3,
      filePath: getSocialMessagesPath(),
      accountStorageKey: () => forgerAccount.user?.id ? `user-${forgerAccount.user.id}` : undefined,
      currentUserId: () => forgerAccount.user?.id,
    });
  }
  return socialMessageStore;
};

const decryptCloudMessage = async (message: CloudMessage): Promise<CloudMessage> => {
  const envelopes = message.envelopes.filter((entry) => Boolean(entry.ciphertext));
  if (envelopes.length === 0) {
    return message;
  }
  const identity = await getCloudIdentityStore().getPublicRegistration();
  const preferred = envelopes.find((entry) => entry.keyFingerprint && entry.keyFingerprint === identity.keyFingerprint);
  const candidates = preferred ? [preferred, ...envelopes.filter((entry) => entry !== preferred)] : envelopes;
  for (const envelope of candidates) {
    try {
      const payload = JSON.parse(envelope.ciphertext) as EncryptedCloudText;
      const plaintext = await getCloudIdentityStore().decrypt(payload);
      return { ...message, plaintext };
    } catch {
      // Try the next envelope; messages may contain envelopes for other devices.
    }
  }
  return message;
};

const decryptCloudMessages = async (messages: CloudMessage[]): Promise<CloudMessage[]> =>
  Promise.all(messages.map((message) => decryptCloudMessage(message)));

const wait = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

const currentUserPayload = (): CloudFriendUser => ({
  id: forgerAccount.user?.id ?? 0,
  username: forgerAccount.user?.username ?? 'me',
  firstName: forgerAccount.user?.firstName,
  lastName: forgerAccount.user?.lastName,
});

const cloudMessageFromDelivery = async (delivery: CloudMessageDelivery): Promise<CloudMessage> => {
  let plaintext: string | undefined;
  try {
    const payload = JSON.parse(delivery.ciphertext) as EncryptedCloudText;
    plaintext = await getCloudIdentityStore().decrypt(payload);
  } catch {
    plaintext = undefined;
  }
  const base = {
    sender: delivery.sender,
    recipient: delivery.recipient,
    deliveryMode: delivery.deliveryMode,
    source: delivery.source,
    sourceAppId: delivery.sourceAppId,
    sourceAppName: delivery.sourceAppName,
    status: 'stored' as const,
    clientMessageId: delivery.clientMessageId,
    metadata: delivery.metadata,
    envelopes: [{
      id: delivery.id,
      cloudDeviceId: delivery.targetCloudDeviceId,
      deviceUid: delivery.deviceUid,
      keyFingerprint: delivery.keyFingerprint,
      ciphertext: delivery.ciphertext,
    }],
    plaintext,
    createdAt: delivery.createdAt,
    updatedAt: delivery.createdAt,
  };
  if (delivery.messageType === 'CloudAppShareMessage' && delivery.appShare) {
    return { ...base, type: 'CloudAppShareMessage', appShare: delivery.appShare };
  }
  return { ...base, type: 'CloudTextMessage' };
};

const processPendingCloudMessageDeliveries = async (): Promise<StoredSocialMessage[]> => {
  if (!forgerBackendClient || !cloudDeviceManager) {
    return [];
  }
  const currentDevice = (await cloudDeviceManager.getState()).currentDevice;
  if (!currentDevice?.id) {
    return [];
  }
  const deliveries = await forgerBackendClient.listCloudMessageDeliveries(currentDevice.id);
  const stored: StoredSocialMessage[] = [];
  const ackIds: number[] = [];
  for (const delivery of deliveries) {
    const message = await cloudMessageFromDelivery(delivery);
    stored.push(await getSocialMessageStore().upsertMessage(message));
    ackIds.push(delivery.id);
  }
  if (ackIds.length > 0) {
    await forgerBackendClient.ackCloudMessageDeliveries(currentDevice.id, ackIds);
  }
  return stored;
};

const listLocalCloudMessages = async (friendUserId: number): Promise<CloudMessage[]> => {
  if (forgerBackendClient) {
    try {
      const legacy = await decryptCloudMessages(await forgerBackendClient.listCloudMessages(friendUserId));
      for (const message of legacy) {
        await getSocialMessageStore().upsertMessage(message);
      }
    } catch {
      // Local history remains usable while legacy import is unavailable.
    }
  }
  await processPendingCloudMessageDeliveries().catch(() => []);
  return await getSocialMessageStore().listMessages(friendUserId);
};

const buildEncryptedEnvelopes = async (
  friend: { devices?: Array<{ id: number; deviceUid: string; publicKey?: string; keyFingerprint?: string }> },
  text: string,
): Promise<CloudMessageEnvelope[]> => {
  const devices = friend.devices?.filter((device) => device.publicKey) ?? [];
  if (devices.length === 0) {
    throw Object.assign(
      new Error('No pudimos enviar el mensaje porque este contacto todavia no tiene una clave cloud activa. Pidele que abra Forger Desktop con su cuenta y vuelve a intentarlo.'),
      { technicalCode: 'recipient_cloud_key_missing' },
    );
  }
  const recipientEnvelopes = devices.map((device) => ({
    recipientUserId: undefined,
    cloudDeviceId: device.id,
    deviceUid: device.deviceUid,
    keyFingerprint: device.keyFingerprint,
    ciphertext: JSON.stringify(getCloudIdentityStore().encryptFor(device.publicKey as string, text, device.keyFingerprint)),
  }));
  const currentDevice = (await cloudDeviceManager?.getState())?.currentDevice;
  const senderEnvelope = currentDevice?.publicKey && forgerAccount.user?.id
    ? [{
        recipientUserId: forgerAccount.user.id,
        cloudDeviceId: currentDevice.id,
        deviceUid: currentDevice.deviceUid,
        keyFingerprint: currentDevice.keyFingerprint,
        ciphertext: JSON.stringify(getCloudIdentityStore().encryptFor(currentDevice.publicKey, text, currentDevice.keyFingerprint)),
      }]
    : [];
  return [...recipientEnvelopes, ...senderEnvelope];
};

const buildEncryptedDeliveries = async (
  recipient: CloudFriendUser,
  text: string,
): Promise<Array<{ targetUserId: number; cloudDeviceId: number; deviceUid?: string; keyFingerprint?: string; ciphertext: string }>> => {
  const currentUserId = forgerAccount.user?.id;
  if (!currentUserId) {
    throw new Error('forger_account_missing');
  }
  const ownDevices = forgerBackendClient ? await forgerBackendClient.listDevices() : [];
  const devices = [
    ...(recipient.devices ?? []).map((device) => ({ ...device, targetUserId: recipient.id })),
    ...ownDevices.map((device) => ({ ...device, targetUserId: currentUserId })),
  ].filter((device) => device.publicKey);
  const uniqueDevices = Array.from(new Map(devices.map((device) => [device.id, device])).values());
  if (uniqueDevices.length === 0) {
    throw Object.assign(
      new Error('No pudimos enviar el mensaje porque no hay dispositivos con clave cloud activa.'),
      { technicalCode: 'cloud_delivery_key_missing' },
    );
  }
  if (uniqueDevices.length > 20) {
    throw Object.assign(
      new Error('No pudimos enviar el mensaje porque hay demasiados dispositivos asociados a esta conversación.'),
      { technicalCode: 'cloud_delivery_too_many_devices' },
    );
  }
  return uniqueDevices.map((device) => ({
    targetUserId: device.targetUserId,
    cloudDeviceId: device.id,
    deviceUid: device.deviceUid,
    keyFingerprint: device.keyFingerprint,
    ciphertext: JSON.stringify(getCloudIdentityStore().encryptFor(device.publicKey as string, text, device.keyFingerprint)),
  }));
};

const sendEncryptedCloudMessage = async (input: CloudSendMessageInput): Promise<CloudMessage> => {
  if (!forgerBackendClient) {
    throw new Error('backend_client_missing');
  }
  const normalizedUsername = input.recipientUsername?.replace(/^@/, '');
  const recipientUsername = normalizedUsername
    ?? (await forgerBackendClient.listFriends()).find((entry) => entry.friend.id === input.recipientUserId)?.friend.username;
  const friend = recipientUsername
    ? (await forgerBackendClient.searchFriends(recipientUsername)).find((entry) =>
      input.recipientUserId ? entry.id === input.recipientUserId : entry.username === recipientUsername)
    : undefined;
  if (!friend) {
    throw new Error('recipient_not_found');
  }
  const clientMessageId = input.clientMessageId ?? `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const localMessage: CloudMessage = {
    type: 'CloudTextMessage',
    sender: currentUserPayload(),
    recipient: friend,
    deliveryMode: input.delivery ?? 'persistent',
    source: input.source ?? 'user',
    sourceAppId: input.sourceAppId,
    sourceAppName: input.sourceAppName,
    status: 'stored',
    clientMessageId,
    metadata: {},
    envelopes: [],
    plaintext: input.text,
    createdAt: new Date().toISOString(),
  };
  await getSocialMessageStore().upsertMessage(localMessage, 'pending');
  try {
    const deliveries = await forgerBackendClient.sendCloudMessageDeliveries({
      ...input,
      recipientUserId: input.recipientUserId ?? friend.id,
      deliveries: await buildEncryptedDeliveries(friend, input.text),
      clientMessageId,
    });
    await getSocialMessageStore().markState(clientMessageId, 'sent');
    const currentDeviceId = (await cloudDeviceManager?.getState())?.currentDevice?.id;
    const currentDeviceDeliveryIds = deliveries
      .filter((delivery) => currentDeviceId && delivery.targetCloudDeviceId === currentDeviceId)
      .map((delivery) => delivery.id);
    if (currentDeviceId && currentDeviceDeliveryIds.length > 0) {
      await forgerBackendClient.ackCloudMessageDeliveries(currentDeviceId, currentDeviceDeliveryIds);
    }
    return { ...localMessage, localState: 'sent' };
  } catch (error) {
    await getSocialMessageStore().markState(clientMessageId, 'failed').catch(() => undefined);
    throw error;
  }
};

const sendEncryptedCloudAppShareMessage = async (input: CloudSendAppShareInput): Promise<CloudMessage> => {
  if (!forgerBackendClient) {
    throw new Error('backend_client_missing');
  }
  const normalizedUsername = input.recipientUsername?.replace(/^@/, '');
  const recipientUsername = normalizedUsername
    ?? (await forgerBackendClient.listFriends()).find((entry) => entry.friend.id === input.recipientUserId)?.friend.username;
  const friend = recipientUsername
    ? (await forgerBackendClient.searchFriends(recipientUsername)).find((entry) =>
      input.recipientUserId ? entry.id === input.recipientUserId : entry.username === recipientUsername)
    : undefined;
  if (!friend) {
    throw new Error('recipient_not_found');
  }
  const clientMessageId = input.clientMessageId ?? `${Date.now()}-${randomBytes(8).toString('hex')}`;
  const deliveries = await forgerBackendClient.sendCloudAppShareDeliveries({
    ...input,
    recipientUserId: input.recipientUserId ?? friend.id,
    deliveries: await buildEncryptedDeliveries(friend, 'app_share'),
    clientMessageId,
  });
  const currentDeviceId = (await cloudDeviceManager?.getState())?.currentDevice?.id;
  const currentDelivery = deliveries.find((delivery) => currentDeviceId && delivery.targetCloudDeviceId === currentDeviceId)
    ?? deliveries.find((delivery) => delivery.appShare);
  if (!currentDelivery) {
    throw new Error('cloud_app_share_delivery_missing');
  }
  const message = await cloudMessageFromDelivery(currentDelivery);
  await getSocialMessageStore().upsertMessage(message, 'sent');
  if (currentDeviceId && currentDelivery.targetCloudDeviceId === currentDeviceId) {
    await forgerBackendClient.ackCloudMessageDeliveries(currentDeviceId, [currentDelivery.id]);
  }
  return { ...message, localState: 'sent' };
};

const isCloudSocialEvent = (event: unknown): event is CloudSocialEvent => {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const type = (event as { type?: unknown }).type;
  return type === 'friendship_changed' || type === 'cloud_message' || type === 'ephemeral_cloud_message'
    || type === 'cloud_message_delivery';
};

const prepareCloudSocialEvent = async (event: unknown): Promise<CloudSocialEvent | null> => {
  if (!isCloudSocialEvent(event)) {
    return null;
  }
  if (event.type === 'friendship_changed') {
    const friendship = forgerBackendClient?.normalizeFriendshipPayload(event.friendship);
    return friendship ? { type: event.type, friendship } : null;
  }
  if (event.type === 'cloud_message' || event.type === 'ephemeral_cloud_message') {
    const message = forgerBackendClient?.normalizeCloudMessagePayload(event.message);
    if (!message) return null;
    const decrypted = await decryptCloudMessage(message);
    await getSocialMessageStore().upsertMessage(decrypted);
    return { type: event.type, message: decrypted };
  }
  if (event.type === 'cloud_message_delivery') {
    const delivery = forgerBackendClient?.normalizeCloudMessageDeliveryPayload(event.delivery);
    if (!delivery) return null;
    const message = await cloudMessageFromDelivery(delivery);
    const stored = await getSocialMessageStore().upsertMessage(message);
    const currentDeviceId = (await cloudDeviceManager?.getState())?.currentDevice?.id;
    if (currentDeviceId) {
      await forgerBackendClient?.ackCloudMessageDeliveries(currentDeviceId, [delivery.id]).catch(() => undefined);
    }
    return { type: 'cloud_message', message: stored };
  }
  return null;
};

const isUnreadIncomingCloudMessage = (event: CloudSocialEvent): boolean => {
  if (event.type !== 'cloud_message' && event.type !== 'ephemeral_cloud_message') {
    return false;
  }
  const currentUserId = forgerAccount.user?.id;
  const message = event.message;
  if (!currentUserId || message.sender.id === currentUserId || message.recipient.id !== currentUserId) {
    return false;
  }

  const chatWindow = friendChatWindows.get(message.sender.id);
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isFocused()) {
    return false;
  }
  return true;
};

const showIncomingCloudMessageNotification = (event: CloudSocialEvent): void => {
  if (!isUnreadIncomingCloudMessage(event)) {
    return;
  }
  if (event.type !== 'cloud_message' && event.type !== 'ephemeral_cloud_message') {
    return;
  }
  if (!Notification.isSupported()) {
    return;
  }

  const message = event.message;
  const senderName = message.sender.firstName?.trim() || `@${message.sender.username}`;
  const body = message.plaintext?.trim() || 'Nuevo mensaje en Social';
  const notification = new Notification({
    title: senderName,
    body: body.length > 120 ? `${body.slice(0, 117)}...` : body,
  });
  notification.on('click', () => {
    void openOrFocusFriendChatWindowForFriend(message.sender);
  });
  notification.show();
};

const forwardCloudSocialEvent = (event: CloudSocialEvent): void => {
  mainWindow?.webContents.send(IPC_CHANNELS.cloudFriendshipEvent, event);
  for (const window of friendChatWindows.values()) {
    window.webContents.send(IPC_CHANNELS.cloudFriendshipEvent, event);
  }
  for (const window of appWindows.values()) {
    window.webContents.send(IPC_CHANNELS.appMessagesEvent, event);
  }
};

const handleCloudSocialEvent = async (event: unknown): Promise<void> => {
  if (event && typeof event === 'object' && (event as { type?: unknown }).type === 'heartbeat_ack') {
    const storedMessages = await processPendingCloudMessageDeliveries().catch(() => []);
    for (const message of storedMessages) {
      const cloudEvent: CloudSocialEvent = { type: 'cloud_message', message };
      const eventForRenderer = { ...cloudEvent, unread: isUnreadIncomingCloudMessage(cloudEvent) };
      showIncomingCloudMessageNotification(eventForRenderer);
      forwardCloudSocialEvent(eventForRenderer);
    }
    return;
  }
  const prepared = await prepareCloudSocialEvent(event);
  if (!prepared) {
    return;
  }
  const eventForRenderer = prepared.type === 'cloud_message' || prepared.type === 'ephemeral_cloud_message'
    ? { ...prepared, unread: isUnreadIncomingCloudMessage(prepared) }
    : prepared;
  showIncomingCloudMessageNotification(eventForRenderer);
  forwardCloudSocialEvent(eventForRenderer);
};

  return { findSqliteFile, resolveManagedClaudeCliPath, resolveSystemClaudeCliPath, resolveClaudeCli, ensureClaudeCliInstalled, resolveAppDbPath, getCloudIdentityStore, getSocialMessageStore, decryptCloudMessage, decryptCloudMessages, wait, buildEncryptedEnvelopes, buildEncryptedDeliveries, listLocalCloudMessages, processPendingCloudMessageDeliveries, sendEncryptedCloudMessage, sendEncryptedCloudAppShareMessage, isCloudSocialEvent, prepareCloudSocialEvent, isUnreadIncomingCloudMessage, showIncomingCloudMessageNotification, forwardCloudSocialEvent, handleCloudSocialEvent };
};
