import LaunchRounded from '@mui/icons-material/LaunchRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import ReplayRounded from '@mui/icons-material/ReplayRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import SystemUpdateAltRounded from '@mui/icons-material/SystemUpdateAltRounded';
import StarRounded from '@mui/icons-material/StarRounded';
import ArrowDropDownRounded from '@mui/icons-material/ArrowDropDownRounded';
import {
  Avatar,
  Box,
  Button,
  ButtonGroup,
  Card,
  CircularProgress,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import type { InstallAppResult } from '@shared/types';

interface AppCardProps {
  appName: string;
  iconUrl?: string;
  categoryLabel: string;
  createdByLabel?: string;
  description: string;
  statusIndicatorLabel?: string;
  primaryActionLabel: string;
  primaryAction: 'open' | 'install' | 'update' | 'stop' | 'retry';
  onPrimaryAction: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryMenuActions?: Array<{ label: string; onClick: () => void }>;
  installProgress?: Pick<InstallAppResult, 'phase' | 'progress' | 'userMessage'>;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  tertiaryActionLabel?: string;
  onTertiaryAction?: () => void;
  beta?: boolean;
  betaLabel?: string;
  averageRating?: number;
  ratingsCount?: number;
  onCardClick?: () => void;
  onboardingTarget?: string;
}

const initialsFromName = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

export function AppCard({
  appName,
  iconUrl,
  categoryLabel,
  createdByLabel,
  description,
  statusIndicatorLabel,
  primaryActionLabel,
  primaryAction,
  onPrimaryAction,
  primaryDisabled = false,
  primaryLoading = false,
  primaryMenuActions = [],
  installProgress,
  secondaryActionLabel,
  onSecondaryAction,
  tertiaryActionLabel,
  onTertiaryAction,
  beta = false,
  betaLabel = 'Experimental release',
  averageRating,
  ratingsCount = 0,
  onCardClick,
  onboardingTarget,
}: AppCardProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const installing = Boolean(installProgress);
  const primaryMenuEnabled = primaryMenuActions.length > 0 && !primaryDisabled && !primaryLoading && !installing;
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
      data-onboarding-target={onboardingTarget}
      onClick={onCardClick}
      role={onCardClick ? 'button' : undefined}
      tabIndex={onCardClick ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onCardClick || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }

        event.preventDefault();
        onCardClick();
      }}
      sx={{
        minHeight: 244,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'visible',
        p: 2.25,
        border: '1px solid',
        borderColor: 'divider',
        cursor: onCardClick ? 'pointer' : 'default',
        transition: 'transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, background-color 160ms ease',
        '&:hover': onCardClick
          ? {
              transform: 'translateY(-3px)',
              borderColor: 'primary.main',
              bgcolor: 'action.hover',
              boxShadow: 6,
            }
          : undefined,
        '&:focus-visible': onCardClick
          ? {
              outline: '2px solid',
              outlineColor: 'primary.main',
              outlineOffset: 3,
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
          {betaLabel}
        </Box>
      ) : null}
      {statusIndicatorLabel ? (
        <Tooltip title={statusIndicatorLabel}>
          <Box
            aria-label={statusIndicatorLabel}
            sx={{
              position: 'absolute',
              top: 14,
              right: 14,
              width: 12,
              height: 12,
              borderRadius: '50%',
              bgcolor: 'success.main',
              border: '2px solid',
              borderColor: 'background.paper',
              boxShadow: 1,
              zIndex: 2,
              '&::after': {
                content: '""',
                position: 'absolute',
                inset: -5,
                borderRadius: '50%',
                bgcolor: 'success.main',
                opacity: 0.32,
                animation: 'forger-status-pulse 1.6s ease-out infinite',
              },
              '@keyframes forger-status-pulse': {
                '0%': {
                  transform: 'scale(0.72)',
                  opacity: 0.42,
                },
                '70%': {
                  transform: 'scale(1.75)',
                  opacity: 0,
                },
                '100%': {
                  transform: 'scale(1.75)',
                  opacity: 0,
                },
              },
            }}
          />
        </Tooltip>
      ) : null}
      <Stack spacing={2} sx={{ height: '100%' }}>
        {installing ? (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ minHeight: 24 }}>
            <CircularProgress size={14} color="inherit" />
          </Stack>
        ) : (
          <Box sx={{ height: 24 }} />
        )}

        <Stack direction="row" spacing={1.25} alignItems="center">
          <Avatar
            src={iconUrl}
            alt={appName}
            variant="rounded"
            sx={{
              width: 42,
              height: 42,
              bgcolor: iconUrl ? 'transparent' : 'secondary.main',
              color: 'secondary.contrastText',
              fontWeight: 700,
              flexShrink: 0,
              '& .MuiAvatar-img': {
                objectFit: 'cover',
              },
            }}
          >
            {iconUrl ? null : initialsFromName(appName)}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ mb: 0.25 }} noWrap>
              {appName}
            </Typography>
            <Stack spacing={0.25}>
              <Typography variant="caption" color="text.secondary">
                {categoryLabel}
              </Typography>
              {createdByLabel ? (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {createdByLabel}
                </Typography>
              ) : null}
            </Stack>
          </Box>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {description}
        </Typography>

        {averageRating ? (
          <Stack direction="row" spacing={0.5} alignItems="center">
            <StarRounded color="warning" fontSize="small" />
            <Typography variant="body2" fontWeight={700}>
              {averageRating.toFixed(1)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              ({ratingsCount.toLocaleString()})
            </Typography>
          </Stack>
        ) : null}

        {installing ? (
          <Stack spacing={0.75}>
            <LinearProgress
              variant={typeof installProgress?.progress === 'number' ? 'determinate' : 'indeterminate'}
              value={Math.min(Math.max(installProgress?.progress ?? 0, 0), 100)}
              sx={{ height: 6, borderRadius: 999 }}
            />
            <Typography variant="caption" color="text.secondary">
              {installProgress?.userMessage}
            </Typography>
          </Stack>
        ) : null}

        <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mt: 'auto' }}>
          {primaryMenuActions.length > 0 ? (
            <>
              <ButtonGroup variant="contained" disabled={primaryDisabled || primaryLoading || installing} aria-busy={primaryLoading || installing}>
                <Button
                  startIcon={primaryLoading || installing ? <CircularProgress color="inherit" size={16} /> : primaryIcon}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPrimaryAction();
                  }}
                >
                  {primaryActionLabel}
                </Button>
                <Button
                  size="small"
                  aria-label={`${primaryActionLabel} menu`}
                  aria-haspopup="menu"
                  aria-expanded={Boolean(menuAnchor)}
                  disabled={!primaryMenuEnabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuAnchor(event.currentTarget);
                  }}
                >
                  <ArrowDropDownRounded />
                </Button>
              </ButtonGroup>
              <Menu
                anchorEl={menuAnchor}
                open={Boolean(menuAnchor)}
                onClose={() => setMenuAnchor(null)}
                onClick={(event) => event.stopPropagation()}
              >
                {primaryMenuActions.map((action) => (
                  <MenuItem
                    key={action.label}
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuAnchor(null);
                      action.onClick();
                    }}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              </Menu>
            </>
          ) : (
            <Button
              variant="contained"
              startIcon={primaryLoading || installing ? <CircularProgress color="inherit" size={16} /> : primaryIcon}
              disabled={primaryDisabled || primaryLoading || installing}
              aria-busy={primaryLoading || installing}
              onClick={(event) => {
                event.stopPropagation();
                onPrimaryAction();
              }}
            >
              {primaryActionLabel}
            </Button>
          )}
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
          {tertiaryActionLabel && onTertiaryAction ? (
            <Tooltip title={tertiaryActionLabel}>
              <IconButton
                size="small"
                color="error"
                aria-label={tertiaryActionLabel}
                sx={{ ml: 'auto' }}
                onClick={(event) => {
                  event.stopPropagation();
                  onTertiaryAction();
                }}
              >
                <DeleteOutlineRounded fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>
      </Stack>
    </Card>
  );
}
