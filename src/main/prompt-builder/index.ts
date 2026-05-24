import fs from 'node:fs';
import path from 'node:path';

export type PromptVariables = Record<string, string | number | boolean | null | undefined>;

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export const promptTemplateRoots = (): string[] => {
  const roots = [
    process.env.FORGER_DESKTOP_PROMPTS_ROOT,
    path.resolve(process.cwd(), 'src/main/prompt-builder/prompts'),
    path.resolve(__dirname, 'prompts'),
  ].filter((entry): entry is string => Boolean(entry));

  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'prompt-builder', 'prompts'));
  }

  return roots;
};

export const resolvePromptTemplatePath = (relativePath: string): string => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`prompt_template_path_invalid:${relativePath}`);
  }
  for (const root of promptTemplateRoots()) {
    const candidate = path.join(root, normalized);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`prompt_template_not_found:${normalized}`);
};

export const loadPromptTemplate = (relativePath: string): string =>
  fs.readFileSync(resolvePromptTemplatePath(relativePath), 'utf8');

export const renderTemplate = (
  template: string,
  variables: PromptVariables,
  options: { trim?: boolean } = {},
): string => {
  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
    used.add(key);
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error(`prompt_template_variable_missing:${key}`);
    }
    const value = variables[key];
    return value === undefined || value === null ? '' : String(value);
  });

  const unresolved = [...rendered.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`prompt_template_unresolved:${[...new Set(unresolved)].sort().join(',')}`);
  }

  const unusedRequired = Object.keys(variables).filter((key) => key.startsWith('required:') && !used.has(key.slice('required:'.length)));
  if (unusedRequired.length > 0) {
    throw new Error(`prompt_template_required_unused:${unusedRequired.join(',')}`);
  }

  return options.trim === false ? rendered.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : rendered.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

export const renderPromptFile = (
  relativePath: string,
  variables: PromptVariables,
  options?: { trim?: boolean },
): string => renderTemplate(loadPromptTemplate(relativePath), variables, options);

export const optionalSection = (content: string | undefined | null, prefix = ''): string => {
  const trimmed = content?.trim();
  return trimmed ? `${prefix}${trimmed}` : '';
};

export const bulletList = (items: string[], fallback: string): string =>
  items.length > 0 ? items.join('\n') : fallback;
