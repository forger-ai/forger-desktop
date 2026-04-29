import LaunchRounded from '@mui/icons-material/LaunchRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import ReplayRounded from '@mui/icons-material/ReplayRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import {
  Avatar,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';

interface AppCardProps {
  appName: string;
  categoryLabel: string;
  description: string;
  statusLabel: string;
  statusColor: 'success' | 'default' | 'warning' | 'error' | 'info';
  primaryActionLabel: string;
  primaryAction: 'open' | 'install' | 'update' | 'stop' | 'retry';
  onPrimaryAction: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  tertiaryActionLabel?: string;
  onTertiaryAction?: () => void;
  beta?: boolean;
  onCardClick?: () => void;
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
  primaryLoading = false,
  secondaryActionLabel,
  onSecondaryAction,
  tertiaryActionLabel,
  onTertiaryAction,
  beta = false,
  onCardClick,
}: AppCardProps) {
  const primaryIcon =
    primaryAction === 'open' ? (
      <LaunchRounded />
    ) : primaryAction === 'stop' ? (
      <StopCircleRounded />
    ) : primaryAction === 'retry' ? (
      <ReplayRounded />
    ) : primaryAction === 'update' ? (
      <SystemUpdateAltRounded />
    ) : (
      <DownloadRounded />
    );

  return (
    <Card
      onClick={onCardClick}
      sx={{
        minHeight: 244,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'visible',
        p: 2.25,
        cursor: onCardClick ? 'pointer' : 'default',
        transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease',
        '&:hover': onCardClick
          ? {
              transform: 'translateY(-3px)',
              boxShadow: 6,
            }
          : undefined,
      }}
    >
      {beta ? (
        <Box
          sx={{
            position: 'absolute',
            top: -10,
            right: 16,
            px: 1,
            py: 0.25,
            borderRadius: 999,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            color: 'text.secondary',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: 0.6,
            lineHeight: 1.4,
            textTransform: 'uppercase',
            zIndex: 1,
          }}
        >
          Beta
        </Box>
      ) : null}
      <Stack spacing={2} sx={{ height: '100%' }}>
        <Stack direction="row" justifyContent="space-between" spacing={2} alignItems="flex-start">
          <Chip label={statusLabel} color={statusColor} size="small" />
          {tertiaryActionLabel && onTertiaryAction ? (
            <Tooltip title={tertiaryActionLabel}>
              <IconButton
                size="small"
                color="error"
                aria-label={tertiaryActionLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  onTertiaryAction();
                }}
              >
                <DeleteOutlineRounded fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Box sx={{ width: 30, height: 30 }} />
          )}
        </Stack>

        <Stack direction="row" spacing={1.25} alignItems="center">
          <Avatar
            sx={{
              width: 42,
              height: 42,
              bgcolor: 'secondary.main',
              color: 'secondary.contrastText',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {initialsFromName(appName)}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ mb: 0.25 }} noWrap>
              {appName}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {categoryLabel}
            </Typography>
          </Box>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {description}
        </Typography>

        <Stack direction="row" spacing={1.25} sx={{ mt: 'auto' }}>
          <Button
            variant="contained"
            startIcon={primaryLoading ? <CircularProgress color="inherit" size={16} /> : primaryIcon}
            disabled={primaryDisabled || primaryLoading}
            aria-busy={primaryLoading}
            onClick={(event) => {
              event.stopPropagation();
              onPrimaryAction();
            }}
          >
            {primaryActionLabel}
          </Button>
          {secondaryActionLabel && onSecondaryAction ? (
            <Button
              variant="outlined"
              onClick={(event) => {
                event.stopPropagation();
                onSecondaryAction();
              }}
            >
              {secondaryActionLabel}
            </Button>
          ) : null}
        </Stack>
      </Stack>
    </Card>
  );
}
