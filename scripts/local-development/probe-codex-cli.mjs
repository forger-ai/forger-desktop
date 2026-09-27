// Protocol/tool-loop smoke: real Codex CLI, synthetic local server, no model inference.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { inspectProbeInvocationPolicy, inspectProbeRequestProfile, parseProbeOptions } from './probe-codex-options.mjs';
import { createNetworkSandboxedCapture } from './sandboxed-capture.mjs';
import { createProbeDiagnostics } from './probe-codex-diagnostics.mjs';

const require = createRequire(import.meta.url);
const { createLlmProviderRunService } = require('../../dist-electron/main/llm-provider/run-service.js');
const { runLocalCommandCapture } = require('../../dist-electron/main/llm-provider/local/process.js');
const { COMPACT_FORGER_CONTRACT } = require('../../dist-electron/main/llm-provider/local/profiles.js');
const { cliPath, redirectCheck, redirectStatus, networkSandbox, agentProfile } = parseProbeOptions(process.argv.slice(2));
const profileObservations = { invocation: null, requests: [] };
let outerNetworkPolicy = null;
const diagnosticCollector = createProbeDiagnostics();
let cliVersion = null;
let agentExitCode = null;
const runProbeCommandCapture = networkSandbox
  ? createNetworkSandboxedCapture({ onProfile: (profile) => { outerNetworkPolicy = profile; } })
  : runLocalCommandCapture;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forger-local-cli-probe-'));
const requests = [];
const model = 'forger-protocol-probe:synthetic';
const modelDigest = crypto.createHash('sha256').update(model).digest('hex');
let responseTurns = 0;
let toolName;
let serverError;
let redirectedRequests = 0;
const canaryMethods = [];
let canaryBodyBytes = 0;
const canary = http.createServer(async (request, response) => {
  redirectedRequests++;
  canaryMethods.push(request.method);
  for await (const chunk of request) canaryBodyBytes += chunk.length;
  response.writeHead(400);
  response.end();
});
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, undefined, 'no authorization reaches the synthetic runtime');
    requests.push(request.url);
    if (request.url === '/api/tags') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: [{ name: model, model, digest: modelDigest }] }));
      return;
    }
    if (request.url === '/api/show') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ capabilities: ['completion', 'tools'], parameters: 'num_ctx 8192' }));
      return;
    }
    if (request.url === '/api/version') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: '0.34.4' }));
      return;
    }
    assert.equal(request.url, '/v1/responses', 'only the pinned Responses route is used');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      assert.ok(bytes <= 2 * 1024 * 1024, 'bounded request');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    diagnosticCollector.addToolOutputs(body.input);
    assert.equal(body.model, model, 'the model never changes to a cloud default');
    assert.equal(body.stream, true);
    const profile = inspectProbeRequestProfile(body, { agentProfile, compactContract: COMPACT_FORGER_CONTRACT });
    profileObservations.requests.push(profile);
    assert.ok(profile.passed, `request profile checks failed: ${profile.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`);
    if (redirectCheck) {
      response.writeHead(redirectStatus, { location: `http://127.0.0.1:${canary.address().port}/canary` });
      response.end();
      return;
    }
    responseTurns++;
    assert.ok(responseTurns <= 2, 'no retry loop');
    let output;
    if (responseTurns === 1) {
      const tools = body.tools?.flatMap((tool) => tool.type === 'namespace' ? tool.tools : [tool]) ?? [];
      const patch = tools.find((tool) => tool.name === 'apply_patch');
      const exec = tools.find((tool) => tool.name === 'exec_command');
      if (patch?.type === 'custom') {
        toolName = 'apply_patch';
        output = { type: 'custom_tool_call', id: 'fc_probe', call_id: 'call_probe', name: toolName,
          input: '*** Begin Patch\n*** Add File: probe-result.txt\n+local-protocol-tool-ok\n*** End Patch' };
      } else {
        assert.ok(exec, `supported editing tool missing: ${tools.map((tool) => tool.name).join(',')}`);
        toolName = 'exec_command';
        output = { type: 'function_call', id: 'fc_probe', call_id: 'call_probe', name: toolName,
          arguments: JSON.stringify({ cmd: "printf 'local-protocol-tool-ok\\n' > probe-result.txt", max_output_tokens: 100 }) };
      }
    } else {
      output = { type: 'message', id: 'msg_probe', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Synthetic protocol probe complete.', annotations: [] }] };
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    const responseId = `resp_probe_${responseTurns}`;
    event('response.created', { response: { id: responseId, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: output });
    event('response.output_item.done', { output_index: 0, item: output });
    event('response.completed', { response: { id: responseId, object: 'response', model, status: 'completed', output: [output],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  } catch (error) {
    serverError = error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

try {
  await new Promise((resolve, reject) => { canary.once('error', reject); canary.listen(0, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const service = createLlmProviderRunService({ enableExperimentalLocalInference: true });
  const version = await runLocalCommandCapture(cliPath, ['--version'], { cwd: root, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000 });
  cliVersion = version.stdout.trim();
  assert.equal(version.code, 0);
  assert.match(version.stdout, /codex-cli 0\.144\.1\b/, 'the experiment uses the configured CLI pin');
  const running = service.run({
    surface: 'app_prompt_task', mode: 'task', cliPath,
    runtime: { provider: 'codex', model, effort: 'none', permissionMode: 'safe' },
    localInference: { runtime: 'ollama', endpoint: `http://127.0.0.1:${server.address().port}`, model, modelDigest, contextWindow: 8192, agentProfile },
    workingDir: root, prompt: 'Create probe-result.txt containing local-protocol-tool-ok.',
    pathEntries: [], environment: {}, timeoutMs: 30000, inactivityTimeoutMs: 15000,
    onOutput: (stream, text) => diagnosticCollector.addOutput(stream, text),
    runCommandCapture: async (command, args, options) => {
      diagnosticCollector.addSecret(options.env?.FORGER_LOCAL_GATEWAY_TOKEN);
      profileObservations.invocation = inspectProbeInvocationPolicy(args, { agentProfile });
      assert.ok(profileObservations.invocation.passed, `invocation permission checks failed: ${profileObservations.invocation.checks.filter((check) => !check.passed).map((check) => check.name).join(',')}`);
      const result = await runProbeCommandCapture(command, args, options);
      agentExitCode = result.code;
      return result;
    },
  });
  if (redirectCheck) {
    await assert.rejects(running);
    assert.equal(redirectedRequests, 0, 'inference must not follow a redirect to a different destination');
    if (serverError) throw serverError;
    assert.ok(requests.includes('/v1/responses'), 'the inference redirect was actually exercised');
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1, evidenceClass: 'real_cli_synthetic_runtime', observedAt: new Date().toISOString(),
      cliVersion: version.stdout.trim(), passed: true, scenario: 'reject_inference_redirect', requests,
      agentProfile, profileObservations,
      redirectStatus, redirectedRequests, canaryMethods, canaryBodyBytes, realModelInference: false, processEgressVerified: false,
      networkSandboxRequested: networkSandbox, outerNetworkPolicy, toolLoopSucceededUnderPolicy: false,
      syntheticDiagnostics: diagnosticCollector.snapshot(),
    }, null, 2)}\n`);
  } else {
    const result = await running;
    if (serverError) throw serverError;
    assert.equal((await fs.readFile(path.join(root, 'probe-result.txt'), 'utf8')).trim(), 'local-protocol-tool-ok');
    assert.equal(result.code, 0);
    assert.equal(result.localInference.runtimeVersion, '0.34.4');
    assert.deepEqual(result.localInference.validatedCapabilities, []);
    assert.equal(result.localInference.effectiveRuntimeContext, null);
    assert.equal(result.localInference.agentProfile, agentProfile);
    if (agentProfile === 'compact-v1') assert.ok(profileObservations.requests.every((request) => request.compactContractSha256 === result.localInference.contractSha256));
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1, evidenceClass: 'real_cli_synthetic_runtime', observedAt: new Date().toISOString(),
      cliVersion: version.stdout.trim(), passed: true, toolName, responseTurns, requests,
      agentProfile, profileObservations,
      profileEvidence: { agentProfile: result.localInference.agentProfile, requestedReasoning: result.localInference.requestedReasoning, appliedSettings: result.localInference.appliedSettings, contractSha256: result.localInference.contractSha256 },
      syntheticRuntimeVersion: result.localInference.runtimeVersion,
      fileEditVerified: true, realModelInference: false, performanceMeasured: false, processEgressVerified: false,
      networkSandboxRequested: networkSandbox, outerNetworkPolicy, toolLoopSucceededUnderPolicy: networkSandbox,
      syntheticDiagnostics: diagnosticCollector.snapshot(),
    }, null, 2)}\n`);
  }
 } catch (error) {
  const syntheticDiagnostics = diagnosticCollector.snapshot();
  const sandboxInitializationDenied = JSON.stringify(syntheticDiagnostics).includes('sandbox')
    && /Operation not permitted|sandbox_apply|sandbox_init/.test(JSON.stringify(syntheticDiagnostics));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1, evidenceClass: 'real_cli_synthetic_runtime', observedAt: new Date().toISOString(),
    cliVersion, passed: false, scenario: redirectCheck ? 'reject_inference_redirect' : 'tool_loop',
    agentProfile, profileObservations,
    failure: serverError?.message ?? error.message, agentExitCode, toolName, responseTurns, requests,
    redirectStatus: redirectCheck ? redirectStatus : null, redirectedRequests, canaryBodyBytes,
    realModelInference: false, performanceMeasured: false, processEgressVerified: false,
    networkSandboxRequested: networkSandbox, outerNetworkPolicy, toolLoopSucceededUnderPolicy: false,
    sandboxInitializationDenied, syntheticDiagnostics,
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  canary.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (canary.listening) await new Promise((resolve) => canary.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
