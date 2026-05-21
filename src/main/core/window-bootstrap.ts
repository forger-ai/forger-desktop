
import type { App, BrowserWindow, IpcMain } from 'electron';
import type path from 'node:path';

import type { registerAgentIpcHandlers as registerAgentIpcHandlersFn } from '../ipc/agent-handlers';
import type { registerMainIpcHandlers as registerMainIpcHandlersFn } from '../ipc/main-handlers';
import {
  extractDeepLinkFromArgv,
  parseForgerUrl,
  registerForgerProtocol,
  type ForgerDeepLink,
} from '../deep-links';
import type { DesktopErrorReporter } from '../error-reporting';
import type { IPC_CHANNELS } from '../../shared/ipc';
import type { WindowControlState } from '../../shared/types';

interface WindowBootstrapState {
  mainWindow: BrowserWindow | null;
  pendingDeepLink: ForgerDeepLink | null;
}

interface WindowBootstrapDeps {
  BrowserWindow: typeof BrowserWindow;
  IPC_CHANNELS: typeof IPC_CHANNELS;
  app: App;
  desktopErrorReporter: DesktopErrorReporter | null;
  focusDeepLinkWindow: (window: BrowserWindow | null) => void;
  getMainProcessIpcDeps: () => unknown;
  getMainWindow: () => BrowserWindow | null;
  getWindowState: (window: BrowserWindow) => WindowControlState;
  ipcMain: IpcMain;
  isDev: boolean;
  loadDesktopWindow: (window: BrowserWindow) => Promise<void>;
  path: typeof path;
  registerAgentIpcHandlers: typeof registerAgentIpcHandlersFn;
  registerMainIpcHandlers: typeof registerMainIpcHandlersFn;
  registerWindowIpcHandlers: (deps: {
    ipcMain: IpcMain;
    getMainWindow: () => BrowserWindow | null;
    readWindowState: (window: BrowserWindow) => WindowControlState;
    quitApp: () => void;
  }) => void;
  registerWindowStateEvents: (window: BrowserWindow) => void;
  state: WindowBootstrapState;
  useCustomWindowFrame: boolean;
}

export const createWindowBootstrapController = (deps: WindowBootstrapDeps) => {
  const { state, path, app, BrowserWindow, isDev, useCustomWindowFrame, registerWindowStateEvents, desktopErrorReporter, loadDesktopWindow, getMainProcessIpcDeps, getMainWindow, registerMainIpcHandlers, registerAgentIpcHandlers, registerWindowIpcHandlers, ipcMain, getWindowState, focusDeepLinkWindow, IPC_CHANNELS } = deps;
const createWindow = async (): Promise<void> => {
  const preloadPath = path.join(__dirname, '..', '..', 'preload', 'index.js');

  state.mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#F6F3EE',
    title: isDev ? 'Forger Dev' : 'Forger',
    frame: !useCustomWindowFrame,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  registerWindowStateEvents(state.mainWindow);
  state.mainWindow.webContents.on('render-process-gone', (_event, details) => {
    desktopErrorReporter?.reportRendererProcessGone(details);
  });

  await loadDesktopWindow(state.mainWindow);
};

const registerIpcHandlers = (): void => {
  const deps = getMainProcessIpcDeps();
  registerMainIpcHandlers(deps as Parameters<typeof registerMainIpcHandlersFn>[0]);
  registerAgentIpcHandlers(deps as Parameters<typeof registerAgentIpcHandlersFn>[0]);

  registerWindowIpcHandlers({
    ipcMain,
    getMainWindow,
    readWindowState: getWindowState,
    quitApp: () => app.quit(),
  });
};
// ── Deep-link routing ────────────────────────────────────────────────
// Handles `forger://` URLs from any source (OS protocol activation,
// `open-url` on macOS, or `second-instance` re-entry on Win/Linux).
// Defers delivery to the renderer when the main window is not ready
// yet via `state.pendingDeepLink` + `flushPendingDeepLink`.

const dispatchDeepLink = (link: ForgerDeepLink): void => {
  if (!state.mainWindow || state.mainWindow.webContents.isLoading()) {
    state.pendingDeepLink = link;
    if (state.mainWindow) {
      // Window exists but content still loading — flush once the load
      // completes. Reusing `did-finish-load` over `dom-ready` because
      // the renderer needs its IPC subscriptions registered, which
      // happens during script execution.
      state.mainWindow.webContents.once('did-finish-load', flushPendingDeepLink);
    }
    return;
  }
  focusDeepLinkWindow(state.mainWindow);
  state.mainWindow.webContents.send(IPC_CHANNELS.deepLink, link);
};

const flushPendingDeepLink = (): void => {
  if (!state.pendingDeepLink || !state.mainWindow) return;
  const link = state.pendingDeepLink;
  state.pendingDeepLink = null;
  focusDeepLinkWindow(state.mainWindow);
  state.mainWindow.webContents.send(IPC_CHANNELS.deepLink, link);
};

const handleIncomingUrl = (rawUrl: string): void => {
  const link = parseForgerUrl(rawUrl);
  if (!link) return;
  dispatchDeepLink(link);
};

registerForgerProtocol();

// Single-instance lock: when the OS opens a `forger://` URL while a
// Desktop instance is already running, Electron spawns a second
// instance. `requestSingleInstanceLock` makes that second instance
// quit immediately and pipe its argv into the running one via
// `second-instance`, so we always have exactly one Desktop process
// handling deep-links.
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = extractDeepLinkFromArgv(argv);
    if (link) dispatchDeepLink(link);
    else focusDeepLinkWindow(state.mainWindow);
  });
}

// macOS path: the OS does not pass URLs in argv; it fires `open-url`
// (and re-fires it after activation if the URL arrived before ready).
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleIncomingUrl(url);
});

// Cold-start argv: on Windows/Linux a `forger://` URL is passed as the
// last argv entry. On macOS this is empty (URLs arrive via open-url).
const coldStartLink = extractDeepLinkFromArgv(process.argv);
if (coldStartLink) {
  state.pendingDeepLink = coldStartLink;
}

  return { createWindow, registerIpcHandlers, dispatchDeepLink, flushPendingDeepLink, handleIncomingUrl };
};
