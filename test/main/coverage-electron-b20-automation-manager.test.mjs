import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AutomationManager,
  computeNextRunAt,
  defaultMissedRunWindowMinutes,
} = require('../../dist-electron/main/automation-manager.js');

const tmpRoot = async (name) => fs.mkdtemp(path.join(os.tmpdir(), `forger-b20-${name}-`));

const makeOptions = (root, overrides = {}) => ({
  forgerHomeRoot: root,
  metadataRoot: path.join(root, 'metadata'),
  codexHome: path.join(root, 'codex-home'),
  getAgentRuntime: async () => ({ provider: 'codex', model: 'test', effort: 'low' }),
  getInstalledApps: () => [],
  getCodexCliPath: async () => null,
  getClaudeCliPath: async () => null,
  getCodexPathEntries: async () => [],
  getCodexAuthenticated: async () => true,
  getClaudeAuthenticated: async () => true,
  onAutomationUpdated: () => undefined,
  ...overrides,
});

const waitForRun = async (manager, automationId, predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runs = await manager.listRuns(automationId);
    if (predicate(runs[0])) return runs[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('automation_run_timeout');
};

test('Given interval schedules and malformed values, when next runs and defaults are computed, then bounds are deterministic', async (t) => {
  assert.equal(defaultMissedRunWindowMinutes({ type: 'interval', intervalMinutes: 7 }), 7);
  assert.equal(defaultMissedRunWindowMinutes({ type: 'daily', timeOfDay: '09:00' }), 360);
  assert.equal(
    computeNextRunAt({ type: 'interval', intervalMinutes: 15 }, new Date('2026-01-01T10:02:45.500Z')),
    '2026-01-01T10:17:00.000Z',
  );
  const sameDayDaily = new Date(computeNextRunAt(
    { type: 'daily', timeOfDay: '23:59' },
    new Date(2026, 0, 1, 10, 0, 0),
  ));
  assert.equal(sameDayDaily.getDate(), 1);
  assert.equal(sameDayDaily.getHours(), 23);
  assert.equal(
    new Date(computeNextRunAt({ type: 'weekly', weeklyDay: 5, timeOfDay: '10:00' }, new Date(2026, 0, 1, 9))).getDay(),
    5,
  );

  const root = await tmpRoot('automation-intervals');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new AutomationManager(makeOptions(root));
  await manager.initialize();
  const fallback = await manager.create({
    name: 'Fallback interval',
    prompt: 'Run',
    selectedAppIds: [],
    enabled: false,
    frequency: { type: 'interval', intervalMinutes: Number.NaN },
    missedRunWindowMinutes: 'invalid',
  });
  const minimum = await manager.create({
    name: 'Minimum interval',
    prompt: 'Run',
    selectedAppIds: [],
    enabled: false,
    frequency: { type: 'interval', intervalMinutes: -1 },
    missedRunWindowMinutes: 0,
  });
  const maximum = await manager.create({
    name: 'Maximum interval',
    prompt: 'Run',
    selectedAppIds: [],
    enabled: false,
    frequency: { type: 'interval', intervalMinutes: '999999' },
    missedRunWindowMinutes: 999999,
  });
  assert.equal(fallback.frequency.intervalMinutes, 15);
  assert.equal(minimum.frequency.intervalMinutes, 15);
  assert.equal(maximum.frequency.intervalMinutes, 1_440);
  assert.equal(maximum.missedRunWindowMinutes, 43_200);
  manager.dispose();
});

test('Given Antigravity setup states, when automations execute, then auth, CLI, and successful local runs map to safe outcomes', async (t) => {
  const root = await tmpRoot('automation-antigravity');
  const fakeCli = path.join(root, 'fake-antigravity.js');
  await fs.writeFile(fakeCli, [
    '#!/usr/bin/env node',
    'process.stdin.resume();',
    'process.stdin.on("end", () => {',
    '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Antigravity done" } }));',
    '});',
  ].join('\n'));
  await fs.chmod(fakeCli, 0o755);
  const managers = [];
  t.after(async () => {
    for (const manager of managers) manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const runCase = async (name, overrides) => {
    const manager = new AutomationManager(makeOptions(path.join(root, name), {
      getAgentRuntime: async () => ({ provider: 'antigravity', model: 'gemini-test', effort: 'low' }),
      ...overrides,
    }));
    managers.push(manager);
    await manager.initialize();
    const automation = await manager.create({
      name,
      prompt: 'Run',
      selectedAppIds: [],
      enabled: false,
      frequency: { type: 'hourly' },
      runtime: { provider: 'antigravity', model: 'gemini-test', effort: 'low' },
    });
    await manager.runNow(automation.id);
    return { manager, automation, run: await waitForRun(manager, automation.id, (entry) => entry?.status !== 'queued' && entry?.status !== 'running') };
  };

  const authMissing = await runCase('Auth missing', {});
  assert.equal(authMissing.run.error, 'antigravity_auth_missing');
  assert.match(authMissing.run.userMessage, /sesion activa/);

  const cliMissing = await runCase('CLI missing', {
    getAntigravityAuthenticated: async () => true,
  });
  assert.equal(cliMissing.run.error, 'antigravity_cli_missing');
  assert.match(cliMissing.run.userMessage, /no esta listo/);

  const succeeded = await runCase('Success', {
    getAntigravityAuthenticated: async () => true,
    getAntigravityCliPath: async () => fakeCli,
  });
  assert.equal(succeeded.run.status, 'succeeded');
  assert.equal(succeeded.run.userMessage, 'Antigravity done');
});

test('Given invalid, just-due, and future schedules, when initialization runs, then recovery and timer disposal are deterministic', async (t) => {
  const root = await tmpRoot('automation-schedules');
  const metadataRoot = path.join(root, 'metadata');
  await fs.mkdir(metadataRoot, { recursive: true });
  const now = Date.now();
  const base = {
    prompt: 'Run',
    frequency: { type: 'hourly' },
    selectedAppIds: [],
    enabled: true,
    running: false,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  await fs.writeFile(path.join(metadataRoot, 'automations.json'), JSON.stringify([
    { ...base, id: 'invalid', name: 'Invalid', missedRunPolicy: 'skip', nextRunAt: 'not-a-date' },
    { ...base, id: 'due', name: 'Due', missedRunPolicy: 'skip', nextRunAt: new Date(now - 1_000).toISOString() },
    { ...base, id: 'future', name: 'Future', nextRunAt: new Date(now + 86_400_000).toISOString() },
  ]));
  const updates = [];
  const manager = new AutomationManager(makeOptions(root, {
    metadataRoot,
    getCodexAuthenticated: async () => false,
    onAutomationUpdated: (event) => updates.push(event),
  }));
  t.after(async () => {
    manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  await manager.initialize();
  const invalidRun = await waitForRun(manager, 'invalid', (run) => run?.status === 'skipped');
  const dueRun = await waitForRun(manager, 'due', (run) => run?.status === 'failed');
  assert.equal(invalidRun.error, 'automation_invalid_schedule');
  assert.match(invalidRun.userMessage, /fecha programada invalida/);
  assert.equal(dueRun.error, 'codex_auth_missing');
  assert.equal(manager.timers.has('future'), true);
  manager.dispose();
  assert.equal(manager.timers.size, 0);
  assert.equal(updates.some((event) => event.run?.error === 'automation_invalid_schedule'), true);
});

test('Given timer callbacks and schedule races, when internal state disappears, then callbacks and cleanup return safely', async (t) => {
  const root = await tmpRoot('automation-races');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const callbacks = [];
  const cleared = [];
  globalThis.setTimeout = (callback) => {
    callbacks.push(callback);
    return { fake: callbacks.length };
  };
  globalThis.clearTimeout = (timer) => cleared.push(timer);
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const manager = new AutomationManager(makeOptions(root));
  await manager.initialize();
  const automation = await manager.create({
    name: 'Future',
    prompt: 'Run',
    selectedAppIds: [],
    enabled: true,
    frequency: { type: 'hourly' },
  });
  assert.equal(callbacks.length, 1);
  const scheduledAgain = [];
  manager.scheduleAutomation = async (id) => { scheduledAgain.push(id); };
  callbacks[0]();
  assert.deepEqual(scheduledAgain, [automation.id]);
  manager.dispose();
  assert.equal(cleared.length, 1);

  await manager.handleDueScheduledRun('missing');
  await manager.skipMissedRun('missing', 'automation_missed_schedule');
  manager.automations.get(automation.id).enabled = false;
  await manager.handleDueScheduledRun(automation.id);

  manager.automations.get(automation.id).enabled = true;
  const originalUpdateLastRun = manager.updateLastRun.bind(manager);
  manager.updateLastRun = async () => { manager.automations.delete(automation.id); };
  await manager.skipMissedRun(automation.id, 'automation_missed_schedule');
  manager.updateLastRun = originalUpdateLastRun;
  assert.equal(manager.automations.has(automation.id), false);
});

test('Given optional update fields and legacy schedule shapes, when automations mutate, then defaults and disabled states are preserved', async (t) => {
  const root = await tmpRoot('automation-update-defaults');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new AutomationManager(makeOptions(root));
  await manager.initialize();

  await assert.rejects(manager.create({
    name: 7,
    prompt: 'Run',
    selectedAppIds: [],
    enabled: false,
    frequency: undefined,
  }), /automation_name_required/);
  const automation = await manager.create({
    name: 'Mutable',
    prompt: 'Run',
    selectedAppIds: [],
    enabled: true,
    frequency: undefined,
  });
  assert.deepEqual(automation.frequency, { type: 'hourly' });
  const updated = await manager.update({
    id: automation.id,
    name: 'Mutable',
    prompt: 'Run again',
    selectedAppIds: [],
    enabled: false,
    frequency: { type: 'weekly', weeklyDay: 1.5 },
    runtime: { provider: 'codex', model: 'updated-model', effort: 'high' },
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, null);
  assert.equal(updated.frequency.weeklyDay, 1);
  assert.equal(updated.runtime.model, 'updated-model');

  await manager.markAutomationRunning(automation.id, true);
  assert.equal(manager.list()[0].running, true);
  assert.equal(manager.list()[0].lastRun, undefined);

  const indexPath = path.join(root, 'metadata', 'automation-runs', `${automation.id}.index.json`);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify({ run: 'not-an-array' }));
  assert.deepEqual(await manager.listRuns(automation.id), []);

  manager.automations.get(automation.id).missedRunWindowMinutes = undefined;
  manager.automations.get(automation.id).enabled = true;
  manager.automations.get(automation.id).nextRunAt = new Date(Date.now() - 2 * 60_000).toISOString();
  manager.automations.get(automation.id).missedRunPolicy = 'within_window';
  manager.startRun = async () => undefined;
  await manager.handleDueScheduledRun(automation.id);

  manager.automations.get(automation.id).enabled = false;
  await manager.skipMissedRun(automation.id, 'automation_missed_schedule');
  assert.equal(manager.automations.get(automation.id).nextRunAt, null);

  manager.runsRoot = () => path.parse(process.cwd()).root;
  assert.equal(manager.runStoragePath(path.parse(process.cwd()).root), path.parse(process.cwd()).root);
  manager.dispose();
});

test('Given Claude output and failed Codex processes, when runs finish, then provider parsing and fallback errors are persisted', async (t) => {
  const root = await tmpRoot('automation-provider-results');
  const claudeCli = path.join(root, 'fake-claude.js');
  const stdoutFailureCli = path.join(root, 'stdout-failure.js');
  const silentFailureCli = path.join(root, 'silent-failure.js');
  await fs.writeFile(claudeCli, [
    '#!/usr/bin/env node',
    'console.log(JSON.stringify({ message: { content: "Claude complete" } }));',
  ].join('\n'));
  await fs.writeFile(stdoutFailureCli, '#!/usr/bin/env node\nconsole.log("stdout failure"); process.exit(1);\n');
  await fs.writeFile(silentFailureCli, '#!/usr/bin/env node\nprocess.exit(1);\n');
  await Promise.all([claudeCli, stdoutFailureCli, silentFailureCli].map((filePath) => fs.chmod(filePath, 0o755)));
  const managers = [];
  t.after(async () => {
    for (const manager of managers) manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const execute = async (name, options) => {
    const manager = new AutomationManager(makeOptions(path.join(root, name), options));
    managers.push(manager);
    await manager.initialize();
    const automation = await manager.create({
      name,
      prompt: 'Run',
      selectedAppIds: options.selectedAppIds ?? [],
      enabled: false,
      frequency: { type: 'hourly' },
    });
    const run = await manager.createRunRecord(automation, 'manual', 'queued');
    await manager.executeRun(automation.id, run.id);
    return await manager.getRunTranscript(run.id);
  };

  const claude = await execute('Claude', {
    getAgentRuntime: async () => ({ provider: 'claude', model: 'claude-test', effort: 'low' }),
    getClaudeCliPath: async () => claudeCli,
  });
  assert.equal(claude.status, 'succeeded');
  assert.equal(claude.userMessage, 'Claude complete');

  const stdoutFailure = await execute('Stdout failure', {
    getCodexCliPath: async () => stdoutFailureCli,
    getInstalledApps: () => [{ id: 'unnamed-app', status: 'installed' }],
    selectedAppIds: ['unnamed-app'],
  });
  assert.equal(stdoutFailure.error, 'stdout failure');

  const silentFailure = await execute('Silent failure', {
    getCodexCliPath: async () => silentFailureCli,
  });
  assert.equal(silentFailure.error, 'codex_exec_failed');
});

test('Given legacy run records and non-Error failures, when execution recovers, then existing progress is preserved without leaking internals', async (t) => {
  const root = await tmpRoot('automation-legacy-runs');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new AutomationManager(makeOptions(root, {
    getAgentRuntime: async () => { throw 'provider rejected'; },
  }));
  await manager.initialize();
  const automation = await manager.create({
    name: 'Legacy run',
    prompt: 'Run',
    selectedAppIds: [],
    enabled: false,
    frequency: { type: 'hourly' },
  });
  const preserved = await manager.createRunRecord(automation, 'manual', 'queued');
  const preservedPath = path.join(root, 'metadata', 'automation-runs', `${preserved.id}.json`);
  await fs.writeFile(preservedPath, JSON.stringify({
    ...preserved,
    userMessage: 'Existing progress',
    userMessages: ['Existing progress'],
  }));
  await manager.executeRun(automation.id, preserved.id);
  const preservedResult = await manager.getRunTranscript(preserved.id);
  assert.equal(preservedResult.error, 'automation_run_failed');
  assert.equal(preservedResult.userMessage, 'Existing progress');
  assert.deepEqual(preservedResult.userMessages, ['Existing progress']);

  const missingFields = await manager.createRunRecord(automation, 'manual', 'queued');
  const missingPath = path.join(root, 'metadata', 'automation-runs', `${missingFields.id}.json`);
  const withoutMessages = { ...missingFields };
  delete withoutMessages.userMessage;
  delete withoutMessages.userMessages;
  await fs.writeFile(missingPath, JSON.stringify(withoutMessages));
  manager.options.getAgentRuntime = async () => ({ provider: 'codex', model: 'test', effort: 'low' });
  manager.options.getCodexCliPath = async () => process.execPath;
  manager.options.createForgerMcpSession = () => { throw new Error('session setup failed'); };
  await manager.executeRun(automation.id, missingFields.id);
  const missingResult = await manager.getRunTranscript(missingFields.id);
  assert.equal(missingResult.error, 'session setup failed');
  assert.equal(missingResult.userMessage, 'La automatizacion no se pudo completar.');
  manager.dispose();
});
