import type { SidekickNetworkPayload, SidekickRuntimeState } from './sidekick-service-helpers';

interface SidekickDiagnosticDeps {
  emit: () => void;
  log: (event: string, payload: Record<string, unknown>) => Promise<void>;
  rejectSpeaker: (error: Error) => void;
}

const normalizeDeviceCode = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value)) return undefined;
  return value.toLowerCase();
};

export const handleWakeBeepResult = (
  runtime: SidekickRuntimeState,
  payload: SidekickNetworkPayload,
  deps: SidekickDiagnosticDeps,
): void => {
  const wakeId = typeof payload.wakeId === 'string' ? payload.wakeId.trim() : '';
  const durationMs = payload.durationMs;
  const status = payload.status;
  const code = normalizeDeviceCode(payload.code);
  if (
    !wakeId || wakeId.length > 128 ||
    (status !== 'completed' && status !== 'failed') ||
    typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs < 0 || durationMs > 5_000 ||
    (status === 'failed' && !code)
  ) {
    void deps.log('sidekick:wake_beep_result_invalid', { sidekickId: payload.sidekickId });
    return;
  }
  runtime.wakeBeep = {
    wakeId,
    status,
    durationMs,
    updatedAt: new Date().toISOString(),
    ...(status === 'failed' ? { technicalCode: `sidekick_wake_beep_${code}` } : {}),
  };
  void deps.log('sidekick:wake_beep_result', {
    sidekickId: payload.sidekickId,
    wakeId,
    status,
    durationMs,
    ...(code ? { technicalCode: code } : {}),
  });
  deps.emit();
};

export const handleNetworkRxOverflow = (
  runtime: SidekickRuntimeState,
  payload: SidekickNetworkPayload,
  deps: SidekickDiagnosticDeps,
): void => {
  const code = normalizeDeviceCode(payload.code) ?? 'rx_queue_full';
  void deps.log('sidekick:network_rx_overflow', {
    sidekickId: payload.sidekickId,
    technicalCode: code,
    droppedMessages: payload.droppedMessages,
    totalDroppedMessages: payload.totalDroppedMessages,
    queueDepth: payload.queueDepth,
    maxInFlightMessages: payload.maxInFlightMessages,
  });
  if (!runtime.speakerPlayback) return;
  runtime.speakerErrorMessage = 'La conexión del Sidekick no pudo recibir el audio a tiempo.';
  runtime.speakerErrorCode = 'sidekick_network_rx_overflow';
  deps.rejectSpeaker(new Error(runtime.speakerErrorCode));
  deps.emit();
};
