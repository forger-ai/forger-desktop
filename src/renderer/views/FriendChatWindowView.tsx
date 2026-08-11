import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import AppsRounded from '@mui/icons-material/AppsRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import LinkOffRounded from '@mui/icons-material/LinkOffRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import ShareRounded from '@mui/icons-material/ShareRounded';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import type { CloudAppShareMessage, CloudMessage, CloudSocialEvent, ForgerAccountSession, SocialUserApp } from '@shared/types';

interface FriendChatWindowViewProps {
  account: ForgerAccountSession;
  friendUserId: number;
  friendUsername: string;
  friendDisplayName: string;
}

const messageTimestamp = (value: string) => {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const formatMessageTime = (value: string) => {
  const timestamp = messageTimestamp(value);
  if (!timestamp) {
    return '';
  }
  return new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
};

const sortMessages = (entries: CloudMessage[]) =>
  [...entries].sort((left, right) => {
    const leftTime = messageTimestamp(left.createdAt);
    const rightTime = messageTimestamp(right.createdAt);
    return leftTime - rightTime;
  });

const messageIdentity = (message: CloudMessage) =>
  message.id ? `id:${message.id}` : message.clientMessageId ? `client:${message.clientMessageId}` : null;

const hasSameMessageIdentity = (left: CloudMessage, right: CloudMessage) =>
  Boolean(
    (left.id && right.id && left.id === right.id)
    || (left.clientMessageId && right.clientMessageId && left.clientMessageId === right.clientMessageId),
  );

const mergeMessage = (messages: CloudMessage[], message: CloudMessage) => {
  const identity = messageIdentity(message);
  if (!identity) {
    return sortMessages([...messages, message]);
  }
  const next = messages.filter((entry) => !hasSameMessageIdentity(entry, message));
  next.push(message);
  return sortMessages(next);
};

const createClientMessageId = () => {
  if (!globalThis.crypto?.getRandomValues) {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${Date.now()}-${suffix}`;
};

const appShareState = (message: CloudAppShareMessage) => {
  const revoked = Boolean(message.appShare.share?.revokedAt);
  if (revoked) {
    return { label: 'Link revocado', color: 'warning' as const };
  }
  if (!message.appShare.app.available) {
    return { label: 'No disponible', color: 'default' as const };
  }
  return { label: 'Disponible', color: 'success' as const };
};

const appShareInstallInput = (message: CloudMessage) => {
  if (message.type !== 'CloudAppShareMessage' || !message.appShare.app.available || message.appShare.share?.revokedAt) {
    return null;
  }
  if (message.appShare.shareKind === 'public_app') {
    return { appId: message.appShare.userAppId };
  }
  const shareCode = message.appShare.share?.code;
  return shareCode ? { shareCode } : null;
};

export function FriendChatWindowView({
  account,
  friendUserId,
  friendUsername,
  friendDisplayName,
}: FriendChatWindowViewProps) {
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareApps, setShareApps] = useState<SocialUserApp[]>([]);
  const [shareAppsLoading, setShareAppsLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [selectedShareAppId, setSelectedShareAppId] = useState('');
  const [sharingApp, setSharingApp] = useState(false);
  const [installingShareKeys, setInstallingShareKeys] = useState<Set<string>>(new Set());
  const [appShareInstallFeedback, setAppShareInstallFeedback] = useState<Record<string, string>>({});
  const [appShareInstallErrors, setAppShareInstallErrors] = useState<Record<string, string>>({});

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

  const markConversationRead = useCallback(async () => {
    if (!account.authenticated || !account.user?.confirmed) {
      return;
    }
    try {
      await window.forger.markFriendChatRead(friendUserId);
    } catch {
      // Loading and sending remain usable even if the read receipt update is delayed.
    }
  }, [account.authenticated, account.user?.confirmed, friendUserId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    void markConversationRead();

    const handleFocus = () => {
      void markConversationRead();
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [markConversationRead]);

  useEffect(() => {
    const removeListener = window.forger.onCloudFriendshipEvent((event: CloudSocialEvent) => {
      if (event.type !== 'cloud_message' && event.type !== 'ephemeral_cloud_message') {
        return;
      }
      const currentUserId = account.user?.id;
      if (!currentUserId) {
        return;
      }
      const message = event.message;
      const belongsToConversation =
        (message.sender.id === currentUserId && message.recipient.id === friendUserId)
        || (message.sender.id === friendUserId && message.recipient.id === currentUserId);
      if (!belongsToConversation) {
        return;
      }
      setMessages((current) => mergeMessage(current, message));
      if (message.sender.id === friendUserId && document.hasFocus()) {
        void markConversationRead();
      }
      setError(null);
    });
    return removeListener;
  }, [account.user?.id, friendUserId, markConversationRead]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !shouldStickToBottomRef.current) {
      return;
    }
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const handleMessagesScroll = (event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 96;
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) {
      return;
    }

    setSending(true);
    setError(null);
    const clientMessageId = createClientMessageId();
    const optimistic: CloudMessage = {
      type: 'CloudTextMessage',
      sender: {
        id: account.user!.id,
        username: account.user?.username ?? 'me',
        firstName: account.user?.firstName,
        lastName: account.user?.lastName,
      },
      recipient: {
        id: friendUserId,
        username: friendUsername,
        firstName: friendDisplayName,
      },
      deliveryMode: 'persistent',
      source: 'user',
      status: 'stored',
      clientMessageId,
      metadata: {},
      envelopes: [],
      plaintext: text,
      localState: 'pending',
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => mergeMessage(current, optimistic));
    setDraft('');
    try {
      const sent = await window.forger.sendCloudMessage({
        recipientUserId: friendUserId,
        clientMessageId,
        text,
        delivery: 'persistent',
        source: 'user',
      });
      setMessages((current) => mergeMessage(current, sent));
    } catch (err) {
      setMessages((current) => mergeMessage(current, { ...optimistic, localState: 'failed' }));
      setDraft(text);
      setError(err instanceof Error ? err.message : 'No pudimos enviar el mensaje.');
    } finally {
      setSending(false);
    }
  };

  const openShareDialog = async () => {
    setShareDialogOpen(true);
    setShareError(null);
    setShareAppsLoading(true);
    try {
      const payload = await window.forger.listMySocialApps();
      setShareApps(payload.apps);
      setSelectedShareAppId((current) => current || String(payload.apps[0]?.id ?? ''));
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'No pudimos cargar tus apps compartidas.');
    } finally {
      setShareAppsLoading(false);
    }
  };

  const handleShareApp = async () => {
    const userAppId = Number(selectedShareAppId);
    setSharingApp(true);
    setShareError(null);
    try {
      const sent = await window.forger.sendCloudAppShareMessage({
        recipientUserId: friendUserId,
        userAppId,
      });
      setMessages((current) => mergeMessage(current, sent));
      setShareDialogOpen(false);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'No pudimos compartir esta app.');
    } finally {
      setSharingApp(false);
    }
  };

  const handleInstallAppShare = async (
    input: { appId: number } | { shareCode: string },
    key: string,
  ) => {
    setInstallingShareKeys((current) => new Set(current).add(key));
    setAppShareInstallErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setAppShareInstallFeedback((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

    try {
      const result = await window.forger.installSocialApp(input, navigator.language);
      if (result.success) {
        setAppShareInstallFeedback((current) => ({
          ...current,
          [key]: result.userMessage || 'App instalada.',
        }));
        return;
      }
      setAppShareInstallErrors((current) => ({
        ...current,
        [key]: result.userMessage || 'No pudimos instalar esta app.',
      }));
    } catch (err) {
      setAppShareInstallErrors((current) => ({
        ...current,
        [key]: err instanceof Error ? err.message : 'No pudimos instalar esta app.',
      }));
    } finally {
      setInstallingShareKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
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
        <Button
          variant="outlined"
          size="small"
          startIcon={shareAppsLoading ? <CircularProgress size={14} color="inherit" /> : <ShareRounded />}
          disabled={!account.authenticated || !account.user?.confirmed || shareAppsLoading || sharingApp}
          onClick={() => void openShareDialog()}
        >
          Compartir app
        </Button>
        <Chip size="small" label="Social" variant="outlined" />
      </Stack>

      <Box
        ref={scrollRef}
        onScroll={handleMessagesScroll}
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
              const body = message.plaintext?.trim();
              const localState = message.localState;
              const shareState = message.type === 'CloudAppShareMessage' ? appShareState(message) : null;
              const shareInstallInput = appShareInstallInput(message);
              const shareActionKey = message.type === 'CloudAppShareMessage'
                ? messageIdentity(message) ?? `app-share:${message.appShare.id}`
                : '';
              const installingShare = installingShareKeys.has(shareActionKey);

              return (
                <Stack key={key} alignItems={outgoing ? 'flex-end' : 'flex-start'}>
                  <Paper
                    elevation={0}
                    sx={{
                      maxWidth: '84%',
                      width: message.type === 'CloudAppShareMessage' ? 'min(360px, 84%)' : 'auto',
                      px: message.type === 'CloudAppShareMessage' ? 0 : 1.5,
                      py: message.type === 'CloudAppShareMessage' ? 0 : 1.1,
                      borderRadius: 2.5,
                      bgcolor: message.type === 'CloudAppShareMessage'
                        ? alpha(theme.palette.background.paper, 0.98)
                        : outgoing
                          ? theme.palette.primary.main
                          : alpha(theme.palette.background.paper, 0.96),
                      color: message.type === 'CloudAppShareMessage'
                        ? theme.palette.text.primary
                        : outgoing
                          ? theme.palette.primary.contrastText
                          : theme.palette.text.primary,
                      border: `1px solid ${
                        message.type === 'CloudAppShareMessage'
                          ? alpha(theme.palette.primary.main, 0.28)
                          : outgoing
                            ? alpha(theme.palette.primary.dark, 0.35)
                            : alpha(theme.palette.divider, 0.8)
                      }`,
                      overflow: 'hidden',
                    }}
                  >
                    {message.type === 'CloudAppShareMessage' ? (
                      <Stack spacing={1.1} sx={{ p: 1.4 }}>
                        <Stack direction="row" spacing={1} alignItems="flex-start">
                          <Avatar
                            variant="rounded"
                            sx={{
                              width: 38,
                              height: 38,
                              bgcolor: alpha(theme.palette.primary.main, 0.12),
                              color: theme.palette.primary.main,
                            }}
                          >
                            {shareState!.label === 'Link revocado' ? <LinkOffRounded /> : <AppsRounded />}
                          </Avatar>
                          <Stack spacing={0.35} sx={{ minWidth: 0, flex: 1 }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 800 }} noWrap>
                              {message.appShare.appNameSnapshot}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" noWrap>
                              @{message.appShare.appOwnerUsernameSnapshot}
                            </Typography>
                          </Stack>
                          <Chip size="small" label={shareState!.label} color={shareState!.color} variant="outlined" />
                        </Stack>
                        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                          <Chip size="small" label={message.appShare.shareKind === 'public_app' ? 'Pública' : message.appShare.shareKind === 'friends_link' ? 'Amigos' : 'Privada'} />
                          <Chip size="small" label={`/${message.appShare.appSlugSnapshot}`} variant="outlined" />
                        </Stack>
                        {body ? (
                          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {body}
                          </Typography>
                        ) : null}
                        {appShareInstallFeedback[shareActionKey] ? (
                          <Alert severity="success" sx={{ py: 0.25 }}>
                            {appShareInstallFeedback[shareActionKey]}
                          </Alert>
                        ) : null}
                        {appShareInstallErrors[shareActionKey] ? (
                          <Alert severity="error" sx={{ py: 0.25 }}>
                            {appShareInstallErrors[shareActionKey]}
                          </Alert>
                        ) : null}
                        <Button
                          size="small"
                          variant="contained"
                          disabled={!shareInstallInput || installingShare}
                          onClick={() => void handleInstallAppShare(shareInstallInput!, shareActionKey)}
                        >
                          {installingShare ? 'Instalando...' : 'Instalar'}
                        </Button>
                      </Stack>
                    ) : (
                      <Typography
                        variant="body2"
                        sx={{
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          color: body
                            ? 'inherit'
                            : outgoing
                              ? alpha(theme.palette.primary.contrastText, 0.78)
                              : theme.palette.text.secondary,
                          fontStyle: body ? 'normal' : 'italic',
                        }}
                      >
                        {body ?? 'No se pudo desencriptar este mensaje en este dispositivo.'}
                      </Typography>
                    )}
                    <Typography
                      variant="caption"
                      sx={{
                        mt: message.type === 'CloudAppShareMessage' ? 0 : 0.75,
                        display: 'block',
                        px: message.type === 'CloudAppShareMessage' ? 1.4 : 0,
                        pb: message.type === 'CloudAppShareMessage' ? 1.1 : 0,
                        color: outgoing
                          ? message.type === 'CloudAppShareMessage'
                            ? theme.palette.text.secondary
                            : alpha(theme.palette.primary.contrastText, 0.8)
                          : theme.palette.text.secondary,
                      }}
                    >
                      <Stack direction="row" spacing={0.5} alignItems="center" component="span">
                        <span>{formatMessageTime(message.createdAt)}</span>
                        {outgoing && localState === 'pending' ? <CircularProgress size={12} color="inherit" /> : null}
                        {outgoing && localState === 'sent' ? <CheckRounded sx={{ fontSize: 14 }} /> : null}
                        {outgoing && localState === 'failed' ? <ErrorOutlineRounded sx={{ fontSize: 14 }} /> : null}
                      </Stack>
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
          slotProps={{ htmlInput: { 'aria-label': 'Mensaje' } }}
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
          aria-label="Enviar mensaje"
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

      <Dialog open={shareDialogOpen} onClose={() => !sharingApp && setShareDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Compartir app con @{friendUsername}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {shareError ? <Alert severity="error">{shareError}</Alert> : null}
            {shareAppsLoading ? (
              <Stack direction="row" spacing={1} alignItems="center">
                <CircularProgress size={18} />
                <Typography color="text.secondary">Cargando tus apps compartidas.</Typography>
              </Stack>
            ) : shareApps.length === 0 ? (
              <Alert severity="info">Sube una app a Social antes de compartirla por chat.</Alert>
            ) : (
              <Select
                fullWidth
                inputProps={{ 'aria-label': 'App para compartir' }}
                value={selectedShareAppId}
                onChange={(event) => setSelectedShareAppId(String(event.target.value))}
                disabled={sharingApp}
              >
                {shareApps.map((app) => (
                  <MenuItem key={app.id} value={String(app.id)}>
                    {app.name}
                  </MenuItem>
                ))}
              </Select>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={sharingApp} onClick={() => setShareDialogOpen(false)}>Cancelar</Button>
          <Button
            variant="contained"
            disabled={sharingApp || shareAppsLoading || !selectedShareAppId || shareApps.length === 0}
            onClick={() => void handleShareApp()}
          >
            {sharingApp ? 'Compartiendo...' : 'Enviar'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
