import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CatalogView } from '@renderer/views/CatalogView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { AppCategory, CatalogApp, ForgerAccountSession, InstallAppResult, SocialUserAppReviewState } from '@shared/types';

interface MockAppCardProps {
  appName: string;
  description: string;
  createdByLabel?: string;
  beta?: boolean;
  betaLabel?: string;
  statusIndicatorLabel?: string;
  primaryAction: string;
  primaryActionLabel: string;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryMenuActions?: Array<{ label: string; onClick: () => void }>;
  installProgress?: InstallAppResult;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  tertiaryActionLabel?: string;
  onTertiaryAction?: () => void;
  onPrimaryAction: () => void;
  onCardClick: () => void;
}

vi.mock('@renderer/components/AppsGrid', () => ({
  AppsGrid: ({ children }: { children: React.ReactNode }) => <div data-testid="apps-grid">{children}</div>,
}));

vi.mock('@renderer/components/AppCard', () => ({
  AppCard: (props: MockAppCardProps) => {
    const id = props.appName.replace('Meta ', '');
    return (
      <article
        data-testid={`catalog-card-${id}`}
        data-primary={props.primaryAction}
        data-disabled={String(Boolean(props.primaryDisabled))}
        data-loading={String(Boolean(props.primaryLoading))}
        data-beta={String(Boolean(props.beta))}
        data-beta-label={props.betaLabel ?? ''}
        data-created-by={props.createdByLabel ?? ''}
        data-description={props.description}
        data-status={props.statusIndicatorLabel ?? ''}
        data-progress={props.installProgress?.phase ?? ''}
      >
        <button type="button" onClick={props.onCardClick}>{`details-${props.appName}`}</button>
        <button
          type="button"
          disabled={props.primaryDisabled || props.primaryLoading}
          onClick={props.onPrimaryAction}
        >
          {`primary-${props.appName}-${props.primaryActionLabel}`}
        </button>
        {props.secondaryActionLabel && props.onSecondaryAction ? (
          <button type="button" onClick={props.onSecondaryAction}>{`secondary-${props.appName}-${props.secondaryActionLabel}`}</button>
        ) : null}
        {props.tertiaryActionLabel && props.onTertiaryAction ? (
          <button type="button" onClick={props.onTertiaryAction}>{`tertiary-${props.appName}-${props.tertiaryActionLabel}`}</button>
        ) : null}
        {props.primaryMenuActions?.map((action) => (
          <button type="button" key={action.label} onClick={action.onClick}>{`menu-${props.appName}-${action.label}`}</button>
        ))}
      </article>
    );
  },
}));

const t = en as unknown as AppDictionary;
const signedOut = { authenticated: false } as ForgerAccountSession;
const signedIn = { authenticated: true, user: { confirmed: true } } as ForgerAccountSession;
const unconfirmed = { authenticated: true, user: { confirmed: false } } as ForgerAccountSession;

const app = (id: string, status: CatalogApp['status'], overrides: Partial<CatalogApp> = {}): CatalogApp => ({
  id,
  status,
  category: 'productivity',
  ...overrides,
});

const remoteShare = (appId: string, state: 'inactive' | 'preparing' | 'connected' | 'closed', active: boolean) => ({
  appId,
  state,
  active,
});

const actionApps: CatalogApp[] = [
  app('not-standard', 'not_installed', { category: 'finance' }),
  app('installed', 'installed', {
    updateAvailable: true,
    localNetworkShareSupported: true,
    remoteTunnelSupported: true,
    remoteNetworkShare: remoteShare('installed', 'connected', true),
  }),
  app('running', 'running'),
  app('conflict', 'conflict'),
  app('installing', 'installing'),
  app('open-error', 'error', { lastErrorOperation: 'runtime' }),
  app('install-error', 'error', { lastErrorOperation: 'install' }),
  app('update-error', 'error', { lastErrorOperation: 'update' }),
  app('private-error', 'error', { lastErrorOperation: 'install', privateLocal: true }),
  app('remote-preparing', 'installed', { remoteNetworkShare: remoteShare('remote-preparing', 'preparing', true) }),
  app('opening-installed', 'installed'),
  app('early-locked', 'not_installed', { catalogStatus: 'coming' }),
  app('early-download', 'not_installed', { catalogStatus: 'coming', latestVersionId: 7 }),
  app('beta-status', 'not_installed', { catalogStatus: 'beta' }),
  app('beta-flag', 'not_installed', { beta: true }),
  app('remote-closed', 'installed', { remoteNetworkShare: remoteShare('remote-closed', 'closed', true) }),
  app('remote-inactive', 'installed', { remoteNetworkShare: remoteShare('remote-inactive', 'inactive', true) }),
];

const renderView = ({
  apps = actionApps,
  filter = 'all' as 'all' | AppCategory,
  statusFilter = 'all' as 'all' | 'installed' | 'not_installed',
  account = signedOut,
  openingAppIds = new Set(['opening-installed']),
  installProgressByApp = { installing: { success: false, phase: 'downloading', userMessage: 'Downloading', progress: 40 } } as Record<string, InstallAppResult>,
} = {}) => {
  const handlers = {
    onFilterChange: vi.fn(),
    onStatusFilterChange: vi.fn(),
    onInstall: vi.fn<(appId: string, trustDecision?: SocialUserAppReviewState) => void | Promise<void>>(),
    onUpdate: vi.fn(),
    onOpen: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
    onRestoreUserVersion: vi.fn(),
    onResolveConflict: vi.fn(),
    onDetails: vi.fn(),
    onDelete: vi.fn(),
    onStartLocalNetworkShare: vi.fn(),
    onStartRemoteNetworkShare: vi.fn(),
    onStopRemoteNetworkShare: vi.fn(),
    onUploadSocial: vi.fn(),
    onOpenCloudModal: vi.fn(),
    onRefresh: vi.fn(),
    getAppMeta: vi.fn((appId: string) => ({ name: `Meta ${appId}`, description: `Description ${appId}` })),
    getCategoryLabel: vi.fn((category: AppCategory) => `Category ${category}`),
  };
  const view = render(
    <CatalogView
      apps={apps}
      openingAppIds={openingAppIds}
      filter={filter}
      statusFilter={statusFilter}
      account={account}
      t={t}
      installProgressByApp={installProgressByApp}
      {...handlers}
    />,
  );
  return { ...handlers, ...view };
};

const card = (id: string) => screen.getByTestId(`catalog-card-${id}`);
const primary = (id: string, label: string) => within(card(id)).getByRole('button', { name: `primary-Meta ${id}-${label}` });

describe('CatalogView', () => {
  it('sorts installed-like apps first and delegates status/category filters and refresh', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    const ids = screen.getAllByTestId(/^catalog-card-/).map((element) => element.dataset.testid?.replace('catalog-card-', '') ?? element.getAttribute('data-testid')?.replace('catalog-card-', ''));
    expect(ids[0]).toBe('installed');
    expect(ids.indexOf('not-standard')).toBeGreaterThan(ids.indexOf('remote-inactive'));

    const statusSelect = screen.getByRole('combobox', { name: t.sections.catalog.statusFilterLabel });
    await user.click(statusSelect);
    await user.click(await screen.findByRole('option', { name: t.sections.catalog.statusFilters.installed }));
    expect(handlers.onStatusFilterChange).toHaveBeenCalledWith('installed');
    await user.click(screen.getByRole('button', { name: t.catalogFilters.finance }));
    expect(handlers.onFilterChange).toHaveBeenCalledWith('finance');
    await user.click(within(card('installed')).getByRole('button', { name: 'details-Meta installed' }));
    expect(handlers.onDetails).toHaveBeenCalledWith('installed');
    handlers.unmount();

    const installedOnly = renderView({ statusFilter: 'installed' });
    expect(card('installed')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-card-installing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('catalog-card-not-standard')).not.toBeInTheDocument();
    installedOnly.unmount();

    const notInstalledOnly = renderView({ statusFilter: 'not_installed', filter: 'finance' });
    expect(card('not-standard')).toBeInTheDocument();
    expect(screen.queryByTestId('catalog-card-installed')).not.toBeInTheDocument();
    notInstalledOnly.unmount();

    const empty = renderView({ apps: [] });
    await user.click(screen.getByRole('button', { name: t.sections.catalog.refresh }));
    expect(empty.onRefresh).toHaveBeenCalledOnce();
  });

  it('derives every primary state and delegates install, retry, update, open, stop, and conflict actions', async () => {
    const user = userEvent.setup();
    const handlers = renderView();

    expect(card('installing')).toHaveAttribute('data-progress', 'downloading');
    expect(primary('installing', t.actions.installing)).toBeDisabled();
    expect(primary('early-locked', t.beta.comingSoonAction)).toBeDisabled();
    expect(primary('opening-installed', t.actions.opening)).toBeDisabled();
    expect(primary('remote-preparing', t.remoteNetwork.preparingAction)).toBeDisabled();
    expect(card('early-download')).toHaveAttribute('data-beta-label', t.beta.earlyAccessBadge);
    expect(card('private-error')).toHaveAttribute('data-beta-label', t.beta.privateLocalBadge);
    expect(card('beta-status')).toHaveAttribute('data-beta-label', t.beta.appBadge);
    expect(card('beta-flag')).toHaveAttribute('data-beta', 'true');

    await user.click(primary('not-standard', t.actions.install));
    await user.click(primary('installed', t.actions.open));
    await user.click(primary('running', t.actions.stop));
    await user.click(primary('conflict', t.actions.resolveWithForger));
    await user.click(primary('open-error', t.actions.open));
    await user.click(primary('install-error', t.actions.retry));
    await user.click(primary('update-error', t.actions.update));
    expect(handlers.onInstall).toHaveBeenCalledWith('not-standard');
    expect(handlers.onOpen.mock.calls).toEqual([['installed'], ['open-error']]);
    expect(handlers.onStop).toHaveBeenCalledWith('running');
    expect(handlers.onResolveConflict).toHaveBeenCalledWith('conflict');
    expect(handlers.onRetry).toHaveBeenCalledWith('install-error');
    expect(handlers.onUpdate).toHaveBeenCalledWith('update-error');

    await user.click(within(card('installed')).getByRole('button', { name: `secondary-Meta installed-${t.actions.update}` }));
    await user.click(within(card('conflict')).getByRole('button', { name: `secondary-Meta conflict-${t.actions.restoreUserVersion}` }));
    await user.click(within(card('installed')).getByRole('button', { name: `tertiary-Meta installed-${t.actions.uninstall}` }));
    expect(handlers.onUpdate).toHaveBeenCalledWith('installed');
    expect(handlers.onRestoreUserVersion).toHaveBeenCalledWith('conflict');
    expect(handlers.onDelete).toHaveBeenCalledWith('installed');
  });

  it('delegates local, remote, stop-sharing, and private upload menu actions', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    const installedCard = within(card('installed'));
    await user.click(installedCard.getByRole('button', { name: `menu-Meta installed-${t.localNetwork.menuAction}` }));
    await user.click(installedCard.getByRole('button', { name: `menu-Meta installed-${t.remoteNetwork.menuAction}` }));
    await user.click(installedCard.getByRole('button', { name: `menu-Meta installed-${t.remoteNetwork.stop}` }));
    await user.click(within(card('private-error')).getByRole('button', { name: `menu-Meta private-error-${t.social.uploadTitle}` }));
    expect(handlers.onStartLocalNetworkShare).toHaveBeenCalledWith('installed');
    expect(handlers.onStartRemoteNetworkShare).toHaveBeenCalledWith('installed');
    expect(handlers.onStopRemoteNetworkShare).toHaveBeenCalledWith('installed');
    expect(handlers.onUploadSocial).toHaveBeenCalledWith('private-error');
    expect(within(card('remote-closed')).queryByText(t.remoteNetwork.stop)).not.toBeInTheDocument();
    expect(within(card('remote-inactive')).queryByText(t.remoteNetwork.stop)).not.toBeInTheDocument();
  });

  it('asks unconfirmed Social users to sign in and supports cancel, Escape, and account navigation', async () => {
    const user = userEvent.setup();
    const social = app('social-unconfirmed', 'not_installed', { socialUserAppId: 10, socialOwnerUsername: 'maker' });
    const handlers = renderView({ apps: [social], account: unconfirmed, openingAppIds: new Set() });
    expect(card('social-unconfirmed')).toHaveAttribute('data-created-by', t.sections.catalog.createdBy('@maker'));

    await user.click(primary('social-unconfirmed', t.actions.install));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.actions.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(primary('social-unconfirmed', t.actions.install));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(primary('social-unconfirmed', t.actions.install));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.sections.catalog.signInDownloadAction }));
    expect(handlers.onOpenCloudModal).toHaveBeenCalledOnce();
    expect(handlers.onInstall).not.toHaveBeenCalled();
  });

  it('lets signed-in Social users skip review or wait for AI review completion', async () => {
    const user = userEvent.setup();
    const reviewed = Promise.withResolvers<void>();
    const social = app('social-reviewed', 'not_installed', { socialUserAppId: 11, socialOwnerUsername: '@reviewer', downloadUrl: 'https://example.test/app.zip' });
    const handlers = renderView({ apps: [social], account: signedIn, openingAppIds: new Set() });
    handlers.onInstall.mockImplementation((_appId, decision) => decision === 'reviewed' ? reviewed.promise : undefined);
    expect(card('social-reviewed')).toHaveAttribute('data-created-by', t.sections.catalog.createdBy('@reviewer'));

    await user.click(primary('social-reviewed', t.actions.install));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(primary('social-reviewed', t.actions.install));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.social.installWithoutReviewAction }));
    expect(handlers.onInstall).toHaveBeenCalledWith('social-reviewed', 'skipped_review');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(primary('social-reviewed', t.actions.install));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.social.reviewWithAiAction }));
    expect(screen.getByText(t.social.reviewPrepareProgress)).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: t.social.reviewWithAiAction })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    reviewed.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(handlers.onInstall).toHaveBeenCalledWith('social-reviewed', 'reviewed');
  });
});
