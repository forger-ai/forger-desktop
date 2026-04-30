import SendRounded from '@mui/icons-material/SendRounded';
import AddCommentRounded from '@mui/icons-material/AddCommentRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import AttachFileRounded from '@mui/icons-material/AttachFileRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DonutLargeRounded from '@mui/icons-material/DonutLargeRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import {
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
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
  CodexModelOption,
  CodexReasoningEffort,
  ForgerFileCategory,
  ForgerFileRecord,
  PermissionRequest,
  PickedChatFile,
} from '@shared/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useRef, useState } from 'react';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';

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
  };
}

export interface ConversationHistoryItem {
  id: string;
  title: string;
  threadId: string | null;
  updatedAt: string;
}

function MarkdownMessage({ content }: { content: string }) {
  const theme = useTheme();

  return (
    <Box
      sx={{
        fontSize: theme.typography.body2.fontSize,
        lineHeight: 1.55,
        '& > :first-child': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& h1, & h2, & h3, & h4': {
          mt: 1.2,
          mb: 0.9,
          lineHeight: 1.15,
        },
        '& h1:first-of-type, & h2:first-of-type, & h3:first-of-type, & h4:first-of-type': {
          mt: 0,
        },
        '& p': { my: 0.7, lineHeight: 1.55, fontSize: 'inherit' },
        '& ul, & ol': { my: 0.8, pl: 2.5 },
        '& li': { mb: 0.45, fontSize: 'inherit' },
        '& a': {
          color: theme.palette.primary.main,
          textDecorationColor: theme.palette.primary.main,
          textUnderlineOffset: '2px',
          fontWeight: 500,
          transition: 'color 120ms ease',
        },
        '& a:hover': {
          color: theme.palette.primary.light,
        },
        '& code': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          bgcolor: 'rgba(148,163,184,0.18)',
          px: 0.5,
          py: 0.15,
          borderRadius: 1,
          fontSize: '0.88em',
        },
        '& pre': {
          bgcolor: 'rgba(15,23,42,0.6)',
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: 2,
          p: 1.25,
          overflowX: 'auto',
          my: 1,
        },
        '& pre code': {
          bgcolor: 'transparent',
          p: 0,
          borderRadius: 0,
        },
        '& blockquote': {
          my: 1,
          pl: 1.5,
          ml: 0,
          borderLeft: `3px solid ${theme.palette.divider}`,
          color: 'text.secondary',
          fontSize: 'inherit',
        },
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </Box>
  );
}

interface ChatViewProps {
  t: AppDictionary;
  conversationTitle: string;
  activeConversationId: string | null;
  historyItems: ConversationHistoryItem[];
  onOpenConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onStartNewConversation: () => void;
  messages: ChatMessage[];
  inputValue: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  pendingFiles: PickedChatFile[];
  mentionedFiles: ForgerFileRecord[];
  availableFiles: ForgerFileRecord[];
  fileCategories: ForgerFileCategory[];
  uploadCategoryPath: string;
  onUploadCategoryChange: (categoryPath: string) => void;
  onPickFiles: () => void;
  onCreateUploadCategory: () => void;
  onRemovePendingFile: (sourcePath: string) => void;
  onMentionFile: (file: ForgerFileRecord) => void;
  onRemoveMentionedFile: (fileId: string) => void;
  modelOptions: CodexModelOption[];
  selectedModel: string;
  onSelectModel: (model: string) => void;
  reasoningOptions: { label: string; value: CodexReasoningEffort }[];
  selectedReasoningEffort: CodexReasoningEffort;
  onSelectReasoningEffort: (reasoningEffort: CodexReasoningEffort) => void;
  onOpenCodexUsageDashboard: () => void;
  assistantAvatarSrc: string;
  isSending: boolean;
  progressLines: string[];
  codexConfigured: boolean;
  onConfigureCodex: () => void;
  openingAppIds: Set<string>;
  onOpenApp: (appId: string) => void;
  onRespondPermission: (runId: string, requestId: string, decision: 'allow' | 'deny') => Promise<void>;
}

export function ChatView({
  t,
  conversationTitle,
  activeConversationId,
  historyItems,
  onOpenConversation,
  onDeleteConversation,
  onStartNewConversation,
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
  onCreateUploadCategory,
  onRemovePendingFile,
  onMentionFile,
  onRemoveMentionedFile,
  modelOptions,
  selectedModel,
  onSelectModel,
  reasoningOptions,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  onOpenCodexUsageDashboard,
  assistantAvatarSrc,
  isSending,
  progressLines,
  codexConfigured,
  onConfigureCodex,
  openingAppIds,
  onOpenApp,
  onRespondPermission,
}: ChatViewProps) {
  const theme = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionMenuPosition, setMentionMenuPosition] = useState<{ left: number; bottom: number } | null>(null);
  const [respondingPermissionIds, setRespondingPermissionIds] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const hasMessages = messages.length > 0;
  const matchingFiles = mentionQuery === null
    ? []
    : availableFiles
        .filter((file) => file.name.toLowerCase().includes(mentionQuery.toLowerCase()))
        .slice(0, 8);

  const respondToPermission = (runId: string, requestId: string, decision: 'allow' | 'deny') => {
    const key = `${runId}:${requestId}`;
    if (respondingPermissionIds.has(key)) {
      return;
    }
    setRespondingPermissionIds((current) => new Set(current).add(key));
    void onRespondPermission(runId, requestId, decision);
  };

  const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
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

  const compactFileName = (name: string): string => {
    const dotIndex = name.lastIndexOf('.');
    const extension = dotIndex > 0 ? name.slice(dotIndex) : '';
    const base = dotIndex > 0 ? name.slice(0, dotIndex) : name;
    const maxBaseLength = extension ? 18 : 24;
    return base.length > maxBaseLength ? `${base.slice(0, maxBaseLength).trim()}...${extension}` : name;
  };

  const compactCategoryLabel = (value: string): string => {
    if (!value) {
      return t.sections.chat.rootCategory;
    }
    return fileCategories.find((category) => category.path === value)?.name ?? value.split('/').join(' / ');
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
    if (!codexConfigured || isSending) {
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeConversationId, codexConfigured, isSending]);

  useEffect(() => {
    if (!inputValue && mentionedFiles.length === 0 && inputRef.current?.textContent) {
      inputRef.current.textContent = '';
    }
  }, [inputValue, mentionedFiles.length]);

  useEffect(() => {
    const scrollEl = messagesScrollRef.current;
    if (!scrollEl || !shouldAutoScrollRef.current) {
      return;
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
  }, [messages.length, isSending, progressLines.length]);

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
      <Box sx={{ display: 'flex', justifyContent: 'flex-start' }}>
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

      <Box
        ref={messagesScrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
          shouldAutoScrollRef.current = distanceFromBottom <= 4;
        }}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          py: 1,
        }}
      >
        <Stack spacing={2}>
          {!hasMessages ? (
            <Stack alignItems="center" justifyContent="center" sx={{ pt: 6 }} spacing={1}>
              <Typography variant="h4" textAlign="center">
                {conversationTitle}
              </Typography>
              <Typography color="text.secondary" textAlign="center" sx={{ maxWidth: 480 }}>
                {codexConfigured ? t.sections.chat.introBody : t.sections.chat.codexMissingBody}
              </Typography>
              {!codexConfigured ? (
                <Button variant="contained" onClick={onConfigureCodex}>
                  {t.sections.chat.configureCodex}
                </Button>
              ) : null}
            </Stack>
          ) : (
            <>
              {messages.map((message) => (
                <Stack
                  key={message.id}
                  direction="row"
                  spacing={1.25}
                  justifyContent={message.role === 'user' ? 'flex-end' : 'flex-start'}
                >
                  {message.role === 'assistant' ? (
                    <Avatar
                      src={assistantAvatarSrc}
                      sx={{
                        width: 30,
                        height: 30,
                        bgcolor: '#fff',
                        p: 0.05,
                        pb: 0,
                        '& img': { objectFit: 'contain' },
                      }}
                    />
                  ) : null}
                  <Box
                    sx={{
                      maxWidth: message.role === 'user' ? '72%' : '78%',
                      px: message.role === 'user' ? 1.6 : 0,
                      py: message.role === 'user' ? 1.2 : 0,
                      borderRadius: message.role === 'user' ? 1 : 0,
                      bgcolor: message.role === 'user' ? 'primary.main' : 'transparent',
                      color:
                        message.role === 'user'
                          ? theme.palette.primary.contrastText
                          : theme.palette.text.primary,
                    }}
                  >
                    {message.role === 'assistant' ? (
                      <Stack spacing={1}>
                        <MarkdownMessage content={message.content} />
                        {message.action?.type === 'open-app' ? (
                          (() => {
                            const action = message.action;
                            const isOpening = openingAppIds.has(action.appId);
                            return (
                              <Button
                                variant="contained"
                                size="small"
                                startIcon={isOpening ? <CircularProgress color="inherit" size={14} /> : undefined}
                                disabled={isOpening}
                                aria-busy={isOpening}
                                onClick={() => onOpenApp(action.appId)}
                                sx={{ alignSelf: 'flex-start' }}
                              >
                                {isOpening ? t.actions.opening : action.label}
                              </Button>
                            );
                          })()
                        ) : null}
                        {message.action?.type === 'permission' ? (
                          (() => {
                            const action = message.action;
                            const responseKey = `${action.runId}:${action.request.requestId}`;
                            const isResponding = respondingPermissionIds.has(responseKey);
                            return (
                              <Paper
                                variant="outlined"
                                sx={{
                                  p: 1.5,
                                  borderRadius: 1,
                                  bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'background.paper',
                                }}
                              >
                                <Stack spacing={1}>
                                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                                    <Chip size="small" color="warning" label={t.sections.chat.permissionBadge} />
                                    <Chip size="small" variant="outlined" label={action.request.resource} />
                                  </Stack>
                                  <Typography variant="body2" color="text.secondary">
                                    {action.request.reason}
                                  </Typography>
                                  <Stack direction="row" spacing={1}>
                                    <Button
                                      variant="contained"
                                      size="small"
                                      disabled={isResponding}
                                      startIcon={isResponding ? <CircularProgress size={14} color="inherit" /> : undefined}
                                      onClick={() => respondToPermission(action.runId, action.request.requestId, 'allow')}
                                    >
                                      {t.sections.chat.permissionApprove}
                                    </Button>
                                    <Button
                                      variant="outlined"
                                      color="inherit"
                                      size="small"
                                      disabled={isResponding}
                                      onClick={() => respondToPermission(action.runId, action.request.requestId, 'deny')}
                                    >
                                      {t.sections.chat.permissionDeny}
                                    </Button>
                                  </Stack>
                                </Stack>
                              </Paper>
                            );
                          })()
                        ) : null}
                      </Stack>
                    ) : (
                      <Stack spacing={0.85}>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          {message.content}
                        </Typography>
                        {message.files?.length ? (
                          <Stack
                            direction="row"
                            spacing={0.75}
                            flexWrap="wrap"
                            useFlexGap
                            sx={{
                              maxWidth: '100%',
                              alignItems: 'flex-start',
                              overflow: 'hidden',
                            }}
                          >
                            {message.files.map((file) => (
                              <Chip
                                key={`${file.source}-${file.id}`}
                                size="small"
                                label={
                                  file.source === 'mentioned'
                                    ? `@${compactFileName(file.name)}`
                                    : `${compactFileName(file.name)} · ${formatBytes(file.sizeBytes)}`
                                }
                                title={file.displayPath ?? file.relativePath}
                                variant={file.source === 'mentioned' ? 'outlined' : 'filled'}
                                sx={{
                                  boxSizing: 'border-box',
                                  height: 28,
                                  maxWidth: 'min(100%, 280px)',
                                  borderRadius: '999px',
                                  bgcolor: file.source === 'mentioned' ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.2)',
                                  border: '1px solid rgba(255,255,255,0.58)',
                                  color: theme.palette.primary.contrastText,
                                  fontSize: 12,
                                  fontWeight: 700,
                                  '& .MuiChip-label': {
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    display: 'block',
                                    px: 1.25,
                                    lineHeight: '26px',
                                  },
                                }}
                              />
                            ))}
                          </Stack>
                        ) : null}
                      </Stack>
                    )}
                  </Box>
                </Stack>
              ))}
            </>
          )}
          {isSending ? (
            <Stack direction="row" spacing={1.25} alignItems="flex-start">
              <Avatar
                src={assistantAvatarSrc}
                sx={{
                  width: 30,
                  height: 30,
                  bgcolor: '#fff',
                  p: 0.05,
                  pb: 0,
                  '& img': { objectFit: 'contain' },
                }}
              />
              <Box sx={{ maxWidth: '78%', color: 'text.secondary' }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <CircularProgress size={14} />
                  <Typography variant="caption">Codex pensando...</Typography>
                </Stack>
                {progressLines.length > 0 ? (
                  <Box component="ul" sx={{ m: 0, pl: 2 }}>
                    {progressLines.slice(-6).map((line, idx) => (
                      <Typography component="li" variant="caption" key={`${idx}-${line}`}>
                        {line}
                      </Typography>
                    ))}
                  </Box>
                ) : null}
              </Box>
            </Stack>
          ) : null}
        </Stack>
      </Box>

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
                contentEditable={!isSending && codexConfigured}
                suppressContentEditableWarning
                role="textbox"
                aria-label={t.sections.chat.inputPlaceholder}
                data-placeholder={t.sections.chat.inputPlaceholder}
                onInput={syncComposerText}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData.getData('text/plain');
                  document.execCommand('insertText', false, text);
                  window.setTimeout(syncComposerText, 0);
                }}
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
                  if (isSending || !codexConfigured) {
                    return;
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    if (serializeComposerText().trim() || pendingFiles.length > 0 || mentionedFiles.length > 0) {
                      onSend();
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
                      renderValue={(value) => compactCategoryLabel(String(value))}
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
                <Select
                  size="small"
                  value={selectedModel}
                  onChange={(event) => onSelectModel(event.target.value)}
                  MenuProps={compactSelectMenuProps}
                  sx={{
                    height: 28,
                    minWidth: 104,
                    fontSize: 12,
                    borderRadius: 1.25,
                    '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                  }}
                >
                  {modelOptions.map((option) => (
                    <MenuItem key={option.realModelName} value={option.realModelName}>
                      {option.displayModelName}
                    </MenuItem>
                  ))}
                </Select>
                <Select
                  size="small"
                  value={selectedReasoningEffort}
                  onChange={(event) => onSelectReasoningEffort(event.target.value as CodexReasoningEffort)}
                  MenuProps={compactSelectMenuProps}
                  sx={{
                    height: 28,
                    minWidth: 82,
                    fontSize: 12,
                    borderRadius: 1.25,
                    '& .MuiSelect-select': { py: 0.35, pl: 1, pr: '26px !important' },
                  }}
                >
                  {reasoningOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </Stack>
            </Stack>
          </Paper>

          {mentionQuery !== null ? (
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
            disabled={isSending || !codexConfigured}
            sx={{ minHeight: 32, px: 1.5 }}
          >
            {t.sections.chat.newConversation}
          </Button>
          <Button
            variant="contained"
            size="small"
            endIcon={isSending ? <CircularProgress size={14} color="inherit" /> : <SendRounded fontSize="small" />}
            onClick={onSend}
            disabled={isSending || !codexConfigured || (!inputValue.trim() && pendingFiles.length === 0 && mentionedFiles.length === 0)}
            sx={{ minHeight: 32, px: 1.5 }}
          >
            {t.sections.chat.send}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
