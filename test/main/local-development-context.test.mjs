import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configurationFromOptions, parseArguments } from '../../scripts/local-development/benchmark.mjs';
import { digest, snapshotTree } from '../../scripts/local-development/fixtures.mjs';
import { executeLocalAgent, renderPrompt, requiredChecks, runBenchmarkTask } from '../../scripts/local-development/runner.mjs';
import { compareReports } from '../../scripts/local-development/compare.mjs';
import { compareContextAblation } from '../../scripts/local-development/context-ablation.mjs';

const hash = (value) => digest(value);
const task = { id: 'bug-01', instruction: 'Trim the note title before persisting it.', partition: 'development', budget: { timeMs: 1000, toolCalls: 10, evaluationTimeMs: 1000 } };
const config = { endpoint: 'http://127.0.0.1:11445', model: 'qwen3:0.6b', modelDigest: `sha256:${hash('model')}`, contextWindow: 4096, agentProfile: 'compact-v1', cliPath: '/synthetic/codex', evaluatorImage: `sha256:${hash('image')}` };
const acceptance = { passed: true, checks: requiredChecks.map((name) => ({ name, passed: true, completedCheckGroups: 1 })) };

test('context strategy is explicit, defaults to direct and rejects unknown or duplicate values', () => {
  assert.equal(configurationFromOptions({}).contextStrategy, 'direct-v1');
  assert.equal(configurationFromOptions(parseArguments(['--context-strategy', 'staged-v1'])).contextStrategy, 'staged-v1');
  assert.equal(configurationFromOptions(parseArguments(['--context-strategy', 'staged-request-v2'])).contextStrategy, 'staged-request-v2');
  assert.throws(() => configurationFromOptions({ 'context-strategy': 'automatic' }), /context.strategy/i);
  assert.throws(() => parseArguments(['--context-strategy', 'staged-v1', '--context-strategy', 'direct-v1']), /duplicate/);
});

test('the synthetic service receives the strategy and unchanged original prompt through the real runner entry point', async () => {
  let observed;
  const returned = await executeLocalAgent({ config: { ...config, contextStrategy: 'staged-v1' }, task, fixture: { workspace: '/synthetic/workspace' } }, {
    createService: (options) => {
      assert.equal(options.enableExperimentalLocalInference, true);
      return { run: async (input) => { observed = input; return { code: 0, assistantText: 'synthetic service only' }; } };
    },
    runCommandCapture: async () => { throw new Error('not used'); },
  });
  assert.equal(observed.localInference.contextStrategy, 'staged-v1');
  assert.equal(observed.prompt, renderPrompt(task));
  assert.equal(observed.localContextRequest, task.instruction);
  assert.equal(observed.runtime.provider, 'codex');
  assert.equal(returned.code, 0);
});

test('all strategies pass exactly the same original request, including whitespace and Unicode', async () => {
  const unicodeTask = { ...task, instruction: '  Corrige el título: café ☕.\nConserva espacios.  ' };
  for (const contextStrategy of ['direct-v1', 'staged-v1', 'staged-request-v2']) {
    await executeLocalAgent({ config: { ...config, contextStrategy }, task: unicodeTask, fixture: { workspace: '/synthetic/workspace' } }, {
      createService: () => ({ run: async (input) => {
        assert.equal(input.localContextRequest, unicodeTask.instruction);
        assert.equal(input.prompt, renderPrompt(unicodeTask));
        assert.equal(input.localInference.contextStrategy, contextStrategy);
        return { code: 0 };
      } }), runCommandCapture: async () => assert.fail('must not run a model'),
    });
  }
});

test('runner preserves original/effective identities and preprocessing evidence on success, nonzero and thrown errors', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-context-record-'));
  try {
    const snapshot = await snapshotTree(workspace);
    for (const mode of ['direct', 'completed', 'failed', 'nonzero', 'request-v2', 'request-v2-failed']) {
      let evaluated = false;
      const strategy = mode === 'direct' ? 'direct-v1' : mode.startsWith('request-v2') ? 'staged-request-v2' : 'staged-v1';
      const preprocessingFailed = ['failed', 'request-v2-failed'].includes(mode);
      const contextPreparation = mode === 'direct' ? undefined : {
        strategy, status: preprocessingFailed ? 'failed' : 'completed',
        originalPromptSha256: hash(renderPrompt(task)), effectivePromptSha256: preprocessingFailed ? null : hash('effective'),
        durationMs: 12, error: preprocessingFailed ? 'invalid_intent' : null, stages: [{ name: 'intent', durationMs: 12, status: preprocessingFailed ? 'failed' : 'completed' }],
        ...(strategy === 'staged-request-v2' ? { requestSha256: hash(task.instruction), requestBytes: Buffer.byteLength(task.instruction), requestOffsetBytes: 100 } : {}),
      };
      const metadata = { runtimeVersion: 'synthetic', ...(contextPreparation ? { contextPreparation } : {}) };
      const result = await runBenchmarkTask({
        task, config: { ...config, contextStrategy: strategy },
        prerequisites: async () => ({ ready: true, evidenceClass: 'controlled_test' }),
        materialize: async () => ({ workspace, snapshot, protectedFiles: {} }),
        executeAgent: async () => {
          if (preprocessingFailed) throw Object.assign(new Error('invalid_intent'), { localInference: metadata });
          return { code: mode === 'nonzero' ? 1 : 0, localInference: metadata };
        },
        evaluate: async () => { evaluated = true; return acceptance; },
      });
      assert.equal(result.promptHash, hash(renderPrompt(task)));
      assert.equal(result.contextRequestHash, hash(task.instruction));
      assert.equal(result.effectivePromptHash, mode === 'direct' ? result.promptHash : contextPreparation.effectivePromptSha256);
      assert.deepEqual(result.agent.metadata, metadata);
      assert.equal(result.attempted, true);
      assert.equal(result.configurationHash, hash(JSON.stringify(result.configuration)));
      assert.equal(result.status, preprocessingFailed || mode === 'nonzero' ? 'failed' : 'passed');
      assert.equal(evaluated, !preprocessingFailed && mode !== 'nonzero');
      assert.ok(result.agentElapsedMs >= 0);
      assert.equal(result.observed.fileInspection.status, 'completed');
    }
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test('request-only v2 ablation requires explicit selection and matching request identities in both arms', () => {
  const direct = report('direct-v1'); const staged = report('staged-v1');
  for (const result of [...direct.results, ...staged.results]) result.contextRequestHash = hash('request');
  for (const result of staged.results) {
    result.configuration.contextStrategy = 'staged-request-v2';
    Object.assign(result.agent.metadata.contextPreparation, { strategy: 'staged-request-v2', requestSha256: hash('request'), requestBytes: 7, requestOffsetBytes: 42 });
  }
  assert.throws(() => compareContextAblation(direct, staged), /strategy/);
  const compared = compareContextAblation(direct, staged, { stagedStrategy: 'staged-request-v2' });
  assert.equal(compared.treatment.staged, 'staged-request-v2');
  assert.equal(compared.treatment.unchangedContextRequestHash, hash('request'));
  assert.equal(compared.pairedSolved.rightStrategy, 'staged-request-v2');
  for (const mutate of [
    (a) => { delete a.results[0].contextRequestHash; },
    (a) => { a.results[0].contextRequestHash = hash('other'); },
    (_a, b) => { delete b.results[0].agent.metadata.contextPreparation.requestSha256; },
    (_a, b) => { b.results[0].agent.metadata.contextPreparation.requestSha256 = hash('other'); },
  ]) {
    const a = structuredClone(direct); const b = structuredClone(staged); mutate(a, b);
    assert.throws(() => compareContextAblation(a, b, { stagedStrategy: 'staged-request-v2' }), /request/i);
  }
  assert.throws(() => compareContextAblation(direct, staged, { stagedStrategy: 'direct-v1' }), /staged_strategy/);
});

test('ordinary comparison and new v1 ablations refuse changed request boundaries; historical v1 remains accepted', () => {
  const direct = report('direct-v1'); const staged = report('staged-v1');
  assert.equal(compareContextAblation(direct, staged).staged.attempted, 3);
  for (const result of [...direct.results, ...staged.results]) result.contextRequestHash = hash('request');
  assert.equal(compareContextAblation(direct, staged).staged.attempted, 3);
  const changed = structuredClone(direct); changed.results[0].contextRequestHash = hash('other');
  assert.throws(() => compareReports(direct, changed), /contextRequestHash/);
  delete staged.results[0].contextRequestHash;
  assert.throws(() => compareContextAblation(direct, staged), /contextRequestHash/);
});

function report(strategy) {
  return {
    protocol: 'forger-common-local-v1', comparisonMode: 'controlled', executionProfile: 'm1-serial-v1', networkPolicy: 'codex-workspace', catalogVersion: 'synthetic',
    forger: { version: 'test', revision: hash('revision'), sourceSha256: hash('source'), compiledProviderSha256: hash('compiled'), harnessSha256: hash('harness') },
    hardware: { platform: 'darwin', architecture: 'arm64', cpu: 'Apple M1', logicalCpuCount: 8, totalMemoryBytes: 8589934592, freeMemoryBytes: 100 },
    results: [1, 2, 3].map((trial) => ({
      taskId: task.id, trial, status: trial === 1 ? 'passed' : 'failed', attempted: true, evidenceClass: 'real_model', intervention: false,
      elapsedMs: trial * 100, agentElapsedMs: trial * 90, failure: trial === 1 ? undefined : 'acceptance_failed', budget: task.budget,
      taskHash: hash('task'), acceptanceHash: hash('acceptance'), promptHash: hash('original'), initialStateHash: hash('initial'),
      effectivePromptHash: strategy === 'direct-v1' ? hash('original') : hash(`effective-${trial}`),
      configuration: { ...config, contextStrategy: strategy }, prerequisites: { evaluatorImage: config.evaluatorImage, cliSha256: hash('cli') },
      agent: { metadata: { model: config.model, modelDigest: config.modelDigest, runtime: 'ollama', runtimeVersion: '0.test', ...(strategy === 'staged-v1' ? { contextPreparation: { strategy, status: 'completed', originalPromptSha256: hash('original'), effectivePromptSha256: hash(`effective-${trial}`), durationMs: 20, stages: [] } } : {}) } },
    })),
  };
}

test('ordinary comparisons remain strict; historical missing strategy means direct only', () => {
  const direct = report('direct-v1');
  const legacy = structuredClone(direct);
  for (const result of legacy.results) { delete result.configuration.contextStrategy; delete result.effectivePromptHash; }
  assert.equal(compareReports(direct, legacy).left.attempted, 3);
  assert.throws(() => compareReports(direct, report('staged-v1')), /incomparable_context_strategy/);
  const changed = structuredClone(direct);
  changed.results[0].effectivePromptHash = hash('other');
  assert.throws(() => compareReports(direct, changed), /incomparable_effectivePromptHash/);
});

test('explicit context ablation keeps all attempt times, failure denominators and pairing variability', () => {
  const direct = report('direct-v1'); const staged = report('staged-v1');
  staged.hardware.freeMemoryBytes = 42; // Dynamic observations must not masquerade as another computer.
  staged.results[2].failure = 'invalid_intent';
  staged.results[2].effectivePromptHash = null;
  Object.assign(staged.results[2].agent.metadata.contextPreparation, { status: 'failed', effectivePromptSha256: null, error: 'invalid_intent' });
  const result = compareContextAblation(direct, staged);
  assert.equal(result.mode, 'context-strategy-ablation');
  assert.deepEqual(result.sample, { taskIds: ['bug-01'], distinctTasks: 1, repetitionsPerStrategy: 3, selectedAttempts: 6 });
  assert.equal(result.direct.passed, 1); assert.equal(result.staged.failed, 2);
  assert.equal(result.staged.successRate, 1 / 3);
  assert.equal(result.staged.allAttemptTimeMs.n, 3);
  assert.equal(result.staged.allAttemptTimeMs.mean, 200);
  assert.equal(result.allAttemptPairs.length, 3);
  assert.equal(result.allAttemptPairs[2].staged.failure, 'invalid_intent');
  assert.equal(result.preprocessing.failed, 1);
  assert.equal(result.preprocessing.completed, 2);
  assert.equal(result.pairedSolved.n, 1);
  assert.equal(result.effectivenessValidated, false);
  assert.match(result.limits.join(' '), /test feedback/i);
  assert.equal(staged.results[0].configuration.contextStrategy, 'staged-v1');
});

test('ablation refuses missing, duplicate, substituted or assisted samples', () => {
  for (const mutate of [
    (right) => right.results.pop(),
    (right) => { right.results[2].trial = 2; },
    (right) => { right.results[0].taskId = 'crud-01'; },
    (right) => { right.results[0].intervention = true; },
    (right) => { right.results[0].evidenceClass = 'controlled_test'; },
    (right) => { right.results[0].elapsedMs = null; },
  ]) {
    const right = report('staged-v1'); mutate(right);
    assert.throws(() => compareContextAblation(report('direct-v1'), right));
  }
});

test('ablation normalizes the real runtime bare digest without accepting malformed or different identities', () => {
  const direct = report('direct-v1'); const staged = report('staged-v1');
  for (const arm of [direct, staged]) for (const result of arm.results) result.agent.metadata.modelDigest = config.modelDigest.slice('sha256:'.length);
  assert.equal(compareContextAblation(direct, staged).runtimeIdentity.complete, true);
  for (const invalid of ['fake', `${config.modelDigest}:extra`, hash('other')]) {
    const changed = structuredClone(staged); changed.results[0].agent.metadata.modelDigest = invalid;
    assert.throws(() => compareContextAblation(direct, changed), /model_digest/);
  }
});

test('ablation permits only strategy/effective-prompt treatment changes, not other experiment identities', () => {
  const mutations = [
    (right) => { right.forger.harnessSha256 = hash('changed'); },
    (right) => { right.forger.sourceSha256 = hash('changed'); },
    (right) => { right.forger.compiledProviderSha256 = hash('changed'); },
    (right) => { right.networkPolicy = 'outer-seatbelt'; },
    (right) => { right.hardware.totalMemoryBytes *= 2; },
    (right) => { right.results[0].configuration.model = 'different-model'; },
    (right) => { right.results[0].configuration.modelDigest = `sha256:${hash('other')}`; },
    (right) => { right.results[0].configuration.agentProfile = 'baseline-v1'; },
    (right) => { right.results[0].configuration.contextWindow = 8192; },
    (right) => { right.results[0].configuration.endpoint = 'http://127.0.0.1:11446'; },
    (right) => { right.results[0].configuration.extraSetting = true; },
    (right) => { right.results[0].promptHash = hash('changed'); },
    (right) => { right.results[0].initialStateHash = hash('changed'); },
    (right) => { right.results[0].acceptanceHash = hash('changed'); },
    (right) => { right.results[0].taskHash = hash('changed'); },
    (right) => { right.results[0].prerequisites.cliSha256 = hash('changed'); },
    (right) => { right.results[0].prerequisites.evaluatorImage = `sha256:${hash('other')}`; },
    (right) => { right.results[0].budget = { ...task.budget, timeMs: 2000 }; },
    (right) => { right.results[0].agent.metadata.runtimeVersion = '0.changed'; },
    (right) => { right.results[0].agent.metadata.contextPreparation.originalPromptSha256 = hash('changed'); },
    (right) => { right.results[0].agent.metadata.contextPreparation.effectivePromptSha256 = hash('changed'); },
  ];
  for (const mutate of mutations) {
    const right = report('staged-v1'); mutate(right);
    assert.throws(() => compareContextAblation(report('direct-v1'), right));
  }
});
