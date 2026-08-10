import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  clearDistModule,
  createElectronAppMock,
  createIpcMainRecorder,
  withMockedElectron,
} from './electron-test-helpers.mjs';

const loadWindowModule = async (BrowserWindow) =>
  await withMockedElectron({ BrowserWindow }, (require) => {
    clearDistModule('main/ipc/window.js');
    return require('../../dist-electron/main/ipc/window.js');
  });

const loadMicrophonePermissions = async (systemPreferences) =>
  await withMockedElectron({ systemPreferences }, (require) => {
    clearDistModule('main/ipc/microphone-permissions.js');
    return require('../../dist-electron/main/ipc/microphone-permissions.js');
  });

const withPlatform = async (platform, callback) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

const createShellMock = (overrides = {}) => ({
  openExternal: async () => undefined,
  openPath: async () => '',
  ...overrides,
});

const createWindowDouble = (overrides = {}) => {
  const events = new Map();
  const sends = [];
  return {
    events,
    sends,
    closeCalls: 0,
    maximizeCalls: 0,
    minimizeCalls: 0,
    unmaximizeCalls: 0,
    destroyed: false,
    fullScreen: false,
    maximized: false,
    webContents: {
      send(channel, payload) {
        sends.push([channel, payload]);
      },
    },
    close() {
      this.closeCalls += 1;
    },
    isDestroyed() {
      return this.destroyed;
    },
    isFullScreen() {
      return this.fullScreen;
    },
    isMaximized() {
      return this.maximized;
    },
    maximize() {
      this.maximizeCalls += 1;
      this.maximized = true;
    },
    minimize() {
      this.minimizeCalls += 1;
    },
    on(event, listener) {
      events.set(event, listener);
    },
    unmaximize() {
      this.unmaximizeCalls += 1;
      this.maximized = false;
    },
    ...overrides,
  };
};

test('window IPC handlers register expected channels and operate on the invoking BrowserWindow', async () => {
  const senderToWindow = new Map();
  const BrowserWindow = {
    fromWebContents(sender) {
      return senderToWindow.get(sender) ?? null;
    },
  };
  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  const { createWindowStateReader, registerWindowIpcHandlers } = await loadWindowModule(BrowserWindow);
  const { handlers, ipcMain } = createIpcMainRecorder();
  const mainWindow = createWindowDouble();
  const childWindow = createWindowDouble();
  const mainSender = { id: 1 };
  const childSender = { id: 2 };
  senderToWindow.set(mainSender, mainWindow);
  senderToWindow.set(childSender, childWindow);

  let quitCalls = 0;
  registerWindowIpcHandlers({
    ipcMain,
    getMainWindow: () => mainWindow,
    readWindowState: createWindowStateReader(true),
    quitApp: () => {
      quitCalls += 1;
    },
  });

  assert.deepEqual([...handlers.keys()], [
    IPC_CHANNELS.windowMinimize,
    IPC_CHANNELS.windowToggleMaximize,
    IPC_CHANNELS.windowClose,
    IPC_CHANNELS.windowGetState,
  ]);

  await handlers.get(IPC_CHANNELS.windowMinimize)({ sender: childSender });
  const maximizedState = await handlers.get(IPC_CHANNELS.windowToggleMaximize)({ sender: childSender });
  const restoredState = await handlers.get(IPC_CHANNELS.windowToggleMaximize)({ sender: childSender });
  const currentState = await handlers.get(IPC_CHANNELS.windowGetState)({ sender: childSender });
  await handlers.get(IPC_CHANNELS.windowClose)({ sender: childSender });
  await handlers.get(IPC_CHANNELS.windowClose)({ sender: mainSender });

  assert.equal(childWindow.minimizeCalls, 1);
  assert.equal(childWindow.maximizeCalls, 1);
  assert.equal(childWindow.unmaximizeCalls, 1);
  assert.equal(childWindow.closeCalls, 1);
  assert.equal(mainWindow.closeCalls, 0);
  assert.equal(quitCalls, 1);
  assert.deepEqual(maximizedState, { isMaximized: true, isFullScreen: false, usesCustomFrame: true });
  assert.deepEqual(restoredState, { isMaximized: false, isFullScreen: false, usesCustomFrame: true });
  assert.deepEqual(currentState, { isMaximized: false, isFullScreen: false, usesCustomFrame: true });
});

test('window IPC reports missing invoking windows as explicit error paths', async () => {
  const BrowserWindow = { fromWebContents: () => null };
  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  const { registerWindowIpcHandlers } = await loadWindowModule(BrowserWindow);
  const { handlers, ipcMain } = createIpcMainRecorder();

  registerWindowIpcHandlers({
    ipcMain,
    getMainWindow: () => null,
    readWindowState: () => ({ isMaximized: false, isFullScreen: false, usesCustomFrame: false }),
    quitApp: () => {},
  });

  await assert.rejects(
    handlers.get(IPC_CHANNELS.windowToggleMaximize)({ sender: {} }),
    /window_not_found/,
  );
  await assert.rejects(
    handlers.get(IPC_CHANNELS.windowGetState)({ sender: {} }),
    /window_not_found/,
  );
  await assert.doesNotReject(handlers.get(IPC_CHANNELS.windowMinimize)({ sender: {} }));
  await assert.doesNotReject(handlers.get(IPC_CHANNELS.windowClose)({ sender: {} }));
});

test('window state event registrar sends current state and suppresses destroyed windows', async () => {
  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  const { createWindowStateEventRegistrar } = await loadWindowModule({});
  const window = createWindowDouble();

  createWindowStateEventRegistrar(() => ({ isMaximized: true, isFullScreen: false, usesCustomFrame: true }))(window);

  assert.deepEqual([...window.events.keys()], [
    'maximize',
    'unmaximize',
    'restore',
    'enter-full-screen',
    'leave-full-screen',
  ]);

  window.events.get('maximize')();
  window.destroyed = true;
  window.events.get('restore')();

  assert.deepEqual(window.sends, [
    [IPC_CHANNELS.windowStateChanged, { isMaximized: true, isFullScreen: false, usesCustomFrame: true }],
  ]);
});

test('window bootstrap creates the main BrowserWindow with secure renderer defaults and registers IPC layers', async () => {
  const app = createElectronAppMock();
  const constructedWindows = [];
  const electronBrowserWindow = class BrowserWindowDouble {
    constructor(options) {
      this.options = options;
      this.currentUrl = '';
      this.webContents = {
        events: new Map(),
        getURL: () => this.currentUrl,
        isLoading: () => false,
        on: (event, listener) => {
          this.webContents.events.set(event, listener);
        },
        once: (event, listener) => {
          this.webContents.events.set(event, listener);
        },
        send: () => {},
        setWindowOpenHandler: (handler) => {
          this.webContents.openHandler = handler;
        },
      };
      constructedWindows.push(this);
    }
    async loadURL(url) {
      this.currentUrl = url;
    }
  };
  const ipcRecorder = createIpcMainRecorder();
  const calls = [];
  const externalUrls = [];
  const openedPaths = [];
  const reportPath = path.resolve('report.txt');
  const reportUrl = pathToFileURL(reportPath).toString();
  let mainWindow = null;
  let friendWindows = [];

  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  const { createWindowBootstrapController } = await withMockedElectron(
    { app, BrowserWindow: electronBrowserWindow },
    (require) => {
      clearDistModule('main/deep-links.js');
      clearDistModule('main/core/window-bootstrap.js');
      return require('../../dist-electron/main/core/window-bootstrap.js');
    },
  );

  const controller = createWindowBootstrapController({
    BrowserWindow: electronBrowserWindow,
    IPC_CHANNELS,
    app,
    desktopErrorReporter: { reportRendererProcessGone: (details) => calls.push(['renderer-gone', details]) },
    focusDeepLinkWindow: (window) => calls.push(['focus', window]),
    getMainProcessIpcDeps: () => ({
      desktopIpcMain: { marker: 'trusted-desktop-ipc' },
      getFriendChatWindows: () => friendWindows,
      marker: 'deps',
      mainWindow,
      getMainWindow: () => mainWindow,
    }),
    getMainWindow: () => mainWindow,
    getWindowState: () => ({ isMaximized: false, isFullScreen: false, usesCustomFrame: true }),
    ipcMain: ipcRecorder.ipcMain,
    isDev: false,
    loadDesktopWindow: async (window) => {
      window.currentUrl = 'http://127.0.0.1:5173/';
      calls.push(['load', window]);
    },
    path: { join: (...parts) => parts.join('/') },
    registerAgentIpcHandlers: (deps) => calls.push(['agent-ipc', deps]),
    registerMainIpcHandlers: (deps) => calls.push(['main-ipc', deps]),
    registerWindowIpcHandlers: (deps) => calls.push(['window-ipc', deps]),
    registerWindowStateEvents: (window) => calls.push(['window-events', window]),
    shell: createShellMock({
      openExternal: async (url) => externalUrls.push(url),
      openPath: async (targetPath) => {
        openedPaths.push(targetPath);
        return '';
      },
    }),
    state: { mainWindow: null, pendingDeepLink: null },
    useCustomWindowFrame: true,
  });

  controller.registerIpcHandlers();
  const registeredMainDeps = calls.find((call) => call[0] === 'main-ipc')[1];
  const registeredAgentDeps = calls.find((call) => call[0] === 'agent-ipc')[1];
  assert.equal(registeredAgentDeps, registeredMainDeps);
  assert.equal(registeredAgentDeps.desktopIpcMain.marker, 'trusted-desktop-ipc');
  assert.equal(registeredMainDeps.mainWindow, null);
  assert.equal(registeredMainDeps.getMainWindow(), null);
  assert.deepEqual(registeredMainDeps.getFriendChatWindows(), []);

  await controller.createWindow();
  mainWindow = constructedWindows[0];
  friendWindows = [{ webContents: { id: 88 } }];
  assert.equal(registeredMainDeps.getMainWindow(), mainWindow);
  assert.equal(registeredAgentDeps.getFriendChatWindows(), friendWindows);
  calls.find((call) => call[0] === 'window-ipc')[1].quitApp();
  mainWindow.webContents.events.get('render-process-gone')({}, { reason: 'crashed' });
  const externalNavigation = [];
  mainWindow.webContents.events.get('will-navigate')(
    { preventDefault: () => externalNavigation.push('prevented') },
    'https://example.com/docs',
  );
  const internalNavigation = [];
  mainWindow.webContents.events.get('will-navigate')(
    { preventDefault: () => internalNavigation.push('prevented') },
    'http://127.0.0.1:5173/settings',
  );
  assert.deepEqual(mainWindow.webContents.openHandler({ url: 'https://example.com/popup' }), { action: 'deny' });
  assert.deepEqual(mainWindow.webContents.openHandler({ url: reportUrl }), { action: 'deny' });
  assert.deepEqual(mainWindow.webContents.openHandler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  assert.deepEqual(mainWindow.webContents.openHandler({ url: 'http://127.0.0.1:5173/help' }), { action: 'deny' });
  mainWindow.currentUrl = 'not-a-url';
  assert.deepEqual(mainWindow.webContents.openHandler({ url: 'not-a-url' }), { action: 'deny' });
  const malformedNavigation = [];
  mainWindow.webContents.events.get('will-navigate')(
    { preventDefault: () => malformedNavigation.push('prevented') },
    'not-a-url',
  );
  assert.deepEqual(malformedNavigation, ['prevented']);
  mainWindow.currentUrl = 'http://127.0.0.1:5173/help';
  const childWindowClosed = [];
  mainWindow.webContents.events.get('did-create-window')({
    isDestroyed: () => false,
    close: () => childWindowClosed.push('close'),
  });
  mainWindow.webContents.events.get('did-create-window')({
    isDestroyed: () => true,
    close: () => childWindowClosed.push('destroyed-close'),
  });
  assert.deepEqual(childWindowClosed, ['close']);

  assert.equal(constructedWindows.length, 1);
  assert.equal(constructedWindows[0].options.frame, false);
  assert.match(
    constructedWindows[0].options.webPreferences.preload.replaceAll('\\', '/'),
    /dist-electron\/main\/core\/\.\.\/\.\.\/preload\/index\.js$/,
  );
  assert.deepEqual(
    {
      nodeIntegration: constructedWindows[0].options.webPreferences.nodeIntegration,
      contextIsolation: constructedWindows[0].options.webPreferences.contextIsolation,
      sandbox: constructedWindows[0].options.webPreferences.sandbox,
    },
    {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  );
  assert.deepEqual(calls.map((call) => call[0]), [
    'main-ipc',
    'agent-ipc',
    'window-ipc',
    'window-events',
    'load',
    'renderer-gone',
  ]);
  assert.equal(app.quitCalls, 1);
  assert.equal(app.protocolRegistrations.length, 1);
  assert.deepEqual(externalNavigation, ['prevented']);
  assert.deepEqual(internalNavigation, []);
  assert.deepEqual(externalUrls, ['https://example.com/docs', 'https://example.com/popup']);
  assert.deepEqual(openedPaths, [reportPath]);
  assert.equal(mainWindow.currentUrl, 'http://127.0.0.1:5173/help');

  const replacementWindow = createWindowDouble();
  mainWindow = replacementWindow;
  assert.equal(registeredMainDeps.getMainWindow(), replacementWindow);
});

test('microphone permissions normalize every platform and native response safely', async () => {
  await withPlatform('linux', async () => {
    const module = await loadMicrophonePermissions({
      getMediaAccessStatus: () => 'granted',
      askForMediaAccess: async () => true,
    });
    assert.equal(module.getMicrophonePermissionStatus(), 'unsupported');
    assert.equal(await module.requestMicrophonePermission(), 'unsupported');
  });

  await withPlatform('darwin', async () => {
    let currentStatus = 'not-determined';
    let askedFor = null;
    const systemPreferences = {
      getMediaAccessStatus: (mediaType) => {
        askedFor = mediaType;
        return currentStatus;
      },
      askForMediaAccess: async (mediaType) => {
        askedFor = mediaType;
        return true;
      },
    };
    const module = await loadMicrophonePermissions(systemPreferences);
    for (const status of ['not-determined', 'granted', 'denied', 'restricted', 'unknown']) {
      currentStatus = status;
      assert.equal(module.getMicrophonePermissionStatus(), status);
      assert.equal(askedFor, 'microphone');
    }
    currentStatus = 'unexpected-native-status';
    assert.equal(module.getMicrophonePermissionStatus(), 'unknown');
    assert.equal(await module.requestMicrophonePermission(), 'granted');

    systemPreferences.askForMediaAccess = async () => false;
    currentStatus = 'denied';
    assert.equal(await module.requestMicrophonePermission(), 'denied');
  });

  await withPlatform('darwin', async () => {
    const module = await loadMicrophonePermissions({
      getMediaAccessStatus: undefined,
      askForMediaAccess: undefined,
    });
    assert.equal(module.getMicrophonePermissionStatus(), 'unsupported');
    assert.equal(await module.requestMicrophonePermission(), 'unsupported');
  });
});

test('window bootstrap keeps native frames portable and ignores empty pending deep-link flushes', async () => {
  await withPlatform('linux', async () => {
    const app = createElectronAppMock();
    const constructedWindows = [];
    const electronBrowserWindow = class BrowserWindowDouble {
      constructor(options) {
        this.options = options;
        this.currentUrl = 'http://127.0.0.1:5173/';
        this.webContents = {
          getURL: () => this.currentUrl,
          isLoading: () => false,
          on: () => {},
          once: () => {},
          send: () => {},
          setWindowOpenHandler: (handler) => {
            this.webContents.openHandler = handler;
          },
        };
        constructedWindows.push(this);
      }
      async loadURL(url) {
        this.currentUrl = url;
      }
    };
    const state = { mainWindow: null, pendingDeepLink: null };
    const focusCalls = [];
    const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
    const { createWindowBootstrapController } = await withMockedElectron(
      { app, BrowserWindow: electronBrowserWindow },
      (require) => {
        clearDistModule('main/deep-links.js');
        clearDistModule('main/core/window-bootstrap.js');
        return require('../../dist-electron/main/core/window-bootstrap.js');
      },
    );

    const controller = createWindowBootstrapController({
      BrowserWindow: electronBrowserWindow,
      IPC_CHANNELS,
      app,
      desktopErrorReporter: null,
      focusDeepLinkWindow: (window) => focusCalls.push(window),
      getMainProcessIpcDeps: () => ({}),
      getMainWindow: () => state.mainWindow,
      getWindowState: () => ({}),
      ipcMain: createIpcMainRecorder().ipcMain,
      isDev: true,
      loadDesktopWindow: async () => {},
      path: { join: (...parts) => parts.join('/') },
      registerAgentIpcHandlers: () => {},
      registerMainIpcHandlers: () => {},
      registerWindowIpcHandlers: () => {},
      registerWindowStateEvents: () => {},
      shell: createShellMock(),
      state,
      useCustomWindowFrame: false,
    });

    await controller.createWindow();
    controller.flushPendingDeepLink();

    assert.equal(constructedWindows[0].options.title, 'Forger Dev');
    assert.equal(constructedWindows[0].options.frame, true);
    assert.equal(constructedWindows[0].options.titleBarStyle, undefined);
    assert.equal(constructedWindows[0].options.trafficLightPosition, undefined);
    assert.deepEqual(focusCalls, []);
  });
});

test('window bootstrap defers deep-links while loading and flushes them after load', async () => {
  const app = createElectronAppMock();
  const sent = [];
  const onceListeners = new Map();
  const onceCalls = [];
  const mainWindow = {
    webContents: {
      isLoading: () => true,
      once: (event, listener) => {
        onceCalls.push([event, listener]);
        onceListeners.set(event, listener);
      },
      send: (channel, payload) => sent.push([channel, payload]),
    },
  };
  const state = { mainWindow, pendingDeepLink: null, pendingDeepLinkFlushScheduled: false };
  const focusCalls = [];
  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  const { createWindowBootstrapController } = await withMockedElectron(
    { app, BrowserWindow: function BrowserWindowDouble() {} },
    (require) => {
      clearDistModule('main/deep-links.js');
      clearDistModule('main/core/window-bootstrap.js');
      return require('../../dist-electron/main/core/window-bootstrap.js');
    },
  );

  const controller = createWindowBootstrapController({
    BrowserWindow: function BrowserWindowDouble() {},
    IPC_CHANNELS,
    app,
    desktopErrorReporter: null,
    focusDeepLinkWindow: (window) => focusCalls.push(window),
    getMainProcessIpcDeps: () => ({}),
    getMainWindow: () => mainWindow,
    getWindowState: () => ({}),
    ipcMain: createIpcMainRecorder().ipcMain,
    isDev: true,
    loadDesktopWindow: async () => {},
    path: { join: (...parts) => parts.join('/') },
    registerAgentIpcHandlers: () => {},
    registerMainIpcHandlers: () => {},
    registerWindowIpcHandlers: () => {},
    registerWindowStateEvents: () => {},
    shell: createShellMock(),
    state,
    useCustomWindowFrame: false,
  });

  const link = { kind: 'chat', app: 'finance-os', prompt: 'load', raw: 'forger://chat?app=finance-os&prompt=load' };
  const latestLink = { kind: 'chat', app: 'finance-os', prompt: 'latest', raw: 'forger://chat?app=finance-os&prompt=latest' };
  controller.dispatchDeepLink(link);
  controller.dispatchDeepLink(latestLink);

  assert.equal(state.pendingDeepLink, latestLink);
  assert.equal(sent.length, 0);
  assert.equal(onceCalls.length, 1);
  assert.equal(typeof onceListeners.get('did-finish-load'), 'function');

  mainWindow.webContents.isLoading = () => false;
  onceListeners.get('did-finish-load')();

  assert.equal(state.pendingDeepLink, null);
  assert.equal(state.pendingDeepLinkFlushScheduled, false);
  assert.deepEqual(focusCalls, [mainWindow]);
  assert.deepEqual(sent, [[IPC_CHANNELS.deepLink, latestLink]]);
});

test('window bootstrap handles single-instance, open-url, and pending deep-link fallbacks', async () => {
  const app = createElectronAppMock();
  const sent = [];
  const focused = [];
  const mainWindow = {
    webContents: {
      isLoading: () => false,
      send: (channel, payload) => sent.push([channel, payload]),
    },
  };
  const state = { mainWindow: null, pendingDeepLink: null };
  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  const { createWindowBootstrapController } = await withMockedElectron(
    { app, BrowserWindow: function BrowserWindowDouble() {} },
    (require) => {
      clearDistModule('main/deep-links.js');
      clearDistModule('main/core/window-bootstrap.js');
      return require('../../dist-electron/main/core/window-bootstrap.js');
    },
  );

  const controller = createWindowBootstrapController({
    BrowserWindow: function BrowserWindowDouble() {},
    IPC_CHANNELS,
    app,
    desktopErrorReporter: null,
    focusDeepLinkWindow: (window) => focused.push(window),
    getMainProcessIpcDeps: () => ({}),
    getMainWindow: () => state.mainWindow,
    getWindowState: () => ({}),
    ipcMain: createIpcMainRecorder().ipcMain,
    isDev: true,
    loadDesktopWindow: async () => {},
    path: { join: (...parts) => parts.join('/') },
    registerAgentIpcHandlers: () => {},
    registerMainIpcHandlers: () => {},
    registerWindowIpcHandlers: () => {},
    registerWindowStateEvents: () => {},
    shell: createShellMock(),
    state,
    useCustomWindowFrame: false,
  });

  controller.handleIncomingUrl('not-a-forger-url');
  assert.deepEqual(sent, []);

  controller.handleIncomingUrl('forger://chat?app=finance-os&prompt=hello');
  assert.equal(state.pendingDeepLink.app, 'finance-os');

  state.mainWindow = mainWindow;
  controller.flushPendingDeepLink();
  assert.equal(state.pendingDeepLink, null);
  assert.equal(sent[0][0], IPC_CHANNELS.deepLink);
  assert.equal(sent[0][1].prompt, 'hello');

  app.listeners.get('second-instance')({}, ['node', 'forger://chat?app=recipes&prompt=open']);
  app.listeners.get('second-instance')({}, ['node']);
  const preventCalls = [];
  app.listeners.get('open-url')({ preventDefault: () => preventCalls.push('prevented') }, 'forger://chat?app=finance-os&prompt=again');

  assert.equal(sent.at(-1)[1].prompt, 'again');
  assert.equal(focused.includes(mainWindow), true);
  assert.deepEqual(preventCalls, ['prevented']);

  const noLockApp = createElectronAppMock();
  noLockApp.requestSingleInstanceLock = () => false;
  await withMockedElectron(
    { app: noLockApp, BrowserWindow: function BrowserWindowDouble() {} },
    (require) => {
      clearDistModule('main/deep-links.js');
      clearDistModule('main/core/window-bootstrap.js');
      return require('../../dist-electron/main/core/window-bootstrap.js').createWindowBootstrapController({
        BrowserWindow: function BrowserWindowDouble() {},
        IPC_CHANNELS,
        app: noLockApp,
        desktopErrorReporter: null,
        focusDeepLinkWindow: () => {},
        getMainProcessIpcDeps: () => ({}),
        getMainWindow: () => null,
        getWindowState: () => ({}),
        ipcMain: createIpcMainRecorder().ipcMain,
        isDev: false,
        loadDesktopWindow: async () => {},
        path: { join: (...parts) => parts.join('/') },
        registerAgentIpcHandlers: () => {},
        registerMainIpcHandlers: () => {},
        registerWindowIpcHandlers: () => {},
        registerWindowStateEvents: () => {},
        shell: createShellMock(),
        state: { mainWindow: null, pendingDeepLink: null },
        useCustomWindowFrame: false,
      });
    },
  );
  assert.equal(noLockApp.quitCalls, 1);
});

test('window bootstrap captures cold-start deep-links from process argv', async () => {
  const app = createElectronAppMock();
  const state = { mainWindow: null, pendingDeepLink: null };
  const originalArgv = process.argv;
  const { IPC_CHANNELS } = await import('../../dist-electron/shared/ipc.js');
  try {
    process.argv = ['node', 'forger://chat?app=finance-os&prompt=cold'];
    await withMockedElectron(
      { app, BrowserWindow: function BrowserWindowDouble() {} },
      (require) => {
        clearDistModule('main/deep-links.js');
        clearDistModule('main/core/window-bootstrap.js');
        return require('../../dist-electron/main/core/window-bootstrap.js').createWindowBootstrapController({
          BrowserWindow: function BrowserWindowDouble() {},
          IPC_CHANNELS,
          app,
          desktopErrorReporter: null,
          focusDeepLinkWindow: () => {},
          getMainProcessIpcDeps: () => ({}),
          getMainWindow: () => null,
          getWindowState: () => ({}),
          ipcMain: createIpcMainRecorder().ipcMain,
          isDev: false,
          loadDesktopWindow: async () => {},
          path: { join: (...parts) => parts.join('/') },
          registerAgentIpcHandlers: () => {},
          registerMainIpcHandlers: () => {},
          registerWindowIpcHandlers: () => {},
          registerWindowStateEvents: () => {},
          shell: createShellMock(),
          state,
          useCustomWindowFrame: false,
        });
      },
    );
  } finally {
    process.argv = originalArgv;
  }

  assert.equal(state.pendingDeepLink.app, 'finance-os');
  assert.equal(state.pendingDeepLink.prompt, 'cold');
});
