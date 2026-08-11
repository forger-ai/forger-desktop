import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerMcpServer } = require('../../dist-electron/main/forger-mcp-server.js');

const definition = (id, overrides = {}) => ({
  id,
  packageId: 'forger',
  name: id,
  description: `Execute ${id}`,
  category: 'consulta',
  risk: 'bajo',
  defaultRequiresApproval: false,
  ...overrides,
});

const session = (overrides = {}) => ({
  runId: 'run-b14',
  appId: 'notes',
  caller: 'desktop-chat',
  appIds: ['notes'],
  officialToolActionIds: [],
  forgerToolActionIds: [],
  connectionGrants: [],
  token: 'token',
  createdAt: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

const baseOptions = (overrides = {}) => ({
  getAppVersion: () => '0.5.test',
  getToolDefinitions: () => [],
  getToolSettings: () => ({ approvals: {} }),
  appendInstallLog: async () => undefined,
  requestPermission: () => null,
  listCatalog: async () => [],
  listInstalledApps: () => [],
  checkUpdates: async () => [],
  createLocalApp: async (input) => ({
    success: true,
    app: { appId: 'created', name: input.name, description: input.description, purpose: input.purpose, lookAndFeel: input.lookAndFeel },
  }),
  finishSocialAppInstall: async () => ({ success: true }),
  deleteQuarantinedSocialApp: async () => ({ success: true, userMessage: 'Deleted' }),
  registerQuestion: async () => ({ id: 'question' }),
  getRuntimeStatus: () => ({ status: 'stopped' }),
  getAppViewSnapshot: async (_appId, input) => input,
  getAppRuntimeDiagnostics: async (_appId, input) => input,
  openApp: async () => ({ success: true }),
  stopApp: async () => ({ success: true }),
  restartApp: async () => ({ success: true }),
  refreshAppView: async () => ({ success: true }),
  updateApp: async () => ({ success: true }),
  listAppPrompts: async () => [],
  testAppPrompt: async (input) => ({ success: true, input }),
  updateAppPrompt: async (input) => ({ success: true, input }),
  restoreAppPrompt: async (input) => ({ success: true, input }),
  previewAppToolGrant: async (input) => ({ success: false, appId: input.appId }),
  setAppToolGrant: async (input) => ({ success: true, appId: input.appId, gate: null }),
  listConnectionGrantsForApp: async () => [],
  listConnectionsForSession: async (grants) => ({ types: [], instances: [], grants }),
  callConnectionFromSession: async (input) => ({ success: true, input }),
  memoryList: async () => [],
  memoryCreate: async () => ({ id: 'memory', scope: 'app' }),
  memoryUpdate: async () => ({ id: 'memory', scope: 'app' }),
  memoryDelete: async () => ({ success: false }),
  listOfficialToolActionIdsForApp: async () => new Set(),
  validateOfficialTool: async () => null,
  callOfficialTool: async () => ({ success: true }),
  getSpeechToTextState: async () => ({ status: 'ready' }),
  getTextToSpeechState: async () => ({ status: 'ready', models: ['model'], voices: ['voice'] }),
  synthesizeTextToSpeech: async (input) => ({ success: true, input }),
  processSpeechToText: async (input) => ({ success: true, input }),
  ...overrides,
});

const call = async (server, activeSession, toolId, args = {}, overrides = {}) => await server.executeAgentTool(
  activeSession,
  toolId,
  args,
  [definition(toolId, overrides)],
);

const callMcp = async (activeSession, body) => await fetch(activeSession.url, {
  method: 'POST',
  headers: { authorization: `Bearer ${activeSession.token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('given protocol and handler failures, HTTP boundaries return deterministic JSON-RPC errors', async (t) => {
  const failures = [];
  let failRequestLog = false;
  const server = new ForgerMcpServer(baseOptions({
    getToolDefinitions: () => [definition('forger_list_catalog')],
    appendInstallLog: async (event) => {
      if (failRequestLog && event === 'agent_tool:mcp_http_request') throw 'log-offline';
    },
    onHttpFailure: (failure) => failures.push(failure),
  }));
  await server.start();
  t.after(() => server.stop());
  const active = server.createSession('run-http', 'notes');

  const noArguments = await (await callMcp(active, {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forger_list_catalog' },
  })).json();
  assert.equal(JSON.parse(noArguments.result.content[0].text).success, true);

  server.releaseSession('missing-token');
  const responseState = {};
  await server.handleHttpRequest({ method: 'GET', url: undefined }, {
    writeHead: (status) => { responseState.status = status; },
    end: (body) => { responseState.body = body; },
  });
  assert.equal(responseState.status, 404);

  failRequestLog = true;
  const failureResponse = await callMcp(active, { jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal(failureResponse.status, 500);
  assert.equal((await failureResponse.json()).error.message, 'internal_error');
  assert.equal(failures.some((failure) => failure.error === 'log-offline'), true);
});

test('given optional app-tool grants, invalid scope, prior grants, unavailable prompts, and approval all fail safely', async () => {
  const state = {
    preview: { success: true, appId: 'notes', appName: 'Notes', alreadyGranted: false },
    permission: null,
  };
  const server = new ForgerMcpServer(baseOptions({
    previewAppToolGrant: async () => state.preview,
    requestPermission: () => state.permission,
    setAppToolGrant: async (input) => ({ success: true, appId: input.appId, gate: null }),
  }));
  const desktop = session();
  const personal = session({ caller: 'personal-agent', personalAgentId: 'agent-1', appIds: [] });

  assert.equal((await server.executeAppToolGrantRequest(desktop, {})).technicalCode, 'app_tool_grant_input_invalid');
  assert.equal((await server.executeAppToolGrantRequest(personal, { appId: 'notes', toolId: 'tool.action' })).technicalCode, 'personal_agent_app_not_granted');

  state.preview = { success: true, appId: 'notes', alreadyGranted: true };
  assert.equal((await server.executeAppToolGrantRequest(desktop, { appId: 'notes', toolId: 'tool.action' })).authorization.status, 'not_required');

  state.preview = { success: true, appId: 'notes', alreadyGranted: false };
  assert.equal((await server.executeAppToolGrantRequest(desktop, { appId: 'notes', toolId: 'tool.action' })).technicalCode, 'permission_unavailable');

  state.permission = Promise.resolve(null);
  assert.equal((await server.executeAppToolGrantRequest(desktop, { appId: 'notes', toolId: 'tool.action' })).authorization.status, 'unavailable');

  state.permission = Promise.resolve(true);
  const approved = await server.executeAppToolGrantRequest(desktop, { appId: 'notes', toolId: 'tool.action' });
  assert.equal(approved.authorization.status, 'approved');

  state.preview = {
    success: true,
    appId: 'notes',
    alreadyGranted: false,
    tool: { description: 'Tool fallback description' },
  };
  assert.equal((await server.executeAppToolGrantRequest(desktop, { appId: 'notes', toolId: 'tool.action' })).authorization.status, 'approved');
});

test('given tool dispatch boundaries, unavailable and malformed contexts never reach privileged callbacks', async () => {
  const created = [];
  let officialValidation = null;
  const server = new ForgerMcpServer(baseOptions({
    createLocalApp: async (input) => ({
      success: true,
      app: { appId: 'new-app', name: input.name, description: input.description, purpose: input.purpose, lookAndFeel: input.lookAndFeel },
    }),
    recordCreatedApp: (_runId, app) => created.push(app),
    validateOfficialTool: async () => officialValidation,
    addAppToPersonalAgent: async ({ appId }) => ({ success: true, appId, alreadyGranted: false, userMessage: 'Added' }),
    listAgentPeers: async () => ({ success: true, peers: [] }),
    askAgent: async (input) => ({ success: true, input }),
    readAgentThread: async ({ threadId }) => ({ success: true, thread: { id: threadId } }),
  }));
  const desktop = session();
  const personal = session({
    caller: 'personal-agent', personalAgentId: 'agent-1', personalAgentConversationId: 'conversation-1', appIds: ['notes'],
  });

  assert.equal((await server.executeAgentTool(desktop, 'missing-tool', {})).technicalCode, 'tool_not_found');

  const officialId = 'forger_chrome_extension.navigate';
  assert.equal((await call(server, session({ caller: 'personal-agent', forgerToolActionIds: [] }), officialId, {})).technicalCode, 'personal_agent_tool_not_granted');
  officialValidation = { success: false, technicalCode: 'official_invalid' };
  assert.equal((await call(server, desktop, officialId, {})).technicalCode, 'official_invalid');

  assert.equal((await call(server, desktop, 'forger_update_published_app_info', { appId: 'notes', name: 'Notes' })).technicalCode, 'published_app_info_update_unavailable');
  assert.equal((await call(server, desktop, 'forger_create_app', {})).technicalCode, 'create_app_input_invalid');
  await call(server, desktop, 'forger_create_app', { name: 'One', description: 'Description', purpose: 'Purpose' });
  await call(server, desktop, 'forger_create_app', { name: 'Two', description: 'Description', purpose: 'Purpose', lookAndFeel: 'Warm' });
  assert.deepEqual(created.map((app) => app.lookAndFeel), [undefined, 'Warm']);

  assert.equal((await call(server, desktop, 'forger_add_app_to_personal_agent', { appId: 'notes' })).technicalCode, 'personal_agent_context_required');
  assert.equal((await call(server, personal, 'forger_add_app_to_personal_agent', { appId: ' ' })).technicalCode, 'personal_agent_app_id_required');
  assert.equal((await call(server, desktop, 'forger_list_agent_peers')).technicalCode, 'personal_agent_context_required');
  assert.equal((await call(server, personal, 'forger_ask_agent', { message: 'Hello' })).technicalCode, 'personal_agent_peer_input_invalid');
  assert.equal((await call(server, personal, 'forger_read_agent_thread')).technicalCode, 'personal_agent_peer_thread_id_required');
  assert.equal((await call(server, desktop, 'forger_read_agent_thread', { threadId: 'thread' })).technicalCode, 'personal_agent_context_required');

  assert.equal((await call(server, desktop, 'forger_finish_social_app_install', { quarantineId: 'review-1' })).technicalCode, 'social_app_review_context_required');
  const review = session({ appId: 'review-1', appIds: ['review-1'] });
  assert.equal((await call(server, review, 'forger_finish_social_app_install')).success, true);
  assert.equal((await call(server, review, 'forger_delete_quarantined_social_app')).success, true);
  assert.equal((await call(server, desktop, 'respond_and_end', { text: 'Done' })).technicalCode, 'sidekick_voice_context_required');
  const sidekick = session({
    caller: 'personal-agent', personalAgentId: 'agent-1', personalAgentConversationId: 'conversation-1', sidekick: { sidekickId: 'sidekick' },
  });
  assert.equal((await call(server, sidekick, 'respond_and_end', { text: ' ' })).technicalCode, 'sidekick_voice_response_text_required');
  assert.equal((await call(server, sidekick, 'respond_and_end', { text: 'Done' })).technicalCode, 'sidekick_voice_outcome_not_pending');

  assert.equal((await call(server, desktop, 'forger_test_app_prompt', { kind: 'invalid' })).technicalCode, 'app_prompt_kind_invalid');
  assert.equal((await call(server, desktop, 'forger_test_app_prompt', { kind: 'agent' })).input.id, '');
  assert.equal((await call(server, session({ caller: 'personal-agent', appIds: [] }), 'forger_open_app', { appId: 'notes' })).technicalCode, 'personal_agent_app_not_granted');
});

test('given a non-Error question registration failure, the question tool returns a safe generic diagnostic', async () => {
  const server = new ForgerMcpServer(baseOptions({ registerQuestion: async () => { throw 'question-offline'; } }));
  const result = await call(server, session(), 'forger_ask_question', {
    questions: [{
      id: 'choice',
      question: 'Continue?',
      options: [
        { id: 'yes', label: 'Yes', description: 'Continue now.' },
        { id: 'no', label: 'No', description: 'Stop here.' },
      ],
    }],
  });
  assert.equal(result.technicalCode, 'question_register_failed');
  assert.equal(result.userMessage, 'No pudimos registrar la pregunta para este chat.');
});

test('given peer, media, prompt, memory, and connection tools, optional inputs preserve exact public shapes', async () => {
  const peerInputs = [];
  const server = new ForgerMcpServer(baseOptions({
    askAgent: async (input) => { peerInputs.push(input); return { success: true }; },
    listConnectionGrantsForApp: async () => [],
  }));
  const desktop = session();
  const personal = session({
    caller: 'personal-agent', personalAgentId: 'agent-1', personalAgentConversationId: 'conversation-1', appIds: ['notes'],
  });

  await call(server, personal, 'forger_ask_agent', { message: 'By target', targetAgentId: 'agent-2' });
  await call(server, personal, 'forger_ask_agent', { message: 'By thread', threadId: 'thread-1' });
  assert.equal(peerInputs.length, 2);

  assert.equal((await call(server, desktop, 'forger_connection_list')).success, true);
  assert.equal((await call(server, desktop, 'forger_speech_to_text_status')).state.status, 'ready');
  assert.equal((await call(server, desktop, 'forger_text_to_speech_status')).state.status, 'ready');
  assert.deepEqual((await call(server, desktop, 'forger_text_to_speech_voices')).voices, ['voice']);
  assert.equal((await call(server, desktop, 'forger_synthesize_speech', {})).technicalCode, 'text_to_speech_arguments_required');
  assert.equal((await call(server, desktop, 'forger_synthesize_speech', { text: 'Hello', model: 'm', voice: 'v' })).success, true);
  assert.equal((await call(server, desktop, 'forger_synthesize_speech', { text: 'Hello', model: 'm', voice: 'v', speed: 1, format: 'mp3' })).success, true);
  assert.equal((await call(server, desktop, 'forger_transcribe_audio', {})).technicalCode, 'speech_audio_path_required');
  assert.equal((await call(server, desktop, 'forger_transcribe_audio', { path: '/tmp/a.wav' })).input.task, 'transcribe');
  assert.equal((await call(server, desktop, 'forger_translate_audio', { path: '/tmp/a.wav', language: ' en ', model: ' base ' })).input.task, 'translate');

  assert.deepEqual(await call(server, desktop, 'forger_get_app_view_snapshot', {}), {});
  assert.deepEqual(await call(server, desktop, 'forger_get_app_view_snapshot', { selector: '#app', includeHtml: true, maxChars: 20 }), { selector: '#app', includeHtml: true, maxChars: 20 });
  assert.deepEqual(await call(server, desktop, 'forger_get_app_runtime_diagnostics', {}), {});
  assert.deepEqual(await call(server, desktop, 'forger_get_app_runtime_diagnostics', { recentLines: 5 }), { recentLines: 5 });

  assert.equal((await call(server, desktop, 'memory_delete', {})).success, false);
  assert.equal((await call(server, desktop, 'forger_update_app_prompt', { kind: 'agent' })).input.id, '');
  assert.equal((await call(server, desktop, 'forger_restore_app_prompt', { kind: 'agent' })).input.id, '');
});

test('given workflow bridge gaps, node and management tools return stable unavailable diagnostics', async () => {
  const server = new ForgerMcpServer(baseOptions({ isWorkflowsEnabled: () => true }));
  const workflow = session({ caller: 'workflow' });
  const desktop = session();

  assert.equal(server.executeWorkflowNodeTool(workflow, 'workflow_get_context', {}).technicalCode, 'workflow_node_context_not_found');
  assert.equal(server.executeWorkflowNodeTool(workflow, 'workflow_complete_node', {}).technicalCode, 'workflow_manager_unavailable');
  assert.equal(server.executeWorkflowNodeTool(workflow, 'workflow_fail_node', {}).technicalCode, 'workflow_manager_unavailable');
  assert.equal((await server.executeWorkflowManagementTool(workflow, 'forger_workflow_list', {})).technicalCode, 'workflow_management_not_allowed');
  assert.deepEqual((await server.executeWorkflowManagementTool(desktop, 'forger_workflow_list', {})).workflows, []);
  assert.equal((await server.executeWorkflowManagementTool(desktop, 'forger_workflow_upsert', {})).technicalCode, 'workflow_manager_unavailable');
  assert.equal((await server.executeWorkflowManagementTool(desktop, 'forger_workflow_run', {})).technicalCode, 'workflow_manager_unavailable');

  server.options.workflowsRun = async () => { throw 'workflow-offline'; };
  assert.equal((await server.executeWorkflowManagementTool(desktop, 'forger_workflow_run', { workflowId: 'flow' })).technicalCode, 'workflow_operation_failed');
});

test('given explicit low-risk approval, the permission broker result is represented without ambiguity', async () => {
  const server = new ForgerMcpServer(baseOptions({ requestPermission: () => Promise.resolve(true) }));
  const approval = await server.ensureToolApproval(session(), definition('custom-low-risk', { defaultRequiresApproval: true }));
  assert.deepEqual({ approved: approval.approved, status: approval.status }, { approved: true, status: 'approved' });
});
