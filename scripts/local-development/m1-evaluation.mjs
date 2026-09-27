import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { configurationFromOptions, createBenchmarkRecord, parseArguments } from './benchmark.mjs';
import { loadCatalog, selectTasks, summarizeResults } from './catalog.mjs';
import { digest } from './fixtures.mjs';
import { capture, checkPrerequisites, evaluateInDocker, executeLocalAgent, runBenchmarkTask } from './runner.mjs';
import { createNetworkSandboxedCapture } from './sandboxed-capture.mjs';
import { createResourceMonitor } from './resource-monitor.mjs';
import { createProbeDiagnostics } from './probe-codex-diagnostics.mjs';

const require = createRequire(import.meta.url);
const { validateLocalConfig } = require('../../dist-electron/main/llm-provider/local/preflight.js');
const { runLocalCommandCapture } = require('../../dist-electron/main/llm-provider/local/process.js');
const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const OWNED_VM = 'forger-local-eval';

export function validateSerialOptions({ config, limaCli, vm, networkPolicy, runtimePid }, platform = process.platform) {
  if (platform !== 'darwin') throw new Error('m1_serial_macos_required');
  if (!['codex-workspace', 'outer-seatbelt'].includes(networkPolicy)) throw new Error('m1_serial_network_policy_required');
  if (runtimePid !== undefined && (!Number.isInteger(runtimePid) || runtimePid <= 0)) throw new Error('m1_serial_runtime_pid_invalid');
  if (vm !== OWNED_VM) throw new Error('m1_serial_owned_vm_required');
  if (!limaCli || !path.isAbsolute(limaCli)) throw new Error('m1_serial_absolute_lima_cli_required');
  if (!config.cliPath || !path.isAbsolute(config.cliPath)) throw new Error('m1_serial_absolute_codex_cli_required');
  if (!/^sha256:[a-f0-9]{64}$/.test(config.evaluatorImage ?? '')) throw new Error('m1_serial_pinned_image_required');
  validateLocalConfig({ runtime: 'ollama', ...config });
}

async function requestRuntimeJson({ config, pathname, body, timeoutMs }) {
  const endpoint = validateLocalConfig({ runtime: 'ollama', ...config });
  if (!['/api/generate', '/api/ps'].includes(pathname)) throw new Error('m1_runtime_route_forbidden');
  return await new Promise((resolve, reject) => {
    const request = http.request(`${endpoint}${pathname}`, { method: body === undefined ? 'GET' : 'POST', agent: false, headers: body === undefined ? {} : { 'Content-Type': 'application/json' } });
    const timer = setTimeout(() => request.destroy(new Error('m1_runtime_timeout')), timeoutMs);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    request.on('error', fail);
    request.on('response', (response) => {
      if (response.statusCode !== 200) { response.resume(); request.destroy(new Error('m1_runtime_http_error')); return; }
      let bytes = 0; const chunks = [];
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) request.destroy(new Error('m1_runtime_response_too_large')); else chunks.push(chunk); });
      response.on('error', fail);
      response.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('m1_runtime_response_invalid')); }
      });
    });
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function residency(config, payload) {
  if (!Array.isArray(payload?.models)) throw new Error('m1_runtime_residency_invalid');
  const target = payload.models.filter((model) => model.name === config.model || model.model === config.model || model.digest?.replace(/^sha256:/, '') === config.modelDigest.replace(/^sha256:/, ''));
  const reportedNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    targetModelResident: target.length > 0, otherResidentModelCount: payload.models.length - target.length,
    source: 'ollama_api_ps', sampledAt: new Date().toISOString(), memoryUsageMeasured: false,
    targetModels: target.map((model) => {
      const digestReported = typeof model.digest === 'string' ? model.digest.replace(/^sha256:/, '') : null;
      return {
        digestReported, digestMatchesRequested: digestReported === null ? null : digestReported === config.modelDigest.replace(/^sha256:/, ''),
        contextLengthReported: reportedNumber(model.context_length), sizeBytesReported: reportedNumber(model.size),
        sizeVramBytesReported: reportedNumber(model.size_vram),
      };
    }),
  };
}

export async function observeModelResidency(config, request = requestRuntimeJson) {
  return residency(config, await request({ config, pathname: '/api/ps', timeoutMs: 5000 }));
}

export async function unloadLocalModel(config, request = requestRuntimeJson) {
  const started = performance.now();
  const response = await request({ config, pathname: '/api/generate', body: { model: config.model, keep_alive: 0, stream: false }, timeoutMs: 15000 });
  if (response?.done !== true) throw new Error('m1_model_unload_not_acknowledged');
  const remaining = Math.floor(15000 - (performance.now() - started));
  if (remaining < 1) throw new Error('m1_model_unload_timeout');
  const observed = residency(config, await request({ config, pathname: '/api/ps', timeoutMs: remaining }));
  if (observed.targetModelResident) throw new Error('m1_model_still_resident');
  return { acknowledged: true, ...observed, elapsedMs: performance.now() - started, memoryReleaseMeasured: false };
}

async function lifecycleAction(events, action, perform) {
  const event = { action, startedAt: new Date().toISOString(), status: 'running' };
  const started = performance.now(); events.push(event);
  try { const value = await perform(); event.status = 'completed'; event.result = value; return value; }
  catch (error) { event.status = 'failed'; event.error = error.message; throw error; }
  finally { event.finishedAt = new Date().toISOString(); event.elapsedMs = performance.now() - started; }
}

async function changeVm({ limaCli, vm, action, command = capture }) {
  const result = await command(limaCli, [action, '--tty=false', vm], { cwd: rootDir, timeoutMs: action === 'start' ? 120000 : 60000 });
  if (result.code !== 0 || result.timedOut) throw new Error(`m1_vm_${action}_failed`);
  return { commandExitCode: result.code, vm, timeoutMs: action === 'start' ? 120000 : 60000 };
}

/** Same task runner, with explicit serial resource scheduling around it. */
export async function runSerialTask({ task, config, limaCli, vm, networkPolicy, runtimePid, trial = 1 }, dependencies = {}) {
  validateSerialOptions({ config, limaCli, vm, networkPolicy, runtimePid }, dependencies.platform ?? process.platform);
  const command = dependencies.command ?? capture;
  const prerequisites = dependencies.prerequisites ?? checkPrerequisites;
  const runTask = dependencies.runTask ?? runBenchmarkTask;
  const agent = dependencies.agent ?? executeLocalAgent;
  const evaluator = dependencies.evaluator ?? evaluateInDocker;
  const unload = dependencies.unload ?? unloadLocalModel;
  const observe = dependencies.observeResidency ?? observeModelResidency;
  const createCapture = dependencies.createCapture ?? createNetworkSandboxedCapture;
  const captureCli = dependencies.captureCli ?? runLocalCommandCapture;
  const monitorFactory = dependencies.monitorFactory ?? createResourceMonitor;
  const diagnosticCollector = createProbeDiagnostics({ maxChars: 8192 });
  let cliExitCode = null;
  let agentResources = null;
  let after = { targetModelResident: null, reason: 'The agent has not run.' };
  const lifecycle = []; let vmStopped = false; let agentInvoked = false; let result;
  let before = { targetModelResident: null, reason: 'No residency observation is available.' };
  try {
    await lifecycleAction(lifecycle, 'vm_start_preflight', () => changeVm({ limaCli, vm, action: 'start', command }));
    const preflight = await lifecycleAction(lifecycle, 'evaluator_preflight', () => prerequisites(config, rootDir));
    const checkedAt = new Date().toISOString();
    if (!preflight.ready) {
      result = await runTask({ task, config, rootDir, trial, prerequisites: async () => preflight });
    } else {
      await lifecycleAction(lifecycle, 'vm_stop_before_agent', () => changeVm({ limaCli, vm, action: 'stop', command }));
      vmStopped = true;
      try { before = await lifecycleAction(lifecycle, 'observe_model_before_agent', () => observe(config)); }
      catch (error) { before = { targetModelResident: null, reason: error.message }; }
      result = await runTask({
        task, config, rootDir, trial,
        prerequisites: async () => ({ ...preflight, checkedAt, daemonStateAtAgentStart: 'stopped_by_serial_controller', revalidationBeforeEvaluationRequired: true }),
        executeAgent: async (input) => {
          agentInvoked = true;
          const selectedCapture = networkPolicy === 'outer-seatbelt'
            ? createCapture({ capture: captureCli, onProfile: (profile) => { lifecycle.push({ action: 'agent_network_sandbox', observedAt: new Date().toISOString(), profile }); } })
            : captureCli;
          let monitor;
          try { monitor = await monitorFactory({ runtimePid }); }
          catch (error) { agentResources = { unavailable: true, reason: error.message }; }
          try {
            return await agent({
              ...input,
              onOutput: (stream, text) => { diagnosticCollector.addOutput(stream, text); input.onOutput?.(stream, text); },
              runCommandCapture: async (command, args, options) => {
                diagnosticCollector.addSecret(options.env?.FORGER_LOCAL_GATEWAY_TOKEN);
                const captured = await selectedCapture(command, args, options);
                cliExitCode = captured.code ?? null;
                return captured;
              },
            });
          } finally {
            if (monitor) {
              try { agentResources = await monitor.stop(); }
              catch (error) { agentResources = { unavailable: true, reason: error.message }; }
            }
            try { after = await lifecycleAction(lifecycle, 'observe_model_after_agent', () => observe(config)); }
            catch (error) { after = { targetModelResident: null, reason: error.message }; }
          }
        },
        evaluate: async (input) => {
          await lifecycleAction(lifecycle, 'unload_model_before_evaluation', () => unload(config));
          await lifecycleAction(lifecycle, 'vm_start_evaluation', () => changeVm({ limaCli, vm, action: 'start', command }));
          vmStopped = false;
          const rechecked = await lifecycleAction(lifecycle, 'evaluator_revalidation', () => prerequisites(config, rootDir));
          if (!rechecked.ready || rechecked.evaluatorImage !== preflight.evaluatorImage || rechecked.cliSha256 !== preflight.cliSha256) throw new Error('m1_evaluator_identity_changed');
          return await evaluator(input);
        },
      });
    }
  } catch (error) {
    result = { schemaVersion: 1, taskId: task.id, trial, configuration: config, attempted: agentInvoked, status: agentInvoked ? 'failed' : 'blocked', ...(agentInvoked ? { failure: error.message } : { blocker: error.message }), evidenceClass: agentInvoked ? 'real_model' : 'unexecuted', intervention: false, agentElapsedMs: null, elapsedMs: null };
  } finally {
    if (vmStopped) {
      if (agentInvoked) await lifecycleAction(lifecycle, 'unload_model_recovery', () => unload(config)).catch(() => undefined);
      await lifecycleAction(lifecycle, 'vm_start_recovery', () => changeVm({ limaCli, vm, action: 'start', command })).catch(() => undefined);
    }
  }
  const diagnostics = diagnosticCollector.snapshot();
  const toolFailures = diagnostics.events.flatMap((event) => {
    const item = event.item;
    if (event.type === 'item.completed' && item?.type === 'command_execution'
      && ((typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed')) {
      return [{ type: 'command_execution', exitCode: item.exit_code ?? null, output: typeof item.aggregated_output === 'string' ? item.aggregated_output.slice(0, 4096) : null }];
    }
    if (['error', 'turn.failed'].includes(event.type)) return [{ type: event.type, error: typeof event.message === 'string' ? event.message.slice(0, 4096) : typeof event.error?.message === 'string' ? event.error.message.slice(0, 4096) : null }];
    return [];
  });
  result.serialExecution = {
    profile: 'm1-serial-v1', vm, lifecycle, networkPolicy, wholeCliEgressVerified: false,
    networkLimitations: networkPolicy === 'codex-workspace'
      ? ['The existing Codex workspace-write tool sandbox has network_access=false; the authenticated gateway rejects inference redirects.', 'The whole CLI process is not covered by an outer network sandbox, and its total egress is unverified.']
      : ['The outer Seatbelt policy is experimental and incompatible with observed nested Codex sandbox initialization on this macOS host.', 'Selecting it does not remove or weaken the inner workspace-write sandbox.'],
    runtimeModelResidentBeforeAgent: before.targetModelResident,
    residencyAfterAgent: after, agentResources,
    syntheticCliDiagnostics: { source: 'synthetic_fixture_cli', cliExitCode, stderr: diagnostics.stderr, toolFailures, truncated: diagnostics.truncated, unparsedStdoutLines: diagnostics.unparsedStdoutLines },
    residencyObservation: before, osFileCache: 'uncontrolled',
    timingSemantics: { agentElapsedMs: 'Existing agent timer includes resource-monitor startup/finish and post-agent residency observation; VM shutdown/startup is excluded.', evaluationElapsedMs: 'Includes model unload, VM startup, revalidation and Docker evaluation.', elapsedMs: 'Common runner time from attempt start; preflight/VM stop and post-failure recovery are recorded separately.', coldStart: 'Runtime residency is observed; OS page cache is uncontrolled. No fully cold-machine claim.' },
  };
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args, ['lima-cli', 'vm', 'network-policy', 'runtime-pid']);
  if (!args.length || options.help) { console.log('Usage: node scripts/local-development/m1-evaluation.mjs --lima-cli /ABS/PATH/limactl --vm forger-local-eval --network-policy codex-workspace|outer-seatbelt --model NAME --model-digest sha256:DIGEST --cli /ABS/PATH/codex --evaluator-image sha256:IMAGE --output NEW.json [--endpoint http://127.0.0.1:11445] [--tasks template-01] [--repeat 1] [--runtime-pid PID]'); return; }
  if (['list', 'check', 'cloud-plan', 'run'].some((key) => options[key])) throw new Error('m1_serial_action_is_implicit');
  const config = configurationFromOptions(options);
  const limaCli = options['lima-cli']; const vm = options.vm;
  const networkPolicy = options['network-policy'];
  const runtimePid = options['runtime-pid'] === undefined ? undefined : Number(options['runtime-pid']);
  validateSerialOptions({ config, limaCli, vm, networkPolicy, runtimePid });
  if (!options.output) throw new Error('m1_serial_new_output_required');
  if (process.env.DOCKER_CONTEXT || !/^unix:\/\/\/.*\/forger-local-eval\/sock\/docker\.sock$/.test(process.env.DOCKER_HOST ?? '')) throw new Error('m1_serial_owned_vm_docker_socket_required');
  const repeats = Number(options.repeat ?? 1);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('m1_serial_repeat_invalid');
  const catalog = await loadCatalog(rootDir);
  const tasks = selectTasks(catalog, { suite: options.suite ?? 'development', taskIds: options.tasks?.split(',') });
  const report = await createBenchmarkRecord(catalog.version);
  Object.assign(report, { executionProfile: 'm1-serial-v1', networkPolicy, wholeCliEgressVerified: false, state: 'running', configuration: config, ownedVm: { name: vm, limaCliSha256: digest(await fs.readFile(limaCli)) }, finalLifecycle: [] });
  const persist = async () => fs.writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await fs.writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  try {
    for (let trial = 1; trial <= repeats; trial += 1) {
      for (const task of tasks) {
        const result = await runSerialTask({ task, config, limaCli, vm, networkPolicy, runtimePid, trial });
        report.results.push(result); report.summary = summarizeResults(report.results);
        await persist();
        console.error(`${task.id} trial=${trial} ${result.status}: ${result.failure ?? result.blocker ?? 'all acceptance groups passed'}`);
      }
    }
    report.state = report.results.every((result) => result.status === 'passed') ? 'completed' : 'completed_with_failures';
  } catch (error) { report.state = 'interrupted'; report.error = error.message; }
  finally {
    await lifecycleAction(report.finalLifecycle, 'vm_stop_final', () => changeVm({ limaCli, vm, action: 'stop' })).catch(() => undefined);
    report.finishedAt = new Date().toISOString();
    await persist();
  }
  console.log(JSON.stringify({ state: report.state, summary: report.summary, output: options.output }, null, 2));
  process.exitCode = report.state === 'completed' ? 0 : 2;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
