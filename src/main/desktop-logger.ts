import fs from 'node:fs/promises';
import path from 'node:path';

export type DesktopLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type DesktopLogService =
  | 'desktop-main'
  | 'desktop-renderer'
  | 'mcp'
  | 'installed-app'
  | 'official-tools'
  | 'tool:whatsapp'
  | 'agent-runtime'
  | 'backend-client';

export interface DesktopLogEntryInput {
  metadataRoot: string;
  level?: DesktopLogLevel;
  service: DesktopLogService;
  event: string;
  message?: string;
  context?: Record<string, unknown>;
  error?: unknown;
}

const MAX_FIELD_LENGTH = 120_000;
const REDACTED_VALUE = '[REDACTED]';
const AUTHORIZATION_HEADER_PATTERN = /\b((?:proxy-)?authorization)(\s*:\s*)[^\r\n]*/gi;
const BEARER_VALUE_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/=:-]+/gi;
const COOKIE_HEADER_PATTERN = /\b((?:set-)?cookie)(\s*:\s*)[^\r\n]*/gi;
const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

interface SensitiveAssignmentValue {
  contentStart: number;
  contentEnd: number;
  nextIndex: number;
}

const SENSITIVE_TERMINAL_KEY_TOKENS = new Set([
  'auth',
  'authorization',
]);
const SENSITIVE_KEY_TOKENS = new Set([
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'creds',
  'password',
  'passwd',
  'secret',
  'token',
]);
const SENSITIVE_COMPACT_KEYS = new Set([
  'accesstoken',
  'advsecretkey',
  'apikey',
  'clientsecret',
  'mcptoken',
  'noisekey',
  'privatekey',
  'refreshtoken',
  'signedidentitykey',
  'signedprekey',
]);
const SENSITIVE_KEY_QUALIFIERS = new Set(['api', 'noise', 'private', 'secret']);

const tokenizeLogKey = (key: string): string[] => key
  .trim()
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((token) => token.toLowerCase());

const hasTokenSuffix = (tokens: string[], suffix: string[]): boolean =>
  tokens.length >= suffix.length
  && suffix.every((token, index) => tokens[tokens.length - suffix.length + index] === token);

const isSensitiveLogKey = (key: string): boolean => {
  const tokens = tokenizeLogKey(key);
  if (tokens.length === 0) {
    return false;
  }
  const compactKey = tokens.join('');
  const terminalToken = tokens[tokens.length - 1];
  return SENSITIVE_COMPACT_KEYS.has(compactKey)
    || tokens.some((token) => SENSITIVE_KEY_TOKENS.has(token))
    || SENSITIVE_TERMINAL_KEY_TOKENS.has(terminalToken)
    || tokens.some((token, index) => token === 'key' && SENSITIVE_KEY_QUALIFIERS.has(tokens[index - 1] ?? ''))
    || hasTokenSuffix(tokens, ['signed', 'identity', 'key'])
    || hasTokenSuffix(tokens, ['signed', 'pre', 'key']);
};

const isQuote = (value: string): value is '"' | "'" => value === '"' || value === "'";
const isBareKeyCharacter = (value: string): boolean => /[A-Za-z0-9_-]/.test(value);
const isUnquotedValueBoundary = (value: string): boolean =>
  value === '[' || value === ']' || /[\s,;&{}]/.test(value);

const countPrecedingBackslashes = (value: string, index: number): number => {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    count += 1;
  }
  return count;
};

// JSON embedded inside one or more strings represents quote delimiters with
// 0, 1, 3, 7... backslashes. An escaped quote inside that value falls into
// the other half of the corresponding modulo, so it cannot end the value.
const resolveQuoteEncodingLevel = (value: string, quoteIndex: number): number | null => {
  const backslashCount = countPrecedingBackslashes(value, quoteIndex);
  if (backslashCount > 1_023 || (backslashCount & (backslashCount + 1)) !== 0) {
    return null;
  }
  return backslashCount;
};

const findClosingQuote = (
  value: string,
  quote: '"' | "'",
  startIndex: number,
  encodingLevel: number,
): number => {
  const delimiterModulo = 2 * (encodingLevel + 1);
  let cursor = value.indexOf(quote, startIndex);
  while (cursor >= 0) {
    if (countPrecedingBackslashes(value, cursor) % delimiterModulo === encodingLevel) {
      return cursor;
    }
    cursor = value.indexOf(quote, cursor + 1);
  }
  return -1;
};

const findAssignmentValue = (value: string, startIndex: number): SensitiveAssignmentValue | null => {
  let valueStart = startIndex;
  while (valueStart < value.length && /\s/.test(value[valueStart])) {
    valueStart += 1;
  }
  let quoteIndex = valueStart;
  while (value[quoteIndex] === '\\') {
    quoteIndex += 1;
  }
  const possibleQuote = value[quoteIndex];
  if (isQuote(possibleQuote)) {
    const encodingLevel = resolveQuoteEncodingLevel(value, quoteIndex);
    if (encodingLevel === null || quoteIndex - valueStart !== encodingLevel) {
      return { contentStart: valueStart, contentEnd: value.length, nextIndex: value.length };
    }
    const closingQuote = findClosingQuote(value, possibleQuote, quoteIndex + 1, encodingLevel);
    if (closingQuote < 0) {
      return {
        contentStart: quoteIndex + 1,
        contentEnd: value.length,
        nextIndex: value.length,
      };
    }
    return {
      contentStart: quoteIndex + 1,
      contentEnd: closingQuote - encodingLevel,
      nextIndex: closingQuote + 1,
    };
  }

  let valueEnd = valueStart;
  while (valueEnd < value.length && !isUnquotedValueBoundary(value[valueEnd])) {
    valueEnd += 1;
  }
  return valueEnd > valueStart
    ? { contentStart: valueStart, contentEnd: valueEnd, nextIndex: valueEnd }
    : null;
};

const findSeparatorEnd = (value: string, startIndex: number): number | null => {
  let cursor = startIndex;
  while (cursor < value.length && /\s/.test(value[cursor])) {
    cursor += 1;
  }
  if (value[cursor] !== ':' && value[cursor] !== '=') {
    return null;
  }
  return cursor + 1;
};

const findQuotedSensitiveAssignment = (
  value: string,
  quoteIndex: number,
): SensitiveAssignmentValue | null => {
  const quote = value[quoteIndex];
  if (!isQuote(quote)) {
    return null;
  }
  const encodingLevel = resolveQuoteEncodingLevel(value, quoteIndex);
  if (encodingLevel === null) {
    return null;
  }
  const keyClosingQuote = findClosingQuote(value, quote, quoteIndex + 1, encodingLevel);
  if (keyClosingQuote < 0 || keyClosingQuote - quoteIndex > 256) {
    return null;
  }
  const key = value.slice(quoteIndex + 1, keyClosingQuote - encodingLevel);
  if (!isSensitiveLogKey(key)) {
    return null;
  }
  const separatorEnd = findSeparatorEnd(value, keyClosingQuote + 1);
  return separatorEnd === null ? null : findAssignmentValue(value, separatorEnd);
};

const findBareSensitiveAssignment = (
  value: string,
  keyStart: number,
): SensitiveAssignmentValue | null => {
  if (!isBareKeyCharacter(value[keyStart]) || (keyStart > 0 && isBareKeyCharacter(value[keyStart - 1]))) {
    return null;
  }
  let keyEnd = keyStart + 1;
  while (keyEnd < value.length && isBareKeyCharacter(value[keyEnd])) {
    keyEnd += 1;
  }
  if (!isSensitiveLogKey(value.slice(keyStart, keyEnd))) {
    return null;
  }
  const separatorEnd = findSeparatorEnd(value, keyEnd);
  return separatorEnd === null ? null : findAssignmentValue(value, separatorEnd);
};

const redactSensitiveAssignments = (value: string): string => {
  const parts: string[] = [];
  let copiedThrough = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const assignment = isQuote(value[cursor])
      ? findQuotedSensitiveAssignment(value, cursor)
      : findBareSensitiveAssignment(value, cursor);
    if (!assignment) {
      cursor += 1;
      continue;
    }
    parts.push(value.slice(copiedThrough, assignment.contentStart), REDACTED_VALUE);
    copiedThrough = assignment.contentEnd;
    cursor = assignment.nextIndex;
  }
  if (parts.length === 0) {
    return value;
  }
  parts.push(value.slice(copiedThrough));
  return parts.join('');
};

const truncateSanitizedString = (value: string): string =>
  value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}...[truncated]` : value;

export const sanitizeDesktopLogString = (value: string): string => {
  let sanitized = value.replace(
    COOKIE_HEADER_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`,
  );
  sanitized = sanitized.replace(
    AUTHORIZATION_HEADER_PATTERN,
    (_match, key: string, separator: string) => `${key}${separator}${REDACTED_VALUE}`,
  );
  sanitized = sanitized.replace(
    URL_CREDENTIALS_PATTERN,
    (_match, scheme: string) => `${scheme}${REDACTED_VALUE}@`,
  );
  sanitized = sanitized.replace(BEARER_VALUE_PATTERN, (match) => `${match.slice(0, match.search(/\s/))} ${REDACTED_VALUE}`);
  sanitized = redactSensitiveAssignments(sanitized);
  return truncateSanitizedString(sanitized);
};

export const appendDesktopLog = async (input: DesktopLogEntryInput): Promise<void> => {
  const logPath = path.join(input.metadataRoot, 'logs', 'forger-desktop.jsonl');
  const entry = {
    timestamp: new Date().toISOString(),
    level: input.level ?? 'info',
    service: input.service,
    event: sanitizeDesktopLogString(input.event),
    ...(input.message ? { message: sanitizeDesktopLogString(input.message) } : {}),
    ...(input.context ? { context: sanitizeDesktopLogValue(input.context) } : {}),
    ...(input.error ? { error: serializeError(input.error) } : {}),
  };
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(logPath, 0o600).catch(() => undefined);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Failed to write Forger desktop log', error);
    }
  }
};

export const serializeError = (error: unknown): Record<string, unknown> => {
  return serializeErrorValue(error, new WeakSet<object>());
};

const serializeErrorValue = (error: unknown, seen: WeakSet<object>): Record<string, unknown> => {
  if (error instanceof Error) {
    if (seen.has(error)) {
      return { message: '[Circular error]' };
    }
    seen.add(error);
    return {
      name: sanitizeDesktopLogString(error.name),
      message: sanitizeDesktopLogString(error.message),
      ...(error.stack ? { stack: sanitizeDesktopLogString(error.stack) } : {}),
      ...(error.cause !== undefined ? { cause: sanitizeLogValue(error.cause, '', seen) } : {}),
    };
  }
  return { message: sanitizeDesktopLogString(String(error)) };
};

const sanitizeLogValue = (
  value: unknown,
  key = '',
  seen = new WeakSet<object>(),
): unknown => {
  if (isSensitiveLogKey(key)) {
    return REDACTED_VALUE;
  }
  if (typeof value === 'string') {
    return sanitizeDesktopLogString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    return value.map((item) => sanitizeLogValue(item, '', seen));
  }
  if (typeof value === 'object') {
    if (value instanceof Error) {
      return serializeErrorValue(value, seen);
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = sanitizeLogValue(entryValue, entryKey, seen);
    }
    return output;
  }
  return sanitizeDesktopLogString(String(value));
};

export const sanitizeDesktopLogValue = (value: unknown): unknown => sanitizeLogValue(value);
