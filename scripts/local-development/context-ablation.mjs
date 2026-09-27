import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports } from './compare.mjs';
import { effectivePromptHash, resolveContextStrategy, resolveStagedStrategy } from './runner.mjs';
import { resolveAgentProfile } from './probe-codex-options.mjs';

const canonical = (value) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const requireSame = (left, right, name) => {
  if (left === undefined || left === null || canonical(left) !== canonical(right)) throw new Error(`incomparable_${name}`);
};
const configurationIdentity = (configuration) => {
  const { contextStrategy: _strategy, ...rest } = configuration;
  return { ...rest, agentProfile: resolveAgentProfile(rest.agentProfile) };
};
const normalizedModelDigest = (value) => {
  if (typeof value !== 'string' || !/^(sha256:)?[a-f0-9]{64}$/.test(value)) throw new Error('ablation_model_digest_required');
  return value.replace(/^sha256:/, '');
};

function validateArm(report, strategy, taskId, repetitions) {
  if (!Array.isArray(report.results) || report.results.length !== repetitions) throw new Error('ablation_incomplete_sample');
  const trials = new Set();
  for (const result of report.results) {
    if (result.taskId !== taskId || !Number.isInteger(result.trial) || result.trial < 1 || result.trial > repetitions || trials.has(result.trial)) throw new Error('ablation_task_or_trial_mismatch');
    trials.add(result.trial);
    if (resolveContextStrategy(result.configuration?.contextStrategy) !== strategy) throw new Error('ablation_strategy_mismatch');
    if (!result.attempted || !['passed', 'failed'].includes(result.status)) throw new Error('ablation_incomplete_attempt_identity');
    if (result.evidenceClass !== 'real_model') throw new Error('controlled_test_is_not_model_evidence');
    if (result.intervention !== false) throw new Error('ablation_human_intervention');
    if (!Number.isFinite(result.elapsedMs) || result.elapsedMs < 0) throw new Error('ablation_attempt_time_unavailable');
    const preparation = result.agent?.metadata?.contextPreparation;
    const effective = effectivePromptHash(result);
    if (strategy === 'direct-v1') {
      if (preparation) throw new Error('ablation_direct_has_preprocessing');
      requireSame(result.promptHash, effective, 'direct_effective_prompt');
    } else if (preparation) {
      if (preparation.strategy !== strategy || !['completed', 'failed'].includes(preparation.status)) throw new Error('ablation_preprocessing_status_invalid');
      requireSame(result.promptHash, preparation.originalPromptSha256, 'preprocessing_original_prompt');
      if (strategy === 'staged-request-v2') requireSame(result.contextRequestHash, preparation.requestSha256, 'preprocessing_request');
      if (effective !== preparation.effectivePromptSha256) throw new Error('incomparable_preprocessing_effective_prompt');
      if (preparation.status === 'completed' && !/^[a-f0-9]{64}$/.test(effective ?? '')) throw new Error('ablation_effective_prompt_unavailable');
      if (preparation.status === 'failed' && result.status !== 'failed') throw new Error('ablation_failed_preprocessing_counted_as_success');
    } else if (result.status !== 'failed' || effective !== null) {
      throw new Error('ablation_preprocessing_evidence_unavailable');
    }
  }
}

/** Explicitly permits the treatment's strategy and effective prompt to differ. */
export function compareContextAblation(direct, staged, { taskId = 'bug-01', repetitions = 3, stagedStrategy = 'staged-v1' } = {}) {
  stagedStrategy = resolveStagedStrategy(stagedStrategy);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('ablation_repetitions_invalid');
  validateArm(direct, 'direct-v1', taskId, repetitions);
  validateArm(staged, stagedStrategy, taskId, repetitions);
  for (const key of ['platform', 'architecture', 'cpu', 'logicalCpuCount', 'totalMemoryBytes']) requireSame(direct.hardware?.[key], staged.hardware?.[key], `hardware_${key}`);
  for (const key of ['catalogVersion', 'networkPolicy']) requireSame(direct[key], staged[key], key);
  requireSame(direct.forger?.version, staged.forger?.version, 'forger_version');
  const first = direct.results[0];
  const compareRequestIdentity = stagedStrategy === 'staged-request-v2' || [...direct.results, ...staged.results].some((result) => result.contextRequestHash !== undefined);
  if (compareRequestIdentity && !/^[a-f0-9]{64}$/.test(first.contextRequestHash ?? '')) throw new Error('ablation_context_request_hash_required');
  for (const key of ['endpoint', 'model', 'modelDigest', 'contextWindow', 'cliPath', 'evaluatorImage']) {
    if (!first.configuration?.[key]) throw new Error(`ablation_missing_configuration_${key}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(first.configuration.modelDigest)) throw new Error('ablation_model_digest_required');
  let runtimeIdentity = null;
  let runtimeIdentityObservations = 0;
  for (const result of [...direct.results, ...staged.results]) {
    requireSame(configurationIdentity(first.configuration), configurationIdentity(result.configuration), 'configuration_except_context_strategy');
    for (const key of ['taskHash', 'acceptanceHash', 'promptHash', 'initialStateHash', 'budget']) requireSame(first[key], result[key], key);
    if (compareRequestIdentity) requireSame(first.contextRequestHash, result.contextRequestHash, 'contextRequestHash');
    for (const key of ['evaluatorImage', 'cliSha256']) requireSame(first.prerequisites?.[key], result.prerequisites?.[key], key);
    const metadata = result.agent?.metadata;
    if (metadata) {
      requireSame(first.configuration.model, metadata.model, 'observed_model');
      requireSame(normalizedModelDigest(first.configuration.modelDigest), normalizedModelDigest(metadata.modelDigest), 'observed_model_digest');
      if (!metadata.runtime || !metadata.runtimeVersion) throw new Error('ablation_observed_runtime_identity_missing');
      const current = { runtime: metadata.runtime, runtimeVersion: metadata.runtimeVersion };
      if (runtimeIdentity) requireSame(runtimeIdentity, current, 'runtime_identity');
      runtimeIdentity = current; runtimeIdentityObservations += 1;
    }
  }
  // All treatment-specific facts were checked above. Project the unchanged input
  // identity only for the ordinary comparator; never mutate the original reports.
  const commonInput = (report) => ({ ...report, results: report.results.map((result) => ({ ...result, effectivePromptHash: result.promptHash, configuration: { ...result.configuration, contextStrategy: 'direct-v1' } })) });
  const comparison = compareReports(commonInput(direct), commonInput(staged));
  const byTrial = new Map(staged.results.map((result) => [result.trial, result]));
  const observation = (result) => ({ status: result.status, failure: result.failure ?? null, elapsedMs: result.elapsedMs, agentElapsedMs: result.agentElapsedMs ?? null, effectivePromptHash: effectivePromptHash(result), preprocessingMs: result.agent?.metadata?.contextPreparation?.durationMs ?? null });
  const preparations = staged.results.map((result) => result.agent?.metadata?.contextPreparation);
  return {
    schemaVersion: 1, mode: 'context-strategy-ablation', effectivenessValidated: false,
    treatment: { direct: 'direct-v1', staged: stagedStrategy, allowedInputDifferences: ['contextStrategy', 'effectivePromptHash and recorded preprocessing evidence'], unchangedOriginalPromptHash: first.promptHash, unchangedContextRequestHash: first.contextRequestHash ?? null },
    sample: { taskIds: [taskId], distinctTasks: 1, repetitionsPerStrategy: repetitions, selectedAttempts: repetitions * 2 },
    direct: comparison.left, staged: comparison.right,
    preprocessing: { completed: preparations.filter((entry) => entry?.status === 'completed').length, failed: preparations.filter((entry) => entry?.status === 'failed').length, unobserved: preparations.filter((entry) => !entry).length },
    runtimeIdentity: { observed: runtimeIdentity, observations: runtimeIdentityObservations, totalAttempts: repetitions * 2, complete: runtimeIdentityObservations === repetitions * 2 },
    allAttemptPairs: direct.results.toSorted((a, b) => a.trial - b.trial).map((result) => ({ taskId, trial: result.trial, direct: observation(result), staged: observation(byTrial.get(result.trial)) })),
    pairedSolved: { ...comparison.pairedSolved, leftStrategy: 'direct-v1', rightStrategy: stagedStrategy },
    excludedFromPairedTime: comparison.excludedFromPairedTime,
    denominator: 'All attempted trials in each arm, including preprocessing failures, agent failures and timeouts. All-attempt elapsed times include preprocessing; solved-only paired time is a separate subset. Missing trials and preflight blockers prevent this completed-experiment comparison.',
    limits: [
      'One task repeated is one distinct task; these observations do not establish general utility or statistical significance.',
      'Preprocessing may add useful context, lose requirements, or increase time. This report does not promote a strategy automatically.',
      'The agent receives no in-loop test feedback in this experiment; independent Docker acceptance follows the agent.',
      'Hardware identity is checked; available memory, OS cache, temperature and other foreground work remain uncontrolled.',
      'Runtime identity comes from observations when available; an early failure may have no runtime metadata and is retained.',
      ...comparison.limits,
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 && (args.length !== 4 || args[2] !== '--staged-strategy')) throw new Error('Usage: node scripts/local-development/context-ablation.mjs direct.json staged.json [--staged-strategy staged-v1|staged-request-v2] (bug-01, exactly three trials each)');
    const stagedStrategy = resolveStagedStrategy(args[3]);
    const reports = await Promise.all(args.slice(0, 2).map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));
    console.log(JSON.stringify(compareContextAblation(...reports, { stagedStrategy }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
