import type { AgentProvider, ChatErrorCode } from '../../shared/types';

export interface ProviderQuotaErrorInfo {
  chatCode: ChatErrorCode;
  message: string;
}

export interface ProviderModelUnsupportedErrorInfo {
  chatCode: ChatErrorCode;
  message: string;
  model: string;
}

export const detectProviderQuotaError = (
  provider: AgentProvider,
  ...texts: Array<string | null | undefined>
): ProviderQuotaErrorInfo | null => {
  const combined = texts
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n');
  if (!combined) {
    return null;
  }

  const providerMatched = provider === 'antigravity'
    ? /RESOURCE_EXHAUSTED|Individual quota reached|model unreachable|code\s*429|HTTP\s*429|Too Many Requests/i.test(combined)
    : /\b(?:rate\s*limit(?:ed| reached| exceeded)?|quota\s+(?:exceeded|reached)|usage\s+limit|too many requests|HTTP\s*429|status(?:\s+code)?\s*429|code\s*429)\b/i.test(combined);
  if (!providerMatched) {
    return null;
  }

  const resetHint = extractResetHint(combined);
  const providerName = provider === 'antigravity'
    ? 'Google Antigravity'
    : provider === 'codex'
      ? 'Codex'
      : 'Claude Code';
  return {
    chatCode: 'quota_exceeded',
    message: `${providerName} quota exceeded${resetHint ? `; resets ${resetHint}` : ''}`,
  };
};

export const createProviderQuotaError = (info: ProviderQuotaErrorInfo): Error => {
  const error = new Error(info.message);
  (error as Error & { chatCode?: ChatErrorCode }).chatCode = info.chatCode;
  return error;
};

export const detectProviderModelUnsupportedError = (
  provider: AgentProvider,
  ...texts: Array<string | null | undefined>
): ProviderModelUnsupportedErrorInfo | null => {
  const combined = texts
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n');
  if (!combined) {
    return null;
  }

  const model = extractUnsupportedModel(combined);
  if (!model) {
    return null;
  }

  const providerName = provider === 'antigravity'
    ? 'Google Antigravity'
    : provider === 'claude'
      ? 'Claude Code'
      : 'Codex';
  return {
    chatCode: 'model_unsupported',
    message: `${providerName} model unsupported: ${model}`,
    model,
  };
};

const extractResetHint = (text: string): string => {
  const match =
    text.match(/\bResets?\s+in\s+([^\n.]+)/i) ??
    text.match(/\breset(?:s|ting)?\s+(?:in|at)\s+([^\n.]+)/i);
  return match?.[1]?.trim() ?? '';
};

const extractUnsupportedModel = (text: string): string => {
  if (!/\bmodel\b/i.test(text) || !/\b(?:not\s+supported|unsupported)\b/i.test(text)) {
    return '';
  }
  return text.match(/The\s+['"`]([^'"`\n]+)['"`]\s+model\s+is\s+not\s+supported/i)?.[1]?.trim()
    ?? text.match(/model\s+['"`]([^'"`\n]+)['"`]\s+is\s+not\s+supported/i)?.[1]?.trim()
    ?? text.match(/model\s+([A-Za-z0-9._:-]+)\s+(?:is\s+)?(?:not\s+supported|unsupported)/i)?.[1]?.trim()
    ?? '';
};
