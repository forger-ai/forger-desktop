import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ErrorRounded from '@mui/icons-material/ErrorRounded';
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded';
import {
  Box,
  Button,
  Chip,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import type { BackgroundTask } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import type { View } from '@renderer/components/Sidebar';

interface BackgroundTasksListViewProps {
  t: AppDictionary;
  tasks: BackgroundTask[];
  backLabel: string;
  onBack: () => void;
  onOpenTask: (taskId: string) => void;
}

interface BackgroundTaskDetailViewProps {
  t: AppDictionary;
  task: BackgroundTask | null;
  onBack: () => void;
}

export const backgroundTaskStatusColor = (task: BackgroundTask): 'default' | 'success' | 'error' | 'warning' | 'info' => {
  if (task.status === 'succeeded') return 'success';
  if (task.status === 'failed') return 'error';
  if (task.status === 'skipped' || task.status === 'canceled') return 'warning';
  if (task.status === 'running') return 'info';
  return 'default';
};

export const backgroundTaskIcon = (task: BackgroundTask) => {
  if (task.status === 'succeeded') return <CheckCircleRounded color="success" fontSize="small" />;
  if (task.status === 'failed') return <ErrorRounded color="error" fontSize="small" />;
  return <HourglassTopRounded color={task.status === 'queued' || task.status === 'running' ? 'info' : 'warning'} fontSize="small" />;
};

export const formatBackgroundTaskDateTime = (value?: string): string => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

export const viewLabel = (t: AppDictionary, view: View): string => {
  if (view === 'backgroundTasks' || view === 'backgroundTaskDetail') return t.backgroundTasks.title;
  return t.nav[view as keyof typeof t.nav] ?? t.nav.apps;
};

export function BackgroundTasksListView({ t, tasks, backLabel, onBack, onOpenTask }: BackgroundTasksListViewProps) {
  return (
    <Stack spacing={2.5}>
      <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.backgroundTasks.backTo(backLabel)}
      </Button>
      <Stack spacing={0.5}>
        <Typography variant="h4">{t.backgroundTasks.historyTitle}</Typography>
        <Typography color="text.secondary">{t.backgroundTasks.historySubtitle}</Typography>
      </Stack>
      {tasks.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Typography color="text.secondary">{t.backgroundTasks.empty}</Typography>
        </Paper>
      ) : (
        <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {tasks.map((task) => (
            <Paper key={task.id} variant="outlined" sx={{ borderRadius: 1, overflow: 'hidden' }}>
              <ListItemButton onClick={() => onOpenTask(task.id)} sx={{ alignItems: 'flex-start', gap: 1.5, py: 1.5 }}>
                <Box sx={{ pt: 0.25 }}>{backgroundTaskIcon(task)}</Box>
                <ListItemText
                  primary={
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Typography fontWeight={700}>{task.title}</Typography>
                      <Chip size="small" color={backgroundTaskStatusColor(task)} label={t.backgroundTasks.statuses[task.status]} />
                    </Stack>
                  }
                  secondary={
                    <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                      <Typography variant="body2" color="text.secondary">
                        {task.result?.message ?? task.statusUpdates.at(-1)?.message ?? formatBackgroundTaskDateTime(task.updatedAt)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {formatBackgroundTaskDateTime(task.updatedAt)}
                        {task.app?.name ? ` · ${task.app.name}` : ''}
                      </Typography>
                    </Stack>
                  }
                />
              </ListItemButton>
            </Paper>
          ))}
        </List>
      )}
    </Stack>
  );
}

export function BackgroundTaskDetailView({ t, task, onBack }: BackgroundTaskDetailViewProps) {
  if (!task) {
    return (
      <Stack spacing={2}>
        <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
          {t.actions.back}
        </Button>
        <Typography color="text.secondary">{t.backgroundTasks.notFound}</Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={2.5}>
      <Button startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.actions.back}
      </Button>
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        {backgroundTaskIcon(task)}
        <Typography variant="h4">{task.title}</Typography>
        <Chip size="small" color={backgroundTaskStatusColor(task)} label={t.backgroundTasks.statuses[task.status]} />
      </Stack>
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
        <Stack spacing={1}>
          {task.app?.name ? (
            <Typography variant="body2" color="text.secondary">
              {t.backgroundTasks.appLabel}: {task.app.name}
            </Typography>
          ) : null}
          <Typography variant="body2" color="text.secondary">
            {t.backgroundTasks.startedAt}: {formatBackgroundTaskDateTime(task.createdAt)}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t.backgroundTasks.updatedAt}: {formatBackgroundTaskDateTime(task.updatedAt)}
          </Typography>
          {task.completedAt ? (
            <Typography variant="body2" color="text.secondary">
              {t.backgroundTasks.completedAt}: {formatBackgroundTaskDateTime(task.completedAt)}
            </Typography>
          ) : null}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
        <Stack spacing={1.25}>
          <Typography variant="h6">{t.backgroundTasks.updatesTitle}</Typography>
          {task.statusUpdates.length === 0 ? (
            <Typography color="text.secondary">{t.backgroundTasks.noUpdates}</Typography>
          ) : (
            task.statusUpdates.map((update, index) => (
              <Box key={`${update.createdAt}-${index}`}>
                <Typography fontWeight={600}>{update.message}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatBackgroundTaskDateTime(update.createdAt)}
                </Typography>
                {index < task.statusUpdates.length - 1 ? <Divider sx={{ mt: 1 }} /> : null}
              </Box>
            ))
          )}
        </Stack>
      </Paper>
      {task.result ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Stack spacing={0.75}>
            <Typography variant="h6">{t.backgroundTasks.resultTitle}</Typography>
            <Typography>{task.result.message}</Typography>
            {task.result.technicalCode ? (
              <Typography variant="caption" color="text.secondary">
                {task.result.technicalCode}
              </Typography>
            ) : null}
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
