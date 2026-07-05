import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkflowManager, friendlyWorkflowFailureMessage } = require('../../dist-electron/main/workflow-manager.js');

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await wait(25);
  }
  throw new Error('waitFor_timeout');
};

const waitForRunEnd = (manager, runId) => waitFor(async () => {
  const run = await manager.getRun(runId);
  return run && ['succeeded', 'failed', 'canceled', 'skipped'].includes(run.status) ? run : null;
});

const writeFakeCodexCli = async (root, { sleepMs = 0, message = 'Hecho por codex', exitCode = 0 } = {}) => {
  const cliPath = join(root, 'bin', 'fake-codex.js');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(cliPath, [
    '#!/usr/bin/env node',
    'require("node:fs").readFileSync(0, "utf8");',
    sleepMs > 0 ? `require("node:child_process");` : '',
    sleepMs > 0
      ? `setTimeout(() => { console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(message)} } })); process.exit(${exitCode}); }, ${sleepMs});`
      : `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(message)} } })); process.exit(${exitCode});`,
  ].join('\n'), 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const createManager = async (overrides = {}) => {
  const metadataRoot = overrides.metadataRoot ?? await mkdtemp(join(tmpdir(), 'forger-wf-llm-'));
  const events = [];
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex-home'),
    getAgentRuntime: async (request) => request?.provider
      ? { provider: request.provider, model: request.model ?? 'gpt-test', effort: request.effort ?? 'medium', permissionMode: request.permissionMode }
      : { provider: 'codex', model: 'gpt-test', effort: 'medium' },
    getInstalledApps: () => [
      { id: 'finance-os', name: 'Finance OS', status: 'installed', description: 'Finanzas' },
    ],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    callConnectorAction: async (input) => ({ success: true, data: { echoed: input.input } }),
    getPersonalAgent: async () => null,
    onWorkflowUpdated: (event) => events.push(event),
    ...overrides.options,
  });
  await manager.initialize();
  return {
    manager,
    metadataRoot,
    events,
    cleanup: async () => {
      manager.dispose();
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

const llmWorkflowInput = (nodeOverrides = {}, workflowOverrides = {}) => ({
  name: 'Flujo LLM',
  trigger: { type: 'manual' },
  nodes: [{
    id: 'agente',
    name: 'Agente',
    type: 'llm_agent',
    prompt: 'Resuelve la tarea con {{trigger.type}}',
    toolIds: [],
    appIds: ['finance-os'],
    ...nodeOverrides,
  }],
  edges: [],
  ...workflowOverrides,
});

test('llm node runs the provider CLI, injects context, and falls back to the last message', async () => {
  const harness = await createManager();
  const cliPath = await writeFakeCodexCli(harness.metadataRoot, { message: 'Resumen final' });
  const mcpSessions = [];
  const listened = [];
  const released = [];
  try {
    const withCli = await createManager({
      metadataRoot: harness.metadataRoot,
      options: {
        getCodexAuthenticated: async () => true,
        getCodexCliPath: async () => cliPath,
        buildMemoryContext: async () => 'MEMORIA-GLOBAL',
        createForgerMcpSession: (nodeRunKey, appIds, toolIds) => {
          mcpSessions.push({ nodeRunKey, appIds, toolIds });
          return { url: 'http://127.0.0.1:1/mcp', token: 'tok' };
        },
        releaseForgerMcpSession: (token) => released.push(token),
        listenAppMcps: async (appIds, listenerId) => {
          listened.push({ appIds, listenerId });
          return [];
        },
        releaseAppMcps: (listenerId) => released.push(listenerId),
      },
    });
    const workflow = await withCli.manager.upsert(llmWorkflowInput({ toolIds: [], appIds: ['finance-os'] }));
    const summary = await withCli.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(withCli.manager, summary.id);

    assert.equal(finished.status, 'succeeded');
    const nodeRun = finished.nodeRuns.find((entry) => entry.nodeId === 'agente');
    assert.deepEqual(nodeRun.output, { text: 'Resumen final' });
    assert.equal(nodeRun.summary, 'Resumen final');
    assert.equal(mcpSessions.length, 1);
    assert.deepEqual(mcpSessions[0].appIds, ['finance-os']);
    assert.ok(mcpSessions[0].nodeRunKey.endsWith(':agente'));
    assert.deepEqual(listened[0].appIds, ['finance-os']);
    assert.ok(released.includes('tok'), 'forger session is released');

    const transcript = (await withCli.manager.getRun(summary.id)).transcript;
    assert.match(transcript, /MEMORIA-GLOBAL/, 'memory context is prepended to the prompt');
    assert.match(transcript, /Finance OS \(id: finance-os\)/, 'enabled apps are described');
    assert.match(transcript, /workflow_complete_node/, 'node contract is in the prompt');

    withCli.manager.dispose();
  } finally {
    await harness.cleanup();
  }
});

test('llm node honours MCP completion, schema validation, and reported failures', async () => {
  const harness = await createManager();
  const cliPath = await writeFakeCodexCli(harness.metadataRoot, { sleepMs: 700, message: 'texto libre' });
  try {
    const withCli = await createManager({
      metadataRoot: harness.metadataRoot,
      options: {
        getCodexAuthenticated: async () => true,
        getCodexCliPath: async () => cliPath,
      },
    });
    const workflow = await withCli.manager.upsert(llmWorkflowInput({
      appIds: [],
      outputSchema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } },
    }));
    const summary = await withCli.manager.runNow(workflow.id);
    const nodeRunKey = `${summary.id}:agente`;

    await waitFor(async () => withCli.manager.getNodeContext(nodeRunKey));
    const context = withCli.manager.getNodeContext(nodeRunKey);
    assert.equal(context.workflowName, 'Flujo LLM');
    assert.equal(context.nodeId, 'agente');
    assert.deepEqual(context.outputSchema.required, ['total']);
    assert.equal(context.input.trigger.type, 'manual');

    const invalid = withCli.manager.completeNodeFromMcp(nodeRunKey, { output: { total: 'muchos' }, summary: 'x' });
    assert.equal(invalid.success, false);
    assert.equal(invalid.technicalCode, 'workflow_output_schema_invalid');
    assert.ok(invalid.errors.length > 0);

    const valid = withCli.manager.completeNodeFromMcp(nodeRunKey, { output: { total: 7 }, summary: 'Siete elementos' });
    assert.equal(valid.success, true);

    const finished = await waitForRunEnd(withCli.manager, summary.id);
    assert.equal(finished.status, 'succeeded');
    const nodeRun = finished.nodeRuns.find((entry) => entry.nodeId === 'agente');
    assert.deepEqual(nodeRun.output, { total: 7 });
    assert.equal(nodeRun.summary, 'Siete elementos');

    // A second run where the agent reports failure through MCP.
    const failSummary = await withCli.manager.runNow(workflow.id);
    const failKey = `${failSummary.id}:agente`;
    await waitFor(async () => withCli.manager.getNodeContext(failKey));
    assert.equal(withCli.manager.failNodeFromMcp(failKey, { reason: 'sin datos suficientes' }).success, true);
    const failed = await waitForRunEnd(withCli.manager, failSummary.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'sin datos suficientes');

    // Default reason when the agent reports failure without one.
    const defaultSummary = await withCli.manager.runNow(workflow.id);
    const defaultKey = `${defaultSummary.id}:agente`;
    await waitFor(async () => withCli.manager.getNodeContext(defaultKey));
    assert.equal(withCli.manager.failNodeFromMcp(defaultKey, {}).success, true);
    const defaulted = await waitForRunEnd(withCli.manager, defaultSummary.id);
    assert.equal(defaulted.error, 'workflow_node_reported_failure');

    withCli.manager.dispose();
  } finally {
    await harness.cleanup();
  }
});

test('forger agent node runs with the personal agent grants and reports missing agents', async () => {
  const harness = await createManager();
  const cliPath = await writeFakeCodexCli(harness.metadataRoot, { message: 'Informe del agente' });
  const sessions = [];
  try {
    const withCli = await createManager({
      metadataRoot: harness.metadataRoot,
      options: {
        getCodexAuthenticated: async () => true,
        getCodexCliPath: async () => cliPath,
        createForgerMcpSession: (nodeRunKey, appIds, toolIds) => {
          sessions.push({ nodeRunKey, appIds, toolIds });
          return null;
        },
        getPersonalAgent: async (agentId) => agentId === 'agente-finanzas'
          ? {
              id: 'agente-finanzas',
              name: 'Finanzas',
              description: '',
              purpose: 'Cuidar las finanzas',
              instructions: 'Se muy prolijo',
              permissionMode: 'unsafe',
              networkAccess: true,
              runtime: { provider: 'codex', model: 'gpt-test', effort: 'low' },
              appIds: ['finance-os'],
              toolIds: ['slack.send_message'],
              createdAt: '',
              updatedAt: '',
            }
          : null,
      },
    });
    const workflow = await withCli.manager.upsert({
      name: 'Con agente',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'preparar', name: 'Preparar', type: 'connector', toolId: 'slack', actionId: 'x', input: {} },
        { id: 'delegado', name: 'Delegado', type: 'forger_agent', agentId: 'agente-finanzas', prompt: 'Revisa {{nodes.preparar.output.echoed}}' },
        { id: 'fantasma', name: 'Fantasma', type: 'forger_agent', agentId: 'no-existe', prompt: 'x' },
      ],
      edges: [
        { from: 'preparar', to: 'delegado', condition: 'success' },
        { from: 'delegado', to: 'fantasma', condition: 'always' },
      ],
    });
    const summary = await withCli.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(withCli.manager, summary.id);

    const byNode = Object.fromEntries(finished.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
    assert.equal(byNode.delegado.status, 'succeeded');
    assert.deepEqual(byNode.delegado.output, { text: 'Informe del agente' });
    assert.equal(byNode.fantasma.status, 'failed');
    assert.equal(byNode.fantasma.error, 'workflow_personal_agent_not_found');
    assert.equal(finished.status, 'failed', 'unhandled ghost agent failure fails the run');

    const delegadoSession = sessions.find((session) => session.nodeRunKey.endsWith(':delegado'));
    assert.deepEqual(delegadoSession.appIds, ['finance-os'], 'agent grants scope the MCP session');
    assert.deepEqual(delegadoSession.toolIds, ['slack.send_message']);

    const transcript = (await withCli.manager.getRun(summary.id)).transcript;
    assert.match(transcript, /Cuidar las finanzas/, 'agent purpose precedes the node prompt');
    assert.match(transcript, /Se muy prolijo/);

    withCli.manager.dispose();
  } finally {
    await harness.cleanup();
  }
});

test('provider readiness and CLI resolution failures produce clean node errors', async () => {
  const cases = [
    [{ }, 'codex_auth_missing'],
    [{ getCodexAuthenticated: async () => true }, 'codex_cli_missing'],
    [{ }, 'claude_auth_missing', { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' }],
    [{ getClaudeAuthenticated: async () => true }, 'claude_cli_missing', { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' }],
    [{ }, 'antigravity_auth_missing', { provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium' }],
    [
      { getAntigravityAuthenticated: async () => true },
      'antigravity_cli_missing',
      { provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium' },
    ],
  ];
  for (const [options, expectedError, runtime] of cases) {
    const harness = await createManager({ options });
    try {
      const workflow = await harness.manager.upsert(llmWorkflowInput({ appIds: [], ...(runtime ? { runtime } : {}) }));
      const summary = await harness.manager.runNow(workflow.id);
      const finished = await waitForRunEnd(harness.manager, summary.id);
      assert.equal(finished.status, 'failed', expectedError);
      assert.equal(finished.error, expectedError);
    } finally {
      await harness.cleanup();
    }
  }
});

test('cancelRun kills a running provider CLI and cancels the run', async () => {
  const harness = await createManager();
  const cliPath = await writeFakeCodexCli(harness.metadataRoot, { sleepMs: 8_000, message: 'nunca llega' });
  try {
    const withCli = await createManager({
      metadataRoot: harness.metadataRoot,
      options: {
        getCodexAuthenticated: async () => true,
        getCodexCliPath: async () => cliPath,
      },
    });
    const workflow = await withCli.manager.upsert(llmWorkflowInput({ appIds: [] }));
    const summary = await withCli.manager.runNow(workflow.id);
    await waitFor(async () => withCli.manager.getNodeContext(`${summary.id}:agente`));

    const notActive = await withCli.manager.cancelRun('run-inexistente');
    assert.equal(notActive.success, false);
    assert.equal(notActive.technicalCode, 'workflow_run_not_active');

    const canceled = await withCli.manager.cancelRun(summary.id);
    assert.equal(canceled.success, true);

    const finished = await waitForRunEnd(withCli.manager, summary.id);
    assert.equal(finished.status, 'canceled');

    withCli.manager.dispose();
  } finally {
    await harness.cleanup();
  }
});

test('scheduled workflows run when due, respect missed-run policies, and reject invalid dates', async () => {
  const scenarios = [
    { name: 'on-time', offsetMs: -5_000, policy: 'within_window', expect: 'succeeded' },
    { name: 'always', offsetMs: -3 * 60 * 60_000, policy: 'always', expect: 'succeeded' },
    { name: 'within-window-hit', offsetMs: -5 * 60_000, policy: 'within_window', windowMinutes: 30, expect: 'succeeded' },
    { name: 'skip-policy', offsetMs: -10 * 60_000, policy: 'skip', expect: 'skipped', error: 'workflow_missed_schedule' },
    { name: 'window-miss', offsetMs: -10 * 60_000, policy: 'within_window', windowMinutes: 1, expect: 'skipped', error: 'workflow_missed_schedule' },
    { name: 'invalid-date', nextRunAt: 'no-es-fecha', policy: 'within_window', expect: 'skipped', error: 'workflow_invalid_schedule' },
  ];
  for (const scenario of scenarios) {
    const metadataRoot = await mkdtemp(join(tmpdir(), `forger-wf-sched-${scenario.name}-`));
    try {
      const workflow = {
        id: `wf-${scenario.name}`,
        name: `Programado ${scenario.name}`,
        trigger: {
          type: 'scheduled',
          frequency: { type: 'hourly' },
          missedRunPolicy: scenario.policy,
          ...(scenario.windowMinutes ? { missedRunWindowMinutes: scenario.windowMinutes } : {}),
        },
        nodes: [{ id: 'paso', name: 'Paso', type: 'connector', toolId: 'slack', actionId: 'x', input: {} }],
        edges: [],
        enabled: true,
        running: false,
        nextRunAt: scenario.nextRunAt ?? new Date(Date.now() + scenario.offsetMs).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(join(metadataRoot, 'workflows.json'), JSON.stringify([workflow]), 'utf8');

      const harness = await createManager({ metadataRoot });
      const stored = await waitFor(async () => {
        const current = harness.manager.get(workflow.id);
        return current?.lastRun && ['succeeded', 'failed', 'skipped'].includes(current.lastRun.status) ? current : null;
      });
      assert.equal(stored.lastRun.status, scenario.expect, scenario.name);
      if (scenario.error) {
        assert.equal(stored.lastRun.error, scenario.error, scenario.name);
      }
      assert.ok(stored.nextRunAt, 'schedule advances to a next run');
      assert.ok(Date.parse(stored.nextRunAt) > Date.now(), 'next run is in the future');
      await harness.cleanup();
    } finally {
      await rm(metadataRoot, { recursive: true, force: true });
    }
  }
});

test('future schedules arm a timer and pausing clears it', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Futuro',
      trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
      nodes: [{ id: 'paso', name: 'Paso', type: 'connector', toolId: 'slack', actionId: 'x', input: {} }],
      edges: [],
      enabled: true,
    });
    assert.ok(Date.parse(workflow.nextRunAt) > Date.now());
    const paused = await harness.manager.setEnabled(workflow.id, false);
    assert.equal(paused.nextRunAt, null);
    const resumed = await harness.manager.setEnabled(workflow.id, true);
    assert.ok(resumed.nextRunAt);

    await assert.rejects(
      harness.manager.upsert({ id: 'wf-desconocido', name: 'X', trigger: { type: 'manual' }, nodes: [{ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'a', input: {} }], edges: [] }),
      /workflow_not_found/,
    );
  } finally {
    await harness.cleanup();
  }
});

test('initialize drops corrupt entries, restores schedules, and fails interrupted runs', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-init-'));
  try {
    const slowHarness = await createManager({
      metadataRoot,
      options: {
        callConnectorAction: async () => {
          await wait(1_500);
          return { success: true, data: { ok: true } };
        },
      },
    });
    const workflow = await slowHarness.manager.upsert({
      name: 'Interrumpido',
      trigger: { type: 'manual' },
      nodes: [{ id: 'lento', name: 'Lento', type: 'connector', toolId: 'slack', actionId: 'x', input: {} }],
      edges: [],
    });
    const runSummary = await slowHarness.manager.runNow(workflow.id);
    await waitFor(async () => (await slowHarness.manager.getRun(runSummary.id))?.status === 'running');
    // Simulate a crash: drop the manager without letting the run finish.
    slowHarness.manager.dispose();

    const raw = JSON.parse(await readFile(join(metadataRoot, 'workflows.json'), 'utf8'));
    raw.push({ id: '', name: 'invalido' });
    raw.push({
      id: 'wf-ciclo',
      name: 'Ciclo',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} },
        { id: 'b', name: 'B', type: 'connector', toolId: 't', actionId: 'x', input: {} },
      ],
      edges: [
        { from: 'a', to: 'b', condition: 'success' },
        { from: 'b', to: 'a', condition: 'success' },
      ],
      enabled: false,
    });
    await writeFile(join(metadataRoot, 'workflows.json'), JSON.stringify(raw), 'utf8');

    const reopened = await createManager({ metadataRoot });
    const surviving = reopened.manager.list();
    assert.deepEqual(surviving.map((entry) => entry.id), [workflow.id], 'corrupt and cyclic entries are dropped');

    const interrupted = await reopened.manager.getRun(runSummary.id);
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error, 'workflow_interrupted');
    assert.ok(interrupted.nodeRuns.every((nodeRun) => ['canceled', 'succeeded', 'failed', 'skipped'].includes(nodeRun.status)));
    assert.equal(reopened.manager.get(workflow.id).running, false);

    await reopened.cleanup();
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('runNode while the workflow is running records a skipped step run', async () => {
  const harness = await createManager({
    options: {
      callConnectorAction: async () => {
        await wait(600);
        return { success: true, data: { ok: true } };
      },
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Ocupado',
      trigger: { type: 'manual' },
      nodes: [{ id: 'lento', name: 'Lento', type: 'connector', toolId: 'slack', actionId: 'x', input: {} }],
      edges: [],
    });
    const first = await harness.manager.runNow(workflow.id);
    await waitFor(async () => harness.manager.get(workflow.id)?.running === true);
    const step = await harness.manager.runNode(workflow.id, 'lento');
    assert.equal(step.status, 'skipped');
    assert.equal(step.error, 'workflow_already_running');
    await waitForRunEnd(harness.manager, first.id);
  } finally {
    await harness.cleanup();
  }
});


test('node and run level errors from the runtime resolver are captured', async () => {
  const harness = await createManager({
    options: { getAgentRuntime: async () => { throw new Error('runtime_roto'); } },
  });
  try {
    const workflow = await harness.manager.upsert(llmWorkflowInput({ appIds: [] }));
    const summary = await harness.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(harness.manager, summary.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'runtime_roto', 'node executor errors surface as the run error');

    const step = await harness.manager.runNode(workflow.id, 'agente');
    const stepRun = await waitForRunEnd(harness.manager, step.id);
    assert.equal(stepRun.status, 'failed');
    assert.equal(stepRun.error, 'runtime_roto', 'step runs capture executor errors too');
  } finally {
    await harness.cleanup();
  }
});

test('run level failures outside node execution mark the run as failed', async () => {
  const { WorkflowManager: Manager } = require('../../dist-electron/main/workflow-manager.js');
  class FlakyManager extends Manager {
    requireWorkflowCalls = 0;
    requireWorkflow(id) {
      this.requireWorkflowCalls += 1;
      if (this.failOnCall && this.requireWorkflowCalls === this.failOnCall) {
        throw new Error('workflow_not_found');
      }
      return super.requireWorkflow(id);
    }
  }
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-flaky-'));
  const manager = new FlakyManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex-home'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    callConnectorAction: async () => ({ success: true, data: {} }),
    onWorkflowUpdated: () => {},
  });
  try {
    await manager.initialize();
    const workflow = await manager.upsert({
      name: 'Fragil',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
    });
    // startRun consumes one requireWorkflow call; the next one happens inside
    // executeRun, which must convert the failure into a failed run.
    manager.requireWorkflowCalls = 0;
    manager.failOnCall = 2;
    const summary = await manager.runNow(workflow.id);
    const finished = await waitForRunEnd(manager, summary.id);
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'workflow_not_found');
  } finally {
    manager.dispose();
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('cancelRun resolves pending approvals and cancels remaining branch nodes', async () => {
  const harness = await createManager({
    options: {
      callConnectorAction: async (input) => {
        if (input.actionId === 'slow.action') {
          await wait(700);
        }
        return { success: true, data: { ok: true } };
      },
    },
  });
  try {
    const approvalWorkflow = await harness.manager.upsert({
      name: 'Aprobacion cancelada',
      trigger: { type: 'manual' },
      nodes: [{ id: 'espera', name: 'Espera', type: 'connector', toolId: 't', actionId: 'x', input: {}, requiresApproval: true }],
      edges: [],
    });
    const approvalRun = await harness.manager.runNow(approvalWorkflow.id);
    await waitFor(async () => (await harness.manager.getRun(approvalRun.id))?.status === 'waiting_approval');
    await harness.manager.cancelRun(approvalRun.id);
    const canceledApproval = await waitForRunEnd(harness.manager, approvalRun.id);
    assert.equal(canceledApproval.status, 'canceled');

    const chainWorkflow = await harness.manager.upsert({
      name: 'Cadena cancelada',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'lento', name: 'Lento', type: 'connector', toolId: 't', actionId: 'slow.action', input: {} },
        { id: 'despues', name: 'Despues', type: 'connector', toolId: 't', actionId: 'x', input: {} },
      ],
      edges: [{ from: 'lento', to: 'despues', condition: 'success' }],
    });
    const chainRun = await harness.manager.runNow(chainWorkflow.id);
    await waitFor(async () => (await harness.manager.getRun(chainRun.id))?.nodeRuns.some((n) => n.status === 'running'));
    await harness.manager.cancelRun(chainRun.id);
    const canceledChain = await waitForRunEnd(harness.manager, chainRun.id);
    assert.equal(canceledChain.status, 'canceled');
    const pendingNode = canceledChain.nodeRuns.find((n) => n.nodeId === 'despues');
    assert.equal(pendingNode.status, 'canceled', 'pending branch nodes end canceled');

    const forEachWorkflow = await harness.manager.upsert({
      name: 'ForEach cancelado',
      trigger: { type: 'manual' },
      nodes: [
        { id: 'lista', name: 'Lista', type: 'connector', toolId: 't', actionId: 'x', input: {} },
        {
          id: 'iterar',
          name: 'Iterar',
          type: 'connector',
          toolId: 't',
          actionId: 'slow.action',
          input: {},
          forEach: 'nodes.lista.output.items',
        },
      ],
      edges: [{ from: 'lista', to: 'iterar', condition: 'success' }],
    });
    const withItems = await createManager({
      metadataRoot: harness.metadataRoot,
      options: {
        callConnectorAction: async (input) => {
          if (input.actionId === 'slow.action') {
            await wait(400);
            return { success: true, data: { ok: true } };
          }
          return { success: true, data: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } };
        },
      },
    });
    const forEachRun = await withItems.manager.runNow(forEachWorkflow.id);
    await waitFor(async () => (await withItems.manager.getRun(forEachRun.id))?.nodeRuns.some((n) => n.nodeId === 'iterar' && n.status === 'running'));
    await wait(100);
    await withItems.manager.cancelRun(forEachRun.id);
    const canceledForEach = await waitForRunEnd(withItems.manager, forEachRun.id);
    assert.equal(canceledForEach.status, 'canceled');
    withItems.manager.dispose();
  } finally {
    await harness.cleanup();
  }
});

test('connector nodes fail cleanly without an executor or when the executor throws', async () => {
  const noExecutor = await createManager({ options: { callConnectorAction: undefined } });
  try {
    const workflow = await noExecutor.manager.upsert({
      name: 'Sin ejecutor',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
    });
    const summary = await noExecutor.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(noExecutor.manager, summary.id);
    assert.equal(finished.error, 'workflow_connectors_unavailable');
  } finally {
    await noExecutor.cleanup();
  }

  const throwing = await createManager({
    options: { callConnectorAction: async () => { throw new Error('conector_explota'); } },
  });
  try {
    const workflow = await throwing.manager.upsert({
      name: 'Explota',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
    });
    const summary = await throwing.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(throwing.manager, summary.id);
    assert.equal(finished.error, 'conector_explota');
  } finally {
    await throwing.cleanup();
  }
});

const writeFakeClaudeCli = async (root) => {
  const cliPath = join(root, 'bin', 'fake-claude.js');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(cliPath, [
    '#!/usr/bin/env node',
    'try { require("node:fs").readFileSync(0, "utf8"); } catch {}',
    'console.log(JSON.stringify({ result: "Hecho por claude" }));',
  ].join('\n'), 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

const writeFakeAntigravityCli = async (root) => {
  const cliPath = join(root, 'bin', 'fake-agy.js');
  await mkdir(join(root, 'bin'), { recursive: true });
  await writeFile(cliPath, [
    '#!/usr/bin/env node',
    'console.log("Listo trabajo antigravity");',
  ].join('\n'), 'utf8');
  await chmod(cliPath, 0o755);
  return cliPath;
};

test('claude and antigravity nodes run through their provider CLIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-wf-providers-'));
  try {
    const claudeCli = await writeFakeClaudeCli(root);
    const agyCli = await writeFakeAntigravityCli(root);
    const harness = await createManager({
      metadataRoot: root,
      options: {
        getClaudeAuthenticated: async () => true,
        getClaudeCliPath: async () => claudeCli,
        getAntigravityAuthenticated: async () => true,
        getAntigravityCliPath: async () => agyCli,
      },
    });
    const workflow = await harness.manager.upsert({
      name: 'Multi proveedor',
      trigger: { type: 'manual' },
      nodes: [
        {
          id: 'claude',
          name: 'Claude',
          type: 'llm_agent',
          prompt: 'haz algo',
          toolIds: [],
          appIds: [],
          runtime: { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' },
        },
        {
          id: 'agy',
          name: 'Antigravity',
          type: 'llm_agent',
          prompt: 'haz otra cosa',
          toolIds: [],
          appIds: [],
          runtime: { provider: 'antigravity', model: 'gemini-3.5-flash', effort: 'medium' },
        },
      ],
      edges: [{ from: 'claude', to: 'agy', condition: 'success' }],
    });
    const summary = await harness.manager.runNow(workflow.id);
    const finished = await waitForRunEnd(harness.manager, summary.id);
    const byNode = Object.fromEntries(finished.nodeRuns.map((n) => [n.nodeId, n]));
    assert.equal(byNode.claude.status, 'succeeded');
    assert.deepEqual(byNode.claude.output, { text: 'Hecho por claude' });
    assert.equal(byNode.agy.status, 'succeeded');
    assert.match(byNode.agy.output.text, /Listo trabajo antigravity/);
    harness.manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a due timer fires and runs the scheduled workflow', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-timer-'));
  try {
    await writeFile(join(metadataRoot, 'workflows.json'), JSON.stringify([{
      id: 'wf-timer',
      name: 'Timer',
      trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
      nodes: [{ id: 'paso', name: 'Paso', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
      enabled: true,
      running: false,
      nextRunAt: new Date(Date.now() + 600).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]), 'utf8');
    const harness = await createManager({ metadataRoot });
    const finished = await waitFor(async () => {
      const current = harness.manager.get('wf-timer');
      return current?.lastRun?.status === 'succeeded' ? current : null;
    });
    assert.equal(finished.lastRun.status, 'succeeded');
    await harness.cleanup();
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('interrupted-run recovery keeps finished workflows and tolerates missing run files', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-recovery-'));
  try {
    const now = new Date().toISOString();
    const baseNode = { id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} };
    await writeFile(join(metadataRoot, 'workflows.json'), JSON.stringify([
      {
        id: 'wf-sano',
        name: 'Sano',
        trigger: { type: 'manual' },
        nodes: [baseNode],
        edges: [],
        enabled: false,
        running: false,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
        lastRun: { id: 'run-ok', workflowId: 'wf-sano', trigger: 'manual', status: 'succeeded', startedAt: now, nodeRuns: [] },
      },
      {
        id: 'wf-huerfano',
        name: 'Huerfano',
        trigger: { type: 'manual' },
        nodes: [baseNode],
        edges: [],
        enabled: false,
        running: true,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
        lastRun: { id: 'run-desaparecido', workflowId: 'wf-huerfano', trigger: 'manual', status: 'running', startedAt: now, nodeRuns: [] },
      },
    ]), 'utf8');
    const harness = await createManager({ metadataRoot });
    assert.equal(harness.manager.get('wf-sano').lastRun.status, 'succeeded', 'finished runs stay untouched');
    assert.equal(harness.manager.get('wf-huerfano').running, false);
    await harness.cleanup();
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('killChild covers windows and already-dead child fallbacks', async () => {
  const harness = await createManager();
  try {
    const killed = [];
    const withPlatform = (platform, operation) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      try {
        return operation();
      } finally {
        Object.defineProperty(process, 'platform', descriptor);
      }
    };
    withPlatform('win32', () => {
      harness.manager.killChild({ pid: 999999, kill: (signal) => killed.push(signal) });
    });
    assert.deepEqual(killed, ['SIGKILL'], 'windows kills the child directly');

    // A child whose process group is gone falls back to child.kill, and a
    // child that also rejects the direct kill is swallowed silently.
    harness.manager.killChild({ pid: 2147483646, kill: (signal) => killed.push(signal) });
    assert.equal(killed.length, 2);
    assert.doesNotThrow(() => harness.manager.killChild({
      pid: 2147483646,
      kill: () => { throw new Error('already dead'); },
    }));
  } finally {
    await harness.cleanup();
  }
});

test('pausing a manual workflow without timers and store guards behave', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Manual pausable',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
    });
    const paused = await harness.manager.setEnabled(workflow.id, false);
    assert.equal(paused.enabled, false, 'manual workflows pause without armed timers');

    await assert.rejects(harness.manager.getRun('../fuera-de-storage'), /workflow_run_path_outside_storage/);
  } finally {
    await harness.cleanup();
  }
});


test('deleting a workflow mid-run finishes the run without resurrecting it', async () => {
  const harness = await createManager({
    options: {
      callConnectorAction: async () => {
        await wait(500);
        return { success: true, data: { ok: true } };
      },
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Borrado en vivo',
      trigger: { type: 'manual' },
      nodes: [{ id: 'lento', name: 'Lento', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
    });
    const summary = await harness.manager.runNow(workflow.id);
    await waitFor(async () => (await harness.manager.getRun(summary.id))?.status === 'running');
    await harness.manager.delete(workflow.id);
    const finished = await waitForRunEnd(harness.manager, summary.id);
    assert.equal(finished.status, 'succeeded', 'the in-flight run still completes');
    assert.equal(harness.manager.get(workflow.id), null, 'the workflow stays deleted');
  } finally {
    await harness.cleanup();
  }
});

test('running an unknown workflow rejects and nameless stored entries are dropped', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-nameless-'));
  try {
    await writeFile(join(metadataRoot, 'workflows.json'), JSON.stringify([{
      id: 'wf-sin-nombre',
      name: '   ',
      trigger: { type: 'manual' },
      nodes: [{ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: 'x', input: {} }],
      edges: [],
      enabled: false,
    }]), 'utf8');
    const harness = await createManager({ metadataRoot });
    assert.equal(harness.manager.list().length, 0, 'nameless workflows are dropped on load');
    await assert.rejects(harness.manager.runNow('wf-desconocido'), /workflow_not_found/);
    await harness.cleanup();
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('corrupt store files degrade to empty results', async () => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-wf-corrupt-'));
  try {
    await mkdir(join(metadataRoot, 'workflow-runs'), { recursive: true });
    await writeFile(join(metadataRoot, 'workflows.json'), '{esto no es json', 'utf8');
    await writeFile(join(metadataRoot, 'workflow-runs', 'run-roto.json'), '{tampoco', 'utf8');
    await writeFile(join(metadataRoot, 'workflow-runs', 'wf-x.index.json'), '{ni esto', 'utf8');
    const harness = await createManager({ metadataRoot });
    assert.deepEqual(harness.manager.list(), []);
    assert.equal(await harness.manager.getRun('run-roto'), null);
    assert.deepEqual(await harness.manager.listRuns('wf-x'), []);
    await harness.cleanup();
  } finally {
    await rm(metadataRoot, { recursive: true, force: true });
  }
});

test('friendly workflow failure messages cover the remaining codes', () => {
  assert.match(friendlyWorkflowFailureMessage('claude_cli_missing'), /no esta listo/);
  assert.match(friendlyWorkflowFailureMessage('workflow_missed_schedule'), /ventana configurada/);
  assert.match(friendlyWorkflowFailureMessage('codex_timeout_after_300000ms'), /tardo demasiado/);
  assert.match(friendlyWorkflowFailureMessage('cualquier_otro_codigo'), /no se pudo completar/);
});
