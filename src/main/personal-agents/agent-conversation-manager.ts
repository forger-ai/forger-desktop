import path from 'node:path';

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentRunActivity, AgentRunActivityStatus, AgentRuntime, AgentRuntimeRequest, PersonalAgent, PersonalAgentConversation, PersonalAgentConversationEvent, PersonalAgentConversationGetInput, PersonalAgentConversationStartInput, PersonalAgentMessage, PersonalAgentMessageSendInput, PersonalAgentMessageSource, PersonalAgentPeerThread, PersonalAgentRun } from '../../shared/types';
import { existsDirectory, runCommandCapture } from '../app-agent/process';
import type { LlmAppMcpServerConfig } from '../app-agent/types';
import {
  addStatusActivityItem,
  appendProviderActivity,
  createAgentRunActivity,
  finalizeAgentRunActivity,
  normalizeActivityStatus,
  persistAgentRunActivity,
  sanitizeAgentRunActivityText,
} from '../chat/agent-run-activity';
import { appendRunLog, getRunLogPath, toProviderProgressMessages } from '../chat/progress-errors';
import { buildPersonalAgentInitialWakePrompt } from '../prompt-builder/personal-agents';
import type { AgentStore } from './agent-store';
import { isTerminalRunStatus } from './agent-store';
import { isDuplicateFinalProgress, normalizeMessageText } from './agent-store-normalizers';
import { createLlmProviderRunService } from '../llm-provider/run-service';
import type { LlmProviderAuthProfileResolver } from '../llm-provider/types';

interface PersonalAgentRunnerInput {
  agent: PersonalAgent;
  conversation: PersonalAgentConversation;
  run: PersonalAgentRun;
  runtime?: AgentRuntime;
  prompt: string;
  workspaceRoot: string;
  sharedRoots: string[];
  trustedRoots: string[];
  mcpContext: PersonalAgentMcpRunContext;
  onProgress: (message: string, options?: { includeActivity?: boolean }) => void;
}

type PersonalAgentRunner = (input: PersonalAgentRunnerInput) => Promise<{ assistantText: string }>;

interface AgentConversationManagerOptions {
  store: AgentStore;
  metadataRoot?: string;
  codexHome?: string;
  providerProfilesRoot?: string;
  resolveAuthProfile?: LlmProviderAuthProfileResolver;
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
  createForgerMcpSession?: (runId: string, agent: PersonalAgent, context: PersonalAgentMcpRunContext) => { url: string; token: string } | null;
  releaseForgerMcpSession?: (token: string) => void;
  listenAppMcps?: (appIds: string[], runId: string) => Promise<LlmAppMcpServerConfig[]>;
  releaseAppMcps?: (runId: string) => void;
  resolveAppTrustedRoots?: (appIds: string[]) => Promise<string[]>;
  runner?: PersonalAgentRunner;
  onConversationEvent?: (event: PersonalAgentConversationEvent) => void;
}

const PERSONAL_AGENT_RUN_TIMEOUT_MS = 600_000;
const FIRST_MESSAGE_TITLE_WORDS = 8;
const MAX_PEER_AGENT_DEPTH = 5;

export interface PersonalAgentMcpRunContext {
  conversationId: string;
  peerThreadId?: string;
  callStackAgentIds: string[];
  sidekick?: {
    sidekickId: string;
    locale: string;
    model?: string;
    voice?: string;
  };
}

export interface PersonalAgentSidekickMessageInput {
  conversationId: string;
  sidekickId: string;
  content: string;
  locale: string;
  model?: string;
  voice?: string;
}

export interface PersonalAgentAskPeerInput {
  callerAgentId: string;
  callerConversationId: string;
  callerRunId: string;
  callStackAgentIds?: string[];
  targetAgentId?: string;
  threadId?: string;
  message: string;
}

export interface PersonalAgentAskPeerResult {
  success: boolean;
  status: 'completed' | 'failed' | 'timeout' | 'running';
  thread?: PersonalAgentPeerThread;
  response?: string;
  userMessage: string;
  technicalCode?: string;
}

export interface PersonalAgentScheduledMessageInput {
  conversationId: string;
  content: string;
  source: Exclude<PersonalAgentMessageSource, 'human'>;
  routineId?: string | null;
  wakeupId?: string | null;
  onRunSettled?: (result: { success: true } | { success: false; error: unknown }) => void | Promise<void>;
}

export class AgentConversationManager {
  private readonly activeChildren = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly activities = new Map<string, AgentRunActivity>();
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

  public async createSidekickConversation(input: { agentId: string; sidekickId: string; title?: string }): Promise<PersonalAgentConversation> {
    const agent = await this.options.store.requireAgent(input.agentId);
    await this.options.store.workspaceRootForAgent(agent.id);
    const conversation = await this.options.store.createConversation({
      agentId: agent.id,
      title: input.title,
      origin: 'sidekick',
      readOnly: true,
      sidekickId: input.sidekickId,
    });
    this.emit({ type: 'conversation.created', conversation });
    return conversation;
  }

  public async canReuseSidekickConversation(input: { conversationId: string; sidekickId: string; agentId: string }): Promise<boolean> {
    const conversation = await this.options.store.getConversation(input.conversationId);
    if (
      !conversation || conversation.origin !== 'sidekick' || !conversation.readOnly ||
      conversation.sidekickId !== input.sidekickId || conversation.agentId !== input.agentId ||
      conversation.status !== 'active' ||
      (conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status))
    ) return false;
    const agent = await this.options.store.requireAgent(input.agentId);
    const runtime = await this.resolveRuntimeForAgent(agent);
    return !runtime || !conversation.provider || conversation.provider === runtime.provider;
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

  public async cancelRun(runId: string): Promise<boolean> {
    const run = await this.options.store.getRun(runId);
    if (!run || isTerminalRunStatus(run.status)) return false;
    const child = this.activeChildren.get(runId);
    if (child && !child.killed) child.kill('SIGTERM');
    const canceled = await this.options.store.updateRunStatus({ runId, status: 'canceled' });
    this.activeChildren.delete(runId);
    this.updateActivityForRun(canceled, 'canceled');
    this.emit({
      type: 'run.canceled',
      conversation: await this.requireUpdatedConversation(run.conversationId),
      run: canceled,
    });
    return true;
  }

  public async sendMessage(input: PersonalAgentMessageSendInput): Promise<PersonalAgentConversation> {
    return await this.sendMessageInternal(input, { source: 'human' });
  }

  public async sendSidekickMessage(input: PersonalAgentSidekickMessageInput): Promise<PersonalAgentConversation> {
    const conversation = await this.options.store.requireConversation(input.conversationId);
    if (conversation.origin !== 'sidekick' || conversation.sidekickId !== input.sidekickId) {
      throw new Error('personal_agent_sidekick_conversation_mismatch');
    }
    return await this.sendMessageInternal(
      { conversationId: input.conversationId, content: input.content },
      {
        source: 'sidekick',
        bypassReadOnly: true,
        locale: input.locale,
        sidekick: {
          sidekickId: input.sidekickId,
          locale: input.locale,
          ...(input.model ? { model: input.model } : {}),
          ...(input.voice ? { voice: input.voice } : {}),
        },
      },
    );
  }

  public async sendScheduledMessage(input: PersonalAgentScheduledMessageInput): Promise<PersonalAgentConversation> {
    return await this.sendMessageInternal(
      { conversationId: input.conversationId, content: input.content },
      {
        source: input.source,
        routineId: input.routineId,
        wakeupId: input.wakeupId,
        bypassWakeupBlock: true,
        onRunSettled: input.onRunSettled,
      },
    );
  }

  private async sendMessageInternal(
    input: PersonalAgentMessageSendInput,
    options: {
      source: PersonalAgentMessageSource;
      routineId?: string | null;
      wakeupId?: string | null;
      bypassWakeupBlock?: boolean;
      bypassReadOnly?: boolean;
      locale?: string;
      sidekick?: PersonalAgentMcpRunContext['sidekick'];
      onRunSettled?: (result: { success: true } | { success: false; error: unknown }) => void | Promise<void>;
    },
  ): Promise<PersonalAgentConversation> {
    const conversation = await this.options.store.requireConversation(input.conversationId);
    if ((conversation.readOnly || conversation.origin === 'agent') && !options.bypassReadOnly) {
      throw new Error('personal_agent_conversation_read_only');
    }
    if (!options.bypassWakeupBlock && conversation.scheduledWakeup?.status === 'scheduled') {
      throw new Error('personal_agent_wakeup_active');
    }
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
    this.activities.set(run.id, this.createActivityForRun(run, agent, conversation));
    const message = await this.options.store.addMessage({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      runId: run.id,
      role: 'user',
      authorType: options.source === 'human' || options.source === 'sidekick' ? 'human' : 'system',
      source: options.source,
      locale: options.locale,
      routineId: options.routineId,
      wakeupId: options.wakeupId,
      content,
      files: input.sharedFiles,
    });
    if (options.source === 'human' && conversation.draftMessage) {
      await this.options.store.updateConversationDraft({ conversationId: conversation.id, draftMessage: '' });
    }
    const updated = await this.requireUpdatedConversation(conversation.id);
    this.emit({ type: 'message.created', conversation: updated, message, run: updated.activeRun });
    const execution = this.executeRunSafely(updated.id, run.id, {
      conversationId: updated.id,
      callStackAgentIds: [agent.id],
      ...(options.sidekick ? { sidekick: options.sidekick } : {}),
    });
    if (options.onRunSettled) {
      void execution.then((result) => options.onRunSettled?.(result));
    }
    void execution;
    return updated;
  }

  public async askPeerAgent(input: PersonalAgentAskPeerInput): Promise<PersonalAgentAskPeerResult> {
    const message = input.message.trim();
    if (!message) {
      return {
        success: false,
        status: 'failed',
        userMessage: 'El mensaje para el otro agente esta vacio.',
        technicalCode: 'personal_agent_peer_message_required',
      };
    }
    const caller = await this.options.store.requireAgent(input.callerAgentId);
    const callerConversation = await this.options.store.requireConversation(input.callerConversationId);
    if (callerConversation.agentId !== caller.id) {
      throw new Error('personal_agent_peer_source_conversation_mismatch');
    }
    let target: PersonalAgent;
    let thread: PersonalAgentPeerThread;
    if (input.threadId) {
      const existingThread = await this.options.store.getPeerThread(input.threadId);
      if (!existingThread) {
        throw new Error('personal_agent_peer_thread_not_found');
      }
      if (existingThread.callerAgentId !== caller.id || existingThread.sourceConversationId !== callerConversation.id) {
        throw new Error('personal_agent_peer_thread_not_allowed');
      }
      target = await this.options.store.requireAgent(existingThread.targetAgentId);
      thread = existingThread;
    } else {
      const targetAgentId = input.targetAgentId?.trim();
      if (!targetAgentId) {
        throw new Error('personal_agent_peer_target_required');
      }
      target = await this.options.store.requireAgent(targetAgentId);
      if (target.id === caller.id) {
        throw new Error('personal_agent_peer_self_call_blocked');
      }
      const callStack = normalizeCallStack(input.callStackAgentIds, caller.id);
      if (callStack.includes(target.id)) {
        throw new Error('personal_agent_peer_cycle_blocked');
      }
      if (callStack.length >= MAX_PEER_AGENT_DEPTH) {
        throw new Error('personal_agent_peer_depth_exceeded');
      }
      const grant = await this.options.store.getPeerGrant(caller.id, target.id);
      if (!grant) {
        throw new Error('personal_agent_peer_not_granted');
      }
      const targetConversation = await this.options.store.createConversation({
        agentId: target.id,
        title: deriveConversationTitle(message),
        origin: 'agent',
        readOnly: true,
        initiatorAgentId: caller.id,
      });
      const parentThread = await this.options.store.getPeerThreadByTargetConversation(callerConversation.id);
      thread = await this.options.store.createPeerThread({
        callerAgentId: caller.id,
        targetAgentId: target.id,
        sourceConversationId: callerConversation.id,
        targetConversationId: targetConversation.id,
        parentThreadId: parentThread?.id,
        createdByRunId: input.callerRunId,
        title: deriveConversationTitle(message),
      });
      this.emit({ type: 'conversation.created', conversation: await this.options.store.requireConversation(targetConversation.id) });
    }
    const grant = await this.options.store.getPeerGrant(caller.id, target.id);
    if (!grant) {
      throw new Error('personal_agent_peer_not_granted');
    }
    const targetConversation = await this.options.store.requireConversation(thread.targetConversationId);
    if (targetConversation.activeRun && !isTerminalRunStatus(targetConversation.activeRun.status)) {
      throw new Error('personal_agent_run_active');
    }
    const runtime = await this.resolveRuntimeForAgent(target);
    if (runtime && targetConversation.provider && targetConversation.provider !== runtime.provider) {
      throw new Error('personal_agent_provider_changed_new_conversation_required');
    }
    const run = await this.options.store.createRun({ agentId: target.id, conversationId: targetConversation.id });
    this.activities.set(run.id, this.createActivityForRun(run, target, targetConversation));
    const userMessage = await this.options.store.addMessage({
      agentId: target.id,
      conversationId: targetConversation.id,
      runId: run.id,
      role: 'user',
      authorType: 'agent',
      authorAgentId: caller.id,
      content: message,
    });
    const updatedTargetConversation = await this.requireUpdatedConversation(targetConversation.id);
    this.emit({ type: 'message.created', conversation: updatedTargetConversation, message: userMessage, run: updatedTargetConversation.activeRun });
    const callStack = [...normalizeCallStack(input.callStackAgentIds, caller.id), target.id];
    const execution = this.executeRunSafely(updatedTargetConversation.id, run.id, {
      conversationId: updatedTargetConversation.id,
      peerThreadId: thread.id,
      callStackAgentIds: callStack,
    });
    const executionResult = await withTimeout(execution, PERSONAL_AGENT_RUN_TIMEOUT_MS);
    const latestThread = await this.options.store.getPeerThread(thread.id) ?? thread;
    if (!executionResult) {
      return {
        success: false,
        status: 'timeout',
        thread: latestThread,
        userMessage: 'El agente destino sigue trabajando. El transcript quedo guardado en el thread.',
        technicalCode: 'personal_agent_peer_timeout',
      };
    }
    if (!executionResult.success) {
      await this.options.store.updatePeerThreadStatus({ threadId: thread.id, status: 'failed' });
      return {
        success: false,
        status: 'failed',
        thread: await this.options.store.getPeerThread(thread.id) ?? latestThread,
        userMessage: 'El agente destino no pudo responder.',
        technicalCode: executionResult.error instanceof Error ? executionResult.error.message : 'personal_agent_peer_run_failed',
      };
    }
    const completedThread = await this.options.store.getPeerThread(thread.id) ?? latestThread;
    const response = latestAssistantMessage(completedThread.messages);
    return {
      success: true,
      status: 'completed',
      thread: completedThread,
      response: response?.content,
      userMessage: response?.content ?? 'El agente destino termino sin texto visible.',
    };
  }

  private async executeRunSafely(
    conversationId: string,
    runId: string,
    context: PersonalAgentMcpRunContext,
  ): Promise<{ success: true } | { success: false; error: unknown }> {
    try {
      await this.executeRun(conversationId, runId, context);
      return { success: true };
    } catch (error) {
      await this.failRun(runId, error);
      return { success: false, error };
    }
  }

  private async executeRun(conversationId: string, runId: string, context: PersonalAgentMcpRunContext): Promise<void> {
    const conversation = await this.options.store.requireConversation(conversationId);
    const run = await this.options.store.updateRunStatus({ runId, status: 'running' });

    const agent = await this.options.store.requireAgent(conversation.agentId);
    this.updateActivityForRun(run, 'running', { agent, conversation });
    this.emit({ type: 'run.started', conversation: await this.requireUpdatedConversation(conversationId), run });
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
    const prompt = await this.buildPrompt(agent, conversationForRun, run, context);
    const sharedRoots = await this.resolveAppTrustedRoots(agent.appIds);
    const trustedRoots = [
      ...trustedRootsForConversationFiles(workspaceRoot, conversationForRun.messages),
      ...sharedRoots,
    ];
    const progressWrites: Array<Promise<void>> = [];
    const visibleActivityParts: string[] = [];
    const result = await this.runPersonalAgent({
      agent,
      conversation: conversationForRun,
      run,
      runtime,
      prompt,
      workspaceRoot,
      sharedRoots,
      trustedRoots,
      mcpContext: context,
      onProgress: (message, progressOptions) => {
        const visibleActivity = typeof message === 'string'
          ? sanitizeAgentRunActivityText(message)
          : '';
        if (!visibleActivity) return;
        visibleActivityParts.push(visibleActivity);
        progressWrites.push(this.recordProgress(run.id, visibleActivity, {
          includeActivity: progressOptions?.includeActivity !== false,
        }));
      },
    });
    await Promise.all(progressWrites);
    const latestRun = await this.options.store.getRun(run.id);
    if (latestRun?.status === 'canceled') return;
    const assistantText = result.assistantText || 'Done.';
    await this.options.store.deleteDuplicateRunProgress({ runId: run.id, finalContent: assistantText });
    const normalizedFinal = normalizeMessageText(assistantText);
    // The persisted `reasoning` field is a user-visible activity summary. It
    // contains sanitized progress receipts, never hidden chain-of-thought.
    const reasoning = visibleActivityParts
      .filter((part) => !isDuplicateFinalProgress(normalizedFinal, part))
      .join('\n\n');
    const assistantMessage = await this.options.store.addMessage({
      agentId: conversation.agentId,
      conversationId: conversation.id,
      runId: run.id,
      role: 'assistant',
      source: conversation.origin === 'sidekick' ? 'sidekick' : undefined,
      content: assistantText,
      ...(reasoning ? { reasoning } : {}),
    });
    const completed = await this.options.store.updateRunStatus({ runId, status: 'completed' });
    const updated = await this.requireUpdatedConversation(conversationId);
    this.updateActivityForRun(completed, 'completed', { agent, conversation: updated });
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
    this.updateActivityForRun(failed, 'failed', { error: failed.error });
    this.emit({ type: 'run.failed', conversation: await this.requireUpdatedConversation(run.conversationId), run: failed });
  }

  private async recordProgress(
    runId: string,
    message: string,
    options: { includeActivity?: boolean } = {},
  ): Promise<void> {
    const progress = await this.options.store.addRunProgress({ runId, message });
    const run = await this.options.store.getRun(runId);
    if (!run) {
      return;
    }
    if (options.includeActivity !== false) {
      this.activities.set(
        runId,
        addStatusActivityItem(this.activities.get(runId) ?? this.createActivityForRun(run), message),
      );
      this.persistActivity(runId);
    }
    const sourceConversation = await this.options.store.requireConversation(run.conversationId);
    const intermediateMessage = await this.options.store.addMessage({
      agentId: run.agentId,
      conversationId: run.conversationId,
      runId: run.id,
      role: 'assistant',
      kind: 'intermediate',
      source: sourceConversation.origin === 'sidekick' ? 'sidekick' : undefined,
      content: message,
    });
    const conversation = await this.requireUpdatedConversation(run.conversationId);
    this.emit({ type: 'message.created', conversation, message: intermediateMessage, run });
    this.emit({ type: 'run.progress', conversation, run, progress });
  }

  private async buildPrompt(
    agent: PersonalAgent,
    conversation: PersonalAgentConversation,
    run: PersonalAgentRun,
    context: PersonalAgentMcpRunContext,
  ): Promise<string> {
    const currentMessage = conversation.messages.find((message) => message.runId === run.id && message.role === 'user');
    const isFirstRun = !conversation.messages.some((message) =>
      message.id !== currentMessage?.id && message.role !== 'system' && message.kind !== 'spoken');
    const bootstrap = isFirstRun
      ? await this.buildConversationBootstrap(agent)
      : '';
    const transcript = conversation.messages
      .filter((message) =>
        message.id !== currentMessage?.id && message.role !== 'system' && message.kind !== 'spoken')
      .map((message) => renderMessageForPrompt(agent, message))
      .join('\n\n');
    const sidekickContract = context.sidekick ? [
      'Sidekick voice response contract (highest priority for this turn):',
      `- This request came from Sidekick ${context.sidekick.sidekickId}.`,
      `- Respond in the language and regional style represented by BCP-47 locale ${context.sidekick.locale}.`,
      '- Keep the response brief, natural, and suitable for spoken delivery.',
      '- Finish exactly once with respond_and_end, or use respond_and_wait only when a spoken follow-up is required.',
      '- The text argument is the exact text Desktop will speak. Do not repeat it as an additional final answer.',
      '- Do not call TTS or audio playback tools. respond_and_* only declares text and mode; Desktop synthesizes, plays, and cancels audio.',
      '',
    ] : [];
    const sidekickFinalReminder = context.sidekick ? [
      '',
      'Mandatory Sidekick final action:',
      '- Call exactly one response tool. Do not finish with plain assistant text.',
      '- Use respond_and_wait when the spoken text asks a question or needs the person to answer; otherwise use respond_and_end.',
      '- Plain assistant text is only a compatibility fallback: a final question mark waits for one reply; other text closes the session.',
    ] : [];
    return [
      ...(bootstrap ? [bootstrap, ''] : []),
      ...sidekickContract,
      'Visible conversation so far:',
      transcript || '- No visible messages yet.',
      '',
      'Current user message:',
      currentMessage ? renderMessageForPrompt(agent, currentMessage) : '',
      ...sidekickFinalReminder,
    ].join('\n');
  }

  private async buildConversationBootstrap(agent: PersonalAgent): Promise<string> {
    const memories = await this.options.store.listMemories(agent.id);
    const memoryRegister = memories.length > 0
      ? memories.map((memory) => `- ${memory.title}: ${memory.content}${memory.rememberWhen ? ` (remember when: ${memory.rememberWhen})` : ''}`).join('\n')
      : '- No agent memories have been saved yet.';
    return buildPersonalAgentInitialWakePrompt({ agent, memoryRegister });
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
    if (!(await existsDirectory(input.workspaceRoot))) {
      throw new Error('personal_agent_workspace_missing');
    }
    const pathEntries = await (this.options.getCodexPathEntries?.() ?? Promise.resolve([]));
    const environment = await (this.options.getCodexEnvironment?.() ?? Promise.resolve({}));
    const runLogPath = getRunLogPath(path.join(this.options.metadataRoot, 'personal-agents'), input.run.id);
    const networkAccess = input.agent.networkAccess;
    let forgerMcpSession: { url: string; token: string } | null = null;
    let mcpServers: LlmAppMcpServerConfig[] = [];
    const logWrites: Array<Promise<void>> = [];
    try {
      const appMcpServers = await (this.options.listenAppMcps?.(input.agent.appIds, input.run.id) ?? Promise.resolve([]));
      forgerMcpSession = this.options.createForgerMcpSession?.(input.run.id, input.agent, input.mcpContext) ?? null;
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
      const onOutput = (stream: 'stdout' | 'stderr' | 'meta', text: string): void => {
        logWrites.push(appendRunLog(runLogPath, stream, text));
        this.handleProviderOutput(input, runtime.provider, stream, text);
      };
      const providerRunService = createLlmProviderRunService({
        codexHome: this.options.codexHome,
        providerProfilesRoot: this.options.providerProfilesRoot,
        resolveAuthProfile: this.options.resolveAuthProfile,
        getCodexCliPath: this.options.getCodexCliPath,
        getClaudeCliPath: this.options.getClaudeCliPath,
        getAntigravityCliPath: this.options.getAntigravityCliPath,
        getCodexAuthenticated: this.options.getCodexAuthenticated,
        getClaudeAuthenticated: this.options.getClaudeAuthenticated,
        getAntigravityAuthenticated: this.options.getAntigravityAuthenticated,
        ensureGitAvailable: this.options.ensureGitAvailable,
      });
      const result = await providerRunService.run({
        surface: 'personal_agent',
        mode: 'conversation',
        runtime,
        runId: input.run.id,
        pathEntries,
        environment,
        mcpServers,
        workingDir: input.workspaceRoot,
        configWorkspaceRoot: runtime.provider === 'antigravity' ? input.workspaceRoot : undefined,
        sharedRoots: input.sharedRoots,
        addDirs: input.sharedRoots,
        prompt: input.prompt,
        permissionMode: input.agent.permissionMode,
        networkAccess,
        timeoutMs: PERSONAL_AGENT_RUN_TIMEOUT_MS,
        timeoutMode: 'absolute',
        threadId: input.conversation.providerThreadId,
        codexHomePlan: runtime.provider === 'codex'
          ? {
              type: 'persistent',
              rootCodexHome: this.options.codexHome,
              targetCodexHome: path.join(
                this.options.metadataRoot,
                'personal-agent-codex-home',
                input.agent.id,
                input.conversation.id,
              ),
              trustedRoots: Array.from(new Set(input.trustedRoots)),
              networkAccess,
            }
          : { type: 'none' },
        onChild: (child) => {
          this.activeChildren.set(input.run.id, child);
        },
        onOutput,
        runCommandCapture,
      });
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
      await Promise.all(logWrites);
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

  private async resolveAppTrustedRoots(appIds: string[]): Promise<string[]> {
    if (!appIds.length || !this.options.resolveAppTrustedRoots) {
      return [];
    }
    const resolvedRoots = await this.options.resolveAppTrustedRoots([...new Set(appIds)]);
    const roots: string[] = [];
    const seen = new Set<string>();
    for (const rawRoot of resolvedRoots) {
      if (typeof rawRoot !== 'string' || !rawRoot.trim()) {
        continue;
      }
      const root = path.resolve(rawRoot);
      if (seen.has(root) || !(await existsDirectory(root))) {
        continue;
      }
      seen.add(root);
      roots.push(root);
    }
    return roots;
  }

  private handleProviderOutput(
    input: PersonalAgentRunnerInput,
    provider: AgentRuntime['provider'],
    stream: 'stdout' | 'stderr' | 'meta',
    text: string,
  ): void {
    const priorCount = this.activities.get(input.run.id)?.counts.total ?? 0;
    this.activities.set(
      input.run.id,
      appendProviderActivity({
        activity: this.activities.get(input.run.id) ?? this.createActivityForRun(input.run, input.agent, input.conversation),
        provider,
        stream,
        text,
      }),
    );
    const activityChanged = (this.activities.get(input.run.id)?.counts.total ?? 0) !== priorCount;
    const messages = toProviderProgressMessages(provider, stream, text);
    for (const message of messages) {
      input.onProgress(message, { includeActivity: !activityChanged });
    }
    if (activityChanged && messages.length === 0) {
      this.persistActivity(input.run.id);
      void this.emitActivityProgress(input.run.id);
    }
  }

  private async requireUpdatedConversation(conversationId: string): Promise<PersonalAgentConversation> {
    const updated = await this.options.store.getConversation(conversationId);
    if (!updated) {
      throw new Error('personal_agent_conversation_not_found');
    }
    return this.withActivityConversation(updated);
  }

  private emit(event: PersonalAgentConversationEvent): void {
    const normalizedEvent = this.withActivityEvent(event);
    this.options.onConversationEvent?.(normalizedEvent);
    for (const listener of this.listeners) {
      listener(normalizedEvent);
    }
  }

  private createActivityForRun(
    run: PersonalAgentRun,
    agent?: PersonalAgent,
    conversation?: PersonalAgentConversation,
  ): AgentRunActivity {
    return createAgentRunActivity({
      runId: run.id,
      surface: 'personal_agent_conversation',
      status: normalizeActivityStatus(run.status),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
      sourceRef: {
        agentId: run.agentId,
        agentName: agent?.name,
        conversationId: run.conversationId,
        title: conversation?.title,
      },
    });
  }

  private updateActivityForRun(
    run: PersonalAgentRun,
    status: AgentRunActivityStatus,
    context: { agent?: PersonalAgent; conversation?: PersonalAgentConversation; error?: string } = {},
  ): void {
    const base = this.activities.get(run.id) ?? this.createActivityForRun(run, context.agent, context.conversation);
    const updatedAt = run.updatedAt;
    const activity = status === 'completed' || status === 'failed' || status === 'canceled'
      ? finalizeAgentRunActivity(base, status, updatedAt, context.error)
      : {
          ...base,
          status,
          updatedAt,
        };
    this.activities.set(run.id, activity);
    this.persistActivity(run.id);
  }

  private withActivityRun(run: PersonalAgentRun | undefined): PersonalAgentRun | undefined {
    if (!run) {
      return undefined;
    }
    const activity = this.activities.get(run.id);
    return activity ? { ...run, activity } : run;
  }

  private withActivityConversation(conversation: PersonalAgentConversation): PersonalAgentConversation {
    return {
      ...conversation,
      ...(conversation.activeRun ? { activeRun: this.withActivityRun(conversation.activeRun) } : {}),
    };
  }

  private withActivityEvent(event: PersonalAgentConversationEvent): PersonalAgentConversationEvent {
    return {
      ...event,
      conversation: this.withActivityConversation(event.conversation),
      ...(event.run ? { run: this.withActivityRun(event.run) } : {}),
    };
  }

  private persistActivity(runId: string): void {
    const activity = this.activities.get(runId);
    if (!activity || !this.options.metadataRoot) {
      return;
    }
    void persistAgentRunActivity(path.join(this.options.metadataRoot, 'personal-agents'), activity);
  }

  private async emitActivityProgress(runId: string): Promise<void> {
    const run = await this.options.store.getRun(runId);
    if (!run) {
      return;
    }
    const conversation = await this.requireUpdatedConversation(run.conversationId);
    this.emit({
      type: 'run.progress',
      conversation,
      run,
      progress: {
        id: `${runId}:activity:${Date.now()}`,
        agentId: run.agentId,
        conversationId: run.conversationId,
        runId,
        message: this.activities.get(runId)?.summary ?? '',
        createdAt: new Date().toISOString(),
      },
    });
  }
}

const deriveConversationTitle = (content: string): string =>
  content.split(/\s+/).slice(0, FIRST_MESSAGE_TITLE_WORDS).join(' ').slice(0, 80);

const normalizeCallStack = (value: unknown, callerAgentId: string): string[] => {
  const ids = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
  const stack = ids.length > 0 ? ids : [callerAgentId];
  return [...new Set(stack)].slice(0, MAX_PEER_AGENT_DEPTH);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const latestAssistantMessage = (messages: PersonalAgentMessage[] | undefined): PersonalAgentMessage | null => {
  if (!messages?.length) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.kind === 'message') {
      return message;
    }
  }
  return null;
};

const renderMessageForPrompt = (agent: PersonalAgent, message: PersonalAgentMessage): string => {
  const authorLabel = message.authorType === 'agent'
    ? message.authorAgentName ?? (message.role === 'assistant' ? agent.name : message.authorAgentId ?? 'Agent')
    : message.authorType === 'system'
      ? 'System'
      : 'Human';
  const fileLines = (message.files ?? []).map((file) =>
    `  - ${file.name} (${file.relativePath || file.path})${typeof file.sizeBytes === 'number' ? `, ${file.sizeBytes} bytes` : ''}`);
  return [
    `${message.role} (${authorLabel}): ${message.content}`,
    ...(fileLines.length > 0 ? ['Shared files:', ...fileLines] : []),
  ].join('\n');
};

const trustedRootsForConversationFiles = (workspaceRoot: string, messages: PersonalAgentMessage[]): string[] => {
  const roots = new Set<string>([workspaceRoot]);
  for (const message of messages) {
    for (const file of message.files ?? []) {
      if (path.isAbsolute(file.path)) {
        roots.add(path.dirname(file.path));
      }
    }
  }
  return [...roots];
};
