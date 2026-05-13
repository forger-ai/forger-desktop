import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SendRounded from '@mui/icons-material/SendRounded';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import type { CloudMessage, ForgerAccountSession } from '@shared/types';

interface FriendChatWindowViewProps {
  account: ForgerAccountSession;
  friendUserId: number;
  friendUsername: string;
  friendDisplayName: string;
}

const formatMessageTime = (value: string) =>
  new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

const sortMessages = (entries: CloudMessage[]) =>
  [...entries].sort((left, right) => {
    const leftTime = new Date(left.createdAt).getTime();
    const rightTime = new Date(right.createdAt).getTime();
    return leftTime - rightTime;
  });

export function FriendChatWindowView({
  account,
  friendUserId,
  friendUsername,
  friendDisplayName,
}: FriendChatWindowViewProps) {
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const loadMessages = useCallback(async () => {
    if (!account.authenticated || !account.user?.confirmed) {
      setMessages([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await window.forger.listCloudMessages(friendUserId);
      setMessages(sortMessages(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos cargar esta conversación.');
    } finally {
      setLoading(false);
    }
  }, [account.authenticated, account.user?.confirmed, friendUserId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    const removeListener = window.forger.onCloudFriendshipEvent(() => {
      void loadMessages();
    });
    return removeListener;
  }, [loadMessages]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      const sent = await window.forger.sendCloudMessage({
        recipientUserId: friendUserId,
        text,
        delivery: 'persistent',
        source: 'user',
      });
      setMessages((current) => sortMessages([...current, sent]));
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos enviar el mensaje.');
    } finally {
      setSending(false);
    }
  };

  const sortedMessages = useMemo(() => sortMessages(messages), [messages]);

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: alpha(theme.palette.background.default, 0.98),
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{
          px: 2,
          py: 1.5,
          borderBottom: `1px solid ${theme.palette.divider}`,
          bgcolor: alpha(theme.palette.background.paper, 0.92),
        }}
      >
        <Avatar sx={{ width: 42, height: 42 }}>
          {friendDisplayName.slice(0, 1).toUpperCase()}
        </Avatar>
        <Stack sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }} noWrap>
            {friendDisplayName}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            @{friendUsername}
          </Typography>
        </Stack>
        <Chip size="small" label="Social" variant="outlined" />
      </Stack>

      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: 2,
          py: 1.5,
        }}
      >
        {!account.authenticated || !account.user?.confirmed ? (
          <Alert severity="info">Inicia sesión en Forger Cloud para enviar mensajes.</Alert>
        ) : null}

        {loading ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
            <CircularProgress size={28} />
          </Stack>
        ) : null}

        {!loading && error ? (
          <Stack spacing={1.5}>
            <Alert severity="error">{error}</Alert>
            <Button variant="outlined" onClick={() => void loadMessages()}>
              Reintentar
            </Button>
          </Stack>
        ) : null}

        {!loading && !error && account.authenticated && account.user?.confirmed && sortedMessages.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, textAlign: 'center' }}>
            <Typography variant="body1" sx={{ fontWeight: 600 }}>
              Aún no hay mensajes
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Envía el primero para empezar la conversación.
            </Typography>
          </Paper>
        ) : null}

        {!loading && !error && sortedMessages.length > 0 ? (
          <Stack spacing={1.25}>
            {sortedMessages.map((message, index) => {
              const outgoing = message.sender.id === account.user?.id;
              const key = message.id ?? `${message.clientMessageId ?? 'message'}-${index}`;

              return (
                <Stack key={key} alignItems={outgoing ? 'flex-end' : 'flex-start'}>
                  <Paper
                    elevation={0}
                    sx={{
                      maxWidth: '84%',
                      px: 1.5,
                      py: 1.1,
                      borderRadius: 2.5,
                      bgcolor: outgoing ? theme.palette.primary.main : alpha(theme.palette.background.paper, 0.96),
                      color: outgoing ? theme.palette.primary.contrastText : theme.palette.text.primary,
                      border: `1px solid ${
                        outgoing ? alpha(theme.palette.primary.dark, 0.35) : alpha(theme.palette.divider, 0.8)
                      }`,
                    }}
                  >
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {message.plaintext ?? ''}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        mt: 0.75,
                        display: 'block',
                        color: outgoing
                          ? alpha(theme.palette.primary.contrastText, 0.8)
                          : theme.palette.text.secondary,
                      }}
                    >
                      {formatMessageTime(message.createdAt)}
                    </Typography>
                  </Paper>
                </Stack>
              );
            })}
          </Stack>
        ) : null}
      </Box>

      <Divider />

      <Stack direction="row" spacing={1} alignItems="flex-end" sx={{ p: 1.5 }}>
        <TextField
          fullWidth
          multiline
          maxRows={4}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          disabled={!account.authenticated || !account.user?.confirmed || sending}
          placeholder={`Escribe a @${friendUsername}`}
        />
        <IconButton
          color="primary"
          onClick={() => void handleSend()}
          disabled={!draft.trim() || sending || !account.authenticated || !account.user?.confirmed}
          sx={{
            width: 44,
            height: 44,
            borderRadius: 2,
            bgcolor: draft.trim() ? theme.palette.primary.main : alpha(theme.palette.action.disabled, 0.12),
            color: draft.trim() ? theme.palette.primary.contrastText : theme.palette.text.disabled,
            '&:hover': {
              bgcolor: draft.trim() ? theme.palette.primary.dark : alpha(theme.palette.action.disabled, 0.12),
            },
          }}
        >
          <SendRounded />
        </IconButton>
      </Stack>
    </Box>
  );
}
