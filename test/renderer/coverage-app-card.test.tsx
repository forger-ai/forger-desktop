import { fireEvent, render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppCard } from '@renderer/components/AppCard';

const baseProps = {
  appName: 'Daily Reports',
  categoryLabel: 'Productivity',
  description: 'Create clear daily reports.',
  primaryActionLabel: 'Open',
  primaryAction: 'open' as const,
  onPrimaryAction: vi.fn(),
};

describe('AppCard', () => {
  it('renders metadata and keeps card, primary, secondary, and destructive actions independent', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    const onPrimaryAction = vi.fn();
    const onSecondaryAction = vi.fn();
    const onTertiaryAction = vi.fn();
    const { container } = render(
      <AppCard
        {...baseProps}
        onCardClick={onCardClick}
        onPrimaryAction={onPrimaryAction}
        createdByLabel="Created by Ana"
        statusIndicatorLabel="Running"
        secondaryActionLabel="Configure"
        onSecondaryAction={onSecondaryAction}
        tertiaryActionLabel="Uninstall"
        onTertiaryAction={onTertiaryAction}
        beta
        averageRating={4.26}
        ratingsCount={1234}
        onboardingTarget="reports-card"
      />,
    );

    const card = container.querySelector('.MuiCard-root') as HTMLElement;
    expect(card).toHaveAttribute('role', 'button');
    expect(card).toHaveAttribute('data-onboarding-target', 'reports-card');
    expect(screen.getByText('DR')).toBeVisible();
    expect(screen.getByText('Created by Ana')).toBeVisible();
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
    expect(screen.getByText('Experimental release')).toBeVisible();
    expect(screen.getByText('4.3')).toBeVisible();
    expect(screen.getByText('(1,234)')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Configure' }));
    await user.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(onPrimaryAction).toHaveBeenCalledOnce();
    expect(onSecondaryAction).toHaveBeenCalledOnce();
    expect(onTertiaryAction).toHaveBeenCalledOnce();
    expect(onCardClick).not.toHaveBeenCalled();

    fireEvent.keyDown(card, { key: 'ArrowDown' });
    expect(onCardClick).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    await user.click(card);
    expect(onCardClick).toHaveBeenCalledTimes(3);
  });

  it('uses an image when provided and stays non-interactive without a card action', () => {
    const { container } = render(
      <AppCard {...baseProps} appName=" Reports" iconUrl="https://example.test/icon.png" />,
    );
    const card = container.querySelector('.MuiCard-root') as HTMLElement;
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
    expect(screen.getByRole('img', { name: 'Reports' })).toHaveAttribute('src', 'https://example.test/icon.png');
    fireEvent.keyDown(card, { key: 'Enter' });
  });

  it.each([
    ['stop', 'StopCircleRoundedIcon'],
    ['retry', 'ReplayRoundedIcon'],
    ['update', 'SystemUpdateAltRoundedIcon'],
    ['install', 'DownloadRoundedIcon'],
  ] as const)('renders the %s primary action icon', (primaryAction, iconTestId) => {
    render(<AppCard {...baseProps} primaryAction={primaryAction} />);
    expect(screen.getByTestId(iconTestId)).toBeVisible();
  });

  it('opens, closes, and executes split-button menu actions without opening the card', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    const onPrimaryAction = vi.fn();
    const alternate = vi.fn();
    render(
      <AppCard
        {...baseProps}
        onCardClick={onCardClick}
        onPrimaryAction={onPrimaryAction}
        primaryMenuActions={[{ label: 'Open safely', onClick: alternate }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(onPrimaryAction).toHaveBeenCalledOnce();
    expect(onCardClick).not.toHaveBeenCalled();

    const menuButton = screen.getByRole('button', { name: 'Open menu' });
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    const firstMenu = screen.getByRole('menu');
    fireEvent.click(firstMenu);
    fireEvent.keyDown(firstMenu.closest('.MuiPopover-root') as HTMLElement, { key: 'Escape', code: 'Escape' });
    await waitForElementToBeRemoved(firstMenu);

    await user.click(menuButton);
    await user.click(screen.getByRole('menuitem', { name: 'Open safely' }));
    expect(alternate).toHaveBeenCalledOnce();
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it.each([
    [{ primaryDisabled: true }, 'disabled'],
    [{ primaryLoading: true }, 'loading'],
    [{ installProgress: { phase: 'downloading' as const, userMessage: 'Downloading' } }, 'installing'],
  ])('disables split actions while %s', (state) => {
    render(
      <AppCard
        {...baseProps}
        {...state}
        primaryMenuActions={[{ label: 'Alternative', onClick: vi.fn() }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeDisabled();
  });

  it('clamps determinate install progress and shows its current message', () => {
    const { rerender } = render(
      <AppCard
        {...baseProps}
        installProgress={{ phase: 'downloading', progress: 140, userMessage: 'Almost ready' }}
      />,
    );
    expect(screen.getAllByRole('progressbar').find((item) => item.getAttribute('aria-valuenow') === '100')).toBeDefined();
    expect(screen.getByText('Almost ready')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-busy', 'true');

    rerender(
      <AppCard
        {...baseProps}
        installProgress={{ phase: 'downloading', progress: -20, userMessage: 'Starting' }}
      />,
    );
    expect(screen.getAllByRole('progressbar').find((item) => item.getAttribute('aria-valuenow') === '0')).toBeDefined();
  });

  it('shows indeterminate installation and standalone loading states', () => {
    const { rerender } = render(
      <AppCard {...baseProps} installProgress={{ phase: 'preparing_runtime', userMessage: '' }} />,
    );
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();

    rerender(<AppCard {...baseProps} primaryLoading />);
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-busy', 'true');
  });

  it('omits incomplete optional action pairs and covers empty-name initials safely', () => {
    render(
      <AppCard
        {...baseProps}
        appName="  Reports"
        secondaryActionLabel="No handler"
        onTertiaryAction={vi.fn()}
        betaLabel="Preview"
        averageRating={0}
      />,
    );
    expect(screen.queryByRole('button', { name: 'No handler' })).not.toBeInTheDocument();
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('StarRoundedIcon')).not.toBeInTheDocument();
  });
});
