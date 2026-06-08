import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStartupLoadingController } = require('../../dist-electron/main/core/startup-loading.js');

const decodeDataHtml = (url) => decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/, ''));

const createBrowserWindowDouble = (calls) => class BrowserWindowDouble {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.executedScripts = [];
    this.loadUrls = [];
    this.webContents = {
      executeJavaScript: async (script) => {
        this.executedScripts.push(script);
      },
    };
    calls.windows.push(this);
  }

  async loadURL(url) {
    this.loadUrls.push(url);
  }

  close() {
    this.destroyed = true;
    calls.closed.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }
};

test('startup loading window renders once, updates progress in-place, and closes safely', () => {
  const calls = { windows: [], closed: [] };
  const BrowserWindow = createBrowserWindowDouble(calls);
  const controller = createStartupLoadingController(BrowserWindow, 'es-CL');

  controller.update({ event: 'startup:settings:load', status: 'active' });
  controller.update({ event: 'startup:forger_mcp_server:start', status: 'success' });
  controller.update({ event: 'startup:main_window:create', status: 'success' });
  controller.close();
  controller.close();

  assert.equal(calls.windows.length, 1);
  assert.equal(calls.closed.length, 1);
  const [window] = calls.windows;
  assert.equal(window.options.title, 'Iniciando Forger');
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.loadUrls.length, 1);
  assert.match(decodeDataHtml(window.loadUrls[0]), /Iniciando Forger/);

  const updates = window.executedScripts.join('\n');
  assert.match(updates, /Cargando configuracion/);
  assert.match(updates, /Iniciando herramientas de Forger/);
  assert.match(updates, /Abriendo Forger/);
});

test('startup loading window keeps the failure state visible', () => {
  const calls = { windows: [], closed: [] };
  const BrowserWindow = createBrowserWindowDouble(calls);
  const controller = createStartupLoadingController(BrowserWindow, 'en-US');

  controller.update({ event: 'startup:settings:load', status: 'failed', error: new Error('settings failed') });

  const [window] = calls.windows;
  assert.equal(calls.closed.length, 0);
  assert.match(decodeDataHtml(window.loadUrls[0]), /Starting Forger/);
  assert.match(window.executedScripts.join('\n'), /Forger could not finish starting/);
});
