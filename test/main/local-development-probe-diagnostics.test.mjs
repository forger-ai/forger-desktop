import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeDiagnostics } from '../../scripts/local-development/probe-codex-diagnostics.mjs';
import { inspectProbeInvocationPolicy, inspectProbeRequestProfile } from '../../scripts/local-development/probe-codex-options.mjs';

test('profile request observations validate actual tool namespaces and reasoning without retaining context', () => {
  const privateText = 'DO-NOT-PERSIST-SYNTHETIC-CONTEXT';
  const request = { instructions: privateText, input: [{ role: 'user', content: privateText }], tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command', description: privateText }] }] };
  assert.equal(inspectProbeRequestProfile(request, { agentProfile: 'single-agent-v1' }).passed, true);
  for (const tool of [{ type: 'namespace', name: 'multi_agent', tools: [] }, { type: 'namespace', name: 'multi_agent_v1', tools: [] }, { type: 'function', name: 'multi_agent_v1.spawn_agent' }]) {
    const leaked = { ...request, tools: [...request.tools, { type: 'namespace', name: 'parent', tools: [tool] }] };
    assert.equal(inspectProbeRequestProfile(leaked, { agentProfile: 'single-agent-v1' }).passed, false);
    assert.equal(inspectProbeRequestProfile(leaked, { agentProfile: 'baseline-v1' }).multiAgentNamespacePresent, true);
  }
  for (const effort of [undefined, 'low', 'none']) {
    const observation = inspectProbeRequestProfile({ ...request, reasoning: effort === undefined ? undefined : { effort } }, { agentProfile: 'single-agent-no-thinking-v1' });
    assert.equal(observation.passed, effort === 'none');
    assert.equal(observation.reasoningEffort, effort ?? null);
    assert.equal(JSON.stringify(observation).includes(privateText), false);
  }
});

test('compact request requires the Forger contract in instructions rather than user content', () => {
  const compactContract = 'Forger synthetic test contract.\n';
  const request = { reasoning: { effort: 'none' }, tools: [], input: [{ role: 'user', content: compactContract }] };
  assert.equal(inspectProbeRequestProfile(request, { agentProfile: 'compact-v1', compactContract }).passed, false);
  for (const decorated of [{ ...request, instructions: compactContract }, { ...request, input: [{ role: 'developer', content: [{ type: 'input_text', text: compactContract }] }] }]) {
    const observation = inspectProbeRequestProfile(decorated, { agentProfile: 'compact-v1', compactContract });
    assert.equal(observation.passed, true);
    assert.equal(observation.compactContractPresent, true);
    assert.match(observation.compactContractSha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(observation).includes(compactContract.trim()), false);
  }
  assert.equal(inspectProbeRequestProfile(request, { agentProfile: 'compact-v1' }).passed, false);
});

test('profile probes require the original invocation permissions and reject conflicting overrides', () => {
  const args = ['--ask-for-approval', 'never', '--config', 'sandbox_workspace_write.network_access=false', '--config', 'web_search="disabled"', '--config', 'include_permissions_instructions=true', '--config', 'model_instructions_file="/private/synthetic-contract.md"', 'exec', '--ignore-user-config', '--sandbox', 'workspace-write', '--', '-'];
  const observation = inspectProbeInvocationPolicy(args, { agentProfile: 'compact-v1' });
  assert.equal(observation.passed, true);
  assert.equal(JSON.stringify(observation).includes('/private/'), false);
  for (const altered of [args.filter((value) => value !== '--ignore-user-config'), args.map((value) => value === 'workspace-write' ? 'danger-full-access' : value), ['--sandbox', 'danger-full-access', ...args], ['--config', 'sandbox_workspace_write.network_access=true', ...args], args.filter((value) => value !== 'include_permissions_instructions=true'), ['--dangerously-bypass-approvals-and-sandbox', ...args]]) {
    assert.equal(inspectProbeInvocationPolicy(altered, { agentProfile: 'compact-v1' }).passed, false);
  }
  assert.equal(inspectProbeInvocationPolicy(args.filter((value) => value !== 'include_permissions_instructions=true'), { agentProfile: 'baseline-v1' }).passed, true);
});

test('synthetic CLI diagnostics retain tool failure but exclude input context and redact ephemeral authentication', () => {
  const collector = createProbeDiagnostics();
  collector.addSecret('synthetic-gateway-secret');
  collector.addOutput('stdout', '{"type":"item.completed","item":{"type":"command_execution","exit_code":1,"aggregated_output":"sandbox_apply: Operation not permitted"}}\n');
  collector.addOutput('stderr', 'synthetic-gateway-secret\n');
  collector.addToolOutputs([
    { type: 'message', content: 'DO-NOT-COPY-INPUT-CONTEXT' },
    { type: 'function_call_output', call_id: 'call_probe', output: 'sandbox_apply: Operation not permitted; synthetic-gateway-secret' },
  ]);
  const snapshot = collector.snapshot();
  assert.equal(snapshot.events[0].item.exit_code, 1);
  assert.equal(snapshot.toolOutputs.length, 1);
  assert.ok(snapshot.toolOutputs[0].output.includes('Operation not permitted'));
  assert.ok(!JSON.stringify(snapshot).includes('DO-NOT-COPY-INPUT-CONTEXT'));
  assert.ok(!JSON.stringify(snapshot).includes('synthetic-gateway-secret'));
});

test('diagnostic buffers are bounded and report truncation instead of growing without limit', () => {
  const collector = createProbeDiagnostics({ maxChars: 100 });
  collector.addOutput('stdout', 'x'.repeat(200));
  collector.addOutput('stderr', 'y'.repeat(200));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.stderr.length, 100);
  assert.equal(snapshot.unparsedStdoutLines, 1);
});
