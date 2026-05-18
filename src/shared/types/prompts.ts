import type { BasicActionResult } from './base';
import type { AgentEffort, AgentProvider, AgentRuntime, CodexReasoningEffort } from './agent-runtime';

export interface AppPromptTemplate {
  id: string;
  title: string;
  description?: string;
  arguments?: AppPromptTemplateArgument[];
  acceptedFileTypes?: string[];
  prompt: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  runtime?: AgentRuntime;
}

export interface AppAgent {
  id: string;
  title: string;
  description?: string;
  initialPrompt: string;
  kind?: 'classic' | 'thread_interface' | 'orchestrator' | 'agent_invocation';
  initialPromptTemplate?: string;
  prompts?: AppAgentPromptSet;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  runtime?: AgentRuntime;
  legacy?: boolean;
}

export type AppAgentPromptVariableType = 'text' | 'string' | 'json' | 'path';

export interface AppAgentPromptVariable {
  type: AppAgentPromptVariableType;
  required?: boolean;
}

export interface AppAgentPromptTemplate {
  body: string;
  variables?: Record<string, AppAgentPromptVariable>;
  runtime?: AgentRuntime;
}

export interface AppAgentPromptSet {
  initial?: AppAgentPromptTemplate;
  resume?: AppAgentPromptTemplate;
  steer?: AppAgentPromptTemplate;
}

export type AppPromptTemplateArgumentType = 'file' | 'string';

export interface AppPromptTemplateArgument {
  name: string;
  type: AppPromptTemplateArgumentType;
  required?: boolean;
  multiple?: boolean;
  acceptedFileTypes?: string[];
  maxBytes?: number;
  maxLength?: number;
}

export type AppPromptReviewKind = 'promptTemplate' | 'agent' | 'agentPrompt';
export type AppPromptSettingSource = 'override' | 'manifest' | 'global';

export interface AppPromptValidationResult {
  valid: boolean;
  errors: string[];
  missingVariables: string[];
  extraVariables: string[];
}

export interface AppPromptReviewItem {
  appId: string;
  kind: AppPromptReviewKind;
  id: string;
  agentId?: string;
  promptKind?: keyof AppAgentPromptSet;
  declaredVariables?: string[];
  sourcePath?: string;
  title: string;
  description?: string;
  originalPrompt: string;
  prompt: string;
  originalModel?: string;
  originalReasoningEffort?: CodexReasoningEffort;
  originalRuntime?: AgentRuntime;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  runtime: AgentRuntime;
  overridePrompt?: string;
  overrideModel?: string;
  overrideReasoningEffort?: CodexReasoningEffort;
  overrideRuntime?: AgentRuntime;
  modelSource: AppPromptSettingSource;
  reasoningEffortSource: AppPromptSettingSource;
  runtimeSource: AppPromptSettingSource;
  edited: boolean;
  overrideInvalid: boolean;
  updatedAt?: string;
  validation: AppPromptValidationResult;
}

export interface AppPromptReviewInput {
  appId: string;
  kind: AppPromptReviewKind;
  id: string;
  prompt: string;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  runtime?: AgentRuntime | null;
  provider?: AgentProvider | null;
  effort?: AgentEffort | null;
}

export interface AppPromptRestoreInput {
  appId: string;
  kind: AppPromptReviewKind;
  id: string;
}

export interface AppPromptMutationResult extends BasicActionResult {
  prompt?: AppPromptReviewItem;
}
