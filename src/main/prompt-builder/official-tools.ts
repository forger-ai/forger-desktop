import fs from 'node:fs';
import path from 'node:path';
import { promptTemplateRoots, renderPromptFile } from './index';

export interface ForgerOfficialToolsPromptInput {
  gmailReady: boolean;
  whatsappReady?: boolean;
  chromeExtensionReady?: boolean;
  allowedActions?: string[];
  mode: 'free-chat' | 'app-agent';
}

export interface ForgerSkillTemplate {
  id: string;
  description: string;
  body: string;
}

type SkillGroup = 'global' | 'forger' | 'apps';

interface SkillFrontmatter {
  name: string;
  description: string;
}

const parseSkillFrontmatter = (source: string, relativePath: string): SkillFrontmatter => {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`skill_frontmatter_missing:${relativePath}`);
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (field) {
      fields.set(field[1], field[2].trim());
    }
  }
  const name = fields.get('name');
  const description = fields.get('description');
  if (!name || !description) {
    throw new Error(`skill_frontmatter_invalid:${relativePath}`);
  }
  return { name, description };
};

const resolveSkillGroupDirectory = (group: SkillGroup): string => {
  for (const root of promptTemplateRoots()) {
    const candidate = path.join(root, 'skills', group);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  throw new Error(`skill_group_not_found:${group}`);
};

const listSkillFiles = (group: SkillGroup): string[] =>
  fs.readdirSync(resolveSkillGroupDirectory(group))
    .filter((entry) => entry.endsWith('.md'))
    .sort((left, right) => left.localeCompare(right));

const buildSkillTemplateFromFile = (group: SkillGroup, filename: string, variables: Record<string, string> = {}): ForgerSkillTemplate => {
  const relativePath = `skills/${group}/${filename}`;
  const source = fs.readFileSync(path.join(resolveSkillGroupDirectory(group), filename), 'utf8');
  const frontmatter = parseSkillFrontmatter(source, relativePath);
  return {
    id: frontmatter.name,
    description: frontmatter.description,
    body: renderPromptFile(relativePath, variables),
  };
};

const buildSkillTemplatesForGroup = (group: SkillGroup): ForgerSkillTemplate[] =>
  listSkillFiles(group).map((filename) => buildSkillTemplateFromFile(group, filename));

export const buildForgerOfficialToolsPromptSection = (input: ForgerOfficialToolsPromptInput): string => {
  const allowedActions = input.allowedActions ?? [];
  const availabilityLine = input.mode === 'free-chat'
    ? 'Free chat may use official Forger tools directly for a global Forger action.'
    : 'App agents may use official Forger tools only when the app context and grants allow the requested action.';
  const actionsLine = allowedActions.length > 0
    ? `Available official tool actions in this context: ${allowedActions.map((action) => `\`${action}\``).join(', ')}.`
    : input.mode === 'free-chat'
      ? 'Free chat can inspect official tool availability through the `forger` MCP server.'
      : 'This app has not declared any official Forger tool actions for its app agent.';

  return renderPromptFile('partials/official-tools.md', {
    availabilityLine,
    gmailStatus: input.gmailReady ? 'connected and ready' : 'not connected or not active',
    whatsappStatus: input.whatsappReady ? 'connected or active locally' : 'not connected or not active',
    chromeExtensionStatus: input.chromeExtensionReady ? 'connected and ready' : 'not connected or not active',
    actionsLine,
    gmailInstruction: input.gmailReady
      ? 'When the request is to search, read, download attachments from, or send Gmail, call the matching `gmail.*` tool through the `forger` MCP server and wait for the Forger permission result.'
      : 'If Gmail is requested and unavailable, explain that Gmail must be activated and connected in Forger Tools before Forger can read or send mail.',
    whatsappInstruction: input.whatsappReady
      ? 'When the request is to read, inspect, or send WhatsApp messages, call the matching `whatsapp.*` tool through the `forger` MCP server. Use only chat IDs and message references returned by WhatsApp reads or listings.'
      : 'If WhatsApp is requested and unavailable, explain that WhatsApp must be activated and connected in Forger Tools before Forger can read or send messages.',
    chromeExtensionInstruction: input.chromeExtensionReady
      ? 'When the request needs a real browser session, call `forger_chrome_extension.open_dedicated_tab`, then use the returned session id for navigation, inspection, click, focus, hover, input, form submit, style inspection, visual highlighting, URL read, and close actions.'
      : 'If Chrome browser control is requested and unavailable, first call `forger_chrome_extension.connection.status` when it is available; otherwise explain that the Forger Chrome Extension must be activated and connected in Forger Tools.',
  });
};

export const buildGlobalSkillTemplates = (): ForgerSkillTemplate[] =>
  buildSkillTemplatesForGroup('global');

export const buildForgerWorkspaceSkillTemplates = (): ForgerSkillTemplate[] => [
  ...buildGlobalSkillTemplates(),
  ...buildSkillTemplatesForGroup('forger'),
];

export const buildInstalledAppSkillTemplates = (allowedOfficialToolActions: string[] = []): ForgerSkillTemplate[] => [
  ...buildGlobalSkillTemplates(),
  buildAppOfficialToolsSkillTemplate(allowedOfficialToolActions),
];

export const buildAppBaseSkillTemplates = buildInstalledAppSkillTemplates;

export const buildAppOfficialToolsSkillTemplate = (allowedOfficialToolActions: string[] = []): ForgerSkillTemplate => ({
  ...buildSkillTemplateFromFile('apps', 'forger-app-official-tools.md', {
    actionsLine: allowedOfficialToolActions.length > 0
      ? `Available official tool actions for this app: ${allowedOfficialToolActions.map((action) => `\`${action}\``).join(', ')}.`
      : 'This app has not declared any official Forger tool actions.',
  }),
});

export const buildForgerOfficialToolSkillTemplates = (): ForgerSkillTemplate[] =>
  buildForgerWorkspaceSkillTemplates();
