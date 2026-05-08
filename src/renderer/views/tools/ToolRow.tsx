import type { ReactNode } from 'react';
import { Paper, Stack, Typography } from '@mui/material';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';

export const ToolRow = ({
  icon,
  title,
  description,
  meta,
  pill,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  meta: string;
  pill: ReactNode;
  onClick: () => void;
}) => (
  <Paper
    variant="outlined"
    onClick={onClick}
    sx={{
      p: 2,
      borderRadius: 1,
      cursor: 'pointer',
      '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
    }}
  >
    <Stack direction="row" spacing={2} alignItems="center">
      {icon}
      <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
          {pill}
        </Stack>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
        <Typography variant="caption" color="text.secondary">{meta}</Typography>
      </Stack>
      <ChevronRightRounded color="action" />
    </Stack>
  </Paper>
);
