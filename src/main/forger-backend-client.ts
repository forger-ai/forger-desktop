/* eslint-disable max-lines */
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
  ConversationDiagnosticReportPreview,
  DesktopErrorReportPreview,
  SubmitConversationDiagnosticReportResult,
  CloudDeviceSummary,
  MobilePairingRequestSummary,
  CloudFriendship,
  CloudFriendUser,
  ForumComment,
  ForumParticipationState,
  ForumPost,
  ForumUserProfile,
  CloudMessage,
  CloudMessageDelivery,
  CloudMessageEnvelope,
  CloudStorageUsage,
  CloudSendAppShareInput,
  CloudSendMessageInput,
  SocialUserApp,
  SocialUserAppDownload,
  SocialUserAppList,
  SocialUserAppShare,
  SocialUserProfileDetail,
  SocialUserAppUploadAttempt,
  CloudAppMessagePermissionDecision,
  RemoteAppBackupSummary,
  RemoteBackupsState,
  RemoteNetworkShareStatus,
  LocalNetworkShareStatus,
  SubmitProductFeedbackInput,
  SubmitAppRatingInput,
  SubmitUsageEventInput,
  SubmitUsageEventResult,
} from '../shared/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ReportSanitizerRoot } from '../shared/report-sanitizer';
import type { StoredForgerAccount } from './forger-account-store';
import type { RemoteFrontendAsset } from './remote-frontend-packager';
import {
  mapCatalogItem,
  normalizeRating,
  type CatalogResponseItem,
  type PublicCatalogResponseItem,
} from './forger-backend/catalog-normalizers';
import {
  normalizeCloudDevice,
  normalizeMobilePairingRequest,
  normalizeCloudMessageDelivery,
  normalizeCloudMessage,
  normalizeCloudUser,
  normalizeFriendship,
} from './forger-backend/cloud-normalizers';
import {
  backendError,
  buildBackendHeaders,
  defaultReportingLogPath,
  emptyRemoteBackupsState,
  googleLoginErrorMessage,
  normalizeCloudStorageUsage,
  normalizeRemoteBackup,
  normalizeRemoteBackupsUsage,
  normalizeRuntimePlatform,
  parseAccountPayload,
  remoteBackupErrorMessage,
  responseRequestId,
  safeValidationKeys,
  type RemoteBackupsResponse,
  type CloudStorageResponse,
  usernameCooldownMessage,
} from './forger-backend/client-helpers';
import { type ConversationDiagnosticAttachmentUpload, type DesktopErrorReportAttachmentUpload, submitConversationDiagnosticReport, submitDesktopErrorReport } from './forger-backend/report-submissions';
import { deleteBackendJson, getBackendJson, patchBackendJson, postBackendJson } from './forger-backend/json-request';
import { toSocialUserApp, toSocialUserAppUploadAttempt, toSocialUserProfileDetail, toSocialVersion } from './forger-backend/social-normalizers';

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
  reportSanitizerRoots?: () => ReportSanitizerRoot[];
}

interface DownloadPayload {
  download_url: string;
  version: {
    version: string;
    checksum_sha256?: string | null;
  };
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

interface SocialDirectUploadResponse { signed_blob_id?: string; direct_upload?: { url?: string; headers?: Record<string, string> } }

interface SocialUploadConfirmResponse {
  upload_attempt?: unknown;
}

const normalizeForumParticipation = (payload: unknown): ForumParticipationState => {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const status = source.status === 'opted_in' || source.status === 'suspended' ? source.status : 'opted_out';
  return {
    status,
    firstPromptShownAt: typeof source.first_prompt_shown_at === 'string' ? source.first_prompt_shown_at : undefined,
    optedInAt: typeof source.opted_in_at === 'string' ? source.opted_in_at : undefined,
    optedOutAt: typeof source.opted_out_at === 'string' ? source.opted_out_at : undefined,
    suspendedAt: typeof source.suspended_at === 'string' ? source.suspended_at : undefined,
    suspensionReason: typeof source.suspension_reason === 'string' ? source.suspension_reason : undefined,
    isModerator: source.is_moderator === true,
  };
};

const normalizeForumUser = (payload: unknown): ForumUserProfile => {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return {
    id: Number(source.id ?? 0),
    username: typeof source.username === 'string' ? source.username : '',
    firstName: typeof source.first_name === 'string' ? source.first_name : undefined,
    lastInitial: typeof source.last_initial === 'string' ? source.last_initial : undefined,
  };
};

const normalizeForumComment = (payload: unknown): ForumComment | null => {
  if (!payload || typeof payload !== 'object') return null;
  const source = payload as Record<string, unknown>;
  const status = source.status === 'hidden' || source.status === 'deleted' ? source.status : 'visible';
  return {
    id: Number(source.id ?? 0),
    forumPostId: Number(source.forum_post_id ?? 0),
    parentId: typeof source.parent_id === 'number' ? source.parent_id : undefined,
    depth: Number(source.depth ?? 0),
    status,
    body: typeof source.body === 'string' ? source.body : undefined,
    author: normalizeForumUser(source.author),
    hiddenAt: typeof source.hidden_at === 'string' ? source.hidden_at : undefined,
    hiddenReason: typeof source.hidden_reason === 'string' ? source.hidden_reason : undefined,
    deletedAt: typeof source.deleted_at === 'string' ? source.deleted_at : undefined,
    canDelete: source.can_delete === true,
    canModerate: source.can_moderate === true,
    createdAt: typeof source.created_at === 'string' ? source.created_at : new Date(0).toISOString(),
    updatedAt: typeof source.updated_at === 'string' ? source.updated_at : undefined,
    editedAt: typeof source.edited_at === 'string' ? source.edited_at : undefined,
    replies: Array.isArray(source.replies) ? source.replies.map(normalizeForumComment).filter(Boolean) as ForumComment[] : [],
  };
};

const normalizeForumPost = (payload: unknown): ForumPost | null => {
  if (!payload || typeof payload !== 'object') return null;
  const source = payload as Record<string, unknown>;
  const status = source.status === 'hidden' || source.status === 'deleted' ? source.status : 'visible';
  return {
    id: Number(source.id ?? 0),
    status,
    body: typeof source.body === 'string' ? source.body : undefined,
    author: normalizeForumUser(source.author),
    commentsCount: Number(source.comments_count ?? 0),
    hiddenAt: typeof source.hidden_at === 'string' ? source.hidden_at : undefined,
    hiddenReason: typeof source.hidden_reason === 'string' ? source.hidden_reason : undefined,
    deletedAt: typeof source.deleted_at === 'string' ? source.deleted_at : undefined,
    canDelete: source.can_delete === true,
    canModerate: source.can_moderate === true,
    createdAt: typeof source.created_at === 'string' ? source.created_at : new Date(0).toISOString(),
    updatedAt: typeof source.updated_at === 'string' ? source.updated_at : undefined,
    editedAt: typeof source.edited_at === 'string' ? source.edited_at : undefined,
    comments: Array.isArray(source.comments) ? source.comments.map(normalizeForumComment).filter(Boolean) as ForumComment[] : undefined,
  };
};

const forumItems = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const source = payload as Record<string, unknown>;
    return Array.isArray(source.items) ? source.items : [];
  }
  return [];
};

export class ForgerBackendClient {
  constructor(private readonly options: ClientOptions) {}

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
        headers: buildBackendHeaders(this.options.token()),
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
      headers: buildBackendHeaders(this.options.token()),
    }).catch(() => undefined);
  }

  async updateAccountProfile(
    input: ForgerAccountProfileInput,
  ): Promise<StoredForgerAccount & { success: boolean; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/profile`, {
      method: 'PATCH',
      headers: {
        ...buildBackendHeaders(this.options.token()),
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
      headers: buildBackendHeaders(this.options.token()),
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
        userMessage: googleLoginErrorMessage(payload),
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
    deviceKind?: 'desktop' | 'mobile';
    publicKey?: string;
    keyFingerprint?: string;
  }): Promise<CloudDeviceSummary & { registered: boolean }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/devices/register`, {
      method: 'POST',
      headers: {
        ...buildBackendHeaders(this.options.token()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_uid: input.deviceUid,
        device_secret: input.deviceSecret,
        name: input.name,
        platform: input.platform,
        device_kind: input.deviceKind ?? 'desktop',
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
      headers: buildBackendHeaders(this.options.token()),
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
        ...buildBackendHeaders(this.options.token()),
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

  async listMobilePairingRequests(): Promise<MobilePairingRequestSummary[]> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/mobile_pairing_requests`, {
      method: 'GET',
      headers: buildBackendHeaders(this.options.token()),
    });
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `mobile_pairing_requests_failed_${response.status}`);
    }
    const payload = await this.readJson<unknown>(response);
    return Array.isArray(payload)
      ? payload.map((entry) => normalizeMobilePairingRequest(entry)).filter((entry): entry is MobilePairingRequestSummary => Boolean(entry))
      : [];
  }

  async acceptMobilePairingRequest(requestId: number): Promise<MobilePairingRequestSummary> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/mobile_pairing_requests/${requestId}/accept`, {
      method: 'POST',
      headers: buildBackendHeaders(this.options.token()),
    });
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `mobile_pairing_accept_failed_${response.status}`);
    }
    const payload = await this.readJson<unknown>(response);
    const request = normalizeMobilePairingRequest(payload);
    if (!request) {
      throw backendError('Forger Cloud response was invalid.', 'mobile_pairing_accept_payload_invalid');
    }
    return request;
  }

  async rejectMobilePairingRequest(requestId: number): Promise<MobilePairingRequestSummary> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/mobile_pairing_requests/${requestId}/reject`, {
      method: 'POST',
      headers: buildBackendHeaders(this.options.token()),
    });
    if (!response.ok) {
      throw backendError('Forger Cloud session is no longer valid.', `mobile_pairing_reject_failed_${response.status}`);
    }
    const payload = await this.readJson<unknown>(response);
    const request = normalizeMobilePairingRequest(payload);
    if (!request) {
      throw backendError('Forger Cloud response was invalid.', 'mobile_pairing_reject_payload_invalid');
    }
    return request;
  }

  async createRemoteTunnelSession(input: { deviceId: number; appId: string }): Promise<Record<string, unknown>> {
    const payload = await postBackendJson(this.options, '/api/v1/me/remote_tunnel_sessions', {
      device_id: input.deviceId,
      app_id: input.appId,
    }, 'remote_tunnel_create_failed');
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  }

  async uploadRemoteTunnelFrontend(input: {
    sessionId: number;
    assets: RemoteFrontendAsset[];
    frontendHash: string;
    tunnelUrl: string;
    desktopPublicKeyJwk: JsonWebKey;
  }): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.set('frontend_hash', input.frontendHash);
    form.set('tunnel_url', input.tunnelUrl);
    form.set('desktop_public_key_jwk', JSON.stringify(input.desktopPublicKeyJwk));
    for (const asset of input.assets) {
      form.append('asset_paths[]', asset.path);
      const body = asset.data.buffer.slice(asset.data.byteOffset, asset.data.byteOffset + asset.data.byteLength) as ArrayBuffer;
      form.append('assets[]', new Blob([body], { type: asset.type }), asset.path.split('/').pop() ?? 'asset');
    }
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/remote_tunnel_sessions/${input.sessionId}/upload_frontend`, {
      method: 'POST',
      headers: buildBackendHeaders(this.options.token(), { contentType: false }),
      body: form,
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      throw backendError('No pudimos subir el frontend remoto.', `remote_tunnel_upload_failed_${response.status}`);
    }
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  }

  async reportRemoteTunnelSession(input: {
    sessionId: number;
    status: string;
    tunnelUrl?: string;
    connectionCount?: number;
    lastError?: string;
  }): Promise<void> {
    await patchBackendJson(this.options, `/api/v1/me/remote_tunnel_sessions/${input.sessionId}/report`, {
      status: input.status,
      tunnel_url: input.tunnelUrl,
      connection_count: input.connectionCount,
      last_error: input.lastError,
    }, 'remote_tunnel_report_failed').catch(() => undefined);
  }

  async closeRemoteTunnelSession(sessionId: number): Promise<void> {
    await postBackendJson(this.options, `/api/v1/me/remote_tunnel_sessions/${sessionId}/close`, {}, 'remote_tunnel_close_failed').catch(() => undefined);
  }

  async reportRemoteSessionRequest(input: {
    requestId: string;
    appId: string;
    status: string;
    remoteStatus?: RemoteNetworkShareStatus;
    portalUrl?: string;
    frontendUrl?: string;
    technicalCode?: string;
  }): Promise<void> {
    await patchBackendJson(this.options, `/api/v1/me/remote_session_requests/${encodeURIComponent(input.requestId)}/report`, {
      app_id: input.appId,
      status: input.status,
      remote_status: input.remoteStatus,
      portal_url: input.portalUrl,
      frontend_url: input.frontendUrl,
      technical_code: input.technicalCode,
    }, 'remote_session_request_report_failed').catch(() => undefined);
  }

  async reportAppAccessRequest(input: {
    requestId: string;
    appId: string;
    status: string;
    accessStatus?: LocalNetworkShareStatus | RemoteNetworkShareStatus;
    technicalCode?: string;
  }): Promise<void> {
    const localStatus = input.accessStatus && 'url' in input.accessStatus ? input.accessStatus : undefined;
    const remoteStatus = input.accessStatus && 'state' in input.accessStatus ? input.accessStatus : undefined;
    await patchBackendJson(this.options, `/api/v1/me/app_access_requests/${encodeURIComponent(input.requestId)}/report`, {
      app_id: input.appId,
      status: input.status,
      remote_status: remoteStatus,
      remote_session_id: remoteStatus?.sessionId,
      url: localStatus?.url,
      connect_url: localStatus?.connectUrl,
      technical_code: input.technicalCode,
    }, 'app_access_request_report_failed').catch(() => undefined);
  }

  async reportAppControlRequest(input: {
    requestId: string;
    appId: string;
    status: string;
    technicalCode?: string;
  }): Promise<void> {
    await patchBackendJson(this.options, `/api/v1/me/app_control_requests/${encodeURIComponent(input.requestId)}/report`, {
      app_id: input.appId,
      status: input.status,
      technical_code: input.technicalCode,
    }, 'app_control_request_report_failed').catch(() => undefined);
  }

  async listFriends(): Promise<CloudFriendship[]> {
    const payload = await getBackendJson(this.options, '/api/v1/me/friends', 'friends_list_failed');
    return Array.isArray(payload) ? payload.map((entry) => normalizeFriendship(entry)).filter(Boolean) as CloudFriendship[] : [];
  }

  async searchFriends(username: string): Promise<CloudFriendUser[]> {
    const query = new URLSearchParams({ username });
    const payload = await getBackendJson(this.options, `/api/v1/me/friends/search?${query.toString()}`, 'friends_search_failed');
    return Array.isArray(payload) ? payload.map((entry) => normalizeCloudUser(entry)).filter(Boolean) as CloudFriendUser[] : [];
  }

  async sendFriendRequest(username: string): Promise<CloudFriendship> {
    const payload = await postBackendJson(this.options, '/api/v1/me/friend_requests', { username }, 'friend_request_create_failed');
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
    const payload = await patchBackendJson(this.options, `/api/v1/me/friends/${encodeURIComponent(String(friendUserId))}/read_receipt`, {}, 'friend_read_receipt_failed');
    const friendship = normalizeFriendship(payload);
    if (!friendship) {
      throw backendError('No pudimos actualizar la lectura del chat.', 'friend_read_receipt_response_invalid');
    }
    return friendship;
  }

  async listCloudMessages(friendUserId: number): Promise<CloudMessage[]> {
    const query = new URLSearchParams({ friend_user_id: String(friendUserId) });
    const payload = await getBackendJson(this.options, `/api/v1/me/cloud_messages?${query.toString()}`, 'cloud_messages_list_failed');
    return Array.isArray(payload) ? payload.map((entry) => normalizeCloudMessage(entry)).filter(Boolean) as CloudMessage[] : [];
  }

  async sendCloudMessage(input: CloudSendMessageInput & { envelopes: CloudMessageEnvelope[]; clientMessageId?: string }): Promise<CloudMessage> {
    const payload = await postBackendJson(this.options, '/api/v1/me/cloud_messages', {
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

  async sendCloudAppShareMessage(input: CloudSendAppShareInput & { envelopes: CloudMessageEnvelope[]; clientMessageId?: string }): Promise<CloudMessage> {
    const payload = await postBackendJson(this.options, '/api/v1/me/cloud_messages/app_share', {
      recipient_username: input.recipientUsername,
      recipient_user_id: input.recipientUserId,
      user_app_id: input.userAppId,
      client_message_id: input.clientMessageId,
      envelopes: input.envelopes.map((envelope) => ({
        recipient_user_id: envelope.recipientUserId,
        cloud_device_id: envelope.cloudDeviceId,
        device_uid: envelope.deviceUid,
        key_fingerprint: envelope.keyFingerprint,
        ciphertext: envelope.ciphertext,
        metadata: envelope.metadata,
      })),
    }, 'cloud_app_share_message_send_failed');
    const message = normalizeCloudMessage(payload);
    if (!message) {
      throw backendError('No pudimos compartir esta app.', 'cloud_app_share_message_response_invalid');
    }
    return message;
  }

  async listCloudMessageDeliveries(deviceId: number): Promise<CloudMessageDelivery[]> {
    const query = new URLSearchParams({ device_id: String(deviceId) });
    const payload = await getBackendJson(this.options, `/api/v1/me/cloud_message_deliveries?${query.toString()}`, 'cloud_message_deliveries_list_failed');
    return Array.isArray(payload)
      ? payload.map((entry) => normalizeCloudMessageDelivery(entry)).filter(Boolean) as CloudMessageDelivery[]
      : [];
  }

  async sendCloudMessageDeliveries(input: CloudSendMessageInput & {
    deliveries: Array<{
      targetUserId: number;
      cloudDeviceId: number;
      deviceUid?: string;
      keyFingerprint?: string;
      ciphertext: string;
    }>;
    clientMessageId: string;
  }): Promise<CloudMessageDelivery[]> {
    const payload = await postBackendJson(this.options, '/api/v1/me/cloud_message_deliveries', {
      recipient_username: input.recipientUsername,
      recipient_user_id: input.recipientUserId,
      source: input.source ?? 'user',
      source_app_id: input.sourceAppId,
      source_app_name: input.sourceAppName,
      client_message_id: input.clientMessageId,
      deliveries: input.deliveries.map((delivery) => ({
        target_user_id: delivery.targetUserId,
        cloud_device_id: delivery.cloudDeviceId,
        device_uid: delivery.deviceUid,
        key_fingerprint: delivery.keyFingerprint,
        ciphertext: delivery.ciphertext,
      })),
    }, 'cloud_message_delivery_send_failed');
    const entries = payload && typeof payload === 'object' && Array.isArray((payload as { deliveries?: unknown }).deliveries)
      ? (payload as { deliveries: unknown[] }).deliveries
      : [];
    return entries.map((entry) => normalizeCloudMessageDelivery(entry)).filter(Boolean) as CloudMessageDelivery[];
  }

  async sendCloudAppShareDeliveries(input: CloudSendAppShareInput & {
    deliveries: Array<{
      targetUserId: number;
      cloudDeviceId: number;
      deviceUid?: string;
      keyFingerprint?: string;
      ciphertext: string;
    }>;
    clientMessageId: string;
  }): Promise<CloudMessageDelivery[]> {
    const payload = await postBackendJson(this.options, '/api/v1/me/cloud_message_deliveries/app_share', {
      recipient_username: input.recipientUsername,
      recipient_user_id: input.recipientUserId,
      user_app_id: input.userAppId,
      client_message_id: input.clientMessageId,
      deliveries: input.deliveries.map((delivery) => ({
        target_user_id: delivery.targetUserId,
        cloud_device_id: delivery.cloudDeviceId,
        device_uid: delivery.deviceUid,
        key_fingerprint: delivery.keyFingerprint,
        ciphertext: delivery.ciphertext,
      })),
    }, 'cloud_app_share_delivery_send_failed');
    const entries = payload && typeof payload === 'object' && Array.isArray((payload as { deliveries?: unknown }).deliveries)
      ? (payload as { deliveries: unknown[] }).deliveries
      : [];
    return entries.map((entry) => normalizeCloudMessageDelivery(entry)).filter(Boolean) as CloudMessageDelivery[];
  }

  async ackCloudMessageDeliveries(deviceId: number, deliveryIds: number[]): Promise<void> {
    await postBackendJson(this.options, '/api/v1/me/cloud_message_deliveries/ack', {
      device_id: deviceId,
      delivery_ids: deliveryIds,
    }, 'cloud_message_delivery_ack_failed');
  }

  async decideAppMessagePermission(cloudMessageId: number, decision: CloudAppMessagePermissionDecision): Promise<CloudMessage> {
    const payload = await patchBackendJson(this.options, '/api/v1/me/app_message_permission', {
      cloud_message_id: cloudMessageId,
      decision,
    }, 'app_message_permission_failed');
    const message = normalizeCloudMessage(payload);
    if (!message) {
      throw backendError('No pudimos actualizar el permiso.', 'app_message_permission_response_invalid');
    }
    return message;
  }

  async getForumParticipation(): Promise<ForumParticipationState> {
    const payload = await getBackendJson(this.options, '/api/v1/me/forum/participation', 'forum_participation_get_failed');
    return normalizeForumParticipation(payload);
  }

  async updateForumParticipation(action: 'mark_prompt_shown' | 'opt_in' | 'opt_out'): Promise<ForumParticipationState> {
    const payload = await patchBackendJson(this.options, '/api/v1/me/forum/participation', {
      forum_action: action,
    }, 'forum_participation_update_failed');
    return normalizeForumParticipation(payload);
  }

  async listForumPosts(limit = 25): Promise<ForumPost[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.round(limit)));
    const payload = await getBackendJson(this.options, `/api/v1/me/forum/posts?per_page=${safeLimit}`, 'forum_posts_list_failed');
    return forumItems(payload).map(normalizeForumPost).filter(Boolean) as ForumPost[];
  }

  async getForumPost(id: number): Promise<ForumPost> {
    const payload = await getBackendJson(this.options, `/api/v1/me/forum/posts/${id}`, 'forum_post_get_failed');
    const post = normalizeForumPost(payload);
    if (!post) throw backendError('No pudimos cargar el post.', 'forum_post_response_invalid');
    return post;
  }

  async createForumPost(body: string): Promise<ForumPost> {
    const payload = await postBackendJson(this.options, '/api/v1/me/forum/posts', { body }, 'forum_post_create_failed');
    const post = normalizeForumPost(payload);
    if (!post) throw backendError('No pudimos crear el post.', 'forum_post_create_response_invalid');
    return post;
  }

  async createForumComment(postId: number, body: string): Promise<ForumComment> {
    const payload = await postBackendJson(this.options, `/api/v1/me/forum/posts/${postId}/comments`, { body }, 'forum_comment_create_failed');
    const comment = normalizeForumComment(payload);
    if (!comment) throw backendError('No pudimos comentar el post.', 'forum_comment_create_response_invalid');
    return comment;
  }

  async replyForumComment(commentId: number, body: string): Promise<ForumComment> {
    const payload = await postBackendJson(this.options, `/api/v1/me/forum/comments/${commentId}/replies`, { body }, 'forum_reply_create_failed');
    const comment = normalizeForumComment(payload);
    if (!comment) throw backendError('No pudimos responder el comentario.', 'forum_reply_create_response_invalid');
    return comment;
  }

  async deleteForumPost(id: number): Promise<ForumPost> {
    const payload = await deleteBackendJson(this.options, `/api/v1/me/forum/posts/${id}`, 'forum_post_delete_failed');
    const post = normalizeForumPost(payload);
    if (!post) throw backendError('No pudimos borrar el post.', 'forum_post_delete_response_invalid');
    return post;
  }

  async deleteForumComment(id: number): Promise<ForumComment> {
    const payload = await deleteBackendJson(this.options, `/api/v1/me/forum/comments/${id}`, 'forum_comment_delete_failed');
    const comment = normalizeForumComment(payload);
    if (!comment) throw backendError('No pudimos borrar el comentario.', 'forum_comment_delete_response_invalid');
    return comment;
  }

  async moderateForumPost(id: number, action: 'hide' | 'unhide', reason?: string): Promise<ForumPost> {
    const payload = await postBackendJson(this.options, `/api/v1/me/forum/posts/${id}/${action}`, { reason }, 'forum_post_moderation_failed');
    const post = normalizeForumPost(payload);
    if (!post) throw backendError('No pudimos moderar el post.', 'forum_post_moderation_response_invalid');
    return post;
  }

  async moderateForumComment(id: number, action: 'hide' | 'unhide', reason?: string): Promise<ForumComment> {
    const payload = await postBackendJson(this.options, `/api/v1/me/forum/comments/${id}/${action}`, { reason }, 'forum_comment_moderation_failed');
    const comment = normalizeForumComment(payload);
    if (!comment) throw backendError('No pudimos moderar el comentario.', 'forum_comment_moderation_response_invalid');
    return comment;
  }

  async listMySocialApps(): Promise<SocialUserAppList> {
    const payload = await getBackendJson(this.options, '/api/v1/me/user_apps', 'social_user_apps_list_failed') as Record<string, unknown>;
    const usage = payload.usage && typeof payload.usage === 'object'
      ? payload.usage as Record<string, unknown>
      : {};
    return {
      usage: {
        appCount: Number(usage.app_count ?? 0),
        appCountLimit: Number(usage.app_count_limit ?? 0),
        versionSizeLimitBytes: Number(usage.version_size_limit_bytes ?? 0),
        storage: normalizeCloudStorageUsage(usage.storage),
      },
      apps: Array.isArray(payload.apps) ? payload.apps.map(toSocialUserApp).filter(Boolean) as SocialUserApp[] : [],
    };
  }

  async uploadSocialApp(input: {
    zipPath: string;
    name?: string;
    slug?: string;
    description?: string;
    shortDescription?: string;
    category?: string;
    visibility: 'public' | 'friends' | 'private';
    onProgress?: (message: string) => void | Promise<void>;
  }): Promise<SocialUserApp> {
    const buffer = await fs.readFile(input.zipPath);
    await input.onProgress?.('Autorizando subida directa');
    const checksum = createHash('md5').update(buffer).digest('base64');
    const checksumSha256 = createHash('sha256').update(buffer).digest('hex');
    const directUpload = await this.createSocialAppDirectUpload({
      filename: path.basename(input.zipPath),
      byte_size: buffer.byteLength,
      checksum,
      checksum_sha256: checksumSha256,
      content_type: 'application/zip',
    });
    const uploadUrl = directUpload.direct_upload?.url;
    const signedBlobId = directUpload.signed_blob_id;
    if (!uploadUrl || !signedBlobId) {
      throw backendError('Forger Cloud no preparo la subida directa.', 'social_user_app_direct_upload_response_invalid');
    }
    await input.onProgress?.('Subiendo archivo a Social');
    const storageResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: directUpload.direct_upload?.headers ?? {},
      body: buffer,
    });
    if (!storageResponse.ok) {
      throw backendError('No pudimos subir el archivo de la app a Social.', `social_user_app_storage_upload_failed_${storageResponse.status}`);
    }
    await input.onProgress?.('Analizando app');

    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/user_apps`, {
      method: 'POST',
      headers: { ...buildBackendHeaders(this.options.token()), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visibility: input.visibility,
        name: input.name,
        slug: input.slug,
        description: input.description,
        short_description: input.shortDescription,
        category: input.category,
        signed_blob_id: signedBlobId,
        checksum_sha256: checksumSha256,
      }),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? String(
            (payload as { user_message?: unknown }).user_message
            ?? (payload as { userMessage?: unknown }).userMessage
            ?? (payload as { error?: unknown }).error
            ?? 'No pudimos subir la app a Social.',
          )
        : 'No pudimos subir la app a Social.';
      const technicalCode = payload && typeof payload === 'object' && typeof (payload as { technical_code?: unknown }).technical_code === 'string'
        ? (payload as { technical_code: string }).technical_code
        : payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
          ? (payload as { error: string }).error
          : `social_user_app_upload_failed_${response.status}`;
      throw backendError(message, technicalCode);
    }
    const attemptPayload = payload && typeof payload === 'object' ? (payload as SocialUploadConfirmResponse).upload_attempt : undefined;
    const attempt = toSocialUserAppUploadAttempt(attemptPayload);
    if (!attempt) throw backendError('Forger Cloud no preparo el analisis de la app.', 'social_user_app_upload_attempt_invalid');
    return await this.pollSocialAppUploadAttempt(attempt.id, input.onProgress);
  }

  private async pollSocialAppUploadAttempt(
    attemptId: number,
    onProgress?: (message: string) => void | Promise<void>,
  ): Promise<SocialUserApp> {
    const deadline = Date.now() + 15 * 60 * 1000;
    let lastStatus: string | undefined;
    while (Date.now() < deadline) {
      const attempt = await this.getSocialAppUploadAttempt(attemptId);
      if (attempt.status !== lastStatus) {
        lastStatus = attempt.status;
        if (attempt.status === 'uploaded' || attempt.status === 'analyzing') {
          await onProgress?.('Analizando app');
        }
      }
      if (attempt.status === 'published' && attempt.app) {
        await onProgress?.('App publicada');
        return attempt.app;
      }
      if (attempt.status === 'failed') {
        throw backendError(attempt.errorCode ?? 'No pudimos analizar la app.', attempt.errorCode ?? 'social_user_app_analysis_failed');
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw backendError('El analisis de la app sigue pendiente.', 'social_user_app_analysis_timeout');
  }

  private async getSocialAppUploadAttempt(attemptId: number): Promise<SocialUserAppUploadAttempt> {
    const payload = await getBackendJson(this.options, `/api/v1/me/user_app_upload_attempts/${encodeURIComponent(String(attemptId))}`, 'social_user_app_upload_attempt_failed');
    const attempt = toSocialUserAppUploadAttempt(payload);
    if (!attempt) {
      throw backendError('Forger Cloud devolvio un estado de subida invalido.', 'social_user_app_upload_attempt_response_invalid');
    }
    return attempt;
  }

  private async createSocialAppDirectUpload(body: Record<string, unknown>): Promise<SocialDirectUploadResponse> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/user_apps/direct_uploads`, {
      method: 'POST',
      headers: { ...buildBackendHeaders(this.options.token()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      const message = payload && typeof payload === 'object'
        ? String((payload as { error?: unknown }).error ?? 'No pudimos preparar la subida a Social.')
        : 'No pudimos preparar la subida a Social.';
      const technicalCode = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `social_user_app_direct_upload_failed_${response.status}`;
      throw backendError(message, technicalCode);
    }
    return payload && typeof payload === 'object' ? payload as SocialDirectUploadResponse : {};
  }

  async createSocialAppShare(userAppId: number): Promise<SocialUserAppShare> {
    const payload = await postBackendJson(this.options, `/api/v1/me/user_apps/${userAppId}/shares`, { scope: 'private_link' }, 'social_user_app_share_failed') as Record<string, unknown>;
    return {
      id: Number(payload.id),
      code: typeof payload.code === 'string' ? payload.code : '',
      scope: typeof payload.scope === 'string' ? payload.scope : 'private_link',
      expiresAt: typeof payload.expires_at === 'string' ? payload.expires_at : undefined,
      maxUses: typeof payload.max_uses === 'number' ? payload.max_uses : undefined,
      deepLink: typeof payload.deep_link === 'string' ? payload.deep_link : '',
    };
  }

  async resolveSocialCode(code: string): Promise<{ app: SocialUserApp; share?: Record<string, unknown> }> {
    const payload = await getBackendJson(this.options, `/api/v1/social/codes/${encodeURIComponent(code)}`, 'social_code_resolve_failed') as Record<string, unknown>;
    const app = toSocialUserApp(payload.app);
    if (!app) throw backendError('No pudimos abrir esta app Social.', 'social_code_app_invalid');
    return { app, share: payload.share && typeof payload.share === 'object' ? payload.share as Record<string, unknown> : undefined };
  }

  async resolveSocialApp(id: number): Promise<{ app: SocialUserApp }> {
    const payload = await getBackendJson(this.options, `/api/v1/social/apps/by_id/${encodeURIComponent(String(id))}`, 'social_app_resolve_failed') as Record<string, unknown>;
    const app = toSocialUserApp(payload);
    if (!app) throw backendError('No pudimos abrir esta app Social.', 'social_app_invalid');
    return { app };
  }

  async getSocialProfile(username: string): Promise<SocialUserProfileDetail> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) {
      throw backendError('No pudimos abrir este perfil Social.', 'social_profile_username_missing');
    }
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/social/profiles/${encodeURIComponent(normalizedUsername)}`, {
      method: 'GET',
      headers: buildBackendHeaders(this.options.token()),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      if (response.status === 404) {
        throw backendError(`No encontramos el perfil @${normalizedUsername.replace(/^@/, '')}.`, 'social_profile_not_found');
      }
      if (response.status === 401 || response.status === 403) {
        throw backendError('Forger Cloud session is no longer valid.', `social_profile_get_failed_${response.status}`);
      }
      throw backendError('No pudimos abrir este perfil Social.', `social_profile_get_failed_${response.status}`);
    }
    const profile = toSocialUserProfileDetail(payload);
    if (!profile) throw backendError('No pudimos abrir este perfil Social.', 'social_profile_invalid');
    return profile;
  }

  async requestSocialAppDownload(input: {
    appId?: number;
    appSlug?: string;
    shareCode?: string;
    platform: string;
    deviceIdentifier: string;
    trustDecision?: 'not_reviewed' | 'reviewed' | 'skipped_review';
  }): Promise<SocialUserAppDownload> {
    const endpoint = typeof input.appId === 'number'
      ? `/api/v1/social/apps/by_id/${encodeURIComponent(String(input.appId))}/download`
      : `/api/v1/social/apps/${encodeURIComponent(input.appSlug ?? '')}/download`;
    const payload = await postBackendJson(this.options, endpoint, {
      share_code: input.shareCode,
      platform: input.platform,
      device_identifier: input.deviceIdentifier,
      trust_decision: input.trustDecision ?? 'not_reviewed',
    }, 'social_user_app_download_failed') as Record<string, unknown>;
    const version = payload.version && typeof payload.version === 'object' ? toSocialVersion(payload.version as Record<string, unknown>) : undefined;
    const app = payload.app && typeof payload.app === 'object' ? payload.app as Record<string, unknown> : {};
    const install = payload.install && typeof payload.install === 'object' ? payload.install as Record<string, unknown> : {};
    if (!version || typeof payload.download_url !== 'string') {
      throw backendError('Forger Cloud devolvio una descarga Social invalida.', 'social_user_app_download_invalid');
    }
    return {
      downloadUrl: payload.download_url,
      version,
      app: {
        id: Number(app.id),
        slug: typeof app.slug === 'string' ? app.slug : '',
        name: typeof app.name === 'string' ? app.name : '',
        ownerUsername: typeof app.owner_username === 'string' ? app.owner_username : '',
      },
      install: {
        id: Number(install.id),
        installedAt: typeof install.installed_at === 'string' ? install.installed_at : '',
        source: typeof install.source === 'string' ? install.source : 'profile',
        trustDecision: install.trust_decision === 'reviewed' || install.trust_decision === 'skipped_review' ? install.trust_decision : 'not_reviewed',
      },
    };
  }

  normalizeCloudMessagePayload(value: unknown): CloudMessage | undefined {
    return normalizeCloudMessage(value);
  }

  normalizeCloudMessageDeliveryPayload(value: unknown): CloudMessageDelivery | undefined {
    return normalizeCloudMessageDelivery(value);
  }

  normalizeFriendshipPayload(value: unknown): CloudFriendship | undefined {
    return normalizeFriendship(value);
  }

  private async friendRequestAction(id: number, action: 'accept' | 'decline' | 'cancel'): Promise<CloudFriendship> {
    const payload = await postBackendJson(this.options, `/api/v1/me/friend_requests/${id}/${action}`, {}, `friend_request_${action}_failed`);
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
        ...buildBackendHeaders(this.options.token()),
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
    const platform = this.options.platform?.() ?? normalizeRuntimePlatform(process.platform, process.arch);
    const desktopVersion = input.desktopVersion ?? this.options.desktopVersion?.();
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
          ...buildBackendHeaders(this.options.token()),
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
    const platform = input.platform ?? this.options.platform?.() ?? normalizeRuntimePlatform(process.platform, process.arch);
    const desktopVersion = input.desktopVersion ?? this.options.desktopVersion?.();
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
    attachments?: DesktopErrorReportAttachmentUpload[],
  ): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> {
    return submitDesktopErrorReport(this.reportSubmissionOptions(), input, attachments);
  }

  async submitConversationDiagnosticReport(
    input: ConversationDiagnosticReportPreview,
    attachments?: ConversationDiagnosticAttachmentUpload[],
  ): Promise<SubmitConversationDiagnosticReportResult> {
    return submitConversationDiagnosticReport(this.reportSubmissionOptions(), input, attachments);
  }

  async listRemoteBackups(appId?: string): Promise<RemoteBackupsState> {
    const url = new URL(`${this.options.backendBaseUrl}/api/v1/me/backups`);
    if (appId) {
      url.searchParams.set('app_id', appId);
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: buildBackendHeaders(this.options.token()),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      return emptyRemoteBackupsState();
    }
    if (Array.isArray(payload)) {
      return {
        backups: payload.map((entry) => normalizeRemoteBackup(entry)).filter((entry): entry is RemoteAppBackupSummary => Boolean(entry)),
        usage: emptyRemoteBackupsState().usage,
      };
    }
    if (!payload || typeof payload !== 'object') {
      return emptyRemoteBackupsState();
    }
    const record = payload as RemoteBackupsResponse;
    const backups = Array.isArray(record.backups) ? record.backups : [];
    return {
      backups: backups.map((entry) => normalizeRemoteBackup(entry)).filter((entry): entry is RemoteAppBackupSummary => Boolean(entry)),
      usage: normalizeRemoteBackupsUsage(record.usage),
    };
  }

  async getCloudStorageUsage(): Promise<CloudStorageUsage | null> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/cloud_storage`, {
      method: 'GET',
      headers: buildBackendHeaders(this.options.token()),
    });
    const payload = await this.readJson<CloudStorageResponse>(response);
    if (!response.ok || !payload || typeof payload !== 'object') {
      return null;
    }
    return normalizeCloudStorageUsage(payload.storage);
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
      headers: buildBackendHeaders(this.options.token(), { contentType: false }),
      body: form,
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok) {
      return {
        success: false,
        userMessage: remoteBackupErrorMessage(response.status, payload),
        technicalCode: `remote_backup_create_failed_${response.status}`,
      };
    }

    return {
      success: true,
      remoteBackup: normalizeRemoteBackup(payload),
      userMessage: input.backupType === 'sync_snapshot' ? 'Datos sincronizados con Forger Cloud.' : 'Respaldo subido a Forger Cloud.',
    };
  }

  async downloadRemoteBackup(remoteBackupId: number, targetPath: string): Promise<{ checksumSha256?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/backups/${remoteBackupId}/download`, {
      method: 'GET',
      headers: buildBackendHeaders(this.options.token(), { accept: 'application/zip' }),
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
      headers: buildBackendHeaders(this.options.token()),
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
        ...buildBackendHeaders(this.options.token()),
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

  private async postGmailOAuth(path: string, body: Record<string, string>): Promise<GmailOAuthTokenResponse> {
    const response = await fetch(`${this.options.backendBaseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...buildBackendHeaders(this.options.token()),
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

  private reportSubmissionOptions() {
    return {
      backendBaseUrl: this.options.backendBaseUrl,
      token: this.options.token(),
      roots: this.options.reportSanitizerRoots?.() ?? [],
      appendReportingLog: (event: string, details: Record<string, unknown>) => this.appendReportingLog(event, details),
    };
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

  private parseAccount(payload: unknown, token?: string): StoredForgerAccount {
    return parseAccountPayload(payload, token, this.options.token());
  }
}
