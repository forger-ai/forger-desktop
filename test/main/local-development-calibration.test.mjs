import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { calibrateRuntime, parseCalibrationArguments } from '../../scripts/local-development/calibrate-runtime.mjs';
import { parseVmStat, parseSwapUsage, processTreeRss, createResourceMonitor } from '../../scripts/local-development/resource-monitor.mjs';

const modelDigest = 'a'.repeat(64);
async function runtime(t, behavior = {}) {
  let loaded = behavior.loaded ?? false;
  let generations = 0;
  const bodies = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/version') return response.end(JSON.stringify({ version: '0.34.4' }));
    if (request.url === '/api/tags') return response.end(JSON.stringify({ models: [{ name: 'test:small', digest: modelDigest }] }));
    if (request.url === '/api/show') return response.end(JSON.stringify({ capabilities: ['completion', 'tools'] }));
    if (request.url === '/api/ps') return response.end(JSON.stringify({ models: loaded ? [{ name: 'test:small', digest: modelDigest, size: 123, size_vram: 100, context_length: 2048 }] : [] }));
    assert.equal(request.url, '/api/generate');
    generations++;
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    if (behavior.generate) return behavior.generate(request, response);
    loaded = true;
    response.write(`${JSON.stringify({ thinking: 'wait', done: false })}\n`);
    response.write(`${JSON.stringify({ response: 'REA', done: false })}\n`);
    response.end(`${JSON.stringify({ response: 'DY', done: true, prompt_eval_count: 9, eval_count: 3, load_duration: 1000000, prompt_eval_duration: 2000000, eval_duration: 5000000, total_duration: 10000000 })}\n`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, generations: () => generations, bodies };
}
const config = (endpoint, overrides = {}) => ({ endpoint, model: 'test:small', modelDigest, phase: 'cold', budgetMs: 1000, contextWindow: 2048, maxTokens: 64, ...overrides });
const dependencies = { monitorFactory: async () => ({ stop: async () => ({ state: 'synthetic-monitor', peakUnifiedMemoryBytes: null }) }) };

test('calibration preserves runtime counts, separates cold/warm, and sends bounded synthetic inference only', async (t) => {
  const fake = await runtime(t);
  const cold = await calibrateRuntime(config(fake.endpoint), dependencies);
  assert.equal(cold.status, 'completed');
  assert.equal(cold.phase, 'cold');
  assert.equal(cold.runtime.version, '0.34.4');
  assert.equal(cold.metrics.promptTokensReported, 9);
  assert.equal(cold.metrics.outputTokensReported, 3);
  assert.equal(cold.metrics.runtimeGenerationTokensPerSecond, 600);
  assert.equal(cold.metrics.codexContextTokens, null);
  assert.ok(cold.metrics.timeToFirstResponseMs >= 0);
  assert.ok(cold.metrics.timeToFirstThinkingMs >= 0);
  assert.equal(cold.runtime.loadedBefore, false);
  assert.equal(cold.runtime.loadedAfter, true);
  assert.equal(cold.resources.peakUnifiedMemoryBytes, null);
  assert.deepEqual(fake.bodies[0].options, { num_ctx: 2048, num_predict: 64, temperature: 0, seed: 42 });
  const warm = await calibrateRuntime(config(fake.endpoint, { phase: 'warm' }), dependencies);
  assert.equal(warm.status, 'completed');
  assert.equal(warm.runtime.loadedBefore, true);
  assert.equal(fake.generations(), 2);
});

test('phase and digest inconsistencies fail before inference', async (t) => {
  const fake = await runtime(t, { loaded: true });
  const cold = await calibrateRuntime(config(fake.endpoint), dependencies);
  assert.equal(cold.status, 'failed');
  assert.equal(cold.failure, 'cold_phase_model_already_loaded');
  const wrongDigest = await calibrateRuntime(config(fake.endpoint, { modelDigest: 'b'.repeat(64) }), dependencies);
  assert.equal(wrongDigest.failure, 'model_digest_mismatch');
  assert.equal(fake.generations(), 0);
});

test('deadline cancels actual HTTP stream without pretending runtime compute stopped', async (t) => {
  let disconnected;
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const fake = await runtime(t, { generate: (_req, res) => { res.on('close', disconnected); res.write('{"response":"a","done":false}\n'); } });
  const evidence = await calibrateRuntime(config(fake.endpoint, { budgetMs: 80 }), dependencies);
  assert.equal(evidence.status, 'timed_out');
  assert.equal(evidence.cancellation.clientRequestDestroyed, true);
  assert.equal(evidence.cancellation.runtimeComputeStopped, null);
  await Promise.race([closed, new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runtime stream was not closed')), 1000);
    t.after(() => clearTimeout(timer));
  })]);
});

test('redirects from inference are not followed and truncated streams fail', async (t) => {
  let canaryCalls = 0;
  const canary = http.createServer((_req, res) => { canaryCalls++; res.end(); });
  await new Promise((resolve) => canary.listen(0, '127.0.0.1', resolve));
  t.after(async () => { canary.closeAllConnections(); await new Promise((resolve) => canary.close(resolve)); });
  const redirect = await runtime(t, { generate: (_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${canary.address().port}/leak` }); res.end(); } });
  const redirected = await calibrateRuntime(config(redirect.endpoint), dependencies);
  assert.equal(redirected.failure, 'runtime_http_307');
  assert.equal(canaryCalls, 0);
  const truncated = await runtime(t, { generate: (_req, res) => res.end('{"response":"not done","done":false}\n') });
  assert.equal((await calibrateRuntime(config(truncated.endpoint), dependencies)).failure, 'runtime_stream_incomplete');
});

test('CLI rejects unsafe endpoints and excessive budgets before network', () => {
  for (const endpoint of ['http://localhost:11434', 'http://2130706433:11434', 'http://127.0.0.1@evil.test', 'https://127.0.0.1']) {
    assert.throws(() => parseCalibrationArguments(['--endpoint', endpoint, '--model', 'test', '--model-digest', modelDigest, '--phase', 'cold']), /endpoint/);
  }
  assert.throws(() => parseCalibrationArguments(['--endpoint', 'http://127.0.0.1:11434', '--model', 'test', '--model-digest', modelDigest, '--phase', 'cold', '--budget-ms', '60001']), /budget/);
});

test('resource parsing preserves page size and separates process RSS from unified memory', () => {
  const vm = parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages occupied by compressor: 3.\nPageouts: 4.');
  assert.equal(vm.freeBytes, 163840);
  assert.equal(vm.compressorBytes, 49152);
  assert.equal(vm.pageouts, 4);
  assert.equal(parseSwapUsage('total = 2048.00M used = 10.50M free = 2037.50M (encrypted)').usedBytes, 10.5 * 1024 ** 2);
  assert.deepEqual(processTreeRss('100 1 2048\n101 100 1024\n102 101 512\n200 1 4096', 100), { processCount: 3, rssBytes: 3584 * 1024 });
  assert.equal(processTreeRss('100 1 2048', 200).rssBytes, null);
  assert.equal(parseVmStat('invalid').freeBytes, null);
});


test('resource monitor reports only sampled peaks and keeps unsupported unified peak unknown', async () => {
  let index = 0;
  const monitor = await createResourceMonitor({
    runtimePid: 123,
    sample: async () => ({ runtimeTreeRssBytes: ++index * 100, systemFreeMemoryBytes: 1000 - index, swap: { usedBytes: index * 10 } }),
  });
  const result = await monitor.stop();
  assert.equal(result.sampleCount, 2);
  assert.equal(result.peakSampledRuntimeTreeRssBytes, 200);
  assert.equal(result.peakSampledSwapUsedBytes, 20);
  assert.equal(result.peakUnifiedMemoryBytes, null);
  assert.equal(await monitor.stop(), result);
});
