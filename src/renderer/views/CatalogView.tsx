import { useState } from 'react';
import { Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, MenuItem, Select, Stack, Typography } from '@mui/material';
import type { AppCategory, CatalogApp, ForgerAccountSession, InstallAppResult, SocialUserAppReviewState } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AppCard } from '@renderer/components/AppCard';
import { AppsGrid } from '@renderer/components/AppsGrid';
import { appExecutionTooltip } from '@renderer/app-execution-labels';
import { isOpenableError, isRetryableInstallError, isUpdateError } from '@renderer/app-error-actions';

interface CatalogViewProps {
  apps: CatalogApp[];
  openingAppIds: Set<string>;
  filter: 'all' | AppCategory;
  onFilterChange: (filter: 'all' | AppCategory) => void;
  statusFilter: 'all' | 'installed' | 'not_installed';
  onStatusFilterChange: (filter: 'all' | 'installed' | 'not_installed') => void;
  onInstall: (appId: string, trustDecision?: SocialUserAppReviewState) => void | Promise<void>;
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
  onUploadSocial: (appId: string) => void;
  onOpenCloudModal: () => void;
  onRefresh: () => void;
  account: ForgerAccountSession;
  t: AppDictionary;
  getAppMeta: (appId: string) => { name: string; description: string; iconUrl?: string };
  getCategoryLabel: (category: AppCategory) => string;
  installProgressByApp: Record<string, InstallAppResult>;
}

const filters: Array<'all' | AppCategory> = ['all', 'productivity', 'finance', 'home', 'health', 'learning', 'utilities', 'lifestyle', 'developer_tools'];

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
  onUploadSocial,
  onOpenCloudModal,
  onRefresh,
  account,
  t,
  getAppMeta,
  getCategoryLabel,
  installProgressByApp,
}: CatalogViewProps) {
  const catalogApps = apps;
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
  const [reviewDialogApp, setReviewDialogApp] = useState<CatalogApp | null>(null);
  const [reviewDialogBusy, setReviewDialogBusy] = useState(false);
  const [socialDownloadAccountDialogOpen, setSocialDownloadAccountDialogOpen] = useState(false);
  const signedIn = account.authenticated && Boolean(account.user?.confirmed);
  const closeReviewDialog = () => {
    setReviewDialogBusy(false);
    setReviewDialogApp(null);
  };
  const continueInstall = async (trustDecision: SocialUserAppReviewState) => {
    if (!reviewDialogApp) return;
    if (trustDecision !== 'reviewed') {
      onInstall(reviewDialogApp.id, trustDecision);
      closeReviewDialog();
      return;
    }
    setReviewDialogBusy(true);
    try {
      await onInstall(reviewDialogApp.id, trustDecision);
      closeReviewDialog();
    } finally {
      setReviewDialogBusy(false);
    }
  };

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.catalog.title}</Typography>
        <Typography color="text.secondary">{t.sections.catalog.subtitle}</Typography>
      </Stack>
      <Alert severity="warning">{t.sections.catalog.disclaimer}</Alert>
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
            const isInstalling = app.status === 'installing';
            const canOpenError = isOpenableError(app);
            const canRetryInstallError = isRetryableInstallError(app);
            const canRecoverUpdateError = isUpdateError(app);
            const isInstalled = app.status === 'installed' || app.status === 'running' || app.status === 'conflict' || canOpenError || (isPrivateLocal && app.status === 'error');
            const isConflict = app.status === 'conflict';
            const isEarlyAccess = app.catalogStatus === 'coming';
            const isBeta = app.catalogStatus === 'beta' || Boolean(app.beta);
            const hasDownloadableVersion = Boolean(app.downloadUrl || app.latestVersionId);
            const primaryAction = isConflict ? 'update' : canRecoverUpdateError ? 'update' : canRetryInstallError ? 'retry' : isInstalled ? (app.status === 'running' ? 'stop' : 'open') : 'install';
            const isSocialCatalogApp = typeof app.socialUserAppId === 'number';
            const createdByLabel = app.socialOwnerUsername
              ? t.sections.catalog.createdBy(app.socialOwnerUsername.startsWith('@') ? app.socialOwnerUsername : `@${app.socialOwnerUsername}`)
              : undefined;
            const remoteNetworkState = app.remoteNetworkShare?.state;
            const remoteNetworkPreparing = remoteNetworkState === 'preparing';
            const isOpening = (primaryAction === 'open' && openingAppIds.has(app.id)) || remoteNetworkPreparing;
            const statusIndicatorLabel = appExecutionTooltip(app, t, {
              startingInForger: primaryAction === 'open' && openingAppIds.has(app.id),
            });
            const canShareLocalNetwork = primaryAction === 'open'
              && app.localNetworkShareSupported === true;
            const canShareRemoteNetwork = primaryAction === 'open'
              && app.remoteTunnelSupported === true;
            const canStopRemoteNetwork = Boolean(app.remoteNetworkShare?.active)
              && app.remoteNetworkShare?.state !== 'closed'
              && app.remoteNetworkShare?.state !== 'inactive';
            const primaryActionLabel = canRetryInstallError
              ? t.actions.retry
              : canRecoverUpdateError
                ? t.actions.update
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
                : isEarlyAccess && !hasDownloadableVersion
                    ? t.beta.comingSoonAction
                    : t.actions.install;

            return (
              <AppCard
                key={app.id}
                appName={meta.name}
                iconUrl={app.iconUrl}
                categoryLabel={getCategoryLabel(app.category)}
                createdByLabel={createdByLabel}
                description={isEarlyAccess ? `${meta.description} ${t.beta.earlyAccessCardBody}` : meta.description}
                beta={isPrivateLocal || isBeta || isEarlyAccess}
                betaLabel={isPrivateLocal ? t.beta.privateLocalBadge : isEarlyAccess ? t.beta.earlyAccessBadge : t.beta.appBadge}
                averageRating={app.averageRating}
                ratingsCount={app.ratingsCount}
                onboardingTarget={undefined}
                statusIndicatorLabel={statusIndicatorLabel}
                primaryAction={primaryAction}
                primaryActionLabel={primaryActionLabel}
                primaryDisabled={isInstalling || (!isInstalled && !canRetryInstallError && !canRecoverUpdateError && isEarlyAccess && !hasDownloadableVersion)}
                primaryLoading={isOpening}
                primaryMenuActions={[
                  ...(canShareLocalNetwork ? [{ label: t.localNetwork.menuAction, onClick: () => onStartLocalNetworkShare(app.id) }] : []),
                  ...(canShareRemoteNetwork ? [{ label: t.remoteNetwork.menuAction, onClick: () => onStartRemoteNetworkShare(app.id) }] : []),
                  ...(canStopRemoteNetwork ? [{ label: t.remoteNetwork.stop, onClick: () => onStopRemoteNetworkShare(app.id) }] : []),
                  ...(isPrivateLocal ? [{ label: t.social.uploadTitle, onClick: () => onUploadSocial(app.id) }] : []),
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
                  if (canRecoverUpdateError) {
                    onUpdate(app.id);
                    return;
                  }
                  if (canRetryInstallError) {
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
                    if (isSocialCatalogApp) {
                      if (!signedIn) {
                        setSocialDownloadAccountDialogOpen(true);
                        return;
                      }
                      setReviewDialogApp(app);
                      return;
                    }
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
      <Dialog open={Boolean(reviewDialogApp)} onClose={reviewDialogBusy ? undefined : closeReviewDialog} maxWidth="xs" fullWidth>
        <DialogTitle>{t.social.reviewInstallTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Typography color="text.secondary">
              {t.social.reviewInstallBody}
            </Typography>
            <Alert severity="warning">{t.sections.catalog.disclaimer}</Alert>
            {reviewDialogBusy ? (
              <Stack spacing={1}>
                <LinearProgress />
                <Typography variant="body2" color="text.secondary">
                  {t.social.reviewPrepareProgress}
                </Typography>
              </Stack>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void continueInstall('skipped_review')} disabled={reviewDialogBusy}>
            {t.social.installWithoutReviewAction}
          </Button>
          <Button variant="contained" onClick={() => void continueInstall('reviewed')} disabled={reviewDialogBusy}>
            {t.social.reviewWithAiAction}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={socialDownloadAccountDialogOpen} onClose={() => setSocialDownloadAccountDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t.sections.catalog.signInDownloadTitle}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">{t.sections.catalog.signInDownloadBody}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSocialDownloadAccountDialogOpen(false)}>
            {t.actions.cancel}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setSocialDownloadAccountDialogOpen(false);
              onOpenCloudModal();
            }}
          >
            {t.sections.catalog.signInDownloadAction}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
