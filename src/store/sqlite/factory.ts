import type { Clock } from "../port";
import { SqliteStore, type SqliteStoreOptions } from "./adapter";

export function createSqliteStore(
  databasePath: string,
  options: SqliteStoreOptions = {},
): SqliteStore {
  return new SqliteStore(databasePath, options);
}

export function createSystemClock(): Clock {
  return {
    now: async () => new Date().toISOString(),
  };
}
