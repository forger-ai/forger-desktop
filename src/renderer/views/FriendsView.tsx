import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type SyntheticEvent } from 'react';
import ForumRounded from '@mui/icons-material/ForumRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import PersonAddDisabledRounded from '@mui/icons-material/PersonAddDisabledRounded';
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
  List,
  ListItemButton,
  Paper,
  Popper,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
  alpha,
  useTheme,
  type AlertColor,
} from '@mui/material';
import type { CloudFriendship, ForgerAccountSession, FriendChatWindowOpenResult } from '@shared/types';

interface FriendsViewProps {
  account: ForgerAccountSession;
  onOpenFriendChat?: (friendship: CloudFriendship) => Promise<FriendChatWindowOpenResult> | FriendChatWindowOpenResult;
  onNotify?: (message: string, severity?: AlertColor) => void;
}

type SocialTab = 'friends' | 'requests';

const LAST_SOCIAL_TAB_KEY = 'forger.social.last-tab';

const friendLabel = (friendship: CloudFriendship) =>
  friendship.friend.firstName || friendship.friend.username;

const requestLabel = (friendship: CloudFriendship) =>
  friendship.friend.firstName || `@${friendship.friend.username}`;

const isFriendOnline = (friendship: CloudFriendship) =>
  Boolean(friendship.friend.online);

const activityTimestamp = (friendship: CloudFriendship) =>
  friendship.lastMessageAt ?? friendship.updatedAt;

const formatRelativeActivity = (value?: string) => {
  if (!value) {
    return 'Sin actividad reciente';
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return 'Actividad reciente';
  }

  const diffMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (diffMinutes < 2) {
    return 'Activo ahora';
  }
  if (diffMinutes < 60) {
    return `Activo hace ${diffMinutes} min`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `Activo hace ${diffHours} h`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `Activo hace ${diffDays} d`;
};

const sortFriends = (entries: CloudFriendship[]) =>
  [...entries].sort((left, right) => {
    const leftOnline = isFriendOnline(left) ? 1 : 0;
    const rightOnline = isFriendOnline(right) ? 1 : 0;
    if (leftOnline !== rightOnline) {
      return rightOnline - leftOnline;
    }

    const leftUpdated = new Date(activityTimestamp(left)).getTime();
    const rightUpdated = new Date(activityTimestamp(right)).getTime();
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }

    return friendLabel(left).localeCompare(friendLabel(right), 'es', { sensitivity: 'base' });
  });

const readLastSessionTab = (): SocialTab | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.sessionStorage.getItem(LAST_SOCIAL_TAB_KEY) === 'requests' ? 'requests' : 'friends';
};

const setTimedFeedback = (
  setter: Dispatch<SetStateAction<Record<number, string>>>,
  key: number,
  message: string,
) => {
  setter((current) => ({ ...current, [key]: message }));
  window.setTimeout(() => {
    setter((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, 2200);
};

export function FriendsView({ account, onOpenFriendChat, onNotify }: FriendsViewProps) {
  const theme = useTheme();
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const panelId = 'social-launcher-panel';
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

  const accepted = useMemo(
    () => sortFriends(friendships.filter((entry) => entry.status === 'accepted')),
    [friendships],
  );
  const pendingIncoming = useMemo(
    () => friendships.filter((entry) => entry.status === 'pending' && entry.addresseeId === account.user?.id),
    [account.user?.id, friendships],
  );
  const pendingOutgoing = useMemo(
    () => friendships.filter((entry) => entry.status === 'pending' && entry.requesterId === account.user?.id),
    [account.user?.id, friendships],
  );
  const pendingRequestsCount = pendingIncoming.length;
  const unseenPendingRequestCount = useMemo(
    () => pendingIncoming.filter((entry) => seenPendingRequestVersions[entry.id] !== entry.updatedAt).length,
    [pendingIncoming, seenPendingRequestVersions],
  );

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

  const loadFriends = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!account.authenticated || !account.user?.confirmed) {
      setFriendships([]);
      setLoading(false);
      setError(null);
      setHasLoadedOnce(false);
      setSeenPendingRequestVersions({});
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
  }, [account.authenticated, account.user?.confirmed, hasLoadedOnce]);

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

    setFriendships([]);
    setError(null);
    setLoading(false);
    setHasLoadedOnce(false);
    return undefined;
  }, [account.authenticated, account.user?.confirmed, hasLoadedOnce, loadFriends]);

  useEffect(() => {
    if (!account.authenticated || !account.user?.confirmed) {
      return undefined;
    }

    return window.forger.onCloudFriendshipEvent(() => {
      void loadFriends({ silent: true });
    });
  }, [account.authenticated, account.user?.confirmed, loadFriends]);

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

  const tabSubtitle =
    activeTab === 'friends'
      ? 'Tus conversaciones disponibles'
      : 'Gestiona solicitudes pendientes';

  const launcherBusy = loading && !hasLoadedOnce;
  const isFriendsTabLoading = loading && accepted.length === 0;
  const isRequestsTabLoading = loading && pendingIncoming.length === 0 && pendingOutgoing.length === 0;
  const tabErrorMessage = activeTab === 'friends'
    ? error ?? 'No pudimos cargar tus amigos.'
    : error ?? 'No pudimos cargar tus solicitudes.';

  return (
    <Box sx={{ position: 'fixed', right: 24, bottom: 24, zIndex: theme.zIndex.modal - 1 }}>
      <ClickAwayListener onClickAway={() => open && closePanel()}>
        <Box sx={{ position: 'relative' }}>
          <Tooltip title="Social" placement="left">
            <Badge
              color="error"
              badgeContent={pendingRequestsCount}
              overlap="rectangular"
              invisible={pendingRequestsCount === 0}
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
                ref={fabRef}
                aria-label="Social"
                aria-describedby={open ? panelId : undefined}
                aria-expanded={open}
                onClick={handleToggle}
                sx={{
                  width: 64,
                  height: 64,
                  minHeight: 64,
                  borderRadius: 2.5,
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

          <Popper
            id={panelId}
            open={open}
            anchorEl={fabRef.current}
            placement="top-end"
            transition
            sx={{ zIndex: theme.zIndex.modal }}
            modifiers={[
              { name: 'offset', options: { offset: [0, 14] } },
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
                    borderRadius: 3,
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
                        <Chip
                          size="small"
                          label={pendingRequestsCount > 0 ? `${pendingRequestsCount} pendiente${pendingRequestsCount > 1 ? 's' : ''}` : 'Al día'}
                          color={pendingRequestsCount > 0 ? 'warning' : 'default'}
                          variant={pendingRequestsCount > 0 ? 'filled' : 'outlined'}
                        />
                      </Stack>
                      <Typography variant="body2" color="text.secondary">
                        {tabSubtitle}
                      </Typography>
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
                        label="Solicitudes de amistad"
                        sx={{ minHeight: 44 }}
                      />
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

                                  return (
                                    <Paper
                                      key={entry.id}
                                      variant="outlined"
                                      sx={{
                                        borderRadius: 2.5,
                                        overflow: 'hidden',
                                        borderColor: alpha(theme.palette.divider, 0.8),
                                      }}
                                    >
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
                        ) : (
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
