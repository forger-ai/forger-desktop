import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversationDiagnosticReportPreview,
  PrepareConversationDiagnosticReportInput,
} from '../shared/types';
import { sanitizeReportPayload, type ReportSanitizerRoot } from '../shared/report-sanitizer';
import type { AppAgentConversationManager } from './app-agent-conversation-manager';
import { getRunLogPath } from './chat/progress-errors';

interface BuildConversationDiagnosticOptions {
  appVersion: string;
  platform: NodeJS.Platform;
  getUserDataPath: () => string;
  getForgerHomeRoot: () => string;
  getPrivateAppsRoot: () => string;
  getPrivateDataRoot: () => string;
  getForgerMetadataRoot: () => string;
  getCodexHome: () => string;
  getInstalledAppVersion: (appId: string) => string | undefined;
  getConversationManager: () => AppAgentConversationManager | null;
}

export const reportSanitizerRoots = (options: Omit<BuildConversationDiagnosticOptions, 'appVersion' | 'platform' | 'getInstalledAppVersion' | 'getConversationManager'>, appId?: string): ReportSanitizerRoot[] => {
  const privateAppsRoot = options.getPrivateAppsRoot();
  return [
    { alias: 'FORGER_HOME/', path: options.getForgerHomeRoot() },
    { alias: 'FORGER_APPS/', path: privateAppsRoot },
    ...(appId ? [{ alias: `FORGER_APPS/${appId}/`, path: path.join(privateAppsRoot, appId) }] : []),
    { alias: 'FORGER_DATA/', path: options.getPrivateDataRoot() },
    { alias: 'FORGER_METADATA/', path: options.getForgerMetadataRoot() },
    { alias: 'DESKTOP_USER_DATA/', path: options.getUserDataPath() },
    { alias: 'CODEX_HOME/', path: options.getCodexHome() },
  ];
};

export const buildConversationDiagnosticReport = async (
  options: BuildConversationDiagnosticOptions,
  input: PrepareConversationDiagnosticReportInput,
): Promise<ConversationDiagnosticReportPreview> => {
  const occurredAt = new Date().toISOString();
  const appId = input.appId || input.conversation?.appId;
  const roots = reportSanitizerRoots(options, appId);
  const payload = input.source === 'app_agent_conversation'
    ? await buildAppAgentPayload(options, input)
    : await buildDesktopChatPayload(options, input);
  return sanitizeReportPayload({
    source: input.source,
    ...(appId ? { appId } : {}),
    conversationId: input.conversationId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.technicalCode ? { technicalCode: input.technicalCode } : {}),
    desktopVersion: options.appVersion,
    platform: options.platform,
    occurredAt,
    payload,
  }, { roots });
};

const buildDesktopChatPayload = async (
  options: BuildConversationDiagnosticOptions,
  input: PrepareConversationDiagnosticReportInput,
): Promise<Record<string, unknown>> => {
  const runLog = input.runId ? await readTail(getRunLogPath(options.getForgerMetadataRoot(), input.runId)) : null;
  return {
    kind: 'desktop_chat',
    appVersion: input.appId ? options.getInstalledAppVersion(input.appId) : undefined,
    conversation: input.conversation ?? {
      title: input.title,
      messages: [],
    },
    rawRunLog: runLog,
  };
};

const buildAppAgentPayload = async (
  options: BuildConversationDiagnosticOptions,
  input: PrepareConversationDiagnosticReportInput,
): Promise<Record<string, unknown>> => {
  const appId = input.appId || input.conversation?.appId;
  const manager = options.getConversationManager();
  if (!appId || !manager) {
    return { kind: 'app_agent_conversation', unavailable: 'conversation_manager_missing' };
  }
  const snapshot = await manager.getDiagnosticSnapshot(appId, input.conversationId, input.runId);
  return {
    kind: 'app_agent_conversation',
    appVersion: options.getInstalledAppVersion(appId),
    snapshot: snapshot ?? { unavailable: 'conversation_not_found' },
  };
};

const readTail = async (filePath: string, maxBytes = 180_000): Promise<Record<string, unknown> | null> => {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) {
    return null;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return {
      path: filePath,
      bytesRead: buffer.length,
      truncatedFromStart: start > 0,
      text: buffer.toString('utf8'),
      home: os.homedir(),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
};
