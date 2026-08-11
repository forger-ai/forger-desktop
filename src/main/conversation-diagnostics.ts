import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ConversationDiagnosticFileSummary,
  ConversationDiagnosticReportPreview,
  PrepareConversationDiagnosticReportInput,
} from '../shared/types';
import { sanitizeReportPayload, type ReportSanitizerRoot } from '../shared/report-sanitizer';
import type { AppAgentConversationManager } from './app-agent-conversation-manager';
import { getRunLogPath } from './chat/progress-errors';
import { sanitizeId } from './app-agent/conversation-helpers';

const CODEX_SESSION_TRANSCRIPT_TAIL_BYTES = 220_000;
const CODEX_SESSION_MATCH_HEAD_BYTES = 64_000;
const DIAGNOSTIC_ATTACHMENT_MAX_CHARS = Number.MAX_SAFE_INTEGER;

export interface ConversationDiagnosticAttachmentUpload extends ConversationDiagnosticFileSummary {
  text: string;
}

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
    : input.source === 'personal_agent_conversation'
      ? await buildPersonalAgentPayload(options, input)
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
    rawRunLog: summarizeTextArtifact(runLog),
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
        ? (conversation.runtime as Record<string, unknown>).provider as string
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

const buildPersonalAgentPayload = async (
  options: BuildConversationDiagnosticOptions,
  input: PrepareConversationDiagnosticReportInput,
): Promise<Record<string, unknown>> => {
  const provider = input.provider ?? providerFromRuntime(input.conversation?.runtime);
  const runLog = input.runId ? await readTail(personalAgentRunLogPath(options.getForgerMetadataRoot(), input.runId)) : null;
  const antigravityLog = provider === 'antigravity' && input.runId && input.personalAgent?.id
    ? await readTail(personalAgentAntigravityLogPath(options.getForgerHomeRoot(), input.personalAgent.id, input.runId))
    : null;
  const providerSession = await buildProviderSession({
    provider,
    threadId: input.conversation?.threadId,
    runId: input.runId,
    runLog,
    antigravityLog,
    codexHomeRoots: [
      ...(input.personalAgent?.id
        ? [personalAgentCodexHome(options.getForgerMetadataRoot(), input.personalAgent.id, input.conversationId)]
        : []),
      options.getCodexHome(),
    ],
  });
  return {
    kind: 'personal_agent_conversation',
    personalAgent: input.personalAgent ?? null,
    conversation: input.conversation ?? {
      title: input.title,
      messages: [],
    },
    run: input.run ?? (input.runId ? { id: input.runId } : null),
    rawRunLog: summarizeTextArtifact(runLog),
    antigravityRunLog: summarizeTextArtifact(antigravityLog),
    providerSession,
  };
};

const appAgentConversationCodexHome = (metadataRoot: string, appId: string, conversationId: string): string =>
  path.join(metadataRoot, 'app-agent-conversations-runtime', sanitizeId(appId), sanitizeId(conversationId), 'codex-home');

const conversationCodexHome = (metadataRoot: string, appId: string, conversationId: string): string =>
  path.join(metadataRoot, 'chat-conversations-runtime', sanitizeId(appId), sanitizeId(conversationId), 'codex-home');

const personalAgentCodexHome = (metadataRoot: string, agentId: string, conversationId: string): string =>
  path.join(metadataRoot, 'personal-agent-codex-home', sanitizeId(agentId), sanitizeId(conversationId));

const personalAgentRunLogPath = (metadataRoot: string, runId: string): string =>
  getRunLogPath(path.join(metadataRoot, 'personal-agents'), runId);

const personalAgentAntigravityLogPath = (forgerHomeRoot: string, agentId: string, runId: string): string =>
  path.join(forgerHomeRoot, 'agents', sanitizeId(agentId), 'workspace', '.forger', 'tmp', `antigravity-${sanitizeId(runId)}.log`);

const providerFromRuntime = (runtime?: Record<string, unknown>): string | undefined =>
  typeof runtime?.provider === 'string' ? runtime.provider : undefined;

const buildProviderSession = async (input: {
  provider?: string;
  threadId?: string | null;
  runId?: string | null;
  runLog?: Record<string, unknown> | null;
  antigravityLog?: Record<string, unknown> | null;
  codexHomeRoots: string[];
}): Promise<Record<string, unknown>> => {
  const provider = input.provider === 'claude'
    ? 'claude'
    : input.provider === 'codex'
      ? 'codex'
      : input.provider === 'antigravity'
        ? 'antigravity'
        : undefined;
  const threadId = typeof input.threadId === 'string' && input.threadId.trim() ? input.threadId.trim() : undefined;
  const runId = typeof input.runId === 'string' && input.runId.trim() ? input.runId.trim() : undefined;
  if (provider === 'codex') {
    const transcript = await findCodexSessionTranscript(input.codexHomeRoots, [threadId, runId].filter(Boolean) as string[]);
    return {
      provider,
      threadId,
      runId,
      source: transcript ? 'codex_session_jsonl' : 'codex_session_not_found',
      transcript: summarizeTextArtifact(transcript),
    };
  }
  if (provider === 'claude') {
    return {
      provider,
      threadId,
      runId,
      source: input.runLog ? 'run_log' : 'run_log_not_found',
      transcript: summarizeTextArtifact(input.runLog),
    };
  }
  if (provider === 'antigravity') {
    return {
      provider,
      threadId,
      runId,
      source: input.antigravityLog ? 'antigravity_run_log' : input.runLog ? 'run_log' : 'run_log_not_found',
      transcript: summarizeTextArtifact(input.antigravityLog ?? input.runLog),
    };
  }
  return {
    provider: provider ?? null,
    threadId,
    runId,
    source: 'provider_unknown',
    transcript: summarizeTextArtifact(input.runLog),
  };
};

export const buildConversationDiagnosticAttachments = async (
  options: BuildConversationDiagnosticOptions,
  input: PrepareConversationDiagnosticReportInput,
): Promise<ConversationDiagnosticAttachmentUpload[]> => {
  const appId = input.appId || input.conversation?.appId;
  const roots = reportSanitizerRoots(options, appId);
  const provider = input.provider ?? providerFromRuntime(input.conversation?.runtime);
  const attachments: ConversationDiagnosticAttachmentUpload[] = [];
  if (input.runId) {
    const runLogPath = input.source === 'personal_agent_conversation'
      ? personalAgentRunLogPath(options.getForgerMetadataRoot(), input.runId)
      : getRunLogPath(options.getForgerMetadataRoot(), input.runId);
    const runLog = await buildAttachmentFromFile({
      filePath: runLogPath,
      kind: provider === 'claude' ? 'claude_run_log' : 'run_log',
      filename: safeDiagnosticFilename(`run-log-${input.runId}.log`),
      contentType: 'text/plain',
      roots,
    });
    if (runLog) {
      attachments.push(runLog);
    }
  }

  if (provider === 'codex') {
    const codexHome = input.source === 'app_agent_conversation'
      ? appAgentConversationCodexHome(options.getForgerMetadataRoot(), input.appId ?? appId ?? 'forger', input.conversationId)
      : input.source === 'personal_agent_conversation' && input.personalAgent?.id
        ? personalAgentCodexHome(options.getForgerMetadataRoot(), input.personalAgent.id, input.conversationId)
        : conversationCodexHome(
          options.getForgerMetadataRoot(),
          input.conversation?.appId ?? input.appId ?? 'forger',
          input.conversationId,
        );
    const codexFilePath = await findCodexSessionFile([
      codexHome,
      options.getCodexHome(),
    ], [input.conversation?.threadId, input.runId].filter(Boolean) as string[]);
    if (codexFilePath) {
      const codexSession = await buildAttachmentFromFile({
        filePath: codexFilePath,
        kind: 'codex_session_jsonl',
        filename: safeDiagnosticFilename(`codex-session-${input.conversation?.threadId ?? input.runId ?? 'conversation'}.jsonl`),
        contentType: 'application/x-ndjson',
        roots,
      });
      if (codexSession) {
        attachments.push(codexSession);
      }
    }
  }

  if (input.source === 'personal_agent_conversation' && provider === 'antigravity' && input.runId && input.personalAgent?.id) {
    const antigravityLog = await buildAttachmentFromFile({
      filePath: personalAgentAntigravityLogPath(options.getForgerHomeRoot(), input.personalAgent.id, input.runId),
      kind: 'antigravity_run_log',
      filename: safeDiagnosticFilename(`antigravity-run-log-${input.runId}.log`),
      contentType: 'text/plain',
      roots,
    });
    if (antigravityLog) {
      attachments.push(antigravityLog);
    }
  }

  return attachments;
};

export const summarizeConversationDiagnosticAttachments = (
  attachments: ConversationDiagnosticAttachmentUpload[],
): ConversationDiagnosticFileSummary[] =>
  attachments.map(({ text: _text, ...summary }) => summary);

const findCodexSessionTranscript = async (
  roots: string[],
  needles: string[],
): Promise<Record<string, unknown> | null> => {
  const filePath = await findCodexSessionFile(roots, needles);
  if (!filePath) {
    return null;
  }
  const transcript = await readTail(filePath, CODEX_SESSION_TRANSCRIPT_TAIL_BYTES);
  const text = typeof transcript?.text === 'string' ? transcript.text : '';
  const matchedFromPathOrTail = matchNeedles(needles, [filePath, text]);
  const matched = matchedFromPathOrTail.length > 0
    ? matchedFromPathOrTail
    : matchNeedles(needles, [await readHeadText(filePath, CODEX_SESSION_MATCH_HEAD_BYTES)]);
  return {
    ...transcript,
    matched,
  };
};

const findCodexSessionFile = async (
  roots: string[],
  needles: string[],
): Promise<string | null> => {
  for (const root of roots) {
    const files = await listJsonlFiles(path.join(root, 'sessions'));
    for (const filePath of files) {
      const transcript = await readTail(filePath, CODEX_SESSION_TRANSCRIPT_TAIL_BYTES);
      const text = typeof transcript?.text === 'string' ? transcript.text : '';
      const matchedFromPathOrTail = matchNeedles(needles, [filePath, text]);
      const matched = matchedFromPathOrTail.length > 0
        ? matchedFromPathOrTail
        : matchNeedles(needles, [await readHeadText(filePath, CODEX_SESSION_MATCH_HEAD_BYTES)]);
      if (needles.length === 0 || matched.length > 0) {
        return filePath;
      }
    }
  }
  return null;
};

const matchNeedles = (needles: string[], haystacks: string[]): string[] =>
  needles.filter((needle) => haystacks.some((haystack) => haystack.includes(needle)));

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

const readHeadText = async (filePath: string, maxBytes: number): Promise<string> => {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) {
    return '';
  }
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const summarizeTextArtifact = (artifact: Record<string, unknown> | null | undefined): Record<string, unknown> | null => {
  if (!artifact) {
    return null;
  }
  const { text: _text, home: _home, ...summary } = artifact;
  return summary;
};

const buildAttachmentFromFile = async (input: {
  filePath: string;
  kind: ConversationDiagnosticAttachmentUpload['kind'];
  filename: string;
  contentType: string;
  roots: ReportSanitizerRoot[];
}): Promise<ConversationDiagnosticAttachmentUpload | null> => {
  const raw = await fs.readFile(input.filePath, 'utf8').catch(() => null);
  if (raw === null) {
    return null;
  }
  const text = sanitizeReportPayload(raw, {
    roots: input.roots,
    maxStringLength: DIAGNOSTIC_ATTACHMENT_MAX_CHARS,
  });
  return {
    kind: input.kind,
    filename: input.filename,
    contentType: input.contentType,
    originalByteSize: Buffer.byteLength(raw, 'utf8'),
    sanitizedByteSize: Buffer.byteLength(text, 'utf8'),
    text,
  };
};

const safeDiagnosticFilename = (value: string): string =>
  // Internal callers always prefix filenames with a non-empty diagnostic kind.
  value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160);
