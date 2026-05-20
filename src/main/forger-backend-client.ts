import type {
  AppCategory,
  AppRatingSummary,
  AppStatus,
  CatalogApp,
  AppBackupSummary,
  RemoteBackupType,
  RemoteBackupSource,
  ForgerAccountLoginInput,
  ForgerAccountProfileInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  DesktopErrorReportPreview,
  CloudDeviceSummary,
  CloudFriendship,
  CloudFriendUser,
  CloudMessage,
  CloudMessageEnvelope,
  CloudSendMessageInput,
  CloudAppMessagePermissionDecision,
  RemoteAppBackupSummary,
  RemoteBackupsState,
  RemoteBackupsUsage,
  SubmitProductFeedbackInput,
  SubmitAppRatingInput,
  SubmitUsageEventInput,
  SubmitUsageEventResult,
} from '../shared/types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeErrorReportDiagnostic } from '../shared/error-diagnostics';
import { normalizeForgerAccountUser, type StoredForgerAccount } from './forger-account-store';
import {
  mapCatalogItem,
  normalizeRating,
  type CatalogResponseItem,
  type PublicCatalogResponseItem,
} from './forger-backend/catalog-normalizers';
import {
  normalizeCloudDevice,
  normalizeCloudMessage,
  normalizeCloudUser,
  normalizeFriendship,
} from './forger-backend/cloud-normalizers';

interface ClientOptions {
  backendBaseUrl: string;
  localCatalogJsonUrl: () => string | undefined;
  token: () => string | undefined;
  mapBackendCategory: (backendCategory: string) => AppCategory;
  toCatalogStatus: (slug: string) => AppStatus;
  getUserMessage: (slug: string) => string | undefined;
  platform?: () => string;
  desktopVersion?: () => string;
  reportingLogPath?: () => string;
}

interface DownloadPayload {
  download_url: string;
  version: {
    version: string;
    checksum_sha256?: string | null;
  };
}

const usernameCooldownMessage = (availableAt?: string): string => {
  if (!availableAt) {
    return 'Podras cambiar tu username cuando se cumplan 30 dias desde el ultimo cambio.';
  }

  const date = new Date(availableAt);
  if (Number.isNaN(date.getTime())) {
    return 'Podras cambiar tu username cuando se cumplan 30 dias desde el ultimo cambio.';
  }

  return `Podras cambiar tu username desde el ${date.toLocaleDateString('es-CL', { dateStyle: 'medium' })}.`;
};

interface RemoteBackupPayload {
  id: number | string;
  app_id: string;
  app_name: string;
  app_version?: string | null;
  backup_type: RemoteBackupType;
  source: RemoteBackupSource;
  metadata?: Record<string, unknown> | null;
  file_count?: number | string | null;
  total_bytes?: number | string | null;
  checksum_sha256?: string | null;
  signature?: string | null;
  signature_key_fingerprint?: string | null;
  signature_algorithm?: string | null;
  created_at?: string;
  updated_at?: string;
  download_url?: string;
}

interface RemoteBackupsResponse {
  backups?: unknown[];
  usage?: {
    used_bytes?: number | string | null;
    limit_bytes?: number | string | null;
    backup_count?: number | string | null;
    backup_count_limit?: number | string | null;
  } | null;
}

interface GmailOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GoogleLoginSessionInput {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

const backendError = (message: string, technicalCode: string): Error & { technicalCode: string } =>
  Object.assign(new Error(message), { technicalCode });

const normalizeRuntimePlatform = (platform: NodeJS.Platform, arch: string): string => {
  const normalizedArch = arch === 'x64' || arch === 'arm64' ? arch : arch.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${platform}_${normalizedArch}`;
};

const safeValidationKeys = (payload: unknown): Record<string, string[]> | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const errors = (payload as { errors?: unknown }).errors;
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) {
    return undefined;
  }
  const entries = Object.entries(errors)
    .filter(([key]) => /^[a-zA-Z0-9_.-]+$/.test(key))
    .map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((entry) => String(entry)).slice(0, 5)
        : [String(value)],
    ] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const responseRequestId = (response: Response): string | undefined =>
  response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? undefined;

const defaultReportingLogPath = (): string => {
  const appDataName = process.env.VITE_DEV_SERVER_URL ? 'forger-desktop-dev' : 'forger-desktop';
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appDataName, 'logs', 'reporting.log');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), appDataName, 'logs', 'reporting.log');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), appDataName, 'logs', 'reporting.log');
};

const emptyRemoteBackupsState = (): RemoteBackupsState => ({
  backups: [],
  usage: {
    usedBytes: 0,
    limitBytes: 0,
    backupCount: 0,
    backupCountLimit: 0,
  },
});

export class ForgerBackendClient {
  constructor(private readonly options: ClientOptions) {}

  private desktopPlatform(): string {
    return this.options.platform?.() ?? normalizeRuntimePlatform(process.platform, process.arch);
  }

  private desktopVersion(): string | undefined {
    return this.options.desktopVersion?.();
  }

  private async appendReportingLog(event: string, details: Record<string, unknown>): Promise<void> {
    const logPath = this.options.reportingLogPath?.() ?? defaultReportingLogPath();
    if (!logPath) {
      return;
    }
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    };
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // Reporting logs must never break user-facing flows.
    }
  }

  async listCatalogApps(): Promise<CatalogApp[]> {
    let backendApps: CatalogApp[] = [];
    try {
      const response = await fetch(`${this.options.backendBaseUrl}/api/v1/catalog/apps`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (response.ok) {
        const payload = await this.readJson<CatalogResponseItem[]>(response);
        if (Array.isArray(payload)) {
          backendApps = payload.map((appEntry) => mapCatalogItem(appEntry, false, this.options));
        }
      }
    } catch {
      // Local dev catalog can still be used below.
    }

    const localApps = await this.listLocalCatalogApps().catch(() => []);
    if (backendApps.length === 0) {
      return localApps;
    }

    return this.mergeCatalogApps(backendApps, localApps);
  }

  private async listLocalCatalogApps(): Promise<CatalogApp[]> {
    const localCatalogJsonUrl = this.options.localCatalogJsonUrl();
    if (!localCatalogJsonUrl) {
      return [];
    }

    const publicResponse = await fetch(localCatalogJsonUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!publicResponse.ok) {
      return [];
    }

    const publicPayload = await this.readJson<PublicCatalogResponseItem[]>(publicResponse);
    return Array.isArray(publicPayload) ? publicPayload.map((appEntry) => mapCatalogItem(appEntry, true, this.options)) : [];
  }

  private mergeCatalogApps(primaryApps: CatalogApp[], secondaryApps: CatalogApp[]): CatalogApp[] {
    const entries = new Map<string, CatalogApp>();
    for (const app of primaryApps) {
      entries.set(app.id, app);
    }
    for (const app of secondaryApps) {
      if (!entries.has(app.id)) {
        entries.set(app.id, app);
      }
    }
    return Array.from(entries.values());
  }

  async registerAccount(
    input: ForgerAccountRegisterInput,
  ): Promise<ForgerAccountSession & { success: boolean; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/users`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        first_name: input.firstName,
        last_name: input.lastName,
        username: input.username,
        email: input.email,
        password: input.password,
        password_confirmation: input.password,
        country: input.country,
        age: input.age,
        gender: input.gender,
        locale: input.locale,
      }),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);

    if (!response.ok) {
      return { success: false, authenticated: false, userMessage: 'No pudimos crear la cuenta.', technicalCode: `register_failed_${response.status}` };
    }

    return {
      ...this.parseAccount(payload),
      success: true,
      confirmationRequired: true,
      userMessage: 'Cuenta creada. Revisa tu correo para confirmar tu cuenta.',
    };
  }

  async loginAccount(
    input: ForgerAccountLoginInput,
  ): Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/session`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        locale: input.locale,
      }),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);
    const token = payload && typeof payload.token === 'string' ? payload.token : undefined;

    if (!response.ok || !token) {
      return {
        success: false,
        authenticated: false,
        confirmationRequired: response.status === 403,
        userMessage: response.status === 403 ? 'Confirma tu correo antes de iniciar sesion.' : 'No pudimos iniciar sesion.',
        technicalCode: `login_failed_${response.status}`,
      };
    }

    return { ...this.parseAccount(payload, token), success: true, userMessage: 'Sesion iniciada.' };
  }

  async logoutAccount(): Promise<void> {
    if (!this.options.token()) {
      return;
    }

    await fetch(`${this.options.backendBaseUrl}/api/v1/session`, {
      method: 'DELETE',
      headers: this.buildHeaders(),
    }).catch(() => undefined);
  }

  async updateAccountProfile(
    input: ForgerAccountProfileInput,
  ): Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/profile`, {
      method: 'PATCH',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: input.username,
      }),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);

    if (!response.ok) {
      const errorCode = typeof payload?.error === 'string' ? payload.error : undefined;
      const availableAt = typeof payload?.username_change_available_at === 'string'
        ? payload.username_change_available_at
        : undefined;
      return {
        success: false,
        authenticated: Boolean(this.options.token()),
        userMessage: errorCode === 'username_change_cooldown'
          ? usernameCooldownMessage(availableAt)
          : response.status === 422
            ? 'Ese username no esta disponible o no cumple el formato.'
            : 'No pudimos actualizar tu perfil.',
        technicalCode: `profile_update_failed_${response.status}`,
      };
    }

    return { ...this.parseAccount(payload), success: true, userMessage: 'Username actualizado.' };
  }

  async getGmailOAuthClientId(): Promise<string> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/oauth/gmail/config`, {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);
    if (!response.ok) {
      throw backendError('Inicia sesion en Forger antes de conectar Gmail.', `gmail_oauth_config_failed_${response.status}`);
    }
    const clientId = typeof payload?.client_id === 'string' ? payload.client_id.trim() : '';
    if (!clientId) {
      throw backendError('Gmail no esta configurado en Forger Cloud.', 'gmail_oauth_client_missing');
    }
    return clientId;
  }

  async exchangeGmailOAuthCode(input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GmailOAuthTokenResponse> {
    return this.postGmailOAuth('/api/v1/oauth/gmail/token', {
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }

  async refreshGmailOAuthAccessToken(input: {
    clientId: string;
    refreshToken: string;
  }): Promise<GmailOAuthTokenResponse> {
    return this.postGmailOAuth('/api/v1/oauth/gmail/refresh', {
      client_id: input.clientId,
      refresh_token: input.refreshToken,
    });
  }

  async getMetaOAuthClientId(): Promise<string> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/oauth/meta/config`, {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);
    if (!response.ok) {
      throw backendError(
        'Inicia sesion en Forger antes de conectar Meta.',
        `meta_oauth_config_failed_${response.status}`,
      );
    }
    const clientId = typeof payload?.client_id === 'string' ? payload.client_id.trim() : '';
    if (!clientId) {
      throw backendError('Meta no esta configurado en Forger Cloud.', 'meta_oauth_client_missing');
    }
    return clientId;
  }

  async exchangeMetaOAuthCode(input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GmailOAuthTokenResponse> {
    return this.postMetaOAuth('/api/v1/oauth/meta/token', {
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }

  async refreshMetaOAuthAccessToken(input: {
    clientId: string;
    userToken: string;
  }): Promise<GmailOAuthTokenResponse> {
    // Meta does not expose a refresh_token. Forger Cloud exchanges the
    // current long-lived user token for a fresh long-lived token via the
    // App Secret (grant_type=fb_exchange_token) and returns the new token
    // shape that mirrors the GmailOAuthTokenResponse so downstream code can
    // be reused unchanged.
    return this.postMetaOAuth('/api/v1/oauth/meta/refresh', {
      client_id: input.clientId,
      user_token: input.userToken,
    });
  }

  async getGoogleLoginOAuthClientId(): Promise<string> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/oauth/google/config`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    const payload = await this.readJson<Record<string, unknown>>(response);
    if (!response.ok) {
      throw backendError('Google login no esta configurado en Forger Cloud.', `google_login_config_failed_${response.status}`);
    }
    const clientId = typeof payload?.client_id === 'string' ? payload.client_id.trim() : '';
    if (!clientId) {
      throw backendError('Google login no esta configurado en Forger Cloud.', 'google_login_client_missing');
    }
    return clientId;
  }

  async createGoogleLoginSession(
    input: GoogleLoginSessionInput,
  ): Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/oauth/google/session`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: input.clientId,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      }),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);
    const token = payload && typeof payload.token === 'string' ? payload.token : undefined;

    if (!response.ok || !token) {
      return {
        success: false,
        authenticated: false,
        userMessage: this.googleLoginErrorMessage(payload),
        technicalCode: `google_login_failed_${response.status}`,
      };
    }

    return { ...this.parseAccount(payload, token), success: true, userMessage: 'Sesion iniciada.' };
  }

  async registerDevice(input: {
    deviceUid: string;
    deviceSecret: string;
    name: string;
    platform: string;
    publicKey?: string;
    keyFingerprint?: string;
  }): Promise<CloudDeviceSummary & { registered: boolean }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/devices/register`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_uid: input.deviceUid,
        device_secret: input.deviceSecret,
        name: input.name,
        platform: input.platform,
        public_key: input.publicKey,
        key_fingerprint: input.keyFingerprint,
      }),
    });
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `device_register_failed_${response.status}`);
    }
    const payload = await this.readJson<Record<string, unknown>>(response);
    return normalizeCloudDevice(payload) as CloudDeviceSummary & { registered: boolean };
  }

  async listDevices(): Promise<CloudDeviceSummary[]> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/devices`, {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `devices_list_failed_${response.status}`);
    }
    const payload = await this.readJson<unknown>(response);
    if (!Array.isArray(payload)) {
      return [];
    }
    return payload.map((entry) => normalizeCloudDevice(entry)).filter((entry): entry is CloudDeviceSummary => Boolean(entry));
  }

  async createDevicePairingCode(input: { deviceId: number; codeDigest: string; expiresAt: string }): Promise<void> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/devices/${input.deviceId}/pairing_codes`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code_digest: input.codeDigest,
        expires_at: input.expiresAt,
      }),
    });
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `pairing_code_failed_${response.status}`);
    }
  }

  async listFriends(): Promise<CloudFriendship[]> {
    const payload = await this.getJson('/api/v1/me/friends', 'friends_list_failed');
    return Array.isArray(payload) ? payload.map((entry) => normalizeFriendship(entry)).filter(Boolean) as CloudFriendship[] : [];
  }

  async searchFriends(username: string): Promise<CloudFriendUser[]> {
    const query = new URLSearchParams({ username });
    const payload = await this.getJson(`/api/v1/me/friends/search?${query.toString()}`, 'friends_search_failed');
    return Array.isArray(payload) ? payload.map((entry) => normalizeCloudUser(entry)).filter(Boolean) as CloudFriendUser[] : [];
  }

  async sendFriendRequest(username: string): Promise<CloudFriendship> {
    const payload = await this.postJson('/api/v1/me/friend_requests', { username }, 'friend_request_create_failed');
    const friendship = normalizeFriendship(payload);
    if (!friendship) {
      throw backendError('No pudimos enviar la solicitud.', 'friend_request_response_invalid');
    }
    return friendship;
  }

  async acceptFriendRequest(id: number): Promise<CloudFriendship> {
    return await this.friendRequestAction(id, 'accept');
  }

  async declineFriendRequest(id: number): Promise<CloudFriendship> {
    return await this.friendRequestAction(id, 'decline');
  }

  async cancelFriendRequest(id: number): Promise<CloudFriendship> {
    return await this.friendRequestAction(id, 'cancel');
  }

  async markFriendChatRead(friendUserId: number): Promise<CloudFriendship> {
    const payload = await this.patchJson(`/api/v1/me/friends/${encodeURIComponent(String(friendUserId))}/read_receipt`, {}, 'friend_read_receipt_failed');
    const friendship = normalizeFriendship(payload);
    if (!friendship) {
      throw backendError('No pudimos actualizar la lectura del chat.', 'friend_read_receipt_response_invalid');
    }
    return friendship;
  }

  async listCloudMessages(friendUserId: number): Promise<CloudMessage[]> {
    const query = new URLSearchParams({ friend_user_id: String(friendUserId) });
    const payload = await this.getJson(`/api/v1/me/cloud_messages?${query.toString()}`, 'cloud_messages_list_failed');
    return Array.isArray(payload) ? payload.map((entry) => normalizeCloudMessage(entry)).filter(Boolean) as CloudMessage[] : [];
  }

  async sendCloudMessage(input: CloudSendMessageInput & { envelopes: CloudMessageEnvelope[]; clientMessageId?: string }): Promise<CloudMessage> {
    const payload = await this.postJson('/api/v1/me/cloud_messages', {
      recipient_username: input.recipientUsername,
      recipient_user_id: input.recipientUserId,
      delivery_mode: input.delivery ?? 'persistent',
      source: input.source ?? 'user',
      source_app_id: input.sourceAppId,
      source_app_name: input.sourceAppName,
      client_message_id: input.clientMessageId,
      envelopes: input.envelopes.map((envelope) => ({
        recipient_user_id: envelope.recipientUserId,
        cloud_device_id: envelope.cloudDeviceId,
        device_uid: envelope.deviceUid,
        key_fingerprint: envelope.keyFingerprint,
        ciphertext: envelope.ciphertext,
        metadata: envelope.metadata,
      })),
    }, 'cloud_message_send_failed');
    const message = normalizeCloudMessage(payload);
    if (!message) {
      throw backendError('No pudimos enviar el mensaje.', 'cloud_message_response_invalid');
    }
    return message;
  }

  async decideAppMessagePermission(cloudMessageId: number, decision: CloudAppMessagePermissionDecision): Promise<CloudMessage> {
    const payload = await this.patchJson('/api/v1/me/app_message_permission', {
      cloud_message_id: cloudMessageId,
      decision,
    }, 'app_message_permission_failed');
    const message = normalizeCloudMessage(payload);
    if (!message) {
      throw backendError('No pudimos actualizar el permiso.', 'app_message_permission_response_invalid');
    }
    return message;
  }

  normalizeCloudMessagePayload(value: unknown): CloudMessage | undefined {
    return normalizeCloudMessage(value);
  }

  normalizeFriendshipPayload(value: unknown): CloudFriendship | undefined {
    return normalizeFriendship(value);
  }

  private async friendRequestAction(id: number, action: 'accept' | 'decline' | 'cancel'): Promise<CloudFriendship> {
    const payload = await this.postJson(`/api/v1/me/friend_requests/${id}/${action}`, {}, `friend_request_${action}_failed`);
    const friendship = normalizeFriendship(payload);
    if (!friendship) {
      throw backendError('No pudimos actualizar la solicitud.', `friend_request_${action}_response_invalid`);
    }
    return friendship;
  }

  async submitAppRating(
    input: SubmitAppRatingInput,
  ): Promise<{ success: boolean; rating?: AppRatingSummary; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/catalog/apps/${encodeURIComponent(input.appId)}/rating`, {
      method: 'PUT',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        score: input.score,
        comment: input.comment,
        locale: input.locale,
      }),
    });
    const payload = await this.readJson<unknown>(response);

    if (!response.ok) {
      return {
        success: false,
        userMessage: response.status === 403 ? 'Confirma tu correo para publicar una review.' : 'No pudimos guardar tu review.',
        technicalCode: `rating_failed_${response.status}`,
      };
    }

    return { success: true, rating: normalizeRating(payload), userMessage: 'Review guardada.' };
  }

  async submitProductFeedback(
    input: SubmitProductFeedbackInput,
  ): Promise<{ success: boolean; userMessage?: string; technicalCode?: string; details?: Record<string, unknown> }> {
    const platform = this.desktopPlatform();
    const desktopVersion = input.desktopVersion ?? this.desktopVersion();
    const logBase = {
      operation: 'feedback.submit',
      target: input.target,
      kind: input.kind,
      appId: input.appId,
      appVersionLabel: input.appVersionLabel,
      desktopVersion,
      platform,
    };
    try {
      const response = await fetch(`${this.options.backendBaseUrl}/api/v1/feedbacks`, {
        method: 'POST',
        headers: {
          ...this.buildHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          target: input.target,
          app_id: input.appId,
          kind: input.kind,
          body: input.body,
          surface: input.surface,
          locale: input.locale,
          platform,
          desktop_version: desktopVersion,
          app_version_label: input.appVersionLabel,
        }),
      });
      const payload = await this.readJson<unknown>(response);
      const requestId = responseRequestId(response);

      if (!response.ok) {
        const technicalCode = `feedback_failed_${response.status}`;
        const validationErrors = safeValidationKeys(payload);
        await this.appendReportingLog('feedback:submit_failed', {
          ...logBase,
          success: false,
          httpStatus: response.status,
          technicalCode,
          requestId,
          validationErrors,
        });
        return {
          success: false,
          userMessage: 'No pudimos enviar el feedback.',
          technicalCode,
          details: {
            httpStatus: response.status,
            requestId,
            validationErrors,
          },
        };
      }

      await this.appendReportingLog('feedback:submit_success', {
        ...logBase,
        success: true,
        httpStatus: response.status,
        requestId,
      });
      return { success: true, userMessage: 'Feedback enviado.' };
    } catch (error) {
      const technicalCode = 'feedback_network_failed';
      await this.appendReportingLog('feedback:submit_failed', {
        ...logBase,
        success: false,
        technicalCode,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        userMessage: 'No pudimos enviar el feedback.',
        technicalCode,
        details: { reason: 'network_or_fetch_error' },
      };
    }
  }

  async submitUsageEvent(input: SubmitUsageEventInput): Promise<SubmitUsageEventResult> {
    const platform = input.platform ?? this.desktopPlatform();
    const desktopVersion = input.desktopVersion ?? this.desktopVersion();
    try {
      const response = await fetch(`${this.options.backendBaseUrl}/api/v1/usage_events`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_name: input.eventName,
          installation_identifier: input.installationIdentifier,
          surface: input.surface,
          desktop_version: desktopVersion,
          platform,
          locale: input.locale,
          occurred_at: input.occurredAt,
          string_parameters: input.stringParameters ?? {},
          int_parameters: input.intParameters ?? {},
        }),
      });
      const payload = await this.readJson<unknown>(response);
      const requestId = responseRequestId(response);

      if (!response.ok) {
        const technicalCode = `usage_event_failed_${response.status}`;
        await this.appendReportingLog('usage_event:submit_failed', {
          eventName: input.eventName,
          surface: input.surface,
          success: false,
          httpStatus: response.status,
          technicalCode,
          requestId,
          validationErrors: safeValidationKeys(payload),
        });
        return {
          success: false,
          userMessage: 'No pudimos enviar la métrica de uso.',
          technicalCode,
          details: {
            httpStatus: response.status,
            requestId,
            validationErrors: safeValidationKeys(payload),
          },
        };
      }

      return { success: true };
    } catch (error) {
      await this.appendReportingLog('usage_event:submit_failed', {
        eventName: input.eventName,
        surface: input.surface,
        success: false,
        technicalCode: 'usage_event_network_failed',
        errorName: error instanceof Error ? error.name : undefined,
      });
      return { success: false, technicalCode: 'usage_event_network_failed' };
    }
  }

  async submitDesktopErrorReport(
    input: DesktopErrorReportPreview,
  ): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> {
    const report = normalizeErrorReportDiagnostic(input);
    const logBase = {
      operation: 'desktop_error_report.submit',
      source: report.source,
      reportOperation: report.operation,
      technicalCode: report.technicalCode,
      appId: report.appId,
      appVersion: report.appVersion,
      desktopVersion: report.desktopVersion,
      platform: report.platform,
      arch: report.arch,
    };
    try {
      const response = await fetch(`${this.options.backendBaseUrl}/api/v1/desktop_error_reports`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: report.source,
          operation: report.operation,
          message: report.message,
          technical_code: report.technicalCode,
          desktop_version: report.desktopVersion,
          platform: report.platform,
          arch: report.arch,
          app_id: report.appId,
          app_version: report.appVersion,
          details: report.details ?? {},
          sensitive_details: report.sensitiveDetails ?? {},
        }),
      });
      const requestId = responseRequestId(response);

      if (!response.ok) {
        const technicalCode = `desktop_error_report_failed_${response.status}`;
        await this.appendReportingLog('desktop_error_report:submit_failed', {
          ...logBase,
          success: false,
          httpStatus: response.status,
          requestId,
          technicalCode,
        });
        return { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode };
      }

      await this.appendReportingLog('desktop_error_report:submit_success', {
        ...logBase,
        success: true,
        httpStatus: response.status,
        requestId,
      });
      return { success: true, userMessage: 'Reporte enviado. Gracias por ayudarnos a corregir Forger.' };
    } catch (error) {
      const technicalCode = 'desktop_error_report_network_failed';
      await this.appendReportingLog('desktop_error_report:submit_failed', {
        ...logBase,
        success: false,
        technicalCode,
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode };
    }
  }

  async listRemoteBackups(appId?: string): Promise<RemoteBackupsState> {
    const url = new URL(`${this.options.backendBaseUrl}/api/v1/me/backups`);
    if (appId) {
      url.searchParams.set('app_id', appId);
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      return emptyRemoteBackupsState();
    }
    if (Array.isArray(payload)) {
      return {
        backups: payload.map((entry) => this.normalizeRemoteBackup(entry)).filter((entry): entry is RemoteAppBackupSummary => Boolean(entry)),
        usage: emptyRemoteBackupsState().usage,
      };
    }
    if (!payload || typeof payload !== 'object') {
      return emptyRemoteBackupsState();
    }
    const record = payload as RemoteBackupsResponse;
    const backups = Array.isArray(record.backups) ? record.backups : [];
    return {
      backups: backups.map((entry) => this.normalizeRemoteBackup(entry)).filter((entry): entry is RemoteAppBackupSummary => Boolean(entry)),
      usage: this.normalizeRemoteBackupsUsage(record.usage),
    };
  }

  async createRemoteBackup(input: {
    archivePath: string;
    localBackup: AppBackupSummary;
    backupType: RemoteBackupType;
    source: RemoteBackupSource;
    signature?: string;
    signatureKeyFingerprint?: string;
    signatureAlgorithm?: string;
  }): Promise<{ success: boolean; remoteBackup?: RemoteAppBackupSummary; userMessage: string; technicalCode?: string }> {
    const archive = await fs.readFile(input.archivePath);
    const form = new FormData();
    form.set('app_id', input.localBackup.appId);
    form.set('app_name', input.localBackup.appName);
    form.set('app_version', input.localBackup.appVersion);
    form.set('backup_type', input.backupType);
    form.set('source', input.source);
    form.set('file_count', String(input.localBackup.fileCount));
    if (input.signature) {
      form.set('signature', input.signature);
      form.set('signature_key_fingerprint', input.signatureKeyFingerprint ?? '');
      form.set('signature_algorithm', input.signatureAlgorithm ?? 'rsa-sha256');
    }
    form.set('metadata', JSON.stringify({
      local_backup_id: input.localBackup.backupId,
      reason: input.localBackup.reason,
      files: input.localBackup.files,
    }));
    form.set(
      'archive',
      new Blob([archive], { type: 'application/zip' }),
      `${input.localBackup.appId}-${input.localBackup.backupId}.zip`,
    );

    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/backups`, {
      method: 'POST',
      headers: this.buildHeaders({ contentType: false }),
      body: form,
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      return {
        success: false,
        userMessage: this.remoteBackupErrorMessage(response.status, payload),
        technicalCode: `remote_backup_create_failed_${response.status}`,
      };
    }

    return {
      success: true,
      remoteBackup: this.normalizeRemoteBackup(payload),
      userMessage: input.backupType === 'sync_snapshot' ? 'Datos sincronizados con Forger Cloud.' : 'Respaldo subido a Forger Cloud.',
    };
  }

  async downloadRemoteBackup(remoteBackupId: number, targetPath: string): Promise<{ checksumSha256?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/backups/${remoteBackupId}/download`, {
      method: 'GET',
      headers: this.buildHeaders({ accept: 'application/zip' }),
    });
    if (!response.ok) {
      throw new Error(`remote_backup_download_failed_${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, buffer);
    return { checksumSha256: response.headers.get('X-Forger-Backup-Sha256') ?? undefined };
  }

  async deleteRemoteBackup(remoteBackupId: number): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/backups/${remoteBackupId}`, {
      method: 'DELETE',
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      return { success: false, userMessage: 'No pudimos eliminar el respaldo cloud.', technicalCode: `remote_backup_delete_failed_${response.status}` };
    }
    return { success: true, userMessage: 'Respaldo cloud eliminado.' };
  }

  async requestDownload(
    appVersionId: number,
    input: { platform: string; deviceIdentifier: string },
  ): Promise<DownloadPayload> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/app_versions/${appVersionId}/download`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platform: input.platform,
        device_identifier: input.deviceIdentifier,
      }),
    });

    if (!response.ok) {
      throw new Error(`download_request_failed_${response.status}`);
    }

    const payload = await this.readJson<DownloadPayload>(response);
    if (!payload?.download_url || !payload.version?.version) {
      throw new Error('download_payload_invalid');
    }

    return payload;
  }

  private buildHeaders(options: { accept?: string; contentType?: false | string } = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: options.accept ?? 'application/json',
    };
    if (typeof options.contentType === 'string') {
      headers['Content-Type'] = options.contentType;
    }
    const token = this.options.token();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async postGmailOAuth(path: string, body: Record<string, string>): Promise<GmailOAuthTokenResponse> {
    const response = await fetch(`${this.options.backendBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await this.readJson<GmailOAuthTokenResponse>(response);
    if (!response.ok) {
      const code = payload?.error || `gmail_oauth_backend_failed_${response.status}`;
      const description = payload?.error_description || 'No pudimos conectar Gmail desde Forger Cloud.';
      throw backendError(description, code);
    }
    if (!payload || typeof payload !== 'object') {
      throw backendError('Forger Cloud devolvio una respuesta Gmail invalida.', 'gmail_oauth_backend_response_invalid');
    }
    return payload;
  }

  private async postMetaOAuth(path: string, body: Record<string, string>): Promise<GmailOAuthTokenResponse> {
    const response = await fetch(`${this.options.backendBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await this.readJson<GmailOAuthTokenResponse>(response);
    if (!response.ok) {
      const code = payload?.error || `meta_oauth_backend_failed_${response.status}`;
      const description = payload?.error_description || 'No pudimos conectar Meta desde Forger Cloud.';
      throw backendError(description, code);
    }
    if (!payload || typeof payload !== 'object') {
      throw backendError('Forger Cloud devolvio una respuesta Meta invalida.', 'meta_oauth_backend_response_invalid');
    }
    return payload;
  }

  private async readJson<T>(response: Response): Promise<T | null> {
    const raw = await response.text();
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async getJson(pathname: string, code: string): Promise<unknown> {
    const response = await fetch(`${this.options.backendBaseUrl}${pathname}`, {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `${code}_${response.status}`);
    }
    return payload;
  }

  private async postJson(pathname: string, body: Record<string, unknown>, code: string): Promise<unknown> {
    const response = await fetch(`${this.options.backendBaseUrl}${pathname}`, {
      method: 'POST',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      throw backendError('No pudimos completar la accion en Forger Cloud.', `${code}_${response.status}`);
    }
    return payload;
  }

  private async patchJson(pathname: string, body: Record<string, unknown>, code: string): Promise<unknown> {
    const response = await fetch(`${this.options.backendBaseUrl}${pathname}`, {
      method: 'PATCH',
      headers: { ...this.buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      throw backendError('No pudimos completar la accion en Forger Cloud.', `${code}_${response.status}`);
    }
    return payload;
  }

  private normalizeRemoteBackup(value: unknown): RemoteAppBackupSummary | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const record = value as RemoteBackupPayload;
    const id = typeof record.id === 'number' ? record.id : Number(record.id);
    if (!Number.isFinite(id) || !record.app_id || !record.app_name) {
      return undefined;
    }
    return {
      id,
      appId: record.app_id,
      appName: record.app_name,
      appVersion: record.app_version ?? undefined,
      backupType: record.backup_type === 'sync_snapshot' ? 'sync_snapshot' : 'backup',
      source: record.source === 'auto_sync' ? 'auto_sync' : 'manual',
      metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : {},
      fileCount: Number(record.file_count ?? 0),
      totalBytes: Number(record.total_bytes ?? 0),
      checksumSha256: record.checksum_sha256 ?? '',
      signature: record.signature ?? undefined,
      signatureKeyFingerprint: record.signature_key_fingerprint ?? undefined,
      signatureAlgorithm: record.signature_algorithm ?? undefined,
      createdAt: record.created_at ?? new Date().toISOString(),
      updatedAt: record.updated_at,
      downloadUrl: record.download_url,
    };
  }

  private normalizeRemoteBackupsUsage(value: unknown): RemoteBackupsUsage {
    if (!value || typeof value !== 'object') {
      return emptyRemoteBackupsState().usage;
    }
    const record = value as NonNullable<RemoteBackupsResponse['usage']>;
    return {
      usedBytes: Number(record.used_bytes ?? 0),
      limitBytes: Number(record.limit_bytes ?? 0),
      backupCount: Number(record.backup_count ?? 0),
      backupCountLimit: Number(record.backup_count_limit ?? 0),
    };
  }

  private remoteBackupErrorMessage(status: number, payload: unknown): string {
    const error = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).error : undefined;
    if (status === 403) {
      return 'Forger Cloud Sync requiere una cuenta demo o pro.';
    }
    if (error === 'storage_limit_exceeded') {
      return 'Tu espacio de Forger Cloud esta lleno. Elimina respaldos cloud antes de subir otro.';
    }
    if (error === 'backup_count_limit_exceeded') {
      return 'Llegaste al maximo de respaldos cloud. Elimina algunos antes de subir otro.';
    }
    return 'No pudimos subir el respaldo a Forger Cloud.';
  }

  private googleLoginErrorMessage(payload: unknown): string {
    const error = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).error : undefined;
    if (error === 'google_login_server_not_configured') {
      return 'Google login no esta configurado en Forger Cloud.';
    }
    if (error === 'google_login_email_unverified') {
      return 'Google no confirmo este correo.';
    }
    if (error === 'google_login_account_conflict') {
      return 'Este correo ya esta vinculado a otra cuenta de Google.';
    }
    if (error === 'access_denied') {
      return 'Google cancelo el inicio de sesion.';
    }
    return 'No pudimos iniciar sesion con Google.';
  }

  private parseAccount(payload: unknown, token?: string): StoredForgerAccount {
    if (!payload || typeof payload !== 'object') {
      return { authenticated: false };
    }

    const record = payload as Record<string, unknown>;
    const user = normalizeForgerAccountUser(record.user);
    return {
      authenticated: Boolean(record.authenticated && (token || this.options.token()) && user),
      confirmationRequired: Boolean(record.confirmation_required ?? record.confirmationRequired),
      token,
      user,
    };
  }
}
