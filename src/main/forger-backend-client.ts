import type {
  AppCategory,
  AppRatingSummary,
  AppStatus,
  CatalogApp,
  ForgerAccountLoginInput,
  ForgerAccountRegisterInput,
  ForgerAccountSession,
  SubmitAppFeedbackInput,
  SubmitAppRatingInput,
} from '../shared/types';
import { normalizeAppCapabilities } from '../shared/capabilities';
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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    const token = this.options.token();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
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
