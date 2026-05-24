import { FORGER_AGENT_CONTRACT_MARKER } from './forger-base';
import { renderPromptFile } from './index';

export interface PromptAppManifestService {
  name?: string;
  type?: string;
  port?: number;
  command?: string;
  healthcheck?: string;
  context?: string;
}

export interface PromptAppManifestStackSection {
  language?: string;
  framework?: string;
  package_manager?: string;
  database?: string;
  bundler?: string;
  ui?: string;
}

export interface PromptAppManifestStack {
  backend?: PromptAppManifestStackSection;
  frontend?: PromptAppManifestStackSection;
}

export interface PromptAppManifest {
  name?: string;
  version?: string;
  description?: string;
  stack?: PromptAppManifestStack;
  services?: PromptAppManifestService[];
  mcp?: unknown;
  promptTemplates?: unknown;
  agents?: unknown;
  tools?: unknown;
  appSecrets?: unknown;
  scripts?: Record<string, string>;
  skills?: string[];
}

const hasValidManifestStack = (manifest: PromptAppManifest | null): manifest is PromptAppManifest & { stack: PromptAppManifestStack } => {
  if (!manifest?.stack || typeof manifest.stack !== 'object') {
    return false;
  }
  const backend = manifest.stack.backend && typeof manifest.stack.backend === 'object';
  const frontend = manifest.stack.frontend && typeof manifest.stack.frontend === 'object';
  return Boolean(backend || frontend);
};

const summarizeStack = (stack: PromptAppManifestStack): string[] => {
  const lines: string[] = [];
  const backend = stack.backend;
  const frontend = stack.frontend;

  if (backend) {
    lines.push(
      `Backend: ${[
        backend.language && `language ${backend.language}`,
        backend.framework && `framework ${backend.framework}`,
        backend.package_manager && `package manager ${backend.package_manager}`,
        backend.database && `database ${backend.database}`,
      ]
        .filter(Boolean)
        .join(', ') || 'undefined'}`,
    );
  }

  if (frontend) {
    lines.push(
      `Frontend: ${[
        frontend.language && `language ${frontend.language}`,
        frontend.framework && `framework ${frontend.framework}`,
        frontend.bundler && `bundler ${frontend.bundler}`,
        frontend.ui && `UI ${frontend.ui}`,
      ]
        .filter(Boolean)
        .join(', ') || 'undefined'}`,
    );
  }

  return lines;
};

export const buildForgerAppAgentsMarkdown = (appId: string, manifest: PromptAppManifest | null): string => {
  const stackLines = hasValidManifestStack(manifest) ? summarizeStack(manifest.stack) : [];
  const stackSection = stackLines.length > 0 ? stackLines.map((line) => `- ${line}`).join('\n') : '- Undefined';
  const scriptEntries = manifest?.scripts ? Object.entries(manifest.scripts) : [];
  const scriptsSection =
    scriptEntries.length > 0
      ? scriptEntries.map(([name, command]) => `- ${name}: internal agent tool. Declared command: \`${command}\``)
      : ['- No scripts declared in `manifest.json`.'];
  const hasMcp = Boolean(manifest?.mcp && typeof manifest.mcp === 'object');
  const mcpSection = hasMcp
    ? [
        '- This app declares structured app tools in `manifest.json`.',
        '- Use those tools as the preferred internal interface when the request is to read, expose, create, edit, delete, import, or validate app data.',
        '- Structured app tools are internal tools. Do not present them as visible app commands.',
      ]
    : ['- No structured app tools are declared in `manifest.json`.'];

  return renderPromptFile('agents-md/installed-app.md', {
    forgerContractMarker: FORGER_AGENT_CONTRACT_MARKER,
    appId,
    mcpSection: mcpSection.join('\n'),
    scriptsSection: scriptsSection.join('\n'),
    stackSection,
  });
};
