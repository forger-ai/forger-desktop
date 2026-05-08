import { FORGER_AGENT_CONTRACT_VERSION } from './forger-base';

export interface PromptSharedFile {
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  source: 'attached' | 'mentioned';
}

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

export const buildCodexPromptWithAppContext = (params: {
  appId: string;
  displayName: string;
  userPrompt: string;
  userLanguage?: string;
  officialToolsContext?: string;
  sharedFiles: PromptSharedFile[];
  sharedFilesRootName: string;
}): string => {
  const userLanguage = params.userLanguage?.trim() || 'not configured';
  const filesSection =
    params.sharedFiles.length === 0
      ? ['- No shared files in this message.']
      : params.sharedFiles.map((file) =>
          [
            `- Name: ${file.name}`,
            `  Relative path: ${params.sharedFilesRootName}/${file.relativePath}`,
            `  Size: ${formatBytes(file.sizeBytes)}`,
            `  Modified at: ${file.modifiedAt}`,
            `  Source: ${file.source === 'attached' ? 'attached in this message' : 'mentioned with @'}`,
          ].join('\n'),
        );

  return [
    `SELECTED APP: /${params.appId}`,
    `SELECTED APP NAME: ${params.displayName}`,
    `FORGER CONTRACT: ${FORGER_AGENT_CONTRACT_VERSION}`,
    `USER LANGUAGE: ${userLanguage}`,
    '',
    'Operational instruction: follow the Forger contract in AGENTS.md. Internally classify the request as one allowed task: resolver_dudas, trabajar_datos, interactuar_con_aplicacion, actualizar_aplicacion, or resolver_conflicto_actualizacion.',
    'Prefer replying in the language the user used to write their question. Also consider USER LANGUAGE as the configured application language, especially when the user message is short, mixed-language, or ambiguous.',
    'If the message contains tasks from different categories, handle one per turn. For actualizar_aplicacion, ground the scope in Visual + Flow before changing anything; if the scope is clear, complete the change and answer only with functional impact.',
    params.officialToolsContext?.trim() ? `\n${params.officialToolsContext.trim()}` : '',
    '',
    'SHARED FILES IN THIS MESSAGE:',
    ...filesSection,
    '',
    'USER MESSAGE:',
    params.userPrompt.trim(),
  ].join('\n');
};

export const buildCodexPromptForFreeChat = (params: {
  userPrompt: string;
  userLanguage?: string;
  officialToolsContext?: string;
  sharedFiles: PromptSharedFile[];
  sharedFilesRootName: string;
}): string => {
  const userLanguage = params.userLanguage?.trim() || 'not configured';
  const filesSection =
    params.sharedFiles.length === 0
      ? ['- No shared files in this message.']
      : params.sharedFiles.map((file) =>
          [
            `- Name: ${file.name}`,
            `  Relative path: ${params.sharedFilesRootName}/${file.relativePath}`,
            `  Size: ${formatBytes(file.sizeBytes)}`,
            `  Modified at: ${file.modifiedAt}`,
            `  Source: ${file.source === 'attached' ? 'attached in this message' : 'mentioned with @'}`,
          ].join('\n'),
        );

  return [
    'FORGER CHAT MODE: free chat',
    `FORGER CONTRACT: ${FORGER_AGENT_CONTRACT_VERSION}`,
    `USER LANGUAGE: ${userLanguage}`,
    '',
    'You are Forger chat in free mode. Work from the Forger home workspace.',
    'Do not assume the user is focused on one app. Ask only when the target app or action is ambiguous.',
    'Use Forger MCP tools and available app MCP tools when the user asks to inspect or act across installed apps.',
    'Official Forger tools are not installed apps. Do not reject a Gmail request only because there is no installed mail app.',
    params.officialToolsContext?.trim() ? `\n${params.officialToolsContext.trim()}` : '',
    '',
    'SHARED FILES IN THIS MESSAGE:',
    ...filesSection,
    '',
    'USER MESSAGE:',
    params.userPrompt.trim(),
  ].join('\n');
};
