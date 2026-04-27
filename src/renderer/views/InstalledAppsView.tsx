import { Button, Stack, Typography } from '@mui/material';
import type { AppSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AppCard } from '@renderer/components/AppCard';
import { AppsGrid } from '@renderer/components/AppsGrid';

interface InstalledAppsViewProps {
  apps: AppSummary[];
  t: AppDictionary;
  getAppMeta: (appId: string) => { name: string; description: string };
  getCategoryLabel: (category: AppSummary['category']) => string;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
  onRetry: (appId: string) => void;
  onDetails: (appId: string) => void;
  onDelete: (appId: string) => void;
  onGoCatalog: () => void;
}

export function InstalledAppsView({
  apps,
  t,
  getAppMeta,
  getCategoryLabel,
  onOpen,
  onStop,
  onRetry,
  onDetails,
  onDelete,
  onGoCatalog,
}: InstalledAppsViewProps) {
  if (apps.length === 0) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '60%' }} spacing={2}>
        <Typography color="text.secondary" textAlign="center" sx={{ maxWidth: 460 }}>
          {t.sections.myApps.empty}
        </Typography>
        <Button variant="contained" onClick={onGoCatalog}>
          {t.sections.myApps.goToCatalog}
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.myApps.title}</Typography>
        <Typography color="text.secondary">{t.sections.myApps.subtitle}</Typography>
      </Stack>
      <AppsGrid>
        {apps.map((app) => {
          const meta = getAppMeta(app.id);
          const isRunning = app.status === 'running';
          const isInstalling = app.status === 'installing';
          const isError = app.status === 'error';
          const statusLabel = isRunning
            ? t.actions.running
            : isInstalling
              ? t.actions.installing
              : isError
                ? t.actions.error
                : t.actions.installed;
          const statusColor = isRunning
            ? 'info'
            : isInstalling
              ? 'warning'
              : isError
                ? 'error'
                : 'success';
          const primaryAction = isRunning ? 'stop' : isError ? 'retry' : 'open';
          const primaryActionLabel = isRunning
            ? t.actions.stop
            : isError
              ? t.actions.retry
              : t.actions.open;

          return (
            <AppCard
              key={app.id}
              appName={meta.name}
              categoryLabel={getCategoryLabel(app.category)}
              description={meta.description}
              statusLabel={statusLabel}
              statusColor={statusColor}
              primaryAction={primaryAction}
              primaryActionLabel={primaryActionLabel}
              primaryDisabled={isInstalling}
              onPrimaryAction={() => {
                if (isRunning) {
                  onStop(app.id);
                  return;
                }

                if (isError) {
                  onRetry(app.id);
                  return;
                }

                onOpen(app.id);
              }}
              tertiaryActionLabel={isInstalling ? undefined : t.actions.uninstall}
              onTertiaryAction={isInstalling ? undefined : () => onDelete(app.id)}
              onCardClick={() => onDetails(app.id)}
            />
          );
        })}
      </AppsGrid>
    </Stack>
  );
}
