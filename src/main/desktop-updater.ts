import { shell } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  DesktopUpdateAsset,
  DesktopUpdateMetadata,
  DesktopUpdateReleaseNotes,
  DesktopUpdateReleaseSummary,
  DesktopUpdateState,
} from '../shared/types';

const DEFAULT_METADATA_URL = 'https://forger-ai.github.io/desktop-versions/latest.json',
  SUPPORTED_INSTALLER_KINDS = new Set(['dmg', 'nsis', 'deb', 'appimage']);

interface DesktopUpdaterOptions {
  currentVersion: string;
  userDataPath: string;
  metadataUrl?: string;
  onStateChanged?: (state: DesktopUpdateState) => void;
}

const parseVersionParts = (value?: string): number[] | null => {
  if (!value) {
    return null;
  }
  const cleaned = value.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+(?:\.\d+){0,3})/);
  if (!match) {
    return null;
  }
  return match[1].split('.').map((part) => Number.parseInt(part, 10));
};

const isVersionNewer = (candidate?: string, current?: string): boolean => {
  const next = parseVersionParts(candidate);
  const prev = parseVersionParts(current);
  if (!next || !prev) {
    return Boolean(candidate && current && candidate !== current);
  }
  const length = Math.max(next.length, prev.length);
  for (let index = 0; index < length; index += 1) {
    const a = next[index] ?? 0;
    const b = prev[index] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isValidSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim());

const normalizeReleaseNotes = (value: unknown): DesktopUpdateReleaseNotes => {
  if (!isRecord(value)) {
    return { changes: [] };
  }
  const changes = Array.isArray(value.changes)
    ? value.changes.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  return {
    summary: typeof value.summary === 'string' && value.summary.trim() ? value.summary : undefined,
    changes,
  };
};

const releaseSummaryFromMetadata = (metadata: DesktopUpdateMetadata): DesktopUpdateReleaseSummary => ({
  version: metadata.version,
  publishedAt: metadata.publishedAt,
  summary: metadata.releaseNotes.summary ?? `Forger Desktop v${metadata.version}`,
});

const validateAsset = (value: unknown): DesktopUpdateAsset | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.platform !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.url !== 'string'
  ) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
    return null;
  }

  const asset: DesktopUpdateAsset = {
    platform: value.platform,
    arch: value.arch,
    kind: value.kind,
    url: value.url,
  };
  if (isValidSha256(value.sha256)) {
    asset.sha256 = value.sha256.trim().toLowerCase();
  }
  if (typeof value.size === 'number' && Number.isFinite(value.size) && value.size > 0) {
    asset.size = value.size;
  }
  if (value.experimental === true) {
    asset.experimental = true;
  }
  return asset;
};

const validateMetadata = (value: unknown): DesktopUpdateMetadata => {
  if (!isRecord(value)) {
    throw new Error('metadata_not_object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('metadata_schema_unsupported');
  }
  if (typeof value.version !== 'string' || !parseVersionParts(value.version)) {
    throw new Error('metadata_invalid_version');
  }
  if (typeof value.publishedAt !== 'string' || Number.isNaN(Date.parse(value.publishedAt))) {
    throw new Error('metadata_invalid_published_at');
  }
  if (!Array.isArray(value.assets)) {
    throw new Error('metadata_assets_missing');
  }

  const assets = value.assets.map(validateAsset).filter((asset): asset is DesktopUpdateAsset => Boolean(asset));
  if (assets.length === 0) {
    throw new Error('metadata_assets_invalid');
  }

  return {
    schemaVersion: 1,
    version: value.version,
    publishedAt: value.publishedAt,
    releaseNotes: normalizeReleaseNotes(value.releaseNotes),
    assets,
  };
};

const validateMetadataIndex = (value: unknown): DesktopUpdateMetadata[] => {
  if (!isRecord(value)) {
    throw new Error('metadata_index_not_object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('metadata_index_schema_unsupported');
  }
  if (!Array.isArray(value.releases)) {
    throw new Error('metadata_index_releases_missing');
  }
  return value.releases.map((entry) => {
    if (!isRecord(entry)) {
      return validateMetadata(entry);
    }
    return validateMetadata({
      ...entry,
      schemaVersion: entry.schemaVersion ?? value.schemaVersion,
      releaseNotes: entry.releaseNotes ?? { summary: entry.summary },
    });
  });
};

const indexUrlForMetadataUrl = (metadataUrl: string): string => {
  const parsed = new URL(metadataUrl);
  parsed.pathname = parsed.pathname.replace(/\/?[^/]*$/, '/index.json');
  return parsed.toString();
};

const getInstallerFilename = (asset: DesktopUpdateAsset, version: string): string => {
  const basename = path.basename(new URL(asset.url).pathname);
  const extensionByKind: Record<string, string> = {
    dmg: 'dmg',
    nsis: 'exe',
    deb: 'deb',
    appimage: 'AppImage',
  };
  const fallbackExtension = extensionByKind[asset.kind.toLowerCase()] ?? 'bin';
  const safeBasename = basename && !basename.includes('..') ? basename : `forger-desktop-${version}.${fallbackExtension}`;
  return safeBasename.endsWith(`.${fallbackExtension}`) ? safeBasename : `${safeBasename}.${fallbackExtension}`;
};

export class DesktopUpdater {
  private readonly currentVersion: string;
  private readonly metadataUrl: string;
  private readonly cacheDir: string;
  private readonly onStateChanged?: (state: DesktopUpdateState) => void;
  private state: DesktopUpdateState;

  constructor(options: DesktopUpdaterOptions) {
    this.currentVersion = options.currentVersion;
    this.metadataUrl = options.metadataUrl ?? process.env.FORGER_DESKTOP_UPDATE_URL ?? DEFAULT_METADATA_URL;
    this.cacheDir = path.join(options.userDataPath, 'desktop-updates');
    this.onStateChanged = options.onStateChanged;
    this.state = {
      status: 'idle',
      currentVersion: this.currentVersion,
      userMessage: 'Listo para revisar actualizaciones.',
    };
  }

  getState(): DesktopUpdateState {
    return { ...this.state };
  }

  async check(): Promise<DesktopUpdateState> {
    this.setState({
      status: 'checking',
      currentVersion: this.currentVersion,
      userMessage: 'Revisando actualizaciones de Forger Desktop...',
      progress: undefined,
      downloadedBytes: undefined,
      totalBytes: undefined,
      technicalCode: undefined,
    });

    try {
      const metadataIndex = await this.fetchMetadataIndex().catch(() => null);
      const response = await fetch(this.metadataUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`metadata_http_${response.status}`);
      }
      const metadata = validateMetadata(await response.json());
      const pendingReleaseSummaries = this.pendingReleaseSummaries(metadataIndex, metadata.version);
      const base = {
        currentVersion: this.currentVersion,
        availableVersion: metadata.version,
        publishedAt: metadata.publishedAt,
        releaseNotes: metadata.releaseNotes,
        pendingReleaseSummaries,
      };

      if (!isVersionNewer(metadata.version, this.currentVersion)) {
        return this.setState({
          ...base,
          status: 'up_to_date',
          userMessage: 'Ya tienes la version mas reciente de Forger Desktop.',
          asset: undefined,
          downloadedPath: undefined,
        });
      }

      const asset = metadata.assets.find(
        (candidate) =>
          candidate.platform === process.platform &&
          candidate.arch === process.arch &&
          SUPPORTED_INSTALLER_KINDS.has(candidate.kind.toLowerCase()),
      );
      if (!asset) {
        return this.setState({
          ...base,
          status: 'unsupported',
          userMessage: 'Hay una version nueva, pero no hay instalador compatible para este computador.',
          technicalCode: `unsupported_${process.platform}_${process.arch}`,
          asset: undefined,
          downloadedPath: undefined,
        });
      }

      return this.setState({
        ...base,
        status: 'available',
        asset,
        downloadedPath: undefined,
        userMessage: 'Hay una actualizacion de Forger Desktop disponible.',
      });
    } catch (error) {
      return this.setError('No pudimos revisar actualizaciones de Forger Desktop.', error);
    }
  }

  async download(): Promise<DesktopUpdateState> {
    let state = this.getState();
    if (state.status === 'idle' || state.status === 'up_to_date' || state.status === 'error') {
      state = await this.check();
    }
    if (state.status !== 'available' || !state.asset || !state.availableVersion) {
      return this.setError('No hay una actualizacion lista para descargar.', state.technicalCode ?? state.status);
    }

    const asset = state.asset;
    const version = state.availableVersion;
    const filename = getInstallerFilename(asset, version);
    const destinationPath = path.join(this.cacheDir, version, filename);
    const tempPath = `${destinationPath}.download`;

    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.rm(tempPath, { force: true });

      const response = await fetch(asset.url);
      if (!response.ok) {
        throw new Error(`download_http_${response.status}`);
      }

      const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      const totalBytes = asset.size ?? (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined);
      this.setState({
        ...state,
        status: 'downloading',
        progress: 0,
        downloadedBytes: 0,
        totalBytes,
        userMessage: 'Descargando actualizacion de Forger Desktop...',
      });

      const hash = createHash('sha256');
      let downloadedBytes = 0;
      const file = await fs.open(tempPath, 'w');
      try {
        if (!response.body) {
          const buffer = Buffer.from(await response.arrayBuffer());
          hash.update(buffer);
          downloadedBytes = buffer.byteLength;
          await file.write(buffer, 0, buffer.byteLength, 0);
        } else {
          const reader = response.body.getReader();
          let offset = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const chunk = Buffer.from(value);
            hash.update(chunk);
            await file.write(chunk, 0, chunk.byteLength, offset);
            offset += chunk.byteLength;
            downloadedBytes += chunk.byteLength;
            this.setState({
              ...this.state,
              downloadedBytes,
              totalBytes,
              progress: totalBytes ? Math.min(1, downloadedBytes / totalBytes) : undefined,
            });
          }
        }
      } finally {
        await file.close();
      }

      const sha256 = hash.digest('hex');
      if (asset.sha256 && sha256 !== asset.sha256.toLowerCase()) {
        await fs.rm(tempPath, { force: true });
        throw new Error('checksum_mismatch');
      }

      await fs.rename(tempPath, destinationPath);
      return this.setState({
        ...this.state,
        status: 'ready',
        progress: 1,
        downloadedBytes,
        totalBytes: totalBytes ?? downloadedBytes,
        downloadedPath: destinationPath,
        userMessage: 'La actualizacion esta lista para instalar.',
      });
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      return this.setError('No pudimos descargar la actualizacion de Forger Desktop.', error);
    }
  }

  async install(): Promise<DesktopUpdateState> {
    const state = this.getState();
    if (state.status !== 'ready' || !state.downloadedPath) {
      return this.setError('Descarga la actualizacion antes de instalarla.', state.status);
    }

    try {
      const openError = await shell.openPath(state.downloadedPath);
      if (openError) {
        throw new Error(openError);
      }
      return this.setState({
        ...state,
        userMessage: 'Abrimos el instalador. Sigue los pasos del sistema para completar la actualizacion.',
      });
    } catch (error) {
      return this.setError('No pudimos abrir el instalador de Forger Desktop.', error);
    }
  }

  private async fetchMetadataIndex(): Promise<DesktopUpdateMetadata[]> {
    const response = await fetch(indexUrlForMetadataUrl(this.metadataUrl), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`metadata_index_http_${response.status}`);
    }
    return validateMetadataIndex(await response.json());
  }

  private pendingReleaseSummaries(
    metadataIndex: DesktopUpdateMetadata[] | null,
    latestVersion: string,
  ): DesktopUpdateReleaseSummary[] {
    const releases = metadataIndex
      ?.filter((entry) => isVersionNewer(entry.version, this.currentVersion) && !isVersionNewer(entry.version, latestVersion))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      ?? [];
    return releases.map(releaseSummaryFromMetadata);
  }

  private setError(userMessage: string, error: unknown): DesktopUpdateState {
    const technicalCode = error instanceof Error ? error.message : String(error);
    return this.setState({
      ...this.state,
      status: 'error',
      userMessage,
      technicalCode,
    });
  }

  private setState(nextState: DesktopUpdateState): DesktopUpdateState {
    this.state = { ...nextState };
    this.onStateChanged?.(this.getState());
    return this.getState();
  }
}
