import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildReference,
  buildUpstreamFieldSources,
  listSampleFields,
  listSchemaFields,
  listUpstreamNodeIds,
  mergeAvailableFields,
  parseReferencePath,
  stringifyTemplateTokens,
  tokenizeTemplate,
} = require('../../dist-electron/shared/workflow-templates.js');
const { slackToolModule } = require('../../dist-electron/main/tools/slack/index.js');

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

test('buildUpstreamFieldSources combines declared contracts with run samples', () => {
  const slackSendSchema = slackToolModule.definition.actions
    .find((action) => action.id === 'slack.send_message').outputSchema;
  const workflow = {
    nodes: [
      { id: 'cond', name: 'Cond', type: 'condition', expression: { left: 'x', operator: 'is_not_empty' } },
      { id: 'slack', name: 'Slack', type: 'connector', toolId: 'slack', actionId: 'slack.send_message', input: {} },
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
    connectorOutputSchemas: { 'slack.send_message': slackSendSchema },
  });
  const bySourceId = Object.fromEntries(sources.map((source) => [source.node.id, source]));

  assert.deepEqual(Object.keys(bySourceId).sort(), ['agente', 'cond', 'slack']);
  assert.ok(bySourceId.cond.fields.some((field) => field.path === 'result'), 'condition exposes result');
  assert.ok(bySourceId.slack.fields.some((field) => field.path === 'ts'), 'connector exposes declared schema');
  const agentFields = Object.fromEntries(bySourceId.agente.fields.map((field) => [field.path, field]));
  assert.equal(agentFields.resumen.sample, 'hola', 'agent exposes sampled output');
  assert.ok('text' in agentFields, 'agent keeps fallback text contract');
});
