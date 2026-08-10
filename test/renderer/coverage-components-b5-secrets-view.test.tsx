import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SecretsView } from '@renderer/views/SecretsView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { UserSecretSummary } from '@shared/types';

const t = en as unknown as AppDictionary;
const secrets: UserSecretSummary[] = [
  { id: 'secret-1', name: 'OpenAI key', createdAt: '2026-08-09T10:00:00.000Z', updatedAt: '2026-08-09T10:00:00.000Z' },
  { id: 'secret-2', name: 'GitHub token', createdAt: '2026-08-09T11:00:00.000Z', updatedAt: '2026-08-09T11:00:00.000Z' },
];

const renderView = ({ items = secrets, busy = false } = {}) => {
  const handlers = {
    onCreateSecret: vi.fn().mockResolvedValue(undefined),
    onUpdateSecret: vi.fn().mockResolvedValue(undefined),
    onDeleteSecret: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(<SecretsView secrets={items} busy={busy} t={t} {...handlers} />);
  return { ...handlers, ...view };
};

describe('SecretsView', () => {
  it('creates a secret, supports value visibility, and resets the form after saving', async () => {
    const user = userEvent.setup();
    const handlers = renderView({ items: [] });

    expect(screen.getByText(t.sections.secrets.empty)).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: t.secrets.secretName });
    const value = screen.getByLabelText(t.secrets.secretValue);
    const save = screen.getByRole('button', { name: t.secrets.save });
    expect(save).toBeDisabled();
    expect(value).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show secret value' }));
    expect(value).toHaveAttribute('type', 'text');
    await user.type(name, '  New API key  ');
    await user.type(value as HTMLInputElement, 'secret-value');
    await user.click(save);

    expect(handlers.onCreateSecret).toHaveBeenCalledWith({ name: '  New API key  ', value: 'secret-value' });
    expect(name).toHaveValue('');
    expect(value).toHaveValue('');
    expect(value).toHaveAttribute('type', 'password');
  });

  it('edits names and optional values and resets the editor after updating', async () => {
    const user = userEvent.setup();
    const handlers = renderView();

    const openAiCard = screen.getByText('OpenAI key').closest('.MuiPaper-root') as HTMLElement;
    await user.click(within(openAiCard).getByRole('button', { name: t.secrets.edit }));
    const dialog = screen.getByRole('dialog');
    const editName = within(dialog).getByRole('textbox', { name: t.secrets.secretName });
    const editValue = within(dialog).getByLabelText(t.secrets.newSecretValue);
    await user.clear(editName);
    expect(within(dialog).getByRole('button', { name: t.secrets.update })).toBeDisabled();
    await user.type(editName, 'Renamed key');
    await user.click(within(dialog).getByRole('button', { name: 'Show secret value' }));
    expect(editValue).toHaveAttribute('type', 'text');
    await user.type(editValue, 'replacement');
    await user.click(within(dialog).getByRole('button', { name: t.secrets.update }));
    expect(handlers.onUpdateSecret).toHaveBeenCalledWith({ id: 'secret-1', name: 'Renamed key', value: 'replacement' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the stored value when an edit is submitted without a replacement', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    await user.click(screen.getAllByRole('button', { name: t.secrets.edit })[1]);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.secrets.update }));
    expect(handlers.onUpdateSecret).toHaveBeenLastCalledWith({ id: 'secret-2', name: 'GitHub token' });
  });

  it('cancels an edit and confirms destructive deletion', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const handlers = renderView();
    const githubCard = screen.getByText('GitHub token').closest('.MuiPaper-root') as HTMLElement;
    await user.click(within(githubCard).getByRole('button', { name: t.secrets.edit }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.secrets.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const currentGithubCard = screen.getByText('GitHub token').closest('.MuiPaper-root') as HTMLElement;
    const deleteButton = within(currentGithubCard).getByRole('button', { name: t.secrets.delete });
    await user.click(deleteButton);
    await user.click(deleteButton);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(handlers.onDeleteSecret).toHaveBeenCalledOnce();
    expect(handlers.onDeleteSecret).toHaveBeenCalledWith('secret-2');
  });

  it('keeps an open editor locked while a mutation is busy', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    await user.click(screen.getAllByRole('button', { name: t.secrets.edit })[0]);
    handlers.rerender(<SecretsView secrets={secrets} busy t={t} onCreateSecret={handlers.onCreateSecret} onUpdateSecret={handlers.onUpdateSecret} onDeleteSecret={handlers.onDeleteSecret} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: t.secrets.secretName })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: t.secrets.cancel })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: t.secrets.update })).toBeDisabled();
    expect(screen.getByText(t.secrets.save).closest('button')).toBeDisabled();
  });
});
