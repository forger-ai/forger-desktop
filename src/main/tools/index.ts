import { gmailToolModule } from './gmail';
import { metaToolModule } from './meta';
import type { InternalToolModule } from './types';

export const INTERNAL_TOOL_MODULES: InternalToolModule[] = [
  gmailToolModule,
  metaToolModule,
];
