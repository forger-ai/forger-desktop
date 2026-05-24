import { contextBridge, ipcRenderer } from 'electron';
import type { ForgerAppApi } from '../shared/types';

const IPC_CHANNELS = {
  appSelectExternalFolder: 'forger:app:select-external-folder',
  appGetContext: 'forger:app:get-context',
  appAiSubscriptionStatus: 'forger:app:ai-subscription-status',
  appRendererError: 'forger:app:renderer-error',
  appAgentTaskStart: 'forger:app:agent-task:start',
  appAgentTaskGet: 'forger:app:agent-task:get',
  appAgentTaskCancel: 'forger:app:agent-task:cancel',
  appAgentTaskApprovePermission: 'forger:app:agent-task:approve-permission',
  appAgentTaskUpdated: 'forger:app:agent-task:updated',
  appCodexTaskStart: 'forger:app:codex-task:start',
  appCodexTaskGet: 'forger:app:codex-task:get',
  appCodexTaskCancel: 'forger:app:codex-task:cancel',
  appCodexTaskApprovePermission: 'forger:app:codex-task:approve-permission',
  appCodexTaskUpdated: 'forger:app:codex-task:updated',
  appAgentConversationCreate: 'forger:app:agent-conversation:create',
  appAgentConversationSendMessage: 'forger:app:agent-conversation:send-message',
  appAgentConversationGet: 'forger:app:agent-conversation:get',
  appAgentConversationList: 'forger:app:agent-conversation:list',
  appAgentConversationDelete: 'forger:app:agent-conversation:delete',
  appAgentConversationCancelRun: 'forger:app:agent-conversation:cancel-run',
  appAgentConversationApprovePermission: 'forger:app:agent-conversation:approve-permission',
  appAgentConversationEvent: 'forger:app:agent-conversation:event',
  appAgentThreadCreate: 'forger:app:agent-thread:create',
  appAgentThreadRunStart: 'forger:app:agent-thread-run:start',
  appAgentThreadGet: 'forger:app:agent-thread:get',
  appAgentThreadRunGet: 'forger:app:agent-thread-run:get',
  appAgentThreadRunCancel: 'forger:app:agent-thread-run:cancel',
  appAgentThreadRunSteer: 'forger:app:agent-thread-run:steer',
  appAgentThreadEvent: 'forger:app:agent-thread:event',
  appManifestAgentStart: 'forger:app:agents:start',
  appManifestAgentResume: 'forger:app:agents:resume',
  appManifestAgentSteer: 'forger:app:agents:steer',
  appManifestAgentStop: 'forger:app:agents:stop',
  appCodexConversationCreate: 'forger:app:codex-conversation:create',
  appCodexConversationSendMessage: 'forger:app:codex-conversation:send-message',
  appCodexConversationGet: 'forger:app:codex-conversation:get',
  appCodexConversationList: 'forger:app:codex-conversation:list',
  appCodexConversationDelete: 'forger:app:codex-conversation:delete',
  appCodexConversationCancelRun: 'forger:app:codex-conversation:cancel-run',
  appCodexConversationApprovePermission: 'forger:app:codex-conversation:approve-permission',
  appCodexConversationEvent: 'forger:app:codex-conversation:event',
  appToolsListAvailable: 'forger:app:tools:list-available',
  appToolsGetStatus: 'forger:app:tools:get-status',
  appToolsCall: 'forger:app:tools:call',
  appMessagesSend: 'forger:app:messages:send',
  appMessagesList: 'forger:app:messages:list',
  appMessagesEvent: 'forger:app:messages:event',
} as const;

const currentLocationContext = () => {
  try {
    return {
      origin: window.location.origin,
      pathname: window.location.pathname,
    };
  } catch {
    return {};
  }
};

const reportRendererError = (input: {
  operation: string;
  message: string;
  technicalCode: string;
  details?: Record<string, unknown>;
  sensitiveDetails?: Record<string, unknown>;
}) => {
  void ipcRenderer.invoke(IPC_CHANNELS.appRendererError, {
    ...input,
    details: {
      ...currentLocationContext(),
      ...(input.details ?? {}),
    },
  }).catch(() => undefined);
};

window.addEventListener('error', (event) => {
  reportRendererError({
    operation: 'app.window.error',
    message: event.message || 'Unexpected app renderer error.',
    technicalCode: 'app_renderer_window_error',
    details: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    },
    sensitiveDetails: {
      stack: event.error instanceof Error ? event.error.stack : undefined,
    },
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportRendererError({
    operation: 'app.window.unhandledrejection',
    message: reason instanceof Error ? reason.message : String(reason ?? 'Unhandled app renderer rejection.'),
    technicalCode: 'app_renderer_unhandled_rejection',
    sensitiveDetails: {
      stack: reason instanceof Error ? reason.stack : undefined,
      reason: reason instanceof Error ? undefined : String(reason ?? ''),
    },
  });
});

const REMOVED_FORGER_APP_BRIDGE_MESSAGE =
  'The in-app forgerApp bridge has been removed. Use the signed Desktop HTTP runtime bridge from your backend instead.';

const rejectRemovedBridge = async (): Promise<never> => {
  throw new Error(REMOVED_FORGER_APP_BRIDGE_MESSAGE);
};

const noopSubscription = () => () => undefined;

const removedApi: ForgerAppApi = {
  getContext: rejectRemovedBridge,
  getAiSubscriptionStatus: rejectRemovedBridge,
  selectExternalFolder: rejectRemovedBridge,
  tools: {
    listAvailable: rejectRemovedBridge,
    getStatus: rejectRemovedBridge,
    call: rejectRemovedBridge,
  },
  messages: {
    sendMessage: rejectRemovedBridge,
    listMessages: rejectRemovedBridge,
    onMessage: noopSubscription,
  },
  agentRuns: {
    createAgentThread: rejectRemovedBridge,
    startAgentThreadRun: rejectRemovedBridge,
    getAgentThread: rejectRemovedBridge,
    getAgentRun: rejectRemovedBridge,
    cancelAgentThreadRun: rejectRemovedBridge,
    steerAgentThreadRun: rejectRemovedBridge,
    onAgentThreadEvent: noopSubscription,
  },
  agents: {
    start: rejectRemovedBridge,
    resume: rejectRemovedBridge,
    steer: rejectRemovedBridge,
    stop: rejectRemovedBridge,
    getThread: rejectRemovedBridge,
    getRun: rejectRemovedBridge,
    onEvent: noopSubscription,
  },
  startAgentTask: rejectRemovedBridge,
  getAgentTask: rejectRemovedBridge,
  cancelAgentTask: rejectRemovedBridge,
  approveAgentTaskPermission: rejectRemovedBridge,
  onAgentTaskUpdated: noopSubscription,
  startCodexTask: rejectRemovedBridge,
  getCodexTask: rejectRemovedBridge,
  cancelCodexTask: rejectRemovedBridge,
  approveCodexTaskPermission: rejectRemovedBridge,
  onCodexTaskUpdated: noopSubscription,
  createAgentConversation: rejectRemovedBridge,
  sendAgentConversationMessage: rejectRemovedBridge,
  getAgentConversation: rejectRemovedBridge,
  listAgentConversations: rejectRemovedBridge,
  deleteAgentConversation: rejectRemovedBridge,
  cancelAgentConversationRun: rejectRemovedBridge,
  approveAgentConversationPermission: rejectRemovedBridge,
  onAgentConversationEvent: noopSubscription,
  createCodexConversation: rejectRemovedBridge,
  sendCodexConversationMessage: rejectRemovedBridge,
  getCodexConversation: rejectRemovedBridge,
  listCodexConversations: rejectRemovedBridge,
  deleteCodexConversation: rejectRemovedBridge,
  cancelCodexConversationRun: rejectRemovedBridge,
  approveCodexConversationPermission: rejectRemovedBridge,
  onCodexConversationEvent: noopSubscription,
};

contextBridge.exposeInMainWorld('forgerApp', removedApi);

type PermissionRequestPayload = {
  requestId: string;
  permission: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  resource: string;
};

type PermissionOverlayInput =
  | {
      source: 'task';
      runId: string;
      request: PermissionRequestPayload;
    }
  | {
      source: 'conversation';
      conversationId: string;
      runId: string;
      request: PermissionRequestPayload;
    };

let activePermissionKey: string | null = null;

type OverlayLocale = 'es' | 'en';

const overlayCopy = {
  es: {
    title: 'Forger necesita autorización',
    body: (resource: string) => `El agente quiere usar "${resource}" para continuar.`,
    deny: 'Rechazar',
    allow: 'Aprobar',
    risks: {
      low: 'Riesgo bajo',
      medium: 'Riesgo medio',
      high: 'Riesgo alto',
    },
  },
  en: {
    title: 'Forger needs authorization',
    body: (resource: string) => `The agent wants to use "${resource}" to continue.`,
    deny: 'Deny',
    allow: 'Approve',
    risks: {
      low: 'Low risk',
      medium: 'Medium risk',
      high: 'High risk',
    },
  },
} as const;

const overlayLocale = (): OverlayLocale => {
  const raw = new URLSearchParams(window.location.search).get('forgerLocale')?.toLowerCase() ?? '';
  return raw === 'en' || raw.startsWith('en-') ? 'en' : 'es';
};

const isPermissionRequest = (value: unknown): value is PermissionRequestPayload => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<PermissionRequestPayload>;
  return (
    typeof candidate.requestId === 'string' &&
    typeof candidate.permission === 'string' &&
    typeof candidate.reason === 'string' &&
    typeof candidate.resource === 'string' &&
    (candidate.risk === 'low' || candidate.risk === 'medium' || candidate.risk === 'high')
  );
};

const riskLabel = (risk: PermissionRequestPayload['risk']): string => {
  return overlayCopy[overlayLocale()].risks[risk];
};

const removePermissionOverlay = (key: string): void => {
  const existing = document.querySelector<HTMLElement>('[data-forger-permission-overlay="true"]');
  if (existing?.dataset.forgerPermissionKey === key) {
    existing.remove();
    activePermissionKey = null;
  }
};

const respondToPermission = async (
  input: PermissionOverlayInput,
  decision: 'allow' | 'deny',
): Promise<void> => {
  const key = `${input.source}:${input.runId}:${input.request.requestId}`;
  if (input.source === 'task') {
    await ipcRenderer.invoke(IPC_CHANNELS.appAgentTaskApprovePermission, input.runId, input.request.requestId, decision);
  } else {
    await ipcRenderer.invoke(
      IPC_CHANNELS.appAgentConversationApprovePermission,
      input.conversationId,
      input.runId,
      input.request.requestId,
      decision,
    );
  }
  removePermissionOverlay(key);
};

const renderPermissionOverlay = (input: PermissionOverlayInput): void => {
  const key = `${input.source}:${input.runId}:${input.request.requestId}`;
  if (activePermissionKey === key) {
    return;
  }
  document.querySelector('[data-forger-permission-overlay="true"]')?.remove();
  activePermissionKey = key;
  const copy = overlayCopy[overlayLocale()];

  const overlay = document.createElement('div');
  overlay.dataset.forgerPermissionOverlay = 'true';
  overlay.dataset.forgerPermissionKey = key;
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:grid',
    'place-items:center',
    'background:rgba(8,10,14,0.55)',
    'font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'width:min(440px,calc(100vw - 32px))',
    'border:1px solid rgba(255,255,255,0.12)',
    'border-radius:12px',
    'background:#12171f',
    'color:#f5f7fb',
    'box-shadow:0 24px 80px rgba(0,0,0,0.45)',
    'padding:22px',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = copy.title;
  title.style.cssText = 'font-size:20px;font-weight:700;letter-spacing:0;margin-bottom:8px';

  const body = document.createElement('div');
  body.textContent = copy.body(input.request.resource);
  body.style.cssText = 'font-size:14px;line-height:1.45;color:#c4cad4;margin-bottom:16px';

  const reason = document.createElement('div');
  reason.textContent = input.request.reason;
  reason.style.cssText = 'font-size:13px;line-height:1.45;color:#a9b1bd;margin-bottom:16px';

  const risk = document.createElement('div');
  risk.textContent = riskLabel(input.request.risk);
  risk.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'border-radius:999px',
    'padding:4px 10px',
    'font-size:12px',
    'font-weight:700',
    input.request.risk === 'high'
      ? 'background:rgba(239,83,80,0.18);color:#ff9d9a'
      : input.request.risk === 'medium'
        ? 'background:rgba(255,193,7,0.16);color:#ffd875'
        : 'background:rgba(102,187,106,0.16);color:#9be29e',
  ].join(';');

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:22px';

  const deny = document.createElement('button');
  deny.type = 'button';
  deny.textContent = copy.deny;
  deny.style.cssText = 'border:1px solid rgba(255,255,255,0.18);background:transparent;color:#f5f7fb;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer';

  const allow = document.createElement('button');
  allow.type = 'button';
  allow.textContent = copy.allow;
  allow.style.cssText = 'border:0;background:#f5f7fb;color:#12171f;border-radius:8px;padding:9px 14px;font-weight:800;cursor:pointer';

  deny.addEventListener('click', () => {
    void respondToPermission(input, 'deny').catch(() => removePermissionOverlay(key));
  });
  allow.addEventListener('click', () => {
    void respondToPermission(input, 'allow').catch(() => removePermissionOverlay(key));
  });

  actions.append(deny, allow);
  panel.append(title, body, reason, risk, actions);
  overlay.append(panel);
  document.documentElement.append(overlay);
};

ipcRenderer.on(IPC_CHANNELS.appAgentTaskUpdated, (_event: Electron.IpcRendererEvent, event: unknown) => {
  const task = event && typeof event === 'object' ? (event as { task?: unknown }).task : null;
  if (!task || typeof task !== 'object') {
    return;
  }
  const candidate = task as { runId?: unknown; status?: unknown; permissionRequest?: unknown };
  if (
    candidate.status === 'needs_permission' &&
    typeof candidate.runId === 'string' &&
    isPermissionRequest(candidate.permissionRequest)
  ) {
    renderPermissionOverlay({ source: 'task', runId: candidate.runId, request: candidate.permissionRequest });
  }
});

ipcRenderer.on(IPC_CHANNELS.appAgentConversationEvent, (_event: Electron.IpcRendererEvent, event: unknown) => {
  if (!event || typeof event !== 'object') {
    return;
  }
  const candidate = event as {
    type?: unknown;
    conversation?: { conversationId?: unknown };
    run?: { runId?: unknown; status?: unknown; permissionRequest?: unknown };
  };
  if (
    candidate.type === 'run.needs_permission' &&
    typeof candidate.conversation?.conversationId === 'string' &&
    typeof candidate.run?.runId === 'string' &&
    candidate.run.status === 'needs_permission' &&
    isPermissionRequest(candidate.run.permissionRequest)
  ) {
    renderPermissionOverlay({
      source: 'conversation',
      conversationId: candidate.conversation.conversationId,
      runId: candidate.run.runId,
      request: candidate.run.permissionRequest,
    });
  }
});
