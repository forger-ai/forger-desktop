import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helpers = require('../../dist-electron/main/forger-mcp-server-helpers.js');

test('MCP boundary helpers classify tools and preserve the effective connection call contract', () => {
  assert.equal(helpers.isMemoryTool('memory_list'), true);
  assert.equal(helpers.isMemoryTool('workflow_list'), false);
  assert.equal(helpers.isOfficialTool('forger_chrome_extension.open_tab'), true);
  assert.equal(helpers.isOfficialTool('unknown.action'), false);
  assert.equal(helpers.isConnectionAction('gmail.search'), true);
  assert.equal(helpers.isConnectionAction('unknown.action'), false);
  assert.equal(helpers.isConnectionManagementTool('forger_connection_list'), true);
  assert.equal(helpers.isConnectionManagementTool('forger_connection_status'), true);
  assert.equal(helpers.isConnectionManagementTool('forger_connection_call'), false);
  assert.equal(helpers.getOfficialToolIdForAction('forger_chrome_extension.open_tab'), 'forger_chrome_extension');
  assert.equal(helpers.getOfficialToolIdForAction('unknown.action'), 'unknown.action');

  const grants = helpers.dedupeConnectionGrants([
    { type: 'google', actions: ['read'], multiple: false },
    { type: 'google', actions: ['read', 'write'], multiple: true, connectionIds: ['g-1'] },
    { type: 'github', actions: ['issues'], multiple: false, connectionIds: ['gh-1'] },
    { type: 'github', actions: ['repos'], multiple: false },
    { type: 'slack', actions: ['read'], multiple: false },
    { type: 'slack', actions: ['write'], multiple: false },
  ]);
  assert.deepEqual(grants, [
    { type: 'google', actions: ['read', 'write'], multiple: true, connectionIds: ['g-1'] },
    { type: 'github', actions: ['issues', 'repos'], multiple: false, connectionIds: ['gh-1'] },
    { type: 'slack', actions: ['read', 'write'], multiple: false },
  ]);
  assert.equal(helpers.connectionActionGranted(grants, 'write'), true);
  assert.equal(helpers.connectionActionGranted(grants, 'missing'), false);
  assert.deepEqual(helpers.toConnectionCallInput('unknown.action', { connectionId: '  ', query: 'roadmap' }), {
    type: '', actionId: 'unknown.action', input: { query: 'roadmap' },
  });
  assert.equal(helpers.toConnectionCallInput('gmail.search', { connectionId: ' gmail-1 ' }).connectionId, 'gmail-1');
});

test('MCP boundary helpers distinguish internal and app-scoped capabilities', () => {
  for (const toolId of [
    'forger_ask_question', 'wakeup_in', 'cancel_wakeup', 'respond_and_end', 'respond_and_wait',
    'create_agent_routine', 'list_agent_routines', 'update_agent_routine', 'delete_agent_routine',
    'forger_list_agent_peers', 'forger_ask_agent', 'forger_read_agent_thread',
    'workflow_run', 'forger_connection_list',
  ]) assert.equal(helpers.isInternalMcpTool(toolId), true, toolId);
  assert.equal(helpers.isInternalMcpTool('forger_open_app'), false);
  assert.equal(helpers.isAppScopedTool('forger_open_app'), true);
  assert.equal(helpers.isAppScopedTool('workflow_run'), false);
});

test('published-app MCP updates accept one platform identity and reject ambiguous malformed edits', () => {
  assert.deepEqual(helpers.parsePublishedAppInfoUpdateInput({ userAppId: ' 7 ', name: ' Finance ' }), {
    userAppId: 7,
    name: 'Finance',
  });
  assert.deepEqual(helpers.parsePublishedAppInfoUpdateInput({
    appId: ' finance-os ', shortDescription: ' Short ', description: ' Detail ', longDescription: ' Long ',
    category: 'finance', visibility: 'friends',
  }), {
    appId: 'finance-os', shortDescription: 'Short', description: 'Detail', longDescription: 'Long',
    category: 'finance', visibility: 'friends',
  });
  const invalid = [
    {},
    { userAppId: '0', appId: ' ' },
    { appId: 'app', name: 7 },
    { appId: 'app', name: ' ' },
    { appId: 'app', shortDescription: 7 },
    { appId: 'app', description: 7 },
    { appId: 'app', longDescription: 7 },
    { appId: 'app', category: 7 },
    { appId: 'app', category: 'not-a-category' },
    { appId: 'app', visibility: 'team' },
    { appId: 'app' },
  ];
  for (const input of invalid) assert.equal(helpers.parsePublishedAppInfoUpdateInput(input), null);
});

test('app grant MCP input and localized consent copy keep authorization explicit', () => {
  assert.deepEqual(helpers.parseAppToolGrantRequestInput({ appId: ' notes ', toolId: ' browser ' }), {
    appId: 'notes', toolId: 'browser',
  });
  assert.equal(helpers.parseAppToolGrantRequestInput({ appId: '', toolId: 'browser' }), null);
  assert.equal(helpers.parseAppToolGrantRequestInput({ appId: 'notes', toolId: 1 }), null);

  const english = helpers.getAppToolGrantMcpCopy('en-US');
  assert.match(english.requestTitle('Browser'), /Browser/);
  assert.match(english.requestBody('Notes', 'Browser', 'Needed'), /Reason: Needed/);
  assert.doesNotMatch(english.requestBody('Notes', 'Browser', ''), /Reason:/);
  assert.match(english.waiting('Browser'), /Browser/);
  assert.match(english.invalidInput, /Choose/);
  const spanish = helpers.getAppToolGrantMcpCopy(undefined);
  assert.match(spanish.requestBody('Notas', 'Navegador', 'Necesario'), /Motivo: Necesario/);
  assert.doesNotMatch(spanish.requestBody('Notas', 'Navegador', ''), /Motivo:/);
});

test('MCP app creation and question forms reject incomplete or structurally unsafe input', () => {
  assert.deepEqual(helpers.parseCreateLocalAppToolInput({
    name: ' Tasks ', description: ' Keep track ', purpose: ' Personal planning ', lookAndFeel: ' Calm ',
  }), { name: 'Tasks', description: 'Keep track', purpose: 'Personal planning', lookAndFeel: 'Calm' });
  assert.deepEqual(helpers.parseCreateLocalAppToolInput({
    name: 'Tasks', description: 'Track', purpose: 'Plan', lookAndFeel: ' ',
  }), { name: 'Tasks', description: 'Track', purpose: 'Plan' });
  for (const input of [{}, { name: 'N', description: 'D' }, { name: 'N', purpose: 'P' }]) {
    assert.equal(helpers.parseCreateLocalAppToolInput(input), null);
  }

  const valid = {
    questions: [{
      id: ' priority ', question: ' Which priority? ', options: [
        { id: ' high ', label: ' High ', description: ' Do first ' },
        { id: ' low ', label: ' Low ', description: ' Can wait ' },
      ],
    }],
  };
  assert.deepEqual(helpers.parseQuestionToolInput(valid), {
    questions: [{
      id: 'priority', question: 'Which priority?', options: [
        { id: 'high', label: 'High', description: 'Do first' },
        { id: 'low', label: 'Low', description: 'Can wait' },
      ],
    }],
  });
  const invalid = [
    {}, { questions: [] }, { questions: new Array(6).fill(valid.questions[0]) }, { questions: [null] },
    { questions: [{ id: '', question: 'Q', options: valid.questions[0].options }] },
    { questions: [{ id: 'q', question: '', options: valid.questions[0].options }] },
    { questions: [{ id: 'q', question: 'Q', options: [] }] },
    { questions: [{ id: 'q', question: 'Q', options: [null, valid.questions[0].options[1]] }] },
    { questions: [{ id: 'q', question: 'Q', options: [{ id: '', label: 'L', description: 'D' }, valid.questions[0].options[1]] }] },
    { questions: [{ id: 'q', question: 'Q', options: [{ id: 'a', label: '', description: 'D' }, valid.questions[0].options[1]] }] },
    { questions: [{ id: 'q', question: 'Q', options: [{ id: 'a', label: 'L', description: '' }, valid.questions[0].options[1]] }] },
  ];
  for (const input of invalid) assert.equal(helpers.parseQuestionToolInput(input), null);
  assert.equal(helpers.parseQuestionToolInput({ questions: [valid.questions[0], valid.questions[0]] }), null);
  assert.equal(helpers.parseQuestionToolInput({ questions: [{
    id: 'q', question: 'Q', options: [
      { id: 'same', label: 'A', description: 'A' }, { id: 'same', label: 'B', description: 'B' },
    ],
  }] }), null);
});

test('workflow, memory, runtime and transport helpers expose stable MCP boundary behavior', async () => {
  assert.equal(helpers.parsePromptReviewKind('agentPrompt'), 'agentPrompt');
  assert.equal(helpers.parsePromptReviewKind('other'), null);
  assert.equal(helpers.isPlainRecord({}), true);
  assert.equal(helpers.isPlainRecord([]), false);
  assert.deepEqual(helpers.parsePromptRuntimeOverride({
    runtime: { provider: 'codex', model: ' gpt-test ', effort: 'high' },
    provider: 'claude', model: ' claude-test ', effort: 'medium', reasoningEffort: 'xhigh',
  }), {
    runtime: { provider: 'codex', model: 'gpt-test', effort: 'high' },
    provider: 'claude', model: 'claude-test', effort: 'medium', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(helpers.parsePromptRuntimeOverride({ runtime: [], provider: 'other', model: ' ', effort: 'huge' }), {});
  assert.deepEqual(helpers.memoryAccess({ caller: 'workflow', appId: 'forger', appIds: ['notes'], runId: 'r1' }), {
    caller: 'automation', appId: undefined, appIds: ['notes'], runId: 'r1',
  });
  assert.deepEqual(helpers.memoryAccess({ caller: 'app', appId: 'notes' }), {
    caller: 'app', appId: 'notes', appIds: undefined, runId: undefined,
  });
  assert.equal(typeof helpers.memoryErrorMessage('not-an-error', 'en'), 'string');

  const workflowCases = new Map([
    ['workflow_not_found', /encontramos/], ['workflow_name_required', /nombre/],
    ['workflow_nodes_required', /nodo/], ['workflow_graph_has_cycle', /ciclo/],
    ['workflow_too_many_nodes', /demasiados/], ['workflow_edge_unknown_node', /invalidos/],
    ['workflow_edge_self_reference', /invalidos/], ['workflow_foreach_join_not_allowed', /repeticiones/],
    ['workflow_foreach_requires_upstream', /paso anterior/], ['workflow_node_id_required', /id unico/],
    ['workflow_node_id_duplicated', /id unico/], ['unknown', /No pudimos/],
  ]);
  for (const [code, expected] of workflowCases) assert.match(helpers.workflowMcpErrorMessage(code), expected);

  assert.equal(helpers.getToolAppId({ appId: 'fallback' }, { appId: ' chosen ' }), 'chosen');
  assert.equal(helpers.getToolAppId({ appId: 'fallback' }, { appId: ' ' }), 'fallback');
  const result = { content: 'ok' };
  assert.equal(helpers.withToolAuthorization(result, { required: false }), result);
  assert.equal(helpers.withToolAuthorization(null, { required: true }), null);
  assert.deepEqual(helpers.withToolAuthorization(result, {
    required: true, status: 'pending', userMessage: 'Approve?',
  }), { content: 'ok', authorization: { required: true, status: 'pending', userMessage: 'Approve?' } });

  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
  helpers.sendMcpJson(response, 202, { accepted: true });
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(response.body), { accepted: true });
  assert.equal(await helpers.readRequestBody(Readable.from(['hello', Buffer.from(' world')])), 'hello world');
  assert.equal(helpers.getBearerToken({ headers: {} }), null);
  assert.equal(helpers.getBearerToken({ headers: { authorization: ['Bearer secret'] } }), null);
  assert.equal(helpers.getBearerToken({ headers: { authorization: 'Basic secret' } }), null);
  assert.equal(helpers.getBearerToken({ headers: { authorization: ' bearer secret-token ' } }), 'secret-token');
});
