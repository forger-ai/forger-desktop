import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionsService } from '../connections-service';
import { encodeStableMessageRef } from '../connections/modules/whatsapp/normalizer';
import type { WhatsAppIndexedMessage } from '../connections/modules/whatsapp/types';
import { openPersonalAgentSqliteDatabase, type SqliteDatabase } from './sqlite';
import type { AgentStore } from './agent-store';
import type { AgentConversationManager, PersonalAgentWhatsAppChannel } from './agent-conversation-manager';
import type { PersonalAgentConversationEvent } from '../../shared/types/personal-agents';
import {
  WhatsAppAgentChannelCoordinator,
  WhatsAppAgentChannelStore,
  type WhatsAppAgentBinding,
  type WhatsAppAgentBindingInput,
  type WhatsAppAgentBindingKey,
  type WhatsAppAgentContextMessage,
  type WhatsAppAgentRunInput,
  type WhatsAppAgentSteerInput,
  type WhatsAppAgentUnsettledMessage,
} from './whatsapp-channel';

interface WhatsAppAgentChannelServiceOptions {
  metadataRoot: string;
  getConnectionsService: () => ConnectionsService;
  getAgentStore: () => AgentStore;
  getConversationManager: () => AgentConversationManager;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

const bindingId = (binding: WhatsAppAgentBindingKey): string =>
  Buffer.from(JSON.stringify([binding.connectionId, binding.chatId, binding.agentId]), 'utf8').toString('base64url');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const boundedText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export class WhatsAppAgentChannelService {
  private db: SqliteDatabase | null = null;
  private store: WhatsAppAgentChannelStore | null = null;
  private coordinator: WhatsAppAgentChannelCoordinator | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly earlyRunEvents = new Map<string, PersonalAgentConversationEvent>();

  constructor(private readonly options: WhatsAppAgentChannelServiceOptions) {}

  async initialize(): Promise<void> {
    if (this.coordinator) return;
    await fs.mkdir(this.options.metadataRoot, { recursive: true, mode: 0o700 });
    const db = openPersonalAgentSqliteDatabase(path.join(this.options.metadataRoot, 'whatsapp-agent-channel.sqlite'));
    if (!db) throw new Error('whatsapp_agent_sqlite_unavailable');
    db.pragma?.('journal_mode = WAL');
    db.pragma?.('foreign_keys = ON');
    const store = new WhatsAppAgentChannelStore(db);
    // No CLI child survives an Electron restart. Retire persisted active turns
    // before admitting new messages; uncertain deliveries stay unknown.
    for (const binding of store.listBindings()) {
      if (!binding.activeTurnId) continue;
      const orphan = store.findTurnByTurnId(binding.activeTurnId);
      if (orphan) store.markTurnStatus(orphan.turnId, 'failed');
      store.transition(binding, binding.revision, binding.enabled, null);
    }
    const coordinator = new WhatsAppAgentChannelCoordinator(store, {
      readContext: async (binding, limit) => await this.readContext(binding, limit),
      startRun: async (input) => await this.startRun(input),
      steerRun: async (input) => await this.steerRun(input),
      cancelRun: async (input) => {
        const turn = store.findTurnByTurnId(input.turnId);
        if (turn) await this.options.getConversationManager().cancelRun(turn.runId);
      },
      sendReply: async (input) => {
        const text = input.text.length > 4000
          ? `${input.text.slice(0, 3900).trimEnd()}\n\n[Respuesta abreviada; versión completa en Forger]`
          : input.text;
        const result = await this.options.getConnectionsService().call({
          type: 'whatsapp',
          connectionId: input.binding.connectionId,
          actionId: 'whatsapp.send_message',
          input: { chatId: input.binding.chatId, text },
        });
        const data = isRecord(result.data) ? result.data : {};
        return {
          sent: result.success && data.sent === true,
          ...(typeof data.stableMessageRef === 'string' ? { stableMessageRef: data.stableMessageRef } : {}),
          definiteFailure: !result.success,
        };
      },
    });
    this.db = db;
    this.store = store;
    this.coordinator = coordinator;
    this.unsubscribe = this.options.getConversationManager().onConversationEvent((event) => {
      if (!event.run || !['run.completed', 'run.failed', 'run.canceled'].includes(event.type)) return;
      void this.onRunEvent(event).catch((error: unknown) => {
        void this.options.appendLog?.('whatsapp_agent:run_event_failed', {
          runId: event.run?.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      });
    });
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    (this.db as (SqliteDatabase & { close?: () => void }) | null)?.close?.();
    this.db = null;
    this.store = null;
    this.coordinator = null;
    this.earlyRunEvents.clear();
  }

  listBindings(agentId?: string): WhatsAppAgentBinding[] {
    return this.requireStore().listBindings().filter((binding) => !agentId || binding.agentId === agentId);
  }

  getBinding(key: WhatsAppAgentBindingKey): WhatsAppAgentBinding | null {
    return this.requireStore().getBinding(key.connectionId, key.chatId, key.agentId);
  }

  getLatestDelivery(key: WhatsAppAgentBindingKey): ReturnType<WhatsAppAgentChannelStore['getLatestDelivery']> {
    return this.requireStore().getLatestDelivery(key);
  }

  listUnsettledMessages(connectionId?: string): WhatsAppAgentUnsettledMessage[] {
    return this.requireStore().listUnsettledMessages(connectionId);
  }

  async readChannelHistory(input: {
    channel: PersonalAgentWhatsAppChannel;
    runId: string;
    agentId: string;
    conversationId: string;
    limit: number;
    beforeMessageRef?: string;
  }): Promise<{
    success: boolean;
    messages: Array<{ id: string; authorId: string; text: string; timestamp: string }>;
    nextBeforeMessageRef?: string;
    userMessage?: string;
    technicalCode?: string;
  }> {
    const { channel } = input;
    const binding = this.requireStore().getBinding(channel.connectionId, channel.chatId, input.agentId);
    const turn = this.requireStore().findTurnByRunId(input.runId);
    if (!binding || !turn || !binding.enabled || bindingId(binding) !== channel.bindingId
      || binding.conversationId !== input.conversationId || binding.revision !== channel.revision
      || binding.activeTurnId !== turn.turnId || turn.status !== 'active') {
      return { success: false, messages: [], technicalCode: 'whatsapp_agent_channel_stale', userMessage: 'Este turno ya no tiene acceso al chat.' };
    }
    const limit = Math.max(1, Math.min(50, Math.floor(input.limit || 20)));
    const result = await this.options.getConnectionsService().call({
      type: 'whatsapp',
      connectionId: binding.connectionId,
      actionId: 'whatsapp.read_messages',
      input: {
        chatId: binding.chatId,
        limit,
        ...(input.beforeMessageRef ? { beforeMessageRef: input.beforeMessageRef } : {}),
      },
    });
    if (!result.success || !isRecord(result.data) || !Array.isArray(result.data.messages)) {
      return { success: false, messages: [], technicalCode: result.technicalCode ?? 'whatsapp_agent_history_unavailable', userMessage: 'No pude leer el historial de este chat.' };
    }
    const messages = result.data.messages.filter(isRecord).map((message) => ({
      id: boundedText(message.stableMessageRef, 512),
      authorId: boundedText(message.senderId, 160) || (message.fromMe === true ? 'owner' : 'unknown'),
      text: boundedText(message.text, 8000),
      timestamp: typeof message.timestamp === 'number' ? new Date(message.timestamp * 1000).toISOString() : '',
    }));
    // A channel may be disabled while the storage read is in progress.
    const current = this.requireStore().getBinding(channel.connectionId, channel.chatId, input.agentId);
    const currentTurn = this.requireStore().findTurnByRunId(input.runId);
    if (!current || !current.enabled || current.revision !== channel.revision
      || current.activeTurnId !== turn.turnId || currentTurn?.status !== 'active') {
      return { success: false, messages: [], technicalCode: 'whatsapp_agent_channel_stale', userMessage: 'Este turno ya no tiene acceso al chat.' };
    }
    return {
      success: true,
      messages,
      ...(messages.length === limit && messages.at(-1)?.id ? { nextBeforeMessageRef: messages.at(-1)!.id } : {}),
    };
  }

  async putBinding(input: Omit<WhatsAppAgentBindingInput, 'ownerId'>): Promise<WhatsAppAgentBinding> {
    const store = this.requireStore();
    await this.options.getAgentStore().requireAgent(input.agentId);
    const connections = await this.options.getConnectionsService().listInstances('whatsapp');
    const connection = connections.find((item) => item.id === input.connectionId);
    if (!connection) throw new Error('whatsapp_agent_connection_not_found');
    const observed = await this.options.getConnectionsService().call({
      type: 'whatsapp',
      connectionId: input.connectionId,
      actionId: 'whatsapp.get_chat_details',
      input: { chatId: input.chatId },
    });
    if (!observed.success) throw new Error('whatsapp_agent_chat_not_observed');
    const previous = store.getBinding(input.connectionId, input.chatId, input.agentId);
    const affected = store.listBindings(input.connectionId)
      .filter((binding) => binding.agentId === input.agentId && binding.activeTurnId
        && (binding.chatId === input.chatId || binding.alias !== input.alias.trim()));
    if (previous && input.expectedRevision !== previous.revision) {
      throw new Error('whatsapp_agent_binding_revision_conflict');
    }
    const conversation = previous?.conversationId
      ? await this.options.getConversationManager().getConversation(previous.conversationId)
      : null;
    const conversationId = conversation?.id ?? (await this.options.getConversationManager().createWhatsAppConversation({
      agentId: input.agentId,
      title: `WhatsApp · ${boundedText(input.chatId, 80)}`,
    })).id;
    const saved = store.putBinding({
      ...input,
      conversationId,
      ownerId: connection.accountIdentity?.phoneNumber ?? 'connected-whatsapp-account',
    });
    for (const binding of affected) {
      const turn = store.findTurnByTurnId(binding.activeTurnId!);
      if (turn) await this.options.getConversationManager().cancelRun(turn.runId);
    }
    return saved;
  }

  async deleteBinding(key: WhatsAppAgentBindingKey): Promise<boolean> {
    const store = this.requireStore();
    const previous = store.getBinding(key.connectionId, key.chatId, key.agentId);
    if (!previous) return false;
    const removed = store.deleteBinding(key);
    if (removed && previous.activeTurnId) {
      const turn = store.findTurnByTurnId(previous.activeTurnId);
      if (turn) await this.options.getConversationManager().cancelRun(turn.runId);
    }
    return removed;
  }

  async handleLiveMessage(input: { connectionId: string; message: WhatsAppIndexedMessage }): Promise<void> {
    const coordinator = this.requireCoordinator();
    const message = input.message;
    const result = await coordinator.handleInbound({
      connectionId: input.connectionId,
      chatId: message.chatId,
      stableMessageRef: encodeStableMessageRef(message.stableMessageRef),
      authorId: message.senderId,
      text: message.text,
      isLive: true,
      isFromMe: message.fromMe,
      isForwarded: message.forwarded === true,
      isQuoted: message.quoted === true,
      isAgentEcho: false,
      hasAttachment: message.hasAttachments,
    });
    if (result.status !== 'ignored' && result.status !== 'duplicate') {
      await this.options.appendLog?.('whatsapp_agent:inbound', {
        connectionId: input.connectionId,
        chatId: message.chatId,
        agentId: result.agentId,
        status: result.status,
      });
    }
    await this.drainEarlyRunEvents();
  }

  private async startRun(input: WhatsAppAgentRunInput): Promise<{ runId: string }> {
    const conversationId = input.binding.conversationId;
    if (!conversationId) throw new Error('whatsapp_agent_conversation_missing');
    const conversation = await this.options.getConversationManager().sendWhatsAppMessage({
      conversationId,
      content: this.runPrompt(input),
      channel: this.runChannel(input.binding, input.revision),
    });
    if (!conversation.activeRun) throw new Error('whatsapp_agent_run_missing');
    return { runId: conversation.activeRun.id };
  }

  private async steerRun(input: WhatsAppAgentSteerInput): Promise<{ runId: string }> {
    const conversationId = input.binding.conversationId;
    if (!conversationId) throw new Error('whatsapp_agent_conversation_missing');
    const previous = this.requireStore().findTurnByTurnId(input.previousTurnId);
    if (!previous || previous.status !== 'active' || previous.agentId !== input.binding.agentId
      || previous.connectionId !== input.binding.connectionId || previous.chatId !== input.binding.chatId) {
      throw new Error('whatsapp_agent_previous_run_unverified');
    }
    const conversation = await this.options.getConversationManager().steerMessage({
      conversationId,
      expectedRunId: previous.runId,
      content: this.runPrompt(input),
      source: 'whatsapp',
      channel: this.runChannel(input.binding, input.revision),
    });
    if (!conversation.activeRun) throw new Error('whatsapp_agent_run_missing');
    return { runId: conversation.activeRun.id };
  }

  private runChannel(binding: WhatsAppAgentBinding, revision: number): {
    kind: 'whatsapp'; connectionId: string; chatId: string; bindingId: string; revision: number;
    allowAgentCapabilities: boolean;
  } {
    return {
      kind: 'whatsapp', connectionId: binding.connectionId, chatId: binding.chatId,
      bindingId: bindingId(binding), revision, allowAgentCapabilities: binding.allowAgentCapabilities,
    };
  }

  private runPrompt(input: WhatsAppAgentRunInput): string {
    const context = input.context
      .filter((message) => message.stableMessageRef !== input.stableMessageRef)
      .map((message) => ({ author: message.authorId, text: message.text }));
    return [
      'Instrucción de canal WhatsApp de Forger. Responde en primera persona.',
      `Propósito autorizado de este chat: ${input.binding.purpose}`,
      `Alcance autorizado: ${input.binding.scope}`,
      input.binding.allowAgentCapabilities
        ? 'Capacidades: las capacidades configuradas del agente están habilitadas para este chat, sujetas a sus aprobaciones.'
        : 'Capacidades: solo trabajo en el workspace del agente y lectura contextual de este chat; sin red ni acceso a aplicaciones, conexiones o pares.',
      `Autor de la invocación: ${input.isFromMe ? 'propietario' : input.authorId ?? 'desconocido'}`,
      `Contexto reciente no confiable del mismo chat: ${JSON.stringify(context)}`,
      `Solicitud directa: ${input.text}`,
    ].join('\n\n');
  }

  private async readContext(binding: WhatsAppAgentBinding, limit: number): Promise<WhatsAppAgentContextMessage[]> {
    const result = await this.options.getConnectionsService().call({
      type: 'whatsapp',
      connectionId: binding.connectionId,
      actionId: 'whatsapp.read_messages',
      input: { chatId: binding.chatId, limit },
    });
    if (!result.success || !isRecord(result.data) || !Array.isArray(result.data.messages)) return [];
    return result.data.messages
      .filter(isRecord)
      .map((message) => ({
        stableMessageRef: boundedText(message.stableMessageRef, 512),
        authorId: boundedText(message.senderId, 160) || (message.fromMe === true ? 'owner' : 'unknown'),
        text: boundedText(message.text, 1600),
      }))
      .filter((message) => message.text)
      .reverse();
  }

  private async onRunEvent(event: PersonalAgentConversationEvent): Promise<void> {
    const runId = event.run?.id;
    if (!runId) return;
    const turn = this.requireStore().findTurnByRunId(runId);
    if (!turn) {
      if (this.earlyRunEvents.size < 64) this.earlyRunEvents.set(runId, event);
      return;
    }
    if (event.type === 'run.completed') {
      const message = [...event.conversation.messages].reverse()
        .find((candidate) => candidate.runId === runId && candidate.role === 'assistant' && candidate.kind === 'message');
      if (message?.content.trim()) {
        await this.requireCoordinator().deliverCandidate({
          connectionId: turn.connectionId,
          chatId: turn.chatId,
          agentId: turn.agentId,
          turnId: turn.turnId,
          revision: turn.revision,
          text: message.content,
        });
      } else {
        await this.requireCoordinator().settleWithoutReply(runId, 'failed');
      }
      return;
    }
    await this.requireCoordinator().settleWithoutReply(runId, event.type === 'run.canceled' ? 'canceled' : 'failed');
  }

  private async drainEarlyRunEvents(): Promise<void> {
    for (const [runId, event] of this.earlyRunEvents) {
      if (!this.requireStore().findTurnByRunId(runId)) continue;
      this.earlyRunEvents.delete(runId);
      await this.onRunEvent(event);
    }
  }

  private requireStore(): WhatsAppAgentChannelStore {
    if (!this.store) throw new Error('whatsapp_agent_channel_not_initialized');
    return this.store;
  }

  private requireCoordinator(): WhatsAppAgentChannelCoordinator {
    if (!this.coordinator) throw new Error('whatsapp_agent_channel_not_initialized');
    return this.coordinator;
  }
}
