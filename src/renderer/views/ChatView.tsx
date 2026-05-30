import SendRounded from '@mui/icons-material/SendRounded';
import AddCommentRounded from '@mui/icons-material/AddCommentRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DonutLargeRounded from '@mui/icons-material/DonutLargeRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import BugReportRounded from '@mui/icons-material/BugReportRounded';
import StopCircleRounded from '@mui/icons-material/StopCircleRounded';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  FormControl,
  IconButton,
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
  ClaudeEffort,
  CodexModelOption,
  CodexReasoningEffort,
  ForgerFileCategory,
  ForgerFileRecord,
  FilesStageForChatInput,
  PermissionRequest,
  PickedChatFile,
} from '@shared/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import { compactCategoryLabel, compactFileName } from './chat-view-helpers';
import { ChatMessagesPanel } from './chat/ChatMessagesPanel';
import { QuestionComposer, type QuestionAction } from './chat/QuestionComposer';

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
}

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
  modelOptions: CodexModelOption[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
  reasoningOptions: { label: string; value: CodexReasoningEffort }[];
  selectedReasoningEffort: CodexReasoningEffort;
  onSelectReasoningEffort: (reasoningEffort: CodexReasoningEffort) => void;
  claudeModelOptions: Array<{ displayModelName: string; realModelName: string }>;
  selectedClaudeModel: string;
  onSelectClaudeModel: (model: string) => void;
  claudeEffortOptions: { label: string; value: ClaudeEffort }[];
  selectedClaudeEffort: ClaudeEffort;
  onSelectClaudeEffort: (effort: ClaudeEffort) => void;
  selectedPermissionMode: AgentPermissionMode;
  onSelectPermissionMode: (mode: AgentPermissionMode) => void;
  onOpenCodexUsageDashboard: () => void;
  assistantAvatarSrc: string;
  isSending: boolean;
  isResponding: boolean;
  canStopRun: boolean;
  progressLines: string[];
  codexConfigured: boolean;
  onConfigureCodex: () => void;
  openingAppIds: Set<string>;
  onOpenApp: (appId: string) => void;
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
  modelOptions,
  selectedModel,
  onSelectModel,
  reasoningOptions,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  claudeModelOptions,
  selectedClaudeModel,
  onSelectClaudeModel,
  claudeEffortOptions,
  selectedClaudeEffort,
  onSelectClaudeEffort,
  selectedPermissionMode,
  onSelectPermissionMode,
  onOpenCodexUsageDashboard,
  assistantAvatarSrc,
  isSending,
  isResponding,
  canStopRun,
  progressLines,
  codexConfigured,
  onConfigureCodex,
  openingAppIds,
  onOpenApp,
  onStopRun,
  onRespondPermission,
  onRespondQuestion,
}: ChatViewProps) {
  const theme = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionMenuPosition, setMentionMenuPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [respondingPermissionIds, setRespondingPermissionIds] = useState<Set<string>>(new Set());
  const [respondingQuestionRequestIds, setRespondingQuestionRequestIds] = useState<Set<string>>(new Set());
  const [stopBusy, setStopBusy] = useState(false);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<ChatMode>('create_app');
  const [draftTargetAppId, setDraftTargetAppId] = useState('');
  const inputRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
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
  const activeModelOptions = effectiveProvider === 'claude' ? claudeModelOptions : modelOptions;
  const activeModelValue = effectiveProvider === 'claude' ? selectedClaudeModel : selectedModel;
  const activeEffortOptions = effectiveProvider === 'claude' ? claudeEffortOptions : reasoningOptions;
  const activeEffortValue = effectiveProvider === 'claude' ? selectedClaudeEffort : selectedReasoningEffort;

  useEffect(() => {
    setDraftMode('create_app');
    setDraftTargetAppId(targetAppId ?? '');
  }, [activeConversationId, targetAppId]);

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
    if (!codexConfigured) {
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, codexConfigured]);

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
        <Drawer
          anchor="left"
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          PaperProps={{ sx: { width: 360 } }}
        >
          <Box sx={{ p: 2 }}>
            <Typography variant="h6">{t.sections.chat.historyTitle}</Typography>
          </Box>
          <Divider />
          {historyItems.length === 0 ? (
            <Box sx={{ p: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {t.sections.chat.noHistory}
              </Typography>
            </Box>
          ) : (
            <List sx={{ py: 0 }}>
              {historyItems.map((item) => (
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
                        >
                          <DeleteOutlineRounded fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  }
                >
                  <ListItemButton
                    selected={item.id === activeConversationId}
                    onClick={() => {
                      onOpenConversation(item.id);
                      setHistoryOpen(false);
                    }}
                  >
                    <ListItemText
                      primary={item.title}
                      secondary={new Date(item.updatedAt).toLocaleString()}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
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
                  renderValue={(value) => modeOptions[value as ChatMode].title}
                >
                  {(['create_app', 'edit_app', 'free_chat'] as ChatMode[]).map((mode) => (
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
          codexConfigured={codexConfigured}
          assistantAvatarSrc={assistantAvatarSrc}
          isSending={isResponding}
          progressLines={progressLines}
          openingAppIds={openingAppIds}
          respondingPermissionIds={respondingPermissionIds}
          scrollRef={messagesScrollRef}
          t={t}
          onConfigureCodex={onConfigureCodex}
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
                    contentEditable={codexConfigured}
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label={t.sections.chat.inputPlaceholder}
                    data-placeholder={t.sections.chat.inputPlaceholder}
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
                      if (!codexConfigured) {
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
                    <IconButton size="small" onClick={onPickFiles} disabled={isSending || !codexConfigured}>
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
                      <IconButton size="small" onClick={onCreateUploadCategory} disabled={isSending || !codexConfigured}>
                        <AddRounded fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </>
                ) : null}
              </Stack>

              <Stack direction="row" spacing={0.75} alignItems="center">
                <Tooltip title={t.sections.chat.quotaOpenDashboard}>
                  <span>
                    <IconButton size="small" onClick={onOpenCodexUsageDashboard} disabled={!codexConfigured}>
                      <DonutLargeRounded fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={runtimeMenuOpen ? '' : providerLocked ? t.sections.chat.lockedRuntimeTooltip : t.sections.chat.providerSelectorLabel}>
                  <span>
                    <Select
                      size="small"
                      value={selectedProvider}
                      onChange={(event) => onSelectProvider(event.target.value as AgentProvider | 'auto')}
                      {...runtimeMenuHandlers}
                      disabled={providerLocked || isSending}
                      MenuProps={compactSelectMenuProps}
                      inputProps={{ 'aria-label': t.sections.chat.providerSelectorLabel }}
                      renderValue={(value) => value === 'auto' ? t.sections.chat.autoProviderLabel(resolvedProviderForAuto === 'claude' ? 'Claude' : 'Codex') : providerOptions.find((option) => option.value === value)?.label}
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
                          {option.value === 'auto' ? t.sections.chat.autoProviderLabel(resolvedProviderForAuto === 'claude' ? 'Claude' : 'Codex') : option.label}
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
                <Tooltip title={runtimeMenuOpen ? '' : providerLocked ? t.sections.chat.lockedRuntimeTooltip : t.sections.chat.modelSelectorLabel}>
                  <span>
                    <Select
                      size="small"
                      value={activeModelValue}
                      onChange={(event) => {
                        const model = event.target.value;
                        if (effectiveProvider === 'claude') {
                          onSelectClaudeModel(model);
                          return;
                        }
                        onSelectModel(model);
                      }}
                      {...runtimeMenuHandlers}
                      disabled={providerLocked || isSending}
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
                <Tooltip title={runtimeMenuOpen ? '' : providerLocked ? t.sections.chat.lockedRuntimeTooltip : t.sections.chat.effortSelectorLabel}>
                  <span>
                    <Select
                      size="small"
                      value={activeEffortValue}
                      onChange={(event) => {
                        const effort = event.target.value;
                        if (effectiveProvider === 'claude') {
                          onSelectClaudeEffort(effort as ClaudeEffort);
                          return;
                        }
                        onSelectReasoningEffort(effort as CodexReasoningEffort);
                      }}
                      {...runtimeMenuHandlers}
                      disabled={providerLocked || isSending}
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

          {!activeQuestionAction && mentionQuery !== null ? (
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
            {!activeQuestionAction ? (
              <Button
                variant="contained"
                size="small"
                endIcon={isResponding ? <CircularProgress size={14} color="inherit" /> : <SendRounded fontSize="small" />}
                onClick={sendComposerMessage}
                disabled={isSending || !codexConfigured || !canSendCurrentMode || (!inputValue.trim() && pendingFiles.length === 0 && mentionedFiles.length === 0)}
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
