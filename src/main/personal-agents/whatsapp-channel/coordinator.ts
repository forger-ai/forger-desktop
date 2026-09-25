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

  constructor(private readonly store: WhatsAppAgentChannelStore, private readonly ports: WhatsAppAgentChannelPorts) {}

  async handleInbound(input: WhatsAppAgentInbound): Promise<WhatsAppAgentInboundResult> {
    const messageText = input.text?.trim();
    if (!input.isLive || input.isForwarded || input.isAgentEcho || !input.stableMessageRef?.trim() || !messageText) {
      return { status: 'ignored' };
    }
    const matched = this.store.listBindingsForChat(input.connectionId, input.chatId)
      .find((binding) => parseAgentWakeMessage(messageText, binding.alias));
    if (!matched) return { status: 'ignored' };
    return this.enqueue(matched, async () => {
      const binding = this.store.getBinding(matched.connectionId, matched.chatId, matched.agentId);
      const parsed = binding && parseAgentWakeMessage(messageText, binding.alias);
      if (!binding || !parsed) return { status: 'ignored' };
      const finish = (result: WhatsAppAgentInboundResult): WhatsAppAgentInboundResult => {
        this.store.markMessageHandled(input.connectionId, input.chatId, input.stableMessageRef);
        return result;
      };
      // pending can safely be replayed. admitting may have reached the runner and needs reconciliation.
      const claim = this.store.claimMessage(input.connectionId, input.chatId, input.stableMessageRef);
      if (claim === 'duplicate') {
        return { status: 'duplicate', agentId: binding.agentId };
      }
      if (claim === 'admitting') {
        return { status: 'reconciliation_required', agentId: binding.agentId };
      }
      if (parsed.kind !== 'task') {
        if (input.isQuoted) return finish({ status: 'ignored', agentId: binding.agentId });
        if (!input.isFromMe) return finish({ status: 'unauthorized', agentId: binding.agentId });
        if (parsed.kind === 'on') {
          if (!binding.purpose.trim()) return finish({ status: 'purpose_required', agentId: binding.agentId });
          if (binding.enabled) return finish({ status: 'enabled', agentId: binding.agentId, revision: binding.revision });
          const changed = this.store.transition(binding, binding.revision, true, null);
          return finish(changed
            ? { status: 'enabled', agentId: binding.agentId, revision: changed.revision }
            : { status: 'failed', agentId: binding.agentId });
        }
        if (!binding.enabled && !binding.activeTurnId) {
          return finish({ status: 'disabled', agentId: binding.agentId, revision: binding.revision });
        }
        const changed = this.store.transition(binding, binding.revision, false, null);
        if (!changed) return finish({ status: 'failed', agentId: binding.agentId });
        this.store.markMessageHandled(input.connectionId, input.chatId, input.stableMessageRef);
        if (binding.activeTurnId) {
          try {
            await this.ports.cancelRun({ binding, turnId: binding.activeTurnId, reason: 'off' });
          } catch {
            // OFF has already invalidated the run. Its eventual response remains stale.
          }
        }
        return { status: 'disabled', agentId: binding.agentId, revision: changed.revision };
      }
      if (!binding.enabled) return finish({ status: 'inactive', agentId: binding.agentId });
      if (!binding.purpose.trim()) return finish({ status: 'purpose_required', agentId: binding.agentId });
      if (!input.isFromMe && (!input.authorId || !binding.participantsAllowed.includes(input.authorId))) {
        return finish({ status: 'unauthorized', agentId: binding.agentId });
      }
      if (binding.activeTurnId && this.store.findTurnByTurnId(binding.activeTurnId)?.status !== 'active') {
        // A previous runner admission may have succeeded before its run ID
        // could be recorded. Never steer without an exact run to replace.
        return { status: 'reconciliation_required', agentId: binding.agentId };
      }
      let context: WhatsAppAgentContextMessage[] = [];
      try {
        context = boundContext(await this.ports.readContext?.(binding, CONTEXT_LIMIT) ?? []);
      } catch {
        // Context is supplementary; the directly invoked task can still run.
      }
      const turnId = randomUUID();
      const previousTurnId = binding.activeTurnId;
      const changed = this.store.prepareTurn(binding, binding.revision, turnId, input.stableMessageRef);
      if (!changed) return finish({ status: 'failed', agentId: binding.agentId });
      const runInput = {
        binding: changed,
        turnId,
        revision: changed.revision,
        text: parsed.text,
        context,
        stableMessageRef: input.stableMessageRef,
        authorId: input.authorId ?? null,
        isFromMe: input.isFromMe,
      };
      try {
        const admitted = previousTurnId
          ? await this.ports.steerRun({ ...runInput, previousTurnId })
          : await this.ports.startRun(runInput);
        this.store.recordRun(changed, turnId, changed.revision, admitted.runId);
      } catch {
        return { status: 'reconciliation_required', agentId: binding.agentId, turnId, revision: changed.revision };
      }
      return {
        status: previousTurnId ? 'steered' : 'started',
        agentId: binding.agentId,
        turnId,
        revision: changed.revision,
      };
    });
  }

  async deliverCandidate(candidate: WhatsAppAgentReplyCandidate): Promise<WhatsAppAgentDeliveryResult> {
    return this.enqueue(candidate, async () => {
      if (this.store.hasDelivery(candidate, candidate.turnId)) return 'duplicate';
      const binding = this.store.getBinding(candidate.connectionId, candidate.chatId, candidate.agentId);
      if (!binding || !binding.enabled || binding.revision !== candidate.revision || binding.activeTurnId !== candidate.turnId) {
        return 'stale';
      }
      if (!this.store.claimDelivery(candidate, candidate.turnId, candidate.revision)) return 'duplicate';
      // The durable claim starts as unknown. A crash or transport timeout never triggers automatic resend.
      try {
        const outcome = await this.ports.sendReply({ binding, turnId: candidate.turnId, revision: candidate.revision, text: candidate.text });
        const state = outcome.sent ? 'sent' : outcome.definiteFailure ? 'failed' : 'unknown';
        this.store.markDelivery(candidate, candidate.turnId, state, outcome.stableMessageRef);
        this.store.markTurnStatus(candidate.turnId, state);
        this.store.finishTurn(candidate, candidate.turnId, candidate.revision);
        return state;
      } catch {
        this.store.markTurnStatus(candidate.turnId, 'unknown');
        this.store.finishTurn(candidate, candidate.turnId, candidate.revision);
        return 'unknown';
      }
    });
  }

  async settleWithoutReply(runId: string, status: 'failed' | 'canceled'): Promise<'settled' | 'stale' | 'unknown'> {
    const turn = this.store.findTurnByRunId(runId);
    if (!turn) return 'unknown';
    return this.enqueue(turn, async () => {
      const binding = this.store.getBinding(turn.connectionId, turn.chatId, turn.agentId);
      if (!binding || binding.revision !== turn.revision || binding.activeTurnId !== turn.turnId) return 'stale';
      this.store.markTurnStatus(turn.turnId, status);
      this.store.finishTurn(turn, turn.turnId, turn.revision);
      return 'settled';
    });
  }

  private enqueue<T>(key: WhatsAppAgentBindingKey, work: () => Promise<T>): Promise<T> {
    const queueKey = keyOf(key);
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(queueKey, tail);
    void tail.then(() => {
      if (this.queues.get(queueKey) === tail) this.queues.delete(queueKey);
    });
    return result;
  }
}
