import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildRunContext,
  computeRunOutcome,
  edgeTaken,
  evaluateConditionExpression,
  isFailureHandled,
  lookupContextPath,
  renderTemplateString,
  resolveNodeReadiness,
  resolveTemplateValue,
  topologicalOrder,
  validateWorkflowGraph,
} = require('../../dist-electron/main/workflow/engine.js');
const {
  sanitizeWorkflowNode,
  sanitizeWorkflowEdges,
  sanitizeWorkflowTrigger,
  sanitizeWorkflowUpsertInput,
} = require('../../dist-electron/main/workflow/sanitize.js');
const { validateOutputAgainstSchema } = require('../../dist-electron/main/workflow/output-schema.js');

const llmNode = (id, overrides = {}) => ({
  id,
  name: `Nodo ${id}`,
  type: 'llm_agent',
  prompt: 'haz algo',
  toolIds: [],
  appIds: [],
  ...overrides,
});

const conditionNode = (id, expression) => ({
  id,
  name: `Cond ${id}`,
  type: 'condition',
  expression,
});

test('validateWorkflowGraph rejects cycles, duplicates and unknown edge nodes', () => {
  assert.throws(() => validateWorkflowGraph([], []), /workflow_nodes_required/);
  assert.throws(
    () => validateWorkflowGraph([llmNode('a'), llmNode('a')], []),
    /workflow_node_id_duplicated/,
  );
  assert.throws(
    () => validateWorkflowGraph([llmNode('a')], [{ from: 'a', to: 'b', condition: 'success' }]),
    /workflow_edge_unknown_node/,
  );
  assert.throws(
    () => validateWorkflowGraph([llmNode('a'), llmNode('b')], [
      { from: 'a', to: 'b', condition: 'success' },
      { from: 'b', to: 'a', condition: 'success' },
    ]),
    /workflow_graph_has_cycle/,
  );
  assert.doesNotThrow(() => validateWorkflowGraph([llmNode('a'), llmNode('b')], [
    { from: 'a', to: 'b', condition: 'success' },
  ]));
});

test('topologicalOrder sorts nodes respecting edges', () => {
  const order = topologicalOrder(
    [llmNode('c'), llmNode('a'), llmNode('b')],
    [
      { from: 'a', to: 'b', condition: 'success' },
      { from: 'b', to: 'c', condition: 'success' },
    ],
  );
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('edgeTaken maps success/error edges and condition branches', () => {
  const plain = llmNode('a');
  const succeeded = { status: 'succeeded' };
  const failed = { status: 'failed' };
  assert.equal(edgeTaken({ from: 'a', to: 'b', condition: 'success' }, plain, succeeded), true);
  assert.equal(edgeTaken({ from: 'a', to: 'b', condition: 'success' }, plain, failed), false);
  assert.equal(edgeTaken({ from: 'a', to: 'b', condition: 'error' }, plain, failed), true);
  assert.equal(edgeTaken({ from: 'a', to: 'b', condition: 'always' }, plain, failed), true);
  assert.equal(edgeTaken({ from: 'a', to: 'b', condition: 'always' }, plain, { status: 'skipped' }), false);
  assert.equal(edgeTaken({ from: 'a', to: 'b', condition: 'success' }, plain, { status: 'running' }), false);

  const condition = conditionNode('c', { left: 'x', operator: 'is_not_empty' });
  const truthy = { status: 'succeeded', output: { result: true } };
  const falsy = { status: 'succeeded', output: { result: false } };
  assert.equal(edgeTaken({ from: 'c', to: 'b', condition: 'success' }, condition, truthy), true);
  assert.equal(edgeTaken({ from: 'c', to: 'b', condition: 'success' }, condition, falsy), false);
  assert.equal(edgeTaken({ from: 'c', to: 'b', condition: 'error' }, condition, falsy), true);
  assert.equal(edgeTaken({ from: 'c', to: 'b', condition: 'error' }, condition, truthy), false);
});

test('resolveNodeReadiness starts roots, waits for sources and skips dead branches', () => {
  const nodes = [llmNode('a'), llmNode('ok'), llmNode('err')];
  const edges = [
    { from: 'a', to: 'ok', condition: 'success' },
    { from: 'a', to: 'err', condition: 'error' },
  ];

  let readiness = resolveNodeReadiness(nodes, edges, {
    a: { status: 'pending' },
    ok: { status: 'pending' },
    err: { status: 'pending' },
  });
  assert.deepEqual(readiness, { ready: ['a'], skipped: [] });

  readiness = resolveNodeReadiness(nodes, edges, {
    a: { status: 'succeeded' },
    ok: { status: 'pending' },
    err: { status: 'pending' },
  });
  assert.deepEqual(readiness.ready, ['ok']);
  assert.deepEqual(readiness.skipped, ['err']);

  readiness = resolveNodeReadiness(nodes, edges, {
    a: { status: 'running' },
    ok: { status: 'pending' },
    err: { status: 'pending' },
  });
  assert.deepEqual(readiness, { ready: [], skipped: [] });
});

test('computeRunOutcome fails on unhandled node failure and succeeds when handled', () => {
  const nodes = [llmNode('a'), llmNode('b')];
  const handledEdges = [{ from: 'a', to: 'b', condition: 'error' }];
  assert.equal(isFailureHandled('a', handledEdges), true);
  assert.deepEqual(
    computeRunOutcome(nodes, handledEdges, {
      a: { status: 'failed', error: 'boom' },
      b: { status: 'succeeded' },
    }).status,
    'succeeded',
  );
  const outcome = computeRunOutcome(nodes, [], {
    a: { status: 'failed', error: 'boom' },
    b: { status: 'skipped' },
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'boom');
  assert.equal(
    computeRunOutcome(nodes, [], { a: { status: 'canceled' }, b: { status: 'skipped' } }).status,
    'canceled',
  );
});

test('template resolution reads node outputs and preserves raw types for exact matches', () => {
  const context = buildRunContext(
    { type: 'manual' },
    {
      buscar: { status: 'succeeded', output: { total: 42, items: [{ name: 'uno' }] } },
    },
  );
  assert.equal(lookupContextPath(context, 'nodes.buscar.output.total'), 42);
  assert.equal(lookupContextPath(context, 'nodes.buscar.output.items.0.name'), 'uno');
  assert.equal(lookupContextPath(context, 'nodes.missing.output'), undefined);
  assert.equal(renderTemplateString('total: {{nodes.buscar.output.total}}', context), 'total: 42');
  assert.equal(resolveTemplateValue('{{nodes.buscar.output.total}}', context), 42);
  assert.deepEqual(
    resolveTemplateValue({ count: '{{nodes.buscar.output.total}}', text: 'hay {{nodes.buscar.output.total}}' }, context),
    { count: 42, text: 'hay 42' },
  );
});

test('evaluateConditionExpression covers operators', () => {
  const context = buildRunContext({}, {
    a: { status: 'succeeded', output: { total: 10, name: 'Informe Mensual', empty: '' } },
  });
  const evaluate = (operator, left, right) =>
    evaluateConditionExpression({ left, operator, ...(right !== undefined ? { right } : {}) }, context);

  assert.equal(evaluate('equals', '{{nodes.a.output.total}}', '10'), true);
  assert.equal(evaluate('not_equals', '{{nodes.a.output.total}}', '11'), true);
  assert.equal(evaluate('contains', '{{nodes.a.output.name}}', 'mensual'), true);
  assert.equal(evaluate('not_contains', '{{nodes.a.output.name}}', 'anual'), true);
  assert.equal(evaluate('greater_than', '{{nodes.a.output.total}}', '5'), true);
  assert.equal(evaluate('less_than', '{{nodes.a.output.total}}', '5'), false);
  assert.equal(evaluate('is_empty', '{{nodes.a.output.empty}}'), true);
  assert.equal(evaluate('is_not_empty', '{{nodes.a.output.name}}'), true);
  assert.equal(evaluate('greater_than', '{{nodes.a.output.name}}', '5'), false);
});

test('validateOutputAgainstSchema checks required properties and types', () => {
  const schema = {
    type: 'object',
    required: ['total', 'items'],
    properties: {
      total: { type: 'number' },
      items: { type: 'array', items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
    },
  };
  assert.deepEqual(validateOutputAgainstSchema({ total: 3, items: [{ name: 'x' }] }, schema), []);
  assert.ok(validateOutputAgainstSchema({ items: 'nope' }, schema).length >= 2);
  assert.ok(validateOutputAgainstSchema('texto', schema).length === 1);
});

test('sanitizeWorkflowNode normalizes node payloads and rejects invalid ones', () => {
  assert.equal(sanitizeWorkflowNode(null), null);
  assert.equal(sanitizeWorkflowNode({ id: 'a', name: 'X', type: 'llm_agent', prompt: '' }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'mal id!', name: 'X', type: 'condition' }), null);

  const node = sanitizeWorkflowNode({
    id: 'paso1',
    name: '  Buscar  ',
    type: 'llm_agent',
    prompt: 'busca',
    toolIds: ['slack.send_message', 'nope', 'slack.send_message'],
    appIds: ['finance-os', '../evil'],
    requiresApproval: true,
    timeoutMs: 1,
    position: { x: 10, y: 20 },
  }, new Set(['slack.send_message']));
  assert.equal(node.name, 'Buscar');
  assert.deepEqual(node.toolIds, ['slack.send_message']);
  assert.deepEqual(node.appIds, ['finance-os']);
  assert.equal(node.requiresApproval, true);
  assert.equal(node.timeoutMs, 10_000);
  assert.deepEqual(node.position, { x: 10, y: 20 });

  const connector = sanitizeWorkflowNode({
    id: 'con1',
    name: 'Slack',
    type: 'connector',
    toolId: 'slack',
    actionId: 'slack.send_message',
    input: { channelId: '#general' },
  });
  assert.equal(connector.type, 'connector');
  assert.deepEqual(connector.input, { channelId: '#general' });

  const condition = sanitizeWorkflowNode({
    id: 'cond1',
    name: 'Hay datos',
    type: 'condition',
    expression: { left: '{{nodes.con1.output}}', operator: 'sin_sentido' },
  });
  assert.equal(condition.expression.operator, 'is_not_empty');
});

test('sanitizeWorkflowEdges drops invalid, duplicated and self edges', () => {
  const edges = sanitizeWorkflowEdges([
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'a', to: 'b', condition: 'error' },
    { from: 'a', to: 'a', condition: 'success' },
    { from: 'a', to: 'zz', condition: 'success' },
    { from: 'a', to: 'b', condition: 'whatever' },
  ], new Set(['a', 'b']));
  assert.deepEqual(edges, [
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'a', to: 'b', condition: 'error' },
  ]);
});

test('sanitizeWorkflowTrigger defaults to manual and normalizes schedules', () => {
  assert.deepEqual(sanitizeWorkflowTrigger(undefined), { type: 'manual' });
  const scheduled = sanitizeWorkflowTrigger({
    type: 'scheduled',
    frequency: { type: 'daily', timeOfDay: 'nonsense' },
    missedRunPolicy: 'always',
    missedRunWindowMinutes: 15,
  });
  assert.equal(scheduled.type, 'scheduled');
  assert.deepEqual(scheduled.frequency, { type: 'daily', timeOfDay: '09:00' });
  assert.deepEqual(
    sanitizeWorkflowTrigger({ type: 'scheduled', frequency: { type: 'daily', timeOfDay: '99:99' } }).frequency,
    { type: 'daily', timeOfDay: '23:59' },
  );
  assert.equal(scheduled.missedRunPolicy, 'always');
  assert.equal(scheduled.missedRunWindowMinutes, 15);
});

test('sanitizeWorkflowUpsertInput keeps only edges between surviving nodes', () => {
  const input = sanitizeWorkflowUpsertInput({
    name: ' Flujo ',
    description: 'desc',
    trigger: { type: 'manual' },
    nodes: [
      llmNode('a'),
      { id: 'broken', name: 'x', type: 'llm_agent', prompt: '' },
    ],
    edges: [
      { from: 'a', to: 'broken', condition: 'success' },
    ],
  });
  assert.equal(input.name, 'Flujo');
  assert.equal(input.nodes.length, 1);
  assert.deepEqual(input.edges, []);
});
