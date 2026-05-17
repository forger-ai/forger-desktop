import AppsRounded from '@mui/icons-material/AppsRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import BackupRounded from '@mui/icons-material/BackupRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import ConstructionRounded from '@mui/icons-material/ConstructionRounded';
import DevicesRounded from '@mui/icons-material/DevicesRounded';
import InsertDriveFileRounded from '@mui/icons-material/InsertDriveFileRounded';
import TableChartRounded from '@mui/icons-material/TableChartRounded';
import FeedbackRounded from '@mui/icons-material/FeedbackRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import VpnKeyRounded from '@mui/icons-material/VpnKeyRounded';
import {
  alpha,
  Box,
  Chip,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { WindowControlState } from '@shared/types';
import type { DesktopUpdateState } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

export type View =
  | 'my-apps'
  | 'catalog'
  | 'chat'
  | 'feedback'
  | 'friends'
  | 'automations'
  | 'files'
  | 'backups'
  | 'devices'
  | 'datos'
  | 'secrets'
  | 'tools'
  | 'settings'
  | 'app';
const isMacOs = navigator.platform.toLowerCase().includes('mac');

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  t: AppDictionary;
  desktopUpdateState: DesktopUpdateState;
  advancedMode: boolean;
}

const defaultNav = [
  { id: 'catalog' as const, icon: <AppsRounded /> },
  { id: 'chat' as const, icon: <AutoAwesomeRounded /> },
  { id: 'feedback' as const, icon: <FeedbackRounded /> },
];

const advancedNav = [
  { id: 'automations' as const, icon: <EventRepeatRounded /> },
  { id: 'files' as const, icon: <InsertDriveFileRounded /> },
  { id: 'backups' as const, icon: <BackupRounded /> },
  { id: 'devices' as const, icon: <DevicesRounded /> },
  { id: 'datos' as const, icon: <TableChartRounded /> },
  { id: 'secrets' as const, icon: <VpnKeyRounded /> },
  { id: 'tools' as const, icon: <ConstructionRounded /> },
];

export function Sidebar({ currentView, onNavigate, t, desktopUpdateState, advancedMode }: SidebarProps) {
  const theme = useTheme();
  const [windowState, setWindowState] = useState<WindowControlState | null>(null);
  const shouldReserveMacTrafficLightSpace =
    isMacOs && !windowState?.isFullScreen;

  useEffect(() => {
    if (!isMacOs) {
      return undefined;
    }

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

  const labels: Record<View, string> = {
    'my-apps': t.nav.myApps,
    catalog: t.nav.apps,
    chat: t.nav.chat,
    feedback: t.nav.feedback,
    friends: 'Friends',
    automations: t.nav.automations,
    files: t.nav.files,
    backups: t.nav.backups,
    devices: t.nav.devices,
    datos: t.nav.datos,
    secrets: t.nav.secrets,
    tools: t.nav.tools,
    settings: t.nav.settings,
    app: t.nav.catalog,
  };
  const showUpdateBanner = desktopUpdateState.status === 'available' || desktopUpdateState.status === 'ready';
  const mainNav = advancedMode
    ? [defaultNav[0], defaultNav[1], defaultNav[2], ...advancedNav]
    : defaultNav;

  return (
    <Box
      component="aside"
      sx={{
        width: 232,
        minWidth: 232,
        height: '100vh',
        p: 1.5,
        borderRight: `1px solid ${theme.palette.divider}`,
        bgcolor: alpha(theme.palette.background.paper, 0.84),
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
        WebkitAppRegion: 'no-drag',
      }}
    >
      <Stack sx={{ height: '100%' }}>
        <Stack spacing={2}>
          <Stack
            direction="row"
            spacing={1.5}
            alignItems="center"
            sx={{
              WebkitAppRegion: 'drag',
              minHeight: 38,
              pt: shouldReserveMacTrafficLightSpace ? 4 : 0,
            }}
          >
            <Box
              component="img"
              src={theme.palette.mode === 'dark' ? iconDark : iconLight}
              alt="Forger"
              sx={{ width: 30, height: 30, flexShrink: 0 }}
            />
            <Typography
              sx={{
                fontFamily: '"Poppins", sans-serif',
                fontWeight: 500,
                fontSize: '1.4rem',
                letterSpacing: '0.28em',
                textTransform: 'uppercase',
                lineHeight: 1,
              }}
            >
              Forger
            </Typography>
          </Stack>

          <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            {mainNav.map((item) => (
              <ListItemButton
                key={item.id}
                data-onboarding-target={`nav-${item.id}`}
                selected={currentView === item.id}
                onClick={() => onNavigate(item.id)}
                sx={{ minHeight: 38, py: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 34 }}>{item.icon}</ListItemIcon>
                <ListItemText primary={labels[item.id]} />
              </ListItemButton>
            ))}
          </List>
        </Stack>

        <Box sx={{ flex: 1 }} />

        <Stack spacing={1.25}>
          {showUpdateBanner ? (
            <Box
              role="button"
              tabIndex={0}
              onClick={() => onNavigate('settings')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onNavigate('settings');
                }
              }}
              sx={{
                p: 1,
                borderRadius: 1,
                cursor: 'pointer',
                border: `1px solid ${alpha(theme.palette.warning.main, 0.4)}`,
                bgcolor: alpha(theme.palette.warning.main, theme.palette.mode === 'dark' ? 0.16 : 0.1),
              }}
            >
              <Stack spacing={0.5}>
                <Chip
                  size="small"
                  color="warning"
                  label={t.settings.desktopUpdateStatuses[desktopUpdateState.status]}
                  sx={{ alignSelf: 'flex-start' }}
                />
                <Typography variant="caption" color="text.secondary">
                  {t.settings.sidebarUpdateAvailable(desktopUpdateState.availableVersion)}
                </Typography>
              </Stack>
            </Box>
          ) : null}
          <Box
            sx={{
              p: 1.15,
              borderRadius: 1,
              border: `1px solid ${alpha(theme.palette.primary.main, 0.24)}`,
              background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.1)}, ${alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.14 : 0.08)})`,
            }}
          >
            <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, lineHeight: 1.3 }}>
              {t.settings.sidebarBetaThanks}
            </Typography>
          </Box>
          <List disablePadding>
            <ListItemButton
              selected={currentView === 'settings'}
              onClick={() => onNavigate('settings')}
              sx={{ minHeight: 38, py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 34 }}>
                <SettingsRounded />
              </ListItemIcon>
              <ListItemText primary={labels.settings} />
            </ListItemButton>
          </List>
        </Stack>
      </Stack>
    </Box>
  );
}
