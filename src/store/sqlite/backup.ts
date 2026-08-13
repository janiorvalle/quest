import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type {
  BackupDatabase,
  BackupDatabaseInspection,
  BackupDatabaseRestoreSession,
} from "../port";
import { readSqliteQuestDump, type SqliteStore } from "./adapter";
import { SQLITE_SCHEMA_VERSION } from "./ddl";
import { migrateSqliteStore } from "./migration";
import { acquireExclusiveSqliteStoreOwnership, type SqliteStoreOwnership } from "./ownership";
import { readSqliteSchemaVersion } from "./schema-version";

type IntegrityRow = {
  integrity_check: string;
};

type UserVersionRow = {
  user_version: number;
};

const LEGACY_SCHEMA_VERSION = 1;
const PRE_CANCEL_SCHEMA_VERSION = 2;
const PRE_LEASE_SCHEMA_VERSION = 3;
const PRE_FENCE_SCHEMA_VERSION = 4;
const PRE_GLOBAL_GUARD_SCHEMA_VERSION = 5;
const PRE_SIGNOFF_SCHEMA_VERSION = 6;
const PRE_UNIFIED_OPEN_SCHEMA_VERSION = 7;

interface PreparedRestoreSource {
  readonly cleanup: () => Promise<void>;
  readonly path: string;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function moveIfPresent(source: string, destination: string): Promise<boolean> {
  if (!(await fileExists(source))) {
    return false;
  }
  await rename(source, destination);
  return true;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "EINVAL" || error.code === "EPERM" || error.code === "EISDIR";
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function safeRestoreLabel(label: string): string {
  const safe = label.replaceAll(/[^0-9A-Za-z._-]/gu, "_");
  return safe === "" ? "restore" : safe;
}

async function availablePreRestorePath(databasePath: string, label: string): Promise<string> {
  const base = `${databasePath}.${safeRestoreLabel(label)}`;
  let candidate = `${base}.pre-restore`;
  let sequence = 2;
  while (
    (await fileExists(candidate)) ||
    (await fileExists(`${candidate}-wal`)) ||
    (await fileExists(`${candidate}-shm`))
  ) {
    candidate = `${base}.${sequence}.pre-restore`;
    sequence += 1;
  }
  return candidate;
}

function inspectDatabase(databasePath: string): BackupDatabaseInspection {
  const database = new Database(databasePath, {
    readonly: true,
    strict: true,
  });
  try {
    database.run("BEGIN DEFERRED");
    try {
      const versionRow = database.query<UserVersionRow, []>("PRAGMA user_version").get();
      if (versionRow === null) {
        throw new Error(`failed to read SQLite schema version from ${databasePath}`);
      }
      const integrityRows = database.query<IntegrityRow, []>("PRAGMA integrity_check").all();
      const dump = readSqliteQuestDump(database);
      database.run("COMMIT");
      return {
        dump,
        integrity_check: integrityRows.map((row) => row.integrity_check),
        schema_version: versionRow.user_version,
      };
    } catch (error: unknown) {
      if (database.inTransaction) {
        database.run("ROLLBACK");
      }
      throw error;
    }
  } finally {
    database.close();
  }
}

async function prepareRestoreSource(source: string): Promise<PreparedRestoreSource> {
  const sourceVersion = readSqliteSchemaVersion(source);
  if (sourceVersion === SQLITE_SCHEMA_VERSION) {
    return { cleanup: () => Promise.resolve(), path: source };
  }
  if (
    sourceVersion !== LEGACY_SCHEMA_VERSION &&
    sourceVersion !== PRE_CANCEL_SCHEMA_VERSION &&
    sourceVersion !== PRE_LEASE_SCHEMA_VERSION &&
    sourceVersion !== PRE_FENCE_SCHEMA_VERSION &&
    sourceVersion !== PRE_GLOBAL_GUARD_SCHEMA_VERSION &&
    sourceVersion !== PRE_SIGNOFF_SCHEMA_VERSION &&
    sourceVersion !== PRE_UNIFIED_OPEN_SCHEMA_VERSION
  ) {
    throw new Error(
      `unsupported restore schema version ${String(sourceVersion)}; expected ${SQLITE_SCHEMA_VERSION}`,
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), `quest-restore-${randomUUID()}-`));
  const temporaryDatabase = join(temporaryRoot, "quest.db");
  try {
    await copyFile(source, temporaryDatabase);
    await migrateSqliteStore({
      backupRoot: join(temporaryRoot, "backups"),
      databasePath: temporaryDatabase,
    });
  } catch (error: unknown) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw error;
  }

  let active = true;
  return {
    cleanup: async () => {
      if (!active) {
        return;
      }
      active = false;
      await rm(temporaryRoot, { force: true, recursive: true });
    },
    path: temporaryDatabase,
  };
}

export class SqliteBackupDatabase implements BackupDatabase {
  readonly restoreScope = "full";
  readonly #databasePath: string;
  readonly #store: SqliteStore | undefined;

  constructor(databasePath: string, store?: SqliteStore) {
    if (!isAbsolute(databasePath)) {
      throw new Error(`database path must be absolute: ${databasePath}`);
    }
    if (store !== undefined && store.databasePath !== databasePath) {
      throw new Error("backup database must own the active SQLite store path");
    }
    this.#databasePath = databasePath;
    this.#store = store;
  }

  createSnapshot(destination: string): Promise<BackupDatabaseInspection> {
    if (!isAbsolute(destination)) {
      return Promise.reject(new Error(`snapshot path must be absolute: ${destination}`));
    }
    if (this.#store === undefined) {
      return Promise.reject(new Error("cannot create a snapshot without an active SQLite store"));
    }
    this.#store.createBackupSnapshot(destination);
    return Promise.resolve(inspectDatabase(destination));
  }

  inspect(databasePath: string): Promise<BackupDatabaseInspection> {
    if (!isAbsolute(databasePath)) {
      return Promise.reject(new Error(`snapshot path must be absolute: ${databasePath}`));
    }
    return Promise.resolve(inspectDatabase(databasePath));
  }

  inspectCurrent(): Promise<BackupDatabaseInspection> {
    return Promise.resolve(
      this.#store === undefined
        ? inspectDatabase(this.#databasePath)
        : this.#store.inspectBackupState(),
    );
  }

  async restoreSnapshot(
    source: string,
    preRestoreLabel: string,
    repository?: string,
  ): Promise<BackupDatabaseRestoreSession> {
    if (!isAbsolute(source)) {
      throw new Error(`snapshot path must be absolute: ${source}`);
    }
    const prepared = await prepareRestoreSource(source);
    if (this.#store === undefined) {
      try {
        return await this.#restoreOffline(prepared.path, preRestoreLabel);
      } finally {
        await prepared.cleanup();
      }
    }
    const preRestorePath = await availablePreRestorePath(this.#databasePath, preRestoreLabel);
    try {
      this.#store.beginBackupRestore(prepared.path, preRestorePath);
    } catch (error: unknown) {
      await removeIfPresent(preRestorePath);
      await prepared.cleanup();
      throw error;
    }

    let active = true;
    let activated = false;
    const activate = async (): Promise<void> => {
      if (!active || activated) {
        return;
      }
      try {
        this.#store?.activateBackupRestore();
        activated = true;
      } catch (error: unknown) {
        await removeIfPresent(preRestorePath);
        active = false;
        throw error;
      }
    };
    return {
      pre_restore_database: preRestorePath,
      activate,
      commit: async () => {
        if (!active) {
          return;
        }
        try {
          await activate();
          this.#store?.commitBackupRestore();
        } finally {
          active = false;
          await prepared.cleanup();
        }
      },
      rollback: async () => {
        if (!active) {
          return;
        }
        try {
          this.#store?.rollbackBackupRestore();
        } finally {
          await removeIfPresent(preRestorePath);
          active = false;
          await prepared.cleanup();
        }
      },
    };
  }

  async #restoreOffline(
    source: string,
    preRestoreLabel: string,
  ): Promise<BackupDatabaseRestoreSession> {
    const sourceInspection = inspectDatabase(source);
    if (sourceInspection.schema_version !== SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `unsupported restore schema version ${sourceInspection.schema_version}; expected ${SQLITE_SCHEMA_VERSION}`,
      );
    }
    const ownership = acquireExclusiveSqliteStoreOwnership(this.#databasePath);
    try {
      return await this.#restoreOfflineWithOwnership(source, preRestoreLabel, ownership);
    } catch (error: unknown) {
      ownership.release();
      throw error;
    }
  }

  async #restoreOfflineWithOwnership(
    source: string,
    preRestoreLabel: string,
    ownership: SqliteStoreOwnership,
  ): Promise<BackupDatabaseRestoreSession> {
    const temporary = `${this.#databasePath}.${randomUUID()}.restore.tmp`;
    try {
      await mkdir(dirname(this.#databasePath), { recursive: true, mode: 0o700 });
      await copyFile(source, temporary);
      await syncFile(temporary);
    } catch (error: unknown) {
      await removeIfPresent(temporary);
      throw error;
    }

    const livePaths = [
      this.#databasePath,
      `${this.#databasePath}-wal`,
      `${this.#databasePath}-shm`,
    ];
    const hasLiveFiles = (await Promise.all(livePaths.map(fileExists))).some(Boolean);
    const preRestorePath = hasLiveFiles
      ? await availablePreRestorePath(this.#databasePath, preRestoreLabel)
      : null;
    const moves = [
      {
        destination: preRestorePath,
        moved: false,
        source: this.#databasePath,
      },
      {
        destination: preRestorePath === null ? null : `${preRestorePath}-wal`,
        moved: false,
        source: `${this.#databasePath}-wal`,
      },
      {
        destination: preRestorePath === null ? null : `${preRestorePath}-shm`,
        moved: false,
        source: `${this.#databasePath}-shm`,
      },
    ];
    let replacementInstalled = false;
    let active = true;

    const rollback = async (): Promise<void> => {
      if (replacementInstalled) {
        await removeIfPresent(`${this.#databasePath}-shm`);
        await removeIfPresent(`${this.#databasePath}-wal`);
        await removeIfPresent(this.#databasePath);
        replacementInstalled = false;
      }
      for (const move of [...moves].reverse()) {
        if (move.moved && move.destination !== null) {
          await rename(move.destination, move.source);
          move.moved = false;
        }
      }
      await removeIfPresent(temporary);
      await syncDirectory(dirname(this.#databasePath));
    };

    const activate = async (): Promise<void> => {
      if (replacementInstalled) {
        return;
      }
      try {
        for (const move of moves) {
          if (move.destination !== null) {
            move.moved = await moveIfPresent(move.source, move.destination);
          }
        }
        await rename(temporary, this.#databasePath);
        replacementInstalled = true;
        await syncDirectory(dirname(this.#databasePath));
      } catch (error: unknown) {
        try {
          await rollback();
        } finally {
          ownership.release();
          active = false;
        }
        throw error;
      }
    };

    return {
      pre_restore_database: preRestorePath,
      activate,
      commit: async () => {
        if (!active) {
          return;
        }
        await activate();
        ownership.release();
        active = false;
      },
      rollback: async () => {
        if (!active) {
          return;
        }
        try {
          await rollback();
        } finally {
          ownership.release();
          active = false;
        }
      },
    };
  }
}
