import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');

const createClient = (root, fetchImpl, token = undefined) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new ForgerBackendClient({
    backendBaseUrl: 'https://platform.test',
    localCatalogJsonUrl: () => undefined,
    token: () => token,
    mapBackendCategory: () => 'productividad',
    toCatalogStatus: () => 'not_installed',
    getUserMessage: () => undefined,
    platform: () => 'darwin_arm64',
    desktopVersion: () => '0.1.test',
    reportingLogPath: () => join(root, 'reporting.log'),
  });
  return {
    client,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
};

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json',
    ...headers,
  },
});

const readLogEntries = async (root) => {
  const raw = await readFile(join(root, 'reporting.log'), 'utf8');
  return raw.trim().split('\n').map((line) => JSON.parse(line));
};

test('updateAccountProfile sends username with the current Forger token and parses the account payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-profile-test-'));
  let requestUrl;
  let requestInit;
  const harness = createClient(root, async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return jsonResponse(200, {
      authenticated: true,
      user: {
        id: 7,
        email: 'felipe@example.com',
        username: 'felipe_cloud',
        confirmed: true,
        subscription_tier: 'free',
      },
    });
  }, 'session-token');

  try {
    const result = await harness.client.updateAccountProfile({ username: 'felipe_cloud' });

    assert.equal(requestUrl, 'https://platform.test/api/v1/me/profile');
    assert.equal(requestInit.method, 'PATCH');
    assert.equal(requestInit.headers.Authorization, 'Bearer session-token');
    assert.equal(JSON.parse(requestInit.body).username, 'felipe_cloud');
    assert.equal(result.success, true);
    assert.equal(result.user.username, 'felipe_cloud');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitProductFeedback normalizes platform in main and logs successful attempts without the body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-feedback-test-'));
  let requestBody;
  const harness = createClient(root, async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse(201, { id: 12, status: 'open' }, { 'x-request-id': 'req-success' });
  });

  try {
    const result = await harness.client.submitProductFeedback({
      target: 'forger',
      kind: 'other',
      body: 'private feedback text',
      platform: 'MacIntel',
      surface: 'feedback',
    });

    assert.equal(result.success, true);
    assert.equal(requestBody.platform, 'darwin_arm64');
    assert.equal(requestBody.desktop_version, '0.1.test');

    const [entry] = await readLogEntries(root);
    assert.equal(entry.event, 'feedback:submit_success');
    assert.equal(entry.platform, 'darwin_arm64');
    assert.equal(entry.requestId, 'req-success');
    assert.equal(JSON.stringify(entry).includes('private feedback text'), false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitProductFeedback logs validation failures with safe error keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-feedback-test-'));
  const harness = createClient(root, async () => jsonResponse(
    422,
    { errors: { platform: ['is not included in the list'] }, error_keys: ['platform'] },
    { 'x-request-id': 'req-422' },
  ));

  try {
    const result = await harness.client.submitProductFeedback({
      target: 'forger',
      kind: 'other',
      body: 'private feedback text',
    });

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'feedback_failed_422');
    assert.equal(result.details.httpStatus, 422);
    assert.equal(result.details.requestId, 'req-422');
    assert.deepEqual(result.details.validationErrors, { platform: ['is not included in the list'] });

    const [entry] = await readLogEntries(root);
    assert.equal(entry.event, 'feedback:submit_failed');
    assert.equal(entry.httpStatus, 422);
    assert.deepEqual(entry.validationErrors, { platform: ['is not included in the list'] });
    assert.equal(JSON.stringify(entry).includes('private feedback text'), false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitProductFeedback logs network failures as reportable diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-feedback-test-'));
  const harness = createClient(root, async () => {
    throw new TypeError('fetch failed');
  });

  try {
    const result = await harness.client.submitProductFeedback({
      target: 'forger',
      kind: 'other',
      body: 'private feedback text',
    });

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'feedback_network_failed');
    assert.deepEqual(result.details, { reason: 'network_or_fetch_error' });

    const [entry] = await readLogEntries(root);
    assert.equal(entry.event, 'feedback:submit_failed');
    assert.equal(entry.technicalCode, 'feedback_network_failed');
    assert.equal(entry.errorName, 'TypeError');
    assert.equal(JSON.stringify(entry).includes('private feedback text'), false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitDesktopErrorReport logs failed report submissions without stack details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-feedback-test-'));
  const harness = createClient(root, async () => jsonResponse(500, { error: 'server_error' }, { 'x-request-id': 'req-report' }));

  try {
    const result = await harness.client.submitDesktopErrorReport({
      source: 'renderer',
      operation: 'window.error',
      message: 'Visible failure',
      technicalCode: 'renderer_window_error',
      occurredAt: '2026-05-17T00:00:00.000Z',
      sensitiveDetails: { stack: 'private stack' },
    });

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'desktop_error_report_failed_500');

    const [entry] = await readLogEntries(root);
    assert.equal(entry.event, 'desktop_error_report:submit_failed');
    assert.equal(entry.httpStatus, 500);
    assert.equal(entry.requestId, 'req-report');
    assert.equal(JSON.stringify(entry).includes('private stack'), false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitUsageEvent sends allowlisted parameters without user content fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-usage-test-'));
  let requestBody;
  const harness = createClient(root, async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse(201, { id: 9, event_name: 'app_opened' }, { 'x-request-id': 'req-usage' });
  });

  try {
    const result = await harness.client.submitUsageEvent({
      eventName: 'app_opened',
      installationIdentifier: 'installation-test',
      surface: 'app',
      locale: 'es',
      stringParameters: { app_id: 'finance-os' },
      intParameters: { duration_ms: 120 },
    });

    assert.equal(result.success, true);
    assert.equal(requestBody.event_name, 'app_opened');
    assert.equal(requestBody.installation_identifier, 'installation-test');
    assert.equal(requestBody.desktop_version, '0.1.test');
    assert.equal(requestBody.platform, 'darwin_arm64');
    assert.deepEqual(requestBody.string_parameters, { app_id: 'finance-os' });
    assert.deepEqual(requestBody.int_parameters, { duration_ms: 120 });
    assert.equal('user_id' in requestBody, false);
    assert.equal('prompt' in requestBody, false);
    assert.equal('message' in requestBody, false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitUsageEvent logs failed attempts without parameter values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-usage-test-'));
  const harness = createClient(root, async () => jsonResponse(
    422,
    { errors: { string_parameters: ['contains unsupported keys'] } },
    { 'x-request-id': 'req-usage-422' },
  ));

  try {
    const result = await harness.client.submitUsageEvent({
      eventName: 'app_opened',
      installationIdentifier: 'installation-test',
      surface: 'app',
      stringParameters: { app_id: 'finance-os' },
    });

    assert.equal(result.success, false);
    assert.equal(result.technicalCode, 'usage_event_failed_422');
    assert.equal(result.details.requestId, 'req-usage-422');

    const [entry] = await readLogEntries(root);
    assert.equal(entry.event, 'usage_event:submit_failed');
    assert.equal(entry.eventName, 'app_opened');
    assert.equal(entry.requestId, 'req-usage-422');
    assert.equal(JSON.stringify(entry).includes('finance-os'), false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('getGoogleLoginOAuthClientId reads the public Google login config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-google-login-test-'));
  const harness = createClient(root, async (url) => {
    assert.equal(url, 'https://platform.test/api/v1/oauth/google/config');
    return jsonResponse(200, { client_id: 'forger-cloud.apps.googleusercontent.com' });
  });

  try {
    const clientId = await harness.client.getGoogleLoginOAuthClientId();
    assert.equal(clientId, 'forger-cloud.apps.googleusercontent.com');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('createGoogleLoginSession returns the existing Forger account session shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-google-login-test-'));
  let requestBody;
  const harness = createClient(root, async (url, init) => {
    assert.equal(url, 'https://platform.test/api/v1/oauth/google/session');
    requestBody = JSON.parse(init.body);
    return jsonResponse(201, {
      authenticated: true,
      token: 'forger-token',
      user: {
        id: 7,
        email: 'user@example.com',
        username: 'user',
        confirmed: true,
        subscription_tier: 'free',
      },
    });
  });

  try {
    const result = await harness.client.createGoogleLoginSession({
      clientId: 'client-id',
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:1234/oauth/google/callback',
    });

    assert.equal(result.success, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.token, 'forger-token');
    assert.equal(result.user.email, 'user@example.com');
    assert.deepEqual(requestBody, {
      client_id: 'client-id',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: 'http://127.0.0.1:1234/oauth/google/callback',
    });
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('createGoogleLoginSession maps backend Google login failures to a safe result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-google-login-test-'));
  const harness = createClient(root, async () => jsonResponse(403, { error: 'google_login_email_unverified' }));

  try {
    const result = await harness.client.createGoogleLoginSession({
      clientId: 'client-id',
      code: 'code',
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:1234/oauth/google/callback',
    });

    assert.equal(result.success, false);
    assert.equal(result.authenticated, false);
    assert.equal(result.technicalCode, 'google_login_failed_403');
    assert.equal(result.userMessage, 'Google no confirmo este correo.');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});
