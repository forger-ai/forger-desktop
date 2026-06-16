/* eslint-disable max-lines */
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
    reportSanitizerRoots: () => [
      { alias: 'FORGER_HOME/', path: '/Users/felipe/Forger' },
      { alias: 'FORGER_APPS/', path: '/Users/felipe/Forger/apps' },
      { alias: 'FORGER_DATA/', path: '/Users/felipe/Forger/data' },
    ],
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

test('updateAccountProfile sends username and display name with the current Forger token and parses the account payload', async () => {
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
        display_name: 'Felipe Cloud',
        confirmed: true,
        subscription_tier: 'free',
        username_changed_at: '2026-05-18T12:00:00Z',
        username_change_available_at: '2026-06-17T12:00:00Z',
      },
    });
  }, 'session-token');

  try {
    const result = await harness.client.updateAccountProfile({ username: 'felipe_cloud', displayName: 'Felipe Cloud' });

    assert.equal(requestUrl, 'https://platform.test/api/v1/me/profile');
    assert.equal(requestInit.method, 'PATCH');
    assert.equal(requestInit.headers.Authorization, 'Bearer session-token');
    assert.equal(JSON.parse(requestInit.body).username, 'felipe_cloud');
    assert.equal(JSON.parse(requestInit.body).display_name, 'Felipe Cloud');
    assert.equal(result.success, true);
    assert.equal(result.user.username, 'felipe_cloud');
    assert.equal(result.user.displayName, 'Felipe Cloud');
    assert.equal(result.user.usernameChangedAt, '2026-05-18T12:00:00Z');
    assert.equal(result.user.usernameChangeAvailableAt, '2026-06-17T12:00:00Z');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('updateSocialAppVisibility patches owned user app visibility and normalizes the app payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-visibility-test-'));
  let requestUrl;
  let requestInit;
  const harness = createClient(root, async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return jsonResponse(200, {
      id: 42,
      slug: 'focus-flow',
      name: 'Focus Flow',
      visibility: 'friends',
      status: 'published',
      owner: { id: 7, username: 'felipe_cloud', display_name: 'Felipe Cloud' },
    });
  }, 'session-token');

  try {
    const result = await harness.client.updateSocialAppVisibility(42, 'friends');

    assert.equal(requestUrl, 'https://platform.test/api/v1/me/user_apps/42');
    assert.equal(requestInit.method, 'PATCH');
    assert.equal(requestInit.headers.Authorization, 'Bearer session-token');
    assert.equal(JSON.parse(requestInit.body).visibility, 'friends');
    assert.equal(result.id, 42);
    assert.equal(result.visibility, 'friends');
    assert.equal(result.owner.displayName, 'Felipe Cloud');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('mobile desktop authorization client lists and revokes mobile links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-mobile-auth-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    if (init.method === 'DELETE') {
      return jsonResponse(200, { success: true });
    }
    return jsonResponse(200, [
      {
        id: 9,
        mobile_device_id: 12,
        desktop_device_id: 7,
        active: true,
        mobile_device: {
          id: 12,
          device_uid: 'mobile-12',
          name: 'Felipe iPhone',
          device_kind: 'mobile',
          platform: 'ios',
          paired: true,
          online: false,
        },
        desktop_device: {
          id: 7,
          device_uid: 'desktop-7',
          name: 'Studio Mac',
          device_kind: 'desktop',
          paired: true,
          online: true,
        },
      },
    ]);
  }, 'session-token');

  try {
    const authorizations = await harness.client.listMobileDesktopAuthorizations();
    await harness.client.revokeMobileDesktopAuthorization(9);

    assert.equal(authorizations.length, 1);
    assert.equal(authorizations[0].mobileDevice.name, 'Felipe iPhone');
    assert.equal(authorizations[0].desktopDeviceId, 7);
    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/mobile_desktop_authorizations');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer session-token');
    assert.equal(requests[1].url, 'https://platform.test/api/v1/me/mobile_desktop_authorizations/9');
    assert.equal(requests[1].init.method, 'DELETE');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('mobile pairing request client deletes terminal requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-mobile-pairing-delete-test-'));
  let requestUrl;
  let requestInit;
  const harness = createClient(root, async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return jsonResponse(200, { success: true });
  }, 'session-token');

  try {
    await harness.client.deleteMobilePairingRequest(22);

    assert.equal(requestUrl, 'https://platform.test/api/v1/me/mobile_pairing_requests/22');
    assert.equal(requestInit.method, 'DELETE');
    assert.equal(requestInit.headers.Authorization, 'Bearer session-token');
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

test('submitDesktopErrorReport sanitizes report payload before sending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-error-sanitize-test-'));
  let requestBody;
  const harness = createClient(root, async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse(201, { id: 1, status: 'open' });
  });

  try {
    const result = await harness.client.submitDesktopErrorReport({
      source: 'agent',
      operation: 'chat.start-run',
      message: 'Failed at /Users/felipe/Desktop/random.pdf',
      technicalCode: 'chat_start_run_failed',
      occurredAt: '2026-05-17T00:00:00.000Z',
      details: { path: '/Users/felipe/Forger/data/import.csv' },
      sensitiveDetails: { stack: 'Bearer sk-private-token\nat /Users/felipe/Desktop/random.pdf' },
    });

    assert.equal(result.success, true);
    const text = JSON.stringify(requestBody);
    assert.equal(text.includes('/Users/felipe/Desktop'), false);
    assert.equal(text.includes('sk-private-token'), false);
    assert.equal(requestBody.details.path, 'FORGER_DATA/import.csv');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitConversationDiagnosticReport posts sanitized thread payload with auth token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-conversation-report-test-'));
  let requestUrl;
  let requestInit;
  const harness = createClient(root, async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return jsonResponse(201, { id: 42, status: 'open' }, { 'x-request-id': 'req-conv' });
  }, 'cloud-token');

  try {
    const result = await harness.client.submitConversationDiagnosticReport({
      source: 'desktop_chat',
      appId: 'finance-os',
      conversationId: 'conversation-1',
      runId: 'run-1',
      description: 'Please inspect the provider session details.',
      provider: 'codex',
      desktopVersion: '0.1.test',
      platform: 'darwin',
      occurredAt: '2026-05-17T00:00:00.000Z',
      payload: {
        rawRunLog: { text: 'Bearer sk-private-token at /Users/felipe/Desktop/random.pdf' },
        conversation: { messages: [{ role: 'user', content: '/Users/felipe/Forger/apps/finance-os/file.py' }] },
      },
    });

    assert.equal(result.success, true);
    assert.equal(requestUrl, 'https://platform.test/api/v1/conversation_diagnostic_reports');
    assert.equal(requestInit.headers.Authorization, 'Bearer cloud-token');
    const body = JSON.parse(requestInit.body);
    const text = JSON.stringify(body);
    assert.equal(body.description, 'Please inspect the provider session details.');
    assert.equal(text.includes('/Users/felipe/Desktop'), false);
    assert.equal(text.includes('sk-private-token'), false);
    assert.equal(text.includes('FORGER_APPS/finance-os'), true);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('submitConversationDiagnosticReport uploads sanitized diagnostic files as multipart attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-conversation-report-upload-test-'));
  let requestInit;
  const harness = createClient(root, async (_url, init) => {
    requestInit = init;
    return jsonResponse(201, { id: 43, status: 'open' }, { 'x-request-id': 'req-conv-upload' });
  }, 'cloud-token');

  try {
    const result = await harness.client.submitConversationDiagnosticReport({
      source: 'desktop_chat',
      appId: 'finance-os',
      conversationId: 'conversation-1',
      provider: 'codex',
      desktopVersion: '0.1.test',
      platform: 'darwin',
      occurredAt: '2026-05-17T00:00:00.000Z',
      payload: {
        conversation: { messages: [{ role: 'user', content: 'debug upload' }] },
        diagnosticFiles: [{ kind: 'codex_session_jsonl', filename: 'codex-session-thread-1.jsonl' }],
      },
    }, [{
      kind: 'codex_session_jsonl',
      filename: 'codex-session-thread-1.jsonl',
      contentType: 'application/x-ndjson',
      originalByteSize: 91,
      sanitizedByteSize: 64,
      text: '{"type":"session_meta","payload":{"id":"thread-1"}}\n',
    }]);

    assert.equal(result.success, true);
    assert.equal(requestInit.headers.Authorization, 'Bearer cloud-token');
    assert.equal(requestInit.headers['Content-Type'], undefined);
    assert.equal(requestInit.body instanceof FormData, true);
    assert.equal(requestInit.body.get('source'), 'desktop_chat');
    assert.equal(requestInit.body.get('conversation_id'), 'conversation-1');
    assert.equal(JSON.parse(requestInit.body.get('payload')).diagnosticFiles[0].filename, 'codex-session-thread-1.jsonl');
    const files = requestInit.body.getAll('diagnostic_files[]');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'codex-session-thread-1.jsonl');
    assert.equal(files[0].type, 'application/x-ndjson');
    assert.equal(await files[0].text(), '{"type":"session_meta","payload":{"id":"thread-1"}}\n');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('remote tunnel session client creates, uploads, reports, closes, and hides best-effort failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-remote-tunnel-client-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/api/v1/me/remote_tunnel_sessions/7/upload_frontend')) {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, 'Bearer session-token');
      assert.equal(init.headers['Content-Type'], undefined);
      assert.equal(init.body instanceof FormData, true);
      assert.equal(init.body.get('frontend_hash'), 'hash-1');
      assert.equal(init.body.get('tunnel_url'), 'https://finance.loca.lt');
      assert.equal(JSON.parse(init.body.get('desktop_public_key_jwk')).kty, 'EC');
      assert.deepEqual(init.body.getAll('asset_paths[]'), ['index.html']);
      return jsonResponse(200, { frontend_url: '/remote-assets/session/' });
    }
    return jsonResponse(200, { id: 7, session_id: 'session-1' });
  }, 'session-token');

  try {
    assert.deepEqual(await harness.client.createRemoteTunnelSession({ deviceId: 5, appId: 'finance-os' }), {
      id: 7,
      session_id: 'session-1',
    });
    assert.deepEqual(await harness.client.uploadRemoteTunnelFrontend({
      sessionId: 7,
      assets: [{ path: 'index.html', data: Buffer.from('<html></html>'), type: 'text/html' }],
      frontendHash: 'hash-1',
      tunnelUrl: 'https://finance.loca.lt',
      desktopPublicKeyJwk: { kty: 'EC' },
    }), { frontend_url: '/remote-assets/session/' });
    await harness.client.reportRemoteTunnelSession({
      sessionId: 7,
      status: 'connected',
      tunnelUrl: 'https://finance.loca.lt',
      connectionCount: 2,
      lastError: 'none',
    });
    await harness.client.closeRemoteTunnelSession(7);

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/remote_tunnel_sessions');
    assert.equal(requests[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].init.body), { device_id: 5, app_id: 'finance-os' });
    assert.equal(requests[2].url, 'https://platform.test/api/v1/me/remote_tunnel_sessions/7/report');
    assert.equal(requests[2].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[2].init.body), {
      status: 'connected',
      tunnel_url: 'https://finance.loca.lt',
      connection_count: 2,
      last_error: 'none',
    });
    assert.equal(requests[3].url, 'https://platform.test/api/v1/me/remote_tunnel_sessions/7/close');
    assert.equal(requests[3].init.method, 'POST');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }

  const failingUpload = createClient(root, async () => jsonResponse(422, { error: 'bad_assets' }), 'session-token');
  try {
    await assert.rejects(
      () => failingUpload.client.uploadRemoteTunnelFrontend({
        sessionId: 7,
        assets: [],
        frontendHash: 'hash-1',
        tunnelUrl: 'https://finance.loca.lt',
        desktopPublicKeyJwk: { kty: 'EC' },
      }),
      /No pudimos subir el frontend remoto./,
    );
  } finally {
    failingUpload.restore();
  }

  const bestEffort = createClient(root, async () => {
    throw new TypeError('network down');
  }, 'session-token');
  try {
    await bestEffort.client.reportRemoteTunnelSession({ sessionId: 7, status: 'error' });
    await bestEffort.client.closeRemoteTunnelSession(7);
  } finally {
    bestEffort.restore();
  }
});

test('remote session request client reports mobile-visible Desktop preparation state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-remote-session-request-client-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, { success: true });
  }, 'session-token');

  try {
    await harness.client.reportRemoteSessionRequest({
      requestId: 'request-1',
      appId: 'finance-os',
      status: 'ready',
      remoteStatus: {
        active: true,
        appId: 'finance-os',
        state: 'waiting_for_session',
        sessionId: 'session-public-token',
        portalUrl: '/portal/tunnels/7',
        frontendUrl: '/remote-assets/session-public-token/',
        tunnelUrl: 'https://finance.loca.lt',
        connectionCount: 0,
        connections: [],
      },
      portalUrl: '/portal/tunnels/7',
      frontendUrl: '/remote-assets/session-public-token/',
    });

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/remote_session_requests/request-1/report');
    assert.equal(requests[0].init.method, 'PATCH');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer session-token');
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      app_id: 'finance-os',
      status: 'ready',
      remote_status: {
        active: true,
        appId: 'finance-os',
        state: 'waiting_for_session',
        sessionId: 'session-public-token',
        portalUrl: '/portal/tunnels/7',
        frontendUrl: '/remote-assets/session-public-token/',
        tunnelUrl: 'https://finance.loca.lt',
        connectionCount: 0,
        connections: [],
      },
      portal_url: '/portal/tunnels/7',
      frontend_url: '/remote-assets/session-public-token/',
    });
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }

  const failingReport = createClient(root, async () => jsonResponse(404, { error: 'not_found' }), 'session-token');
  try {
    await failingReport.client.reportRemoteSessionRequest({
      requestId: 'request-2',
      appId: 'finance-os',
      status: 'error',
      technicalCode: 'remote_tunnel_not_supported',
    });
  } finally {
    failingReport.restore();
  }
});

test('app access request client reports local network and remote tunnel status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-app-access-request-client-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, { success: true });
  }, 'session-token');

  try {
    await harness.client.reportAppAccessRequest({
      requestId: '101',
      appId: 'finance-os',
      status: 'ready',
      accessStatus: {
        active: true,
        appId: 'finance-os',
        url: 'http://192.168.1.10:5000',
        connectUrl: 'http://192.168.1.10:5000/connect/token',
      },
    });
    await harness.client.reportAppAccessRequest({
      requestId: '102',
      appId: 'finance-os',
      status: 'ready',
      accessStatus: {
        active: true,
        appId: 'finance-os',
        state: 'waiting_for_session',
        sessionId: 'session-public-token',
        frontendUrl: '/remote-assets/session-public-token/',
      },
    });

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/app_access_requests/101/report');
    assert.equal(requests[0].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      app_id: 'finance-os',
      status: 'ready',
      url: 'http://192.168.1.10:5000',
      connect_url: 'http://192.168.1.10:5000/connect/token',
    });
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      app_id: 'finance-os',
      status: 'ready',
      remote_status: {
        active: true,
        appId: 'finance-os',
        state: 'waiting_for_session',
        sessionId: 'session-public-token',
        frontendUrl: '/remote-assets/session-public-token/',
      },
      remote_session_id: 'session-public-token',
    });
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('agent access request client reports sanitized personal agent lifecycle status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-agent-access-request-client-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, { success: true });
  }, 'session-token');

  try {
    await harness.client.reportAgentAccessRequest({
      requestId: '301',
      agentId: 'agent-1',
      status: 'ready',
      agentStatus: {
        active: true,
        agentId: 'agent-1',
        state: 'ready',
        sessionId: 'agent-session-1',
        localUrl: 'http://127.0.0.1:4567',
        tunnelUrl: 'https://agent-session.example.test',
        authorizationToken: 'scoped-session-token',
        allowedPaths: ['/health', '/conversations/start', '/messages/send', '/conversations/:id'],
      },
    });

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/agent_access_requests/301/report');
    assert.equal(requests[0].init.method, 'PATCH');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer session-token');
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      agent_id: 'agent-1',
      status: 'ready',
      agent_status: {
        active: true,
        agent_id: 'agent-1',
        state: 'ready',
        session_id: 'agent-session-1',
        tunnel_url: 'https://agent-session.example.test',
        authorization_token: 'scoped-session-token',
        allowed_paths: ['/health', '/conversations/start', '/messages/send', '/conversations/:id'],
      },
    });
    assert.equal(requests[0].init.body.includes('127.0.0.1'), false);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('agent access request client surfaces report failures to the caller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-agent-access-request-client-failure-test-'));
  const harness = createClient(root, async () => jsonResponse(422, { error: 'invalid_status' }), 'session-token');

  try {
    let thrown;
    try {
      await harness.client.reportAgentAccessRequest({
        requestId: '301',
        agentId: 'agent-1',
        status: 'ready',
      });
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown?.technicalCode, 'agent_access_request_report_failed_422');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('app control request client reports stop status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-app-control-request-client-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, { success: true });
  }, 'session-token');

  try {
    await harness.client.reportAppControlRequest({
      requestId: '201',
      appId: 'finance-os',
      status: 'done',
    });
    await harness.client.reportAppControlRequest({
      requestId: '202',
      appId: 'finance-os',
      status: 'error',
      technicalCode: 'stop_failed',
    });

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/app_control_requests/201/report');
    assert.equal(requests[0].init.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      app_id: 'finance-os',
      status: 'done',
    });
    assert.deepEqual(JSON.parse(requests[1].init.body), {
      app_id: 'finance-os',
      status: 'error',
      technical_code: 'stop_failed',
    });
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

test('getAppleLoginOAuthClientId reads the public Apple login config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-apple-login-test-'));
  const harness = createClient(root, async (url) => {
    assert.equal(url, 'https://platform.test/api/v1/oauth/apple/config');
    return jsonResponse(200, {
      client_id: 'cloud.forger.signin',
      redirect_uri: 'https://platform.test/api/v1/oauth/apple/callback',
    });
  });

  try {
    const clientId = await harness.client.getAppleLoginOAuthClientId();
    assert.equal(clientId, 'cloud.forger.signin');
    assert.deepEqual(await harness.client.getAppleLoginOAuthConfig(), {
      clientId: 'cloud.forger.signin',
      redirectUri: 'https://platform.test/api/v1/oauth/apple/callback',
    });
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('createAppleLoginSession returns the existing Forger account session shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-apple-login-test-'));
  let requestBody;
  const harness = createClient(root, async (url, init) => {
    assert.equal(url, 'https://platform.test/api/v1/oauth/apple/session');
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
    const result = await harness.client.createAppleLoginSession({
      clientId: 'client-id',
      code: 'code',
      nonce: 'nonce',
      redirectUri: 'http://127.0.0.1:1234/oauth/apple/callback',
    });

    assert.equal(result.success, true);
    assert.equal(result.authenticated, true);
    assert.equal(result.token, 'forger-token');
    assert.equal(result.user.email, 'user@example.com');
    assert.deepEqual(requestBody, {
      client_id: 'client-id',
      code: 'code',
      nonce: 'nonce',
      redirect_uri: 'http://127.0.0.1:1234/oauth/apple/callback',
    });
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
      localBackup: { backupId: 'local-1', appId: 'finance-os', appName: 'Finance OS', appVersion: '1.0.0', createdAt: '2026-05-21T00:00:00Z', reason: 'manual', fileCount: 1, totalBytes: 9, files: ['db.sqlite'] },
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

test('cloud storage endpoint returns normalized quota usage and keeps failures non-blocking', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-cloud-storage-test-'));
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/cloud_storage' && (!init.method || init.method === 'GET')) {
      return jsonResponse(200, {
        storage: {
          used_bytes: '3072',
          limit_bytes: '10737418240',
          remaining_bytes: '10737415168',
          plan: 'demo',
          breakdown: {
            backups_bytes: '1024',
            uploaded_apps_bytes: '1536',
            pending_user_app_uploads_bytes: '256',
            other_bytes: '256',
          },
        },
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const usage = await harness.client.getCloudStorageUsage();

    assert.equal(requests[0].url, 'https://platform.test/api/v1/me/cloud_storage');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer session-token');
    assert.deepEqual(usage, {
      usedBytes: 3072,
      limitBytes: 10737418240,
      remainingBytes: 10737415168,
      plan: 'demo',
      breakdown: {
        backupsBytes: 1024,
        uploadedAppsBytes: 1536,
        pendingUserAppUploadsBytes: 256,
        otherBytes: 256,
      },
    });
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('cloud storage endpoint returns null on unavailable backend or malformed response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-cloud-storage-failure-test-'));
  const harness = createClient(root, async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/cloud_storage') {
      return jsonResponse(500, { error: 'offline' });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    assert.equal(await harness.client.getCloudStorageUsage(), null);
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

test('social app upload uses direct upload, confirms an upload attempt, and polls until published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-upload-'));
  const zipPath = join(root, 'social.zip');
  await writeFile(zipPath, 'zip-content');
  const requests = [];
  const harness = createClient(root, async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/user_apps/direct_uploads') {
      const body = JSON.parse(init.body);
      assert.equal(body.filename, 'social.zip');
      assert.equal(body.byte_size, 'zip-content'.length);
      assert.equal(body.content_type, 'application/zip');
      return jsonResponse(201, {
        signed_blob_id: 'signed-blob',
        direct_upload: {
          url: 'https://storage.test/upload',
          headers: { 'Content-Type': 'application/zip' },
        },
      });
    }
    if (url === 'https://storage.test/upload') {
      assert.equal(init.method, 'PUT');
      assert.equal(init.headers['Content-Type'], 'application/zip');
      assert.equal(Buffer.from(init.body).toString('utf8'), 'zip-content');
      return new Response('', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/me/user_apps') {
      const body = JSON.parse(init.body);
      assert.equal(body.signed_blob_id, 'signed-blob');
      assert.equal(body.slug, 'chessos');
      assert.equal(body.remix_source_user_app_id, 42);
      assert.match(body.checksum_sha256, /^[0-9a-f]{64}$/);
      return jsonResponse(202, {
        upload_attempt: {
          id: 77,
          slug: 'chessos',
          status: 'uploaded',
          checksum_sha256: body.checksum_sha256,
          byte_size: 11,
        },
      });
    }
    if (parsed.pathname === '/api/v1/me/user_app_upload_attempts/77') {
      return jsonResponse(200, {
        id: 77,
        slug: 'chessos',
        status: 'published',
        app: {
          id: 9,
          slug: 'chessos',
          name: 'ChessOS',
          visibility: 'private',
          status: 'published',
          remixed: true,
          remix_source: { id: 42, slug: 'original-chess', name: 'Original Chess', owner_username: 'ana' },
          owner: { id: 1, username: 'maker' },
          latest_version: { id: 9, version: 'v1', checksum_sha256: 'a'.repeat(64), file_size_bytes: 11, supported_platforms: [] },
        },
      });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    const app = await harness.client.uploadSocialApp({
      zipPath,
      name: 'ChessOS',
      slug: 'chessos',
      visibility: 'private',
      remixSourceUserAppId: 42,
    });
    assert.equal(app.slug, 'chessos');
    assert.equal(app.remixed, true);
    assert.deepEqual(app.remixSource, { id: 42, slug: 'original-chess', name: 'Original Chess', ownerUsername: 'ana' });
    assert.equal(app.latestVersion.version, 'v1');
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      '/api/v1/me/user_apps/direct_uploads',
      '/upload',
      '/api/v1/me/user_apps',
      '/api/v1/me/user_app_upload_attempts/77',
    ]);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('social app upload surfaces async analysis errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-upload-failed-'));
  const zipPath = join(root, 'social.zip');
  await writeFile(zipPath, 'zip-content');
  const harness = createClient(root, async (url, _init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v1/me/user_apps/direct_uploads') {
      return jsonResponse(201, {
        signed_blob_id: 'signed-blob',
        direct_upload: {
          url: 'https://storage.test/upload',
          headers: {},
        },
      });
    }
    if (url === 'https://storage.test/upload') {
      return new Response('', { status: 200 });
    }
    if (parsed.pathname === '/api/v1/me/user_apps') {
      return jsonResponse(202, { upload_attempt: { id: 78, slug: 'bad-app', status: 'uploaded' } });
    }
    if (parsed.pathname === '/api/v1/me/user_app_upload_attempts/78') {
      return jsonResponse(200, { id: 78, slug: 'bad-app', status: 'failed', error_code: 'manifest_invalid_json' });
    }
    return jsonResponse(404, { error: 'not_found' });
  }, 'session-token');

  try {
    await assert.rejects(
      () => harness.client.uploadSocialApp({ zipPath, name: 'Bad App', slug: 'bad-app', visibility: 'private' }),
      (error) => error.technicalCode === 'manifest_invalid_json',
    );
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('social app download uses app id instead of version id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-download-'));
  let requestPath;
  const harness = createClient(root, async (url, init = {}) => {
    const parsed = new URL(url);
    requestPath = parsed.pathname;
    assert.equal(init.method, 'POST');
    return jsonResponse(201, {
      download_url: 'https://downloads.test/chessos.zip',
      app: { id: 9, slug: 'chessos', name: 'ChessOS', owner_username: 'maker' },
      version: { id: 9, version: 'v2', checksum_sha256: 'a'.repeat(64), file_size_bytes: 10, supported_platforms: [] },
      install: { id: 5, installed_at: '2026-05-25T00:00:00Z', source: 'profile', trust_decision: 'reviewed' },
    });
  }, 'session-token');

  try {
    const download = await harness.client.requestSocialAppDownload({
      appId: 9,
      platform: 'darwin_arm64',
      deviceIdentifier: 'desktop',
      trustDecision: 'reviewed',
    });
    assert.equal(requestPath, '/api/v1/social/apps/by_id/9/download');
    assert.equal(download.version.version, 'v2');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('social app resolver fetches public apps by id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-resolve-app-'));
  let requestPath;
  const harness = createClient(root, async (url) => {
    const parsed = new URL(url);
    requestPath = parsed.pathname;
    return jsonResponse(200, {
      id: 9,
      slug: 'chessos',
      name: 'ChessOS',
      visibility: 'public',
      status: 'published',
      owner: { id: 1, username: 'maker' },
      latest_version: { id: 9, version: 'v2', checksum_sha256: 'a'.repeat(64), file_size_bytes: 10, supported_platforms: [] },
    });
  }, 'session-token');

  try {
    const result = await harness.client.resolveSocialApp(9);
    assert.equal(requestPath, '/api/v1/social/apps/by_id/9');
    assert.equal(result.app.id, 9);
    assert.equal(result.app.latestVersion.version, 'v2');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});

test('social profile resolver fetches profile apps by username', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-social-profile-'));
  let requestPath;
  const harness = createClient(root, async (url) => {
    const parsed = new URL(url);
    requestPath = parsed.pathname;
    return jsonResponse(200, {
      profile: { id: 1, username: 'maker', first_name: 'Ada', last_initial: 'L', social_bio: 'Builds apps' },
      apps: [
        {
          id: 9,
          slug: 'chessos',
          name: 'ChessOS',
          visibility: 'private',
          status: 'published',
          access_reason: 'direct_share',
          owner: { id: 1, username: 'maker' },
          latest_version: { id: 9, version: 'v2', checksum_sha256: 'a'.repeat(64), file_size_bytes: 10, supported_platforms: [] },
        },
      ],
    });
  }, 'session-token');

  try {
    const result = await harness.client.getSocialProfile('@maker');
    assert.equal(requestPath, '/api/v1/social/profiles/%40maker');
    assert.equal(result.profile.username, 'maker');
    assert.equal(result.profile.firstName, 'Ada');
    assert.equal(result.apps[0].slug, 'chessos');
    assert.equal(result.apps[0].visibility, 'private');
    assert.equal(result.apps[0].accessReason, 'direct_share');
    assert.equal(result.apps[0].latestVersion.version, 'v2');
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
    await assert.rejects(() => harness.client.exchangeGmailOAuthCode({ clientId: 'client-id', code: 'code', codeVerifier: 'verifier', redirectUri: 'http://127.0.0.1/callback' }), (error) => error.technicalCode === 'gmail_oauth_backend_response_invalid');
    await assert.rejects(() => harness.client.refreshGmailOAuthAccessToken({ clientId: 'client-id', refreshToken: 'refresh-token' }), (error) => error.technicalCode === 'gmail_oauth_backend_failed_502');
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});
