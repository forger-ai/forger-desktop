import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { loadOptionalBetterSqlite } from '../runtime/optional-better-sqlite';

export interface SqliteStatement {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => unknown;
}

export interface SqliteDatabase {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqliteStatement;
  pragma?: (sql: string) => unknown;
}

type EmitWarning = typeof process.emitWarning;

const NODE_SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';

const requireNodeSqlite = (): { DatabaseSync?: new (filename: string) => SqliteDatabase } => {
  const originalEmitWarning: EmitWarning = process.emitWarning;
  const emitWarning = originalEmitWarning as unknown as (warning: string | Error, ...args: unknown[]) => void;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningMessage = typeof warning === 'string' ? warning : warning.message;
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (warningMessage === NODE_SQLITE_EXPERIMENTAL_WARNING && warningType === 'ExperimentalWarning') {
      return;
    }
    return emitWarning(warning, ...args);
  }) as EmitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as { DatabaseSync?: new (filename: string) => SqliteDatabase };
  } finally {
    process.emitWarning = originalEmitWarning;
  }
};

export const openPersonalAgentSqliteDatabase = (filename: string): SqliteDatabase | null => {
  const BetterSqlite3 = loadOptionalBetterSqlite();
  if (BetterSqlite3) {
    try {
      return new BetterSqlite3(filename) as BetterSqliteDatabase as SqliteDatabase;
    } catch {
      // Host-node tests can run with Electron-rebuilt native modules; fall through to node:sqlite.
    }
  }
  try {
    const nodeSqlite = requireNodeSqlite();
    return nodeSqlite.DatabaseSync ? new nodeSqlite.DatabaseSync(filename) : null;
  } catch {
    return null;
  }
};
