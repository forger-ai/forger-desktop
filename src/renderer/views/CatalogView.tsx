import { Chip, MenuItem, Select, Stack, Typography } from '@mui/material';
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
  t: AppDictionary;
  earlyAccessEnabled: boolean;
  getAppMeta: (appId: string) => { name: string; description: string; iconUrl?: string };
  getCategoryLabel: (category: AppCategory) => string;
  installProgressByApp: Record<string, InstallAppResult>;
}

const filters: Array<'all' | AppCategory> = ['all', 'finanzas', 'hogar', 'salud', 'productividad', 'developer_tools'];

const isInstalledLike = (app: CatalogApp) =>
  app.status === 'installed' || app.status === 'running' || app.status === 'error' || app.status === 'conflict' || app.status === 'installing';

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
  const visibleApps = filter === 'all' ? statusApps : statusApps.filter((app) => app.category === filter);

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
        <Typography color="text.secondary">{t.sections.catalog.subtitle}</Typography>
      ) : (
        <AppsGrid>
          {visibleApps.map((app) => {
            const meta = getAppMeta(app.id);
            const installProgress = installProgressByApp[app.id];
            const isInstalled = app.status === 'installed' || app.status === 'running' || app.status === 'conflict';
            const isInstalling = app.status === 'installing';
            const hasError = app.status === 'error';
            const isConflict = app.status === 'conflict';
            const isEarlyAccess = app.catalogStatus === 'coming';
            const isBeta = app.catalogStatus === 'beta' || Boolean(app.beta);
            const hasDownloadableVersion = Boolean(app.downloadUrl || app.latestVersionId);
            const canInstallEarlyAccess = !isEarlyAccess || (earlyAccessEnabled && hasDownloadableVersion);
            const statusLabel = isInstalling
              ? t.actions.installing
              : app.status === 'running'
                ? t.actions.running
                : isConflict
                  ? t.actions.conflict
                : hasError
                  ? t.actions.error
                  : !isInstalled && isEarlyAccess
                    ? t.beta.earlyAccessBadge
                  : app.updateAvailable && app.latestVersion
                    ? t.appView.updateAvailable(app.latestVersion)
                  : isInstalled
                    ? t.actions.installed
                    : t.actions.available;
            const statusColor = isInstalling
              ? 'warning'
              : app.status === 'running'
                ? 'info'
                : isConflict
                  ? 'error'
                : hasError
                  ? 'error'
                  : app.updateAvailable
                    ? 'warning'
                  : isInstalled
                    ? 'success'
                    : 'default';
            const primaryAction = isConflict ? 'update' : hasError ? 'retry' : isInstalled ? (app.status === 'running' ? 'stop' : 'open') : 'install';
            const isOpening = primaryAction === 'open' && openingAppIds.has(app.id);
            const primaryActionLabel = hasError
              ? t.actions.retry
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
                beta={isBeta || isEarlyAccess}
                betaLabel={isEarlyAccess ? t.beta.earlyAccessBadge : 'Beta'}
                averageRating={app.averageRating}
                ratingsCount={app.ratingsCount}
                onboardingTarget={app.id === 'finance-os' ? 'finance-os-card' : undefined}
                statusLabel={statusLabel}
                statusColor={statusColor}
                primaryAction={primaryAction}
                primaryActionLabel={primaryActionLabel}
                primaryDisabled={isInstalling || (!isInstalled && !canInstallEarlyAccess)}
                primaryLoading={isOpening}
                installProgress={installProgress}
                onPrimaryAction={() => {
                  if (isInstalling) {
                    return;
                  }
                  if (isConflict) {
                    onResolveConflict(app.id);
                    return;
                  }
                  if (hasError) {
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
