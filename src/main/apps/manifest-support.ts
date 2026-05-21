import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { App as ElectronApp, shell as electronShell } from 'electron';
import { AGENT_TOOL_DEFINITIONS } from '../core/agent-tool-packages';
import type { ForgerBackendClient } from '../forger-backend-client';
import type { CloudIdentityStore } from '../cloud-identity-store';
import type { BackupsManager } from '../backups-manager';
import type { MemoryStore } from '../memory-store';
import type { OfficialToolsService } from '../official-tools-service';
import { normalizeAppToolDeclarations } from '../official-tools-service';
import type { PromptOverridesStore } from '../prompt-overrides';
import { buildPromptBases, promptOverrideErrorResult } from '../prompt-overrides';
import { appSecretEnvName } from '../secrets-store';
import type { SecretsStore } from '../secrets-store';
import { buildForgerOfficialToolsPromptSection } from '../prompts/official-tools';
import type { ManifestAgentPromptKind } from '../manifest-agent-prompts';
import type {
  AgentDefaults,
  AgentProvider,
  AgentRuntime,
  AgentRuntimeRecommendations,
  AppAgent,
  AppAgentPromptSet,
  AppAgentPromptTemplate,
  AppAgentPromptVariable,
  AppAgentPromptVariableType,
  AppPromptMutationResult,
  AppPromptRestoreInput,
  AppPromptReviewInput,
  AppPromptReviewItem,
  AppPromptTemplate,
  AppPromptValidationResult,
  AppSecretConnection,
  AppSecretDeclaration,
  AppSecretsState,
  AppToolDeclaration,
  BasicActionResult,
  CatalogApp,
  ClaudeEffort,
  CodexReasoningEffort,
  CreateRemoteAppBackupInput,
  CreateRemoteAppBackupResult,
  Settings,
} from '../../shared/types';
import type { AppManifest, AppRegistry, RunningAppProcess } from '../core/main-process-types';

interface ManifestSupportState {
  secretsStore: SecretsStore | null;
  officialToolsService: OfficialToolsService | null;
  memoryStore: MemoryStore | null;
  backupsManager: BackupsManager | null;
}

interface ManifestSupportDeps {
  fs: typeof fs;
  path: typeof path;
  app: Pick<ElectronApp, 'getPath'>;
  shell: Pick<typeof electronShell, 'openExternal'>;
  state: ManifestSupportState;
  forgerBackendClient: ForgerBackendClient | null;
  forgerAccount: { authenticated?: boolean; token?: string | null };
  registry: AppRegistry;
  catalogApps: CatalogApp[];
  runningApps: Map<string, RunningAppProcess>;
  cloudSyncSettings: { appSync: Record<string, { autoSync?: boolean }> };
  settings: Settings;
  normalizeSettings: (input?: Partial<Settings>) => Settings;
  normalizeCodexReasoningEffort: (value: unknown, fallback: CodexReasoningEffort) => CodexReasoningEffort;
  normalizeClaudeEffort: (value: unknown, fallback: ClaudeEffort) => ClaudeEffort;
  getCodexDefaults: () => Settings['codexDefaults'];
  BUILT_IN_CODEX_REASONING: CodexReasoningEffort;
  BUILT_IN_CLAUDE_EFFORT: ClaudeEffort;
  CLAUDE_EFFORT_VALUES: Set<ClaudeEffort>;
  CODEX_REASONING_VALUES: Set<CodexReasoningEffort>;
  SecretsStore: typeof import('../secrets-store').SecretsStore;
  OfficialToolsService: typeof import('../official-tools-service').OfficialToolsService;
  MemoryStore: typeof import('../memory-store').MemoryStore;
  BackupsManager: typeof import('../backups-manager').BackupsManager;
  getForgerMetadataRoot: () => string;
  getBackupsRoot: () => string;
  getTempRoot: () => string;
  getFreePort: () => Promise<number>;
  getPromptOverridesStore: () => PromptOverridesStore;
  getCloudIdentityStore: () => CloudIdentityStore;
  hashFileSha256: (filePath: string) => Promise<string>;
  zipDirectory: (sourceDir: string, zipPath: string) => Promise<void>;
  validateArchiveEntries: (archivePath: string) => Promise<void>;
  extractArchive: (archivePath: string, destination: string) => Promise<void>;
  appendInstallLog: (event: string, payload?: Record<string, unknown>) => Promise<void>;
  canUseCloudDataSync: () => boolean;
  renderManifestAgentPrompt: (input: {
    agent: AppAgent;
    kind: ManifestAgentPromptKind;
    variables?: Record<string, unknown>;
    appRoot: string;
  }) => string;
  withAgentDefaults: <T extends {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    runtime?: AgentRuntime;
    runtimeRecommendations?: AgentRuntimeRecommendations;
  }>(input: T, defaults?: AgentDefaults) => T;
}

export const createManifestSupportController = (deps: ManifestSupportDeps) => {
  const {
    path,
    fs,
    app,
    shell,
    state,
    forgerBackendClient,
    forgerAccount,
    registry,
    catalogApps,
    runningApps,
    cloudSyncSettings,
    settings,
    normalizeSettings,
    normalizeCodexReasoningEffort,
    normalizeClaudeEffort,
    getCodexDefaults,
    BUILT_IN_CODEX_REASONING,
    BUILT_IN_CLAUDE_EFFORT,
    CLAUDE_EFFORT_VALUES,
    CODEX_REASONING_VALUES,
    SecretsStore,
    OfficialToolsService,
    MemoryStore,
    BackupsManager,
    getForgerMetadataRoot,
    getBackupsRoot,
    getTempRoot,
    getFreePort,
    getPromptOverridesStore,
    getCloudIdentityStore,
    hashFileSha256,
    zipDirectory,
    validateArchiveEntries,
    extractArchive,
    appendInstallLog,
    canUseCloudDataSync,
    renderManifestAgentPrompt,
    withAgentDefaults,
  } = deps;
const normalizeToken = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  return value.trim().toLowerCase();
};

const ensurePathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(relative));
};

const toPosixRelativePath = (value: string): string => value.replace(/\\/g, '/');

const resolveInstalledManifest = async (installDir: string): Promise<AppManifest | null> => {
  const manifestPath = path.join(installDir, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as AppManifest;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const manifestAllowsAgentNetworkAccess = (manifest: AppManifest | null): boolean =>
  manifest?.agentRuntime?.networkAccess === true;

const normalizeAgentProvider = (value: unknown): AgentProvider | undefined =>
  value === 'codex' || value === 'claude' ? value : undefined;

const appAllowsAgentNetworkAccess = async (appId: string): Promise<boolean> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return false;
  }
  return manifestAllowsAgentNetworkAccess(await resolveInstalledManifest(record.installDir));
};

const anyAppAllowsAgentNetworkAccess = async (appIds: string[]): Promise<boolean> => {
  for (const appId of appIds) {
    if (await appAllowsAgentNetworkAccess(appId)) {
      return true;
    }
  }
  return false;
};

const getSecretsStore = (): SecretsStore => {
  if (!state.secretsStore) {
    state.secretsStore = new SecretsStore(app.getPath('userData'));
  }
  return state.secretsStore;
};

const getOfficialToolsService = (): OfficialToolsService => {
  if (!state.officialToolsService) {
    state.officialToolsService = new OfficialToolsService({
      metadataRoot: getForgerMetadataRoot(),
      secretsStore: getSecretsStore(),
      getFreePort,
      openExternalUrl: async (url) => {
        await shell.openExternal(url);
      },
      isForgerAccountAuthenticated: () => Boolean(forgerAccount.token),
      getGmailOAuthClientId: async () => {
        if (!forgerAccount.token || !forgerBackendClient) {
          throw new Error('forger_account_required');
        }
        return await forgerBackendClient.getGmailOAuthClientId();
      },
      exchangeGmailOAuthCode: async (input) => {
        if (!forgerAccount.token || !forgerBackendClient) {
          throw new Error('forger_account_required');
        }
        return await forgerBackendClient.exchangeGmailOAuthCode(input);
      },
      refreshGmailOAuthAccessToken: async (input) => {
        if (!forgerAccount.token || !forgerBackendClient) {
          throw new Error('forger_account_required');
        }
        return await forgerBackendClient.refreshGmailOAuthAccessToken(input);
      },
      appendLog: appendInstallLog,
      getAppToolDeclarations: resolveAppToolDeclarations,
    });
  }
  return state.officialToolsService;
};

const getMemoryStore = (): MemoryStore => {
  if (!state.memoryStore) {
    state.memoryStore = new MemoryStore(getForgerMetadataRoot());
  }
  return state.memoryStore;
};

const buildMemoryContextForApps = async (appIds: string[]): Promise<string> => {
  return await getMemoryStore().buildContext({ caller: 'automation', appIds });
};

const buildMemoryContextForApp = async (appId: string): Promise<string> => {
  return await getMemoryStore().buildContext({ caller: 'app-agent', appId, appIds: [appId] });
};

const buildForgerToolsContextForApp = async (appId: string): Promise<string> => {
  const state = await getOfficialToolsService().list().catch(() => null);
  const gmail = state?.tools.find((tool) => tool.id === 'gmail');
  const gmailReady = gmail?.status === 'configured';
  const allowedActions = await getOfficialToolsService().listAgentActionIdsForApp(appId).catch(() => new Set<string>());
  return buildForgerOfficialToolsPromptSection({
    mode: 'app-agent',
    gmailReady,
    allowedActions: [...allowedActions],
  });
};

const buildForgerToolsContextForFreeChat = async (): Promise<string> => {
  const state = await getOfficialToolsService().list().catch(() => null);
  const gmail = state?.tools.find((tool) => tool.id === 'gmail');
  const gmailReady = gmail?.status === 'configured';
  const gmailActions = AGENT_TOOL_DEFINITIONS
    .map((tool) => tool.id)
    .filter((toolId) => toolId.startsWith('gmail.'));
  return buildForgerOfficialToolsPromptSection({
    mode: 'free-chat',
    gmailReady,
    allowedActions: gmailActions,
  });
};

const getBackupsManager = (): BackupsManager => {
  if (!state.backupsManager) {
    state.backupsManager = new BackupsManager({
      backupsRoot: getBackupsRoot(),
      listInstalledApps: () => Object.values(registry.apps).map((record) => ({
        appId: record.appId,
        name: record.name,
        version: record.version,
        installDir: record.installDir,
      })),
      getInstalledApp: (appId) => {
        const record = registry.apps[appId];
        return record
          ? {
              appId: record.appId,
              name: record.name,
              version: record.version,
              installDir: record.installDir,
            }
          : undefined;
      },
      isAppRunning: (appId) => runningApps.has(appId),
      log: appendInstallLog,
    });
  }
  return state.backupsManager;
};

const createRemoteAppBackup = async (
  input: CreateRemoteAppBackupInput,
): Promise<CreateRemoteAppBackupResult> => {
  if (!forgerBackendClient) {
    return { success: false, userMessage: 'No pudimos conectar con Forger Cloud.', technicalCode: 'backend_client_missing' };
  }
  if (!forgerAccount.authenticated || !forgerAccount.token) {
    return { success: false, userMessage: 'Inicia sesion en Forger Cloud para usar esta funcionalidad.', technicalCode: 'cloud_account_required' };
  }
  if (!canUseCloudDataSync()) {
    return { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.', technicalCode: 'subscription_required' };
  }

  const localBackup = await getBackupsManager().createBackup({ appId: input.appId, reason: 'manual' });
  if (!localBackup.success || !localBackup.backup) {
    return localBackup;
  }
  const backupDir = getBackupsManager().backupDirectory(localBackup.backup.appId, localBackup.backup.backupId);
  if (!backupDir) {
    return { success: false, userMessage: 'No pudimos preparar el respaldo para subir.', technicalCode: 'local_backup_missing' };
  }

  const archivePath = path.join(getTempRoot(), 'cloud-backups', `${localBackup.backup.appId}-${localBackup.backup.backupId}.zip`);
  await fs.rm(archivePath, { force: true }).catch(() => undefined);
  await zipDirectory(backupDir, archivePath);
  const archiveChecksum = await hashFileSha256(archivePath);
  const backupSignature = await getCloudIdentityStore().signText(JSON.stringify({
    appId: localBackup.backup.appId,
    backupId: localBackup.backup.backupId,
    checksumSha256: archiveChecksum,
  })).catch(() => null);

  try {
    return await forgerBackendClient.createRemoteBackup({
      archivePath,
      localBackup: localBackup.backup,
      backupType: input.backupType,
      source: input.source ?? 'manual',
      signature: backupSignature?.signature,
      signatureKeyFingerprint: backupSignature?.keyFingerprint,
      signatureAlgorithm: backupSignature?.algorithm,
    });
  } finally {
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
  }
};

const restoreRemoteAppBackup = async (remoteBackupId: number): Promise<BasicActionResult> => {
  if (!forgerBackendClient) {
    return { success: false, userMessage: 'No pudimos conectar con Forger Cloud.', technicalCode: 'backend_client_missing' };
  }
  if (!canUseCloudDataSync()) {
    return { success: false, userMessage: 'Forger Cloud Sync requiere una cuenta demo o pro.', technicalCode: 'subscription_required' };
  }

  const remoteBackup = (await forgerBackendClient.listRemoteBackups()).backups.find((backup) => backup.id === remoteBackupId);
  if (!remoteBackup) {
    return { success: false, userMessage: 'No encontramos ese respaldo cloud.', technicalCode: 'remote_backup_not_found' };
  }

  const downloadPath = path.join(getTempRoot(), 'cloud-backups', `${remoteBackup.id}.zip`);
  const extractDir = path.join(getTempRoot(), 'cloud-backups', `${remoteBackup.id}-extracted-${Date.now()}`);
  await fs.rm(downloadPath, { force: true }).catch(() => undefined);
  await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);

  try {
    const download = await forgerBackendClient.downloadRemoteBackup(remoteBackup.id, downloadPath);
    const actualChecksum = await hashFileSha256(downloadPath);
    const expectedChecksum = download.checksumSha256 || remoteBackup.checksumSha256;
    if (expectedChecksum && actualChecksum !== expectedChecksum) {
      throw new Error('remote_backup_checksum_mismatch');
    }
    await validateArchiveEntries(downloadPath);
    await extractArchive(downloadPath, extractDir);
    return await getBackupsManager().restoreBackupDirectory({ appId: remoteBackup.appId, backupDir: extractDir });
  } finally {
    await fs.rm(downloadPath, { force: true }).catch(() => undefined);
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
};

const syncAppToCloudIfEnabled = async (appId: string): Promise<void> => {
  if (!cloudSyncSettings.appSync[appId]?.autoSync || !canUseCloudDataSync()) {
    return;
  }
  const result = await createRemoteAppBackup({ appId, backupType: 'sync_snapshot', source: 'auto_sync' });
  await appendInstallLog(result.success ? 'cloud_sync:auto_success' : 'cloud_sync:auto_failed', {
    appId,
    technicalCode: result.technicalCode,
  });
};

const RESERVED_APP_SECRET_ENV_NAMES = new Set([
  'APPDATA',
  'CORS_ORIGINS',
  'DATABASE_URL',
  'ELECTRON_RUN_AS_NODE',
  'HOME',
  'NODE_ENV',
  'PATH',
  'PORT',
  'PYTHONHOME',
  'PYTHONPATH',
  'SHELL',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'VITE_API_BASE_URL',
]);

const isReservedAppSecretEnvName = (envName: string): boolean =>
  RESERVED_APP_SECRET_ENV_NAMES.has(envName) || envName.startsWith('NPM_');

const normalizeAppSecretDeclaration = (value: unknown): AppSecretDeclaration | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<AppSecretDeclaration>;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const usage = typeof candidate.usage === 'string' ? candidate.usage.trim() : '';
  const envName = appSecretEnvName(name);
  if (!name || !usage || !envName || isReservedAppSecretEnvName(envName)) {
    return null;
  }

  const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : undefined;
  return {
    name,
    required: candidate.required === true,
    usage,
    ...(label ? { label } : {}),
  };
};

const normalizeManifestAppSecrets = (manifest: AppManifest | null): AppSecretDeclaration[] => {
  if (!manifest || !Array.isArray(manifest.appSecrets)) {
    return [];
  }

  const seenNames = new Set<string>();
  const seenEnvNames = new Set<string>();
  const declarations: AppSecretDeclaration[] = [];
  for (const entry of manifest.appSecrets) {
    const declaration = normalizeAppSecretDeclaration(entry);
    if (!declaration) {
      continue;
    }
    const envName = appSecretEnvName(declaration.name);
    if (seenNames.has(declaration.name) || seenEnvNames.has(envName)) {
      continue;
    }
    seenNames.add(declaration.name);
    seenEnvNames.add(envName);
    declarations.push(declaration);
  }

  return declarations;
};

const resolveAppToolDeclarations = async (
  appId: string,
): Promise<{
  appName: string;
  required: AppToolDeclaration[];
  optional: AppToolDeclaration[];
  agents: AppAgent[];
  promptTemplates: AppPromptTemplate[];
} | null> => {
  const record = registry.apps[appId];
  if (record?.installDir) {
    const manifest = await resolveInstalledManifest(record.installDir);
    const declarations = normalizeAppToolDeclarations(manifest?.tools);
    return {
      appName: record.name ?? appId,
      agents: normalizeManifestAgents(manifest),
      promptTemplates: normalizeManifestPromptTemplates(manifest),
      ...declarations,
    };
  }

  const catalog = catalogApps.find((entry) => entry.id === appId);
  if (!catalog) {
    return null;
  }
  const declarations = normalizeAppToolDeclarations(catalog.tools);
  return {
    appName: catalog.name ?? appId,
    agents: catalog.agents ?? [],
    promptTemplates: catalog.promptTemplates ?? [],
    ...declarations,
  };
};

const normalizeManifestPromptTemplates = (manifest: AppManifest | null): AppPromptTemplate[] => {
  if (!manifest || !Array.isArray(manifest.promptTemplates)) {
    return [];
  }

  const seenIds = new Set<string>();
  const templates: AppPromptTemplate[] = [];
  for (const entry of manifest.promptTemplates) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Partial<AppPromptTemplate>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : '';
    if (!id || !title || !prompt || seenIds.has(id)) {
      continue;
    }
    const description =
      typeof candidate.description === 'string' && candidate.description.trim()
        ? candidate.description.trim()
        : undefined;
    const acceptedFileTypes = Array.isArray(candidate.acceptedFileTypes)
      ? candidate.acceptedFileTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : undefined;
    const reasoningEffort = normalizeManifestReasoningEffort(candidate.reasoningEffort);
    const runtime = normalizeManifestRuntime((candidate as Record<string, unknown>).runtime);
    const runtimeRecommendations = normalizeManifestRuntimeRecommendations(
      (candidate as Record<string, unknown>).runtimeRecommendations,
      { model, reasoningEffort },
    );
    const args = normalizePromptTemplateArguments(candidate.arguments);
    seenIds.add(id);
    templates.push({
      id,
      title,
      prompt,
      ...(description ? { description } : {}),
      ...(args.length > 0 ? { arguments: args } : {}),
      ...(acceptedFileTypes && acceptedFileTypes.length > 0 ? { acceptedFileTypes } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(runtime ? { runtime } : {}),
      ...(runtimeRecommendations ? { runtimeRecommendations } : {}),
    });
  }
  return templates;
};

const normalizeManifestAgents = (manifest: AppManifest | null): AppAgent[] => {
  const agents: AppAgent[] = [];
  const seenIds = new Set<string>();
  if (manifest && Array.isArray(manifest.agents)) {
    for (const entry of manifest.agents) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const candidate = entry as Partial<AppAgent>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      const prompts = normalizeManifestAgentPrompts((candidate as Record<string, unknown>).prompts);
      const initialPrompt =
        typeof candidate.initialPrompt === 'string' && candidate.initialPrompt.trim()
          ? candidate.initialPrompt.trim()
          : prompts?.initial?.body ?? '';
      if (!id || !title || (!initialPrompt && !prompts?.initial) || seenIds.has(id)) {
        continue;
      }
      const description =
        typeof candidate.description === 'string' && candidate.description.trim()
          ? candidate.description.trim()
          : undefined;
      const model = typeof candidate.model === 'string' && candidate.model.trim() ? candidate.model.trim() : undefined;
      const reasoningEffort = normalizeManifestReasoningEffort(candidate.reasoningEffort);
      const runtime = normalizeManifestRuntime((candidate as Record<string, unknown>).runtime);
      const runtimeRecommendations = normalizeManifestRuntimeRecommendations(
        (candidate as Record<string, unknown>).runtimeRecommendations,
        { model, reasoningEffort },
      );
      const kind = normalizeManifestAgentKind((candidate as Record<string, unknown>).kind);
      const initialPromptTemplate =
        typeof (candidate as Record<string, unknown>).initialPromptTemplate === 'string'
        && ((candidate as Record<string, unknown>).initialPromptTemplate as string).trim()
          ? ((candidate as Record<string, unknown>).initialPromptTemplate as string).trim()
          : undefined;
      seenIds.add(id);
      agents.push({
        id,
        title,
        initialPrompt,
        ...(description ? { description } : {}),
        ...(kind ? { kind } : {}),
        ...(initialPromptTemplate ? { initialPromptTemplate } : {}),
        ...(prompts ? { prompts } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(runtime ? { runtime } : {}),
        ...(runtimeRecommendations ? { runtimeRecommendations } : {}),
      });
    }
  }

  if (
    agents.length === 0 &&
    manifest?.codexConversation &&
    typeof manifest.codexConversation === 'object' &&
    (manifest.codexConversation as Record<string, unknown>).enabled === true
  ) {
    agents.push({
      id: 'legacy-codex-conversation',
      title: 'App Agent',
      description: 'Conversacion asistida declarada por la app.',
      initialPrompt: 'Ayuda al usuario con esta app usando su documentacion y herramientas disponibles.',
      model: getCodexDefaults().model,
      reasoningEffort: getCodexDefaults().reasoningEffort,
      legacy: true,
    });
  }

  return agents;
};

const normalizeManifestAgentKind = (value: unknown): AppAgent['kind'] =>
  value === 'classic' || value === 'thread_interface' || value === 'orchestrator' || value === 'agent_invocation'
    ? value
    : undefined;

const normalizeManifestAgentPrompts = (value: unknown): AppAgentPromptSet | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const output: AppAgentPromptSet = {};
  for (const key of ['initial', 'resume', 'steer'] as const) {
    const template = normalizeManifestAgentPromptTemplate(raw[key]);
    if (template) {
      output[key] = template;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

const normalizeManifestAgentPromptTemplate = (value: unknown): AppAgentPromptTemplate | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (!body) {
    return undefined;
  }
  const variables = normalizeManifestAgentPromptVariables(raw.variables);
  const runtime = normalizeManifestRuntime(raw.runtime);
  const runtimeRecommendations = normalizeManifestRuntimeRecommendations(raw.runtimeRecommendations);
  return {
    body,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
    ...(runtime ? { runtime } : {}),
    ...(runtimeRecommendations ? { runtimeRecommendations } : {}),
  };
};

const normalizeManifestAgentPromptVariables = (value: unknown): Record<string, AppAgentPromptVariable> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, AppAgentPromptVariable> = {};
  for (const [name, rawDeclaration] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !rawDeclaration || typeof rawDeclaration !== 'object' || Array.isArray(rawDeclaration)) {
      continue;
    }
    const declaration = rawDeclaration as Record<string, unknown>;
    const type = declaration.type;
    if (!isAppAgentPromptVariableType(type)) {
      continue;
    }
    output[name] = {
      type,
      ...(typeof declaration.required === 'boolean' ? { required: declaration.required } : {}),
    };
  }
  return output;
};

const isAppAgentPromptVariableType = (value: unknown): value is AppAgentPromptVariableType =>
  value === 'text' || value === 'string' || value === 'json' || value === 'path';

const normalizeManifestReasoningEffort = (value: unknown): CodexReasoningEffort | undefined =>
  CODEX_REASONING_VALUES.has(value as CodexReasoningEffort) ? value as CodexReasoningEffort : undefined;

const normalizeManifestAgentDefaults = (manifest: AppManifest | null): AgentDefaults => {
  const base = normalizeSettings(settings).agentDefaults;
  return normalizeManifestRuntimeRecommendations(manifest?.agentProviders, undefined, base) as AgentDefaults;
};

const normalizeManifestRuntimeRecommendations = (
  value: unknown,
  legacyCodex?: { model?: string; reasoningEffort?: CodexReasoningEffort },
  fallback?: AgentDefaults,
): Partial<AgentDefaults> | undefined => {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const codexRaw = record.codex && typeof record.codex === 'object' && !Array.isArray(record.codex)
    ? record.codex as Record<string, unknown>
    : {};
  const claudeRaw = record.claude && typeof record.claude === 'object' && !Array.isArray(record.claude)
    ? record.claude as Record<string, unknown>
    : {};
  const codexModel =
    asNonEmptyString(codexRaw.model)
    ?? asNonEmptyString(codexRaw.defaultModel)
    ?? legacyCodex?.model
    ?? fallback?.codex.model;
  const codexEffort = normalizeManifestReasoningEffort(
    codexRaw.reasoningEffort ?? codexRaw.effort ?? codexRaw.defaultEffort ?? legacyCodex?.reasoningEffort,
  ) ?? fallback?.codex.reasoningEffort;
  const claudeModel =
    asNonEmptyString(claudeRaw.model)
    ?? asNonEmptyString(claudeRaw.defaultModel)
    ?? fallback?.claude.model;
  const claudeEffort = CLAUDE_EFFORT_VALUES.has((claudeRaw.effort ?? claudeRaw.defaultEffort) as ClaudeEffort)
    ? (claudeRaw.effort ?? claudeRaw.defaultEffort) as ClaudeEffort
    : fallback?.claude.effort;
  const output: Partial<AgentDefaults> = {};
  if (codexModel || codexEffort) {
    output.codex = {
      model: codexModel ?? fallback?.codex.model ?? getCodexDefaults().model,
      reasoningEffort: codexEffort ?? fallback?.codex.reasoningEffort ?? getCodexDefaults().reasoningEffort,
    };
  }
  if (claudeModel || claudeEffort) {
    output.claude = {
      model: claudeModel ?? fallback?.claude.model ?? 'sonnet',
      effort: claudeEffort ?? fallback?.claude.effort ?? 'medium',
    };
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeManifestRuntime = (value: unknown): AgentRuntime | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const provider = normalizeAgentProvider(record.provider);
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : '';
  const effort = provider === 'claude'
    ? normalizeClaudeEffort(record.effort, BUILT_IN_CLAUDE_EFFORT)
    : normalizeCodexReasoningEffort(record.effort, BUILT_IN_CODEX_REASONING);
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model, effort };
};

const normalizePromptTemplateArguments = (input: unknown): NonNullable<AppPromptTemplate['arguments']> => {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenNames = new Set<string>();
  const args: NonNullable<AppPromptTemplate['arguments']> = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const type = candidate.type === 'file' || candidate.type === 'string' ? candidate.type : null;
    if (!name || !type || seenNames.has(name)) {
      continue;
    }
    const acceptedFileTypes = Array.isArray(candidate.acceptedFileTypes)
      ? candidate.acceptedFileTypes.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
    const maxBytes = typeof candidate.maxBytes === 'number' && Number.isFinite(candidate.maxBytes) && candidate.maxBytes > 0
      ? candidate.maxBytes
      : undefined;
    const maxLength = typeof candidate.maxLength === 'number' && Number.isFinite(candidate.maxLength) && candidate.maxLength > 0
      ? candidate.maxLength
      : undefined;
    seenNames.add(name);
    args.push({
      name,
      type,
      ...(candidate.required === true ? { required: true } : {}),
      ...(candidate.multiple === true ? { multiple: true } : {}),
      ...(acceptedFileTypes && acceptedFileTypes.length > 0 ? { acceptedFileTypes } : {}),
      ...(maxBytes ? { maxBytes } : {}),
      ...(maxLength ? { maxLength } : {}),
    });
  }
  return args;
};

const resolveInstalledPromptTemplates = async (appId: string): Promise<AppPromptTemplate[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  const manifest = await resolveInstalledManifest(record.installDir);
  const templates = normalizeManifestPromptTemplates(manifest);
  const defaults = normalizeManifestAgentDefaults(manifest);
  return (await getPromptOverridesStore().applyToPromptTemplates(appId, templates))
    .map((template) => withAgentDefaults(template, defaults));
};

const resolveInstalledAgents = async (appId: string): Promise<AppAgent[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  const manifest = await resolveInstalledManifest(record.installDir);
  const agents = normalizeManifestAgents(manifest);
  const defaults = normalizeManifestAgentDefaults(manifest);
  return (await getPromptOverridesStore().applyToAgents(appId, agents))
    .map((agent) => withAgentDefaults(agent, defaults));
};

const hasInstalledCodexConversation = async (appId: string): Promise<boolean> =>
  (await resolveInstalledAgents(appId)).length > 0;

const resolveInstalledPromptBases = async (appId: string) => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  const manifest = await resolveInstalledManifest(record.installDir);
  return buildPromptBases(normalizeManifestPromptTemplates(manifest), normalizeManifestAgents(manifest), getCodexDefaults());
};

const listAppPrompts = async (appId: string): Promise<AppPromptReviewItem[]> => {
  const bases = await resolveInstalledPromptBases(appId);
  return await getPromptOverridesStore().list(appId, bases);
};

const validateAppPrompt = async (input: AppPromptReviewInput): Promise<AppPromptValidationResult> => {
  try {
    const bases = await resolveInstalledPromptBases(input.appId);
    return await getPromptOverridesStore().validate(input.appId, bases, input);
  } catch (error) {
    const result = promptOverrideErrorResult(error);
    return {
      valid: false,
      errors: [result.userMessage ?? 'No se pudo validar el prompt.'],
      missingVariables: [],
      extraVariables: [],
    };
  }
};

const updateAppPrompt = async (input: AppPromptReviewInput): Promise<AppPromptMutationResult> => {
  try {
    const bases = await resolveInstalledPromptBases(input.appId);
    const prompt = await getPromptOverridesStore().update(input.appId, bases, input);
    return {
      success: true,
      userMessage: 'Prompt actualizado.',
      prompt,
    };
  } catch (error) {
    return promptOverrideErrorResult(error);
  }
};

const restoreAppPrompt = async (input: AppPromptRestoreInput): Promise<AppPromptMutationResult> => {
  try {
    const bases = await resolveInstalledPromptBases(input.appId);
    const prompt = await getPromptOverridesStore().restore(input.appId, bases, input);
    return {
      success: true,
      userMessage: 'Prompt original restaurado.',
      prompt,
    };
  } catch (error) {
    return promptOverrideErrorResult(error);
  }
};

const getManifestAppSecretsValidationError = (manifest: AppManifest | null): string | null => {
  if (!manifest || !Array.isArray(manifest.appSecrets)) {
    return null;
  }

  const seenNames = new Set<string>();
  const seenEnvNames = new Set<string>();
  for (const entry of manifest.appSecrets) {
    if (!entry || typeof entry !== 'object') {
      return 'La app declara un secreto invalido.';
    }

    const candidate = entry as Partial<AppSecretDeclaration>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const usage = typeof candidate.usage === 'string' ? candidate.usage.trim() : '';
    const envName = appSecretEnvName(name);

    if (!name || !usage || !envName) {
      return 'La app declara un secreto incompleto.';
    }
    if (isReservedAppSecretEnvName(envName)) {
      return `La app declara un secreto con un nombre reservado: ${envName}.`;
    }
    if (seenNames.has(name) || seenEnvNames.has(envName)) {
      return `La app declara secretos duplicados para la variable ${envName}.`;
    }

    seenNames.add(name);
    seenEnvNames.add(envName);
  }

  return null;
};

const resolveInstalledAppSecrets = async (appId: string): Promise<AppSecretDeclaration[]> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return [];
  }
  const manifest = await resolveInstalledManifest(record.installDir);
  return normalizeManifestAppSecrets(manifest);
};

const buildAppSecretsState = async (appId: string): Promise<AppSecretsState> => {
  const record = registry.apps[appId];
  const declarations = await resolveInstalledAppSecrets(appId);
  const store = getSecretsStore();
  const userSecrets = await store.listUserSecrets();
  const userSecretById = new Map(userSecrets.map((secret) => [secret.id, secret]));
  const appSecrets: AppSecretConnection[] = [];

  for (const declaration of declarations) {
    const userSecretId = await store.getMappedSecretId(appId, declaration.name);
    const userSecret = userSecretId ? userSecretById.get(userSecretId) : undefined;
    appSecrets.push({
      appSecret: declaration,
      envName: appSecretEnvName(declaration.name),
      connected: Boolean(userSecret),
      ...(userSecret ? { userSecretId: userSecret.id, userSecretName: userSecret.name } : {}),
    });
  }

  return {
    appId,
    appName: record?.name ?? appId,
    appSecrets,
    userSecrets,
  };
};

const formatProcessOutputForInstallLog = (value: string, secretValues: string[]): string =>
  secretValues.length > 0
    ? '[salida omitida porque la app recibio secretos]'
    : value;

  return { normalizeToken, ensurePathInside, toPosixRelativePath, resolveInstalledManifest, manifestAllowsAgentNetworkAccess, appAllowsAgentNetworkAccess, anyAppAllowsAgentNetworkAccess, getSecretsStore, getOfficialToolsService, getMemoryStore, buildMemoryContextForApps, buildMemoryContextForApp, buildForgerToolsContextForApp, buildForgerToolsContextForFreeChat, getBackupsManager, createRemoteAppBackup, restoreRemoteAppBackup, syncAppToCloudIfEnabled, isReservedAppSecretEnvName, normalizeAppSecretDeclaration, normalizeManifestAppSecrets, resolveAppToolDeclarations, normalizeManifestPromptTemplates, normalizeManifestAgents, normalizeManifestAgentKind, normalizeManifestAgentPrompts, normalizeManifestAgentPromptTemplate, normalizeManifestAgentPromptVariables, isAppAgentPromptVariableType, normalizeManifestReasoningEffort, normalizeManifestAgentDefaults, normalizeManifestRuntime, normalizePromptTemplateArguments, resolveInstalledPromptTemplates, resolveInstalledAgents, hasInstalledCodexConversation, resolveInstalledPromptBases, listAppPrompts, validateAppPrompt, updateAppPrompt, restoreAppPrompt, getManifestAppSecretsValidationError, resolveInstalledAppSecrets, buildAppSecretsState, formatProcessOutputForInstallLog };
};
