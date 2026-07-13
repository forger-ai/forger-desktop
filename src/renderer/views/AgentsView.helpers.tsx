import DescriptionRounded from '@mui/icons-material/DescriptionRounded';
import FolderRounded from '@mui/icons-material/FolderRounded';
import { Box, Stack, Typography } from '@mui/material';
import type {
  AgentPermissionMode,
  AgentProvider,
  AgentRuntime,
  AgentToolId,
  PersonalAgent,
  PersonalAgentConnectionGrant,
  PersonalAgentConversation,
  PersonalAgentGrantOptionConnection,
  PersonalAgentGroup,
  PersonalAgentMessage,
  PersonalAgentPeerGrant,
  PersonalAgentRunStatus,
  PersonalAgentWorkspaceEntry,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import {
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
} from '@renderer/preferences';
import type { AgentRunActivityProgressMessage } from '@shared/agent-run-activity-view';

interface WorkspaceTreeProps {
  entries: PersonalAgentWorkspaceEntry[];
  emptyLabel: string;
  selectedPath?: string;
  onOpenFile: (entry: PersonalAgentWorkspaceEntry) => void;
}

export interface AccessDraft {
  permissionMode: AgentPermissionMode;
  networkAccess: boolean;
  canSpawnAgents: boolean;
  groupId: string | null;
  runtime: AgentRuntime;
  appIds: string[];
  toolIds: AgentToolId[];
  connectionGrants: PersonalAgentConnectionGrant[];
  peerAgentGrants: PersonalAgentPeerGrant[];
}

export interface AgentConversationHistoryGroup {
  id: string;
  label: string;
  items: PersonalAgentConversation[];
}

export interface PersonalAgentDisplayGroup {
  groupId: string | null;
  name?: string;
  agents: PersonalAgent[];
}

export const groupAgentsForDisplay = (
  agents: PersonalAgent[],
  groups: PersonalAgentGroup[],
): PersonalAgentDisplayGroup[] => {
  const sortedGroups = [...groups].sort((left, right) => left.name.localeCompare(right.name));
  const grouped = sortedGroups
    .map((group) => ({
      groupId: group.id,
      name: group.name,
      agents: agents
        .filter((agent) => agent.groupId === group.id)
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .filter((group) => group.agents.length > 0);
  const knownGroupIds = new Set(groups.map((group) => group.id));
  const ungrouped = agents
    .filter((agent) => !agent.groupId || !knownGroupIds.has(agent.groupId))
    .sort((left, right) => left.name.localeCompare(right.name));
  return ungrouped.length > 0
    ? [...grouped, { groupId: null, agents: ungrouped }]
    : grouped;
};

export interface RenderPersonalAgentMessageOptions {
  contextMessages?: PersonalAgentMessage[];
}

export const connectionInstanceLabel = (instance: PersonalAgentGrantOptionConnection['instances'][number]): string =>
  instance.accountIdentity?.email
  ?? instance.accountIdentity?.username
  ?? instance.accountIdentity?.workspace
  ?? instance.accountIdentity?.phoneNumber
  ?? instance.label
  ?? instance.id;

export function WorkspaceTree({ entries, emptyLabel, selectedPath, onOpenFile }: WorkspaceTreeProps) {
  if (entries.length === 0) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">{emptyLabel}</Typography>
      </Box>
    );
  }

  const renderEntry = (entry: PersonalAgentWorkspaceEntry, depth: number) => (
    <Box key={entry.relativePath}>
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        role={entry.kind === 'file' ? 'button' : undefined}
        tabIndex={entry.kind === 'file' ? 0 : undefined}
        onClick={() => {
          if (entry.kind === 'file') {
            onOpenFile(entry);
          }
        }}
        onKeyDown={(event) => {
          if (entry.kind === 'file' && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onOpenFile(entry);
          }
        }}
        sx={{
          bgcolor: entry.relativePath === selectedPath ? 'action.selected' : 'transparent',
          cursor: entry.kind === 'file' ? 'pointer' : 'default',
          minHeight: 30,
          pl: 1 + depth * 1.5,
          pr: 1,
          '&:hover': {
            bgcolor: entry.kind === 'file' ? 'action.hover' : 'transparent',
          },
        }}
      >
        {entry.kind === 'directory' ? (
          <FolderRounded color="action" sx={{ fontSize: 18, flexShrink: 0 }} />
        ) : (
          <DescriptionRounded color="action" sx={{ fontSize: 18, flexShrink: 0 }} />
        )}
        <Typography
          variant="body2"
          title={entry.relativePath}
          sx={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.name}
        </Typography>
      </Stack>
      {entry.children?.map((child) => renderEntry(child, depth + 1))}
    </Box>
  );

  return <Box sx={{ py: 0.75 }}>{entries.map((entry) => renderEntry(entry, 0))}</Box>;
}

export const isTerminalRunStatus = (status: PersonalAgentRunStatus | undefined): boolean =>
  status === 'completed' || status === 'failed' || status === 'canceled';

export const upsertConversation = (
  current: PersonalAgentConversation[],
  conversation: PersonalAgentConversation,
): PersonalAgentConversation[] => {
  const next = [
    conversation,
    ...current.filter((item) => item.id !== conversation.id),
  ];
  return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

export const defaultAccessDraft = (): AccessDraft => ({
  permissionMode: 'safe',
  networkAccess: false,
  canSpawnAgents: false,
  groupId: null,
  runtime: defaultPersonalAgentRuntime(),
  appIds: [],
  toolIds: [],
  connectionGrants: [],
  peerAgentGrants: [],
});

export const accessDraftFromAgent = (agent: PersonalAgent): AccessDraft => ({
  permissionMode: agent.permissionMode,
  networkAccess: agent.networkAccess,
  canSpawnAgents: agent.canSpawnAgents,
  groupId: agent.groupId ?? null,
  runtime: agent.runtime ? { ...agent.runtime } : defaultPersonalAgentRuntime(),
  appIds: [...agent.appIds],
  toolIds: [...agent.toolIds],
  connectionGrants: agent.connectionGrants.map((grant) => ({
    ...grant,
    actions: [...grant.actions],
    ...(grant.connectionIds ? { connectionIds: [...grant.connectionIds] } : {}),
  })),
  peerAgentGrants: agent.peerAgentGrants.map((grant) => ({ ...grant })),
});

export const toggleId = <T extends string>(values: T[], id: T, checked: boolean): T[] =>
  checked ? [...new Set([...values, id])] : values.filter((value) => value !== id);

export const compactFileLabel = (name: string): string => name.length > 28 ? `${name.slice(0, 12)}...${name.slice(-12)}` : name;

export const defaultPersonalAgentRuntime = (): AgentRuntime => ({
  provider: 'codex',
  model: CODEX_MODEL_OPTIONS[0]?.realModelName ?? 'gpt-5.2',
  effort: CODEX_MODEL_OPTIONS[0]?.defaultReasoningEffort ?? 'medium',
});

export const visiblePeerThreadMessages = (messages: PersonalAgentMessage[]): PersonalAgentMessage[] => {
  const visible = messages.filter((item) => item.role !== 'system' && item.kind !== 'intermediate');
  return visible.length > 0 ? visible : messages.filter((item) => item.role !== 'system');
};

export const progressMessagesForMessageRun = (
  item: PersonalAgentMessage,
  contextMessages: PersonalAgentMessage[] | undefined,
): AgentRunActivityProgressMessage[] => {
  if (!item.runId || item.role !== 'assistant' || item.kind !== 'message' || !contextMessages?.length) {
    return [];
  }
  return contextMessages
    .filter((candidate) =>
      candidate.runId === item.runId &&
      candidate.role === 'assistant' &&
      candidate.kind === 'intermediate' &&
      !isLikelyDuplicateFinalProgress(candidate.content, item.content))
    .map((candidate) => ({
      id: candidate.id,
      message: candidate.content,
      createdAt: candidate.createdAt,
    }));
};

export const defaultRuntimeForProvider = (provider: AgentProvider): AgentRuntime => {
  if (provider === 'claude') {
    return {
      provider,
      model: CLAUDE_MODEL_OPTIONS[0]?.realModelName ?? 'claude-sonnet-5',
      effort: CLAUDE_MODEL_OPTIONS[0]?.defaultEffort ?? 'medium',
    };
  }
  if (provider === 'antigravity') {
    return {
      provider,
      model: ANTIGRAVITY_MODEL_OPTIONS[0]?.realModelName ?? 'gemini-3-pro',
      effort: ANTIGRAVITY_MODEL_OPTIONS[0]?.defaultEffort ?? 'medium',
    };
  }
  return defaultPersonalAgentRuntime();
};

export const personalAgentRunErrorMessage = (error: string | undefined, t: AppDictionary): string | null => {
  if (!error) return null;
  const normalized = error.trim();
  if (normalized === 'codex_auth_missing' || normalized === 'claude_auth_missing') return t.agents.runErrorLlmAuth;
  if (normalized === 'codex_cli_missing') return t.agents.runErrorCodexCli;
  if (normalized === 'claude_cli_missing') return t.agents.runErrorClaudeCli;
  if (normalized === 'personal_agent_workspace_missing') return t.agents.runErrorWorkspaceMissing;
  if (normalized === 'personal_agent_runtime_unavailable') return t.agents.runErrorRuntimeUnavailable;
  if (normalized === 'personal_agent_provider_changed_new_conversation_required') return t.agents.runErrorProviderChanged;
  return t.agents.runErrorGeneric;
};

export const personalAgentSaveErrorMessage = (error: unknown, fallback: string, t: AppDictionary): string => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message === 'personal_agent_runtime_provider_not_connected') {
    return t.agents.runtimeProviderNotConnected;
  }
  return error instanceof Error ? error.message : fallback;
};

const isLikelyDuplicateFinalProgress = (progress: string, finalContent: string): boolean => {
  const normalizedProgress = normalizeComparableAgentText(progress);
  const normalizedFinal = normalizeComparableAgentText(finalContent);
  if (!normalizedProgress || !normalizedFinal) {
    return false;
  }
  if (normalizedProgress === normalizedFinal) {
    return true;
  }
  const prefix = normalizedProgress.replace(/\.\.\.$/, '').trim();
  return prefix.length >= 80 && normalizedFinal.startsWith(prefix);
};

const normalizeComparableAgentText = (value: string): string =>
  value
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
