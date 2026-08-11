import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildConversationDiagnosticAttachments,
  buildConversationDiagnosticReport,
  reportSanitizerRoots,
  summarizeConversationDiagnosticAttachments,
} = require('../../dist-electron/main/conversation-diagnostics.js');

const makeOptions = (root, manager = null) => ({
  appVersion: '2.0.test',
  platform: 'linux',
  getUserDataPath: () => path.join(root, 'user-data'),
  getForgerHomeRoot: () => path.join(root, 'Forger'),
  getPrivateAppsRoot: () => path.join(root, 'Forger', 'apps'),
  getPrivateDataRoot: () => path.join(root, 'Forger', 'data'),
  getForgerMetadataRoot: () => path.join(root, 'Forger', '.forger'),
  getCodexHome: () => path.join(root, 'codex-home'),
  getInstalledAppVersion: (appId) => appId === 'demo-app' ? '1.4.0' : undefined,
  getConversationManager: () => manager,
});

test('diagnostic reports expose stable fallbacks for missing conversations, managers, providers, and runs', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-diagnostics-fallbacks-'));
  try {
    const options = makeOptions(root);
    assert.equal(reportSanitizerRoots(options).some(({ alias }) => alias.includes('demo-app')), false);
    assert.equal(reportSanitizerRoots(options, 'demo-app').some(({ alias }) => alias === 'FORGER_APPS/demo-app/'), true);

    const desktop = await buildConversationDiagnosticReport(options, {
      source: 'desktop_chat',
      conversationId: 'conversation-empty',
    });
    assert.equal(desktop.appId, undefined);
    assert.deepEqual(desktop.payload.conversation, { title: undefined, messages: [] });
    assert.equal(desktop.payload.appVersion, undefined);
    assert.equal(desktop.payload.rawRunLog, null);
    assert.deepEqual(desktop.payload.providerSession, {
      provider: null,
      threadId: undefined,
      runId: undefined,
      source: 'provider_unknown',
      transcript: null,
    });

    const unavailable = await buildConversationDiagnosticReport(options, {
      source: 'app_agent_conversation',
      conversationId: 'missing-manager',
    });
    assert.deepEqual(unavailable.payload, {
      kind: 'app_agent_conversation',
      unavailable: 'conversation_manager_missing',
    });

    const personal = await buildConversationDiagnosticReport(options, {
      source: 'personal_agent_conversation',
      conversationId: 'personal-empty',
      title: 'Fallback title',
    });
    assert.equal(personal.payload.personalAgent, null);
    assert.deepEqual(personal.payload.conversation, { title: 'Fallback title', messages: [] });
    assert.equal(personal.payload.run, null);
    assert.equal(personal.payload.rawRunLog, null);
    assert.equal(personal.payload.antigravityRunLog, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('app-agent snapshots infer provider and requested run while null snapshots remain explicit', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-app-diagnostics-'));
  try {
    const inferredManager = {
      getDiagnosticSnapshot: async () => ({
        conversation: {
          runtime: { provider: 'claude' },
          threadId: 42,
        },
        requestedRunId: 'requested-run',
      }),
    };
    const inferred = await buildConversationDiagnosticReport(makeOptions(root, inferredManager), {
      source: 'app_agent_conversation',
      appId: 'demo-app',
      conversationId: 'conversation-inferred',
    });
    assert.equal(inferred.payload.providerSession.provider, 'claude');
    assert.equal(inferred.payload.providerSession.threadId, undefined);
    assert.equal(inferred.payload.providerSession.runId, 'requested-run');
    assert.equal(inferred.payload.providerSession.source, 'run_log_not_found');

    const nullManager = { getDiagnosticSnapshot: async () => null };
    const missing = await buildConversationDiagnosticReport(makeOptions(root, nullManager), {
      source: 'app_agent_conversation',
      conversationId: 'conversation-missing',
      conversation: { appId: 'demo-app' },
      provider: 'antigravity',
    });
    assert.deepEqual(missing.payload.snapshot, { unavailable: 'conversation_not_found' });
    assert.equal(missing.payload.providerSession.source, 'run_log_not_found');

    const providerlessManager = {
      getDiagnosticSnapshot: async () => ({ conversation: { runtime: {}, threadId: null } }),
    };
    const providerless = await buildConversationDiagnosticReport(makeOptions(root, providerlessManager), {
      source: 'app_agent_conversation',
      appId: 'demo-app',
      conversationId: 'conversation-providerless',
    });
    assert.equal(providerless.payload.providerSession.provider, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('provider diagnostics distinguish missing Codex, Claude, and Antigravity evidence', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-provider-diagnostics-'));
  try {
    const options = makeOptions(root);
    const codex = await buildConversationDiagnosticReport(options, {
      source: 'desktop_chat',
      conversationId: 'no-codex-session',
      provider: 'codex',
      conversation: { threadId: 'missing-thread', messages: [] },
    });
    assert.equal(codex.payload.providerSession.source, 'codex_session_not_found');
    assert.equal(codex.payload.providerSession.transcript, null);

    const claude = await buildConversationDiagnosticReport(options, {
      source: 'personal_agent_conversation',
      conversationId: 'no-claude-run',
      runId: 'missing-claude-run',
      conversation: { runtime: { provider: 'claude' }, messages: [] },
    });
    assert.equal(claude.payload.providerSession.source, 'run_log_not_found');

    const metadataRunDir = path.join(root, 'Forger', '.forger', 'personal-agents', 'runs');
    await fs.mkdir(metadataRunDir, { recursive: true });
    await fs.writeFile(path.join(metadataRunDir, 'run-fallback.log'), 'fallback antigravity trace', 'utf8');
    const antigravityFallback = await buildConversationDiagnosticReport(options, {
      source: 'personal_agent_conversation',
      conversationId: 'antigravity-fallback',
      runId: 'run-fallback',
      provider: 'antigravity',
      personalAgent: { id: 'missing-agent-log' },
    });
    assert.equal(antigravityFallback.payload.providerSession.source, 'run_log');

    const antigravityMissing = await buildConversationDiagnosticReport(options, {
      source: 'personal_agent_conversation',
      conversationId: 'antigravity-missing',
      runId: 'missing-run',
      provider: 'antigravity',
      personalAgent: { id: 'missing-agent-log' },
    });
    assert.equal(antigravityMissing.payload.providerSession.source, 'run_log_not_found');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('diagnostic attachments handle missing files, Claude logs, hostile ids, and deep Codex trees', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-diagnostic-attachments-'));
  try {
    const options = makeOptions(root);
    assert.deepEqual(await buildConversationDiagnosticAttachments(options, {
      source: 'desktop_chat',
      conversationId: 'no-files',
      runId: 'missing-run',
      provider: 'claude',
    }), []);

    const runDir = path.join(root, 'Forger', '.forger', 'runs');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'run with spaces.log'), 'claude evidence in private path', 'utf8');
    const claude = await buildConversationDiagnosticAttachments(options, {
      source: 'desktop_chat',
      conversationId: 'claude-files',
      runId: 'run with spaces',
      provider: 'claude',
    });
    assert.equal(claude[0].kind, 'claude_run_log');
    assert.equal(claude[0].filename, 'run-log-run-with-spaces.log');
    assert.deepEqual(summarizeConversationDiagnosticAttachments(claude), [{
      kind: 'claude_run_log',
      filename: 'run-log-run-with-spaces.log',
      contentType: 'text/plain',
      originalByteSize: claude[0].originalByteSize,
      sanitizedByteSize: claude[0].sanitizedByteSize,
    }]);

    const sessionsRoot = path.join(root, 'codex-home', 'sessions');
    const tooDeep = path.join(sessionsRoot, ...Array.from({ length: 10 }, (_, index) => `level-${index}`));
    await fs.mkdir(tooDeep, { recursive: true });
    await fs.writeFile(path.join(sessionsRoot, 'notes.txt'), 'not a transcript', 'utf8');
    await fs.writeFile(path.join(tooDeep, 'hidden.jsonl'), 'deep-thread', 'utf8');
    const deep = await buildConversationDiagnosticAttachments(options, {
      source: 'desktop_chat',
      conversationId: 'deep-tree',
      provider: 'codex',
      conversation: { threadId: 'deep-thread' },
    });
    assert.deepEqual(deep, []);

    const antigravity = await buildConversationDiagnosticAttachments(options, {
      source: 'personal_agent_conversation',
      conversationId: 'missing-antigravity',
      runId: 'missing-antigravity-run',
      provider: 'antigravity',
      personalAgent: { id: 'agent/unsafe' },
    });
    assert.deepEqual(antigravity, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Codex attachment lookup covers app-id and filename fallbacks without exposing unsafe ids', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-codex-fallbacks-'));
  try {
    const options = makeOptions(root);
    const sessionDir = path.join(root, 'codex-home', 'sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'fallback.jsonl'), 'run-only-id evidence', 'utf8');

    const runFallback = await buildConversationDiagnosticAttachments(options, {
      source: 'desktop_chat',
      conversationId: 'filename-run',
      runId: 'run-only-id',
      provider: 'codex',
    });
    assert.equal(runFallback.at(-1).filename, 'codex-session-run-only-id.jsonl');

    const conversationFallback = await buildConversationDiagnosticAttachments(options, {
      source: 'desktop_chat',
      conversationId: 'filename-conversation',
      provider: 'codex',
    });
    assert.equal(conversationFallback[0].filename, 'codex-session-conversation.jsonl');

    for (const input of [
      {
        source: 'app_agent_conversation',
        conversationId: 'app-fallback',
        provider: 'codex',
      },
      {
        source: 'app_agent_conversation',
        conversationId: 'app-conversation-id',
        provider: 'codex',
        conversation: { appId: 'demo-app' },
      },
    ]) {
      const attachments = await buildConversationDiagnosticAttachments(options, input);
      assert.equal(Array.isArray(attachments), true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Codex transcript lookup tolerates session files disappearing during tail and header reads', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-codex-races-'));
  const originalOpen = fs.open;
  try {
    const options = makeOptions(root);
    const sessionDir = path.join(root, 'codex-home', 'sessions');
    const sessionPath = path.join(sessionDir, 'race.jsonl');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(sessionPath, 'race-thread evidence', 'utf8');

    let targetOpens = 0;
    fs.open = async (...args) => {
      if (args[0] === sessionPath) {
        targetOpens += 1;
        if (targetOpens === 2) {
          throw new Error('session disappeared after discovery');
        }
      }
      return await originalOpen(...args);
    };
    const report = await buildConversationDiagnosticReport(options, {
      source: 'desktop_chat',
      conversationId: 'tail-race',
      provider: 'codex',
      conversation: { threadId: 'race-thread' },
    });
    assert.equal(report.payload.providerSession.source, 'codex_session_jsonl');
    assert.deepEqual(report.payload.providerSession.transcript.matched, ['race-thread']);

    targetOpens = 0;
    fs.open = async (...args) => {
      if (args[0] === sessionPath) {
        targetOpens += 1;
        throw new Error('session disappeared before inspection');
      }
      return await originalOpen(...args);
    };
    const missing = await buildConversationDiagnosticReport(options, {
      source: 'desktop_chat',
      conversationId: 'head-race',
      provider: 'codex',
      conversation: { threadId: 'not-in-path' },
    });
    assert.equal(targetOpens >= 2, true);
    assert.equal(missing.payload.providerSession.source, 'codex_session_not_found');
  } finally {
    fs.open = originalOpen;
    await fs.rm(root, { recursive: true, force: true });
  }
});
