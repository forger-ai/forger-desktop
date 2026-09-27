import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { createResourceMonitor } from './resource-monitor.mjs';

const prompt = 'Respond with exactly the word READY.';
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const normalizedDigest = (value) => typeof value === 'string' ? value.replace(/^sha256:/, '') : '';

function validate(config) {
  if (!/^http:\/\/127\.0\.0\.1(?::[1-9][0-9]{0,4})?\/?$/.test(config.endpoint ?? '')) throw new Error('invalid_endpoint');
  try { new URL(config.endpoint); } catch { throw new Error('invalid_endpoint'); }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:+-]{0,199}$/.test(config.model ?? '') || /cloud/i.test(config.model)) throw new Error('invalid_local_model');
  if (!/^[a-f0-9]{64}$/.test(normalizedDigest(config.modelDigest))) throw new Error('invalid_model_digest');
  if (!['cold', 'warm'].includes(config.phase)) throw new Error('explicit_phase_required');
  if (!Number.isInteger(config.budgetMs) || config.budgetMs < 1 || config.budgetMs > 60000) throw new Error('invalid_budget');
  if (!Number.isInteger(config.contextWindow) || config.contextWindow < 512 || config.contextWindow > 8192) throw new Error('invalid_context_window');
  if (!Number.isInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > 128) throw new Error('invalid_generation_limit');
  if (config.runtimePid !== undefined && (!Number.isInteger(config.runtimePid) || config.runtimePid <= 0)) throw new Error('invalid_runtime_pid');
}

export function parseCalibrationArguments(args) {
  const allowed = new Set(['endpoint', 'model', 'model-digest', 'phase', 'budget-ms', 'context-window', 'max-tokens', 'runtime-pid', 'output']);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    if (!args[index]?.startsWith('--') || !allowed.has(key) || key in options || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid_calibration_arguments');
    options[key] = args[index + 1];
  }
  const config = {
    endpoint: options.endpoint ?? 'http://127.0.0.1:11434', model: options.model, modelDigest: options['model-digest'], phase: options.phase,
    budgetMs: Number(options['budget-ms'] ?? 60000), contextWindow: Number(options['context-window'] ?? 2048), maxTokens: Number(options['max-tokens'] ?? 64),
    ...(options['runtime-pid'] ? { runtimePid: Number(options['runtime-pid']) } : {}), output: options.output,
  };
  validate(config);
  return config;
}

function request(endpoint, route, { body, signal, onChunk, onAbort, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('calibration_cancelled')); return; }
    const req = http.request(new URL(route, endpoint), {
      method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    const abort = () => { onAbort?.(); req.destroy(new Error('calibration_cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    req.on('error', (error) => {
      cleanup();
      reject(error.message.startsWith('runtime_') || error.message === 'calibration_cancelled' ? error : new Error('runtime_unavailable'));
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        req.destroy(new Error(`runtime_http_${res.statusCode}`));
        return;
      }
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { req.destroy(new Error('runtime_response_limit')); return; }
        try {
          if (onChunk) onChunk(chunk);
          else chunks.push(chunk);
        } catch { req.destroy(new Error('runtime_stream_invalid')); }
      });
      res.on('error', () => { cleanup(); reject(new Error('runtime_stream_interrupted')); });
      res.on('end', () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); });
    });
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function readJson(endpoint, route, options) {
  try {
    const result = JSON.parse(await request(endpoint, route, options));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('runtime_invalid_response');
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('runtime_invalid_response');
    throw error;
  }
}

function loadedModel(data, config) {
  if (!Array.isArray(data.models)) throw new Error('runtime_invalid_response');
  const found = data.models.find((entry) => entry?.name === config.model || entry?.model === config.model);
  if (!found) return null;
  if (found.digest && normalizedDigest(found.digest) !== normalizedDigest(config.modelDigest)) throw new Error('loaded_model_digest_mismatch');
  return {
    digest: typeof found.digest === 'string' ? normalizedDigest(found.digest) : null,
    sizeBytesReported: positive(found.size), sizeVramBytesReported: positive(found.size_vram),
    contextLengthReported: positive(found.context_length),
  };
}

async function generate(config, signal, record, onAbort) {
  const started = performance.now();
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let final;
  let responseText = '';
  const line = (text) => {
    if (!text.trim()) return;
    const data = JSON.parse(text);
    if (data.error || !data || typeof data !== 'object') throw new Error('runtime_generation_error');
    if (typeof data.thinking === 'string' && data.thinking.length) {
      record.metrics.timeToFirstThinkingMs ??= performance.now() - started;
      record.metrics.thinkingBytesObserved += Buffer.byteLength(data.thinking);
    }
    if (typeof data.response === 'string' && data.response.length) {
      record.metrics.timeToFirstResponseMs ??= performance.now() - started;
      responseText += data.response;
    }
    if (data.done === true) final = data;
  };
  await request(config.endpoint, '/api/generate', {
    signal, onAbort, maxBytes: 4 * 1024 * 1024,
    body: { model: config.model, prompt, stream: true, keep_alive: '2m', options: { num_ctx: config.contextWindow, num_predict: config.maxTokens, temperature: 0, seed: 42 } },
    onChunk: (chunk) => {
      record.metrics.timeToFirstStreamChunkMs ??= performance.now() - started;
      pending += decoder.write(chunk);
      let boundary;
      while ((boundary = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);
      }
    },
  });
  pending += decoder.end();
  if (pending.trim()) line(pending);
  if (!final) throw new Error('runtime_stream_incomplete');
  record.metrics.generationRequestWallMs = performance.now() - started;
  record.metrics.promptTokensReported = positive(final.prompt_eval_count);
  record.metrics.outputTokensReported = positive(final.eval_count);
  for (const [source, target] of [['load_duration', 'runtimeLoadMs'], ['prompt_eval_duration', 'runtimePromptEvaluationMs'], ['eval_duration', 'runtimeGenerationMs'], ['total_duration', 'runtimeTotalMs']]) {
    const duration = positive(final[source]);
    record.metrics[target] = duration === null ? null : duration / 1e6;
  }
  const seconds = positive(final.eval_duration) / 1e9;
  if (seconds > 0 && record.metrics.outputTokensReported !== null) record.metrics.runtimeGenerationTokensPerSecond = record.metrics.outputTokensReported / seconds;
  record.output = { responseText, syntheticExactMatch: responseText.trim() === 'READY', doneReasonReported: typeof final.done_reason === 'string' ? final.done_reason : null };
}

export async function calibrateRuntime(config, { monitorFactory = createResourceMonitor, signal: externalSignal } = {}) {
  validate(config);
  const started = performance.now();
  const controller = new AbortController();
  let deadlineExpired = false;
  const deadline = setTimeout(() => { deadlineExpired = true; controller.abort(); }, config.budgetMs);
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const record = {
    schemaVersion: 1, kind: 'bounded-runtime-calibration', observedAt: new Date().toISOString(), status: 'failed', failure: null,
    phase: config.phase, phaseDefinition: 'cold means absent from /api/ps before the request; filesystem and OS caches are not flushed',
    configuration: { model: config.model, modelDigest: normalizedDigest(config.modelDigest), budgetMs: config.budgetMs, contextWindowRequested: config.contextWindow, maximumGeneratedTokensRequested: config.maxTokens, keepAlive: '2m', temperature: 0, seed: 42 },
    hardware: { platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model ?? null, totalMemoryBytes: os.totalmem() },
    runtime: { name: 'ollama', version: null, reportedCapabilities: [], loadedBefore: null, loadedAfter: null, modelBefore: null, modelAfter: null },
    fixture: { classification: 'synthetic', promptSha256: createHash('sha256').update(prompt).digest('hex'), purpose: 'latency and generation calibration; not app-development acceptance' },
    metrics: { wallMs: null, generationRequestWallMs: null, timeToFirstStreamChunkMs: null, timeToFirstResponseMs: null, timeToFirstThinkingMs: null, thinkingBytesObserved: 0, promptTokensReported: null, outputTokensReported: null, runtimeLoadMs: null, runtimePromptEvaluationMs: null, runtimeGenerationMs: null, runtimeTotalMs: null, runtimeGenerationTokensPerSecond: null, codexContextTokens: null },
    metricDefinitions: { tokenCounts: 'Reported by Ollama final prompt_eval_count and eval_count for the selected model tokenizer; no Codex context count is inferred.', generationRate: 'eval_count / (eval_duration nanoseconds / 1000000000)', timeToFirstResponse: 'Client monotonic milliseconds from starting /api/generate until the first non-empty response field; a chunk may contain multiple tokens.', timeToFirstThinking: 'Separate first non-empty thinking field latency; thinking content is not retained.' },
    cancellation: { requested: false, clientRequestDestroyed: false, observedAfterMs: null, runtimeComputeStopped: null, runtimeComputeStoppedReason: 'Closing the client HTTP connection does not prove that a runtime/GPU has stopped computing.' },
    resources: null,
    limitations: ['This is direct runtime calibration, not the Forger agent tool loop or a development-task benchmark.', 'Runtime-reported token counts use the selected model tokenizer for this synthetic prompt only.', 'No model download, forced unload, cloud inference, proxy or redirected request is performed.', 'Cold here is unloaded runtime state; operating-system caches may be warm.', 'No OS network isolation or private-runtime authentication is established.', 'The requested mutable model tag is checked against its digest before generation; this is not an immutable per-token digest guarantee.'],
  };
  let monitor;
  const requestOptions = { signal: controller.signal };
  try {
    const version = await readJson(config.endpoint, '/api/version', requestOptions);
    if (typeof version.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version.version) || version.version.length > 100) throw new Error('runtime_invalid_response');
    record.runtime.version = version.version;
    const tags = await readJson(config.endpoint, '/api/tags', requestOptions);
    const model = tags.models?.find((entry) => entry?.name === config.model || entry?.model === config.model);
    if (!model) throw new Error('model_missing');
    if (normalizedDigest(model.digest) !== normalizedDigest(config.modelDigest)) throw new Error('model_digest_mismatch');
    const details = await readJson(config.endpoint, '/api/show', { ...requestOptions, body: { model: config.model } });
    if (model.remote_model || model.remote_host || details.remote_model || details.remote_host) throw new Error('remote_model_rejected');
    record.runtime.reportedCapabilities = Array.isArray(details.capabilities) ? details.capabilities.filter((value) => typeof value === 'string') : [];
    if (!record.runtime.reportedCapabilities.includes('completion')) throw new Error('completion_capability_missing');
    record.runtime.modelBefore = loadedModel(await readJson(config.endpoint, '/api/ps', requestOptions), config);
    record.runtime.loadedBefore = Boolean(record.runtime.modelBefore);
    if (config.phase === 'cold' && record.runtime.loadedBefore) throw new Error('cold_phase_model_already_loaded');
    if (config.phase === 'warm' && !record.runtime.loadedBefore) throw new Error('warm_phase_model_not_loaded');
    monitor = await monitorFactory({ runtimePid: config.runtimePid });
    await generate(config, controller.signal, record, () => {
      record.cancellation.clientRequestDestroyed = true;
      record.cancellation.observedAfterMs = performance.now() - started;
    });
    record.runtime.modelAfter = loadedModel(await readJson(config.endpoint, '/api/ps', requestOptions), config);
    record.runtime.loadedAfter = Boolean(record.runtime.modelAfter);
    record.status = 'completed';
  } catch (error) {
    record.status = deadlineExpired ? 'timed_out' : controller.signal.aborted ? 'cancelled' : 'failed';
    record.failure = controller.signal.aborted ? record.status : /^[a-z0-9_]+$/.test(error.message) ? error.message : 'calibration_failed';
  } finally {
    clearTimeout(deadline);
    externalSignal?.removeEventListener('abort', abort);
    record.cancellation.requested = controller.signal.aborted;
    record.metrics.wallMs = performance.now() - started;
    if (monitor) record.resources = await monitor.stop();
  }
  return record;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node scripts/local-development/calibrate-runtime.mjs --endpoint http://127.0.0.1:11434 --model exact-name --model-digest sha256:<hex> --phase cold|warm [--budget-ms 60000] [--context-window 2048] [--max-tokens 64] [--runtime-pid PID] [--output evidence.json]');
    return;
  }
  const config = parseCalibrationArguments(args);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let record;
  try { record = await calibrateRuntime(config, { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  const json = `${JSON.stringify(record, null, 2)}\n`;
  if (config.output) { await fs.mkdir(path.dirname(path.resolve(config.output)), { recursive: true }); await fs.writeFile(config.output, json, { flag: 'wx' }); }
  else process.stdout.write(json);
  if (record.status !== 'completed') process.exitCode = 2;
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
