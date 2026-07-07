export { figmaToolModule } from './figma';
export { zendeskToolModule } from './zendesk';
export { discordToolModule } from './discord';
export { calendlyToolModule } from './calendly';
export { gitlabToolModule } from './gitlab';
export { shopifyToolModule } from './shopify';
export { whatsappBusinessToolModule } from './whatsapp-business';
export { telegramToolModule } from './telegram';
export { sendgridToolModule } from './sendgrid';
export { postmarkToolModule } from './postmark';
export { twilioToolModule } from './twilio';
export { metaAdsToolModule } from './meta-ads';

import { figmaToolModule } from './figma';
import { zendeskToolModule } from './zendesk';
import { discordToolModule } from './discord';
import { calendlyToolModule } from './calendly';
import { gitlabToolModule } from './gitlab';
import { shopifyToolModule } from './shopify';
import { whatsappBusinessToolModule } from './whatsapp-business';
import { telegramToolModule } from './telegram';
import { sendgridToolModule } from './sendgrid';
import { postmarkToolModule } from './postmark';
import { twilioToolModule } from './twilio';
import { metaAdsToolModule } from './meta-ads';
import type { InternalToolModule } from '../../../tools/types';

export const tokenServiceConnectorModules: InternalToolModule[] = [
  figmaToolModule,
  zendeskToolModule,
  discordToolModule,
  calendlyToolModule,
  gitlabToolModule,
  shopifyToolModule,
  whatsappBusinessToolModule,
  telegramToolModule,
  sendgridToolModule,
  postmarkToolModule,
  twilioToolModule,
  metaAdsToolModule,
];
