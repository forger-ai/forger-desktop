import type { PersonalAgentWhatsAppChannelPolicy } from '@shared/types';

export const emptyPolicy = (): PersonalAgentWhatsAppChannelPolicy => ({ appIds: [], toolIds: [], connectionGrants: [], peerAgentIds: [], networkAccess: false, sharedMemoryIds: [], sharedFiles: [] });

export interface ObservedChat {
  chatId: string;
  title?: string;
  phoneNumber?: string;
  chatType: 'direct' | 'group' | 'channel';
}

export interface BindingDraft {
  connectionId: string;
  chatId: string;
  alias: string;
  purpose: string;
  scope: string;
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
      ...(typeof candidate.title === 'string' ? { title: candidate.title } : {}),
      ...(typeof candidate.phoneNumber === 'string' ? { phoneNumber: candidate.phoneNumber } : {}),
    }];
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
