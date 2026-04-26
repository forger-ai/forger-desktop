import { Chip, Stack, Typography } from '@mui/material';
import type { AppCategory, CatalogApp } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { AppCard } from '@renderer/components/AppCard';
import { AppsGrid } from '@renderer/components/AppsGrid';

interface CatalogViewProps {
  apps: CatalogApp[];
  filter: 'all' | AppCategory;
  onFilterChange: (filter: 'all' | AppCategory) => void;
  onInstall: (appId: string) => void;
  t: AppDictionary;
  getAppMeta: (appId: string) => { name: string; description: string };
  getCategoryLabel: (category: AppCategory) => string;
}

const filters: Array<'all' | AppCategory> = ['all', 'finanzas', 'hogar', 'salud', 'productividad'];

export function CatalogView({
  apps,
  filter,
  onFilterChange,
  onInstall,
  t,
  getAppMeta,
  getCategoryLabel,
}: CatalogViewProps) {
  const visibleApps = filter === 'all' ? apps : apps.filter((app) => app.category === filter);

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.catalog.title}</Typography>
        <Typography color="text.secondary">{t.sections.catalog.subtitle}</Typography>
      </Stack>
      <Stack spacing={1}>
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
            const isInstalled = app.status === 'installed' || app.status === 'running';
            const isInstalling = app.status === 'installing';
            const hasError = app.status === 'error';
            const statusLabel = isInstalling
              ? t.actions.installing
              : app.status === 'running'
                ? t.actions.running
                : hasError
                  ? t.actions.error
                  : isInstalled
                    ? t.actions.installed
                    : t.actions.available;
            const statusColor = isInstalling
              ? 'warning'
              : app.status === 'running'
                ? 'info'
                : hasError
                  ? 'error'
                  : isInstalled
                    ? 'success'
                    : 'default';
            const primaryAction = hasError ? 'retry' : 'install';
            const primaryActionLabel = hasError
              ? t.actions.retry
              : isInstalling
                ? t.actions.installing
                : isInstalled
                  ? t.actions.installed
                  : t.actions.install;

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
                primaryDisabled={isInstalled || isInstalling}
                onPrimaryAction={() => {
                  if (!isInstalled && !isInstalling) {
                    onInstall(app.id);
                  }
                }}
              />
            );
          })}
        </AppsGrid>
      )}
    </Stack>
  );
}
