import CloseRounded from '@mui/icons-material/CloseRounded';
import CropSquareRounded from '@mui/icons-material/CropSquareRounded';
import DeviceHubRounded from '@mui/icons-material/DeviceHubRounded';
import FilterNoneRounded from '@mui/icons-material/FilterNoneRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PeopleRounded from '@mui/icons-material/PeopleRounded';
import MinimizeRounded from '@mui/icons-material/MinimizeRounded';
import PersonRounded from '@mui/icons-material/PersonRounded';
import StorageRounded from '@mui/icons-material/StorageRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import {
  alpha,
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState, type MouseEvent } from 'react';
import type { AppSummary, CloudStorageUsage, ForgerAccountSession, WindowControlState } from '@shared/types';
import type { BackgroundTask } from '@shared/types';
import type { RemoteActivityItem, RemoteActivitySnapshot } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from './Sidebar';
import { BackgroundTasksDrawer } from './BackgroundTasksDrawer';
import { LlmRunsDrawer } from './LlmRunsDrawer';
import { LAST_SOCIAL_TAB_KEY, type SocialTab } from '@renderer/views/friends/socialViewHelpers';

interface TopbarProps {
  currentView: View;
  t: AppDictionary;
  chatModeLabel?: string | null;
  dataApps: AppSummary[];
  selectedDataAppId: string | null;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSelectDataApp: (appId: string | null) => void;
  onOpenCloudModal: () => void;
  account: ForgerAccountSession;
  accountBusy: boolean;
  cloudStorageUsage: CloudStorageUsage | null;
  cloudStorageBusy: boolean;
  onOpenStorageSettings: () => void;
  onOpenSocialTab: (tab: SocialTab) => void;
  onLogout: () => void;
  backgroundTasks: BackgroundTask[];
  backgroundTasksOpen: boolean;
  activeBackgroundTaskCount: number;
  onOpenBackgroundTasks: () => void;
  onCloseBackgroundTasks: () => void;
  onOpenBackgroundTaskHistory: () => void;
  onOpenBackgroundTask: (taskId: string) => void;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

const formatStorageBytes = (bytes: number, locale: string) => {
  const units = [
    { value: 1024 ** 3, label: 'GB' },
    { value: 1024 ** 2, label: 'MB' },
    { value: 1024, label: 'KB' },
  ];
  const unit = units.find((entry) => bytes >= entry.value) ?? units[1];
  const value = bytes / unit.value;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${unit.label}`;
};

const emptyRemoteActivity = (): RemoteActivitySnapshot => ({
  activities: [],
  activeCount: 0,
  preparingCount: 0,
  errorCount: 0,
  updatedAt: new Date(0).toISOString(),
});

const AppSelect = ({
  apps,
  selectedAppId,
  labelId,
  inactiveLabel,
  onSelect,
  getAppMeta,
}: {
  apps: AppSummary[];
  selectedAppId: string | null;
  labelId: string;
  inactiveLabel: string;
  onSelect: (appId: string | null) => void;
  getAppMeta: (appId: string) => { name: string; description: string };
}) => {
  const theme = useTheme();
  return (
    <Select
      labelId={labelId}
      value={selectedAppId ?? ''}
      onChange={(event) => onSelect(event.target.value || null)}
      size="small"
      displayEmpty
      IconComponent={KeyboardArrowDownRounded}
      renderValue={(value) => {
        if (!value) return <Typography variant="body2" color="text.secondary">{inactiveLabel}</Typography>;
        const appMeta = getAppMeta(value);
        return (
          <Stack direction="row" spacing={1} alignItems="center">
            <Avatar sx={{ width: 22, height: 22, bgcolor: 'secondary.main', color: 'secondary.contrastText', fontSize: 11 }}>
              {initialsFromName(appMeta.name)}
            </Avatar>
            <Typography variant="body2">{appMeta.name}</Typography>
          </Stack>
        );
      }}
      sx={{
        minWidth: 220,
        bgcolor: alpha(theme.palette.background.paper, 0.9),
        WebkitAppRegion: 'no-drag',
        '& .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider },
      }}
    >
      <MenuItem value="">
        <Typography variant="body2" color="text.secondary">{inactiveLabel}</Typography>
      </MenuItem>
      {apps.map((app) => {
        const appMeta = getAppMeta(app.id);
        return (
          <MenuItem key={app.id} value={app.id}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Avatar sx={{ width: 22, height: 22, bgcolor: 'secondary.main', color: 'secondary.contrastText', fontSize: 11 }}>
                {initialsFromName(appMeta.name)}
              </Avatar>
              <Typography variant="body2">{appMeta.name}</Typography>
            </Stack>
          </MenuItem>
        );
      })}
    </Select>
  );
};

const WindowControls = ({ t }: { t: AppDictionary }) => {
  const theme = useTheme();
  const [windowState, setWindowState] = useState<WindowControlState | null>(null);

  useEffect(() => {
    let mounted = true;
    const desktopApi = window.forger;

    void desktopApi
      .getWindowState()
      .then((state) => {
        if (mounted) {
          setWindowState(state);
        }
      })
      .catch(() => undefined);

    const removeListener = desktopApi.onWindowStateChanged((state) => {
      setWindowState(state);
    });

    return () => {
      mounted = false;
      removeListener();
    };
  }, []);

  if (!windowState?.usesCustomFrame) {
    return null;
  }

  const isMaximized = windowState.isMaximized || windowState.isFullScreen;

  const controlSx = {
    width: 34,
    height: 30,
    borderRadius: 1,
    color: 'text.secondary',
    '&:hover': {
      bgcolor: alpha(theme.palette.text.primary, 0.08),
      color: 'text.primary',
    },
  };

  return (
    <Stack direction="row" alignItems="center" spacing={0.25} sx={{ WebkitAppRegion: 'no-drag' }}>
      <Tooltip title={t.window.minimize}>
        <IconButton size="small" aria-label={t.window.minimize} onClick={() => void window.forger.minimizeWindow()} sx={controlSx}>
          <MinimizeRounded sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title={isMaximized ? t.window.restore : t.window.maximize}>
        <IconButton
          size="small"
          aria-label={isMaximized ? t.window.restore : t.window.maximize}
          onClick={() => void window.forger.toggleMaximizeWindow()}
          sx={controlSx}
        >
          {isMaximized ? <FilterNoneRounded sx={{ fontSize: 15 }} /> : <CropSquareRounded sx={{ fontSize: 15 }} />}
        </IconButton>
      </Tooltip>
      <Tooltip title={t.window.close}>
        <IconButton
          size="small"
          aria-label={t.window.close}
          onClick={() => void window.forger.closeWindow()}
          sx={{
            ...controlSx,
            '&:hover': {
              bgcolor: theme.palette.error.main,
              color: theme.palette.error.contrastText,
            },
          }}
        >
          <CloseRounded sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    </Stack>
  );
};

export function Topbar({
  currentView,
  t,
  chatModeLabel,
  dataApps,
  selectedDataAppId,
  getAppMeta,
  onSelectDataApp,
  onOpenCloudModal,
  account,
  accountBusy,
  cloudStorageUsage,
  cloudStorageBusy,
  onOpenStorageSettings,
  onOpenSocialTab,
  onLogout,
  backgroundTasks,
  backgroundTasksOpen,
  activeBackgroundTaskCount,
  onOpenBackgroundTasks,
  onCloseBackgroundTasks,
  onOpenBackgroundTaskHistory,
  onOpenBackgroundTask,
}: TopbarProps) {
  const theme = useTheme();
  const [accountAnchorEl, setAccountAnchorEl] = useState<HTMLElement | null>(null);
  const [socialAnchorEl, setSocialAnchorEl] = useState<HTMLElement | null>(null);
  const [remoteActivityAnchorEl, setRemoteActivityAnchorEl] = useState<HTMLElement | null>(null);
  const [remoteActivity, setRemoteActivity] = useState<RemoteActivitySnapshot>(() => emptyRemoteActivity());
  const [stoppingRemoteActivityIds, setStoppingRemoteActivityIds] = useState<Set<string>>(() => new Set());
  const accountMenuOpen = Boolean(accountAnchorEl);
  const socialMenuOpen = Boolean(socialAnchorEl);
  const remoteActivityOpen = Boolean(remoteActivityAnchorEl);
  const accountUser = account.authenticated ? account.user : null;
  const accountName = accountUser?.firstName?.trim() || accountUser?.email.split('@')[0] || '';
  const storagePercent = cloudStorageUsage && cloudStorageUsage.limitBytes > 0
    ? Math.min(100, Math.round((cloudStorageUsage.usedBytes / cloudStorageUsage.limitBytes) * 100))
    : 0;
  const storageColor = storagePercent >= 95 ? 'error' : storagePercent >= 80 ? 'warning' : 'primary';
  const remoteActivityCount = remoteActivity.activeCount + remoteActivity.preparingCount + remoteActivity.errorCount;

  useEffect(() => {
    let mounted = true;
    void window.forger.getRemoteActivity()
      .then((snapshot) => {
        if (mounted) setRemoteActivity(snapshot);
      })
      .catch(() => undefined);
    const unsubscribe = window.forger.onRemoteActivityChanged((snapshot) => {
      setRemoteActivity(snapshot);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleAccountClick = (event: MouseEvent<HTMLElement>) => {
    if (accountUser) {
      setAccountAnchorEl(event.currentTarget);
      return;
    }

    onOpenCloudModal();
  };

  const handleLogout = () => {
    setAccountAnchorEl(null);
    onLogout();
  };

  const handleOpenStorageSettings = () => {
    setAccountAnchorEl(null);
    onOpenStorageSettings();
  };

  const handleOpenSocialTab = (tab: SocialTab) => {
    window.sessionStorage.setItem(LAST_SOCIAL_TAB_KEY, tab);
    setSocialAnchorEl(null);
    onOpenSocialTab(tab);
  };

  const handleRemoteActivityClick = (event: MouseEvent<HTMLElement>) => {
    setRemoteActivityAnchorEl(event.currentTarget);
  };

  const refreshRemoteActivity = async () => {
    const snapshot = await window.forger.getRemoteActivity();
    setRemoteActivity(snapshot);
    return snapshot;
  };

  const canStopRemoteActivity = (activity: RemoteActivityItem) =>
    activity.kind === 'app' && activity.state !== 'closed';

  const handleStopRemoteActivity = async (activity: RemoteActivityItem) => {
    setStoppingRemoteActivityIds((current) => new Set(current).add(activity.id));
    try {
      await window.forger.stopRemoteNetworkShare(activity.targetId);
      await refreshRemoteActivity().catch(() => undefined);
    } finally {
      setStoppingRemoteActivityIds((current) => {
        const next = new Set(current);
        next.delete(activity.id);
        return next;
      });
    }
  };

  return (
    <Box
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 2,
        px: 2.5,
        py: 1.25,
        borderBottom: `1px solid ${theme.palette.divider}`,
        bgcolor: alpha(theme.palette.background.paper, 0.88),
        backdropFilter: 'blur(14px)',
        WebkitAppRegion: 'drag',
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
        <Box sx={{ minWidth: 0, WebkitAppRegion: 'no-drag' }}>
          {currentView === 'chat' ? (
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {t.sections.chat.modeLabel}
              </Typography>
              <Tooltip title={t.sections.chat.modeLockedTooltip}>
                <Chip size="small" variant="outlined" label={chatModeLabel ?? t.sections.chat.modeSelector.pendingChip} />
              </Tooltip>
            </Stack>
          ) : null}

          {currentView === 'datos' ? (
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Typography id="active-data-app-label" variant="body2" color="text.secondary">
                {t.sections.datos.activeAppLabel}
              </Typography>
              <AppSelect
                apps={dataApps}
                selectedAppId={selectedDataAppId}
                labelId="active-data-app-label"
                inactiveLabel={t.sections.datos.inactiveApp}
                onSelect={onSelectDataApp}
                getAppMeta={getAppMeta}
              />
            </Stack>
          ) : null}
        </Box>

        <Stack direction="row" alignItems="center" spacing={1} sx={{ WebkitAppRegion: 'no-drag', flexShrink: 0 }}>
          <Tooltip title={t.remoteActivity.open}>
            <IconButton
              size="small"
              aria-label={t.remoteActivity.open}
              onClick={handleRemoteActivityClick}
              sx={{
                width: 34,
                height: 34,
                color: remoteActivity.errorCount > 0 ? 'error.main' : remoteActivityCount > 0 ? 'primary.main' : 'text.secondary',
                bgcolor: remoteActivityCount > 0 ? alpha(theme.palette.primary.main, 0.09) : 'transparent',
              }}
            >
              <DeviceHubRounded sx={{ fontSize: 19 }} />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={remoteActivityAnchorEl}
            open={remoteActivityOpen}
            onClose={() => setRemoteActivityAnchorEl(null)}
            PaperProps={{ sx: { mt: 1, minWidth: 320, maxWidth: 380, borderRadius: 2 } }}
          >
            <Box sx={{ px: 2, py: 1.5 }}>
              <Stack spacing={0.5}>
                <Typography variant="subtitle2">{t.remoteActivity.title}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {t.remoteActivity.activeSummary(remoteActivity.activeCount, remoteActivity.preparingCount)}
                </Typography>
              </Stack>
            </Box>
            <Divider />
            {remoteActivity.activities.length === 0 ? (
              <Box sx={{ px: 2, py: 2 }}>
                <Typography variant="body2" color="text.secondary">{t.remoteActivity.empty}</Typography>
              </Box>
            ) : remoteActivity.activities.map((activity) => (
              <MenuItem key={activity.id} disableRipple sx={{ alignItems: 'stretch', whiteSpace: 'normal', py: 1.25 }}>
                <Stack spacing={0.75} sx={{ width: '100%' }}>
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={700} noWrap>
                        {activity.targetName}
                      </Typography>
                      <Chip
                        size="small"
                        label={activity.kind === 'agent' ? t.remoteActivity.agent : t.remoteActivity.app}
                        sx={{ height: 20 }}
                      />
                    </Stack>
                    <Chip
                      size="small"
                      color={activity.state === 'error' ? 'error' : activity.state === 'active' ? 'success' : 'warning'}
                      label={t.remoteActivity.states[activity.state]}
                      sx={{ height: 22, flexShrink: 0 }}
                    />
                  </Stack>
                  {activity.requesterMobileDevice ? (
                    <Typography variant="caption" color="text.secondary">
                      {t.remoteActivity.mobileRequested(activity.requesterMobileDevice.name)}
                    </Typography>
                  ) : null}
                  {activity.lastError ? (
                    <Typography variant="caption" color="error.main">
                      {activity.lastError}
                    </Typography>
                  ) : null}
                  {canStopRemoteActivity(activity) ? (
                    <Button
                      size="small"
                      color="warning"
                      variant="outlined"
                      startIcon={<StopCircleRounded fontSize="small" />}
                      disabled={stoppingRemoteActivityIds.has(activity.id)}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleStopRemoteActivity(activity);
                      }}
                      sx={{ alignSelf: 'flex-start' }}
                    >
                      {stoppingRemoteActivityIds.has(activity.id) ? t.remoteActivity.stopping : t.remoteActivity.stop}
                    </Button>
                  ) : null}
                </Stack>
              </MenuItem>
            ))}
          </Menu>
          <BackgroundTasksDrawer
            t={t}
            tasks={backgroundTasks}
            open={backgroundTasksOpen}
            activeCount={activeBackgroundTaskCount}
            onOpen={onOpenBackgroundTasks}
            onClose={onCloseBackgroundTasks}
            onOpenHistory={onOpenBackgroundTaskHistory}
            onOpenTask={onOpenBackgroundTask}
          />
          <LlmRunsDrawer t={t} />
          <Box data-onboarding-target="social-actions">
            <Tooltip title="Social">
              <IconButton
                size="small"
                aria-label="Social"
                aria-controls={socialMenuOpen ? 'forger-social-menu' : undefined}
                aria-haspopup="menu"
                aria-expanded={socialMenuOpen ? 'true' : undefined}
                onClick={(event) => setSocialAnchorEl(event.currentTarget)}
                sx={{
                  width: 34,
                  height: 34,
                  borderRadius: 1,
                  color: 'text.secondary',
                  border: '1px solid',
                  borderColor: socialMenuOpen ? 'primary.main' : 'divider',
                  bgcolor: socialMenuOpen ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                }}
              >
                <PeopleRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Menu
              id="forger-social-menu"
              anchorEl={socialAnchorEl}
              open={socialMenuOpen}
              onClose={() => setSocialAnchorEl(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              slotProps={{
                paper: {
                  sx: {
                    mt: 1,
                    width: 220,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    boxShadow: theme.shadows[8],
                  },
                },
              }}
            >
              <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
                <Typography variant="subtitle2" fontWeight={800}>Social</Typography>
                <Typography variant="caption" color="text.secondary">Abrir vista completa</Typography>
              </Box>
              <Divider />
              <MenuItem onClick={() => handleOpenSocialTab('friends')}>Amigos</MenuItem>
              <MenuItem onClick={() => handleOpenSocialTab('forum')}>Foro</MenuItem>
              <MenuItem onClick={() => handleOpenSocialTab('profile')}>Mi perfil</MenuItem>
              <MenuItem onClick={() => handleOpenSocialTab('search')}>Buscar</MenuItem>
            </Menu>
          </Box>
          <IconButton
            data-onboarding-target="account-actions"
            size="small"
            onClick={handleAccountClick}
            sx={{ p: 0.25 }}
            aria-label={t.cloud.openLabel}
            aria-controls={accountMenuOpen ? 'forger-account-menu' : undefined}
            aria-haspopup={accountUser ? 'menu' : undefined}
            aria-expanded={accountMenuOpen ? 'true' : undefined}
          >
            <Avatar sx={{ width: 28, height: 28, bgcolor: 'primary.main', fontSize: 13, fontWeight: 600 }}>
              {accountName ? accountName[0].toUpperCase() : <PersonRounded fontSize="small" />}
            </Avatar>
          </IconButton>
          <Menu
            id="forger-account-menu"
            anchorEl={accountAnchorEl}
            open={accountMenuOpen}
            onClose={() => setAccountAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            slotProps={{
              paper: {
                sx: {
                  mt: 1,
                  width: 260,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  boxShadow: theme.shadows[8],
                },
              },
            }}
          >
            <Box sx={{ px: 2, pt: 1.5, pb: 1.25 }}>
              <Typography variant="subtitle1" fontWeight={700} noWrap>
                {accountName}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {accountUser?.email}
              </Typography>
            </Box>
            <Divider />
            <Box sx={{ px: 2, py: 1.25 }}>
              <Stack spacing={0.75}>
                <Stack direction="row" justifyContent="space-between" spacing={1}>
                  <Typography variant="subtitle2">{t.settings.storageCloudTitle}</Typography>
                  {cloudStorageUsage ? (
                    <Chip size="small" label={t.settings.storagePlanLabel(cloudStorageUsage.plan)} sx={{ height: 22 }} />
                  ) : null}
                </Stack>
                {cloudStorageUsage ? (
                  <>
                    <Typography variant="body2" color="text.secondary">
                      {t.settings.storageUsedOfLimit(
                        formatStorageBytes(cloudStorageUsage.usedBytes, t.locale),
                        formatStorageBytes(cloudStorageUsage.limitBytes, t.locale),
                      )}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={storagePercent}
                      color={storageColor}
                      sx={{ height: 6, borderRadius: 1 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      {t.settings.storageMenuBreakdown(
                        formatStorageBytes(cloudStorageUsage.breakdown.backupsBytes, t.locale),
                        formatStorageBytes(cloudStorageUsage.breakdown.uploadedAppsBytes + cloudStorageUsage.breakdown.pendingUserAppUploadsBytes, t.locale),
                        formatStorageBytes(cloudStorageUsage.breakdown.otherBytes, t.locale),
                      )}
                    </Typography>
                  </>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    {cloudStorageBusy ? t.settings.storageLoading : t.settings.storageUnavailable}
                  </Typography>
                )}
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<StorageRounded />}
                  onClick={handleOpenStorageSettings}
                  sx={{ justifyContent: 'flex-start', alignSelf: 'flex-start', px: 0.5 }}
                >
                  {t.settings.storageManage}
                </Button>
              </Stack>
            </Box>
            <Divider />
            <Box sx={{ px: 1, py: 1 }}>
              <Button
                color="inherit"
                fullWidth
                startIcon={<LogoutRounded />}
                onClick={handleLogout}
                disabled={accountBusy}
                sx={{ justifyContent: 'flex-start' }}
              >
                {t.cloud.logout}
              </Button>
            </Box>
          </Menu>
          <WindowControls t={t} />
        </Stack>
      </Stack>
    </Box>
  );
}
