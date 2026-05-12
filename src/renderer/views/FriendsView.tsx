import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import type {
  CloudAppMessagePermissionDecision,
  CloudFriendship,
  CloudMessage,
  CloudMessageDeliveryMode,
  ForgerAccountSession,
} from '@shared/types';

interface FriendsViewProps {
  account: ForgerAccountSession;
}

const friendLabel = (friendship: CloudFriendship) =>
  friendship.friend.firstName || friendship.friend.username;

export function FriendsView({ account }: FriendsViewProps) {
  const [friendships, setFriendships] = useState<CloudFriendship[]>([]);
  const [selectedFriendId, setSelectedFriendId] = useState<number | null>(null);
  const [messages, setMessages] = useState<CloudMessage[]>([]);
  const [username, setUsername] = useState('');
  const [text, setText] = useState('');
  const [delivery, setDelivery] = useState<CloudMessageDeliveryMode>('persistent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accepted = friendships.filter((entry) => entry.status === 'accepted');
  const pendingIncoming = friendships.filter((entry) => entry.status === 'pending' && entry.addresseeId === account.user?.id);
  const pendingOutgoing = friendships.filter((entry) => entry.status === 'pending' && entry.requesterId === account.user?.id);
  const selectedFriendship = useMemo(
    () => accepted.find((entry) => entry.friend.id === selectedFriendId) ?? accepted[0],
    [accepted, selectedFriendId],
  );

  const loadFriends = async () => {
    const next = await window.forger.listFriends();
    setFriendships(next);
    if (!selectedFriendId && next.find((entry) => entry.status === 'accepted')) {
      setSelectedFriendId(next.find((entry) => entry.status === 'accepted')?.friend.id ?? null);
    }
  };

  const loadMessages = async (friendUserId: number) => {
    setMessages(await window.forger.listCloudMessages(friendUserId));
  };

  useEffect(() => {
    void loadFriends().catch(() => setError('No pudimos cargar amistades.'));
  }, []);

  useEffect(() => {
    if (selectedFriendship) {
      void loadMessages(selectedFriendship.friend.id).catch(() => setError('No pudimos cargar mensajes.'));
    }
  }, [selectedFriendship?.friend.id]);

  if (!account.authenticated || !account.user?.confirmed) {
    return <Alert severity="info">Inicia sesión en Forger Cloud para usar amistades y mensajes.</Alert>;
  }

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pudimos completar la acción.');
    } finally {
      setBusy(false);
    }
  };

  const sendRequest = () => run(async () => {
    if (!username.trim()) return;
    await window.forger.sendFriendRequest(username.trim());
    setUsername('');
    await loadFriends();
  });

  const sendMessage = () => run(async () => {
    if (!selectedFriendship || !text.trim()) return;
    const sent = await window.forger.sendCloudMessage({
      recipientUserId: selectedFriendship.friend.id,
      text: text.trim(),
      delivery,
    });
    setText('');
    setMessages((current) => [...current, sent]);
  });

  const decidePermission = (message: CloudMessage, decision: CloudAppMessagePermissionDecision) => run(async () => {
    if (!message.id) return;
    const updated = await window.forger.decideAppMessagePermission(message.id, decision);
    setMessages((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
  });

  const inviteText = `Join me on Forger Cloud and add @${account.user.username ?? account.user.email.split('@')[0]}.`;

  return (
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography variant="h4">Friends</Typography>
        <Typography color="text.secondary">Requests, secure chat, and messages from apps.</Typography>
      </Stack>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="stretch">
        <Paper variant="outlined" sx={{ width: { xs: '100%', md: 320 }, p: 2 }}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1}>
              <TextField
                size="small"
                label="Username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                fullWidth
              />
              <Button disabled={busy || !username.trim()} onClick={sendRequest}>Add</Button>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>{inviteText}</Typography>
              <Tooltip title="Copy invite">
                <IconButton onClick={() => navigator.clipboard.writeText(inviteText)}>
                  <ContentCopyRounded fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            <Divider />
            <Typography variant="subtitle2">Requests</Typography>
            {pendingIncoming.length === 0 && pendingOutgoing.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No pending requests.</Typography>
            ) : null}
            {pendingIncoming.map((entry) => (
              <Stack key={entry.id} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ flex: 1 }}>@{entry.friend.username}</Typography>
                <IconButton size="small" onClick={() => run(async () => { await window.forger.acceptFriendRequest(entry.id); await loadFriends(); })}>
                  <CheckRounded fontSize="small" />
                </IconButton>
                <IconButton size="small" onClick={() => run(async () => { await window.forger.declineFriendRequest(entry.id); await loadFriends(); })}>
                  <CloseRounded fontSize="small" />
                </IconButton>
              </Stack>
            ))}
            {pendingOutgoing.map((entry) => (
              <Stack key={entry.id} direction="row" spacing={1} alignItems="center">
                <Typography sx={{ flex: 1 }}>@{entry.friend.username}</Typography>
                <Button size="small" onClick={() => run(async () => { await window.forger.cancelFriendRequest(entry.id); await loadFriends(); })}>Cancel</Button>
              </Stack>
            ))}
            <Divider />
            <Typography variant="subtitle2">Friends</Typography>
            <List disablePadding>
              {accepted.map((entry) => (
                <ListItemButton
                  key={entry.id}
                  selected={selectedFriendship?.friend.id === entry.friend.id}
                  onClick={() => setSelectedFriendId(entry.friend.id)}
                >
                  <ListItemText primary={friendLabel(entry)} secondary={`@${entry.friend.username}`} />
                </ListItemButton>
              ))}
            </List>
          </Stack>
        </Paper>
        <Paper variant="outlined" sx={{ flex: 1, p: 2, minHeight: 520 }}>
          {selectedFriendship ? (
            <Stack spacing={2} sx={{ height: '100%' }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="h6" sx={{ flex: 1 }}>{friendLabel(selectedFriendship)}</Typography>
                <Chip size="small" label={`@${selectedFriendship.friend.username}`} />
              </Stack>
              <Box sx={{ flex: 1, overflow: 'auto' }}>
                <Stack spacing={1.25}>
                  {messages.map((message, index) => {
                    const mine = message.sender.id === account.user?.id;
                    return (
                      <Paper key={message.id ?? `${message.clientMessageId}-${index}`} variant="outlined" sx={{ p: 1.25, alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '76%' }}>
                        <Stack spacing={0.75}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="caption" color="text.secondary">{mine ? 'You' : `@${message.sender.username}`}</Typography>
                            <Chip size="small" label={message.deliveryMode === 'ephemeral' ? 'live-only' : message.status} />
                            {message.source === 'app' ? <Chip size="small" label={message.sourceAppName ?? message.sourceAppId} /> : null}
                          </Stack>
                          {message.status === 'pending_permission' && message.source === 'app' ? (
                            <Stack spacing={1}>
                              <Typography variant="body2">This app wants to send you a message.</Typography>
                              <Stack direction="row" spacing={1} flexWrap="wrap">
                                <Button size="small" onClick={() => decidePermission(message, 'allow_once')}>Allow once</Button>
                                <Button size="small" onClick={() => decidePermission(message, 'allow_always')}>Always</Button>
                                <Button size="small" onClick={() => decidePermission(message, 'decline_once')}>Decline</Button>
                                <Button size="small" onClick={() => decidePermission(message, 'decline_always')}>Block</Button>
                              </Stack>
                            </Stack>
                          ) : (
                            <Typography whiteSpace="pre-wrap">{message.plaintext ?? (message.status === 'blocked' ? 'Blocked message' : 'Encrypted message')}</Typography>
                          )}
                        </Stack>
                      </Paper>
                    );
                  })}
                </Stack>
              </Box>
              <Stack direction="row" spacing={1}>
                <Select size="small" value={delivery} onChange={(event) => setDelivery(event.target.value as CloudMessageDeliveryMode)}>
                  <MenuItem value="persistent">Stored</MenuItem>
                  <MenuItem value="ephemeral">Live-only</MenuItem>
                </Select>
                <TextField
                  size="small"
                  placeholder="Write a message"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  fullWidth
                  multiline
                  maxRows={3}
                />
                <IconButton disabled={busy || !text.trim()} onClick={sendMessage}>
                  <SendRounded />
                </IconButton>
              </Stack>
            </Stack>
          ) : (
            <Typography color="text.secondary">Add a friend to start chatting.</Typography>
          )}
        </Paper>
      </Stack>
    </Stack>
  );
}
