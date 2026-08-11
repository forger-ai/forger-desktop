import type {
  AgentToolId,
  AutomationFrequency,
  PersonalAgentRoutine,
  PersonalAgentScheduledWakeup,
} from '../../shared/types';
import { buildFailureDiagnostic } from '../../shared/error-diagnostics';
import { getSharedCopy } from '../../shared/i18n';
import type { AgentMcpSession } from '../forger-mcp-server';
import { cleanString } from '../forger-mcp-server-helpers';

interface PersonalAgentRoutineToolOptions {
  schedulePersonalAgentWakeup?: (input: { agentId: string; conversationId: string; runId: string; seconds: number; prompt: string }) => Promise<PersonalAgentScheduledWakeup>;
  cancelPersonalAgentWakeup?: (input: { wakeupId?: string; conversationId?: string }) => Promise<PersonalAgentScheduledWakeup | null>;
  createAgentRoutine?: (input: {
    agentId: string;
    name: string;
    prompt: string;
    frequency: AutomationFrequency;
    missedRunPolicy?: 'skip' | 'always' | 'within_window';
    missedRunWindowMinutes?: number;
    enabled?: boolean;
    authorizationText: string;
  }) => Promise<PersonalAgentRoutine>;
  listAgentRoutines?: (input: { agentId: string }) => Promise<PersonalAgentRoutine[]>;
  updateAgentRoutine?: (input: {
    agentId: string;
    routineId: string;
    name: string;
    prompt: string;
    frequency: AutomationFrequency;
    missedRunPolicy?: 'skip' | 'always' | 'within_window';
    missedRunWindowMinutes?: number;
    enabled?: boolean;
    authorizationText: string;
  }) => Promise<PersonalAgentRoutine>;
  deleteAgentRoutine?: (input: { agentId: string; routineId: string; authorizationText: string }) => Promise<{ success: boolean }>;
}

export const executePersonalAgentRoutineTool = async (
  session: AgentMcpSession,
  toolId: AgentToolId,
  args: Record<string, unknown>,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (session.caller !== 'personal-agent' || !session.personalAgentId || !session.personalAgentConversationId) {
    return {
      success: false,
      userMessage: 'Esta herramienta solo esta disponible dentro de una conversacion de agente personal.',
      technicalCode: 'personal_agent_context_required',
    };
  }

  try {
    if (toolId === 'wakeup_in') {
      return await executeWakeupIn(session, args, options);
    }
    if (toolId === 'cancel_wakeup') {
      return await executeCancelWakeup(session, args, options);
    }
    if (toolId === 'list_agent_routines') {
      return await executeListRoutines(session, options);
    }
    if (toolId === 'create_agent_routine') {
      return await executeCreateRoutine(session, args, options);
    }
    if (toolId === 'update_agent_routine') {
      return await executeUpdateRoutine(session, args, options);
    }
    if (toolId === 'delete_agent_routine') {
      return await executeDeleteRoutine(session, args, options);
    }
  } catch (error) {
    const diagnostic = buildFailureDiagnostic({
      error,
      technicalCode: error instanceof Error ? error.message : undefined,
      fallbackCode: 'personal_agent_routine_failed',
    });
    return {
      success: false,
      userMessage: personalAgentRoutineErrorMessage(diagnostic.technicalCode),
      ...diagnostic,
    };
  }

  return { success: false, userMessage: getSharedCopy(session.locale).tools.unavailable, technicalCode: 'tool_not_found' };
};

const executeWakeupIn = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (!options.schedulePersonalAgentWakeup) {
    return { success: false, userMessage: 'No pudimos programar el despertar.', technicalCode: 'personal_agent_wakeup_unavailable' };
  }
  const prompt = cleanString(args.prompt);
  const seconds = typeof args.seconds === 'number' ? args.seconds : Number(args.seconds);
  if (!prompt || !Number.isFinite(seconds)) {
    return {
      success: false,
      userMessage: 'Indica seconds y prompt para programar el despertar.',
      technicalCode: 'personal_agent_wakeup_input_invalid',
    };
  }
  const wakeup = await options.schedulePersonalAgentWakeup({
    agentId: session.personalAgentId as string,
    conversationId: session.personalAgentConversationId as string,
    runId: session.runId,
    seconds,
    prompt,
  });
  return {
    success: true,
    wakeup,
    userMessage: `Despertare este thread en ${Math.max(5, Math.floor(seconds))} segundos. El thread queda bloqueado hasta despertar o cancelar.`,
  };
};

const executeCancelWakeup = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (!options.cancelPersonalAgentWakeup) {
    return { success: false, userMessage: 'No pudimos cancelar el despertar.', technicalCode: 'personal_agent_wakeup_unavailable' };
  }
  const wakeup = await options.cancelPersonalAgentWakeup({
    wakeupId: cleanString(args.wakeupId) || undefined,
    conversationId: session.personalAgentConversationId,
  });
  return {
    success: Boolean(wakeup),
    wakeup,
    userMessage: wakeup ? 'Despertar cancelado.' : 'No habia un despertar pendiente para cancelar.',
    technicalCode: wakeup ? undefined : 'personal_agent_wakeup_not_found',
  };
};

const executeListRoutines = async (
  session: AgentMcpSession,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (!options.listAgentRoutines) {
    return { success: false, userMessage: 'No pudimos listar las rutinas.', technicalCode: 'personal_agent_routines_unavailable' };
  }
  const routines = await options.listAgentRoutines({ agentId: session.personalAgentId as string });
  return { success: true, routines };
};

const executeCreateRoutine = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (!options.createAgentRoutine) {
    return { success: false, userMessage: 'No pudimos crear la rutina.', technicalCode: 'personal_agent_routines_unavailable' };
  }
  const input = parseAgentRoutineMutationInput(args, false);
  if (!input) {
    return {
      success: false,
      userMessage: 'Completa name, periodicity, prompt y authorizationText para crear la rutina.',
      technicalCode: 'personal_agent_routine_input_invalid',
    };
  }
  const routine = await options.createAgentRoutine({ agentId: session.personalAgentId as string, ...input });
  return { success: true, routine, userMessage: 'Rutina creada para este agente personal.' };
};

const executeUpdateRoutine = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (!options.updateAgentRoutine) {
    return { success: false, userMessage: 'No pudimos actualizar la rutina.', technicalCode: 'personal_agent_routines_unavailable' };
  }
  const input = parseAgentRoutineMutationInput(args, true);
  const routineId = input?.routineId;
  if (!routineId) {
    return {
      success: false,
      userMessage: 'Completa routineId, name, periodicity, prompt y authorizationText para actualizar la rutina.',
      technicalCode: 'personal_agent_routine_input_invalid',
    };
  }
  const routine = await options.updateAgentRoutine({ agentId: session.personalAgentId as string, ...input, routineId });
  return { success: true, routine, userMessage: 'Rutina actualizada.' };
};

const executeDeleteRoutine = async (
  session: AgentMcpSession,
  args: Record<string, unknown>,
  options: PersonalAgentRoutineToolOptions,
): Promise<unknown> => {
  if (!options.deleteAgentRoutine) {
    return { success: false, userMessage: 'No pudimos borrar la rutina.', technicalCode: 'personal_agent_routines_unavailable' };
  }
  const routineId = cleanString(args.routineId);
  const authorizationText = cleanString(args.authorizationText);
  if (!routineId || !authorizationText) {
    return {
      success: false,
      userMessage: 'Indica routineId y authorizationText para borrar la rutina.',
      technicalCode: 'personal_agent_routine_input_invalid',
    };
  }
  const result = await options.deleteAgentRoutine({
    agentId: session.personalAgentId as string,
    routineId,
    authorizationText,
  });
  return { ...result, userMessage: result.success ? 'Rutina eliminada. El thread se conserva como conversacion normal.' : 'No pudimos borrar la rutina.' };
};

const parseAgentRoutineMutationInput = (
  args: Record<string, unknown>,
  requireRoutineId: boolean,
): {
  routineId?: string;
  name: string;
  prompt: string;
  frequency: AutomationFrequency;
  missedRunPolicy?: 'skip' | 'always' | 'within_window';
  missedRunWindowMinutes?: number;
  enabled?: boolean;
  authorizationText: string;
} | null => {
  const routineId = cleanString(args.routineId);
  const name = cleanString(args.name);
  const prompt = cleanString(args.prompt);
  const authorizationText = cleanString(args.authorizationText);
  const frequency = parseAgentRoutineFrequency(args.periodicity ?? args.frequency);
  if ((requireRoutineId && !routineId) || !name || !prompt || !authorizationText || !frequency) {
    return null;
  }
  const missedRunPolicy = parseMissedRunPolicy(args.missedRunPolicy);
  const missedRunWindowMinutes = parsePositiveInteger(args.missedRunWindowMinutes);
  return {
    ...(routineId ? { routineId } : {}),
    name,
    prompt,
    frequency,
    ...(missedRunPolicy ? { missedRunPolicy } : {}),
    missedRunWindowMinutes,
    enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
    authorizationText,
  };
};

const parseAgentRoutineFrequency = (value: unknown): AutomationFrequency | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const input = value as { type?: unknown; timeOfDay?: unknown; weeklyDay?: unknown };
  if (input.type === 'hourly') {
    return { type: 'hourly' };
  }
  if (input.type === 'daily') {
    return { type: 'daily', timeOfDay: parseTimeOfDay(input.timeOfDay) };
  }
  if (input.type === 'weekly') {
    return {
      type: 'weekly',
      timeOfDay: parseTimeOfDay(input.timeOfDay),
      weeklyDay: parseWeeklyDay(input.weeklyDay),
    };
  }
  return null;
};

const parseTimeOfDay = (value: unknown): string => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) {
    return '09:00';
  }
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const parseWeeklyDay = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.min(6, Math.max(0, Math.floor(numeric)));
};

const parseMissedRunPolicy = (value: unknown): 'skip' | 'always' | 'within_window' | undefined =>
  value === 'skip' || value === 'always' || value === 'within_window' ? value : undefined;

const parsePositiveInteger = (value: unknown): number | undefined => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  return Math.floor(numeric);
};

const personalAgentRoutineErrorMessage = (code?: string): string => {
  if (code === 'personal_agent_wakeup_minimum_seconds') {
    return 'El despertar debe ser de al menos 5 segundos.';
  }
  if (code === 'personal_agent_wakeup_active') {
    return 'Este thread ya tiene un despertar pendiente.';
  }
  if (code === 'personal_agent_routine_authorization_required') {
    return 'La rutina necesita autorizacion textual de la persona.';
  }
  if (code === 'personal_agent_routine_not_found') {
    return 'No encontramos esa rutina.';
  }
  return 'No pudimos completar la operacion de rutinas.';
};
