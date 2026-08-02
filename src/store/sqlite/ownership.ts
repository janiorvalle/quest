import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

type JournalModeRow = {
  journal_mode: string;
};

type UserVersionRow = {
  user_version: number;
};

const OWNERSHIP_SCHEMA_VERSION = 1;

export interface SqliteStoreOwnership {
  release(): void;
}

export interface SqliteMigrationLease {
  release(): void;
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "SQLITE_BUSY";
}

function acquireOwnership(
  databasePath: string,
  mode: "shared" | "exclusive",
): SqliteStoreOwnership {
  const ownershipPath = `${databasePath}.ownership.sqlite`;
  mkdirSync(dirname(ownershipPath), { recursive: true });
  const database = new Database(ownershipPath, {
    create: true,
    readwrite: true,
    strict: true,
  });

  try {
    database.run("PRAGMA busy_timeout = 5000");
    const version = database.query<UserVersionRow, []>("PRAGMA user_version").get()?.user_version;
    if (version === 0) {
      database.run(`PRAGMA user_version = ${OWNERSHIP_SCHEMA_VERSION}`);
    } else if (version !== OWNERSHIP_SCHEMA_VERSION) {
      throw new Error(
        `unsupported SQLite ownership schema version ${String(version)}: ${ownershipPath}`,
      );
    }
    const journal = database.query<JournalModeRow, []>("PRAGMA journal_mode").get();
    if (journal?.journal_mode.toLowerCase() !== "delete") {
      throw new Error(`SQLite ownership database must use DELETE journaling: ${ownershipPath}`);
    }
    database.run("PRAGMA busy_timeout = 0");
    if (mode === "shared") {
      database.run("BEGIN DEFERRED");
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM sqlite_schema").get();
    } else {
      database.run("BEGIN EXCLUSIVE");
    }
  } catch (error: unknown) {
    database.close();
    if (isBusy(error)) {
      const action =
        mode === "shared"
          ? "open the Quest store while an offline restore is active"
          : "replace the Quest store while another Quest process is using it";
      throw new Error(`cannot ${action}`, { cause: error });
    }
    throw error;
  }

  let active = true;
  return {
    release() {
      if (!active) {
        return;
      }
      try {
        if (database.inTransaction) {
          database.run("ROLLBACK");
        }
      } finally {
        database.close();
        active = false;
      }
    },
  };
}

export function acquireSharedSqliteStoreOwnership(databasePath: string): SqliteStoreOwnership {
  return acquireOwnership(databasePath, "shared");
}

export function acquireExclusiveSqliteStoreOwnership(databasePath: string): SqliteStoreOwnership {
  return acquireOwnership(databasePath, "exclusive");
}

function acquireMigrationLease(databasePath: string): SqliteMigrationLease {
  const leasePath = `${databasePath}.migration.sqlite`;
  mkdirSync(dirname(leasePath), { recursive: true });
  const database = new Database(leasePath, {
    create: true,
    readwrite: true,
    strict: true,
  });

  try {
    database.run("PRAGMA busy_timeout = 0");
    database.run("BEGIN EXCLUSIVE");
  } catch (error: unknown) {
    database.close();
    throw error;
  }

  let active = true;
  return {
    release() {
      if (!active) {
        return;
      }
      try {
        if (database.inTransaction) {
          database.run("ROLLBACK");
        }
      } finally {
        database.close();
        active = false;
      }
    },
  };
}

export function tryAcquireSqliteMigrationLease(databasePath: string): SqliteMigrationLease | null {
  try {
    return acquireMigrationLease(databasePath);
  } catch (error: unknown) {
    if (isBusy(error)) {
      return null;
    }
    throw error;
  }
}
