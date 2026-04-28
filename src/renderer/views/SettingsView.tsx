import {
  Button,
  Card,
  CardContent,
  Chip,
  Avatar,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import type { CodexAuthStatus } from '@shared/types';
import type { AppDictionary, Locale } from '@renderer/i18n';
import type { ThemePreference } from '@renderer/theme/appTheme';
import type { ChatBotPicture, LanguagePreference } from '@renderer/App';

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
}: SettingsViewProps) {
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
            </Stack>
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
