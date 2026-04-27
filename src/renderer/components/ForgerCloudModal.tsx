import CloudQueueRounded from '@mui/icons-material/CloudQueueRounded';
import GroupsRounded from '@mui/icons-material/GroupsRounded';
import PsychologyRounded from '@mui/icons-material/PsychologyRounded';
import SupportAgentRounded from '@mui/icons-material/SupportAgentRounded';
import PhoneIphoneRounded from '@mui/icons-material/PhoneIphoneRounded';
import {
  Avatar,
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import iconDark from '@renderer/assets/icon-dark.svg';
import iconLight from '@renderer/assets/icon-light.svg';

interface ForgerCloudModalProps {
  open: boolean;
  t: AppDictionary;
  onClose: () => void;
}

export function ForgerCloudModal({ open, t, onClose }: ForgerCloudModalProps) {
  const theme = useTheme();
  const items = [
    { icon: <PhoneIphoneRounded />, text: t.cloud.benefits.everywhere },
    { icon: <GroupsRounded />, text: t.cloud.benefits.social },
    { icon: <CloudQueueRounded />, text: t.cloud.benefits.subscription },
    { icon: <PsychologyRounded />, text: t.cloud.benefits.intelligence },
    { icon: <SupportAgentRounded />, text: t.cloud.benefits.support },
  ];

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box sx={{ position: 'relative', width: 54, height: 54, flexShrink: 0 }}>
            <Avatar
              sx={{
                width: 54,
                height: 54,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Box
                component="img"
                src={theme.palette.mode === 'dark' ? iconDark : iconLight}
                alt="Forger"
                sx={{ width: 34, height: 34 }}
              />
            </Avatar>
            <Avatar
              sx={{
                position: 'absolute',
                right: -3,
                bottom: -3,
                width: 24,
                height: 24,
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                border: '2px solid',
                borderColor: 'background.paper',
              }}
            >
              <CloudQueueRounded sx={{ fontSize: 15 }} />
            </Avatar>
          </Box>
          <Stack>
            <Typography variant="h5">{t.cloud.title}</Typography>
            <Typography variant="overline" color="text.secondary">
              {t.cloud.comingSoon}
            </Typography>
          </Stack>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Typography color="text.secondary" sx={{ mb: 1.5 }}>
          {t.cloud.body}
        </Typography>
        <List>
          {items.map((item) => (
            <ListItem key={item.text} disableGutters>
              <ListItemAvatar>
                <Avatar sx={{ bgcolor: 'secondary.main', color: 'secondary.contrastText' }}>
                  {item.icon}
                </Avatar>
              </ListItemAvatar>
              <ListItemText primary={item.text} />
            </ListItem>
          ))}
        </List>
      </DialogContent>
    </Dialog>
  );
}
