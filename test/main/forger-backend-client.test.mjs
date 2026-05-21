import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');
const { defaultReportingLogPath } = require('../../dist-electron/main/forger-backend/client-helpers.js');

const withPlatform = async (platform, operation) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
};

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

test('backend helper default reporting path covers macOS app support storage', async () => {
  const logPath = await withPlatform('darwin', async () => defaultReportingLogPath());

  assert.match(logPath, /Library\/Application Support\/forger-desktop\/logs\/reporting\.log$/);
});

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
        username_changed_at: '2026-05-18T12:00:00Z',
        username_change_available_at: '2026-06-17T12:00:00Z',
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
    assert.equal(result.user.usernameChangedAt, '2026-05-18T12:00:00Z');
    assert.equal(result.user.usernameChangeAvailableAt, '2026-06-17T12:00:00Z');
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

test('remote backup cloud calls normalize lists, upload archives, download files, and map delete failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-remote-backups-test-'));
  const archivePath = join(root, 'backup.zip');
  const downloadPath = join(root, 'downloaded.zip');
  await writeFile(archivePath, Buffer.from('zip-bytes'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'GET') {
      assert.equal(parsed.searchParams.get('app_id'), 'finance-os');
      return jsonResponse(200, {
        backups: [
          {
            id: '101',
            app_id: 'finance-os',
            app_name: 'Finance OS',
            app_version: '1.0.0',
            backup_type: 'sync_snapshot',
            source: 'auto_sync',
            metadata: { reason: 'scheduled' },
            file_count: '2',
            total_bytes: '32',
            checksum_sha256: 'checksum',
            created_at: '2026-05-21T00:00:00Z',
          },
          { id: 'bad' },
        ],
        usage: {
          used_bytes: '32',
          limit_bytes: '100',
          backup_count: '1',
          backup_count_limit: '5',
        },
      });
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'POST') {
      assert.equal(init.headers.Authorization, 'Bearer session-token');
      assert.equal('Content-Type' in init.headers, false);
      assert.equal(init.body.get('app_id'), 'finance-os');
      assert.equal(init.body.get('metadata'), JSON.stringify({
        local_backup_id: 'local-1',
        reason: 'manual',
        files: ['db.sqlite'],
      }));
      const archive = init.body.get('archive');
      assert.equal(Buffer.from(await archive.arrayBuffer()).toString('utf8'), 'zip-bytes');
      return jsonResponse(201, {
        id: 102,
        app_id: 'finance-os',
        app_name: 'Finance OS',
        backup_type: 'backup',
        source: 'manual',
        file_count: 1,
        total_bytes: 9,
        checksum_sha256: 'uploaded-checksum',
        created_at: '2026-05-21T00:01:00Z',
      });
    }
    if (parsed.pathname === '/api/v1/me/backups/102/download') {
      return new Response(Buffer.from('downloaded-zip'), {
        status: 200,
        headers: { 'X-Forger-Backup-Sha256': 'download-checksum' },
      });
    }
    if (parsed.pathname === '/api/v1/me/backups/102' && init.method === 'DELETE') {
      return jsonResponse(403, { error: 'forbidden' });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const listed = await harness.client.listRemoteBackups('finance-os');
    assert.equal(listed.backups.length, 1);
    assert.equal(listed.backups[0].id, 101);
    assert.equal(listed.backups[0].backupType, 'sync_snapshot');
    assert.deepEqual(listed.usage, {
      usedBytes: 32,
      limitBytes: 100,
      backupCount: 1,
      backupCountLimit: 5,
    });

    const uploaded = await harness.client.createRemoteBackup({
      archivePath,
      backupType: 'backup',
      source: 'manual',
      localBackup: {
        backupId: 'local-1',
        appId: 'finance-os',
        appName: 'Finance OS',
        appVersion: '1.0.0',
        createdAt: '2026-05-21T00:00:00Z',
        reason: 'manual',
        fileCount: 1,
        totalBytes: 9,
        files: ['db.sqlite'],
      },
    });
    assert.equal(uploaded.success, true);
    assert.equal(uploaded.remoteBackup.id, 102);

    const downloaded = await harness.client.downloadRemoteBackup(102, downloadPath);
    assert.deepEqual(downloaded, { checksumSha256: 'download-checksum' });
    assert.equal(await readFile(downloadPath, 'utf8'), 'downloaded-zip');

    const deleted = await harness.client.deleteRemoteBackup(102);
    assert.equal(deleted.success, false);
    assert.equal(deleted.technicalCode, 'remote_backup_delete_failed_403');
    assert.equal(requests.every((request) => request.init.headers.Authorization === 'Bearer session-token'), true);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('catalog, account, and OAuth config methods cover local fallbacks and safe failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-backend-fallbacks-'));
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/catalog/apps') {
      throw new TypeError('backend offline');
    }
    if (url === 'https://public.test/catalog.json') {
      return jsonResponse(200, [{
        slug: 'local-app',
        name: 'Local App',
        description: 'Local catalog item',
        category: 'productivity',
        latest_version: {
          version: '1.0.0',
          status: 'published',
          published_at: '2026-05-21T00:00:00Z',
          platforms: [],
        },
      }]);
    }
    if (parsed.pathname === '/api/v1/users') {
      return jsonResponse(422, { errors: { email: ['taken'] } });
    }
    if (parsed.pathname === '/api/v1/session' && init.method === 'POST') {
      return jsonResponse(403, { error: 'unconfirmed' });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/config') {
      return jsonResponse(200, { client_id: '   ' });
    }
    if (parsed.pathname === '/api/v1/oauth/google/config') {
      return jsonResponse(500, { error: 'missing_config' });
    }
    return jsonResponse(404, { error: 'not_found' });
  });
  harness.client.options.localCatalogJsonUrl = () => 'https://public.test/catalog.json';

  try {
    const catalog = await harness.client.listCatalogApps();
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, 'local-app');

    const registered = await harness.client.registerAccount({
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
      email: 'ada@example.com',
      password: 'secret',
      country: 'CL',
      age: 30,
      gender: 'prefer_not_to_say',
      locale: 'es',
    });
    assert.equal(registered.success, false);
    assert.equal(registered.technicalCode, 'register_failed_422');

    const loggedIn = await harness.client.loginAccount({
      email: 'ada@example.com',
      password: 'secret',
      locale: 'es',
    });
    assert.equal(loggedIn.success, false);
    assert.equal(loggedIn.confirmationRequired, true);
    assert.equal(loggedIn.technicalCode, 'login_failed_403');

    await assert.rejects(
      () => harness.client.getGmailOAuthClientId(),
      (error) => error.technicalCode === 'gmail_oauth_client_missing',
    );
    await assert.rejects(
      () => harness.client.getGoogleLoginOAuthClientId(),
      (error) => error.technicalCode === 'google_login_config_failed_500',
    );

    assert.equal(requests.some((request) => request.url === 'https://public.test/catalog.json'), true);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('account, catalog, rating, and download methods cover success and malformed response branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-backend-account-success-'));
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/catalog/apps') {
      return jsonResponse(200, [
        {
          slug: 'finance-os',
          name: 'Finance OS',
          description: 'Backend catalog item',
          category: 'finance',
          latest_version: {
            version: '2.0.0',
            status: 'published',
            published_at: '2026-05-21T00:00:00Z',
            platforms: [],
          },
        },
      ]);
    }
    if (url === 'https://public.test/catalog.json') {
      return jsonResponse(200, [
        {
          slug: 'finance-os',
          name: 'Duplicate Finance OS',
          description: 'Duplicate local entry',
          latest_version: { version: '1.0.0', status: 'published', platforms: [] },
        },
        {
          slug: 'recipes',
          name: 'Recipes',
          description: 'Local recipe app',
          latest_version: { version: '1.1.0', status: 'published', platforms: [] },
        },
      ]);
    }
    if (parsed.pathname === '/api/v1/users') {
      const body = JSON.parse(init.body);
      assert.equal(body.password_confirmation, body.password);
      return jsonResponse(201, {
        authenticated: true,
        token: 'registered-token',
        user: { id: 3, email: body.email, username: body.username, confirmed: false },
      });
    }
    if (parsed.pathname === '/api/v1/session' && init.method === 'POST') {
      return jsonResponse(200, {
        authenticated: true,
        token: 'login-token',
        user: { id: 3, email: 'ada@example.com', username: 'ada', confirmed: true },
      });
    }
    if (parsed.pathname === '/api/v1/session' && init.method === 'DELETE') {
      return new Response('', { status: 204 });
    }
    if (parsed.pathname === '/api/v1/catalog/apps/finance-os/rating') {
      return jsonResponse(200, { id: 12, score: 5, comment: 'Useful' });
    }
    if (parsed.pathname === '/api/v1/catalog/apps/recipes/rating') {
      return jsonResponse(403, { error: 'confirmation_required' });
    }
    if (parsed.pathname === '/api/v1/app_versions/42/download') {
      return jsonResponse(200, {
        download_url: 'https://downloads.test/finance-os.zip',
        version: { version: '2.0.0', checksum_sha256: 'abc' },
      });
    }
    if (parsed.pathname === '/api/v1/app_versions/43/download') {
      return jsonResponse(503, { error: 'offline' });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');
  harness.client.options.localCatalogJsonUrl = () => 'https://public.test/catalog.json';

  try {
    const catalog = await harness.client.listCatalogApps();
    assert.deepEqual(catalog.map((app) => app.id), ['finance-os', 'recipes']);
    assert.equal(catalog[0].name, 'Finance OS');

    const registered = await harness.client.registerAccount({
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
      email: 'ada@example.com',
      password: 'secret',
      country: 'CL',
      age: 30,
      gender: 'prefer_not_to_say',
      locale: 'es',
    });
    assert.equal(registered.success, true);
    assert.equal(registered.confirmationRequired, true);
    assert.equal(registered.user.username, 'ada');

    const loggedIn = await harness.client.loginAccount({ email: 'ada@example.com', password: 'secret', locale: 'es' });
    assert.equal(loggedIn.success, true);
    assert.equal(loggedIn.token, 'login-token');

    await harness.client.logoutAccount();
    assert.equal(requests.some((request) => new URL(request.url).pathname === '/api/v1/session' && request.init.method === 'DELETE'), true);

    const rating = await harness.client.submitAppRating({ appId: 'finance-os', score: 5, comment: 'Useful', locale: 'es' });
    assert.equal(rating.success, true);
    assert.equal(rating.rating.score, 5);
    const blockedRating = await harness.client.submitAppRating({ appId: 'recipes', score: 4, locale: 'es' });
    assert.equal(blockedRating.success, false);
    assert.match(blockedRating.userMessage, /Confirma/);

    const download = await harness.client.requestDownload(42, { platform: 'darwin_arm64', deviceIdentifier: 'device-1' });
    assert.equal(download.download_url, 'https://downloads.test/finance-os.zip');
    await assert.rejects(() => harness.client.requestDownload(43, { platform: 'darwin_arm64', deviceIdentifier: 'device-1' }), /download_request_failed_503/);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote backup and Gmail OAuth backend helpers cover empty, signed, and invalid payload paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-backend-remote-edges-'));
  const archivePath = join(root, 'backup.zip');
  await writeFile(archivePath, Buffer.from('zip-bytes'));
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'GET' && parsed.searchParams.get('app_id') === 'array') {
      return jsonResponse(200, [
        { id: '5', app_id: 'array', app_name: 'Array App', backup_type: 'backup', source: 'manual' },
      ]);
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'GET' && parsed.searchParams.get('app_id') === 'null') {
      return new Response('', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'GET') {
      return jsonResponse(500, { error: 'offline' });
    }
    if (parsed.pathname === '/api/v1/me/backups' && init.method === 'POST') {
      assert.equal(init.body.get('signature'), 'sig');
      assert.equal(init.body.get('signature_key_fingerprint'), 'fp');
      assert.equal(init.body.get('signature_algorithm'), 'rsa');
      return jsonResponse(201, {
        id: '6',
        app_id: 'finance-os',
        app_name: 'Finance OS',
        backup_type: 'sync_snapshot',
        source: 'auto_sync',
        file_count: 1,
        total_bytes: 9,
      });
    }
    if (parsed.pathname === '/api/v1/me/backups/404/download') {
      return jsonResponse(404, { error: 'missing' });
    }
    if (parsed.pathname === '/api/v1/me/backups/6' && init.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/token') {
      return new Response('', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/refresh') {
      return new Response('not json', { status: 502 });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    assert.equal((await harness.client.listRemoteBackups('array')).backups[0].id, 5);
    assert.deepEqual(await harness.client.listRemoteBackups('null'), {
      backups: [],
      usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
    });
    assert.deepEqual(await harness.client.listRemoteBackups('failed'), {
      backups: [],
      usage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
    });

    const uploaded = await harness.client.createRemoteBackup({
      archivePath,
      backupType: 'sync_snapshot',
      source: 'auto_sync',
      signature: 'sig',
      signatureKeyFingerprint: 'fp',
      signatureAlgorithm: 'rsa',
      localBackup: {
        backupId: 'local-1',
        appId: 'finance-os',
        appName: 'Finance OS',
        appVersion: '1.0.0',
        createdAt: '2026-05-21T00:00:00Z',
        reason: 'manual',
        fileCount: 1,
        totalBytes: 9,
        files: ['db.sqlite'],
      },
    });
    assert.equal(uploaded.success, true);
    assert.match(uploaded.userMessage, /sincronizados/);

    await assert.rejects(() => harness.client.downloadRemoteBackup(404, join(root, 'missing.zip')), /remote_backup_download_failed_404/);
    assert.deepEqual(await harness.client.deleteRemoteBackup(6), { success: true, userMessage: 'Respaldo cloud eliminado.' });
    await assert.rejects(
      () => harness.client.exchangeGmailOAuthCode({
        clientId: 'client-id',
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1/callback',
      }),
      (error) => error.technicalCode === 'gmail_oauth_backend_response_invalid',
    );
    await assert.rejects(
      () => harness.client.refreshGmailOAuthAccessToken({ clientId: 'client-id', refreshToken: 'refresh-token' }),
      (error) => error.technicalCode === 'gmail_oauth_backend_failed_502',
    );
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('backend client maps profile cooldowns, OAuth token posts, device failures, and reporting network failures safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-backend-branches-'));
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/profile') {
      return jsonResponse(429, {
        error: 'username_change_cooldown',
        username_change_available_at: '2026-06-21T00:00:00Z',
      });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/token') {
      const body = JSON.parse(init.body);
      assert.equal(body.code, 'oauth-code');
      return jsonResponse(502, { error: 'upstream' });
    }
    if (parsed.pathname === '/api/v1/oauth/gmail/refresh') {
      const body = JSON.parse(init.body);
      assert.equal(body.refresh_token, 'refresh-token');
      return jsonResponse(200, { access_token: 'access-token' });
    }
    if (parsed.pathname === '/api/v1/me/devices/register') {
      return jsonResponse(401, { error: 'expired' });
    }
    if (parsed.pathname === '/api/v1/me/devices') {
      return jsonResponse(200, { devices: 'not-array' });
    }
    if (parsed.pathname === '/api/v1/me/devices/7/pairing_codes') {
      return jsonResponse(500, { error: 'failed' });
    }
    if (parsed.pathname === '/api/v1/usage_events') {
      throw new TypeError('usage offline');
    }
    if (parsed.pathname === '/api/v1/desktop_error_reports') {
      throw new TypeError('reports offline');
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const profile = await harness.client.updateAccountProfile({ username: 'new_name' });
    assert.equal(profile.success, false);
    assert.equal(profile.authenticated, true);
    assert.equal(profile.technicalCode, 'profile_update_failed_429');
    assert.match(profile.userMessage, /21\/06\/2026|2026/);

    await assert.rejects(
      () => harness.client.exchangeGmailOAuthCode({
        clientId: 'client-id',
        code: 'oauth-code',
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1/callback',
      }),
      (error) => error.technicalCode === 'upstream',
    );
    assert.deepEqual(await harness.client.refreshGmailOAuthAccessToken({
      clientId: 'client-id',
      refreshToken: 'refresh-token',
    }), { access_token: 'access-token' });

    await assert.rejects(
      () => harness.client.registerDevice({
        deviceUid: 'device',
        deviceSecret: 'secret',
        name: 'Mac',
        platform: 'darwin_arm64',
      }),
      (error) => error.technicalCode === 'device_register_failed_401',
    );
    assert.deepEqual(await harness.client.listDevices(), []);
    await assert.rejects(
      () => harness.client.createDevicePairingCode({
        deviceId: 7,
        codeDigest: 'digest',
        expiresAt: '2026-05-21T00:00:00Z',
      }),
      (error) => error.technicalCode === 'pairing_code_failed_500',
    );

    const usage = await harness.client.submitUsageEvent({
      eventName: 'app_opened',
      installationIdentifier: 'install',
      surface: 'app',
    });
    assert.equal(usage.success, false);
    assert.equal(usage.technicalCode, 'usage_event_network_failed');

    const report = await harness.client.submitDesktopErrorReport({
      source: 'main',
      operation: 'startup',
      message: 'Failed',
      technicalCode: 'startup_failed',
    });
    assert.equal(report.success, false);
    assert.equal(report.technicalCode, 'desktop_error_report_network_failed');

    const entries = await readLogEntries(root);
    assert.equal(entries.some((entry) => entry.event === 'usage_event:submit_failed'), true);
    assert.equal(entries.some((entry) => entry.event === 'desktop_error_report:submit_failed'), true);
    assert.equal(requests.some((request) => request.init.headers?.Authorization === 'Bearer session-token'), true);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});
