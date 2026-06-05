import { gmailToolModule } from './gmail';
import { whatsappToolModule } from './whatsapp';
import type { InternalToolModule } from './types';

export const INTERNAL_TOOL_MODULES: InternalToolModule[] = [
  gmailToolModule,
  whatsappToolModule,
];
