import SendRounded from '@mui/icons-material/SendRounded';
import AddCommentRounded from '@mui/icons-material/AddCommentRounded';
import HistoryRounded from '@mui/icons-material/HistoryRounded';
import {
  Avatar,
  Box,
  Button,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';

export interface ChatMessage {
  id: string;
  role: 'assistant' | 'user';
  content: string;
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
  isSending: boolean;
  progressLines: string[];
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
  isSending,
  progressLines,
}: ChatViewProps) {
  const theme = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const hasMessages = messages.length > 0;

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
                {t.sections.chat.introBody}
              </Typography>
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
                    <Avatar sx={{ width: 34, height: 34, bgcolor: 'secondary.main' }}>F</Avatar>
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
                      <MarkdownMessage content={message.content} />
                    ) : (
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                        {message.content}
                      </Typography>
                    )}
                  </Box>
                </Stack>
              ))}
            </>
          )}
          {isSending ? (
            <Stack direction="row" spacing={1.25} alignItems="flex-start">
              <Avatar sx={{ width: 34, height: 34, bgcolor: 'secondary.main' }}>F</Avatar>
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

      <Stack spacing={1.25}>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={4}
          placeholder={t.sections.chat.inputPlaceholder}
          value={inputValue}
          disabled={isSending}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (isSending) {
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <Button
            variant="outlined"
            startIcon={<AddCommentRounded />}
            onClick={onStartNewConversation}
            disabled={isSending}
          >
            {t.sections.chat.newConversation}
          </Button>
          <Button
            variant="contained"
            endIcon={isSending ? <CircularProgress size={16} color="inherit" /> : <SendRounded />}
            onClick={onSend}
            disabled={isSending || !inputValue.trim()}
          >
            {t.sections.chat.send}
          </Button>
        </Stack>
      </Stack>
    </Box>
  );
}
