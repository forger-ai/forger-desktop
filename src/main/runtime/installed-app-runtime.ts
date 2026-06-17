import { BrowserWindow } from 'electron';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type fs from 'node:fs/promises';
import type http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type net from 'node:net';
import type path from 'node:path';
import type { Duplex } from 'node:stream';

import type {
  AppManifest,
  AppManifestService,
  AppRegistry,
  RuntimeBinarySet,
  RunningAppProcess,
} from '../core/main-process-types';
import type { ForgerDeepLink } from '../deep-links';
import type {
  AppLastErrorOperation,
  AppSecretDeclaration,
  AppStatus,
  CloudFriendship,
  CloudFriendUser,
  FriendChatWindowOpenResult,
  OpenAppResult,
  RuntimeStatus,
  StopAppResult,
} from '../../shared/types';
import { normalizeLocale } from '../../shared/i18n';
import { mergePathEntry, spawnProcess } from './process-spawn';

interface RuntimeDeps {
  FORGER_PROTOCOL: string;
  app: Electron.App;
  appAgentConversationManager: { rejectPendingPermissionsForApp: (appId: string) => void } | null;
  appAgentTaskManager: { rejectPendingPermissionsForApp: (appId: string) => void } | null;
  appFolderGrantSecret: string;
  appWindows: Map<string, BrowserWindow>;
  appendInstallLog: (event: string, payload: Record<string, unknown>) => Promise<void>;
  desktopRuntimeBridge: { environmentForApp: (appId: string) => Record<string, string> } | null;
  getSpeechToTextEnvironment?: (manifest: AppManifest | null) => Record<string, string>;
  getTextToSpeechEnvironment?: (manifest: AppManifest | null) => Record<string, string>;
  getAudioInputEnvironment?: (manifest: AppManifest | null) => Record<string, string>;
  dispatchDeepLink: (link: ForgerDeepLink) => void;
  emitRuntimeStatus: (payload: RuntimeStatus) => void;
  ensureBackendPythonEnvironment: (pythonPath: string, backendDir: string, appId: string, reason: string) => Promise<void>;
  ensureCatalogStatuses: () => void;
  ensureRuntimeInstalled: (type: 'node' | 'python', version: string) => Promise<RuntimeBinarySet>;
  failureDiagnostic: (error: unknown, fallbackCode: string) => { technicalCode?: string; details?: Record<string, unknown>; sensitiveDetails?: Record<string, unknown> };
  formatProcessOutputForInstallLog: (text: string, secrets: string[]) => string;
  friendChatWindows: Map<number, BrowserWindow>;
  fs: typeof fs;
  getInstallLogPath: () => string;
  getBackendPathEntries: (appId: string) => Promise<string[]>;
  getLocalNetworkShareStatus?: (appId: string) => RuntimeStatus['localNetworkShare'];
  getManifestAppSecretsValidationError: (manifest: AppManifest | null) => string | null;
  getSecretsStore: () => {
    resolveAppEnv: (appId: string, declarations: AppSecretDeclaration[]) => Promise<{
      env: Record<string, string>;
      missingRequired: AppSecretDeclaration[];
      secretValues: string[];
    }>;
  };
  getVenvExecutables: (backendDir: string) => { python: string; pip: string };
  http: typeof http;
  isDev: boolean;
  isSecretsVaultUnavailableError: (error: unknown) => boolean;
  net: typeof net;
  normalizeManifestAppSecrets: (manifest: AppManifest | null) => AppSecretDeclaration[];
  normalizeNodeRuntimeVersion: (value?: string | null) => string;
  parseForgerUrl: (url: string) => ForgerDeepLink | null;
  path: typeof path;
  registry: AppRegistry;
  resolveInstalledManifest: (installDir: string) => Promise<AppManifest | null>;
  runCommand: (command: string, args: string[], options: Record<string, unknown> & { cwd: string }) => Promise<void>;
  runningApps: Map<string, RunningAppProcess>;
  serializeErrorForInstallLog: (error: unknown) => Record<string, unknown>;
  shell: Electron.Shell;
  stoppingApps: Set<string>;
  stopLocalNetworkShare?: (appId: string) => Promise<unknown>;
  stopRemoteNetworkShare?: (appId: string) => Promise<unknown>;
  syncAppToCloudIfEnabled: (appId: string) => Promise<void>;
  truncateForInstallLog: (value: string) => string;
  upsertInstalledRecord: (record: AppRegistry['apps'][string]) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
  withAppLifecycleLock: <T>(appId: string, operation: () => Promise<T>) => Promise<T>;
}

export const createInstalledAppRuntimeController = (deps: RuntimeDeps) => {
const { net, http, runCommand, app, registry, upsertInstalledRecord, ensureCatalogStatuses, appWindows, appAgentTaskManager, appAgentConversationManager, stoppingApps, runningApps, path, isDev, FORGER_PROTOCOL, parseForgerUrl, dispatchDeepLink, shell, friendChatWindows, wait, resolveInstalledManifest, getLocalNetworkShareStatus, getManifestAppSecretsValidationError, normalizeManifestAppSecrets, getSecretsStore, isSecretsVaultUnavailableError, normalizeNodeRuntimeVersion, appendInstallLog, getInstallLogPath, getBackendPathEntries, ensureRuntimeInstalled, ensureBackendPythonEnvironment, getVenvExecutables, desktopRuntimeBridge, getSpeechToTextEnvironment, getTextToSpeechEnvironment, getAudioInputEnvironment, appFolderGrantSecret, truncateForInstallLog, formatProcessOutputForInstallLog, serializeErrorForInstallLog, failureDiagnostic, emitRuntimeStatus, stopLocalNetworkShare, stopRemoteNetworkShare, syncAppToCloudIfEnabled, withAppLifecycleLock, fs } = deps;
const localNetworkShareStatusFor = getLocalNetworkShareStatus ?? (() => undefined);
const localNetworkSharePayloadFor = (appId: string) => {
  const status = localNetworkShareStatusFor(appId);
  return status ? { localNetworkShare: status } : {};
};
const stopLocalNetworkShareFor = stopLocalNetworkShare ?? (async () => undefined);
const stopRemoteNetworkShareFor = stopRemoteNetworkShare ?? (async () => undefined);
const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`startup_timeout_${url}`);
};

const getFreePort = async (): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('port_not_available'));
      }
      server.close();
    });
    server.on('error', reject);
  });
};

const hasPathPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const proxyHttpRequest = async (
  targetBaseUrl: string,
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  pathPrefix = '',
): Promise<void> => {
  const targetUrl = new URL(incoming.url ?? '/', targetBaseUrl);
  if (pathPrefix && hasPathPrefix(targetUrl.pathname, pathPrefix)) {
    targetUrl.pathname = targetUrl.pathname.slice(pathPrefix.length) || '/';
  }
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    incoming.on('end', () => resolve(Buffer.concat(chunks)));
    incoming.on('error', reject);
  });
  const response = await fetch(targetUrl, {
    method: incoming.method,
    headers: filterProxyRequestHeaders(incoming.headers),
    body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : fetchBodyFromBuffer(body),
  });
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) {
    if (['content-type', 'cache-control', 'etag', 'last-modified'].includes(key.toLowerCase())) {
      outgoing.setHeader(key, value);
    }
  }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
};

const proxyWebSocketUpgrade = (
  targetBaseUrl: string,
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathPrefix: string,
): void => {
  const incomingUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1');
  if (!hasPathPrefix(incomingUrl.pathname, pathPrefix)) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const targetUrl = new URL(incoming.url ?? '/', targetBaseUrl);
  targetUrl.pathname = targetUrl.pathname.slice(pathPrefix.length) || '/';
  const targetPort = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80));
  const targetSocket = net.connect(targetPort, targetUrl.hostname);
  let settled = false;

  const closeBoth = () => {
    socket.destroy();
    targetSocket.destroy();
  };

  targetSocket.on('connect', () => {
    settled = true;
    targetSocket.write(formatUpgradeRequest(incoming, targetUrl));
    if (head.length > 0) {
      targetSocket.write(head);
    }
    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });
  targetSocket.on('error', () => {
    if (!settled) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    closeBoth();
  });
  socket.on('error', closeBoth);
};

const formatUpgradeRequest = (incoming: IncomingMessage, targetUrl: URL): string => {
  const pathAndSearch = `${targetUrl.pathname}${targetUrl.search}`;
  const lines = [`${incoming.method ?? 'GET'} ${pathAndSearch} HTTP/${incoming.httpVersion}`];
  let hasHost = false;
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    const name = incoming.rawHeaders[index];
    const value = incoming.rawHeaders[index + 1] ?? '';
    if (name.toLowerCase() === 'host') {
      lines.push(`Host: ${targetUrl.host}`);
      hasHost = true;
      continue;
    }
    lines.push(`${name}: ${value}`);
  }
  if (!hasHost) {
    lines.push(`Host: ${targetUrl.host}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
};

const filterProxyRequestHeaders = (headers: IncomingMessage['headers']): Record<string, string> => {
  const allowed = new Set(['accept', 'accept-language', 'content-type']);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!allowed.has(key.toLowerCase()) || typeof value !== 'string') {
      continue;
    }
    result[key] = value;
  }
  return result;
};

const fetchBodyFromBuffer = (body: Buffer): ArrayBuffer =>
  body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;

const createLocalAppProxy = async (
  backendUrl: string,
  rawFrontendUrl: string,
): Promise<{ server: http.Server; url: string }> => {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const isApiRequest = hasPathPrefix(requestUrl.pathname, '/__forger_api');
    const target = isApiRequest ? backendUrl : rawFrontendUrl;
    const prefix = isApiRequest ? '/__forger_api' : '';
    void proxyHttpRequest(target, request, response, prefix).catch(() => {
      response.statusCode = 502;
      response.end('Forger app proxy failed.');
    });
  });
  server.on('upgrade', (request, socket, head) => {
    proxyWebSocketUpgrade(backendUrl, request, socket, head, '/__forger_api');
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('proxy_port_not_available'));
      }
    });
    server.on('error', reject);
  });
  return { server, url: `http://127.0.0.1:${port}` };
};

const closeServer = async (server: http.Server): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const terminateProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.killed) {
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      cwd: app.getPath('userData'),
    }).catch(() => {
      // best effort
    });
    return;
  }

  child.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const markAppRuntimeStatus = async (
  appId: string,
  status: Exclude<AppStatus, 'not_installed'>,
  userMessage: string,
  lastErrorOperation?: AppLastErrorOperation,
): Promise<void> => {
  const current = registry.apps[appId];
  if (!current) {
    return;
  }

  const nextStatus: Exclude<AppStatus, 'not_installed' | 'running'> = status === 'running' ? 'installed' : status;
  await upsertInstalledRecord({
    ...current,
    status: nextStatus,
    userMessage,
    lastErrorOperation: status === 'error' ? lastErrorOperation : undefined,
  });
  ensureCatalogStatuses();
};

const closeAppWindow = (appId: string): void => {
  const existing = appWindows.get(appId);
  appWindows.delete(appId);
  if (existing && !existing.isDestroyed()) {
    existing.close();
  }
};

const withAppLocale = (frontendUrl: string, locale?: string): string => {
  if (!locale) {
    return frontendUrl;
  }
  const url = new URL(frontendUrl);
  url.searchParams.set('forgerLocale', locale);
  return url.toString();
};

const loadDesktopWindow = async (window: BrowserWindow, query: Record<string, string> = {}): Promise<void> => {
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    await window.loadURL(url.toString());
    return;
  }

  await window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), { query });
};

const openOrFocusAppWindow = async (
  appId: string,
  appName: string,
  frontendUrl: string,
  locale?: string,
): Promise<void> => {
  const rawRuntimeLocale = locale?.trim() || null;
  if (rawRuntimeLocale) {
    const running = runningApps.get(appId);
    if (running) {
      running.locale = normalizeLocale(rawRuntimeLocale);
      running.rawLocale = rawRuntimeLocale;
    }
  }
  const localizedFrontendUrl = withAppLocale(frontendUrl, locale);
  const existing = appWindows.get(appId);
  if (existing && !existing.isDestroyed()) {
    const currentUrl = existing.webContents.getURL();
    const shouldLoadUrl = currentUrl !== localizedFrontendUrl;
    await appendInstallLog('app_window:existing_open_or_focus', {
      appId,
      currentUrl,
      targetUrl: localizedFrontendUrl,
      shouldLoadUrl,
    });
    if (shouldLoadUrl) {
      await appendInstallLog('app_window:existing_load_url', {
        appId,
        fromUrl: currentUrl,
        toUrl: localizedFrontendUrl,
      });
      await existing.loadURL(localizedFrontendUrl).catch(() => {
        // keep current URL if reload fails
      });
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.show();
    existing.focus();
    return;
  }

  const appPreloadPath = path.join(__dirname, '..', '..', 'preload', 'app.js');
  const appWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#F6F3EE',
    title: appName,
    autoHideMenuBar: true,
    webPreferences: {
      preload: appPreloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  appWindows.set(appId, appWindow);
  const expectedOrigin = new URL(localizedFrontendUrl).origin;
  const isAllowedAppUrl = (targetUrl: string): boolean => {
    try {
      return new URL(targetUrl).origin === expectedOrigin;
    } catch {
      return false;
    }
  };
  const openExternalUrl = (targetUrl: string): void => {
    try {
      const protocol = new URL(targetUrl).protocol;
      if (protocol === `${FORGER_PROTOCOL}:`) {
        // `forger://` URLs originated from an app's BrowserWindow are
        // routed in-process — same effect as the OS-level handler,
        // without the round-trip and without depending on the dev
        // build having protocol registration that survived rebuilds.
        const link = parseForgerUrl(targetUrl);
        if (link) dispatchDeepLink(link);
        return;
      }
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        void shell.openExternal(targetUrl);
      }
    } catch {
      // Ignore invalid navigation targets.
    }
  };

  appWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedAppUrl(targetUrl)) {
      event.preventDefault();
      openExternalUrl(targetUrl);
    }
  });
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAppUrl(url)) {
      void appWindow.loadURL(url);
      return { action: 'deny' };
    }
    openExternalUrl(url);
    return { action: 'deny' };
  });
  appWindow.on('closed', () => {
    appWindows.delete(appId);
    appAgentTaskManager?.rejectPendingPermissionsForApp(appId);
    appAgentConversationManager?.rejectPendingPermissionsForApp(appId);
    if (!stoppingApps.has(appId) && runningApps.has(appId)) {
      void stopInstalledApp(appId);
    }
  });

  await appWindow.loadURL(localizedFrontendUrl);
};

const openOrFocusFriendChatWindowForFriend = async (friend: CloudFriendUser): Promise<FriendChatWindowOpenResult> => {
  const friendUserId = friend.id;
  const friendUsername = friend.username;
  const displayName = friend.firstName?.trim() || friend.username;
  const existing = friendChatWindows.get(friendUserId);

  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }
    existing.show();
    existing.moveTop();
    existing.focus();
    await wait(150);

    if (existing.isFocused()) {
      return {
        action: 'focused-existing',
        userMessage: `El chat con @${friendUsername} ya estaba abierto. Lo reenfoqué.`,
      };
    }

    existing.flashFrame(true);
    setTimeout(() => existing.flashFrame(false), 3000);
    return {
      action: 'already-open',
      userMessage: `El chat con @${friendUsername} ya estaba abierto. Intenté traerlo al frente, pero puede seguir en otro Space de macOS.`,
    };
  }

  const preloadPath = path.join(__dirname, '..', '..', 'preload', 'index.js');
  const chatWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 520,
    backgroundColor: '#F6F3EE',
    title: `${displayName} · Social`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  friendChatWindows.set(friendUserId, chatWindow);
  chatWindow.on('closed', () => {
    friendChatWindows.delete(friendUserId);
  });

  await loadDesktopWindow(chatWindow, {
    socialChat: '1',
    friendUserId: String(friendUserId),
    friendUsername,
    friendDisplayName: displayName,
  });

  return {
    action: 'opened',
    userMessage: `Abrí el chat con @${friendUsername}.`,
  };
};

const openOrFocusFriendChatWindow = async (friendship: CloudFriendship): Promise<FriendChatWindowOpenResult> =>
  await openOrFocusFriendChatWindowForFriend(friendship.friend);

const findManifestService = (
  manifest: AppManifest | null,
  name: string,
  fallbackContext: string,
): AppManifestService | null => {
  const services = Array.isArray(manifest?.services) ? manifest.services : [];
  return services.find((service) => service.name === name)
    ?? services.find((service) => service.context === fallbackContext)
    ?? null;
};

const replaceCommandOption = (args: string[], option: string, value: string): string[] => {
  const next = [...args];
  const index = next.indexOf(option);
  if (index >= 0) {
    if (index + 1 < next.length) {
      next[index + 1] = value;
    } else {
      next.push(value);
    }
    return next;
  }
  next.push(option, value);
  return next;
};

const splitManifestCommand = (command: string | undefined): string[] =>
  command?.trim().split(/\s+/).filter(Boolean) ?? [];

const resolvePythonAppImport = (appPath: string): { appImport: string; pythonPath: string } => {
  const cleanPath = appPath.replace(/\\/g, '/').replace(/\.py$/i, '');
  const parts = cleanPath.split('/').filter(Boolean);
  const srcIndex = parts.indexOf('src');
  const moduleParts = srcIndex >= 0 ? parts.slice(srcIndex + 1) : parts;
  const pythonPath = srcIndex >= 0 ? parts.slice(0, srcIndex + 1).join('/') : '.';
  return {
    appImport: `${moduleParts.length ? moduleParts.join('.') : 'app.main'}:app`,
    pythonPath,
  };
};

const mergePythonPath = (
  environment: Record<string, string>,
  cwd: string,
  pythonPath: string,
): Record<string, string> => {
  const resolvedPythonPath = path.resolve(cwd, pythonPath);
  const currentPythonPath = environment.PYTHONPATH ?? process.env.PYTHONPATH;
  return {
    ...environment,
    PYTHONPATH: currentPythonPath
      ? `${resolvedPythonPath}${path.delimiter}${currentPythonPath}`
      : resolvedPythonPath,
  };
};

const translateManifestEnvironment = (
  environment: Record<string, string>,
  backendDir: string,
): Record<string, string> => {
  const appRoot = path.dirname(backendDir);
  const appDataDir = path.join(backendDir, 'data');
  const placeholders: Record<string, string> = {
    '{app_root}': appRoot,
    '{backend}': backendDir,
    '{app_data}': appDataDir,
  };
  const translated = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => {
      let resolved = value;
      for (const [placeholder, replacement] of Object.entries(placeholders)) {
        resolved = resolved.split(placeholder).join(replacement);
      }
      return [key, resolved];
    }),
  );
  const databaseUrl = translated.DATABASE_URL;
  const sqliteAppPrefix = 'sqlite:////app/';
  if (typeof databaseUrl === 'string' && databaseUrl.startsWith(sqliteAppPrefix)) {
    const relativeDbPath = databaseUrl.slice(sqliteAppPrefix.length);
    translated.DATABASE_URL = `sqlite:///${path.join(backendDir, relativeDbPath)}`;
  }
  return translated;
};

const ensureSqliteDatabaseParent = async (environment: Record<string, string>): Promise<void> => {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl?.startsWith('sqlite:///')) {
    return;
  }
  const filePath = databaseUrl.slice('sqlite:///'.length);
  if (!path.isAbsolute(filePath)) {
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
};

const summarizeBackendEnvironment = (environment: Record<string, string>): Record<string, string> => {
  const summary: Record<string, string> = {};
  for (const key of ['DATABASE_URL', 'PYTHONPATH', 'CORS_ORIGINS']) {
    const value = environment[key];
    if (typeof value === 'string' && value.trim()) {
      summary[key] = value;
    }
  }
  return summary;
};

const buildBackendProcessConfig = (
  service: AppManifestService | null,
  backendDir: string,
  python: string,
  port: number,
): { command: string; args: string[]; cwd: string; environment: Record<string, string> } => {
  const rawArgs = splitManifestCommand(service?.command);
  const fastapiIndex = rawArgs.indexOf('fastapi');
  const uvicornIndex = rawArgs.indexOf('uvicorn');
  const manifestEnvironment = service?.environment && typeof service.environment === 'object' ? service.environment : {};
  const environment = translateManifestEnvironment(manifestEnvironment, backendDir);
  const cwd = service?.context ? path.resolve(path.join(path.dirname(backendDir), service.context)) : backendDir;

  if (fastapiIndex >= 0 && rawArgs[fastapiIndex + 1] === 'dev') {
    const appPath = rawArgs[fastapiIndex + 2] && !rawArgs[fastapiIndex + 2].startsWith('-')
      ? rawArgs[fastapiIndex + 2]
      : 'src/app/main.py';
    const optionStartIndex = rawArgs[fastapiIndex + 2] && !rawArgs[fastapiIndex + 2].startsWith('-')
      ? fastapiIndex + 3
      : fastapiIndex + 2;
    const resolvedApp = resolvePythonAppImport(appPath);
    let args = ['-m', 'uvicorn', resolvedApp.appImport, ...rawArgs.slice(optionStartIndex)];
    args = replaceCommandOption(args, '--host', '127.0.0.1');
    args = replaceCommandOption(args, '--port', String(port));
    if (!args.includes('--reload')) {
      args.push('--reload');
    }
    return {
      command: python,
      args,
      cwd,
      environment: mergePythonPath(environment, cwd, resolvedApp.pythonPath),
    };
  }

  if (uvicornIndex >= 0) {
    const appImport = rawArgs[uvicornIndex + 1] && !rawArgs[uvicornIndex + 1].startsWith('-')
      ? rawArgs[uvicornIndex + 1]
      : 'app.main:app';
    const optionStartIndex = rawArgs[uvicornIndex + 1] && !rawArgs[uvicornIndex + 1].startsWith('-')
      ? uvicornIndex + 2
      : uvicornIndex + 1;
    let args = ['-m', 'uvicorn', appImport, ...rawArgs.slice(optionStartIndex)];
    args = replaceCommandOption(args, '--host', '127.0.0.1');
    args = replaceCommandOption(args, '--port', String(port));
    if (isDev && !args.includes('--reload')) {
      args.push('--reload');
    }
    return { command: python, args, cwd, environment };
  }

  const args = ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)];
  if (isDev) {
    args.push('--reload');
  }
  return { command: python, args, cwd, environment };
};

const normalizeHealthcheckPath = (healthcheck: string | undefined): string => {
  const value = healthcheck?.trim() || '/health';
  return value.startsWith('/') ? value : `/${value}`;
};

const openInstalledAppUnlocked = async (
  appId: string,
  locale?: string,
  options: { openWindow?: boolean } = {},
): Promise<OpenAppResult> => {
  const runtimeLocale = normalizeLocale(locale);
  const rawRuntimeLocale = locale?.trim() || null;
  const shouldOpenWindow = options.openWindow !== false;
  const record = registry.apps[appId];
  if (!record || !record.installDir) {
    return {
      success: false,
      userMessage: 'Primero instala esta app.',
      technicalCode: 'app_not_installed',
    };
  }
  if (record.status === 'conflict') {
    return {
      success: false,
      userMessage: 'Esta app necesita resolver una actualizacion antes de abrirse.',
      technicalCode: 'app_update_conflict',
    };
  }

  const running = runningApps.get(appId);
  if (running) {
    if (shouldOpenWindow) {
      await openOrFocusAppWindow(appId, record.name, running.frontendUrl, locale);
    }
    return {
      success: true,
      userMessage: 'La app ya esta en ejecucion.',
      backendUrl: running.backendUrl,
      frontendUrl: running.frontendUrl,
    };
  }

  const manifest = await resolveInstalledManifest(record.installDir);
  const appSecretsValidationError = getManifestAppSecretsValidationError(manifest);
  if (appSecretsValidationError) {
    return {
      success: false,
      userMessage: appSecretsValidationError,
      technicalCode: 'invalid_app_secrets_manifest',
    };
  }
  const appSecretDeclarations = normalizeManifestAppSecrets(manifest);
  let resolvedSecrets;
  try {
    resolvedSecrets = await getSecretsStore().resolveAppEnv(appId, appSecretDeclarations);
  } catch (error) {
    if (isSecretsVaultUnavailableError(error)) {
      return {
        success: false,
        userMessage: 'No pudimos leer los secretos guardados. Revisa el espacio seguro antes de abrir esta app.',
        technicalCode: 'secrets_vault_unavailable',
      };
    }
    if (error instanceof Error && error.message === 'secrets_encryption_unavailable') {
      return {
        success: false,
        userMessage: 'El sistema no tiene disponible el almacenamiento seguro de secretos.',
        technicalCode: 'secrets_encryption_unavailable',
      };
    }
    throw error;
  }
  if (resolvedSecrets.missingRequired.length > 0) {
    const missingLabels = resolvedSecrets.missingRequired
      .map((secret) => secret.label ?? secret.name)
      .join(', ');
    return {
      success: false,
      userMessage: `Conecta los secretos requeridos antes de abrir esta app: ${missingLabels}.`,
      technicalCode: 'required_app_secrets_missing',
    };
  }

  const nodeVersion = normalizeNodeRuntimeVersion(record.requiredNodeVersion);
  await appendInstallLog('open:start', {
    appId,
    installDir: record.installDir,
    requiredNodeVersion: nodeVersion,
    requiredPythonVersion: record.requiredPythonVersion,
    connectedSecrets: Object.keys(resolvedSecrets.env),
    logPath: getInstallLogPath(),
  });

  const nodeRuntime = await ensureRuntimeInstalled('node', nodeVersion);
  const pythonRuntime = await ensureRuntimeInstalled('python', record.requiredPythonVersion);

  const backendService = findManifestService(manifest, 'backend', './backend');
  const frontendService = findManifestService(manifest, 'frontend', './frontend');
  const backendDir = path.join(record.installDir, 'backend');
  const frontendDir = path.join(record.installDir, 'frontend');
  await ensureBackendPythonEnvironment(pythonRuntime.python as string, backendDir, appId, 'open_app');
  const venv = getVenvExecutables(backendDir);

  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const rawFrontendUrl = `http://127.0.0.1:${frontendPort}`;
  const proxy = await createLocalAppProxy(backendUrl, rawFrontendUrl);
  const frontendUrl = proxy.url;
  const backendConfig = buildBackendProcessConfig(backendService, backendDir, venv.python, backendPort);
  const frontendArgs = ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(frontendPort)];
  const backendHealthcheckPath = normalizeHealthcheckPath(backendService?.healthcheck);
  await ensureSqliteDatabaseParent(backendConfig.environment);
  const backendPathEntries = await getBackendPathEntries(appId);
  const backendPath = [...backendPathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);

  await appendInstallLog('open:spawn', {
    appId,
    backend: {
      command: backendConfig.command,
      args: backendConfig.args,
      cwd: backendConfig.cwd,
      url: backendUrl,
      healthcheck: backendHealthcheckPath,
      environment: summarizeBackendEnvironment({
        ...backendConfig.environment,
        CORS_ORIGINS: `${frontendUrl},${rawFrontendUrl},http://127.0.0.1:${frontendPort}`,
      }),
    },
    frontend: {
      command: nodeRuntime.npm,
      args: frontendArgs,
      cwd: frontendService?.context ? path.resolve(path.join(record.installDir, frontendService.context)) : frontendDir,
      url: frontendUrl,
    },
  });

  const backend = spawnProcess(
    backendConfig.command,
    backendConfig.args,
    {
      cwd: backendConfig.cwd,
      env: {
        ...process.env,
        ...backendConfig.environment,
        ...(desktopRuntimeBridge?.environmentForApp(appId) ?? {}),
        ...(getSpeechToTextEnvironment?.(manifest) ?? {}),
        ...(getTextToSpeechEnvironment?.(manifest) ?? {}),
        ...(getAudioInputEnvironment?.(manifest) ?? {}),
        ...resolvedSecrets.env,
        PATH: backendPath,
        CORS_ORIGINS: `${frontendUrl},${rawFrontendUrl},http://127.0.0.1:${frontendPort}`,
        FORGER_APP_ID: appId,
        FORGER_APP_GRANT_SECRET: appFolderGrantSecret,
      },
      stdio: 'pipe',
    },
  );

  const frontend = spawnProcess(nodeRuntime.npm as string, frontendArgs, {
    cwd: frontendService?.context ? path.resolve(path.join(record.installDir, frontendService.context)) : frontendDir,
    env: mergePathEntry({
      ...process.env,
      ...(frontendService?.environment && typeof frontendService.environment === 'object' ? frontendService.environment : {}),
      ...resolvedSecrets.env,
      VITE_API_BASE_URL: `${frontendUrl}/__forger_api`,
    }, path.dirname(nodeRuntime.node as string), path.delimiter),
    stdio: 'pipe',
  });

  backend.stdout.on('data', (chunk) => {
    void appendInstallLog('open:backend:stdout', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  backend.stderr.on('data', (chunk) => {
    void appendInstallLog('open:backend:stderr', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  backend.on('error', (error) => {
    void appendInstallLog('open:backend:error', {
      appId,
      error: serializeErrorForInstallLog(error),
    });
  });

  frontend.stdout.on('data', (chunk) => {
    void appendInstallLog('open:frontend:stdout', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  frontend.stderr.on('data', (chunk) => {
    void appendInstallLog('open:frontend:stderr', {
      appId,
      text: truncateForInstallLog(formatProcessOutputForInstallLog(chunk.toString(), resolvedSecrets.secretValues)),
    });
  });

  frontend.on('error', (error) => {
    void appendInstallLog('open:frontend:error', {
      appId,
      error: serializeErrorForInstallLog(error),
    });
  });

  const onProcessCrash = async (crashedProcess: ChildProcessWithoutNullStreams): Promise<void> => {
    if (stoppingApps.has(appId)) {
      return;
    }

    const running = runningApps.get(appId);
    if (!running) {
      return;
    }

    runningApps.delete(appId);
    stoppingApps.add(appId);
    try {
      await stopLocalNetworkShareFor(appId).catch(() => undefined);
      await stopRemoteNetworkShareFor(appId).catch(() => undefined);
      closeAppWindow(appId);
      const sibling = running.backend === crashedProcess ? running.frontend : running.backend;
      await terminateProcess(sibling).catch(() => undefined);
      await closeServer(running.proxyServer).catch(() => undefined);
    } finally {
      stoppingApps.delete(appId);
    }

    await markAppRuntimeStatus(appId, 'error', 'La app se detuvo por un error. Inicia de nuevo.', 'runtime');
    emitRuntimeStatus({
      appId,
      status: 'error',
      userMessage: 'La app se detuvo por un error. Inicia de nuevo.',
    });
  };

  backend.once('exit', (code, signal) => {
    void appendInstallLog('open:backend:exit', {
      appId,
      code,
      signal,
    });
    void onProcessCrash(backend);
  });

  frontend.once('exit', (code, signal) => {
    void appendInstallLog('open:frontend:exit', {
      appId,
      code,
      signal,
    });
    void onProcessCrash(frontend);
  });

  runningApps.set(appId, {
    appId,
    backend,
    frontend,
    backendUrl,
    frontendUrl,
    rawFrontendUrl,
    proxyServer: proxy.server,
    locale: runtimeLocale,
    rawLocale: rawRuntimeLocale,
  });

  try {
    await waitForHttpOk(`${backendUrl}${backendHealthcheckPath}`, 60_000);
    await waitForHttpOk(rawFrontendUrl, 60_000);
    await waitForHttpOk(frontendUrl, 60_000);
    if (shouldOpenWindow) {
      await openOrFocusAppWindow(appId, record.name, frontendUrl, locale);
    }
    await appendInstallLog('open:ready', {
      appId,
      backendUrl,
      frontendUrl,
    });

    await markAppRuntimeStatus(appId, 'running', 'App en ejecucion.');
    emitRuntimeStatus({
      appId,
      status: 'running',
      userMessage: 'App en ejecucion.',
      backendUrl,
      frontendUrl,
      ...localNetworkSharePayloadFor(appId),
    });

    ensureCatalogStatuses();

    return {
      success: true,
      userMessage: 'App abierta correctamente.',
      backendUrl,
      frontendUrl,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error, 'open_failed');
    await appendInstallLog('open:failed', {
      appId,
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(error),
    });

    await terminateProcess(backend);
    await terminateProcess(frontend);
    await closeServer(proxy.server).catch(() => undefined);
    runningApps.delete(appId);
    closeAppWindow(appId);
    await markAppRuntimeStatus(appId, 'error', 'No pudimos iniciar la app. Reintenta.', 'open');

    return {
      success: false,
      userMessage: 'No pudimos iniciar la app. Reintenta.',
      ...diagnostic,
    };
  }
};

const stopInstalledAppUnlocked = async (appId: string): Promise<StopAppResult> => {
  const running = runningApps.get(appId);
  if (!running) {
    return {
      success: true,
      userMessage: 'La app ya estaba detenida.',
    };
  }

  stoppingApps.add(appId);
  let stopError: unknown = null;
  try {
    await stopLocalNetworkShareFor(appId).catch(() => undefined);
    await stopRemoteNetworkShareFor(appId).catch(() => undefined);
    closeAppWindow(appId);
    for (const child of [running.backend, running.frontend]) {
      try {
        await terminateProcess(child);
      } catch (error) {
        stopError ??= error;
      }
    }
    await closeServer(running.proxyServer).catch(() => undefined);
  } finally {
    stoppingApps.delete(appId);
  }

  if (stopError) {
    const diagnostic = failureDiagnostic(stopError, 'stop_failed');
    await appendInstallLog('stop:failed', {
      appId,
      detail: diagnostic.technicalCode,
      error: serializeErrorForInstallLog(stopError),
    });
    return {
      success: false,
      userMessage: 'No pudimos detener la app. Reintenta.',
      ...diagnostic,
    };
  }

  runningApps.delete(appId);
  await markAppRuntimeStatus(appId, 'installed', 'App detenida.');
  emitRuntimeStatus({
    appId,
    status: 'installed',
    userMessage: 'App detenida.',
    ...localNetworkSharePayloadFor(appId),
  });
  ensureCatalogStatuses();
  await syncAppToCloudIfEnabled(appId).catch((error) => {
    void appendInstallLog('cloud_sync:auto_error', {
      appId,
      error: serializeErrorForInstallLog(error),
    });
  });

  return {
    success: true,
    userMessage: 'App detenida correctamente.',
  };
};

const openInstalledApp = async (appId: string, locale?: string): Promise<OpenAppResult> =>
  await withAppLifecycleLock(appId, async () => await openInstalledAppUnlocked(appId, locale));

const stopInstalledApp = async (appId: string): Promise<StopAppResult> =>
  await withAppLifecycleLock(appId, async () => await stopInstalledAppUnlocked(appId));

const restartInstalledApp = async (
  appId: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<OpenAppResult> =>
  await withAppLifecycleLock(appId, async () => {
    await appendInstallLog('restart:start', { appId });
    options.onProgress?.('Deteniendo la app...');
    const stop = await stopInstalledAppUnlocked(appId);
    await appendInstallLog('restart:stop_done', { appId, result: stop });
    if (!stop.success) {
      await appendInstallLog('restart:failed', { appId, phase: 'stop', result: stop });
      options.onProgress?.('No pude detener la app.');
      return {
        success: false,
        userMessage: stop.userMessage || 'No pudimos detener la app para reiniciarla.',
        technicalCode: stop.technicalCode ?? 'restart_stop_failed',
      };
    }

    options.onProgress?.('App detenida. Iniciando servicios locales y esperando que quede lista...');
    await appendInstallLog('restart:open_start', { appId });
    const open = await openInstalledAppUnlocked(appId);
    if (!open.success) {
      await appendInstallLog('restart:failed', { appId, phase: 'open', result: open });
      options.onProgress?.('La app se detuvo, pero no pude volver a abrirla.');
      if (!runningApps.has(appId)) {
        const current = registry.apps[appId];
        const nextStatus = current?.status === 'error' ? 'error' : 'installed';
        await markAppRuntimeStatus(appId, nextStatus, open.userMessage || 'La app quedo detenida.');
        emitRuntimeStatus({
          appId,
          status: nextStatus,
          userMessage: open.userMessage || 'La app quedo detenida.',
        });
      }
      return {
        ...open,
        userMessage: open.userMessage || 'La app se detuvo, pero no pudimos volver a abrirla.',
        technicalCode: open.technicalCode ?? 'restart_open_failed',
      };
    }

    await appendInstallLog('restart:ready', {
      appId,
      backendUrl: open.backendUrl,
      frontendUrl: open.frontendUrl,
    });
    options.onProgress?.('App reiniciada correctamente.');
    return {
      ...open,
      userMessage: 'App reiniciada correctamente.',
    };
  });

const getRuntimeStatus = (appId: string): RuntimeStatus => {
  const running = runningApps.get(appId);
  const record = registry.apps[appId];

  if (running) {
    return {
      appId,
      status: 'running',
      userMessage: 'App en ejecucion.',
      backendUrl: running.backendUrl,
      frontendUrl: running.frontendUrl,
      ...localNetworkSharePayloadFor(appId),
    };
  }

  if (!record) {
    return {
      appId,
      status: 'not_installed',
      userMessage: 'Aun no instalada.',
      ...localNetworkSharePayloadFor(appId),
    };
  }

  return {
    appId,
    status: record.status,
    userMessage: record.userMessage,
    ...localNetworkSharePayloadFor(appId),
  };
};

  return { waitForHttpOk, getFreePort, fetchBodyFromBuffer, createLocalAppProxy, closeServer, terminateProcess, closeAppWindow, loadDesktopWindow, openOrFocusAppWindow, openOrFocusFriendChatWindowForFriend, openOrFocusFriendChatWindow, findManifestService, splitManifestCommand, translateManifestEnvironment, ensureSqliteDatabaseParent, openInstalledAppUnlocked, openInstalledApp, stopInstalledApp, restartInstalledApp, getRuntimeStatus };
};
