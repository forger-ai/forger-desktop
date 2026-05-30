import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prepareDesktopErrorReport } = require('../../dist-electron/main/desktop-error-report-artifacts.js');

const makeOptions = (logPath) => ({
  fs,
  appVersion: '0.1.test',
  platform: 'darwin',
  arch: 'arm64',
  getInstallLogPath: () => logPath,
  roots: [
    { alias: 'FORGER_HOME/', path: '/Users/felipe/Forger' },
    { alias: 'FORGER_APPS/', path: '/Users/felipe/Forger/apps' },
  ],
});

test('app error report preparation attaches recent matching install log as a sanitized file', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-app-error-log-'));
  const logPath = path.join(root, 'install.log');
  try {
    await fs.writeFile(logPath, [
      JSON.stringify({ timestamp: '2026-05-24T10:00:00.000Z', event: 'open:start', appId: 'demo-app' }),
      JSON.stringify({ timestamp: '2026-05-24T10:00:01.000Z', event: 'open:backend:stderr', appId: 'other-app', text: 'ignore me' }),
      JSON.stringify({
        timestamp: '2026-05-24T10:00:02.000Z',
        event: 'open:backend:stderr',
        appId: 'demo-app',
        text: 'db failed at /Users/felipe/Desktop/private.csv OPENAI_API_KEY=secret-token-value',
      }),
      JSON.stringify({ timestamp: '2026-05-24T10:00:03.000Z', event: 'open:failed', appId: 'demo-app', detail: 'open_failed' }),
      '',
    ].join('\n'), 'utf8');

    const { report, attachments } = await prepareDesktopErrorReport(makeOptions(logPath), {
      source: 'app',
      operation: 'open',
      message: 'No pudimos iniciar la app.',
      technicalCode: 'open_failed',
      appId: 'demo-app',
      occurredAt: '2026-05-24T10:00:04.000Z',
    });

    assert.equal(report.sensitiveDetails?.appInstallLogExcerpt, undefined);
    assert.equal(report.diagnosticFiles.length, 1);
    assert.equal(report.diagnosticFiles[0].kind, 'install_log');
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].filename, 'install-log.jsonl');
    assert.match(attachments[0].text, /db failed/);
    assert.doesNotMatch(attachments[0].text, /ignore me/);
    assert.doesNotMatch(attachments[0].text, /secret-token-value/);
    assert.doesNotMatch(attachments[0].text, /\/Users\/felipe\/Desktop/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('app error report preparation promotes layered diagnostics into sanitized attachments', async () => {
  const { report, attachments } = await prepareDesktopErrorReport(makeOptions(path.join(tmpdir(), 'missing-forger-install.log')), {
    source: 'agent',
    operation: 'agent-run',
    message: 'run failed',
    technicalCode: 'agent_run_failed',
    occurredAt: '2026-05-24T10:00:04.000Z',
    sensitiveDetails: {
      runtimeStatus: { backend: 'failed', path: '/Users/felipe/Forger/apps/demo-app/backend' },
      agentRunLog: [
        { type: 'stderr', text: 'failed at /Users/felipe/Desktop/private.csv', token: 'secret-token-value' },
      ],
      rendererStack: 'Error: boom\n    at /Users/felipe/Desktop/app.ts:1:1',
    },
  });

  assert.equal(report.sensitiveDetails, undefined);
  assert.deepEqual(
    report.diagnosticFiles.map((file) => file.filename),
    ['runtime-status.json', 'agent-run.jsonl', 'renderer-stack.log'],
  );
  assert.equal(attachments.length, 3);
  const attachmentText = attachments.map((attachment) => attachment.text).join('\n');
  assert.match(attachmentText, /FORGER_APPS\/demo-app\/backend/);
  assert.doesNotMatch(attachmentText, /\/Users\/felipe\/Desktop/);
  assert.doesNotMatch(attachmentText, /secret-token-value/);
});

test('app error report preparation skips non-app reports', async () => {
  const { report, attachments } = await prepareDesktopErrorReport(makeOptions(path.join(tmpdir(), 'missing-forger-install.log')), {
    source: 'desktop',
    operation: 'uncaughtException',
    message: 'boom',
    technicalCode: 'main_uncaught_exception',
    occurredAt: '2026-05-24T10:00:04.000Z',
  });

  assert.equal(report.sensitiveDetails?.appInstallLogExcerpt, undefined);
  assert.equal(report.diagnosticFiles, undefined);
  assert.equal(attachments.length, 0);
});
