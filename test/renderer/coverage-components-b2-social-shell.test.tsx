import { createRef, type ComponentProps, type SyntheticEvent } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PromptPreviewDialog } from '@renderer/views/app-view/PromptPreviewDialog';
import { SocialLauncherButton } from '@renderer/views/friends/SocialLauncherButton';
import { SocialPanelHeader } from '@renderer/views/friends/SocialPanelHeader';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { ForgerAccountSession } from '@shared/types';

const t = en as unknown as AppDictionary;
const confirmedAccount: ForgerAccountSession = {
  authenticated: true,
  user: {
    id: 1,
    email: 'person@example.test',
    username: 'person',
    confirmed: true,
    subscriptionTier: 'free',
  },
};

describe('PromptPreviewDialog shell', () => {
  it('stays closed without a preview', () => {
    render(<PromptPreviewDialog preview={null} t={t} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows optional context and closes from its action', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PromptPreviewDialog
        preview={{ title: 'Weekly summary', description: 'Exact provider context', prompt: 'Summarize this week.' }}
        t={t}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Weekly summary' })).toBeInTheDocument();
    expect(screen.getByText('Exact provider context')).toBeInTheDocument();
    expect(screen.getByText('Summarize this week.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders a preview without optional context and closes with Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <PromptPreviewDialog
        preview={{ title: 'Direct prompt', prompt: 'Run this prompt.' }}
        t={t}
        onClose={onClose}
      />,
    );
    expect(screen.queryByText('Exact provider context')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('SocialLauncherButton shell', () => {
  it.each([
    { topbar: true, open: true, badgeCount: 0 },
    { topbar: true, open: false, badgeCount: 2 },
    { topbar: false, open: true, badgeCount: 2 },
    { topbar: false, open: false, badgeCount: 0 },
  ])('toggles from topbar=$topbar open=$open badge=$badgeCount', async ({ topbar, open, badgeCount }) => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const launcherRef = createRef<HTMLButtonElement>();
    render(
      <SocialLauncherButton
        badgeCount={badgeCount}
        open={open}
        panelId="social-panel"
        topbar={topbar}
        launcherRef={launcherRef}
        onToggle={onToggle}
      />,
    );

    const launcher = screen.getByRole('button', { name: 'Social' });
    expect(launcherRef.current).toBe(launcher);
    expect(launcher).toHaveAttribute('aria-expanded', String(open));
    if (open) expect(launcher).toHaveAttribute('aria-describedby', 'social-panel');
    else expect(launcher).not.toHaveAttribute('aria-describedby');
    await user.click(launcher);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

const renderSocialHeader = ({
  account = confirmedAccount,
  accountBusy = false,
  accountUsername = 'person',
  editingUsername = false,
  launcherBusy = false,
  profileUsername = 'new_person',
  profileUsernameError = null as string | null,
  usernameAvailableDate = null as string | null,
  usernameChangeBlocked = false,
  canUpdateUsername = true,
}: Partial<ComponentProps<typeof SocialPanelHeader>> = {}) => {
  const handlers = {
    onCancelUsernameEdit: vi.fn(),
    onEditingUsernameChange: vi.fn(),
    onProfileUsernameChange: vi.fn(),
    onProfileUsernameErrorChange: vi.fn(),
    onUsernameSubmit: vi.fn((event?: SyntheticEvent) => event?.preventDefault()),
  };
  const view = render(
    <SocialPanelHeader
      account={account}
      accountBusy={accountBusy}
      accountUsername={accountUsername}
      editingUsername={editingUsername}
      launcherBusy={launcherBusy}
      profileUsername={profileUsername}
      profileUsernameError={profileUsernameError}
      tabSubtitle="Your conversations"
      usernameAvailableDate={usernameAvailableDate}
      usernameChangeBlocked={usernameChangeBlocked}
      canUpdateUsername={canUpdateUsername}
      {...handlers}
    />,
  );
  return { ...view, ...handlers };
};

describe('SocialPanelHeader shell', () => {
  it('edits, validates, submits, and cancels a username', async () => {
    const user = userEvent.setup();
    const handlers = renderSocialHeader({ editingUsername: true, profileUsernameError: 'Already taken', launcherBusy: true });
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    const input = screen.getByRole('textbox', { name: 'Nuevo username' });
    expect(input).toHaveAccessibleDescription('Already taken');

    await user.clear(input);
    await user.type(input, 'available_name');
    expect(handlers.onProfileUsernameChange).toHaveBeenCalled();
    expect(handlers.onProfileUsernameErrorChange).toHaveBeenCalledWith(null);

    await user.click(screen.getByLabelText('Guardar username').querySelector('button') as HTMLButtonElement);
    expect(handlers.onUsernameSubmit).toHaveBeenCalledOnce();
    await user.click(screen.getByLabelText('Cancelar').querySelector('button') as HTMLButtonElement);
    expect(handlers.onCancelUsernameEdit).toHaveBeenCalledOnce();
  });

  it('locks editing while account work is busy and disables a blank username', () => {
    const busy = renderSocialHeader({ editingUsername: true, accountBusy: true, profileUsername: '', launcherBusy: false });
    expect(screen.getByRole('textbox', { name: 'Nuevo username' })).toBeDisabled();
    expect(screen.getByLabelText('Guardar username').querySelector('button')).toBeDisabled();
    expect(screen.getByLabelText('Cancelar').querySelector('button')).toBeDisabled();
    busy.unmount();

    renderSocialHeader({ editingUsername: true, accountBusy: false, profileUsername: '   ' });
    expect(screen.getByLabelText('Guardar username').querySelector('button')).toBeDisabled();
    expect(screen.getByText('Letras, numeros o guion bajo.')).toBeInTheDocument();
  });

  it('starts editing for a confirmed account and explains a blocked change date', async () => {
    const user = userEvent.setup();
    const handlers = renderSocialHeader();
    expect(screen.getByText('Tu username: @person')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cambiar username' }));
    expect(handlers.onEditingUsernameChange).toHaveBeenCalledWith(true);
    handlers.unmount();

    renderSocialHeader({ usernameChangeBlocked: true, usernameAvailableDate: '20/08/2026' });
    expect(screen.getByRole('button', { name: 'Cambiar username' })).toBeDisabled();
    expect(screen.getByText('Puedes cambiarlo desde el 20/08/2026.')).toBeInTheDocument();
  });

  it.each([
    { account: { authenticated: false } satisfies ForgerAccountSession, canUpdateUsername: true },
    { account: { authenticated: true } satisfies ForgerAccountSession, canUpdateUsername: true },
    { account: confirmedAccount, canUpdateUsername: false },
  ])('hides username editing when the account is not eligible', ({ account, canUpdateUsername }) => {
    renderSocialHeader({ account, accountUsername: '', canUpdateUsername });
    expect(screen.getByText('Tu cuenta no tiene username visible')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cambiar username' })).not.toBeInTheDocument();
  });
});
