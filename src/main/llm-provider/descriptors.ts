import type { AgentProvider, ClaudeEffort, CodexReasoningEffort } from '../../shared/types';
import { antigravityCliAdapter } from './adapters/antigravity-cli-adapter';
import { claudeCliAdapter } from './adapters/claude-cli-adapter';
import { codexCliAdapter } from './adapters/codex-cli-adapter';
import type { LlmCliRunInput, LlmCommandResult, LlmRunCommandCapture, LlmRunOutputStream, LlmRunResult } from './types';

export type LlmProviderRunMode = 'chat' | 'task' | 'conversation' | 'automation';

export interface LlmProviderResolvedCommand {
  command: string;
  prefixArgs: string[];
  pathEntries: string[];
}

export interface LlmProviderDescriptorRunInput extends Omit<LlmCliRunInput, 'cliPath' | 'runCommandCapture'> {
  mode: LlmProviderRunMode;
  cliPath: string;
  runCommandCapture: LlmRunCommandCapture;
  codexHome?: string;
  rootCodexHome?: string;
  threadId?: string | null;
  imagePaths?: string[];
  networkAccess?: boolean;
  alwaysIncludeMcpConfig?: boolean;
  throwOnNonZero?: boolean;
  resolvedCommand?: LlmProviderResolvedCommand;
}

export interface LlmProviderRunOutput extends LlmRunResult {
  code: number;
  threadId?: string;
}

export interface LlmProviderDescriptor {
  key: AgentProvider;
  label: string;
  supportsMcp: boolean;
  supportsConversations: boolean;
  supportsSkills: boolean;
  resolveCommand?: (cliPath: string, pathEntries: string[]) => Promise<LlmProviderResolvedCommand>;
  run: (input: LlmProviderDescriptorRunInput) => Promise<LlmProviderRunOutput>;
}

const toRunOutput = (
  result: LlmRunResult & Partial<LlmCommandResult> & { code?: number | null; threadId?: string },
): LlmProviderRunOutput => ({
  code: typeof result.code === 'number' ? result.code : 0,
  assistantText: result.assistantText,
  conversationId: result.conversationId,
  threadId: result.threadId ?? result.conversationId ?? undefined,
  usageDelta: result.usageDelta,
  toolEvents: result.toolEvents,
  stdout: result.stdout,
  stderr: result.stderr,
});

const runCodex = async (input: LlmProviderDescriptorRunInput): Promise<LlmProviderRunOutput> => {
  const common = {
    cliPath: input.cliPath,
    pathEntries: input.pathEntries,
    environment: input.environment,
    mcpServers: input.mcpServers,
    workingDir: input.workingDir,
    sharedRoots: input.sharedRoots,
    addDirs: input.addDirs,
    prompt: input.prompt,
    model: input.model || 'gpt-5.2',
    reasoningEffort: (input.effort || 'medium') as CodexReasoningEffort,
    permissionMode: input.permissionMode,
    networkAccess: input.networkAccess,
    timeoutMs: input.timeoutMs,
    inactivityTimeoutMs: input.inactivityTimeoutMs,
    codexHome: input.codexHome,
    imagePaths: input.imagePaths,
    onChild: input.onChild,
    onOutput: input.onOutput as ((stream: LlmRunOutputStream, text: string) => void) | undefined,
    runCommandCapture: input.runCommandCapture,
  };
  if (input.mode === 'chat') {
    return toRunOutput(await codexCliAdapter.runChat({
      ...common,
      rootCodexHome: input.rootCodexHome ?? input.codexHome ?? '',
      threadId: input.threadId ?? undefined,
    }));
  }
  if (input.mode === 'task') {
    return toRunOutput(await codexCliAdapter.runTask(common));
  }
  if (input.mode === 'automation') {
    return toRunOutput(await codexCliAdapter.runAutomation({
      ...common,
      resolvedCommand: input.resolvedCommand,
    }));
  }
  return toRunOutput(await codexCliAdapter.runConversation({
    ...common,
    threadId: input.threadId,
  }));
};

const runClaude = async (input: LlmProviderDescriptorRunInput): Promise<LlmProviderRunOutput> =>
  toRunOutput(await claudeCliAdapter.run({
    cliPath: input.cliPath,
    pathEntries: input.pathEntries,
    environment: input.environment,
    mcpServers: input.mcpServers,
    workingDir: input.workingDir,
    configWorkspaceRoot: input.configWorkspaceRoot,
    sharedRoots: input.sharedRoots,
    addDirs: input.addDirs,
    prompt: input.prompt,
    model: input.model || 'claude-sonnet-5',
    effort: (input.effort || 'medium') as ClaudeEffort,
    permissionMode: input.permissionMode,
    timeoutMs: input.timeoutMs,
    inactivityTimeoutMs: input.inactivityTimeoutMs,
    threadId: input.threadId,
    imagePaths: input.imagePaths,
    throwOnNonZero: input.throwOnNonZero,
    alwaysIncludeMcpConfig: input.alwaysIncludeMcpConfig,
    onChild: input.onChild,
    onOutput: input.onOutput,
    runCommandCapture: input.runCommandCapture,
  }));

const runAntigravity = async (input: LlmProviderDescriptorRunInput): Promise<LlmProviderRunOutput> =>
  toRunOutput(await antigravityCliAdapter.run({
    runId: input.runId,
    cliPath: input.cliPath,
    pathEntries: input.pathEntries,
    environment: input.environment,
    mcpServers: input.mcpServers,
    workingDir: input.workingDir,
    configWorkspaceRoot: input.configWorkspaceRoot,
    sharedRoots: input.sharedRoots,
    addDirs: input.addDirs,
    prompt: input.prompt,
    model: input.model,
    effort: input.effort,
    conversationId: input.threadId ?? input.conversationId,
    permissionMode: input.permissionMode,
    timeoutMs: input.timeoutMs,
    inactivityTimeoutMs: input.inactivityTimeoutMs,
    timeoutMode: input.timeoutMode,
    onChild: input.onChild,
    onOutput: input.onOutput,
    onEvent: input.onEvent,
    runCommandCapture: input.runCommandCapture,
  }));

export const LLM_PROVIDER_DESCRIPTORS: Record<AgentProvider, LlmProviderDescriptor> = {
  codex: {
    key: 'codex',
    label: 'ChatGPT',
    supportsMcp: true,
    supportsConversations: true,
    supportsSkills: false,
    resolveCommand: async (cliPath, pathEntries) => await codexCliAdapter.resolveCommand(cliPath, pathEntries),
    run: runCodex,
  },
  claude: {
    key: 'claude',
    label: 'Claude',
    supportsMcp: true,
    supportsConversations: true,
    supportsSkills: true,
    run: runClaude,
  },
  antigravity: {
    key: 'antigravity',
    label: 'Google',
    supportsMcp: true,
    supportsConversations: true,
    supportsSkills: true,
    run: runAntigravity,
  },
};

export const getLlmProviderDescriptor = (provider: AgentProvider): LlmProviderDescriptor =>
  LLM_PROVIDER_DESCRIPTORS[provider];
