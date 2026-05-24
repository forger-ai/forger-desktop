import { Button, Chip, MenuItem, Select, Stack, Typography } from '@mui/material';
import type { AppCategory, CatalogApp, InstallAppResult } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AppCard } from '@renderer/components/AppCard';
import { AppsGrid } from '@renderer/components/AppsGrid';

interface CatalogViewProps {
  apps: CatalogApp[];
  openingAppIds: Set<string>;
  filter: 'all' | AppCategory;
  onFilterChange: (filter: 'all' | AppCategory) => void;
  statusFilter: 'all' | 'installed' | 'not_installed';
  onStatusFilterChange: (filter: 'all' | 'installed' | 'not_installed') => void;
  onInstall: (appId: string) => void;
  onUpdate: (appId: string) => void;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
  onRetry: (appId: string) => void;
  onRestoreUserVersion: (appId: string) => void;
  onResolveConflict: (appId: string) => void;
  onDetails: (appId: string) => void;
  onDelete: (appId: string) => void;
  onStartLocalNetworkShare: (appId: string) => void;
  onStartRemoteNetworkShare: (appId: string) => void;
  onStopRemoteNetworkShare: (appId: string) => void;
  onRefresh: () => void;
  t: AppDictionary;
  earlyAccessEnabled: boolean;
  getAppMeta: (appId: string) => { name: string; description: string; iconUrl?: string };
  getCategoryLabel: (category: AppCategory) => string;
  installProgressByApp: Record<string, InstallAppResult>;
}

const filters: Array<'all' | AppCategory> = ['all', 'finanzas', 'hogar', 'salud', 'productividad', 'developer_tools'];

const isInstalledLike = (app: CatalogApp) =>
  app.status === 'installed' || app.status === 'running' || app.status === 'error' || app.status === 'conflict' || app.status === 'installing';

const installedSortRank = (app: CatalogApp) => (isInstalledLike(app) ? 0 : 1);

export function CatalogView({
  apps,
  openingAppIds,
  filter,
  onFilterChange,
  statusFilter,
  onStatusFilterChange,
  onInstall,
  onUpdate,
  onOpen,
  onStop,
  onRetry,
  onRestoreUserVersion,
  onResolveConflict,
  onDetails,
  onDelete,
  onStartLocalNetworkShare,
  onStartRemoteNetworkShare,
  onStopRemoteNetworkShare,
  onRefresh,
  t,
  earlyAccessEnabled,
  getAppMeta,
  getCategoryLabel,
  installProgressByApp,
}: CatalogViewProps) {
  const catalogApps = apps.filter((app) => app.catalogStatus !== 'coming' || earlyAccessEnabled || isInstalledLike(app));
  const statusApps =
    statusFilter === 'installed'
      ? catalogApps.filter((app) => app.status === 'installed' || app.status === 'running' || app.status === 'error' || app.status === 'conflict')
      : statusFilter === 'not_installed'
        ? catalogApps.filter((app) => app.status === 'not_installed')
        : catalogApps;
  const filteredApps = filter === 'all' ? statusApps : statusApps.filter((app) => app.category === filter);
  const visibleApps = filteredApps
    .map((app, index) => ({ app, index }))
    .sort((left, right) => installedSortRank(left.app) - installedSortRank(right.app) || left.index - right.index)
    .map(({ app }) => app);

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.catalog.title}</Typography>
        <Typography color="text.secondary">{t.sections.catalog.subtitle}</Typography>
      </Stack>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <Typography variant="body2" color="text.secondary">
            {t.sections.catalog.statusFilterLabel}
          </Typography>
          <Select
            size="small"
            value={statusFilter}
            onChange={(event) => onStatusFilterChange(event.target.value as 'all' | 'installed' | 'not_installed')}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="all">{t.sections.catalog.statusFilters.all}</MenuItem>
            <MenuItem value="installed">{t.sections.catalog.statusFilters.installed}</MenuItem>
            <MenuItem value="not_installed">{t.sections.catalog.statusFilters.notInstalled}</MenuItem>
          </Select>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {t.sections.catalog.filtersLabel}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          {filters.map((filterId) => (
            <Chip
              key={filterId}
              label={t.catalogFilters[filterId]}
              clickable
              color={filter === filterId ? 'primary' : 'default'}
              variant={filter === filterId ? 'filled' : 'outlined'}
              onClick={() => onFilterChange(filterId)}
            />
          ))}
        </Stack>
      </Stack>

      {visibleApps.length === 0 ? (
        <Stack spacing={1.5} alignItems="flex-start">
          <Typography color="text.secondary">{t.sections.catalog.empty}</Typography>
          <Button variant="outlined" onClick={onRefresh}>
            {t.sections.catalog.refresh}
          </Button>
        </Stack>
      ) : (
        <AppsGrid>
          {visibleApps.map((app) => {
            const meta = getAppMeta(app.id);
            const installProgress = installProgressByApp[app.id];
            const isPrivateLocal = app.privateLocal === true;
            const isInstalled = app.status === 'installed' || app.status === 'running' || app.status === 'conflict' || (isPrivateLocal && app.status === 'error');
            const isInstalling = app.status === 'installing';
            const hasError = app.status === 'error';
            const isConflict = app.status === 'conflict';
            const isEarlyAccess = app.catalogStatus === 'coming';
            const isBeta = app.catalogStatus === 'beta' || Boolean(app.beta);
            const hasDownloadableVersion = Boolean(app.downloadUrl || app.latestVersionId);
            const canInstallEarlyAccess = !isEarlyAccess || (earlyAccessEnabled && hasDownloadableVersion);
            const primaryAction = isConflict ? 'update' : hasError && !isPrivateLocal ? 'retry' : isInstalled ? (app.status === 'running' ? 'stop' : 'open') : 'install';
            const remoteNetworkState = app.remoteNetworkShare?.state;
            const remoteNetworkPreparing = remoteNetworkState === 'preparing';
            const isOpening = (primaryAction === 'open' && openingAppIds.has(app.id)) || remoteNetworkPreparing;
            const localNetworkRunning = Boolean(app.localNetworkShare?.connectedAt || app.localNetworkShare?.active);
            const statusIndicatorLabel = remoteNetworkState === 'preparing'
              ? t.remoteNetwork.preparingBadge
              : remoteNetworkState === 'waiting_for_session'
                ? t.remoteNetwork.waitingBadge
              : remoteNetworkState === 'connected'
                ? t.remoteNetwork.connectedBadge
              : remoteNetworkState === 'error'
                ? t.remoteNetwork.errorBadge
              : localNetworkRunning
              ? t.localNetwork.runningTooltip
              : app.status === 'running'
                ? 'running'
                : undefined;
            const canShareLocalNetwork = earlyAccessEnabled
              && primaryAction === 'open'
              && app.localNetworkShareSupported === true;
            const canShareRemoteNetwork = earlyAccessEnabled
              && primaryAction === 'open'
              && app.remoteTunnelSupported === true;
            const canStopRemoteNetwork = earlyAccessEnabled
              && Boolean(app.remoteNetworkShare?.active)
              && app.remoteNetworkShare?.state !== 'closed'
              && app.remoteNetworkShare?.state !== 'inactive';
            const primaryActionLabel = hasError && !isPrivateLocal
              ? t.actions.retry
              : remoteNetworkPreparing
                ? t.remoteNetwork.preparingAction
              : app.status === 'running'
                ? t.actions.stop
              : isInstalling
                ? t.actions.installing
              : isConflict
                ? t.actions.resolveWithForger
              : isInstalled
                ? isOpening
                  ? t.actions.opening
                  : t.actions.open
                : isEarlyAccess && !earlyAccessEnabled
                  ? t.beta.enableEarlyAccessAction
                  : isEarlyAccess && !hasDownloadableVersion
                    ? t.beta.comingSoonAction
                    : t.actions.install;

            return (
              <AppCard
                key={app.id}
                appName={meta.name}
                iconUrl={app.iconUrl}
                categoryLabel={getCategoryLabel(app.category)}
                description={isEarlyAccess ? `${meta.description} ${t.beta.earlyAccessCardBody}` : meta.description}
                beta={isPrivateLocal || isBeta || isEarlyAccess}
                betaLabel={isPrivateLocal ? t.beta.privateLocalBadge : isEarlyAccess ? t.beta.earlyAccessBadge : 'Beta'}
                averageRating={app.averageRating}
                ratingsCount={app.ratingsCount}
                onboardingTarget={app.id === 'finance-os' ? 'finance-os-card' : undefined}
                statusIndicatorLabel={statusIndicatorLabel}
                primaryAction={primaryAction}
                primaryActionLabel={primaryActionLabel}
                primaryDisabled={isInstalling || (!isInstalled && !canInstallEarlyAccess)}
                primaryLoading={isOpening}
                primaryMenuActions={[
                  ...(canShareLocalNetwork ? [{ label: t.localNetwork.menuAction, onClick: () => onStartLocalNetworkShare(app.id) }] : []),
                  ...(canShareRemoteNetwork ? [{ label: t.remoteNetwork.menuAction, onClick: () => onStartRemoteNetworkShare(app.id) }] : []),
                  ...(canStopRemoteNetwork ? [{ label: t.remoteNetwork.stop, onClick: () => onStopRemoteNetworkShare(app.id) }] : []),
                ]}
                installProgress={installProgress}
                onPrimaryAction={() => {
                  if (isInstalling) {
                    return;
                  }
                  if (isConflict) {
                    onResolveConflict(app.id);
                    return;
                  }
                  if (hasError && !isPrivateLocal) {
                    onRetry(app.id);
                    return;
                  }
                  if (app.status === 'running') {
                    onStop(app.id);
                    return;
                  }
                  if (isInstalled) {
                    onOpen(app.id);
                    return;
                  }
                  if (!isInstalled) {
                    onInstall(app.id);
                  }
                }}
                secondaryActionLabel={isConflict ? t.actions.restoreUserVersion : app.updateAvailable ? t.actions.update : undefined}
                onSecondaryAction={
                  isConflict
                    ? () => onRestoreUserVersion(app.id)
                    : app.updateAvailable
                      ? () => onUpdate(app.id)
                      : undefined
                }
                tertiaryActionLabel={isInstalled && !isInstalling ? t.actions.uninstall : undefined}
                onTertiaryAction={isInstalled && !isInstalling ? () => onDelete(app.id) : undefined}
                onCardClick={() => onDetails(app.id)}
              />
            );
          })}
        </AppsGrid>
      )}
    </Stack>
  );
}
