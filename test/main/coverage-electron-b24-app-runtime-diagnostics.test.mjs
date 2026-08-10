import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createAppRuntimeDiagnostics } = require('../../dist-electron/main/core/app-runtime-diagnostics.js');

test('app runtime diagnostics snapshots windows and reads only redacted bounded app log tails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-b24-diagnostics-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const logs = path.join(root, 'logs');
  await fs.mkdir(logs);
  const filler = 'x'.repeat(270_000);
  await fs.writeFile(path.join(logs, 'forger-desktop.jsonl'), `${filler}\nother token=visible\nfinance token=secret password: "hidden"\nfinance ok\n`);
  const executions = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async (source, gesture) => {
        executions.push({ source, gesture });
        return { success: false, selector: 'body' };
      },
      getURL: () => 'http://app.local',
      getTitle: () => 'Finance',
      isLoading: () => false,
    },
  };
  const running = {
    backend: { pid: 10 }, frontend: { pid: 11 }, backendUrl: 'http://b', frontendUrl: 'http://f', locale: 'es',
  };
  const appWindows = new Map([['finance', window], ['destroyed', { isDestroyed: () => true }]]);
  const diagnostics = createAppRuntimeDiagnostics({
    appWindows,
    runningApps: new Map([['finance', running]]),
    getForgerMetadataRoot: () => root,
    getRuntimeStatus: (appId) => ({ appId, status: 'running' }),
    serializeErrorForInstallLog: (error) => ({ error: error.message }),
  });

  assert.equal((await diagnostics.getAppViewSnapshot('missing', {})).technicalCode, 'app_window_not_open');
  assert.equal((await diagnostics.getAppViewSnapshot('destroyed', {})).technicalCode, 'app_window_not_open');
  const snapshot = await diagnostics.getAppViewSnapshot('finance', { selector: '  ', includeHtml: true, maxChars: 99 });
  assert.equal(snapshot.success, false);
  assert.match(executions[0].source, /"selector":"body"/);
  assert.match(executions[0].source, /"maxChars":1000/);
  assert.equal(executions[0].gesture, true);
  await diagnostics.getAppViewSnapshot('finance', { selector: ' #root ', maxChars: 60_000 });
  assert.match(executions[1].source, /"selector":"#root"/);
  assert.match(executions[1].source, /"maxChars":50000/);
  window.webContents.executeJavaScript = async () => { throw new Error('renderer gone'); };
  assert.deepEqual(await diagnostics.getAppViewSnapshot('finance', { maxChars: Number.NaN }), {
    success: false,
    appId: 'finance',
    userMessage: 'No se pudo leer la vista de la app en Forger.',
    error: 'renderer gone',
    technicalCode: 'app_view_snapshot_failed',
  });

  const runtime = await diagnostics.getAppRuntimeDiagnostics('finance', { recentLines: 999 });
  assert.equal(runtime.appWindow.open, true);
  assert.equal(runtime.runningProcess.backendPid, 10);
  assert.equal(runtime.logs[0].scannedTailBytes, 256 * 1024);
  assert.equal(runtime.logs[0].lines.length, 2);
  assert.doesNotMatch(runtime.logs[0].lines.join(' '), /secret|hidden/);
  assert.match(runtime.logs[0].lines[0], /\[redacted\]/);
  const unavailable = await diagnostics.getAppRuntimeDiagnostics('missing', { recentLines: 1 });
  assert.deepEqual(unavailable.appWindow, { open: false });
  assert.equal(unavailable.runningProcess, null);
  assert.equal(unavailable.logs[0].available, true);

  const missingLogs = createAppRuntimeDiagnostics({
    appWindows: new Map(), runningApps: new Map(), getForgerMetadataRoot: () => path.join(root, 'missing'),
    getRuntimeStatus: () => ({}), serializeErrorForInstallLog: () => ({}),
  });
  const absent = await missingLogs.getAppRuntimeDiagnostics('finance', { recentLines: Number.NaN });
  assert.equal(absent.logs[0].available, false);
  assert.equal(absent.logs[0].technicalCode, 'ENOENT');

  const fsPromises = require('node:fs/promises');
  const originalStat = fsPromises.stat;
  fsPromises.stat = async () => { throw null; };
  try {
    const fallback = await diagnostics.getAppRuntimeDiagnostics('finance', { recentLines: 10 });
    assert.equal(fallback.logs[0].technicalCode, 'log_read_failed');
  } finally {
    fsPromises.stat = originalStat;
  }
});
