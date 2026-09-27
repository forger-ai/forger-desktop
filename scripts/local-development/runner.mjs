import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { digest, prepareFixture, snapshotTree, verifyProtectedFiles, isEditable } from './fixtures.mjs';
import { resolveAgentProfile } from './probe-codex-options.mjs';

const require = createRequire(import.meta.url);
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const unknown = (reason) => ({ value: null, reason });
export function resolveContextStrategy(value) {
  if (value === undefined) return 'direct-v1';
  if (!['direct-v1', 'staged-v1', 'staged-request-v2'].includes(value)) throw new Error('invalid_context_strategy');
  return value;
}

export function resolveStagedStrategy(value = 'staged-v1') {
  if (!['staged-v1', 'staged-request-v2'].includes(value)) throw new Error('invalid_staged_strategy');
  return value;
}

export function effectivePromptHash(result) {
  if (Object.hasOwn(result, 'effectivePromptHash')) return result.effectivePromptHash;
  const preparation = result.agent?.metadata?.contextPreparation;
  if (preparation) return preparation.effectivePromptSha256 ?? null;
  return resolveContextStrategy(result.configuration?.contextStrategy) === 'direct-v1' ? result.promptHash ?? null : null;
}
export const requiredChecks = ['frontend_build', 'backend_compile', 'backend_regression', 'frontend_regression', 'runtime_health', 'task_acceptance', 'browser_acceptance'];
export const acceptancePassed = (report) => report?.passed === true && requiredChecks.every((name) => report.checks?.filter((check) => check.name === name && check.passed === true && check.completedCheckGroups === 1).length === 1);
export const missingMetrics = () => ({
  timeToFirstTokenMs: unknown('Codex JSONL does not expose the first model token. First process output is not TTFT.'),
  generationTokensPerSecond: unknown('No token-timed inference trace is available.'),
  peakRuntimeMemoryBytes: unknown('Runtime and unified GPU memory are not sampled by this runner.'),
  outOfMemory: unknown('Only explicit process/runtime resource errors are identifiable; OS memory pressure is not instrumented.'),
  promptTokens: unknown('The model tokenizer and complete rendered tool/context messages are not observed.'),
  cloudCost: unknown('Local execution; no cloud billing request is made.'),
  modelLoadMs: unknown('Load timing is not separately observed; the model may already be resident.'),
  initialDownloadMs: unknown('Downloads are outside benchmark execution and never initiated by this runner.'),
});

// Host commands are restricted to Docker metadata and Git metadata. App commands run inside Docker.
export async function capture(command, args, { cwd, timeoutMs = 10000, env = process.env, onStdout, onStderr, signal } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-2_000_000); onStdout?.(String(chunk)); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2_000_000); onStderr?.(String(chunk)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

export async function checkEvaluatorPrerequisites(config, rootDir = defaultRoot) {
  try {
    const endpoint = await resolveLocalDockerEndpoint();
    if (!endpoint.local) return { ready: false, reason: endpoint.reason };
    const docker = await capture('docker', ['version', '--format', '{{.Server.Version}}'], { cwd: rootDir });
    if (docker.code !== 0) return { ready: false, reason: 'docker_unavailable' };
    if (!config.evaluatorImage || !/^sha256:[a-f0-9]{64}$/.test(config.evaluatorImage)) return { ready: false, reason: 'immutable_evaluator_image_required' };
    const image = await capture('docker', ['image', 'inspect', config.evaluatorImage, '--format', '{{.Id}}'], { cwd: rootDir });
    if (image.code !== 0 || image.stdout.trim() !== config.evaluatorImage) return { ready: false, reason: 'evaluator_image_not_installed' };
    return { ready: true, dockerVersion: docker.stdout.trim(), evaluatorImage: image.stdout.trim() };
  } catch (error) { return { ready: false, reason: error.code === 'ENOENT' ? 'docker_cli_or_compiled_adapter_unavailable' : 'prerequisite_failed', detail: error.message }; }
}

export async function checkPrerequisites(config, rootDir = defaultRoot) {
  const evaluator = await checkEvaluatorPrerequisites(config, rootDir);
  if (!evaluator.ready) return evaluator;
  try {
    if (!config.cliPath || !path.isAbsolute(config.cliPath)) return { ready: false, reason: 'explicit_installed_codex_cli_required' };
    await fs.access(config.cliPath);
    await fs.access(path.join(rootDir, 'dist-electron/main/llm-provider/local/process.js'));
    return { ...evaluator, evidenceClass: 'real_model', cliSha256: digest(await fs.readFile(config.cliPath)) };
  } catch (error) { return { ready: false, reason: 'codex_cli_or_compiled_adapter_unavailable', detail: error.message }; }
}

export async function resolveLocalDockerEndpoint(env = process.env, run = capture) {
  let endpoint = env.DOCKER_CONTEXT ? undefined : env.DOCKER_HOST;
  if (!endpoint) {
    // `context inspect` reads CLI configuration only. It does not contact a daemon.
    const args = ['context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []), '--format', '{{.Endpoints.docker.Host}}'];
    const result = await run('docker', args, { env, timeoutMs: 10000 });
    if (result.code !== 0) return { local: false, reason: 'docker_context_unavailable' };
    endpoint = result.stdout.trim();
  }
  const local = endpoint.startsWith('unix:///') || endpoint.startsWith('npipe:////./pipe/');
  return local ? { local: true } : { local: false, reason: 'remote_docker_endpoint_forbidden' };
}

export function renderPrompt(task) {
  return [
    'This is an authorized synthetic Forger benchmark in a disposable private workspace.',
    'Use the existing supported stack. Preserve commons, manifests, dependencies/configuration and all original tests.',
    'You may add tests, but may not weaken or delete tests. No Internet, new dependencies, MCP, cloud, or external file access.',
    'The evaluator builds, starts and browser-tests the application independently. A completion statement is not evidence.',
    'Do not run dependency/framework/build/test commands on the host: this app is Dockerized. Docker access is not granted to the agent; report unavailable checks honestly.',
    `Time budget ${task.budget.timeMs} ms; tool budget ${task.budget.toolCalls}; no retries or human assistance.`,
    task.instruction,
  ].join('\n\n');
}

export async function executeLocalAgent({ config, task, fixture, onOutput, signal, runCommandCapture }, dependencies = {}) {
  const createLlmProviderRunService = dependencies.createService ?? require(path.join(defaultRoot, 'dist-electron/main/llm-provider/run-service.js')).createLlmProviderRunService;
  const runLocalCommandCapture = dependencies.runCommandCapture ?? require(path.join(defaultRoot, 'dist-electron/main/llm-provider/local/process.js')).runLocalCommandCapture;
  const service = createLlmProviderRunService({ enableExperimentalLocalInference: true });
  const prompt = renderPrompt(task);
  return await service.run({
    surface: 'app_prompt_task', mode: 'task',
    runtime: { provider: 'codex', model: config.model, effort: 'none', permissionMode: 'safe' },
    localInference: { runtime: 'ollama', endpoint: config.endpoint, model: config.model, modelDigest: config.modelDigest, contextWindow: config.contextWindow, agentProfile: config.agentProfile, contextStrategy: resolveContextStrategy(config.contextStrategy) },
    cliPath: config.cliPath, pathEntries: [path.dirname(config.cliPath), '/usr/bin', '/bin'], environment: {},
    workingDir: fixture.workspace, prompt, localContextRequest: task.instruction, timeoutMs: task.budget.timeMs,
    signal, onOutput, runCommandCapture: runCommandCapture ?? runLocalCommandCapture,
  });
}

export async function stageEvaluationInput(workspace) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-evaluation-input-'));
  await fs.chmod(staging, 0o755);
  // Never copy ignored agent artifacts (.venv, node_modules, databases, build output).
  const input = await snapshotTree(workspace);
  for (const relative of Object.keys(input.files)) {
    await fs.mkdir(path.dirname(path.join(staging, relative)), { recursive: true });
    await fs.copyFile(path.join(workspace, relative), path.join(staging, relative));
    await fs.chmod(path.join(staging, relative), 0o644);
  }
  return staging;
}

export async function immutableFixtureMounts(staging) {
  const mounts = [];
  // /work/app stays on the read-only image. Backend/frontend are separate tmpfs
  // mount points (cannot be renamed), with every supplied child mounted read-only.
  // Their writable roots hold only generated build/cache/data artifacts.
  for (const entry of await fs.readdir(staging, { withFileTypes: true })) {
    if (entry.isDirectory() && ['backend', 'frontend'].includes(entry.name)) {
      for (const child of await fs.readdir(path.join(staging, entry.name))) {
        mounts.push(`type=bind,source=${path.join(staging, entry.name, child)},target=/work/app/${entry.name}/${child},readonly`);
      }
    } else {
      mounts.push(`type=bind,source=${path.join(staging, entry.name)},target=/work/app/${entry.name},readonly`);
    }
  }
  return mounts.sort();
}

export async function evaluateInDocker({ config, task, fixture, rootDir = defaultRoot }) {
  const name = `forger-eval-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const evaluationRoot = path.join(rootDir, 'benchmarks/local-development/evaluator');
  const staging = await stageEvaluationInput(fixture.workspace);
  const mounts = await immutableFixtureMounts(staging);
  const args = ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=3g', '--cpus=2', '--read-only', '--user=1000:1000', '--shm-size=256m', '--tmpfs', '/tmp:rw,nosuid,size=256m', '--tmpfs', '/scratch:rw,exec,nosuid,size=256m,uid=1000,gid=1000', '--tmpfs', '/work/app/backend:rw,exec,nosuid,size=256m,uid=1000,gid=1000', '--tmpfs', '/work/app/frontend:rw,exec,nosuid,size=768m,uid=1000,gid=1000', ...mounts.flatMap((mount) => ['--mount', mount]), '--mount', `type=bind,source=${evaluationRoot},target=/evaluation,readonly`, config.evaluatorImage, 'node', '/evaluation/evaluate.mjs', task.id];
  try {
    const result = await capture('docker', args, { cwd: rootDir, timeoutMs: task.budget.evaluationTimeMs });
    const marker = result.stdout.split('\n').findLast((line) => line.startsWith('FORGER_EVALUATION='));
    if (!marker) return { passed: false, checks: [], error: result.timedOut ? 'evaluation_timeout' : 'evaluation_report_missing', code: result.code, stderr: result.stderr };
    const report = JSON.parse(marker.slice('FORGER_EVALUATION='.length));
    return { ...report, passed: result.code === 0 && acceptancePassed(report), timedOut: result.timedOut, code: result.code };
  } finally {
    // Killing the Docker client does not necessarily kill its container.
    await capture('docker', ['rm', '-f', name], { cwd: rootDir, timeoutMs: 10000 }).catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function inspectFixtureAfterAgent(fixture) {
  // Each observation can fail independently. A failed snapshot must never turn
  // unknown edits into an empty list or replace the original agent error.
  const [protectedFiles, snapshot] = await Promise.allSettled([
    verifyProtectedFiles(fixture.workspace, fixture.protectedFiles),
    (async () => {
      const after = await snapshotTree(fixture.workspace);
      return {
        modifiedFiles: [...new Set([...Object.keys(fixture.snapshot.files), ...Object.keys(after.files)])].filter((file) => fixture.snapshot.files[file] !== after.files[file]),
        unexpectedFiles: Object.keys(after.files).filter((file) => !(file in fixture.snapshot.files) && !isEditable(file) && !/^backend\/tests\/test_[^/]+\.py$/.test(file) && !/^frontend\/src\/.*\.(test|spec)\.[jt]sx?$/.test(file)),
      };
    })(),
  ]);
  const observation = (outcome) => outcome.status === 'fulfilled'
    ? { status: 'completed' }
    : { status: 'unavailable', reason: outcome.reason?.message ?? String(outcome.reason) };
  const completed = [protectedFiles, snapshot].filter((outcome) => outcome.status === 'fulfilled').length;
  return {
    protectedFileChanges: protectedFiles.status === 'fulfilled' ? protectedFiles.value : null,
    observed: {
      modifiedFiles: snapshot.status === 'fulfilled' ? snapshot.value.modifiedFiles : null,
      unexpectedFiles: snapshot.status === 'fulfilled' ? snapshot.value.unexpectedFiles : null,
      fileInspection: { status: completed === 2 ? 'completed' : completed === 1 ? 'partial' : 'unavailable', protectedFiles: observation(protectedFiles), snapshot: observation(snapshot) },
    },
  };
}

export async function runBenchmarkTask({ task, config, rootDir = defaultRoot, trial = 1, prerequisites = checkPrerequisites, materialize, executeAgent = executeLocalAgent, evaluate = evaluateInDocker }) {
  config = { ...config, agentProfile: resolveAgentProfile(config.agentProfile), contextStrategy: resolveContextStrategy(config.contextStrategy) };
  const result = {
    schemaVersion: 1, taskId: task.id, taskHash: digest(JSON.stringify(task)), trial,
    partition: task.partition, band: task.band, family: task.family, creationMode: task.source?.creationMode,
    startedAt: new Date().toISOString(), status: 'blocked', attempted: false, intervention: false,
    evidenceClass: 'unexecuted', elapsedMs: 0, agentElapsedMs: null, evaluationElapsedMs: null, effectivePromptHash: null,
    configuration: { ...config }, configurationHash: digest(JSON.stringify(config)), budget: task.budget,
    protectedFileChanges: null,
    metrics: missingMetrics(), observed: { harnessRetries: 0, internalModelRetries: unknown('Internal CLI/runtime retries are not exposed as a reliable counter.'), toolCalls: null, toolCallEvidence: 'No JSONL execution events observed yet.', timeouts: 0, modifiedFiles: null, fileInspection: { status: 'not_attempted', reason: 'agent_not_started' }, relevantFilesRead: unknown('Complete file retrieval is not exposed by the CLI stream.'), unexpectedFiles: null },
    loadPhase: { value: 'uncontrolled', reason: 'Cold start, resident model and initial download are not conflated. Load state must be independently instrumented before cold/warm comparison.' },
    privacy: { inference: 'loopback only; enforced by provider preflight', evaluator: 'Docker network=none, no host write mounts, no secrets injected', agentSubprocesses: 'Codex safe workspace sandbox; no claim of absolute host or OS isolation' },
  };
  let fixture; let timer; let temporary; let attemptedStart; let exceeded = null;
  try {
    const ready = await prerequisites(config, rootDir);
    result.prerequisites = ready;
    if (!ready.ready) { result.blocker = ready.reason; return result; }
    result.evidenceClass = ready.evidenceClass ?? 'real_model';
    if (materialize) fixture = await materialize();
    else {
      const pin = JSON.parse(await fs.readFile(path.join(rootDir, 'benchmarks/local-development/skeleton-pin.json'), 'utf8'));
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-local-benchmark-'));
      fixture = await prepareFixture({ sourceRoot: path.join(rootDir, 'resources/app-skeletons/vite-fastapi-sqlite'), workspace: path.join(temporary, 'workspace'), pin, task });
    }
    result.initialStateHash = fixture.snapshot.digest;
    result.fixturePreparation = fixture.preparation ?? null;
    result.acceptanceHash = (await snapshotTree(path.join(rootDir, 'benchmarks/local-development/evaluator'))).digest;
    result.promptHash = digest(renderPrompt(task));
    result.contextRequestHash = digest(task.instruction);
    if (config.contextStrategy === 'direct-v1') result.effectivePromptHash = result.promptHash;
    result.attempted = true; result.status = 'failed'; attemptedStart = performance.now();
    const controller = new AbortController();
    let lineBuffer = ''; const tools = new Set();
    timer = setTimeout(() => { exceeded = 'time_budget_exceeded'; controller.abort(); }, task.budget.timeMs);
    const onOutput = (stream, text) => {
      if (stream !== 'stdout') return;
      lineBuffer += text;
      if (lineBuffer.length > 2_000_000) { exceeded = 'output_budget_exceeded'; controller.abort(); return; }
      const lines = lineBuffer.split('\n'); lineBuffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (['item.started', 'item.completed', 'turn.completed'].includes(event.type)) {
            result.observed.toolCalls = tools.size;
            result.observed.toolCallEvidence = 'Distinct item IDs with explicit command/file/tool types in Codex JSONL; not inferred from token count.';
          }
          if (event.item && ['command_execution', 'tool_call', 'function_call', 'mcp_tool_call', 'file_change', 'web_search'].includes(event.item.type)) {
            tools.add(event.item.id ?? digest(line)); result.observed.toolCalls = tools.size;
            if (tools.size > task.budget.toolCalls) { exceeded = 'tool_budget_exceeded'; controller.abort(); }
          }
        } catch { /* Plain CLI diagnostics are not token or tool events. */ }
      }
    };
    let agent;
    try { agent = await executeAgent({ config, task, fixture, onOutput, signal: controller.signal }); }
    finally {
      clearTimeout(timer);
      result.agentElapsedMs = performance.now() - attemptedStart;
      const inspection = await inspectFixtureAfterAgent(fixture);
      result.protectedFileChanges = inspection.protectedFileChanges;
      Object.assign(result.observed, inspection.observed);
    }
    onOutput('stdout', '\n');
    result.agent = { code: agent.code ?? 0, usage: agent.usageDelta ?? null, claimedCompletion: Boolean(agent.assistantText), metadata: agent.localInference ?? null };
    if (config.contextStrategy !== 'direct-v1') result.effectivePromptHash = agent.localInference?.contextPreparation?.effectivePromptSha256 ?? null;
    if (exceeded) throw new Error(exceeded);
    if (agent.code !== undefined && agent.code !== 0) throw new Error('agent_nonzero_exit');
    if (result.protectedFileChanges?.length || result.observed.unexpectedFiles?.length) throw new Error('protected_files_changed');
    if (result.observed.fileInspection.status !== 'completed') throw new Error('workspace_inspection_unavailable');
    const evaluationStart = performance.now();
    result.evaluation = await evaluate({ config, task, fixture, rootDir });
    result.evaluationElapsedMs = performance.now() - evaluationStart;
    const acceptanceAfter = (await snapshotTree(path.join(rootDir, 'benchmarks/local-development/evaluator'))).digest;
    if (acceptanceAfter !== result.acceptanceHash) throw new Error('acceptance_files_changed');
    if (!acceptancePassed(result.evaluation)) throw new Error('acceptance_failed');
    result.status = 'passed';
  } catch (error) {
    const failure = exceeded ?? error.message;
    if (error.localInference) {
      result.agent = { code: null, usage: null, claimedCompletion: false, metadata: error.localInference };
      if (config.contextStrategy !== 'direct-v1') result.effectivePromptHash = error.localInference.contextPreparation?.effectivePromptSha256 ?? null;
    }
    if (!result.attempted) result.blocker = failure;
    else { result.status = 'failed'; result.failure = failure; }
    if (/timeout|time_budget/i.test(failure)) result.observed.timeouts += 1;
    if (/out.of.memory|ENOMEM|CUDA.*memory/i.test(error.message)) result.metrics.outOfMemory = { value: true, reason: 'Explicit runtime/process error; no complete memory sampling.' };
  } finally {
    clearTimeout(timer);
    result.elapsedMs = attemptedStart ? performance.now() - attemptedStart : 0;
    result.finishedAt = new Date().toISOString();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
  return result;
}
