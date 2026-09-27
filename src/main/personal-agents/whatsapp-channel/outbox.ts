import type { WhatsAppAgentChannelStore } from './store';
import type { WhatsAppAgentChannelPorts } from './types';

/** Serializes outbound sends per connected account, independently of request execution. */
export class WhatsAppAgentOutbox {
  private readonly accountQueues = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly store: WhatsAppAgentChannelStore,
    private readonly ports: Pick<WhatsAppAgentChannelPorts, 'sendReply'>,
  ) {}

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(connectionId: string, delay: number): void {
    if (this.closed || this.timers.has(connectionId)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(connectionId);
        void this.flushAccount(connectionId).catch(() => this.schedule(connectionId, 1500));
      },
      Math.max(1, delay),
    );
    timer.unref?.();
    this.timers.set(connectionId, timer);
  }

  flushAccount(connectionId: string): Promise<void> {
    const previous = this.accountQueues.get(connectionId) ?? Promise.resolve();
    const result = previous.then(async () => {
      if (this.closed) return;
      const request = this.store
        .listActivity()
        .find(
          (r) =>
            r.connectionId === connectionId &&
            r.deliveryState === 'pending' &&
            this.store.getBinding(r.connectionId, r.chatId, r.agentId)?.enabled,
        );
      if (!request) return;
      const wait = Math.max(request.retryAt, this.store.nextSendAt(connectionId)) - Date.now();
      if (wait > 0) {
        this.schedule(connectionId, wait);
        return;
      }
      const binding = this.store.getBinding(request.connectionId, request.chatId, request.agentId);
      if (!binding?.enabled) return;
      if (!request.responseText) {
        this.store.updateRequest(request.requestId, { deliveryState: 'failed', reason: 'response_missing' });
        return;
      }
      // Mark unknown before crossing the transport boundary; a crash cannot create a resend.
      this.store.updateRequest(request.requestId, { deliveryState: 'unknown' });
      this.store.claimDelivery(request, request.requestId, request.revision);
      this.store.reserveSend(connectionId, Date.now() + 1500);
      try {
        const outcome = await this.ports.sendReply({
          binding,
          turnId: request.requestId,
          revision: request.revision,
          text: request.responseText,
        });
        if (this.closed) return;
        const state = outcome.sent
          ? 'sent'
          : outcome.definiteFailure
            ? outcome.retryable
              ? 'pending'
              : 'failed'
            : 'unknown';
        this.store.updateRequest(request.requestId, {
          deliveryState: state,
          reason: outcome.reason ?? null,
          retryAt: state === 'pending' ? Date.now() + 1500 : 0,
        });
        this.store.markDelivery(
          request,
          request.requestId,
          state === 'pending' ? 'failed' : state,
          outcome.stableMessageRef,
        );
        this.store.markTurnStatus(request.requestId, state === 'pending' ? 'failed' : state);
      } catch {
        if (this.closed) return;
        this.store.updateRequest(request.requestId, { deliveryState: 'unknown', reason: 'delivery_unconfirmed' });
        this.store.markTurnStatus(request.requestId, 'unknown');
      }
      this.schedule(connectionId, 1500);
    });
    this.accountQueues.set(connectionId, result);
    void result
      .finally(() => {
        if (this.accountQueues.get(connectionId) === result) this.accountQueues.delete(connectionId);
      })
      .catch(() => undefined);
    return result;
  }
}
