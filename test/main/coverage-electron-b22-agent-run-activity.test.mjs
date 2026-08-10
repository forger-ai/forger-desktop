import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const activityModule = require('../../dist-electron/main/chat/agent-run-activity.js');
const {
  activityFromProgressFallback,
  addPermissionActivityItem,
  addStatusActivityItem,
  appendActivityItems,
  appendProviderActivity,
  createAgentRunActivity,
  finalizeAgentRunActivity,
  normalizeActivityStatus,
  parseProviderOutputActivityItems,
  persistAgentRunActivity,
  sanitizeAgentRunActivityText,
} = activityModule;

const now = '2026-08-10T10:00:00.000Z';
const baseActivity = (overrides = {}) => createAgentRunActivity({
  runId: 'run-b22',
  surface: 'desktop_chat',
  status: 'running',
  startedAt: now,
  updatedAt: now,
  ...overrides,
});

test('activity lifecycle defaults, status and permission events remain observable', () => {
  const generated = createAgentRunActivity({ runId: 'generated', surface: 'desktop_chat' });
  assert.equal(generated.status, 'queued');
  assert.equal(generated.startedAt, generated.updatedAt);
  assert.equal(Number.isNaN(Date.parse(generated.updatedAt)), false);

  const started = createAgentRunActivity({ runId: 'started', surface: 'desktop_chat', startedAt: now });
  assert.equal(started.updatedAt, now);
  const updated = createAgentRunActivity({
    runId: 'updated',
    surface: 'personal_agent_conversation',
    updatedAt: now,
    sourceRef: { agentId: 'agent-1' },
  });
  assert.equal(updated.startedAt, now);
  assert.deepEqual(updated.sourceRef, { agentId: 'agent-1' });

  let activity = addStatusActivityItem(baseActivity(), 'Started work');
  assert.equal(activity.items[0].status, 'running');
  activity = addStatusActivityItem(activity, 'Finished work', 'completed');
  activity = addPermissionActivityItem(activity, 'Needs camera');
  activity = addPermissionActivityItem(activity, 'Needs files', 'shared-folder');
  assert.deepEqual(activity.items.slice(-2).map(({ technicalLabel }) => technicalLabel), [undefined, 'shared-folder']);
  assert.equal(activity.counts.permissions, 2);
});

test('activity append rejects empty output, deduplicates, caps history, and counts every item kind', () => {
  const activity = baseActivity();
  assert.equal(appendProviderActivity({ activity, provider: 'codex', stream: 'stdout', text: '  ' }), activity);
  assert.equal(appendProviderActivity({ activity, provider: 'codex', stream: 'meta', text: 'metadata' }), activity);
  assert.equal(appendProviderActivity({ activity, provider: 'codex', stream: 'stdout', text: '{broken' }), activity);
  const generatedTimestamp = parseProviderOutputActivityItems({
    provider: 'codex',
    stream: 'stdout',
    text: JSON.stringify({ type: 'turn.started' }),
  });
  assert.equal(Number.isNaN(Date.parse(generatedTimestamp[0].createdAt)), false);
  assert.equal(appendActivityItems(activity, [{ id: 'blank', kind: 'assistant_note', summary: ' ', createdAt: now }]), activity);

  const everyKind = [
    'mcp_call',
    'file_read',
    'file_write',
    'command',
    'connected_service',
    'permission',
    'status',
    'assistant_note',
    'error',
  ].map((kind, index) => ({
    id: `kind-${index}`,
    kind,
    summary: `item ${index}`,
    createdAt: now,
  }));
  const counted = appendActivityItems(activity, everyKind);
  assert.deepEqual(counted.counts, {
    total: 9,
    mcpCalls: 1,
    fileReads: 1,
    fileWrites: 1,
    commands: 1,
    connectedServices: 1,
    permissions: 1,
    notes: 2,
    errors: 1,
  });

  const many = Array.from({ length: 305 }, (_, index) => ({
    id: `note-${index}`,
    kind: 'assistant_note',
    summary: index < 2 ? 'duplicate' : `note ${index}`,
    technicalLabel: index < 2 ? 'same' : undefined,
    createdAt: now,
  }));
  const capped = appendActivityItems(activity, many);
  assert.equal(capped.items.length, 300);
  assert.equal(capped.items.some(({ id }) => id === 'note-0'), false);
  assert.equal(capped.summary, 'note 304');
});

test('final activity statuses provide terminal fallback copy, errors, and non-negative duration', () => {
  const expected = {
    completed: ['Completed.', 'completed'],
    canceled: ['Canceled.', 'blocked'],
    failed: ['Failed.', 'failed'],
    running: ['Working.', 'running'],
    queued: ['Working.', 'running'],
    needs_permission: ['Working.', 'running'],
  };
  for (const [status, [summary, itemStatus]] of Object.entries(expected)) {
    const finalized = finalizeAgentRunActivity(baseActivity(), status, '2026-08-10T09:00:00.000Z');
    assert.equal(finalized.summary, summary);
    assert.equal(finalized.items[0].status, itemStatus);
    if (['completed', 'canceled', 'failed'].includes(status)) {
      assert.equal(finalized.durationMs, 0);
    } else {
      assert.equal(finalized.finishedAt, undefined);
    }
  }

  const failed = finalizeAgentRunActivity(baseActivity(), 'failed', now, 'password=hunter2');
  assert.equal(failed.items[0].kind, 'error');
  assert.match(failed.summary, /password=\[hidden sensitive value]/);

  const defaultTime = finalizeAgentRunActivity(baseActivity(), 'running');
  assert.equal(Number.isNaN(Date.parse(defaultTime.updatedAt)), false);
});

test('fallback activity and status normalization handle every persisted run vocabulary', () => {
  for (const status of ['queued', 'running', 'needs_permission', 'completed', 'failed', 'canceled']) {
    assert.equal(normalizeActivityStatus(status), status);
  }
  for (const status of ['preview_ready', 'applied', 'undone']) {
    assert.equal(normalizeActivityStatus(status), 'completed');
  }
  assert.equal(normalizeActivityStatus('legacy_unknown'), 'running');

  const fallback = activityFromProgressFallback({
    runId: 'fallback-empty',
    surface: 'workflow_node',
    status: 'legacy_unknown',
    startedAt: now,
    updatedAt: now,
  });
  assert.equal(fallback.status, 'running');
  assert.equal(fallback.summary, 'Working.');

  const finished = activityFromProgressFallback({
    runId: 'fallback-finished',
    surface: 'workflow_node',
    status: 'completed',
    startedAt: now,
    updatedAt: now,
    finishedAt: '2026-08-10T10:00:05.000Z',
    progressLog: ['One step'],
    error: 'final error',
  });
  assert.equal(finished.finishedAt, '2026-08-10T10:00:05.000Z');
  assert.equal(finished.items.at(-1).kind, 'error');
});

test('Codex events cover generic tools, command fallbacks, tool kinds, and raw command details', () => {
  const lines = [
    [],
    null,
    { type: 'tool.started', name: 'forger_lookup' },
    { type: 'tool.completed' },
    { item: { type: 'command_execution', cmd: 'mkdir output' } },
    { item: { type: 'command_execution', text: 'cat input.txt' } },
    { item: { type: 'command_execution' } },
    { item: { type: 'custom_tool', tool_name: 'EditFile' } },
    { item: { type: 'other_tool' } },
    { item: { type: 'custom_tool', name: 'Bash' } },
    { item: { type: 'custom_tool', name: 'unknown' } },
    { item: { type: 'custom_tool', name: 'mcp__forger__status' } },
    { item: { type: 'custom_tool', name: 'service.lookup' } },
    { item: { type: 'agent_message', text: 42 } },
  ].map((entry) => JSON.stringify(entry));
  const items = parseProviderOutputActivityItems({ provider: 'codex', stream: 'stdout', text: lines.join('\n'), now });

  assert.equal(items.some(({ summary }) => summary === 'Used forger_lookup.'), true);
  assert.equal(items.some(({ technicalLabel }) => technicalLabel === 'tool.completed'), true);
  assert.equal(items.some(({ summary }) => summary === 'Changed files.'), true);
  assert.equal(items.some(({ summary }) => summary === 'Read a file or searched code.'), true);
  const rawCommand = items.find(({ technicalLabel }) => technicalLabel === 'command');
  assert.match(rawCommand.technicalDetails, /command_execution/);
  assert.equal(items.some(({ kind }) => kind === 'file_write'), true);
  assert.equal(items.some(({ kind }) => kind === 'file_read'), true);
  assert.equal(items.some(({ kind }) => kind === 'command'), true);
  assert.equal(items.some(({ summary }) => summary === 'Used a tool.'), true);
  assert.equal(items.some(({ summary }) => summary === 'Used forger.status.'), true);
  assert.equal(items.some(({ summary }) => summary === 'Used service.lookup.'), true);
});

test('Claude and Antigravity output cover unnamed tools, MCP lines, noise, errors, and metadata', () => {
  const claude = parseProviderOutputActivityItems({
    provider: 'claude',
    stream: 'stderr',
    now,
    text: [
      'plain provider error',
      JSON.stringify({ type: 'tool_use' }),
      JSON.stringify({ content: [{ type: 'tool_use' }, null, [], 'text'], text: 'direct note' }),
      JSON.stringify({ message: { content: 'invalid' } }),
    ].join('\n'),
  });
  assert.equal(claude[0].kind, 'error');
  assert.equal(claude.filter(({ technicalLabel }) => technicalLabel === 'tool_use').length, 2);

  const antigravity = parseProviderOutputActivityItems({
    provider: 'antigravity',
    stream: 'stdout',
    now,
    text: [
      '',
      'Calling MCP tool: service.lookup',
      'MCP tool forger_status',
      'Print mode: enabled',
      'visible work',
      '{structured fragment',
    ].join('\n'),
  });
  assert.deepEqual(antigravity.map(({ kind }) => kind), ['mcp_call', 'mcp_call', 'assistant_note']);
  assert.deepEqual(parseProviderOutputActivityItems({ provider: 'antigravity', stream: 'meta', text: 'metadata', now }), []);
});

test('activity sanitization redacts all credential shapes and strips markdown and null bytes', () => {
  const secretText = [
    'authorization: Bearer auth-secret',
    'api_key=api-secret',
    'token=token-secret',
    'secret=secret-secret',
    'password=password-secret',
    'cookie=session-cookie',
    'sk-abcdefghijklmnop',
    'ghp_abcdefghijklmnop',
    'xoxb-abcdefghijklmnop',
    '\0',
  ].join(' ');
  const sanitized = sanitizeAgentRunActivityText(secretText);
  assert.equal(/auth-secret|api-secret|token-secret|secret-secret|password-secret|session-cookie|abcdefghijklmnop/.test(sanitized), false);

  const items = parseProviderOutputActivityItems({
    provider: 'codex',
    stream: 'stdout',
    now,
    text: '# Heading with [link](https://example.test) and `code`\n> final note',
  });
  assert.match(items[0].summary, /Heading with link and code/);
});

test('activity persistence writes safe filenames and treats disappearing metadata as benign', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'forger-b22-activity-persist-'));
  const originalMkdir = fs.mkdir;
  try {
    const activity = baseActivity({ runId: '' });
    await persistAgentRunActivity(root, activity);
    const persisted = JSON.parse(await fs.readFile(path.join(root, 'agent-run-activity', 'run.json'), 'utf8'));
    assert.equal(persisted.runId, '');

    fs.mkdir = async () => { throw Object.assign(new Error('metadata removed'), { code: 'ENOENT' }); };
    await assert.doesNotReject(() => persistAgentRunActivity(root, activity));

    fs.mkdir = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
    await assert.rejects(() => persistAgentRunActivity(root, activity), /permission denied/);
  } finally {
    fs.mkdir = originalMkdir;
    await fs.rm(root, { recursive: true, force: true });
  }
});
