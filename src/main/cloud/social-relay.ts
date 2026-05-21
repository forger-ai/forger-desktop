import { Notification } from 'electron';
import { randomBytes } from 'node:crypto';
import type fs from 'node:fs/promises';
import type path from 'node:path';

import { IPC_CHANNELS } from '../../shared/ipc';
import type { CloudRelayRequest, CloudRelayResponse } from '../cloud-device-manager';
import type { CloudDeviceManager } from '../cloud-device-manager';
import type { CloudIdentityStore, EncryptedCloudText } from '../cloud-identity-store';
import type { ForgerBackendClient } from '../forger-backend-client';
import type { AppRegistry, RuntimeBinarySet, RunningAppProcess } from '../core/main-process-types';
import type {
  AppAgent,
  AppCodexTaskStartInput,
  CloudFriendUser,
  CloudMessage,
  CloudMessageEnvelope,
  CloudSendMessageInput,
  CloudSocialEvent,
  FriendChatWindowOpenResult,
  OpenAppResult,
  RuntimeStatus,
} from '../../shared/types';
import type { StoredForgerAccount } from '../forger-account-store';

interface CloudSocialRelayDeps {
  CLAUDE_CODE_VERSION: string;
  DEFAULT_NODE_VERSION: string;
  CloudIdentityStore: typeof CloudIdentityStore;
  app: Electron.App;
  appAgentTaskManager: {
    start: (appId: string, input: AppCodexTaskStartInput) => Promise<unknown>;
    get: (appId: string, runId: string) => unknown;
    cancel: (appId: string, runId: string) => unknown;
  } | null;
  appWindows: Map<string, Electron.BrowserWindow>;
  canRunCommand: (command: string, args: string[]) => Promise<boolean>;
  cloudDeviceManager: CloudDeviceManager | null;
  cloudIdentityStore: CloudIdentityStore | null;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  existsFile: (filePath: string) => Promise<boolean>;
  fetchBodyFromBuffer: (body: Buffer) => ArrayBuffer;
  forgerAccount: StoredForgerAccount;
  forgerBackendClient: ForgerBackendClient | null;
  friendChatWindows: Map<number, Electron.BrowserWindow>;
  fs: typeof fs;
  getClaudeRoot: () => string;
  getCloudIdentityPath: () => string;
  getCodexAuthStatus: () => Promise<{ authenticated: boolean }>;
  getRuntimePathEntries: (runtime: RuntimeBinarySet) => string[];
  getRuntimeStatus: (appId: string) => RuntimeStatus;
  mainWindow: Electron.BrowserWindow | null;
  openInstalledAppUnlocked: (appId: string, locale?: string, options?: { openWindow?: boolean }) => Promise<OpenAppResult>;
  openOrFocusFriendChatWindowForFriend: (friend: CloudFriendUser) => Promise<FriendChatWindowOpenResult>;
  path: typeof path;
  registry: AppRegistry;
  resolveInstalledAgents: (appId: string) => Promise<AppAgent[]>;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  runCommandCapture: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<{ code?: number | null; stdout: string; stderr: string }>;
  runningApps: Map<string, RunningAppProcess>;
}

export const createCloudSocialRelayController = (deps: CloudSocialRelayDeps) => {
  let { cloudIdentityStore } = deps;
  const { CLAUDE_CODE_VERSION, DEFAULT_NODE_VERSION, CloudIdentityStore, app, appAgentTaskManager, appWindows, canRunCommand, cloudDeviceManager, ensureRuntimeInstalled, existsFile, fetchBodyFromBuffer, forgerAccount, forgerBackendClient, friendChatWindows, fs, getClaudeRoot, getCloudIdentityPath, getCodexAuthStatus, getRuntimePathEntries, mainWindow, openInstalledAppUnlocked, openOrFocusFriendChatWindowForFriend, path, registry, resolveInstalledAgents, runCommand, runCommandCapture, runningApps } = deps;
const handleCloudRelayRequest = async (request: CloudRelayRequest): Promise<CloudRelayResponse> => {
  try {
    const open = await openInstalledAppUnlocked(request.app_id, undefined, { openWindow: false });
    if (!open.success) {
      return relayError(request.request_id, 424, open.technicalCode ?? 'app_open_failed');
    }
    const running = runningApps.get(request.app_id);
    if (!running) {
      return relayError(request.request_id, 424, 'app_not_running');
    }
    const pathValue = request.path?.startsWith('/') ? request.path : `/${request.path || ''}`;
    if (pathValue.includes('..') || pathValue.toLowerCase().startsWith('/__forger_internal')) {
      if (pathValue.toLowerCase().startsWith('/__forger_internal/forger_app/')) {
        return await handleCloudForgerAppRequest(request, pathValue);
      }
      return relayError(request.request_id, 403, 'path_blocked');
    }
    const target = new URL(pathValue, running.frontendUrl);
    const response = await fetch(target, {
      method: request.method,
      headers: request.headers ?? {},
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : fetchBodyFromBuffer(Buffer.from(request.body ?? [])),
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (['content-type', 'cache-control', 'etag', 'last-modified'].includes(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    return {
      request_id: request.request_id,
      status: response.status,
      headers,
      body: [...Buffer.from(await response.arrayBuffer())],
    };
  } catch (error) {
    return relayError(request.request_id, 502, error instanceof Error ? error.message : 'relay_failed');
  }
};

const handleCloudForgerAppRequest = async (
  request: CloudRelayRequest,
  pathValue: string,
): Promise<CloudRelayResponse> => {
  try {
    if (request.method !== 'POST') {
      return relayJson(request.request_id, 405, { error: 'method_not_allowed' });
    }

    const body = parseRelayJsonBody(request.body);
    const action = pathValue.replace(/^\/__forger_internal\/forger_app\/?/i, '').replace(/\/+$/, '');
    const json = async (value: unknown, status = 200): Promise<CloudRelayResponse> =>
      relayJson(request.request_id, status, value);

    if (action === 'ai-subscription-status') {
      const status = await getCodexAuthStatus();
      return json({ connected: status.authenticated });
    }

    if (action === 'context') {
      return json({ agents: await resolveInstalledAgents(request.app_id) });
    }

    if (action === 'codex-task/start') {
      if (!appAgentTaskManager) {
        return json({ error: 'app_codex_task_manager_unavailable' }, 503);
      }
      const task = await appAgentTaskManager.start(request.app_id, body as unknown as AppCodexTaskStartInput);
      return json(task);
    }

    if (action === 'codex-task/get') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      return json(appAgentTaskManager?.get(request.app_id, runId) ?? null);
    }

    if (action === 'codex-task/cancel') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      return json(appAgentTaskManager?.cancel(request.app_id, runId) ?? { success: false });
    }

    return json({ error: 'unknown_forger_app_action' }, 404);
  } catch (error) {
    return relayJson(request.request_id, 500, {
      error: error instanceof Error ? error.message : 'forger_app_request_failed',
    });
  }
};

const parseRelayJsonBody = (body?: number[]): Record<string, unknown> => {
  if (!body || body.length === 0) {
    return {};
  }
  const raw = Buffer.from(body).toString('utf8');
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
};

const relayJson = (requestId: string, status: number, value: unknown): CloudRelayResponse => ({
  request_id: requestId,
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: [...Buffer.from(JSON.stringify(value))],
});

const relayError = (requestId: string, status: number, message: string): CloudRelayResponse => ({
  request_id: requestId,
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: [...Buffer.from(message)],
});

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

const ensureClaudeCliInstalled = async (): Promise<string> => {
  const existing = await resolveManagedClaudeCliPath(getClaudeRoot());
  if (existing) {
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

const decryptCloudMessage = async (message: CloudMessage): Promise<CloudMessage> => {
  const envelope = message.envelopes.find((entry) => Boolean(entry.ciphertext));
  if (!envelope) {
    return message;
  }
  try {
    const payload = JSON.parse(envelope.ciphertext) as EncryptedCloudText;
    const plaintext = await getCloudIdentityStore().decrypt(payload);
    return { ...message, plaintext };
  } catch {
    return message;
  }
};

const decryptCloudMessages = async (messages: CloudMessage[]): Promise<CloudMessage[]> =>
  Promise.all(messages.map((message) => decryptCloudMessage(message)));

const wait = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  const message = await forgerBackendClient.sendCloudMessage({
    ...input,
    recipientUserId: input.recipientUserId ?? friend.id,
    envelopes: await buildEncryptedEnvelopes(friend, input.text),
    clientMessageId: `${Date.now()}-${randomBytes(8).toString('hex')}`,
  });
  return { ...(await decryptCloudMessage(message)), plaintext: input.text };
};

const isCloudSocialEvent = (event: unknown): event is CloudSocialEvent => {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const type = (event as { type?: unknown }).type;
  return type === 'friendship_changed' || type === 'cloud_message' || type === 'ephemeral_cloud_message';
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
    return message ? { type: event.type, message: await decryptCloudMessage(message) } : null;
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

  return { handleCloudRelayRequest, handleCloudForgerAppRequest, parseRelayJsonBody, relayJson, relayError, findSqliteFile, resolveManagedClaudeCliPath, resolveSystemClaudeCliPath, resolveClaudeCli, ensureClaudeCliInstalled, resolveAppDbPath, getCloudIdentityStore, decryptCloudMessage, decryptCloudMessages, wait, buildEncryptedEnvelopes, sendEncryptedCloudMessage, isCloudSocialEvent, prepareCloudSocialEvent, isUnreadIncomingCloudMessage, showIncomingCloudMessageNotification, forwardCloudSocialEvent, handleCloudSocialEvent };
};
