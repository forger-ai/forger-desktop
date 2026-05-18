import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import ForumRounded from '@mui/icons-material/ForumRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import PersonAddDisabledRounded from '@mui/icons-material/PersonAddDisabledRounded';
import PersonAddRounded from '@mui/icons-material/PersonAddRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import GroupsRounded from '@mui/icons-material/GroupsRounded';
import SaveRounded from '@mui/icons-material/SaveRounded';
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  ClickAwayListener,
  Divider,
  Fab,
  Grow,
  IconButton,
  List,
  ListItemButton,
  Paper,
  Popper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
  type AlertColor,
} from '@mui/material';
import type {
  CloudFriendship,
  CloudFriendUser,
  CloudMessage,
  CloudSocialEvent,
  ForgerAccountSession,
  FriendChatWindowOpenResult,
} from '@shared/types';
import {
  LAST_SOCIAL_TAB_KEY,
  activityTimestamp,
  formatRelativeActivity,
  friendLabel,
  isFriendOnline,
  readLastSessionTab,
  requestLabel,
  setTimedFeedback,
  sortFriends,
  type SocialTab,
} from './friends/socialViewHelpers';

interface FriendsViewProps {
  account: ForgerAccountSession;
  accountBusy?: boolean;
  onOpenFriendChat?: (friendship: CloudFriendship) => Promise<FriendChatWindowOpenResult> | FriendChatWindowOpenResult;
  onNotify?: (message: string, severity?: AlertColor) => void;
  onUpdateUsername?: (username: string) => Promise<boolean>;
  variant?: 'floating' | 'topbar';
}

const formatUsernameAvailableDate = (value?: string) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString('es-CL', { dateStyle: 'medium' });
};

export function FriendsView({ account, accountBusy = false, onOpenFriendChat, onNotify, onUpdateUsername, variant = 'floating' }: FriendsViewProps) {
  const theme = useTheme();
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const previousAccountIdRef = useRef<number | undefined>(account.user?.id);
  const panelId = 'social-launcher-panel';
  const topbar = variant === 'topbar';
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SocialTab>(() => readLastSessionTab() ?? 'friends');
  const [lastSessionTab, setLastSessionTab] = useState<SocialTab | null>(() => readLastSessionTab());
  const [friendships, setFriendships] = useState<CloudFriendship[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [openingFriendIds, setOpeningFriendIds] = useState<Set<number>>(new Set());
  const [rowFeedback, setRowFeedback] = useState<Record<number, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [requestBusyIds, setRequestBusyIds] = useState<Set<number>>(new Set());
  const [requestErrors, setRequestErrors] = useState<Record<number, string>>({});
  const [requestFeedback, setRequestFeedback] = useState<Record<number, string>>({});
  const [seenPendingRequestVersions, setSeenPendingRequestVersions] = useState<Record<number, string>>({});
  const [friendSearch, setFriendSearch] = useState('');
  const [friendSearchResults, setFriendSearchResults] = useState<CloudFriendUser[]>([]);
  const [friendSearchLoading, setFriendSearchLoading] = useState(false);
  const [friendRequestSendingId, setFriendRequestSendingId] = useState<number | null>(null);
  const [addFriendError, setAddFriendError] = useState<string | null>(null);
  const [addFriendFeedback, setAddFriendFeedback] = useState<string | null>(null);
  const [editingUsername, setEditingUsername] = useState(false);
  const [profileUsername, setProfileUsername] = useState(account.user?.username ?? '');
  const [profileUsernameError, setProfileUsernameError] = useState<string | null>(null);

  const accountUserId = account.user?.id;
  const accepted = useMemo(
    () => sortFriends(friendships.filter((entry) => entry.status === 'accepted')),
    [friendships],
  );
  const pendingIncoming = useMemo(
    () => friendships.filter((entry) => entry.status === 'pending' && entry.addresseeId === accountUserId),
    [accountUserId, friendships],
  );
  const pendingOutgoing = useMemo(
    () => friendships.filter((entry) => entry.status === 'pending' && entry.requesterId === accountUserId),
    [accountUserId, friendships],
  );
  const pendingRequestsCount = pendingIncoming.length;
  const unseenPendingRequestCount = useMemo(
    () => pendingIncoming.filter((entry) => seenPendingRequestVersions[entry.id] !== entry.updatedAt).length,
    [pendingIncoming, seenPendingRequestVersions],
  );
  const unseenMessagesCount = useMemo(
    () => accepted.reduce((total, friendship) => total + (friendship.unreadCount ?? 0), 0),
    [accepted],
  );
  const launcherBadgeCount = pendingRequestsCount + unseenMessagesCount;
  const accountUsername = account.user?.username?.trim();
  const usernameAvailableDate = formatUsernameAvailableDate(account.user?.usernameChangeAvailableAt);
  const usernameChangeBlocked = Boolean(
    account.user?.usernameChangeAvailableAt && new Date(account.user.usernameChangeAvailableAt).getTime() > Date.now(),
  );

  useEffect(() => {
    setProfileUsername(account.user?.username ?? '');
    setProfileUsernameError(null);
    setEditingUsername(false);
  }, [account.user?.id, account.user?.username]);

  const syncLastTab = (value: SocialTab) => {
    setLastSessionTab(value);
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(LAST_SOCIAL_TAB_KEY, value);
    }
  };

  const mergeFriendship = useCallback((friendship: CloudFriendship) => {
    setFriendships((current) => {
      const next = current.filter((entry) => entry.id !== friendship.id);
      next.push(friendship);
      return next;
    });
  }, []);

  const mergeCloudMessageActivity = useCallback((message: CloudMessage, unread = false) => {
    const currentUserId = accountUserId;
    if (!currentUserId) {
      return;
    }
    const friendId = message.sender.id === currentUserId ? message.recipient.id : message.sender.id;
    const activityAt = message.createdAt || message.updatedAt || new Date().toISOString();
    setFriendships((current) => current.map((entry) => {
      if (entry.friend.id !== friendId) {
        return entry;
      }
      return {
        ...entry,
        lastMessageAt: activityAt,
        updatedAt: activityAt,
        unreadCount: unread ? (entry.unreadCount ?? 0) + 1 : entry.unreadCount,
        friend: message.sender.id === friendId ? { ...entry.friend, ...message.sender } : { ...entry.friend, ...message.recipient },
      };
    }));
  }, [accountUserId]);

  const resetSocialState = useCallback(() => {
    setFriendships([]);
    setLoading(false);
    setError(null);
    setHasLoadedOnce(false);
    setOpeningFriendIds(new Set());
    setRowFeedback({});
    setRowErrors({});
    setRequestBusyIds(new Set());
    setRequestErrors({});
    setRequestFeedback({});
    setSeenPendingRequestVersions({});
    setFriendSearch('');
    setFriendSearchResults([]);
    setFriendSearchLoading(false);
    setFriendRequestSendingId(null);
    setAddFriendError(null);
    setAddFriendFeedback(null);
  }, []);

  useEffect(() => {
    if (previousAccountIdRef.current === accountUserId) {
      return;
    }
    previousAccountIdRef.current = accountUserId;
    resetSocialState();
  }, [accountUserId, resetSocialState]);

  const loadFriends = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!account.authenticated || !account.user?.confirmed) {
      resetSocialState();
      return;
    }

    if (!silent || !hasLoadedOnce) {
      setLoading(true);
    }
    if (!silent) {
      setError(null);
    }

    try {
      const next = await window.forger.listFriends();
      setFriendships(next);
      setHasLoadedOnce(true);
      setError(null);
    } catch (err) {
      if (!silent || !hasLoadedOnce) {
        setError(err instanceof Error ? err.message : 'No pudimos cargar Social.');
      }
    } finally {
      if (!silent || !hasLoadedOnce) {
        setLoading(false);
      }
    }
  }, [account.authenticated, account.user?.confirmed, accountUserId, hasLoadedOnce, resetSocialState]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (account.authenticated && account.user?.confirmed) {
      void loadFriends({ silent: hasLoadedOnce });
      return undefined;
    }

    resetSocialState();
    return undefined;
  }, [account.authenticated, account.user?.confirmed, accountUserId, hasLoadedOnce, loadFriends, resetSocialState]);

  useEffect(() => {
    if (!account.authenticated || !account.user?.confirmed) {
      return undefined;
    }

    return window.forger.onCloudFriendshipEvent((event: CloudSocialEvent) => {
      if (event.type === 'friendship_changed') {
        mergeFriendship(event.friendship);
        return;
      }

      if (event.type === 'cloud_message' || event.type === 'ephemeral_cloud_message') {
        const currentUserId = accountUserId;
        if (!currentUserId) {
          return;
        }
        const message = event.message;
        const friendId = message.sender.id === currentUserId ? message.recipient.id : message.sender.id;
        const knownFriendship = friendships.some((entry) => entry.friend.id === friendId);
        mergeCloudMessageActivity(message, Boolean(event.unread));
        if (!knownFriendship) {
          void loadFriends({ silent: true });
        }
      }
    });
  }, [account.authenticated, account.user?.confirmed, accountUserId, friendships, loadFriends, mergeCloudMessageActivity, mergeFriendship]);

  useEffect(() => {
    if (open && activeTab === 'requests' && pendingIncoming.length > 0) {
      setSeenPendingRequestVersions((current) => {
        const next = { ...current };
        pendingIncoming.forEach((entry) => {
          next[entry.id] = entry.updatedAt;
        });
        return next;
      });
    }
  }, [activeTab, open, pendingIncoming]);

  useEffect(() => {
    if (!open && unseenPendingRequestCount > 0 && !lastSessionTab) {
      setActiveTab('requests');
    }
  }, [lastSessionTab, open, unseenPendingRequestCount]);

  const handleToggle = () => {
    if (open) {
      setOpen(false);
      return;
    }

    const nextTab = unseenPendingRequestCount > 0 ? 'requests' : (lastSessionTab ?? 'friends');
    setActiveTab(nextTab);
    setOpen(true);
  };

  const handleTabChange = (_event: SyntheticEvent, value: SocialTab) => {
    setActiveTab(value);
    syncLastTab(value);
  };

  const closePanel = () => setOpen(false);

  const setFriendFeedback = (friendId: number, message: string) => {
    setTimedFeedback(setRowFeedback, friendId, message);
  };

  const handleOpenChat = async (friendship: CloudFriendship) => {
    if (openingFriendIds.has(friendship.friend.id)) {
      return;
    }

    setOpeningFriendIds((current) => new Set(current).add(friendship.friend.id));
    setRowErrors((current) => {
      const next = { ...current };
      delete next[friendship.friend.id];
      return next;
    });

    try {
      const result = await onOpenFriendChat?.(friendship);
      void window.forger.markFriendChatRead(friendship.friend.id)
        .then(mergeFriendship)
        .catch(() => undefined);
      const label = result?.userMessage ?? `Chat de @${friendship.friend.username} listo para abrir`;
      setFriendFeedback(friendship.friend.id, label);
      onNotify?.(label, 'info');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No pudimos abrir este chat.';
      setRowErrors((current) => ({ ...current, [friendship.friend.id]: message }));
      onNotify?.(message, 'error');
    } finally {
      setOpeningFriendIds((current) => {
        const next = new Set(current);
        next.delete(friendship.friend.id);
        return next;
      });
    }
  };

  const runRequestAction = async (
    friendshipId: number,
    action: () => Promise<CloudFriendship>,
    successMessage: string,
  ) => {
    setRequestBusyIds((current) => new Set(current).add(friendshipId));
    setRequestErrors((current) => {
      const next = { ...current };
      delete next[friendshipId];
      return next;
    });

    try {
      const nextFriendship = await action();
      mergeFriendship(nextFriendship);
      setTimedFeedback(setRequestFeedback, friendshipId, successMessage);
      void loadFriends({ silent: true });
      onNotify?.(successMessage, 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No pudimos completar la solicitud.';
      setRequestErrors((current) => ({ ...current, [friendshipId]: message }));
      onNotify?.(message, 'error');
    } finally {
      setRequestBusyIds((current) => {
        const next = new Set(current);
        next.delete(friendshipId);
        return next;
      });
    }
  };

  const handleSearchFriends = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    const username = friendSearch.trim().replace(/^@/, '');
    if (!username || friendSearchLoading) {
      return;
    }

    setFriendSearchLoading(true);
    setAddFriendError(null);
    setAddFriendFeedback(null);
    try {
      const results = await window.forger.searchFriends(username);
      setFriendSearchResults(results.filter((result) => result.id !== accountUserId));
      if (results.length === 0) {
        setAddFriendFeedback(`No encontramos a @${username}.`);
      }
    } catch (err) {
      setAddFriendError(err instanceof Error ? err.message : 'No pudimos buscar ese usuario.');
    } finally {
      setFriendSearchLoading(false);
    }
  };

  const handleSendFriendRequest = async (user: CloudFriendUser) => {
    if (friendRequestSendingId) {
      return;
    }

    setFriendRequestSendingId(user.id);
    setAddFriendError(null);
    setAddFriendFeedback(null);
    try {
      const friendship = await window.forger.sendFriendRequest(user.username);
      mergeFriendship(friendship);
      setFriendSearchResults((current) => current.filter((entry) => entry.id !== user.id));
      setAddFriendFeedback(`Solicitud enviada a @${user.username}.`);
      onNotify?.(`Solicitud enviada a @${user.username}.`, 'success');
      void loadFriends({ silent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No pudimos enviar la solicitud.';
      setAddFriendError(message);
      onNotify?.(message, 'error');
    } finally {
      setFriendRequestSendingId(null);
    }
  };

  const handleUsernameSubmit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    const nextUsername = profileUsername.trim().replace(/^@/, '');
    if (!nextUsername || accountBusy || usernameChangeBlocked) {
      return;
    }

    setProfileUsernameError(null);
    const success = await onUpdateUsername?.(nextUsername);
    if (success) {
      setEditingUsername(false);
      onNotify?.('Username actualizado.', 'success');
      return;
    }

    setProfileUsernameError('No pudimos actualizar tu username.');
  };

  const tabSubtitle =
    activeTab === 'friends'
      ? 'Tus conversaciones disponibles'
      : activeTab === 'requests'
        ? 'Gestiona solicitudes pendientes'
        : 'Busca por username y envía una solicitud';

  const launcherBusy = loading && !hasLoadedOnce;
  const isFriendsTabLoading = loading && accepted.length === 0;
  const isRequestsTabLoading = loading && pendingIncoming.length === 0 && pendingOutgoing.length === 0;
  const tabErrorMessage = activeTab === 'friends'
    ? error ?? 'No pudimos cargar tus amigos.'
    : error ?? 'No pudimos cargar tus solicitudes.';

  const launcherButton = topbar ? (
    <Tooltip title="Social">
      <Badge
        color="error"
        badgeContent={launcherBadgeCount}
        overlap="circular"
        invisible={launcherBadgeCount === 0}
        sx={{
          '& .MuiBadge-badge': {
            minWidth: 18,
            height: 18,
            borderRadius: 1,
            fontWeight: 700,
            boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
          },
        }}
      >
        <IconButton
          ref={launcherRef}
          size="small"
          aria-label="Social"
          aria-describedby={open ? panelId : undefined}
          aria-expanded={open}
          onClick={handleToggle}
          sx={{
            width: 32,
            height: 32,
            borderRadius: 1,
            color: open ? 'primary.main' : 'text.secondary',
            bgcolor: open ? alpha(theme.palette.primary.main, 0.12) : 'transparent',
            '&:hover': {
              bgcolor: alpha(theme.palette.primary.main, 0.12),
              color: 'primary.main',
            },
          }}
        >
          <GroupsRounded sx={{ fontSize: 19 }} />
        </IconButton>
      </Badge>
    </Tooltip>
  ) : (
    <Tooltip title="Social" placement="left">
      <Badge
        color="error"
        badgeContent={launcherBadgeCount}
        overlap="rectangular"
        invisible={launcherBadgeCount === 0}
        sx={{
          '& .MuiBadge-badge': {
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            fontWeight: 700,
            boxShadow: `0 0 0 2px ${theme.palette.background.default}`,
          },
        }}
      >
        <Fab
          ref={launcherRef}
          aria-label="Social"
          aria-describedby={open ? panelId : undefined}
          aria-expanded={open}
          onClick={handleToggle}
          sx={{
            width: 64,
            height: 64,
            minHeight: 64,
            borderRadius: 1,
            boxShadow: open ? theme.shadows[10] : theme.shadows[6],
            bgcolor: open ? theme.palette.primary.main : alpha(theme.palette.background.paper, 0.96),
            color: open ? theme.palette.primary.contrastText : theme.palette.text.primary,
            border: `1px solid ${open ? alpha(theme.palette.primary.main, 0.9) : alpha(theme.palette.divider, 0.9)}`,
            backdropFilter: 'blur(18px)',
            transition: theme.transitions.create(['background-color', 'box-shadow', 'transform'], {
              duration: theme.transitions.duration.shorter,
            }),
            '&:hover': {
              bgcolor: open ? theme.palette.primary.dark : alpha(theme.palette.background.paper, 1),
              transform: 'translateY(-1px)',
            },
          }}
        >
          <ForumRounded />
        </Fab>
      </Badge>
    </Tooltip>
  );

  return (
    <Box sx={topbar ? { position: 'relative' } : { position: 'fixed', right: 24, bottom: 24, zIndex: theme.zIndex.modal - 1 }}>
      <ClickAwayListener onClickAway={() => open && closePanel()}>
        <Box sx={{ position: 'relative' }}>
          {launcherButton}

          <Popper
            id={panelId}
            open={open}
            anchorEl={launcherRef.current}
            placement={topbar ? 'bottom-end' : 'top-end'}
            transition
            sx={{ zIndex: theme.zIndex.modal }}
            modifiers={[
              { name: 'offset', options: { offset: [0, topbar ? 8 : 14] } },
            ]}
          >
            {({ TransitionProps }) => (
              <Grow {...TransitionProps} timeout={160} style={{ transformOrigin: 'bottom right' }}>
                <Paper
                  variant="outlined"
                  sx={{
                    width: 392,
                    maxWidth: 'calc(100vw - 32px)',
                    maxHeight: 560,
                    overflow: 'hidden',
                    borderRadius: 1,
                    boxShadow: theme.shadows[14],
                    bgcolor: alpha(theme.palette.background.paper, 0.98),
                    backdropFilter: 'blur(18px)',
                    borderColor: alpha(theme.palette.divider, 0.9),
                  }}
                >
                  <Stack sx={{ minHeight: 420, maxHeight: 560 }}>
                    <Stack spacing={0.5} sx={{ px: 2, pt: 1.8, pb: 1.4 }}>
                      <Stack direction="row" alignItems="center" spacing={1}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
                          Social
                        </Typography>
                        {launcherBusy ? <CircularProgress size={16} /> : null}
                      </Stack>
                      <Stack spacing={0.25}>
                        <Typography variant="body2" color="text.secondary">
                          {tabSubtitle}
                        </Typography>
                        {editingUsername ? (
                          <Box component="form" onSubmit={(event) => void handleUsernameSubmit(event)} sx={{ pt: 0.5 }}>
                            <Stack direction="row" spacing={0.75} alignItems="flex-start">
                              <TextField
                                size="small"
                                value={profileUsername}
                                onChange={(event) => {
                                  setProfileUsername(event.target.value);
                                  setProfileUsernameError(null);
                                }}
                                placeholder="@username"
                                error={Boolean(profileUsernameError)}
                                helperText={profileUsernameError ?? 'Letras, numeros o guion bajo.'}
                                disabled={accountBusy}
                                inputProps={{ 'aria-label': 'Nuevo username' }}
                                sx={{ flex: 1 }}
                              />
                              <Tooltip title="Guardar username">
                                <span>
                                  <IconButton
                                    type="submit"
                                    size="small"
                                    color="primary"
                                    disabled={accountBusy || !profileUsername.trim()}
                                    sx={{ mt: 0.35 }}
                                  >
                                    {accountBusy ? <CircularProgress size={16} /> : <SaveRounded fontSize="small" />}
                                  </IconButton>
                                </span>
                              </Tooltip>
                              <Tooltip title="Cancelar">
                                <span>
                                  <IconButton
                                    size="small"
                                    onClick={() => {
                                      setProfileUsername(account.user?.username ?? '');
                                      setProfileUsernameError(null);
                                      setEditingUsername(false);
                                    }}
                                    disabled={accountBusy}
                                    sx={{ mt: 0.35 }}
                                  >
                                    <CloseRounded fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            </Stack>
                          </Box>
                        ) : (
                          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
                            <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
                              {accountUsername ? `Tu username: @${accountUsername}` : 'Tu cuenta no tiene username visible'}
                            </Typography>
                            {account.authenticated && account.user?.confirmed && onUpdateUsername ? (
                              <Tooltip
                                title={
                                  usernameChangeBlocked && usernameAvailableDate
                                    ? `Disponible desde el ${usernameAvailableDate}`
                                    : 'Cambiar username'
                                }
                              >
                                <span>
                                  <IconButton
                                    size="small"
                                    aria-label="Cambiar username"
                                    onClick={() => setEditingUsername(true)}
                                    disabled={accountBusy || usernameChangeBlocked}
                                    sx={{ width: 24, height: 24, flexShrink: 0 }}
                                  >
                                    <EditRounded sx={{ fontSize: 16 }} />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            ) : null}
                          </Stack>
                        )}
                        {usernameChangeBlocked && usernameAvailableDate && !editingUsername ? (
                          <Typography variant="caption" color="text.secondary">
                            Puedes cambiarlo desde el {usernameAvailableDate}.
                          </Typography>
                        ) : null}
                      </Stack>
                    </Stack>

                    <Tabs
                      value={activeTab}
                      onChange={handleTabChange}
                      variant="fullWidth"
                      sx={{ px: 1.2, minHeight: 44 }}
                    >
                      <Tab value="friends" label="Amigos" sx={{ minHeight: 44 }} />
                      <Tab
                        value="requests"
                        label="Solicitudes"
                        sx={{ minHeight: 44 }}
                      />
                      <Tab value="add" label="Agregar" sx={{ minHeight: 44 }} />
                    </Tabs>

                    <Divider />

                    <Box sx={{ px: 1.5, py: 1.5, overflowY: 'auto', minHeight: 0, flex: 1 }}>
                      {!account.authenticated || !account.user?.confirmed ? (
                        <Alert severity="info">
                          Inicia sesión en Forger Cloud para usar Social.
                        </Alert>
                      ) : null}

                      {account.authenticated && account.user?.confirmed && error ? (
                        <Stack spacing={1.5}>
                          <Alert severity="error">{tabErrorMessage}</Alert>
                          <Button variant="outlined" onClick={() => void loadFriends()}>
                            Reintentar
                          </Button>
                        </Stack>
                      ) : null}

                      {account.authenticated && account.user?.confirmed && !error ? (
                        activeTab === 'friends' ? (
                          <Stack spacing={1}>
                            {isFriendsTabLoading ? (
                              <Stack spacing={1}>
                                {[0, 1, 2].map((item) => (
                                  <Paper
                                    key={item}
                                    variant="outlined"
                                    sx={{ px: 1.5, py: 1.25, borderRadius: 2.5 }}
                                  >
                                    <Stack direction="row" spacing={1.25} alignItems="center">
                                      <Avatar sx={{ width: 42, height: 42 }} />
                                      <Stack spacing={0.75} sx={{ flex: 1 }}>
                                        <Box sx={{ width: '56%', height: 10, borderRadius: 999, bgcolor: alpha(theme.palette.text.primary, 0.08) }} />
                                        <Box sx={{ width: '72%', height: 9, borderRadius: 999, bgcolor: alpha(theme.palette.text.primary, 0.05) }} />
                                      </Stack>
                                    </Stack>
                                  </Paper>
                                ))}
                              </Stack>
                            ) : null}

                            {!isFriendsTabLoading && accepted.length === 0 ? (
                              <Paper
                                variant="outlined"
                                sx={{ p: 2, borderRadius: 2.5, textAlign: 'center' }}
                              >
                                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                                  Aún no tienes amigos
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                  Cuando aceptes una solicitud, tus conversaciones aparecerán aquí.
                                </Typography>
                              </Paper>
                            ) : null}

                            {!isFriendsTabLoading ? (
                              <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {accepted.map((entry) => {
                                  const online = isFriendOnline(entry);
                                  const feedback = rowFeedback[entry.friend.id];
                                  const rowError = rowErrors[entry.friend.id];
                                  const opening = openingFriendIds.has(entry.friend.id);
                                  const unreadCount = Math.max(0, entry.unreadCount ?? 0);

                                  return (
                                    <Paper
                                      key={entry.id}
                                      variant="outlined"
                                      sx={{
                                        position: 'relative',
                                        borderRadius: 2.5,
                                        overflow: 'visible',
                                        borderColor: alpha(theme.palette.divider, 0.8),
                                      }}
                                    >
                                      {unreadCount > 0 ? (
                                        <Chip
                                          size="small"
                                          color="error"
                                          label={unreadCount > 99 ? '99+' : unreadCount}
                                          sx={{
                                            position: 'absolute',
                                            top: -7,
                                            right: 10,
                                            zIndex: 1,
                                            minWidth: 24,
                                            height: 22,
                                            borderRadius: 11,
                                            fontSize: '0.72rem',
                                            fontWeight: 800,
                                            boxShadow: `0 0 0 2px ${theme.palette.background.paper}`,
                                          }}
                                        />
                                      ) : null}
                                      <ListItemButton
                                        onClick={() => void handleOpenChat(entry)}
                                        disabled={opening}
                                        sx={{
                                          alignItems: 'flex-start',
                                          gap: 1.5,
                                          px: 1.5,
                                          py: 1.4,
                                        }}
                                      >
                                        <Badge
                                          color={online ? 'success' : 'default'}
                                          overlap="circular"
                                          variant="dot"
                                          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                                        >
                                          <Avatar sx={{ width: 42, height: 42 }}>
                                            {friendLabel(entry).slice(0, 1).toUpperCase()}
                                          </Avatar>
                                        </Badge>

                                        <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
                                          <Stack direction="row" spacing={1} alignItems="center">
                                            <Typography variant="body1" sx={{ fontWeight: 600 }} noWrap>
                                              {friendLabel(entry)}
                                            </Typography>
                                            <Chip
                                              size="small"
                                              variant="outlined"
                                              label={online ? 'En línea' : 'Disponible'}
                                              color={online ? 'success' : 'default'}
                                            />
                                          </Stack>
                                          <Typography variant="body2" color="text.secondary" noWrap>
                                            @{entry.friend.username}
                                          </Typography>
                                          <Typography variant="caption" color="text.secondary" noWrap>
                                            {formatRelativeActivity(activityTimestamp(entry))}
                                          </Typography>
                                          {feedback ? (
                                            <Typography variant="caption" color="primary.main">
                                              {feedback}
                                            </Typography>
                                          ) : null}
                                          {rowError ? (
                                            <Typography variant="caption" color="error.main">
                                              {rowError}
                                            </Typography>
                                          ) : null}
                                        </Stack>
                                      </ListItemButton>
                                    </Paper>
                                  );
                                })}
                              </List>
                            ) : null}
                          </Stack>
                        ) : activeTab === 'requests' ? (
                          <Stack spacing={1.25}>
                            {isRequestsTabLoading ? (
                              <Stack spacing={1}>
                                {[0, 1].map((item) => (
                                  <Paper key={item} variant="outlined" sx={{ p: 1.5, borderRadius: 2.5 }}>
                                    <Stack direction="row" spacing={1.25} alignItems="center">
                                      <Avatar sx={{ width: 40, height: 40 }} />
                                      <Stack spacing={0.75} sx={{ flex: 1 }}>
                                        <Box sx={{ width: '48%', height: 10, borderRadius: 999, bgcolor: alpha(theme.palette.text.primary, 0.08) }} />
                                        <Box sx={{ width: '64%', height: 9, borderRadius: 999, bgcolor: alpha(theme.palette.text.primary, 0.05) }} />
                                      </Stack>
                                    </Stack>
                                  </Paper>
                                ))}
                              </Stack>
                            ) : null}

                            {!isRequestsTabLoading && pendingIncoming.length === 0 && pendingOutgoing.length === 0 ? (
                              <Paper
                                variant="outlined"
                                sx={{ p: 2, borderRadius: 2.5, textAlign: 'center' }}
                              >
                                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                                  No hay solicitudes pendientes
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                  Cuando alguien te agregue o envíes una invitación, aparecerá aquí.
                                </Typography>
                              </Paper>
                            ) : null}

                            {pendingIncoming.length > 0 ? (
                              <Stack spacing={1}>
                                <Typography variant="subtitle2" sx={{ px: 0.5 }}>
                                  Recibidas
                                </Typography>
                                {pendingIncoming.map((entry) => {
                                  const busy = requestBusyIds.has(entry.id);
                                  return (
                                    <Paper key={entry.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2.5 }}>
                                      <Stack spacing={1.25}>
                                        <Stack direction="row" spacing={1.25} alignItems="center">
                                          <Avatar sx={{ width: 40, height: 40 }}>
                                            {requestLabel(entry).slice(0, 1).toUpperCase()}
                                          </Avatar>
                                          <Stack sx={{ flex: 1, minWidth: 0 }}>
                                            <Typography variant="body1" sx={{ fontWeight: 600 }} noWrap>
                                              {requestLabel(entry)}
                                            </Typography>
                                            <Typography variant="body2" color="text.secondary" noWrap>
                                              @{entry.friend.username}
                                            </Typography>
                                          </Stack>
                                        </Stack>
                                        <Stack direction="row" spacing={1}>
                                          <Button
                                            size="small"
                                            variant="contained"
                                            startIcon={<CheckRounded />}
                                            disabled={busy}
                                            onClick={() => void runRequestAction(
                                              entry.id,
                                              async () => await window.forger.acceptFriendRequest(entry.id),
                                              `Agregaste a @${entry.friend.username} a tus amigos.`,
                                            )}
                                          >
                                            Aceptar
                                          </Button>
                                          <Button
                                            size="small"
                                            variant="outlined"
                                            color="inherit"
                                            startIcon={<CloseRounded />}
                                            disabled={busy}
                                            onClick={() => void runRequestAction(
                                              entry.id,
                                              async () => await window.forger.declineFriendRequest(entry.id),
                                              `Rechazaste la solicitud de @${entry.friend.username}.`,
                                            )}
                                          >
                                            Rechazar
                                          </Button>
                                        </Stack>
                                        {requestErrors[entry.id] ? (
                                          <Typography variant="caption" color="error.main">
                                            {requestErrors[entry.id]}
                                          </Typography>
                                        ) : null}
                                        {requestFeedback[entry.id] ? (
                                          <Typography variant="caption" color="primary.main">
                                            {requestFeedback[entry.id]}
                                          </Typography>
                                        ) : null}
                                      </Stack>
                                    </Paper>
                                  );
                                })}
                              </Stack>
                            ) : null}

                            {pendingOutgoing.length > 0 ? (
                              <Stack spacing={1}>
                                <Typography variant="subtitle2" sx={{ px: 0.5 }}>
                                  Enviadas
                                </Typography>
                                {pendingOutgoing.map((entry) => {
                                  const busy = requestBusyIds.has(entry.id);
                                  return (
                                    <Paper key={entry.id} variant="outlined" sx={{ p: 1.5, borderRadius: 2.5 }}>
                                      <Stack spacing={1.25}>
                                        <Stack direction="row" spacing={1.25} alignItems="center">
                                          <Avatar sx={{ width: 40, height: 40 }}>
                                            {requestLabel(entry).slice(0, 1).toUpperCase()}
                                          </Avatar>
                                          <Stack sx={{ flex: 1, minWidth: 0 }}>
                                            <Typography variant="body1" sx={{ fontWeight: 600 }} noWrap>
                                              {requestLabel(entry)}
                                            </Typography>
                                            <Typography variant="body2" color="text.secondary" noWrap>
                                              @{entry.friend.username}
                                            </Typography>
                                          </Stack>
                                          <Chip size="small" label="Pendiente" color="warning" variant="outlined" />
                                        </Stack>
                                        <Button
                                          size="small"
                                          variant="text"
                                          color="inherit"
                                          startIcon={<PersonAddDisabledRounded />}
                                          disabled={busy}
                                          onClick={() => void runRequestAction(
                                            entry.id,
                                            async () => await window.forger.cancelFriendRequest(entry.id),
                                            `Cancelaste la solicitud para @${entry.friend.username}.`,
                                          )}
                                        >
                                          Cancelar
                                        </Button>
                                        {requestErrors[entry.id] ? (
                                          <Typography variant="caption" color="error.main">
                                            {requestErrors[entry.id]}
                                          </Typography>
                                        ) : null}
                                        {requestFeedback[entry.id] ? (
                                          <Typography variant="caption" color="primary.main">
                                            {requestFeedback[entry.id]}
                                          </Typography>
                                        ) : null}
                                      </Stack>
                                    </Paper>
                                  );
                                })}
                              </Stack>
                            ) : null}
                          </Stack>
                        ) : (
                          <Stack spacing={1.25}>
                            <Box component="form" onSubmit={handleSearchFriends}>
                              <Stack direction="row" spacing={1}>
                                <TextField
                                  fullWidth
                                  size="small"
                                  value={friendSearch}
                                  onChange={(event) => {
                                    setFriendSearch(event.target.value);
                                    setAddFriendError(null);
                                    setAddFriendFeedback(null);
                                  }}
                                  placeholder="@username"
                                  autoComplete="off"
                                  disabled={friendSearchLoading}
                                />
                                <Button
                                  type="submit"
                                  variant="contained"
                                  startIcon={
                                    friendSearchLoading
                                      ? <CircularProgress color="inherit" size={16} />
                                      : <SearchRounded />
                                  }
                                  disabled={!friendSearch.trim() || friendSearchLoading}
                                >
                                  Buscar
                                </Button>
                              </Stack>
                            </Box>

                            {addFriendError ? <Alert severity="error">{addFriendError}</Alert> : null}
                            {addFriendFeedback ? <Alert severity="info">{addFriendFeedback}</Alert> : null}

                            {friendSearchResults.length > 0 ? (
                              <List disablePadding sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {friendSearchResults.map((user) => {
                                  const sending = friendRequestSendingId === user.id;
                                  const name = user.firstName || user.username;
                                  return (
                                    <Paper
                                      key={user.id}
                                      variant="outlined"
                                      sx={{
                                        borderRadius: 1,
                                        overflow: 'hidden',
                                        borderColor: alpha(theme.palette.divider, 0.8),
                                      }}
                                    >
                                      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ p: 1.5 }}>
                                        <Avatar sx={{ width: 40, height: 40 }}>
                                          {name.slice(0, 1).toUpperCase()}
                                        </Avatar>
                                        <Stack sx={{ flex: 1, minWidth: 0 }}>
                                          <Typography variant="body1" sx={{ fontWeight: 600 }} noWrap>
                                            {name}
                                          </Typography>
                                          <Typography variant="body2" color="text.secondary" noWrap>
                                            @{user.username}
                                          </Typography>
                                        </Stack>
                                        <Button
                                          size="small"
                                          variant="contained"
                                          startIcon={
                                            sending
                                              ? <CircularProgress color="inherit" size={14} />
                                              : <PersonAddRounded />
                                          }
                                          disabled={Boolean(friendRequestSendingId)}
                                          onClick={() => void handleSendFriendRequest(user)}
                                        >
                                          Enviar
                                        </Button>
                                      </Stack>
                                    </Paper>
                                  );
                                })}
                              </List>
                            ) : null}

                            {friendSearchResults.length === 0 && !addFriendFeedback ? (
                              <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
                                <Typography variant="body1" sx={{ fontWeight: 600 }}>
                                  Busca a alguien por username
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                  Escribe el username exacto o el inicio del username para enviar una solicitud.
                                </Typography>
                              </Paper>
                            ) : null}
                          </Stack>
                        )
                      ) : null}
                    </Box>
                  </Stack>
                </Paper>
              </Grow>
            )}
          </Popper>
        </Box>
      </ClickAwayListener>
    </Box>
  );
}
