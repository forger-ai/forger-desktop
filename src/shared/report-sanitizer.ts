export interface ReportSanitizerRoot {
  alias: string;
  path?: string | null;
}

export interface ReportSanitizerOptions {
  roots?: ReportSanitizerRoot[];
  homeDir?: string;
  maxStringLength?: number;
}

const DEFAULT_MAX_STRING_LENGTH = 80_000;
const REDACTED = '[REDACTED]';
const REDACTED_PATH = '[REDACTED_PATH]';
const SENSITIVE_KEY_PATTERN = /(?:secret|token|authorization|bearer|api[_-]?key|password|passwd|credential|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|mcp[_-]?token|cookie)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const TOKEN_ASSIGNMENT_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]*(?:TOKEN|Token|token|SECRET|Secret|secret|KEY|Key|key|PASSWORD|Password|password))=([^\s"'`]{8,})/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MAC_HOME_PATTERN = /\/Users\/[^/\s"'`]+(?!\/Forger(?:-dev)?(?:\/|$))/g;
const LINUX_HOME_PATTERN = /\/home\/[^/\s"'`]+(?!\/Forger(?:-dev)?(?:\/|$))/g;
const WINDOWS_HOME_PATTERN = /\b[A-Za-z]:\\Users\\[^\\\s"'`]+(?!\\Forger(?:-dev)?(?:\\|$))/g;

export const sanitizeReportPayload = <T>(value: T, options: ReportSanitizerOptions = {}): T =>
  sanitizeValue(value, normalizeOptions(options), []) as T;

const normalizeOptions = (options: ReportSanitizerOptions): Required<Pick<ReportSanitizerOptions, 'maxStringLength'>> & {
  roots: Array<{ alias: string; variants: string[] }>;
} => ({
  maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
  roots: (options.roots ?? [])
    .filter((root) => root.alias && root.path)
    .map((root) => ({
      alias: root.alias.endsWith('/') ? root.alias : `${root.alias}/`,
      variants: pathVariants(String(root.path)),
    }))
    .sort((left, right) => longestVariant(right) - longestVariant(left)),
});

const sanitizeValue = (value: unknown, options: ReturnType<typeof normalizeOptions>, keyPath: string[]): unknown => {
  const key = keyPath[keyPath.length - 1] ?? '';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeString(value, options, SENSITIVE_KEY_PATTERN.test(key));
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, options, [...keyPath, String(index)]));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = SENSITIVE_KEY_PATTERN.test(entryKey)
        ? redactSensitiveValue(entryValue)
        : sanitizeValue(entryValue, options, [...keyPath, entryKey]);
    }
    return output;
  }
  return String(value);
};

const sanitizeString = (value: string, options: ReturnType<typeof normalizeOptions>, sensitiveKey: boolean): string => {
  if (sensitiveKey) {
    return REDACTED;
  }
  let output = value;
  for (const root of options.roots) {
    for (const variant of root.variants) {
      output = replaceAllPath(output, variant, root.alias);
    }
  }
  output = output
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(TOKEN_ASSIGNMENT_PATTERN, `$1=${REDACTED}`)
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(MAC_HOME_PATTERN, REDACTED_PATH)
    .replace(LINUX_HOME_PATTERN, REDACTED_PATH)
    .replace(WINDOWS_HOME_PATTERN, REDACTED_PATH);
  if (output.length > options.maxStringLength) {
    return `${output.slice(-options.maxStringLength)}\n[TRUNCATED_FROM_START]`;
  }
  return output;
};

const redactSensitiveValue = (value: unknown): unknown => {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(() => REDACTED);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((key) => [key, REDACTED]));
  }
  return REDACTED;
};

const pathVariants = (rawPath: string): string[] => {
  const trimmed = rawPath.trim().replace(/[\\/]+$/, '');
  if (!trimmed) {
    return [];
  }
  const forward = trimmed.replace(/\\/g, '/');
  const backward = trimmed.replace(/\//g, '\\');
  return Array.from(new Set([trimmed, forward, backward]));
};

const longestVariant = (root: { variants: string[] }): number =>
  root.variants.reduce((max, variant) => Math.max(max, variant.length), 0);

const replaceAllPath = (value: string, target: string, alias: string): string => {
  if (!target) {
    return value;
  }
  return value.split(target).join(alias.replace(/\/$/, '')).replace(new RegExp(`${escapeRegExp(alias.replace(/\/$/, ''))}([/\\\\])`, 'g'), alias);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
