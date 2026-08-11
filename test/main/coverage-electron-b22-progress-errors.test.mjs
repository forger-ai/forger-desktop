import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  appendRunLog,
  buildChatRecoveryContext,
  isInternalProviderProgressText,
  isMissingProviderThreadError,
  mapFailureMessage,
  normalizeChatHistory,
  normalizeErrorCode,
  normalizeProviderErrorCode,
  toProgressMessages,
  toProviderProgressMessages,
} = require('../../dist-electron/main/chat/progress-errors.js');

test('history and stale-thread recovery normalize malformed, long, and provider-specific inputs', () => {
  const history = normalizeChatHistory([
    null,
    { role: 'user', content: 42 },
    { role: 'assistant', content: '  answer  ' },
    ...Array.from({ length: 45 }, (_, index) => ({ role: 'user', content: `message ${index}` })),
  ]);
  assert.equal(history.length, 40);
  assert.equal(history[0].content, 'message 5');
  assert.equal(buildChatRecoveryContext([{ role: 'user', content: 'x'.repeat(25_000) }]).length < 25_000, true);

  for (const phrase of [
    'No rollout found for thread id 1',
    'Thread/resume failed',
    'Conversation not found',
    'Session not found',
    'Could not resume',
    'Cannot resume',
  ]) {
    assert.equal(isMissingProviderThreadError(phrase), true, phrase);
  }
  assert.equal(isMissingProviderThreadError({ reason: 'different' }), false);
});

test('Codex progress ignores malformed shapes and recognizes every file-edit command family', () => {
  const edits = [
    'apply_patch file',
    'cat > file',
    'tee file',
    'python3 -c "open(\'file\', \'w\')"',
    'node -e "writeFile(\'file\')"',
    'sed -i s/a/b/ file',
    'perl -pi -e s/a/b/ file',
    'mkdir -p folder',
    'touch file',
    'cp source target',
  ];
  const events = [
    { type: 42 },
    { type: 'item.started', item: { type: 42, command: 42 } },
    { type: 'item.completed', item: { type: 42, text: 42 } },
    { type: 'item.completed', item: { type: 'agent_message', text: 42 } },
    ...edits.map((command) => ({ type: 'item.started', item: { type: 'command_execution', command } })),
    { type: 'item.completed', item: { type: 'agent_message', text: '> {"private":"payload"}' } },
  ];
  const progress = toProgressMessages('stdout', events.map(JSON.stringify).join('\n'), 'en');
  assert.equal(progress.length, edits.length);
  assert.equal(progress.every((entry) => entry === 'The agent is editing app files.'), true);
});

test('Claude progress handles direct, string, invalid, duplicate, tool, and metadata event shapes', () => {
  const output = [
    'not-json',
    JSON.stringify({ message: null }),
    JSON.stringify({ message: { content: 'string content' } }),
    JSON.stringify({ message: { content: 42 } }),
    JSON.stringify({ message: { content: [null, 'invalid', { text: 42 }, { text: 'array content' }] } }),
    JSON.stringify({ text: 'array content' }),
    JSON.stringify({ type: 'tool_use' }),
    JSON.stringify({ message: { content: [null, 'invalid', { type: 'tool_use' }] } }),
    JSON.stringify({ message: { content: [] } }),
  ].join('\n');
  assert.deepEqual(toProviderProgressMessages('claude', 'stdout', output, 'en'), [
    'string content',
    'array content',
    'The agent is using app tools.',
  ]);
  assert.deepEqual(toProviderProgressMessages('claude', 'meta', output, 'en'), []);
});

test('Antigravity progress filters all transport noise, duplicates, internal payloads, and metadata', () => {
  const noise = [
    'Created conversation abc',
    'Streaming conversation abc',
    'conversationID=abc',
    'CONVERSATION_ID: abc',
    'agy --conversation abc',
    'Or, paste the authorization code',
    'MCP config loaded',
    'Using config /tmp/config',
    'Log file: /tmp/log',
  ];
  const output = [...noise, 'visible update', 'visible update', '{"internal":true}'].join('\n');
  assert.deepEqual(toProviderProgressMessages('antigravity', 'stdout', output), ['visible update']);
  assert.deepEqual(toProviderProgressMessages('antigravity', 'meta', 'visible update'), []);
});

test('internal provider payload detection covers annotations, escaped metadata, fragments, and plain copy', () => {
  assert.equal(isInternalProviderProgressText(''), false);
  assert.equal(isInternalProviderProgressText('plain user-facing progress'), false);
  assert.equal(isInternalProviderProgressText('\\n'), false);
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    assert.equal(isInternalProviderProgressText(JSON.stringify({ annotations: { [hint]: true } })), true);
  }
  assert.equal(isInternalProviderProgressText(JSON.stringify({ tools: [{ name: 'tool', annotations: { readOnlyHint: true } }] })), true);
  assert.equal(isInternalProviderProgressText(JSON.stringify({ jsonrpc: '2.0', method: 'tools/list' })), true);
  assert.equal(isInternalProviderProgressText('{\\"name\\":\\"forger_status\\",\\"annotations\\":{\\"readOnlyHint\\":true}}'), true);
  assert.equal(isInternalProviderProgressText(`prefix ${'x'.repeat(500)} \\"annotations\\":{\\"readOnlyHint\\":true}`), true);
  assert.equal(isInternalProviderProgressText('{'), true);
  assert.equal(isInternalProviderProgressText('"abcdefgh",'), true);
  assert.equal(isInternalProviderProgressText('abcdefgh"'), true);
  assert.equal(isInternalProviderProgressText('alpha: "one", beta: "two"'), true);
  assert.equal(isInternalProviderProgressText('alpha: true'), true);
  assert.equal(isInternalProviderProgressText('{broken json'), false);
});

test('run-log persistence distinguishes cleanup races from unrelated filesystem failures', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-progress-log-'));
  const runLogPath = path.join(root, 'runs', 'run.log');
  const originalAppendFile = fs.appendFile;
  try {
    for (const error of [
      Object.assign({ message: `invalid argument ${runLogPath}` }, { code: 'EINVAL' }),
      Object.assign(new Error('other invalid argument'), { code: 'EINVAL' }),
      Object.assign(new Error(`different failure ${runLogPath}`), { code: 'EINVAL' }),
    ]) {
      fs.appendFile = async () => { throw error; };
      if (!(error instanceof Error)) {
        await assert.rejects(() => appendRunLog(runLogPath, 'meta', 'event'));
      } else if (!error.message.includes(runLogPath) || !/invalid argument/i.test(error.message)) {
        await assert.rejects(() => appendRunLog(runLogPath, 'meta', 'event'), error);
      }
    }
  } finally {
    fs.appendFile = originalAppendFile;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('error normalization and localized mapping cover provider, code, detail, and empty variants', () => {
  const coded = Object.assign(new Error('quota'), { chatCode: 'quota_exceeded' });
  assert.deepEqual(normalizeProviderErrorCode(coded), normalizeErrorCode(coded));
  for (const value of [null, 'error', new Error('plain')]) {
    assert.equal(normalizeProviderErrorCode(value), null);
  }

  assert.match(mapFailureMessage('codex_auth_expired', undefined, undefined, 'en'), /Codex/);
  assert.match(mapFailureMessage('auth_missing', undefined, undefined, 'en', 'antigravity'), /Google Antigravity/);
  assert.match(mapFailureMessage('auth_missing', undefined, undefined, 'en', 'codex'), /Codex/);
  assert.match(mapFailureMessage('quota_exceeded', 'Claude Code quota exceeded', undefined, 'en'), /Claude Code/);
  assert.match(mapFailureMessage('quota_exceeded', 'unrecognized quota', undefined, 'en'), /provider/i);
  assert.match(mapFailureMessage('model_unsupported', 'Claude model unsupported', undefined, 'en'), /Claude/);
  assert.match(mapFailureMessage('model_unsupported', undefined, undefined, 'en', 'antigravity'), /Google Antigravity/);
  assert.match(mapFailureMessage('capability_unavailable', undefined, undefined, 'en'), /Codex/);
  assert.match(mapFailureMessage('capability_unavailable', undefined, undefined, 'en', 'claude'), /Claude Code/);
  assert.match(mapFailureMessage('capability_unavailable', 'exec failed', undefined, 'en', 'codex'), /Codex/);
  assert.match(mapFailureMessage('capability_unavailable', 'exec failed', undefined, 'en', 'antigravity'), /Google Antigravity/);
});
