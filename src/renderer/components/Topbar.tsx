import { useState } from 'react';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import {
  alpha,
  Avatar,
  Box,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Select,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from './Sidebar';

interface TopbarProps {
  currentView: View;
  t: AppDictionary;
  isAuthenticated: boolean;
  userLabel: string;
  chatApps: AppSummary[];
  selectedChatAppId: string | null;
  dataApps: AppSummary[];
  selectedDataAppId: string | null;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSelectChatApp: (appId: string | null) => void;
  onSelectDataApp: (appId: string | null) => void;
  onNavigate: (view: View) => void;
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

export function Topbar({
  currentView,
  t,
  isAuthenticated,
  userLabel,
  chatApps,
  selectedChatAppId,
  dataApps,
  selectedDataAppId,
  getAppMeta,
  onSelectChatApp,
  onSelectDataApp,
  onNavigate,
}: TopbarProps) {
  const theme = useTheme();
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

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
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
        <Box sx={{ minWidth: 0 }}>
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

        {/* User button */}
        <IconButton
          size="small"
          onClick={(e) => setMenuAnchor(e.currentTarget)}
          sx={{ p: 0.25 }}
        >
          <Avatar sx={{ width: 28, height: 28, bgcolor: 'primary.main', fontSize: 13, fontWeight: 600 }}>
            {isAuthenticated ? userLabel.slice(0, 1).toUpperCase() : 'G'}
          </Avatar>
        </IconButton>

        {/* Dropdown menu */}
        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={() => setMenuAnchor(null)}
          transformOrigin={{ horizontal: 'right', vertical: 'top' }}
          anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
          slotProps={{
            paper: {
              sx: {
                mt: 0.75,
                minWidth: 172,
                border: `1px solid ${theme.palette.divider}`,
                boxShadow: theme.palette.mode === 'dark'
                  ? '0 8px 24px rgba(0,0,0,0.4)'
                  : '0 8px 24px rgba(0,0,0,0.08)',
              },
            },
          }}
        >
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {isAuthenticated ? userLabel : t.topbar.guestUser}
            </Typography>
          </Box>
          <Divider />
          <MenuItem
            dense
            onClick={() => { onNavigate('settings'); setMenuAnchor(null); }}
          >
            <Typography variant="body2">{t.nav.settings}</Typography>
          </MenuItem>
        </Menu>
      </Stack>
    </Box>
  );
}
