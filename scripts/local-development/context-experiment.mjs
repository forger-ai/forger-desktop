import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationFromOptions, createBenchmarkRecord, parseArguments } from './benchmark.mjs';
import { loadCatalog, selectTasks, summarizeResults } from './catalog.mjs';
import { capture, resolveContextStrategy, resolveStagedStrategy } from './runner.mjs';
import { runSerialTask, validateSerialOptions } from './m1-evaluation.mjs';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
export function createContextExperimentOrder(stagedStrategy) {
  const staged = resolveStagedStrategy(stagedStrategy);
  return Object.freeze([
    Object.freeze({ trial: 1, strategies: Object.freeze(['direct-v1', staged]) }),
    Object.freeze({ trial: 2, strategies: Object.freeze([staged, 'direct-v1']) }),
    Object.freeze({ trial: 3, strategies: Object.freeze(['direct-v1', staged]) }),
  ]);
}
export const contextExperimentOrder = createContextExperimentOrder();
const persist = async (file, report, flag = 'w') => fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { flag });

async function stopOwnedVm({ limaCli, vm }) {
  const result = await capture(limaCli, ['stop', '--tty=false', vm], { cwd: rootDir, timeoutMs: 60000 });
  if (result.code !== 0 || result.timedOut) throw new Error('context_experiment_vm_stop_failed');
  return { code: result.code, vm };
}

async function loadExperimentTask() {
  const catalog = await loadCatalog(rootDir);
  return { catalogVersion: catalog.version, task: selectTasks(catalog, { taskIds: ['bug-01'] })[0] };
}

/** Sequential A/B scheduling; inference and Docker evaluation reuse the existing M1 controller. */
export async function runContextExperiment({ config, stagedStrategy, limaCli, vm, networkPolicy, runtimePid, directOutput, stagedOutput }, dependencies = {}) {
  stagedStrategy = resolveStagedStrategy(stagedStrategy);
  const order = createContextExperimentOrder(stagedStrategy);
  validateSerialOptions({ config, limaCli, vm, networkPolicy, runtimePid }, dependencies.platform ?? process.platform);
  if (!directOutput || !stagedOutput || path.resolve(directOutput) === path.resolve(stagedOutput)) throw new Error('context_experiment_distinct_outputs_required');
  const { catalogVersion, task } = await (dependencies.loadTask ?? loadExperimentTask)();
  const common = await (dependencies.makeRecord ?? createBenchmarkRecord)(catalogVersion);
  const outputs = { 'direct-v1': path.resolve(directOutput), [stagedStrategy]: path.resolve(stagedOutput) };
  const reports = Object.fromEntries(Object.entries(outputs).map(([strategy, output]) => [strategy, {
    ...structuredClone(common), executionProfile: 'm1-serial-v1', networkPolicy, wholeCliEgressVerified: false,
    configuration: { ...config, contextStrategy: resolveContextStrategy(strategy) }, ownedVm: { name: vm },
    state: 'prepared', output, finalLifecycle: [], summary: summarizeResults([]),
    contextExperiment: { protocol: 'forger-context-ablation-v1', taskId: 'bug-01', stagedStrategy, repetitionsPerStrategy: 3, sharedProvenance: true, order, limits: ['The three trials start direct twice and staged once; order effects are not eliminated.', 'The common task timer includes preprocessing; model residency and VM lifecycle are observed by the existing serial runner.', 'No in-loop test feedback or automatic strategy promotion is added.'] },
  }]));
  const created = [];
  try {
    for (const [strategy, output] of Object.entries(outputs)) {
      await fs.mkdir(path.dirname(output), { recursive: true });
      await persist(output, reports[strategy], 'wx'); created.push(output);
    }
  } catch (error) {
    // Only remove new, never-started reports reserved by this invocation.
    await Promise.all(created.map((output) => fs.rm(output)));
    throw error;
  }
  const persistBoth = async () => { for (const [strategy, output] of Object.entries(outputs)) await persist(output, reports[strategy]); };
  const progress = dependencies.progress ?? ((message) => console.error(message));
  try {
    for (const report of Object.values(reports)) report.state = 'running';
    await persistBoth();
    for (const { trial, strategies } of order) {
      for (const strategy of strategies) {
        const report = reports[strategy];
        progress(`bug-01 trial=${trial} strategy=${strategy} starting`);
        const result = await (dependencies.runTask ?? runSerialTask)({ task, config: report.configuration, limaCli, vm, networkPolicy, runtimePid, trial });
        report.results.push(result); report.summary = summarizeResults(report.results);
        await persist(outputs[strategy], report);
        progress(`bug-01 trial=${trial} strategy=${strategy} ${result.status}: ${result.failure ?? result.blocker ?? 'all acceptance groups passed'}`);
      }
    }
    for (const report of Object.values(reports)) report.state = report.results.every((result) => result.status === 'passed') ? 'completed' : 'completed_with_failures';
  } catch (error) {
    for (const report of Object.values(reports)) { report.state = 'interrupted'; report.error = error.message; }
  } finally {
    const event = { action: 'vm_stop_final', startedAt: new Date().toISOString(), status: 'running' };
    try { event.result = await (dependencies.stopVm ?? stopOwnedVm)({ limaCli, vm }); event.status = 'completed'; }
    catch (error) { event.status = 'failed'; event.error = error.message; }
    event.finishedAt = new Date().toISOString();
    for (const report of Object.values(reports)) { report.finalLifecycle.push(event); report.finishedAt = event.finishedAt; }
    await persistBoth();
  }
  return reports;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args, ['lima-cli', 'vm', 'network-policy', 'runtime-pid', 'direct-output', 'staged-output', 'staged-strategy']);
  if (!args.length || options.help) {
    console.log('Usage: node scripts/local-development/context-experiment.mjs --lima-cli /ABS/limactl --vm forger-local-eval --network-policy codex-workspace --model NAME --model-digest sha256:DIGEST --context-window 16384 --agent-profile compact-v1 --cli /ABS/codex --evaluator-image sha256:IMAGE --direct-output NEW-direct.json --staged-output NEW-staged.json [--staged-strategy staged-v1|staged-request-v2] [--endpoint http://127.0.0.1:11445] [--runtime-pid PID]\nRuns only bug-01, exactly three trials per arm in D/S, S/D, D/S order. Staged strategy defaults to staged-v1; staged-request-v2 requires explicit selection. Models, runtime, owned VM and evaluator image must already be installed. No downloads or cloud requests.');
    return;
  }
  if (['list', 'check', 'cloud-plan', 'run', 'suite', 'tasks', 'repeat', 'context-strategy', 'output'].some((key) => options[key] !== undefined)) throw new Error('context_experiment_protocol_options_are_fixed');
  if (process.env.DOCKER_CONTEXT || !/^unix:\/\/\/.*\/forger-local-eval\/sock\/docker\.sock$/.test(process.env.DOCKER_HOST ?? '')) throw new Error('m1_serial_owned_vm_docker_socket_required');
  const reports = await runContextExperiment({ config: configurationFromOptions(options), stagedStrategy: options['staged-strategy'], limaCli: options['lima-cli'], vm: options.vm, networkPolicy: options['network-policy'], runtimePid: options['runtime-pid'] === undefined ? undefined : Number(options['runtime-pid']), directOutput: options['direct-output'], stagedOutput: options['staged-output'] });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(reports).map(([strategy, report]) => [strategy, { state: report.state, summary: report.summary, output: report.output }])), null, 2));
  process.exitCode = Object.values(reports).every((report) => report.state === 'completed' && report.finalLifecycle.every((event) => event.status === 'completed')) ? 0 : 2;
  return reports;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
