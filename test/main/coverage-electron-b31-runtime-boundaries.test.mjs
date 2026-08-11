import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('BDD: Claude OAuth handles child-process callbacks with omitted output before checking the file fallback', async () => {
  const { readClaudeOAuthToken } = require('../../dist-electron/main/claude-oauth.js');
  let reads = 0;
  const token = await readClaudeOAuthToken({
    platform: 'darwin', securityPath: '/security',
    execFile: (_command, _args, _options, callback) => callback(null, undefined, undefined),
    fs: { readFile: async () => { reads += 1; return JSON.stringify({ claudeAiOauth: { accessToken: 'file-token' } }); } },
  });
  assert.equal(token, 'file-token');
  assert.equal(reads, 1);
});

test('BDD: sidekick cancellation supplies a stable error when an AbortSignal has no reason', async () => {
  const { raceSidekickOperationWithSignal } = require('../../dist-electron/main/sidekick-service-reliability.js');
  const alreadyAborted = { aborted: true, reason: undefined, addEventListener() {}, removeEventListener() {} };
  await assert.rejects(raceSidekickOperationWithSignal(Promise.resolve('late'), alreadyAborted), /sidekick_operation_cancelled/);

  let abort;
  const pendingSignal = {
    aborted: false, reason: undefined,
    addEventListener: (_name, listener) => { abort = listener; }, removeEventListener() {},
  };
  const result = raceSidekickOperationWithSignal(new Promise(() => {}), pendingSignal);
  abort();
  await assert.rejects(result, /sidekick_operation_cancelled/);
});

test('BDD: error reporting normalizes null rejection and task messages without requiring an operation', () => {
  const sent = [];
  const { DesktopErrorReporter } = require('../../dist-electron/main/error-reporting.js');
  const withDefaultDedupe = new DesktopErrorReporter({
    getMainWindow: () => null, getAppVersion: () => '1.0.0', getInstalledApp: () => null,
  });
  assert.equal(withDefaultDedupe.buildPreview({ source: 'desktop', message: 'Preview' }).message, 'Preview');
  const reporter = new DesktopErrorReporter({
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (_channel, preview) => sent.push(preview) } }),
    getAppVersion: () => '1.0.0', getInstalledApp: () => null, dedupeTtlMs: 0,
  });
  reporter.reportMainUnhandledRejection(null);
  reporter.reportAppCodexTaskEvent({ task: { status: 'failed', appId: 'app', runId: 'run' } });
  reporter.request({ source: 'desktop', message: 'No operation', technicalCode: 'missing_operation_case' });
  assert.equal(sent[0].message, 'Unhandled rejection');
  assert.equal(sent[0].sensitiveDetails.reason, '');
  assert.equal(sent[1].message, 'App agent task failed.');
  assert.equal(sent[2].operation, undefined);
});

test('BDD: memory maintenance records empty command failures, primitive failures, and invokes scheduled work', async () => {
  const modulePath = require.resolve('../../dist-electron/main/memory-maintenance-manager.js');
  const runnerPath = require.resolve('../../dist-electron/main/automation/agent-command-runner.js');
  const originalLoad = Module._load;
  const loadManager = (runAgentCommand) => {
    delete require.cache[modulePath];
    Module._load = function(request, parent, isMain) {
      if (request === './automation/agent-command-runner' && parent?.filename === modulePath) return { runAgentCommand };
      return originalLoad.call(this, request, parent, isMain);
    };
    try { return require(modulePath).MemoryMaintenanceManager; } finally { Module._load = originalLoad; delete require.cache[runnerPath]; }
  };
  const createHarness = (MemoryMaintenanceManager) => {
    const runs = [];
    const manager = new MemoryMaintenanceManager({
      forgerHomeRoot: '/tmp', codexHome: '/tmp/codex', getCodexAuthenticated: async () => true,
      getAgentRuntime: async () => ({ provider: 'codex' }), getCodexCliPath: async () => '/codex', getCodexPathEntries: async () => [],
      buildMemoryContext: async () => '', getMemoryStore: () => ({ recordMaintenanceRun: async (run) => runs.push(run) }),
      appendInstallLog: async () => {},
    });
    return { manager, runs };
  };

  let harness = createHarness(loadManager(async () => ({ code: 1, stdout: '', stderr: '' })));
  await harness.manager.runNow();
  assert.equal(harness.runs[0].summary, 'memory_maintenance_failed');

  harness = createHarness(loadManager(async () => { throw 'primitive'; }));
  await harness.manager.runNow();
  assert.equal(harness.runs[0].summary, 'memory_maintenance_failed');

  harness = createHarness(loadManager(async () => ({ code: 0, stdout: '', stderr: '' })));
  let scheduled = false;
  harness.manager.runNow = async (trigger) => { scheduled = trigger === 'scheduled'; };
  await harness.manager.initialize();
  harness.manager.timer._onTimeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled, true);
  harness.manager.dispose();
});
