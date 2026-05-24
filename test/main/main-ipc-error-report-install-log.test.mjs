import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { __testMainHandlersInternals } = require('../../dist-electron/main/ipc/main-handlers.js');

test('app error report enrichment attaches recent matching install log lines', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-app-error-log-'));
  const logPath = path.join(root, 'install.log');
  try {
    await fs.writeFile(logPath, [
      JSON.stringify({ timestamp: '2026-05-24T10:00:00.000Z', event: 'open:start', appId: 'demo-app' }),
      JSON.stringify({ timestamp: '2026-05-24T10:00:01.000Z', event: 'open:backend:stderr', appId: 'other-app', text: 'ignore me' }),
      JSON.stringify({ timestamp: '2026-05-24T10:00:02.000Z', event: 'open:backend:stderr', appId: 'demo-app', text: 'db failed' }),
      JSON.stringify({ timestamp: '2026-05-24T10:00:03.000Z', event: 'open:failed', appId: 'demo-app', detail: 'open_failed' }),
      '',
    ].join('\n'), 'utf8');

    const report = await __testMainHandlersInternals.enrichAppErrorReportWithInstallLog({
      fs,
      getInstallLogPath: () => logPath,
      input: {
        source: 'app',
        operation: 'open',
        message: 'No pudimos iniciar la app.',
        technicalCode: 'open_failed',
        appId: 'demo-app',
        occurredAt: '2026-05-24T10:00:04.000Z',
      },
    });

    const excerpt = report.sensitiveDetails.appInstallLogExcerpt;
    assert.equal(excerpt.source, 'install.log');
    assert.equal(excerpt.lines.length, 3);
    assert.match(excerpt.lines[1], /db failed/);
    assert.doesNotMatch(excerpt.lines.join('\n'), /ignore me/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('app error report enrichment skips non-app reports', async () => {
  const report = await __testMainHandlersInternals.enrichAppErrorReportWithInstallLog({
    fs,
    getInstallLogPath: () => path.join(tmpdir(), 'missing-forger-install.log'),
    input: {
      source: 'desktop',
      operation: 'uncaughtException',
      message: 'boom',
      technicalCode: 'main_uncaught_exception',
      occurredAt: '2026-05-24T10:00:04.000Z',
    },
  });

  assert.equal(report.sensitiveDetails?.appInstallLogExcerpt, undefined);
});
