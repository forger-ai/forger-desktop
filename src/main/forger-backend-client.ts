import type {
  AppCategory,
  AppRatingSummary,
  AppStatus,
  CatalogApp,
  AppBackupSummary,
  RemoteBackupType,
  RemoteBackupSource,
  ForgerAccountLoginInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  DesktopErrorReportPreview,
  CloudDeviceSummary,
  RemoteAppBackupSummary,
  RemoteBackupsState,
  RemoteBackupsUsage,
  SubmitAppFeedbackInput,
  SubmitAppRatingInput,
} from '../shared/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeAppCapabilities } from '../shared/capabilities';
import { normalizeErrorReportDiagnostic } from '../shared/error-diagnostics';
import { normalizeForgerAccountUser, type StoredForgerAccount } from './forger-account-store';

interface ClientOptions {
  backendBaseUrl: string;
  localCatalogJsonUrl: () => string | undefined;
  token: () => string | undefined;
  mapBackendCategory: (backendCategory: string) => AppCategory;
  toCatalogStatus: (slug: string) => AppStatus;
  getUserMessage: (slug: string) => string | undefined;
}

interface PublicCatalogResponseItem {
  slug: string;
  name: string;
  short_description?: string | null;
  description?: string | null;
  category: string;
  icon_url?: string | null;
  beta?: boolean | null;
  latest_version?: CatalogVersionPayload;
}

interface CatalogResponseItem extends PublicCatalogResponseItem {
  short_description: string | null;
  description: string | null;
  average_rating?: number | string | null;
  ratings_count?: number | string | null;
  recent_ratings?: unknown[];
  current_user_rating?: unknown;
  latest_version?: CatalogVersionPayload & { id: number };
}

interface CatalogVersionPayload {
  version?: string;
  required_python_version?: string | null;
  required_node_version?: string | null;
  checksum_sha256?: string | null;
  download_url?: string | null;
  changelog?: unknown;
  capabilities?: unknown;
  permissions?: unknown;
}

interface DownloadPayload {
  download_url: string;
  version: {
    version: string;
    checksum_sha256?: string | null;
  };
}

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

const backendError = (message: string, technicalCode: string): Error & { technicalCode: string } =>
  Object.assign(new Error(message), { technicalCode });

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
          backendApps = payload.map((appEntry) => this.mapCatalogItem(appEntry, false));
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
    return Array.isArray(publicPayload) ? publicPayload.map((appEntry) => this.mapCatalogItem(appEntry, true)) : [];
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

  async registerDevice(input: {
    deviceUid: string;
    deviceSecret: string;
    name: string;
    platform: string;
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
      }),
    });
    const payload = await this.readJson<Record<string, unknown>>(response);
    if (!response.ok) {
      throw new Error(`device_register_failed_${response.status}`);
    }
    return this.normalizeCloudDevice(payload) as CloudDeviceSummary & { registered: boolean };
  }

  async listDevices(): Promise<CloudDeviceSummary[]> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/me/devices`, {
      method: 'GET',
      headers: this.buildHeaders(),
    });
    const payload = await this.readJson<unknown>(response);
    if (!response.ok || !Array.isArray(payload)) {
      return [];
    }
    return payload.map((entry) => this.normalizeCloudDevice(entry)).filter((entry): entry is CloudDeviceSummary => Boolean(entry));
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
      throw new Error(`pairing_code_failed_${response.status}`);
    }
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

    return { success: true, rating: this.normalizeRating(payload), userMessage: 'Review guardada.' };
  }

  async submitAppFeedback(
    input: SubmitAppFeedbackInput,
  ): Promise<{ success: boolean; userMessage?: string; technicalCode?: string }> {
    const response = await fetch(`${this.options.backendBaseUrl}/api/v1/catalog/apps/${encodeURIComponent(input.appId)}/feedbacks`, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: input.kind,
        body: input.body,
        locale: input.locale,
      }),
    });

    if (!response.ok) {
      return { success: false, userMessage: 'No pudimos enviar el feedback.', technicalCode: `feedback_failed_${response.status}` };
    }

    return { success: true, userMessage: 'Feedback enviado.' };
  }

  async submitDesktopErrorReport(
    input: DesktopErrorReportPreview,
  ): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> {
    const report = normalizeErrorReportDiagnostic(input);
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

    if (!response.ok) {
      return { success: false, userMessage: 'No pudimos enviar el reporte.', technicalCode: `desktop_error_report_failed_${response.status}` };
    }

    return { success: true, userMessage: 'Reporte enviado. Gracias por ayudarnos a corregir Forger.' };
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
  }): Promise<{ success: boolean; remoteBackup?: RemoteAppBackupSummary; userMessage: string; technicalCode?: string }> {
    const archive = await fs.readFile(input.archivePath);
    const form = new FormData();
    form.set('app_id', input.localBackup.appId);
    form.set('app_name', input.localBackup.appName);
    form.set('app_version', input.localBackup.appVersion);
    form.set('backup_type', input.backupType);
    form.set('source', input.source);
    form.set('file_count', String(input.localBackup.fileCount));
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

  private mapCatalogItem(appEntry: CatalogResponseItem | PublicCatalogResponseItem, includeDirectDownloadUrl: boolean): CatalogApp {
    const latestVersion = appEntry.latest_version;
    const backendEntry = appEntry as CatalogResponseItem;
    const recentRatings = Array.isArray(backendEntry.recent_ratings)
      ? backendEntry.recent_ratings.map((rating) => this.normalizeRating(rating)).filter((rating): rating is AppRatingSummary => Boolean(rating))
      : [];

    return {
      id: appEntry.slug,
      category: this.options.mapBackendCategory(appEntry.category),
      status: this.options.toCatalogStatus(appEntry.slug),
      name: appEntry.name,
      description: appEntry.short_description ?? appEntry.description ?? '',
      iconUrl: this.absoluteBackendUrl(appEntry.icon_url),
      beta: Boolean(appEntry.beta),
      latestVersionId: 'id' in (latestVersion ?? {}) ? (latestVersion as CatalogResponseItem['latest_version'])?.id : undefined,
      latestVersion: latestVersion?.version,
      requiredPythonVersion: latestVersion?.required_python_version ?? undefined,
      requiredNodeVersion: latestVersion?.required_node_version ?? undefined,
      checksumSha256: latestVersion?.checksum_sha256 ?? undefined,
      downloadUrl: includeDirectDownloadUrl ? latestVersion?.download_url ?? undefined : undefined,
      changelog: this.normalizeChangelog(latestVersion?.changelog, latestVersion?.version),
      capabilities: normalizeAppCapabilities(latestVersion?.capabilities ?? latestVersion?.permissions),
      version: latestVersion?.version,
      userMessage: this.options.getUserMessage(appEntry.slug),
      averageRating: this.normalizeNumber(backendEntry.average_rating),
      ratingsCount: this.normalizeNumber(backendEntry.ratings_count),
      recentRatings,
      currentUserRating: this.normalizeRating(backendEntry.current_user_rating),
    };
  }

  private absoluteBackendUrl(value: string | null | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    try {
      return new URL(value, this.options.backendBaseUrl).toString();
    } catch {
      return undefined;
    }
  }

  private normalizeNumber(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  }

  private normalizeChangelog(value: unknown, version?: string): CatalogApp['changelog'] {
    if (!value || typeof value !== 'object' || !version) {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const changes = Array.isArray(record.changes) ? record.changes.filter((entry): entry is string => typeof entry === 'string') : [];
    return {
      version,
      summary: typeof record.summary === 'string' ? record.summary : undefined,
      changes,
    };
  }

  private normalizeRating(value: unknown): AppRatingSummary | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }

    const record = value as Record<string, unknown>;
    const user = record.user && typeof record.user === 'object' ? record.user as Record<string, unknown> : undefined;
    return {
      id: Number(record.id),
      score: Number(record.score),
      comment: typeof record.comment === 'string' ? record.comment : null,
      forgerResponse: typeof record.forger_response === 'string' ? record.forger_response : null,
      createdAt: typeof record.created_at === 'string' ? record.created_at : undefined,
      updatedAt: typeof record.updated_at === 'string' ? record.updated_at : undefined,
      user: user
        ? {
            firstName: typeof user.first_name === 'string' ? user.first_name : undefined,
            lastInitial: typeof user.last_initial === 'string' ? user.last_initial : null,
          }
        : undefined,
    };
  }

  private normalizeCloudDevice(value: unknown): CloudDeviceSummary | undefined {
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
      paired: Boolean(record.paired),
      online: Boolean(record.online),
      lastSeenAt: typeof record.last_seen_at === 'string' ? record.last_seen_at : undefined,
      installedApps: apps,
    };
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
