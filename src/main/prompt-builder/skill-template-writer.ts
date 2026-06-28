import type fs from 'node:fs/promises';
import type path from 'node:path';
import type { ForgerSkillTemplate } from './official-tools';

export interface SkillTemplateWriterDeps {
  fs: typeof fs;
  path: typeof path;
}

const yamlScalar = (value: string): string => JSON.stringify(value);

export const normalizeSkillTemplateBody = (template: ForgerSkillTemplate): string => {
  const bodyWithoutFrontmatter = template.body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return [
    '---',
    `name: ${yamlScalar(template.id)}`,
    `description: ${yamlScalar(template.description)}`,
    '---',
    bodyWithoutFrontmatter.replace(/^\s+/, ''),
  ].join('\n');
};

export const removeUndeclaredSkillTemplates = async (
  deps: SkillTemplateWriterDeps,
  skillsRoot: string,
  templates: ForgerSkillTemplate[],
): Promise<void> => {
  const declaredIds = new Set(templates.map((template) => template.id));
  const entries = await deps.fs.readdir(skillsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    throw error;
  });

  for (const entry of entries) {
    if (!entry.isDirectory() || declaredIds.has(entry.name)) {
      continue;
    }
    await deps.fs.rm(deps.path.join(skillsRoot, entry.name), { recursive: true, force: true });
  }
};

export const writeSkillTemplates = async (
  deps: SkillTemplateWriterDeps,
  skillsRoot: string,
  templates: ForgerSkillTemplate[],
): Promise<void> => {
  await deps.fs.mkdir(skillsRoot, { recursive: true });
  await removeUndeclaredSkillTemplates(deps, skillsRoot, templates);
  for (const template of templates) {
    const targetDir = deps.path.join(skillsRoot, template.id);
    await deps.fs.rm(targetDir, { recursive: true, force: true });
    await deps.fs.mkdir(targetDir, { recursive: true });
    await deps.fs.writeFile(deps.path.join(targetDir, 'SKILL.md'), normalizeSkillTemplateBody(template), 'utf8');
    await deps.fs.writeFile(deps.path.join(targetDir, 'README.md'), `${template.description}\n`, 'utf8');
  }
};

export const forgerSkillRoots = (pathApi: typeof path, contextRoot: string): string[] => [
  pathApi.join(contextRoot, '.agents', 'skills'),
  pathApi.join(contextRoot, '.claude', 'skills'),
];
