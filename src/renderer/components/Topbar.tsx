import CloseRounded from '@mui/icons-material/CloseRounded';
import CropSquareRounded from '@mui/icons-material/CropSquareRounded';
import FilterNoneRounded from '@mui/icons-material/FilterNoneRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PeopleRounded from '@mui/icons-material/PeopleRounded';
import MinimizeRounded from '@mui/icons-material/MinimizeRounded';
import PersonRounded from '@mui/icons-material/PersonRounded';
import {
  alpha,
  Avatar,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState, type MouseEvent } from 'react';
import type { AppSummary, ForgerAccountSession, WindowControlState } from '@shared/types';
import type { BackgroundTask } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from './Sidebar';
import { BackgroundTasksDrawer } from './BackgroundTasksDrawer';
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

const AppSelect = ({
  apps,
  selectedAppId,
  inactiveLabel,
  onSelect,
  getAppMeta,
}: {
  apps: AppSummary[];
  selectedAppId: string | null;
  inactiveLabel: string;
  onSelect: (appId: string | null) => void;
  getAppMeta: (appId: string) => { name: string; description: string };
}) => {
  const theme = useTheme();
  return (
    <Select
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
  const accountMenuOpen = Boolean(accountAnchorEl);
  const socialMenuOpen = Boolean(socialAnchorEl);
  const accountUser = account.authenticated ? account.user : null;
  const accountName = accountUser?.firstName?.trim() || accountUser?.email.split('@')[0] || '';

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

  const handleOpenSocialTab = (tab: SocialTab) => {
    window.sessionStorage.setItem(LAST_SOCIAL_TAB_KEY, tab);
    setSocialAnchorEl(null);
    onOpenSocialTab(tab);
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
              <Typography variant="body2" color="text.secondary">
                {t.sections.datos.activeAppLabel}
              </Typography>
              <AppSelect
                apps={dataApps}
                selectedAppId={selectedDataAppId}
                inactiveLabel={t.sections.datos.inactiveApp}
                onSelect={onSelectDataApp}
                getAppMeta={getAppMeta}
              />
            </Stack>
          ) : null}
        </Box>

        <Stack direction="row" alignItems="center" spacing={1} sx={{ WebkitAppRegion: 'no-drag', flexShrink: 0 }}>
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
              <MenuItem onClick={() => handleOpenSocialTab('apps')}>Mis apps</MenuItem>
              <MenuItem onClick={() => handleOpenSocialTab('profile')}>Perfil</MenuItem>
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
