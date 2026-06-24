import type fs from 'node:fs/promises';
import type path from 'node:path';
import { FileLibrary } from '../file-library';
import { buildForgerAppAgentsMarkdown } from '../prompt-builder/apps-base';
import {
  FORGER_AGENT_CONTRACT_MARKER,
  FORGER_AGENT_CONTRACT_MARKER_PREFIX,
  buildGlobalForgerAgentsMarkdown,
} from '../prompt-builder/forger-base';
import {
  buildInstalledAppSkillTemplates,
  buildForgerWorkspaceSkillTemplates,
} from '../prompt-builder/official-tools';
import type { CatalogApp } from '../../shared/types';
import type { AppManifest, AppManifestStack, AppRegistry, StackSkillTemplate } from '../core/main-process-types';

interface FileLibraryState {
  current: FileLibrary | null;
}

interface AppContextSupportDeps {
  fs: typeof fs;
  path: typeof path;
  catalogApps: CatalogApp[];
  registry: AppRegistry;
  fileLibraryState: FileLibraryState;
  getPrivateDataRoot: () => string;
  getForgerMetadataRoot: () => string;
  appLifecycleLocks: Map<string, Promise<unknown>>;
  forgerBackendClient: { listCatalogApps: () => Promise<CatalogApp[]> } | null;
}

export const createAppContextSupportController = (deps: AppContextSupportDeps) => {
  const { fs, path, catalogApps, registry, fileLibraryState, getPrivateDataRoot, getForgerMetadataRoot, appLifecycleLocks, forgerBackendClient } = deps;
const ensurePathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  const normalizedRelative = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return normalizedRelative === '' || (!normalizedRelative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveInstalledManifest = async (installDir: string): Promise<AppManifest | null> => {
  const manifestPath = path.join(installDir, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as AppManifest;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const hasValidManifestStack = (manifest: AppManifest | null): manifest is AppManifest & { stack: AppManifestStack } => {
  if (!manifest?.stack || typeof manifest.stack !== 'object' || Array.isArray(manifest.stack)) {
    return false;
  }
  const backend = manifest.stack.backend && typeof manifest.stack.backend === 'object' && !Array.isArray(manifest.stack.backend);
  const frontend = manifest.stack.frontend && typeof manifest.stack.frontend === 'object' && !Array.isArray(manifest.stack.frontend);
  return Boolean(backend || frontend);
};

const ensureGlobalAgentsContext = async (forgerHomeRoot: string): Promise<void> => {
  await fs.mkdir(forgerHomeRoot, { recursive: true });
  const agentsPath = path.join(forgerHomeRoot, 'AGENTS.md');
  await fs.writeFile(agentsPath, buildGlobalForgerAgentsMarkdown(), 'utf8');
  const skillsRoot = path.join(forgerHomeRoot, '.agents', 'skills');
  await writeSkillTemplates(skillsRoot, buildForgerWorkspaceSkillTemplates());
};

const shouldWriteAppAgentsMarkdown = async (agentsPath: string): Promise<boolean> => {
  const current = await fs.readFile(agentsPath, 'utf8').catch(() => null);
  if (current === null) {
    return true;
  }

  if (!current.includes(FORGER_AGENT_CONTRACT_MARKER_PREFIX)) {
    return false;
  }

  return !current.includes(FORGER_AGENT_CONTRACT_MARKER);
};

const normalizeToolActions = (manifest: AppManifest | null): string[] => {
  const tools = manifest?.tools;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    return [];
  }
  const declaredTools = tools as { required?: unknown; optional?: unknown };
  const required = Array.isArray(declaredTools.required) ? declaredTools.required : [];
  const optional = Array.isArray(declaredTools.optional) ? declaredTools.optional : [];
  const entries = [...required, ...optional];
  const actions = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const rawActions = (entry as { actions?: unknown }).actions;
    if (!Array.isArray(rawActions)) {
      continue;
    }
    for (const action of rawActions) {
      if (typeof action === 'string' && action.trim()) {
        actions.add(action.trim());
      }
    }
  }
  return [...actions].sort();
};

const buildInstalledAppContextSkillTemplates = (allowedOfficialToolActions: string[] = []): StackSkillTemplate[] =>
  buildInstalledAppSkillTemplates(allowedOfficialToolActions);

const buildStackSkillTemplates = (_stack: AppManifestStack, _hasAppMcp = false, allowedOfficialToolActions: string[] = []): StackSkillTemplate[] =>
  buildInstalledAppContextSkillTemplates(allowedOfficialToolActions);

const removeUndeclaredSkillTemplates = async (skillsRoot: string, templates: StackSkillTemplate[]): Promise<void> => {
  const declaredIds = new Set(templates.map((template) => template.id));
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  for (const entry of entries) {
    if (!entry.isDirectory() || declaredIds.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(skillsRoot, entry.name), { recursive: true, force: true });
  }
};

const writeSkillTemplates = async (skillsRoot: string, templates: StackSkillTemplate[]): Promise<void> => {
  await fs.mkdir(skillsRoot, { recursive: true });
  await removeUndeclaredSkillTemplates(skillsRoot, templates);
  for (const template of templates) {
    const targetDir = path.join(skillsRoot, template.id);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), template.body, 'utf8');
    await fs.writeFile(path.join(targetDir, 'README.md'), `${template.description}\n`, 'utf8');
  }
};

const copyDirectory = async (sourceDir: string, targetDir: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
};

const writeStackSkills = async (skillsRoot: string, stack: AppManifestStack, hasAppMcp = false, allowedOfficialToolActions: string[] = []): Promise<void> => {
  await writeSkillTemplates(skillsRoot, buildStackSkillTemplates(stack, hasAppMcp, allowedOfficialToolActions));
};

const copyAppSkills = async (installDir: string, skillsRoot: string, manifest: AppManifest): Promise<void> => {
  const declared = Array.isArray(manifest.skills) ? manifest.skills : [];
  const resolvedInstallDir = await fs.realpath(installDir);

  for (const entry of declared) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    const sourcePath = path.resolve(installDir, entry);
    const sourcePathReal = await fs.realpath(sourcePath).catch(() => null);
    if (!sourcePathReal || !ensurePathInside(resolvedInstallDir, sourcePathReal)) {
      continue;
    }

    const stat = await fs.stat(sourcePathReal).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }

    const skillName = path.basename(sourcePathReal);
    const destinationPath = path.join(skillsRoot, skillName);
    await copyDirectory(sourcePathReal, destinationPath);
  }
};

const normalizeInstalledAgentContext = async (installDir: string, appId: string): Promise<void> => {
  const manifest = await resolveInstalledManifest(installDir);

  const agentsPath = path.join(installDir, 'AGENTS.md');
  if (await shouldWriteAppAgentsMarkdown(agentsPath)) {
    await fs.writeFile(agentsPath, buildForgerAppAgentsMarkdown(appId, manifest), 'utf8');
  }

  const allowedOfficialToolActions = normalizeToolActions(manifest);

  const skillsRoot = path.join(installDir, '.agents', 'skills');
  await fs.rm(skillsRoot, { recursive: true, force: true });
  await fs.mkdir(skillsRoot, { recursive: true });
  await writeSkillTemplates(skillsRoot, buildInstalledAppContextSkillTemplates(allowedOfficialToolActions));
  if (manifest) {
    await copyAppSkills(installDir, skillsRoot, manifest);
  }
};

const resolveSelectedAppDisplayName = (appId: string): string => {
  const installedName = registry.apps[appId]?.name?.trim();
  if (installedName) {
    return installedName;
  }
  const catalogName = catalogApps.find((entry) => entry.id === appId)?.name?.trim();
  if (catalogName) {
    return catalogName;
  }
  return appId;
};

const getFileLibrary = (): FileLibrary => {
  if (!fileLibraryState.current) {
    fileLibraryState.current = new FileLibrary(getPrivateDataRoot(), getForgerMetadataRoot());
  }
  return fileLibraryState.current;
};

const withAppLifecycleLock = async <T>(appId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = appLifecycleLocks.get(appId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => current);
  appLifecycleLocks.set(appId, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (appLifecycleLocks.get(appId) === chain) {
      appLifecycleLocks.delete(appId);
    }
  }
};

const listCatalogFromBackend = async (): Promise<CatalogApp[]> => {
  return forgerBackendClient ? await forgerBackendClient.listCatalogApps() : [];
};

  return { hasValidManifestStack, ensureGlobalAgentsContext, shouldWriteAppAgentsMarkdown, buildInstalledAppContextSkillTemplates, buildStackSkillTemplates, writeSkillTemplates, copyDirectory, writeStackSkills, copyAppSkills, normalizeInstalledAgentContext, resolveSelectedAppDisplayName, getFileLibrary, withAppLifecycleLock, listCatalogFromBackend };
};
