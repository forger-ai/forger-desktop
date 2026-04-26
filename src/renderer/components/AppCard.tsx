import LaunchRounded from '@mui/icons-material/LaunchRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import TuneRounded from '@mui/icons-material/TuneRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import ReplayRounded from '@mui/icons-material/ReplayRounded';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  Stack,
  Typography,
} from '@mui/material';

interface AppCardProps {
  appName: string;
  categoryLabel: string;
  description: string;
  statusLabel: string;
  statusColor: 'success' | 'default' | 'warning' | 'error' | 'info';
  primaryActionLabel: string;
  primaryAction: 'open' | 'install' | 'stop' | 'retry';
  onPrimaryAction: () => void;
  primaryDisabled?: boolean;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export function AppCard({
  appName,
  categoryLabel,
  description,
  statusLabel,
  statusColor,
  primaryActionLabel,
  primaryAction,
  onPrimaryAction,
  primaryDisabled = false,
  secondaryActionLabel,
  onSecondaryAction,
}: AppCardProps) {
  const primaryIcon =
    primaryAction === 'open' ? (
      <LaunchRounded />
    ) : primaryAction === 'stop' ? (
      <StopCircleRounded />
    ) : primaryAction === 'retry' ? (
      <ReplayRounded />
    ) : (
      <DownloadRounded />
    );

  return (
    <Card
      sx={{
        minHeight: 244,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        p: 2.25,
      }}
    >
      <Stack spacing={2} sx={{ height: '100%' }}>
        <Stack direction="row" justifyContent="space-between" spacing={2} alignItems="flex-start">
          <Avatar
            sx={{
              width: 42,
              height: 42,
              bgcolor: 'secondary.main',
              color: 'secondary.contrastText',
              fontWeight: 700,
            }}
          >
            {initialsFromName(appName)}
          </Avatar>
          <Chip label={statusLabel} color={statusColor} size="small" />
        </Stack>

        <Box>
          <Typography variant="subtitle1" sx={{ mb: 0.5 }}>
            {appName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {categoryLabel}
          </Typography>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {description}
        </Typography>

        <Stack direction="row" spacing={1.25} sx={{ mt: 'auto' }}>
          <Button
            variant="contained"
            startIcon={primaryIcon}
            disabled={primaryDisabled}
            onClick={onPrimaryAction}
          >
            {primaryActionLabel}
          </Button>
          {secondaryActionLabel && onSecondaryAction ? (
            <Button
              variant="outlined"
              startIcon={<TuneRounded />}
              onClick={onSecondaryAction}
            >
              {secondaryActionLabel}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Card>
  );
}
