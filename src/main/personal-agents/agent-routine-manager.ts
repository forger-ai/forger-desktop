import type {
  PersonalAgentConversation,
  PersonalAgentConversationEvent,
  PersonalAgentConversationDraftUpdateInput,
  PersonalAgentRoutine,
  PersonalAgentRoutineDeleteInput,
  PersonalAgentRoutineListInput,
  PersonalAgentRoutineRun,
  PersonalAgentRoutineRunNowInput,
  PersonalAgentRoutineSetEnabledInput,
  PersonalAgentRoutineUpsertInput,
  PersonalAgentScheduledWakeup,
  PersonalAgentWakeupCancelInput,
} from '../../shared/types';
import { computeNextRunAt, defaultMissedRunWindowMinutes } from '../automation-manager';
import type { AgentConversationManager } from './agent-conversation-manager';
import { isTerminalRunStatus, type AgentStore } from './agent-store';

interface AgentRoutineManagerOptions {
  store: AgentStore;
  conversationManager: AgentConversationManager;
  onConversationEvent?: (event: PersonalAgentConversationEvent) => void;
}

export interface PersonalAgentWakeupScheduleContext {
  agentId: string;
  conversationId: string;
  seconds: number;
  prompt: string;
  createdByRunId?: string | null;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const MISSED_RUN_GRACE_MS = 60_000;
const MIN_WAKEUP_SECONDS = 5;
const ROUTINE_THREAD_BUSY = 'routine_thread_busy';
const ROUTINE_MISSED_SCHEDULE = 'routine_missed_schedule';
const ROUTINE_INVALID_SCHEDULE = 'routine_invalid_schedule';
const ROUTINE_RUN_FAILED = 'routine_run_failed';

export class AgentRoutineManager {
  private readonly routineTimers = new Map<string, NodeJS.Timeout>();
  private readonly wakeupTimers = new Map<string, NodeJS.Timeout>();
  private initialized = false;

  public constructor(private readonly options: AgentRoutineManagerOptions) {}

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    const agents = await this.options.store.listAgents();
    const routines = (await Promise.all(agents.map((agent) => this.options.store.listRoutines(agent.id)))).flat();
    for (const routine of routines) {
      await this.scheduleRoutine(routine);
    }
    const wakeups = await this.options.store.listScheduledWakeups();
    for (const wakeup of wakeups) {
      await this.scheduleWakeupTimer(wakeup);
    }
  }

  public dispose(): void {
    for (const timer of this.routineTimers.values()) {
      clearTimeout(timer);
    }
    this.routineTimers.clear();
    for (const timer of this.wakeupTimers.values()) {
      clearTimeout(timer);
    }
    this.wakeupTimers.clear();
    this.initialized = false;
  }

  public async list(input: PersonalAgentRoutineListInput): Promise<PersonalAgentRoutine[]> {
    return await this.options.store.listRoutines(input.agentId);
  }

  public async create(agentId: string, input: PersonalAgentRoutineUpsertInput): Promise<PersonalAgentRoutine> {
    this.requireAuthorization(input.authorizationText);
    const frequency = input.frequency;
    const enabled = input.enabled !== false;
    const routine = await this.options.store.createRoutine({
      agentId,
      name: input.name,
      prompt: input.prompt,
      frequency,
      missedRunPolicy: input.missedRunPolicy ?? 'within_window',
      missedRunWindowMinutes: input.missedRunWindowMinutes,
      enabled,
      nextRunAt: enabled ? computeNextRunAt(frequency) : null,
      authorizationText: input.authorizationText,
    });
    await this.scheduleRoutine(routine);
    await this.emitRoutineUpdated(routine);
    return routine;
  }

  public async update(input: PersonalAgentRoutineUpsertInput & { routineId: string }): Promise<PersonalAgentRoutine> {
    this.requireAuthorization(input.authorizationText);
    const current = await this.options.store.requireRoutine(input.routineId);
    const frequency = input.frequency;
    const enabled = input.enabled ?? current.enabled;
    const routine = await this.options.store.updateRoutine({
      routineId: current.id,
      name: input.name,
      prompt: input.prompt,
      frequency,
      missedRunPolicy: input.missedRunPolicy ?? current.missedRunPolicy,
      missedRunWindowMinutes: input.missedRunWindowMinutes,
      enabled,
      nextRunAt: enabled ? computeNextRunAt(frequency) : null,
      authorizationText: input.authorizationText,
    });
    await this.scheduleRoutine(routine);
    await this.emitRoutineUpdated(routine);
    return routine;
  }

  public async setEnabled(input: PersonalAgentRoutineSetEnabledInput): Promise<PersonalAgentRoutine> {
    this.requireAuthorization(input.authorizationText);
    const routine = await this.options.store.requireRoutine(input.routineId);
    const updated = await this.options.store.setRoutineEnabled({
      routineId: routine.id,
      enabled: input.enabled,
      nextRunAt: input.enabled ? computeNextRunAt(routine.frequency) : null,
    });
    await this.scheduleRoutine(updated);
    await this.emitRoutineUpdated(updated);
    return updated;
  }

  public async delete(input: PersonalAgentRoutineDeleteInput): Promise<{ success: boolean }> {
    this.requireAuthorization(input.authorizationText);
    const routine = await this.options.store.requireRoutine(input.routineId);
    this.clearRoutineTimer(routine.id);
    const conversationId = routine.conversationId;
    const result = await this.options.store.deleteRoutine(routine.id);
    const conversation = await this.options.store.getConversation(conversationId);
    if (conversation) {
      this.options.onConversationEvent?.({ type: 'conversation.updated', conversation });
    }
    return result;
  }

  public async runNow(input: PersonalAgentRoutineRunNowInput): Promise<PersonalAgentRoutineRun> {
    return await this.startRoutineRun(input.routineId, 'manual');
  }

  public async scheduleWakeup(input: PersonalAgentWakeupScheduleContext): Promise<PersonalAgentScheduledWakeup> {
    const seconds = Math.floor(Number(input.seconds));
    if (!Number.isFinite(seconds) || seconds < MIN_WAKEUP_SECONDS) {
      throw new Error('personal_agent_wakeup_minimum_seconds');
    }
    const dueAt = new Date(Date.now() + seconds * 1000).toISOString();
    const wakeup = await this.options.store.scheduleWakeup({
      agentId: input.agentId,
      conversationId: input.conversationId,
      prompt: input.prompt,
      dueAt,
      createdByRunId: input.createdByRunId ?? null,
    });
    await this.scheduleWakeupTimer(wakeup);
    await this.emitWakeupEvent('wakeup.scheduled', wakeup);
    return wakeup;
  }

  public async cancelWakeup(input: PersonalAgentWakeupCancelInput): Promise<PersonalAgentScheduledWakeup | null> {
    const wakeup = await this.options.store.cancelWakeup(input);
    if (!wakeup) {
      return null;
    }
    this.clearWakeupTimer(wakeup.id);
    await this.emitWakeupEvent('wakeup.canceled', wakeup);
    return wakeup;
  }

  public async updateDraft(input: PersonalAgentConversationDraftUpdateInput): Promise<PersonalAgentConversation> {
    const conversation = await this.options.store.updateConversationDraft(input);
    this.options.onConversationEvent?.({ type: 'conversation.updated', conversation });
    return conversation;
  }

  private async scheduleRoutine(routine: PersonalAgentRoutine): Promise<void> {
    this.clearRoutineTimer(routine.id);
    if (!routine.enabled || !routine.nextRunAt) {
      return;
    }
    const dueAt = Date.parse(routine.nextRunAt);
    if (!Number.isFinite(dueAt)) {
      await this.skipRoutineRun(routine.id, ROUTINE_INVALID_SCHEDULE);
      return;
    }
    const delay = dueAt - Date.now();
    if (delay <= 0) {
      await this.handleDueRoutine(routine.id);
      return;
    }
    const timer = setTimeout(() => {
      void this.scheduleRoutineById(routine.id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.routineTimers.set(routine.id, timer);
  }

  private async scheduleRoutineById(routineId: string): Promise<void> {
    const routine = await this.options.store.getRoutine(routineId);
    if (!routine) {
      this.clearRoutineTimer(routineId);
      return;
    }
    await this.scheduleRoutine(routine);
  }

  private async handleDueRoutine(routineId: string): Promise<void> {
    const routine = await this.options.store.getRoutine(routineId);
    if (!routine?.enabled || !routine.nextRunAt) {
      return;
    }
    const dueAt = Date.parse(routine.nextRunAt);
    const latenessMs = Date.now() - dueAt;
    if (this.shouldRunMissedRoutine(routine, latenessMs)) {
      void this.startRoutineRun(routine.id, 'scheduled');
      return;
    }
    await this.skipRoutineRun(routine.id, ROUTINE_MISSED_SCHEDULE);
  }

  private shouldRunMissedRoutine(routine: PersonalAgentRoutine, latenessMs: number): boolean {
    if (latenessMs <= MISSED_RUN_GRACE_MS) {
      return true;
    }
    if (routine.missedRunPolicy === 'always') {
      return true;
    }
    if (routine.missedRunPolicy !== 'within_window') {
      return false;
    }
    const windowMs = (routine.missedRunWindowMinutes ?? defaultMissedRunWindowMinutes(routine.frequency)) * 60_000;
    return latenessMs <= windowMs;
  }

  private async startRoutineRun(routineId: string, trigger: PersonalAgentRoutineRun['trigger']): Promise<PersonalAgentRoutineRun> {
    const routine = await this.options.store.requireRoutine(routineId);
    const conversation = await this.options.store.requireConversation(routine.conversationId);
    if (conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status)) {
      return await this.skipRoutineRun(routine.id, ROUTINE_THREAD_BUSY);
    }

    const routineRun = await this.options.store.createRoutineRun({
      routineId: routine.id,
      trigger,
      status: 'queued',
    });
    await this.options.store.updateRoutineSchedule({ routineId: routine.id, running: true });
    await this.emitRoutineUpdated(await this.options.store.requireRoutine(routine.id));

    let messageId: string | undefined;
    try {
      const updated = await this.options.conversationManager.sendScheduledMessage({
        conversationId: routine.conversationId,
        content: routine.prompt,
        source: 'routine',
        routineId: routine.id,
        onRunSettled: async (result) => {
          if (result.success) {
            await this.finishRoutineRun(routineRun.id, 'succeeded', messageId);
          } else {
            await this.finishRoutineRun(
              routineRun.id,
              'failed',
              messageId,
              result.error instanceof Error ? result.error.message : ROUTINE_RUN_FAILED,
            );
          }
        },
      });
      messageId = latestRoutineMessageId(updated, routine.id);
      await this.options.store.updateRoutineRun({ runId: routineRun.id, status: 'running', messageId });
      await this.emitRoutineUpdated(await this.options.store.requireRoutine(routine.id));
      return await this.options.store.updateRoutineRun({ runId: routineRun.id, status: 'running', messageId });
    } catch (error) {
      await this.finishRoutineRun(
        routineRun.id,
        'failed',
        messageId,
        error instanceof Error ? error.message : ROUTINE_RUN_FAILED,
      );
      return await this.options.store.updateRoutineRun({
        runId: routineRun.id,
        status: 'failed',
        messageId,
        error: error instanceof Error ? error.message : ROUTINE_RUN_FAILED,
      });
    }
  }

  private async finishRoutineRun(
    routineRunId: string,
    status: 'succeeded' | 'failed',
    messageId?: string,
    error?: string,
  ): Promise<void> {
    const run = await this.options.store.updateRoutineRun({
      runId: routineRunId,
      status,
      messageId,
      error,
    }).catch((updateError) => {
      if (updateError instanceof Error && updateError.message === 'personal_agent_routine_run_not_found') {
        return null;
      }
      throw updateError;
    });
    if (!run) {
      return;
    }
    const routine = await this.options.store.getRoutine(run.routineId);
    if (!routine) {
      return;
    }
    const updated = await this.options.store.updateRoutineSchedule({
      routineId: routine.id,
      running: false,
      nextRunAt: routine.enabled ? computeNextRunAt(routine.frequency) : null,
    });
    await this.emitRoutineUpdated(updated);
    await this.scheduleRoutine(updated);
  }

  private async skipRoutineRun(routineId: string, error: string): Promise<PersonalAgentRoutineRun> {
    const routine = await this.options.store.requireRoutine(routineId);
    const run = await this.options.store.createRoutineRun({
      routineId: routine.id,
      trigger: 'scheduled',
      status: 'skipped',
      error,
    });
    const updated = await this.options.store.updateRoutineSchedule({
      routineId: routine.id,
      running: false,
      nextRunAt: routine.enabled ? computeNextRunAt(routine.frequency) : null,
    });
    await this.emitRoutineUpdated(updated);
    await this.scheduleRoutine(updated);
    return run;
  }

  private async scheduleWakeupTimer(wakeup: PersonalAgentScheduledWakeup): Promise<void> {
    this.clearWakeupTimer(wakeup.id);
    if (wakeup.status !== 'scheduled') {
      return;
    }
    const dueAt = Date.parse(wakeup.dueAt);
    if (!Number.isFinite(dueAt)) {
      await this.options.store.updateWakeupStatus({ wakeupId: wakeup.id, status: 'canceled' });
      return;
    }
    const delay = dueAt - Date.now();
    if (delay <= 0) {
      await this.fireWakeup(wakeup.id);
      return;
    }
    const timer = setTimeout(() => {
      void this.scheduleWakeupById(wakeup.id);
    }, Math.min(delay, MAX_TIMEOUT_MS));
    this.wakeupTimers.set(wakeup.id, timer);
  }

  private async scheduleWakeupById(wakeupId: string): Promise<void> {
    const wakeup = (await this.options.store.listScheduledWakeups()).find((candidate) => candidate.id === wakeupId);
    if (!wakeup) {
      this.clearWakeupTimer(wakeupId);
      return;
    }
    await this.scheduleWakeupTimer(wakeup);
  }

  private async fireWakeup(wakeupId: string): Promise<void> {
    const wakeup = (await this.options.store.listScheduledWakeups()).find((candidate) => candidate.id === wakeupId);
    if (!wakeup) {
      this.clearWakeupTimer(wakeupId);
      return;
    }
    const conversation = await this.options.store.requireConversation(wakeup.conversationId);
    if (conversation.activeRun && !isTerminalRunStatus(conversation.activeRun.status)) {
      const timer = setTimeout(() => {
        void this.fireWakeup(wakeup.id);
      }, 1000);
      this.wakeupTimers.set(wakeup.id, timer);
      return;
    }
    const fired = await this.options.store.updateWakeupStatus({ wakeupId: wakeup.id, status: 'fired' });
    await this.emitWakeupEvent('conversation.updated', fired);
    await this.options.conversationManager.sendScheduledMessage({
      conversationId: wakeup.conversationId,
      content: wakeup.prompt,
      source: 'scheduled_wakeup',
      wakeupId: wakeup.id,
    });
    this.clearWakeupTimer(wakeup.id);
  }

  private async emitRoutineUpdated(routine: PersonalAgentRoutine): Promise<void> {
    const conversation = await this.options.store.getConversation(routine.conversationId);
    if (!conversation) {
      return;
    }
    this.options.onConversationEvent?.({ type: 'routine.updated', conversation, routine });
  }

  private async emitWakeupEvent(
    type: Extract<PersonalAgentConversationEvent['type'], 'wakeup.scheduled' | 'wakeup.canceled' | 'conversation.updated'>,
    wakeup: PersonalAgentScheduledWakeup,
  ): Promise<void> {
    const conversation = await this.options.store.getConversation(wakeup.conversationId);
    if (!conversation) {
      return;
    }
    this.options.onConversationEvent?.({ type, conversation, wakeup });
  }

  private clearRoutineTimer(routineId: string): void {
    const timer = this.routineTimers.get(routineId);
    if (timer) {
      clearTimeout(timer);
      this.routineTimers.delete(routineId);
    }
  }

  private clearWakeupTimer(wakeupId: string): void {
    const timer = this.wakeupTimers.get(wakeupId);
    if (timer) {
      clearTimeout(timer);
      this.wakeupTimers.delete(wakeupId);
    }
  }

  private requireAuthorization(value: string | undefined): void {
    if (!value?.trim()) {
      throw new Error('personal_agent_routine_authorization_required');
    }
  }
}

const latestRoutineMessageId = (conversation: PersonalAgentConversation, routineId: string): string | undefined => {
  for (let index = conversation.messages.length - 1; index >= 0; index -= 1) {
    const message = conversation.messages[index];
    if (message?.source === 'routine' && message.routineId === routineId) {
      return message.id;
    }
  }
  return undefined;
};
