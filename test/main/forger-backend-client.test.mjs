import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ForgerBackendClient } = require('../../dist-electron/main/forger-backend-client.js');

const createClient = (root, fetchImpl) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const client = new ForgerBackendClient({
    backendBaseUrl: 'https://platform.test',
    localCatalogJsonUrl: () => undefined,
    token: () => undefined,
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
