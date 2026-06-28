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
import { forgerSkillRoots, writeSkillTemplates as writePromptSkillTemplates } from '../prompt-builder/skill-template-writer';
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
  await writeSkillTemplatesForRoots(forgerSkillRoots(path, forgerHomeRoot), buildForgerWorkspaceSkillTemplates());
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

const readFrontmatterField = (frontmatter: string, fieldName: 'name' | 'description'): string | null => {
  const match = frontmatter.match(new RegExp(`^${fieldName}:\\s*(.*)$`, 'm'));
  if (!match) {
    return null;
  }
  const value = match[1]?.trim() ?? '';
  if (!value) {
    return null;
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  if (/:\s/.test(value)) {
    return null;
  }
  return value;
};

const hasValidSkillFrontmatter = (source: string): boolean => {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return false;
  }
  return Boolean(
    readFrontmatterField(match[1], 'name')
    && readFrontmatterField(match[1], 'description'),
  );
};

const writeSkillTemplates = async (skillsRoot: string, templates: StackSkillTemplate[]): Promise<void> => {
  await writePromptSkillTemplates({ fs, path }, skillsRoot, templates);
};

const writeSkillTemplatesForRoots = async (skillsRoots: string[], templates: StackSkillTemplate[]): Promise<void> => {
  await Promise.all(skillsRoots.map((skillsRoot) => writeSkillTemplates(skillsRoot, templates)));
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
    const skillMarkdownPath = path.join(sourcePathReal, 'SKILL.md');
    const skillMarkdown = await fs.readFile(skillMarkdownPath, 'utf8').catch(() => null);
    if (!skillMarkdown || !hasValidSkillFrontmatter(skillMarkdown)) {
      console.warn('skill_frontmatter_invalid', { sourcePath: sourcePathReal });
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

  const skillsRoots = forgerSkillRoots(path, installDir);
  await Promise.all(skillsRoots.map(async (skillsRoot) => {
    await fs.rm(skillsRoot, { recursive: true, force: true });
    await fs.mkdir(skillsRoot, { recursive: true });
  }));
  await writeSkillTemplatesForRoots(skillsRoots, buildInstalledAppContextSkillTemplates(allowedOfficialToolActions));
  if (manifest) {
    await Promise.all(skillsRoots.map((skillsRoot) => copyAppSkills(installDir, skillsRoot, manifest)));
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
