import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { AppDetails } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface AppViewProps {
  details: AppDetails | null;
  openingAppIds: Set<string>;
  t: AppDictionary;
  categoryLabel: string;
  onBack: () => void;
  onInstall: (appId: string) => void;
  onUpdate: (appId: string) => void;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
  onRestoreUserVersion: (appId: string) => void;
  onResolveConflict: (appId: string) => void;
  onDelete: (appId: string) => void;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export function AppView({
  details,
  openingAppIds,
  t,
  categoryLabel,
  onBack,
  onInstall,
  onUpdate,
  onOpen,
  onStop,
  onRestoreUserVersion,
  onResolveConflict,
  onDelete,
}: AppViewProps) {
  if (!details) {
    return (
      <Stack spacing={2}>
        <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
          {t.actions.back}
        </Button>
        <Typography color="text.secondary">{t.appView.notFound}</Typography>
      </Stack>
    );
  }

  const appId = details.app.id;
  const appName = details.app.name ?? appId;
  const isRunning = details.status === 'running';
  const hasError = details.status === 'error';
  const hasConflict = details.status === 'conflict';
  const isOpening = openingAppIds.has(appId);

  return (
    <Stack spacing={3}>
      <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.actions.back}
      </Button>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems={{ xs: 'flex-start', md: 'center' }}>
        <Avatar sx={{ width: 84, height: 84, bgcolor: 'secondary.main', color: 'secondary.contrastText', fontSize: 28, fontWeight: 700 }}>
          {initialsFromName(appName)}
        </Avatar>
        <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
            <Typography variant="h3">{appName}</Typography>
            <Chip label={categoryLabel} />
            <Chip
              color={details.installed ? (hasError || hasConflict ? 'error' : isRunning ? 'info' : details.updateAvailable ? 'warning' : 'success') : 'default'}
              label={details.installed ? (isRunning ? t.actions.running : hasConflict ? t.actions.conflict : hasError ? t.actions.error : details.updateAvailable && details.latestVersion ? t.appView.updateAvailable(details.latestVersion) : t.actions.installed) : t.actions.available}
            />
          </Stack>
          <Typography color="text.secondary" sx={{ maxWidth: 760 }}>
            {details.app.description}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {details.installed
              ? `${t.appView.installedVersion}: ${details.version ?? '-'}`
              : `${t.appView.availableVersion}: ${details.latestVersion ?? details.version ?? '-'}`}
          </Typography>
        </Stack>
      </Stack>

      <Stack direction="row" spacing={1.25} useFlexGap flexWrap="wrap">
        {!details.installed ? (
          <Button variant="contained" startIcon={<DownloadRounded />} onClick={() => onInstall(appId)}>
            {t.actions.install}
          </Button>
        ) : hasConflict ? (
          <>
            <Button variant="contained" color="warning" startIcon={<SystemUpdateAltRounded />} onClick={() => onResolveConflict(appId)}>
              {t.actions.resolveWithForger}
            </Button>
            <Button variant="outlined" onClick={() => onRestoreUserVersion(appId)}>
              {t.actions.restoreUserVersion}
            </Button>
          </>
        ) : isRunning ? (
          <Button variant="contained" color="warning" startIcon={<StopCircleRounded />} onClick={() => onStop(appId)}>
            {t.actions.stop}
          </Button>
        ) : details.updateAvailable ? (
          <Button variant="contained" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
            {t.actions.update}
          </Button>
        ) : (
          <Button
            variant="contained"
            startIcon={isOpening ? <CircularProgress color="inherit" size={16} /> : <LaunchRounded />}
            disabled={isOpening}
            aria-busy={isOpening}
            onClick={() => onOpen(appId)}
          >
            {isOpening ? t.actions.opening : t.actions.open}
          </Button>
        )}
        {details.installed ? (
          <Button variant="outlined" color="error" startIcon={<DeleteOutlineRounded />} onClick={() => onDelete(appId)}>
            {t.actions.delete}
          </Button>
        ) : null}
        {hasError ? (
          <Tooltip title={t.actions.comingSoon}>
            <span>
              <Button disabled>{t.actions.askForgerHelp}</Button>
            </span>
          </Tooltip>
        ) : null}
      </Stack>

      {!details.installed ? (
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            minHeight: 220,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'background.paper',
          }}
        >
          <Typography color="text.secondary">{t.appView.screenshotsPlaceholder}</Typography>
        </Box>
      ) : (
        <Stack spacing={3}>
          <Divider />
          <Stack spacing={1}>
            <Typography variant="h5">{t.appView.historyTitle}</Typography>
            {details.operations.length === 0 ? (
              <Typography color="text.secondary">{t.appView.noHistory}</Typography>
            ) : (
              <Stack spacing={1.25}>
                {details.operations.map((operation) => (
                  <Box key={operation.operationId} sx={{ borderLeft: '3px solid', borderColor: operation.revertedAt ? 'divider' : 'primary.main', pl: 1.5 }}>
                    <Typography fontWeight={600}>{operation.title}</Typography>
                    <Typography variant="body2" color="text.secondary">{operation.summary}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(operation.createdAt).toLocaleString()}
                      {operation.revertedAt ? ` · ${t.appView.reverted}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
          <Stack spacing={1}>
            <Typography variant="h5">{t.appView.updatesTitle}</Typography>
            {hasConflict ? <Typography color="error.main">{t.appView.conflictBody}</Typography> : null}
            <Typography color="text.secondary">{t.appView.updatesBody}</Typography>
            {details.changelog ? (
              <Box sx={{ borderLeft: '3px solid', borderColor: 'warning.main', pl: 1.5 }}>
                <Typography fontWeight={600}>{details.changelog.summary ?? t.appView.updateAvailable(details.changelog.version)}</Typography>
                {details.changelog.changes.length > 0 ? (
                  <Stack component="ul" sx={{ m: 0, pl: 2 }}>
                    {details.changelog.changes.map((change) => (
                      <Typography component="li" variant="body2" color="text.secondary" key={change}>
                        {change}
                      </Typography>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">{t.appView.updateNoChangelog}</Typography>
                )}
              </Box>
            ) : null}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
