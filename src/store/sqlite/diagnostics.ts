import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import type { QuestDump } from "../../schema";
import { readSqliteQuestDump } from "./adapter";

export type SqliteStoreInspection =
  | {
      readonly state: "missing";
    }
  | {
      readonly dump?: QuestDump | undefined;
      readonly integrity_check: readonly string[];
      readonly state: "present";
    };

type IntegrityRow = {
  integrity_check: string;
};

export function inspectSqliteStore(databasePath: string): SqliteStoreInspection {
  if (!existsSync(databasePath)) {
    return { state: "missing" };
  }

  const database = new Database(databasePath, {
    readonly: true,
    strict: true,
  });
  let inTransaction = false;
  try {
    database.run("BEGIN DEFERRED");
    inTransaction = true;
    const integrityCheck = database
      .query<IntegrityRow, []>("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check);
    const dump =
      integrityCheck.length === 1 && integrityCheck[0]?.toLowerCase() === "ok"
        ? readSqliteQuestDump(database)
        : undefined;
    database.run("COMMIT");
    inTransaction = false;
    return {
      ...(dump === undefined ? {} : { dump }),
      integrity_check: integrityCheck,
      state: "present",
    };
  } catch (error: unknown) {
    if (inTransaction && database.inTransaction) {
      database.run("ROLLBACK");
    }
    throw error;
  } finally {
    database.close();
  }
}
