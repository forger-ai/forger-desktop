import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import {
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { AppDetails } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface AppViewProps {
  details: AppDetails | null;
  t: AppDictionary;
  categoryLabel: string;
  onBack: () => void;
  onInstall: (appId: string) => void;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
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
  t,
  categoryLabel,
  onBack,
  onInstall,
  onOpen,
  onStop,
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
              color={details.installed ? (hasError ? 'error' : isRunning ? 'info' : 'success') : 'default'}
              label={details.installed ? (isRunning ? t.actions.running : hasError ? t.actions.error : t.actions.installed) : t.actions.available}
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
        ) : isRunning ? (
          <Button variant="contained" color="warning" startIcon={<StopCircleRounded />} onClick={() => onStop(appId)}>
            {t.actions.stop}
          </Button>
        ) : (
          <Button variant="contained" startIcon={<LaunchRounded />} onClick={() => onOpen(appId)}>
            {t.actions.open}
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
            <Typography color="text.secondary">{t.appView.updatesBody}</Typography>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
