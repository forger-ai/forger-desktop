import CloseRounded from '@mui/icons-material/CloseRounded';
import CropSquareRounded from '@mui/icons-material/CropSquareRounded';
import FilterNoneRounded from '@mui/icons-material/FilterNoneRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import MinimizeRounded from '@mui/icons-material/MinimizeRounded';
import PersonRounded from '@mui/icons-material/PersonRounded';
import {
  alpha,
  Avatar,
  Box,
  IconButton,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { AppSummary, WindowControlState } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from './Sidebar';

interface TopbarProps {
  currentView: View;
  t: AppDictionary;
  chatApps: AppSummary[];
  selectedChatAppId: string | null;
  dataApps: AppSummary[];
  selectedDataAppId: string | null;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSelectChatApp: (appId: string | null) => void;
  onSelectDataApp: (appId: string | null) => void;
  onOpenCloudModal: () => void;
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
  chatApps,
  selectedChatAppId,
  dataApps,
  selectedDataAppId,
  getAppMeta,
  onSelectChatApp,
  onSelectDataApp,
  onOpenCloudModal,
}: TopbarProps) {
  const theme = useTheme();

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
                {t.sections.chat.activeAppLabel}
              </Typography>
              <AppSelect
                apps={chatApps}
                selectedAppId={selectedChatAppId}
                inactiveLabel={t.sections.chat.inactiveApp}
                onSelect={onSelectChatApp}
                getAppMeta={getAppMeta}
              />
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
          <IconButton
            size="small"
            onClick={onOpenCloudModal}
            sx={{ p: 0.25 }}
            aria-label={t.cloud.openLabel}
          >
            <Avatar sx={{ width: 28, height: 28, bgcolor: 'primary.main', fontSize: 13, fontWeight: 600 }}>
              <PersonRounded fontSize="small" />
            </Avatar>
          </IconButton>
          <WindowControls t={t} />
        </Stack>
      </Stack>
    </Box>
  );
}
