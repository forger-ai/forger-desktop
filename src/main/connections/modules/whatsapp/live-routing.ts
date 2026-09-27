import type { WhatsAppIndexedMessage, WhatsAppLiveGroupMessage } from './types';

/** One trusted live-ingestion event chooses one operator before either can act. */
export async function dispatchLiveWhatsAppMessage(input: {
  connectionId: string;
  message: WhatsAppIndexedMessage;
  newlyStored: boolean;
  onRepositoryMessage?: (message: WhatsAppLiveGroupMessage) => Promise<boolean | void>;
  onAgentMessage?: (event: { connectionId: string; message: WhatsAppIndexedMessage; newlyStored: boolean }) => Promise<void> | void;
}): Promise<void> {
  const { message } = input;
  if (message.isGroup && message.senderId && message.text && message.timestamp) {
    const claimed = await input.onRepositoryMessage?.({
      chatId: message.chatId, messageId: message.stableMessageRef.id,
      senderId: message.senderId, senderName: message.senderDisplayName,
      text: message.text, timestamp: message.timestamp * 1000,
      live: true, identityVerified: true, fromMe: message.fromMe,
      automated: message.text.startsWith('🤖'),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    });
    if (claimed) return;
  }
  await input.onAgentMessage?.({ connectionId: input.connectionId, message, newlyStored: input.newlyStored });
}
