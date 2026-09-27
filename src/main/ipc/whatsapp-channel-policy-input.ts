import type { PersonalAgentWhatsAppChannelPolicy, SharedFileRef } from '../../shared/types';

const invalid = (): never => { throw new Error('whatsapp_agent_invalid_input'); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 256): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid();
  return value.trim();
};
const strings = (value: unknown, max = 128): string[] => {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return [...new Set(value.map((item) => text(item)))];
};

/** Only imported file references cross this bridge; host lookup verifies their identity. */
const sharedFile = (value: unknown): SharedFileRef => {
  if (!record(value)) return invalid();
  const id = text(value.id);
  const filePath = text(value.path, 1024);
  if (filePath.startsWith('/') || filePath.includes('\\') || filePath.includes(':') || filePath.split('/').some((part) => !part || part === '..' || part === '.')) return invalid();
  return {
    id, path: filePath,
    ...(value.name === undefined ? {} : { name: text(value.name) }),
    ...(value.relativePath === undefined ? {} : { relativePath: text(value.relativePath, 1024) }),
    ...(typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0 ? { sizeBytes: value.sizeBytes } : {}),
    ...(typeof value.modifiedAt === 'string' ? { modifiedAt: text(value.modifiedAt) } : {}),
    ...(value.source === 'attached' || value.source === 'mentioned' ? { source: value.source } : {}),
  };
};

export const validateWhatsAppChannelPolicy = (value: unknown): PersonalAgentWhatsAppChannelPolicy => {
  if (!record(value) || typeof value.networkAccess !== 'boolean' || !Array.isArray(value.connectionGrants) || value.connectionGrants.length > 64) return invalid();
  const connectionGrants = value.connectionGrants.map((grant: unknown) => {
    if (!record(grant) || typeof grant.multiple !== 'boolean') return invalid();
    return { type: text(grant.type), actions: strings(grant.actions), multiple: grant.multiple,
      ...(grant.connectionIds === undefined ? {} : { connectionIds: strings(grant.connectionIds) }) };
  });
  if (value.sharedFiles !== undefined && (!Array.isArray(value.sharedFiles) || value.sharedFiles.length > 64)) return invalid();
  return {
    appIds: strings(value.appIds),
    toolIds: strings(value.toolIds) as PersonalAgentWhatsAppChannelPolicy['toolIds'],
    connectionGrants,
    peerAgentIds: strings(value.peerAgentIds),
    networkAccess: value.networkAccess,
    sharedMemoryIds: strings(value.sharedMemoryIds),
    ...(value.sharedFiles === undefined ? {} : { sharedFiles: (value.sharedFiles as unknown[]).map(sharedFile) }),
  };
};
