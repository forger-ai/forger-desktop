import { gmailToolModule } from './gmail';
import { chromeExtensionToolModule } from './chrome-extension';
import { whatsappToolModule } from './whatsapp';
import { slackToolModule } from './slack';
import { trelloToolModule } from './trello';
import type { InternalToolModule } from './types';

export const INTERNAL_TOOL_MODULES: InternalToolModule[] = [
  gmailToolModule,
  chromeExtensionToolModule,
  whatsappToolModule,
  slackToolModule,
  trelloToolModule,
];
