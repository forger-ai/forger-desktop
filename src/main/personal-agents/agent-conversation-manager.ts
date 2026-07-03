import path from 'node:path';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentRuntime, AgentRuntimeRequest, ClaudeEffort, CodexReasoningEffort, PersonalAgent, PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentConversationGetInput, PersonalAgentConversationStartInput, PersonalAgentMessageSendInput, PersonalAgentRun } from '../../shared/types';
import { preparePersistentIsolatedCodexHome } from '../codex-run-isolation';
import { existsDirectory, runCommandCapture } from '../app-agent/process';
import type { LlmAppMcpServerConfig } from '../app-agent/types';
import { appendRunLog, getRunLogPath, toProviderProgressMessages } from '../chat/progress-errors';
import { buildPersonalAgentInitialWakePrompt } from '../prompt-builder/personal-agents';
import type { AgentStore } from './agent-store';
import { isTerminalRunStatus } from './agent-store';
import { antigravityCliAdapter } from '../llm-provider/adapters/antigravity-cli-adapter';
import { claudeCliAdapter } from '../llm-provider/adapters/claude-cli-adapter';
import { codexCliAdapter } from '../llm-provider/adapters/codex-cli-adapter';

interface PersonalAgentRunnerInput {
  agent: PersonalAgent;
  conversation: PersonalAgentConversation;
  run: PersonalAgentRun;
  runtime?: AgentRuntime;
  prompt: string;
  workspaceRoot: string;
  onProgress: (message: string) => void;
}

type PersonalAgentRunner = (input: PersonalAgentRunnerInput) => Promise<{ assistantText: string }>;

interface AgentConversationManagerOptions {
  store: AgentStore;
  metadataRoot?: string;
  codexHome?: string;
  getAgentRuntime?: (requested?: AgentRuntimeRequest) => Promise<AgentRuntime>;
  getCodexCliPath?: () => Promise<string | null>;
  getClaudeCliPath?: () => Promise<string | null>;
  getAntigravityCliPath?: () => Promise<string | null>;
  getCodexPathEntries?: () => Promise<string[]>;
  getCodexEnvironment?: () => Promise<Record<string, string>>;
  ensureGitAvailable?: () => Promise<void>;
  getCodexAuthenticated?: () => Promise<boolean>;
  getClaudeAuthenticated?: () => Promise<boolean>;
  getAntigravityAuthenticated?: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, agent: PersonalAgent) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<LlmAppMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  runner?: PersonalAgentRunner;
  onConversationEvent?: (event: PersonalAgentConversationEvent) => void;
}

const DEFAULT_MODEL = 'gpt-5.2';
const DEFAULT_REASONING: CodexReasoningEffort = 'medium';
const PERSONAL_AGENT_RUN_TIMEOUT_MS = 600_000;
const FIRST_MESSAGE_TITLE_WORDS = 8;

export class AgentConversationManager {
  private readonly activeChildren = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly listeners = new Set<(event: PersonalAgentConversationEvent) => void>();

  public constructor(private readonly options: AgentConversationManagerOptions) {}

  public onConversationEvent(listener: (event: PersonalAgentConversationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async createConversation(input: PersonalAgentConversationStartInput): Promise<PersonalAgentConversation> {
    const agent = await this.options.store.requireAgent(input.agentId);
    await this.options.store.workspaceRootForAgent(agent.id);
    const conversation = await this.options.store.createConversation({
      agentId: agent.id,
      title: input.title,
    });
    this.emit({ type: 'conversation.created', conversation });
    return conversation;
  }

  public async startConversation(input: PersonalAgentConversationStartInput): Promise<PersonalAgentConversation> {
    const conversation = await this.createConversation(input);
    const initialMessage = input.initialMessage?.trim();
    if (!initialMessage) {
      return conversation;
    }
    return await this.sendMessage({
      conversationId: conversation.id,
      content: initialMessage,
    });
  }

  public async getConversation(input: string | PersonalAgentConversationGetInput): Promise<PersonalAgentConversation | null> {
    const conversationId = typeof input === 'string' ? input : input.conversationId;
    if (!conversationId) {
      throw new Error('personal_agent_conversation_id_required');
    }
    return await this.options.store.getConversation(conversationId);
  }

  public async sendMessage(input: PersonalAgentMessageSendInput): Promise<PersonalAgentConversation> {
    const conversation = await this.options.store.requireConversation(input.conversationId);
    if (conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status)) {
      throw new Error('personal_agent_run_active');
    }
    const agent = await this.options.store.requireAgent(conversation.agentId);
    const runtime = await this.resolveRuntimeForAgent(agent);
    if (runtime && conversation.provider && conversation.provider !== runtime.provider) {
      throw new Error('personal_agent_provider_changed_new_conversation_required');
    }
    const content = input.content.trim();
    if (!content) {
      throw new Error('personal_agent_message_required');
    }
    const conversationWasEmpty = conversation.messages.length === 0;
    if (conversationWasEmpty) {
      await this.options.store.updateConversationTitle({
        conversationId: conversation.id,
        title: deriveConversationTitle(content),
      });
    }
    const run = await this.options.store.createRun({ agentId: conversation.agentId, conversationId: conversation.id });
    const message = await this.options.store.addMessage({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      runId: run.id,
      role: 'user',
      content,
    });
    const updated = await this.requireUpdatedConversation(conversation.id);
    this.emit({ type: 'message.created', conversation: updated, message, run: updated.activeRun });
    void this.executeRun(updated.id, run.id).catch((error) => {
      void this.failRun(run.id, error);
    });
    return updated;
  }

  private async executeRun(conversationId: string, runId: string): Promise<void> {
    const conversation = await this.options.store.requireConversation(conversationId);
    const run = await this.options.store.updateRunStatus({ runId, status: 'running' });
    this.emit({ type: 'run.started', conversation: await this.requireUpdatedConversation(conversationId), run });

    const agent = await this.options.store.requireAgent(conversation.agentId);
    const runtime = await this.resolveRuntimeForAgent(agent);
    if (runtime && conversation.provider && conversation.provider !== runtime.provider) {
      throw new Error('personal_agent_provider_changed_new_conversation_required');
    }
    const conversationForRun = runtime
      ? await this.options.store.updateConversationProvider({
        conversationId: conversation.id,
        provider: runtime.provider,
        providerThreadId: conversation.provider === runtime.provider || !conversation.provider ? conversation.providerThreadId ?? null : null,
      })
      : conversation;
    const workspaceRoot = await this.options.store.workspaceRootForAgent(agent.id);
    const prompt = await this.buildPrompt(agent, conversationForRun, run);
    const progressWrites: Array<Promise<void>> = [];
    const result = await this.runPersonalAgent({
      agent,
      conversation: conversationForRun,
      run,
      runtime,
      prompt,
      workspaceRoot,
      onProgress: (message) => {
        progressWrites.push(this.recordProgress(run.id, message));
      },
    });
    await Promise.all(progressWrites);
    const assistantText = result.assistantText || 'Done.';
    await this.options.store.deleteDuplicateRunProgress({ runId: run.id, finalContent: assistantText });
    const assistantMessage = await this.options.store.addMessage({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      runId: run.id,
      role: 'assistant',
      content: assistantText,
    });
    const completed = await this.options.store.updateRunStatus({ runId, status: 'completed' });
    const updated = await this.requireUpdatedConversation(conversationId);
    this.emit({ type: 'message.created', conversation: updated, message: assistantMessage, run: completed });
    this.emit({ type: 'run.completed', conversation: updated, run: completed });
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    const run = await this.options.store.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) {
      return;
    }
    const failed = await this.options.store.updateRunStatus({
      runId,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error ?? 'personal_agent_run_failed'),
    });
    this.activeChildren.delete(runId);
    this.emit({ type: 'run.failed', conversation: await this.requireUpdatedConversation(run.conversationId), run: failed });
  }

  private async recordProgress(runId: string, message: string): Promise<void> {
    const progress = await this.options.store.addRunProgress({ runId, message });
    const run = await this.options.store.getRun(runId);
    if (!run) {
      return;
    }
    const intermediateMessage = await this.options.store.addMessage({
      agentId: run.agentId,
      conversationId: run.conversationId,
      runId: run.id,
      role: 'assistant',
      kind: 'intermediate',
      content: message,
    });
    const conversation = await this.requireUpdatedConversation(run.conversationId);
    this.emit({ type: 'message.created', conversation, message: intermediateMessage, run });
    this.emit({ type: 'run.progress', conversation, run, progress });
  }

  private async buildPrompt(agent: PersonalAgent, conversation: PersonalAgentConversation, run: PersonalAgentRun): Promise<string> {
    const memories = await this.options.store.listMemories(agent.id);
    const memoryRegister = memories.length > 0
      ? memories.map((memory) => `- ${memory.title}: ${memory.content}${memory.rememberWhen ? ` (remember when: ${memory.rememberWhen})` : ''}`).join('\n')
      : '- No agent memories have been saved yet.';
    const bootstrap = buildPersonalAgentInitialWakePrompt({ agent, memoryRegister });
    const transcript = conversation.messages
      .filter((message) => message.role !== 'system')
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n\n');
    const currentMessage = conversation.messages.find((message) => message.runId === run.id && message.role === 'user')?.content ?? '';
    return [
      bootstrap,
      '',
      'Visible conversation so far:',
      transcript || '- No visible messages yet.',
      '',
      'Current user message:',
      currentMessage,
    ].join('\n');
  }

  private async runPersonalAgent(input: PersonalAgentRunnerInput): Promise<{ assistantText: string }> {
    if (this.options.runner) {
      return await this.options.runner(input);
    }
    return await this.runWithConfiguredProvider(input);
  }

  private async runWithConfiguredProvider(input: PersonalAgentRunnerInput): Promise<{ assistantText: string }> {
    if (!this.options.getAgentRuntime || !this.options.metadataRoot || !this.options.codexHome) {
      throw new Error('personal_agent_runtime_unavailable');
    }
    const runtime = input.runtime ?? await this.resolveRuntimeForAgent(input.agent);
    if (!runtime) {
      throw new Error('personal_agent_runtime_unavailable');
    }
    if (runtime.provider === 'antigravity') {
      if (!(await (this.options.getAntigravityAuthenticated?.() ?? Promise.resolve(false)))) {
        throw new Error('antigravity_auth_missing');
      }
    } else if (runtime.provider === 'claude') {
      if (!(await (this.options.getClaudeAuthenticated?.() ?? Promise.resolve(false)))) {
        throw new Error('claude_auth_missing');
      }
    } else if (!(await (this.options.getCodexAuthenticated?.() ?? Promise.resolve(false)))) {
      throw new Error('codex_auth_missing');
    }
    if (runtime.provider === 'codex') {
      await this.options.ensureGitAvailable?.();
    }
    const codexCliPath = runtime.provider === 'codex' ? await (this.options.getCodexCliPath?.() ?? Promise.resolve(null)) : null;
    const claudeCliPath = runtime.provider === 'claude' ? await (this.options.getClaudeCliPath?.() ?? Promise.resolve(null)) : null;
    const antigravityCliPath = runtime.provider === 'antigravity' ? await (this.options.getAntigravityCliPath?.() ?? Promise.resolve(null)) : null;
    if (runtime.provider === 'codex' && !codexCliPath) {
      throw new Error('codex_cli_missing');
    }
    if (runtime.provider === 'claude' && !claudeCliPath) {
      throw new Error('claude_cli_missing');
    }
    if (runtime.provider === 'antigravity' && !antigravityCliPath) {
      throw new Error('antigravity_cli_missing');
    }
    if (!(await existsDirectory(input.workspaceRoot))) {
      throw new Error('personal_agent_workspace_missing');
    }
    const pathEntries = await (this.options.getCodexPathEntries?.() ?? Promise.resolve([]));
    const environment = await (this.options.getCodexEnvironment?.() ?? Promise.resolve({}));
    const runLogPath = getRunLogPath(path.join(this.options.metadataRoot, 'personal-agents'), input.run.id);
    const networkAccess = input.agent.networkAccess;
    let forgerMcpSession: { url: string; token: string } | null = null;
    let mcpServers: LlmAppMcpServerConfig[] = [];
    try {
      const appMcpServers = await (this.options.listenAppMcps?.(input.agent.appIds, input.run.id) ?? Promise.resolve([]));
      forgerMcpSession = this.options.createForgerMcpSession?.(input.run.id, input.agent) ?? null;
      mcpServers = [
        ...(forgerMcpSession
          ? [{
              name: 'forger',
              url: forgerMcpSession.url,
              token: forgerMcpSession.token,
              tokenEnvVar: 'FORGER_MCP_TOKEN',
              toolTimeoutSec: 600,
            }]
          : []),
        ...appMcpServers,
      ];
      const codexHome = runtime.provider === 'codex'
        ? await preparePersistentIsolatedCodexHome(
          this.options.codexHome,
          path.join(this.options.metadataRoot, 'personal-agent-codex-home', input.agent.id, input.conversation.id),
          { trustedRoots: [input.workspaceRoot], networkAccess },
        )
        : '';
      const onOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
        void appendRunLog(runLogPath, stream, text);
        this.handleProviderOutput(input, runtime.provider, stream, text);
      };
      const antigravityResult = runtime.provider === 'antigravity'
        ? await antigravityCliAdapter.run({
          runId: input.run.id,
          cliPath: antigravityCliPath as string,
          pathEntries: [path.dirname(antigravityCliPath as string), ...pathEntries],
          environment,
          mcpServers,
          workingDir: input.workspaceRoot,
          configWorkspaceRoot: input.workspaceRoot,
          prompt: input.prompt,
          model: runtime.model,
          effort: runtime.effort,
          conversationId: input.conversation.providerThreadId,
          permissionMode: input.agent.permissionMode,
          timeoutMs: PERSONAL_AGENT_RUN_TIMEOUT_MS,
          timeoutMode: 'absolute',
          onChild: (child) => {
            this.activeChildren.set(input.run.id, child);
          },
          onOutput,
          runCommandCapture,
        })
        : null;
      const claudeResult = runtime.provider === 'claude'
        ? await claudeCliAdapter.run({
          cliPath: claudeCliPath as string,
          pathEntries,
          environment,
          mcpServers,
          workingDir: input.workspaceRoot,
          prompt: input.prompt,
          model: runtime.model,
          effort: runtime.effort as ClaudeEffort,
          permissionMode: input.agent.permissionMode,
          timeoutMs: PERSONAL_AGENT_RUN_TIMEOUT_MS,
          onChild: (child) => {
            this.activeChildren.set(input.run.id, child);
          },
          onOutput,
          runCommandCapture,
        })
        : null;
      const codexResult = runtime.provider === 'codex'
        ? await codexCliAdapter.runConversation({
          cliPath: codexCliPath as string,
          pathEntries,
          environment,
          mcpServers,
          workingDir: input.workspaceRoot,
          prompt: input.prompt,
          model: runtime.model || DEFAULT_MODEL,
          reasoningEffort: (runtime.effort as CodexReasoningEffort) || DEFAULT_REASONING,
          permissionMode: input.agent.permissionMode,
          networkAccess,
          timeoutMs: PERSONAL_AGENT_RUN_TIMEOUT_MS,
          codexHome,
          threadId: input.conversation.providerThreadId,
          onChild: (child) => {
            this.activeChildren.set(input.run.id, child);
          },
          onOutput,
          runCommandCapture,
        })
        : null;
      const result = runtime.provider === 'antigravity'
        ? { code: 0, stdout: antigravityResult?.stdout ?? '', stderr: antigravityResult?.stderr ?? '', assistantText: antigravityResult?.assistantText ?? '', threadId: antigravityResult?.conversationId ?? undefined }
        : runtime.provider === 'claude'
          ? { code: 0, stdout: claudeResult?.stdout ?? '', stderr: claudeResult?.stderr ?? '', assistantText: claudeResult?.assistantText ?? '', threadId: claudeResult?.threadId }
          : { code: codexResult?.code ?? 1, stdout: codexResult?.stdout ?? '', stderr: codexResult?.stderr ?? '', assistantText: codexResult?.assistantText ?? '', threadId: codexResult?.threadId };
      this.activeChildren.delete(input.run.id);
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || `${runtime.provider}_personal_agent_exec_failed`).trim());
      }
      if (result.threadId) {
        input.conversation.providerThreadId = result.threadId;
        await this.options.store.updateConversationProvider({
          conversationId: input.conversation.id,
          provider: runtime.provider,
          providerThreadId: result.threadId,
        });
      }
      return { assistantText: result.assistantText };
    } finally {
      this.activeChildren.delete(input.run.id);
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      this.options.releaseAppMcps?.(input.run.id);
    }
  }

  private async resolveRuntimeForAgent(agent: PersonalAgent): Promise<AgentRuntime | undefined> {
    if (!this.options.getAgentRuntime) {
      return agent.runtime;
    }
    return await this.options.getAgentRuntime({
      ...(agent.runtime ?? {}),
      permissionMode: agent.permissionMode,
      strict: Boolean(agent.runtime),
    });
  }

  private handleProviderOutput(
    input: PersonalAgentRunnerInput,
    provider: AgentRuntime['provider'],
    stream: 'stdout' | 'stderr' | 'meta',
    text: string,
  ): void {
    for (const message of toProviderProgressMessages(provider, stream, text)) {
      input.onProgress(message);
    }
  }

  private async requireUpdatedConversation(conversationId: string): Promise<PersonalAgentConversation> {
    const updated = await this.options.store.getConversation(conversationId);
    if (!updated) {
      throw new Error('personal_agent_conversation_not_found');
    }
    return updated;
  }

  private emit(event: PersonalAgentConversationEvent): void {
    this.options.onConversationEvent?.(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const deriveConversationTitle = (content: string): string =>
  content.split(/\s+/).slice(0, FIRST_MESSAGE_TITLE_WORDS).join(' ').slice(0, 80);
