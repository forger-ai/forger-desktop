import type { AgentProvider, ChatErrorCode } from '../../shared/types';
import { classifyCodexAuthOutput } from '../codex-auth-helpers';
import { detectProviderModelUnsupportedError, detectProviderQuotaError } from '../llm-provider/provider-errors';

const codexTimeoutPattern = /\btimed out(?:\s+due to inactivity)?\s+after\b|codex_timeout_after_/i;

export const buildProviderRunFailureError = (
  provider: AgentProvider,
  stdout: string,
  stderr: string,
  fallbackMessage = `${provider}_exec_failed`,
): Error => {
  const message = (stderr || stdout || fallbackMessage).trim() || fallbackMessage;
  const authFailure = provider === 'codex' ? classifyCodexAuthOutput(stdout, stderr) : undefined;
  const modelUnsupportedFailure = detectProviderModelUnsupportedError(provider, stdout, stderr, message);
  const quotaFailure = detectProviderQuotaError(provider, stdout, stderr, message);
  const chatCode: ChatErrorCode | null = provider === 'codex' && authFailure === 'codex_auth_expired'
    ? 'codex_auth_expired'
    : codexTimeoutPattern.test(message)
      ? 'timeout'
      : modelUnsupportedFailure
        ? 'model_unsupported'
        : quotaFailure
          ? 'quota_exceeded'
          : null;
  const error = new Error(
    chatCode === 'model_unsupported'
      ? modelUnsupportedFailure!.message
      : chatCode === 'quota_exceeded'
        ? quotaFailure!.message
        : message,
  );
  if (chatCode) {
    (error as Error & { chatCode?: ChatErrorCode }).chatCode = chatCode;
  }
  return error;
};

export const buildCodexRunFailureError = (
  stdout: string,
  stderr: string,
  fallbackMessage = 'codex_exec_failed',
): Error => buildProviderRunFailureError('codex', stdout, stderr, fallbackMessage);
