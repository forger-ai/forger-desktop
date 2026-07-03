import SendRounded from '@mui/icons-material/SendRounded';
import AddCommentRounded from '@mui/icons-material/AddCommentRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DonutLargeRounded from '@mui/icons-material/DonutLargeRounded';
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import BugReportRounded from '@mui/icons-material/BugReportRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  LinearProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type {
  AgentProvider,
  AgentPermissionMode,
  AppSummary,
  ChatMode,
  ChatQuestionRequest,
  CodexAuthStatus,
  CodexRateLimitBucket,
  ForgerFileCategory,
  ForgerFileRecord,
  FilesStageForChatInput,
  PermissionRequest,
  PickedChatFile,
  WindowControlState,
} from '@shared/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import { compactCategoryLabel, compactFileName } from './chat-view-helpers';
import { ChatMessagesPanel } from './chat/ChatMessagesPanel';
import { QuestionComposer, type QuestionAction } from './chat/QuestionComposer';
import type { RuntimeProviderControls } from '@renderer/runtime-provider-controls';

export interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
  files?: Array<{
    id: string;
    name: string;
    relativePath: string;
    sizeBytes: number;
    displayPath?: string;
    source: 'attached' | 'mentioned';
  }>;
  action?: {
    type: 'open-app';
    appId: string;
    label: string;
  } | {
    type: 'permission';
    runId: string;
    request: PermissionRequest;
    status?: 'pending' | 'approved' | 'denied';
  } | {
    type: 'question';
    runId: string;
    request: ChatQuestionRequest;
    status?: 'pending' | 'answered';
  };
}

export interface ChatQuestionAnswer {
  questionId: string;
  question: string;
  optionId: string;
  label: string;
  description?: string;
}

export interface ChatQuestionResponse {
  answers: ChatQuestionAnswer[];
  freeText?: string;
}

export interface ConversationHistoryItem {
  id: string;
  title: string;
  threadId: string | null;
  updatedAt: string;
  appId: string;
  mode?: ChatMode;
  targetAppId?: string | null;
}

interface ConversationHistoryGroup {
  id: string;
  label: string;
  items: ConversationHistoryItem[];
}

const isMacOs = navigator.platform.toLowerCase().includes('mac');
const HISTORY_INITIAL_LIMIT = 5;
const HISTORY_LIMIT_STEP = 10;

const historyItemTimestamp = (item: ConversationHistoryItem) => {
  const timestamp = Date.parse(item.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const sortHistoryItemsByRecentActivity = (items: ConversationHistoryItem[]) =>
  [...items].sort((left, right) => historyItemTimestamp(right) - historyItemTimestamp(left));

const historyGroupTimestamp = (group: ConversationHistoryGroup) =>
  Math.max(0, ...group.items.map(historyItemTimestamp));

const sortHistoryGroupsByRecentActivity = (groups: ConversationHistoryGroup[]) =>
  [...groups].sort((left, right) => {
    const activityDifference = historyGroupTimestamp(right) - historyGroupTimestamp(left);
    return activityDifference !== 0 ? activityDifference : left.label.localeCompare(right.label);
  });

const readFileAsBase64 = async (file: File): Promise<string> =>
  await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      resolve(value.includes(',') ? value.split(',').pop() ?? '' : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error('clipboard_image_read_failed'));
    reader.readAsDataURL(file);
  });

const CODEX_USAGE_TOOLTIP_CACHE_MS = 60_000;

const formatRelativeHistoryTime = (updatedAt: string, nowLabel: string) => {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return nowLabel;
  }

  const units: Array<[string, number]> = [
    ['y', 60 * 60 * 24 * 365],
    ['mo', 60 * 60 * 24 * 30],
    ['w', 60 * 60 * 24 * 7],
    ['d', 60 * 60 * 24],
    ['h', 60 * 60],
    ['m', 60],
  ];
  const [unit, seconds] = units.find(([, unitSeconds]) => diffSeconds >= unitSeconds) ?? ['m', 60];
  return `${Math.floor(diffSeconds / seconds)}${unit}`;
};

const CodexUsageTooltipContent = ({
  bucket,
  loading,
  t,
}: {
  bucket: CodexRateLimitBucket;
  loading: boolean;
  t: AppDictionary;
}) => {
  const usedPercent = Math.round(bucket.primary?.usedPercent ?? 0);
  const remainingPercent = Math.round(bucket.primary?.remainingPercent ?? Math.max(0, 100 - usedPercent));
  const resetLabel = bucket.primary?.resetsAt
    ? t.settings.codexUsageReset(new Date(bucket.primary.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    : null;
  const bucketName = bucket.limitName || bucket.limitId;

  return (
    <Stack spacing={0.75} sx={{ minWidth: 220, py: 0.25 }}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Typography variant="caption" fontWeight={700}>{t.settings.codexUsageTitle}</Typography>
        {loading ? <CircularProgress color="inherit" size={12} /> : null}
      </Stack>
      <LinearProgress color={bucket.rateLimitReachedType || usedPercent >= 90 ? 'warning' : 'primary'} variant="determinate" value={usedPercent} />
      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
        <Chip size="small" label={t.settings.codexUsageUsed(usedPercent)} />
        <Chip size="small" label={t.settings.codexUsageRemaining(remainingPercent)} />
        {bucket.primary?.windowDurationMins ? <Chip size="small" label={t.settings.codexUsageWindow(bucket.primary.windowDurationMins)} /> : null}
        {resetLabel ? <Chip size="small" label={resetLabel} /> : null}
      </Stack>
      <Typography variant="caption" color="inherit">
        {bucket.rateLimitReachedType ? t.settings.codexUsageLimitReached : t.settings.codexUsageBucket(bucketName)}
      </Typography>
    </Stack>
  );
};

interface ChatViewProps {
  t: AppDictionary;
  conversationTitle: string;
  activeConversationId: string | null;
  historyItems: ConversationHistoryItem[];
  onOpenConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onStartNewConversation: () => void;
  onNotifyForger?: () => void;
  chatMode?: ChatMode;
  targetAppId?: string | null;
  installedApps: AppSummary[];
  getAppMeta: (appId: string) => { name: string; description: string };
  messages: ChatMessage[];
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: (modeOverride?: { mode: ChatMode; targetAppId?: string | null }) => void;
  pendingFiles: PickedChatFile[];
  mentionedFiles: ForgerFileRecord[];
  availableFiles: ForgerFileRecord[];
  fileCategories: ForgerFileCategory[];
  uploadCategoryPath: string;
  onUploadCategoryChange: (categoryPath: string) => void;
  onPickFiles: () => void;
  onStagePastedFile: (input: FilesStageForChatInput) => Promise<void>;
  onCreateUploadCategory: () => void;
  onRemovePendingFile: (sourcePath: string) => void;
  onMentionFile: (file: ForgerFileRecord) => void;
  onRemoveMentionedFile: (fileId: string) => void;
  providerOptions: Array<{ label: string; value: AgentProvider | 'auto' }>;
  selectedProvider: AgentProvider | 'auto';
  resolvedProviderForAuto: AgentProvider;
  onSelectProvider: (provider: AgentProvider | 'auto') => void;
  providerLocked: boolean;
  runtimeProviderControls: RuntimeProviderControls;
  selectedPermissionMode: AgentPermissionMode;
  onSelectPermissionMode: (mode: AgentPermissionMode) => void;
  selectedNetworkAccess: boolean;
  onSelectNetworkAccess: (networkAccess: boolean) => void;
  onOpenCodexUsageDashboard: () => void;
  onRefreshCodexUsage: () => Promise<CodexAuthStatus>;
  assistantAvatarSrc: string;
  isSending: boolean;
  isResponding: boolean;
  canStopRun: boolean;
  progressLines: string[];
  intelligenceProviderConfigured: boolean;
  codexProviderConfigured: boolean;
  onConfigureIntelligenceProvider: () => void;
  openingAppIds: Set<string>;
  onOpenApp: (appId: string) => void;
  onInstallReviewedSocialApp?: () => void;
  onDeleteReviewedSocialApp?: () => void;
  onStopRun: () => Promise<void>;
  onRespondPermission: (runId: string, requestId: string, decision: 'allow' | 'deny') => Promise<void>;
  onRespondQuestion: (runId: string, request: ChatQuestionRequest, response: ChatQuestionResponse) => Promise<void>;
}

export function ChatView({
  t,
  conversationTitle,
  activeConversationId,
  historyItems,
  onOpenConversation,
  onDeleteConversation,
  onStartNewConversation,
  onNotifyForger,
  chatMode,
  targetAppId,
  installedApps,
  getAppMeta,
  messages,
  inputValue,
  onInputChange,
  onSend,
  pendingFiles,
  mentionedFiles,
  availableFiles,
  fileCategories,
  uploadCategoryPath,
  onUploadCategoryChange,
  onPickFiles,
  onStagePastedFile,
  onCreateUploadCategory,
  onRemovePendingFile,
  onMentionFile,
  onRemoveMentionedFile,
  providerOptions,
  selectedProvider,
  resolvedProviderForAuto,
  onSelectProvider,
  providerLocked,
  runtimeProviderControls,
  selectedPermissionMode,
  onSelectPermissionMode,
  selectedNetworkAccess,
  onSelectNetworkAccess,
  onOpenCodexUsageDashboard,
  onRefreshCodexUsage,
  assistantAvatarSrc,
  isSending,
  isResponding,
  canStopRun,
  progressLines,
  intelligenceProviderConfigured,
  codexProviderConfigured,
  onConfigureIntelligenceProvider,
  openingAppIds,
  onOpenApp,
  onInstallReviewedSocialApp,
  onDeleteReviewedSocialApp,
  onStopRun,
  onRespondPermission,
  onRespondQuestion,
}: ChatViewProps) {
  const theme = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [windowState, setWindowState] = useState<WindowControlState | null>(null);
  const [collapsedHistoryGroups, setCollapsedHistoryGroups] = useState<Record<string, boolean>>({});
  const [historyGroupLimits, setHistoryGroupLimits] = useState<Record<string, number>>({});
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionMenuPosition, setMentionMenuPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [respondingPermissionIds, setRespondingPermissionIds] = useState<Set<string>>(new Set());
  const [respondingQuestionRequestIds, setRespondingQuestionRequestIds] = useState<Set<string>>(new Set());
  const [stopBusy, setStopBusy] = useState(false);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [codexUsageStatus, setCodexUsageStatus] = useState<CodexAuthStatus | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexUsageError, setCodexUsageError] = useState(false);
  const [draftMode, setDraftMode] = useState<ChatMode>('create_app');
  const [draftTargetAppId, setDraftTargetAppId] = useState('');
  const inputRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const codexUsageCheckedAtRef = useRef(0);
  const providerLabel = (provider: AgentProvider): string =>
    providerOptions.find((option) => option.value === provider)?.label ?? provider;
  const renderProviderValue = (value: AgentProvider | 'auto' | ''): string =>
    value === ''
      ? ''
      : value === 'auto'
        ? t.sections.chat.autoProviderLabel(providerLabel(resolvedProviderForAuto))
        : providerOptions.find((option) => option.value === value)?.label ?? providerLabel(value);
  const selectedProviderValue = providerOptions.some((option) => option.value === selectedProvider) ? selectedProvider : '';
  const effectiveProvider = selectedProvider === 'auto' ? resolvedProviderForAuto : selectedProvider;
  const activeQuestionAction = useMemo(
    () => [...messages].reverse().find((message) => (
      message.role === 'assistant'
      && message.action?.type === 'question'
      && (message.action.status ?? 'pending') === 'pending'
    ))?.action as QuestionAction | undefined,
    [messages],
  );
  const matchingFiles = mentionQuery === null
    ? []
    : availableFiles
        .filter((file) => file.name.toLowerCase().includes(mentionQuery.toLowerCase()))
        .slice(0, 8);
  const modeOptions = t.sections.chat.modeSelector.options;
  const canStartMode = draftMode !== 'edit_app' || Boolean(draftTargetAppId);
  const pendingModeOverride = chatMode ? undefined : { mode: draftMode, targetAppId: draftMode === 'edit_app' ? draftTargetAppId : null };
  const canSendCurrentMode = Boolean(chatMode) || canStartMode;
  const runtimeMenuHandlers = { onOpen: () => setRuntimeMenuOpen(true), onClose: () => setRuntimeMenuOpen(false) };
  const activeRuntimeControl = runtimeProviderControls[effectiveProvider];
  const activeModelOptions = activeRuntimeControl.modelOptions;
  const activeModelValue = activeRuntimeControl.selectedModel;
  const activeEffortOptions = activeRuntimeControl.effortOptions;
  const activeEffortValue = activeRuntimeControl.selectedEffort;
  const codexUsageBucket = codexUsageStatus?.rateLimits?.primary ?? codexUsageStatus?.rateLimits?.buckets[0];
  const shouldReserveMacTrafficLightSpace = isMacOs && !windowState?.isFullScreen;
  const historyGroups = useMemo<ConversationHistoryGroup[]>(() => {
    const createAppItems: ConversationHistoryItem[] = [];
    const reviewAppItems: ConversationHistoryItem[] = [];
    const freeChatItems: ConversationHistoryItem[] = [];
    const appGroups = new Map<string, ConversationHistoryGroup>();

    historyItems.forEach((item) => {
      if (item.mode === 'create_app') {
        createAppItems.push(item);
        return;
      }
      if (item.mode === 'social_app_review') {
        reviewAppItems.push(item);
        return;
      }
      if (item.mode === 'free_chat' || !item.mode) {
        freeChatItems.push(item);
        return;
      }

      const appId = item.targetAppId ?? item.appId;
      const groupId = `app:${appId}`;
      const existingGroup = appGroups.get(groupId);
      if (existingGroup) {
        existingGroup.items.push(item);
        return;
      }
      appGroups.set(groupId, {
        id: groupId,
        label: getAppMeta(appId).name,
        items: [item],
      });
    });

    return sortHistoryGroupsByRecentActivity([
      createAppItems.length > 0
        ? { id: 'create_app', label: t.sections.chat.historyGroups.createApps, items: sortHistoryItemsByRecentActivity(createAppItems) }
        : null,
      reviewAppItems.length > 0
        ? { id: 'review_apps', label: t.sections.chat.historyGroups.reviewApps, items: sortHistoryItemsByRecentActivity(reviewAppItems) }
        : null,
      ...Array.from(appGroups.values()).map((group) => ({
        ...group,
        items: sortHistoryItemsByRecentActivity(group.items),
      })),
      freeChatItems.length > 0
        ? { id: 'free_chat', label: t.sections.chat.historyGroups.freeChat, items: sortHistoryItemsByRecentActivity(freeChatItems) }
        : null,
    ].filter((group): group is ConversationHistoryGroup => Boolean(group)));
  }, [
    getAppMeta,
    historyItems,
    t.sections.chat.historyGroups.createApps,
    t.sections.chat.historyGroups.freeChat,
    t.sections.chat.historyGroups.reviewApps,
  ]);
  const refreshCodexUsageForTooltip = async () => {
    if (!codexProviderConfigured || codexUsageLoading) {
      return;
    }
    const hasFreshUsage = codexUsageBucket && Date.now() - codexUsageCheckedAtRef.current < CODEX_USAGE_TOOLTIP_CACHE_MS;
    if (hasFreshUsage) {
      return;
    }
    setCodexUsageLoading(true);
    setCodexUsageError(false);
    try {
      const nextStatus = await onRefreshCodexUsage();
      setCodexUsageStatus(nextStatus);
      codexUsageCheckedAtRef.current = Date.now();
    } catch {
      setCodexUsageError(true);
    } finally {
      setCodexUsageLoading(false);
    }
  };
  const codexUsageTooltipTitle = !codexProviderConfigured ? (
    t.sections.chat.quotaCodexRequired
  ) : codexUsageBucket ? (
    <CodexUsageTooltipContent bucket={codexUsageBucket} loading={codexUsageLoading} t={t} />
  ) : codexUsageLoading ? (
    <Stack direction="row" spacing={1} alignItems="center">
      <CircularProgress color="inherit" size={14} />
      <Typography variant="caption">{t.sections.chat.quotaLoading}</Typography>
    </Stack>
  ) : codexUsageError ? (
    <Typography variant="caption">{t.sections.chat.quotaUnavailable}</Typography>
  ) : (
    t.sections.chat.quotaOpenDashboard
  );

  useEffect(() => {
    setDraftMode('create_app');
    setDraftTargetAppId(targetAppId ?? '');
  }, [activeConversationId, targetAppId]);

  useEffect(() => {
    if (!isMacOs) {
      return undefined;
    }

    let mounted = true;
    const desktopApi = window.forger;

    void desktopApi
      .getWindowState()
      .then((state) => {
        if (mounted) {
          setWindowState(state);
        }
      })
      .catch(() => undefined);

    const removeListener = desktopApi.onWindowStateChanged((state) => {
      setWindowState(state);
    });

    return () => {
      mounted = false;
      removeListener();
    };
  }, []);

  const respondToPermission = (runId: string, requestId: string, decision: 'allow' | 'deny') => {
    const key = `${runId}:${requestId}`;
    if (respondingPermissionIds.has(key)) {
      return;
    }
    setRespondingPermissionIds((current) => new Set(current).add(key));
    void onRespondPermission(runId, requestId, decision);
  };

  const respondToQuestion = (runId: string, request: ChatQuestionRequest, response: ChatQuestionResponse) => {
    if (respondingQuestionRequestIds.has(request.requestId)) {
      return;
    }
    setRespondingQuestionRequestIds((current) => new Set(current).add(request.requestId));
    void onRespondQuestion(runId, request, response).finally(() => {
      setRespondingQuestionRequestIds((current) => {
        const next = new Set(current);
        next.delete(request.requestId);
        return next;
      });
    });
  };

  const handleStopRun = async () => {
    if (!canStopRun || stopBusy) {
      return;
    }
    setStopBusy(true);
    try {
      await onStopRun();
    } finally {
      setStopBusy(false);
    }
  };

  const sendComposerMessage = () => {
    if (!canSendCurrentMode) {
      return;
    }
    onSend(pendingModeOverride);
  };

  const serializeComposerText = () => {
    const root = inputRef.current;
    if (!root) {
      return '';
    }
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-file-chip]').forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trimEnd())
      .join('\n')
      .trimStart();
  };

  const getMentionIdsInComposer = () => {
    const root = inputRef.current;
    if (!root) {
      return [];
    }
    return Array.from(root.querySelectorAll<HTMLElement>('[data-file-chip-id]'))
      .map((node) => node.dataset.fileChipId)
      .filter((id): id is string => Boolean(id));
  };

  const getTextBeforeCaret = () => {
    const root = inputRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) {
      return serializeComposerText();
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer)) {
      return serializeComposerText();
    }
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(root);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const fragment = beforeRange.cloneContents();
    fragment.querySelectorAll?.('[data-file-chip]').forEach((node) => node.remove());
    return (fragment.textContent ?? '').replace(/\u00a0/g, ' ');
  };

  const syncComposerText = () => {
    const value = serializeComposerText();
    onInputChange(value);
    const existingMentionIds = getMentionIdsInComposer();
    mentionedFiles.forEach((file) => {
      if (!existingMentionIds.includes(file.id)) {
        onRemoveMentionedFile(file.id);
      }
    });
    const match = getTextBeforeCaret().match(/(?:^|\s)@([^\s@]*)$/);
    if (match) {
      const root = composerAnchorRef.current;
      const selection = window.getSelection();
      if (root && selection && selection.rangeCount > 0) {
        const caretRect = selection.getRangeAt(0).getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        if (caretRect.top || caretRect.left) {
          setMentionMenuPosition({
            left: Math.max(8, Math.min(caretRect.left - rootRect.left - 18, rootRect.width - 232)),
            bottom: Math.max(58, rootRect.bottom - caretRect.top + 8),
          });
        }
      }
    } else {
      setMentionMenuPosition(null);
    }
    setMentionQuery(match ? match[1] : null);
  };

  const makeMentionChip = (file: ForgerFileRecord) => {
    const chip = document.createElement('span');
    chip.setAttribute('contenteditable', 'false');
    chip.dataset.fileChip = 'true';
    chip.dataset.fileChipId = file.id;
    chip.textContent = `@${file.name}`;
    chip.className = 'forger-inline-file-chip';

    const close = document.createElement('span');
    close.dataset.fileChipRemove = 'true';
    close.textContent = 'x';
    close.className = 'forger-inline-file-chip-remove';
    chip.appendChild(close);
    return chip;
  };

  const handleSelectMention = (file: ForgerFileRecord) => {
    const root = inputRef.current;
    const selection = window.getSelection();
    if (root && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (root.contains(range.startContainer)) {
        const textNode = range.startContainer;
        if (textNode.nodeType === Node.TEXT_NODE) {
          const text = textNode.textContent ?? '';
          const before = text.slice(0, range.startOffset);
          const match = before.match(/(?:^|\s)@([^\s@]*)$/);
          if (match?.index !== undefined) {
            range.setStart(textNode, match.index + (match[0].startsWith(' ') ? 1 : 0));
          }
        }
        range.deleteContents();
        const fragment = document.createDocumentFragment();
        const chip = makeMentionChip(file);
        const trailingSpace = document.createTextNode(' ');
        fragment.append(chip, trailingSpace);
        range.insertNode(fragment);
        range.setStartAfter(trailingSpace);
        range.setEndAfter(trailingSpace);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    onMentionFile(file);
    setMentionQuery(null);
    setMentionMenuPosition(null);
    inputRef.current?.focus();
    window.setTimeout(syncComposerText, 0);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const imageItems = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.toLowerCase().startsWith('image/'));
    const text = event.clipboardData.getData('text/plain');
    if (imageItems.length === 0) {
      event.preventDefault();
      document.execCommand('insertText', false, text);
      window.setTimeout(syncComposerText, 0);
      return;
    }

    event.preventDefault();
    if (text) {
      document.execCommand('insertText', false, text);
    }
    void Promise.all(
      imageItems.map(async (item, index) => {
        const file = item.getAsFile();
        if (!file) {
          return;
        }
        const dataBase64 = await readFileAsBase64(file);
        await onStagePastedFile({
          name: file.name || `imagen-pegada-${index + 1}`,
          mimeType: file.type,
          dataBase64,
        });
      }),
    )
      .catch((error) => {
        console.warn('Could not stage pasted chat image', error);
      })
      .finally(() => {
        window.setTimeout(syncComposerText, 0);
      });
  };

  const compactSelectMenuProps = {
    PaperProps: {
      sx: {
        mt: 0.5,
        borderRadius: 1.5,
        maxHeight: 240,
        '& .MuiMenuItem-root': {
          minHeight: 32,
          py: 0.75,
          fontSize: 13,
        },
      },
    },
    MenuListProps: {
      dense: true,
    },
  } as const;

  useEffect(() => {
    if (!intelligenceProviderConfigured) {
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, intelligenceProviderConfigured]);

  useEffect(() => {
    const root = inputRef.current;
    if (!root) return;
    // Mention chips are stored as inline DOM nodes the composer manages
    // directly; bail out so we never wipe them by overwriting textContent.
    if (mentionedFiles.length > 0) return;

    // The composer is a contenteditable, but `inputValue` is the
    // controlled mirror. They normally stay in sync because typing
    // funnels through `syncComposerText → onInputChange`. When the
    // controlled value changes from outside (clear after send, deep-link
    // prefill, etc.) we have to push it into the DOM ourselves.
    const currentText = serializeComposerText();
    if (currentText === inputValue) return;

    root.textContent = inputValue;
    if (inputValue) {
      // Place the caret at the end so the user can keep typing after the
      // injected text instead of finding the cursor at position 0.
      const range = document.createRange();
      range.selectNodeContents(root);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [inputValue, mentionedFiles.length]);

  useEffect(() => {
    const scrollEl = messagesScrollRef.current;
    if (!scrollEl || !shouldAutoScrollRef.current) {
      return;
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }, [messages.length, isResponding, progressLines.length]);

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Tooltip title={t.sections.chat.showHistoryTooltip}>
          <span>
            <IconButton
              aria-label={t.sections.chat.showHistoryTooltip}
              onClick={() => setHistoryOpen(true)}
              size="small"
            >
              <HistoryRounded fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Stack direction="row" spacing={1} alignItems="center">
          {chatMode === 'social_app_review' ? (
            <>
              <Button
                size="small"
                variant="contained"
                startIcon={<AddRounded fontSize="small" />}
                onClick={onInstallReviewedSocialApp}
                sx={{ minHeight: 32, px: 1.25 }}
              >
                {t.social.reviewInstallAction}
              </Button>
              <Button
                size="small"
                color="error"
                variant="outlined"
                startIcon={<DeleteOutlineRounded fontSize="small" />}
                onClick={onDeleteReviewedSocialApp}
                sx={{ minHeight: 32, px: 1.25 }}
              >
                {t.social.reviewDeleteAction}
              </Button>
            </>
          ) : null}
          {activeConversationId && onNotifyForger ? (
            <Tooltip title={t.sections.chat.notifyForgerTooltip}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<BugReportRounded fontSize="small" />}
                  onClick={onNotifyForger}
                  sx={{ minHeight: 32, px: 1.25 }}
                >
                  {t.sections.chat.notifyForger}
                </Button>
              </span>
            </Tooltip>
          ) : null}
        </Stack>
        <Drawer
          anchor="left"
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          PaperProps={{
            sx: {
              width: 360,
              bgcolor: theme.palette.background.default,
              borderRight: `1px solid ${theme.palette.divider}`,
              WebkitAppRegion: 'no-drag',
            },
          }}
        >
          {historyItems.length === 0 ? (
            <Box sx={{ px: 2, pb: 2, pt: shouldReserveMacTrafficLightSpace ? 6 : 2, WebkitAppRegion: 'no-drag' }}>
              <Typography variant="body2" color="text.secondary">
                {t.sections.chat.noHistory}
              </Typography>
            </Box>
          ) : (
            <Box sx={{ px: 1.25, pb: 1.5, pt: shouldReserveMacTrafficLightSpace ? 5.25 : 1.25, WebkitAppRegion: 'no-drag' }}>
              <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {historyGroups.map((group) => {
                  const collapsed = collapsedHistoryGroups[group.id] === true;
                  const visibleLimit = historyGroupLimits[group.id] ?? HISTORY_INITIAL_LIMIT;
                  const visibleItems = group.items.slice(0, visibleLimit);
                  const remainingItems = group.items.length - visibleItems.length;

                  return (
                    <Box key={group.id}>
                      <ListItemButton
                        onClick={() => {
                          setCollapsedHistoryGroups((current) => ({
                            ...current,
                            [group.id]: current[group.id] !== true,
                          }));
                        }}
                        sx={{
                          minHeight: 32,
                          borderRadius: 1,
                          px: 0.75,
                          py: 0.25,
                          color: 'text.secondary',
                        }}
                      >
                        <Box sx={{ width: 24, display: 'flex', alignItems: 'center', color: 'text.secondary' }}>
                          {collapsed ? <ChevronRightRounded fontSize="small" /> : <ExpandMoreRounded fontSize="small" />}
                        </Box>
                        <Typography
                          variant="body2"
                          noWrap
                          sx={{ flex: 1, minWidth: 0, fontWeight: 650, color: 'text.primary' }}
                        >
                          {group.label}
                        </Typography>
                      </ListItemButton>
                      <Collapse in={!collapsed} timeout="auto" unmountOnExit>
                        <List disablePadding sx={{ pl: 3.25, pr: 0.5 }}>
                          {visibleItems.map((item) => (
                            <ListItem
                              key={item.id}
                              disablePadding
                              secondaryAction={
                                <Tooltip title={t.sections.chat.deleteConversationTooltip}>
                                  <span>
                                    <IconButton
                                      edge="end"
                                      size="small"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        onDeleteConversation(item.id);
                                      }}
                                      sx={{ color: 'text.secondary' }}
                                    >
                                      <DeleteOutlineRounded fontSize="small" />
                                    </IconButton>
                                  </span>
                                </Tooltip>
                              }
                              sx={{
                                '& .MuiListItemSecondaryAction-root': {
                                  right: 0,
                                },
                              }}
                            >
                              <ListItemButton
                                selected={item.id === activeConversationId}
                                onClick={() => {
                                  onOpenConversation(item.id);
                                  setHistoryOpen(false);
                                }}
                                sx={{
                                  minHeight: 34,
                                  borderRadius: 1,
                                  py: 0.25,
                                  pl: 0.75,
                                  pr: 5.75,
                                  '&.Mui-selected': {
                                    bgcolor: theme.palette.action.selected,
                                  },
                                }}
                              >
                                <ListItemText
                                  primary={
                                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                                      <Typography
                                        variant="body2"
                                        noWrap
                                        sx={{ flex: 1, minWidth: 0, color: 'text.primary' }}
                                      >
                                        {item.title}
                                      </Typography>
                                      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
                                        {formatRelativeHistoryTime(item.updatedAt, t.sections.chat.historyNow)}
                                      </Typography>
                                    </Stack>
                                  }
                                  sx={{ m: 0 }}
                                />
                              </ListItemButton>
                            </ListItem>
                          ))}
                          {remainingItems > 0 ? (
                            <ListItem disablePadding>
                              <ListItemButton
                                onClick={() => {
                                  setHistoryGroupLimits((current) => ({
                                    ...current,
                                    [group.id]: visibleLimit + HISTORY_LIMIT_STEP,
                                  }));
                                }}
                                sx={{
                                  minHeight: 32,
                                  borderRadius: 1,
                                  px: 0.75,
                                  py: 0.25,
                                  color: 'text.secondary',
                                }}
                              >
                                <Typography variant="body2">{t.sections.chat.showMoreHistory}</Typography>
                              </ListItemButton>
                            </ListItem>
                          ) : null}
                        </List>
                      </Collapse>
                    </Box>
                  );
                })}
              </List>
            </Box>
          )}
        </Drawer>
      </Box>

      {!chatMode ? (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            placeItems: 'center',
            px: 2,
          }}
        >
          <Box
            sx={{
              width: 'min(560px, 100%)',
            }}
          >
            <Stack spacing={2.25}>
              <Stack spacing={0.5} textAlign="center">
                <Typography variant="h5">{t.sections.chat.modeSelector.title}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {t.sections.chat.modeSelector.subtitle}
                </Typography>
              </Stack>

              <FormControl fullWidth>
                <Select
                  labelId="chat-mode-select-label"
                  inputProps={{ 'aria-label': t.sections.chat.modeSelector.label }}
                  value={draftMode}
                  onChange={(event) => setDraftMode(event.target.value as ChatMode)}
                  renderValue={(value) => modeOptions[value as keyof typeof modeOptions].title}
                >
                  {(['create_app', 'edit_app', 'free_chat'] as Array<keyof typeof modeOptions>).map((mode) => (
                    <MenuItem key={mode} value={mode}>
                      <Stack spacing={0.25}>
                        <Typography variant="body2" fontWeight={700}>
                          {modeOptions[mode].title}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {modeOptions[mode].description}
                        </Typography>
                      </Stack>
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {draftMode === 'edit_app' ? (
                installedApps.length > 0 ? (
                  <FormControl fullWidth>
                    <Typography
                      id="chat-target-app-select-label"
                      variant="caption"
                      color="text.secondary"
                      sx={{ mb: 0.75, fontWeight: 600 }}
                    >
                      {t.sections.chat.modeSelector.appLabel}
                    </Typography>
                    <Select
                      labelId="chat-target-app-select-label"
                      inputProps={{ 'aria-label': t.sections.chat.modeSelector.appLabel }}
                      value={draftTargetAppId}
                      onChange={(event) => setDraftTargetAppId(event.target.value)}
                      displayEmpty
                      renderValue={(value) => {
                        if (!value) {
                          return <Typography color="text.secondary">{t.sections.chat.modeSelector.appPlaceholder}</Typography>;
                        }
                        return getAppMeta(value).name;
                      }}
                    >
                      {installedApps.map((app) => (
                        <MenuItem key={app.id} value={app.id}>
                          <Stack spacing={0.25}>
                            <Typography variant="body2">{getAppMeta(app.id).name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {app.status === 'running' ? t.actions.running : t.actions.installed}
                            </Typography>
                          </Stack>
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                ) : (
                  <Stack spacing={1.25} alignItems="flex-start">
                    <Typography variant="body2" color="text.secondary">
                      {t.sections.chat.modeSelector.noInstalledApps}
                    </Typography>
                  </Stack>
                )
              ) : null}
            </Stack>
          </Box>
        </Box>
      ) : (
        <ChatMessagesPanel
          messages={messages}
          conversationTitle={conversationTitle}
          intelligenceProviderConfigured={intelligenceProviderConfigured}
          assistantAvatarSrc={assistantAvatarSrc}
          isSending={isResponding}
          progressLines={progressLines}
          openingAppIds={openingAppIds}
          respondingPermissionIds={respondingPermissionIds}
          scrollRef={messagesScrollRef}
          t={t}
          onConfigureIntelligenceProvider={onConfigureIntelligenceProvider}
          onOpenApp={onOpenApp}
          onRespondPermission={respondToPermission}
          onAutoScrollChange={(shouldAutoScroll) => {
            shouldAutoScrollRef.current = shouldAutoScroll;
          }}
        />
      )}

      <Stack spacing={1}>
        <Box ref={composerAnchorRef} sx={{ position: 'relative' }}>
          <Paper
            variant="outlined"
            sx={{
              borderRadius: 2,
              px: 1,
              pt: 0.9,
              pb: 0.8,
              bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'background.paper',
              borderColor: theme.palette.divider,
            }}
          >
            {activeQuestionAction ? (
              <QuestionComposer
                action={activeQuestionAction}
                isResponding={respondingQuestionRequestIds.has(activeQuestionAction.request.requestId)}
                t={t}
                onRespondQuestion={respondToQuestion}
              />
            ) : !intelligenceProviderConfigured ? (
              <Stack spacing={1.25} alignItems="flex-start" sx={{ minHeight: 92, px: 0.75, py: 0.75 }}>
                <Stack spacing={0.35}>
                  <Typography variant="subtitle2">{t.sections.chat.inputProviderMissingTitle}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 560 }}>
                    {t.sections.chat.inputProviderMissingBody}
                  </Typography>
                </Stack>
                <Button variant="contained" size="small" onClick={onConfigureIntelligenceProvider}>
                  {t.sections.chat.inputProviderMissingAction}
                </Button>
              </Stack>
            ) : (
              <>
                <Box
                  onClick={() => inputRef.current?.focus()}
                  sx={{
                    minHeight: 92,
                    borderRadius: 1.5,
                    px: 0.4,
                    py: 0.25,
                    cursor: 'text',
                  }}
                >
                  {pendingFiles.length > 0 ? (
                    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" sx={{ mb: 0.5 }}>
                      {pendingFiles.map((file) => (
                        <Chip
                          key={file.sourcePath}
                          label={compactFileName(file.name)}
                          size="small"
                          onDelete={() => onRemovePendingFile(file.sourcePath)}
                          deleteIcon={<CloseRounded />}
                          sx={{
                            height: 24,
                            maxWidth: 188,
                            borderRadius: 1.25,
                            fontSize: 12,
                            '& .MuiChip-label': {
                              pl: 1,
                              pr: 0.25,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            },
                            '& .MuiChip-deleteIcon': { fontSize: 16 },
                          }}
                        />
                      ))}
                    </Stack>
                  ) : null}

                  <Box
                    component="div"
                    ref={inputRef}
                    contentEditable={intelligenceProviderConfigured}
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label={intelligenceProviderConfigured ? t.sections.chat.inputPlaceholder : t.sections.chat.inputProviderMissingPlaceholder}
                    data-placeholder={intelligenceProviderConfigured ? t.sections.chat.inputPlaceholder : t.sections.chat.inputProviderMissingPlaceholder}
                    onInput={syncComposerText}
                    onPaste={handlePaste}
                    onClick={(event) => {
                      const removeTarget = (event.target as HTMLElement).closest<HTMLElement>('[data-file-chip-remove]');
                      const chip = removeTarget?.closest<HTMLElement>('[data-file-chip-id]');
                      const fileId = chip?.dataset.fileChipId;
                      if (chip && fileId) {
                        chip.remove();
                        onRemoveMentionedFile(fileId);
                        syncComposerText();
                      }
                    }}
                    onKeyDown={(event) => {
                      if (!intelligenceProviderConfigured) {
                        return;
                      }
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        if (!isSending && canSendCurrentMode && (serializeComposerText().trim() || pendingFiles.length > 0 || mentionedFiles.length > 0)) {
                          sendComposerMessage();
                        }
                      }
                    }}
                    sx={{
                      width: '100%',
                      minHeight: 56,
                      maxHeight: 140,
                      overflowY: 'auto',
                      border: 0,
                      outline: 0,
                      bgcolor: 'transparent',
                      color: 'text.primary',
                      font: 'inherit',
                      fontSize: theme.typography.body1.fontSize,
                      lineHeight: 1.45,
                      p: 0.35,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      '&:empty::before': {
                        content: 'attr(data-placeholder)',
                        color: theme.palette.text.disabled,
                        pointerEvents: 'none',
                      },
                      '& .forger-inline-file-chip': {
                        display: 'inline-flex',
                        alignItems: 'center',
                        maxWidth: 190,
                        height: 24,
                        mx: 0.25,
                        px: 0.75,
                        borderRadius: 1.25,
                        bgcolor: 'rgba(124,58,237,0.16)',
                        border: `1px solid ${theme.palette.secondary.main}`,
                        color: theme.palette.secondary.main,
                        fontSize: 12,
                        fontWeight: 600,
                        lineHeight: 1,
                        verticalAlign: 'baseline',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                      '& .forger-inline-file-chip-remove': {
                        ml: 0.5,
                        color: theme.palette.text.secondary,
                        cursor: 'pointer',
                        fontSize: 13,
                        lineHeight: '14px',
                        height: 14,
                        width: 14,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        alignSelf: 'center',
                      },
                    }}
                  />
                </Box>

                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                <Tooltip title={t.sections.chat.attachFiles}>
                  <span>
                    <IconButton size="small" onClick={onPickFiles} disabled={isSending || !intelligenceProviderConfigured}>
                      <AttachFileRounded fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                {pendingFiles.length > 0 ? (
                  <>
                    <Select
                      size="small"
                      value={uploadCategoryPath}
                      onChange={(event) => onUploadCategoryChange(event.target.value)}
                      displayEmpty
                      renderValue={(value) => compactCategoryLabel(String(value), fileCategories, t.sections.chat.rootCategory)}
                      MenuProps={compactSelectMenuProps}
                      sx={{
                        minWidth: 76,
                        maxWidth: 120,
                        height: 28,
                        fontSize: 12,
                        borderRadius: 1.25,
                        '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                      }}
                    >
                      <MenuItem value="">{t.sections.chat.rootCategory}</MenuItem>
                      {fileCategories.map((category) => (
                        <MenuItem key={category.path} value={category.path}>{category.name}</MenuItem>
                      ))}
                    </Select>
                    <Tooltip title={t.sections.files.createCategory}>
                      <IconButton size="small" onClick={onCreateUploadCategory} disabled={isSending || !intelligenceProviderConfigured}>
                        <AddRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </>
                ) : null}
              </Stack>

              <Stack direction="row" spacing={0.75} alignItems="center">
                <Tooltip title={codexUsageTooltipTitle}>
                  <span onMouseEnter={() => void refreshCodexUsageForTooltip()} onFocus={() => void refreshCodexUsageForTooltip()}>
                    <IconButton size="small" onClick={onOpenCodexUsageDashboard} disabled={!codexProviderConfigured}>
                      <DonutLargeRounded fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={runtimeMenuOpen ? '' : providerLocked ? t.sections.chat.lockedRuntimeTooltip : t.sections.chat.providerSelectorLabel}>
                  <span>
                    <Select
                      size="small"
                      value={selectedProviderValue}
                      displayEmpty
                      onChange={(event) => onSelectProvider(event.target.value as AgentProvider | 'auto')}
                      {...runtimeMenuHandlers}
                      disabled={providerLocked || isSending || providerOptions.length === 0}
                      MenuProps={compactSelectMenuProps}
                      inputProps={{ 'aria-label': t.sections.chat.providerSelectorLabel }}
                      renderValue={(value) => renderProviderValue(value as AgentProvider | 'auto' | '')}
                      sx={{
                        height: 28,
                        minWidth: 98,
                        fontSize: 12,
                        borderRadius: 1.25,
                        '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                      }}
                    >
                      {providerOptions.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.value === 'auto' ? t.sections.chat.autoProviderLabel(providerLabel(resolvedProviderForAuto)) : option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </span>
                </Tooltip>
                <Tooltip title={runtimeMenuOpen ? '' : selectedPermissionMode === 'unsafe' ? t.sections.chat.permissionElevatedTooltip : t.sections.chat.permissionNormalTooltip}>
                  <span>
                    <Select
                      size="small"
                      value={selectedPermissionMode}
                      onChange={(event) => onSelectPermissionMode(event.target.value as AgentPermissionMode)}
                      {...runtimeMenuHandlers}
                      disabled={isSending}
                      MenuProps={compactSelectMenuProps}
                      inputProps={{ 'aria-label': t.sections.chat.permissionSelectorLabel }}
                      sx={{
                        height: 28,
                        minWidth: 132,
                        fontSize: 12,
                        borderRadius: 1.25,
                        '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                      }}
                    >
                      <MenuItem value="safe">{t.sections.chat.permissionNormalLabel}</MenuItem>
                      <MenuItem value="unsafe">{t.sections.chat.permissionElevatedLabel}</MenuItem>
                    </Select>
                  </span>
                </Tooltip>
                <Tooltip title={runtimeMenuOpen ? '' : selectedNetworkAccess ? t.sections.chat.networkEnabledTooltip : t.sections.chat.networkDisabledTooltip}>
                  <span>
                    <Select
                      size="small"
                      value={selectedNetworkAccess ? 'enabled' : 'disabled'}
                      onChange={(event) => onSelectNetworkAccess(event.target.value === 'enabled')}
                      {...runtimeMenuHandlers}
                      disabled={isSending}
                      MenuProps={compactSelectMenuProps}
                      inputProps={{ 'aria-label': t.sections.chat.networkSelectorLabel }}
                      sx={{
                        height: 28,
                        minWidth: 104,
                        fontSize: 12,
                        borderRadius: 1.25,
                        '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                      }}
                    >
                      <MenuItem value="enabled">{t.sections.chat.networkEnabledLabel}</MenuItem>
                      <MenuItem value="disabled">{t.sections.chat.networkDisabledLabel}</MenuItem>
                    </Select>
                  </span>
                </Tooltip>
                <Tooltip title={runtimeMenuOpen ? '' : t.sections.chat.modelSelectorLabel}>
                  <span>
                    <Select
                      size="small"
                      value={activeModelValue}
                      onChange={(event) => {
                        const model = event.target.value;
                        activeRuntimeControl.onSelectModel(model);
                      }}
                      {...runtimeMenuHandlers}
                      disabled={isSending || activeModelOptions.length <= 1}
                      MenuProps={compactSelectMenuProps}
                      inputProps={{ 'aria-label': t.sections.chat.modelSelectorLabel }}
                      sx={{
                        height: 28,
                        minWidth: 112,
                        fontSize: 12,
                        borderRadius: 1.25,
                        '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                      }}
                    >
                      {activeModelOptions.map((option) => (
                        <MenuItem key={option.realModelName} value={option.realModelName}>
                          {option.displayModelName}
                        </MenuItem>
                      ))}
                    </Select>
                  </span>
                </Tooltip>
                <Tooltip title={runtimeMenuOpen ? '' : t.sections.chat.effortSelectorLabel}>
                  <span>
                    <Select
                      size="small"
                      value={activeEffortValue}
                      onChange={(event) => {
                        activeRuntimeControl.onSelectEffort(event.target.value);
                      }}
                      {...runtimeMenuHandlers}
                      disabled={isSending}
                      MenuProps={compactSelectMenuProps}
                      inputProps={{ 'aria-label': t.sections.chat.effortSelectorLabel }}
                      sx={{
                        height: 28,
                        minWidth: 82,
                        fontSize: 12,
                        borderRadius: 1.25,
                        '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                      }}
                    >
                      {activeEffortOptions.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </span>
                </Tooltip>
              </Stack>
            </Stack>
              </>
            )}
          </Paper>

          {!activeQuestionAction && intelligenceProviderConfigured && mentionQuery !== null ? (
            <Paper
              elevation={8}
              sx={{
                position: 'absolute',
                left: mentionMenuPosition?.left ?? 0,
                right: 'auto',
                bottom: mentionMenuPosition?.bottom ?? 'calc(100% + 8px)',
                width: 228,
                maxHeight: 220,
                overflow: 'auto',
                zIndex: 5,
              }}
            >
              <Box sx={{ px: 1.5, py: 1 }}>
                <Typography variant="caption" color="text.secondary">{t.sections.chat.mentionFilesTitle}</Typography>
              </Box>
              <Divider />
              {matchingFiles.length === 0 ? (
                <Box sx={{ px: 1.5, py: 1 }}>
                  <Typography variant="body2" color="text.secondary">{t.sections.files.noFiles}</Typography>
                </Box>
              ) : (
                <List dense disablePadding>
                  {matchingFiles.map((file) => (
                    <ListItemButton
                      key={file.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSelectMention(file)}
                    >
                      <ListItemText primary={file.name} secondary={file.categoryPath || t.sections.files.root} />
                    </ListItemButton>
                  ))}
                </List>
              )}
            </Paper>
          ) : null}
        </Box>

        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<AddCommentRounded />}
            onClick={onStartNewConversation}
            sx={{ minHeight: 32, px: 1.5 }}
          >
            {t.sections.chat.newConversation}
          </Button>
          <Stack direction="row" spacing={0.75} alignItems="center">
            {isResponding ? (
              <Button
                variant="outlined"
                color="error"
                size="small"
                startIcon={stopBusy ? <CircularProgress size={14} color="inherit" /> : <StopCircleRounded fontSize="small" />}
                onClick={() => void handleStopRun()}
                disabled={!canStopRun || stopBusy}
                sx={{ minHeight: 32, px: 1.5 }}
              >
                {t.sections.chat.stopResponse}
              </Button>
            ) : null}
            {!activeQuestionAction && intelligenceProviderConfigured ? (
              <Button
                variant="contained"
                size="small"
                endIcon={isResponding ? <CircularProgress size={14} color="inherit" /> : <SendRounded fontSize="small" />}
                onClick={sendComposerMessage}
                disabled={isSending || !intelligenceProviderConfigured || !canSendCurrentMode || (!inputValue.trim() && pendingFiles.length === 0 && mentionedFiles.length === 0)}
                sx={{ minHeight: 32, px: 1.5 }}
              >
                {t.sections.chat.send}
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Stack>
    </Box>
  );
}
