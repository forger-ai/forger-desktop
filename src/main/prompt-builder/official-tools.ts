import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionInstance, ConnectionRequirementState, ConnectionTypeDefinition } from '../../shared/types';
import { CONNECTION_DISPLAY_NAMES, isConnectionActionId } from '../../shared/connection-catalog';
import { promptTemplateRoots, renderPromptFile } from './index';

export interface ForgerOfficialToolsPromptInput {
  gmailReady?: boolean;
  whatsappReady?: boolean;
  chromeExtensionReady?: boolean;
  allowedActions?: string[];
  mode: 'free-chat' | 'app-agent';
  connectionRequirements?: ConnectionRequirementState[];
  connectionTypes?: ConnectionTypeDefinition[];
  connectionInstances?: ConnectionInstance[];
}

export interface ForgerSkillTemplate {
  id: string;
  description: string;
  body: string;
  resources?: ForgerSkillTemplateResource[];
}

export interface ForgerSkillTemplateResource {
  path: string;
  content: Buffer;
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

const normalizeSkillResourcePath = (relativePath: string): string => {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized
    || path.isAbsolute(normalized)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || normalized === 'SKILL.md'
    || normalized === 'README.md'
  ) {
    throw new Error(`skill_resource_path_invalid:${relativePath}`);
  }
  return normalized;
};

const listSkillResourceFiles = (root: string, current = root): string[] => {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`skill_resource_symlink:${entryPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...listSkillResourceFiles(root, entryPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizeSkillResourcePath(path.relative(root, entryPath)));
    }
  }
  return files;
};

const readSkillTemplateResources = (group: SkillGroup, filename: string): ForgerSkillTemplateResource[] | undefined => {
  const groupDirectory = resolveSkillGroupDirectory(group);
  const resourceDirectory = path.join(groupDirectory, path.basename(filename, '.md'));
  if (!fs.existsSync(resourceDirectory)) {
    return undefined;
  }
  if (!fs.statSync(resourceDirectory).isDirectory()) {
    throw new Error(`skill_resource_path_invalid:${resourceDirectory}`);
  }
  const resources = listSkillResourceFiles(resourceDirectory).map((resourcePath) => ({
    path: resourcePath,
    content: fs.readFileSync(path.join(resourceDirectory, resourcePath)),
  }));
  return resources.length > 0 ? resources : undefined;
};

const buildSkillTemplateFromFile = (group: SkillGroup, filename: string, variables: Record<string, string> = {}): ForgerSkillTemplate => {
  const relativePath = `skills/${group}/${filename}`;
  const source = fs.readFileSync(path.join(resolveSkillGroupDirectory(group), filename), 'utf8');
  const frontmatter = parseSkillFrontmatter(source, relativePath);
  return {
    id: frontmatter.name,
    description: frontmatter.description,
    body: renderPromptFile(relativePath, variables),
    resources: readSkillTemplateResources(group, filename),
  };
};

const buildSkillTemplatesForGroup = (group: SkillGroup): ForgerSkillTemplate[] =>
  listSkillFiles(group).map((filename) => buildSkillTemplateFromFile(group, filename));

export const isForgerConnectionActionId = (actionId: string): boolean =>
  isConnectionActionId(actionId);

const FALLBACK_CONNECTION_NAMES: Record<string, string> = CONNECTION_DISPLAY_NAMES;

const CONNECTED_STATUSES = new Set(['available', 'connected', 'syncing']);

const formatActions = (actions: string[]): string =>
  actions.length > 0
    ? actions.map((action) => `\`${action}\``).join(', ')
    : 'none granted';

const statusLabel = (instance: ConnectionInstance): string => {
  const suffixes = [
    instance.status,
    instance.isDefault ? 'default' : '',
  ].filter(Boolean);
  return suffixes.length > 0 ? ` (${suffixes.join(', ')})` : '';
};

const identityLabel = (instance: ConnectionInstance): string => {
  const identity = instance.accountIdentity;
  const identityValue = identity?.email
    ?? identity?.phoneNumber
    ?? identity?.workspace
    ?? identity?.username
    ?? identity?.subject
    ?? '';
  return identityValue && identityValue !== instance.label
    ? `${instance.label} - ${identityValue}${statusLabel(instance)}`
    : `${instance.label}${statusLabel(instance)}`;
};

const formatInstances = (instances: ConnectionInstance[]): string =>
  instances.length > 0
    ? instances.map(identityLabel).join('; ')
    : 'no connected account or session';

const displayNameForConnection = (
  type: string,
  definitions: ConnectionTypeDefinition[],
): string =>
  definitions.find((definition) => definition.type === type)?.displayName
  ?? FALLBACK_CONNECTION_NAMES[type]
  ?? type;

const promptConnectionDefinitions = (input: ForgerOfficialToolsPromptInput): ConnectionTypeDefinition[] => {
  if ((input.connectionTypes?.length ?? 0) > 0) {
    return input.connectionTypes ?? [];
  }
  const definitions: ConnectionTypeDefinition[] = [];
  if (typeof input.gmailReady === 'boolean') {
    definitions.push({
      type: 'gmail',
      displayName: 'Gmail',
      description: 'Gmail account connection.',
      setupKind: 'oauth',
      supportsMultiple: true,
      secretsSchema: [],
      statusActionId: 'gmail.connection.status',
      actions: [
        { id: 'gmail.connection.status', name: 'Status', description: 'Check Gmail connection status.', risk: 'low' },
        { id: 'gmail.search_messages', name: 'Search messages', description: 'Search Gmail messages.', risk: 'medium' },
        { id: 'gmail.read_thread', name: 'Read thread', description: 'Read a Gmail thread.', risk: 'medium' },
        { id: 'gmail.read_attachment', name: 'Read attachment', description: 'Read a Gmail attachment.', risk: 'medium' },
        { id: 'gmail.send_email', name: 'Send email', description: 'Send Gmail email.', risk: 'high' },
      ],
    });
  }
  if (typeof input.whatsappReady === 'boolean') {
    definitions.push({
      type: 'whatsapp',
      displayName: 'WhatsApp',
      description: 'WhatsApp session connection.',
      setupKind: 'qr_pairing',
      supportsMultiple: true,
      secretsSchema: [],
      statusActionId: 'whatsapp.connection.status',
      actions: [
        { id: 'whatsapp.connection.status', name: 'Status', description: 'Check WhatsApp connection status.', risk: 'low' },
        { id: 'whatsapp.start_pairing', name: 'Start pairing', description: 'Start WhatsApp pairing.', risk: 'medium' },
        { id: 'whatsapp.list_chats', name: 'List chats', description: 'List WhatsApp chats.', risk: 'medium' },
        { id: 'whatsapp.read_messages', name: 'Read messages', description: 'Read WhatsApp messages.', risk: 'medium' },
        { id: 'whatsapp.download_attachment', name: 'Download attachment', description: 'Download a WhatsApp attachment.', risk: 'medium' },
        { id: 'whatsapp.send_message', name: 'Send message', description: 'Send a WhatsApp message.', risk: 'high' },
        { id: 'whatsapp.get_chat_details', name: 'Get chat details', description: 'Inspect WhatsApp chat details.', risk: 'medium' },
      ],
    });
  }
  return definitions;
};

const promptConnectionInstances = (input: ForgerOfficialToolsPromptInput): ConnectionInstance[] => {
  if ((input.connectionInstances?.length ?? 0) > 0) {
    return input.connectionInstances ?? [];
  }
  const now = new Date(0).toISOString();
  const instances: ConnectionInstance[] = [];
  if (input.gmailReady) {
    instances.push({
      id: 'gmail',
      type: 'gmail',
      label: 'Gmail',
      status: 'connected',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  if (input.whatsappReady) {
    instances.push({
      id: 'whatsapp',
      type: 'whatsapp',
      label: 'WhatsApp',
      status: 'connected',
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return instances;
};

const buildFreeChatConnectionsLine = (
  definitions: ConnectionTypeDefinition[],
  instances: ConnectionInstance[],
): string => {
  if (definitions.length === 0) {
    return 'Connections available in this context: none listed. Do not claim external account actions are available until Forger lists or grants that Connection.';
  }
  return [
    'Connections available in this context:',
    ...definitions.map((definition) => {
      const typeInstances = instances.filter((instance) => instance.type === definition.type);
      const connected = typeInstances.some((instance) => CONNECTED_STATUSES.has(instance.status));
      return `- ${definition.displayName}: ${connected ? 'connected' : 'not connected or needs setup'}; accounts/sessions: ${formatInstances(typeInstances)}; status action: \`${definition.statusActionId}\`; supports multiple: ${definition.supportsMultiple ? 'yes' : 'no'}.`;
    }),
  ].join('\n');
};

const buildAppConnectionsLine = (
  requirements: ConnectionRequirementState[],
  definitions: ConnectionTypeDefinition[],
): string => {
  if (requirements.length === 0) {
    return 'This app has not declared any Connections. Do not claim external account, workspace, or connected-service access for this app.';
  }
  return [
    'Declared app Connections:',
    ...requirements.map((requirement) => {
      const declaration = requirement.declaration;
      const displayName = requirement.definition?.displayName ?? displayNameForConnection(declaration.type, definitions);
      const actions = requirement.resolvedActions.map((action) => action.id);
      const grantState = requirement.granted ? 'granted' : 'not granted';
      const configuredState = requirement.configured ? 'configured' : 'not configured';
      const reviewState = requirement.reviewNeeded ? '; grant review needed before new actions are available' : '';
      return `- ${requirement.required ? 'Required' : 'Optional'} ${displayName}: ${grantState}; ${configuredState}; actions: ${formatActions(actions)}; multiple allowed: ${declaration.multiple ? 'yes' : 'no'}; accounts/sessions: ${formatInstances(requirement.instances)}${reviewState}. Reason: ${declaration.reason}`;
    }),
  ].join('\n');
};

const connectionStatusGuidance = (
  mode: ForgerOfficialToolsPromptInput['mode'],
): string =>
  mode === 'free-chat'
    ? 'Before using a Connection action, check the matching `*.connection.status` action when account/session state is unclear. Do not claim external account access unless the Connection is granted and connected, except for status or setup actions that Forger exposes.'
    : 'Before an app agent uses a Connection action, check the matching `*.connection.status` action when state is unclear. If multiple accounts or sessions are allowed and the selected account is ambiguous, ask for the intended account/session instead of guessing. Sensitive sends, creates, attachment reads, and external writes still require visible approval when Forger asks.';

export const buildForgerOfficialToolsPromptSection = (input: ForgerOfficialToolsPromptInput): string => {
  const allowedActions = input.allowedActions ?? [];
  const forgerToolActions = allowedActions.filter((action) => !isForgerConnectionActionId(action));
  const connectionActions = allowedActions.filter(isForgerConnectionActionId);
  const connectionDefinitions = promptConnectionDefinitions(input);
  const connectionInstances = promptConnectionInstances(input);
  const availabilityLine = input.mode === 'free-chat'
    ? 'Free chat may use Forger Tools for global Forger actions and may use Connections only when Forger exposes or grants the requested connection action.'
    : 'App agents may use Forger Tools and Connections only when the selected app context and grants allow the requested action.';
  const forgerToolActionsLine = forgerToolActions.length > 0
    ? `Available Forger Tool actions in this context: ${formatActions(forgerToolActions)}.`
    : input.mode === 'free-chat'
      ? 'Free chat can inspect Forger Tool availability through the `forger` MCP server.'
      : 'This app has not declared any Forger Tool actions for its app agent.';
  const connectionActionsLine = connectionActions.length > 0
    ? `Available Connection actions in this context: ${formatActions(connectionActions)}.`
    : input.mode === 'free-chat'
      ? 'No external account action ids are listed for free chat in this context.'
      : 'No Connection action ids are granted for this app context.';
  const connectionsLine = input.mode === 'free-chat'
    ? buildFreeChatConnectionsLine(connectionDefinitions, connectionInstances)
    : buildAppConnectionsLine(input.connectionRequirements ?? [], connectionDefinitions);

  return renderPromptFile('partials/official-tools.md', {
    availabilityLine,
    chromeExtensionStatus: input.chromeExtensionReady ? 'connected and ready' : 'not connected or not active',
    forgerToolActionsLine,
    connectionActionsLine,
    connectionsLine,
    connectionStatusGuidance: connectionStatusGuidance(input.mode),
    chromeExtensionInstruction: input.chromeExtensionReady
      ? 'When the request needs a real external browser session, call `forger_chrome_extension.open_dedicated_tab`, then use the returned session id for navigation, inspection, selector waits, click, focus, hover, input, form submit, style inspection, visual highlighting, URL read, and close actions. Do not use Chrome Extension for installed app frontend/backend runtime URLs.'
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
      ? `Available Forger Tool and Connection actions for this app: ${allowedOfficialToolActions.map((action) => `\`${action}\``).join(', ')}.`
      : 'This app has not declared any Forger Tool or Connection actions.',
  }),
});

export const buildForgerOfficialToolSkillTemplates = (): ForgerSkillTemplate[] =>
  buildForgerWorkspaceSkillTemplates();
