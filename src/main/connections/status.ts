import type { ConnectionStatus, ConnectionStatusResult } from '../../shared/types/connections';

export const normalizeConnectionStatus = (
  value: Partial<ConnectionStatusResult> | null | undefined,
): ConnectionStatusResult => {
  const status: ConnectionStatus = value?.status ?? (value?.connected ? 'connected' : 'needs_setup');
  return {
    connected: value?.connected === true || status === 'connected',
    status,
    ...(value?.message ? { message: value.message } : {}),
    ...(value?.technicalCode ? { technicalCode: value.technicalCode } : {}),
    ...(value?.accountIdentity ? { accountIdentity: value.accountIdentity } : {}),
    ...(value?.lastCheckedAt ? { lastCheckedAt: value.lastCheckedAt } : {}),
    ...(value?.capabilities ? { capabilities: value.capabilities } : {}),
  };
};
