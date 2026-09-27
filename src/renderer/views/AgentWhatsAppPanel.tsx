import type { PersonalAgentWhatsAppChannelPolicy, WhatsAppAgentBinding } from '@shared/types';
import { ActivityDialog } from './whatsapp-agent-channel/ActivityDialog';
import { PolicyEditor } from './whatsapp-agent-channel/PolicyEditor';
import { useState } from 'react';
import { blankDraft, emptyPolicy, participantAccess } from './whatsapp-agent-channel/model';
import { copy } from './whatsapp-agent-channel/copy';
import { useChannelEditor } from './whatsapp-agent-channel/useChannelEditor';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  FormControlLabel,
  Switch,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';

interface AgentWhatsAppPanelProps {
  agentId: string;
  agentName: string;
  t: AppDictionary;
  onOpenConnections?: () => void;
  onOpenConversation?: (id: string) => void;
}

function ChannelSwitch({ checked, disabled, label, onCheckedChange }: { checked: boolean; disabled: boolean; label: string; onCheckedChange: (checked: boolean) => void }) {
  return <FormControlLabel label={label} control={<Switch checked={checked} disabled={disabled} onChange={(_event, value) => onCheckedChange(value)} slotProps={{ input: { role: 'switch', 'aria-label': label, 'aria-checked': checked } }} />} />;
}

export function AgentWhatsAppPanel({ agentId, agentName, t, onOpenConversation, onOpenConnections }: AgentWhatsAppPanelProps) {
  const c = (t.locale as string) === 'en' ? copy.en : copy.es;
  const { refreshConnections, pause, conflicting, setConflicting, participantsLoading, participantsError, setParticipantsRefresh, connections, bindings, unsettled, deliveries, draft, editing, chats, chatTitle, participants, search, loading, loadingChats, busy, error, chatError, notice, updateDraft, setSearch, beginEdit, save, remove, connectedAccounts, editedAccountAvailable, availableConnections, selectedChat, chatChoices, setEditing, setDraft, setNotice } = useChannelEditor(agentId, agentName, c);

  const updatePolicy = (policy: PersonalAgentWhatsAppChannelPolicy) => updateDraft((current) => ({ ...current, policy }));
  const [activity, setActivity] = useState<WhatsAppAgentBinding | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const aliasAffected = bindings.filter((item) => item.connectionId === draft.connectionId && item.alias !== draft.alias.trim());
  const requestSave = () => {
    if (draft.participantAccess === 'selected' && !draft.participantsAllowed.length) { void save(); return; }
    if (draft.connectionId && draft.chatId && draft.alias.trim() && (!draft.enabled || draft.purpose.trim()) && (draft.enabled || aliasAffected.length)) setReviewOpen(true);
    else void save();
  };
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">{c.title}</Typography>
        <Typography variant="body2" color="text.secondary">{c.description}</Typography>
      </Box>
      {loading ? <CircularProgress size={22} /> : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {chatError ? <Alert severity="error">{chatError}</Alert> : null}
      {conflicting ? <Alert severity="warning" action={<Button onClick={() => { setEditing(conflicting); setConflicting(null); }}>{c.useDraft}</Button>}>
        <Typography variant="subtitle2">{c.currentSettings}</Typography>
        <Typography>{c.alias}: {conflicting.alias}</Typography>
        <Typography>{c.enabled}: {conflicting.enabled ? c.active : c.inactive}</Typography>
        <Typography>{c.purpose}: {conflicting.purpose}</Typography>
        <Typography>{c.scope}: {conflicting.scope}</Typography>
        <Typography>{c.access}: {c[participantAccess(conflicting)]} {participantAccess(conflicting) === 'selected' ? conflicting.participantsAllowed.join(', ') : ''}</Typography>
        <PolicyEditor agentId={agentId} value={conflicting.policy ?? emptyPolicy()} onChange={updatePolicy} disabled english={(t.locale as string) === 'en'} />
      </Alert> : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}
      {!loading && connectedAccounts.length === 0 ? <Alert severity="info" action={onOpenConnections ? <Button onClick={onOpenConnections}>{c.connections}</Button> : undefined}>{c.noConnection}</Alert> : null}
      {bindings.length > 0 ? (
        <Stack spacing={1}>
          <Typography variant="subtitle2">{c.bindings}</Typography>
          {bindings.map((binding) => {
            const account = connections.find((item) => item.id === binding.connectionId);
            const needsReview = unsettled.some((item) => item.agentId === binding.agentId && item.connectionId === binding.connectionId && item.chatId === binding.chatId);
            const delivery = deliveries[`${binding.connectionId}:${binding.chatId}:${binding.agentId}`];
            return (
              <Paper key={`${binding.connectionId}:${binding.chatId}`} variant="outlined" sx={{ p: 1.5, borderRadius: 1 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>{binding.alias} · {chatTitle(binding.connectionId, binding.chatId)}</Typography>
                    <Typography variant="caption" color="text.secondary">{account?.label ?? c.connectionMissing}</Typography>
                    <Typography variant="caption" display="block" color="text.secondary">{c[participantAccess(binding)]}</Typography>
                  </Box>
                  <Chip size="small" color={binding.enabled && account?.status === 'connected' ? 'success' : 'default'} label={!binding.enabled ? c.inactive : account?.status === 'connected' ? c.active : c.disconnected} />
                  {binding.activeTurnId ? <Chip size="small" color="info" label={c.working} /> : null}
                  {needsReview ? <Chip size="small" color="warning" label={c.review} /> : null}
                  {delivery ? <Chip size="small" color={delivery.state === 'sent' ? 'success' : delivery.state === 'failed' ? 'error' : 'warning'} label={delivery.state === 'sent' ? c.sent : delivery.state === 'failed' ? c.deliveryFailed : c.deliveryUnknown} /> : null}
                  {account?.status !== 'connected' && onOpenConnections ? <Button size="small" onClick={onOpenConnections}>{c.reconnect}</Button> : null}
                  <Button size="small" onClick={() => setActivity(binding)}>{c.activity}</Button>
                  {binding.enabled ? <Button size="small" disabled={busy} onClick={() => void pause(binding)}>{c.pause}</Button> : null}
                  <Button size="small" onClick={() => beginEdit(binding)}>{c.edit}</Button>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      ) : null}
      <Divider />
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2">{editing ? `${c.chat}: ${selectedChat?.title ?? editing.chatId}` : c.add}</Typography>
        {editing ? <Button size="small" onClick={() => { setEditing(null); setDraft(blankDraft(bindings.find((item) => item.connectionId === connectedAccounts[0]?.id)?.alias ?? agentName, connectedAccounts[0]?.id ?? '')); setNotice(''); }}>{c.add}</Button> : null}
      </Stack>
      <TextField
        select
        fullWidth
        label={c.account}
        value={draft.connectionId}
        disabled={busy || Boolean(editing) || availableConnections.length === 0}
        onChange={(event) => updateDraft((current) => ({ ...current, ...blankDraft(bindings.find((item) => item.connectionId === event.target.value)?.alias ?? agentName, event.target.value) }))}
      >
        {availableConnections.map((item) => <MenuItem key={item.id} value={item.id}>{item.label || item.accountIdentity?.phoneNumber || item.id}</MenuItem>)}
      </TextField>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <TextField
          fullWidth
          label={c.search}
          value={search}
          disabled={!draft.connectionId || busy}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          startIcon={<RefreshRounded />}
          disabled={!draft.connectionId || loadingChats || busy}
          onClick={() => void refreshConnections()}
        >
          {c.refresh}
        </Button>
      </Stack>
      <TextField
        select
        fullWidth
        label={c.chat}
        value={draft.chatId}
        disabled={!draft.connectionId || busy || Boolean(editing)}
        onChange={(event) => updateDraft((current) => ({ ...current, chatId: event.target.value, participantAccess: 'owner', participantsAllowed: [], policy: emptyPolicy(), enabled: false, purpose: '', scope: '' }))}
      >
        {chatChoices.map((chat) => <MenuItem key={chat.chatId} value={chat.chatId}>{chat.title || chat.phoneNumber || chat.chatId}</MenuItem>)}
      </TextField>
      {loadingChats ? <CircularProgress size={18} /> : null}
      {!loadingChats && draft.connectionId && chats.length === 0 ? <Typography variant="caption" color="text.secondary">{c.noChats}</Typography> : null}
      <TextField
        fullWidth
        label={c.alias}
        value={draft.alias}
        helperText={c.aliasHelp}
        disabled={busy}
        onChange={(event) => updateDraft((current) => ({ ...current, alias: event.target.value }))}
      />
      <TextField
        fullWidth
        multiline
        minRows={2}
        label={c.purpose}
        value={draft.purpose}
        helperText={c.purposeHelp}
        disabled={busy}
        onChange={(event) => updateDraft((current) => ({ ...current, purpose: event.target.value }))}
      />
      <TextField
        fullWidth
        multiline
        minRows={2}
        label={c.scope}
        value={draft.scope}
        helperText={c.scopeHelp}
        disabled={busy}
        onChange={(event) => updateDraft((current) => ({ ...current, scope: event.target.value }))}
      />
      <TextField select fullWidth label={c.access} value={draft.participantAccess} disabled={busy || !draft.chatId}
        helperText={draft.participantAccess === 'all' ? `${c.allHelp} ${c.accessHelp}` : c.accessHelp}
        onChange={(event) => updateDraft((current) => ({ ...current, participantAccess: event.target.value as typeof current.participantAccess }))}>
        <MenuItem value="owner">{c.owner}</MenuItem>
        <MenuItem value="selected">{c.selected}</MenuItem>
        {(selectedChat?.chatType === 'group' || draft.chatId.endsWith('@g.us') || draft.participantAccess === 'all') ? <MenuItem value="all">{c.all}</MenuItem> : null}
      </TextField>
      {draft.participantAccess === 'selected' ? (
        <Autocomplete
          multiple
          options={[...new Set([...participants.map((person) => person.id), ...draft.participantsAllowed])]}
          getOptionLabel={(id) => participants.find((person) => person.id === id)?.name ?? id}
          value={draft.participantsAllowed}
          disabled={busy}
          onChange={(_event, values) => updateDraft((current) => ({ ...current, participantsAllowed: values }))}
          renderInput={(params) => <TextField {...params} label={c.participants} helperText={c.participantsHelp} />}
        />
      ) : null}
      {participantsLoading ? <Typography role="status">{c.participantsLoading}</Typography> : null}
      {participantsError ? <Alert severity="error" action={<Button onClick={() => setParticipantsRefresh((n) => n + 1)}>{c.retry}</Button>}>{participantsError}</Alert> : null}
      <PolicyEditor key={`${draft.connectionId}:${draft.chatId}`} agentId={agentId} value={draft.policy} onChange={updatePolicy} disabled={busy} english={(t.locale as string) === 'en'} />

      <ChannelSwitch
        checked={draft.enabled}
        disabled={busy}
        label={c.enabled}
        onCheckedChange={(checked) => updateDraft((current) => ({ ...current, enabled: checked }))}
      />
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="subtitle2">{c.replyPreview}</Typography>
        <Typography sx={{ whiteSpace: 'pre-line' }}>{`🤖 ${draft.alias.trim() || agentName}: \n${c.exampleReply}`}</Typography>
      </Paper>
      <Alert severity="info">{c.commands(draft.alias.trim() || c.alias)}</Alert>
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy || (Boolean(editing) && !editedAccountAvailable)} onClick={requestSave}>{c.save}</Button>
        {editing ? <Button color="error" startIcon={<DeleteOutlineRounded />} disabled={busy} onClick={() => setRemoveOpen(true)}>{c.delete}</Button> : null}
      </Stack>
      {activity ? <ActivityDialog binding={activity} c={c} onClose={() => setActivity(null)} onOpenConversation={onOpenConversation} /> : null}
      <Dialog open={removeOpen} onClose={() => setRemoveOpen(false)}>
        <DialogTitle>{c.delete}</DialogTitle><DialogContent>{c.removeConfirm}</DialogContent>
        <DialogActions><Button onClick={() => setRemoveOpen(false)}>{c.cancel}</Button><Button color="error" onClick={() => { setRemoveOpen(false); void remove(); }}>{c.delete}</Button></DialogActions>
      </Dialog>
      <Dialog open={reviewOpen} onClose={() => setReviewOpen(false)} fullWidth>
        <DialogTitle>{c.reviewSave}</DialogTitle><DialogContent><Stack spacing={1}>
          <Typography>{connections.find((item) => item.id === draft.connectionId)?.label} · {selectedChat?.title ?? draft.chatId}</Typography>
          <Typography>{draft.purpose}</Typography><Typography>{c.enableSummary}</Typography>
          <Typography>{c.access}: {c[draft.participantAccess]}{draft.participantAccess === 'selected' ? `: ${draft.participantsAllowed.map((id) => participants.find((person) => person.id === id)?.name ?? id).join(', ')}` : ''}</Typography>
          <PolicyEditor key={`${draft.connectionId}:${draft.chatId}`} agentId={agentId} value={draft.policy} onChange={updatePolicy} disabled english={(t.locale as string) === 'en'} />
          {draft.participantAccess === 'all' ? <Typography>{c.allHelp}</Typography> : null}
          <Typography>{c.accessHelp}</Typography>
          <Alert severity="info">{c.audience}</Alert>
          {aliasAffected.length ? <Alert severity="warning">{c.aliasWarning}<ul>{aliasAffected.map((item) => <li key={item.chatId}>{chatTitle(item.connectionId, item.chatId)}</li>)}</ul></Alert> : null}
        </Stack></DialogContent>
        <DialogActions><Button onClick={() => setReviewOpen(false)}>{c.cancel}</Button><Button variant="contained" onClick={() => { setReviewOpen(false); void save(); }}>{c.confirmSave}</Button></DialogActions>
      </Dialog>
    </Stack>
  );
}
