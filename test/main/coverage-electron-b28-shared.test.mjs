import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getSharedCopy } = require('../../dist-electron/shared/i18n.js');
const { normalizePlatformCapabilities } = require('../../dist-electron/shared/platform-capabilities.js');
const { resolveWorkflowNodePosition } = require('../../dist-electron/shared/workflow-node-positions.js');
const {
  buildUpstreamFieldSources,
  listSampleFields,
  listSchemaFields,
} = require('../../dist-electron/shared/workflow-templates.js');

test('all dynamic shared copy messages render in Spanish and English with fallback variants', () => {
  for (const locale of ['es', 'en']) {
    const copy = getSharedCopy(locale);
    const messages = [
      copy.tools.unavailableForAgent('Gmail'),
      copy.tools.unavailableForApp('Gmail'),
      copy.tools.notConfiguredForAgent('Gmail'),
      copy.tools.notConfiguredForApp('Gmail'),
      copy.tools.configurationError('Gmail'),
      copy.tools.configurationError('Gmail', 'missing token'),
      copy.chat.failures.authMissingProvider('Codex'),
      copy.chat.failures.quotaExceeded('Codex'),
      copy.chat.failures.quotaExceeded(''),
      copy.chat.failures.modelUnsupported('Codex'),
      copy.chat.failures.modelUnsupported(''),
      copy.chat.failures.canceled(' Check logs.'),
      copy.chat.failures.codexCliFailed('command failed', ' Check logs.'),
      copy.chat.failures.codexCliFailed('', ''),
      copy.chat.failures.codexRequestFailed('timeout', ' Check logs.'),
      copy.chat.failures.codexRequestFailed('', ''),
      copy.chat.failures.providerCliFailed('Claude', 'command failed', ' Check logs.'),
      copy.chat.failures.providerCliFailed('Claude', '', ''),
      copy.chat.failures.providerRequestFailed('Claude', 'timeout', ' Check logs.'),
      copy.chat.failures.providerRequestFailed('Claude', '', ''),
      copy.agentTools.approvalWaiting('Gmail'),
    ];
    assert.equal(messages.every((message) => typeof message === 'string' && message.length > 0), true, locale);
  }
});

test('platform capability objects default malformed reasons without changing grants', () => {
  assert.deepEqual(normalizePlatformCapabilities({
    speechToText: { required: false, reason: null },
    textToSpeech: { required: false, reason: 7 },
    audioInput: { required: false },
    workspaceFolders: { required: false, reason: [] },
    agentRuntimeControl: { required: false, reason: {} },
    sidekickDisplay: { required: false, reason: true },
    sidekickSpeech: { required: false, reason: undefined },
  }), {
    speechToText: { required: false, reason: '' },
    textToSpeech: { required: false, reason: '' },
    audioInput: { required: false, reason: '' },
    workspaceFolders: { required: false, reason: '' },
    agentRuntimeControl: { required: false, reason: '' },
    sidekickDisplay: { required: false, reason: '' },
    sidekickSpeech: { required: false, reason: '' },
  });
});

test('workflow position reset falls back when the previous draft disappears', () => {
  assert.deepEqual(resolveWorkflowNodePosition({
    draftPosition: undefined,
    previousDraftPosition: { x: 10, y: 20 },
    hadPreviousDraftPosition: true,
    livePosition: { x: 30, y: 40 },
    fallbackPosition: { x: 80, y: 80 },
  }), { x: 80, y: 80 });
});

test('workflow fields cover untyped, null, array, connection, and Forger-tool contracts', () => {
  assert.deepEqual(listSchemaFields({}), []);
  assert.deepEqual(listSchemaFields({
    type: 'object',
    properties: { unknown: {}, list: { type: 'array', items: { type: 'string' } } },
  }).map((field) => field.path), ['unknown', 'list']);
  assert.deepEqual(listSchemaFields({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } }, 'items').map((field) => field.path), ['items.0.id']);
  assert.equal(listSampleFields({ value: null })[0].type, 'null');
  assert.equal(listSampleFields([{ id: 1 }])[0].path, '0.id');

  const workflow = {
    nodes: [
      { id: 'connection-current', name: 'Connection current', type: 'connection', connectionType: 'slack', actionId: 'slack.current', input: {} },
      { id: 'connection-legacy', name: 'Connection legacy', type: 'connection', connectionType: 'slack', actionId: 'slack.legacy', input: {} },
      { id: 'connection-none', name: 'Connection none', type: 'connection', connectionType: 'slack', actionId: 'slack.none', input: {} },
      { id: 'tool-current', name: 'Tool current', type: 'forger_tool', toolId: 'forger_current', input: {} },
      { id: 'tool-legacy', name: 'Tool legacy', type: 'forger_tool', toolId: 'forger_legacy', input: {} },
      { id: 'final', name: 'Final', type: 'llm_agent', prompt: 'Summarize', toolIds: [], appIds: [], connectionGrants: [] },
    ],
    edges: [
      { from: 'connection-current', to: 'final', condition: 'success' },
      { from: 'connection-legacy', to: 'final', condition: 'success' },
      { from: 'connection-none', to: 'final', condition: 'success' },
      { from: 'tool-current', to: 'final', condition: 'success' },
      { from: 'tool-legacy', to: 'final', condition: 'success' },
    ],
  };
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  const sources = buildUpstreamFieldSources(workflow, 'final', {
    connectionOutputSchemas: { 'slack.current': schema },
    forgerToolOutputSchemas: { forger_current: schema },
    connectorOutputSchemas: { 'slack.legacy': schema, forger_legacy: schema },
  });
  const fieldsByNode = Object.fromEntries(sources.map((source) => [source.node.id, source.fields]));
  assert.equal(fieldsByNode['connection-current'][0].path, 'ok');
  assert.equal(fieldsByNode['connection-legacy'][0].path, 'ok');
  assert.deepEqual(fieldsByNode['connection-none'], []);
  assert.equal(fieldsByNode['tool-current'][0].path, 'ok');
  assert.equal(fieldsByNode['tool-legacy'][0].path, 'ok');
});
