import type { DesktopErrorReportInput, DesktopErrorReportPreview } from '@shared/types';

const EXPECTED_ERROR_CODES = new Set([
  'permission_denied',
  'app_not_installed',
  'missing_secrets',
  'no_pending_update_conflict',
  'codex_auth_missing',
  'auth_missing',
]);

export const buildErrorReport = (
  input: DesktopErrorReportInput,
  currentVersion?: string,
): DesktopErrorReportPreview => ({
  ...input,
  desktopVersion: currentVersion || undefined,
  platform: navigator.platform,
  occurredAt: new Date().toISOString(),
});

export const shouldPromptForErrorReport = (technicalCode?: string): boolean => {
  if (!technicalCode) {
    return true;
  }
  return !EXPECTED_ERROR_CODES.has(technicalCode);
};
