import { renderPromptFile } from './index';

export interface ForgerOfficialToolsPromptInput {
  gmailReady: boolean;
  allowedActions?: string[];
  mode: 'free-chat' | 'app-agent';
}

export interface ForgerSkillTemplate {
  id: string;
  description: string;
  body: string;
}

type SkillGroup = 'global' | 'forger' | 'apps';

interface ForgerSkillDefinition extends Omit<ForgerSkillTemplate, 'body'> {
  group: SkillGroup;
}

const globalSkillDefinitions: ForgerSkillDefinition[] = [
  {
    group: 'global',
    id: 'forger-context',
    description: 'Understand Forger as the local app environment around installed apps.',
  },
  {
    group: 'global',
    id: 'forger-app-agents-authoring',
    description: 'Write app-owned AGENTS.md files from current app facts.',
  },
  {
    group: 'global',
    id: 'forger-app-mcp-data-tools',
    description: 'Prefer app MCP tools for structured app data operations.',
  },
];

const forgerSkillDefinitions: ForgerSkillDefinition[] = [
  {
    group: 'forger',
    id: 'forger-official-tools',
    description: 'Use official Forger MCP tools without falling back to Codex-local connectors.',
  },
  {
    group: 'forger',
    id: 'forger-gmail',
    description: 'Use Gmail only through the official Forger MCP tools.',
  },
  {
    group: 'forger',
    id: 'forger-permissions',
    description: 'Respect Forger permission prompts for sensitive tools.',
  },
  {
    group: 'forger',
    id: 'forger-manifest-authoring',
    description: 'Write and review Forger app manifests using the current manifest contract.',
  },
  {
    group: 'forger',
    id: 'forger-desktop-runtime-bridge',
    description: 'Call Forger Desktop prompt templates and manifest agents from a local app backend.',
  },
  {
    group: 'forger',
    id: 'forger-automations',
    description: 'Understand scheduled Forger automations for repetitive app-aware agent work.',
  },
  {
    group: 'forger',
    id: 'forger-secrets',
    description: 'Understand app secrets for safe credential sharing through app runtime environments.',
  },
  {
    group: 'forger',
    id: 'forger-agents',
    description: 'Understand app agents for conversational work invoked by apps.',
  },
  {
    group: 'forger',
    id: 'forger-tools',
    description: 'Understand Forger-approved tools and app tool grants.',
  },
  {
    group: 'forger',
    id: 'forger-tasks',
    description: 'Understand one-shot app tasks powered by prompt templates.',
  },
  {
    group: 'forger',
    id: 'forger-app-design-guidelines',
    description: 'Material-grounded UI design guardrails for Forger React/MUI apps.',
  },
  {
    group: 'forger',
    id: 'forger-mui-consistency',
    description: 'Visual consistency and accessibility in MUI.',
  },
  {
    group: 'forger',
    id: 'forger-installed-app-change',
    description: 'Protocol for changing installed Forger apps safely.',
  },
  {
    group: 'forger',
    id: 'forger-python-backend',
    description: 'Best practices for Python backends in Forger.',
  },
  {
    group: 'forger',
    id: 'forger-fastapi-contracts',
    description: 'Guidance for contracts and safety in FastAPI endpoints.',
  },
  {
    group: 'forger',
    id: 'forger-frontend-structure',
    description: 'Feature-first frontend structure for Forger React apps.',
  },
  {
    group: 'forger',
    id: 'forger-mobile-responsive-frontend',
    description: 'Build React/MUI app frontends that work well on mobile and desktop.',
  },
  {
    group: 'forger',
    id: 'forger-remote-tunnel-wiring',
    description: 'Use Forger remote tunnel and local network manifest flags and frontend modules correctly.',
  },
  {
    group: 'forger',
    id: 'forger-react-ui',
    description: 'React UI best practices for non-technical users.',
  },
];

const renderSkillDefinition = (template: ForgerSkillDefinition): ForgerSkillTemplate => ({
  id: template.id,
  description: template.description,
  body: renderPromptFile(`skills/${template.group}/${template.id}.md`, {}),
});

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
    actionsLine,
    gmailInstruction: input.gmailReady
      ? 'When the request is to search, read, download attachments from, or send Gmail, call the matching `gmail.*` tool through the `forger` MCP server and wait for the Forger permission result.'
      : 'If Gmail is requested and unavailable, explain that Gmail must be activated and connected in Forger Tools before Forger can read or send mail.',
  });
};

export const buildGlobalSkillTemplates = (): ForgerSkillTemplate[] =>
  globalSkillDefinitions.map(renderSkillDefinition);

export const buildForgerWorkspaceSkillTemplates = (): ForgerSkillTemplate[] => [
  ...buildGlobalSkillTemplates(),
  ...forgerSkillDefinitions.map(renderSkillDefinition),
];

export const buildInstalledAppSkillTemplates = (allowedOfficialToolActions: string[] = []): ForgerSkillTemplate[] => [
  ...buildGlobalSkillTemplates(),
  buildAppOfficialToolsSkillTemplate(allowedOfficialToolActions),
];

export const buildAppBaseSkillTemplates = buildInstalledAppSkillTemplates;

export const buildAppOfficialToolsSkillTemplate = (allowedOfficialToolActions: string[] = []): ForgerSkillTemplate => ({
  id: 'forger-app-official-tools',
  description: 'Use only official Forger tool actions granted to this installed app.',
  body: renderPromptFile('skills/apps/forger-app-official-tools.md', {
    actionsLine: allowedOfficialToolActions.length > 0
      ? `Available official tool actions for this app: ${allowedOfficialToolActions.map((action) => `\`${action}\``).join(', ')}.`
      : 'This app has not declared any official Forger tool actions.',
  }),
});

export const buildForgerOfficialToolSkillTemplates = (): ForgerSkillTemplate[] =>
  buildForgerWorkspaceSkillTemplates();
