import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
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
    mapBackendCategory: () => 'productivity',
    toCatalogStatus: () => 'not_installed',
    getUserMessage: () => undefined,
    platform: () => 'darwin_arm64',
    desktopVersion: () => '0.1.test',
    reportingLogPath: () => join(root, 'reporting.log'),
    reportSanitizerRoots: () => [
      { alias: 'FORGER_APPS/', path: '/Users/example-user/Forger/apps' },
      { alias: 'FORGER_APPS/finance-os/', path: '/Users/example-user/Forger/apps/finance-os' },
    ],
  });
  return {
    client,
    restore: () => {
      globalThis.fetch = previousFetch;
    },
  };
};

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('submitDesktopErrorReport uploads sanitized diagnostic files as multipart attachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-error-report-upload-test-'));
  let requestInit;
  const harness = createClient(root, async (_url, init) => {
    requestInit = init;
    return jsonResponse(201, { id: 2, status: 'open' });
  });

  try {
    const result = await harness.client.submitDesktopErrorReport({
      source: 'app',
      operation: 'open',
      message: 'Failed at /Users/example-user/Desktop/random.pdf',
      technicalCode: 'open_failed',
      appId: 'finance-os',
      occurredAt: '2026-05-17T00:00:00.000Z',
      diagnosticFiles: [{
        kind: 'install_log',
        filename: 'install-log.jsonl',
        contentType: 'application/x-ndjson',
        originalByteSize: 120,
        sanitizedByteSize: 80,
      }],
    }, [{
      kind: 'install_log',
      filename: 'install-log.jsonl',
      contentType: 'application/x-ndjson',
      originalByteSize: 120,
      sanitizedByteSize: 80,
      text: '{"appId":"finance-os","text":"Bearer sk-private-token-value at /Users/example-user/Forger/apps/finance-os/app.py"}\n',
    }]);

    assert.equal(result.success, true);
    assert.equal(requestInit.headers['Content-Type'], undefined);
    assert.equal(requestInit.body instanceof FormData, true);
    assert.equal(requestInit.body.get('source'), 'app');
    assert.equal(requestInit.body.get('app_id'), 'finance-os');
    assert.equal(JSON.parse(requestInit.body.get('details')).diagnosticFiles[0].filename, 'install-log.jsonl');
    const files = requestInit.body.getAll('diagnostic_files[]');
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'install-log.jsonl');
    assert.equal(files[0].type, 'application/x-ndjson');
    const fileText = await files[0].text();
    assert.match(fileText, /FORGER_APPS\/finance-os\/app.py/);
    assert.doesNotMatch(fileText, /sk-private-token-value/);
  } finally {
    harness.restore();
    await rm(root, { recursive: true, force: true });
  }
});
