import assert from 'node:assert/strict';
import test from 'node:test';
import { observeModelResidency, runSerialTask, unloadLocalModel, validateSerialOptions } from '../../scripts/local-development/m1-evaluation.mjs';

const config = { endpoint: 'http://127.0.0.1:11445', model: 'fixture-model', modelDigest: `sha256:${'a'.repeat(64)}`, contextWindow: 4096, cliPath: '/tools/codex', evaluatorImage: `sha256:${'b'.repeat(64)}` };
const task = { id: 'template-01', budget: { timeMs: 1000, evaluationTimeMs: 1000, toolCalls: 10 } };
const options = { config, task, limaCli: '/tools/limactl', vm: 'forger-local-eval', networkPolicy: 'outer-seatbelt' };
const ready = { ready: true, evaluatorImage: config.evaluatorImage, cliSha256: 'pinned-cli', evidenceClass: 'real_model' };

test('serial pilot accepts only the explicitly owned VM and local inference configuration', () => {
  assert.doesNotThrow(() => validateSerialOptions(options, 'darwin'));
  assert.throws(() => validateSerialOptions({ ...options, vm: 'user-work' }, 'darwin'), /owned_vm_required/);
  assert.throws(() => validateSerialOptions({ ...options, limaCli: 'limactl' }, 'darwin'), /absolute_lima_cli_required/);
  assert.throws(() => validateSerialOptions({ ...options, config: { ...config, endpoint: 'https://provider.example' } }, 'darwin'), /local_endpoint_invalid/);
  assert.throws(() => validateSerialOptions(options, 'linux'), /macos_required/);
  assert.throws(() => validateSerialOptions({ ...options, networkPolicy: undefined }, 'darwin'), /network_policy_required/);
  assert.throws(() => validateSerialOptions({ ...options, networkPolicy: 'unsafe' }, 'darwin'), /network_policy_required/);
  assert.throws(() => validateSerialOptions({ ...options, runtimePid: -1 }, 'darwin'), /runtime_pid_invalid/);
});

test('serial execution stops VM before agent, unloads without prompt, and validates image before evaluation', async () => {
  const order = [];
  let commandCount = 0;
  const result = await runSerialTask(options, {
    monitorFactory: async () => ({ stop: async () => ({ peakUnifiedMemoryBytes: null, sampleCount: 2 }) }),
    platform: 'darwin',
    command: async (_command, args, commandOptions) => { order.push(`vm:${args[0]}`); commandCount += 1; assert.ok(commandOptions.timeoutMs <= 120000); return { code: 0, stdout: '', stderr: '' }; },
    prerequisites: async () => { order.push('preflight'); return ready; },
    observeResidency: async () => ({ targetModelResident: false, otherResidentModelCount: 0, source: 'ollama_api_ps' }),
    unload: async () => { order.push('unload'); return { acknowledged: true, targetModelResident: false }; },
    createCapture: ({ onProfile }) => { onProfile({ gatewayPort: 1234, policyHash: 'policy' }); return async () => ({ code: 0 }); },
    agent: async ({ runCommandCapture }) => { order.push('agent'); assert.equal(typeof runCommandCapture, 'function'); return { code: 0 }; },
    evaluator: async () => { order.push('evaluate'); return { passed: true }; },
    runTask: async (input) => {
      const observed = await input.prerequisites();
      assert.equal(observed.daemonStateAtAgentStart, 'stopped_by_serial_controller');
      assert.ok(observed.checkedAt);
      await input.executeAgent({ config, task, fixture: {}, signal: new AbortController().signal });
      await input.evaluate({ config, task, fixture: {} });
      return { taskId: task.id, status: 'passed', attempted: true, agentElapsedMs: 42, evaluationElapsedMs: 15, elapsedMs: 57 };
    },
  });
  assert.deepEqual(order, ['vm:start', 'preflight', 'vm:stop', 'agent', 'unload', 'vm:start', 'preflight', 'evaluate']);
  assert.equal(commandCount, 3);
  assert.equal(result.agentElapsedMs, 42);
  assert.equal(result.serialExecution.runtimeModelResidentBeforeAgent, false);
  assert.equal(result.serialExecution.osFileCache, 'uncontrolled');
  assert.ok(result.serialExecution.lifecycle.some((event) => event.action === 'agent_network_sandbox' && event.profile.policyHash === 'policy'));
});

test('failed agent remains failed and VM recovery is recorded separately from agent time', async () => {
  const commands = [];
  const result = await runSerialTask(options, {
    monitorFactory: async () => ({ stop: async () => ({ peakUnifiedMemoryBytes: null, sampleCount: 2 }) }),
    platform: 'darwin', command: async (_command, args) => { commands.push(args[0]); return { code: 0, stdout: '', stderr: '' }; },
    prerequisites: async () => ready, observeResidency: async () => ({ targetModelResident: null, reason: 'not sampled' }),
    unload: async () => ({ acknowledged: true }), createCapture: () => 'sandboxed',
    agent: async () => { throw new Error('local_cli_failed'); },
    runTask: async (input) => { await assert.rejects(input.executeAgent({}), /local_cli_failed/); return { taskId: task.id, status: 'failed', failure: 'local_cli_failed', attempted: true, agentElapsedMs: 7, elapsedMs: 7 }; },
  });
  assert.deepEqual(commands, ['start', 'stop', 'start']);
  assert.equal(result.status, 'failed');
  assert.equal(result.agentElapsedMs, 7);
  assert.ok(result.serialExecution.lifecycle.some((event) => event.action === 'vm_start_recovery'));
});

test('changed evaluator image prevents evaluation and is kept as a failed attempt', async () => {
  let preflights = 0; let evaluations = 0;
  const result = await runSerialTask(options, {
    monitorFactory: async () => ({ stop: async () => ({ peakUnifiedMemoryBytes: null, sampleCount: 2 }) }),
    platform: 'darwin', command: async () => ({ code: 0, stdout: '', stderr: '' }),
    prerequisites: async () => (++preflights === 1 ? ready : { ...ready, evaluatorImage: 'different' }),
    observeResidency: async () => ({ targetModelResident: false }), unload: async () => ({ acknowledged: true }), createCapture: () => 'sandboxed', agent: async () => ({ code: 0 }),
    evaluator: async () => { evaluations += 1; },
    runTask: async (input) => {
      await input.executeAgent({});
      await assert.rejects(input.evaluate({}), /evaluator_identity_changed/);
      return { taskId: task.id, status: 'failed', failure: 'evaluator_identity_changed', attempted: true, agentElapsedMs: 5, elapsedMs: 10 };
    },
  });
  assert.equal(evaluations, 0);
  assert.equal(result.status, 'failed');
});

test('local unload never includes prompts and reports actual residency under a bounded budget', async () => {
  const requests = [];
  const result = await unloadLocalModel(config, async (input) => {
    requests.push(input);
    assert.ok(input.timeoutMs > 0 && input.timeoutMs <= 15000);
    return input.pathname === '/api/generate' ? { done: true, done_reason: 'unload' } : { models: [] };
  });
  assert.deepEqual(requests[0].body, { model: config.model, keep_alive: 0, stream: false });
  assert.equal(requests[1].pathname, '/api/ps');
  assert.equal(result.acknowledged, true);
  assert.equal(result.targetModelResident, false);
  await assert.rejects(unloadLocalModel(config, async (input) => input.pathname === '/api/generate' ? { done: true } : { models: [{ name: config.model }] }), /model_still_resident/);
});


test('residency preserves reported context, memory and digest without equating it to measured usage', async () => {
  const observed = await observeModelResidency(config, async () => ({ models: [{
    name: config.model, digest: 'a'.repeat(64), context_length: 4096, size: 2000, size_vram: 1500,
  }] }));
  assert.deepEqual(observed.targetModels, [{
    digestReported: 'a'.repeat(64), digestMatchesRequested: true, contextLengthReported: 4096,
    sizeBytesReported: 2000, sizeVramBytesReported: 1500,
  }]);
  assert.equal(observed.memoryUsageMeasured, false);
});

test('codex-workspace policy retains safe capture, monitors resources and records failure residency before unload', async () => {
  const order = [];
  let observations = 0;
  const result = await runSerialTask({ ...options, networkPolicy: 'codex-workspace', runtimePid: 321 }, {
    platform: 'darwin',
    command: async () => ({ code: 0, stdout: '', stderr: '' }),
    prerequisites: async () => ready,
    observeResidency: async () => { order.push('observe'); return { targetModelResident: observations++ > 0, targetModels: [{ contextLengthReported: 4096 }] }; },
    monitorFactory: async ({ runtimePid }) => {
      assert.equal(runtimePid, 321); order.push('monitor-start');
      return { stop: async () => { order.push('monitor-stop'); return { sampleCount: 2, peakSampledRuntimeTreeRssBytes: 123, peakUnifiedMemoryBytes: null }; } };
    },
    createCapture: () => assert.fail('outer policy must not be silently applied'),
    captureCli: async () => ({ code: 3, stdout: '', stderr: 'synthetic CLI failure' }),
    agent: async ({ onOutput, runCommandCapture }) => {
      order.push('agent');
      await runCommandCapture('/fake', [], { env: { FORGER_LOCAL_GATEWAY_TOKEN: 'temporary-secret' } });
      onOutput('stderr', 'synthetic failure temporary-secret');
      onOutput('stdout', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 3, aggregated_output: 'build failed' } }) + '\n');
      throw new Error('agent_nonzero_exit');
    },
    unload: async () => { order.push('unload'); return { acknowledged: true }; },
    runTask: async (input) => {
      await assert.rejects(input.executeAgent({ onOutput: () => {} }), /agent_nonzero_exit/);
      return { attempted: true, status: 'failed', failure: 'agent_nonzero_exit' };
    },
  });
  assert.deepEqual(order, ['observe', 'monitor-start', 'agent', 'monitor-stop', 'observe', 'unload']);
  assert.equal(result.serialExecution.networkPolicy, 'codex-workspace');
  assert.equal(result.serialExecution.wholeCliEgressVerified, false);
  assert.equal(result.serialExecution.residencyAfterAgent.targetModelResident, true);
  assert.equal(result.serialExecution.agentResources.peakSampledRuntimeTreeRssBytes, 123);
  assert.equal(result.serialExecution.syntheticCliDiagnostics.cliExitCode, 3);
  assert.ok(!JSON.stringify(result.serialExecution.syntheticCliDiagnostics).includes('temporary-secret'));
});
