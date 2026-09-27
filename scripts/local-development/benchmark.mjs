import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog, selectTasks, summarizeResults } from './catalog.mjs';
import { digest, snapshotTree } from './fixtures.mjs';
import { capture, checkPrerequisites, renderPrompt, resolveContextStrategy, runBenchmarkTask } from './runner.mjs';
import { resolveAgentProfile } from './probe-codex-options.mjs';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const allowed = new Set(['list', 'run', 'check', 'cloud-plan', 'suite', 'tasks', 'repeat', 'endpoint', 'model', 'model-digest', 'context-window', 'agent-profile', 'context-strategy', 'cli', 'evaluator-image', 'output', 'help']);
export function parseArguments(args, additionalValueOptions = []) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index].replace(/^--/, '');
    if (!args[index].startsWith('--') || (!allowed.has(key) && !additionalValueOptions.includes(key)) || key in parsed) throw new Error(`Invalid or duplicate option: ${args[index]}`);
    if (['list', 'run', 'check', 'cloud-plan', 'help'].includes(key)) parsed[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: --${key}`);
      parsed[key] = value;
    }
  }
  return parsed;
}

export async function provenance() {
  const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const [revision, dirty] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: rootDir }),
    capture('git', ['status', '--porcelain'], { cwd: rootDir }),
  ]);
  const source = await snapshotTree(path.join(rootDir, 'src'));
  const configuration = await Promise.all(['package.json', 'package-lock.json', 'tsconfig.electron.json'].map(async (file) => [file, digest(await fs.readFile(path.join(rootDir, file)))]));
  let compiledProviderSha256 = null;
  try { compiledProviderSha256 = (await snapshotTree(path.join(rootDir, 'dist-electron/main/llm-provider'))).digest; } catch { /* Missing compiled adapter remains a preflight blocker. */ }
  return { version: pkg.version, revision: revision.code === 0 ? revision.stdout.trim() : null, dirty: dirty.code === 0 ? Boolean(dirty.stdout.trim()) : null, sourceSha256: digest(JSON.stringify({ source: source.digest, configuration })), compiledProviderSha256, harnessSha256: (await snapshotTree(path.join(rootDir, 'scripts/local-development'))).digest };
}

export const configurationFromOptions = (options) => ({ endpoint: options.endpoint ?? 'http://127.0.0.1:11434', model: options.model, modelDigest: options['model-digest'], contextWindow: Number(options['context-window'] ?? 4096), agentProfile: resolveAgentProfile(options['agent-profile']), contextStrategy: resolveContextStrategy(options['context-strategy']), cliPath: options.cli, evaluatorImage: options['evaluator-image'] });

export async function createBenchmarkRecord(catalogVersion) {
  return { schemaVersion: 1, createdAt: new Date().toISOString(), protocol: 'forger-common-local-v1', comparisonMode: 'controlled', executionProfile: 'standard-v1', forger: await provenance(), hardware: { platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model ?? null, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), availableForModelBytes: null, availableForModelReason: 'Free RAM does not include the runtime, KV cache, unified GPU memory, OS, Forger, browser and build headroom; no available-for-model estimate is derived.', classification: 'detection only, not a calibration or performance measurement' }, catalogVersion, results: [] };
}

const help = `Forger experimental local benchmark (no implicit downloads or cloud requests)
  node scripts/local-development/benchmark.mjs --list
  node scripts/local-development/benchmark.mjs --cloud-plan --suite all
  node scripts/local-development/benchmark.mjs --check --evaluator-image sha256:<64 hex> --cli /absolute/path/to/codex
  node scripts/local-development/benchmark.mjs --run --model exact-name --model-digest sha256:<64 hex> --context-window 4096 --cli /absolute/path/to/codex --evaluator-image sha256:<64 hex> --suite development --repeat 3
Optional --endpoint http://127.0.0.1:11434, --tasks template-01,crud-01, --output results.json.
--agent-profile accepts baseline-v1 (default), single-agent-v1, single-agent-no-thinking-v1 or compact-v1. Profiles are experimental and must be compared separately.
--context-strategy accepts direct-v1 (default), staged-v1 or staged-request-v2. The original prompt is preserved; preprocessing is included in the task budget and elapsed time. Compare strategies explicitly with context-ablation.mjs.
The evaluator image and the model must already be installed. Planned tasks are rejected.
--cloud-plan writes a synthetic common-protocol plan only; it never invokes cloud providers.`;

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help || !args.length) { console.log(help); return; }
  if (['list', 'run', 'check', 'cloud-plan'].filter((key) => options[key]).length !== 1) throw new Error('Choose exactly one action: --list, --run, --check, --cloud-plan');
  const catalog = await loadCatalog(rootDir);
  if (options.list) {
    console.log(JSON.stringify({ catalogVersion: catalog.version, counts: { catalogued: catalog.tasks.length, executable: catalog.tasks.filter((task) => task.state === 'executable').length, planned: catalog.tasks.filter((task) => task.state === 'planned').length }, tasks: catalog.tasks.map(({ id, title, family, band, state, partition }) => ({ id, title, family, band, state, partition })) }, null, 2));
    return;
  }
  const tasks = selectTasks(catalog, { suite: options.suite ?? 'development', taskIds: options.tasks?.split(',') });
  const repeated = Number(options.repeat ?? 1);
  if (!Number.isInteger(repeated) || repeated < 1 || repeated > 10) throw new Error('--repeat must be an integer from 1 to 10');
  const record = await createBenchmarkRecord(catalog.version);
  if (options['cloud-plan']) {
    Object.assign(record, { executionEnabled: false, state: 'prepared_not_executed', reason: 'Cloud execution requires explicit provider/model configuration, approved synthetic-only context and the existing supported authentication path. This CLI does not implement a cloud runner.', authorization: { fixtureClassification: 'synthetic', userPrivateRepositoryIncluded: false, inferenceTransmissionAuthorized: false }, tasks: tasks.map((task) => ({ id: task.id, taskHash: digest(JSON.stringify(task)), prompt: renderPrompt(task), promptHash: digest(renderPrompt(task)), budget: task.budget, acceptance: task.acceptance })), requiredCloudEvidence: ['exact provider/model revision', 'same task and acceptance hashes', 'same sandbox/tool/context policy and budgets', 'exact Forger revision and harness hash', 'usage and billing source or null reason', 'no provider-model fallback; explicit model identity confirmed'] });
  } else {
    const config = configurationFromOptions(options);
    if (options.run && (!config.model || !/^sha256:[a-f0-9]{64}$/.test(config.modelDigest ?? '') || !Number.isInteger(config.contextWindow) || config.contextWindow < 512)) throw new Error('--run requires an exact --model, --model-digest sha256:<64 hex>, and valid --context-window');
    if (options.check) Object.assign(record, { state: 'preflight_only', prerequisites: await checkPrerequisites(config, rootDir) });
    else {
      for (let trial = 1; trial <= repeated; trial += 1) {
        for (const task of tasks) {
          const result = await runBenchmarkTask({ task, config, rootDir, trial });
          record.results.push(result);
          console.error(`${task.id} trial=${trial} ${result.status}${result.failure ? `: ${result.failure}` : result.blocker ? `: ${result.blocker}` : ''}`);
        }
      }
      record.summary = summarizeResults(record.results);
      if (record.results.some((result) => result.status !== 'passed')) process.exitCode = 2;
    }
  }
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (options.output) { await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true }); await fs.writeFile(options.output, json, { flag: 'wx' }); console.log(`Saved ${path.resolve(options.output)}`); }
  else console.log(json);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
