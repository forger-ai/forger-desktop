import { createTheme, ThemeProvider } from '@mui/material/styles';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgerAccountSession } from '@shared/types';
import { en } from '@renderer/i18n/en';

import { ForgerCloudModal } from '@renderer/components/ForgerCloudModal';

const guest: ForgerAccountSession = { authenticated: false };

const signedIn = (overrides: Partial<NonNullable<ForgerAccountSession['user']>> = {}): ForgerAccountSession => ({
  authenticated: true,
  user: {
    id: 1,
    email: 'ada@example.com',
    username: 'ada',
    confirmed: true,
    subscriptionTier: 'free',
    ...overrides,
  },
});

const callbacks = () => ({
  onClose: vi.fn(),
  onLogin: vi.fn(async () => undefined),
  onGoogleLogin: vi.fn(async () => undefined),
  onAppleLogin: vi.fn(async () => undefined),
  onRegister: vi.fn(async () => false),
  onUpdateUsername: vi.fn(async () => false),
  onLogout: vi.fn(async () => undefined),
});

const renderModal = ({
  account = guest,
  busy = false,
  message = null as string | null,
  open = true,
  dark = false,
} = {}) => {
  const actions = callbacks();
  const component = (next: {
    account?: ForgerAccountSession;
    busy?: boolean;
    message?: string | null;
    open?: boolean;
    dark?: boolean;
  } = {}) => (
    <ThemeProvider theme={createTheme({ palette: { mode: next.dark ?? dark ? 'dark' : 'light' } })}>
      <ForgerCloudModal
        open={next.open ?? open}
        t={en}
        account={next.account ?? account}
        busy={next.busy ?? busy}
        message={next.message ?? message}
        {...actions}
      />
    </ThemeProvider>
  );
  const view = render(component());
  return { ...view, ...actions, rerenderModal: (next?: Parameters<typeof component>[0]) => view.rerender(component(next)) };
};

describe('ForgerCloudModal', () => {
  let openExternalUrl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openExternalUrl = vi.fn(async () => ({ success: true }));
    Object.defineProperty(window, 'forger', {
      configurable: true,
      value: { openExternalUrl },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
  });

  it('opens the guest introduction, providers, legal links, and close action', async () => {
    const view = renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerenderModal({ open: true, message: 'Welcome to Cloud' });

    expect(screen.getByRole('alert')).toHaveTextContent('Welcome to Cloud');
    expect(screen.getByText(en.cloud.cards.reviews.title)).toBeVisible();
    expect(screen.getByText(en.cloud.cards.feedback.title)).toBeVisible();
    expect(screen.getByText(en.cloud.cards.sync.title)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.googleLogin }));
    await userEvent.click(screen.getByRole('button', { name: en.cloud.appleLogin }));
    expect(view.onGoogleLogin).toHaveBeenCalledOnce();
    expect(view.onAppleLogin).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: en.cloud.privacyLink }));
    await userEvent.click(screen.getByRole('button', { name: en.cloud.termsLink }));
    expect(openExternalUrl).toHaveBeenNthCalledWith(1, en.cloud.privacyUrl);
    expect(openExternalUrl).toHaveBeenNthCalledWith(2, en.cloud.termsUrl);
    await userEvent.click(screen.getByRole('button', { name: en.actions.close }));
    expect(view.onClose).toHaveBeenCalledOnce();

    view.rerenderModal({ open: true, busy: true });
    expect(screen.getByRole('button', { name: en.cloud.googleLogin })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.cloud.appleLogin })).toBeDisabled();
  });

  it('validates email login, submits credentials, and switches between forms', async () => {
    const view = renderModal();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.login }));
    expect(screen.getByRole('heading', { name: en.cloud.loginTitle })).toBeVisible();
    expect(screen.getByRole('button', { name: en.cloud.login })).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox', { name: en.settings.emailLabel }), 'ada@example.com');
    const password = screen.getByLabelText(en.settings.passwordLabel);
    await userEvent.type(password, 'secret');
    await userEvent.click(screen.getByRole('button', { name: en.cloud.login }));
    expect(view.onLogin).toHaveBeenCalledWith('ada@example.com', 'secret');

    await userEvent.click(screen.getByRole('button', { name: en.cloud.googleLogin }));
    await userEvent.click(screen.getByRole('button', { name: en.cloud.appleLogin }));
    expect(view.onGoogleLogin).toHaveBeenCalledOnce();
    expect(view.onAppleLogin).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.register }));
    expect(screen.getByRole('heading', { name: en.cloud.registerTitle })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.login }));
    expect(screen.getByRole('heading', { name: en.cloud.loginTitle })).toBeVisible();
  });

  it('registers with absent and populated optional profile fields and sanitizes age', async () => {
    const view = renderModal();
    view.onRegister.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: en.cloud.register }));
    const register = screen.getByRole('button', { name: en.cloud.register });
    expect(register).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox', { name: en.cloud.firstName }), 'Ada');
    await userEvent.type(screen.getByRole('textbox', { name: en.cloud.lastName }), 'Lovelace');
    await userEvent.type(screen.getByRole('textbox', { name: en.cloud.username }), 'ada_l');
    await userEvent.type(screen.getByRole('textbox', { name: en.settings.emailLabel }), 'ada@example.com');
    await userEvent.type(screen.getByLabelText(en.settings.passwordLabel), 'secret');
    await userEvent.click(register);
    expect(view.onRegister).toHaveBeenNthCalledWith(1, {
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada_l',
      email: 'ada@example.com',
      password: 'secret',
      country: undefined,
      age: undefined,
      gender: undefined,
    });
    expect(screen.getByRole('heading', { name: en.cloud.registerTitle })).toBeVisible();

    const country = screen.getByRole('combobox', { name: en.cloud.country });
    await userEvent.click(country);
    await userEvent.type(country, 'Chile');
    await userEvent.click(await screen.findByRole('option', { name: /Chile/i }));
    await userEvent.click(country);
    expect(await screen.findByRole('option', { name: /Chile/i })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    const clearCountry = screen.getByTitle('Clear');
    await userEvent.click(clearCountry);
    await userEvent.click(country);
    await userEvent.clear(country);
    await userEvent.type(country, 'Chile');
    await userEvent.click(await screen.findByRole('option', { name: /Chile/i }));

    const age = screen.getByRole('textbox', { name: en.cloud.age });
    await userEvent.type(age, '12a3456');
    expect(age).toHaveValue('123');
    await userEvent.click(screen.getByRole('combobox', { name: en.cloud.gender }));
    await userEvent.click(screen.getByRole('option', { name: en.cloud.genders.other }));
    await userEvent.click(screen.getByRole('button', { name: en.cloud.googleLogin }));
    await userEvent.click(screen.getByRole('button', { name: en.cloud.appleLogin }));
    expect(view.onGoogleLogin).toHaveBeenCalledOnce();
    expect(view.onAppleLogin).toHaveBeenCalledOnce();
    await userEvent.click(register);

    await waitFor(() => expect(screen.getByRole('heading', { name: en.cloud.loginTitle })).toBeVisible());
    expect(view.onRegister).toHaveBeenNthCalledWith(2, expect.objectContaining({
      country: 'CL',
      age: 123,
      gender: 'other',
    }));
    expect(screen.getByLabelText(en.settings.passwordLabel)).toHaveValue('');
  });

  it('updates, rejects, and cancels an authenticated username before signing out', async () => {
    const view = renderModal({ account: signedIn(), message: 'Profile ready' });
    view.onUpdateUsername.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(screen.getByRole('alert')).toHaveTextContent('Profile ready');
    expect(screen.getByText(en.cloud.signedInAs('ada@example.com'))).toBeVisible();
    expect(screen.getByText(en.cloud.confirmed)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.changeUsername }));
    const username = screen.getByRole('textbox', { name: en.cloud.username });
    await userEvent.clear(username);
    await userEvent.type(username, 'ada_new');
    await userEvent.click(screen.getByRole('button', { name: en.cloud.saveUsername }));
    expect(view.onUpdateUsername).toHaveBeenNthCalledWith(1, 'ada_new');
    expect(screen.getByRole('textbox', { name: en.cloud.username })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.saveUsername }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: en.cloud.username })).not.toBeInTheDocument());
    expect(view.onUpdateUsername).toHaveBeenNthCalledWith(2, 'ada_new');

    await userEvent.click(screen.getByRole('button', { name: en.cloud.changeUsername }));
    await userEvent.clear(screen.getByRole('textbox', { name: en.cloud.username }));
    await userEvent.type(screen.getByRole('textbox', { name: en.cloud.username }), 'discarded');
    await userEvent.click(screen.getByRole('button', { name: en.cloud.cancelUsername }));
    expect(screen.getByText('@ada')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.logout }));
    expect(view.onLogout).toHaveBeenCalledOnce();
  });

  it('blocks username edits until a valid future date and handles missing profile data', async () => {
    const view = renderModal({
      account: signedIn({
        confirmed: false,
        usernameChangeAvailableAt: '2099-08-10T00:00:00.000Z',
      }),
      busy: true,
      dark: true,
    });

    expect(screen.getByText(en.cloud.confirmationRequired)).toBeVisible();
    expect(screen.getByText(/Puedes cambiar tu username desde el/)).toBeVisible();
    expect(screen.getByRole('button', { name: en.cloud.changeUsername })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.cloud.logout })).toBeDisabled();
    expect(screen.getAllByAltText('Forger')).toHaveLength(2);

    view.rerenderModal({
      account: signedIn({ username: undefined, usernameChangeAvailableAt: 'not-a-date' }),
      busy: false,
      dark: false,
    });
    expect(screen.getByText('@')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.changeUsername }));
    expect(screen.getByRole('button', { name: en.cloud.saveUsername })).toBeDisabled();
    view.rerenderModal({
      account: signedIn({ username: undefined, usernameChangeAvailableAt: '2099-08-10T00:00:00.000Z' }),
      busy: false,
    });
    expect(screen.getByText(/Disponible desde el/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: en.cloud.cancelUsername }));
  });

  it('falls back to guest content for an authenticated session without a user', () => {
    renderModal({ account: { authenticated: true }, message: 'Session incomplete' });
    expect(screen.getByText(en.cloud.cards.reviews.title)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Session incomplete');
    expect(screen.getByRole('button', { name: en.cloud.logout })).toBeVisible();
  });
});
