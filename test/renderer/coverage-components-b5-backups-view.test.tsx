import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BackupsView } from '@renderer/views/BackupsView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type {
  AppBackupReason,
  AppBackupSummary,
  AppSummary,
  CloudSyncSettings,
  ForgerAccountSession,
  RemoteAppBackupSummary,
  RemoteBackupsUsage,
} from '@shared/types';

const t = en as unknown as AppDictionary;
const labels = t.sections.backups;

const apps: AppSummary[] = [
  { id: 'alpha', name: 'Alpha', category: 'productivity', status: 'installed' },
  { id: 'beta', name: 'Beta', category: 'utilities', status: 'running' },
  { id: 'error-app', category: 'developer_tools', status: 'error' },
  { id: 'conflict-app', name: 'Conflict', category: 'home', status: 'conflict' },
  { id: 'catalog-only', name: 'Catalog only', category: 'learning', status: 'not_installed' },
];

const backup = (
  backupId: string,
  overrides: Partial<AppBackupSummary> = {},
): AppBackupSummary => ({
  appId: 'alpha',
  appName: 'Alpha',
  appVersion: '1.0.0',
  backupId,
  createdAt: '2026-08-10T10:00:00.000Z',
  reason: 'manual',
  fileCount: 1,
  totalBytes: 512,
  files: [],
  ...overrides,
});

const localBackups: AppBackupSummary[] = [
  backup('manual', { appName: 'Alpha snapshot', totalBytes: 512 }),
  backup('update-new', { appName: '', appVersion: '', reason: 'update', createdAt: '2026-08-09T10:00:00.000Z', totalBytes: 2_048 }),
  backup('restore-new', { reason: 'pre_restore', createdAt: '2026-08-08T10:00:00.000Z', totalBytes: 2 * 1024 * 1024 }),
  backup('update-invalid', { reason: 'update', createdAt: 'invalid-date', totalBytes: 2 * 1024 * 1024 * 1024 }),
  backup('restore-old', { reason: 'pre_restore', createdAt: '2026-08-01T10:00:00.000Z', totalBytes: Number.NaN }),
  backup('legacy', { reason: 'legacy' as AppBackupReason, totalBytes: 0 }),
  backup('beta-running', { appId: 'beta', appName: '', reason: 'manual', totalBytes: 1_024 }),
  backup('error-fallback', { appId: 'error-app', appName: '', reason: 'manual', totalBytes: 768 }),
];

const remote = (id: number, overrides: Partial<RemoteAppBackupSummary> = {}): RemoteAppBackupSummary => ({
  id,
  appId: 'alpha',
  appName: 'Alpha cloud',
  appVersion: '1.0.0',
  backupType: 'sync_snapshot',
  source: 'auto_sync',
  metadata: {},
  fileCount: 3,
  totalBytes: 3_072,
  checksumSha256: `checksum-${id}`,
  createdAt: '2026-08-10T12:00:00.000Z',
  ...overrides,
});

const remoteBackups: RemoteAppBackupSummary[] = [
  remote(1),
  remote(2, { appName: '', appVersion: undefined, backupType: 'backup', totalBytes: 4 * 1024 * 1024 }),
  remote(3, { appId: 'beta', appName: '', backupType: 'backup', totalBytes: 4 * 1024 * 1024 * 1024 }),
  remote(4, { appId: 'error-app', appName: '', backupType: 'backup', totalBytes: 768 }),
];

const usage: RemoteBackupsUsage = { usedBytes: 2_048, limitBytes: 1_024, backupCount: 3, backupCountLimit: 5 };
const signedIn = { authenticated: true } as ForgerAccountSession;
const signedOut = { authenticated: false } as ForgerAccountSession;
const syncSettings: CloudSyncSettings = { appSync: { alpha: { autoSync: true }, beta: { autoSync: false } } };

const renderView = (overrides: Partial<React.ComponentProps<typeof BackupsView>> = {}) => {
  const handlers = {
    onCreateBackup: vi.fn(),
    onSyncNow: vi.fn(),
    onDeleteBackup: vi.fn(),
    onDeleteSelectedBackups: vi.fn().mockResolvedValue(true),
    onDeleteRemoteBackup: vi.fn(),
    onRestoreBackup: vi.fn(),
    onRestoreRemoteBackup: vi.fn(),
    onSetAutoSync: vi.fn(),
    onRequireCloud: vi.fn(),
  };
  const props: React.ComponentProps<typeof BackupsView> = {
    backups: localBackups,
    remoteBackups,
    remoteBackupsUsage: usage,
    apps,
    account: signedIn,
    cloudSyncSettings: syncSettings,
    busy: false,
    t,
    ...handlers,
    ...overrides,
  };
  const view = render(<BackupsView {...props} />);
  return { ...handlers, props, ...view };
};

const chooseApp = async (user: ReturnType<typeof userEvent.setup>, appName: string) => {
  await user.click(screen.getByRole('combobox', { name: labels.appLabel }));
  await user.click(await screen.findByRole('option', { name: appName }));
};

describe('BackupsView', () => {
  it('creates, restores, deletes, selects, clears, and batch-deletes local backups', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    handlers.onDeleteSelectedBackups.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(screen.getByText(labels.reasonLabels.manual)).toBeInTheDocument();
    expect(screen.getAllByText(labels.reasonLabels.update)).toHaveLength(2);
    expect(screen.getAllByText(labels.reasonLabels.pre_restore)).toHaveLength(2);
    expect(screen.getByText('legacy')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.getByText('2 MB')).toBeInTheDocument();
    expect(screen.getByText('2 GB')).toBeInTheDocument();
    expect(screen.getAllByText('0 B').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: labels.createLocal }));
    expect(handlers.onCreateBackup).toHaveBeenCalledWith('alpha');
    const firstRow = screen.getByText('Alpha snapshot').closest('tr') as HTMLElement;
    await user.click(within(firstRow).getByRole('button', { name: labels.restore }));
    await user.click(within(firstRow).getByRole('button', { name: labels.delete }));
    expect(handlers.onRestoreBackup).toHaveBeenCalledWith(localBackups[0]);
    expect(handlers.onDeleteBackup).toHaveBeenCalledWith(localBackups[0]);

    const firstSelection = within(firstRow).getByRole('checkbox', { name: labels.selectLocalBackup('Alpha snapshot') });
    await user.click(firstSelection);
    expect(screen.getByRole('button', { name: labels.clearSelection })).toBeEnabled();
    await user.click(firstSelection);
    expect(screen.getByRole('button', { name: labels.clearSelection })).toBeDisabled();

    const selectAll = screen.getByRole('checkbox', { name: labels.selectAllLocalBackups });
    await user.click(selectAll);
    expect(selectAll).toBeChecked();
    await user.click(screen.getByRole('button', { name: labels.clearSelection }));
    expect(selectAll).not.toBeChecked();
    await user.click(selectAll);
    await user.click(selectAll);
    expect(selectAll).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: labels.selectOldAutomatic }));
    const deleteSelected = screen.getByRole('button', { name: labels.deleteSelected });
    expect(deleteSelected).toBeEnabled();
    await user.click(deleteSelected);
    expect(handlers.onDeleteSelectedBackups).toHaveBeenCalledTimes(1);
    expect(deleteSelected).toBeEnabled();
    await user.click(deleteSelected);
    await waitFor(() => expect(deleteSelected).toBeDisabled());
  });

  it('switches local apps, clears selection, shows empty state, and blocks restore for a running app', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    await user.click(screen.getByRole('checkbox', { name: labels.selectLocalBackup('Alpha snapshot') }));
    await chooseApp(user, 'Beta');

    expect(screen.getByRole('combobox', { name: labels.appLabel })).toHaveTextContent('Beta');
    const betaRow = screen.getByText('1 KB').closest('tr') as HTMLElement;
    expect(within(betaRow).getByRole('button', { name: labels.restore })).toBeDisabled();
    expect(screen.getByRole('button', { name: labels.clearSelection })).toBeDisabled();

    await chooseApp(user, 'error-app');
    expect(screen.getByRole('checkbox', { name: labels.selectLocalBackup('error-app') })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: labels.createLocal }));
    expect(handlers.onCreateBackup).toHaveBeenLastCalledWith('error-app');

    await chooseApp(user, 'Conflict');
    expect(screen.getByText(labels.empty)).toBeInTheDocument();
    expect(screen.getByText(labels.noLocalBackupForApp)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: labels.createLocal }));
    expect(handlers.onCreateBackup).toHaveBeenLastCalledWith('conflict-app');
  });

  it('requires cloud authentication for sync settings, update, and latest restore', async () => {
    const user = userEvent.setup();
    const handlers = renderView({ account: signedOut });
    await user.click(screen.getByRole('tab', { name: labels.cloudTitle }));

    expect(screen.getByText(labels.cloudLocked)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: labels.autoSync }));
    await user.click(screen.getByRole('button', { name: labels.updateCloud }));
    await user.click(screen.getAllByRole('button', { name: labels.restore })[0]);
    expect(handlers.onRequireCloud).toHaveBeenCalledTimes(3);
    expect(handlers.onSetAutoSync).not.toHaveBeenCalled();
    expect(handlers.onSyncNow).not.toHaveBeenCalled();
    expect(handlers.onRestoreRemoteBackup).not.toHaveBeenCalled();
  });

  it('syncs, restores, deletes, and displays cloud backup states when signed in', async () => {
    const user = userEvent.setup();
    const handlers = renderView();
    await user.click(screen.getByRole('tab', { name: labels.cloudTitle }));

    expect(screen.getByText(labels.autoSyncActive)).toBeInTheDocument();
    expect(screen.getByText(labels.syncSnapshot)).toBeInTheDocument();
    expect(screen.getByText(labels.cloudBackup)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await user.click(screen.getByRole('switch', { name: labels.autoSync }));
    expect(handlers.onSetAutoSync).toHaveBeenCalledWith('alpha', false);
    await user.click(screen.getByRole('button', { name: labels.updateCloud }));
    expect(handlers.onSyncNow).toHaveBeenCalledWith('alpha');
    await user.click(screen.getAllByRole('button', { name: labels.restore })[0]);
    expect(handlers.onRestoreRemoteBackup).toHaveBeenCalledWith(remoteBackups[0]);

    const alphaCloudRow = screen.getByText('Alpha cloud').closest('tr') as HTMLElement;
    await user.click(within(alphaCloudRow).getByRole('button', { name: labels.restore }));
    await user.click(within(alphaCloudRow).getByRole('button', { name: labels.delete }));
    expect(handlers.onRestoreRemoteBackup).toHaveBeenCalledTimes(2);
    expect(handlers.onDeleteRemoteBackup).toHaveBeenCalledWith(remoteBackups[0]);

    await chooseApp(user, 'Beta');
    const betaCloudRow = screen.getByText('4 GB').closest('tr') as HTMLElement;
    expect(within(betaCloudRow).getByRole('button', { name: labels.restore })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: labels.restore })[0]).toBeDisabled();

    await chooseApp(user, 'error-app');
    expect(screen.getAllByText('error-app')).toHaveLength(2);
  });

  it('handles no eligible apps, no backups, zero quota, missing sync settings, and busy controls', async () => {
    const user = userEvent.setup();
    const handlers = renderView({
      backups: [],
      remoteBackups: [],
      remoteBackupsUsage: { usedBytes: 0, limitBytes: 0, backupCount: 0, backupCountLimit: 0 },
      apps: [apps[4]],
      cloudSyncSettings: { appSync: {} },
      busy: true,
    });

    expect(screen.getByText(labels.noApps)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: labels.createLocal })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: labels.selectAllLocalBackups })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: labels.cloudTitle }));
    expect(screen.getByText(labels.cloudEmpty)).toBeInTheDocument();
    expect(screen.getByText(labels.cloudNotSynced)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('switch', { name: labels.autoSync })).toBeDisabled();
    expect(screen.getByRole('button', { name: labels.updateCloud })).toBeDisabled();
    expect(screen.getByRole('button', { name: labels.restore })).toBeDisabled();
    expect(handlers.onRequireCloud).not.toHaveBeenCalled();
  });
});
