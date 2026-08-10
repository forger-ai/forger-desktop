const MAX_JSON_DEPTH = 30;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const MAX_APP_ACTION_SCHEMA_BYTES = 100_000;
export const MAX_APP_ACTION_INPUT_BYTES = 2_000_000;
export const MAX_APP_ACTION_CATALOG_BYTES = 2_000_000;

export const isSafeAppActionJson = (value: unknown, maxBytes: number): boolean => {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) return false;
  } catch {
    return false;
  }
  const visit = (current: unknown, depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH) return false;
    if (Array.isArray(current)) return current.every((entry) => visit(entry, depth + 1));
    if (current && typeof current === 'object') {
      return Object.entries(current as Record<string, unknown>).every(([key, entry]) =>
        !UNSAFE_OBJECT_KEYS.has(key) && visit(entry, depth + 1));
    }
    return true;
  };
  return visit(value, 0);
};
