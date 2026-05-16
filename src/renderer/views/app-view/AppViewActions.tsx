import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import { Button, CircularProgress, Stack, Tooltip } from '@mui/material';
import type { AppDetails, InstallAppResult } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface AppViewActionsProps {
  appId: string;
  details: AppDetails;
  installProgress?: InstallAppResult;
  isOpening: boolean;
  t: AppDictionary;
  onInstall: (appId: string) => void;
  onUpdate: (appId: string) => void;
  onOpen: (appId: string) => void;
  onStop: (appId: string) => void;
  onRestoreUserVersion: (appId: string) => void;
  onResolveConflict: (appId: string) => void;
  onDelete: (appId: string) => void;
}

export function AppViewActions({
  appId,
  details,
  installProgress,
  isOpening,
  t,
  onInstall,
  onUpdate,
  onOpen,
  onStop,
  onRestoreUserVersion,
  onResolveConflict,
  onDelete,
}: AppViewActionsProps) {
  const isRunning = details.status === 'running';
  const hasError = details.status === 'error';
  const hasConflict = details.status === 'conflict';
  const isInstalling = details.status === 'installing' || Boolean(installProgress);

  return (
    <Stack direction="row" spacing={1.25} useFlexGap flexWrap="wrap">
      {isInstalling ? (
        <Button variant="contained" startIcon={<CircularProgress color="inherit" size={16} />} disabled aria-busy>
          {t.actions.installing}
        </Button>
      ) : !details.installed ? (
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
      ) : (
        <>
          <Button
            variant="contained"
            startIcon={isOpening ? <CircularProgress color="inherit" size={16} /> : <LaunchRounded />}
            disabled={isOpening}
            aria-busy={isOpening}
            onClick={() => onOpen(appId)}
          >
            {isOpening ? t.actions.opening : t.actions.open}
          </Button>
          {details.updateAvailable ? (
            <Button variant="outlined" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
              {t.actions.update}
            </Button>
          ) : null}
        </>
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
  );
}
