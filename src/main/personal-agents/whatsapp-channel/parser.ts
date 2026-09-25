export type ParsedAgentWakeMessage = { kind: 'on' | 'off' } | { kind: 'task'; text: string };

export const normalizeAgentAliasKey = (alias: string): string => alias.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export const parseAgentWakeMessage = (message: string, alias: string): ParsedAgentWakeMessage | null => {
  const normalizedAlias = normalizeAgentAliasKey(alias);
  if (!normalizedAlias) return null;
  const text = message.normalize('NFKC').trim();
  if (!text.toLowerCase().startsWith(normalizedAlias)) return null;
  const remainder = text.slice(normalizedAlias.length);
  if (!/^[\s:,]/u.test(remainder)) return null;
  const command = remainder.replace(/^[\s:,]+/u, '').trim();
  if (!command) return null;
  if (/^ON[.!]?$/iu.test(command)) return { kind: 'on' };
  if (/^OFF[.!]?$/iu.test(command)) return { kind: 'off' };
  return { kind: 'task', text: command };
};
