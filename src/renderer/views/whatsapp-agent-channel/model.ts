import type { PersonalAgentWhatsAppChannelPolicy, WhatsAppAgentBinding } from '@shared/types';

export const emptyPolicy = (): PersonalAgentWhatsAppChannelPolicy => ({ appIds: [], toolIds: [], connectionGrants: [], peerAgentIds: [], networkAccess: false, sharedMemoryIds: [], sharedFiles: [] });

export interface ObservedChat {
  chatId: string;
  title?: string;
  contactName?: string;
  phoneNumber?: string;
  identityIds?: string[];
  chatType: 'direct' | 'group' | 'channel';
}

export const participantAccess = (binding: Pick<WhatsAppAgentBinding, 'participantsAllowed' | 'participantAccess'>): 'owner' | 'selected' | 'all' => binding.participantAccess ?? (binding.participantsAllowed.length ? 'selected' : 'owner');

export interface BindingDraft {
  connectionId: string;
  chatId: string;
  alias: string;
  purpose: string;
  scope: string;
  participantAccess: 'owner' | 'selected' | 'all';
  participantsAllowed: string[];
  enabled: boolean;
  policy: PersonalAgentWhatsAppChannelPolicy;
}

export const blankDraft = (agentName: string, connectionId = ''): BindingDraft => ({
  connectionId,
  chatId: '',
  alias: agentName,
  purpose: '',
  scope: '',
  participantAccess: 'owner',
  participantsAllowed: [],
  enabled: false,
  policy: emptyPolicy(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const observedChats = (data: unknown): ObservedChat[] => {
  if (!isRecord(data) || !Array.isArray(data.chats)) return [];
  return data.chats.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.chatId !== 'string') return [];
    if (candidate.chatType !== 'direct' && candidate.chatType !== 'group') return [];
    return [{
      chatId: candidate.chatId,
      chatType: candidate.chatType,
      ...(typeof candidate.contactName === 'string' ? { contactName: candidate.contactName } : {}),
      ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
      ...(typeof candidate.phoneNumber === 'string' ? { phoneNumber: candidate.phoneNumber } : {}),
      identityIds: [...new Set([candidate.chatId, ...(Array.isArray(candidate.identityIds) ? candidate.identityIds.filter((id): id is string => typeof id === 'string') : [])])],
    }];
  });
};

/** Presentation deduplication only; channel authorization uses the main process. */
export const uniqueChatChoices = (chats: ObservedChat[]): ObservedChat[] => {
  const seen = new Set<string>();
  return chats.filter((chat) => {
    const identities = chat.identityIds ?? [chat.chatId];
    if (identities.some((id) => seen.has(id))) return false;
    identities.forEach((id) => seen.add(id));
    return true;
  });
};

export const observedParticipants = (data: unknown): { id: string; name: string }[] => {
  if (!isRecord(data)) return [];
  if (data.type === 'direct' && isRecord(data.chat) && typeof data.chat.chatId === 'string') {
    return [{ id: data.chat.chatId, name: typeof data.chat.title === 'string' ? data.chat.title : data.chat.chatId }];
  }
  if (!isRecord(data.metadata) || !Array.isArray(data.metadata.participants)) return [];
  return data.metadata.participants.flatMap((candidate) =>
    isRecord(candidate) && typeof candidate.id === 'string' ? [{ id: candidate.id, name: typeof candidate.name === 'string' ? candidate.name : typeof candidate.notify === 'string' ? candidate.notify : candidate.id }] : []);
};

export const chatName = (chat: ObservedChat): string =>
  (chat.chatType === 'direct' ? chat.contactName?.trim() : '') || chat.title?.trim() || (chat.chatType === 'direct' ? chat.phoneNumber : '') || chat.chatId;

export const chatPhone = (chat: ObservedChat): string =>
  chat.chatType === 'direct' && chat.phoneNumber !== chatName(chat) ? chat.phoneNumber ?? '' : '';

export const chatLabel = (chat: ObservedChat): string =>
  [chatName(chat), chatPhone(chat)].filter(Boolean).join(' · ');
