import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildConversationRecoveryContext,
  buildManifestAgentRecoveryPrompt,
  buildManifestAgentResumePrompt,
  buildManifestAgentStartPrompt,
  buildManifestAgentSteerPrompt,
  defaultAgentRuntime,
  extensionForMimeType,
  isMissingProviderThread,
  isTerminalRunStatus,
  normalizeMetadata,
  progressFromCodexOutput: progressFromConversationOutput,
  sanitizeId,
  sanitizeTitle,
  toConversation,
  toRun,
} = require('../../dist-electron/main/app-agent/conversation-helpers.js');
const {
  parseClaudeConversationJsonl,
  parseClaudeTaskJsonl,
  parseCodexConversationJsonl,
  parseCodexTaskJsonl,
} = require('../../dist-electron/main/app-agent/jsonl.js');
const {
  buildMcpArgs,
  getMcpApprovalMode,
  writeClaudeMcpConfig,
} = require('../../dist-electron/main/app-agent/mcp.js');
const {
  existsDirectory,
  existsFile,
  findExecutableInPathEntries,
  isPathInside,
  killProcessTree,
  resolveCodexCommand,
  runCommandCapture,
} = require('../../dist-electron/main/app-agent/process.js');
const {
  appendTranscript,
  buildLegacyPromptVariables,
  formatFileArgumentForPrompt,
  isStaleCodexThreadError,
  normalizeFileArgumentValue,
  normalizeStringArgument,
  normalizeTaskLocale,
  progressFromCodexOutput: progressFromTaskOutput,
  renderPrompt,
  sanitizeFilename,
  taskMessage,
  uniqueFilename,
  validateAttachmentType,
  validateFileArgumentType,
} = require('../../dist-electron/main/app-agent/task-helpers.js');

test('app-agent JSONL parsers keep the latest assistant text and tolerate plain text fallbacks', () => {
  const codexRaw = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
    'plain fallback',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second' } }),
  ].join('\n');

  assert.equal(parseCodexTaskJsonl(codexRaw, ''), 'second');
  assert.deepEqual(parseCodexConversationJsonl(codexRaw, ''), {
    assistantText: 'second',
    threadId: 'thread-123',
  });

  const claudeRaw = [
    JSON.stringify({ session_id: 'session-1', message: { content: [{ text: 'hello' }, { text: 'world' }] } }),
    JSON.stringify({ result: 'final answer' }),
  ].join('\n');
  assert.equal(parseClaudeTaskJsonl('', claudeRaw), 'final answer');
  assert.deepEqual(parseClaudeConversationJsonl(claudeRaw, ''), {
    assistantText: 'final answer',
    threadId: 'session-1',
  });
});

test('app-agent JSONL parsers preserve fallback text and recognize provider thread variants', () => {
  assert.equal(parseCodexTaskJsonl([
    'first plain line',
    JSON.stringify({ type: 'item.completed', item: { type: 'other', text: 'ignored' } }),
    'second plain line',
  ].join('\n'), ''), 'first plain line\nsecond plain line');

  assert.deepEqual(parseClaudeConversationJsonl([
    JSON.stringify({ conversation_id: 'conversation-provider-id', message: { content: 'first message' } }),
    JSON.stringify({ message: { content: [{ type: 'text', text: 'second' }, { type: 'tool_use', name: 'ignored' }] } }),
    'plain tail',
  ].join('\n'), ''), {
    assistantText: 'second\nplain tail',
    threadId: 'conversation-provider-id',
  });

  assert.equal(parseClaudeTaskJsonl('', JSON.stringify({
    message: { content: [{ text: 'stderr answer' }] },
  })), 'stderr answer');
  assert.equal(parseClaudeTaskJsonl(JSON.stringify({ text: 'top-level text' }), ''), 'top-level text');
  assert.equal(parseClaudeTaskJsonl(JSON.stringify({ message: { content: 42 } }), ''), '');
  assert.deepEqual(parseClaudeConversationJsonl(JSON.stringify({ sessionId: 'session-camel', text: 'hello' }), ''), {
    assistantText: 'hello',
    threadId: 'session-camel',
  });
  assert.deepEqual(parseClaudeConversationJsonl(JSON.stringify({ message: { ignored: true } }), ''), {
    assistantText: '',
    threadId: undefined,
  });
});

test('app-agent JSONL parsers use stderr fallbacks and ignore malformed provider text shapes', () => {
  assert.equal(parseCodexTaskJsonl('', [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 42 } }),
    'stderr fallback',
  ].join('\n')), 'stderr fallback');
  assert.deepEqual(parseCodexConversationJsonl('', [
    JSON.stringify({ type: 'thread.started', thread_id: '' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 42 } }),
    'conversation stderr fallback',
  ].join('\n')), {
    assistantText: 'conversation stderr fallback',
    threadId: '',
  });
  assert.equal(parseClaudeTaskJsonl('', JSON.stringify({
    message: { content: [null, { text: 'first' }, { text: 7 }, { text: 'second' }] },
  })), 'first\nsecond');
  assert.equal(parseClaudeTaskJsonl([
    JSON.stringify({ result: 'first result' }),
    'plain claude fallback',
  ].join('\n'), ''), 'first result\nplain claude fallback');
  assert.equal(parseClaudeTaskJsonl(JSON.stringify({ type: 'status', ok: true }), ''), '');
  assert.deepEqual(parseClaudeConversationJsonl('', [
    JSON.stringify({ session_id: '   ', message: { content: null } }),
    JSON.stringify({ conversation_id: 'conversation-from-stderr', message: { content: ['bad-shape', { text: 'ok' }] } }),
  ].join('\n')), {
    assistantText: 'ok',
    threadId: 'conversation-from-stderr',
  });
  assert.equal(parseCodexTaskJsonl('', ''), '');
  assert.deepEqual(parseClaudeConversationJsonl('', ''), { assistantText: '', threadId: undefined });
});

test('app-agent MCP helpers build provider configs without exposing bearer values inline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-app-agent-mcp-'));
  try {
    const servers = [
      { name: 'forger', url: 'http://127.0.0.1:1/mcp', token: 'secret-forger', tokenEnvVar: 'FORGER_MCP_TOKEN' },
      { name: 'app_finance_os', url: 'http://127.0.0.1:2/mcp', token: 'secret-app', tokenEnvVar: 'APP_MCP_TOKEN', toolTimeoutSec: 42 },
    ];

    assert.equal(getMcpApprovalMode(servers[0]), 'auto');
    assert.equal(getMcpApprovalMode(servers[1]), 'approve');
    assert.deepEqual(buildMcpArgs(servers), [
      '--config',
      'mcp_servers.forger.url="http://127.0.0.1:1/mcp"',
      '--config',
      'mcp_servers.forger.bearer_token_env_var="FORGER_MCP_TOKEN"',
      '--config',
      'mcp_servers.forger.enabled=true',
      '--config',
      'mcp_servers.forger.tool_timeout_sec=600',
      '--config',
      'mcp_servers.forger.default_tools_approval_mode="auto"',
      '--config',
      'mcp_servers.app_finance_os.url="http://127.0.0.1:2/mcp"',
      '--config',
      'mcp_servers.app_finance_os.bearer_token_env_var="APP_MCP_TOKEN"',
      '--config',
      'mcp_servers.app_finance_os.enabled=true',
      '--config',
      'mcp_servers.app_finance_os.tool_timeout_sec=42',
      '--config',
      'mcp_servers.app_finance_os.default_tools_approval_mode="approve"',
    ]);

    const configPath = await writeClaudeMcpConfig(root, servers);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.mcpServers.forger.headers.Authorization, 'Bearer ${FORGER_MCP_TOKEN}');
    assert.equal(config.mcpServers.app_finance_os.headers.Authorization, 'Bearer ${APP_MCP_TOKEN}');
    assert.equal(JSON.stringify(config).includes('secret-forger'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('app-agent process helpers capture streams, stdin, child handles, and path checks', async () => {
  let childSeen = false;
  const result = await runCommandCapture(process.execPath, [
    '-e',
    [
      'let input = "";',
      'process.stdin.on("data", chunk => input += chunk);',
      'process.stdin.on("end", () => {',
      '  process.stdout.write("out:" + input);',
      '  process.stderr.write("err:" + process.env.FORGER_TEST_FLAG);',
      '});',
    ].join(''),
  ], {
    cwd: process.cwd(),
    env: { FORGER_TEST_FLAG: 'ok' },
    stdinText: 'hello',
    timeoutMs: 5_000,
    onChild: (child) => {
      childSeen = typeof child.pid === 'number';
    },
  });

  assert.equal(childSeen, true);
  assert.deepEqual(result, { code: 0, stdout: 'out:hello', stderr: 'err:ok' });
  assert.equal(await existsFile(process.execPath), true);
  assert.equal(await existsDirectory(path.dirname(process.execPath)), true);
  assert.equal(await findExecutableInPathEntries([path.join(process.cwd(), 'missing-dir-for-test')], ['missing']), null);
  assert.equal(await findExecutableInPathEntries([path.dirname(process.execPath)], [path.basename(process.execPath)]), process.execPath);
  assert.deepEqual(await resolveCodexCommand('/opt/codex/bin/codex', ['/custom/bin']), {
    command: '/opt/codex/bin/codex',
    prefixArgs: [],
    pathEntries: ['/opt/codex/bin', '/custom/bin'],
  });
  assert.equal(isPathInside(path.join(process.cwd(), 'child'), process.cwd()), true);
  assert.equal(isPathInside(path.dirname(process.cwd()), process.cwd()), false);
  assert.doesNotThrow(() => killProcessTree(undefined));
  assert.doesNotThrow(() => killProcessTree({ killed: true }));
});

test('app-agent process helpers reject inactive commands through timeout', async () => {
  await assert.rejects(() => runCommandCapture(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
  ], {
    cwd: process.cwd(),
    timeoutMs: 50,
  }), /codex_timeout_after_50ms/);
});

test('conversation helpers serialize public state and build manifest-first prompts', () => {
  assert.equal(buildManifestAgentStartPrompt('  # Start\nDo it.  '), '# Start\nDo it.');
  assert.equal(buildManifestAgentResumePrompt('  # Resume\nContinue.  '), '# Resume\nContinue.');
  assert.equal(buildManifestAgentSteerPrompt('  # Steer\nAdjust.  '), '# Steer\nAdjust.');
  assert.equal(
    buildManifestAgentRecoveryPrompt('# Resume\nContinue.', 'user: old\n\nassistant: prior'),
    '# Resume\nContinue.\n\n# Previous Messages\nuser: old\n\nassistant: prior',
  );

  const recovery = buildConversationRecoveryContext({
    messages: [
      { role: 'user', text: 'old', runId: 'run-1' },
      { role: 'assistant', text: 'skip active', runId: 'run-2' },
    ],
  }, 'run-2');
  assert.match(recovery, /user: old/);
  assert.doesNotMatch(recovery, /skip active/);
  assert.equal(buildConversationRecoveryContext({
    messages: [{ role: 'user', text: 'active', runId: 'run-1' }],
  }, 'run-1'), '');

  const run = toRun({
    runId: 'run-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    appId: 'finance-os',
    conversationId: 'conversation-1',
    child: { pid: 123 },
    progressLog: ['working'],
  });
  assert.deepEqual(run, {
    runId: 'run-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    progressLog: ['working'],
  });
  assert.deepEqual(toRun({
    runId: 'run-2',
    status: 'failed',
    createdAt: 'a',
    updatedAt: 'b',
    error: 'boom',
    permissionRequest: { requestId: 'request-1', title: 'Use tool', body: 'Continue', action: 'tool' },
  }), {
    runId: 'run-2',
    status: 'failed',
    createdAt: 'a',
    updatedAt: 'b',
    error: 'boom',
    permissionRequest: { requestId: 'request-1', title: 'Use tool', body: 'Continue', action: 'tool' },
  });
  assert.deepEqual(toConversation({
    conversationId: 'conversation-1',
    appId: 'finance-os',
    title: 'Title',
    createdAt: 'a',
    updatedAt: 'b',
    messages: [],
    threadId: 'provider-thread',
    metadata: { hidden: true },
  }), {
    conversationId: 'conversation-1',
    appId: 'finance-os',
    title: 'Title',
    createdAt: 'a',
    updatedAt: 'b',
    messages: [],
  });
});

test('conversation helpers normalize ids, metadata, terminal status, progress, and defaults', () => {
  assert.equal(sanitizeId('bad id / value!'), 'bad-id-value-');
  assert.equal(sanitizeId(''), 'app');
  assert.equal(sanitizeTitle('  A   long   title  '), 'A long title');
  assert.equal(sanitizeTitle(null), '');
  assert.equal(normalizeMetadata(null), undefined);
  assert.equal(normalizeMetadata(['drop']), undefined);
  assert.deepEqual(normalizeMetadata({ keep: 'yes', count: 1, flag: true, none: null, drop: { nested: true } }), {
    keep: 'yes',
    count: 1,
    flag: true,
    none: null,
  });
  assert.equal(extensionForMimeType('image/jpeg'), 'jpg');
  assert.equal(extensionForMimeType('image/webp'), 'webp');
  assert.equal(extensionForMimeType('image/svg+xml'), 'svg');
  assert.equal(extensionForMimeType('image/png'), 'png');
  assert.equal(isTerminalRunStatus('completed'), true);
  assert.equal(isTerminalRunStatus('running'), false);
  assert.equal(isMissingProviderThread('', 'Thread/resume failed: conversation not found'), true);
  assert.equal(isMissingProviderThread('ok', ''), false);
  assert.deepEqual(defaultAgentRuntime(), { model: 'gpt-5.4', reasoningEffort: 'medium' });
  assert.equal(progressFromConversationOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '# Done\n\n- Updated `value`.' },
  })), 'Done Updated value.');
  assert.match(progressFromConversationOutput(JSON.stringify({ type: 'turn.started' }), 'en'), /thinking/i);
  assert.match(progressFromConversationOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'mcp_tool_call', name: 'list' },
  }), 'en'), /tools/i);
  assert.match(progressFromConversationOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python script.py' },
  }), 'en'), /tools/i);
  assert.match(progressFromConversationOutput(JSON.stringify({
    type: 'item.started',
    item: { type: 'command_execution', command: 'python script.py' },
  }), 'en'), /tools/i);
  assert.equal(progressFromConversationOutput('not json\n{"type":"ignored"}', 'en'), null);
});

test('task helpers validate arguments, render prompts, and parse progress states', () => {
  assert.equal(normalizeTaskLocale('en-US'), 'en');
  assert.equal(normalizeTaskLocale('es-CL'), 'es');
  assert.equal(taskMessage('en', 'finished'), 'The assistant finished the task.');
  assert.equal(sanitizeFilename('../bad:name?.csv'), '.._bad_name_.csv');
  assert.equal(sanitizeFilename('.'), 'attachment');
  assert.equal(sanitizeFilename('..'), 'attachment');
  const used = new Set();
  assert.equal(uniqueFilename('file.csv', used), 'file.csv');
  assert.equal(uniqueFilename('file.csv', used), 'file-2.csv');
  assert.equal(normalizeStringArgument({ name: 'amount', type: 'string', maxLength: 4 }, 123), '123');
  assert.throws(() => normalizeStringArgument({ name: 'amount', type: 'string', maxLength: 2 }, '123'), /app_prompt_string_too_long:amount/);
  assert.deepEqual(normalizeFileArgumentValue({ name: 'doc', type: 'file', multiple: true }, [
    { type: 'file', dataBase64: Buffer.from('a').toString('base64'), name: 'a.txt' },
  ]), [
    { type: 'file', dataBase64: Buffer.from('a').toString('base64'), name: 'a.txt' },
  ]);
  assert.throws(() => normalizeFileArgumentValue({ name: 'doc', type: 'file', multiple: false }, [{ type: 'file', dataBase64: 'a' }, { type: 'file', dataBase64: 'b' }]), /multiple_not_allowed/);

  assert.doesNotThrow(() => validateAttachmentType({ acceptedFileTypes: ['text/*', '.csv'] }, { mimeType: 'text/plain' }, 'notes.txt'));
  assert.throws(() => validateAttachmentType({ acceptedFileTypes: ['application/pdf'] }, { mimeType: 'text/plain' }, 'notes.txt'), /attachment_type_not_accepted/);
  assert.doesNotThrow(() => validateFileArgumentType({ name: 'doc', acceptedFileTypes: ['.pdf'] }, { mimeType: 'application/octet-stream' }, 'report.pdf'));
  assert.throws(() => validateFileArgumentType({ name: 'doc', acceptedFileTypes: ['image/*'] }, { mimeType: 'application/pdf' }, 'report.pdf'), /app_prompt_file_type_not_accepted:doc/);

  const files = [{ argumentName: 'doc', name: 'report.pdf', path: '/tmp/report.pdf', mimeType: 'application/pdf' }];
  assert.deepEqual(buildLegacyPromptVariables({ category: 'tax' }, files), { category: 'tax', filename: '/tmp/report.pdf' });
  assert.equal(formatFileArgumentForPrompt(files), '/tmp/report.pdf');
  assert.equal(formatFileArgumentForPrompt([
    { argumentName: 'one', name: 'one.csv', path: '/tmp/one.csv' },
    { argumentName: 'two', name: 'two.csv', path: '/tmp/two.csv' },
  ]), '- one.csv: /tmp/one.csv\n- two.csv: /tmp/two.csv');
  assert.match(renderPrompt('Review {{category}} {{doc}}', {
    variables: { category: 'tax', doc: formatFileArgumentForPrompt(files) },
    files,
  }), /# User-Provided Files\n\n- doc\.report\.pdf: \/tmp\/report\.pdf \(application\/pdf\)/);
  assert.match(renderPrompt('Review {{missing}}', {
    variables: { missing: null },
    files: [],
  }), /# User-Provided Files\n\n- No se adjuntaron archivos\.[\s\S]*Respond in Spanish/);
  assert.match(renderPrompt('Review {{note}}', {
    variables: { note: 'literal {{braces}} from user' },
    files: [],
  }, 'en'), /literal \{ \{braces\} \} from user[\s\S]*Respond in English/);
  assert.match(renderPrompt('Review {{doc}}', {
    variables: { doc: '/tmp/{{file}}.csv' },
    files: [{ argumentName: 'doc', name: '{{file}}.csv', path: '/tmp/{{file}}.csv', mimeType: 'text/csv' }],
  }, 'en'), /doc\.\{ \{file\} \}\.csv: \/tmp\/\{ \{file\} \}\.csv/);
  assert.equal(progressFromTaskOutput(JSON.stringify({ type: 'turn.started' }), 'en'), 'The assistant is working on the task.');
  assert.equal(progressFromTaskOutput(JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call' } }), 'en'), 'Using internal tools.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.started',
    item: { type: 'mcp_tool_call', server: 'mcp_app_finance_os__', name: 'list_movements' },
  }), 'es'), 'Llamando herramienta MCP: mcp_app_finance_os__.list_movements.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'mcp_tool_call', name: 'import_movements' },
  }), 'en'), 'Calling MCP tool: import_movements.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.started',
    item: { type: 'command_execution', command: 'python scripts/list_categories.py' },
  }), 'en'), 'Reviewing available categories for classification.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python scripts/import_movements.py', exit_code: 0 },
  }), 'en'), 'Loading movements into the local database.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python scripts/verify.py', exit_code: 0 },
  }), 'en'), 'Validating that the data is consistent.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python scripts/list_movements.py', exit_code: 0 },
  }), 'en'), 'Confirming the loaded movements.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'pdftotext report.pdf -', exit_code: 0 },
  }), 'en'), 'Reading the document contents.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'cat AGENTS.md', exit_code: 0 },
  }), 'en'), 'Reviewing the app internal instructions.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python scripts/custom.py', exit_code: 0 },
  }), 'en'), 'Using internal tools.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', exit_code: 0 },
  }), 'en'), null);
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python scripts/import_movements.py', exit_code: 1 },
  }), 'en'), 'The assistant found a technical limitation and is trying another approach.');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '# Done\n\nA'.repeat(160) },
  }), 'en')?.endsWith('...'), true);
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '' },
  }), 'en'), null);
  assert.equal(progressFromTaskOutput('not json', 'en'), null);
  assert.equal(isStaleCodexThreadError('failed to record rollout items: thread abc not found'), true);
  assert.equal(isStaleCodexThreadError('different error'), false);
});

test('task transcript helper creates parent directories and records stream labels', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-task-transcript-'));
  try {
    const transcriptPath = path.join(root, 'nested', 'transcript.log');
    await appendTranscript(transcriptPath, 'meta', 'starting');
    await appendTranscript(transcriptPath, 'stderr', 'retrying');
    const raw = await readFile(transcriptPath, 'utf8');
    assert.match(raw, /\[meta\] starting/);
    assert.match(raw, /\[stderr\] retrying/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('process helpers resolve Windows Codex shims and missing filesystem paths', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'forger-process-win-'));
  const binDir = path.join(root, 'bin');
  const codexDir = path.join(root, 'node_modules', '.bin');
  const entrypoint = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const codexCmd = path.join(codexDir, 'codex.cmd');
  const nodeExe = path.join(binDir, 'node');
  const originalPlatform = process.platform;
  try {
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await mkdir(codexDir, { recursive: true });
    await writeFile(entrypoint, 'console.log("codex")\n', 'utf8');
    await writeFile(nodeExe, '#!/usr/bin/env node\n', 'utf8');
    await writeFile(codexCmd, '@node codex.js\n', 'utf8');
    await chmod(nodeExe, 0o755);
    await chmod(codexCmd, 0o755);

    Object.defineProperty(process, 'platform', { value: 'win32' });
    assert.deepEqual(await resolveCodexCommand(codexCmd, [binDir]), {
      command: nodeExe,
      prefixArgs: [entrypoint],
      pathEntries: [binDir, codexDir, binDir],
    });
    await rm(entrypoint, { force: true });
    await assert.rejects(() => resolveCodexCommand(codexCmd, [binDir]), /codex_js_entrypoint_missing/);
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    await rm(root, { recursive: true, force: true });
  }

  assert.equal(await existsFile(path.join(root, 'missing-file')), false);
  assert.equal(await existsDirectory(path.join(root, 'missing-dir')), false);
});

test('process and task helper edge cases stay explicit for runtime safety', async () => {
  assert.doesNotThrow(() => validateAttachmentType({}, { mimeType: 'application/x-custom' }, 'statement.bin'));
  assert.doesNotThrow(() => validateFileArgumentType({ name: 'doc' }, { mimeType: 'application/x-custom' }, 'statement.bin'));
  assert.doesNotThrow(() => validateFileArgumentType(
    { name: 'doc', acceptedFileTypes: ['application/pdf'] },
    { mimeType: ' application/pdf ' },
    'statement.bin',
  ));
  assert.throws(() => normalizeStringArgument({ name: 'topic' }, { type: 'string', value: { nested: true } }), /app_prompt_argument_invalid:topic/);
  assert.throws(() => normalizeFileArgumentValue({ name: 'statement', multiple: false }, [
    { type: 'file', name: 'a.csv', dataBase64: 'YQ==' },
    { type: 'file', name: 'b.csv', dataBase64: 'Yg==' },
  ]), /app_prompt_argument_multiple_not_allowed:statement/);
  assert.throws(() => normalizeFileArgumentValue({ name: 'statement', multiple: true }, [
    { type: 'file', name: 'a.csv' },
  ]), /app_prompt_argument_invalid:statement/);
  assert.deepEqual(buildLegacyPromptVariables({ category: 'tax' }, []), { category: 'tax' });
  assert.equal(formatFileArgumentForPrompt([]), '');
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 42 },
  }), 'en'), null);
  assert.equal(progressFromTaskOutput(JSON.stringify({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'python scripts/import_movements.py', status: 'failed' },
  }), 'en'), 'The assistant found a technical limitation and is trying another approach.');

  const noTimeout = await runCommandCapture(process.execPath, [
    '-e',
    'process.stdout.write("done")',
  ], {
    cwd: process.cwd(),
    timeoutMs: 0,
  });
  assert.equal(noTimeout.stdout, 'done');

  const defaultOptions = await runCommandCapture(process.execPath, [
    '-e',
    'process.stdout.write(Boolean(process.env.PATH) ? "has-path" : "missing-path")',
  ], {
    cwd: process.cwd(),
  });
  assert.equal(defaultOptions.stdout, 'has-path');

  await assert.rejects(() => runCommandCapture(path.join(tmpdir(), 'missing-command-for-forger-tests'), [], {
    cwd: process.cwd(),
    timeoutMs: 1_000,
  }), /ENOENT/);

  let killCalled = false;
  killProcessTree({
    killed: false,
    kill(signal) {
      killCalled = signal === 'SIGKILL';
    },
  });
  assert.equal(killCalled, true);

  let fallbackKillCalled = false;
  killProcessTree({
    killed: false,
    pid: 999_999_999,
    kill(signal) {
      fallbackKillCalled = signal === 'SIGKILL';
    },
  });
  assert.equal(fallbackKillCalled, true);
});
