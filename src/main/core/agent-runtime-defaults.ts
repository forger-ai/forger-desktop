import type { ClaudeEffort, CodexReasoningEffort } from '../../shared/types';

export const DEFAULT_NODE_VERSION = '22';
export const DEFAULT_PYTHON_VERSION = '3.12';
export const BUNDLED_GIT_VERSION = '2.54.0';
export const CODEX_CLI_VERSION = '0.135.0';
export const CLAUDE_CODE_VERSION = '2.1.158';
export const CODEX_USAGE_DASHBOARD_URL = 'https://chatgpt.com/codex/settings/usage';
export const BUILT_IN_CODEX_MODEL = 'gpt-5.4';
export const BUILT_IN_CODEX_REASONING: CodexReasoningEffort = 'medium';
export const BUILT_IN_CLAUDE_MODEL = 'sonnet';
export const BUILT_IN_CLAUDE_EFFORT: ClaudeEffort = 'medium';

export const APP_CODEX_MODEL_OPTIONS = [
  { displayModelName: '5.4', realModelName: 'gpt-5.4', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.3 Codex', realModelName: 'gpt-5.3-codex', defaultReasoningEffort: 'low' as const },
  { displayModelName: '5.3 Spark', realModelName: 'gpt-5.3-codex-spark', defaultReasoningEffort: 'high' as const },
  { displayModelName: '5.4 Mini', realModelName: 'gpt-5.4-mini', defaultReasoningEffort: 'medium' as const },
  { displayModelName: '5.5', realModelName: 'gpt-5.5', defaultReasoningEffort: 'medium' as const },
];

export const APP_CLAUDE_MODEL_OPTIONS = [
  { displayModelName: 'Opus 4.8', realModelName: 'claude-opus-4-8', defaultEffort: 'high' as const },
  { displayModelName: 'Opus 4.7', realModelName: 'claude-opus-4-7', defaultEffort: 'xhigh' as const },
  { displayModelName: 'Opus 4.6', realModelName: 'claude-opus-4-6', defaultEffort: 'high' as const },
  { displayModelName: 'Opus 4.5', realModelName: 'claude-opus-4-5-20251101', defaultEffort: 'high' as const },
  { displayModelName: 'Sonnet 4.6', realModelName: 'claude-sonnet-4-6', defaultEffort: 'high' as const },
  { displayModelName: 'Sonnet 4.5', realModelName: 'claude-sonnet-4-5-20250929', defaultEffort: 'medium' as const },
  { displayModelName: 'Haiku 4.5', realModelName: 'claude-haiku-4-5-20251001', defaultEffort: 'low' as const },
];
