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

export const buildForgerOfficialToolsPromptSection = (input: ForgerOfficialToolsPromptInput): string => {
  const allowedActions = input.allowedActions ?? [];
  const availabilityLine = input.mode === 'free-chat'
    ? 'Free chat may use official Forger tools directly when the user asks for a global Forger action.'
    : 'App agents may use official Forger tools only when the app context and grants allow the requested action.';
  return [
    '## Forger Official Tools',
    '',
    availabilityLine,
    'Use only tools exposed by the `forger` MCP server. Do not use Codex-local connectors, `codex_apps`, or non-Forger Gmail tools.',
    '',
    `Gmail status: ${input.gmailReady ? 'connected and ready' : 'not connected or not active'}.`,
    allowedActions.length > 0
      ? `Available official tool actions in this context: ${allowedActions.map((action) => `\`${action}\``).join(', ')}.`
      : input.mode === 'free-chat'
        ? 'Free chat can inspect official tool availability through the `forger` MCP server.'
        : 'This app has not declared any official Forger tool actions for its app agent.',
    'Gmail is an official Forger tool, not an installed mail app. Do not require a mail app installation before checking Gmail tool status.',
    'Gmail search, read, and send actions are sensitive. The Forger MCP broker asks for visible user approval when approval is enabled.',
    input.gmailReady
      ? 'When the user asks to search, read, or send Gmail, call the matching `gmail.*` tool through the `forger` MCP server and wait for the Forger permission result.'
      : 'If the user asks for Gmail and it is unavailable, explain that Gmail must be activated and connected in Forger Tools before Forger can read or send mail.',
  ].join('\n');
};

export const buildForgerOfficialToolSkillTemplates = (): ForgerSkillTemplate[] => [
  {
    id: 'forger-official-tools',
    description: 'Use official Forger MCP tools without falling back to Codex-local connectors.',
    body: [
      '---',
      'name: forger-official-tools',
      'description: Use official Forger MCP tools without falling back to Codex-local connectors.',
      '---',
      '',
      '- Official tools live on the `forger` MCP server.',
      '- Do not use Codex-local connectors, `codex_apps`, or non-Forger MCP servers for official Forger actions.',
      '- Treat tool names, MCP server names, and internal paths as implementation details unless the user asks for technical details.',
      '- If a tool is unavailable, explain the missing user-facing setup step in simple language.',
    ].join('\n'),
  },
  {
    id: 'forger-gmail',
    description: 'Use Gmail only through the official Forger MCP tools.',
    body: [
      '---',
      'name: forger-gmail',
      'description: Use Gmail only through the official Forger MCP tools.',
      '---',
      '',
      '- Gmail is an official Forger tool, not an installed mail app.',
      '- Use only these MCP actions on the `forger` server: `gmail.connection.status`, `gmail.search_messages`, `gmail.read_thread`, and `gmail.send_email`.',
      '- Never use `codex_apps`, Codex-local Gmail connectors, browser mail sessions, or personal Codex plugins for Gmail inside Forger.',
      '- Search, read, and send actions may require visible user approval through Forger. If approval is denied or unavailable, stop and explain the action was not completed.',
      '- Do not claim email was read or sent unless the Forger Gmail tool call succeeds.',
    ].join('\n'),
  },
  {
    id: 'forger-permissions',
    description: 'Respect Forger permission prompts for sensitive tools.',
    body: [
      '---',
      'name: forger-permissions',
      'description: Respect Forger permission prompts for sensitive tools.',
      '---',
      '',
      '- Forger, not Codex, owns visible approval for sensitive tools.',
      '- When a Forger tool returns a permission denial, cancellation, or unavailable approval result, do not retry through another connector.',
      '- Continue only after the Forger MCP broker reports that approval was granted.',
      '- Explain permission outcomes in user-facing language.',
    ].join('\n'),
  },
];
