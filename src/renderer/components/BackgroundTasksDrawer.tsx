import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ErrorRounded from '@mui/icons-material/ErrorRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded';
import PendingActionsRounded from '@mui/icons-material/PendingActionsRounded';
import {
  Badge,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { BackgroundTask } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface BackgroundTasksDrawerProps {
  t: AppDictionary;
  tasks: BackgroundTask[];
  open: boolean;
  activeCount: number;
  onOpen: () => void;
  onClose: () => void;
  onOpenHistory: () => void;
  onOpenTask: (taskId: string) => void;
}

const terminalStatuses = new Set(['succeeded', 'failed', 'canceled', 'skipped']);

export const isActiveBackgroundTask = (task: BackgroundTask): boolean =>
  task.status === 'queued' || task.status === 'running';

const taskStatusColor = (task: BackgroundTask): 'default' | 'success' | 'error' | 'warning' | 'info' => {
  if (task.status === 'succeeded') return 'success';
  if (task.status === 'failed') return 'error';
  if (task.status === 'skipped' || task.status === 'canceled') return 'warning';
  if (task.status === 'running') return 'info';
  return 'default';
};

const taskIcon = (task: BackgroundTask) => {
  if (task.status === 'succeeded') return <CheckCircleRounded color="success" fontSize="small" />;
  if (task.status === 'failed') return <ErrorRounded color="error" fontSize="small" />;
  return <HourglassTopRounded color={terminalStatuses.has(task.status) ? 'warning' : 'info'} fontSize="small" />;
};

const formatDateTime = (value?: string): string => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

export function BackgroundTasksDrawer({
  t,
  tasks,
  open,
  activeCount,
  onOpen,
  onClose,
  onOpenHistory,
  onOpenTask,
}: BackgroundTasksDrawerProps) {
  const drawerTasks = [...tasks]
    .sort((a, b) => Number(isActiveBackgroundTask(b)) - Number(isActiveBackgroundTask(a)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 8);

  return (
    <>
      <Tooltip title={t.backgroundTasks.open}>
        <IconButton
          size="small"
          onClick={onOpen}
          aria-label={t.backgroundTasks.open}
          sx={{ width: 34, height: 34 }}
        >
          <Badge badgeContent={activeCount} color="primary" invisible={activeCount === 0}>
            <PendingActionsRounded fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>
      <Drawer anchor="right" open={open} onClose={onClose}>
        <Box sx={{ width: 380, maxWidth: '100vw', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <Stack spacing={0.5} sx={{ px: 2, py: 2 }}>
            <Typography variant="h6">{t.backgroundTasks.title}</Typography>
            <Typography variant="body2" color="text.secondary">
              {activeCount > 0 ? t.backgroundTasks.activeSummary(activeCount) : t.backgroundTasks.noActive}
            </Typography>
          </Stack>
          <Divider />
          <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {drawerTasks.length === 0 ? (
              <Typography color="text.secondary" sx={{ px: 2, py: 3 }}>
                {t.backgroundTasks.empty}
              </Typography>
            ) : (
              <List disablePadding>
                {drawerTasks.map((task) => (
                  <ListItemButton
                    key={task.id}
                    alignItems="flex-start"
                    onClick={() => onOpenTask(task.id)}
                    sx={{ py: 1.25, gap: 1.25 }}
                  >
                    <Box sx={{ pt: 0.25 }}>{taskIcon(task)}</Box>
                    <ListItemText
                      disableTypography
                      primary={
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
                          <Typography fontWeight={700} noWrap sx={{ minWidth: 0 }}>
                            {task.title}
                          </Typography>
                          <Chip size="small" color={taskStatusColor(task)} label={t.backgroundTasks.statuses[task.status]} />
                        </Stack>
                      }
                      secondary={
                        <Stack spacing={0.25} sx={{ mt: 0.25 }}>
                          <Typography variant="body2" color="text.secondary" noWrap>
                            {task.statusUpdates.at(-1)?.message ?? task.result?.message ?? formatDateTime(task.updatedAt)}
                          </Typography>
                          {task.app?.name ? (
                            <Typography variant="caption" color="text.secondary" noWrap>
                              {task.app.name}
                            </Typography>
                          ) : null}
                        </Stack>
                      }
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Box>
          <Divider />
          <Box sx={{ p: 1.5 }}>
            <Button fullWidth variant="contained" startIcon={<HistoryRounded />} onClick={onOpenHistory}>
              {t.backgroundTasks.viewHistory}
            </Button>
          </Box>
        </Box>
      </Drawer>
    </>
  );
}
