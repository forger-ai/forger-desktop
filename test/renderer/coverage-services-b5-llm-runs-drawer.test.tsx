import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunActivity, LlmRunSnapshotItem, LlmRunsSnapshot } from '@shared/types';
import { en } from '@renderer/i18n/en';

import { LlmRunsDrawer } from '@renderer/components/LlmRunsDrawer';

const emptySnapshot = (updatedAt: string): LlmRunsSnapshot => ({
  items: [],
  activeCount: 0,
  errorCount: 0,
  updatedAt,
});

const item = (overrides: Partial<LlmRunSnapshotItem> = {}): LlmRunSnapshotItem => ({
  id: 'run-1',
  kind: 'desktop_chat',
  sourceId: 'source-1',
  appName: 'Forger',
  title: 'Agent run',
  status: 'running',
  startedAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:01:00.000Z',
  ...overrides,
});

const activity = (): AgentRunActivity => ({
  runId: 'run-running',
  surface: 'personal_agent_conversation',
  status: 'running',
  startedAt: '2026-08-10T10:00:00.000Z',
  updatedAt: '2026-08-10T10:01:00.000Z',
  summary: 'Working',
  items: [{
    id: 'note-1',
    kind: 'assistant_note',
    summary: 'Checking the latest context',
    createdAt: '2026-08-10T10:00:30.000Z',
  }],
  counts: {
    total: 1,
    mcpCalls: 0,
    fileReads: 0,
    fileWrites: 0,
    commands: 0,
    connectedServices: 0,
    permissions: 0,
    notes: 1,
    errors: 0,
  },
  redactions: [],
});

describe('LlmRunsDrawer', () => {
  let getSnapshot: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let snapshotChanged: ((snapshot: LlmRunsSnapshot) => void) | undefined;

  beforeEach(() => {
    getSnapshot = vi.fn();
    unsubscribe = vi.fn();
    snapshotChanged = undefined;
    Object.defineProperty(window, 'forger', {
      configurable: true,
      value: {
        getLlmRunsSnapshot: getSnapshot,
        onLlmRunsSnapshotChanged: vi.fn((listener: (snapshot: LlmRunsSnapshot) => void) => {
          snapshotChanged = listener;
          return unsubscribe;
        }),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
  });

  it('keeps the freshest empty snapshot, recovers from refresh errors, and closes from the backdrop', async () => {
    getSnapshot.mockResolvedValueOnce(emptySnapshot('2000-01-01T00:00:00.000Z'));
    const first = render(<LlmRunsDrawer t={en} />);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole('button', { name: en.llmRuns.open }));
    expect(screen.getByText(en.llmRuns.noActive)).toBeVisible();
    expect(screen.getByText(en.llmRuns.empty)).toBeVisible();
    const backdrop = document.querySelector<HTMLElement>('.MuiBackdrop-root');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as HTMLElement);
    await waitFor(() => expect(screen.queryByText(en.llmRuns.title)).not.toBeInTheDocument());
    first.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();

    getSnapshot.mockReset();
    getSnapshot.mockRejectedValueOnce(new Error('snapshot-offline'));
    const second = render(<LlmRunsDrawer t={en} />);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('button', { name: en.llmRuns.open }));
    expect(screen.getByText(en.llmRuns.empty)).toBeVisible();
    second.unmount();
  });

  it('renders every run status and kind, then accepts only fresh pushed snapshots', async () => {
    const snapshot: LlmRunsSnapshot = {
      activeCount: 3,
      errorCount: 1,
      updatedAt: '2099-01-01T00:00:00.000Z',
      items: [
        item({ id: 'queued', title: 'Queued run', status: 'queued', kind: 'desktop_chat', progress: 'Waiting for capacity' }),
        item({ id: 'running', title: 'Running run', status: 'running', kind: 'personal_agent_conversation', activity: activity() }),
        item({ id: 'permission', title: 'Permission run', status: 'needs_permission', kind: 'app_agent_thread', progress: 'Waiting for approval' }),
        item({ id: 'completed', title: 'Completed run', status: 'completed', kind: 'app_prompt_task', progress: undefined, error: undefined }),
        item({ id: 'failed', title: 'Failed run', status: 'failed', kind: 'workflow_node', error: 'The workflow failed' }),
        item({ id: 'canceled', title: 'Canceled run', status: 'canceled', kind: 'desktop_chat', progress: 'Canceled by the user' }),
      ],
    };
    getSnapshot.mockResolvedValueOnce(snapshot);
    render(<LlmRunsDrawer t={en} />);
    await waitFor(() => expect(getSnapshot).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole('button', { name: en.llmRuns.open }));

    expect(screen.getByText(en.llmRuns.activeSummary(3))).toBeVisible();
    for (const run of snapshot.items) {
      expect(screen.getByText(run.title)).toBeVisible();
      expect(screen.getAllByText(en.llmRuns.statuses[run.status]).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(/Forger ·/)).toHaveLength(6);
    expect(screen.getAllByText('Waiting for capacity').length).toBeGreaterThan(0);
    expect(screen.getByText('Checking the latest context')).toBeVisible();
    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0);
    expect(screen.getAllByText(en.llmRuns.noProgress).length).toBeGreaterThan(0);
    expect(screen.getAllByText('The workflow failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Canceled by the user').length).toBeGreaterThan(0);

    expect(snapshotChanged).toBeTypeOf('function');
    act(() => snapshotChanged?.({
      ...emptySnapshot('2098-01-01T00:00:00.000Z'),
      items: [item({ id: 'stale', title: 'Stale pushed run' })],
      activeCount: 1,
    }));
    expect(screen.queryByText('Stale pushed run')).not.toBeInTheDocument();

    act(() => snapshotChanged?.(emptySnapshot('2100-01-01T00:00:00.000Z')));
    expect(screen.getByText(en.llmRuns.noActive)).toBeVisible();
    expect(screen.getByText(en.llmRuns.empty)).toBeVisible();
  });
});
