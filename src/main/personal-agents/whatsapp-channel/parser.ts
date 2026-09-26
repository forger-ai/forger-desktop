export type ParsedAgentWakeMessage =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'task'; text: string }
  | { kind: 'correct'; requestId: string; text: string }
  | { kind: 'correct-own'; text: string };

export const normalizeAgentAliasKey = (alias: string): string =>
  alias.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

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
  const ownCorrection = /^CORREGIR\s+MI\s+[ÚU]LTIMA\s+([\s\S]+)$/iu.exec(command);
  if (ownCorrection) return { kind: 'correct-own', text: ownCorrection[1].trim() };
  const correction = /^CORREGIR\s+(\S+)\s+([\s\S]+)$/iu.exec(command);
  if (correction) return { kind: 'correct', requestId: correction[1], text: correction[2].trim() };
  return { kind: 'task', text: command };
};
