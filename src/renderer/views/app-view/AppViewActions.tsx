import ArrowDropDownRounded from '@mui/icons-material/ArrowDropDownRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import { Button, ButtonGroup, CircularProgress, Menu, MenuItem, Stack, Tooltip } from '@mui/material';
import type { AppDetails, InstallAppResult } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { isOpenableError, isRetryableInstallError, isUpdateError } from '@renderer/app-error-actions';
import { useState } from 'react';

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
  onStartLocalNetworkShare: (appId: string) => void;
  onStartRemoteNetworkShare: (appId: string) => void;
  onStopRemoteNetworkShare: (appId: string) => void;
  onUploadSocial: (appId: string) => void;
  onRenameApp: (appId: string) => void;
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
  onStartLocalNetworkShare,
  onStartRemoteNetworkShare,
  onStopRemoteNetworkShare,
  onUploadSocial,
  onRenameApp,
}: AppViewActionsProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const isRunning = details.status === 'running';
  const hasError = details.status === 'error';
  const canOpenError = isOpenableError(details.app);
  const canRetryInstallError = isRetryableInstallError(details.app);
  const canRecoverUpdateError = isUpdateError(details.app);
  const hasConflict = details.status === 'conflict';
  const isInstalling = details.status === 'installing' || Boolean(installProgress);
  const canUseAppActionMenu = details.installed && !isInstalling && !hasConflict && (!hasError || canOpenError);
  const canShareLocalNetwork = canUseAppActionMenu && details.app.localNetworkShareSupported === true;
  const canShareRemoteNetwork = canUseAppActionMenu && details.app.remoteTunnelSupported === true;
  const canStopRemoteNetwork = canUseAppActionMenu
    && Boolean(details.app.remoteNetworkShare?.active)
    && details.app.remoteNetworkShare?.state !== 'closed'
    && details.app.remoteNetworkShare?.state !== 'inactive';
  const canUploadSocial = canUseAppActionMenu && (details.app.privateLocal === true || Boolean(details.app.socialSource));
  const canRenameApp = canUploadSocial;
  const appMenuActions = [
    ...(canRenameApp ? [{ label: t.social.renameAppAction, onClick: () => onRenameApp(appId) }] : []),
    ...(canShareLocalNetwork ? [{ label: t.localNetwork.menuAction, onClick: () => onStartLocalNetworkShare(appId) }] : []),
    ...(canShareRemoteNetwork ? [{ label: t.remoteNetwork.menuAction, onClick: () => onStartRemoteNetworkShare(appId) }] : []),
    ...(canStopRemoteNetwork ? [{ label: t.remoteNetwork.stop, onClick: () => onStopRemoteNetworkShare(appId) }] : []),
    ...(canUploadSocial ? [{ label: t.locale === 'es' ? 'Subir a Social' : 'Upload to Social', onClick: () => onUploadSocial(appId) }] : []),
  ];
  const appMenuEnabled = appMenuActions.length > 0;

  const openButton = (
    <Button
      variant="contained"
      startIcon={isOpening ? <CircularProgress color="inherit" size={16} /> : <LaunchRounded />}
      disabled={isOpening}
      aria-busy={isOpening}
      onClick={() => onOpen(appId)}
    >
      {isOpening ? t.actions.opening : t.actions.open}
    </Button>
  );

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
      ) : canRecoverUpdateError ? (
        <Button variant="contained" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
          {t.actions.update}
        </Button>
      ) : canRetryInstallError ? (
        <Button variant="contained" startIcon={<DownloadRounded />} onClick={() => onInstall(appId)}>
          {t.actions.retry}
        </Button>
      ) : isRunning ? (
        appMenuEnabled ? (
          <>
            <ButtonGroup variant="contained">
              <Button color="warning" startIcon={<StopCircleRounded />} onClick={() => onStop(appId)}>
                {t.actions.stop}
              </Button>
              <Button
                color="warning"
                size="small"
                aria-label={`${t.actions.stop} menu`}
                aria-haspopup="menu"
                aria-expanded={Boolean(menuAnchor)}
                onClick={(event) => setMenuAnchor(event.currentTarget)}
              >
                <ArrowDropDownRounded />
              </Button>
            </ButtonGroup>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
              {appMenuActions.map((action) => (
                <MenuItem
                  key={action.label}
                  onClick={() => {
                    setMenuAnchor(null);
                    action.onClick();
                  }}
                >
                  {action.label}
                </MenuItem>
              ))}
            </Menu>
          </>
        ) : (
          <Button variant="contained" color="warning" startIcon={<StopCircleRounded />} onClick={() => onStop(appId)}>
            {t.actions.stop}
          </Button>
        )
      ) : (
        <>
          {appMenuEnabled ? (
            <>
              <ButtonGroup variant="contained" disabled={isOpening} aria-busy={isOpening}>
                {openButton}
                <Button
                  size="small"
                  aria-label={`${isOpening ? t.actions.opening : t.actions.open} menu`}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(menuAnchor)}
                  disabled={isOpening}
                  onClick={(event) => setMenuAnchor(event.currentTarget)}
                >
                  <ArrowDropDownRounded />
                </Button>
              </ButtonGroup>
              <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                {appMenuActions.map((action) => (
                  <MenuItem
                    key={action.label}
                    onClick={() => {
                      setMenuAnchor(null);
                      action.onClick();
                    }}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              </Menu>
            </>
          ) : openButton}
          {details.updateAvailable ? (
            <Button variant="outlined" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
              {t.actions.update}
            </Button>
          ) : null}
        </>
      )}
      {isRunning && details.updateAvailable ? (
        <Button variant="outlined" startIcon={<SystemUpdateAltRounded />} onClick={() => onUpdate(appId)}>
          {t.actions.update}
        </Button>
      ) : null}
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
