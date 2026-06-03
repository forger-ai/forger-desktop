import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppAgent,
  AppPromptTemplate,
  AppToolDeclaration,
  AppToolsInstallGate,
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  InstalledOfficialToolRecord,
  OfficialToolDefinition,
  OfficialToolSummary,
  OfficialToolsState,
  SetAppToolGrantInput,
  ToolMutationResult,
} from '../shared/types';
import { SecretsStore } from './secrets-store';
import { INTERNAL_TOOL_MODULES } from './tools';
import type { InternalToolModule } from './tools/types';
import type { InternalOAuthTokenResponse } from './tools/types';
import { getSharedCopy } from '../shared/i18n';

interface ToolRegistryFile {
  version: 1;
  installed: Record<string, InstalledOfficialToolRecord>;
  appGrants: Record<string, Record<string, boolean>>;
}

interface OfficialToolsServiceOptions {
  metadataRoot: string;
  secretsStore: SecretsStore;
  getFreePort: () => Promise<number>;
  openExternalUrl: (url: string) => Promise<void>;
  isForgerAccountAuthenticated: () => boolean;
  getGmailOAuthClientId: () => Promise<string>;
  exchangeGmailOAuthCode: (input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<InternalOAuthTokenResponse>;
  refreshGmailOAuthAccessToken: (input: {
    clientId: string;
    refreshToken: string;
  }) => Promise<InternalOAuthTokenResponse>;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  getAppToolDeclarations: (appId: string) => Promise<{
    appName: string;
    required: AppToolDeclaration[];
    optional: AppToolDeclaration[];
    agents: AppAgent[];
    promptTemplates: AppPromptTemplate[];
  } | null>;
}

const emptyRegistry = (): ToolRegistryFile => ({
  version: 1,
  installed: {},
  appGrants: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeActionIds = (actions: unknown): string[] =>
  Array.isArray(actions)
    ? actions.filter((action): action is string => typeof action === 'string' && action.trim().length > 0)
    : [];

const buildToolUnavailableResult = (
  tool: OfficialToolSummary | null,
  surface: 'agent' | 'app',
): CallOfficialToolResult => {
  const copy = getSharedCopy().tools;
  if (!tool) {
    return { success: false, userMessage: copy.unavailable, technicalCode: 'tool_not_found' };
  }
  if (tool.status === 'available') {
    return {
      success: false,
      userMessage: surface === 'agent' ? copy.gmailUnavailableForAgent : copy.gmailUnavailableForApp,
      technicalCode: 'tool_not_active',
    };
  }
  if (tool.status === 'installed') {
    return {
      success: false,
      userMessage: surface === 'agent' ? copy.gmailNotConfiguredForAgent : copy.gmailNotConfiguredForApp,
      technicalCode: 'tool_not_configured',
    };
  }
  if (tool.status === 'error') {
    return {
      success: false,
      userMessage: copy.configurationError(tool.name, tool.error),
      technicalCode: 'tool_configuration_error',
    };
  }
  return { success: false, userMessage: copy.notReady, technicalCode: 'tool_not_configured' };
};

const appToolDeclarationsMissingMessage = 'La app no tiene acceso configurado a herramientas oficiales. La declaracion de herramientas debe incluir un motivo visible y las acciones necesarias.';
const appToolNotDeclaredMessage = 'La app no tiene acceso configurado a esta herramienta oficial. Revisa que la declaracion incluya toolId, reason y actions.';
const appToolActionNotDeclaredMessage = 'La app no tiene acceso configurado a esta accion oficial. Revisa que la declaracion incluya la accion necesaria.';

const localizeOfficialToolDefinition = (
  entry: OfficialToolDefinition,
  locale?: string,
): OfficialToolDefinition => {
  const localizedTools = getSharedCopy(locale).officialTools as Partial<Record<string, {
    name: string;
    description: string;
    secrets: Record<string, { label: string; usage: string }>;
    actions: Record<string, { name: string; description: string }>;
    changelog?: readonly string[];
  }>>;
  const localized = localizedTools[entry.id];
  if (!localized) return entry;
  return {
    ...entry,
    name: localized.name,
    description: localized.description,
    secrets: entry.secrets.map((secret) => {
      const copy = localized.secrets[secret.name];
      return copy ? { ...secret, label: copy.label, usage: copy.usage } : secret;
    }),
    actions: entry.actions.map((action) => {
      const copy = localized.actions[action.id];
      return copy ? { ...action, name: copy.name, description: copy.description } : action;
    }),
    changelog: localized.changelog ? [...localized.changelog] : entry.changelog,
  };
};

export const normalizeAppToolDeclarations = (
  value: unknown,
): { required: AppToolDeclaration[]; optional: AppToolDeclaration[] } => {
  if (!isRecord(value)) {
    return { required: [], optional: [] };
  }

  const normalize = (entries: unknown): AppToolDeclaration[] => {
    if (!Array.isArray(entries)) {
      return [];
    }
    const seen = new Set<string>();
    const declarations: AppToolDeclaration[] = [];
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      const toolId = typeof entry.toolId === 'string' ? entry.toolId.trim() : '';
      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
      const actions = normalizeActionIds(entry.actions);
      if (!toolId || !reason || actions.length === 0 || seen.has(toolId)) {
        continue;
      }
      seen.add(toolId);
      declarations.push({ toolId, reason, actions });
    }
    return declarations;
  };

  return {
    required: normalize(value.required),
    optional: normalize(value.optional),
  };
};

export class OfficialToolsService {
  private registry: ToolRegistryFile = emptyRegistry();
  private readonly modulesById = new Map<string, InternalToolModule>(
    INTERNAL_TOOL_MODULES.map((toolModule) => [toolModule.definition.id, toolModule]),
  );
  private loaded = false;

  constructor(private readonly options: OfficialToolsServiceOptions) {}

  private getContext(locale?: string) {
    return {
      metadataRoot: this.options.metadataRoot,
      secretsStore: this.options.secretsStore,
      locale,
      getFreePort: this.options.getFreePort,
      openExternalUrl: this.options.openExternalUrl,
      isForgerAccountAuthenticated: this.options.isForgerAccountAuthenticated,
      getGmailOAuthClientId: this.options.getGmailOAuthClientId,
      exchangeGmailOAuthCode: this.options.exchangeGmailOAuthCode,
      refreshGmailOAuthAccessToken: this.options.refreshGmailOAuthAccessToken,
      appendLog: this.options.appendLog,
    };
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.registry = await this.readRegistry();
    this.loaded = true;
  }

  async refresh(locale?: string): Promise<OfficialToolsState> {
    return this.list(locale);
  }

  async list(locale?: string): Promise<OfficialToolsState> {
    await this.load();
    return {
      tools: await Promise.all(INTERNAL_TOOL_MODULES.map((toolModule) => this.toSummary(toolModule.definition, locale))),
    };
  }

  async getTool(toolId: string, locale?: string): Promise<OfficialToolSummary | null> {
    await this.load();
    const toolModule = this.modulesById.get(toolId);
    return toolModule ? await this.toSummary(toolModule.definition, locale) : null;
  }

  async activate(toolId: string, locale?: string): Promise<ToolMutationResult> {
    const copy = getSharedCopy(locale);
    await this.load();
    const toolModule = this.modulesById.get(toolId);
    if (!toolModule) {
      return { success: false, userMessage: copy.tools.unavailable, technicalCode: 'tool_not_found' };
    }

    const now = new Date().toISOString();
    this.registry.installed[toolId] = {
      id: toolId,
      version: toolModule.definition.version,
      status: 'installed',
      configured: await this.isConfigured(toolModule.definition),
      installedAt: this.registry.installed[toolId]?.installedAt ?? now,
      updatedAt: now,
    };
    await this.saveRegistry();
    return { success: true, userMessage: copy.tools.activated, tool: await this.toSummary(toolModule.definition, locale) };
  }

  async configure(input: ConfigureOfficialToolInput): Promise<ToolMutationResult> {
    await this.load();
    const toolModule = this.modulesById.get(input.toolId);
    if (!toolModule) {
      return { success: false, userMessage: getSharedCopy(input.locale).tools.unavailable, technicalCode: 'tool_not_found' };
    }
    if (!this.registry.installed[input.toolId]) {
      const activation = await this.activate(input.toolId, input.locale);
      if (!activation.success) {
        return activation;
      }
    }

    const result = await toolModule.configure(this.getContext(input.locale));
    await this.recordError(input.toolId, result.success ? undefined : new Error(result.technicalCode ?? 'tool_configuration_failed'));
    return {
      ...result,
      tool: await this.toSummary(toolModule.definition, input.locale),
    };
  }

  async deactivate(toolId: string, options?: { keepSecrets?: boolean; locale?: string }): Promise<ToolMutationResult> {
    const copy = getSharedCopy(options?.locale);
    await this.load();
    const toolModule = this.modulesById.get(toolId);
    if (!toolModule) {
      return { success: false, userMessage: copy.tools.unavailable, technicalCode: 'tool_not_found' };
    }

    delete this.registry.installed[toolId];
    for (const grants of Object.values(this.registry.appGrants)) {
      delete grants[toolId];
    }
    if (!options?.keepSecrets) {
      await this.options.secretsStore.deleteToolSecrets(toolId).catch(() => undefined);
    }
    await this.saveRegistry();
    return { success: true, userMessage: copy.tools.deactivated, tool: await this.toSummary(toolModule.definition, options?.locale) };
  }

  async getInstallGate(appId: string, locale?: string): Promise<AppToolsInstallGate | null> {
    await this.load();
    const declarations = await this.options.getAppToolDeclarations(appId);
    if (!declarations) {
      return null;
    }
    const required = await Promise.all(declarations.required.map((declaration) => this.toRequirement(appId, declaration, true, locale)));
    const optional = await Promise.all(declarations.optional.map((declaration) => this.toRequirement(appId, declaration, false, locale)));
    return {
      appId,
      appName: declarations.appName,
      required,
      optional,
      agents: declarations.agents,
      promptTemplates: declarations.promptTemplates,
      canInstall: required.every((item) => item.available && item.configured),
    };
  }

  async setAppToolGrant(input: SetAppToolGrantInput, locale?: string): Promise<AppToolsInstallGate | null> {
    await this.load();
    this.registry.appGrants[input.appId] = {
      ...(this.registry.appGrants[input.appId] ?? {}),
      [input.toolId]: input.granted,
    };
    await this.saveRegistry();
    return this.getInstallGate(input.appId, locale);
  }

  async listToolsForApp(appId: string): Promise<OfficialToolSummary[]> {
    await this.load();
    const declarations = await this.options.getAppToolDeclarations(appId);
    if (!declarations) {
      return [];
    }
    const declaredIds = new Set([
      ...declarations.required.map((item) => item.toolId),
      ...declarations.optional.filter((item) => this.registry.appGrants[appId]?.[item.toolId] === true).map((item) => item.toolId),
    ]);
    const state = await this.list();
    return state.tools.filter((tool) => declaredIds.has(tool.id) && tool.status !== 'available');
  }

  async listAgentActionIdsForApp(appId: string): Promise<Set<string>> {
    await this.load();
    const declarations = await this.options.getAppToolDeclarations(appId);
    if (!declarations) {
      return new Set();
    }
    const allowedActions = new Set<string>();
    for (const declaration of declarations.required) {
      for (const action of declaration.actions) {
        allowedActions.add(action);
      }
    }
    for (const declaration of declarations.optional) {
      if (this.registry.appGrants[appId]?.[declaration.toolId] !== true) {
        continue;
      }
      for (const action of declaration.actions) {
        allowedActions.add(action);
      }
    }
    return allowedActions;
  }

  async callFromApp(appId: string, input: CallOfficialToolInput): Promise<CallOfficialToolResult> {
    await this.load();
    const declarations = await this.options.getAppToolDeclarations(appId);
    if (!declarations) {
      return { success: false, userMessage: appToolDeclarationsMissingMessage, technicalCode: 'app_tools_not_declared' };
    }
    const required = declarations.required.find((item) => item.toolId === input.toolId);
    const optional = declarations.optional.find((item) => item.toolId === input.toolId);
    if (!required && !optional) {
      return { success: false, userMessage: appToolNotDeclaredMessage, technicalCode: 'app_tool_not_declared' };
    }
    if (optional && this.registry.appGrants[appId]?.[input.toolId] !== true) {
      return { success: false, userMessage: 'La app no tiene permiso para usar esta herramienta.', technicalCode: 'app_tool_permission_denied' };
    }
    const declaration = required ?? optional;
    if (!declaration?.actions.includes(input.actionId)) {
      return { success: false, userMessage: appToolActionNotDeclaredMessage, technicalCode: 'app_tool_action_not_declared' };
    }
    const tool = await this.getTool(input.toolId);
    if (!tool || !this.canExecuteTool(tool, input)) {
      return buildToolUnavailableResult(tool, 'app');
    }
    return this.execute(input);
  }

  async callFromAgent(input: CallOfficialToolInput, options?: { appId?: string; requireAppGrant?: boolean }): Promise<CallOfficialToolResult> {
    await this.load();
    const validation = await this.validateAgentCall(input, options);
    if (validation) {
      return validation;
    }
    return this.execute(input);
  }

  async validateAgentCall(input: CallOfficialToolInput, options?: { appId?: string; requireAppGrant?: boolean }): Promise<CallOfficialToolResult | null> {
    await this.load();
    if (options?.requireAppGrant) {
      if (!options.appId) {
        return { success: false, userMessage: appToolDeclarationsMissingMessage, technicalCode: 'app_tools_not_declared' };
      }
      const declarations = await this.options.getAppToolDeclarations(options.appId);
      if (!declarations) {
        return { success: false, userMessage: appToolDeclarationsMissingMessage, technicalCode: 'app_tools_not_declared' };
      }
      const required = declarations.required.find((item) => item.toolId === input.toolId);
      const optional = declarations.optional.find((item) => item.toolId === input.toolId);
      if (!required && !optional) {
        return { success: false, userMessage: appToolNotDeclaredMessage, technicalCode: 'app_tool_not_declared' };
      }
      if (optional && this.registry.appGrants[options.appId]?.[input.toolId] !== true) {
        return { success: false, userMessage: 'La app no tiene permiso para usar esta herramienta.', technicalCode: 'app_tool_permission_denied' };
      }
      const declaration = required ?? optional;
      if (!declaration?.actions.includes(input.actionId)) {
        return { success: false, userMessage: appToolActionNotDeclaredMessage, technicalCode: 'app_tool_action_not_declared' };
      }
    }
    const tool = await this.getTool(input.toolId);
    if (!tool || !this.canExecuteTool(tool, input)) {
      return buildToolUnavailableResult(tool, 'agent');
    }
    return null;
  }

  private async execute(input: CallOfficialToolInput): Promise<CallOfficialToolResult> {
    const toolModule = this.modulesById.get(input.toolId);
    if (!toolModule) {
      return { success: false, userMessage: 'La herramienta no tiene executor disponible.', technicalCode: 'tool_executor_missing' };
    }
    return toolModule.execute(input, this.getContext());
  }

  private async toRequirement(appId: string, declaration: AppToolDeclaration, required: boolean, locale?: string) {
    const tool = await this.getTool(declaration.toolId, locale);
    const configured = Boolean(tool && this.isToolUsable(tool));
    return {
      declaration,
      required,
      tool: tool ?? undefined,
      granted: required || this.registry.appGrants[appId]?.[declaration.toolId] === true,
      available: Boolean(tool && tool.status !== 'available' && tool.status !== 'error'),
      configured,
    };
  }

  private isToolUsable(tool: OfficialToolSummary): boolean {
    return tool.status === 'configured';
  }

  private canExecuteTool(tool: OfficialToolSummary, input: CallOfficialToolInput): boolean {
    return this.isToolUsable(tool) || (input.actionId.endsWith('.connection.status') && tool.status !== 'available');
  }

  private async toSummary(entry: OfficialToolDefinition, locale?: string): Promise<OfficialToolSummary> {
    const localized = localizeOfficialToolDefinition(entry, locale);
    const installed = this.registry.installed[entry.id];
    const configured = await this.isConfigured(entry);
    if (!installed) {
      return { ...localized, status: 'available', configured: false };
    }
    return {
      ...localized,
      status: installed.error ? 'error' : configured ? 'configured' : 'installed',
      installedVersion: installed.version,
      configured,
      error: installed.error,
    };
  }

  private async isConfigured(entry: OfficialToolDefinition): Promise<boolean> {
    for (const secret of entry.secrets.filter((item) => item.required)) {
      if (!await this.options.secretsStore.hasToolSecret(entry.id, secret.name)) {
        return false;
      }
    }
    return true;
  }

  private async recordError(toolId: string, error: Error | undefined): Promise<void> {
    const existing = this.registry.installed[toolId];
    if (!existing) {
      return;
    }
    this.registry.installed[toolId] = {
      ...existing,
      status: error ? 'error' : existing.configured ? 'configured' : 'installed',
      error: error?.message,
      updatedAt: new Date().toISOString(),
    };
    await this.saveRegistry();
  }

  private getRegistryPath(): string {
    return path.join(this.options.metadataRoot, 'official-tools.json');
  }

  private async readRegistry(): Promise<ToolRegistryFile> {
    try {
      const raw = await fs.readFile(this.getRegistryPath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ToolRegistryFile>;
      return {
        version: 1,
        installed: isRecord(parsed.installed) ? parsed.installed as Record<string, InstalledOfficialToolRecord> : {},
        appGrants: isRecord(parsed.appGrants) ? parsed.appGrants as Record<string, Record<string, boolean>> : {},
      };
    } catch {
      return emptyRegistry();
    }
  }

  private async saveRegistry(): Promise<void> {
    const registryPath = this.getRegistryPath();
    const tempPath = `${registryPath}.tmp`;
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(this.registry, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, registryPath);
    await fs.chmod(registryPath, 0o600).catch(() => undefined);
  }
}
