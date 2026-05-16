import type { ReactNode } from 'react';
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { TourStep } from './useForgerTour';

interface TourOverlayProps {
  step: TourStep | null;
  highlightRect: DOMRect | null;
  modalWidth: number;
  primaryLabel: string;
  primaryVariant: 'contained' | 'outlined';
  primaryColor: 'primary' | 'inherit';
  t: AppDictionary;
  extraContent?: ReactNode;
  onSkip: () => void;
  onContinue: () => void;
}

export function TourOverlay({
  step,
  highlightRect,
  modalWidth,
  primaryLabel,
  primaryVariant,
  primaryColor,
  t,
  extraContent,
  onSkip,
  onContinue,
}: TourOverlayProps) {
  if (!step) {
    return null;
  }

  const position = highlightRect
    ? {
        top: Math.min(window.innerHeight - 220, Math.max(24, highlightRect.bottom + 16)),
        left: Math.min(
          window.innerWidth - modalWidth - 24,
          Math.max(24, highlightRect.left + Math.min(80, highlightRect.width / 2)),
        ),
      }
    : {
        top: Math.max(72, window.innerHeight * 0.28),
        left: Math.max(24, window.innerWidth / 2 - modalWidth / 2),
      };

  return (
    <Box sx={{ position: 'fixed', inset: 0, zIndex: 1500, pointerEvents: 'auto' }}>
      <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'rgba(12, 18, 28, 0.32)' }} />
      {highlightRect ? (
        <Box
          sx={{
            position: 'absolute',
            top: highlightRect.top - 6,
            left: highlightRect.left - 6,
            width: highlightRect.width + 12,
            height: highlightRect.height + 12,
            border: '2px solid',
            borderColor: 'primary.main',
            borderRadius: 2,
            boxShadow: '0 0 0 9999px rgba(12, 18, 28, 0.18), 0 12px 28px rgba(0, 0, 0, 0.25)',
            pointerEvents: 'none',
          }}
        />
      ) : null}
      <Paper
        elevation={10}
        sx={{
          position: 'absolute',
          top: position.top,
          left: position.left,
          width: modalWidth,
          maxWidth: 'calc(100vw - 48px)',
          p: 2,
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Stack spacing={1.5}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{step.title}</Typography>
            <Typography variant="body2" color="text.secondary">{step.body}</Typography>
          </Stack>
          {extraContent}
          <Stack direction="row" justifyContent="space-between" spacing={1}>
            <Button onClick={onSkip}>{t.onboarding.skip}</Button>
            <Button variant={primaryVariant} color={primaryColor} onClick={onContinue}>
              {primaryLabel}
            </Button>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
