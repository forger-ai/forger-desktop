import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppAgent,
  AppPromptTemplate,
  AppToolDeclaration,
  AppToolGrantRequestPreview,
  AppToolGrantRequestResult,
  AppToolsInstallGate,
  CallOfficialToolInput,
  CallOfficialToolResult,
  ConfigureOfficialToolInput,
  GetAppToolsInstallGateOptions,
  InstalledOfficialToolRecord,
  OfficialToolDefinition,
  OfficialToolSummary,
  OfficialToolRuntimeEvent,
  OfficialToolsState,
  SetAppToolGrantInput,
  ToolMutationResult,
} from '../shared/types';
import { SecretsStore } from './secrets-store';
import { INTERNAL_TOOL_MODULES } from './tools';
import { getMcpToolInputSchema } from './forger-mcp/tool-metadata';
import type { AgentToolId } from '../shared/types';
import type { InternalToolModule } from './tools/types';
import type { InternalOAuthTokenResponse } from './tools/types';
import { getSharedCopy } from '../shared/i18n';
import type { PlatformCapabilities } from '../shared/platform-capabilities';

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
  emitEvent?: (event: OfficialToolRuntimeEvent) => void;
  getAppToolDeclarations: (appId: string) => Promise<{
    appName: string;
    required: AppToolDeclaration[];
    optional: AppToolDeclaration[];
    agents: AppAgent[];
    promptTemplates: AppPromptTemplate[];
    platformCapabilities: PlatformCapabilities;
  } | null>;
}

const emptyRegistry = (): ToolRegistryFile => ({
  version: 1,
  installed: {},
  appGrants: {},
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ALL_TOOL_ACTIONS_TOKEN = '*';

const normalizeActionIds = (actions: unknown): string[] => {
  if (!Array.isArray(actions)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const action of actions) {
    if (typeof action !== 'string') {
      continue;
    }
    const trimmed = action.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
};

const buildToolUnavailableResult = (
  tool: OfficialToolSummary | null,
  surface: 'agent' | 'app',
  locale?: string,
): CallOfficialToolResult => {
  const copy = getSharedCopy(locale).tools;
  if (!tool) {
    return { success: false, userMessage: copy.unavailable, technicalCode: 'tool_not_found' };
  }
  if (tool.status === 'available') {
    return {
      success: false,
      userMessage: surface === 'agent' ? copy.unavailableForAgent(tool.name) : copy.unavailableForApp(tool.name),
      technicalCode: 'tool_not_active',
    };
  }
  if (tool.status === 'installed') {
    return {
      success: false,
      userMessage: surface === 'agent' ? copy.notConfiguredForAgent(tool.name) : copy.notConfiguredForApp(tool.name),
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

/**
 * Actions expose the same input schema agents see over MCP so surfaces like
 * the workflow editor can render forms instead of raw JSON.
 */
const withActionSchemas = (entry: OfficialToolDefinition): OfficialToolDefinition => ({
  ...entry,
  actions: entry.actions.map((action) => ({
    ...action,
    inputSchema: action.inputSchema ?? getMcpToolInputSchema(action.id as AgentToolId),
  })),
});

const appToolDeclarationsMissingMessage = 'La app no tiene acceso configurado a herramientas oficiales. La declaracion de herramientas debe incluir un motivo visible y las acciones necesarias.';
const appToolNotDeclaredMessage = 'La app no tiene acceso configurado a esta herramienta oficial. Revisa que la declaracion incluya toolId, reason y actions.';
const appToolNotOptionalMessage = 'Esta herramienta no se puede activar como opcional porque la app no la declaro en tools.optional.';
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
      emitEvent: this.options.emitEvent,
    };
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.registry = await this.readRegistry();
    this.loaded = true;
  }

  async startActiveTools(locale?: string): Promise<void> {
    await this.load();
    await Promise.all(Object.keys(this.registry.installed).map(async (toolId) => {
      const toolModule = this.modulesById.get(toolId);
      if (!toolModule?.start) {
        return;
      }
      try {
        await toolModule.start(this.getContext(locale));
      } catch (error) {
        await this.options.appendLog?.('official_tools:start_failed', {
          toolId,
          message: error instanceof Error ? error.message : 'unknown_error',
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        });
      }
    }));
  }

  async stopActiveTools(locale?: string): Promise<void> {
    const context = this.getContext(locale);
    await Promise.all(INTERNAL_TOOL_MODULES.map(async (toolModule) => {
      if (!toolModule.stop) {
        return;
      }
      try {
        await toolModule.stop(context);
      } catch (error) {
        await this.options.appendLog?.('official_tools:stop_failed', {
          toolId: toolModule.definition.id,
          message: error instanceof Error ? error.message : 'unknown_error',
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        });
      }
    }));
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

    const result = await toolModule.configure(this.getContext(input.locale), input);
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
    await toolModule.deactivate?.(this.getContext(options?.locale));
    if (!options?.keepSecrets) {
      await this.options.secretsStore.deleteToolSecrets(toolId).catch(() => undefined);
    }
    await this.saveRegistry();
    return { success: true, userMessage: copy.tools.deactivated, tool: await this.toSummary(toolModule.definition, options?.locale) };
  }

  async getInstallGate(appId: string, locale?: string, options?: GetAppToolsInstallGateOptions): Promise<AppToolsInstallGate | null> {
    await this.load();
    const declarations = await this.options.getAppToolDeclarations(appId);
    if (!declarations) {
      return null;
    }
    const required = await Promise.all(declarations.required.map((declaration) => this.toRequirement(appId, declaration, true, locale, options)));
    const optional = await Promise.all(declarations.optional.map((declaration) => this.toRequirement(appId, declaration, false, locale, options)));
    return {
      appId,
      appName: declarations.appName,
      platformCapabilities: declarations.platformCapabilities,
      required,
      optional,
      agents: declarations.agents,
      promptTemplates: declarations.promptTemplates,
      canInstall: true,
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

  async previewOptionalAppToolGrant(
    input: Pick<SetAppToolGrantInput, 'appId' | 'toolId'>,
    locale?: string,
  ): Promise<AppToolGrantRequestPreview> {
    await this.load();
    const appId = input.appId.trim();
    const toolId = input.toolId.trim();
    const declarations = await this.options.getAppToolDeclarations(appId);
    if (!declarations) {
      return {
        success: false,
        appId,
        userMessage: appToolDeclarationsMissingMessage,
        technicalCode: 'app_tools_not_declared',
      };
    }
    const required = declarations.required.find((item) => item.toolId === toolId);
    const optional = declarations.optional.find((item) => item.toolId === toolId);
    if (required && !optional) {
      return {
        success: false,
        appId,
        appName: declarations.appName,
        declaration: required,
        userMessage: appToolNotOptionalMessage,
        technicalCode: 'app_tool_not_optional',
      };
    }
    if (!optional) {
      return {
        success: false,
        appId,
        appName: declarations.appName,
        userMessage: appToolNotDeclaredMessage,
        technicalCode: 'app_tool_not_declared',
      };
    }
    const tool = await this.getTool(toolId, locale);
    if (!tool) {
      return {
        success: false,
        appId,
        appName: declarations.appName,
        declaration: optional,
        userMessage: getSharedCopy(locale).tools.unavailable,
        technicalCode: 'tool_not_found',
      };
    }
    const warning = this.getGrantWarning(tool, locale);
    return {
      success: true,
      appId,
      appName: declarations.appName,
      declaration: optional,
      tool,
      alreadyGranted: this.registry.appGrants[appId]?.[toolId] === true,
      ...(warning ? { warning } : {}),
      userMessage: warning
        ? warning
        : this.getGrantCopy(locale).ready(tool.name, declarations.appName),
    };
  }

  async setOptionalAppToolGrant(input: SetAppToolGrantInput, locale?: string): Promise<AppToolGrantRequestResult> {
    const preview = await this.previewOptionalAppToolGrant(input, locale);
    if (!preview.success) {
      return preview;
    }
    const gate = await this.setAppToolGrant(input, locale);
    const copy = this.getGrantCopy(locale);
    return {
      ...preview,
      gate,
      userMessage: input.granted
        ? copy.granted(preview.tool?.name ?? input.toolId, preview.appName ?? input.appId)
        : copy.revoked(preview.tool?.name ?? input.toolId, preview.appName ?? input.appId),
    };
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
      const tool = await this.getTool(declaration.toolId);
      for (const action of this.resolveDeclarationActionIds(declaration, tool)) {
        allowedActions.add(action);
      }
    }
    for (const declaration of declarations.optional) {
      if (this.registry.appGrants[appId]?.[declaration.toolId] !== true) {
        continue;
      }
      const tool = await this.getTool(declaration.toolId);
      for (const action of this.resolveDeclarationActionIds(declaration, tool)) {
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
    const tool = await this.getTool(input.toolId);
    const declaration = required ?? optional;
    if (!declaration || !this.declarationAllowsAction(declaration, input.actionId, tool)) {
      return { success: false, userMessage: appToolActionNotDeclaredMessage, technicalCode: 'app_tool_action_not_declared' };
    }
    if (!tool || !this.canExecuteTool(tool, input)) {
      return buildToolUnavailableResult(tool, 'app');
    }
    return this.execute(input);
  }

  async callFromAgent(input: CallOfficialToolInput, options?: { appId?: string; requireAppGrant?: boolean; locale?: string }): Promise<CallOfficialToolResult> {
    await this.load();
    const validation = await this.validateAgentCall(input, options);
    if (validation) {
      return validation;
    }
    return this.execute(input, options?.locale);
  }

  async validateAgentCall(input: CallOfficialToolInput, options?: { appId?: string; requireAppGrant?: boolean; locale?: string }): Promise<CallOfficialToolResult | null> {
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
      const tool = await this.getTool(input.toolId, options?.locale);
      const declaration = required ?? optional;
      if (!declaration || !this.declarationAllowsAction(declaration, input.actionId, tool)) {
        return { success: false, userMessage: appToolActionNotDeclaredMessage, technicalCode: 'app_tool_action_not_declared' };
      }
    }
    const tool = await this.getTool(input.toolId, options?.locale);
    if (!tool || !this.canExecuteTool(tool, input)) {
      return buildToolUnavailableResult(tool, 'agent', options?.locale);
    }
    return null;
  }

  private async execute(input: CallOfficialToolInput, locale?: string): Promise<CallOfficialToolResult> {
    const toolModule = this.modulesById.get(input.toolId);
    if (!toolModule) {
      return { success: false, userMessage: getSharedCopy(locale).tools.chromeExtension.executorMissing, technicalCode: 'tool_executor_missing' };
    }
    return toolModule.execute(input, this.getContext(locale));
  }

  private async toRequirement(appId: string, declaration: AppToolDeclaration, required: boolean, locale?: string, options?: GetAppToolsInstallGateOptions) {
    const tool = await this.getTool(declaration.toolId, locale);
    const configured = Boolean(tool && this.isToolUsable(tool));
    const storedGrant = this.registry.appGrants[appId]?.[declaration.toolId];
    const hasStoredGrant = typeof storedGrant === 'boolean';
    return {
      declaration,
      required,
      tool: tool ?? undefined,
      resolvedActions: this.resolveDeclarationActions(declaration, tool),
      allActions: declaration.actions.includes(ALL_TOOL_ACTIONS_TOKEN),
      granted: required || (hasStoredGrant ? storedGrant : options?.defaultOptionalGrants === true),
      hasStoredGrant,
      available: Boolean(tool && tool.status !== 'available' && tool.status !== 'error'),
      configured,
    };
  }

  private resolveDeclarationActionIds(declaration: AppToolDeclaration, tool: OfficialToolSummary | null): string[] {
    if (declaration.actions.includes(ALL_TOOL_ACTIONS_TOKEN)) {
      return tool?.actions.map((action) => action.id) ?? [];
    }
    return declaration.actions;
  }

  private resolveDeclarationActions(declaration: AppToolDeclaration, tool: OfficialToolSummary | null) {
    const actionIds = this.resolveDeclarationActionIds(declaration, tool);
    if (!tool) {
      return [];
    }
    const allowed = new Set(actionIds);
    return tool.actions.filter((action) => allowed.has(action.id));
  }

  private declarationAllowsAction(declaration: AppToolDeclaration, actionId: string, tool: OfficialToolSummary | null): boolean {
    if (declaration.actions.includes(ALL_TOOL_ACTIONS_TOKEN)) {
      return Boolean(tool?.actions.some((action) => action.id === actionId));
    }
    return declaration.actions.includes(actionId);
  }

  private isToolUsable(tool: OfficialToolSummary): boolean {
    return tool.status === 'configured';
  }

  private canExecuteTool(tool: OfficialToolSummary, input: CallOfficialToolInput): boolean {
    return this.isToolUsable(tool) || (input.actionId.endsWith('.connection.status') && tool.status !== 'available');
  }

  private getGrantWarning(tool: OfficialToolSummary, locale?: string): string | undefined {
    const copy = this.getGrantCopy(locale);
    if (tool.status === 'available') {
      return copy.inactive(tool.name);
    }
    if (tool.status === 'installed') {
      return copy.unconfigured(tool.name);
    }
    if (tool.status === 'error') {
      return copy.error(tool.name, tool.error);
    }
    return undefined;
  }

  private getGrantCopy(locale?: string) {
    const isEnglish = locale?.toLowerCase().startsWith('en');
    return isEnglish
      ? {
        ready: (toolName: string, appName: string) => `${toolName} can be allowed for ${appName}.`,
        granted: (toolName: string, appName: string) => `${toolName} is allowed for ${appName}.`,
        revoked: (toolName: string, appName: string) => `${toolName} is no longer allowed for ${appName}.`,
        inactive: (toolName: string) => `${toolName} is not active yet. The grant can be saved, but the app cannot use it until the tool is activated and configured.`,
        unconfigured: (toolName: string) => `${toolName} is active but not configured yet. The grant can be saved, but the app cannot use it until configuration is complete.`,
        error: (toolName: string, detail?: string) => `${toolName} has a configuration error. The grant can be saved, but the app cannot use it until the error is fixed.${detail ? ` Detail: ${detail}` : ''}`,
      }
      : {
        ready: (toolName: string, appName: string) => `${toolName} se puede permitir para ${appName}.`,
        granted: (toolName: string, appName: string) => `${toolName} quedo permitido para ${appName}.`,
        revoked: (toolName: string, appName: string) => `${toolName} dejo de estar permitido para ${appName}.`,
        inactive: (toolName: string) => `${toolName} todavia no esta activa. El permiso se puede guardar, pero la app no podra usarla hasta activarla y configurarla.`,
        unconfigured: (toolName: string) => `${toolName} esta activa pero todavia no esta configurada. El permiso se puede guardar, pero la app no podra usarla hasta completar la configuracion.`,
        error: (toolName: string, detail?: string) => `${toolName} tiene un error de configuracion. El permiso se puede guardar, pero la app no podra usarla hasta corregirlo.${detail ? ` Detalle: ${detail}` : ''}`,
      };
  }

  private async toSummary(entry: OfficialToolDefinition, locale?: string): Promise<OfficialToolSummary> {
    const localized = withActionSchemas(localizeOfficialToolDefinition(entry, locale));
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
    const toolModule = this.modulesById.get(entry.id);
    if (toolModule?.isConfigured) {
      return toolModule.isConfigured(this.getContext());
    }
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
