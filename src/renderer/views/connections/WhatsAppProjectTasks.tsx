import { Alert, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import type { RepositoryCollaborationCopy } from '@renderer/i18n/locales/repositoryCollaboration';
import type { RepositoryCollaborationRepository, RepositoryCollaborationTask } from '@shared/types/repository-collaboration';

export function WhatsAppProjectTasks({ tasks, repositories, copy, busy, onCancel, onRetry }: {
  tasks: RepositoryCollaborationTask[];
  repositories: RepositoryCollaborationRepository[];
  copy: RepositoryCollaborationCopy;
  busy: boolean;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const repositoryNames = new Map(repositories.map((repository) => [repository.id, repository.name]));
  return <Stack spacing={1}>
    <Typography variant="subtitle1" fontWeight={700}>{copy.tasks}</Typography>
    {tasks.length === 0 ? <Typography color="text.secondary">{copy.noTasks}</Typography> : null}
    {tasks.some((task) => ['failed', 'cancelled', 'needs_attention'].includes(task.status)) ? <Alert severity="info">{copy.retryHint}</Alert> : null}
    {[...tasks].sort((a, b) => b.createdAt - a.createdAt).map((task) => <Paper key={task.id} variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography fontWeight={700}>#{task.id.slice(0, 8)}</Typography>
          <Chip size="small" label={copy.statuses[task.status]} color={task.status === 'failed' || task.status === 'needs_attention' ? 'warning' : task.status === 'completed' ? 'success' : 'default'} />
          <Typography variant="body2">{task.participantName}</Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">{task.repositoryIds.map((id) => repositoryNames.get(id) ?? '—').join(' · ')}</Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.prompt}</Typography>
        {task.errorCode ? <Alert severity="warning">{copy.taskErrors[task.errorCode]}</Alert> : task.result ? <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{task.result}</Typography> : null}
        {task.status === 'queued' || task.status === 'running' ? <Button sx={{ alignSelf: 'flex-start' }} size="small" disabled={busy} aria-label={`${copy.cancel} ${task.id}`} onClick={() => onCancel(task.id)}>{copy.cancel}</Button> : null}
        {['failed', 'cancelled', 'needs_attention'].includes(task.status) ? <Button sx={{ alignSelf: 'flex-start' }} size="small" disabled={busy} aria-label={`${copy.retry} ${task.id}`} onClick={() => onRetry(task.id)}>{copy.retry}</Button> : null}
      </Stack>
    </Paper>)}
  </Stack>;
}
