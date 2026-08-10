import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildDesktopErrorReportAttachments,
  prepareDesktopErrorReport,
  readRecentAppInstallLogLines,
  summarizeDesktopErrorReportAttachments,
} = require('../../dist-electron/main/desktop-error-report-artifacts.js');

const roots = [{ alias: 'FORGER_HOME/', path: '/private/Forger' }];
const baseReport = {
  source: 'desktop',
  operation: 'uncaughtException',
  message: 'Desktop failed',
  technicalCode: 'main_uncaught_exception',
  occurredAt: '2026-08-10T10:00:00.000Z',
};

test('desktop reports attach a bounded recent desktop log and sanitize promoted diagnostic shapes', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-error-artifacts-'));
  const desktopLogPath = path.join(root, 'forger-desktop.jsonl');
  const metadataRoot = path.join(root, 'metadata');
  try {
    const longRecentLine = `recent ${'/private/Forger/apps/demo '.repeat(500)}`;
    await fs.writeFile(desktopLogPath, `${'discarded'.repeat(70_000)}\n${longRecentLine}\nlast line\n`, 'utf8');
    await fs.mkdir(path.join(metadataRoot, 'runs'), { recursive: true });
    await fs.writeFile(path.join(metadataRoot, 'runs', 'run.log'), 'run failed in /private/Forger/apps/demo\n', 'utf8');

    const { report, attachments } = await prepareDesktopErrorReport({
      fs,
      appVersion: '1.2.3',
      platform: 'linux',
      arch: 'x64',
      getInstallLogPath: () => path.join(root, 'missing-install.log'),
      getDesktopLogPath: () => desktopLogPath,
      getMetadataRoot: () => metadataRoot,
      roots,
    }, {
      ...baseReport,
      operation: 'desktop-chat.run',
      appId: 'demo-app',
      details: { runId: '////' },
      desktopVersion: '',
      platform: '',
      arch: '',
      sensitiveDetails: {
        appInstallLogExcerpt: {
          lines: ['kept /private/Forger/apps/demo', 42, null],
          truncatedFromStart: true,
        },
        appMcpLog: '   ',
        agentRunLog: [null, 'plain event', { type: 'result', path: '/private/Forger/apps/demo' }],
        providerSessionLog: [],
        runtimeStatus: { state: 'failed', path: '/private/Forger/apps/demo' },
        mainStack: { error: 'boom' },
        retainedContext: 'visible after promotion',
      },
    });

    assert.deepEqual(attachments.map((attachment) => attachment.kind), [
      'desktop_log',
      'install_log',
      'run_log',
      'runtime_status',
      'agent_run',
      'main_stack',
    ]);
    assert.equal(attachments[0].truncated, true);
    assert.match(attachments[0].text, /\[truncated \d+ chars]/);
    assert.equal(attachments[1].lineCount, 1);
    assert.equal(attachments[1].truncated, true);
    assert.equal(attachments[2].filename, 'run-log-run.log');
    assert.match(attachments.map(({ text }) => text).join('\n'), /FORGER_HOME\/apps\/demo/);
    assert.deepEqual(report.sensitiveDetails, { retainedContext: 'visible after promotion' });
    assert.equal(report.desktopVersion, '1.2.3');
    assert.equal(report.platform, 'linux');
    assert.equal(report.arch, 'x64');
    assert.deepEqual(summarizeDesktopErrorReportAttachments(attachments)[0], {
      kind: 'desktop_log',
      filename: 'forger-desktop.jsonl',
      contentType: 'application/x-ndjson',
      originalByteSize: attachments[0].originalByteSize,
      sanitizedByteSize: attachments[0].sanitizedByteSize,
      lineCount: attachments[0].lineCount,
      truncated: true,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('install-log extraction skips partial and unrelated records and reports an empty match set', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-install-excerpt-'));
  const logPath = path.join(root, 'install.log');
  try {
    await fs.writeFile(logPath, `${'partial'.repeat(80_000)}\nnot-json\n${JSON.stringify({ appId: 'other-app' })}\n`, 'utf8');
    assert.equal(await readRecentAppInstallLogLines({
      fs,
      getInstallLogPath: () => logPath,
      appId: 'demo-app',
    }), null);

    let closeAttempts = 0;
    const closeFailureFs = {
      stat: async () => ({ size: 2 }),
      open: async () => ({
        read: async (buffer) => {
          buffer.write('{}');
          return { bytesRead: 2 };
        },
        close: () => {
          closeAttempts += 1;
          return Promise.reject(new Error('close raced'));
        },
      }),
    };
    assert.equal(await readRecentAppInstallLogLines({
      fs: closeFailureFs,
      getInstallLogPath: () => 'virtual-install.log',
      appId: 'demo-app',
    }), null);
    assert.equal(closeAttempts, 1);
    assert.equal(await readRecentAppInstallLogLines({
      fs,
      getInstallLogPath: () => path.join(root, 'missing.log'),
      appId: 'demo-app',
    }), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('attachment collection tolerates empty desktop logs, invalid promoted excerpts, and chat reports without a run id', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-empty-artifacts-'));
  const emptyLog = path.join(root, 'empty.log');
  try {
    await fs.writeFile(emptyLog, '\n \n', 'utf8');
    for (const appInstallLogExcerpt of ['invalid', { lines: 'invalid' }]) {
      const attachments = await buildDesktopErrorReportAttachments({
        fs,
        getInstallLogPath: () => path.join(root, 'missing-install.log'),
        getDesktopLogPath: () => emptyLog,
        getMetadataRoot: () => path.join(root, 'metadata'),
        roots,
      }, {
        ...baseReport,
        operation: 'desktop-chat.run',
        sensitiveDetails: { appInstallLogExcerpt },
      });
      assert.deepEqual(attachments, []);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('report preparation supplies occurrence time and log readers tolerate close races', async () => {
  let closeAttempts = 0;
  const closeFailureFs = {
    stat: async () => ({ size: 5 }),
    open: async () => ({
      read: async (buffer) => {
        buffer.write('line\n');
        return { bytesRead: 5 };
      },
      close: () => {
        closeAttempts += 1;
        return Promise.reject(new Error('close raced'));
      },
    }),
  };
  const { report, attachments } = await prepareDesktopErrorReport({
    fs: closeFailureFs,
    appVersion: '1.2.3',
    platform: 'linux',
    arch: 'x64',
    getInstallLogPath: () => 'virtual-install.log',
    getDesktopLogPath: () => 'virtual-desktop.log',
    roots,
  }, {
    source: 'desktop',
    operation: 'uncaughtException',
    message: 'Desktop failed',
    technicalCode: 'main_uncaught_exception',
    sensitiveDetails: {
      appInstallLogExcerpt: { bytesRead: 12, lines: ['install line'] },
    },
  });

  assert.equal(closeAttempts, 1);
  assert.equal(typeof report.occurredAt, 'string');
  assert.deepEqual(attachments.map(({ kind, originalByteSize }) => ({ kind, originalByteSize })), [
    { kind: 'desktop_log', originalByteSize: 5 },
  ]);
});
