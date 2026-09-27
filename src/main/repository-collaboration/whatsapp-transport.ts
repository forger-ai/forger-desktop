import { decodeStableMessageRef } from '../connections/modules/whatsapp/normalizer';
import type { ConnectionsService } from '../connections-service';
import type {
  RepositoryCollaborationChat,
  RepositoryCollaborationChatParticipant,
} from '../../shared/types/repository-collaboration';
import type { RepositoryCollaborationTransport } from './types';
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const validParticipant = (value: unknown): value is string =>
  typeof value === 'string' && /^[^\s@]+@(s\.whatsapp\.net|lid)$/.test(value);
export class WhatsAppRepositoryTransport
  implements RepositoryCollaborationTransport
{
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly lastSends = new Map<string, number>();
  constructor(
    private readonly connections: Pick<ConnectionsService, 'call'>,
    private readonly clock = {
      now: () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)),
    },
  ) {}
  async listGroups(
    connectionId: string,
  ): Promise<RepositoryCollaborationChat[]> {
    const groups: RepositoryCollaborationChat[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.connections.call({
        type: 'whatsapp',
        connectionId,
        actionId: 'whatsapp.list_chats',
        input: { chatType: 'group', limit: 100, ...(cursor ? { cursor } : {}) },
      });
      if (!result.success) throw new Error('repository_whatsapp_unavailable');
      const data = record(result.data);
      for (const row of Array.isArray(data.chats) ? data.chats : []) {
        const chat = record(row);
        if (typeof chat.chatId === 'string' && chat.chatId.endsWith('@g.us'))
          groups.push({
            chatId: chat.chatId,
            title: typeof chat.title === 'string' ? chat.title : chat.chatId,
          });
      }
      if (typeof data.nextCursor !== 'string' || data.nextCursor === cursor)
        break;
      cursor = data.nextCursor;
    }
    return groups;
  }
  async listParticipants(
    connectionId: string,
    chatId: string,
  ): Promise<RepositoryCollaborationChatParticipant[]> {
    if (!chatId.endsWith('@g.us'))
      throw new Error('repository_whatsapp_group_required');
    const result = await this.connections.call({
      type: 'whatsapp',
      connectionId,
      actionId: 'whatsapp.get_chat_details',
      input: { chatId },
    });
    const data = record(result.data);
    const metadata = record(data.metadata);
    if (
      !result.success ||
      data.type !== 'group' ||
      metadata.id !== chatId ||
      !Array.isArray(metadata.participants)
    )
      throw new Error('repository_whatsapp_membership_unavailable');
    return metadata.participants.map((value) => {
      const person = record(value);
      if (!validParticipant(person.id))
        throw new Error('repository_whatsapp_identity_unverified');
      return {
        participantId: person.id,
        displayName: typeof person.name === 'string' ? person.name : person.id,
        ...(Array.isArray(data.selfIds) && data.selfIds.includes(person.id)
          ? { isSelf: true }
          : {}),
      };
    });
  }
  async sendMessage(input: {
    connectionId: string;
    chatId: string;
    text: string;
    replyToMessageId?: string;
    canSend?: () => Promise<boolean>;
  }): Promise<{
    messageId: string;
  }> {
    if (
      !input.chatId.endsWith('@g.us') ||
      !input.text.trim() ||
      input.text.length > 4000
    )
      throw new Error('repository_whatsapp_message_invalid');
    const pending = (this.tails.get(input.connectionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const wait = Math.max(
            0,
            1600 -
              (this.clock.now() -
                (this.lastSends.get(input.connectionId) ?? -Infinity)),
          );
          if (wait) await this.clock.sleep(wait);
          if (input.canSend && !(await input.canSend()))
            throw new Error('repository_whatsapp_send_cancelled');
          this.lastSends.set(input.connectionId, this.clock.now());
          const result = await this.connections.call({
            type: 'whatsapp',
            connectionId: input.connectionId,
            actionId: 'whatsapp.send_message',
            input: {
              chatId: input.chatId,
              text: input.text,
              ...(input.replyToMessageId
                ? { replyToMessageId: input.replyToMessageId }
                : {}),
            },
          });
          if (
            !result.success &&
            result.technicalCode === 'whatsapp_send_rate_limited' &&
            attempt < 2
          ) {
            await this.clock.sleep(1600 * (attempt + 1));
            continue;
          }
          const data = record(result.data);
          if (
            !result.success ||
            data.sent !== true ||
            typeof data.stableMessageRef !== 'string'
          )
            throw new Error('repository_whatsapp_send_failed');
          const ref = decodeStableMessageRef(data.stableMessageRef);
          if (!ref || ref.remoteJid !== input.chatId)
            throw new Error('repository_whatsapp_send_failed');
          return { messageId: ref.id };
        }
        throw new Error('repository_whatsapp_send_failed');
      });
    this.tails.set(input.connectionId, pending);
    return pending;
  }
}
