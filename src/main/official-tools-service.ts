import { execFile } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AppSecretDeclaration,
  InstallOfficialToolResult,
  OfficialToolActionDefinition,
  OfficialToolPermission,
  OfficialToolRuntime,
  OfficialToolSecretDeclaration,
  OfficialToolStatus,
  OfficialToolSummary,
} from '../shared/types';

const execFileAsync = promisify(execFile);

const CATALOG_FILE = 'catalog.json';
const REGISTRY_FILE = 'official-tools-registry.json';
const PUBLIC_SIGNING_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6h5TIxC2+5n34tWwRhCjFFJQpFf7FuXxqVy6nStys1U=
-----END PUBLIC KEY-----`;

interface OfficialToolsCatalog {
  schemaVersion: 1;
  publisher: 'Forger';
  tools: OfficialToolCatalogEntry[];
}

interface OfficialToolCatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: OfficialToolRuntime;
  archivePath: string;
  signaturePath?: string;
  checksumSha256: string;
  signatureBase64: string;
  manifestPath: string;
}

interface OfficialToolManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  runtime: OfficialToolRuntime;
  documentation?: string;
  technicalBlocker?: string;
  permissions: OfficialToolPermission[];
  secrets: OfficialToolSecretDeclaration[];
  actions: Array<Omit<OfficialToolActionDefinition, 'permissions'> & { permissions: string[] }>;
}

interface InstalledOfficialToolRecord {
  id: string;
  version: string;
  installDir: string;
  installedAt: string;
}

interface OfficialToolsRegistry {
  version: 1;
  installed: Record<string, InstalledOfficialToolRecord>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const safeToken = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const isRuntime = (value: unknown): value is OfficialToolRuntime =>
  value === 'host' || value === 'node' || value === 'python' || value === 'oauth';

const isRisk = (value: unknown): value is OfficialToolActionDefinition['risk'] =>
  value === 'bajo' || value === 'medio' || value === 'alto';

const isCategory = (value: unknown): value is OfficialToolActionDefinition['category'] =>
  value === 'consulta' || value === 'app' || value === 'actualizacion' || value === 'vista';

const isSafeRelativePath = (value: string): boolean =>
  Boolean(value)
  && !path.isAbsolute(value)
  && !value.replace(/\\/g, '/').split('/').filter(Boolean).includes('..');

const isSafeId = (value: string): boolean => /^[a-z0-9][a-z0-9._-]*$/.test(value);

const createEmptyRegistry = (): OfficialToolsRegistry => ({ version: 1, installed: {} });

const readJsonFile = async <T>(filePath: string): Promise<T> => {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
};

const normalizePermission = (value: unknown): OfficialToolPermission | null => {
  if (!isPlainRecord(value)) {
    return null;
  }
  const id = safeToken(value.id);
  const label = safeToken(value.label);
  const description = safeToken(value.description);
  if (!id || !label || !description) {
    return null;
  }
  return { id, label, description, required: value.required === true };
};

const normalizeSecret = (value: unknown): OfficialToolSecretDeclaration | null => {
  if (!isPlainRecord(value)) {
    return null;
  }
  const name = safeToken(value.name);
  const usage = safeToken(value.usage);
  const label = safeToken(value.label);
  if (!name || !usage) {
    return null;
  }
  return { name, usage, required: value.required === true, ...(label ? { label } : {}) };
};

const normalizeManifest = (value: unknown): OfficialToolManifest => {
  if (!isPlainRecord(value) || value.schemaVersion !== 1) {
    throw new Error('official_tool_manifest_invalid');
  }
  const id = safeToken(value.id);
  const name = safeToken(value.name);
  const description = safeToken(value.description);
  const version = safeToken(value.version);
  if (!isSafeId(id) || !name || !description || !version || !isRuntime(value.runtime)) {
    throw new Error('official_tool_manifest_invalid');
  }

  const permissions = Array.isArray(value.permissions)
    ? value.permissions.map(normalizePermission)
    : [];
  const secrets = Array.isArray(value.secrets) ? value.secrets.map(normalizeSecret) : [];
  if (permissions.some((entry) => !entry) || secrets.some((entry) => !entry)) {
    throw new Error('official_tool_manifest_invalid');
  }
  const permissionIds = new Set(permissions.map((entry) => entry?.id));
  const secretNames = new Set(secrets.map((entry) => entry?.name));
  if (permissionIds.size !== permissions.length || secretNames.size !== secrets.length) {
    throw new Error('official_tool_manifest_invalid');
  }

  const actions = Array.isArray(value.actions) ? value.actions : [];
  if (actions.length === 0) {
    throw new Error('official_tool_manifest_invalid');
  }
  const normalizedActions = actions.map((action) => {
    if (!isPlainRecord(action)) {
      throw new Error('official_tool_manifest_invalid');
    }
    const actionId = safeToken(action.id);
    const actionName = safeToken(action.name);
    const actionDescription = safeToken(action.description);
    const actionPermissions = Array.isArray(action.permissions) ? action.permissions.map(safeToken) : [];
    const actionSecrets = Array.isArray(action.secrets) ? action.secrets.map(safeToken) : [];
    if (
      !actionId.startsWith('official_') ||
      !actionName ||
      !actionDescription ||
      !isCategory(action.category) ||
      !isRisk(action.risk) ||
      actionPermissions.some((permission) => !permissionIds.has(permission)) ||
      actionSecrets.some((secret) => !secretNames.has(secret))
    ) {
      throw new Error('official_tool_manifest_invalid');
    }
    return {
      id: actionId as OfficialToolActionDefinition['id'],
      name: actionName,
      description: actionDescription,
      category: action.category,
      risk: action.risk,
      defaultRequiresApproval: action.defaultRequiresApproval === true,
      permissions: actionPermissions,
      secrets: actionSecrets,
    };
  });

  return {
    schemaVersion: 1,
    id,
    name,
    description,
    version,
    runtime: value.runtime,
    documentation: safeToken(value.documentation) || undefined,
    technicalBlocker: safeToken(value.technicalBlocker) || undefined,
    permissions: permissions as OfficialToolPermission[],
    secrets: secrets as OfficialToolSecretDeclaration[],
    actions: normalizedActions,
  };
};

const normalizeCatalog = (value: unknown): OfficialToolsCatalog => {
  if (!isPlainRecord(value) || value.schemaVersion !== 1 || value.publisher !== 'Forger' || !Array.isArray(value.tools)) {
    throw new Error('official_tools_catalog_invalid');
  }
  const tools = value.tools.map((entry) => {
    if (!isPlainRecord(entry)) {
      throw new Error('official_tools_catalog_invalid');
    }
    const id = safeToken(entry.id);
    const name = safeToken(entry.name);
    const description = safeToken(entry.description);
    const version = safeToken(entry.version);
    const archivePath = safeToken(entry.archivePath);
    const signaturePath = safeToken(entry.signaturePath);
    const checksumSha256 = safeToken(entry.checksumSha256).toLowerCase();
    const signatureBase64 = safeToken(entry.signatureBase64);
    const manifestPath = safeToken(entry.manifestPath);
    if (
      !isSafeId(id) ||
      !name ||
      !description ||
      !version ||
      !isRuntime(entry.runtime) ||
      !isSafeRelativePath(archivePath) ||
      (signaturePath && !isSafeRelativePath(signaturePath)) ||
      !/^[a-f0-9]{64}$/.test(checksumSha256) ||
      !signatureBase64 ||
      !isSafeRelativePath(manifestPath)
    ) {
      throw new Error('official_tools_catalog_invalid');
    }
    return {
      id,
      name,
      description,
      version,
      runtime: entry.runtime,
      archivePath,
      signaturePath: signaturePath || undefined,
      checksumSha256,
      signatureBase64,
      manifestPath,
    };
  });
  return { schemaVersion: 1, publisher: 'Forger', tools };
};

const validateArchiveEntries = async (archivePath: string): Promise<void> => {
  if (!archivePath.endsWith('.zip')) {
    throw new Error('official_tool_archive_format_unsupported');
  }
  const { stdout } = await execFileAsync('unzip', ['-Z', '-1', archivePath], {
    cwd: path.dirname(archivePath),
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  for (const line of stdout.split('\n')) {
    const normalized = line.trim().replace(/\\/g, '/');
    if (!normalized) {
      continue;
    }
    const parts = normalized.split('/').filter(Boolean);
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      parts.includes('..') ||
      parts.includes('.git') ||
      normalized.includes('/.git/') ||
      normalized.endsWith('/.git')
    ) {
      throw new Error(`official_tool_archive_unsafe_entry_${normalized}`);
    }
  }
};

const extractZip = async (archivePath: string, destination: string): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });
  await execFileAsync('unzip', ['-q', archivePath, '-d', destination], {
    cwd: destination,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
};

const flattenSingleTopLevelDirectory = async (targetDir: string): Promise<void> => {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'));
  if (visibleEntries.length !== 1 || !visibleEntries[0].isDirectory()) {
    return;
  }
  const topFolder = path.join(targetDir, visibleEntries[0].name);
  for (const child of await fs.readdir(topFolder)) {
    await fs.rename(path.join(topFolder, child), path.join(targetDir, child));
  }
  await fs.rm(topFolder, { recursive: true, force: true });
};

const assertSafeExtractedTree = async (rootDir: string): Promise<void> => {
  const walk = async (currentDir: string): Promise<void> => {
    for (const entry of await fs.readdir(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const relative = path.relative(rootDir, entryPath).replace(/\\/g, '/');
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split('/').includes('.git')) {
        throw new Error(`official_tool_archive_unsafe_entry_${relative}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`official_tool_archive_symlink_entry_${relative}`);
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  };
  await walk(rootDir);
};

export const integratedForgerToolSummary = (tools: AgentToolDefinition[]): OfficialToolSummary => ({
  id: 'forger',
  name: 'Herramientas de Forger',
  description: 'Herramientas integradas en Forger Desktop.',
  version: 'integrated',
  status: 'integrated',
  runtime: 'host',
  actions: tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    risk: tool.risk,
    defaultRequiresApproval: tool.defaultRequiresApproval,
    permissions: [],
    secrets: [],
  })),
  permissions: [],
  secrets: [],
});

export class OfficialToolsService {
  private registry: OfficialToolsRegistry = createEmptyRegistry();

  constructor(
    private readonly resourcesRoot: string,
    private readonly metadataRoot: string,
    private readonly tempRoot: string,
  ) {}

  async load(): Promise<void> {
    this.registry = await this.readRegistry();
  }

  async listTools(integratedTools: AgentToolDefinition[]): Promise<OfficialToolSummary[]> {
    const catalog = await this.readCatalog();
    const summaries = await Promise.all(catalog.tools.map((entry) => this.toSummary(entry)));
    return [integratedForgerToolSummary(integratedTools), ...summaries];
  }

  async listInstalledPackages(): Promise<AgentToolPackageDefinition[]> {
    const packages: AgentToolPackageDefinition[] = [];
    for (const record of Object.values(this.registry.installed)) {
      const manifest = await this.readInstalledManifest(record).catch(() => null);
      if (!manifest) {
        continue;
      }
      packages.push(this.manifestToPackage(manifest));
    }
    return packages;
  }

  async installTool(toolId: string): Promise<InstallOfficialToolResult> {
    try {
      const catalog = await this.readCatalog();
      const entry = catalog.tools.find((candidate) => candidate.id === toolId);
      if (!entry) {
        return { success: false, userMessage: 'La herramienta no esta disponible.', technicalCode: 'official_tool_missing' };
      }

      const archivePath = path.join(this.resourcesRoot, entry.archivePath);
      const archive = await fs.readFile(archivePath);
      const checksum = createHash('sha256').update(archive).digest('hex');
      if (checksum !== entry.checksumSha256) {
        return { success: false, userMessage: 'El paquete no paso la validacion de seguridad.', technicalCode: 'official_tool_checksum_mismatch' };
      }

      const catalogSignature = Buffer.from(entry.signatureBase64, 'base64');
      const signaturePath = entry.signaturePath ? path.join(this.resourcesRoot, entry.signaturePath) : null;
      const fileSignature = signaturePath ? await fs.readFile(signaturePath).catch(() => null) : null;
      const signature = fileSignature ?? catalogSignature;
      if (!verify(null, archive, PUBLIC_SIGNING_KEY, signature)) {
        return { success: false, userMessage: 'La firma del paquete no es valida.', technicalCode: 'official_tool_signature_invalid' };
      }

      await validateArchiveEntries(archivePath);
      const stageDir = path.join(this.tempRoot, `official-tool-${toolId}-${Date.now()}`);
      await fs.rm(stageDir, { recursive: true, force: true });
      await extractZip(archivePath, stageDir);
      await flattenSingleTopLevelDirectory(stageDir);
      await assertSafeExtractedTree(stageDir);
      const manifest = normalizeManifest(await readJsonFile(path.join(stageDir, entry.manifestPath)));
      if (
        manifest.id !== entry.id ||
        manifest.version !== entry.version ||
        manifest.name !== entry.name ||
        manifest.runtime !== entry.runtime
      ) {
        throw new Error('official_tool_manifest_catalog_mismatch');
      }

      const installDir = path.join(this.getToolsRoot(), toolId);
      await fs.rm(installDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(installDir), { recursive: true });
      await fs.cp(stageDir, installDir, { recursive: true, force: true, verbatimSymlinks: false });
      await fs.rm(stageDir, { recursive: true, force: true });
      const installedAt = new Date().toISOString();
      this.registry.installed[toolId] = {
        id: toolId,
        version: entry.version,
        installDir,
        installedAt,
      };
      await this.saveRegistry();

      return {
        success: true,
        userMessage: 'Herramienta instalada.',
        tool: this.manifestToSummary(manifest, 'installed', installedAt),
      };
    } catch (error) {
      return {
        success: false,
        userMessage: 'No pudimos instalar la herramienta.',
        technicalCode: error instanceof Error ? error.message : 'official_tool_install_failed',
      };
    }
  }

  async getManifest(toolId: string): Promise<OfficialToolManifest | null> {
    const record = this.registry.installed[toolId];
    if (!record) {
      return null;
    }
    return await this.readInstalledManifest(record).catch(() => null);
  }

  secretDeclarations(manifest: OfficialToolManifest | null): AppSecretDeclaration[] {
    if (!manifest) {
      return [];
    }
    return manifest.secrets.map((secret) => ({
      name: secret.name,
      label: secret.label,
      required: secret.required,
      usage: secret.usage,
    }));
  }

  toolMappingId(toolId: string): string {
    return `tool:${toolId}`;
  }

  private async toSummary(entry: OfficialToolCatalogEntry): Promise<OfficialToolSummary> {
    const record = this.registry.installed[entry.id];
    if (record) {
      const manifest = await this.readInstalledManifest(record).catch(() => null);
      if (manifest) {
        return this.manifestToSummary(manifest, 'installed', record.installedAt);
      }
    }
    const archivePath = path.join(this.resourcesRoot, entry.archivePath);
    const stageDir = path.join(this.tempRoot, `official-tool-summary-${entry.id}-${Date.now()}`);
    try {
      await validateArchiveEntries(archivePath);
      await extractZip(archivePath, stageDir);
      await flattenSingleTopLevelDirectory(stageDir);
      await assertSafeExtractedTree(stageDir);
      const manifest = normalizeManifest(await readJsonFile(path.join(stageDir, entry.manifestPath)));
      return this.manifestToSummary(manifest, 'available');
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private manifestToPackage(manifest: OfficialToolManifest): AgentToolPackageDefinition {
    const permissionsById = new Map(manifest.permissions.map((permission) => [permission.id, permission]));
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      icon: 'official',
      source: 'official',
      version: manifest.version,
      tools: manifest.actions.map((action) => ({
        id: action.id,
        packageId: manifest.id,
        name: action.name,
        description: action.description,
        category: action.category,
        risk: action.risk,
        defaultRequiresApproval: action.defaultRequiresApproval,
        permissions: action.permissions.map((permission) => permissionsById.get(permission)).filter(Boolean) as OfficialToolPermission[],
        secrets: action.secrets,
      })),
    };
  }

  private manifestToSummary(
    manifest: OfficialToolManifest,
    status: OfficialToolStatus,
    installedAt?: string,
  ): OfficialToolSummary {
    const permissionsById = new Map(manifest.permissions.map((permission) => [permission.id, permission]));
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      status,
      runtime: manifest.runtime,
      permissions: manifest.permissions,
      secrets: manifest.secrets,
      documentation: manifest.documentation,
      technicalBlocker: manifest.technicalBlocker,
      installedAt,
      actions: manifest.actions.map((action) => ({
        id: action.id,
        name: action.name,
        description: action.description,
        category: action.category,
        risk: action.risk,
        defaultRequiresApproval: action.defaultRequiresApproval,
        permissions: action.permissions.map((permission) => permissionsById.get(permission)).filter(Boolean) as OfficialToolPermission[],
        secrets: action.secrets,
      })),
    };
  }

  private async readCatalog(): Promise<OfficialToolsCatalog> {
    return normalizeCatalog(await readJsonFile(path.join(this.resourcesRoot, CATALOG_FILE)));
  }

  private async readInstalledManifest(record: InstalledOfficialToolRecord): Promise<OfficialToolManifest> {
    return normalizeManifest(await readJsonFile(path.join(record.installDir, 'manifest.json')));
  }

  private getRegistryPath(): string {
    return path.join(this.metadataRoot, REGISTRY_FILE);
  }

  private getToolsRoot(): string {
    return path.join(this.metadataRoot, 'tools');
  }

  private async readRegistry(): Promise<OfficialToolsRegistry> {
    try {
      const parsed = await readJsonFile<Partial<OfficialToolsRegistry>>(this.getRegistryPath());
      if (parsed.version === 1 && parsed.installed && typeof parsed.installed === 'object') {
        return { version: 1, installed: parsed.installed as Record<string, InstalledOfficialToolRecord> };
      }
    } catch {
      // Fresh registry.
    }
    return createEmptyRegistry();
  }

  private async saveRegistry(): Promise<void> {
    const registryPath = this.getRegistryPath();
    const tempPath = `${registryPath}.tmp`;
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(this.registry, null, 2), 'utf8');
    await fs.rename(tempPath, registryPath);
  }
}
