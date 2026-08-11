import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildAgentRunActivityTimeline,
  formatAgentRunActivityDuration,
  isActiveAgentRunActivityStatus,
} = require('../../dist-electron/shared/agent-run-activity-view.js');
const {
  deriveAppExecutionState,
  withAppExecutionState,
} = require('../../dist-electron/shared/app-execution-state.js');

const labels = {
  fallbackTitle: 'Activity',
  workedFor: (duration, count) => `Worked ${duration} / ${count}`,
  activityTitle: (count) => count === 0 ? '' : `${count} actions`,
  duration: { hours: 'h', minutes: 'm', seconds: 's' },
  kinds: {
    mcp_call: 'Used an app tool',
    file_read: 'Read a file',
    file_write: 'Wrote a file',
    command: 'Ran a command',
    connected_service: 'Used a service',
    permission: 'Requested permission',
    status: 'Status',
    assistant_note: 'Note',
    error: 'Error',
  },
};

test('activity status and duration helpers expose stable boundary behavior', () => {
  assert.equal(isActiveAgentRunActivityStatus(undefined), false);
  assert.equal(isActiveAgentRunActivityStatus('completed'), false);
  assert.equal(isActiveAgentRunActivityStatus('queued'), true);
  assert.equal(isActiveAgentRunActivityStatus('running'), true);
  assert.equal(isActiveAgentRunActivityStatus('needs_permission'), true);

  assert.equal(formatAgentRunActivityDuration(undefined, labels.duration), '');
  assert.equal(formatAgentRunActivityDuration(Number.NaN, labels.duration), '');
  assert.equal(formatAgentRunActivityDuration(-1, labels.duration), '');
  assert.equal(formatAgentRunActivityDuration(499, labels.duration), '0 s');
  assert.equal(formatAgentRunActivityDuration(65_000, labels.duration), '1 m 5 s');
  assert.equal(formatAgentRunActivityDuration(3_723_000, labels.duration), '1 h 2 m');
});

test('activity timeline falls back to public progress while filtering blank messages', () => {
  const timeline = buildAgentRunActivityTimeline({
    progressMessages: [
      '  later  ',
      '',
      { message: 'first', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'custom', message: 'middle', createdAt: '2026-01-01T00:00:02.000Z' },
      { message: 'undated' },
    ],
    mode: 'live',
    labels,
  });

  assert.equal(timeline.title, '4 actions');
  assert.deepEqual(timeline.rows.map(({ id, text }) => ({ id, text })), [
    { id: 'progress-0', text: 'later' },
    { id: 'progress-2', text: 'first' },
    { id: 'custom', text: 'middle' },
    { id: 'progress-4', text: 'undated' },
  ]);

  const empty = buildAgentRunActivityTimeline({ mode: 'completed', labels });
  assert.deepEqual(empty, {
    title: 'Activity',
    mode: 'completed',
    rows: [],
  });
});

test('activity timeline prefers activity items, sorts dated rows, and derives elapsed time safely', () => {
  const activity = {
    runId: 'run-1',
    surface: 'desktop_chat',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:05.000Z',
    summary: 'Finished safely',
    durationMs: undefined,
    items: [
      { id: '', kind: 'command', summary: 'private command', createdAt: '2026-01-01T00:00:03.000Z' },
      { id: 'note', kind: 'assistant_note', summary: 'Visible note', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'status', kind: 'status', summary: 'Visible status', createdAt: '2026-01-01T00:00:02.000Z' },
      { id: 'error', kind: 'error', summary: 'Visible error' },
      { id: 'unknown', kind: 'mcp_call', summary: 'summary fallback', createdAt: 'invalid' },
    ],
    counts: { total: 5 },
  };
  const timeline = buildAgentRunActivityTimeline({
    activity,
    progressMessages: ['must not be used'],
    completedAt: '2026-01-01T00:00:00.000Z',
    mode: 'completed',
    labels: { ...labels, kinds: { ...labels.kinds, mcp_call: '' } },
  });

  assert.equal(timeline.title, 'Worked 0 s / 5');
  assert.equal(timeline.summary, 'Finished safely');
  assert.equal(timeline.status, 'completed');
  assert.deepEqual(timeline.rows.map((row) => row.text), [
    'Visible note',
    'Visible status',
    'Ran a command',
    'Visible error',
    'summary fallback',
  ]);
  assert.equal(timeline.rows[2].id, 'activity-0');

  const invalidCompletion = buildAgentRunActivityTimeline({
    progressMessages: [{ message: 'one', createdAt: 'invalid' }],
    completedAt: 'also-invalid',
    mode: 'completed',
    labels,
  });
  assert.equal(invalidCompletion.title, '1 actions');

  const validCompletion = buildAgentRunActivityTimeline({
    progressMessages: [{ message: 'one', createdAt: '2026-01-01T00:00:00.000Z' }],
    completedAt: '2026-01-01T00:01:05.000Z',
    mode: 'completed',
    labels,
  });
  assert.equal(validCompletion.title, 'Worked 1 m 5 s / 1');
});

test('app execution state prioritizes remote and local connection evidence', () => {
  const cases = [
    [{ status: 'installed', remoteNetworkShare: { state: 'preparing' } }, { phase: 'starting', mode: 'remote_tunnel', connectMode: 'remote_tunnel' }],
    [{ status: 'running', remoteNetworkShare: { active: true, state: 'waiting_for_session' } }, { phase: 'running', mode: 'remote_tunnel', connectMode: 'remote_tunnel' }],
    [{ status: 'running', remoteNetworkShare: { active: true, state: 'connected' } }, { phase: 'running', mode: 'remote_tunnel', connectMode: 'remote_tunnel' }],
    [{ status: 'running', remoteNetworkShare: { active: false, state: 'connected' } }, { phase: 'running', mode: 'forger', connectMode: null }],
    [{ status: 'running', remoteNetworkShare: { active: true, state: 'error' } }, { phase: 'error', mode: 'remote_tunnel', connectMode: null }],
    [{ status: 'installed', localNetworkShare: { active: true } }, { phase: 'running', mode: 'local_network', connectMode: 'local_network' }],
    [{ status: 'installed', localNetworkShare: { active: false, connectedAt: '2026-01-01' } }, { phase: 'running', mode: 'local_network', connectMode: 'local_network' }],
    [{ status: 'installed' }, { phase: 'stopped', mode: null, connectMode: null }],
    [{ status: 'installing' }, { phase: 'starting', mode: 'forger', connectMode: null }],
    [{ status: 'running' }, { phase: 'running', mode: 'forger', connectMode: null }],
    [{ status: 'error' }, { phase: 'error', mode: null, connectMode: null }],
    [{ status: 'conflict' }, { phase: 'error', mode: null, connectMode: null }],
  ];
  for (const [app, expected] of cases) {
    assert.deepEqual(deriveAppExecutionState(app), expected);
  }
  assert.deepEqual(deriveAppExecutionState({ status: 'installed' }, { startingInForger: true }), {
    phase: 'starting',
    mode: 'forger',
    connectMode: null,
  });

  assert.deepEqual(withAppExecutionState({
    id: 'app-1',
    name: 'App',
    description: '',
    category: 'productivity',
    status: 'installed',
    remoteNetworkShare: { active: true, state: 'connected' },
  }), {
    id: 'app-1',
    name: 'App',
    description: '',
    category: 'productivity',
    status: 'installed',
    remoteNetworkShare: { active: true, state: 'connected' },
    executionPhase: 'running',
    executionMode: 'remote_tunnel',
    connectMode: 'remote_tunnel',
  });
});
