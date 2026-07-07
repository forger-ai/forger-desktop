import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildReference,
  findForEachJoinConflict,
  buildUpstreamFieldSources,
  listSampleFields,
  listSchemaFields,
  listUpstreamNodeIds,
  mergeAvailableFields,
  parseReferencePath,
  stringifyTemplateTokens,
  tokenizeTemplate,
} = require('../../dist-electron/shared/workflow-templates.js');
const { slackToolModule } = require('../../dist-electron/main/connections/modules/slack/index.js');

test('tokenizeTemplate splits text and references and round-trips', () => {
  const value = 'Hay {{nodes.buscar.output.total}} pendientes en {{trigger.type}}.';
  const tokens = tokenizeTemplate(value);
  assert.deepEqual(tokens, [
    { type: 'text', value: 'Hay ' },
    { type: 'reference', path: 'nodes.buscar.output.total' },
    { type: 'text', value: ' pendientes en ' },
    { type: 'reference', path: 'trigger.type' },
    { type: 'text', value: '.' },
  ]);
  assert.equal(stringifyTemplateTokens(tokens), value);
  assert.deepEqual(tokenizeTemplate('sin referencias'), [{ type: 'text', value: 'sin referencias' }]);
  assert.deepEqual(tokenizeTemplate('{{nodes.a.output}}'), [{ type: 'reference', path: 'nodes.a.output' }]);
});

test('parseReferencePath and buildReference are symmetric', () => {
  assert.deepEqual(parseReferencePath('nodes.paso1.output.total'), {
    kind: 'node',
    nodeId: 'paso1',
    fieldPath: 'total',
  });
  assert.deepEqual(parseReferencePath('nodes.paso1.output'), {
    kind: 'node',
    nodeId: 'paso1',
    fieldPath: undefined,
  });
  assert.deepEqual(parseReferencePath('trigger.type'), { kind: 'trigger', fieldPath: 'type' });
  assert.equal(parseReferencePath('whatever'), null);
  assert.equal(buildReference('paso1', 'total'), 'nodes.paso1.output.total');
  assert.equal(buildReference('paso1'), 'nodes.paso1.output');
});

test('listSchemaFields flattens nested object and array schemas', () => {
  const schema = {
    type: 'object',
    properties: {
      channels: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
        },
      },
      total: { type: 'number' },
    },
  };
  const paths = listSchemaFields(schema).map((field) => field.path);
  assert.ok(paths.includes('channels'));
  assert.ok(paths.includes('channels.0.id'));
  assert.ok(paths.includes('channels.0.name'));
  assert.ok(paths.includes('total'));
});

test('listSampleFields infers fields with samples from run outputs', () => {
  const fields = listSampleFields({ total: 4, items: [{ name: 'uno' }], meta: { ok: true } });
  const byPath = Object.fromEntries(fields.map((field) => [field.path, field]));
  assert.equal(byPath.total.sample, 4);
  assert.equal(byPath['items.0.name'].sample, 'uno');
  assert.equal(byPath['meta.ok'].sample, true);
  assert.equal(byPath.items.type, 'array');
});

test('mergeAvailableFields keeps samples while schema wins on type', () => {
  const merged = mergeAvailableFields(
    [{ path: 'total', type: 'number' }],
    [{ path: 'total', type: 'string', sample: '4' }, { path: 'extra', type: 'string', sample: 'x' }],
  );
  const byPath = Object.fromEntries(merged.map((field) => [field.path, field]));
  assert.equal(byPath.total.type, 'number');
  assert.equal(byPath.total.sample, '4');
  assert.equal(byPath.extra.sample, 'x');
});

test('listUpstreamNodeIds returns transitive ancestors in node order', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'aislado' }];
  const edges = [
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'b', to: 'c', condition: 'success' },
  ];
  assert.deepEqual(listUpstreamNodeIds(nodes, edges, 'c'), ['a', 'b']);
  assert.deepEqual(listUpstreamNodeIds(nodes, edges, 'a'), []);
  assert.deepEqual(listUpstreamNodeIds(nodes, edges, 'aislado'), []);
});



test('reference parsing and field listing edge cases', () => {
  assert.deepEqual(parseReferencePath('trigger'), { kind: 'trigger', fieldPath: undefined });
  assert.deepEqual(parseReferencePath('nodes.a'), { kind: 'node', nodeId: 'a', fieldPath: undefined });
  assert.deepEqual(parseReferencePath('nodes.a.campo.sub'), { kind: 'node', nodeId: 'a', fieldPath: 'campo.sub' });
  assert.deepEqual(parseReferencePath('nodes.'), null);

  assert.deepEqual(listSchemaFields({ type: 'string' }), [], 'scalar schemas expose no fields');
  assert.deepEqual(listSchemaFields({ type: 'object', properties: 'nope' }), []);
  const deep = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'string' } } } } } } } } } } };
  const deepPaths = listSchemaFields(deep).map((field) => field.path);
  assert.ok(deepPaths.includes('a.b.c'), 'nested fields are listed');
  assert.ok(!deepPaths.some((path) => path.split('.').length > 5), 'depth is capped');
  const arrayRoot = listSchemaFields({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } });
  assert.deepEqual(arrayRoot.map((field) => field.path), ['0.id']);
  const skipped = listSchemaFields({ type: 'object', properties: { ok: { type: 'string' }, bad: null } });
  assert.deepEqual(skipped.map((field) => field.path), ['ok']);

  assert.deepEqual(listSampleFields([]), []);
  assert.deepEqual(listSampleFields('texto'), []);
  assert.deepEqual(listSampleFields(null), []);
  const deepSample = listSampleFields({ a: { b: { c: { d: { e: { f: 1 } } } } } }).map((field) => field.path);
  assert.ok(!deepSample.some((path) => path.split('.').length > 5), 'sample depth is capped');
});

test('findForEachJoinConflict rejects sibling loops joining and allows nested or single loops', () => {
  const nodes = (forEachIds) => [
    { id: 'root' },
    { id: 'a', forEach: forEachIds.includes('a') ? 'nodes.root.output.items' : undefined },
    { id: 'b', forEach: forEachIds.includes('b') ? 'nodes.root.output.items' : undefined },
    { id: 'c' },
  ];
  const siblingEdges = [
    { from: 'root', to: 'a', condition: 'success' },
    { from: 'root', to: 'b', condition: 'success' },
    { from: 'a', to: 'c', condition: 'success' },
    { from: 'b', to: 'c', condition: 'success' },
  ];

  // A and B are sibling loops feeding C: conflict.
  const conflict = findForEachJoinConflict(nodes(['a', 'b']), siblingEdges);
  assert.equal(conflict.nodeId, 'c');
  assert.deepEqual([...conflict.parents].sort(), ['a', 'b']);

  // Only A iterates: joining A and plain B into C is fine.
  assert.equal(findForEachJoinConflict(nodes(['a']), siblingEdges), null);

  // Nested loops: A -> B -> C where both iterate is a chain, not a join.
  const nestedEdges = [
    { from: 'root', to: 'a', condition: 'success' },
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'b', to: 'c', condition: 'success' },
  ];
  assert.equal(findForEachJoinConflict(nodes(['a', 'b']), nestedEdges), null);

  // C fed by both A and its nested loop B: allowed because A reaches B.
  const diamondNested = [
    { from: 'root', to: 'a', condition: 'success' },
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'a', to: 'c', condition: 'success' },
    { from: 'b', to: 'c', condition: 'success' },
  ];
  assert.equal(findForEachJoinConflict(nodes(['a', 'b']), diamondNested), null);
});


test('field listings cap at the per-node maximum and diamond graphs dedupe ancestors', () => {
  const manyProps = Object.fromEntries(Array.from({ length: 60 }, (_v, i) => [`campo${i}`, { type: 'string' }]));
  assert.equal(listSchemaFields({ type: 'object', properties: manyProps }).length, 40);
  const manySample = Object.fromEntries(Array.from({ length: 60 }, (_v, i) => [`s${i}`, i]));
  assert.equal(listSampleFields(manySample).length, 40);

  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const diamond = [
    { from: 'a', to: 'b', condition: 'success' },
    { from: 'a', to: 'c', condition: 'success' },
    { from: 'b', to: 'd', condition: 'success' },
    { from: 'c', to: 'd', condition: 'success' },
  ];
  assert.deepEqual(listUpstreamNodeIds(nodes, diamond, 'd'), ['a', 'b', 'c']);
});

test('buildUpstreamFieldSources combines declared contracts with run samples', () => {
  const slackSendSchema = slackToolModule.definition.actions
    .find((action) => action.id === 'slack.send_message').outputSchema;
  const workflow = {
    nodes: [
      { id: 'cond', name: 'Cond', type: 'condition', expression: { left: 'x', operator: 'is_not_empty' } },
      { id: 'slack', name: 'Slack', type: 'connection', connectionType: 'slack', actionId: 'slack.send_message', input: {} },
      { id: 'agente', name: 'Agente', type: 'llm_agent', prompt: 'p', toolIds: [], appIds: [] },
      { id: 'final', name: 'Final', type: 'llm_agent', prompt: 'p', toolIds: [], appIds: [] },
    ],
    edges: [
      { from: 'cond', to: 'slack', condition: 'success' },
      { from: 'slack', to: 'agente', condition: 'success' },
      { from: 'agente', to: 'final', condition: 'success' },
    ],
  };
  const sources = buildUpstreamFieldSources(workflow, 'final', {
    outputSamples: { agente: { resumen: 'hola' } },
    connectionOutputSchemas: { 'slack.send_message': slackSendSchema },
  });
  const bySourceId = Object.fromEntries(sources.map((source) => [source.node.id, source]));

  assert.deepEqual(Object.keys(bySourceId).sort(), ['agente', 'cond', 'slack']);
  assert.ok(bySourceId.cond.fields.some((field) => field.path === 'result'), 'condition exposes result');
  assert.ok(bySourceId.slack.fields.some((field) => field.path === 'ts'), 'connection exposes declared schema');
  const agentFields = Object.fromEntries(bySourceId.agente.fields.map((field) => [field.path, field]));
  assert.equal(agentFields.resumen.sample, 'hola', 'agent exposes sampled output');
  assert.ok('text' in agentFields, 'agent keeps fallback text contract');
});
