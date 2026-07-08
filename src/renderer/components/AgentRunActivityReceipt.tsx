import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import {
  Box,
  ButtonBase,
  CircularProgress,
  Collapse,
  Stack,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import { isValidElement, useMemo, useState } from 'react';
import type { AppDictionary } from '@renderer/i18n';
import type { AgentRunActivity, AgentRunActivityItemKind } from '@shared/types';
import {
  buildAgentRunActivityTimeline,
  isActiveAgentRunActivityStatus,
  type AgentRunActivityProgressMessage,
  type AgentRunActivityTimelineKindLabels,
  type AgentRunActivityTimelineMode,
} from '@shared/agent-run-activity-view';

export interface AgentRunActivityReceiptItem {
  id?: string;
  label: string;
  value?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'error' | 'info';
  mono?: boolean;
}

export interface AgentRunActivityReceiptSection {
  id?: string;
  title: string;
  description?: string;
  items?: AgentRunActivityReceiptItem[];
}

export interface AgentRunActivityReceiptActivity {
  id?: string;
  title?: string;
  summary?: string;
  status?: string;
  kind?: string;
  appName?: string;
  agentName?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  sections?: AgentRunActivityReceiptSection[];
  technicalDetails?: unknown;
}

export interface AgentRunActivityReceiptProps {
  t: AppDictionary;
  activity?: AgentRunActivityReceiptActivity | AgentRunActivity;
  title?: string;
  summary?: string;
  status?: string;
  kind?: string;
  appName?: string;
  agentName?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  sections?: AgentRunActivityReceiptSection[];
  technicalDetails?: unknown;
  expanded?: boolean;
  defaultExpanded?: boolean;
  mode?: AgentRunActivityTimelineMode;
  progressMessages?: Array<string | AgentRunActivityProgressMessage>;
  emptyLabel?: string;
  showTechnicalDetails?: boolean;
  excludeText?: string | string[];
  onExpandedChange?: (expanded: boolean) => void;
}

const isAgentRunActivity = (value: AgentRunActivityReceiptActivity | AgentRunActivity | undefined): value is AgentRunActivity =>
  Boolean(value && typeof value === 'object' && 'items' in value && Array.isArray((value as AgentRunActivity).items));

const renderItemValue = (value: ReactNode): string => {
  if (value === undefined || value === null || value === '') return '';
  if (isValidElement(value)) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
};

export function AgentRunActivityReceipt({
  t,
  activity,
  title,
  summary,
  status,
  completedAt,
  sections,
  expanded,
  defaultExpanded = false,
  mode,
  progressMessages = [],
  emptyLabel,
  excludeText,
  onExpandedChange,
}: AgentRunActivityReceiptProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const concreteActivity = isAgentRunActivity(activity) ? activity : undefined;
  const legacyActivity = isAgentRunActivity(activity) ? undefined : activity;
  const legacyMessages = useMemo(
    () => legacyProgressMessages(legacyActivity, sections),
    [legacyActivity, sections],
  );
  const resolvedStatus = status ?? concreteActivity?.status ?? legacyActivity?.status;
  const resolvedMode = mode ?? (isActiveAgentRunActivityStatus(resolvedStatus) ? 'live' : 'completed');
  const resolvedCompletedAt = completedAt ?? concreteActivity?.finishedAt ?? legacyActivity?.completedAt;
  const labels = useMemo(() => timelineLabelsFromDictionary(t), [t]);
  const timeline = buildAgentRunActivityTimeline({
    activity: concreteActivity,
    progressMessages: concreteActivity ? progressMessages : [...legacyMessages, ...progressMessages],
    mode: resolvedMode,
    labels,
    completedAt: resolvedCompletedAt,
  });
  const displayTitle = title ?? legacyActivity?.title ?? timeline.title;
  const isExpanded = resolvedMode === 'live' ? true : expanded ?? internalExpanded;
  const excludedText = normalizedExcludedText(excludeText);
  const rows = excludedText.size > 0
    ? timeline.rows.filter((row) => !excludedText.has(normalizeComparableText(row.text)))
    : timeline.rows;
  const visibleSummary = rows.length === 0 ? summary ?? legacyActivity?.summary ?? timeline.summary : undefined;

  if (resolvedMode === 'live') {
    return (
      <Stack spacing={0.75} sx={{ width: '100%', minWidth: 0, color: 'text.secondary' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <CircularProgress size={14} />
          <Typography variant="caption" sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {rows.length > 0 ? displayTitle : emptyLabel ?? t.sections.chat.agentThinking}
          </Typography>
        </Stack>
        {rows.length > 0 ? <ActivityRows rows={rows} /> : null}
      </Stack>
    );
  }

  if (rows.length === 0 && !visibleSummary) {
    return null;
  }

  const toggleExpanded = () => {
    const nextExpanded = !isExpanded;
    setInternalExpanded(nextExpanded);
    onExpandedChange?.(nextExpanded);
  };

  return (
    <Box sx={{ width: '100%', minWidth: 0, color: 'text.secondary' }}>
      <ButtonBase
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? t.agentRunActivityReceipt.collapse : t.agentRunActivityReceipt.expand}
        sx={{
          width: '100%',
          display: 'block',
          textAlign: 'left',
          borderBottom: '1px solid',
          borderColor: 'divider',
          py: 0.85,
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
        }}
      >
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
          >
            {displayTitle}
          </Typography>
          <ExpandMoreRounded
            fontSize="small"
            sx={{
              color: 'text.secondary',
              flexShrink: 0,
              transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: (theme) => theme.transitions.create('transform', { duration: theme.transitions.duration.shortest }),
            }}
          />
        </Stack>
      </ButtonBase>
      <Collapse in={isExpanded} timeout="auto" unmountOnExit>
        <Stack spacing={0.75} sx={{ pt: 0.85 }}>
          {visibleSummary ? (
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {visibleSummary}
            </Typography>
          ) : null}
          {rows.length > 0 ? <ActivityRows rows={rows} /> : null}
        </Stack>
      </Collapse>
    </Box>
  );
}

function ActivityRows({ rows }: { rows: Array<{ id: string; kind: AgentRunActivityItemKind; text: string }> }) {
  return (
    <Stack spacing={0.6} component="ol" sx={{ listStyle: 'none', m: 0, p: 0, minWidth: 0 }}>
      {rows.map((row) => (
        <Stack
          key={row.id}
          component="li"
          direction="row"
          spacing={0.8}
          alignItems="flex-start"
          sx={{ minWidth: 0 }}
        >
          <Box
            aria-hidden
            sx={{
              width: 16,
              height: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Box
              sx={{
                width: row.kind === 'error' ? 7 : 5,
                height: row.kind === 'error' ? 7 : 5,
                borderRadius: '50%',
                bgcolor: row.kind === 'error' ? 'error.main' : row.kind === 'assistant_note' ? 'text.secondary' : 'action.disabled',
              }}
            />
          </Box>
          <Typography
            variant="body2"
            color={row.kind === 'error' ? 'error.main' : 'text.secondary'}
            sx={{
              minWidth: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {row.text}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

const timelineLabelsFromDictionary = (t: AppDictionary) => ({
  fallbackTitle: t.agentRunActivityReceipt.fallbackTitle,
  workedFor: t.agentRunActivityReceipt.workedFor,
  activityTitle: t.agentRunActivityReceipt.activityTitle,
  duration: t.agentRunActivityReceipt.duration,
  kinds: t.agentRunActivityReceipt.timelineKinds as AgentRunActivityTimelineKindLabels,
});

const normalizedExcludedText = (value: string | string[] | undefined): Set<string> =>
  new Set((Array.isArray(value) ? value : value ? [value] : [])
    .map(normalizeComparableText)
    .filter(Boolean));

const normalizeComparableText = (value: string): string =>
  value
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const legacyProgressMessages = (
  activity: AgentRunActivityReceiptActivity | undefined,
  sections: AgentRunActivityReceiptSection[] | undefined,
): AgentRunActivityProgressMessage[] => {
  const visibleSections = sections ?? activity?.sections ?? [];
  const messages = visibleSections.flatMap((section) => section.items ?? [])
    .map((item, index) => ({
      id: item.id ?? `legacy-${index}`,
      message: item.label || renderItemValue(item.value),
    }))
    .filter((item) => item.message.trim().length > 0);
  if (messages.length > 0) {
    return messages;
  }
  return activity?.summary ? [{ id: `${activity.id ?? 'legacy'}-summary`, message: activity.summary }] : [];
};
