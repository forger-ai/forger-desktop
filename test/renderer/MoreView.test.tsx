import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MoreView } from '@renderer/views/MoreView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { PinnableView, View } from '@renderer/components/Sidebar';

const t = en as unknown as AppDictionary;

const renderMoreView = ({
  pinnedViews = [],
  workflowsEnabled = false,
  workflowsEarlyAccessBusy = false,
}: {
  pinnedViews?: PinnableView[];
  workflowsEnabled?: boolean;
  workflowsEarlyAccessBusy?: boolean;
} = {}) => {
  const onTogglePin = vi.fn<(view: PinnableView) => void>();
  const onOpen = vi.fn<(view: View) => void>();
  const onUpdateWorkflowsEarlyAccess = vi.fn<(enabled: boolean) => void>();
  render(
    <MoreView
      t={t}
      pinnedViews={pinnedViews}
      workflowsEnabled={workflowsEnabled}
      workflowsEarlyAccessBusy={workflowsEarlyAccessBusy}
      onTogglePin={onTogglePin}
      onOpen={onOpen}
      onUpdateWorkflowsEarlyAccess={onUpdateWorkflowsEarlyAccess}
    />,
  );
  return { onTogglePin, onOpen, onUpdateWorkflowsEarlyAccess };
};

const workflowsCard = () => screen.getByText(t.nav.workflows).closest('.MuiCard-root') as HTMLElement;

describe('MoreView', () => {
  it('keeps Workflows navigation and pinning unavailable until early access is enabled', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView();
    const card = workflowsCard();

    expect(within(card).getByRole('button', { name: /Workflows/ })).toBeDisabled();
    expect(within(card).queryByRole('button', { name: t.more.pin })).not.toBeInTheDocument();
    expect(within(card).getByRole('switch', { name: t.more.workflowsDisabled })).not.toBeChecked();

    await user.click(within(card).getByRole('switch', { name: t.more.workflowsDisabled }));

    expect(handlers.onUpdateWorkflowsEarlyAccess).toHaveBeenCalledOnce();
    expect(handlers.onUpdateWorkflowsEarlyAccess).toHaveBeenCalledWith(true);
    expect(handlers.onOpen).not.toHaveBeenCalled();
    expect(handlers.onTogglePin).not.toHaveBeenCalled();
  });

  it('opens and pins enabled surfaces without one action triggering the other', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView({ workflowsEnabled: true });
    const card = workflowsCard();

    await user.click(within(card).getByRole('button', { name: /Workflows/ }));
    expect(handlers.onOpen).toHaveBeenCalledWith('workflows');

    handlers.onOpen.mockClear();
    await user.click(within(card).getByRole('button', { name: t.more.pin }));
    expect(handlers.onTogglePin).toHaveBeenCalledWith('workflows');
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('shows pinned state and lets a person unpin a regular surface', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView({ pinnedViews: ['files'] });
    const filesCard = screen.getByText(t.nav.files).closest('.MuiCard-root') as HTMLElement;

    expect(within(filesCard).getByText(t.more.pinnedBadge)).toBeInTheDocument();
    await user.click(within(filesCard).getByRole('button', { name: t.more.unpin }));

    expect(handlers.onTogglePin).toHaveBeenCalledWith('files');
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('requires confirmation before disabling Workflows and cancel keeps it enabled', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView({ workflowsEnabled: true });

    await user.click(within(workflowsCard()).getByRole('switch', { name: t.more.workflowsEnabled }));
    const dialog = screen.getByRole('dialog', { name: t.more.workflowsDisableTitle });
    expect(within(dialog).getByText(t.more.workflowsDisableBody)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: t.more.workflowsDisableCancel }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(handlers.onUpdateWorkflowsEarlyAccess).not.toHaveBeenCalled();
  });

  it('dismisses the Workflows confirmation with Escape', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView({ workflowsEnabled: true });

    await user.click(within(workflowsCard()).getByRole('switch', { name: t.more.workflowsEnabled }));
    expect(screen.getByRole('dialog', { name: t.more.workflowsDisableTitle })).toBeVisible();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(handlers.onUpdateWorkflowsEarlyAccess).not.toHaveBeenCalled();
  });

  it('disables Workflows only after the person confirms', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView({ workflowsEnabled: true });

    await user.click(within(workflowsCard()).getByRole('switch', { name: t.more.workflowsEnabled }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: t.more.workflowsDisableConfirm }),
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(handlers.onUpdateWorkflowsEarlyAccess).toHaveBeenCalledOnce();
    expect(handlers.onUpdateWorkflowsEarlyAccess).toHaveBeenCalledWith(false);
  });

  it.each([
    { workflowsEnabled: false, status: t.more.workflowsEnabling },
    { workflowsEnabled: true, status: t.more.workflowsDisabling },
  ])('locks the toggle and explains the $status state while an update is busy', ({ workflowsEnabled, status }) => {
    const handlers = renderMoreView({ workflowsEnabled, workflowsEarlyAccessBusy: true });
    const card = workflowsCard();
    const toggle = within(card).getByRole('switch');

    expect(toggle).toBeDisabled();
    expect(toggle.closest('label')).toHaveAttribute('aria-busy', 'true');
    expect(within(card).getByRole('status')).toHaveTextContent(status);
    expect(handlers.onUpdateWorkflowsEarlyAccess).not.toHaveBeenCalled();
  });

  it('navigates to a regular surface from its card', async () => {
    const user = userEvent.setup();
    const handlers = renderMoreView();
    const filesCard = screen.getByText(t.nav.files).closest('.MuiCard-root') as HTMLElement;

    await user.click(within(filesCard).getByRole('button', { name: /Files/ }));

    expect(handlers.onOpen).toHaveBeenCalledWith('files');
  });
});
