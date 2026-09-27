import type { RepositoryCollaborationCopy } from '@renderer/i18n/locales/repositoryCollaboration';

export const collaborationError = (error: unknown, copy: RepositoryCollaborationCopy, fallback = copy.actionError): string => {
  const message = error instanceof Error ? error.message : '';
  if (/repository_execution_platform_unsupported/.test(message)) return copy.unsupported;
  if (/codex.*(auth|required|unauthenticated)|provider_authentication|auth_profile/.test(message)) return copy.authRequired;
  if (/connection_not_(configured|connected)|whatsapp.*disconnected/.test(message)) return copy.unavailable;
  return fallback;
};
