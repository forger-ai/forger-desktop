import { useCallback, useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import ChatRounded from '@mui/icons-material/ChatRounded';
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import OpenInNewRounded from '@mui/icons-material/OpenInNewRounded';
import PersonAddRounded from '@mui/icons-material/PersonAddRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import SearchRounded from '@mui/icons-material/SearchRounded';
import UploadRounded from '@mui/icons-material/UploadRounded';
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  List,
  MenuItem,
  Paper,
  Select,
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
  AppCategory,
  AppSummary,
  CloudFriendship,
  CloudFriendUser,
  ForgerAccountSession,
  FriendChatWindowOpenResult,
  SocialUserApp,
  SocialUserAppVisibility,
  SocialUserProfile,
  SocialUserProfileDetail,
} from '@shared/types';
import { APP_CATEGORIES } from '@shared/types/catalog';
import type { AppDictionary } from '@renderer/i18n';
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

type FullSocialTab = 'friends' | 'forum' | 'profile' | 'search';

interface SocialViewProps {
  account: ForgerAccountSession;
  t: AppDictionary;
  accountBusy?: boolean;
  initialProfileUsername?: string | null;
  installedApps?: AppSummary[];
  onInitialProfileUsernameConsumed?: () => void;
  onOpenFriendChat?: (friendship: CloudFriendship) => Promise<FriendChatWindowOpenResult> | FriendChatWindowOpenResult;
  onOpenCloudModal: () => void;
  onOpenSocialApp: (app: SocialUserApp) => void;
  onUploadSocial?: (appId: string, visibility?: Exclude<SocialUserAppVisibility, 'restricted'>, category?: AppCategory) => void;
  onNotify?: (message: string, severity?: AlertColor) => void;
  onUpdateUsername?: (username: string) => Promise<boolean>;
  onUpdateProfile?: (input: { displayName?: string }) => Promise<boolean>;
}

const appCategoryOptions: AppCategory[] = [...APP_CATEGORIES];
const editableVisibilityOptions: Array<Exclude<SocialUserAppVisibility, 'restricted'>> = ['private', 'friends', 'public'];

const fullSocialTabs: Array<{ value: FullSocialTab; label: string }> = [
  { value: 'friends', label: 'Amigos' },
  { value: 'forum', label: 'Foro' },
  { value: 'profile', label: 'Mi perfil' },
  { value: 'search', label: 'Buscar' },
];

const readFullSocialTab = (): FullSocialTab => {
  if (typeof window === 'undefined') return 'friends';
  const value = window.sessionStorage.getItem(LAST_SOCIAL_TAB_KEY);
  return value === 'forum' || value === 'profile' || value === 'search' ? value : 'friends';
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
  profile.displayName || (profile.firstName ? `${profile.firstName}${profile.lastInitial ? ` ${profile.lastInitial}.` : ''}` : `@${profile.username}`);

const isAppCategory = (value: string | undefined): value is AppCategory =>
  appCategoryOptions.some((category) => category === value);

const visibilityLabel = (app: SocialUserApp, t: AppDictionary, isOwnedByAccount = false) => {
  if (!isOwnedByAccount && app.accessReason === 'direct_share') return t.social.visibility.directShare;
  return t.social.visibility[app.visibility];
};

const SocialAppCard = ({
  app,
  t,
  ownerLabel,
  onOpen,
  accountUserId,
  onVisibilityChange,
  onEditInfo,
  onDelete,
  visibilityBusy,
}: {
  app: SocialUserApp;
  t: AppDictionary;
  ownerLabel?: string;
  onOpen: (app: SocialUserApp) => void;
  accountUserId?: number;
  onVisibilityChange?: (app: SocialUserApp, visibility: Exclude<SocialUserAppVisibility, 'restricted'>) => void;
  onEditInfo?: (app: SocialUserApp) => void;
  onDelete?: (app: SocialUserApp) => void;
  visibilityBusy?: boolean;
}) => {
  const isOwnedByAccount = accountUserId !== undefined && app.owner.id === accountUserId;
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1.25} alignItems="flex-start">
          <Avatar sx={{ width: 42, height: 42 }}>{app.name.slice(0, 1).toUpperCase()}</Avatar>
          <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" useFlexGap flexWrap="wrap">
              <Typography variant="body1" sx={{ fontWeight: 700 }} noWrap>{app.name}</Typography>
              <Chip size="small" label={visibilityLabel(app, t, isOwnedByAccount)} variant="outlined" />
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
          {onVisibilityChange ? (
            <Select
              size="small"
              value={app.visibility === 'restricted' ? 'private' : app.visibility}
              disabled={visibilityBusy}
              onChange={(event) => onVisibilityChange(app, event.target.value as Exclude<SocialUserAppVisibility, 'restricted'>)}
              sx={{ minWidth: 128 }}
            >
              {editableVisibilityOptions.map((visibility) => (
                <MenuItem key={visibility} value={visibility}>{t.social.visibility[visibility]}</MenuItem>
              ))}
            </Select>
          ) : null}
          {onEditInfo ? (
            <Button
              size="small"
              variant="outlined"
              startIcon={<EditRounded />}
              onClick={() => onEditInfo(app)}
            >
              {t.social.editAppInfoAction}
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<DeleteOutlineRounded />}
              disabled={app.status !== 'published'}
              onClick={() => onDelete(app)}
            >
              {t.social.unpublishAction}
            </Button>
          ) : null}
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
};

export function SocialView({
  account,
  t,
  accountBusy = false,
  installedApps = [],
  initialProfileUsername,
  onInitialProfileUsernameConsumed,
  onOpenFriendChat,
  onOpenCloudModal,
  onOpenSocialApp,
  onUploadSocial,
  onNotify,
  onUpdateUsername,
  onUpdateProfile,
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
  const [profileUrl, setProfileUrl] = useState('');
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileUsernameBusy, setProfileUsernameBusy] = useState(false);
  const [profileUsernameError, setProfileUsernameError] = useState<string | null>(null);
  const [profileEditOpen, setProfileEditOpen] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState(account.user?.displayName ?? '');
  const [profileInfoBusy, setProfileInfoBusy] = useState(false);
  const [profileInfoError, setProfileInfoError] = useState<string | null>(null);
  const [visibilityBusyId, setVisibilityBusyId] = useState<number | null>(null);
  const [deleteAppDialog, setDeleteAppDialog] = useState<{ app: SocialUserApp | null; busy: boolean; error: string | null }>({
    app: null,
    busy: false,
    error: null,
  });
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publishAppId, setPublishAppId] = useState('');
  const [publishVisibility, setPublishVisibility] = useState<Exclude<SocialUserAppVisibility, 'restricted'>>('private');
  const [publishCategory, setPublishCategory] = useState<AppCategory>('productivity');
  const [editAppDialog, setEditAppDialog] = useState<{
    app: SocialUserApp | null;
    name: string;
    shortDescription: string;
    description: string;
    category: AppCategory | '';
    visibility: Exclude<SocialUserAppVisibility, 'restricted'>;
    busy: boolean;
    error: string | null;
  }>({
    app: null,
    name: '',
    shortDescription: '',
    description: '',
    category: '',
    visibility: 'private',
    busy: false,
    error: null,
  });
  const signedIn = account.authenticated && Boolean(account.user?.confirmed);

  const accountUserId = account.user?.id;
  const accountUsername = account.user?.username?.trim() ?? '';
  const uploadCandidates = useMemo(
    () => installedApps.filter((app) => Boolean(app.privateLocal) && app.status !== 'installing'),
    [installedApps],
  );
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
    switchTab(normalized === accountUsername ? 'profile' : 'search');
  }, [accountUsername, switchTab]);

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
    setDisplayNameDraft(account.user?.displayName ?? '');
  }, [account.user?.displayName, accountUsername]);

  useEffect(() => {
    if (!signedIn) {
      setFriendships([]);
      setMyApps([]);
      return;
    }
    void loadFriends();
  }, [signedIn, loadFriends]);

  useEffect(() => {
    if (activeTab === 'profile') void loadMyApps();
  }, [activeTab, loadMyApps]);

  useEffect(() => {
    if (activeTab === 'profile') void loadProfile(accountUsername);
    if (activeTab === 'search') void loadProfile(activeProfileUsername);
  }, [accountUsername, activeProfileUsername, activeTab, loadProfile]);

  useEffect(() => {
    if (activeTab !== 'profile' || !accountUsername) return;
    void window.forger.getSocialProfileUrl(accountUsername)
      .then(setProfileUrl)
      .catch(() => setProfileUrl(''));
  }, [accountUsername, activeTab]);

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

  const handleProfileInfoSubmit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (!onUpdateProfile || profileInfoBusy) return;
    setProfileInfoBusy(true);
    setProfileInfoError(null);
    try {
      const success = await onUpdateProfile({ displayName: displayNameDraft });
      if (!success) {
        setProfileInfoError('No pudimos actualizar tu perfil.');
        return;
      }
      setProfileEditOpen(false);
      onNotify?.('Perfil actualizado.', 'success');
      void loadProfile(accountUsername);
    } catch (error) {
      setProfileInfoError(error instanceof Error ? error.message : 'No pudimos actualizar tu perfil.');
    } finally {
      setProfileInfoBusy(false);
    }
  };

  const handleVisibilityChange = async (app: SocialUserApp, visibility: Exclude<SocialUserAppVisibility, 'restricted'>) => {
    if (visibilityBusyId !== null || app.visibility === visibility) return;
    setVisibilityBusyId(app.id);
    try {
      const updated = await window.forger.updateSocialAppVisibility(app.id, visibility);
      setMyApps((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setProfileApps((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      onNotify?.('Visibilidad actualizada.', 'success');
    } catch (error) {
      onNotify?.(error instanceof Error ? error.message : 'No pudimos actualizar la visibilidad.', 'error');
    } finally {
      setVisibilityBusyId(null);
    }
  };

  const openEditAppInfoDialog = (app: SocialUserApp) => {
    setEditAppDialog({
      app,
      name: app.name,
      shortDescription: app.shortDescription ?? '',
      description: app.longDescription ?? app.description ?? '',
      category: isAppCategory(app.category) ? app.category : '',
      visibility: app.visibility === 'restricted' ? 'private' : app.visibility,
      busy: false,
      error: null,
    });
  };

  const closeEditAppInfoDialog = () => {
    setEditAppDialog((current) => ({ ...current, app: null, busy: false, error: null }));
  };

  const handleEditAppInfoSubmit = async (event?: SyntheticEvent) => {
    event?.preventDefault();
    const app = editAppDialog.app;
    if (!app || editAppDialog.busy) return;
    setEditAppDialog((current) => ({ ...current, busy: true, error: null }));
    try {
      const updated = await window.forger.updateSocialApp({
        id: app.id,
        name: editAppDialog.name.trim(),
        shortDescription: editAppDialog.shortDescription.trim(),
        description: editAppDialog.description.trim(),
        longDescription: editAppDialog.description.trim(),
        category: editAppDialog.category || undefined,
        visibility: editAppDialog.visibility,
      });
      setMyApps((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setProfileApps((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setEditAppDialog((current) => ({ ...current, app: null, busy: false, error: null }));
      onNotify?.(t.social.editAppInfoSuccess, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : t.social.editAppInfoError;
      setEditAppDialog((current) => ({ ...current, busy: false, error: message }));
      onNotify?.(message, 'error');
    }
  };

  const handleDeleteSocialApp = async () => {
    const app = deleteAppDialog.app;
    if (!app || deleteAppDialog.busy) return;
    setDeleteAppDialog((current) => ({ ...current, busy: true, error: null }));
    try {
      await window.forger.deleteSocialApp(app.id);
      setMyApps((current) => current.filter((entry) => entry.id !== app.id));
      setProfileApps((current) => current.filter((entry) => entry.id !== app.id));
      setDeleteAppDialog({ app: null, busy: false, error: null });
      onNotify?.(t.social.unpublishSuccess, 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : t.social.unpublishError;
      setDeleteAppDialog((current) => ({ ...current, busy: false, error: message }));
      onNotify?.(message, 'error');
    }
  };

  const handleOpenProfileInBrowser = async () => {
    const url = profileUrl || (accountUsername ? await window.forger.getSocialProfileUrl(accountUsername) : '');
    if (!url) return;
    await window.forger.openExternalUrl(url);
  };

  const handleCopyProfileLink = async () => {
    const url = profileUrl || (accountUsername ? await window.forger.getSocialProfileUrl(accountUsername) : '');
    if (!url) return;
    await navigator.clipboard.writeText(url);
    onNotify?.('Link copiado.', 'success');
  };

  const handlePublishSubmit = () => {
    if (!publishAppId || !onUploadSocial) return;
    setPublishDialogOpen(false);
    onUploadSocial(publishAppId, publishVisibility, publishCategory);
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

  const renderSearch = () => (
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
        </Stack>
      </Box>
      {profileLoading ? (
        <Stack alignItems="center" spacing={1.25} sx={{ py: 5 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">Cargando perfil...</Typography>
        </Stack>
      ) : null}
      {!profileLoading && profileError ? (
        <Stack spacing={1.25}>
          <Alert severity="error">{profileError}</Alert>
          <Button variant="outlined" onClick={() => void loadProfile(activeProfileUsername)} sx={{ alignSelf: 'flex-start' }}>
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
                  <SocialAppCard key={app.id} app={app} t={t} ownerLabel={`@${app.owner.username}`} accountUserId={accountUserId} onOpen={onOpenSocialApp} />
                ))}
              </List>
            )}
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );

  const renderProfile = () => (
    <Stack spacing={2}>
      <Paper
        variant="outlined"
        sx={{
          p: 2,
          borderRadius: 1,
          borderColor: alpha(theme.palette.primary.main, 0.28),
          bgcolor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.1 : 0.04),
        }}
      >
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', md: 'center' }}>
          <Avatar sx={{ width: 60, height: 60, fontSize: 24 }}>
            {(account.user?.displayName || account.user?.firstName || accountUsername || 'F').slice(0, 1).toUpperCase()}
          </Avatar>
          <Stack sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h5" fontWeight={800} noWrap>{account.user?.displayName || account.user?.firstName || `@${accountUsername}`}</Typography>
            <Typography color="text.secondary" noWrap>@{accountUsername || 'sin-username'}</Typography>
            {profileUrl ? <Typography variant="caption" color="text.secondary" noWrap>{profileUrl}</Typography> : null}
          </Stack>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <Button size="small" variant="outlined" startIcon={<EditRounded />} onClick={() => setProfileEditOpen(true)}>Editar</Button>
            <Button size="small" variant="outlined" startIcon={<OpenInNewRounded />} disabled={!accountUsername} onClick={() => void handleOpenProfileInBrowser()}>Abrir</Button>
            <Button size="small" variant="outlined" startIcon={<ContentCopyRounded />} disabled={!accountUsername} onClick={() => void handleCopyProfileLink()}>Copiar link</Button>
          </Stack>
        </Stack>
      </Paper>

      {profileUsernameError ? <Alert severity="error">{profileUsernameError}</Alert> : null}
      <Box component="form" onSubmit={handleUsernameSubmit}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            size="small"
            label="Username"
            value={profileUsernameDraft}
            onChange={(event) => {
              setProfileUsernameDraft(event.target.value);
              setProfileUsernameError(null);
            }}
            placeholder="@username"
            autoComplete="off"
            sx={{ maxWidth: { sm: 360 } }}
          />
          <Button
            type="submit"
            variant="outlined"
            disabled={accountBusy || profileUsernameBusy || !profileUsernameDraft.trim() || !onUpdateUsername}
          >
            {profileUsernameBusy ? 'Guardando...' : 'Guardar username'}
          </Button>
        </Stack>
      </Box>

      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" spacing={1}>
          <Typography variant="h6">Apps publicadas</Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button size="small" startIcon={<RefreshRounded />} onClick={() => void loadMyApps()} disabled={myAppsLoading}>Actualizar</Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<UploadRounded />}
              disabled={!onUploadSocial || uploadCandidates.length === 0}
              onClick={() => {
                const firstCandidate = uploadCandidates[0];
                setPublishAppId(firstCandidate?.id ?? '');
                setPublishCategory(isAppCategory(firstCandidate?.category) ? firstCandidate.category : 'productivity');
                setPublishDialogOpen(true);
              }}
            >
              Subir app
            </Button>
          </Stack>
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
            <Typography variant="body2" color="text.secondary">
              {uploadCandidates.length > 0 ? 'Puedes subir una app instalada desde este perfil.' : 'Crea o instala una app propia para subirla a Social.'}
            </Typography>
          </Paper>
        ) : null}
        {myApps.length > 0 ? (
          <List disablePadding sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
            {myApps.map((app) => (
              <SocialAppCard
                key={app.id}
                app={app}
                t={t}
                ownerLabel="Tuya"
                accountUserId={accountUserId}
                onOpen={onOpenSocialApp}
                onVisibilityChange={handleVisibilityChange}
                onEditInfo={openEditAppInfoDialog}
                onDelete={(app) => setDeleteAppDialog({ app, busy: false, error: null })}
                visibilityBusy={visibilityBusyId === app.id}
              />
            ))}
          </List>
        ) : null}
      </Stack>

      <Dialog open={profileEditOpen} onClose={() => setProfileEditOpen(false)} maxWidth="xs" fullWidth>
        <Box component="form" onSubmit={handleProfileInfoSubmit}>
          <DialogTitle>Editar perfil</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                label="Nombre visible"
                value={displayNameDraft}
                onChange={(event) => {
                  setDisplayNameDraft(event.target.value);
                  setProfileInfoError(null);
                }}
                autoComplete="name"
                inputProps={{ maxLength: 80 }}
                fullWidth
              />
              {profileInfoError ? <Alert severity="error">{profileInfoError}</Alert> : null}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setProfileEditOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="contained" disabled={profileInfoBusy || !onUpdateProfile}>
              {profileInfoBusy ? 'Guardando...' : 'Guardar'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog
        open={Boolean(deleteAppDialog.app)}
        onClose={() => {
          if (!deleteAppDialog.busy) setDeleteAppDialog({ app: null, busy: false, error: null });
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t.social.unpublishTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography color="text.secondary">
              {deleteAppDialog.app ? t.social.unpublishBody(deleteAppDialog.app.name) : ''}
            </Typography>
            <Alert severity="warning">{t.social.unpublishWarning}</Alert>
            {deleteAppDialog.error ? <Alert severity="error">{deleteAppDialog.error}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={deleteAppDialog.busy} onClick={() => setDeleteAppDialog({ app: null, busy: false, error: null })}>
            {t.actions.cancel}
          </Button>
          <Button color="error" variant="contained" disabled={deleteAppDialog.busy} onClick={() => void handleDeleteSocialApp()}>
            {deleteAppDialog.busy ? t.social.unpublishing : t.social.unpublishConfirmAction}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(editAppDialog.app)} onClose={closeEditAppInfoDialog} maxWidth="sm" fullWidth>
        <Box component="form" onSubmit={handleEditAppInfoSubmit}>
          <DialogTitle>{t.social.editAppInfoTitle}</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField
                label={t.social.editAppNameLabel}
                value={editAppDialog.name}
                onChange={(event) => setEditAppDialog((current) => ({ ...current, name: event.target.value, error: null }))}
                inputProps={{ maxLength: 120 }}
                required
                fullWidth
              />
              <TextField
                label={t.social.editAppShortDescriptionLabel}
                value={editAppDialog.shortDescription}
                onChange={(event) => setEditAppDialog((current) => ({ ...current, shortDescription: event.target.value, error: null }))}
                inputProps={{ maxLength: 180 }}
                fullWidth
              />
              <TextField
                label={t.social.editAppDescriptionLabel}
                value={editAppDialog.description}
                onChange={(event) => setEditAppDialog((current) => ({ ...current, description: event.target.value, error: null }))}
                multiline
                minRows={4}
                fullWidth
              />
              <FormControl fullWidth size="small">
                <InputLabel id="social-edit-app-category-label">{t.social.editAppCategoryLabel}</InputLabel>
                <Select
                  labelId="social-edit-app-category-label"
                  label={t.social.editAppCategoryLabel}
                  value={editAppDialog.category}
                  onChange={(event) => setEditAppDialog((current) => ({ ...current, category: event.target.value as AppCategory | '', error: null }))}
                >
                  <MenuItem value="">{t.social.editAppCategoryEmpty}</MenuItem>
                  {appCategoryOptions.map((category) => (
                    <MenuItem key={category} value={category}>{t.appCategories[category]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth size="small">
                <InputLabel id="social-edit-app-visibility-label">{t.social.editAppVisibilityLabel}</InputLabel>
                <Select
                  labelId="social-edit-app-visibility-label"
                  label={t.social.editAppVisibilityLabel}
                  value={editAppDialog.visibility}
                  onChange={(event) => setEditAppDialog((current) => ({
                    ...current,
                    visibility: event.target.value as Exclude<SocialUserAppVisibility, 'restricted'>,
                    error: null,
                  }))}
                >
                  {editableVisibilityOptions.map((visibility) => (
                    <MenuItem key={visibility} value={visibility}>{t.social.visibility[visibility]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              {editAppDialog.error ? <Alert severity="error">{editAppDialog.error}</Alert> : null}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={closeEditAppInfoDialog}>{t.actions.cancel}</Button>
            <Button type="submit" variant="contained" disabled={editAppDialog.busy || !editAppDialog.name.trim()}>
              {editAppDialog.busy ? t.social.saving : t.actions.save}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <Dialog open={publishDialogOpen} onClose={() => setPublishDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t.social.uploadTitle}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="social-profile-upload-app-label">{t.social.uploadAppLabel}</InputLabel>
              <Select
                labelId="social-profile-upload-app-label"
                label={t.social.uploadAppLabel}
                value={publishAppId}
                onChange={(event) => {
                  const nextAppId = event.target.value;
                  const app = uploadCandidates.find((candidate) => candidate.id === nextAppId);
                  setPublishAppId(nextAppId);
                  setPublishCategory(isAppCategory(app?.category) ? app.category : 'productivity');
                }}
              >
                {uploadCandidates.map((app) => (
                  <MenuItem key={app.id} value={app.id}>{app.name ?? app.id}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel id="social-profile-upload-category-label">{t.social.uploadCategoryLabel}</InputLabel>
              <Select
                labelId="social-profile-upload-category-label"
                label={t.social.uploadCategoryLabel}
                value={publishCategory}
                onChange={(event) => setPublishCategory(event.target.value as AppCategory)}
              >
                {appCategoryOptions.map((category) => (
                  <MenuItem key={category} value={category}>{t.appCategories[category]}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Typography variant="caption" color="text.secondary">{t.social.uploadCategoryHelp}</Typography>
            <FormControl fullWidth size="small">
              <InputLabel id="social-profile-upload-visibility-label">{t.social.uploadVisibilityLabel}</InputLabel>
              <Select
                labelId="social-profile-upload-visibility-label"
                label={t.social.uploadVisibilityLabel}
                value={publishVisibility}
                onChange={(event) => setPublishVisibility(event.target.value as Exclude<SocialUserAppVisibility, 'restricted'>)}
              >
                <MenuItem value="private">{t.social.uploadVisibility.private}</MenuItem>
                <MenuItem value="friends">{t.social.uploadVisibility.friends}</MenuItem>
                <MenuItem value="public">{t.social.uploadVisibility.public}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPublishDialogOpen(false)}>{t.actions.cancel}</Button>
          <Button variant="contained" disabled={!publishAppId} onClick={handlePublishSubmit}>{t.social.uploadAction}</Button>
        </DialogActions>
      </Dialog>
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
          {activeTab === 'profile' ? renderProfile() : null}
          {activeTab === 'search' ? renderSearch() : null}
        </>
      )}
    </Stack>
  );
}
