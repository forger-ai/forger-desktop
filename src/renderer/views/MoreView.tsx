import PushPinOutlined from '@mui/icons-material/PushPinOutlined';
import PushPinRounded from '@mui/icons-material/PushPinRounded';
import { useState } from 'react';
import { alpha, Box, Button, Card, CardActionArea, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, Stack, Switch, Tooltip, Typography, useTheme } from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import { pinnableNav, type PinnableView, type View } from '@renderer/components/Sidebar';

interface MoreViewProps {
  t: AppDictionary;
  pinnedViews: PinnableView[];
  workflowsEnabled: boolean;
  workflowsEarlyAccessBusy: boolean;
  onTogglePin: (view: PinnableView) => void;
  onOpen: (view: View) => void;
  onUpdateWorkflowsEarlyAccess: (enabled: boolean) => void;
}

export function MoreView({ t, pinnedViews, workflowsEnabled, workflowsEarlyAccessBusy, onTogglePin, onOpen, onUpdateWorkflowsEarlyAccess }: MoreViewProps) {
  const theme = useTheme();
  const [workflowsDisableDialogOpen, setWorkflowsDisableDialogOpen] = useState(false);
  const navLabels: Record<PinnableView, string> = {
    automations: t.nav.automations,
    workflows: t.nav.workflows,
    files: t.nav.files,
    backups: t.nav.backups,
    devices: t.nav.devices,
    sidekicks: t.nav.sidekicks,
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
          const isWorkflows = item.id === 'workflows';
          const surfaceEnabled = !isWorkflows || workflowsEnabled;
          return (
            <Card
              key={item.id}
              variant="outlined"
              sx={{
                position: 'relative',
                borderColor: pinned && surfaceEnabled ? alpha(theme.palette.primary.main, 0.5) : undefined,
              }}
            >
              <CardActionArea disabled={!surfaceEnabled} onClick={() => onOpen(item.id)} sx={{ p: 2, height: isWorkflows ? 'auto' : '100%' }}>
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
                  {pinned && surfaceEnabled ? (
                    <Chip size="small" color="primary" variant="outlined" label={t.more.pinnedBadge} sx={{ alignSelf: 'flex-start' }} />
                  ) : null}
                </Stack>
              </CardActionArea>
              {isWorkflows ? (
                <Stack spacing={1} sx={{ px: 2, pb: 2 }}>
                  <Chip size="small" color="primary" variant="outlined" label={t.beta.earlyAccessBadge} sx={{ alignSelf: 'flex-start' }} />
                  <FormControlLabel
                    aria-busy={workflowsEarlyAccessBusy}
                    control={(
                      <Switch
                        checked={workflowsEnabled}
                        disabled={workflowsEarlyAccessBusy}
                        onChange={() => {
                          if (workflowsEnabled) {
                            setWorkflowsDisableDialogOpen(true);
                          } else {
                            onUpdateWorkflowsEarlyAccess(true);
                          }
                        }}
                      />
                    )}
                    label={workflowsEnabled ? t.more.workflowsEnabled : t.more.workflowsDisabled}
                  />
                  {workflowsEarlyAccessBusy ? (
                    <Stack direction="row" spacing={1} alignItems="center" role="status">
                      <CircularProgress size={18} />
                      <Typography variant="caption" color="text.secondary">
                        {workflowsEnabled ? t.more.workflowsDisabling : t.more.workflowsEnabling}
                      </Typography>
                    </Stack>
                  ) : null}
                </Stack>
              ) : null}
              {surfaceEnabled ? (
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
              ) : null}
            </Card>
          );
        })}
      </Box>
      <Dialog open={workflowsDisableDialogOpen} onClose={() => setWorkflowsDisableDialogOpen(false)}>
        <DialogTitle>{t.more.workflowsDisableTitle}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">{t.more.workflowsDisableBody}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWorkflowsDisableDialogOpen(false)}>{t.more.workflowsDisableCancel}</Button>
          <Button
            color="warning"
            onClick={() => {
              setWorkflowsDisableDialogOpen(false);
              onUpdateWorkflowsEarlyAccess(false);
            }}
          >
            {t.more.workflowsDisableConfirm}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
