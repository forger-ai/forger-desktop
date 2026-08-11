import assert from 'node:assert/strict';
import test from 'node:test';

const {
  deleteBackendJson,
  getBackendJson,
  patchBackendJson,
  postBackendJson,
} = await import('../../dist-electron/main/forger-backend/json-request.js');
const {
  appleLoginErrorMessage,
  defaultReportingLogPath,
  googleLoginErrorMessage,
  normalizeRuntimePlatform,
} = await import('../../dist-electron/main/forger-backend/client-helpers.js');
const { mapCatalogItem, normalizeRating } = await import(
  '../../dist-electron/main/forger-backend/catalog-normalizers.js'
);
const {
  submitConversationDiagnosticReport,
  submitDesktopErrorReport,
} = await import('../../dist-electron/main/forger-backend/report-submissions.js');

const options = {
  backendBaseUrl: 'https://platform.test',
  token: () => 'session-token',
};

const withFetch = async (implementation, action) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const response = (status, body, headers = {}) => new Response(body, { status, headers });
const json = (status, body, headers = {}) => response(status, JSON.stringify(body), {
  'content-type': 'application/json',
  ...headers,
});

const captureFailure = async (action) => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('Expected request to fail');
};

test('JSON requests preserve method/body semantics and tolerate empty or malformed success payloads', async () => {
  const requests = [];
  const replies = [
    response(200, ''),
    response(200, '{malformed'),
    json(200, { patched: true }),
    response(204, null),
  ];
  await withFetch(async (url, init) => {
    requests.push({ url, init });
    return replies.shift();
  }, async () => {
    assert.equal(await getBackendJson(options, '/empty', 'empty_failed'), null);
    assert.equal(await postBackendJson(options, '/malformed', { value: 1 }, 'post_failed'), null);
    assert.deepEqual(await patchBackendJson(options, '/patch', { value: 2 }, 'patch_failed'), { patched: true });
    assert.equal(await deleteBackendJson(options, '/gone', 'delete_failed'), null);
  });

  assert.deepEqual(requests.map(({ init }) => init.method), ['GET', 'POST', 'PATCH', 'DELETE']);
  assert.equal(requests[0].init.body, undefined);
  assert.equal(requests[0].init.headers['Content-Type'], undefined);
  assert.equal(requests[1].init.body, '{"value":1}');
  assert.equal(requests[1].init.headers['Content-Type'], 'application/json');
  assert.equal(requests.every(({ init }) => init.headers.Authorization === 'Bearer session-token'), true);
});

test('JSON request failures expose stable user and technical error contracts for every backend shape', async () => {
  const cases = [
    {
      invoke: () => getBackendJson(options, '/auth', 'fetch_failed'),
      reply: json(401, null),
      message: 'Tu sesión de Forger Cloud expiró. Inicia sesión de nuevo e inténtalo otra vez.',
      technicalCode: 'fetch_failed_401',
    },
    {
      invoke: () => postBackendJson(options, '/forbidden', {}, 'post_failed'),
      reply: json(403, []),
      technicalCode: 'post_failed_403',
    },
    {
      invoke: () => patchBackendJson(options, '/missing', {}, 'patch_failed'),
      reply: json(404, { error: 4, message: 9 }),
      message: 'No encontramos esa app o el código de invitación ya no está disponible.',
      technicalCode: 'patch_failed_404',
    },
    {
      invoke: () => deleteBackendJson(options, '/platform', 'social_user_app_download_failed'),
      reply: json(422, { error: ' platform_not_supported ', message: 'Backend detail' }),
      message: 'Esta app no está disponible para este sistema operativo.',
      technicalCode: 'social_app_platform_not_supported',
      backendErrorCode: 'platform_not_supported',
    },
    {
      invoke: () => getBackendJson(options, '/download-auth', 'social_user_app_download_failed'),
      reply: json(403, { error: 'unauthorized' }),
      technicalCode: 'forger_cloud_auth_expired',
    },
    {
      invoke: () => getBackendJson(options, '/download-missing', 'social_user_app_download_failed'),
      reply: json(404, { error: 'not_found' }),
      technicalCode: 'social_app_download_not_found',
    },
    {
      invoke: () => postBackendJson(options, '/detail', {}, 'save_failed'),
      reply: json(500, { error: '  ', message: ' Backend says no ' }),
      message: 'Backend says no',
      technicalCode: 'save_failed_500',
    },
    {
      invoke: () => getBackendJson(options, '/blank', 'fetch_failed'),
      reply: json(500, { message: '  ' }),
      message: 'Forger Cloud session is no longer valid.',
      technicalCode: 'fetch_failed_500',
    },
    {
      invoke: () => deleteBackendJson(options, '/delete', 'delete_failed'),
      reply: response(500, 'not-json'),
      message: 'No pudimos completar la accion en Forger Cloud.',
      technicalCode: 'delete_failed_500',
    },
  ];

  for (const scenario of cases) {
    const error = await withFetch(async () => scenario.reply, () => captureFailure(scenario.invoke));
    if (scenario.message) {
      assert.equal(error.message, scenario.message);
    }
    assert.equal(error.technicalCode, scenario.technicalCode);
    assert.equal(error.details.httpStatus, scenario.reply.status);
    if ('backendErrorCode' in scenario) {
      assert.equal(error.details.backendErrorCode, scenario.backendErrorCode);
    }
  }
});

const mapCatalog = (entry, includeDownload = true) => mapCatalogItem(entry, includeDownload, {
  backendBaseUrl: 'https://platform.test/base/',
  mapBackendCategory: () => 'productivity',
  toCatalogStatus: () => 'not_installed',
  getUserMessage: () => undefined,
});

test('catalog normalization keeps complete optional metadata and sanitizes social identifiers', () => {
  const app = mapCatalog({
    id: '8',
    slug: '***',
    name: 'Shared',
    short_description: null,
    description: 'Fallback description',
    category: 'social',
    owner: { username: '!!!' },
    recent_ratings: [{
      id: 1,
      score: 5,
      comment: 7,
      forger_response: 'Thanks',
      created_at: 'created',
      updated_at: 'updated',
      user: { username: 'ada', first_name: 4, last_initial: 9 },
    }],
    current_user_rating: { id: 2, score: 4, user: null },
    latest_version: {
      id: 9,
      version: '1.2.3',
      download_url: '/download.zip',
      connections: { required: [{ type: 'gmail', actions: ['read'], reason: 'Needed' }] },
      tools: {
        required: [{ toolId: 'mail', actions: ['read', 'read', 7, ' '], reason: ' access ' }],
        optional: [{ toolId: ' ', actions: ['read'], reason: 'drop' }, []],
      },
      agents: [{
        id: 'agent',
        title: 'Agent',
        initialPrompt: ' Start ',
        description: ' Description ',
        kind: 'classic',
        initialPromptTemplate: ' Template ',
        model: ' model ',
        reasoningEffort: 'high',
        runtimeRecommendations: { codex: { model: 'gpt' } },
      }],
      prompt_templates: [{
        id: 'template',
        title: 'Template',
        prompt: ' Do it ',
        description: ' Description ',
        model: ' model ',
        reasoningEffort: 'medium',
        runtimeRecommendations: { claude: { model: 'sonnet' } },
      }],
    },
  }, false);

  assert.equal(app.id, 'social-user-app');
  assert.equal(app.description, 'Fallback description');
  assert.equal(app.longDescription, 'Fallback description');
  assert.equal(app.downloadUrl, undefined);
  assert.deepEqual(app.recentRatings[0], {
    id: 1,
    score: 5,
    comment: null,
    forgerResponse: 'Thanks',
    createdAt: 'created',
    updatedAt: 'updated',
    user: { username: 'ada', firstName: undefined, lastInitial: null },
  });
  assert.equal(app.currentUserRating.user, undefined);
  assert.deepEqual(app.tools.required, [{ toolId: 'mail', actions: ['read'], reason: 'access' }]);
  assert.equal(app.connections.required[0].type, 'gmail');
  assert.equal(app.agents[0].description, 'Description');
  assert.equal(app.agents[0].initialPromptTemplate, 'Template');
  assert.equal(app.agents[0].runtimeRecommendations.codex.model, 'gpt');
  assert.equal(app.promptTemplates[0].description, 'Description');
  assert.equal(app.promptTemplates[0].runtimeRecommendations.claude.model, 'sonnet');
});

test('catalog normalization drops absent and malformed optional collections without inventing metadata', () => {
  const app = mapCatalog({
    slug: 'plain',
    name: 'Plain',
    category: 'other',
    owner: { username: null },
    tools: [],
    agents: [null, [], { id: 5, title: 'Bad', initialPrompt: 'Start' }, { id: 'a', title: 'A', initialPrompt: '' }],
    promptTemplates: [null, [], { id: 4, title: 'Bad', prompt: 'Run' }],
    latest_version: {
      tools: null,
      agents: 'bad',
      promptTemplates: 'bad',
      connections: null,
      changelog: { summary: 9, changes: 'bad' },
    },
  });

  assert.equal(app.id, 'plain');
  assert.equal(app.shortDescription, undefined);
  assert.equal(app.description, '');
  assert.equal(app.longDescription, '');
  assert.equal(app.tools, undefined);
  assert.equal(app.connections, undefined);
  assert.equal(app.agents, undefined);
  assert.equal(app.promptTemplates, undefined);
  assert.equal(app.changelog, undefined);
  assert.equal(normalizeRating({ id: 1, score: 2, user: { username: 3, first_name: 'Ada', last_initial: 'A' } }).user.username, undefined);
  assert.equal(normalizeRuntimePlatform('linux', 'x64'), 'linux_x64');
  assert.equal(normalizeRuntimePlatform('linux', 'risc v/64'), 'linux_risc_v_64');
});

test('catalog normalization exhausts malformed nested declarations before returning empty collections', () => {
  const invalid = mapCatalog({
    slug: 'invalid',
    name: 'Invalid',
    category: 'other',
    average_rating: Number.NaN,
    latest_version: {
      version: '1.0.0',
      changelog: { summary: 5 },
      tools: {
        required: [{ toolId: 'mail', actions: 'read', reason: 'Needed' }],
        optional: [],
      },
      agents: [
        { id: 9, title: 'Title', initialPrompt: 'Start' },
        { id: 'id', title: 9, initialPrompt: 'Start' },
        { id: 'id', title: 'Title', prompts: {} },
        { id: 'resume-only', title: 'Resume only', prompts: { resume: { body: 'Resume' } } },
        { id: 'valid', title: 'Valid', prompts: { initial: { body: 'Prompt' } } },
        { id: 'empty-body', title: 'Empty', prompts: { initial: { body: 9 } } },
      ],
      promptTemplates: [
        { id: 9, title: 'Title', prompt: 'Prompt' },
        { id: 'id', title: 9, prompt: 'Prompt' },
        { id: 'id', title: 'Title', prompt: 9 },
      ],
    },
  });
  assert.equal(invalid.tools, undefined);
  assert.deepEqual(invalid.agents.map(({ id, initialPrompt }) => [id, initialPrompt]), [['valid', 'Prompt']]);
  assert.equal(invalid.promptTemplates, undefined);
  assert.equal(invalid.averageRating, undefined);
  assert.deepEqual(invalid.changelog, { version: '1.0.0', summary: undefined, changes: [] });

  const entirelyEmpty = mapCatalog({
    slug: 'empty',
    name: 'Empty',
    category: 'other',
    tools: {},
    agents: [{ id: 9, title: 9, initialPrompt: '' }],
    promptTemplates: [{ id: 9, title: 9, prompt: 9 }],
  });
  assert.equal(entirelyEmpty.tools, undefined);
  assert.equal(entirelyEmpty.agents, undefined);
  assert.equal(entirelyEmpty.promptTemplates, undefined);
});

test('Apple login failures map each public backend outcome to a stable user message', () => {
  assert.equal(appleLoginErrorMessage({ error: 'apple_login_server_not_configured' }), 'Apple login no esta configurado en Forger Cloud.');
  assert.equal(appleLoginErrorMessage({ error: 'apple_login_email_unverified' }), 'Apple no confirmo este correo.');
  assert.equal(appleLoginErrorMessage({ error: 'apple_login_account_conflict' }), 'Este correo ya esta vinculado a otra cuenta de Apple.');
  assert.equal(appleLoginErrorMessage({ error: 'access_denied' }), 'Apple cancelo el inicio de sesion.');
  assert.equal(appleLoginErrorMessage({ error: 'unknown' }), 'No pudimos iniciar sesion con Apple.');
  assert.equal(appleLoginErrorMessage(null), 'No pudimos iniciar sesion con Apple.');
  assert.equal(googleLoginErrorMessage(null), 'No pudimos iniciar sesion con Google.');
});

test('reporting log paths honor development names and each platform storage convention', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const previous = {
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  try {
    process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173';
    process.env.APPDATA = '/windows-data';
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    assert.equal(defaultReportingLogPath(), '/windows-data/forger-desktop-dev/logs/reporting.log');

    delete process.env.APPDATA;
    assert.match(defaultReportingLogPath(), /forger-desktop-dev\/logs\/reporting\.log$/);

    delete process.env.VITE_DEV_SERVER_URL;
    process.env.XDG_CONFIG_HOME = '/linux-config';
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    assert.equal(defaultReportingLogPath(), '/linux-config/forger-desktop/logs/reporting.log');

    delete process.env.XDG_CONFIG_HOME;
    assert.match(defaultReportingLogPath(), /\.config\/forger-desktop\/logs\/reporting\.log$/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

const desktopReport = {
  source: 'main',
  operation: 'startup',
  message: 'Failed at /private/work/report.txt',
  technicalCode: 'startup_failed',
  desktopVersion: '1.0.0',
  platform: 'darwin',
  arch: 'arm64',
  details: { safe: true },
  sensitiveDetails: { token: 'secret' },
};

const conversationReport = {
  source: 'desktop_chat',
  appId: 'finance',
  conversationId: 'conversation-1',
  runId: 'run-1',
  title: 'Failure',
  description: 'Please inspect',
  provider: 'codex',
  technicalCode: 'run_failed',
  desktopVersion: '1.0.0',
  platform: 'darwin',
  occurredAt: '2026-08-10T00:00:00.000Z',
  payload: { message: 'visible' },
};

const reportOptions = (logs, token = 'cloud-token') => ({
  backendBaseUrl: 'https://platform.test',
  token,
  roots: [{ alias: 'WORKSPACE', path: '/private/work' }],
  appendReportingLog: async (event, details) => logs.push({ event, ...details }),
});

test('desktop reports serialize sanitized multipart attachments and preserve request diagnostics', async () => {
  const logs = [];
  let request;
  const result = await withFetch(async (url, init) => {
    request = { url, init };
    return json(201, {}, { 'x-correlation-id': 'correlation-1' });
  }, () => submitDesktopErrorReport(reportOptions(logs), {
    ...desktopReport,
    appId: undefined,
    appVersion: undefined,
  }, [{
    kind: 'run_log',
    filename: 'run.log',
    contentType: 'text/plain',
    originalByteSize: 30,
    sanitizedByteSize: 20,
    text: 'at /private/work/run.log token=secret',
  }]));

  assert.equal(result.success, true);
  assert.equal(request.init.body instanceof FormData, true);
  assert.equal(request.init.headers['Content-Type'], undefined);
  assert.equal(request.init.body.get('app_id'), null);
  assert.deepEqual(JSON.parse(request.init.body.get('details')).diagnosticFiles.map(({ filename }) => filename), ['run.log']);
  assert.equal((await request.init.body.get('diagnostic_files[]').text()).includes('/private/work'), false);
  assert.equal(logs[0].requestId, 'correlation-1');
  assert.equal(logs[0].diagnosticFileCount, 1);
});

test('desktop and conversation report failures retain observable auth, HTTP, and network classifications', async () => {
  const logs = [];
  const desktopHttp = await withFetch(async () => json(503, {}), () => submitDesktopErrorReport(
    reportOptions(logs),
    { ...desktopReport, diagnosticFiles: [{ kind: 'main_log', filename: 'main.log', contentType: 'text/plain', originalByteSize: 1, sanitizedByteSize: 1 }] },
  ));
  assert.equal(desktopHttp.technicalCode, 'desktop_error_report_failed_503');
  assert.equal(logs.at(-1).diagnosticFileCount, 1);

  const desktopNetwork = await withFetch(async () => {
    throw new TypeError('offline');
  }, () => submitDesktopErrorReport(reportOptions(logs), desktopReport));
  assert.equal(desktopNetwork.technicalCode, 'desktop_error_report_network_failed');
  assert.equal(logs.at(-1).errorName, 'TypeError');
  assert.equal(logs.at(-1).errorMessage, 'offline');

  for (const status of [401, 403, 500]) {
    const result = await withFetch(async () => json(status, {}, { 'x-request-id': `request-${status}` }), () =>
      submitConversationDiagnosticReport(reportOptions(logs), conversationReport));
    assert.equal(result.technicalCode, status === 500 ? 'conversation_diagnostic_report_failed_500' : 'forger_cloud_auth_expired');
    assert.equal(logs.at(-1).requestId, `request-${status}`);
  }

  const conversationNetwork = await withFetch(async () => {
    throw 'offline';
  }, () => submitConversationDiagnosticReport(reportOptions(logs), conversationReport));
  assert.equal(conversationNetwork.technicalCode, 'conversation_diagnostic_report_network_failed');
  assert.equal(logs.at(-1).errorName, undefined);

  const conversationError = await withFetch(async () => {
    throw new TypeError('offline');
  }, () => submitConversationDiagnosticReport(reportOptions(logs), conversationReport));
  assert.equal(conversationError.technicalCode, 'conversation_diagnostic_report_network_failed');
  assert.equal(logs.at(-1).errorName, 'TypeError');
});

test('conversation reports omit missing multipart fields and upload every diagnostic attachment', async () => {
  const logs = [];
  let form;
  const result = await withFetch(async (_url, init) => {
    form = init.body;
    return json(201, {});
  }, () => submitConversationDiagnosticReport(reportOptions(logs, undefined), {
    ...conversationReport,
    appId: undefined,
    runId: undefined,
    title: undefined,
    description: undefined,
    provider: undefined,
    technicalCode: undefined,
    desktopVersion: undefined,
    platform: undefined,
  }, [{
    kind: 'codex_session_jsonl',
    filename: 'session.jsonl',
    contentType: 'application/x-ndjson',
    originalByteSize: 2,
    sanitizedByteSize: 2,
    text: '{}',
  }]));

  assert.equal(result.success, true);
  assert.equal(form instanceof FormData, true);
  assert.equal(form.get('app_id'), null);
  assert.equal(form.get('source'), 'desktop_chat');
  assert.deepEqual(JSON.parse(form.get('payload')), { message: 'visible' });
  assert.equal((await form.get('diagnostic_files[]').text()), '{}');
  assert.equal(logs[0].success, true);
});
