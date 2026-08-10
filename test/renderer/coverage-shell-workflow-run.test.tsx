import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowRunModal } from '@renderer/views/workflows/WorkflowRunModal';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { WorkflowNodeRun, WorkflowRun } from '@shared/types';

const t = en as unknown as AppDictionary;
const copy = t.sections.workflows;

const node = (overrides: Partial<WorkflowNodeRun> = {}): WorkflowNodeRun => ({
  nodeId: 'review',
  nodeName: 'Review message',
  nodeType: 'llm_agent',
  status: 'waiting_approval',
  input: { message: 'Please review this message' },
  output: {},
  summary: 'The draft needs approval.',
  error: 'The recipient is missing.',
  ...overrides,
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run-1',
  workflowId: 'workflow-1',
  trigger: 'manual',
  status: 'waiting_approval',
  startedAt: '2026-08-10T12:00:00.000Z',
  pendingApprovalNodeId: 'review',
  nodeRuns: [node()],
  transcript: 'Provider transcript',
  ...overrides,
});

describe('WorkflowRunModal shell', () => {
  it('shows an empty state when there is no focused node and closes from the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <WorkflowRunModal
        open
        run={null}
        focusNodeId={null}
        copy={copy}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('dialog', { name: copy.runDetail })).toBeInTheDocument();
    expect(screen.getByText(copy.noRuns)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows errors and structured data, switches tabs, and resolves approval either way', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <WorkflowRunModal
        open
        run={run()}
        focusNodeId="review"
        copy={copy}
        onClose={vi.fn()}
        onApprove={onApprove}
      />,
    );

    expect(screen.getByRole('dialog', { name: /Review message/ })).toBeInTheDocument();
    expect(screen.getByText(copy.statusLabels.waiting_approval)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The recipient is missing.');
    expect(screen.getByText(/Please review this message/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: copy.log }));
    expect(screen.getByText(/The draft needs approval/)).toHaveTextContent('The recipient is missing.');
    expect(screen.getByText(/The draft needs approval/)).toHaveTextContent('Provider transcript');

    await user.click(screen.getByRole('tab', { name: copy.output }));
    expect(screen.getByText(copy.noData)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: copy.approve }));
    await user.click(screen.getByRole('button', { name: copy.reject }));
    expect(onApprove.mock.calls).toEqual([
      ['review', true],
      ['review', false],
    ]);
  });

  it('handles string and primitive values and resets the selected tab for a new focused node', async () => {
    const user = userEvent.setup();
    const firstRun = run({
      status: 'succeeded',
      pendingApprovalNodeId: undefined,
      nodeRuns: [node({ status: 'succeeded', error: undefined, input: 7 as unknown as Record<string, unknown>, output: 'Done' as unknown as Record<string, unknown> })],
      transcript: '',
    });
    const view = render(
      <WorkflowRunModal
        open
        run={firstRun}
        focusNodeId="review"
        copy={copy}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.approve })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: copy.output }));
    expect(screen.getByText('Done')).toBeInTheDocument();

    view.rerender(
      <WorkflowRunModal
        open
        run={run({
          id: 'run-2',
          status: 'succeeded',
          pendingApprovalNodeId: undefined,
          nodeRuns: [node({ nodeId: 'deliver', nodeName: 'Deliver message', status: 'succeeded', error: undefined, input: undefined, output: undefined })],
          transcript: '',
        })}
        focusNodeId="deliver"
        copy={copy}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: copy.input })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(copy.noData)).toBeInTheDocument();
  });

  it('does not offer approval when the run waits on a different node or no handler exists', () => {
    const view = render(
      <WorkflowRunModal
        open
        run={run({ pendingApprovalNodeId: 'another-node' })}
        focusNodeId="review"
        copy={copy}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: copy.approve })).not.toBeInTheDocument();

    view.rerender(
      <WorkflowRunModal
        open
        run={run()}
        focusNodeId="review"
        copy={copy}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: copy.approve })).not.toBeInTheDocument();
  });
});
