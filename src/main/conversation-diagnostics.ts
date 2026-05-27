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
import { sanitizeId } from './app-agent/conversation-helpers';

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
    ...(input.description ? { description: input.description } : {}),
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
  const providerSession = await buildProviderSession({
    provider: input.provider,
    threadId: input.conversation?.threadId,
    runId: input.runId,
    runLog,
    codexHomeRoots: [
      conversationCodexHome(options.getForgerMetadataRoot(), input.conversation?.appId ?? input.appId ?? 'forger', input.conversationId),
      options.getCodexHome(),
    ],
  });
  return {
    kind: 'desktop_chat',
    appVersion: input.appId ? options.getInstalledAppVersion(input.appId) : undefined,
    conversation: input.conversation ?? {
      title: input.title,
      messages: [],
    },
    rawRunLog: runLog,
    providerSession,
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
  const snapshotRecord = snapshot as Record<string, unknown> | null;
  const conversation = snapshotRecord?.conversation && typeof snapshotRecord.conversation === 'object'
    ? snapshotRecord.conversation as Record<string, unknown>
    : {};
  const providerSession = await buildProviderSession({
    provider: typeof input.provider === 'string'
      ? input.provider
      : typeof (conversation.runtime as Record<string, unknown> | undefined)?.provider === 'string'
        ? (conversation.runtime as Record<string, unknown>).provider as 'codex' | 'claude'
        : undefined,
    threadId: typeof conversation.threadId === 'string' ? conversation.threadId : undefined,
    runId: input.runId || (snapshotRecord?.requestedRunId && typeof snapshotRecord.requestedRunId === 'string' ? snapshotRecord.requestedRunId : undefined),
    runLog: snapshotRecord?.rawRunLog && typeof snapshotRecord.rawRunLog === 'object' ? snapshotRecord.rawRunLog as Record<string, unknown> : null,
    codexHomeRoots: [appAgentConversationCodexHome(options.getForgerMetadataRoot(), appId, input.conversationId)],
  });
  return {
    kind: 'app_agent_conversation',
    appVersion: options.getInstalledAppVersion(appId),
    snapshot: snapshot ?? { unavailable: 'conversation_not_found' },
    providerSession,
  };
};

const appAgentConversationCodexHome = (metadataRoot: string, appId: string, conversationId: string): string =>
  path.join(metadataRoot, 'app-agent-conversations-runtime', sanitizeId(appId), sanitizeId(conversationId), 'codex-home');

const conversationCodexHome = (metadataRoot: string, appId: string, conversationId: string): string =>
  path.join(metadataRoot, 'chat-conversations-runtime', sanitizeId(appId), sanitizeId(conversationId), 'codex-home');

const buildProviderSession = async (input: {
  provider?: string;
  threadId?: string | null;
  runId?: string | null;
  runLog?: Record<string, unknown> | null;
  codexHomeRoots: string[];
}): Promise<Record<string, unknown>> => {
  const provider = input.provider === 'claude' ? 'claude' : input.provider === 'codex' ? 'codex' : undefined;
  const threadId = typeof input.threadId === 'string' && input.threadId.trim() ? input.threadId.trim() : undefined;
  const runId = typeof input.runId === 'string' && input.runId.trim() ? input.runId.trim() : undefined;
  if (provider === 'codex') {
    const transcript = await findCodexSessionTranscript(input.codexHomeRoots, [threadId, runId].filter(Boolean) as string[]);
    return {
      provider,
      threadId,
      runId,
      source: transcript ? 'codex_session_jsonl' : 'codex_session_not_found',
      transcript,
    };
  }
  if (provider === 'claude') {
    return {
      provider,
      threadId,
      runId,
      source: input.runLog ? 'run_log_tail' : 'run_log_not_found',
      transcript: input.runLog ?? null,
    };
  }
  return {
    provider: provider ?? null,
    threadId,
    runId,
    source: 'provider_unknown',
    transcript: input.runLog ?? null,
  };
};

const findCodexSessionTranscript = async (
  roots: string[],
  needles: string[],
): Promise<Record<string, unknown> | null> => {
  for (const root of roots) {
    const files = await listJsonlFiles(path.join(root, 'sessions'));
    for (const filePath of files) {
      const transcript = await readTail(filePath, 220_000);
      const text = typeof transcript?.text === 'string' ? transcript.text : '';
      if (needles.length === 0 || needles.some((needle) => text.includes(needle))) {
        return {
          ...transcript,
          matched: needles.filter((needle) => text.includes(needle)),
        };
      }
    }
  }
  return null;
};

const listJsonlFiles = async (root: string, depth = 0): Promise<string[]> => {
  if (depth > 8) {
    return [];
  }
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const paths = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return await listJsonlFiles(entryPath, depth + 1);
    }
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [entryPath] : [];
  }));
  const files = paths.flat();
  const stats = await Promise.all(files.map(async (filePath) => ({
    filePath,
    mtimeMs: (await fs.stat(filePath).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
  })));
  return stats.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 250).map((entry) => entry.filePath);
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
