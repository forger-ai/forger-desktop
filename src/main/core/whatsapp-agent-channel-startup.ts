import { setLiveWhatsAppMessageHandler } from '../connections/modules/whatsapp';
import type { WhatsAppAgentChannelService } from '../personal-agents/whatsapp-channel-service';
import type { MainLifecycleState } from './main-lifecycle-types';
import type { StartupLogger } from './startup-loading';

export const startWhatsAppAgentChannel = async (
  channel: WhatsAppAgentChannelService | undefined,
  connections: { startType?: (type: string) => Promise<void> } | null,
): Promise<WhatsAppAgentChannelService | null> => {
  if (!channel) return null;
  await channel.initialize();
  setLiveWhatsAppMessageHandler(async ({ connectionId, message }) => {
    await channel.handleLiveMessage({ connectionId, message });
  });
  try {
    await connections?.startType?.('whatsapp');
    return channel;
  } catch (error) {
    setLiveWhatsAppMessageHandler(null);
    channel.close();
    throw error;
  }
};

export const initializeWhatsAppAgentChannel = async (
  state: Pick<MainLifecycleState, 'connectionsService' | 'whatsappAgentChannelService'>,
  getChannel: (() => WhatsAppAgentChannelService) | undefined,
  logger: StartupLogger,
  onFailure: (error: unknown) => void,
): Promise<void> => {
  await logger.step('startup:whatsapp_agent_channel:initialize', async () => {
    state.whatsappAgentChannelService = await startWhatsAppAgentChannel(
      getChannel?.(), state.connectionsService,
    );
  }).catch(onFailure);
};

export const createWhatsAppChannelHistoryReader = (
  getChannel: (() => WhatsAppAgentChannelService) | undefined,
): ((input: Parameters<WhatsAppAgentChannelService['readChannelHistory']>[0]) => ReturnType<WhatsAppAgentChannelService['readChannelHistory']>) | undefined =>
  getChannel ? (input) => getChannel().readChannelHistory(input) : undefined;

export const createWhatsAppChannelAgentReader = (
  getChannel: (() => WhatsAppAgentChannelService) | undefined,
): import('../forger-mcp/whatsapp-channel-access').WhatsAppChannelAgentReader | undefined =>
  getChannel ? (input) => getChannel().getCurrentPolicyAgent(input) : undefined;

export const createWhatsAppChannelImageReader = (
  getChannel: (() => WhatsAppAgentChannelService) | undefined,
): import('../forger-mcp/whatsapp-channel-images').WhatsAppChannelImageReader | undefined =>
  getChannel ? (input) => getChannel().readCurrentImages(input) : undefined;
