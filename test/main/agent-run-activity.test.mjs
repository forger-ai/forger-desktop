import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  appendProviderActivity,
  buildAgentRunActivityFromProgressLog,
  createAgentRunActivity,
  parseProviderOutputActivityItems,
  sanitizeAgentRunActivityText,
} = require('../../dist-electron/main/chat/agent-run-activity.js');
const {
  toProviderProgressMessages,
} = require('../../dist-electron/main/chat/progress-errors.js');
const {
  buildAgentRunActivityTimeline,
  formatAgentRunActivityDuration,
} = require('../../dist-electron/shared/agent-run-activity-view.js');

const now = '2026-01-01T00:00:00.000Z';
const timelineLabels = {
  fallbackTitle: 'Agent activity',
  workedFor: (duration) => `Worked for ${duration}`,
  activityTitle: (count) => `${count} ${count === 1 ? 'action' : 'actions'}`,
  duration: {
    hours: 'h',
    minutes: 'min',
    seconds: 's',
  },
  kinds: {
    mcp_call: 'Used an app tool.',
    file_read: 'Read a file or searched code.',
    file_write: 'Changed files.',
    command: 'Ran a command.',
    connected_service: 'Used a connected service.',
    permission: 'Requested permission.',
    status: 'Updated status.',
    assistant_note: 'Added a note.',
    error: 'Recorded an error.',
  },
};

test('parses Codex JSONL chunks into sanitized activity items', () => {
  const secret = 'sk-private-token-value';
  const items = parseProviderOutputActivityItems({
    provider: 'codex',
    stream: 'stdout',
    now,
    text: [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'forger', name: 'workflow_get_context' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: `OPENAI_API_KEY=${secret} cat /Users/example-user/Desktop/private.csv`, exit_code: 0 } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Done for felipe@example.com with Bearer ${secret} at /Users/example-user/Desktop/private.csv` } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'),
  });

  assert.deepEqual(items.map((item) => item.kind), [
    'status',
    'status',
    'mcp_call',
    'command',
    'assistant_note',
    'status',
  ]);
  assert.equal(items[0].summary, 'Provider thread started.');
  assert.equal(items[2].technicalLabel, 'workflow_get_context');
  assert.equal(items[3].technicalDetails.includes(secret), false);
  assert.equal(items[3].technicalDetails.includes('/Users/example-user/Desktop'), false);
  assert.equal(items[4].summary.includes(secret), false);
  assert.equal(items[4].summary.includes('felipe@example.com'), false);
  assert.equal(items[4].summary.includes('/Users/example-user/Desktop'), false);
  assert.match(items[4].summary, /Bearer \[REDACTED]/);
  assert.match(items[4].summary, /\[REDACTED_PATH]/);
});

test('appends provider activity and updates counts, summary, and redactions', () => {
  const activity = createAgentRunActivity({
    runId: 'run-1',
    surface: 'desktop_chat',
    status: 'running',
    startedAt: now,
    updatedAt: now,
  });
  const next = appendProviderActivity({
    activity,
    provider: 'codex',
    stream: 'stdout',
    now,
    text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Loaded token=private-token-value' } }),
  });

  assert.equal(next.items.length, 1);
  assert.equal(next.summary, 'Loaded token=[hidden sensitive value]');
  assert.equal(next.counts.notes, 1);
  assert.equal(next.redactions.includes('Hidden sensitive value'), true);
});

test('keeps long assistant activity summaries intact after sanitizing', () => {
  const longMessage = Array.from({ length: 90 }, (_value, index) =>
    `segment-${index.toString().padStart(2, '0')} keeps its full wording in the activity timeline`)
    .join(' ');
  const items = parseProviderOutputActivityItems({
    provider: 'codex',
    stream: 'stdout',
    now,
    text: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: longMessage } }),
  });

  assert.equal(longMessage.length > 160, true);
  assert.equal(longMessage.length > 1200, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].summary, longMessage);
  assert.equal(items[0].summary.endsWith('...'), false);
});

test('keeps provider progress messages complete and chronological', () => {
  const messages = Array.from({ length: 8 }, (_value, index) =>
    `Progress ${index + 1}: ${'complete intermediate wording '.repeat(8)}end ${index + 1}.`);
  const progress = toProviderProgressMessages(
    'codex',
    'stdout',
    messages
      .map((message) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
      .join('\n'),
  );

  assert.equal(messages[0].length > 160, true);
  assert.equal(progress.length, messages.length);
  assert.deepEqual(progress, messages.map((message) => message.replace(/\s+/g, ' ').trim()));
  assert.equal(progress.some((message) => message.endsWith('...')), false);
});

test('parses Claude stream events with message text, tool use, and final result', () => {
  const items = parseProviderOutputActivityItems({
    provider: 'claude',
    stream: 'stdout',
    now,
    text: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading the requested file for felipe@example.com.' },
            { type: 'tool_use', name: 'Read' },
          ],
        },
      }),
      JSON.stringify({ type: 'result', session_id: 'session-1', result: 'Final answer.' }),
    ].join('\n'),
  });

  assert.deepEqual(items.map((item) => item.kind), [
    'status',
    'assistant_note',
    'file_read',
    'assistant_note',
  ]);
  assert.equal(items[1].summary.includes('felipe@example.com'), false);
  assert.equal(items[2].technicalLabel, 'Read');
  assert.equal(items[3].summary, 'Final answer.');
});

test('handles plain provider output safely and skips malformed structured fragments', () => {
  const items = parseProviderOutputActivityItems({
    provider: 'antigravity',
    stream: 'stderr',
    now,
    text: [
      'Log file: /Users/example-user/Desktop/provider.log',
      '{"type":"item.started"',
      'Provider failed with token=private-token-value and /Users/example-user/Documents/input.csv',
    ].join('\n'),
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'assistant_note');
  assert.equal(items[0].summary.includes('private-token-value'), false);
  assert.equal(items[0].summary.includes('/Users/example-user/Documents'), false);
  assert.match(items[0].summary, /\[hidden sensitive value]/);
  assert.match(items[0].summary, /\[REDACTED_PATH]/);
});

test('builds aggregate activity from progressLog fallback', () => {
  const activity = buildAgentRunActivityFromProgressLog({
    runId: 'fallback-run',
    surface: 'desktop_chat',
    status: 'completed',
    startedAt: now,
    updatedAt: now,
    progressLog: [
      'Starting',
      '',
      'Starting',
      'Loaded Bearer sk-private-token-value from /Users/example-user/Desktop/private.csv',
    ],
  });

  assert.equal(activity.status, 'completed');
  assert.equal(activity.counts.notes, 2);
  assert.equal(activity.items[0].summary, 'Starting');
  assert.equal(activity.items[1].summary.includes('sk-private-token-value'), false);
  assert.equal(activity.items[1].summary.includes('/Users/example-user/Desktop'), false);
  assert.match(activity.items[1].summary, /Bearer \[REDACTED]/);
  assert.match(activity.items[1].summary, /\[REDACTED_PATH]/);
});

test('sanitizes activity text without exposing sensitive values', () => {
  const sanitized = sanitizeAgentRunActivityText(
    'Bearer sk-private-token-value sent to felipe@example.com from /Users/example-user/Desktop/private.csv',
  );

  assert.equal(sanitized.includes('sk-private-token-value'), false);
  assert.equal(sanitized.includes('felipe@example.com'), false);
  assert.equal(sanitized.includes('/Users/example-user/Desktop'), false);
});

test('builds minimal activity timeline without technical labels or truncating notes', () => {
  const longNote = 'This is a deliberately long intermediate note that should stay visible in full instead of being ellipsized or replaced by a shortened summary.';
  const activity = createAgentRunActivity({
    runId: 'run-1',
    surface: 'desktop_chat',
    status: 'running',
    startedAt: now,
    updatedAt: now,
  });
  const withItems = {
    ...activity,
    durationMs: 65_000,
    items: [
      {
        id: 'tool-1',
        kind: 'mcp_call',
        summary: 'Used forger_private_internal_tool.',
        technicalLabel: 'mcp__forger__private_internal_tool',
        technicalDetails: '{"token":"hidden"}',
        createdAt: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'note-1',
        kind: 'assistant_note',
        summary: longNote,
        createdAt: '2026-01-01T00:00:03.000Z',
      },
      {
        id: 'command-1',
        kind: 'command',
        summary: 'Ran cat.',
        technicalLabel: 'cat',
        technicalDetails: 'cat /Users/example-user/Desktop/private.csv',
        createdAt: '2026-01-01T00:00:04.000Z',
      },
    ],
    counts: {
      total: 3,
      mcpCalls: 1,
      fileReads: 0,
      fileWrites: 0,
      commands: 1,
      connectedServices: 0,
      permissions: 0,
      notes: 1,
      errors: 0,
    },
  };

  const timeline = buildAgentRunActivityTimeline({
    activity: withItems,
    mode: 'completed',
    labels: timelineLabels,
  });

  assert.equal(timeline.title, 'Worked for 1 min 5 s');
  assert.deepEqual(timeline.rows.map((row) => row.text), [
    'Used an app tool.',
    longNote,
    'Ran a command.',
  ]);
  assert.equal(timeline.rows.some((row) => row.text.includes('mcp__forger__private_internal_tool')), false);
  assert.equal(timeline.rows.some((row) => row.text.includes('/Users/example-user/Desktop')), false);
});

test('builds live timeline from full fallback progress messages', () => {
  const progress = 'A long fallback progress message should be preserved completely for the live transcript instead of showing only a recent sliced subset.';
  const timeline = buildAgentRunActivityTimeline({
    progressMessages: [progress],
    mode: 'live',
    labels: timelineLabels,
  });

  assert.equal(formatAgentRunActivityDuration(3_723_000, timelineLabels.duration), '1 h 2 min');
  assert.equal(timeline.title, '1 action');
  assert.deepEqual(timeline.rows.map((row) => row.text), [progress]);
});

test('builds completed fallback timeline title from localized worked-for duration', () => {
  const timeline = buildAgentRunActivityTimeline({
    progressMessages: [
      {
        id: 'progress-1',
        message: 'Started reviewing the peer agent request.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'progress-2',
        message: 'Finished the handoff notes.',
        createdAt: '2026-01-01T00:00:30.000Z',
      },
    ],
    completedAt: '2026-01-01T00:01:05.000Z',
    mode: 'completed',
    labels: timelineLabels,
  });

  assert.equal(timeline.title, 'Worked for 1 min 5 s');
  assert.notEqual(timeline.title, '2 actions');
});
