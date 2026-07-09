import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const distRequire = (relativePath) => {
  const resolved = require.resolve(`../../dist-electron/${relativePath}`);
  delete require.cache[resolved];
  return require(resolved);
};

const makeOptions = (root, conversationManager = null) => ({
  appVersion: '0.1.test',
  platform: 'darwin',
  getUserDataPath: () => path.join(root, 'user-data'),
  getForgerHomeRoot: () => path.join(root, 'Forger'),
  getPrivateAppsRoot: () => path.join(root, 'Forger', 'apps'),
  getPrivateDataRoot: () => path.join(root, 'Forger', 'data'),
  getForgerMetadataRoot: () => path.join(root, 'Forger', '.forger'),
  getCodexHome: () => path.join(root, 'codex-home'),
  getInstalledAppVersion: (appId) => appId === 'finance-os' ? '1.2.3' : undefined,
  getConversationManager: () => conversationManager,
});

test('conversation diagnostics include description and sanitized raw provider session payloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-conversation-diagnostic-'));
  try {
    const metadataRoot = path.join(root, 'Forger', '.forger');
    const sessionDir = path.join(metadataRoot, 'chat-conversations-runtime', 'finance-os', 'conversation-1', 'codex-home', 'sessions', '2026', '05', '26');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'rollout.jsonl'),
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1', cwd: path.join(root, 'Forger', 'apps', 'finance-os') }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OPENAI_API_KEY=secret-token-value /Users/example-user/Desktop/private.csv' } }),
      ].join('\n'),
      'utf8',
    );

    const {
      buildConversationDiagnosticAttachments,
      buildConversationDiagnosticReport,
    } = distRequire('main/conversation-diagnostics.js');
    const report = await buildConversationDiagnosticReport(makeOptions(root), {
      source: 'desktop_chat',
      appId: 'finance-os',
      conversationId: 'conversation-1',
      runId: 'run-1',
      title: 'Import bug',
      description: 'State reset after sending chat.',
      provider: 'codex',
      conversation: {
        appId: 'finance-os',
        title: 'Import bug',
        threadId: 'thread-1',
        runtime: { provider: 'codex', model: 'gpt-test' },
        messages: [{ id: 'm1', role: 'user', content: 'Please inspect this.' }],
      },
    });
    const attachments = await buildConversationDiagnosticAttachments(makeOptions(root), {
      source: 'desktop_chat',
      appId: 'finance-os',
      conversationId: 'conversation-1',
      runId: 'run-1',
      title: 'Import bug',
      description: 'State reset after sending chat.',
      provider: 'codex',
      conversation: {
        appId: 'finance-os',
        title: 'Import bug',
        threadId: 'thread-1',
        runtime: { provider: 'codex', model: 'gpt-test' },
        messages: [{ id: 'm1', role: 'user', content: 'Please inspect this.' }],
      },
    });

    const text = JSON.stringify(report);
    assert.equal(report.description, 'State reset after sending chat.');
    assert.equal(report.payload.providerSession.source, 'codex_session_jsonl');
    assert.deepEqual(report.payload.providerSession.transcript.matched, ['thread-1']);
    assert.equal(report.payload.providerSession.transcript.text, undefined);
    assert.equal(text.includes('secret-token-value'), false);
    assert.equal(text.includes('/Users/example-user/Desktop'), false);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, 'codex_session_jsonl');
    assert.equal(attachments[0].text.includes('secret-token-value'), false);
    assert.equal(attachments[0].text.includes('/Users/example-user/Desktop'), false);
    assert.equal(attachments[0].text.includes('FORGER_APPS/finance-os'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conversation diagnostics match large Codex sessions from the session header', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-conversation-diagnostic-large-'));
  try {
    const metadataRoot = path.join(root, 'Forger', '.forger');
    const sessionDir = path.join(metadataRoot, 'chat-conversations-runtime', 'finance-os', 'conversation-1', 'codex-home', 'sessions', '2026', '05', '26');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'rollout-large.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
        'x'.repeat(260_000),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'latest tail only' } }),
      ].join('\n'),
      'utf8',
    );

    const { buildConversationDiagnosticReport } = distRequire('main/conversation-diagnostics.js');
    const report = await buildConversationDiagnosticReport(makeOptions(root), {
      source: 'desktop_chat',
      appId: 'finance-os',
      conversationId: 'conversation-1',
      provider: 'codex',
      conversation: {
        appId: 'finance-os',
        title: 'Import bug',
        threadId: 'thread-1',
        runtime: { provider: 'codex', model: 'gpt-test' },
        messages: [],
      },
    });

    assert.equal(report.payload.providerSession.source, 'codex_session_jsonl');
    assert.deepEqual(report.payload.providerSession.transcript.matched, ['thread-1']);
    assert.equal(report.payload.providerSession.transcript.truncatedFromStart, true);
    assert.equal(report.payload.providerSession.transcript.text, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app-agent conversation diagnostics attach Claude run log as provider session transcript', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-app-agent-diagnostic-'));
  try {
    const manager = {
      getDiagnosticSnapshot: async () => ({
        conversation: {
          conversationId: 'conversation-2',
          appId: 'finance-os',
          title: 'Agent chat',
          threadId: 'claude-session-1',
          runtime: { provider: 'claude', model: 'sonnet' },
          messages: [],
          activeRun: null,
        },
        requestedRunId: 'run-2',
        rawRunLog: {
          path: path.join(root, 'Forger', '.forger', 'runs', 'run-2.log'),
          text: '{"session_id":"claude-session-1","result":"done"}',
        },
      }),
    };
    const { buildConversationDiagnosticReport } = distRequire('main/conversation-diagnostics.js');
    const report = await buildConversationDiagnosticReport(makeOptions(root, manager), {
      source: 'app_agent_conversation',
      appId: 'finance-os',
      conversationId: 'conversation-2',
      runId: 'run-2',
      provider: 'claude',
    });

    assert.equal(report.payload.providerSession.provider, 'claude');
    assert.equal(report.payload.providerSession.source, 'run_log');
    assert.equal(report.payload.providerSession.threadId, 'claude-session-1');
    assert.equal(report.payload.providerSession.transcript.text, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('personal-agent conversation diagnostics include Antigravity run evidence when available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-diagnostic-'));
  try {
    const metadataRoot = path.join(root, 'Forger', '.forger');
    const personalRunDir = path.join(metadataRoot, 'personal-agents', 'runs');
    const agentWorkspace = path.join(root, 'Forger', 'agents', 'agent-1', 'workspace');
    const antigravityLogDir = path.join(agentWorkspace, '.forger', 'tmp');
    await mkdir(personalRunDir, { recursive: true });
    await mkdir(antigravityLogDir, { recursive: true });
    await writeFile(
      path.join(personalRunDir, 'run-personal.log'),
      `stdout failed inside ${agentWorkspace}\n`,
      'utf8',
    );
    await writeFile(
      path.join(antigravityLogDir, 'antigravity-run-personal.log'),
      `antigravity trace inside ${antigravityLogDir}\n`,
      'utf8',
    );

    const input = {
      source: 'personal_agent_conversation',
      conversationId: 'conv-personal',
      runId: 'run-personal',
      title: 'Mi agente',
      provider: 'antigravity',
      technicalCode: 'personal_agent_run_failed',
      personalAgent: {
        id: 'agent-1',
        name: 'Mi agente',
        description: 'Revisa tareas.',
      },
      conversation: {
        title: 'Agent chat',
        threadId: 'agy-thread-1',
        runtime: { provider: 'antigravity', model: 'gemini-test' },
        messages: [
          { id: 'm1', role: 'user', content: 'Haz la revisión.', createdAt: '2026-07-09T12:00:00.000Z' },
          { id: 'm2', role: 'assistant', content: 'Estoy revisando.', runId: 'run-personal', createdAt: '2026-07-09T12:00:01.000Z' },
        ],
      },
      run: {
        id: 'run-personal',
        status: 'failed',
        error: `failed at ${agentWorkspace}`,
        progress: [{ id: 'p1', message: 'Ejecutando Antigravity', createdAt: '2026-07-09T12:00:02.000Z' }],
        activity: { items: [{ id: 'a1', label: 'Terminal' }] },
        createdAt: '2026-07-09T12:00:00.000Z',
        updatedAt: '2026-07-09T12:01:00.000Z',
      },
    };

    const {
      buildConversationDiagnosticAttachments,
      buildConversationDiagnosticReport,
    } = distRequire('main/conversation-diagnostics.js');
    const report = await buildConversationDiagnosticReport(makeOptions(root), input);
    const attachments = await buildConversationDiagnosticAttachments(makeOptions(root), input);

    const text = JSON.stringify(report);
    assert.equal(report.source, 'personal_agent_conversation');
    assert.equal(report.provider, 'antigravity');
    assert.equal(report.technicalCode, 'personal_agent_run_failed');
    assert.equal(report.payload.kind, 'personal_agent_conversation');
    assert.equal(report.payload.personalAgent.id, 'agent-1');
    assert.equal(report.payload.conversation.messages.length, 2);
    assert.equal(report.payload.run.error.includes('FORGER_HOME/agents/agent-1/workspace'), true);
    assert.equal(report.payload.providerSession.provider, 'antigravity');
    assert.equal(report.payload.providerSession.source, 'antigravity_run_log');
    assert.equal(report.payload.providerSession.transcript.text, undefined);
    assert.equal(text.includes(agentWorkspace), false);
    assert.deepEqual(attachments.map((attachment) => attachment.kind).sort(), ['antigravity_run_log', 'run_log']);
    assert.equal(attachments.every((attachment) => !attachment.text.includes(agentWorkspace)), true);
    assert.equal(attachments.some((attachment) => attachment.text.includes('FORGER_HOME/agents/agent-1/workspace')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('personal-agent Codex diagnostics search the personal-agent codex home before fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-personal-agent-codex-diagnostic-'));
  try {
    const metadataRoot = path.join(root, 'Forger', '.forger');
    const sessionDir = path.join(metadataRoot, 'personal-agent-codex-home', 'agent-1', 'conv-personal', 'sessions', '2026', '07', '09');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'rollout.jsonl'),
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-personal' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'agent evidence' } }),
      ].join('\n'),
      'utf8',
    );

    const input = {
      source: 'personal_agent_conversation',
      conversationId: 'conv-personal',
      runId: 'run-codex',
      personalAgent: { id: 'agent-1', name: 'Codex Agent' },
      conversation: {
        title: 'Agent chat',
        threadId: 'codex-thread-personal',
        runtime: { provider: 'codex', model: 'gpt-test' },
        messages: [],
      },
    };

    const {
      buildConversationDiagnosticAttachments,
      buildConversationDiagnosticReport,
    } = distRequire('main/conversation-diagnostics.js');
    const report = await buildConversationDiagnosticReport(makeOptions(root), input);
    const attachments = await buildConversationDiagnosticAttachments(makeOptions(root), input);

    assert.equal(report.payload.providerSession.provider, 'codex');
    assert.equal(report.payload.providerSession.source, 'codex_session_jsonl');
    assert.deepEqual(report.payload.providerSession.transcript.matched, ['codex-thread-personal']);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, 'codex_session_jsonl');
    assert.equal(attachments[0].text.includes('agent evidence'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
