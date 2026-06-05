import type fs from 'node:fs/promises';
import type { DesktopErrorReportFileSummary, DesktopErrorReportPreview } from '../shared/types';
import { normalizeErrorReportDiagnostic } from '../shared/error-diagnostics';
import { sanitizeReportPayload, type ReportSanitizerRoot } from '../shared/report-sanitizer';

const MAX_APP_ERROR_LOG_BYTES = 512 * 1024;
const MAX_APP_ERROR_LOG_LINES = 80;
const MAX_APP_ERROR_LOG_LINE_CHARS = 8_000;
const DIAGNOSTIC_ATTACHMENT_MAX_CHARS = Number.MAX_SAFE_INTEGER;
const PROMOTED_ARTIFACTS = [
  { key: 'runtimeStatus', kind: 'runtime_status', filename: 'runtime-status.json', contentType: 'application/json' },
  { key: 'appMcpLog', kind: 'app_mcp_log', filename: 'app-mcp.log', contentType: 'text/plain' },
  { key: 'agentRunLog', kind: 'agent_run', filename: 'agent-run.jsonl', contentType: 'application/x-ndjson' },
  { key: 'providerSessionLog', kind: 'provider_session', filename: 'provider-session.jsonl', contentType: 'application/x-ndjson' },
  { key: 'rendererStack', kind: 'renderer_stack', filename: 'renderer-stack.log', contentType: 'text/plain' },
  { key: 'mainStack', kind: 'main_stack', filename: 'main-stack.log', contentType: 'text/plain' },
  { key: 'automationTranscript', kind: 'automation_transcript', filename: 'automation-transcript.log', contentType: 'text/plain' },
] as const;

type FsPromises = typeof fs;

export interface DesktopErrorReportAttachmentUpload extends DesktopErrorReportFileSummary {
  text: string;
}

interface PrepareDesktopErrorReportOptions {
  fs: FsPromises;
  appVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  getInstallLogPath: () => string;
  getDesktopLogPath?: () => string;
  roots: ReportSanitizerRoot[];
}

interface AppInstallLogExcerpt {
  source: 'install.log' | 'forger-desktop.jsonl';
  bytesRead: number;
  truncatedFromStart: boolean;
  lines: string[];
}

export const prepareDesktopErrorReport = async (
  options: PrepareDesktopErrorReportOptions,
  input: DesktopErrorReportPreview,
): Promise<{ report: DesktopErrorReportPreview; attachments: DesktopErrorReportAttachmentUpload[] }> => {
  const normalized = normalizeErrorReportDiagnostic({
    ...input,
    desktopVersion: input.desktopVersion || options.appVersion,
    platform: input.platform || options.platform,
    arch: input.arch || options.arch,
    occurredAt: input.occurredAt || new Date().toISOString(),
  });
  const attachments = await buildDesktopErrorReportAttachments(options, normalized);
  const diagnosticFiles = summarizeDesktopErrorReportAttachments(attachments);
  const cleanedSensitiveDetails = removePromotedSensitiveDetails(normalized.sensitiveDetails);
  const report = sanitizeReportPayload({
    ...normalized,
    sensitiveDetails: cleanedSensitiveDetails,
    diagnosticFiles: diagnosticFiles.length > 0 ? diagnosticFiles : undefined,
  }, { roots: options.roots });
  return {
    report,
    attachments,
  };
};

export const buildDesktopErrorReportAttachments = async (
  options: Pick<PrepareDesktopErrorReportOptions, 'fs' | 'getInstallLogPath' | 'getDesktopLogPath' | 'roots'>,
  input: DesktopErrorReportPreview,
): Promise<DesktopErrorReportAttachmentUpload[]> => {
  const attachments: DesktopErrorReportAttachmentUpload[] = [];
  const desktopLogExcerpt = options.getDesktopLogPath
    ? await readRecentLogLines({
      fs: options.fs,
      logPath: options.getDesktopLogPath(),
      source: 'forger-desktop.jsonl',
    })
    : null;
  if (desktopLogExcerpt) {
    attachments.push(buildLogAttachment({
      excerpt: desktopLogExcerpt,
      roots: options.roots,
      kind: 'desktop_log',
      filename: 'forger-desktop.jsonl',
    }));
  }
  const promotedInstallLog = appInstallLogExcerptFromSensitiveDetails(input.sensitiveDetails);
  const appInstallLogExcerpt = promotedInstallLog
    ?? (input.source === 'app' && input.appId
      ? await readRecentAppInstallLogLines({
        fs: options.fs,
        getInstallLogPath: options.getInstallLogPath,
        appId: input.appId,
      })
      : null);
  if (appInstallLogExcerpt && input.appId) {
    attachments.push(buildAppInstallLogAttachment({
      excerpt: appInstallLogExcerpt,
      roots: options.roots,
    }));
  }
  attachments.push(...promotedArtifactAttachments(input.sensitiveDetails, options.roots));
  return attachments;
};

const readRecentLogLines = async (input: {
  fs: FsPromises;
  logPath: string;
  source: AppInstallLogExcerpt['source'];
}): Promise<AppInstallLogExcerpt | null> => {
  let handle: fs.FileHandle | null = null;
  try {
    const stats = await input.fs.stat(input.logPath);
    const bytesToRead = Math.min(stats.size, MAX_APP_ERROR_LOG_BYTES);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    handle = await input.fs.open(input.logPath, 'r');
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    const rawLines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
    const lines = (start > 0 ? rawLines.slice(1) : rawLines).slice(-MAX_APP_ERROR_LOG_LINES).map(truncateLogLine);
    return lines.length > 0 ? { source: input.source, bytesRead, truncatedFromStart: start > 0, lines } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const summarizeDesktopErrorReportAttachments = (
  attachments: DesktopErrorReportAttachmentUpload[],
): DesktopErrorReportFileSummary[] =>
  attachments.map(({ text: _text, ...summary }) => summary);

export const readRecentAppInstallLogLines = async (input: {
  fs: FsPromises;
  getInstallLogPath: () => string;
  appId: string;
}): Promise<AppInstallLogExcerpt | null> => {
  const logPath = input.getInstallLogPath();
  let handle: fs.FileHandle | null = null;
  try {
    const stats = await input.fs.stat(logPath);
    const bytesToRead = Math.min(stats.size, MAX_APP_ERROR_LOG_BYTES);
    const start = Math.max(0, stats.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    handle = await input.fs.open(logPath, 'r');
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
    const rawLines = buffer
      .subarray(0, bytesRead)
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const candidateLines = start > 0 ? rawLines.slice(1) : rawLines;
    const lines: string[] = [];
    for (let index = candidateLines.length - 1; index >= 0 && lines.length < MAX_APP_ERROR_LOG_LINES; index -= 1) {
      const line = candidateLines[index];
      try {
        const parsed = JSON.parse(line) as { appId?: unknown };
        if (parsed.appId === input.appId) {
          lines.push(truncateLogLine(line));
        }
      } catch {
        // install.log is best-effort diagnostics and can contain partial lines.
      }
    }
    if (lines.length === 0) {
      return null;
    }
    return {
      source: 'install.log',
      bytesRead,
      truncatedFromStart: start > 0,
      lines: lines.reverse(),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const buildAppInstallLogAttachment = (input: {
  excerpt: AppInstallLogExcerpt;
  roots: ReportSanitizerRoot[];
}): DesktopErrorReportAttachmentUpload => {
  return buildLogAttachment({
    excerpt: input.excerpt,
    roots: input.roots,
    kind: 'install_log',
    filename: 'install-log.jsonl',
  });
};

const buildLogAttachment = (input: {
  excerpt: AppInstallLogExcerpt;
  roots: ReportSanitizerRoot[];
  kind: DesktopErrorReportFileSummary['kind'];
  filename: string;
}): DesktopErrorReportAttachmentUpload => {
  const raw = `${input.excerpt.lines.join('\n')}\n`;
  const text = sanitizeReportPayload(raw, {
    roots: input.roots,
    maxStringLength: DIAGNOSTIC_ATTACHMENT_MAX_CHARS,
  });
  return {
    kind: input.kind,
    filename: input.filename,
    contentType: 'application/x-ndjson',
    originalByteSize: Buffer.byteLength(raw, 'utf8'),
    sanitizedByteSize: Buffer.byteLength(text, 'utf8'),
    lineCount: input.excerpt.lines.length,
    truncated: input.excerpt.truncatedFromStart,
    text,
  };
};

const promotedArtifactAttachments = (
  sensitiveDetails: Record<string, unknown> | undefined,
  roots: ReportSanitizerRoot[],
): DesktopErrorReportAttachmentUpload[] => {
  if (!sensitiveDetails) {
    return [];
  }
  return PROMOTED_ARTIFACTS.flatMap((definition) => {
    const rawValue = sensitiveDetails[definition.key];
    const raw = stringifyArtifactValue(rawValue, definition.contentType);
    if (!raw) {
      return [];
    }
    const text = sanitizeReportPayload(raw, {
      roots,
      maxStringLength: DIAGNOSTIC_ATTACHMENT_MAX_CHARS,
    });
    return [{
      kind: definition.kind,
      filename: definition.filename,
      contentType: definition.contentType,
      originalByteSize: Buffer.byteLength(raw, 'utf8'),
      sanitizedByteSize: Buffer.byteLength(text, 'utf8'),
      lineCount: text.split(/\r?\n/).filter((line) => line.length > 0).length,
      text,
    }];
  });
};

const stringifyArtifactValue = (value: unknown, contentType: string): string | null => {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    return value.trim() ? `${value.replace(/\s+$/, '')}\n` : null;
  }
  if (Array.isArray(value) && contentType === 'application/x-ndjson') {
    const lines = value
      .filter((entry) => entry != null)
      .map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry));
    return lines.length > 0 ? `${lines.join('\n')}\n` : null;
  }
  return `${JSON.stringify(value, null, contentType === 'application/json' ? 2 : 0)}\n`;
};

const appInstallLogExcerptFromSensitiveDetails = (
  sensitiveDetails: Record<string, unknown> | undefined,
): AppInstallLogExcerpt | null => {
  const excerpt = sensitiveDetails?.appInstallLogExcerpt;
  if (!excerpt || typeof excerpt !== 'object') {
    return null;
  }
  const record = excerpt as Record<string, unknown>;
  if (!Array.isArray(record.lines)) {
    return null;
  }
  return {
    source: 'install.log',
    bytesRead: typeof record.bytesRead === 'number' ? record.bytesRead : 0,
    truncatedFromStart: record.truncatedFromStart === true,
    lines: record.lines.filter((line): line is string => typeof line === 'string'),
  };
};

const removePromotedSensitiveDetails = (
  sensitiveDetails: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!sensitiveDetails) {
    return undefined;
  }
  const {
    appInstallLogExcerpt: _appInstallLogExcerpt,
    runtimeStatus: _runtimeStatus,
    appMcpLog: _appMcpLog,
    agentRunLog: _agentRunLog,
    providerSessionLog: _providerSessionLog,
    rendererStack: _rendererStack,
    mainStack: _mainStack,
    automationTranscript: _automationTranscript,
    ...remaining
  } = sensitiveDetails;
  return Object.keys(remaining).length > 0 ? remaining : undefined;
};

const truncateLogLine = (line: string): string => {
  if (line.length <= MAX_APP_ERROR_LOG_LINE_CHARS) {
    return line;
  }
  return `${line.slice(0, MAX_APP_ERROR_LOG_LINE_CHARS)}...[truncated ${line.length - MAX_APP_ERROR_LOG_LINE_CHARS} chars]`;
};
