import AppsRounded from '@mui/icons-material/AppsRounded';
import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import CategoryRounded from '@mui/icons-material/CategoryRounded';
import InsertDriveFileRounded from '@mui/icons-material/InsertDriveFileRounded';
import TableChartRounded from '@mui/icons-material/TableChartRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import {
  alpha,
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

export type View = 'my-apps' | 'catalog' | 'chat' | 'files' | 'datos' | 'settings' | 'app';

interface SidebarProps {
  currentView: View;
  onNavigate: (view: View) => void;
  t: AppDictionary;
}

const mainNav = [
  { id: 'my-apps' as const, icon: <AppsRounded /> },
  { id: 'catalog' as const, icon: <CategoryRounded /> },
  { id: 'chat' as const, icon: <AutoAwesomeRounded /> },
  { id: 'files' as const, icon: <InsertDriveFileRounded /> },
  { id: 'datos' as const, icon: <TableChartRounded /> },
];

export function Sidebar({ currentView, onNavigate, t }: SidebarProps) {
  const theme = useTheme();

  const labels: Record<View, string> = {
    'my-apps': t.nav.myApps,
    catalog: t.nav.catalog,
    chat: t.nav.chat,
    files: t.nav.files,
    datos: t.nav.datos,
    settings: t.nav.settings,
    app: t.nav.catalog,
  };

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
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ WebkitAppRegion: 'drag' }}>
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
