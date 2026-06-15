import type { AppSummary } from '@shared/types';

type ErrorActionApp = Pick<AppSummary, 'lastErrorOperation' | 'privateLocal' | 'status'>;

export const isOpenableError = (app: ErrorActionApp): boolean =>
  app.status === 'error' && (!app.lastErrorOperation || app.lastErrorOperation === 'open' || app.lastErrorOperation === 'runtime');

export const isUpdateError = (app: ErrorActionApp): boolean =>
  app.status === 'error' && app.lastErrorOperation === 'update';

export const isRetryableInstallError = (app: ErrorActionApp): boolean =>
  app.status === 'error' && app.lastErrorOperation === 'install';
