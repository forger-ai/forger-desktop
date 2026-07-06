import AppsRounded from '@mui/icons-material/AppsRounded';
import AccountTreeRounded from '@mui/icons-material/AccountTreeRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import BackupRounded from '@mui/icons-material/BackupRounded';
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded';
import ConstructionRounded from '@mui/icons-material/ConstructionRounded';
import DevicesRounded from '@mui/icons-material/DevicesRounded';
import InsertDriveFileRounded from '@mui/icons-material/InsertDriveFileRounded';
import SmartToyRounded from '@mui/icons-material/SmartToyRounded';
import TableChartRounded from '@mui/icons-material/TableChartRounded';
import FeedbackRounded from '@mui/icons-material/FeedbackRounded';
import PeopleRounded from '@mui/icons-material/PeopleRounded';
import SpeedRounded from '@mui/icons-material/SpeedRounded';
import GridViewRounded from '@mui/icons-material/GridViewRounded';
import HubRounded from '@mui/icons-material/HubRounded';
import MenuBookRounded from '@mui/icons-material/MenuBookRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import VpnKeyRounded from '@mui/icons-material/VpnKeyRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import {
  alpha,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Popover,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState, type MouseEvent, type ReactElement } from 'react';
import type { WindowControlState } from '@shared/types';
import type { DesktopUpdateState } from '@shared/types';
import type { AgentProviderUsageEntry, AgentProviderUsageWindow } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

export type View =
  | 'apps'
  | 'catalog'
  | 'chat'
  | 'agents'
  | 'feedback'
  | 'friends'
  | 'automations'
  | 'workflows'
  | 'workflowEditor'
  | 'workflowDetail'
  | 'files'
  | 'backups'
  | 'devices'
  | 'datos'
  | 'secrets'
  | 'connections'
  | 'connectionDetail'
  | 'tools'
  | 'docs'
  | 'more'
  | 'settings'
  | 'app'
  | 'backgroundTasks'
  | 'backgroundTaskDetail';
const isMacOs = navigator.platform.toLowerCase().includes('mac');

export const PINNABLE_VIEWS = ['automations', 'workflows', 'files', 'backups', 'devices', 'datos', 'secrets', 'connections', 'tools', 'docs'] as const;
export type PinnableView = (typeof PINNABLE_VIEWS)[number];

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  t: AppDictionary;
  desktopUpdateState: DesktopUpdateState;
  pinnedViews: PinnableView[];
  showForumNav: boolean;
}

const defaultNav = [
  { id: 'chat' as const, icon: <AutoAwesomeRounded /> },
  { id: 'apps' as const, icon: <AppsRounded /> },
  { id: 'agents' as const, icon: <SmartToyRounded /> },
  { id: 'catalog' as const, icon: <StorefrontRounded /> },
  { id: 'friends' as const, icon: <PeopleRounded /> },
  { id: 'feedback' as const, icon: <FeedbackRounded /> },
];

export const pinnableNav: Array<{ id: PinnableView; icon: ReactElement }> = [
  { id: 'automations', icon: <EventRepeatRounded /> },
  { id: 'workflows', icon: <AccountTreeRounded /> },
  { id: 'files', icon: <InsertDriveFileRounded /> },
  { id: 'backups', icon: <BackupRounded /> },
  { id: 'devices', icon: <DevicesRounded /> },
  { id: 'datos', icon: <TableChartRounded /> },
  { id: 'secrets', icon: <VpnKeyRounded /> },
  { id: 'connections', icon: <HubRounded /> },
  { id: 'tools', icon: <ConstructionRounded /> },
  { id: 'docs', icon: <MenuBookRounded /> },
];

const formatResetLabel = (window: AgentProviderUsageWindow): string | null => {
  if (!window.resetsAt) {
    return null;
  }
  const date = new Date(window.resetsAt * 1000);
  if (window.kind === 'weekly') {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const usageWindowLabel = (window: AgentProviderUsageWindow, t: AppDictionary): string =>
  window.kind === 'five_hour' ? t.providerUsage.fiveHour : t.providerUsage.weekly;

const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const usageMeterColor = (remainingPercent: number): 'success' | 'warning' | 'error' =>
  remainingPercent >= 40 ? 'success' : remainingPercent >= 15 ? 'warning' : 'error';

const worstRemainingPercent = (usage: AgentProviderUsageEntry[]): number | null => {
  let worst: number | null = null;
  for (const entry of usage) {
    for (const window of entry.windows) {
      if (typeof window.remainingPercent === 'number' && (worst === null || window.remainingPercent < worst)) {
        worst = window.remainingPercent;
      }
    }
  }
  return worst;
};

function SidebarUsageMenu({ t }: { t: AppDictionary }) {
  const theme = useTheme();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<AgentProviderUsageEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const open = Boolean(anchorEl);

  const refreshUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.forger.getAgentProviderUsage();
      setUsage(result.providers);
      if (!result.success) {
        setError(result.userMessage ?? t.providerUsage.error);
      }
    } catch {
      setUsage([]);
      setError(t.providerUsage.error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshUsage();
    const interval = window.setInterval(() => {
      void refreshUsage();
    }, USAGE_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const handleToggle = (event: MouseEvent<HTMLElement>) => {
    if (open) {
      setAnchorEl(null);
      return;
    }
    setAnchorEl(event.currentTarget);
    void refreshUsage();
  };

  const worstRemaining = worstRemainingPercent(usage);

  return (
    <Box>
      <List disablePadding>
        <ListItemButton
          onClick={handleToggle}
          selected={open}
          sx={{
            minHeight: 38,
            py: 0.5,
            color: 'text.secondary',
            '&.Mui-selected': {
              bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.08 : 0.05),
              color: 'text.primary',
            },
            '&.Mui-selected:hover': {
              bgcolor: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.11 : 0.07),
            },
          }}
        >
          <ListItemIcon sx={{ minWidth: 34, color: 'inherit' }}>
            <SpeedRounded fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t.providerUsage.title} primaryTypographyProps={{ fontSize: 14 }} />
          {worstRemaining !== null ? (
            <Typography
              variant="caption"
              color={`${usageMeterColor(worstRemaining)}.main`}
              sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
            >
              {t.providerUsage.remainingPercent(worstRemaining)}
            </Typography>
          ) : loading ? (
            <CircularProgress size={12} />
          ) : null}
        </ListItemButton>
      </List>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 252, p: 1.5, borderRadius: 1.5 } } }}
      >
        <Stack spacing={1.25}>
          <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {t.providerUsage.title}
          </Typography>
          {error ? (
            <Typography variant="caption" color="text.secondary">{error}</Typography>
          ) : null}
          {loading && usage.length === 0 ? (
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ py: 0.25 }}>
              <CircularProgress size={13} />
              <Typography variant="caption" color="text.secondary">{t.providerUsage.loading}</Typography>
            </Stack>
          ) : usage.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              {t.providerUsage.noConnectedProviders}
            </Typography>
          ) : (
            <Stack spacing={1.25}>
              {usage.map((entry) => (
                <Stack key={entry.provider} spacing={0.6}>
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: 700, color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {entry.label}
                  </Typography>
                  {entry.windows.length > 0 ? (
                    entry.windows.map((window) => {
                      const resetLabel = formatResetLabel(window);
                      const remaining = typeof window.remainingPercent === 'number' ? window.remainingPercent : null;
                      return (
                        <Stack key={window.kind} spacing={0.3}>
                          <Stack direction="row" alignItems="baseline" justifyContent="space-between" spacing={1}>
                            <Typography variant="caption" color="text.secondary">{usageWindowLabel(window, t)}</Typography>
                            <Stack direction="row" spacing={0.8} alignItems="baseline">
                              <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.primary', fontWeight: 600 }}>
                                {remaining !== null ? t.providerUsage.remainingPercent(remaining) : t.providerUsage.percentUnavailable}
                              </Typography>
                              {resetLabel ? (
                                <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{resetLabel}</Typography>
                              ) : null}
                            </Stack>
                          </Stack>
                          {remaining !== null ? (
                            <LinearProgress
                              variant="determinate"
                              value={remaining}
                              color={usageMeterColor(remaining)}
                              sx={{ height: 4, borderRadius: 2 }}
                            />
                          ) : null}
                        </Stack>
                      );
                    })
                  ) : (
                    <Stack spacing={0.35}>
                      <Typography variant="caption" color="text.secondary">
                        {entry.unavailableReason === 'read_failed'
                          ? t.providerUsage.readFailed
                          : entry.unavailableReason === 'no_recent_usage'
                            ? t.providerUsage.noRecentUsage
                            : t.providerUsage.unavailable}
                      </Typography>
                      {entry.externalUrl ? (
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => void window.forger.openExternalUrl(entry.externalUrl as string)}
                          sx={{
                            alignSelf: 'flex-start',
                            minWidth: 0,
                            minHeight: 20,
                            px: 0,
                            py: 0,
                            fontSize: 12,
                            fontWeight: 600,
                            color: 'primary.main',
                            textDecoration: 'underline',
                            textUnderlineOffset: '3px',
                            '&:hover': { textDecoration: 'underline' },
                          }}
                        >
                          {t.providerUsage.openExternal}
                        </Button>
                      ) : null}
                    </Stack>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      </Popover>
    </Box>
  );
}

export function Sidebar({ currentView, onNavigate, t, desktopUpdateState, pinnedViews, showForumNav }: SidebarProps) {
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
    apps: t.nav.apps,
    catalog: t.nav.catalog,
    chat: t.nav.chat,
    agents: t.nav.agents,
    feedback: t.nav.feedback,
    friends: t.nav.community,
    automations: t.nav.automations,
    workflows: t.nav.workflows,
    workflowEditor: t.nav.workflows,
    workflowDetail: t.nav.workflows,
    files: t.nav.files,
    backups: t.nav.backups,
    devices: t.nav.devices,
    datos: t.nav.datos,
    secrets: t.nav.secrets,
    connections: t.nav.connections,
    connectionDetail: t.nav.connections,
    tools: t.nav.tools,
    docs: t.nav.docs,
    more: t.nav.more,
    settings: t.nav.settings,
    app: t.nav.catalog,
    backgroundTasks: t.backgroundTasks.title,
    backgroundTaskDetail: t.backgroundTasks.title,
  };
  const showUpdateBanner = desktopUpdateState.status === 'available' || desktopUpdateState.status === 'ready';
  const mainNav = defaultNav.filter((item) => item.id !== 'friends' || showForumNav);
  const pinnedNav = pinnableNav.filter((item) => pinnedViews.includes(item.id));

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
        <Stack spacing={2} sx={{ flex: 1, minHeight: 0 }}>
          <Stack
            direction="row"
            spacing={1.5}
            alignItems="center"
            sx={{
              WebkitAppRegion: 'drag',
              minHeight: 38,
              flexShrink: 0,
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

          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              scrollbarWidth: 'thin',
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-thumb': {
                borderRadius: 3,
                bgcolor: alpha(theme.palette.text.primary, 0.16),
              },
            }}
          >
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
            {pinnedNav.length > 0 ? (
              <>
                <Divider sx={{ mx: 1, my: 1 }} />
                <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                  {pinnedNav.map((item) => (
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
              </>
            ) : null}
          </Box>
        </Stack>

        <Stack spacing={1.25} sx={{ flexShrink: 0, pt: 1.25 }}>
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
          <SidebarUsageMenu t={t} />
          <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
            <ListItemButton
              data-onboarding-target="nav-more"
              selected={currentView === 'more'}
              onClick={() => onNavigate('more')}
              sx={{ minHeight: 38, py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 34 }}>
                <GridViewRounded />
              </ListItemIcon>
              <ListItemText primary={labels.more} />
            </ListItemButton>
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
