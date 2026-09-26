import type { IpcMain } from 'electron';
import type { IPC_CHANNELS as IpcChannels } from '../../shared/ipc';
import type { WhatsAppAgentBindingKey, WhatsAppAgentBindingPutInput } from '../../shared/types';
import type { WhatsAppAgentChannelService } from '../personal-agents/whatsapp-channel-service';
import { validateWhatsAppChannelPolicy } from './whatsapp-channel-policy-input';

interface WhatsAppAgentChannelIpcHandlersDeps {
  IPC_CHANNELS: typeof IpcChannels;
  ipcMain: IpcMain;
  getWhatsAppAgentChannelService: () => WhatsAppAgentChannelService;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredText = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') throw new Error('whatsapp_agent_invalid_input');
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error('whatsapp_agent_invalid_input');
  return normalized;
};

const optionalText = (value: unknown, maxLength: number): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('whatsapp_agent_invalid_input');
  return value.trim();
};

const optionalRevision = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('whatsapp_agent_invalid_input');
  return value;
};

const validateBindingKey = (input: unknown): WhatsAppAgentBindingKey => {
  if (!isRecord(input)) throw new Error('whatsapp_agent_invalid_input');
  return {
    connectionId: requiredText(input.connectionId, 128),
    chatId: requiredText(input.chatId, 256),
    agentId: requiredText(input.agentId, 128),
  };
};

const validateBindingInput = (input: unknown): WhatsAppAgentBindingPutInput => {
  const key = validateBindingKey(input);
  if (!isRecord(input) || typeof input.enabled !== 'boolean' || typeof input.allowAgentCapabilities !== 'boolean' || !Array.isArray(input.participantsAllowed)) {
    throw new Error('whatsapp_agent_invalid_input');
  }
  if (input.participantsAllowed.length > 64) throw new Error('whatsapp_agent_invalid_input');
  const participantsAllowed = [...new Set(input.participantsAllowed.map((id) => requiredText(id, 256)))];
  const alias = requiredText(input.alias, 60);
  if (/\r|\n/.test(alias)) throw new Error('whatsapp_agent_invalid_input');
  const purpose = optionalText(input.purpose, 4000);
  const scope = optionalText(input.scope, 4000);
  if (input.enabled && !purpose) throw new Error('whatsapp_agent_purpose_required');
  const expectedRevision = input.expectedRevision;
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error('whatsapp_agent_invalid_input');
  }
  return {
    ...key, alias, enabled: input.enabled, purpose, scope, participantsAllowed,
    allowAgentCapabilities: input.allowAgentCapabilities,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(input.expectedConfigurationVersion === undefined ? {} : { expectedConfigurationVersion: optionalRevision(input.expectedConfigurationVersion) }),
    ...(input.policy === undefined ? {} : { policy: validateWhatsAppChannelPolicy(input.policy) }),
  };
};

export const registerWhatsAppAgentChannelIpcHandlers = ({
  IPC_CHANNELS,
  ipcMain,
  getWhatsAppAgentChannelService,
}: WhatsAppAgentChannelIpcHandlersDeps): void => {
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppBindingsList, (_event, input: unknown) => {
    if (!isRecord(input)) throw new Error('whatsapp_agent_invalid_input');
    return getWhatsAppAgentChannelService().listBindings(requiredText(input.agentId, 128));
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppBindingGet, (_event, input: unknown) =>
    getWhatsAppAgentChannelService().getBinding(validateBindingKey(input)));
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppBindingPut, async (_event, input: unknown) =>
    await getWhatsAppAgentChannelService().putBinding(validateBindingInput(input)));
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppBindingDelete, async (_event, input: unknown) =>
    await getWhatsAppAgentChannelService().deleteBinding(validateBindingKey(input)));
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppUnsettledList, (_event, input: unknown) => {
    if (!isRecord(input)) throw new Error('whatsapp_agent_invalid_input');
    const agentId = requiredText(input.agentId, 128);
    const connectionId = input.connectionId !== undefined
      ? requiredText(input.connectionId, 128)
      : undefined;
    return getWhatsAppAgentChannelService().listUnsettledMessages(connectionId)
      .filter((item) => item.agentId === agentId);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppLatestDeliveryGet, (_event, input: unknown) =>
    getWhatsAppAgentChannelService().getLatestDelivery(validateBindingKey(input)));
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppActivityList, (_event, input: unknown) =>
    getWhatsAppAgentChannelService().listActivity(validateBindingKey(input)));
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppBindingSetEnabled, async (_event, input: unknown) => {
    const key = validateBindingKey(input);
    if (!isRecord(input) || typeof input.enabled !== 'boolean') throw new Error('whatsapp_agent_invalid_input');
    return await getWhatsAppAgentChannelService().setEnabled(key, input.enabled, optionalRevision(input.expectedConfigurationVersion));
  });
  const actions = [
    [IPC_CHANNELS.personalAgentWhatsAppRequestCancel, 'cancelRequest'],
    [IPC_CHANNELS.personalAgentWhatsAppDeliveryRetry, 'retryDelivery'],
    [IPC_CHANNELS.personalAgentWhatsAppRequestDismiss, 'dismissRequest'],
  ] as const;
  for (const [channel, method] of actions) {
    ipcMain.handle(channel, async (_event, input: unknown) => {
      const key = validateBindingKey(input);
      return await getWhatsAppAgentChannelService()[method](key, requiredText((input as Record<string, unknown>).requestId, 128));
    });
  }
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppAliasUpdate, async (_event, input: unknown) => {
    if (!isRecord(input)) throw new Error('whatsapp_agent_invalid_input');
    const alias = requiredText(input.alias, 60);
    if (/[\r\n]/.test(alias)) throw new Error('whatsapp_agent_invalid_input');
    return await getWhatsAppAgentChannelService().updateAlias(requiredText(input.connectionId, 128), requiredText(input.agentId, 128), alias);
  });
  ipcMain.handle(IPC_CHANNELS.personalAgentWhatsAppPolicyOptionsGet, async (_event, input: unknown) => {
    if (!isRecord(input)) throw new Error('whatsapp_agent_invalid_input');
    return await getWhatsAppAgentChannelService().getPolicyOptions(requiredText(input.agentId, 128));
  });
};
