export interface FailureDiagnosticFields {
  technicalCode?: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}

interface BuildFailureDiagnosticInput extends FailureDiagnosticFields {
  fallbackCode: string;
  error?: unknown;
  rawError?: string;
}

interface ErrorReportLike extends FailureDiagnosticFields {
  source?: string;
  operation?: string;
}

const MAX_STABLE_TECHNICAL_CODE_LENGTH = 120;

export const isStableTechnicalCode = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim();
  if (/^command_failed_(?:null|\d+)$/i.test(normalized)) {
    return false;
  }
  return (
    normalized.length > 0
    && normalized.length <= MAX_STABLE_TECHNICAL_CODE_LENGTH
    && /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.-]+)?$/.test(normalized)
  );
};

export const buildFailureDiagnostic = (input: BuildFailureDiagnosticInput): FailureDiagnosticFields => {
  const rawTechnicalCode = typeof input.technicalCode === 'string' ? input.technicalCode.trim() : '';
  const errorMessage = errorMessageText(input.error);
  const rawError = input.rawError ?? errorMessage;
  const stack = input.error instanceof Error ? input.error.stack : undefined;
  const classificationText = [rawTechnicalCode, rawError, stack, commandFailureOutputText(input.error)].filter(Boolean).join('\n');
  const classified = classifyTechnicalCode(classificationText, input.fallbackCode);
  const technicalCode = isStableTechnicalCode(rawTechnicalCode) ? rawTechnicalCode : classified.technicalCode;
  const sensitiveDetails = compactRecord({
    ...(input.sensitiveDetails ?? {}),
    ...(!rawTechnicalCode || isStableTechnicalCode(rawTechnicalCode) ? {} : { rawTechnicalCode }),
    ...(rawError && !isStableTechnicalCode(rawError) ? { rawError } : {}),
    ...(stack ? { stack } : {}),
    ...commandFailureSensitiveDetails(input.error),
  });
  const details = compactRecord({
    ...(input.details ?? {}),
    ...classified.details,
    ...commandFailureDetails(input.error),
  });

  return {
    technicalCode,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(Object.keys(sensitiveDetails).length > 0 ? { sensitiveDetails } : {}),
  };
};

export const normalizeErrorReportDiagnostic = <T extends ErrorReportLike>(input: T): T => {
  if (!input.technicalCode || isStableTechnicalCode(input.technicalCode)) {
    return input;
  }
  const diagnostic = buildFailureDiagnostic({
    fallbackCode: fallbackCodeForReport(input),
    technicalCode: input.technicalCode,
    details: input.details,
    sensitiveDetails: input.sensitiveDetails,
  });
  return {
    ...input,
    technicalCode: diagnostic.technicalCode,
    details: diagnostic.details,
    sensitiveDetails: diagnostic.sensitiveDetails,
  };
};

const classifyTechnicalCode = (
  text: string,
  fallbackCode: string,
): { technicalCode: string; details?: Record<string, unknown> } => {
  if (/env:\s*node:\s*No such file or directory/i.test(text)) {
    return {
      technicalCode: 'codex_node_runtime_missing',
      details: { classifier: 'codex_node_runtime_missing' },
    };
  }

  if (/401\s+Unauthorized/i.test(text) && /refresh token|Failed to refresh token/i.test(text)) {
    return {
      technicalCode: 'codex_auth_expired',
      details: { classifier: 'codex_auth_expired' },
    };
  }

  if (/Fatal process out of memory/i.test(text) && /Failed to reserve virtual memory for CodeRange/i.test(text)) {
    return {
      technicalCode: 'node_fatal_oom_code_range',
      details: { classifier: 'node_fatal_oom_code_range' },
    };
  }

  if (/\bcommand_timeout\b|CommandTimeoutError/i.test(text)) {
    return {
      technicalCode: 'command_timeout',
      details: { classifier: 'command_timeout' },
    };
  }

  if (
    /antigravity/i.test(text)
    && /(?:being used by another process|utilizado en otro proceso|obtener acceso al archivo|Remove-Item)/i.test(text)
  ) {
    return {
      technicalCode: 'antigravity_cli_install_concurrent_file_lock',
      details: { classifier: 'antigravity_cli_install_concurrent_file_lock' },
    };
  }

  const commandMatch = text.match(/\bcommand_failed_([^:\s]+)(?::|\b)/i);
  if (commandMatch) {
    return {
      technicalCode: 'command_failed',
      details: { exitCode: commandMatch[1] === 'null' ? null : commandMatch[1], classifier: 'command_failed' },
    };
  }

  if (
    /flattenSingleTopLevelDirectory|moveFlattenChild|flatten:move_fallback|operation['"]?:\s*['"]flatten/i.test(text)
    && /\b(?:EPERM|EACCES|ENOTEMPTY|EEXIST)\b/.test(text)
  ) {
    return {
      technicalCode: 'install_extract_flatten_failed',
      details: {
        classifier: 'install_extract_flatten_failed',
        operation: 'flatten',
        ...flattenRenameDetails(text),
      },
    };
  }

  if (/\bENOTEMPTY\b/.test(text)) {
    return { technicalCode: 'filesystem_enotempty', details: { classifier: 'filesystem_enotempty' } };
  }

  return { technicalCode: isStableTechnicalCode(fallbackCode) ? fallbackCode : 'desktop_error' };
};

const flattenRenameDetails = (text: string): Record<string, unknown> => {
  const match = text.match(/\b(?:rename|copyfile|cp)\s+'([^']+)'\s+->\s+'([^']+)'/i);
  if (!match) {
    return {};
  }
  return {
    errorCode: text.match(/\b(EPERM|EACCES|ENOTEMPTY|EEXIST)\b/)?.[1],
    sourceName: basenameLike(match[1]),
    targetName: basenameLike(match[2]),
  };
};

const basenameLike = (value: string): string => {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? value;
};

const fallbackCodeForReport = (input: ErrorReportLike): string => {
  const source = sanitizeCodePart(input.source) || 'desktop';
  const operation = sanitizeCodePart(input.operation) || 'error';
  return `${source}_${operation}_failed`;
};

const sanitizeCodePart = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : '';

const errorMessageText = (error: unknown): string | undefined => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return undefined;
};

const commandFailureDetails = (error: unknown): Record<string, unknown> => {
  if (!isRecord(error)) {
    return {};
  }
  return compactRecord({
    exitCode: error.exitCode,
    signal: error.signal,
  });
};

const commandFailureSensitiveDetails = (error: unknown): Record<string, unknown> => {
  if (!isRecord(error)) {
    return {};
  }
  return compactRecord({
    command: error.command,
    args: error.args,
    cwd: error.cwd,
    timeoutMs: error.timeoutMs,
    stdout: error.stdout,
    stderr: error.stderr,
  });
};

const commandFailureOutputText = (error: unknown): string | undefined => {
  if (!isRecord(error)) {
    return undefined;
  }
  return [error.stdout, error.stderr].filter((entry): entry is string => typeof entry === 'string').join('\n') || undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';

const compactRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''));
