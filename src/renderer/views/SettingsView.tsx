import { useState } from 'react';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import {
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  TextField,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import type { CodexAuthStatus, SessionState, Settings } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';

interface SettingsViewProps {
  settings: Settings;
  session: SessionState;
  authBusy: boolean;
  codexAuthBusy: boolean;
  codexAuthStatus: CodexAuthStatus;
  t: AppDictionary;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onLogin: (email: string, password: string) => Promise<void>;
  onLogout: () => Promise<void>;
  onConnectCodexAuth: () => Promise<void>;
  onDisconnectCodexAuth: () => Promise<void>;
  onRefreshCodexAuth: () => Promise<void>;
}

export function SettingsView({
  settings,
  session,
  authBusy,
  codexAuthBusy,
  codexAuthStatus,
  t,
  themePreference,
  onThemeChange,
  onLogin,
  onLogout,
  onConnectCodexAuth,
  onDisconnectCodexAuth,
  onRefreshCodexAuth,
}: SettingsViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    await onLogin(email, password);
    setPassword('');
  };

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.settings.title}</Typography>
        <Typography color="text.secondary">{t.sections.settings.subtitle}</Typography>
      </Stack>
      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6">{t.settings.account}</Typography>
            {session.authenticated ? (
              <>
                <Typography>{t.settings.loggedInLabel}</Typography>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Chip label={settings.userEmail || session.user.email} />
                  <Chip label={`${t.settings.planLabel}: ${t.settings.planFree}`} />
                </Stack>
                <Button variant="outlined" onClick={() => void onLogout()} disabled={authBusy}>
                  {t.settings.logoutAction}
                </Button>
              </>
            ) : (
              <>
                <Typography>{t.settings.loggedOutLabel}</Typography>
                <Typography color="text.secondary">{t.settings.loginHint}</Typography>
                <TextField
                  label={t.settings.emailLabel}
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                />
                <TextField
                  label={t.settings.passwordLabel}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
                <Button
                  variant="contained"
                  onClick={() => void handleLogin()}
                  disabled={authBusy || !email.trim() || !password}
                >
                  {t.settings.loginAction}
                </Button>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Stack spacing={0.5}>
                <Typography variant="h6">{t.settings.codexTitle}</Typography>
                <Typography variant="body2" color="text.secondary">{t.settings.codexDescription}</Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Chip
                  size="small"
                  color={codexAuthStatus.installed && codexAuthStatus.authenticated ? 'success' : 'default'}
                  label={codexAuthStatus.authenticated ? t.settings.codexConnected : t.settings.codexDisconnected}
                />
                <Tooltip title={t.settings.codexRefreshAction}>
                  <IconButton size="small" disabled={codexAuthBusy} onClick={() => void onRefreshCodexAuth()}>
                    <RefreshRounded fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Stack>
            <Stack direction="row" spacing={1}>
              {!codexAuthStatus.authenticated ? (
                <Button
                  variant="contained"
                  size="small"
                  disabled={codexAuthBusy}
                  onClick={() => void onConnectCodexAuth()}
                >
                  {t.settings.codexConnectAction}
                </Button>
              ) : (
                <Button
                  variant="outlined"
                  size="small"
                  disabled={codexAuthBusy}
                  onClick={() => void onDisconnectCodexAuth()}
                >
                  {t.settings.codexDisconnectAction}
                </Button>
              )}
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6">{t.settings.appearance}</Typography>
            <Typography color="text.secondary">{t.settings.appearanceDescription}</Typography>
            <ToggleButtonGroup
              exclusive
              value={themePreference}
              onChange={(_event, nextValue: ThemePreference | null) => {
                if (nextValue) {
                  onThemeChange(nextValue);
                }
              }}
            >
              <ToggleButton value="light">{t.settings.themeLight}</ToggleButton>
              <ToggleButton value="dark">{t.settings.themeDark}</ToggleButton>
              <ToggleButton value="system">{t.settings.themeSystem}</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </CardContent>
      </Card>

    </Stack>
  );
}
