import { useEffect, useMemo, useState } from 'react';
import type { ConnectionInstance, WhatsAppAgentBinding, WhatsAppAgentDeliveryStatus, WhatsAppAgentUnsettledMessage } from '@shared/types';
import { blankDraft, emptyPolicy, observedChats, observedParticipants, type BindingDraft, type ObservedChat } from './model';
import type { ChannelCopy } from './copy';

export function useChannelEditor(agentId: string, agentName: string, c: ChannelCopy) {
  const [connections, setConnections] = useState<ConnectionInstance[]>([]);
  const [bindings, setBindings] = useState<WhatsAppAgentBinding[]>([]);
  const [unsettled, setUnsettled] = useState<WhatsAppAgentUnsettledMessage[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, WhatsAppAgentDeliveryStatus | null>>({});
  const [draft, setDraft] = useState<BindingDraft>(() => blankDraft(agentName));
  const [editing, setEditing] = useState<WhatsAppAgentBinding | null>(null);
  const [chats, setChats] = useState<ObservedChat[]>([]);
  const [participants, setParticipants] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState('');
  const [chatRefresh, setChatRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingChats, setLoadingChats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chatError, setChatError] = useState('');
  const [notice, setNotice] = useState('');
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantsError, setParticipantsError] = useState('');
  const [participantsRefresh, setParticipantsRefresh] = useState(0);
  const [conflicting, setConflicting] = useState<WhatsAppAgentBinding | null>(null);

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
      const connectionId = nextConnections.find((item) => item.status === 'connected')?.id ?? '';
      setDraft(blankDraft(nextBindings.find((item) => item.connectionId === connectionId)?.alias ?? agentName, connectionId));
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
        const [nextBindings, nextUnsettled, connectionState] = await Promise.all([
          window.forger.personalAgentWhatsAppBindingsList({ agentId }),
          window.forger.personalAgentWhatsAppUnsettledList({ agentId }),
          window.forger.connectionsList(),
        ]);
        const latestDeliveries = await Promise.all(nextBindings.map(async (binding) => {
          const latest = await window.forger.personalAgentWhatsAppLatestDeliveryGet({
            connectionId: binding.connectionId, chatId: binding.chatId, agentId: binding.agentId,
          }).catch(() => null);
          return [`${binding.connectionId}:${binding.chatId}:${binding.agentId}`, latest] as const;
        }));
        if (!current) return;
        setConnections(connectionState.instances.filter((item) => item.type === 'whatsapp'));
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
      setLoadingChats(false);
      setChats([]);
      setChatError('');
      return () => { current = false; };
    }
    setChats([]);
    setChatError('');
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
      setParticipantsLoading(false);
      setParticipantsError('');
      setParticipants([]);
      return () => { current = false; };
    }
    setParticipants([]);
    setParticipantsError('');
    setParticipantsLoading(true);
    window.forger.connectionsCall({
      type: 'whatsapp',
      connectionId: draft.connectionId,
      actionId: 'whatsapp.get_chat_details',
      input: { chatId: draft.chatId },
    }).then((result) => {
      if (!current) return;
      if (!result.success) throw new Error('participants_unavailable');
      setParticipants(observedParticipants(result.data));
    }).catch(() => {
      if (current) setParticipantsError(c.participantsFailed);
    }).finally(() => { if (current) setParticipantsLoading(false); });
    return () => { current = false; };
  }, [draft.connectionId, draft.chatId, participantsRefresh, c.participantsFailed]);

  const beginEdit = (binding: WhatsAppAgentBinding) => {
    setConflicting(null);
    setEditing(binding);
    setDraft({
      connectionId: binding.connectionId,
      chatId: binding.chatId,
      alias: binding.alias,
      purpose: binding.purpose,
      scope: binding.scope,
      participantsAllowed: binding.participantsAllowed,
      enabled: binding.enabled,
      policy: { ...(binding.policy ?? emptyPolicy()), networkAccess: false },
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
    let expectedConfigurationVersion = editing?.configurationVersion;
    try {
      const currentAlias = bindings.find((item) => item.connectionId === draft.connectionId)?.alias;
      if (currentAlias && currentAlias !== draft.alias.trim()) {
        const updated = await window.forger.personalAgentWhatsAppAliasUpdate({ connectionId: draft.connectionId, agentId, alias: draft.alias.trim() });
        setBindings((items) => [...items.filter((item) => item.connectionId !== draft.connectionId), ...updated]);
        const changed = updated.find((item) => item.chatId === draft.chatId);
        if (changed) { setEditing(changed); expectedConfigurationVersion = changed.configurationVersion; }
      }
      const saved = await window.forger.personalAgentWhatsAppBindingPut({
        agentId,
        connectionId: draft.connectionId,
        chatId: draft.chatId,
        alias: draft.alias.trim(),
        purpose: draft.purpose.trim(),
        scope: draft.scope.trim(),
        participantsAllowed: draft.participantsAllowed,
        allowAgentCapabilities: true,
        policy: { ...draft.policy, networkAccess: false },
        enabled: draft.enabled,
        ...(editing ? { expectedConfigurationVersion } : {}),
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
      if (message.includes('conflict') && !message.includes('alias_conflict') && editing) {
        const latest = await window.forger.personalAgentWhatsAppBindingGet(editing).catch(() => null);
        setConflicting(latest);
      }
      setError((message.includes('whatsapp_agent_binding_revision_conflict') || message.includes('configuration_conflict')) ? c.conflict
        : message.includes('whatsapp_agent_alias_conflict') ? c.aliasConflict : c.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || busy) return;
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

  const pause = async (binding: WhatsAppAgentBinding) => {
    setBusy(true);
    try {
      const saved = await window.forger.personalAgentWhatsAppBindingSetEnabled({ connectionId: binding.connectionId, chatId: binding.chatId, agentId, enabled: false, expectedConfigurationVersion: binding.configurationVersion });
      setBindings((items) => items.map((item) => item.connectionId === saved.connectionId && item.chatId === saved.chatId ? saved : item));
      if (editing?.chatId === saved.chatId && editing.connectionId === saved.connectionId) { setEditing(saved); setDraft((value) => ({ ...value, enabled: false })); }
    } catch { setError(c.actionFailed); } finally { setBusy(false); }
  };

  const refreshConnections = async () => {
    try { const state = await window.forger.connectionsList(); setConnections(state.instances.filter((item) => item.type === 'whatsapp')); }
    catch { setError(c.loadFailed); }
    setChatRefresh((value) => value + 1);
  };
  return { refreshConnections, pause, conflicting, setConflicting, participantsLoading, participantsError, setParticipantsRefresh, connections, bindings, unsettled, deliveries, draft, editing, chats, participants, search, loading, loadingChats, busy, error, chatError, notice, updateDraft, setChatRefresh, setSearch, beginEdit, save, remove, connectedAccounts, editedAccountAvailable, availableConnections, selectedChat, chatChoices, setEditing, setDraft, setNotice };
}
