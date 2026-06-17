import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnProcess } from './runtime/process-spawn';

const DEV_CATALOG_HOST = '127.0.0.1';
const DEV_CATALOG_PORT = 8765;
const DEFAULT_RUNTIME_STACK = 'vite_fastapi_sqlite';

type JsonObject = Record<string, unknown>;

interface LocalApp {
  catalogSlug: string;
  sourceSlug: string;
  appDir: string;
  manifest: JsonObject;
}

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.idea',
  '.vscode',
  '.venv',
  '__pycache__',
  'node_modules',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  'dist',
  'build',
]);

const EXCLUDED_RELATIVE_PATHS = new Set(['backend/data', 'frontend/node_modules']);
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store']);
const EXCLUDED_EXTENSIONS = new Set(['.pyc', '.pyo']);
const COMMONS_OVERLAY_FILES = [
  ['commons/backend/database.py', 'backend/src/app/database.py'],
  ['commons/backend/health.py', 'backend/src/app/health.py'],
  ['commons/backend/cors.py', 'backend/src/app/cors.py'],
  ['commons/backend/forger_desktop.py', 'backend/src/app/forger_desktop.py'],
  ['commons/backend/mcp_runtime.py', 'backend/src/app/mcp_runtime.py'],
  ['commons/backend/remote_tunnel.py', 'backend/src/app/remote_tunnel.py'],
  ['commons/frontend/client.ts', 'frontend/src/api/client.ts'],
  ['commons/frontend/query.ts', 'frontend/src/api/query.ts'],
  ['commons/frontend/forgerBrand.ts', 'frontend/src/api/forgerBrand.ts'],
  ['commons/frontend/remoteTunnel.ts', 'frontend/src/api/remoteTunnel.ts'],
  ['commons/frontend/realtime.ts', 'frontend/src/api/realtime.ts'],
] as const;

const isRecord = (value: unknown): value is JsonObject => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const asRecord = (value: unknown): JsonObject => (isRecord(value) ? value : {});

const asString = (value: unknown, fallback = ''): string => {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

const safeJson = (payload: unknown): Buffer => Buffer.from(JSON.stringify(payload, null, 2), 'utf8');

const readDevVersionOverride = async (appDir: string): Promise<string | undefined> => {
  const raw = await fsp.readFile(path.join(appDir, '.version.dev'), 'utf8').catch(() => '');
  const version = raw.trim();
  return version || undefined;
};

const runCommand = async (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> => {
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error('command_timeout'));
        }, options.timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`command_failed_${code}: ${stdout}\n${stderr}`));
    });
  });
};

const getGitValue = async (appDir: string, args: string[]): Promise<string | undefined> => {
  try {
    const result = await runCommand('git', ['-C', appDir, ...args], { cwd: appDir, timeoutMs: 5_000 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};

const getGitDirty = async (appDir: string): Promise<boolean | undefined> => {
  try {
    const result = await runCommand('git', ['-C', appDir, 'status', '--porcelain'], {
      cwd: appDir,
      timeoutMs: 5_000,
    });
    return result.stdout.trim().length > 0;
  } catch {
    return undefined;
  }
};

const parseLocalAppPaths = (): string[] => {
  const raw = process.env.FORGER_LOCAL_APPS ?? '';
  const paths = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
  return Array.from(new Set(paths));
};

const readLocalApps = async (): Promise<LocalApp[]> => {
  const apps: LocalApp[] = [];
  for (const appDir of parseLocalAppPaths()) {
    const manifestPath = path.join(appDir, 'manifest.json');
    try {
      const manifestStat = await fsp.stat(manifestPath);
      if (!manifestStat.isFile()) {
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as JsonObject;
    const sourceSlug = asString(manifest.name, path.basename(appDir));
    apps.push({
      catalogSlug: `${sourceSlug}-dev`,
      sourceSlug,
      appDir,
      manifest,
    });
  }
  return apps;
};

const getRuntimeStack = (manifest: JsonObject): string => {
  const catalog = asRecord(manifest.catalog);
  return asString(catalog.runtime_stack, DEFAULT_RUNTIME_STACK);
};

const getCatalogStatus = (app: LocalApp, catalog: JsonObject): string => {
  return asString(catalog.status, app.sourceSlug === 'finance-os' ? 'beta' : 'coming');
};

const optionalArray = (value: unknown): unknown[] | undefined => {
  return Array.isArray(value) ? value : undefined;
};

const optionalRecord = (value: unknown): JsonObject | undefined => {
  return isRecord(value) ? value : undefined;
};

const getIconUrl = (app: LocalApp, catalog: JsonObject, baseUrl: string): string | undefined => {
  const iconPath = asString(catalog.icon_path);
  if (!iconPath) {
    return undefined;
  }
  return `${baseUrl}/assets/${encodeURIComponent(app.catalogSlug)}/${iconPath.split('/').map(encodeURIComponent).join('/')}`;
};

const getDevDisplayName = (app: LocalApp, catalog: JsonObject): string => {
  const displayName = asString(catalog.display_name, app.sourceSlug);
  return /\bdev$/i.test(displayName) ? displayName : `${displayName} Dev`;
};

const toCatalogEntry = async (app: LocalApp, baseUrl: string): Promise<JsonObject> => {
  const catalog = asRecord(app.manifest.catalog);
  const stack = asRecord(app.manifest.stack);
  const backend = asRecord(stack.backend);
  const frontend = asRecord(stack.frontend);
  const version = asString(app.manifest.version, '0.0.0');
  const devVersion = (await readDevVersionOverride(app.appDir)) ?? `${version}-dev`;
  const branch = await getGitValue(app.appDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const runtimeStack = getRuntimeStack(app.manifest);

  return {
    slug: app.catalogSlug,
    name: getDevDisplayName(app, catalog),
    short_description: asString(catalog.short_description),
    description: asString(catalog.description, asString(app.manifest.description)),
    category: asString(catalog.category, 'utilities'),
    icon_url: getIconUrl(app, catalog, baseUrl),
    status: getCatalogStatus(app, catalog),
    runtime_stack: runtimeStack,
    latest_version: {
      version: devVersion,
      runtime_stack: runtimeStack,
      required_python_version: asString(backend.python_version),
      required_node_version: asString(frontend.node_version),
      supported_platforms: Array.isArray(catalog.supported_platforms)
        ? catalog.supported_platforms
        : ['darwin_arm64', 'darwin_x64', 'linux_x64', 'win32_x64'],
      localNetworkShare: app.manifest.localNetworkShare === true,
      remoteTunnel: app.manifest.remoteTunnel === true,
      agents: optionalArray(app.manifest.agents),
      prompt_templates: optionalArray(app.manifest.promptTemplates),
      tools: optionalRecord(app.manifest.tools),
      download_url: `${baseUrl}/download/${encodeURIComponent(app.catalogSlug)}.zip`,
      file_size_bytes: null,
      checksum_sha256: null,
      published_at: new Date().toISOString(),
      changelog: {
        version: devVersion,
        summary: 'Local development build.',
        changes: [`Empaquetado desde ${app.appDir}`, branch ? `Branch local: ${branch}` : 'Branch local no disponible'],
      },
    },
    dev: {
      source: 'local_app',
      source_slug: app.sourceSlug,
      workspace_path: app.appDir,
      branch,
      dirty: await getGitDirty(app.appDir),
    },
  };
};

const shouldSkip = (sourcePath: string, root: string): boolean => {
  const relative = path.relative(root, sourcePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  const normalized = relative.split(path.sep).join('/');
  const parts = normalized.split('/');
  if (parts.some((part) => EXCLUDED_DIR_NAMES.has(part))) {
    return true;
  }
  if (EXCLUDED_RELATIVE_PATHS.has(parts.slice(0, 2).join('/'))) {
    return true;
  }
  if (EXCLUDED_FILE_NAMES.has(path.basename(sourcePath))) {
    return true;
  }
  if (EXCLUDED_EXTENSIONS.has(path.extname(sourcePath))) {
    return true;
  }
  return false;
};

const copyFiltered = async (sourceRoot: string, targetRoot: string, current = sourceRoot): Promise<void> => {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(current, entry.name);
    if (shouldSkip(sourcePath, sourceRoot)) {
      continue;
    }

    const relative = path.relative(sourceRoot, sourcePath);
    const targetPath = path.join(targetRoot, relative);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await fsp.mkdir(targetPath, { recursive: true });
      await copyFiltered(sourceRoot, targetRoot, sourcePath);
      continue;
    }
    if (entry.isFile()) {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
};

const applyCommonsOverlay = async (sourceRoot: string, targetRoot: string): Promise<void> => {
  for (const [sourceRelativePath, targetRelativePath] of COMMONS_OVERLAY_FILES) {
    const sourcePath = path.join(sourceRoot, sourceRelativePath);
    const targetPath = path.join(targetRoot, targetRelativePath);
    try {
      const stat = await fsp.stat(sourcePath);
      if (!stat.isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(sourcePath, targetPath);
  }
};

const zipDirectory = async (sourceDir: string, zipPath: string): Promise<void> => {
  if (process.platform === 'win32') {
    const escapedSource = path.join(sourceDir, '*').replace(/'/g, "''");
    const escapedZip = zipPath.replace(/'/g, "''");
    await runCommand(
      'powershell',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${escapedSource}' -DestinationPath '${escapedZip}' -Force`],
      { cwd: sourceDir, timeoutMs: 120_000 },
    );
    return;
  }

  await runCommand('zip', ['-qry', zipPath, '.'], { cwd: sourceDir, timeoutMs: 120_000 });
};

const makeLocalAppZip = async (app: LocalApp): Promise<{ zipPath: string; checksum: string; size: number; cleanup: () => void }> => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'forger-dev-catalog-'));
  const stageDir = path.join(tempRoot, 'stage');
  const zipPath = path.join(tempRoot, `${app.catalogSlug}.zip`);
  await fsp.mkdir(stageDir, { recursive: true });
  await copyFiltered(app.appDir, stageDir);
  await applyCommonsOverlay(app.appDir, stageDir);
  await zipDirectory(stageDir, zipPath);
  const buffer = await fsp.readFile(zipPath);
  return {
    zipPath,
    checksum: createHash('sha256').update(buffer).digest('hex'),
    size: buffer.length,
    cleanup: () => {
      void fsp.rm(tempRoot, { recursive: true, force: true });
    },
  };
};

const sendJson = (response: ServerResponse, payload: unknown, statusCode = 200): void => {
  const body = safeJson(payload);
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  });
  response.end(body);
};

const sendNotFound = (response: ServerResponse): void => {
  sendJson(response, { error: 'not_found' }, 404);
};

export const __testDevCatalogInternals = {
  applyCommonsOverlay,
  readDevVersionOverride,
  runCommand,
  shouldSkip,
  zipDirectory,
};

export class DevCatalogService {
  private server: http.Server | null = null;
  private port: number;

  constructor(port = DEV_CATALOG_PORT) {
    this.port = port;
  }

  get url(): string {
    return `http://${DEV_CATALOG_HOST}:${this.port}/catalog.json`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.port, DEV_CATALOG_HOST, () => {
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        this.server?.off('error', reject);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private baseUrl(): string {
    return `http://${DEV_CATALOG_HOST}:${this.port}`;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? '/', this.baseUrl());
      if (request.method !== 'GET') {
        return sendJson(response, { error: 'method_not_allowed' }, 405);
      }

      if (requestUrl.pathname === '/' || requestUrl.pathname === '/health') {
        const apps = await readLocalApps();
        sendJson(response, {
          ok: true,
          local_apps: apps.map((app) => app.catalogSlug),
        });
        return;
      }

      if (requestUrl.pathname === '/catalog.json') {
        const localApps = await readLocalApps();
        const localCatalog = await Promise.all(localApps.map((app) => toCatalogEntry(app, this.baseUrl())));
        sendJson(response, localCatalog);
        return;
      }

      const assetMatch = /^\/assets\/([^/]+)\/(.+)$/.exec(requestUrl.pathname);
      if (assetMatch) {
        await this.handleAsset(
          decodeURIComponent(assetMatch[1] ?? ''),
          decodeURIComponent(assetMatch[2] ?? ''),
          response,
        );
        return;
      }

      const downloadMatch = /^\/download\/([^/]+)\.zip$/.exec(requestUrl.pathname);
      if (downloadMatch) {
        await this.handleDownload(decodeURIComponent(downloadMatch[1] ?? ''), response);
        return;
      }

      sendNotFound(response);
    } catch (error) {
      sendJson(response, { error: 'dev_catalog_error', detail: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async handleDownload(catalogSlug: string, response: ServerResponse): Promise<void> {
    const app = (await readLocalApps()).find((candidate) => candidate.catalogSlug === catalogSlug);
    if (!app) {
      sendJson(response, { error: 'app_not_found', slug: catalogSlug }, 404);
      return;
    }

    const bundle = await makeLocalAppZip(app);
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${app.catalogSlug}.zip"`,
      'Content-Length': String(bundle.size),
      'X-Forger-Checksum-Sha256': bundle.checksum,
    });

    const stream = fs.createReadStream(bundle.zipPath);
    stream.pipe(response);
    stream.on('close', bundle.cleanup);
    stream.on('error', () => {
      bundle.cleanup();
      response.destroy();
    });
  }

  private async handleAsset(catalogSlug: string, relativePath: string, response: ServerResponse): Promise<void> {
    const app = (await readLocalApps()).find((candidate) => candidate.catalogSlug === catalogSlug);
    if (!app) {
      sendJson(response, { error: 'app_not_found', slug: catalogSlug }, 404);
      return;
    }

    const catalog = asRecord(app.manifest.catalog);
    const iconPath = asString(catalog.icon_path);
    if (!iconPath || relativePath !== iconPath) {
      sendNotFound(response);
      return;
    }

    const appRoot = await fsp.realpath(app.appDir);
    const assetPath = path.resolve(appRoot, iconPath);
    const realAssetPath = await fsp.realpath(assetPath).catch(() => null);
    if (!realAssetPath || !realAssetPath.startsWith(`${appRoot}${path.sep}`)) {
      sendNotFound(response);
      return;
    }

    const extension = path.extname(realAssetPath).toLowerCase();
    const contentType =
      extension === '.png'
        ? 'image/png'
        : extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.webp'
            ? 'image/webp'
            : extension === '.svg'
              ? 'image/svg+xml'
              : 'application/octet-stream';
    const stat = await fsp.stat(realAssetPath);
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
    });
    fs.createReadStream(realAssetPath).pipe(response);
  }
}
