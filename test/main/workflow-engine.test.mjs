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
  summarizeWorkflow,
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


test('validateWorkflowGraph enforces forEach placement rules', () => {
  const forEachNode = (id, extra = {}) => llmNode(id, { forEach: 'nodes.root.output.items', ...extra });

  assert.throws(
    () => validateWorkflowGraph([forEachNode('solo')], []),
    /workflow_foreach_requires_upstream/,
  );

  const nodes = [llmNode('root'), forEachNode('a'), forEachNode('b'), llmNode('c')];
  assert.throws(
    () => validateWorkflowGraph(nodes, [
      { from: 'root', to: 'a', condition: 'success' },
      { from: 'root', to: 'b', condition: 'success' },
      { from: 'a', to: 'c', condition: 'success' },
      { from: 'b', to: 'c', condition: 'success' },
    ]),
    /workflow_foreach_join_not_allowed/,
  );

  assert.doesNotThrow(() => validateWorkflowGraph(nodes, [
    { from: 'root', to: 'a', condition: 'success' },
    { from: 'root', to: 'b', condition: 'success' },
    { from: 'a', to: 'c', condition: 'success' },
  ]));

  assert.doesNotThrow(() => validateWorkflowGraph(nodes, [
    { from: 'root', to: 'a', condition: 'success' },
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'b', to: 'c', condition: 'success' },
  ]), 'nested loops are allowed');
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

test('computeRunOutcome fails on unhandled node failure and reports handled incidents', () => {
  const nodes = [llmNode('a'), llmNode('b')];
  const handledEdges = [{ from: 'a', to: 'b', condition: 'error' }];
  assert.equal(isFailureHandled('a', handledEdges), true);
  assert.deepEqual(
    computeRunOutcome(nodes, handledEdges, {
      a: { status: 'failed', error: 'boom' },
      b: { status: 'succeeded' },
    }).status,
    'completed_with_issues',
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
    connectionGrants: [{ type: 'gmail', actions: ['gmail.search_messages'], multiple: true }],
    appIds: ['finance-os', '../evil'],
    requiresApproval: true,
    timeoutMs: 1,
    position: { x: 10, y: 20 },
  }, new Set(['slack.send_message']));
  assert.equal(node.name, 'Buscar');
  assert.deepEqual(node.toolIds, ['slack.send_message']);
  assert.deepEqual(node.connectionGrants, [{ type: 'gmail', actions: ['gmail.search_messages'], multiple: true }]);
  assert.deepEqual(node.appIds, ['finance-os']);
  assert.equal(node.requiresApproval, true);
  assert.equal(node.timeoutMs, 10_000);
  assert.deepEqual(node.position, { x: 10, y: 20 });

  const connection = sanitizeWorkflowNode({
    id: 'con1',
    name: 'Slack',
    type: 'connector',
    toolId: 'slack',
    actionId: 'slack.send_message',
    input: { channelId: '#general' },
  });
  assert.equal(connection.type, 'connection');
  assert.equal(connection.connectionType, 'slack');
  assert.deepEqual(connection.input, { channelId: '#general' });

  const forgerTool = sanitizeWorkflowNode({
    id: 'tool1',
    name: 'Refresh',
    type: 'connector',
    toolId: 'forger',
    actionId: 'forger_refresh_app_view',
    input: { appId: 'finance-os' },
  }, new Set(['forger_refresh_app_view']));
  assert.equal(forgerTool.type, 'forger_tool');
  assert.equal(forgerTool.toolId, 'forger_refresh_app_view');

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


test('validateWorkflowGraph rejects oversized graphs and blank node ids', () => {
  const many = Array.from({ length: 31 }, (_value, index) => llmNode(`n${index}`));
  assert.throws(() => validateWorkflowGraph(many, []), /workflow_too_many_nodes/);
  assert.throws(() => validateWorkflowGraph([llmNode('   ')], []), /workflow_node_id_required/);
});

test('template helpers handle primitives, circular values, and unknown operators', () => {
  const circular = { total: 3 };
  circular.self = circular;
  const context = buildRunContext({ ok: true, count: 2 }, {
    a: { status: 'succeeded', output: { total: 42, flag: false, circular } },
  });

  assert.equal(lookupContextPath(context, 'nodes.a.output.total.deeper'), undefined, 'primitives stop the walk');
  assert.equal(renderTemplateString('v={{trigger.count}} f={{nodes.a.output.flag}}', context), 'v=2 f=false');
  assert.equal(renderTemplateString('c={{nodes.a.output.circular}}', context), 'c=', 'circular values stringify to empty');
  assert.equal(resolveTemplateValue(null, context), null);
  assert.equal(resolveTemplateValue(7, context), 7);
  assert.deepEqual(resolveTemplateValue(['{{nodes.a.output.total}}'], context), [42]);
  assert.equal(evaluateConditionExpression({ left: 'x', operator: 'operador_falso' }, context), false);
  assert.equal(evaluateConditionExpression({ left: '{{trigger.count}}', operator: 'greater_than', right: '   ' }, context), false);
  assert.equal(evaluateConditionExpression({ left: '{{nodes.a.output.missing}}', operator: 'is_empty' }, context), true);
  assert.equal(evaluateConditionExpression({ left: '{{trigger.count}}', operator: 'is_empty' }, context), false);
});

test('validateOutputAgainstSchema reports scalar and array item mismatches', () => {
  assert.deepEqual(
    validateOutputAgainstSchema([1, 'dos'], { type: 'array', items: { type: 'string' } }),
    ['output[0] debe ser texto'],
  );
  assert.deepEqual(validateOutputAgainstSchema('x', { type: 'number' }), ['output debe ser un numero']);
  assert.deepEqual(validateOutputAgainstSchema(1, { type: 'boolean' }), ['output debe ser booleano']);
  assert.deepEqual(validateOutputAgainstSchema(1, { type: 'string' }), ['output debe ser texto']);
  assert.deepEqual(validateOutputAgainstSchema({ any: 1 }, { description: 'sin tipo' }), []);
});

test('sanitize helpers normalize hostile node shapes', () => {
  assert.equal(sanitizeWorkflowNode({ id: 'a', name: null, type: 'condition' }), null, 'missing name');
  assert.equal(sanitizeWorkflowNode({ id: 'a', name: 'A', type: 'tipo_falso' }), null, 'unknown type');
  assert.equal(sanitizeWorkflowNode({ id: 'a', name: 'A', type: 'forger_agent', agentId: '', prompt: 'x' }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'a', name: 'A', type: 'connector', toolId: 't', actionId: '' }), null);

  const agentNode = sanitizeWorkflowNode({
    id: 'a',
    name: 'A',
    type: 'forger_agent',
    agentId: 'agente-1',
    prompt: 'revisa',
    outputSchema: { type: 'object' },
    position: { x: 'no', y: 2 },
    timeoutMs: 10 ** 9,
  });
  assert.equal(agentNode.agentId, 'agente-1');
  assert.deepEqual(agentNode.outputSchema, { type: 'object' });
  assert.equal(agentNode.position, undefined, 'invalid positions are dropped');
  assert.equal(agentNode.timeoutMs, 30 * 60_000, 'timeouts clamp to the maximum');

  const llm = sanitizeWorkflowNode({
    id: 'b',
    name: 'B',
    type: 'llm_agent',
    prompt: 'x',
    toolIds: 'no-es-lista',
    appIds: 'tampoco',
    outputSchema: ['no-objeto'],
  });
  assert.deepEqual(llm.toolIds, []);
  assert.deepEqual(llm.appIds, []);
  assert.equal(llm.outputSchema, undefined);

  const condition = sanitizeWorkflowNode({ id: 'c', name: 'C', type: 'condition' });
  assert.deepEqual(condition.expression, { left: '', operator: 'is_not_empty' });
  const emptyDrop = sanitizeWorkflowNode({
    id: 'd',
    name: 'D',
    type: 'condition',
    expression: { left: 'x', operator: 'is_empty', right: 'se-ignora' },
  });
  assert.equal(emptyDrop.expression.right, undefined, 'is_empty drops the comparison value');
});

test('sanitizeWorkflowTrigger covers weekly normalization and window clamps', () => {
  const weekly = sanitizeWorkflowTrigger({
    type: 'scheduled',
    frequency: { type: 'weekly', timeOfDay: '18:30', weeklyDay: 99 },
    missedRunWindowMinutes: 10 ** 9,
  });
  assert.deepEqual(weekly.frequency, { type: 'weekly', timeOfDay: '18:30', weeklyDay: 6 });
  assert.equal(weekly.missedRunWindowMinutes, 30 * 24 * 60);
  const badDay = sanitizeWorkflowTrigger({ type: 'scheduled', frequency: { type: 'weekly', weeklyDay: 'martes' } });
  assert.equal(badDay.frequency.weeklyDay, 1, 'non-numeric weekdays default to Monday');
  const noWindow = sanitizeWorkflowTrigger({ type: 'scheduled', frequency: { type: 'hourly' }, missedRunWindowMinutes: 0 });
  assert.equal(noWindow.missedRunWindowMinutes, undefined);
});


test('remaining engine and sanitize micro-branches', () => {
  assert.throws(
    () => validateWorkflowGraph([llmNode('a')], [{ from: 'a', to: 'a', condition: 'success' }]),
    /workflow_edge_self_reference/,
  );

  const context = buildRunContext({}, {
    a: { status: 'succeeded', output: { name: 'Informe', lista: [], objeto: {}, llena: [1] } },
  });
  assert.equal(renderTemplateString('hola {{nodes.a.output.name}}', context), 'hola Informe');
  assert.equal(renderTemplateString('x={{nodes.fantasma.output.y}}!', context), 'x=!', 'missing paths render empty');
  assert.equal(evaluateConditionExpression({ left: '{{nodes.a.output.lista}}', operator: 'is_empty' }, context), true);
  assert.equal(evaluateConditionExpression({ left: '{{nodes.a.output.objeto}}', operator: 'is_empty' }, context), true);
  assert.equal(evaluateConditionExpression({ left: '{{nodes.a.output.llena}}', operator: 'is_not_empty' }, context), true);

  assert.match(summarizeWorkflow({ name: 'Demo', nodes: [llmNode('a')], edges: [] }), /Demo \(1 nodos, 0 conexiones\)/);

  assert.deepEqual(sanitizeWorkflowEdges('no-lista', new Set(['a'])), []);
  assert.deepEqual(sanitizeWorkflowEdges([null, 'texto', 42], new Set(['a'])), []);
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
