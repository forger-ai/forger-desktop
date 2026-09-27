import type { WhatsAppAgentBinding, WhatsAppParticipantAccess } from '../../../shared/types/whatsapp-agent-channel';

export const validateParticipantAccess = (
  value: unknown, chatId: string, participants: string[],
): WhatsAppParticipantAccess => {
  if (value === undefined) return participants.length ? 'selected' : 'owner';
  if (!['owner', 'selected', 'all'].includes(value as string) || (value === 'all' && !chatId.endsWith('@g.us')))
    throw new Error('whatsapp_agent_participant_access_invalid');
  if (value === 'selected' && !participants.length) throw new Error('whatsapp_agent_participants_required');
  return value as WhatsAppParticipantAccess;
};

export const participantCanInvoke = (
  binding: WhatsAppAgentBinding, isFromMe: boolean, authorId: string | null | undefined, identities: string[] = [],
): boolean => {
  if (isFromMe) return true;
  if (!authorId?.trim()) return false;
  const mode = binding.participantAccess ?? (binding.participantsAllowed.length ? 'selected' : 'owner');
  if (mode === 'all') return binding.chatId.endsWith('@g.us');
  return mode === 'selected' && [authorId, ...identities].some((id) => binding.participantsAllowed.includes(id));
};
