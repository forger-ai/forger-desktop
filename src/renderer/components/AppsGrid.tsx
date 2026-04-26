import { Box } from '@mui/material';
import type { ReactNode } from 'react';

interface AppsGridProps {
  children: ReactNode;
}

export function AppsGrid({ children }: AppsGridProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: {
          xs: '1fr',
          sm: 'repeat(2, minmax(0, 1fr))',
          lg: 'repeat(4, minmax(0, 1fr))',
        },
        alignItems: 'stretch',
      }}
    >
      {children}
    </Box>
  );
}
