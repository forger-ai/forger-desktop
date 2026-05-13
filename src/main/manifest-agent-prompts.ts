import path from 'node:path';
import type {
  AppAgent,
  AppAgentPromptTemplate,
  AppAgentPromptVariable,
} from '../shared/types';

export type ManifestAgentPromptKind = 'initial' | 'resume' | 'steer';

export interface RenderManifestAgentPromptInput {
  agent: AppAgent;
  kind: ManifestAgentPromptKind;
  variables?: Record<string, unknown>;
  appRoot: string;
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export const renderManifestAgentPrompt = ({
  agent,
  kind,
  variables = {},
  appRoot,
}: RenderManifestAgentPromptInput): string => {
  const template = resolvePromptTemplate(agent, kind);
  const declarations = template.variables ?? {};
  const placeholders = placeholdersFor(template.body);
  const declaredNames = new Set(Object.keys(declarations));
  for (const placeholder of placeholders) {
    if (!declaredNames.has(placeholder)) {
      throw new Error(`agent_prompt_placeholder_not_declared:${placeholder}`);
    }
  }
  for (const name of Object.keys(variables)) {
    if (!declaredNames.has(name)) {
      throw new Error(`agent_prompt_variable_not_declared:${name}`);
    }
  }
  for (const [name, declaration] of Object.entries(declarations)) {
    if (declaration.required === false) {
      continue;
    }
    if (!(name in variables)) {
      throw new Error(`agent_prompt_variable_required:${name}`);
    }
  }
  const renderedVariables = Object.fromEntries(
    Object.entries(declarations).map(([name, declaration]) => [
      name,
      renderVariable(name, variables[name], declaration, appRoot),
    ]),
  );
  return template.body.replace(PLACEHOLDER_PATTERN, (_match, name: string) => renderedVariables[name] ?? '').trim();
};

export const resolvePromptTemplate = (agent: AppAgent, kind: ManifestAgentPromptKind): AppAgentPromptTemplate => {
  const prompts = agent.prompts;
  const template = kind === 'steer' ? (prompts?.steer ?? prompts?.resume) : prompts?.[kind];
  if (!template?.body?.trim()) {
    throw new Error(`agent_prompt_template_missing:${agent.id}:${kind}`);
  }
  return template;
};

export const placeholdersFor = (body: string): Set<string> => {
  const output = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    output.add(match[1]);
  }
  return output;
};

const renderVariable = (
  name: string,
  value: unknown,
  declaration: AppAgentPromptVariable,
  appRoot: string,
): string => {
  if (value === undefined || value === null) {
    return '';
  }
  if (declaration.type === 'json') {
    return JSON.stringify(value, stableJsonReplacer, 2);
  }
  if (typeof value !== 'string') {
    throw new Error(`agent_prompt_variable_type:${name}`);
  }
  if (declaration.type === 'string') {
    if (value.includes('\n') || value.includes('\r')) {
      throw new Error(`agent_prompt_variable_multiline_string:${name}`);
    }
    return value;
  }
  if (declaration.type === 'text') {
    return value;
  }
  if (declaration.type === 'path') {
    return resolveSafePath(name, value, appRoot);
  }
  throw new Error(`agent_prompt_variable_type:${name}`);
};

const resolveSafePath = (name: string, value: string, appRoot: string): string => {
  const resolved = path.resolve(appRoot, value);
  const relative = path.relative(appRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`agent_prompt_variable_path_outside_app:${name}`);
};

const stableJsonReplacer = (_key: string, value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
};
