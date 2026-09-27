import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';

import { loadCatalog, selectTasks, summarizeResults } from '../../scripts/local-development/catalog.mjs';
import { digest, snapshotTree, verifyProtectedFiles, prepareFixture } from '../../scripts/local-development/fixtures.mjs';
import { acceptancePassed, executeLocalAgent, immutableFixtureMounts, requiredChecks, resolveLocalDockerEndpoint, runBenchmarkTask, stageEvaluationInput } from '../../scripts/local-development/runner.mjs';
import { configurationFromOptions, parseArguments } from '../../scripts/local-development/benchmark.mjs';
import { compareReports } from '../../scripts/local-development/compare.mjs';
import { applyReferenceSolution } from '../../scripts/local-development/references.mjs';
import { classifyControl } from '../../scripts/local-development/controls.mjs';

const rootDir = path.resolve(import.meta.dirname, '../..');
const catalog = await loadCatalog(rootDir);

test('frontend regression environment preserves fixture defaults instead of inheriting runtime URL overrides', async () => {
  const { frontendTestEnvironment } = await import('../../benchmarks/local-development/evaluator/environment.mjs');
  const runtime = { PATH: '/usr/bin', VITE_API_BASE_URL: 'http://127.0.0.1:8000', DATABASE_URL: 'sqlite:////scratch/acceptance.sqlite' };
  const testing = frontendTestEnvironment(runtime);
  assert.equal(Object.hasOwn(testing, 'VITE_API_BASE_URL'), false);
  assert.equal(testing.PATH, runtime.PATH);
  assert.equal(testing.DATABASE_URL, runtime.DATABASE_URL);
  assert.equal(runtime.VITE_API_BASE_URL, 'http://127.0.0.1:8000');
  assert.deepEqual(frontendTestEnvironment({}), {});
});

test('reviewable reference solutions change only disposable source/additional tests and preserve protected originals', async () => {
  const pin = JSON.parse(await fs.readFile(path.join(rootDir, 'benchmarks/local-development/skeleton-pin.json'), 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-references-'));
  try {
    for (const task of selectTasks(catalog, { suite: 'all' })) {
      const workspace = path.join(temporary, task.id);
      const fixture = await prepareFixture({ sourceRoot: path.join(rootDir, 'resources/app-skeletons/vite-fastapi-sqlite'), workspace, pin, task });
      const reference = await applyReferenceSolution({ workspace, taskId: task.id });
      assert.ok(reference.changedFiles.length > 0);
      assert.ok(reference.addedTests.length > 0);
      assert.equal(reference.referenceHash.length, 64);
      assert.deepEqual(await verifyProtectedFiles(workspace, fixture.protectedFiles), []);
      for (const file of reference.changedFiles) assert.ok(file.startsWith('backend/src/app/') || file.startsWith('frontend/src/') || /^backend\/tests\/test_[^/]+\.py$/.test(file), file);
    }
    await assert.rejects(applyReferenceSolution({ workspace: temporary, taskId: 'planned-unknown' }), /reference_not_available/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('negative controls count only the expected functional rejection, never environment failures', () => {
  const checks = requiredChecks.map((name) => ({ name, passed: true, completedCheckGroups: 1 }));
  assert.equal(classifyControl({ kind: 'reference', taskId: 'template-01', evaluation: { passed: true, checks } }).status, 'passed');
  assert.equal(classifyControl({ kind: 'initial', taskId: 'template-01', evaluation: { passed: true, checks } }).status, 'failed');
  const index = checks.findIndex((check) => check.name === 'task_acceptance');
  const expectedFailure = [...checks.slice(0, index), { name: 'task_acceptance', passed: false, completedCheckGroups: 0, error: '404 expected 200' }];
  assert.equal(classifyControl({ kind: 'initial', taskId: 'template-01', evaluation: { passed: false, checks: expectedFailure } }).status, 'passed');
  assert.equal(classifyControl({ kind: 'initial', taskId: 'template-01', evaluation: { passed: false, checks: [{ name: 'frontend_build', passed: false, completedCheckGroups: 0 }] } }).status, 'failed');
  assert.equal(classifyControl({ kind: 'initial', taskId: 'template-01', evaluation: { passed: false, checks: [], error: 'container_unavailable' } }).status, 'failed');
  assert.equal(classifyControl({ kind: 'reference', taskId: 'template-01', evaluation: { passed: false, checks: expectedFailure } }).status, 'failed');
});

test('real skeleton fixtures materialize and protect the commons files mounted by their compose contract', async () => {
  const sourceRoot = path.join(rootDir, 'resources/app-skeletons/vite-fastapi-sqlite');
  const pin = JSON.parse(await fs.readFile(path.join(rootDir, 'benchmarks/local-development/skeleton-pin.json'), 'utf8'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-commons-fixture-'));
  try {
    const fixture = await prepareFixture({ sourceRoot, workspace: path.join(temporary, 'app'), pin, task: { fixture: 'template' } });
    assert.equal(fixture.preparation.commonsOverlays.length, 14);
    assert.equal(fixture.preparation.sha256.length, 64);
    const original = await snapshotTree(sourceRoot);
    assert.equal(original.digest, pin.digest);
    for (const overlay of fixture.preparation.commonsOverlays) {
      assert.equal(fixture.snapshot.files[overlay.destination], original.files[overlay.source]);
      assert.equal(fixture.protectedFiles[overlay.destination], original.files[overlay.source]);
    }
    const changed = 'backend/src/app/forger_desktop.py';
    await fs.writeFile(path.join(fixture.workspace, changed), 'modified protected commons');
    assert.deepEqual(await verifyProtectedFiles(fixture.workspace, fixture.protectedFiles), [changed]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('benchmark separates 30 provisional tasks from the five executable acceptance fixtures', () => {
  assert.equal(catalog.tasks.length, 30);
  assert.equal(new Set(catalog.tasks.map((task) => task.id)).size, 30);
  assert.equal(catalog.tasks.filter((task) => task.state === 'executable').length, 5);
  assert.equal(new Set(catalog.tasks.map((task) => task.family)).size, 5);
  for (const task of catalog.tasks) {
    if (task.state === 'planned') { assert.ok(task.pendingReason); continue; }
    assert.ok(task.instruction);
    assert.ok(task.acceptance.length);
    assert.ok(task.regression.length);
    assert.ok(task.initialState);
    assert.ok(task.budget.timeMs > 0);
    assert.ok(task.budget.toolCalls > 0);
    assert.equal(task.estimated.tokenCount.value, null);
    assert.ok(task.estimated.tokenCount.reason);
    assert.equal(task.source.dataClassification, 'synthetic');
  }
  assert.equal(selectTasks(catalog, { suite: 'holdout' }).length, 1);
  assert.equal(selectTasks(catalog, { suite: 'development' }).length, 4);
  assert.throws(() => selectTasks(catalog, { taskIds: ['crud-02'] }), /not executable/);
});

test('summary keeps failures and intervention in denominators and reports variability', () => {
  const results = [
    { taskId: 'a', status: 'passed', attempted: true, intervention: false, elapsedMs: 10 },
    { taskId: 'a', status: 'passed', attempted: true, intervention: true, elapsedMs: 30 },
    { taskId: 'b', status: 'failed', attempted: true, intervention: false, elapsedMs: 99 },
    { taskId: 'c', status: 'blocked', attempted: false, intervention: false, elapsedMs: 0 },
  ];
  const summary = summarizeResults(results);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.selected, 4);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.passed, 2);
  assert.equal(summary.autonomousPassed, 1);
  assert.equal(summary.successRate, 2 / 3);
  assert.equal(summary.autonomousSuccessRate, 1 / 3);
  assert.deepEqual(summary.solvedTimeMs, { n: 2, mean: 20, min: 10, max: 30, sampleStandardDeviation: Math.sqrt(200) });
  assert.equal(summarizeResults([]).successRate, null);
});

test('fixture copies only pinned public skeleton files and detects changed protected tests/config', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-benchmark-fixture-'));
  try {
    const source = path.join(temporary, 'source');
    await fs.mkdir(path.join(source, 'backend/tests'), { recursive: true });
    await fs.mkdir(path.join(source, 'backend/src/app'), { recursive: true });
    await fs.writeFile(path.join(source, 'backend/tests/test_contract.py'), 'assert True\n');
    await fs.writeFile(path.join(source, 'backend/src/app/main.py'), 'x = 1\n');
    await fs.writeFile(path.join(source, '.env'), 'DO_NOT_COPY=secret');
    const snapshot = await snapshotTree(source);
    assert.equal(Object.hasOwn(snapshot.files, '.env'), false);
    const workspace = path.join(temporary, 'workspace');
    const fixture = await prepareFixture({ sourceRoot: source, workspace, pin: snapshot, task: { fixture: 'template' } });
    await assert.rejects(fs.stat(path.join(workspace, '.env')), /ENOENT/);
    await fs.writeFile(path.join(workspace, 'backend/src/app/main.py'), 'x = 2\n');
    assert.deepEqual(await verifyProtectedFiles(workspace, fixture.protectedFiles), []);
    await fs.writeFile(path.join(workspace, 'backend/tests/test_contract.py'), 'assert False\n');
    assert.deepEqual(await verifyProtectedFiles(workspace, fixture.protectedFiles), ['backend/tests/test_contract.py']);
    await fs.writeFile(path.join(source, 'backend/src/app/main.py'), 'changed after pin');
    await assert.rejects(prepareFixture({ sourceRoot: source, workspace: path.join(temporary, 'bad'), pin: snapshot, task: { fixture: 'template' } }), /skeleton_pin_mismatch/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('fixture refuses symbolic links instead of following paths outside the synthetic workspace', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-benchmark-link-'));
  try {
    await fs.symlink('/etc/passwd', path.join(temporary, 'external'));
    await assert.rejects(snapshotTree(temporary), /symlink_not_allowed/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('missing Docker is blocked before provider invocation, never a synthetic success', async () => {
  let providerRuns = 0;
  const result = await runBenchmarkTask({
    task: catalog.tasks[0], config: { model: 'test', modelDigest: 'sha256:test', endpoint: 'http://127.0.0.1:11434', contextWindow: 4096 },
    prerequisites: async () => ({ ready: false, reason: 'docker_unavailable' }),
    executeAgent: async () => { providerRuns += 1; },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.attempted, false);
  assert.equal(result.blocker, 'docker_unavailable');
  assert.equal(providerRuns, 0);
  assert.equal(result.metrics.timeToFirstTokenMs.value, null);
  assert.ok(result.metrics.timeToFirstTokenMs.reason);
  assert.equal(result.observed.modifiedFiles, null);
  assert.equal(result.observed.unexpectedFiles, null);
  assert.equal(result.protectedFileChanges, null);
  assert.deepEqual(result.observed.fileInspection, { status: 'not_attempted', reason: 'agent_not_started' });
});

test('agent completion text does not count as acceptance; protected file tampering fails', async () => {
  for (const tamper of [false, true]) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-benchmark-outcome-'));
    try {
      const workspace = path.join(temporary, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(path.join(workspace, 'guard.json'), '{}');
      const before = await snapshotTree(workspace);
      let evaluated = false;
      const result = await runBenchmarkTask({
        task: catalog.tasks[0], config: { model: 'fake', modelDigest: 'sha256:fake', endpoint: 'http://127.0.0.1:11434', contextWindow: 4096 },
        prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace, protectedFiles: before.files, snapshot: before }),
        executeAgent: async () => {
          if (tamper) await fs.writeFile(path.join(workspace, 'guard.json'), '{"changed":true}');
          return { code: 0, assistantText: 'Everything passes', stdout: '', stderr: '', toolEvents: 0 };
        },
        evaluate: async () => { evaluated = true; return { passed: false, checks: [{ name: 'acceptance', passed: false }] }; },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.attempted, true);
      assert.equal(result.failure, tamper ? 'protected_files_changed' : 'acceptance_failed');
      assert.equal(evaluated, !tamper);
      assert.equal(result.evidenceClass, 'controlled_test');
      assert.equal(result.observed.fileInspection.status, 'completed');
      assert.deepEqual(result.observed.modifiedFiles, tamper ? ['guard.json'] : []);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
});

test('all immutable acceptance groups must explicitly pass as completed groups', () => {
  assert.equal(acceptancePassed({ passed: true, checks: [] }), false);
  assert.equal(acceptancePassed({ passed: true, checks: [{ name: 'acceptance', passed: true, completedCheckGroups: 100 }] }), false);
  const checks = requiredChecks.map((name) => ({ name, passed: true, completedCheckGroups: 1 }));
  assert.equal(acceptancePassed({ passed: true, checks }), true);
  assert.equal(acceptancePassed({ passed: true, checks: [...checks, checks[0]] }), false);
  assert.equal(acceptancePassed({ passed: true, checks: checks.map((entry, index) => index === 0 ? { ...entry, completedCheckGroups: 0 } : entry) }), false);
});

test('staging excludes injected environments, databases, secrets and build artifacts', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-stage-test-'));
  let staging;
  try {
    await fs.mkdir(path.join(temporary, 'frontend/src'), { recursive: true });
    await fs.writeFile(path.join(temporary, 'frontend/src/Screen.tsx'), 'export const value = 1;');
    await fs.writeFile(path.join(temporary, '.env'), 'FAKE_SECRET=not-for-evaluator');
    await fs.mkdir(path.join(temporary, 'backend/data'), { recursive: true });
    await fs.writeFile(path.join(temporary, 'backend/data/untrusted.sqlite'), 'not-a-db');
    await fs.symlink('/nonexistent-external', path.join(temporary, 'node_modules'));
    staging = await stageEvaluationInput(temporary);
    assert.equal((await fs.stat(staging)).mode & 0o777, 0o755);
    assert.deepEqual(Object.keys((await snapshotTree(staging)).files), ['frontend/src/Screen.tsx']);
    for (const name of ['.env', 'node_modules', 'backend/data']) await assert.rejects(fs.stat(path.join(staging, name)), /ENOENT/);
  } finally {
    if (staging) await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test('evaluator mounts every supplied source, test, config and shared file read-only at execution paths', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-mount-plan-'));
  try {
    for (const directory of ['backend/src/app', 'backend/tests', 'frontend/src', 'commons/backend']) await fs.mkdir(path.join(temporary, directory), { recursive: true });
    for (const file of ['backend/pyproject.toml', 'frontend/package.json', 'frontend/vite.config.ts', 'manifest.json']) await fs.writeFile(path.join(temporary, file), '{}');
    const mounts = await immutableFixtureMounts(temporary);
    for (const suffix of ['backend/src', 'backend/tests', 'backend/pyproject.toml', 'frontend/src', 'frontend/package.json', 'frontend/vite.config.ts', 'commons', 'manifest.json']) {
      assert.ok(mounts.includes(`type=bind,source=${path.join(temporary, suffix)},target=/work/app/${suffix},readonly`));
    }
    assert.equal(mounts.length, 8);
    assert.ok(mounts.every((mount) => mount.endsWith(',readonly')));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('new test hooks and false positive evaluator reports cannot produce success', async () => {
  for (const newFile of ['backend/tests/conftest.py', 'pytest.ini', 'backend/src/sitecustomize.py', null]) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-policy-test-'));
    try {
      await fs.writeFile(path.join(temporary, 'guard.json'), '{}');
      const before = await snapshotTree(temporary);
      const result = await runBenchmarkTask({
        task: catalog.tasks[0], config: {},
        prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace: temporary, snapshot: before, protectedFiles: before.files }),
        executeAgent: async () => {
          if (newFile) { await fs.mkdir(path.dirname(path.join(temporary, newFile)), { recursive: true }); await fs.writeFile(path.join(temporary, newFile), 'untrusted'); }
          return { code: 0, assistantText: 'Done' };
        },
        evaluate: async () => ({ passed: true, checks: [] }),
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failure, newFile ? 'protected_files_changed' : 'acceptance_failed');
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
});

test('tool and time budgets abort the active run, preserving failed attempts', async () => {
  for (const trigger of ['tools', 'time']) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-budget-test-'));
    try {
      const before = await snapshotTree(temporary);
      const task = { ...catalog.tasks[0], budget: { ...catalog.tasks[0].budget, toolCalls: 1, timeMs: trigger === 'time' ? 10 : 1000 } };
      let wasAborted = false;
      const result = await runBenchmarkTask({
        task, config: {}, prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace: temporary, snapshot: before, protectedFiles: {} }),
        executeAgent: async ({ onOutput, signal }) => {
          if (trigger === 'tools') {
            for (const id of ['a', 'a', 'b']) onOutput('stdout', `${JSON.stringify({ type: 'item.completed', item: { id, type: 'command_execution' } })}\n`);
          }
          await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
          wasAborted = signal.aborted;
          throw Object.assign(new Error('aborted'), { localInference: { agentProfile: 'compact-v1', runtimeVersion: 'synthetic', contractSha256: 'd'.repeat(64) } });
        },
      });
      assert.equal(wasAborted, true);
      assert.equal(result.status, 'failed');
      assert.equal(result.attempted, true);
      assert.equal(result.failure, trigger === 'tools' ? 'tool_budget_exceeded' : 'time_budget_exceeded');
      assert.equal(result.observed.timeouts, trigger === 'time' ? 1 : 0);
      assert.equal(result.agent.metadata.agentProfile, 'compact-v1');
      assert.equal(result.agent.metadata.runtimeVersion, 'synthetic');
      if (trigger === 'tools') assert.equal(result.observed.toolCalls, 2);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
});

test('failed runs retain observed provider metadata without inventing evidence for preflight errors', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-failure-metadata-'));
  try {
    const before = await snapshotTree(temporary);
    const metadata = { agentProfile: 'single-agent-v1', runtimeVersion: 'synthetic', modelDigest: 'sha256:observed', effectiveRuntimeContext: null };
    for (const scenario of ['throw_with_metadata', 'nonzero_with_metadata', 'preflight_error']) {
      const result = await runBenchmarkTask({
        task: catalog.tasks[0], config: { agentProfile: 'single-agent-v1' },
        prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace: temporary, snapshot: before, protectedFiles: {} }),
        executeAgent: async () => {
          if (scenario === 'preflight_error') throw new Error('local_model_not_installed');
          if (scenario === 'throw_with_metadata') throw Object.assign(new Error('local_inference_timeout'), { localInference: metadata });
          return { code: 1, localInference: metadata, assistantText: 'Not completed' };
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.attempted, true);
      assert.ok(result.agentElapsedMs >= 0);
      assert.equal(result.configuration.agentProfile, 'single-agent-v1');
      assert.equal(result.configurationHash, digest(JSON.stringify(result.configuration)));
      if (scenario === 'preflight_error') assert.equal(result.agent?.metadata ?? null, null);
      else assert.deepEqual(result.agent.metadata, metadata);
      assert.equal(result.failure, scenario === 'preflight_error' ? 'local_model_not_installed' : scenario === 'throw_with_metadata' ? 'local_inference_timeout' : 'agent_nonzero_exit');
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('agent errors and nonzero exits retain file changes observed after the attempt', async () => {
  for (const exit of ['throw', 'nonzero']) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-failed-edit-'));
    try {
      await fs.mkdir(path.join(temporary, 'frontend/src'), { recursive: true });
      await fs.writeFile(path.join(temporary, 'frontend/src/Screen.tsx'), 'before');
      const before = await snapshotTree(temporary);
      let evaluated = false;
      const result = await runBenchmarkTask({
        task: catalog.tasks[0], config: {},
        prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace: temporary, snapshot: before, protectedFiles: {} }),
        executeAgent: async () => {
          await fs.writeFile(path.join(temporary, 'frontend/src/Screen.tsx'), 'after');
          if (exit === 'throw') throw new Error('local_inference_timeout');
          return { code: 1 };
        },
        evaluate: async () => { evaluated = true; },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failure, exit === 'throw' ? 'local_inference_timeout' : 'agent_nonzero_exit');
      assert.deepEqual(result.observed.modifiedFiles, ['frontend/src/Screen.tsx']);
      assert.deepEqual(result.observed.unexpectedFiles, []);
      assert.deepEqual(result.protectedFileChanges, []);
      assert.equal(result.observed.fileInspection.status, 'completed');
      assert.equal(evaluated, false);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
});

test('protected mutations are reported after agent failure without replacing the original failure', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-failed-protected-edit-'));
  try {
    await fs.writeFile(path.join(temporary, 'guard.json'), '{}');
    const before = await snapshotTree(temporary);
    const result = await runBenchmarkTask({
      task: catalog.tasks[0], config: {},
      prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
      materialize: async () => ({ workspace: temporary, snapshot: before, protectedFiles: before.files }),
      executeAgent: async () => {
        await fs.writeFile(path.join(temporary, 'guard.json'), '{"changed":true}');
        throw new Error('local_cli_failed');
      },
    });
    assert.equal(result.failure, 'local_cli_failed');
    assert.deepEqual(result.protectedFileChanges, ['guard.json']);
    assert.deepEqual(result.observed.modifiedFiles, ['guard.json']);
    assert.equal(result.observed.fileInspection.status, 'completed');
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('unavailable snapshots report unknown edits, preserve agent failure, and block acceptance', async () => {
  for (const agentFails of [false, true]) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-unavailable-inspection-'));
    try {
      await fs.writeFile(path.join(temporary, 'guard.json'), '{}');
      const before = await snapshotTree(temporary);
      let evaluated = false;
      const result = await runBenchmarkTask({
        task: catalog.tasks[0], config: {},
        prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace: temporary, snapshot: before, protectedFiles: before.files }),
        executeAgent: async () => {
          await fs.symlink('guard.json', path.join(temporary, 'unsafe-link'));
          if (agentFails) throw new Error('local_cli_failed');
          return { code: 0 };
        },
        evaluate: async () => { evaluated = true; },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failure, agentFails ? 'local_cli_failed' : 'workspace_inspection_unavailable');
      assert.equal(result.observed.modifiedFiles, null);
      assert.equal(result.observed.unexpectedFiles, null);
      assert.deepEqual(result.protectedFileChanges, []);
      assert.equal(result.observed.fileInspection.status, 'partial');
      assert.equal(result.observed.fileInspection.snapshot.status, 'unavailable');
      assert.match(result.observed.fileInspection.snapshot.reason, /symlink_not_allowed: unsafe-link/);
      assert.equal(result.observed.fileInspection.protectedFiles.status, 'completed');
      assert.equal(evaluated, false);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
});

test('benchmark configuration records a strict agent profile, defaults to baseline, and hashes it', () => {
  assert.equal(configurationFromOptions({}).agentProfile, 'baseline-v1');
  const configurations = ['baseline-v1', 'single-agent-v1', 'single-agent-no-thinking-v1', 'compact-v1'].map((agentProfile) => {
    const options = parseArguments(['--run', '--agent-profile', agentProfile]);
    const configuration = configurationFromOptions(options);
    assert.equal(configuration.agentProfile, agentProfile);
    return digest(JSON.stringify(configuration));
  });
  assert.equal(new Set(configurations).size, 4);
  assert.throws(() => configurationFromOptions({ 'agent-profile': 'automatic' }), /agent.profile/i);
  assert.throws(() => parseArguments(['--agent-profile', 'compact-v1', '--agent-profile', 'baseline-v1']), /duplicate/);
});

test('CLI refuses unknown and duplicate switches; comparison excludes failures only from paired timing', () => {
  assert.deepEqual(parseArguments(['--run', '--model', 'pinned']), { run: true, model: 'pinned' });
  assert.throws(() => parseArguments(['--allow-cloud']), /Invalid/);
  assert.throws(() => parseArguments(['--run', '--run']), /duplicate/);
  assert.throws(() => parseArguments(['--model']), /Missing/);
  const base = { protocol: 'same', comparisonMode: 'controlled', forger: { revision: 'commit', sourceSha256: 'source', compiledProviderSha256: 'compiled', harnessSha256: 'hash' } };
  const success = { taskId: 'one', trial: 1, status: 'passed', attempted: true, evidenceClass: 'real_model', elapsedMs: 20, taskHash: 'task', acceptanceHash: 'acceptance', promptHash: 'prompt', initialStateHash: 'initial', budget: { timeMs: 1000 }, prerequisites: { evaluatorImage: 'sha256:image', cliSha256: 'cli-hash' }, configuration: { contextWindow: 4096 }, intervention: false };
  const failed = { ...success, taskId: 'two', status: 'failed' };
  const a = { ...base, results: [success, failed] };
  const b = { ...base, results: [{ ...success, elapsedMs: 40 }, { ...failed, status: 'passed' }] };
  const compared = compareReports(a, b);
  assert.equal(compared.left.successRate, 0.5);
  assert.equal(compared.right.successRate, 1);
  assert.equal(compared.pairedSolved.n, 1);
  assert.equal(compared.excludedFromPairedTime.length, 1);
  assert.throws(() => compareReports(a, { ...b, results: [{ ...success, promptHash: 'different' }] }), /incomparable_promptHash/);
  assert.throws(() => compareReports(a, { ...b, results: [{ ...success, prerequisites: { ...success.prerequisites, evaluatorImage: 'different' } }] }), /incomparable_evaluatorImage/);
  assert.throws(() => compareReports(a, { ...b, results: [{ ...success, prerequisites: { evaluatorImage: success.prerequisites.evaluatorImage } }] }), /incomparable_cliSha256/);
  assert.throws(() => compareReports(a, { ...b, results: [{ ...success, evidenceClass: 'controlled_test' }] }), /not_model_evidence/);
  const serial = { ...a, executionProfile: 'm1-serial-v1', networkPolicy: 'codex-workspace' };
  assert.throws(() => compareReports(serial, { ...b, executionProfile: 'm1-serial-v1', networkPolicy: 'outer-seatbelt' }), /incomparable_network_policy/);
  assert.throws(() => compareReports(serial, { ...b, executionProfile: 'm1-serial-v1' }), /incomparable_network_policy/);
  assert.equal(compareReports(serial, { ...b, executionProfile: 'm1-serial-v1', networkPolicy: 'codex-workspace' }).pairedSolved.n, 1);
  const withProfile = (profile) => ({ ...b, results: b.results.map((entry) => ({ ...entry, configuration: { ...entry.configuration, agentProfile: profile } })) });
  assert.equal(compareReports(a, withProfile('baseline-v1')).pairedSolved.n, 1, 'historical omission means baseline only');
  assert.throws(() => compareReports(a, withProfile('single-agent-v1')), /incomparable_agent_profile/);
  assert.throws(() => compareReports(withProfile('single-agent-v1'), withProfile('compact-v1')), /incomparable_agent_profile/);
  assert.throws(() => compareReports(a, withProfile(null)), /invalid_agent_profile/);
  assert.throws(() => compareReports(a, { ...withProfile('baseline-v1'), forger: { ...base.forger, harnessSha256: 'other-harness' } }), /incomparable_forger_harnessSha256/);
});

test('remote Docker contexts are rejected before contacting a daemon; local socket contexts work', async () => {
  let calls = 0;
  const never = async () => { calls += 1; throw new Error('must not contact Docker'); };
  assert.deepEqual(await resolveLocalDockerEndpoint({ DOCKER_HOST: 'tcp://cloud.example:2376' }, never), { local: false, reason: 'remote_docker_endpoint_forbidden' });
  assert.deepEqual(await resolveLocalDockerEndpoint({ DOCKER_HOST: 'ssh://someone@example.test' }, never), { local: false, reason: 'remote_docker_endpoint_forbidden' });
  assert.equal(calls, 0);
  assert.deepEqual(await resolveLocalDockerEndpoint({ DOCKER_HOST: 'unix:///tmp/docker.sock' }, never), { local: true });
  const selected = await resolveLocalDockerEndpoint({ DOCKER_CONTEXT: 'local-desktop', DOCKER_HOST: 'tcp://ignored:2376' }, async (command, args) => {
    assert.equal(command, 'docker'); assert.deepEqual(args.slice(0, 3), ['context', 'inspect', 'local-desktop']);
    return { code: 0, stdout: 'unix:///tmp/docker.sock\n' };
  });
  assert.equal(selected.local, true);
  assert.equal((await resolveLocalDockerEndpoint({}, async () => ({ code: 0, stdout: 'tcp://remote:2376' }))).local, false);
});

test('controlled CLI evaluation traverses the compiled real provider service without cloud credentials', { skip: process.platform === 'win32' ? 'POSIX fake executable; production Windows CLI resolution has separate provider tests.' : false }, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-benchmark-provider-'));
  const modelDigest = 'a'.repeat(64);
  const requests = [];
  const runtime = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/tags') response.end(JSON.stringify({ models: [{ name: 'fixture-model', digest: modelDigest }] }));
    else if (request.url === '/api/show') response.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
    else if (request.url === '/api/version') response.end(JSON.stringify({ version: '0.34.4' }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  try {
    await new Promise((resolve) => runtime.listen(0, '127.0.0.1', resolve));
    const workspace = path.join(temporary, 'workspace');
    await fs.mkdir(path.join(workspace, 'frontend/src'), { recursive: true });
    const cliPath = path.join(temporary, 'fake-codex');
    await fs.writeFile(cliPath, `#!${process.execPath}
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.ok(process.argv.includes('--ignore-user-config'));
assert.ok(process.argv.includes('workspace-write'));
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
const prompt = fs.readFileSync(0, 'utf8');
assert.ok(prompt.includes('My local desk'));
fs.writeFileSync('frontend/src/controlled-fixture.txt', 'controlled fake edit');
console.log(JSON.stringify({type:'item.completed',item:{id:'edit-1',type:'file_change'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'message-1',type:'agent_message',text:'Done'}}));
`, { mode: 0o755 });
    const before = await snapshotTree(workspace);
    const result = await runBenchmarkTask({
      task: catalog.tasks[0],
      config: { model: 'fixture-model', modelDigest: `sha256:${modelDigest}`, contextWindow: 4096, cliPath, endpoint: `http://127.0.0.1:${runtime.address().port}`, agentProfile: 'compact-v1' },
      prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
      materialize: async () => ({ workspace, snapshot: before, protectedFiles: {} }),
      executeAgent: executeLocalAgent,
      evaluate: async () => ({ passed: true, checks: requiredChecks.map((name) => ({ name, passed: true, completedCheckGroups: 1 })) }),
    });
    assert.equal(result.status, 'passed', result.failure);
    assert.equal(result.evidenceClass, 'controlled_test');
    assert.equal(result.observed.toolCalls, 1);
    assert.deepEqual(result.observed.modifiedFiles, ['frontend/src/controlled-fixture.txt']);
    assert.equal(result.observed.fileInspection.status, 'completed');
    assert.deepEqual(requests, ['/api/tags', '/api/show', '/api/version']);
    assert.equal(result.metrics.timeToFirstTokenMs.value, null);
    assert.equal(result.configuration.agentProfile, 'compact-v1');
    assert.equal(result.configurationHash, digest(JSON.stringify(result.configuration)));
    assert.equal(result.agent.metadata.agentProfile, 'compact-v1');
    assert.equal(result.agent.metadata.requestedReasoning, 'none');
    assert.match(result.agent.metadata.contractSha256, /^[a-f0-9]{64}$/);
  } finally {
    runtime.closeAllConnections();
    await new Promise((resolve) => runtime.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
