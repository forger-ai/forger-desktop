import type fs from 'node:fs/promises';
import type path from 'node:path';

export interface DeveloperPathDeps {
  fs: typeof fs;
  path: typeof path;
}

export interface BuildEffectivePathInput {
  enabled: boolean;
  runtimePathEntries: string[];
  globalPathEntries: string[];
  appPathEntries?: string[];
  systemPath?: string;
  delimiter: string;
}

export const normalizeDeveloperPathEntries = (
  entries: unknown,
  pathModule: typeof path,
): string[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue;
    }
    const value = entry.trim();
    if (!value || value.startsWith('~') || value.includes('$') || !pathModule.isAbsolute(value)) {
      continue;
    }
    const resolved = pathModule.resolve(value);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      normalized.push(resolved);
    }
  }
  return normalized;
};

export const validateDeveloperPathEntries = async (
  entries: unknown,
  deps: DeveloperPathDeps,
): Promise<string[]> => {
  const normalized = normalizeDeveloperPathEntries(entries, deps.path);
  for (const entry of normalized) {
    try {
      const stat = await deps.fs.stat(entry);
      if (!stat.isDirectory()) {
        throw new Error('not_directory');
      }
    } catch {
      throw new Error(`developer_path_invalid:${entry}`);
    }
  }
  return normalized;
};

export const splitPathEntries = (value: string | undefined, delimiter: string): string[] => {
  if (!value) {
    return [];
  }
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
};

export const dedupePathEntries = (entries: string[]): string[] => {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    deduped.push(entry);
  }
  return deduped;
};

export const buildEffectiveDeveloperPathEntries = (input: BuildEffectivePathInput): string[] => dedupePathEntries([
  ...input.runtimePathEntries,
  ...(input.enabled ? input.globalPathEntries : []),
  ...(input.enabled ? input.appPathEntries ?? [] : []),
  ...splitPathEntries(input.systemPath, input.delimiter),
]);
