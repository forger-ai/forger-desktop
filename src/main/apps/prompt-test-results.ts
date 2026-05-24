import type { AppPromptTestResult } from '../../shared/types';

const PROMPT_VARIABLE_PATTERN = /{{\s*([^{}]+?)\s*}}/g;
const MAX_RENDERED_PROMPT_LENGTH = 20_000;

export const renderPromptTemplateForTest = (prompt: string, variables: Record<string, unknown>): string =>
  prompt.replace(PROMPT_VARIABLE_PATTERN, (_match, name: string) => renderPromptTestValue(variables[name.trim()]));

const renderPromptTestValue = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

export const promptTestSuccess = (
  renderedPrompt: string,
  details: Pick<AppPromptTestResult, 'declaredVariables' | 'usedVariables'>,
): AppPromptTestResult => ({
  success: true,
  valid: true,
  errors: [],
  renderedPrompt: truncateRenderedPrompt(renderedPrompt),
  declaredVariables: details.declaredVariables,
  usedVariables: details.usedVariables,
  missingVariables: [],
  extraVariables: [],
});

export const promptTestFailure = (
  technicalCode: string,
  errors: string[],
  details: Partial<Pick<AppPromptTestResult, 'declaredVariables' | 'usedVariables' | 'missingVariables' | 'extraVariables'>> = {},
): AppPromptTestResult => ({
  success: false,
  valid: false,
  technicalCode,
  errors,
  declaredVariables: details.declaredVariables ?? [],
  usedVariables: details.usedVariables ?? [],
  missingVariables: details.missingVariables ?? [],
  extraVariables: details.extraVariables ?? [],
});

const truncateRenderedPrompt = (prompt: string): string =>
  prompt.length > MAX_RENDERED_PROMPT_LENGTH
    ? `${prompt.slice(0, MAX_RENDERED_PROMPT_LENGTH)}\n[truncated]`
    : prompt;

export const promptTestTechnicalCode = (error: unknown): string => {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.split(':')[0] || 'app_prompt_test_failed';
  }
  return 'app_prompt_test_failed';
};

export const promptTestErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'No se pudo probar el prompt.';
