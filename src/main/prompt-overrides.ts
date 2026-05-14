import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppAgent,
  AppPromptReviewInput,
  AppPromptReviewItem,
  AppPromptReviewKind,
  AppPromptSettingSource,
  AppPromptRestoreInput,
  AppPromptTemplate,
  AppPromptTemplateArgument,
  AppPromptValidationResult,
  AppAgentPromptSet,
  AppAgentPromptVariable,
  BasicActionResult,
  CodexReasoningEffort,
} from '../shared/types';

const PROMPT_OVERRIDES_VERSION = 1;
const MAX_PROMPT_LENGTH = 50_000;

interface StoredPromptOverride {
  kind: AppPromptReviewKind;
  id: string;
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  updatedAt: string;
}

interface PromptOverridesFile {
  version: number;
  apps: Record<string, Record<string, StoredPromptOverride>>;
}

interface PromptBase {
  kind: AppPromptReviewKind;
  id: string;
  agentId?: string;
  promptKind?: keyof AppAgentPromptSet;
  declaredVariables?: Record<string, AppAgentPromptVariable>;
  sourcePath?: string;
  title: string;
  description?: string;
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  defaultModel: string;
  defaultReasoningEffort: CodexReasoningEffort;
  arguments?: AppPromptTemplateArgument[];
}

interface PromptRuntimeDefaults {
  model: string;
  reasoningEffort: CodexReasoningEffort;
}

const REASONING_VALUES = new Set<CodexReasoningEffort>(['low', 'medium', 'high', 'xhigh']);

const emptyStore = (): PromptOverridesFile => ({
  version: PROMPT_OVERRIDES_VERSION,
  apps: {},
});

export class PromptOverridesStore {
  public constructor(private readonly storePath: string) {}

  public async list(appId: string, bases: PromptBase[]): Promise<AppPromptReviewItem[]> {
    const store = await this.readStore();
    const appOverrides = store.apps[appId] ?? {};
    return bases.map((base) => this.buildReviewItem(appId, base, appOverrides[promptKey(base.kind, base.id)]));
  }

  public async validate(appId: string, bases: PromptBase[], input: AppPromptReviewInput): Promise<AppPromptValidationResult> {
    const base = findPromptBase(appId, bases, input);
    return validatePromptEdit(base, input.prompt);
  }

  public async update(appId: string, bases: PromptBase[], input: AppPromptReviewInput): Promise<AppPromptReviewItem> {
    const base = findPromptBase(appId, bases, input);
    const normalizedPrompt = normalizePromptText(input.prompt);
    const validation = validatePromptEdit(base, normalizedPrompt);
    if (!validation.valid) {
      throw new PromptOverrideError('app_prompt_invalid', validation.errors.join(' '));
    }

    const store = await this.readStore();
    const appOverrides = store.apps[appId] ?? {};
    const key = promptKey(input.kind, input.id);
    const existing = appOverrides[key];
    const model = base.kind === 'agentPrompt'
      ? undefined
      : input.model === null
      ? undefined
      : typeof input.model === 'string' && input.model.trim()
        ? input.model.trim()
        : existing?.model;
    const reasoningEffort = base.kind === 'agentPrompt'
      ? undefined
      : input.reasoningEffort === null
      ? undefined
      : REASONING_VALUES.has(input.reasoningEffort as CodexReasoningEffort)
        ? input.reasoningEffort as CodexReasoningEffort
        : existing?.reasoningEffort;
    const override: StoredPromptOverride = {
      kind: input.kind,
      id: input.id,
      prompt: normalizedPrompt,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      updatedAt: new Date().toISOString(),
    };
    store.apps[appId] = {
      ...appOverrides,
      [key]: override,
    };
    await this.writeStore(store);

    const reloaded = await this.readStore();
    const saved = reloaded.apps[appId]?.[key];
    if (!saved || saved.prompt !== normalizedPrompt) {
      throw new PromptOverrideError('app_prompt_store_failed', 'No se pudo verificar el prompt guardado.');
    }

    return this.buildReviewItem(appId, base, saved);
  }

  public async restore(appId: string, bases: PromptBase[], input: AppPromptRestoreInput): Promise<AppPromptReviewItem> {
    const base = findPromptBase(appId, bases, input);
    const store = await this.readStore();
    const appOverrides = store.apps[appId] ?? {};
    const key = promptKey(input.kind, input.id);
    if (appOverrides[key]) {
      delete appOverrides[key];
      if (Object.keys(appOverrides).length > 0) {
        store.apps[appId] = appOverrides;
      } else {
        delete store.apps[appId];
      }
      await this.writeStore(store);
    }
    return this.buildReviewItem(appId, base, undefined);
  }

  public async applyToPromptTemplates(appId: string, templates: AppPromptTemplate[]): Promise<AppPromptTemplate[]> {
    const store = await this.readStore();
    const appOverrides = store.apps[appId] ?? {};
    return templates.map((template) => {
      const override = appOverrides[promptKey('promptTemplate', template.id)];
      if (!override) {
        return template;
      }
      const base = promptTemplateBase(template, {
        model: template.model ?? 'gpt-5.4',
        reasoningEffort: template.reasoningEffort ?? 'medium',
      });
      const validation = validatePromptEdit(base, override.prompt);
      return {
        ...template,
        ...(validation.valid ? { prompt: override.prompt } : {}),
        ...(override.model ? { model: override.model } : {}),
        ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
      };
    });
  }

  public async applyToAgents(appId: string, agents: AppAgent[]): Promise<AppAgent[]> {
    const store = await this.readStore();
    const appOverrides = store.apps[appId] ?? {};
    return agents.map((agent) => {
      if (hasAgentPromptSet(agent)) {
        const prompts = { ...agent.prompts };
        for (const key of ['initial', 'resume', 'steer'] as const) {
          const prompt = prompts[key];
          if (!prompt) {
            continue;
          }
          const override = appOverrides[promptKey('agentPrompt', agentPromptId(agent.id, key))];
          if (!override) {
            continue;
          }
          const base = agentPromptBase(agent, key, {
            model: agent.model ?? 'gpt-5.4',
            reasoningEffort: agent.reasoningEffort ?? 'medium',
          });
          const validation = validatePromptEdit(base, override.prompt);
          prompts[key] = {
            ...prompt,
            ...(validation.valid ? { body: override.prompt } : {}),
          };
        }
        return {
          ...agent,
          prompts,
        };
      }
      const override = appOverrides[promptKey('agent', agent.id)];
      if (!override) {
        return agent;
      }
      const base = agentBase(agent, {
        model: agent.model ?? 'gpt-5.4',
        reasoningEffort: agent.reasoningEffort ?? 'medium',
      });
      const validation = validatePromptEdit(base, override.prompt);
      return {
        ...agent,
        ...(validation.valid ? { initialPrompt: override.prompt } : {}),
        ...(override.model ? { model: override.model } : {}),
        ...(override.reasoningEffort ? { reasoningEffort: override.reasoningEffort } : {}),
      };
    });
  }

  private buildReviewItem(appId: string, base: PromptBase, override?: StoredPromptOverride): AppPromptReviewItem {
    const overrideValidation = override ? validatePromptEdit(base, override.prompt) : null;
    const validation = overrideValidation ?? validatePromptEdit(base, base.prompt);
    const overrideInvalid = Boolean(override && !validation.valid);
    const modelSource = settingSource(base.model, override?.model) as AppPromptSettingSource;
    const reasoningEffortSource = settingSource(base.reasoningEffort, override?.reasoningEffort) as AppPromptSettingSource;
    return {
      appId,
      kind: base.kind,
      id: base.id,
      ...(base.agentId ? { agentId: base.agentId } : {}),
      ...(base.promptKind ? { promptKind: base.promptKind } : {}),
      ...(base.declaredVariables ? { declaredVariables: Object.keys(base.declaredVariables).sort() } : {}),
      ...(base.sourcePath ? { sourcePath: base.sourcePath } : {}),
      title: base.title,
      ...(base.description ? { description: base.description } : {}),
      originalPrompt: base.prompt,
      prompt: override && validation.valid ? override.prompt : base.prompt,
      ...(base.model ? { originalModel: base.model } : {}),
      ...(base.reasoningEffort ? { originalReasoningEffort: base.reasoningEffort } : {}),
      model: override?.model ?? base.model ?? base.defaultModel,
      reasoningEffort: override?.reasoningEffort ?? base.reasoningEffort ?? base.defaultReasoningEffort,
      ...(override ? { overridePrompt: override.prompt, updatedAt: override.updatedAt } : {}),
      ...(override?.model ? { overrideModel: override.model } : {}),
      ...(override?.reasoningEffort ? { overrideReasoningEffort: override.reasoningEffort } : {}),
      modelSource,
      reasoningEffortSource,
      edited: Boolean(override),
      overrideInvalid,
      validation,
    };
  }

  private async readStore(): Promise<PromptOverridesFile> {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      return normalizeStore(JSON.parse(raw) as Partial<PromptOverridesFile>);
    } catch {
      return emptyStore();
    }
  }

  private async writeStore(store: PromptOverridesFile): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(normalizeStore(store), null, 2), 'utf8');
  }
}

export class PromptOverrideError extends Error {
  public constructor(public readonly code: string, public readonly userMessage: string) {
    super(code);
  }
}

export const promptTemplateBase = (template: AppPromptTemplate, defaults: PromptRuntimeDefaults): PromptBase => ({
  kind: 'promptTemplate',
  id: template.id,
  title: template.title,
  ...(template.description ? { description: template.description } : {}),
  prompt: template.prompt,
  ...(template.model ? { model: template.model } : {}),
  ...(template.reasoningEffort ? { reasoningEffort: template.reasoningEffort } : {}),
  defaultModel: defaults.model,
  defaultReasoningEffort: defaults.reasoningEffort,
  ...(template.arguments ? { arguments: template.arguments } : {}),
});

export const agentBase = (agent: AppAgent, defaults: PromptRuntimeDefaults): PromptBase => ({
  kind: 'agent',
  id: agent.id,
  title: agent.title,
  ...(agent.description ? { description: agent.description } : {}),
  prompt: agent.initialPrompt,
  ...(agent.model ? { model: agent.model } : {}),
  ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
  defaultModel: defaults.model,
  defaultReasoningEffort: defaults.reasoningEffort,
});

export const agentPromptBase = (
  agent: AppAgent,
  promptKind: keyof AppAgentPromptSet,
  defaults: PromptRuntimeDefaults,
): PromptBase => {
  const prompt = agent.prompts?.[promptKind];
  if (!prompt) {
    throw new PromptOverrideError('app_prompt_not_found', 'No encontramos ese prompt en la app instalada.');
  }
  return {
    kind: 'agentPrompt',
    id: agentPromptId(agent.id, promptKind),
    agentId: agent.id,
    promptKind,
    declaredVariables: prompt.variables,
    sourcePath: `agents[].prompts.${promptKind}.body`,
    title: `${agent.title} · ${promptKind}`,
    ...(agent.description ? { description: agent.description } : {}),
    prompt: prompt.body,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    defaultModel: defaults.model,
    defaultReasoningEffort: defaults.reasoningEffort,
  };
};

export const buildPromptBases = (
  templates: AppPromptTemplate[],
  agents: AppAgent[],
  defaults: PromptRuntimeDefaults,
): PromptBase[] => [
  ...templates.map((template) => promptTemplateBase(template, defaults)),
  ...agents.flatMap((agent) => hasAgentPromptSet(agent)
    ? (['initial', 'resume', 'steer'] as const)
      .filter((key) => Boolean(agent.prompts?.[key]))
      .map((key) => agentPromptBase(agent, key, defaults))
    : [agentBase(agent, defaults)]),
];

export const normalizePromptText = (prompt: string): string => prompt.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export const validatePromptEdit = (base: PromptBase, prompt: string): AppPromptValidationResult => {
  const normalizedPrompt = normalizePromptText(prompt);
  const errors: string[] = [];
  if (!normalizedPrompt.trim()) {
    errors.push('El prompt no puede estar vacio.');
  }
  if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
    errors.push(`El prompt no puede superar ${MAX_PROMPT_LENGTH.toLocaleString()} caracteres.`);
  }

  const originalVariables = extractPromptVariables(base.prompt);
  const editedVariables = extractPromptVariables(normalizedPrompt);
  const missingVariables = [...originalVariables].filter((variable) => !editedVariables.has(variable)).sort();
  const extraVariables = [...editedVariables].filter((variable) => !originalVariables.has(variable)).sort();
  if (missingVariables.length > 0) {
    errors.push(`Faltan variables del prompt original: ${missingVariables.join(', ')}.`);
  }
  if (extraVariables.length > 0) {
    errors.push(`El prompt agrega variables no declaradas: ${extraVariables.join(', ')}.`);
  }

  if (base.kind === 'agentPrompt' && base.declaredVariables) {
    const declaredVariables = new Set(Object.keys(base.declaredVariables));
    const undeclaredVariables = [...editedVariables].filter((variable) => !declaredVariables.has(variable)).sort();
    if (undeclaredVariables.length > 0) {
      errors.push(`El prompt usa variables no declaradas por el manifest: ${undeclaredVariables.join(', ')}.`);
    }
  }

  if (base.kind === 'promptTemplate') {
    const missingArguments = (base.arguments ?? [])
      .map((argument) => argument.name)
      .filter((name) => originalVariables.has(name) && !editedVariables.has(name))
      .sort();
    if (missingArguments.length > 0) {
      errors.push(`Faltan argumentos usados por la app: ${missingArguments.join(', ')}.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    missingVariables,
    extraVariables,
  };
};

export const promptOverrideErrorResult = (error: unknown): BasicActionResult => {
  if (error instanceof PromptOverrideError) {
    return {
      success: false,
      userMessage: error.userMessage,
      technicalCode: error.code,
    };
  }
  return {
    success: false,
    userMessage: 'No se pudo actualizar el prompt.',
    technicalCode: error instanceof Error ? error.message : 'app_prompt_error',
  };
};

const extractPromptVariables = (prompt: string): Set<string> => {
  const variables = new Set<string>();
  const pattern = /{{\s*([^{}]+?)\s*}}/g;
  for (const match of prompt.matchAll(pattern)) {
    const variable = match[1]?.trim();
    if (variable) {
      variables.add(variable);
    }
  }
  return variables;
};

const findPromptBase = (
  appId: string,
  bases: PromptBase[],
  input: { appId: string; kind: AppPromptReviewKind; id: string },
): PromptBase => {
  if (input.appId !== appId) {
    throw new PromptOverrideError('app_prompt_scope_mismatch', 'Ese prompt no pertenece a esta app.');
  }
  const base = bases.find((candidate) => candidate.kind === input.kind && candidate.id === input.id);
  if (!base) {
    throw new PromptOverrideError('app_prompt_not_found', 'No encontramos ese prompt en la app instalada.');
  }
  return base;
};

const promptKey = (kind: AppPromptReviewKind, id: string): string => `${kind}:${id}`;

const agentPromptId = (agentId: string, promptKind: keyof AppAgentPromptSet): string => `${agentId}:${promptKind}`;

const hasAgentPromptSet = (agent: AppAgent): boolean =>
  Boolean(agent.prompts && (agent.prompts.initial || agent.prompts.resume || agent.prompts.steer));

const normalizeStore = (input?: Partial<PromptOverridesFile>): PromptOverridesFile => {
  const store = emptyStore();
  if (!input?.apps || typeof input.apps !== 'object') {
    return store;
  }

  for (const [appId, entries] of Object.entries(input.apps)) {
    if (!appId || !entries || typeof entries !== 'object') {
      continue;
    }
    const normalizedEntries: Record<string, StoredPromptOverride> = {};
    for (const entry of Object.values(entries)) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const kind = entry.kind === 'promptTemplate' || entry.kind === 'agent' || entry.kind === 'agentPrompt' ? entry.kind : null;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      const prompt = typeof entry.prompt === 'string' ? normalizePromptText(entry.prompt) : '';
      const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined;
      const reasoningEffort = REASONING_VALUES.has(entry.reasoningEffort as CodexReasoningEffort)
        ? entry.reasoningEffort as CodexReasoningEffort
        : undefined;
      const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt.trim()
        ? entry.updatedAt
        : new Date().toISOString();
      if (!kind || !id || !prompt) {
        continue;
      }
      normalizedEntries[promptKey(kind, id)] = {
        kind,
        id,
        prompt,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        updatedAt,
      };
    }
    if (Object.keys(normalizedEntries).length > 0) {
      store.apps[appId] = normalizedEntries;
    }
  }

  return store;
};

const settingSource = (manifestValue: unknown, overrideValue: unknown): AppPromptSettingSource => {
  if (overrideValue) {
    return 'override';
  }
  if (manifestValue) {
    return 'manifest';
  }
  return 'global';
};
