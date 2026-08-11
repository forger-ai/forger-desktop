import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { WorkflowReviewDialog } from '@renderer/views/workflows/WorkflowReviewDialog';
import { WorkflowRevisionsDialog } from '@renderer/views/workflows/WorkflowRevisionsDialog';
import { WorkflowRunModal } from '@renderer/views/workflows/WorkflowRunModal';

const copy = getDictionary('en').sections.workflows;
const baseRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'run-1', workflowId: 'workflow-1', trigger: 'manual', status: 'succeeded',
  startedAt: '2026-08-10T10:00:00.000Z', nodeRuns: [], transcript: '', ...overrides,
});

describe('workflow dialogs', () => {
  it('renders review states, issue shapes, and busy actions', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn(); const onApply = vi.fn();
    const { rerender } = render(<WorkflowReviewDialog open review={null} busy={false} copy={copy} onClose={onClose} onApply={onApply} />);
    expect(screen.getByText(copy.reviewGuarantee)).toBeVisible();
    rerender(<WorkflowReviewDialog open review={{ status: 'ready', issues: [] }} busy={false} copy={copy} onClose={onClose} onApply={onApply} />);
    expect(screen.getByText(copy.reviewReady)).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.applyReview }));
    expect(onApply).toHaveBeenCalledOnce();
    rerender(<WorkflowReviewDialog open review={{ status: 'needs_attention', issues: ['plain', { message: 'message' }, { code: 'code' }, { unexpected: true }, 7, null] }} busy={false} copy={copy} onClose={onClose} onApply={onApply} />);
    expect(screen.getByText(copy.reviewNeedsAttention)).toBeVisible();
    for (const text of ['plain', 'message', 'code', '[object Object]', '7', 'null']) expect(screen.getByText(text)).toBeVisible();
    rerender(<WorkflowReviewDialog open review={{ status: 'ready', issues: [] }} busy copy={copy} onClose={onClose} onApply={onApply} />);
    expect(screen.getByRole('button', { name: copy.cancel })).toBeDisabled();
    expect(screen.getByRole('button', { name: copy.applyReview })).toBeDisabled();
  });

  it('renders empty and populated revisions and confirms restore', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn(); const onRestore = vi.fn();
    const revisions = [
      { id: 'r1', revision: 1, createdAt: '2026-08-10T10:00:00.000Z', applied: true },
      { id: 'r2', revision: 2, createdAt: '2026-08-11T10:00:00.000Z', applied: false },
    ];
    const { rerender } = render(<WorkflowRevisionsDialog open revisions={[]} busy={false} copy={copy} onClose={onClose} onRestore={onRestore} />);
    expect(screen.getByText(copy.noRevisions)).toBeVisible();
    rerender(<WorkflowRevisionsDialog open revisions={revisions} busy={false} copy={copy} onClose={onClose} onRestore={onRestore} />);
    expect(screen.getByText(copy.revisionNumber(1))).toBeVisible();
    expect(screen.getByText(copy.revisionNumber(2))).toBeVisible();
    expect(screen.getByText(copy.appliedRevision)).toBeVisible();
    expect(screen.getByText(copy.draftRevision)).toBeVisible();
    const restoreButtons = screen.getAllByRole('button', { name: copy.restoreAsDraft });
    await user.click(restoreButtons[0]);
    expect(onRestore).toHaveBeenCalledWith(revisions[0]);
    rerender(<WorkflowRevisionsDialog open revisions={revisions} busy copy={copy} onClose={onClose} onRestore={onRestore} />);
    expect(screen.getAllByRole('button', { name: copy.restoreAsDraft })[0]).toBeDisabled();
  });

  it('covers run detail tabs, empty values, statuses, approval, and focus reset', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn(); const onApprove = vi.fn();
    const nodeRun = { nodeId: 'node-1', nodeName: 'Node', nodeType: 'llm_agent' as const, status: 'waiting_approval' as const, input: {}, output: { ok: true }, summary: 'Log', error: 'Oops' };
    const run = baseRun({ status: 'waiting_approval', pendingApprovalNodeId: 'node-1', transcript: 'Transcript', nodeRuns: [nodeRun] });
    const { rerender } = render(<WorkflowRunModal open run={null} focusNodeId={null} copy={copy} onClose={onClose} onApprove={onApprove} />);
    expect(screen.getByText(copy.noRuns)).toBeVisible();
    rerender(<WorkflowRunModal open run={run} focusNodeId="node-1" copy={copy} onClose={onClose} onApprove={onApprove} />);
    expect(screen.getByText('Node')).toBeVisible();
    expect(screen.getByText('Oops')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: copy.log }));
    expect(screen.getByText(/Log\s+Oops\s+Transcript/)).toBeVisible();
    await user.click(screen.getByRole('tab', { name: copy.output }));
    expect(screen.getByText(/"ok": true/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.approve }));
    await user.click(screen.getByRole('button', { name: copy.reject }));
    expect(onApprove).toHaveBeenNthCalledWith(1, 'node-1', true);
    expect(onApprove).toHaveBeenNthCalledWith(2, 'node-1', false);
    rerender(<WorkflowRunModal open run={baseRun({ nodeRuns: [{ ...nodeRun, status: 'succeeded', input: 'text', output: null, error: undefined, summary: undefined }] })} focusNodeId="node-1" copy={copy} onClose={onClose} />);
    await user.click(screen.getByRole('tab', { name: copy.output }));
    expect(screen.getByText(copy.noData)).toBeVisible();
  });
});
