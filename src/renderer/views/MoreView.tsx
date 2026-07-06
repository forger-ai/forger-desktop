import PushPinOutlined from '@mui/icons-material/PushPinOutlined';
import PushPinRounded from '@mui/icons-material/PushPinRounded';
import { alpha, Box, Card, CardActionArea, Chip, IconButton, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import { pinnableNav, type PinnableView, type View } from '@renderer/components/Sidebar';

interface MoreViewProps {
  t: AppDictionary;
  pinnedViews: PinnableView[];
  onTogglePin: (view: PinnableView) => void;
  onOpen: (view: View) => void;
}

export function MoreView({ t, pinnedViews, onTogglePin, onOpen }: MoreViewProps) {
  const theme = useTheme();
  const navLabels: Record<PinnableView, string> = {
    automations: t.nav.automations,
    workflows: t.nav.workflows,
    files: t.nav.files,
    backups: t.nav.backups,
    devices: t.nav.devices,
    datos: t.nav.datos,
    secrets: t.nav.secrets,
    connections: t.nav.connections,
    tools: t.nav.tools,
    docs: t.nav.docs,
  };
  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.more.title}</Typography>
        <Typography color="text.secondary">{t.more.subtitle}</Typography>
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        }}
      >
        {pinnableNav.map((item) => {
          const pinned = pinnedViews.includes(item.id);
          return (
            <Card
              key={item.id}
              variant="outlined"
              sx={{
                position: 'relative',
                borderColor: pinned ? alpha(theme.palette.primary.main, 0.5) : undefined,
              }}
            >
              <CardActionArea onClick={() => onOpen(item.id)} sx={{ p: 2, height: '100%' }}>
                <Stack spacing={1} sx={{ pr: 4 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    {item.icon}
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                      {navLabels[item.id]}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {t.settings.advancedSurfaces[item.id]}
                  </Typography>
                  {pinned ? (
                    <Chip size="small" color="primary" variant="outlined" label={t.more.pinnedBadge} sx={{ alignSelf: 'flex-start' }} />
                  ) : null}
                </Stack>
              </CardActionArea>
              <Tooltip title={pinned ? t.more.unpin : t.more.pin}>
                <IconButton
                  size="small"
                  aria-label={pinned ? t.more.unpin : t.more.pin}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePin(item.id);
                  }}
                  sx={{ position: 'absolute', top: 8, right: 8 }}
                >
                  {pinned ? <PushPinRounded fontSize="small" color="primary" /> : <PushPinOutlined fontSize="small" />}
                </IconButton>
              </Tooltip>
            </Card>
          );
        })}
      </Box>
    </Stack>
  );
}
