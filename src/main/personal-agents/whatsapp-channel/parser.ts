export type ParsedAgentWakeMessage =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'task'; text: string }
  | { kind: 'correct'; requestId: string; text: string }
  | { kind: 'correct-own'; text: string };

export const normalizeAgentAliasKey = (alias: string): string =>
  alias.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

const parsePrefix = (text: string, alias: string): ParsedAgentWakeMessage | null => {
  const prefix = text.replace(/^@/u, '');
  if (!prefix.toLowerCase().startsWith(alias)) return null;
  const remainder = prefix.slice(alias.length);
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

const MENTION_START = /[\s([{«“‘"'¿¡,:;!?]/u;
const MENTION_END = /^(?:$|[\s,:;!?()[\]{}«»“”‘’"'…]|\.(?=$|[\s,:;!?()[\]{}«»“”‘’"']))/u;

/** Position is only for routing; normalized text never replaces an inline request. */
export const findAgentWakeMessage = (message: string, alias: string): { parsed: ParsedAgentWakeMessage; position: number } | null => {
  const normalizedAlias = normalizeAgentAliasKey(alias);
  if (!normalizedAlias) return null;
  const text = message.normalize('NFKC').trim();
  const prefix = parsePrefix(text, normalizedAlias);
  if (prefix) return { parsed: prefix, position: 0 };
  const searchable = text.toLowerCase();
  const mention = `@${normalizedAlias}`;
  for (let position = searchable.indexOf(mention); position !== -1; position = searchable.indexOf(mention, position + 1)) {
    if (position > 0 && !MENTION_START.test(searchable[position - 1])) continue;
    const end = position + mention.length;
    if (!MENTION_END.test(searchable.slice(end))) continue;
    // Punctuation inside a URL or email token is not an address to the agent.
    const precedingToken = searchable.slice(0, position).match(/\S*$/u)![0];
    if (/[./\\@]|^[a-z][a-z\d+.-]*:/iu.test(precedingToken)) continue;
    if (!/[\p{L}\p{N}]/u.test(searchable.slice(0, position) + searchable.slice(end))) continue;
    return { parsed: { kind: 'task', text: message.trim() }, position };
  }
  return null;
};

export const parseAgentWakeMessage = (message: string, alias: string): ParsedAgentWakeMessage | null =>
  findAgentWakeMessage(message, alias)?.parsed ?? null;
