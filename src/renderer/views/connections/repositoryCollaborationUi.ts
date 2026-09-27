import type { RepositoryCollaborationCopy } from '@renderer/i18n/locales/repositoryCollaboration';

const invalidRepositoryMessages = new Set([
  'La carpeta seleccionada no es un repositorio Git disponible.',
  'Selecciona una carpeta de proyecto válida.',
]);

export const collaborationError = (
  error: unknown,
  copy: RepositoryCollaborationCopy,
  fallback = copy.actionError,
): string => {
  const message = error instanceof Error ? error.message : '';
  const domainMessage = message.replace(
    /^Error invoking remote method 'forger:repository-collaboration:add-repository': Error: /,
    '',
  );
  if (invalidRepositoryMessages.has(domainMessage))
    return copy.invalidRepository;
  if (/repository_execution_platform_unsupported/.test(message))
    return copy.unsupported;
  if (
    /codex.*(auth|required|unauthenticated)|provider_authentication|auth_profile/.test(
      message,
    )
  )
    return copy.authRequired;
  if (
    /connection_not_(configured|connected)|whatsapp.*disconnected/.test(message)
  )
    return copy.unavailable;
  return fallback;
};
