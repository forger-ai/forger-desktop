export const loadOptionalBetterSqlite = (): typeof import('better-sqlite3') | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3') as typeof import('better-sqlite3');
  } catch {
    return null;
  }
};
