import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { INTERNAL_TOOL_MODULES } = require('../../dist-electron/main/tools/index.js');
const { metaToolModule } = require('../../dist-electron/main/tools/meta/index.js');
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');

const findMetaModule = () => INTERNAL_TOOL_MODULES.find((module) => module.definition.id === 'meta');

const baseContext = (overrides = {}) => ({
  metadataRoot: '/tmp/forger-meta-test',
  secretsStore: {
    hasToolSecret: async () => false,
    getToolSecret: async () => undefined,
    setToolSecret: async () => ({ success: true }),
    deleteToolSecrets: async () => undefined,
  },
  getFreePort: async () => 7861,
  openExternalUrl: async () => undefined,
  isForgerAccountAuthenticated: () => true,
  getGmailOAuthClientId: async () => 'gmail-client-id-unused',
  exchangeGmailOAuthCode: async () => ({}),
  refreshGmailOAuthAccessToken: async () => ({}),
  getMetaOAuthClientId: async () => 'meta-client-id',
  exchangeMetaOAuthCode: async () => ({}),
  refreshMetaOAuthAccessToken: async () => ({}),
  appendLog: async () => undefined,
  ...overrides,
});

test('meta tool is registered in INTERNAL_TOOL_MODULES', () => {
  const found = findMetaModule();
  assert.ok(found, 'metaToolModule must be exported from INTERNAL_TOOL_MODULES');
  assert.equal(found, metaToolModule);
});

test('meta tool definition declares the expected read-only actions', () => {
  const actions = metaToolModule.definition.actions.map((action) => action.id);
  assert.deepEqual(actions.sort(), [
    'meta.connection.status',
    'meta.get_lead',
    'meta.list_lead_forms',
    'meta.list_pages',
    'meta.sync_leads',
  ]);
});

test('meta tool declares only read-related scopes via its secret usage description', () => {
  const secret = metaToolModule.definition.secrets[0];
  assert.equal(secret.name, 'oauth_user_access_token');
  assert.equal(secret.required, true);
});

test('meta.connection.status returns disconnected when no token is stored', async () => {
  const context = baseContext({
    secretsStore: {
      hasToolSecret: async () => false,
      getToolSecret: async () => undefined,
      setToolSecret: async () => ({ success: true }),
      deleteToolSecrets: async () => undefined,
    },
  });
  const result = await metaToolModule.execute(
    { toolId: 'meta', actionId: 'meta.connection.status', input: {} },
    context,
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { connected: false });
});

test('meta.list_lead_forms rejects input without pageId', async () => {
  const result = await metaToolModule.execute(
    { toolId: 'meta', actionId: 'meta.list_lead_forms', input: {} },
    baseContext(),
  );
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'meta_list_lead_forms_input_invalid');
});

test('meta.sync_leads rejects input missing pageId or formId', async () => {
  const missingForm = await metaToolModule.execute(
    { toolId: 'meta', actionId: 'meta.sync_leads', input: { pageId: 'p1' } },
    baseContext(),
  );
  assert.equal(missingForm.success, false);
  assert.equal(missingForm.technicalCode, 'meta_sync_leads_input_invalid');

  const missingPage = await metaToolModule.execute(
    { toolId: 'meta', actionId: 'meta.sync_leads', input: { formId: 'f1' } },
    baseContext(),
  );
  assert.equal(missingPage.success, false);
  assert.equal(missingPage.technicalCode, 'meta_sync_leads_input_invalid');
});

test('meta.get_lead rejects input without leadId', async () => {
  const result = await metaToolModule.execute(
    { toolId: 'meta', actionId: 'meta.get_lead', input: {} },
    baseContext(),
  );
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'meta_get_lead_input_invalid');
});

test('meta tool returns oauth_not_connected when an authenticated read action is called without a token', async () => {
  const context = baseContext({
    secretsStore: {
      hasToolSecret: async () => false,
      getToolSecret: async () => undefined,
      setToolSecret: async () => ({ success: true }),
      deleteToolSecrets: async () => undefined,
    },
  });
  const result = await metaToolModule.execute(
    { toolId: 'meta', actionId: 'meta.list_pages', input: {} },
    context,
  );
  assert.equal(result.success, false);
  assert.equal(result.technicalCode, 'meta_oauth_not_connected');
});

test('ForgerBackendClient.exchangeMetaOAuthCode posts to the Meta token path with the client and code', async () => {
  const previousFetch = globalThis.fetch;
  let recordedUrl;
  let recordedBody;
  globalThis.fetch = async (url, init) => {
    recordedUrl = url;
    recordedBody = init?.body ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ access_token: 'short-lived', expires_in: 3600 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = new ForgerBackendClient({
      backendBaseUrl: 'https://platform.test',
      localCatalogJsonUrl: () => undefined,
      token: () => 'forger-session-token',
      mapBackendCategory: () => 'productividad',
      toCatalogStatus: () => 'not_installed',
      getUserMessage: () => undefined,
      platform: () => 'darwin_arm64',
      desktopVersion: () => '0.1.test',
      reportingLogPath: () => '/tmp/forger-meta-test.log',
    });
    const response = await client.exchangeMetaOAuthCode({
      clientId: 'meta-client-id',
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:7861/oauth/meta/callback',
    });
    assert.equal(recordedUrl, 'https://platform.test/api/v1/oauth/meta/token');
    assert.equal(recordedBody.client_id, 'meta-client-id');
    assert.equal(recordedBody.code, 'auth-code');
    assert.equal(recordedBody.code_verifier, 'verifier');
    assert.equal(recordedBody.redirect_uri, 'http://127.0.0.1:7861/oauth/meta/callback');
    assert.equal(response.access_token, 'short-lived');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('ForgerBackendClient.refreshMetaOAuthAccessToken posts the long-lived exchange to the refresh path', async () => {
  const previousFetch = globalThis.fetch;
  let recordedUrl;
  let recordedBody;
  globalThis.fetch = async (url, init) => {
    recordedUrl = url;
    recordedBody = init?.body ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify({ access_token: 'long-lived', expires_in: 5184000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = new ForgerBackendClient({
      backendBaseUrl: 'https://platform.test',
      localCatalogJsonUrl: () => undefined,
      token: () => 'forger-session-token',
      mapBackendCategory: () => 'productividad',
      toCatalogStatus: () => 'not_installed',
      getUserMessage: () => undefined,
      platform: () => 'darwin_arm64',
      desktopVersion: () => '0.1.test',
      reportingLogPath: () => '/tmp/forger-meta-test.log',
    });
    const response = await client.refreshMetaOAuthAccessToken({
      clientId: 'meta-client-id',
      userToken: 'current-long-lived-token',
    });
    assert.equal(recordedUrl, 'https://platform.test/api/v1/oauth/meta/refresh');
    assert.equal(recordedBody.client_id, 'meta-client-id');
    assert.equal(recordedBody.user_token, 'current-long-lived-token');
    assert.equal(response.access_token, 'long-lived');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
