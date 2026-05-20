import type { RefObject } from 'react';
import ForumRounded from '@mui/icons-material/ForumRounded';
import GroupsRounded from '@mui/icons-material/GroupsRounded';
import { Badge, Fab, IconButton, Tooltip, alpha, useTheme } from '@mui/material';

interface SocialLauncherButtonProps {
  badgeCount: number;
  open: boolean;
  panelId: string;
  topbar: boolean;
  launcherRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}

export function SocialLauncherButton({ badgeCount, open, panelId, topbar, launcherRef, onToggle }: SocialLauncherButtonProps) {
  const theme = useTheme();

  if (topbar) {
    return (
      <Tooltip title="Social">
        <Badge
          color="error"
          badgeContent={badgeCount}
          overlap="circular"
          invisible={badgeCount === 0}
          sx={{
            '& .MuiBadge-badge': {
              minWidth: 18,
              height: 18,
              borderRadius: 1,
              fontWeight: 700,
              boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
            },
          }}
        >
          <IconButton
            ref={launcherRef}
            size="small"
            aria-label="Social"
            aria-describedby={open ? panelId : undefined}
            aria-expanded={open}
            onClick={onToggle}
            sx={{
              width: 32,
              height: 32,
              borderRadius: 1,
              color: open ? 'primary.main' : 'text.secondary',
              bgcolor: open ? alpha(theme.palette.primary.main, 0.12) : 'transparent',
              '&:hover': {
                bgcolor: alpha(theme.palette.primary.main, 0.12),
                color: 'primary.main',
              },
            }}
          >
            <GroupsRounded sx={{ fontSize: 19 }} />
          </IconButton>
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip title="Social" placement="left">
      <Badge
        color="error"
        badgeContent={badgeCount}
        overlap="rectangular"
        invisible={badgeCount === 0}
        sx={{
          '& .MuiBadge-badge': {
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            fontWeight: 700,
            boxShadow: `0 0 0 2px ${theme.palette.background.default}`,
          },
        }}
      >
        <Fab
          ref={launcherRef}
          aria-label="Social"
          aria-describedby={open ? panelId : undefined}
          aria-expanded={open}
          onClick={onToggle}
          sx={{
            width: 64,
            height: 64,
            minHeight: 64,
            borderRadius: 1,
            boxShadow: open ? theme.shadows[10] : theme.shadows[6],
            bgcolor: open ? theme.palette.primary.main : alpha(theme.palette.background.paper, 0.96),
            color: open ? theme.palette.primary.contrastText : theme.palette.text.primary,
            border: `1px solid ${open ? alpha(theme.palette.primary.main, 0.9) : alpha(theme.palette.divider, 0.9)}`,
            backdropFilter: 'blur(18px)',
            transition: theme.transitions.create(['background-color', 'box-shadow', 'transform'], {
              duration: theme.transitions.duration.shorter,
            }),
            '&:hover': {
              bgcolor: open ? theme.palette.primary.dark : alpha(theme.palette.background.paper, 1),
              transform: 'translateY(-1px)',
            },
          }}
        >
          <ForumRounded />
        </Fab>
      </Badge>
    </Tooltip>
  );
}
