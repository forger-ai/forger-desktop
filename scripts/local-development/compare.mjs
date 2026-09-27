import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeResults } from './catalog.mjs';
import { resolveAgentProfile } from './probe-codex-options.mjs';
import { effectivePromptHash, resolveContextStrategy } from './runner.mjs';

export function compareReports(left, right) {
  if ((left.executionProfile ?? 'standard-v1') !== (right.executionProfile ?? 'standard-v1')) throw new Error('incomparable_execution_profile');
  if (left.executionProfile === 'm1-serial-v1' && (!left.networkPolicy || left.networkPolicy !== right.networkPolicy)) throw new Error('incomparable_network_policy');
  for (const key of ['protocol', 'comparisonMode']) if (left[key] !== right[key]) throw new Error(`incomparable_${key}`);
  for (const key of ['revision', 'sourceSha256', 'compiledProviderSha256', 'harnessSha256']) if (!left.forger?.[key] || left.forger[key] !== right.forger?.[key]) throw new Error(`incomparable_forger_${key}`);
  if (left.comparisonMode !== 'controlled') throw new Error('best_configuration_comparison_not_validated');
  for (const report of [left, right]) {
    if (report.results.some((result) => result.attempted && result.evidenceClass !== 'real_model')) throw new Error('controlled_test_is_not_model_evidence');
    const keys = report.results.map((result) => `${result.taskId}:${result.trial}`);
    if (new Set(keys).size !== keys.length) throw new Error('duplicate_trial');
  }
  const indexed = new Map(right.results.map((result) => [`${result.taskId}:${result.trial}`, result]));
  const pairs = [];
  const unavailable = [];
  for (const a of left.results) {
    const b = indexed.get(`${a.taskId}:${a.trial}`);
    if (!b) { unavailable.push({ taskId: a.taskId, trial: a.trial, reason: 'not_selected_in_both' }); continue; }
    if (resolveAgentProfile(a.configuration?.agentProfile) !== resolveAgentProfile(b.configuration?.agentProfile)) throw new Error(`incomparable_agent_profile: ${a.taskId}`);
    if (resolveContextStrategy(a.configuration?.contextStrategy) !== resolveContextStrategy(b.configuration?.contextStrategy)) throw new Error(`incomparable_context_strategy: ${a.taskId}`);
    for (const key of ['taskHash', 'acceptanceHash', 'promptHash', 'initialStateHash']) if (a.attempted && b.attempted && (!a[key] || a[key] !== b[key])) throw new Error(`incomparable_${key}: ${a.taskId}`);
    if (a.attempted && b.attempted && (a.contextRequestHash !== undefined || b.contextRequestHash !== undefined) && (!a.contextRequestHash || a.contextRequestHash !== b.contextRequestHash)) throw new Error(`incomparable_contextRequestHash: ${a.taskId}`);
    if (a.attempted && b.attempted && effectivePromptHash(a) !== effectivePromptHash(b)) throw new Error(`incomparable_effectivePromptHash: ${a.taskId}`);
    for (const key of ['evaluatorImage', 'cliSha256']) if (a.attempted && b.attempted && (!a.prerequisites?.[key] || a.prerequisites[key] !== b.prerequisites?.[key])) throw new Error(`incomparable_${key}: ${a.taskId}`);
    if (a.attempted && b.attempted && (JSON.stringify(a.budget) !== JSON.stringify(b.budget) || a.configuration.contextWindow !== b.configuration.contextWindow)) throw new Error(`incomparable_budget_or_context: ${a.taskId}`);
    if (a.status === 'passed' && b.status === 'passed') pairs.push({ taskId: a.taskId, trial: a.trial, leftMs: a.elapsedMs, rightMs: b.elapsedMs, leftIntervention: a.intervention, rightIntervention: b.intervention });
    else unavailable.push({ taskId: a.taskId, trial: a.trial, reason: 'not_solved_by_both', leftStatus: a.status, rightStatus: b.status });
  }
  for (const b of right.results) if (!left.results.some((a) => a.taskId === b.taskId && a.trial === b.trial)) unavailable.push({ taskId: b.taskId, trial: b.trial, reason: 'not_selected_in_both' });
  return {
    schemaVersion: 1, mode: 'controlled', left: summarizeResults(left.results), right: summarizeResults(right.results),
    pairedSolved: { n: pairs.length, pairs, leftMeanMs: pairs.length ? pairs.reduce((sum, pair) => sum + pair.leftMs, 0) / pairs.length : null, rightMeanMs: pairs.length ? pairs.reduce((sum, pair) => sum + pair.rightMs, 0) / pairs.length : null, denominator: 'Only identical task/trial pairs solved by both. Global success rates above include all attempted failures.' },
    excludedFromPairedTime: unavailable,
    limits: ['Report provenance is recorded, not cryptographically attested.', 'Different hardware and cold/warm states must be reviewed separately; this comparison does not normalize them.', 'No percentage of general model quality is calculated.'],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/local-development/compare.mjs left.json right.json');
    const reports = await Promise.all(process.argv.slice(2).map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));
    console.log(JSON.stringify(compareReports(...reports), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
