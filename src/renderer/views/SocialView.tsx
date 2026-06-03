import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import ChatRounded from '@mui/icons-material/ChatRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import PersonAddRounded from '@mui/icons-material/PersonAddRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  List,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  alpha,
  useTheme,
  type AlertColor,
} from '@mui/material';
import type {
  CloudFriendship,
  CloudFriendUser,
  ForgerAccountSession,
  FriendChatWindowOpenResult,
  SocialUserApp,
  SocialUserProfile,
  SocialUserProfileDetail,
} from '@shared/types';
import { ForumPanel } from './friends/ForumPanel';
import {
  LAST_SOCIAL_TAB_KEY,
  activityTimestamp,
  formatRelativeActivity,
  friendLabel,
  isFriendOnline,
  requestLabel,
  sortFriends,
  type SocialTab,
} from './friends/socialViewHelpers';

type FullSocialTab = 'friends' | 'forum' | 'apps' | 'profile';

interface SocialViewProps {
  account: ForgerAccountSession;
  accountBusy?: boolean;
  initialProfileUsername?: string | null;
  onInitialProfileUsernameConsumed?: () => void;
  onOpenFriendChat?: (friendship: CloudFriendship) => Promise<FriendChatWindowOpenResult> | FriendChatWindowOpenResult;
  onOpenCloudModal: () => void;
  onOpenSocialApp: (app: SocialUserApp) => void;
  onNotify?: (message: string, severity?: AlertColor) => void;
  onUpdateUsername?: (username: string) => Promise<boolean>;
}

const fullSocialTabs: Array<{ value: FullSocialTab; label: string }> = [
  { value: 'friends', label: 'Amigos' },
  { value: 'forum', label: 'Foro' },
  { value: 'apps', label: 'Mis apps' },
  { value: 'profile', label: 'Perfil' },
];

const readFullSocialTab = (): FullSocialTab => {
  if (typeof window === 'undefined') return 'friends';
  const value = window.sessionStorage.getItem(LAST_SOCIAL_TAB_KEY);
  return value === 'forum' || value === 'apps' || value === 'profile' ? value : 'friends';
};

const formatBytes = (value?: number) => {
  if (!value || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toLocaleString(undefined, { maximumFractionDigits: unitIndex === 0 ? 0 : 1 })} ${units[unitIndex]}`;
};

const profileName = (profile: SocialUserProfile) =>
  profile.firstName ? `${profile.firstName}${profile.lastInitial ? ` ${profile.lastInitial}.` : ''}` : `@${profile.username}`;

const visibilityLabel = (app: SocialUserApp) => {
  if (app.accessReason === 'direct_share') return 'Compartida contigo';
  if (app.visibility === 'public') return 'Pública';
  if (app.visibility === 'friends') return 'Amigos';
  if (app.visibility === 'restricted') return 'Restringida';
  return 'Privada';
};

const SocialAppCard = ({
  app,
  ownerLabel,
  onOpen,
}: {
  app: SocialUserApp;
  ownerLabel?: string;
  onOpen: (app: SocialUserApp) => void;
}) => (
  <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1.25} alignItems="flex-start">
        <Avatar sx={{ width: 42, height: 42 }}>{app.name.slice(0, 1).toUpperCase()}</Avatar>
        <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
            <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>{app.name}</Typography>
            <Chip size="small" label={visibilityLabel(app)} variant="outlined" />
            {app.status !== 'published' ? <Chip size="small" label="No publicada" color="warning" variant="outlined" /> : null}
          </Stack>
          {ownerLabel ? (
            <Typography variant="caption" color="text.secondary" noWrap>{ownerLabel}</Typography>
          ) : null}
          <Typography variant="body2" color="text.secondary" noWrap>
            {app.shortDescription || app.description || 'App compartida desde Forger Social'}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            Version {app.latestVersion?.version ?? '-'} · {formatBytes(app.latestVersion?.fileSizeBytes)}
          </Typography>
        </Stack>
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button
          size="small"
          variant="contained"
          startIcon={<OpenInNewRounded />}
          disabled={app.status !== 'published'}
          onClick={() => onOpen(app)}
        >
          Abrir app
        </Button>
      </Stack>
    </Stack>
  </Paper>
);

export function SocialView({
  account,
  accountBusy = false,
  initialProfileUsername,
  onInitialProfileUsernameConsumed,
  onOpenFriendChat,
  onOpenCloudModal,
  onOpenSocialApp,
  onNotify,
  onUpdateUsername,
}: SocialViewProps) {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState<FullSocialTab>(readFullSocialTab);
  const [friendships, setFriendships] = useState<CloudFriendship[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [openingFriendId, setOpeningFriendId] = useState<number | null>(null);
  const [friendSearch, setFriendSearch] = useState('');
  const [friendSearchResults, setFriendSearchResults] = useState<CloudFriendUser[]>([]);
  const [friendSearchLoading, setFriendSearchLoading] = useState(false);
  const [friendRequestSendingId, setFriendRequestSendingId] = useState<number | null>(null);
  const [friendSearchMessage, setFriendSearchMessage] = useState<string | null>(null);
  const [friendSearchError, setFriendSearchError] = useState<string | null>(null);
  const [myApps, setMyApps] = useState<SocialUserApp[]>([]);
  const [myAppsLoading, setMyAppsLoading] = useState(false);
  const [myAppsError, setMyAppsError] = useState<string | null>(null);
  const [profileUsernameDraft, setProfileUsernameDraft] = useState(account.user?.username ?? '');
  const [activeProfileUsername, setActiveProfileUsername] = useState(account.user?.username ?? '');
  const [profile, setProfile] = useState<SocialUserProfile | null>(null);
  const [profileApps, setProfileApps] = useState<SocialUserApp[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileUsernameBusy, setProfileUsernameBusy] = useState(false);
  const [profileUsernameError, setProfileUsernameError] = useState<string | null>(null);
  const signedIn = account.authenticated && Boolean(account.user?.confirmed);

  const accountUserId = account.user?.id;
  const accountUsername = account.user?.username?.trim() ?? '';
  const accepted = useMemo(() => sortFriends(friendships.filter((entry) => entry.status === 'accepted')), [friendships]);
  const pendingIncoming = useMemo(
    () => friendships.filter((entry) => entry.status === 'pending' && entry.addresseeId === accountUserId),
    [accountUserId, friendships],
  );
  const pendingOutgoing = useMemo(
    () => friendships.filter((entry) => entry.status === 'pending' && entry.requesterId === accountUserId),
    [accountUserId, friendships],
  );

  const switchTab = useCallback((value: FullSocialTab) => {
    setActiveTab(value);
    const nextTab: SocialTab = value;
    window.sessionStorage.setItem(LAST_SOCIAL_TAB_KEY, nextTab);
  }, []);

  const openProfile = useCallback((username: string) => {
    const normalized = username.trim().replace(/^@/, '');
    if (!normalized) return;
    setActiveProfileUsername(normalized);
    setProfileUsernameDraft(normalized);
    switchTab('profile');
  }, [switchTab]);

  const loadFriends = useCallback(async () => {
    if (!signedIn) return;
    setFriendsLoading(true);
    setFriendsError(null);
    try {
      setFriendships(await window.forger.listFriends());
    } catch (error) {
      setFriendsError(error instanceof Error ? error.message : 'No pudimos cargar tus amigos.');
    } finally {
      setFriendsLoading(false);
    }
  }, [signedIn]);

  const loadMyApps = useCallback(async () => {
    if (!signedIn) return;
    setMyAppsLoading(true);
    setMyAppsError(null);
    try {
      const payload = await window.forger.listMySocialApps();
      setMyApps(payload.apps);
    } catch (error) {
      setMyAppsError(error instanceof Error ? error.message : 'No pudimos cargar tus apps.');
    } finally {
      setMyAppsLoading(false);
    }
  }, [signedIn]);

  const loadProfile = useCallback(async (username: string) => {
    const normalized = username.trim().replace(/^@/, '');
    if (!normalized) return;
    setProfileLoading(true);
    setProfileError(null);
    try {
      const payload: SocialUserProfileDetail = await window.forger.getSocialProfile(normalized);
      setProfile(payload.profile);
      setProfileApps(payload.apps);
      if (!payload.profile) {
        setProfileError(`No encontramos el perfil @${normalized}.`);
      }
    } catch (error) {
      setProfile(null);
      setProfileApps([]);
      setProfileError(error instanceof Error ? error.message : 'No pudimos cargar este perfil.');
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    setProfileUsernameDraft(accountUsername);
    setActiveProfileUsername((current) => current || accountUsername);
  }, [accountUsername]);

  useEffect(() => {
    if (!signedIn) {
      setFriendships([]);
      setMyApps([]);
      return;
    }
    void loadFriends();
  }, [signedIn, loadFriends]);

  useEffect(() => {
    if (activeTab === 'apps') void loadMyApps();
  }, [activeTab, loadMyApps]);

  useEffect(() => {
    if (activeTab === 'profile') void loadProfile(activeProfileUsername || accountUsername);
  }, [accountUsername, activeProfileUsername, activeTab, loadProfile]);

  useEffect(() => {
    if (!initialProfileUsername) return;
    openProfile(initialProfileUsername);
    onInitialProfileUsernameConsumed?.();
  }, [initialProfileUsername, onInitialProfileUsernameConsumed, openProfile]);

  const handleOpenChat = async (friendship: CloudFriendship) => {
    if (openingFriendId !== null) return;
    setOpeningFriendId(friendship.friend.id);
    try {
      const result = await onOpenFriendChat?.(friendship);
      const message = result?.userMessage ?? `Chat de @${friendship.friend.username} listo.`;
      onNotify?.(message, 'info');
      void window.forger.markFriendChatRead(friendship.friend.id).then((next) => {
        setFriendships((current) => current.map((entry) => entry.id === next.id ? next : entry));
      }).catch(() => undefined);
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : 'No pudimos abrir este chat.', 'error');
    } finally {
      setOpeningFriendId(null);
    }
  };

  const handleSearchFriends = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    const username = friendSearch.trim().replace(/^@/, '');
    if (!username) return;
    setFriendSearchLoading(true);
    setFriendSearchMessage(null);
    setFriendSearchError(null);
    try {
      const results = await window.forger.searchFriends(username);
      const visibleResults = results.filter((result) => result.id !== accountUserId);
      setFriendSearchResults(visibleResults);
      if (visibleResults.length === 0) setFriendSearchMessage(`No encontramos a @${username}.`);
    } catch (error) {
      setFriendSearchError(error instanceof Error ? error.message : 'No pudimos buscar ese usuario.');
    } finally {
      setFriendSearchLoading(false);
    }
  };

  const handleSendFriendRequest = async (user: CloudFriendUser) => {
    if (friendRequestSendingId !== null) return;
    setFriendRequestSendingId(user.id);
    setFriendSearchError(null);
    setFriendSearchMessage(null);
    try {
      const friendship = await window.forger.sendFriendRequest(user.username);
      setFriendships((current) => [friendship, ...current.filter((entry) => entry.id !== friendship.id)]);
      setFriendSearchResults((current) => current.filter((entry) => entry.id !== user.id));
      setFriendSearchMessage(`Solicitud enviada a @${user.username}.`);
      onNotify?.(`Solicitud enviada a @${user.username}.`, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No pudimos enviar la solicitud.';
      setFriendSearchError(message);
      onNotify?.(message, 'error');
    } finally {
      setFriendRequestSendingId(null);
    }
  };

  const handleProfileSearch = (event?: SyntheticEvent) => {
    event?.preventDefault();
    openProfile(profileUsernameDraft);
  };

  const handleUsernameSubmit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    const nextUsername = profileUsernameDraft.trim().replace(/^@/, '');
    if (!nextUsername || accountBusy || profileUsernameBusy || !onUpdateUsername) return;
    setProfileUsernameBusy(true);
    setProfileUsernameError(null);
    try {
      const success = await onUpdateUsername(nextUsername);
      if (!success) {
        setProfileUsernameError('No pudimos actualizar tu username.');
        return;
      }
      setActiveProfileUsername(nextUsername);
      onNotify?.('Username actualizado.', 'success');
    } finally {
      setProfileUsernameBusy(false);
    }
  };

  const renderSignedOut = () => (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, maxWidth: 560 }}>
      <Stack spacing={1.5} alignItems="flex-start">
        <Typography variant="h6">Social requiere Forger Cloud</Typography>
        <Typography color="text.secondary">Inicia sesión para ver amigos, foro, apps compartidas y perfiles.</Typography>
        <Button variant="contained" onClick={onOpenCloudModal}>Iniciar sesión</Button>
      </Stack>
    </Paper>
  );

  const renderFriends = () => (
    <Stack spacing={2}>
      <Box component="form" onSubmit={handleSearchFriends}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            size="small"
            value={friendSearch}
            onChange={(event) => {
              setFriendSearch(event.target.value);
              setFriendSearchError(null);
              setFriendSearchMessage(null);
            }}
            placeholder="@username"
            autoComplete="off"
            sx={{ maxWidth: { sm: 360 } }}
          />
          <Button
            type="submit"
            variant="outlined"
            startIcon={friendSearchLoading ? <CircularProgress size={16} color="inherit" /> : <SearchRounded />}
            disabled={!friendSearch.trim() || friendSearchLoading}
            sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}
          >
            Buscar
          </Button>
        </Stack>
      </Box>
      {friendSearchError ? <Alert severity="error">{friendSearchError}</Alert> : null}
      {friendSearchMessage ? <Alert severity="info">{friendSearchMessage}</Alert> : null}
      {friendSearchResults.length > 0 ? (
        <Stack spacing={1}>
          <Typography variant="subtitle2">Resultados</Typography>
          <List disablePadding sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
            {friendSearchResults.map((user) => {
              const name = user.firstName || user.username;
              const sending = friendRequestSendingId === user.id;
              return (
                <Paper key={user.id} variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
                  <Stack direction="row" spacing={1.25} alignItems="center">
                    <Avatar>{name.slice(0, 1).toUpperCase()}</Avatar>
                    <Stack sx={{ flex: 1, minWidth: 0 }}>
                      <Typography fontWeight={700} noWrap>{name}</Typography>
                      <Typography variant="body2" color="text.secondary" noWrap>@{user.username}</Typography>
                    </Stack>
                    <Button size="small" onClick={() => openProfile(user.username)}>Ver perfil</Button>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={sending ? <CircularProgress color="inherit" size={14} /> : <PersonAddRounded />}
                      disabled={friendRequestSendingId !== null}
                      onClick={() => void handleSendFriendRequest(user)}
                    >
                      Enviar
                    </Button>
                  </Stack>
                </Paper>
              );
            })}
          </List>
        </Stack>
      ) : null}
      <Divider />
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">Amigos</Typography>
          <Button size="small" startIcon={<RefreshRounded />} onClick={() => void loadFriends()} disabled={friendsLoading}>Actualizar</Button>
        </Stack>
        {friendsError ? <Alert severity="error">{friendsError}</Alert> : null}
        {friendsLoading && accepted.length === 0 ? (
          <Stack alignItems="center" spacing={1.25} sx={{ py: 4 }}>
            <CircularProgress size={24} />
            <Typography variant="body2" color="text.secondary">Cargando amigos...</Typography>
          </Stack>
        ) : null}
        {!friendsLoading && accepted.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
            <Typography fontWeight={700}>Aún no tienes amigos</Typography>
            <Typography variant="body2" color="text.secondary">Busca por username o acepta solicitudes pendientes.</Typography>
          </Paper>
        ) : null}
        {accepted.length > 0 ? (
          <List disablePadding sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
            {accepted.map((entry) => {
              const online = isFriendOnline(entry);
              const unreadCount = Math.max(0, entry.unreadCount ?? 0);
              const opening = openingFriendId === entry.friend.id;
              return (
                <Paper key={entry.id} variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
                  <Stack direction="row" spacing={1.25} alignItems="center">
                    <Badge color={online ? 'success' : 'default'} overlap="circular" variant="dot" anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
                      <Avatar>{friendLabel(entry).slice(0, 1).toUpperCase()}</Avatar>
                    </Badge>
                    <Stack sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
                        <Typography fontWeight={700} noWrap>{friendLabel(entry)}</Typography>
                        {unreadCount > 0 ? <Chip size="small" color="error" label={unreadCount > 99 ? '99+' : unreadCount} /> : null}
                      </Stack>
                      <Typography variant="body2" color="text.secondary" noWrap>@{entry.friend.username}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>{formatRelativeActivity(activityTimestamp(entry))}</Typography>
                    </Stack>
                    <Button size="small" onClick={() => openProfile(entry.friend.username)}>Ver perfil</Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={opening ? <CircularProgress size={14} color="inherit" /> : <ChatRounded />}
                      disabled={openingFriendId !== null}
                      onClick={() => void handleOpenChat(entry)}
                    >
                      Chat
                    </Button>
                  </Stack>
                </Paper>
              );
            })}
          </List>
        ) : null}
      </Stack>
      {pendingIncoming.length > 0 || pendingOutgoing.length > 0 ? (
        <Stack spacing={1}>
          <Typography variant="h6">Solicitudes</Typography>
          {[...pendingIncoming, ...pendingOutgoing].map((entry) => (
            <Paper key={entry.id} variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
              <Stack direction="row" spacing={1.25} alignItems="center">
                <Avatar>{requestLabel(entry).slice(0, 1).toUpperCase()}</Avatar>
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography fontWeight={700} noWrap>{requestLabel(entry)}</Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>@{entry.friend.username}</Typography>
                </Stack>
                <Chip size="small" label={entry.addresseeId === accountUserId ? 'Recibida' : 'Enviada'} variant="outlined" />
                <Button size="small" onClick={() => openProfile(entry.friend.username)}>Ver perfil</Button>
              </Stack>
            </Paper>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );

  const renderMyApps = () => (
    <Stack spacing={1.25}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">Mis apps en Social</Typography>
        <Button size="small" startIcon={<RefreshRounded />} onClick={() => void loadMyApps()} disabled={myAppsLoading}>Actualizar</Button>
      </Stack>
      {myAppsError ? <Alert severity="error">{myAppsError}</Alert> : null}
      {myAppsLoading && myApps.length === 0 ? (
        <Stack alignItems="center" spacing={1.25} sx={{ py: 4 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">Cargando apps...</Typography>
        </Stack>
      ) : null}
      {!myAppsLoading && myApps.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
          <Typography fontWeight={700}>No has subido apps a Social</Typography>
          <Typography variant="body2" color="text.secondary">Usa Subir a Social desde una app tuya para publicarla o compartirla.</Typography>
        </Paper>
      ) : null}
      {myApps.length > 0 ? (
        <List disablePadding sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
          {myApps.map((app) => <SocialAppCard key={app.id} app={app} ownerLabel="Tuya" onOpen={onOpenSocialApp} />)}
        </List>
      ) : null}
    </Stack>
  );

  const renderProfile = () => (
    <Stack spacing={2}>
      <Box component="form" onSubmit={handleProfileSearch}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            size="small"
            label="Perfil"
            value={profileUsernameDraft}
            onChange={(event) => {
              setProfileUsernameDraft(event.target.value);
              setProfileUsernameError(null);
            }}
            placeholder="@username"
            autoComplete="off"
            sx={{ maxWidth: { sm: 360 } }}
          />
          <Button type="submit" variant="outlined" disabled={!profileUsernameDraft.trim()} startIcon={<SearchRounded />}>Ver perfil</Button>
          {accountUsername && profileUsernameDraft.replace(/^@/, '') !== accountUsername && onUpdateUsername ? (
            <Button
              variant="text"
              disabled={accountBusy || profileUsernameBusy || !profileUsernameDraft.trim()}
              onClick={() => void handleUsernameSubmit()}
            >
              {profileUsernameBusy ? 'Guardando...' : 'Usar como mi username'}
            </Button>
          ) : null}
        </Stack>
      </Box>
      {profileUsernameError ? <Alert severity="error">{profileUsernameError}</Alert> : null}
      {profileLoading ? (
        <Stack alignItems="center" spacing={1.25} sx={{ py: 5 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">Cargando perfil...</Typography>
        </Stack>
      ) : null}
      {!profileLoading && profileError ? (
        <Stack spacing={1.25}>
          <Alert severity="error">{profileError}</Alert>
          <Button variant="outlined" onClick={() => void loadProfile(activeProfileUsername || accountUsername)} sx={{ alignSelf: 'flex-start' }}>
            Reintentar
          </Button>
        </Stack>
      ) : null}
      {!profileLoading && !profileError && !profile ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
          <Typography fontWeight={700}>Busca un perfil</Typography>
          <Typography variant="body2" color="text.secondary">Escribe un username o abre el perfil desde amigos o foro.</Typography>
        </Paper>
      ) : null}
      {!profileLoading && !profileError && profile ? (
        <Stack spacing={1.5}>
          <Paper
            variant="outlined"
            sx={{
              p: 2,
              borderRadius: 1,
              borderColor: alpha(theme.palette.primary.main, 0.28),
              bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.1 : 0.04),
            }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }}>
              <Avatar sx={{ width: 60, height: 60, fontSize: 24 }}>{profileName(profile).slice(0, 1).toUpperCase()}</Avatar>
              <Stack sx={{ minWidth: 0, flex: 1 }}>
                <Typography variant="h5" fontWeight={800} noWrap>{profileName(profile)}</Typography>
                <Typography color="text.secondary" noWrap>@{profile.username}</Typography>
                {profile.socialBio ? <Typography sx={{ mt: 0.75 }}>{profile.socialBio}</Typography> : null}
              </Stack>
              <Chip label={`${profileApps.length} apps`} variant="outlined" />
            </Stack>
          </Paper>
          <Stack spacing={1}>
            <Typography variant="h6">Apps publicadas</Typography>
            {profileApps.length === 0 ? (
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 1, textAlign: 'center' }}>
                <Typography fontWeight={700}>Sin apps visibles</Typography>
                <Typography variant="body2" color="text.secondary">Este perfil no tiene apps disponibles para ti.</Typography>
              </Paper>
            ) : (
              <List disablePadding sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
                {profileApps.map((app) => (
                  <SocialAppCard key={app.id} app={app} ownerLabel={`@${app.owner.username}`} onOpen={onOpenSocialApp} />
                ))}
              </List>
            )}
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>Social</Typography>
        <Typography color="text.secondary">Amigos, foro, apps compartidas y perfiles de Forger.</Typography>
      </Stack>

      {!signedIn && activeTab !== 'profile' ? renderSignedOut() : (
        <>
          <Tabs
            value={activeTab}
            onChange={(_event, value: FullSocialTab) => switchTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            allowScrollButtonsMobile
          >
            {fullSocialTabs.map((tab) => <Tab key={tab.value} value={tab.value} label={tab.label} />)}
          </Tabs>
          <Divider />
          {activeTab === 'friends' ? (signedIn ? renderFriends() : renderSignedOut()) : null}
          {activeTab === 'forum' ? (signedIn ? <ForumPanel active onNotify={onNotify} onOpenProfile={openProfile} /> : renderSignedOut()) : null}
          {activeTab === 'apps' ? (signedIn ? renderMyApps() : renderSignedOut()) : null}
          {activeTab === 'profile' ? renderProfile() : null}
        </>
      )}
    </Stack>
  );
}
