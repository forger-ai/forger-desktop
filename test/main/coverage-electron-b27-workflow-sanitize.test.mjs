import assert from 'node:assert/strict';
import test from 'node:test';

const {
  sanitizeText,
  sanitizeWorkflowEdges,
  sanitizeWorkflowFrequency,
  sanitizeWorkflowNode,
  sanitizeWorkflowTrigger,
  sanitizeWorkflowUpsertInput,
} = await import('../../dist-electron/main/workflow/sanitize.js');

const llmNode = (overrides = {}) => ({ id: 'llm', name: 'LLM', type: 'llm_agent', prompt: 'Work', ...overrides });

test('workflow node sanitization rejects hostile envelopes and normalizes optional execution controls', () => {
  assert.equal(sanitizeText('  abcdef  ', 3), 'abc');
  assert.equal(sanitizeText(7, 3), '');
  for (const value of [false, 'node', []]) assert.equal(sanitizeWorkflowNode(value), null);

  const normalized = sanitizeWorkflowNode(llmNode({
    runtime: { provider: 'claude', model: 'claude-sonnet-5' },
    position: { x: -1, y: 2 },
    timeoutMs: '12500.6',
    forEach: '{{ items }}',
    toolIds: [null, '', 'tool-a', 'tool-a'],
    appIds: [null, ' app-a ', 'bad id', 'app-a'],
    connectionGrants: [
      null,
      [],
      'bad',
      { type: '', actions: ['x'] },
      { type: 'gmail', actions: 'bad' },
      { type: 'gmail', actions: ['', 'search', 'search'], connectionIds: ['', 'one', 'one'], multiple: false },
    ],
    outputSchema: { type: 'object' },
  }));
  assert.equal(normalized.runtime.provider, 'claude');
  assert.deepEqual(normalized.position, { x: -1, y: 2 });
  assert.equal(normalized.timeoutMs, 12_501);
  assert.equal(normalized.forEach, 'items');
  assert.deepEqual(normalized.toolIds, ['tool-a']);
  assert.deepEqual(normalized.appIds, ['app-a']);
  assert.deepEqual(normalized.connectionGrants, [{ type: 'gmail', actions: ['search'], multiple: false, connectionIds: ['one'] }]);
  assert.deepEqual(normalized.outputSchema, { type: 'object' });

  for (const timeoutMs of [Number.NaN, 0, -1, 'invalid']) {
    assert.equal(sanitizeWorkflowNode(llmNode({ timeoutMs })).timeoutMs, undefined);
  }
  for (const position of [null, [], { x: Number.NaN, y: 1 }, { x: 1, y: Number.POSITIVE_INFINITY }]) {
    assert.equal(sanitizeWorkflowNode(llmNode({ position })).position, undefined);
  }
});

test('workflow node variants enforce schemas, tool allowlists, and connector migration', () => {
  assert.equal(sanitizeWorkflowNode(llmNode({ runtime: 'unknown', outputSchema: 1 })).runtime, undefined);
  assert.deepEqual(sanitizeWorkflowNode(llmNode({ toolIds: ['one', 'two'] }), undefined).toolIds, ['one', 'two']);

  assert.equal(sanitizeWorkflowNode({ id: 'a', name: 'A', type: 'forger_agent', agentId: 'agent', prompt: '' }), null);
  const agent = sanitizeWorkflowNode({ id: 'a', name: 'A', type: 'forger_agent', agentId: 'agent', prompt: 'go', outputSchema: null });
  assert.equal(agent.outputSchema, undefined);

  assert.equal(sanitizeWorkflowNode({ id: 't', name: 'T', type: 'forger_tool', toolId: '', input: {} }), null);
  assert.equal(sanitizeWorkflowNode({ id: 't', name: 'T', type: 'forger_tool', toolId: 'blocked', input: {} }, new Set(['allowed'])), null);
  assert.deepEqual(
    sanitizeWorkflowNode({ id: 't', name: 'T', type: 'forger_tool', toolId: 'allowed', input: [] }, new Set(['allowed'])).input,
    {},
  );

  assert.equal(sanitizeWorkflowNode({ id: 'c', name: 'C', type: 'connection', connectionType: '', actionId: 'a' }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'c', name: 'C', type: 'connection', connectionType: 'gmail', actionId: '' }), null);
  const connection = sanitizeWorkflowNode({
    id: 'c', name: 'C', type: 'connection', connectionType: 'gmail', actionId: 'gmail.search_messages', connectionId: '', input: 'bad',
  });
  assert.equal(connection.connectionId, undefined);
  assert.deepEqual(connection.input, {});

  assert.equal(sanitizeWorkflowNode({ id: 'x', name: 'X', type: 'connector', toolId: '', actionId: 'a' }), null);
  assert.equal(sanitizeWorkflowNode({ id: 'x', name: 'X', type: 'connector', toolId: 'legacy', actionId: '' }), null);
  const actionMapped = sanitizeWorkflowNode({
    id: 'x', name: 'X', type: 'connector', toolId: 'legacy', actionId: 'slack.send_message', input: null,
  });
  assert.equal(actionMapped.type, 'connection');
  assert.equal(actionMapped.connectionType, 'slack');
  const freeTool = sanitizeWorkflowNode({ id: 'x', name: 'X', type: 'connector', toolId: 'legacy', actionId: 'custom.action', input: [] });
  assert.equal(freeTool.type, 'forger_tool');
  assert.equal(sanitizeWorkflowNode(
    { id: 'x', name: 'X', type: 'connector', toolId: 'legacy', actionId: 'custom.action' },
    new Set(['another.action']),
  ), null);
});

test('workflow conditions and graph edges keep only executable predicates', () => {
  const invalidExpression = sanitizeWorkflowNode({ id: 'c', name: 'C', type: 'condition', expression: [] });
  assert.deepEqual(invalidExpression.expression, { left: '', operator: 'is_not_empty' });
  const equals = sanitizeWorkflowNode({
    id: 'c', name: 'C', type: 'condition', expression: { left: 'a', operator: 'equals', right: ' b ' },
  });
  assert.deepEqual(equals.expression, { left: 'a', operator: 'equals', right: 'b' });
  const noRight = sanitizeWorkflowNode({
    id: 'c', name: 'C', type: 'condition', expression: { left: 'a', operator: 'equals', right: '' },
  });
  assert.equal(noRight.expression.right, undefined);

  const nodeIds = new Set(['a', 'b']);
  assert.deepEqual(sanitizeWorkflowEdges([
    [],
    { from: '', to: 'b' },
    { from: 'a', to: '' },
    { from: 'a', to: 'a' },
    { from: 'missing', to: 'b' },
    { from: 'a', to: 'missing' },
    { from: 'a', to: 'b', condition: 'always' },
  ], nodeIds), [{ from: 'a', to: 'b', condition: 'always' }]);
});

test('workflow schedules normalize invalid frequencies, policies, windows, and upsert envelopes', () => {
  assert.deepEqual(sanitizeWorkflowFrequency(null), { type: 'hourly' });
  assert.deepEqual(sanitizeWorkflowFrequency([]), { type: 'hourly' });
  assert.deepEqual(sanitizeWorkflowFrequency({ type: 'weekly', timeOfDay: '1:02', weeklyDay: -10 }), {
    type: 'weekly', timeOfDay: '01:02', weeklyDay: 0,
  });
  assert.deepEqual(sanitizeWorkflowFrequency({ type: 'weekly', weeklyDay: 1.5 }), {
    type: 'weekly', timeOfDay: '09:00', weeklyDay: 1,
  });

  assert.deepEqual(sanitizeWorkflowTrigger([]), { type: 'manual' });
  for (const missedRunPolicy of ['skip', 'within_window']) {
    assert.equal(sanitizeWorkflowTrigger({ type: 'scheduled', missedRunPolicy }).missedRunPolicy, missedRunPolicy);
  }
  for (const missedRunWindowMinutes of ['5', Number.NaN, -1]) {
    assert.equal(sanitizeWorkflowTrigger({ type: 'scheduled', missedRunWindowMinutes }).missedRunWindowMinutes, undefined);
  }
  assert.equal(sanitizeWorkflowTrigger({ type: 'scheduled', missedRunWindowMinutes: 1.4 }).missedRunWindowMinutes, 1);

  assert.deepEqual(sanitizeWorkflowUpsertInput({
    name: 3,
    description: '',
    trigger: null,
    nodes: 'bad',
    edges: 'bad',
    enabled: 'yes',
  }), { name: '', trigger: { type: 'manual' }, nodes: [], edges: [] });
  assert.equal(sanitizeWorkflowUpsertInput({
    name: 'Flow', trigger: { type: 'manual' }, nodes: [], edges: [], enabled: false,
  }).enabled, false);
});
