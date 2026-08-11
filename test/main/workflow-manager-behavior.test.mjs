import assert from 'node:assert/strict';
import test from 'node:test';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkflowManager, friendlyWorkflowFailureMessage } = require('../../dist-electron/main/workflow-manager.js');

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const waitFor = async (predicate, timeoutMs = 15_000) => {
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

const createRecordingCodexCli = async (root) => {
  const callsPath = join(root, 'workflow-provider-calls.ndjson');
  const cliPath = join(root, 'workflow-provider.cjs');
  await writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
    args: process.argv.slice(2),
    stdin,
  }) + '\\n');
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'workflow-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Workflow complete.' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }));
});
`, 'utf8');
  await chmod(cliPath, 0o755);
  return { cliPath, callsPath };
};

const createManager = async (overrides = {}) => {
  const metadataRoot = await mkdtemp(join(tmpdir(), 'forger-workflows-'));
  const events = [];
  const connectorCalls = [];
  const manager = new WorkflowManager({
    forgerHomeRoot: metadataRoot,
    metadataRoot,
    codexHome: join(metadataRoot, 'codex'),
    getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-test', effort: 'medium' }),
    getInstalledApps: () => [],
    getCodexCliPath: async () => null,
    getClaudeCliPath: async () => null,
    getCodexPathEntries: async () => [],
    getCodexAuthenticated: async () => false,
    getClaudeAuthenticated: async () => false,
    callConnectorAction: overrides.callConnectorAction ?? (async (input) => {
      connectorCalls.push(input);
      return { success: true, userMessage: 'ok', data: { echoed: input.input } };
    }),
    getPersonalAgent: overrides.getPersonalAgent ?? (async () => null),
    onWorkflowUpdated: (event) => events.push(event),
    ...overrides.options,
  });
  await manager.initialize();
  return {
    manager,
    metadataRoot,
    events,
    connectorCalls,
    cleanup: async () => {
      await manager.dispose();
      await rm(metadataRoot, { recursive: true, force: true });
    },
  };
};

const connectorNode = (id, overrides = {}) => ({
  id,
  name: `Forger tool ${id}`,
  type: 'connector',
  toolId: 'forger',
  actionId: 'forger_refresh_app_view',
  input: { channelId: '#general', text: 'hola' },
  ...overrides,
});

test('upsert validates and persists workflows, list/get/delete/setEnabled work', async () => {
  const harness = await createManager();
  try {
    await assert.rejects(
      harness.manager.upsert({ name: '', trigger: { type: 'manual' }, nodes: [connectorNode('a')], edges: [] }),
      /workflow_name_required/,
    );
    await assert.rejects(
      harness.manager.upsert({ name: 'Sin nodos', trigger: { type: 'manual' }, nodes: [], edges: [] }),
      /workflow_nodes_required/,
    );
    await assert.rejects(
      harness.manager.upsert({
        name: 'No debe perder pasos',
        trigger: { type: 'manual' },
        nodes: [connectorNode('valido'), { id: 'roto', name: 'Roto', type: 'not_a_node' }],
        edges: [],
      }),
      /workflow_node_invalid/,
    );
    assert.equal(harness.manager.list().length, 0);
    await assert.rejects(
      harness.manager.upsert({
        name: 'Ciclo',
        trigger: { type: 'manual' },
        nodes: [connectorNode('a'), connectorNode('b')],
        edges: [
          { from: 'a', to: 'b', condition: 'success' },
          { from: 'b', to: 'a', condition: 'success' },
        ],
      }),
      /workflow_graph_has_cycle/,
    );

    const workflow = await harness.manager.upsert({
      name: 'Mi flujo',
      description: 'demo',
      trigger: { type: 'manual' },
      nodes: [connectorNode('a')],
      edges: [],
    });
    assert.ok(workflow.id);
    assert.equal(workflow.enabled, false);
    assert.equal(workflow.nextRunAt, null);
    assert.equal(harness.manager.list().length, 1);
    assert.equal(harness.manager.get(workflow.id)?.name, 'Mi flujo');

    const paused = await harness.manager.setEnabled(workflow.id, false);
    assert.equal(paused.enabled, false);

    const scheduled = await harness.manager.upsert({
      id: workflow.id,
      expectedRevision: workflow.revision,
      name: 'Mi flujo',
      trigger: { type: 'scheduled', frequency: { type: 'hourly' } },
      nodes: [connectorNode('a')],
      edges: [],
      enabled: true,
    });
    assert.equal(scheduled.nextRunAt, null, 'saving a scheduled draft does not activate it');
    const review = await harness.manager.review(workflow.id);
    await harness.manager.apply(workflow.id, {
      definitionHash: review.definitionHash,
      expectedRevision: scheduled.revision,
    });
    const activated = await harness.manager.setEnabled(workflow.id, true);
    assert.ok(activated.nextRunAt, 'activating an applied schedule gets nextRunAt');

    const deletion = await harness.manager.delete(workflow.id);
    assert.equal(deletion.success, true);
    assert.equal(harness.manager.list().length, 0);
    const missing = await harness.manager.delete('nope');
    assert.equal(missing.success, false);
  } finally {
    await harness.cleanup();
  }
});

test('runs a connector + condition DAG chaining outputs through templates', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Encadenado',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('fuente', { input: { channelId: '#general', text: 'hola' } }),
        {
          id: 'hay_datos',
          name: 'Hay datos',
          type: 'condition',
          expression: { left: '{{nodes.fuente.output.echoed.text}}', operator: 'equals', right: 'hola' },
        },
        connectorNode('notificar', {
          input: { channelId: '#general', text: 'texto: {{nodes.fuente.output.echoed.text}}' },
        }),
        connectorNode('nunca', { input: { channelId: '#general', text: 'no debería correr' } }),
      ],
      edges: [
        { from: 'fuente', to: 'hay_datos', condition: 'success' },
        { from: 'hay_datos', to: 'notificar', condition: 'success' },
        { from: 'hay_datos', to: 'nunca', condition: 'error' },
      ],
    });

    const runSummary = await harness.manager.runNow(workflow.id);
    assert.equal(runSummary.status, 'queued');

    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed', 'canceled'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'succeeded');

    const byNode = Object.fromEntries(finished.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
    assert.equal(byNode.fuente.status, 'succeeded');
    assert.equal(byNode.hay_datos.status, 'succeeded');
    assert.deepEqual(byNode.hay_datos.output, { result: true });
    assert.equal(byNode.notificar.status, 'succeeded');
    assert.equal(byNode.nunca.status, 'skipped');

    const notifyCall = harness.connectorCalls.find((call) => call.input.text?.startsWith('texto:'));
    assert.equal(notifyCall.input.text, 'texto: hola');

    const runs = await harness.manager.listRuns(workflow.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'succeeded');
  } finally {
    await harness.cleanup();
  }
});

test('error branches handle connector failures and unhandled failures fail the run', async () => {
  const harness = await createManager({
    callConnectorAction: async (input) => input.actionId === 'fail.action'
      ? { success: false, userMessage: 'falló', technicalCode: 'connector_boom' }
      : { success: true, data: { ok: true } },
  });
  try {
    const handled = await harness.manager.upsert({
      name: 'Con manejo',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('rompe', { actionId: 'fail.action' }),
        connectorNode('rescate'),
      ],
      edges: [{ from: 'rompe', to: 'rescate', condition: 'error' }],
    });
    const handledRun = await harness.manager.runNow(handled.id);
    const handledResult = await waitFor(async () => {
      const run = await harness.manager.getRun(handledRun.id);
      return run && ['completed_with_issues', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(handledResult.status, 'completed_with_issues');
    const byNode = Object.fromEntries(handledResult.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
    assert.equal(byNode.rompe.status, 'failed');
    assert.equal(byNode.rompe.error, 'connector_boom');
    assert.equal(byNode.rescate.status, 'succeeded');

    const unhandled = await harness.manager.upsert({
      name: 'Sin manejo',
      trigger: { type: 'manual' },
      nodes: [connectorNode('rompe', { actionId: 'fail.action' })],
      edges: [],
    });
    const unhandledRun = await harness.manager.runNow(unhandled.id);
    const unhandledResult = await waitFor(async () => {
      const run = await harness.manager.getRun(unhandledRun.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(unhandledResult.status, 'failed');
    assert.equal(unhandledResult.error, 'connector_boom');
  } finally {
    await harness.cleanup();
  }
});

test('requiresApproval pauses the run until approveNode resolves it', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Con aprobación',
      trigger: { type: 'manual' },
      nodes: [connectorNode('enviar', { requiresApproval: true })],
      edges: [],
    });
    const runSummary = await harness.manager.runNow(workflow.id);

    const waiting = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    assert.equal(waiting.pendingApprovalNodeId, 'enviar');

    const approval = await harness.manager.approveNode({ runId: runSummary.id, nodeId: 'enviar', approved: true });
    assert.equal(approval.success, true);

    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'succeeded');

    const stale = await harness.manager.approveNode({ runId: runSummary.id, nodeId: 'enviar', approved: true });
    assert.equal(stale.success, false);
    assert.equal(stale.technicalCode, 'workflow_approval_not_pending');
  } finally {
    await harness.cleanup();
  }
});

test('rejected approval fails the node and the run when unhandled', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Rechazado',
      trigger: { type: 'manual' },
      nodes: [connectorNode('enviar', { requiresApproval: true })],
      edges: [],
    });
    const runSummary = await harness.manager.runNow(workflow.id);
    await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({ runId: runSummary.id, nodeId: 'enviar', approved: false });
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'workflow_node_approval_denied');
    assert.equal(harness.connectorCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('MCP node bridge validates output schemas and reports failures', async () => {
  const harness = await createManager();
  try {
    assert.equal(harness.manager.getNodeContext('missing'), null);
    assert.equal(harness.manager.completeNodeFromMcp('missing', {}).success, false);
    assert.equal(harness.manager.failNodeFromMcp('missing', {}).success, false);
  } finally {
    await harness.cleanup();
  }
});

test('parallel branches execute concurrently', async () => {
  let active = 0;
  let maxActive = 0;
  const harness = await createManager({
    callConnectorAction: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await wait(150);
      active -= 1;
      return { success: true, data: { ok: true } };
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Paralelo',
      trigger: { type: 'manual' },
      nodes: [connectorNode('rama1'), connectorNode('rama2'), connectorNode('rama3')],
      edges: [],
    });
    const runSummary = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'succeeded');
    assert.ok(maxActive >= 2, `expected parallel branches, saw maxActive=${maxActive}`);
  } finally {
    await harness.cleanup();
  }
});

test('workflow skips concurrent duplicate runs and interrupted runs fail on restart', async () => {
  const harness = await createManager({
    callConnectorAction: async () => {
      await wait(300);
      return { success: true, data: { ok: true } };
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Duplicado',
      trigger: { type: 'manual' },
      nodes: [connectorNode('lento')],
      edges: [],
    });
    const first = await harness.manager.runNow(workflow.id);
    await waitFor(async () => harness.manager.get(workflow.id)?.running === true);
    const second = await harness.manager.runNow(workflow.id);
    assert.equal(second.status, 'skipped');
    await waitFor(async () => {
      const run = await harness.manager.getRun(first.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });

    assert.equal(friendlyWorkflowFailureMessage('workflow_interrupted').includes('interrumpido'), true);
    assert.equal(friendlyWorkflowFailureMessage('codex_auth_missing').length > 0, true);
  } finally {
    await harness.cleanup();
  }
});


test('runNode executes a single step seeded with the latest stored outputs', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'Paso a paso',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('fuente', { input: { channelId: '#general', text: 'hola' } }),
        connectorNode('destino', {
          input: { channelId: '#general', text: 'antes: {{nodes.fuente.output.echoed.text}}' },
          requiresApproval: true,
        }),
      ],
      edges: [{ from: 'fuente', to: 'destino', condition: 'success' }],
    });

    const fullRun = await harness.manager.runNow(workflow.id);
    await waitFor(async () => {
      const run = await harness.manager.getRun(fullRun.id);
      return run?.status === 'waiting_approval' ? run : null;
    });
    await harness.manager.approveNode({ runId: fullRun.id, nodeId: 'destino', approved: true });
    await waitFor(async () => {
      const run = await harness.manager.getRun(fullRun.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });

    const outputs = await harness.manager.collectLatestOutputs(workflow.id);
    assert.deepEqual(outputs.fuente, { echoed: { channelId: '#general', text: 'hola' } });

    harness.connectorCalls.length = 0;
    const stepRun = await harness.manager.runNode(workflow.id, 'destino');
    assert.equal(stepRun.trigger, 'step');
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(stepRun.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'succeeded');

    const byNode = Object.fromEntries(finished.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
    assert.equal(byNode.fuente.status, 'skipped', 'other nodes stay skipped in a step run');
    assert.equal(byNode.destino.status, 'succeeded');
    assert.equal(harness.connectorCalls.length, 1, 'approval is bypassed for explicit step runs');
    assert.equal(harness.connectorCalls[0].input.text, 'antes: hola', 'templates resolve against stored outputs');

    await assert.rejects(harness.manager.runNode(workflow.id, 'nope'), /workflow_node_not_found/);
  } finally {
    await harness.cleanup();
  }
});


test('forEach connectors run the action once per item with {{item.*}} context', async () => {
  const harness = await createManager({
    callConnectorAction: async (input) => {
      if (input.actionId === 'list.action') {
        return {
          success: true,
          data: {
            messages: [
              { subject: 'Factura', from: 'a@x.com' },
              { subject: 'Boleta', from: 'b@x.com' },
            ],
          },
        };
      }
      harness.connectorCalls.push(input);
      return { success: true, data: { sent: input.input.text } };
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Fan out',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('correos', { actionId: 'list.action', input: {} }),
        connectorNode('avisar', {
          forEach: '{{nodes.correos.output.messages}}',
          input: { channelId: '#general', text: '{{itemIndex}}: {{item.subject}} de {{item.from}}' },
        }),
      ],
      edges: [{ from: 'correos', to: 'avisar', condition: 'success' }],
    });
    assert.equal(harness.manager.get(workflow.id).nodes[1].forEach, 'nodes.correos.output.messages', 'braces are stripped on save');

    const runSummary = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'succeeded');

    const avisar = finished.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'avisar');
    assert.equal(avisar.output.count, 2);
    assert.deepEqual(avisar.output.items, [{ sent: '0: Factura de a@x.com' }, { sent: '1: Boleta de b@x.com' }]);
    assert.equal(harness.connectorCalls.length, 2);

    const broken = await harness.manager.upsert({
      name: 'Lista invalida',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('correos', { actionId: 'list.action', input: {} }),
        connectorNode('avisar', {
          forEach: 'nodes.correos.output.nope',
          input: { channelId: '#general', text: 'x' },
        }),
      ],
      edges: [{ from: 'correos', to: 'avisar', condition: 'success' }],
    });
    const brokenRun = await harness.manager.runNow(broken.id);
    const brokenResult = await waitFor(async () => {
      const run = await harness.manager.getRun(brokenRun.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(brokenResult.status, 'failed');
    assert.ok(brokenResult.error.startsWith('workflow_foreach_not_a_list'));
  } finally {
    await harness.cleanup();
  }
});

test('forEach stops at the first failing item and reports partial results', async () => {
  let calls = 0;
  const harness = await createManager({
    callConnectorAction: async (input) => {
      if (input.actionId === 'list.action') {
        return { success: true, data: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] } };
      }
      calls += 1;
      return calls === 2
        ? { success: false, technicalCode: 'item_boom' }
        : { success: true, data: { ok: input.input.n } };
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Fan out con falla',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('lista', { actionId: 'list.action', input: {} }),
        connectorNode('proceso', {
          forEach: 'nodes.lista.output.items',
          input: { channelId: '#x', text: 'x', n: '{{item.n}}' },
        }),
      ],
      edges: [{ from: 'lista', to: 'proceso', condition: 'success' }],
    });
    const runSummary = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'failed');
    assert.ok(finished.error.startsWith('workflow_foreach_item_failed:1:item_boom'));
    const proceso = finished.nodeRuns.find((nodeRun) => nodeRun.nodeId === 'proceso');
    assert.equal(proceso.output.failedIndex, 1);
    assert.equal(proceso.output.items.length, 1, 'keeps results of items completed before the failure');
    assert.equal(calls, 2, 'stops at the first failure');
  } finally {
    await harness.cleanup();
  }
});


test('forEach works on condition nodes and sibling loop joins are rejected on upsert', async () => {
  const harness = await createManager({
    callConnectorAction: async (input) => {
      if (input.actionId === 'list.action') {
        return { success: true, data: { items: [{ total: 5 }, { total: 0 }] } };
      }
      harness.connectorCalls.push(input);
      return { success: true, data: { ok: true } };
    },
  });
  try {
    await assert.rejects(
      harness.manager.upsert({
        name: 'Join invalido',
        trigger: { type: 'manual' },
        nodes: [
          connectorNode('root', { actionId: 'list.action', input: {} }),
          connectorNode('a', { forEach: 'nodes.root.output.items' }),
          connectorNode('b', { forEach: 'nodes.root.output.items' }),
          connectorNode('c'),
        ],
        edges: [
          { from: 'root', to: 'a', condition: 'success' },
          { from: 'root', to: 'b', condition: 'success' },
          { from: 'a', to: 'c', condition: 'success' },
          { from: 'b', to: 'c', condition: 'success' },
        ],
      }),
      /workflow_foreach_join_not_allowed/,
    );
    await assert.rejects(
      harness.manager.upsert({
        name: 'ForEach raiz',
        trigger: { type: 'manual' },
        nodes: [connectorNode('root', { forEach: 'nodes.x.output.items' })],
        edges: [],
      }),
      /workflow_foreach_requires_upstream/,
    );

    const workflow = await harness.manager.upsert({
      name: 'Condicion por item',
      trigger: { type: 'manual' },
      nodes: [
        connectorNode('lista', { actionId: 'list.action', input: {} }),
        {
          id: 'todas_positivas',
          name: 'Todas positivas',
          type: 'condition',
          forEach: 'nodes.lista.output.items',
          expression: { left: '{{item.total}}', operator: 'greater_than', right: '0' },
        },
        connectorNode('ok'),
        connectorNode('alerta'),
      ],
      edges: [
        { from: 'lista', to: 'todas_positivas', condition: 'success' },
        { from: 'todas_positivas', to: 'ok', condition: 'success' },
        { from: 'todas_positivas', to: 'alerta', condition: 'error' },
      ],
    });
    const runSummary = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'succeeded');
    const byNode = Object.fromEntries(finished.nodeRuns.map((nodeRun) => [nodeRun.nodeId, nodeRun]));
    assert.equal(byNode.todas_positivas.output.result, false, 'aggregate result is false when any item fails');
    assert.deepEqual(byNode.todas_positivas.output.items, [{ result: true }, { result: false }]);
    assert.equal(byNode.ok.status, 'skipped', 'false aggregate takes the error branch');
    assert.equal(byNode.alerta.status, 'succeeded');
  } finally {
    await harness.cleanup();
  }
});

test('llm node fails cleanly when the provider is not authenticated', async () => {
  const harness = await createManager();
  try {
    const workflow = await harness.manager.upsert({
      name: 'LLM sin auth',
      trigger: { type: 'manual' },
      nodes: [{
        id: 'agente',
        name: 'Agente',
        type: 'llm_agent',
        prompt: 'haz algo',
        toolIds: [],
        appIds: [],
      }],
      edges: [],
    });
    const runSummary = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(runSummary.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });
    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'codex_auth_missing');
  } finally {
    await harness.cleanup();
  }
});

test('llm workflow nodes keep every selected app in the strict runtime, MCP sessions, and prompt', async () => {
  const providerRoot = await mkdtemp(join(tmpdir(), 'forger-workflow-provider-propagation-'));
  const provider = await createRecordingCodexCli(providerRoot);
  const runtimeRequests = [];
  const forgerSessions = [];
  const appMcpListeners = [];

  const strictHarness = await createManager({
    options: {
      getAgentRuntime: async (request) => {
        runtimeRequests.push(request);
        return { provider: 'codex', model: 'gpt-workflow', effort: 'high' };
      },
      getInstalledApps: () => [
        { id: 'sales-app', name: 'Sales', status: 'installed', description: 'Sales workspace' },
        { id: 'inventory-app', name: 'Inventory', status: 'installed', description: 'Inventory workspace' },
      ],
      getCodexCliPath: async () => provider.cliPath,
      getCodexAuthenticated: async () => true,
      createForgerMcpSession: (listenerId, appIds, toolIds, connectionGrants) => {
        forgerSessions.push({ listenerId, appIds, toolIds, connectionGrants });
        return { url: 'http://127.0.0.1:7000/mcp', token: 'forger-token' };
      },
      listenRequiredAppMcps: async (appIds, listenerId) => {
        appMcpListeners.push({ appIds, listenerId });
        return {
          servers: appIds.map((appId, index) => ({
            appId,
            config: {
              name: `app_${appId}`,
              url: `http://127.0.0.1:${7100 + index}/mcp`,
              token: `token-${appId}`,
              tokenEnvVar: `FORGER_APP_MCP_TOKEN_${index}`,
              toolTimeoutSec: 30,
            },
          })),
          failures: [],
        };
      },
    },
  });
  try {
    const workflow = await strictHarness.manager.upsert({
      name: 'Cross-app review',
      trigger: { type: 'manual' },
      nodes: [{
        id: 'review',
        name: 'Review sales and stock',
        type: 'llm_agent',
        prompt: 'Compare both selected apps.',
        runtime: { provider: 'codex', model: 'gpt-workflow', effort: 'high' },
        toolIds: [],
        appIds: ['sales-app', 'inventory-app'],
      }],
      edges: [],
    });

    const queued = await strictHarness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await strictHarness.manager.getRun(queued.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });

    assert.equal(finished.status, 'succeeded');
    assert.deepEqual(runtimeRequests, [{
      provider: 'codex',
      model: 'gpt-workflow',
      effort: 'high',
      strict: true,
    }]);
    assert.equal(forgerSessions.length, 1);
    assert.deepEqual(forgerSessions[0].appIds, ['sales-app', 'inventory-app']);
    assert.equal(appMcpListeners.length, 1);
    assert.deepEqual(appMcpListeners[0].appIds, ['sales-app', 'inventory-app']);
    assert.equal(appMcpListeners[0].listenerId, forgerSessions[0].listenerId);

    const providerCalls = (await readFile(provider.callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].stdin.includes('Sales (id: sales-app)'), true);
    assert.equal(providerCalls[0].stdin.includes('Inventory (id: inventory-app)'), true);
  } finally {
    await strictHarness.cleanup();
    await rm(providerRoot, { recursive: true, force: true });
  }
});

test('a required app MCP failure fails the node before the provider starts', async () => {
  const providerRoot = await mkdtemp(join(tmpdir(), 'forger-workflow-provider-not-started-'));
  const provider = await createRecordingCodexCli(providerRoot);
  const strictMcpCalls = [];
  const harness = await createManager({
    options: {
      getAgentRuntime: async () => ({ provider: 'codex', model: 'gpt-workflow', effort: 'medium' }),
      getInstalledApps: () => [
        { id: 'sales-app', name: 'Sales', status: 'installed' },
        { id: 'broken-app', name: 'Broken', status: 'installed' },
      ],
      getCodexCliPath: async () => provider.cliPath,
      getCodexAuthenticated: async () => true,
      listenRequiredAppMcps: async (appIds, listenerId) => {
        strictMcpCalls.push({ appIds, listenerId });
        return {
          servers: [],
          failures: [{ appId: 'broken-app', code: 'app_mcp_start_failed' }],
        };
      },
    },
  });
  try {
    const workflow = await harness.manager.upsert({
      name: 'Strict app MCP preflight',
      trigger: { type: 'manual' },
      nodes: [{
        id: 'review',
        name: 'Review required apps',
        type: 'llm_agent',
        prompt: 'Review sales with the required companion app.',
        toolIds: [],
        appIds: ['sales-app', 'broken-app'],
      }],
      edges: [],
    });

    const queued = await harness.manager.runNow(workflow.id);
    const finished = await waitFor(async () => {
      const run = await harness.manager.getRun(queued.id);
      return run && ['succeeded', 'failed'].includes(run.status) ? run : null;
    });

    assert.equal(finished.status, 'failed');
    assert.equal(finished.error, 'workflow_required_app_mcp_unavailable');
    assert.equal(finished.nodeRuns[0].error, 'workflow_required_app_mcp_unavailable');
    assert.deepEqual(strictMcpCalls.map((call) => call.appIds), [['sales-app', 'broken-app']]);
    await assert.rejects(access(provider.callsPath), { code: 'ENOENT' });
  } finally {
    await harness.cleanup();
    await rm(providerRoot, { recursive: true, force: true });
  }
});
