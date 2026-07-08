import AutoAwesomeRounded from '@mui/icons-material/AutoAwesomeRounded';
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded';
import ErrorRounded from '@mui/icons-material/ErrorRounded';
import HourglassTopRounded from '@mui/icons-material/HourglassTopRounded';
import {
  Badge,
  Box,
  Chip,
  Drawer,
  IconButton,
  List,
  ListItemText,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useMemo, useState } from 'react';
import type { LlmRunKind, LlmRunSnapshotItem, LlmRunStatus, LlmRunsSnapshot } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { formatBackgroundTaskDateTime } from '@renderer/views/BackgroundTasksView';
import { AgentRunActivityReceipt } from './AgentRunActivityReceipt';

interface LlmRunsDrawerProps {
  t: AppDictionary;
}

const emptySnapshot = (): LlmRunsSnapshot => ({
  items: [],
  activeCount: 0,
  errorCount: 0,
  updatedAt: new Date().toISOString(),
});

const activeRunStatuses = new Set<LlmRunStatus>(['queued', 'running', 'needs_permission']);

const isActive = (status: LlmRunStatus) => activeRunStatuses.has(status);

const statusColor = (status: LlmRunStatus): 'default' | 'success' | 'error' | 'warning' | 'info' => {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  if (status === 'canceled') return 'warning';
  if (isActive(status)) return 'info';
  return 'default';
};

const statusIcon = (status: LlmRunStatus) => {
  if (status === 'completed') return <CheckCircleRounded color="success" fontSize="small" />;
  if (status === 'failed') return <ErrorRounded color="error" fontSize="small" />;
  return <HourglassTopRounded color={isActive(status) ? 'info' : 'disabled'} fontSize="small" />;
};

export function LlmRunsDrawer({ t }: LlmRunsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<LlmRunsSnapshot>(() => emptySnapshot());

  const refresh = async () => {
    const nextSnapshot = await window.forger.getLlmRunsSnapshot().catch(() => emptySnapshot());
    setSnapshot(nextSnapshot);
  };

  useEffect(() => {
    void refresh();
    const unsubscribe = window.forger.onLlmRunsSnapshotChanged((nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });
    return unsubscribe;
  }, []);

  const items = useMemo<LlmRunSnapshotItem[]>(() => snapshot.items, [snapshot.items]);
  const activeCount = snapshot.activeCount;

  return (
    <>
      <Tooltip title={t.llmRuns.open}>
        <IconButton
          size="small"
          aria-label={t.llmRuns.open}
          onClick={() => setOpen(true)}
          sx={{ width: 34, height: 34, borderRadius: 1, color: 'text.secondary', border: '1px solid', borderColor: open ? 'primary.main' : 'divider' }}
        >
          <Badge
            badgeContent={activeCount}
            color="primary"
            invisible={activeCount === 0}
            sx={{ '& .MuiBadge-badge': { minWidth: 14, height: 14, px: 0.4, fontSize: 10 } }}
          >
            <AutoAwesomeRounded sx={{ fontSize: 18 }} />
          </Badge>
        </IconButton>
      </Tooltip>
      <Drawer anchor="right" open={open} onClose={() => setOpen(false)} PaperProps={{ sx: { width: 380, maxWidth: '100vw' } }}>
        <Stack spacing={2} sx={{ p: 2.5 }}>
          <Stack spacing={0.5}>
            <Typography variant="h6">{t.llmRuns.title}</Typography>
            <Typography variant="body2" color="text.secondary">
              {activeCount > 0 ? t.llmRuns.activeSummary(activeCount) : t.llmRuns.noActive}
            </Typography>
          </Stack>
          {items.length === 0 ? (
            <Box sx={{ py: 4, textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">{t.llmRuns.empty}</Typography>
            </Box>
          ) : (
            <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {items.map((item) => (
                <Box key={item.id} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1.5, py: 1.25 }}>
                  <Stack direction="row" alignItems="flex-start">
                    <Box sx={{ pt: 0.25, pr: 1.25 }}>{statusIcon(item.status)}</Box>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ minWidth: 0 }}>
                          <Typography fontWeight={700} noWrap sx={{ minWidth: 0 }}>{item.title}</Typography>
                          <Chip size="small" color={statusColor(item.status)} label={t.llmRuns.statuses[item.status]} sx={{ height: 22, flexShrink: 0, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }} />
                        </Stack>
                      }
                      secondary={
                        <Stack spacing={0.25} sx={{ mt: 0.5 }}>
                          <Typography variant="caption" color="text.secondary">
                            {item.appName} · {kindLabel(item.kind, t)}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">{item.progress || item.error || t.llmRuns.noProgress}</Typography>
                          <Typography variant="caption" color="text.secondary">{formatBackgroundTaskDateTime(item.updatedAt)}</Typography>
                        </Stack>
                      }
                    />
                  </Stack>
                  {item.activity || item.progress || item.error ? (
                    <Box sx={{ mt: 1 }}>
                      <AgentRunActivityReceipt t={t} activity={item.activity ?? fallbackActivityForItem(item, t)} />
                    </Box>
                  ) : null}
                </Box>
              ))}
            </List>
          )}
        </Stack>
      </Drawer>
    </>
  );
}

const kindLabel = (kind: LlmRunKind, t: AppDictionary): string => {
  if (kind === 'desktop_chat') return t.llmRuns.kinds.desktopChat;
  if (kind === 'personal_agent_conversation') return t.llmRuns.kinds.personalAgentConversation;
  if (kind === 'app_agent_thread') return t.llmRuns.kinds.appAgentThread;
  if (kind === 'workflow_node') return t.llmRuns.kinds.workflowNode;
  return t.llmRuns.kinds.appPromptTask;
};

const fallbackActivityForItem = (item: LlmRunSnapshotItem, t: AppDictionary) => ({
  title: t.agentRunActivityReceipt.activityTitle(item.progress || item.error ? 1 : 0),
  summary: item.progress || item.error || t.llmRuns.noProgress,
  status: item.status,
  kind: item.kind,
  appName: item.appName,
  startedAt: item.startedAt,
  updatedAt: item.updatedAt,
  completedAt: isActive(item.status) ? undefined : item.updatedAt,
  sections: item.progress || item.error
    ? [{
        id: 'notes',
        title: item.error ? t.agentRunActivityReceipt.sections.errors : t.agentRunActivityReceipt.sections.notes,
        items: [{
          id: `${item.id}:fallback`,
          label: item.progress || item.error || t.llmRuns.noProgress,
          value: item.status,
          tone: item.error ? 'error' as const : 'default' as const,
        }],
      }]
    : [],
});
