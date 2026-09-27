import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Paper, Stack, TextField, Typography } from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { RepositoryCollaborationChat, RepositoryCollaborationChatParticipant, RepositoryCollaborationRepository, RepositoryCollaborationSnapshot } from '@shared/types/repository-collaboration';
import { WhatsAppProjectAccess } from './WhatsAppProjectAccess';
import { WhatsAppProjectTasks } from './WhatsAppProjectTasks';
import { collaborationError } from './repositoryCollaborationUi';

export function WhatsAppProjectsPanel({ connectionId, t }: { connectionId: string; t: AppDictionary }) {
  const copy = t.repositoryCollaboration;
  const [snapshot, setSnapshot] = useState<RepositoryCollaborationSnapshot | null>(null);
  const [groups, setGroups] = useState<RepositoryCollaborationChat[]>([]);
  const [groupState, setGroupState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [chatId, setChatId] = useState('');
  const [participants, setParticipants] = useState<RepositoryCollaborationChatParticipant[]>([]);
  const [participantState, setParticipantState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [alias, setAlias] = useState('');
  const [removing, setRemoving] = useState<RepositoryCollaborationRepository | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setGroupState('loading');
    void Promise.resolve().then(() => window.forger.repositoryCollaborationSnapshot(connectionId)).then((next) => {
      if (!active) return;
      setSnapshot(next);
      setChatId((current) => current || next.groups[0]?.chatId || '');
      setError('');
    }).catch((failure: unknown) => {
      if (active) setError(collaborationError(failure, copy, copy.loadError));
    }).finally(() => { if (active) setLoading(false); });
    void Promise.resolve().then(() => window.forger.repositoryCollaborationListGroups(connectionId)).then((chats) => {
      if (active) { setGroups(chats); setGroupState('ready'); }
    }).catch(() => { if (active) { setGroups([]); setGroupState('error'); } });
    return () => { active = false; };
  }, [connectionId, refresh, copy]);

  useEffect(() => {
    let active = true;
    let polling = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || polling) return;
      polling = true;
      void Promise.resolve().then(() => window.forger.repositoryCollaborationSnapshot(connectionId))
        .then((next) => { if (active) setSnapshot(next); })
        .catch(() => { if (active) setError(copy.loadError); })
        .finally(() => { polling = false; });
    }, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [connectionId, copy.loadError]);

  useEffect(() => {
    let active = true;
    setParticipants([]);
    setParticipantState('loading');
    if (!chatId) return () => { active = false; };
    void Promise.resolve().then(() => window.forger.repositoryCollaborationListParticipants({ connectionId, chatId })).then((next) => {
      if (active) { setParticipants(next); setParticipantState('ready'); }
    }).catch(() => { if (active) setParticipantState('error'); });
    return () => { active = false; };
  }, [connectionId, chatId, refresh]);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true); setNotice(''); setError('');
    try {
      const result = await operation();
      if (!live.current) return;
      if (result !== null) setNotice(copy.saved);
      setRefresh((current) => current + 1);
    } catch (failure) {
      if (live.current) setError(collaborationError(failure, copy));
    } finally { if (live.current) setBusy(false); }
  }, [copy]);

  const group = snapshot?.groups.find((candidate) => candidate.chatId === chatId);
  const repositories = snapshot?.repositories.filter((repository) => repository.groupId === group?.id) ?? [];
  const grants = snapshot?.grants.filter((grant) => grant.groupId === group?.id) ?? [];
  const tasks = snapshot?.tasks.filter((task) => task.groupId === group?.id) ?? [];
  const currentChat = groups.find((chat) => chat.chatId === chatId);
  const allGroups = useMemo(() => {
    const merged = new Map(groups.map((chat) => [chat.chatId, chat]));
    snapshot?.groups.forEach((saved) => { if (!merged.has(saved.chatId)) merged.set(saved.chatId, saved); });
    return [...merged.values()];
  }, [groups, snapshot?.groups]);
  const accessParticipants = useMemo(() => {
    const merged = new Map(participants.map((participant) => [participant.participantId, participant]));
    snapshot?.participants.filter((participant) => participant.groupId === group?.id).forEach((participant) => {
      if (!merged.has(participant.participantId)) merged.set(participant.participantId, participant);
    });
    return [...merged.values()];
  }, [participants, snapshot?.participants, group?.id]);
  const canActivate = repositories.length > 0 && grants.some((grant) => participants.some((participant) => participant.participantId === grant.participantId)) && participantState === 'ready';

  return <Paper variant="outlined" component="section" aria-label={copy.title} sx={{ p: 2, minWidth: 0 }}>
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">{copy.title}</Typography>
        <Button size="small" disabled={loading || busy} onClick={() => { setNotice(''); setRefresh((current) => current + 1); }}>{copy.refresh}</Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">{copy.description}</Typography>
      <Alert severity="info">{copy.availability}</Alert>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}
      {groupState === 'error' ? <Alert severity="warning">{copy.unavailable}</Alert> : null}
      {loading && !snapshot ? <Box><CircularProgress size={22} aria-label={copy.loading} /></Box> : null}
      {snapshot ? <>
        {allGroups.length === 0 && groupState === 'ready' ? <Typography color="text.secondary">{copy.noGroups}</Typography> : null}
        {allGroups.length === 0 && groupState === 'loading' ? <CircularProgress size={20} aria-label={copy.loading} /> : null}
        {allGroups.length > 0 ? <TextField select label={copy.group} value={chatId} disabled={busy} onChange={(event) => { setChatId(event.target.value); setNotice(''); setAlias(''); }} slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}>
          <option value="">{copy.chooseGroup}</option>
          {allGroups.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.title}</option>)}
        </TextField> : null}
        {chatId && !group ? <Button variant="outlined" sx={{ alignSelf: 'flex-start' }} disabled={busy || !currentChat} onClick={() => void run(() => window.forger.repositoryCollaborationConfigureGroup({ connectionId, chatId, title: currentChat!.title, enabled: false }))}>{copy.saveGroup}</Button> : null}
        {group ? <>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Chip label={group.enabled ? copy.active : copy.paused} color={group.enabled ? 'success' : 'default'} />
            <Button disabled={busy || (!group.enabled && !canActivate)} onClick={() => void run(() => window.forger.repositoryCollaborationConfigureGroup({ connectionId, chatId, title: group.title, enabled: !group.enabled }))}>{group.enabled ? copy.pause : copy.activate}</Button>
          </Stack>
          {!group.enabled && !canActivate ? <Typography variant="body2" color="text.secondary">{copy.activationHint}</Typography> : null}
          <Divider />
          <Typography variant="subtitle1" fontWeight={700}>{copy.repositories}</Typography>
          {repositories.length === 0 ? <Typography color="text.secondary">{copy.noRepositories}</Typography> : null}
          {repositories.map((repository) => <Stack key={repository.id} direction="row" spacing={1} alignItems="center" justifyContent="space-between"><Typography>{repository.name}</Typography><Button size="small" color="error" disabled={busy} aria-label={`${copy.remove} ${repository.name}`} onClick={() => setRemoving(repository)}>{copy.remove}</Button></Stack>)}
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField size="small" label={copy.alias} value={alias} disabled={busy} onChange={(event) => setAlias(event.target.value)} slotProps={{ htmlInput: { maxLength: 80 } }} />
            <Button variant="outlined" disabled={busy || !alias.trim()} onClick={() => void run(async () => { const result = await window.forger.repositoryCollaborationAddRepository({ groupId: group.id, name: alias.trim() }); if (result && live.current) setAlias(''); return result; })}>{copy.addFolder}</Button>
          </Stack>
          <Divider />
          <Typography variant="subtitle1" fontWeight={700}>{copy.participants}</Typography>
          <Typography variant="body2" color="text.secondary">{copy.identityHint}</Typography>
          <Alert severity="warning">{copy.revokeWarning}</Alert>
          {participantState === 'loading' ? <CircularProgress size={20} aria-label={copy.loading} /> : null}
          {participantState === 'error' ? <Alert severity="error">{copy.participantError}</Alert> : null}
          {participantState === 'ready' && accessParticipants.length === 0 ? <Typography color="text.secondary">{copy.noParticipants}</Typography> : null}
          {accessParticipants.map((participant) => {
            const ids = grants.filter((grant) => grant.participantId === participant.participantId).map((grant) => grant.repositoryId).sort();
            return <WhatsAppProjectAccess key={`${group.id}:${participant.participantId}:${ids.join(',')}:${repositories.map((repo) => repo.id).join(',')}`} groupId={group.id} participant={participant} repositoryIds={ids} repositories={repositories} copy={copy} busy={busy} canGrant={participantState === 'ready' && participants.some((current) => current.participantId === participant.participantId)} onSave={(input) => void run(() => window.forger.repositoryCollaborationSetAccess(input))} />;
          })}
          <Alert severity="info">{copy.examples}</Alert>
          <Divider />
          {snapshot.outbox.some((message) => message.groupId === group.id && message.status === 'pending') ? <Alert severity="info">{copy.pendingDelivery}</Alert> : null}
          <WhatsAppProjectTasks tasks={tasks} repositories={repositories} copy={copy} busy={busy} onCancel={(taskId) => void run(() => window.forger.repositoryCollaborationCancelTask({ taskId }))} onRetry={(taskId) => void run(() => window.forger.repositoryCollaborationRetryTask({ taskId }))} />
        </> : null}
      </> : null}
    </Stack>
    <Dialog open={Boolean(removing)} onClose={() => { if (!busy) setRemoving(null); }}>
      <DialogTitle>{copy.removeConfirm}</DialogTitle>
      <DialogContent><Typography fontWeight={700}>{removing?.name}</Typography><Typography>{copy.revokeWarning}</Typography></DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setRemoving(null)}>{copy.keep}</Button><Button color="error" disabled={busy} onClick={() => { if (removing) { const input = { groupId: removing.groupId, repositoryId: removing.id }; setRemoving(null); void run(() => window.forger.repositoryCollaborationRemoveRepository(input)); } }}>{copy.confirmRemove}</Button></DialogActions>
    </Dialog>
  </Paper>;
}
