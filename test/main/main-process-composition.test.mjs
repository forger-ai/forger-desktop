import assert from 'node:assert/strict';
import test from 'node:test';

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
    ['before-quit', 'window-all-closed'],
  );
  assert.equal(constructedWindows.length, 0);
  assert.equal(ipcRecorder.handlers.size, 0);
  assert.deepEqual(shellCalls, []);

  const beforeQuit = appListeners.find(([event]) => event === 'before-quit')?.[1];
  const windowAllClosed = appListeners.find(([event]) => event === 'window-all-closed')?.[1];
  assert.equal(typeof beforeQuit, 'function');
  assert.equal(typeof windowAllClosed, 'function');

  assert.doesNotThrow(() => beforeQuit());
  assert.doesNotThrow(() => windowAllClosed());
  assert.equal(app.quitCalls, process.platform === 'darwin' ? 0 : 1);
});
