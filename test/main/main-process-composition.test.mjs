import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  clearDistModule,
  createElectronAppMock,
  createIpcMainRecorder,
  withMockedElectron,
} from './electron-test-helpers.mjs';

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const getRequiredMainLifecycleDepNames = () => {
  const sourcePath = path.resolve(__dirname, '../../src/main/core/main-lifecycle.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const match = source.match(/export interface MainLifecycleDeps \{([\s\S]*?)\n\}/);
  assert.ok(match, 'MainLifecycleDeps interface was not found');
  return match[1]
    .split('\n')
    .map((line) => line.match(/^ {2}([A-Za-z_$][\w$]*)(\?)?:/)?.slice(1, 3))
    .filter(Boolean)
    .filter(([, optional]) => optional !== '?')
    .map(([name]) => name)
    .sort();
};

test('main-process composes lifecycle wiring with mocked Electron without launching a BrowserWindow', async () => {
  const ready = createDeferred();
  const app = createElectronAppMock();
  const appListeners = [];
  const constructedWindows = [];
  let whenReadyCalls = 0;

  app.on = (event, listener) => {
    appListeners.push([event, listener]);
  };
  app.whenReady = () => {
    whenReadyCalls += 1;
    return ready.promise;
  };

  class BrowserWindowDouble {
    constructor(options) {
      this.options = options;
      this.webContents = {
        on: () => undefined,
        once: () => undefined,
        send: () => undefined,
      };
      constructedWindows.push(this);
    }

    static getAllWindows() {
      return constructedWindows;
    }
  }

  const ipcRecorder = createIpcMainRecorder();
  const shellCalls = [];

  await withMockedElectron(
    {
      app,
      BrowserWindow: BrowserWindowDouble,
      dialog: {},
      ipcMain: ipcRecorder.ipcMain,
      Notification: class NotificationDouble {},
      shell: {
        openExternal: async (url) => {
          shellCalls.push(url);
        },
      },
    },
    (require) => {
      clearDistModule('main/core/main-process.js');
      require('../../dist-electron/main/core/main-process.js');
    },
  );

  assert.equal(whenReadyCalls, 2);
  assert.deepEqual(
    appListeners.map(([event]) => event),
    ['before-quit', 'before-quit', 'window-all-closed'],
  );
  assert.equal(constructedWindows.length, 0);
  assert.equal(ipcRecorder.handlers.size, 0);
  assert.deepEqual(shellCalls, []);

  const beforeQuitListeners = appListeners
    .filter(([event]) => event === 'before-quit')
    .map(([, listener]) => listener);
  const windowAllClosed = appListeners.find(([event]) => event === 'window-all-closed')?.[1];
  assert.equal(beforeQuitListeners.length, 2);
  assert.equal(typeof windowAllClosed, 'function');

  for (const beforeQuit of beforeQuitListeners) {
    assert.doesNotThrow(() => beforeQuit());
  }
  assert.doesNotThrow(() => windowAllClosed());
  assert.equal(app.quitCalls, process.platform === 'darwin' ? 0 : 1);
});

test('main-process passes every required lifecycle dependency into lifecycle wiring', async () => {
  const app = createElectronAppMock();
  let lifecycleDeps = null;

  await withMockedElectron(
    {
      app,
      BrowserWindow: class BrowserWindowDouble {},
      dialog: {},
      ipcMain: createIpcMainRecorder().ipcMain,
      Notification: class NotificationDouble {},
      shell: { openExternal: async () => undefined },
    },
    (require) => {
      const originalLoad = Module._load;
      Module._load = function loadWithLifecycleCapture(request, parent, isMain) {
        if (request === './main-lifecycle') {
          return {
            registerMainLifecycle(deps) {
              lifecycleDeps = deps;
            },
          };
        }
        return originalLoad.apply(this, [request, parent, isMain]);
      };

      try {
        clearDistModule('main/core/main-process.js');
        require('../../dist-electron/main/core/main-process.js');
      } finally {
        Module._load = originalLoad;
      }
    },
  );

  assert.ok(lifecycleDeps);
  const requiredDepNames = getRequiredMainLifecycleDepNames();
  const missingDepNames = requiredDepNames.filter((name) => !(name in lifecycleDeps));
  assert.deepEqual(missingDepNames, []);

  for (const name of requiredDepNames) {
    assert.notEqual(lifecycleDeps[name], undefined, `main-process passed undefined for lifecycle dependency ${name}`);
  }
});
