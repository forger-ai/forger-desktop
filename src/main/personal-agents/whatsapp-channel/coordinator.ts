import { WhatsAppAgentOutbox } from './outbox';
import { randomUUID } from 'node:crypto';
import { parseAgentWakeMessage } from './parser';
import { WhatsAppAgentChannelStore } from './store';
import type {
  WhatsAppAgentBindingKey,
  WhatsAppAgentChannelPorts,
  WhatsAppAgentContextMessage,
  WhatsAppAgentDeliveryResult,
  WhatsAppAgentInbound,
  WhatsAppAgentInboundResult,
  WhatsAppAgentReplyCandidate,
} from './types';

const CONTEXT_LIMIT = 30;
const CONTEXT_TEXT_LIMIT = 1600;
const CONTEXT_TOTAL_LIMIT = 12_000;

const keyOf = (key: WhatsAppAgentBindingKey): string => `${key.connectionId}\u0000${key.chatId}\u0000${key.agentId}`;

const boundContext = (messages: WhatsAppAgentContextMessage[]): WhatsAppAgentContextMessage[] => {
  let remaining = CONTEXT_TOTAL_LIMIT;
  const bounded: WhatsAppAgentContextMessage[] = [];
  for (const message of messages.slice(-CONTEXT_LIMIT).reverse()) {
    if (remaining <= 0) break;
    const text = typeof message.text === 'string' ? message.text.slice(0, Math.min(CONTEXT_TEXT_LIMIT, remaining)) : '';
    if (!text) continue;
    bounded.push({
      stableMessageRef: String(message.stableMessageRef ?? ''),
      authorId: String(message.authorId ?? ''),
      text,
    });
    remaining -= text.length;
  }
  return bounded.reverse();
};

export class WhatsAppAgentChannelCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly outbox: WhatsAppAgentOutbox;
  private closed = false;

  constructor(
    private readonly store: WhatsAppAgentChannelStore,
    private readonly ports: WhatsAppAgentChannelPorts,
  ) {
    this.outbox = new WhatsAppAgentOutbox(store, ports);
  }

  close(): void {
    this.closed = true;
    this.outbox.close();
  }

  async resume(): Promise<void> {
    for (const binding of this.store.listBindings()) await this.enqueue(binding, () => this.pump(binding));
    for (const account of new Set(
      this.store
        .listActivity()
        .filter((r) => r.deliveryState === 'pending')
        .map((r) => r.connectionId),
    )) {
      await this.outbox.flushAccount(account);
    }
  }

  async resumeBinding(key: WhatsAppAgentBindingKey): Promise<void> {
    await this.enqueue(key, () => this.pump(key));
  }

  async handleInbound(input: WhatsAppAgentInbound): Promise<WhatsAppAgentInboundResult> {
    const messageText = input.text?.trim();
    if (!input.isLive || input.isForwarded || input.isAgentEcho || !input.stableMessageRef?.trim() || !messageText)
      return { status: 'ignored' };
    const matched = this.store
      .listBindingsForChat(input.connectionId, input.chatId)
      .find((b) => parseAgentWakeMessage(messageText, b.alias));
    if (!matched) return { status: 'ignored' };
    return this.enqueue(matched, async () => {
      const binding = this.store.getBinding(matched.connectionId, matched.chatId, matched.agentId);
      const parsed = binding && parseAgentWakeMessage(messageText, binding.alias);
      if (!binding || !parsed) return { status: 'ignored' };
      const finish = (status: WhatsAppAgentInboundResult['status']): WhatsAppAgentInboundResult => {
        this.store.markMessageHandled(input.connectionId, input.chatId, input.stableMessageRef);
        return { status, agentId: binding.agentId };
      };
      const claim = this.store.claimMessage(input.connectionId, input.chatId, input.stableMessageRef);
      if (claim === 'duplicate') return { status: 'duplicate', agentId: binding.agentId };
      if (claim === 'admitting') return { status: 'reconciliation_required', agentId: binding.agentId };
      if (parsed.kind === 'on' || parsed.kind === 'off') {
        if (input.isQuoted) return finish('ignored');
        if (!input.isFromMe) return finish('unauthorized');
        if (parsed.kind === 'on' && !binding.purpose.trim()) return finish('purpose_required');
        await this.changeEnabled(binding, parsed.kind === 'on');
        return finish(parsed.kind === 'on' ? 'enabled' : 'disabled');
      }
      if (!binding.enabled) return finish('inactive');
      if (!binding.purpose.trim()) return finish('purpose_required');
      if (!input.isFromMe && (!input.authorId || !binding.participantsAllowed.includes(input.authorId)))
        return finish('unauthorized');
      if (parsed.kind === 'correct' || parsed.kind === 'correct-own') {
        const activity = this.store.listActivity(binding);
        const target =
          parsed.kind === 'correct-own'
            ? activity
                .reverse()
                .find(
                  (request) =>
                    (request.status === 'active' || request.status === 'queued') &&
                    request.isFromMe === input.isFromMe &&
                    (input.isFromMe || request.authorId === input.authorId),
                )
            : activity.find((request) => request.requestId === parsed.requestId);
        if (!target && parsed.kind === 'correct-own') return finish('ignored');
        if (!target || (!input.isFromMe && (target.isFromMe || target.authorId !== input.authorId)))
          return finish('unauthorized');
        if (target.status === 'queued') {
          this.store.updateRequest(target.requestId, { requestText: parsed.text });
          return finish('queued');
        }
        if (target.status !== 'active') return finish('failed');
        await this.cancelUnlocked(binding, target.requestId, 'corrected');
      }
      const requestId = randomUUID();
      const now = new Date().toISOString();
      this.store.queueRequest({
        ...binding,
        requestId,
        runId: randomUUID(),
        requestText: parsed.text,
        authorId: input.authorId ?? null,
        isFromMe: input.isFromMe,
        createdAt: now,
        updatedAt: now,
        stableMessageRef: input.stableMessageRef,
      });
      await this.pump(binding);
      const request = this.store.listActivity(binding).find((r) => r.requestId === requestId)!;
      return {
        status: request.status === 'active' ? 'started' : request.status === 'queued' ? 'queued' : 'failed',
        agentId: binding.agentId,
        turnId: requestId,
        revision: request.revision,
      };
    });
  }

  private async pump(key: WhatsAppAgentBindingKey): Promise<void> {
    if (this.closed) return;
    const binding = this.store.getBinding(key.connectionId, key.chatId, key.agentId);
    if (!binding?.enabled || binding.activeTurnId) return;
    const request = this.store.listActivity(key).find((r) => r.status === 'queued');
    if (!request) return;
    if (!request.isFromMe && (!request.authorId || !binding.participantsAllowed.includes(request.authorId))) {
      this.store.updateRequest(request.requestId, { status: 'canceled', reason: 'participant_access_removed' });
      return this.pump(key);
    }
    // Persist the exact request/run association BEFORE any asynchronous runner work.
    const changed = this.store.activateRequest(request, binding);
    if (!changed) return;
    let context: WhatsAppAgentContextMessage[] = [];
    try {
      context = boundContext((await this.ports.readContext?.(changed, CONTEXT_LIMIT)) ?? []);
    } catch {
      /* Supplementary context. */
    }
    const current = this.store.getBinding(key.connectionId, key.chatId, key.agentId);
    if (this.closed || !current?.enabled || current.activeTurnId !== request.requestId) return;
    try {
      const accepted = await this.ports.startRun({
        binding: changed,
        turnId: request.requestId,
        runId: request.runId,
        revision: changed.revision,
        text: request.requestText,
        context,
        stableMessageRef: request.stableMessageRef,
        authorId: request.authorId,
        isFromMe: request.isFromMe,
      });
      if (accepted.status === 'rejected') {
        this.store.settleRequest(changed, request.requestId, changed.revision, {
          status: 'failed',
          reason: accepted.reason,
        });
        this.store.markTurnStatus(request.requestId, 'failed');
        await this.pump(key);
        return;
      }
      if (accepted.status === 'unknown') throw new Error('whatsapp_agent_run_admission_unknown');
      if (accepted.runId !== request.runId) throw new Error('whatsapp_agent_run_id_mismatch');
    } catch {
      // The adapter reconciles a run that was admitted before returning. No implicit replay.
      this.store.updateRequest(request.requestId, { status: 'interrupted', reason: 'run_admission_interrupted' });
      this.store.markTurnStatus(request.requestId, 'interrupted');
      this.store.finishTurn(changed, request.requestId, changed.revision);
      await this.pump(key);
    }
  }

  async deliverCandidate(candidate: WhatsAppAgentReplyCandidate): Promise<WhatsAppAgentDeliveryResult> {
    let delivery: Promise<void> | undefined;
    const result = await this.enqueue<WhatsAppAgentDeliveryResult>(candidate, async () => {
      const request = this.store.listActivity(candidate).find((r) => r.requestId === candidate.turnId);
      if (request?.deliveryState || this.store.hasDelivery(candidate, candidate.turnId)) return 'duplicate';
      const binding = this.store.getBinding(candidate.connectionId, candidate.chatId, candidate.agentId);
      if (!binding?.enabled || binding.revision !== candidate.revision || binding.activeTurnId !== candidate.turnId)
        return 'stale';
      this.store.settleRequest(candidate, candidate.turnId, candidate.revision, {
        status: 'completed',
        responseText: candidate.text,
        deliveryState: 'pending',
        reason: null,
      });
      // Transport waits never retain the binding lock or prevent the next task from running.
      delivery = this.outbox.flushAccount(candidate.connectionId).catch(() => undefined);
      await this.pump(candidate);
      return 'pending';
    });
    if (result !== 'pending') return result;
    await delivery;
    if (this.closed) return 'unknown';
    const state = this.store.listActivity(candidate).find((r) => r.requestId === candidate.turnId)?.deliveryState;
    return state === 'sent' || state === 'failed' || state === 'unknown' ? state : 'pending';
  }

  async settleWithoutReply(runId: string, status: 'failed' | 'canceled'): Promise<'settled' | 'stale' | 'unknown'> {
    const turn = this.store.findTurnByRunId(runId);
    if (!turn) return 'unknown';
    return this.enqueue(turn, async () => {
      const binding = this.store.getBinding(turn.connectionId, turn.chatId, turn.agentId);
      if (!binding || binding.activeTurnId !== turn.turnId) return 'stale';
      this.store.settleRequest(turn, turn.turnId, turn.revision, {
        status,
        reason: status === 'failed' ? 'run_failed' : 'run_canceled',
      });
      this.store.markTurnStatus(turn.turnId, status);
      await this.pump(turn);
      return 'settled';
    });
  }

  async setEnabled(key: WhatsAppAgentBindingKey, enabled: boolean, expectedConfigurationVersion?: number) {
    // Revocation is local and immediate even while a context read or runner startup is blocked.
    const result = await this.changeEnabled(key, enabled, expectedConfigurationVersion);
    if (enabled) {
      await this.enqueue(key, () => this.pump(key));
      await this.outbox.flushAccount(key.connectionId);
    }
    return result;
  }

  private async changeEnabled(key: WhatsAppAgentBindingKey, enabled: boolean, expected?: number) {
    const previous = this.store.getBinding(key.connectionId, key.chatId, key.agentId);
    const changed = this.store.setEnabled(key, enabled, expected);
    if (previous?.activeTurnId && !enabled) await this.cancelUnlocked(previous, previous.activeTurnId, 'off');
    return changed;
  }

  async cancelRequest(key: WhatsAppAgentBindingKey, requestId: string): Promise<void> {
    return this.enqueue(key, async () => {
      await this.cancelUnlocked(key, requestId, 'canceled');
      await this.pump(key);
    });
  }

  private async cancelUnlocked(
    key: WhatsAppAgentBindingKey,
    requestId: string,
    reason: 'off' | 'canceled' | 'corrected',
  ): Promise<void> {
    const request = this.store.listActivity(key).find((r) => r.requestId === requestId);
    const binding = this.store.getBinding(key.connectionId, key.chatId, key.agentId);
    if (!request || !binding || !['queued', 'active'].includes(request.status))
      throw new Error('whatsapp_agent_request_not_cancelable');
    this.store.settleRequest(key, requestId, request.revision, { status: 'canceled', reason });
    this.store.markTurnStatus(requestId, 'canceled');
    if (request.status === 'active') {
      try {
        const cancellation = this.ports.cancelRun({ binding, turnId: requestId, reason });
        if (reason === 'off') void cancellation.catch(() => undefined);
        else await cancellation;
      } catch {
        /* Durable revocation remains effective if the process already exited. */
      }
    }
  }

  async retryDelivery(key: WhatsAppAgentBindingKey, requestId: string): Promise<void> {
    const request = this.store.listActivity(key).find((r) => r.requestId === requestId);
    if (request?.deliveryState !== 'failed' || request.reason === 'channel_reconfigured' || !request.responseText)
      throw new Error('whatsapp_agent_delivery_not_retryable');
    this.store.updateRequest(requestId, { deliveryState: 'pending', retryAt: 0, reason: null });
    await this.outbox.flushAccount(key.connectionId);
  }

  async dismissRequest(key: WhatsAppAgentBindingKey, requestId: string): Promise<void> {
    const request = this.store.listActivity(key).find((r) => r.requestId === requestId);
    if (!request || (request.status !== 'interrupted' && request.deliveryState !== 'unknown'))
      throw new Error('whatsapp_agent_request_not_dismissible');
    this.store.updateRequest(requestId, { status: 'dismissed' });
  }

  private enqueue<T>(key: WhatsAppAgentBindingKey, work: () => Promise<T>): Promise<T> {
    const queueKey = keyOf(key);
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(queueKey, tail);
    void tail.then(() => {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    });
    return result;
  }
}
