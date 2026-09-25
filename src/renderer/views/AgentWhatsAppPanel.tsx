import { useEffect, useMemo, useState } from 'react';
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { ConnectionInstance, WhatsAppAgentBinding, WhatsAppAgentDeliveryStatus, WhatsAppAgentUnsettledMessage } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';

interface ObservedChat {
  chatId: string;
  title?: string;
  phoneNumber?: string;
  chatType: 'direct' | 'group' | 'channel';
}

interface BindingDraft {
  connectionId: string;
  chatId: string;
  alias: string;
  purpose: string;
  scope: string;
  participantsAllowed: string[];
  allowAgentCapabilities: boolean;
  enabled: boolean;
}

const blankDraft = (agentName: string, connectionId = ''): BindingDraft => ({
  connectionId,
  chatId: '',
  alias: agentName,
  purpose: '',
  scope: '',
  participantsAllowed: [],
  allowAgentCapabilities: false,
  enabled: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const observedChats = (data: unknown): ObservedChat[] => {
  if (!isRecord(data) || !Array.isArray(data.chats)) return [];
  return data.chats.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.chatId !== 'string') return [];
    if (candidate.chatType !== 'direct' && candidate.chatType !== 'group') return [];
    return [{
      chatId: candidate.chatId,
      chatType: candidate.chatType,
      ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
      ...(typeof candidate.phoneNumber === 'string' ? { phoneNumber: candidate.phoneNumber } : {}),
    }];
  });
};

const observedParticipants = (data: unknown): string[] => {
  if (!isRecord(data)) return [];
  if (data.type === 'direct' && isRecord(data.chat) && typeof data.chat.chatId === 'string') {
    return [data.chat.chatId];
  }
  if (!isRecord(data.metadata) || !Array.isArray(data.metadata.participants)) return [];
  return data.metadata.participants.flatMap((candidate) =>
    isRecord(candidate) && typeof candidate.id === 'string' ? [candidate.id] : []);
};

const copy = {
  es: {
    title: 'WhatsApp',
    description: 'El agente responde en los chats que habilites aquí, usando su propio espacio de trabajo.',
    noConnection: 'Conecta WhatsApp desde Conexiones para usar este canal.',
    noChats: 'Todavía no hay chats observados. Abre una conversación en WhatsApp y actualiza la lista.',
    bindings: 'Chats configurados',
    add: 'Agregar chat',
    edit: 'Editar',
    account: 'Cuenta de WhatsApp',
    chat: 'Chat',
    search: 'Buscar chats observados',
    refresh: 'Actualizar chats',
    alias: 'Palabra de activación',
    aliasHelp: 'Escribe esta palabra seguida de una tarea para hablar con el agente.',
    purpose: 'Propósito en este chat',
    purposeHelp: 'Obligatorio para activar el agente.',
    scope: 'Instrucciones de trabajo para este chat',
    scopeHelp: 'Guía las tareas de este chat. El acceso real depende del modo de capacidades y de los permisos del agente.',
    participants: 'Personas que pueden pedirle tareas',
    participantsHelp: 'Si lo dejas vacío, sólo la cuenta vinculada podrá pedir tareas. El acceso de cada persona autorizada depende del permiso de capacidades que configures abajo.',
    capabilities: 'Permitir capacidades actuales del agente desde este chat',
    capabilitiesHelp: 'Apagado: usa Codex restringido al espacio de trabajo del agente, sin red ni capacidades externas; puede consultar el contexto de este chat. Encendido: usa el motor y los permisos actuales del agente, incluidas apps, herramientas, conexiones, red y otros agentes habilitados.',
    enabled: 'Permitir respuestas automáticas en este chat',
    commands: (alias: string) => `Desde la cuenta vinculada, escribe “${alias} ON” para activar el chat o “${alias} OFF” para detenerlo. Las tareas empiezan con “${alias}”. Si envías otra tarea mientras trabaja, se cancela la ejecución actual y comienza una nueva con la corrección.`,
    save: 'Guardar chat',
    saved: 'Configuración guardada.',
    delete: 'Quitar chat',
    deleted: 'Chat quitado.',
    removeConfirm: '¿Quitar este chat del agente? Se detendrá el trabajo activo.',
    active: 'Activo',
    inactive: 'Pausado',
    working: 'Trabajando',
    review: 'Invocación pendiente',
    sent: 'Última respuesta enviada',
    deliveryFailed: 'Última respuesta falló',
    deliveryUnknown: 'Entrega sin confirmar',
    connectionMissing: 'La cuenta ya no está disponible.',
    loadFailed: 'No pude cargar la configuración de WhatsApp.',
    chatsFailed: 'No pude cargar los chats observados.',
    saveFailed: 'No pude guardar este chat.',
    conflict: 'El chat cambió mientras editabas. Vuelve a abrirlo para revisar antes de guardar.',
    deleteFailed: 'No pude quitar este chat.',
    chooseChat: 'Elige una cuenta y un chat observado.',
    purposeRequired: 'Escribe el propósito antes de activar las respuestas.',
    aliasRequired: 'Escribe una palabra de activación.',
    aliasConflict: 'Otro agente ya usa esa palabra de activación en esta cuenta.',
  },
  en: {
    title: 'WhatsApp',
    description: 'The agent responds in chats you enable here, using its own workspace.',
    noConnection: 'Connect WhatsApp in Connections to use this channel.',
    noChats: 'No observed chats yet. Open a WhatsApp conversation and refresh the list.',
    bindings: 'Configured chats',
    add: 'Add chat',
    edit: 'Edit',
    account: 'WhatsApp account',
    chat: 'Chat',
    search: 'Search observed chats',
    refresh: 'Refresh chats',
    alias: 'Activation word',
    aliasHelp: 'Type this word followed by a task to speak to the agent.',
    purpose: 'Purpose in this chat',
    purposeHelp: 'Required before enabling the agent.',
    scope: 'Work instructions for this chat',
    scopeHelp: 'Guides tasks in this chat. Actual access depends on the capabilities mode and the agent’s permissions.',
    participants: 'People allowed to assign tasks',
    participantsHelp: 'Leave empty to allow only the linked account to assign tasks. Each allowed person’s access depends on the capabilities setting below.',
    capabilities: 'Allow the agent’s current capabilities from this chat',
    capabilitiesHelp: 'Off: uses Codex restricted to the agent workspace, without network or external capabilities; it can read context from this chat. On: uses the agent’s current engine and permissions, including enabled apps, tools, connections, network, and other agents.',
    enabled: 'Allow automatic replies in this chat',
    commands: (alias: string) => `From the linked account, send “${alias} ON” to activate this chat or “${alias} OFF” to stop it. Tasks start with “${alias}”. A new task while the agent is working cancels the current run and starts another with the correction.`,
    save: 'Save chat',
    saved: 'Settings saved.',
    delete: 'Remove chat',
    deleted: 'Chat removed.',
    removeConfirm: 'Remove this chat from the agent? Active work will stop.',
    active: 'Active',
    inactive: 'Paused',
    working: 'Working',
    review: 'Pending invocation',
    sent: 'Last reply sent',
    deliveryFailed: 'Last reply failed',
    deliveryUnknown: 'Delivery unconfirmed',
    connectionMissing: 'The account is no longer available.',
    loadFailed: 'Could not load WhatsApp settings.',
    chatsFailed: 'Could not load observed chats.',
    saveFailed: 'Could not save this chat.',
    conflict: 'This chat changed while you were editing. Open it again to review before saving.',
    deleteFailed: 'Could not remove this chat.',
    chooseChat: 'Choose an account and an observed chat.',
    purposeRequired: 'Enter a purpose before enabling replies.',
    aliasRequired: 'Enter an activation word.',
    aliasConflict: 'Another agent already uses this activation word on this account.',
  },
} as const;

interface AgentWhatsAppPanelProps {
  agentId: string;
  agentName: string;
  t: AppDictionary;
}

function AgentWhatsAppToggle({ checked, disabled, label, onCheckedChange }: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <ButtonBase
      component="button"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      sx={{ display: 'inline-flex', justifyContent: 'flex-start', gap: 1.5, textAlign: 'left', width: 'fit-content', borderRadius: 1, p: 0.5, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}
    >
      <Box sx={{ width: 40, height: 24, borderRadius: 12, backgroundColor: checked ? 'primary.main' : 'action.disabledBackground', p: '3px', transition: 'background-color 120ms ease', flexShrink: 0 }}>
        <Box sx={{ width: 18, height: 18, borderRadius: '50%', backgroundColor: 'background.paper', transform: checked ? 'translateX(16px)' : 'translateX(0)', transition: 'transform 120ms ease', boxShadow: 1 }} />
      </Box>
      <Typography variant="body2">{label}</Typography>
    </ButtonBase>
  );
}

export function AgentWhatsAppPanel({ agentId, agentName, t }: AgentWhatsAppPanelProps) {
  const c = (t.locale as string) === 'en' ? copy.en : copy.es;
  const [connections, setConnections] = useState<ConnectionInstance[]>([]);
  const [bindings, setBindings] = useState<WhatsAppAgentBinding[]>([]);
  const [unsettled, setUnsettled] = useState<WhatsAppAgentUnsettledMessage[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, WhatsAppAgentDeliveryStatus | null>>({});
  const [draft, setDraft] = useState<BindingDraft>(() => blankDraft(agentName));
  const [editing, setEditing] = useState<WhatsAppAgentBinding | null>(null);
  const [chats, setChats] = useState<ObservedChat[]>([]);
  const [participants, setParticipants] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [chatRefresh, setChatRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingChats, setLoadingChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [notice, setNotice] = useState('');

  const updateDraft = (change: (current: BindingDraft) => BindingDraft) => {
    setDraft(change);
    setError('');
    setNotice('');
  };

  useEffect(() => {
    let current = true;
    setLoading(true);
    setBindings([]);
    setUnsettled([]);
    setEditing(null);
    Promise.all([
      window.forger.connectionsList(),
      window.forger.personalAgentWhatsAppBindingsList({ agentId }),
      window.forger.personalAgentWhatsAppUnsettledList({ agentId }),
    ]).then(async ([state, nextBindings, nextUnsettled]) => {
      if (!current) return;
      const nextConnections = state.instances.filter((item) => item.type === 'whatsapp');
      setConnections(nextConnections);
      setBindings(nextBindings);
      setUnsettled(nextUnsettled);
      const latestDeliveries = await Promise.all(nextBindings.map(async (binding) => {
        const latest = await window.forger.personalAgentWhatsAppLatestDeliveryGet({
          connectionId: binding.connectionId, chatId: binding.chatId, agentId: binding.agentId,
        }).catch(() => null);
        return [`${binding.connectionId}:${binding.chatId}:${binding.agentId}`, latest] as const;
      }));
      if (!current) return;
      setDeliveries(Object.fromEntries(latestDeliveries));
      setDraft(blankDraft(agentName, nextConnections.find((item) => item.status === 'connected')?.id ?? ''));
      setEditing(null);
      setError('');
    }).catch(() => {
      if (current) setError(c.loadFailed);
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [agentId, agentName, c.loadFailed]);

  useEffect(() => {
    let current = true;
    const refresh = async () => {
      try {
        const [nextBindings, nextUnsettled] = await Promise.all([
          window.forger.personalAgentWhatsAppBindingsList({ agentId }),
          window.forger.personalAgentWhatsAppUnsettledList({ agentId }),
        ]);
        const latestDeliveries = await Promise.all(nextBindings.map(async (binding) => {
          const latest = await window.forger.personalAgentWhatsAppLatestDeliveryGet({
            connectionId: binding.connectionId, chatId: binding.chatId, agentId: binding.agentId,
          }).catch(() => null);
          return [`${binding.connectionId}:${binding.chatId}:${binding.agentId}`, latest] as const;
        }));
        if (!current) return;
        setBindings(nextBindings);
        setUnsettled(nextUnsettled);
        setDeliveries(Object.fromEntries(latestDeliveries));
      } catch {
        // Keep the last known status; the initial load and explicit actions surface errors.
      }
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [agentId]);

  useEffect(() => {
    let current = true;
    if (!draft.connectionId) {
      setChats([]);
      setChatError('');
      return () => { current = false; };
    }
    setLoadingChats(true);
    const timeout = window.setTimeout(() => {
      window.forger.connectionsCall({
        type: 'whatsapp',
        connectionId: draft.connectionId,
        actionId: 'whatsapp.list_chats',
        input: { limit: 100, query: search.trim() },
      }).then((result) => {
        if (!current) return;
        if (!result.success) throw new Error('whatsapp_chat_list_failed');
        setChats(observedChats(result.data));
        setChatError('');
      }).catch(() => {
        if (current) setChatError(c.chatsFailed);
      }).finally(() => {
        if (current) setLoadingChats(false);
      });
    }, 200);
    return () => { current = false; window.clearTimeout(timeout); };
  }, [draft.connectionId, search, chatRefresh, c.chatsFailed]);

  const selectedChat = chats.find((chat) => chat.chatId === draft.chatId);
  const chatChoices = useMemo(() => {
    if (!draft.chatId || chats.some((chat) => chat.chatId === draft.chatId)) return chats;
    return [{ chatId: draft.chatId, title: draft.chatId, chatType: 'direct' as const }, ...chats];
  }, [chats, draft.chatId]);

  useEffect(() => {
    let current = true;
    if (!draft.connectionId || !draft.chatId) {
      setParticipants([]);
      return () => { current = false; };
    }
    setParticipants([]);
    window.forger.connectionsCall({
      type: 'whatsapp',
      connectionId: draft.connectionId,
      actionId: 'whatsapp.get_chat_details',
      input: { chatId: draft.chatId },
    }).then((result) => {
      if (current && result.success) setParticipants(observedParticipants(result.data));
    }).catch(() => {
      if (current) setParticipants([]);
    });
    return () => { current = false; };
  }, [draft.connectionId, draft.chatId]);

  const beginEdit = (binding: WhatsAppAgentBinding) => {
    setEditing(binding);
    setDraft({
      connectionId: binding.connectionId,
      chatId: binding.chatId,
      alias: binding.alias,
      purpose: binding.purpose,
      scope: binding.scope,
      participantsAllowed: binding.participantsAllowed,
      allowAgentCapabilities: binding.allowAgentCapabilities,
      enabled: binding.enabled,
    });
    setError('');
    setNotice('');
  };

  const save = async () => {
    if (!draft.connectionId || !draft.chatId) { setError(c.chooseChat); return; }
    if (!draft.alias.trim()) { setError(c.aliasRequired); return; }
    if (draft.enabled && !draft.purpose.trim()) { setError(c.purposeRequired); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await window.forger.personalAgentWhatsAppBindingPut({
        agentId,
        connectionId: draft.connectionId,
        chatId: draft.chatId,
        alias: draft.alias.trim(),
        purpose: draft.purpose.trim(),
        scope: draft.scope.trim(),
        participantsAllowed: draft.participantsAllowed,
        allowAgentCapabilities: draft.allowAgentCapabilities,
        enabled: draft.enabled,
        ...(editing ? { expectedRevision: editing.revision } : {}),
      });
      setBindings((items) => [...items.filter((item) => !(item.connectionId === saved.connectionId && item.chatId === saved.chatId && item.agentId === saved.agentId)), saved]);
      setEditing(saved);
      setNotice(c.saved);
      const [pendingResult, latestResult] = await Promise.allSettled([
        window.forger.personalAgentWhatsAppUnsettledList({ agentId }),
        window.forger.personalAgentWhatsAppLatestDeliveryGet({
          connectionId: saved.connectionId, chatId: saved.chatId, agentId: saved.agentId,
        }),
      ]);
      if (pendingResult.status === 'fulfilled') setUnsettled(pendingResult.value);
      if (latestResult.status === 'fulfilled') {
        setDeliveries((current) => ({ ...current, [`${saved.connectionId}:${saved.chatId}:${saved.agentId}`]: latestResult.value }));
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      setError(message.includes('whatsapp_agent_binding_revision_conflict') ? c.conflict
        : message.includes('whatsapp_agent_alias_conflict') ? c.aliasConflict : c.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || busy || !window.confirm(c.removeConfirm)) return;
    setBusy(true);
    setError('');
    try {
      await window.forger.personalAgentWhatsAppBindingDelete({
        connectionId: editing.connectionId,
        chatId: editing.chatId,
        agentId,
      });
      setBindings((items) => items.filter((item) => !(item.connectionId === editing.connectionId && item.chatId === editing.chatId && item.agentId === agentId)));
      setUnsettled((items) => items.filter((item) => !(item.connectionId === editing.connectionId && item.chatId === editing.chatId && item.agentId === agentId)));
      setDeliveries((current) => {
        const next = { ...current };
        delete next[`${editing.connectionId}:${editing.chatId}:${agentId}`];
        return next;
      });
      setDraft(blankDraft(agentName, connections.find((item) => item.status === 'connected')?.id ?? ''));
      setEditing(null);
      setNotice(c.deleted);
    } catch {
      setError(c.deleteFailed);
    } finally {
      setBusy(false);
    }
  };

  const connectedAccounts = connections.filter((item) => item.status === 'connected');
  const editedAccountAvailable = Boolean(editing && connections.some((item) => item.id === editing.connectionId));
  const availableConnections = connectedAccounts.some((item) => item.id === draft.connectionId)
    ? connectedAccounts
    : [...connectedAccounts, ...connections.filter((item) => item.id === draft.connectionId)];

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h6">{c.title}</Typography>
        <Typography variant="body2" color="text.secondary">{c.description}</Typography>
      </Box>
      {loading ? <CircularProgress size={22} /> : null}
      {error ? <Alert severity="error">{error}</Alert> : null}
      {chatError ? <Alert severity="error">{chatError}</Alert> : null}
      {notice ? <Alert severity="success">{notice}</Alert> : null}
      {!loading && connectedAccounts.length === 0 ? <Alert severity="info">{c.noConnection}</Alert> : null}
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
                    <Typography variant="subtitle2" sx={{ overflowWrap: 'anywhere' }}>{binding.alias} · {chats.find((chat) => chat.chatId === binding.chatId)?.title ?? binding.chatId}</Typography>
                    <Typography variant="caption" color="text.secondary">{account?.label ?? c.connectionMissing}</Typography>
                  </Box>
                  <Chip size="small" color={binding.enabled ? 'success' : 'default'} label={binding.enabled ? c.active : c.inactive} />
                  {binding.activeTurnId ? <Chip size="small" color="info" label={c.working} /> : null}
                  {needsReview ? <Chip size="small" color="warning" label={c.review} /> : null}
                  {delivery ? <Chip size="small" color={delivery.state === 'sent' ? 'success' : delivery.state === 'failed' ? 'error' : 'warning'} label={delivery.state === 'sent' ? c.sent : delivery.state === 'failed' ? c.deliveryFailed : c.deliveryUnknown} /> : null}
                  <Button size="small" onClick={() => beginEdit(binding)}>{c.edit}</Button>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      ) : null}
      <Divider />
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2">{editing ? `${c.chat}: ${editing.chatId}` : c.add}</Typography>
        {editing ? <Button size="small" onClick={() => { setEditing(null); setDraft(blankDraft(agentName, connectedAccounts[0]?.id ?? '')); setNotice(''); }}>{c.add}</Button> : null}
      </Stack>
      <TextField
        select
        fullWidth
        label={c.account}
        value={draft.connectionId}
        disabled={busy || Boolean(editing) || availableConnections.length === 0}
        onChange={(event) => updateDraft((current) => ({ ...current, connectionId: event.target.value, chatId: '', participantsAllowed: [] }))}
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
          onClick={() => setChatRefresh((value) => value + 1)}
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
        onChange={(event) => updateDraft((current) => ({ ...current, chatId: event.target.value, participantsAllowed: [] }))}
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
      {(selectedChat?.chatType === 'group' || participants.length > 0 || draft.participantsAllowed.length > 0) ? (
        <Autocomplete
          multiple
          options={[...new Set([...participants, ...draft.participantsAllowed])]}
          value={draft.participantsAllowed}
          disabled={busy}
          onChange={(_event, values) => updateDraft((current) => ({ ...current, participantsAllowed: values }))}
          renderInput={(params) => <TextField {...params} label={c.participants} helperText={c.participantsHelp} />}
        />
      ) : null}
      <Stack spacing={0.5}>
        <AgentWhatsAppToggle
          checked={draft.allowAgentCapabilities}
          disabled={busy}
          label={c.capabilities}
          onCheckedChange={(checked) => updateDraft((current) => ({ ...current, allowAgentCapabilities: checked }))}
        />
        <Typography variant="caption" color="text.secondary">{c.capabilitiesHelp}</Typography>
      </Stack>
      <AgentWhatsAppToggle
        checked={draft.enabled}
        disabled={busy}
        label={c.enabled}
        onCheckedChange={(checked) => updateDraft((current) => ({ ...current, enabled: checked }))}
      />
      <Alert severity="info">{c.commands(draft.alias.trim() || c.alias)}</Alert>
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={busy || (Boolean(editing) && !editedAccountAvailable)} onClick={() => void save()}>{c.save}</Button>
        {editing ? <Button color="error" startIcon={<DeleteOutlineRounded />} disabled={busy} onClick={() => void remove()}>{c.delete}</Button> : null}
      </Stack>
    </Stack>
  );
}
