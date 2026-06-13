import path from 'node:path';
import fs from 'node:fs/promises';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentRuntime, AgentRuntimeRequest, ClaudeEffort, CodexReasoningEffort, PersonalAgent, PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentConversationGetInput, PersonalAgentConversationStartInput, PersonalAgentMessageSendInput, PersonalAgentRun } from '../../shared/types';
import { assertAllowedMcpServers, codexWorkspaceNetworkConfigArgs, preparePersistentIsolatedCodexHome } from '../codex-run-isolation';
import { claudePermissionArgs, codexUnsafeArgs, codexWorkspaceArgs } from '../agent-permission-mode';
import { buildMcpArgs, writeClaudeMcpConfig } from '../app-agent/mcp';
import { parseClaudeConversationJsonl, parseCodexConversationJsonl } from '../app-agent/jsonl';
import { existsDirectory, resolveCodexCommand, runCommandCapture } from '../app-agent/process';
import type { CodexMcpServerConfig } from '../app-agent/types';
import { appendRunLog, getRunLogPath, toProgressMessages } from '../chat/progress-errors';
import { buildPersonalAgentInitialWakePrompt } from '../prompt-builder/personal-agents';
import type { AgentStore } from './agent-store';
import { isTerminalRunStatus } from './agent-store';

interface PersonalAgentRunnerInput {
  agent: PersonalAgent;
  conversation: PersonalAgentConversation;
  run: PersonalAgentRun;
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
  getCodexPathEntries?: () => Promise<string[]>;
  getCodexEnvironment?: () => Promise<Record<string, string>>;
  getCodexAuthenticated?: () => Promise<boolean>;
  getClaudeAuthenticated?: () => Promise<boolean>;
  createForgerMcpSession?: (runId: string, agent: PersonalAgent) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<CodexMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  runner?: PersonalAgentRunner;
  onConversationEvent?: (event: PersonalAgentConversationEvent) => void;
}

const DEFAULT_MODEL = 'gpt-5.4';
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
    const workspaceRoot = await this.options.store.workspaceRootForAgent(agent.id);
    const prompt = await this.buildPrompt(agent, conversation, run);
    const progressWrites: Array<Promise<void>> = [];
    const result = await this.runPersonalAgent({
      agent,
      conversation,
      run,
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
    const runtime = await this.options.getAgentRuntime({
      permissionMode: input.agent.permissionMode,
    });
    if (runtime.provider === 'claude') {
      if (!(await (this.options.getClaudeAuthenticated?.() ?? Promise.resolve(false)))) {
        throw new Error('claude_auth_missing');
      }
    } else if (!(await (this.options.getCodexAuthenticated?.() ?? Promise.resolve(false)))) {
      throw new Error('codex_auth_missing');
    }
    const codexCliPath = runtime.provider === 'codex' ? await (this.options.getCodexCliPath?.() ?? Promise.resolve(null)) : null;
    const claudeCliPath = runtime.provider === 'claude' ? await (this.options.getClaudeCliPath?.() ?? Promise.resolve(null)) : null;
    if (runtime.provider === 'codex' && !codexCliPath) {
      throw new Error('codex_cli_missing');
    }
    if (runtime.provider === 'claude' && !claudeCliPath) {
      throw new Error('claude_cli_missing');
    }
    if (!(await existsDirectory(input.workspaceRoot))) {
      throw new Error('personal_agent_workspace_missing');
    }
    const pathEntries = await (this.options.getCodexPathEntries?.() ?? Promise.resolve([]));
    const command = runtime.provider === 'codex'
      ? await resolveCodexCommand(codexCliPath as string, pathEntries)
      : { command: claudeCliPath as string, prefixArgs: [], pathEntries };
    const environment = await (this.options.getCodexEnvironment?.() ?? Promise.resolve({}));
    const runLogPath = getRunLogPath(path.join(this.options.metadataRoot, 'personal-agents'), input.run.id);
    const networkAccess = input.agent.networkAccess;
    let forgerMcpSession: { url: string; token: string } | null = null;
    let claudeMcpConfigPath: string | null = null;
    let mcpServers: CodexMcpServerConfig[] = [];
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
      const mcpArgs = buildMcpArgs(mcpServers);
      claudeMcpConfigPath = runtime.provider === 'claude' && mcpServers.length > 0
        ? await writeClaudeMcpConfig(input.workspaceRoot, mcpServers)
        : null;
      const args = runtime.provider === 'claude'
        ? [
          '-p',
          input.prompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--model',
          runtime.model,
          '--effort',
          runtime.effort as ClaudeEffort,
          ...claudePermissionArgs(input.agent.permissionMode),
          ...(claudeMcpConfigPath ? ['--mcp-config', claudeMcpConfigPath] : []),
        ]
        : [
          ...command.prefixArgs,
          ...(mcpServers.length > 0 ? ['--ask-for-approval', 'never'] : []),
          'exec',
          '--json',
          '--model',
          runtime.model || DEFAULT_MODEL,
          '--config',
          `reasoning_effort="${(runtime.effort as CodexReasoningEffort) || DEFAULT_REASONING}"`,
          ...codexWorkspaceNetworkConfigArgs(networkAccess),
          ...codexUnsafeArgs(input.agent.permissionMode),
          ...codexWorkspaceArgs(input.agent.permissionMode),
          ...mcpArgs,
          '--skip-git-repo-check',
          '-C',
          input.workspaceRoot,
          '--',
          '-',
        ];
      const codexHome = runtime.provider === 'codex'
        ? await preparePersistentIsolatedCodexHome(
          this.options.codexHome,
          path.join(this.options.metadataRoot, 'personal-agent-codex-home', input.agent.id, input.conversation.id),
          { trustedRoots: [input.workspaceRoot], networkAccess },
        )
        : '';
      const result = await runCommandCapture(command.command, args, {
        cwd: input.workspaceRoot,
        env: {
          ...(runtime.provider === 'codex' ? { CODEX_HOME: codexHome } : {}),
          FORGER_ALLOWED_ROOTS: input.workspaceRoot,
          ...Object.fromEntries(mcpServers.map((server) => [server.tokenEnvVar, server.token])),
          ...environment,
          PATH: [...command.pathEntries, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        },
        timeoutMs: PERSONAL_AGENT_RUN_TIMEOUT_MS,
        stdinText: runtime.provider === 'codex' ? input.prompt : undefined,
        onChild: (child) => {
          this.activeChildren.set(input.run.id, child);
        },
        onStdout: (text) => {
          void appendRunLog(runLogPath, 'stdout', text);
          this.handleProviderOutput(input, text);
        },
        onStderr: (text) => {
          void appendRunLog(runLogPath, 'stderr', text);
          this.handleProviderOutput(input, text);
        },
      });
      assertAllowedMcpServers(result.stdout, result.stderr, new Set(mcpServers.map((server) => server.name)));
      this.activeChildren.delete(input.run.id);
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || `${runtime.provider}_personal_agent_exec_failed`).trim());
      }
      const parsed = runtime.provider === 'claude'
        ? parseClaudeConversationJsonl(result.stdout, result.stderr)
        : parseCodexConversationJsonl(result.stdout, result.stderr);
      return { assistantText: parsed.assistantText };
    } finally {
      this.activeChildren.delete(input.run.id);
      if (forgerMcpSession) {
        this.options.releaseForgerMcpSession?.(forgerMcpSession.token);
      }
      this.options.releaseAppMcps?.(input.run.id);
      await fs.rm(claudeMcpConfigPath ?? '', { force: true }).catch(() => undefined);
    }
  }

  private handleProviderOutput(input: PersonalAgentRunnerInput, text: string): void {
    for (const message of toProgressMessages('stdout', text)) {
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
