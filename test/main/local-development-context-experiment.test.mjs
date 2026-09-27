import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createContextExperimentOrder, runContextExperiment } from '../../scripts/local-development/context-experiment.mjs';

const config = { model: 'qwen3:0.6b', modelDigest: `sha256:${'a'.repeat(64)}`, evaluatorImage: `sha256:${'b'.repeat(64)}`, contextWindow: 16384, agentProfile: 'compact-v1', cliPath: '/synthetic/codex', endpoint: 'http://127.0.0.1:11445' };
const task = { id: 'bug-01', state: 'executable', partition: 'development' };
const record = { schemaVersion: 1, protocol: 'forger-common-local-v1', comparisonMode: 'controlled', forger: { sourceSha256: 'one-fingerprint' }, results: [] };

test('v2 experiment explicitly selects its staged arm while retaining the fixed alternating protocol', async () => {
  assert.deepEqual(createContextExperimentOrder().flatMap((entry) => entry.strategies), ['direct-v1', 'staged-v1', 'staged-v1', 'direct-v1', 'direct-v1', 'staged-v1']);
  assert.throws(() => createContextExperimentOrder('direct-v1'), /staged_strategy/);
  assert.throws(() => createContextExperimentOrder('automatic'), /staged_strategy/);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-request-v2-experiment-'));
  const calls = [];
  try {
    const reports = await runContextExperiment({ config, stagedStrategy: 'staged-request-v2', limaCli: '/synthetic/limactl', vm: 'forger-local-eval', networkPolicy: 'codex-workspace', directOutput: path.join(temporary, 'direct.json'), stagedOutput: path.join(temporary, 'v2.json') }, {
      platform: 'darwin',
      loadTask: async () => ({ catalogVersion: 'synthetic', task }), makeRecord: async () => structuredClone(record),
      runTask: async (input) => { calls.push([input.trial, input.config.contextStrategy]); return { taskId: 'bug-01', trial: input.trial, attempted: true, status: 'failed', elapsedMs: 1 }; },
      stopVm: async () => ({ code: 0 }), progress: () => undefined,
    });
    assert.deepEqual(calls, [[1, 'direct-v1'], [1, 'staged-request-v2'], [2, 'staged-request-v2'], [2, 'direct-v1'], [3, 'direct-v1'], [3, 'staged-request-v2']]);
    assert.equal(reports['staged-request-v2'].summary.attempted, 3);
    assert.equal(reports['staged-request-v2'].contextExperiment.stagedStrategy, 'staged-request-v2');
    assert.equal(reports['staged-v1'], undefined);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('the experiment alternates all six real trial identities and persists each failure before continuing', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-experiment-'));
  const directOutput = path.join(temporary, 'direct.json'); const stagedOutput = path.join(temporary, 'staged.json');
  const calls = []; let fingerprints = 0; let stops = 0;
  try {
    const reports = await runContextExperiment({ config, limaCli: '/synthetic/limactl', vm: 'forger-local-eval', networkPolicy: 'codex-workspace', directOutput, stagedOutput }, {
      platform: 'darwin',
      loadTask: async () => ({ catalogVersion: 'synthetic', task }),
      makeRecord: async () => { fingerprints += 1; return structuredClone(record); },
      runTask: async (input) => {
        const saved = await Promise.all([directOutput, stagedOutput].map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));
        assert.equal(saved.reduce((sum, report) => sum + report.results.length, 0), calls.length);
        calls.push([input.trial, input.config.contextStrategy]);
        return { taskId: 'bug-01', trial: input.trial, attempted: true, status: 'failed', elapsedMs: 17, failure: input.config.contextStrategy === 'staged-v1' ? 'invalid_intent' : 'acceptance_failed' };
      },
      stopVm: async () => { stops += 1; return { code: 0 }; },
      progress: () => undefined,
    });
    assert.equal(fingerprints, 1); assert.equal(stops, 1);
    assert.deepEqual(calls, [[1, 'direct-v1'], [1, 'staged-v1'], [2, 'staged-v1'], [2, 'direct-v1'], [3, 'direct-v1'], [3, 'staged-v1']]);
    for (const strategy of ['direct-v1', 'staged-v1']) {
      assert.equal(reports[strategy].summary.attempted, 3);
      assert.equal(reports[strategy].summary.failed, 3);
      assert.deepEqual(reports[strategy].results.map((result) => result.trial), [1, 2, 3]);
      assert.equal(reports[strategy].state, 'completed_with_failures');
      assert.equal(reports[strategy].finalLifecycle[0].status, 'completed');
      assert.deepEqual(reports[strategy].forger, record.forger);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('unexpected scheduler failure preserves attempts, reports missing trials and stops only the owned VM', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-interrupted-'));
  let calls = 0; let stopped;
  try {
    const reports = await runContextExperiment({ config, limaCli: '/synthetic/limactl', vm: 'forger-local-eval', networkPolicy: 'codex-workspace', directOutput: path.join(temporary, 'direct.json'), stagedOutput: path.join(temporary, 'staged.json') }, {
      platform: 'darwin',
      loadTask: async () => ({ catalogVersion: 'synthetic', task }), makeRecord: async () => structuredClone(record),
      runTask: async () => { calls += 1; if (calls === 2) throw new Error('synthetic_scheduler_failure'); return { taskId: task.id, trial: 1, attempted: true, status: 'failed', elapsedMs: 17 }; },
      stopVm: async (input) => { stopped = input.vm; return { code: 0 }; }, progress: () => undefined,
    });
    assert.equal(stopped, 'forger-local-eval');
    assert.equal(reports['direct-v1'].results.length, 1);
    assert.equal(reports['staged-v1'].results.length, 0);
    assert.equal(reports['staged-v1'].state, 'interrupted');
    assert.equal(reports['staged-v1'].error, 'synthetic_scheduler_failure');
    assert.equal(reports['staged-v1'].summary.attempted, 0);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test('existing reports and identical output paths are rejected before any VM or model operation', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-output-'));
  try {
    const directOutput = path.join(temporary, 'direct.json'); const stagedOutput = path.join(temporary, 'staged.json');
    await fs.writeFile(stagedOutput, 'existing evidence');
    const input = { config, limaCli: '/synthetic/limactl', vm: 'forger-local-eval', networkPolicy: 'codex-workspace', directOutput, stagedOutput };
    const dependencies = { platform: 'darwin', loadTask: async () => ({ catalogVersion: 'synthetic', task }), makeRecord: async () => structuredClone(record), runTask: async () => assert.fail('must not run'), stopVm: async () => assert.fail('must not stop') };
    await assert.rejects(runContextExperiment(input, dependencies), /EEXIST/);
    assert.equal(await fs.readFile(stagedOutput, 'utf8'), 'existing evidence');
    await assert.rejects(runContextExperiment({ ...input, stagedOutput: directOutput }, dependencies), /distinct_outputs_required/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
