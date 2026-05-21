import type fs from 'node:fs/promises';
import type path from 'node:path';
import { FileLibrary } from '../file-library';
import { buildForgerAppAgentsMarkdown } from '../prompts/apps-base';
import {
  FORGER_AGENT_CONTRACT_MARKER,
  FORGER_AGENT_CONTRACT_MARKER_PREFIX,
  buildGlobalForgerAgentsMarkdown,
} from '../prompts/forger-base';
import { buildForgerOfficialToolSkillTemplates } from '../prompts/official-tools';
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
  await writeSkillTemplates(skillsRoot, buildForgerOfficialToolSkillTemplates());
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

const buildStackSkillTemplates = (stack: AppManifestStack, hasAppMcp = false): StackSkillTemplate[] => {
  const templates: StackSkillTemplate[] = buildForgerOfficialToolSkillTemplates();
  const backend = stack.backend ?? {};
  const frontend = stack.frontend ?? {};
  const backendLanguage = normalizeToken(backend.language);
  const backendFramework = normalizeToken(backend.framework);
  const frontendFramework = normalizeToken(frontend.framework);
  const frontendUi = normalizeToken(frontend.ui);

  if (backendLanguage === 'python') {
    templates.push({
      id: 'forger-python-backend',
      description: 'Best practices for Python backends in Forger.',
      body: [
        '---',
        'name: forger-python-backend',
        'description: Use small, safe Python backend changes focused on validation and integrity.',
        '---',
        '',
        '- Keep domain validations before persisting data.',
        '- Avoid breaking payload compatibility without explaining the impact.',
        '- Prefer clear, testable changes that are easy to revert.',
      ].join('\n'),
    });
  }

  if (backendFramework === 'fastapi') {
    templates.push({
      id: 'forger-fastapi-contracts',
      description: 'Guidance for contracts and safety in FastAPI endpoints.',
      body: [
        '---',
        'name: forger-fastapi-contracts',
        'description: Adjust FastAPI routes while preserving contracts and consistent responses for non-technical users.',
        '---',
        '',
        '- Keep HTTP semantics consistent.',
        '- Do not remove response fields used by the frontend without a migration plan.',
        '- Return errors with clear, actionable messages.',
      ].join('\n'),
    });
  }

  if (frontendFramework === 'react') {
    templates.push({
      id: 'forger-react-ui',
      description: 'React UI best practices for non-technical users.',
      body: [
        '---',
        'name: forger-react-ui',
        'description: Prioritize clear flows with saved versions, adjustments, and return-to-previous-version behavior in React interfaces.',
        '---',
        '',
        '- Use simple action-oriented copy.',
        '- Avoid ambiguous states; clearly show success, error, and next steps.',
        '- Keep components predictable and easy to extend.',
        '- When the user asks for visible changes, describe screens, buttons, and flows instead of implementation.',
      ].join('\n'),
    });
  }

  if (frontendUi === 'mui') {
    templates.push({
      id: 'forger-mui-consistency',
      description: 'Visual consistency and accessibility in MUI.',
      body: [
        '---',
        'name: forger-mui-consistency',
        'description: Use consistent MUI patterns to keep the experience stable.',
        '---',
        '',
        '- Reuse MUI components before creating ad hoc variants.',
        '- Keep visual hierarchy simple and messages easy to understand.',
        '- Do not introduce styles that make maintenance harder.',
      ].join('\n'),
    });
  }

  if (hasAppMcp) {
    templates.push({
      id: 'forger-app-mcp-data-tools',
      description: 'Use app MCP tools for structured Forger app data operations.',
      body: [
        '---',
        'name: forger-app-mcp-data-tools',
        'description: Prefer app MCP tools when app data needs to be read, exposed, created, edited, deleted, imported, or validated.',
        '---',
        '',
        '- Review the app `AGENTS.md` and `manifest.json` before using tools.',
        '- Use app MCP tools before scripts, direct database access, or ad hoc endpoint calls for structured data operations.',
        '- Treat MCP tools as internal agent tools, not user-visible commands.',
        '- Let MCP validation errors shape the user-facing answer: explain missing data, rejected records, invalid categories, duplicates, or unsupported operations in product language.',
        '- If MCP does not expose the needed operation, fall back to documented scripts or endpoints when they preserve app validations.',
        '- Avoid direct SQL writes unless there is no MCP or documented tool for the task and the change is narrow, validated, and safe.',
        '- Confirm before destructive or irreversible data changes.',
      ].join('\n'),
    });
  }

  return templates;
};

const writeSkillTemplates = async (skillsRoot: string, templates: StackSkillTemplate[]): Promise<void> => {
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

const writeStackSkills = async (skillsRoot: string, stack: AppManifestStack, hasAppMcp = false): Promise<void> => {
  await writeSkillTemplates(skillsRoot, buildStackSkillTemplates(stack, hasAppMcp));
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

  const hasStack = hasValidManifestStack(manifest);
  const hasAppMcp = Boolean(
    manifest?.mcp
    && typeof manifest.mcp === 'object'
    && (!manifest.mcp.type || manifest.mcp.type === 'http')
    && typeof manifest.mcp.command === 'string',
  );
  const hasAppSkills = Boolean(manifest && Array.isArray(manifest.skills) && manifest.skills.length > 0);
  if (!hasStack && !hasAppSkills && !hasAppMcp) {
    return;
  }

  const skillsRoot = path.join(installDir, '.agents', 'skills');
  await fs.rm(skillsRoot, { recursive: true, force: true });
  await fs.mkdir(skillsRoot, { recursive: true });
  if (hasStack) {
    await writeStackSkills(skillsRoot, manifest.stack, hasAppMcp);
  }
  if (!hasStack && hasAppMcp) {
    await writeStackSkills(skillsRoot, {}, hasAppMcp);
  }
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

  return { hasValidManifestStack, ensureGlobalAgentsContext, shouldWriteAppAgentsMarkdown, buildStackSkillTemplates, writeSkillTemplates, copyDirectory, writeStackSkills, copyAppSkills, normalizeInstalledAgentContext, resolveSelectedAppDisplayName, getFileLibrary, withAppLifecycleLock, listCatalogFromBackend };
};
