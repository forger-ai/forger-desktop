import {
  Button,
  Card,
  CardContent,
  Chip,
  Avatar,
  LinearProgress,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import LaunchRounded from '@mui/icons-material/LaunchRounded';
import RestartAltRounded from '@mui/icons-material/RestartAltRounded';
import type { CodexAuthStatus, DesktopUpdateState } from '@shared/types';
import type { AppDictionary, Locale } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';
import type { ChatBotPicture, LanguagePreference } from '@renderer/preferences';

interface SettingsViewProps {
  codexAuthBusy: boolean;
  codexAuthStatus: CodexAuthStatus;
  t: AppDictionary;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  languagePreference: LanguagePreference;
  activeLocale: Locale;
  systemLocale: Locale;
  onLanguageChange: (language: LanguagePreference) => void;
  chatBotPicture: ChatBotPicture;
  chatBotPictureOptions: Array<{ value: ChatBotPicture; label: string; src: string }>;
  onChatBotPictureChange: (picture: ChatBotPicture) => void;
  onOpenCodexConfig: () => void;
  onReinstallCodex: () => void;
  desktopUpdateState: DesktopUpdateState;
  desktopUpdateBusy: boolean;
  onCheckDesktopUpdates: () => void;
  onDownloadDesktopUpdate: () => void;
  onInstallDesktopUpdate: () => void;
}

export function SettingsView({
  codexAuthBusy,
  codexAuthStatus,
  t,
  themePreference,
  onThemeChange,
  languagePreference,
  activeLocale,
  systemLocale,
  onLanguageChange,
  chatBotPicture,
  chatBotPictureOptions,
  onChatBotPictureChange,
  onOpenCodexConfig,
  onReinstallCodex,
  desktopUpdateState,
  desktopUpdateBusy,
  onCheckDesktopUpdates,
  onDownloadDesktopUpdate,
  onInstallDesktopUpdate,
}: SettingsViewProps) {
  const canDownload = desktopUpdateState.status === 'available' && Boolean(desktopUpdateState.asset);
  const canInstall = desktopUpdateState.status === 'ready' && Boolean(desktopUpdateState.downloadedPath);
  const progressPercent =
    typeof desktopUpdateState.progress === 'number'
      ? Math.round(desktopUpdateState.progress * 100)
      : undefined;
  const statusLabel = t.settings.desktopUpdateStatuses[desktopUpdateState.status];

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.sections.settings.title}</Typography>
        <Typography color="text.secondary">{t.sections.settings.subtitle}</Typography>
      </Stack>
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
              </Stack>
            </Stack>
            <Stack direction="row" spacing={1}>
              <Button
                variant={codexAuthStatus.authenticated ? 'outlined' : 'contained'}
                size="small"
                disabled={codexAuthBusy}
                onClick={onOpenCodexConfig}
              >
                {codexAuthStatus.authenticated ? t.settings.codexConfiguredAction : t.settings.codexConnectAction}
              </Button>
              <Button
                variant="outlined"
                color="warning"
                size="small"
                startIcon={<RestartAltRounded />}
                disabled={codexAuthBusy}
                onClick={onReinstallCodex}
              >
                {t.settings.codexReinstallAction}
              </Button>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t.settings.codexReinstallHint}
            </Typography>
            <Stack spacing={0.35} sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              <Typography variant="caption" color="text.secondary">
                {t.settings.codexCliPathLabel}: {codexAuthStatus.codexCliPath ?? '-'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t.settings.codexHomeLabel}: {codexAuthStatus.codexHome || '-'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t.settings.codexAuthFileLabel}: {codexAuthStatus.authFilePath || '-'}
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
              <Stack spacing={0.5}>
                <Typography variant="h6">{t.settings.desktopUpdatesTitle}</Typography>
                <Typography variant="body2" color="text.secondary">{t.settings.desktopUpdatesDescription}</Typography>
              </Stack>
              <Chip
                size="small"
                color={
                  desktopUpdateState.status === 'available' || desktopUpdateState.status === 'ready'
                    ? 'warning'
                    : desktopUpdateState.status === 'error' || desktopUpdateState.status === 'unsupported'
                      ? 'error'
                      : desktopUpdateState.status === 'up_to_date'
                        ? 'success'
                        : 'default'
                }
                label={statusLabel}
              />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Typography variant="body2">
                {t.settings.desktopCurrentVersion}: <strong>{desktopUpdateState.currentVersion}</strong>
              </Typography>
              <Typography variant="body2">
                {t.settings.desktopAvailableVersion}: <strong>{desktopUpdateState.availableVersion ?? '-'}</strong>
              </Typography>
            </Stack>
            {desktopUpdateState.releaseNotes ? (
              <Stack spacing={0.75}>
                <Typography variant="subtitle2">
                  {desktopUpdateState.releaseNotes.summary ?? t.settings.desktopReleaseNotes}
                </Typography>
                {desktopUpdateState.releaseNotes.changes.length > 0 ? (
                  <Stack component="ul" sx={{ m: 0, pl: 2 }}>
                    {desktopUpdateState.releaseNotes.changes.map((change) => (
                      <Typography component="li" variant="body2" color="text.secondary" key={change}>
                        {change}
                      </Typography>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">{t.appView.updateNoChangelog}</Typography>
                )}
              </Stack>
            ) : null}
            {desktopUpdateState.status === 'downloading' ? (
              <Stack spacing={0.5}>
                <LinearProgress variant={progressPercent === undefined ? 'indeterminate' : 'determinate'} value={progressPercent} />
                <Typography variant="caption" color="text.secondary">
                  {progressPercent === undefined ? t.settings.desktopDownloading : t.settings.desktopDownloadProgress(progressPercent)}
                </Typography>
              </Stack>
            ) : null}
            {desktopUpdateState.userMessage ? (
              <Typography
                variant="body2"
                color={desktopUpdateState.status === 'error' || desktopUpdateState.status === 'unsupported' ? 'error.main' : 'text.secondary'}
              >
                {desktopUpdateState.userMessage}
              </Typography>
            ) : null}
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              <Button
                variant="outlined"
                size="small"
                startIcon={<SystemUpdateAltRounded />}
                disabled={desktopUpdateBusy}
                onClick={onCheckDesktopUpdates}
              >
                {t.settings.desktopCheckUpdates}
              </Button>
              <Button
                variant="contained"
                size="small"
                startIcon={<DownloadRounded />}
                disabled={desktopUpdateBusy || !canDownload}
                onClick={onDownloadDesktopUpdate}
              >
                {t.settings.desktopDownloadUpdate}
              </Button>
              <Button
                variant="contained"
                color="warning"
                size="small"
                startIcon={<LaunchRounded />}
                disabled={desktopUpdateBusy || !canInstall}
                onClick={onInstallDesktopUpdate}
              >
                {t.settings.desktopInstallUpdate}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6">{t.settings.appearance}</Typography>
            <Typography color="text.secondary">{t.settings.appearanceDescription}</Typography>
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.settings.language}</Typography>
              <ToggleButtonGroup
                exclusive
                value={languagePreference}
                onChange={(_event, nextValue: LanguagePreference | null) => {
                  if (nextValue) {
                    onLanguageChange(nextValue);
                  }
                }}
              >
                <ToggleButton value="system">{t.settings.languageSystem(t.settings.languageNames[systemLocale])}</ToggleButton>
                <ToggleButton value="es">{t.settings.languageNames.es}</ToggleButton>
                <ToggleButton value="en">{t.settings.languageNames.en}</ToggleButton>
              </ToggleButtonGroup>
              <Typography variant="caption" color="text.secondary">
                {t.settings.activeLanguage(t.settings.languageNames[activeLocale])}
              </Typography>
            </Stack>
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
            <Stack spacing={1}>
              <Typography variant="subtitle2">{t.settings.chatBotPicture}</Typography>
              <ToggleButtonGroup
                exclusive
                value={chatBotPicture}
                onChange={(_event, nextValue: ChatBotPicture | null) => {
                  if (nextValue) {
                    onChatBotPictureChange(nextValue);
                  }
                }}
              >
                {chatBotPictureOptions.map((option) => (
                  <ToggleButton key={option.value} value={option.value} sx={{ gap: 1, px: 1.25 }}>
                    <Avatar
                      src={option.src}
                      alt={option.label}
                      sx={{
                        width: 30,
                        height: 30,
                        bgcolor: '#fff',
                        p: 0.05,
                        pb: 0,
                        border: '1px solid',
                        borderColor: 'divider',
                        '& img': { objectFit: 'contain' },
                      }}
                    />
                    {option.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

    </Stack>
  );
}
