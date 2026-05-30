import { FORGER_AGENT_CONTRACT_VERSION } from './forger-base';
import { optionalSection, renderPromptFile } from './index';

export interface PromptSharedFile {
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  source: 'attached' | 'mentioned';
}

export type ChatPromptTurnKind = 'start' | 'resume';
export type ChatPromptMode = 'create_app' | 'edit_app' | 'free_chat';

const CHAT_MODE_PARTIALS: Record<ChatPromptMode, string> = {
  create_app: 'partials/chat-modes/create-app.md',
  edit_app: 'partials/chat-modes/edit-app.md',
  free_chat: 'partials/chat-modes/free-chat.md',
};

const renderChatModePartial = (mode: ChatPromptMode): string =>
  renderPromptFile(CHAT_MODE_PARTIALS[mode], {});

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
  turnKind?: ChatPromptTurnKind;
  appId: string;
  displayName: string;
  appRoot?: string;
  runRoot?: string;
  appStack?: string;
  runtime?: string;
  networkAccess?: boolean;
  userPrompt: string;
  userLanguage?: string;
  officialToolsContext?: string;
  sharedFiles: PromptSharedFile[];
  sharedFilesRootName: string;
  chatMode?: ChatPromptMode;
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

  const turnKind = params.turnKind ?? 'start';
  const chatMode = params.chatMode ?? 'edit_app';
  const templatePath = turnKind === 'resume' ? 'chat/app-chat-resume.md' : 'chat/app-chat-start.md';
  const commonVariables = {
    chatModeInstructions: renderChatModePartial(chatMode),
    sharedFiles: filesSection.join('\n'),
    userPrompt: params.userPrompt.trim(),
  };

  if (turnKind === 'resume') {
    return renderPromptFile(templatePath, commonVariables);
  }

  return renderPromptFile(templatePath, {
    appId: params.appId,
    displayName: params.displayName,
    appRoot: params.appRoot?.trim() || 'not provided',
    runRoot: params.runRoot?.trim() || params.appRoot?.trim() || 'not provided',
    appStack: params.appStack?.trim() || 'not provided',
    runtime: params.runtime?.trim() || 'not provided',
    networkAccess: typeof params.networkAccess === 'boolean' ? (params.networkAccess ? 'enabled' : 'disabled') : 'not provided',
    forgerContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    userLanguage,
    officialToolsContext: optionalSection(params.officialToolsContext, '\n'),
    ...commonVariables,
  });
};

export const buildCodexPromptForFreeChat = (params: {
  turnKind?: ChatPromptTurnKind;
  userPrompt: string;
  userLanguage?: string;
  officialToolsContext?: string;
  sharedFiles: PromptSharedFile[];
  sharedFilesRootName: string;
  chatMode?: ChatPromptMode;
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

  const turnKind = params.turnKind ?? 'start';
  const chatMode = params.chatMode ?? 'free_chat';
  const templatePath = turnKind === 'resume' ? 'chat/free-chat-resume.md' : 'chat/free-chat-start.md';
  const commonVariables = {
    chatModeInstructions: renderChatModePartial(chatMode),
    sharedFiles: filesSection.join('\n'),
    userPrompt: params.userPrompt.trim(),
  };

  if (turnKind === 'resume') {
    return renderPromptFile(templatePath, commonVariables);
  }

  return renderPromptFile(templatePath, {
    forgerContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    userLanguage,
    forgerPartial: renderPromptFile('partials/forger.md', {}),
    officialToolsContext: optionalSection(params.officialToolsContext, '\n'),
    ...commonVariables,
  });
};
