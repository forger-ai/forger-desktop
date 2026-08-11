import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppSecretsDialog, AppSecretsPanel } from '@renderer/components/AppSecretsDialog';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { AppSecretsState } from '@shared/types';

const t = en as unknown as AppDictionary;
const userSecrets = [
  { id: 'secret-1', name: 'Primary API key', createdAt: '2026-08-10T09:00:00.000Z', updatedAt: '2026-08-10T09:00:00.000Z' },
  { id: 'secret-2', name: 'Backup token', createdAt: '2026-08-10T09:00:00.000Z', updatedAt: '2026-08-10T09:00:00.000Z' },
];
const state: AppSecretsState = {
  appId: 'planner',
  appName: 'Planner',
  userSecrets,
  appSecrets: [
    {
      appSecret: { name: 'api_key--main', required: true, usage: 'Loads calendar data.' },
      envName: 'API_KEY_MAIN',
      connected: false,
    },
    {
      appSecret: { name: 'optional_token', label: 'Optional token', required: false, usage: 'Enables exports.' },
      envName: 'OPTIONAL_TOKEN',
      connected: true,
      userSecretId: 'secret-2',
      userSecretName: 'Backup token',
    },
  ],
};

const handlers = () => ({
  onConnectSecret: vi.fn<(appSecretName: string, userSecretId: string) => Promise<void>>().mockResolvedValue(undefined),
  onDisconnectSecret: vi.fn<(appSecretName: string) => Promise<void>>().mockResolvedValue(undefined),
});

describe('AppSecretsPanel and AppSecretsDialog', () => {
  it('renders loading and empty declaration states and closes the dialog', async () => {
    const user = userEvent.setup();
    const callbacks = handlers();
    const view = render(
      <AppSecretsDialog open state={null} busy={false} t={t} onClose={vi.fn()} {...callbacks} />,
    );
    expect(screen.getByRole('dialog', { name: t.secrets.title })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const emptyState: AppSecretsState = { appId: 'empty', appName: 'Empty app', appSecrets: [], userSecrets: [] };
    const onClose = vi.fn();
    view.rerender(<AppSecretsDialog open state={emptyState} busy={false} t={t} onClose={onClose} {...callbacks} />);
    expect(screen.getByRole('alert')).toHaveTextContent(t.secrets.noAppSecrets);
    await user.click(screen.getByRole('button', { name: t.secrets.close }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('selects a library secret, connects it, and disconnects an existing mapping', async () => {
    const user = userEvent.setup();
    const callbacks = handlers();
    render(<AppSecretsPanel state={state} busy={false} t={t} {...callbacks} />);

    expect(screen.getByRole('alert')).toHaveTextContent(t.secrets.missingRequired(1));
    expect(screen.getByText('Api Key Main')).toBeInTheDocument();
    expect(screen.getByText('Optional token')).toBeInTheDocument();
    expect(screen.getByText(t.secrets.requiredSummary(1, 1))).toBeInTheDocument();

    const selects = screen.getAllByRole('combobox');
    expect(selects[1]).toHaveTextContent('Backup token');
    await user.click(selects[0]);
    await user.click(screen.getByRole('option', { name: 'Primary API key' }));

    const requirement = screen.getByText('Api Key Main').closest('.MuiBox-root') as HTMLElement;
    await user.click(within(requirement).getByRole('button', { name: t.secrets.connect }));
    expect(callbacks.onConnectSecret).toHaveBeenCalledWith('api_key--main', 'secret-1');

    const optionalRequirement = screen.getByText('Optional token').closest('.MuiBox-root') as HTMLElement;
    await user.click(within(optionalRequirement).getByRole('button', { name: t.secrets.disconnect }));
    expect(callbacks.onDisconnectSecret).toHaveBeenCalledWith('optional_token');
  });

  it('shows ready, empty-library, and busy states without exposing enabled mutations', async () => {
    const user = userEvent.setup();
    const callbacks = handlers();
    const readyState: AppSecretsState = {
      ...state,
      appSecrets: state.appSecrets.map((connection) => ({ ...connection, connected: true, userSecretId: 'secret-1' })),
    };
    const view = render(<AppSecretsPanel state={readyState} busy={false} t={t} {...callbacks} />);
    expect(screen.getByRole('alert')).toHaveTextContent(t.secrets.ready);
    view.unmount();

    const noLibraryState: AppSecretsState = {
      ...state,
      userSecrets: [],
      appSecrets: [state.appSecrets[0]],
    };
    const noLibrary = render(<AppSecretsPanel state={noLibraryState} busy={false} t={t} {...callbacks} />);
    expect(screen.getByText(t.secrets.emptyLibrary)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: t.secrets.connect })).toBeDisabled();

    noLibrary.rerender(<AppSecretsPanel state={state} busy t={t} {...callbacks} />);
    expect(screen.getAllByRole('combobox')[0]).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByRole('button', { name: t.secrets.disconnect })[0]).toBeDisabled();
    expect(callbacks.onConnectSecret).not.toHaveBeenCalled();
    expect(callbacks.onDisconnectSecret).not.toHaveBeenCalled();

    noLibrary.rerender(<AppSecretsPanel state={null} busy={false} t={t} {...callbacks} />);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks dialog dismissal while busy', async () => {
    const user = userEvent.setup();
    const callbacks = handlers();
    const onClose = vi.fn();
    render(<AppSecretsDialog open state={state} busy t={t} onClose={onClose} {...callbacks} />);

    expect(screen.getByRole('button', { name: t.secrets.close })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
