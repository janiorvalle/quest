import { constants, Database } from "bun:sqlite";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type UserVersionRow = {
  user_version: number;
};

type RecoveryState = {
  database: BigIntStats;
  journal: BigIntStats | null;
  shm: BigIntStats | null;
  wal: BigIntStats | null;
};

class RecoverySnapshotChangedError extends Error {
  constructor(path: string) {
    super(`SQLite recovery files changed while reading schema version for ${path}`);
    this.name = "RecoverySnapshotChangedError";
  }
}

export function readSqliteSchemaVersion(databasePath: string): number | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return readSqliteSchemaVersionOnce(databasePath);
    } catch (error: unknown) {
      if (!(error instanceof RecoverySnapshotChangedError) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new Error(`failed to read SQLite schema version for ${databasePath}`);
}

function readSqliteSchemaVersionOnce(databasePath: string): number | null {
  if (!existsSync(databasePath)) {
    return null;
  }

  const journalMode = readJournalMode(databasePath);
  const rollbackJournalPath = `${databasePath}-journal`;
  const walPath = `${databasePath}-wal`;
  const shmPath = `${databasePath}-shm`;
  if (journalMode === "rollback" && existsSync(rollbackJournalPath)) {
    return readRecoverySnapshot(databasePath, rollbackJournalPath, "-journal");
  }
  const walExists = existsSync(walPath);
  const shmExists = existsSync(shmPath);
  if (journalMode === "wal" && walExists && !shmExists) {
    return readRecoverySnapshot(databasePath, walPath, "-wal");
  }

  const database =
    journalMode === "rollback" || (journalMode === "wal" && walExists && shmExists)
      ? openLockedReadOnly(databasePath)
      : null;
  if (database === null) {
    return readStableImmutable(databasePath);
  }
  try {
    return readVersion(database, databasePath);
  } finally {
    database.close();
  }
}

function readJournalMode(databasePath: string): "rollback" | "unknown" | "wal" {
  const descriptor = openSync(databasePath, "r");
  try {
    const header = new Uint8Array(20);
    if (readSync(descriptor, header, 0, header.length, 0) < header.length) {
      return "unknown";
    }
    if (header[18] === 2 && header[19] === 2) {
      return "wal";
    }
    if (header[18] === 1 && header[19] === 1) {
      return "rollback";
    }
    return "unknown";
  } finally {
    closeSync(descriptor);
  }
}

function openLockedReadOnly(databasePath: string): Database {
  return new Database(databasePath, {
    readonly: true,
    strict: true,
  });
}

function openImmutable(databasePath: string): Database {
  const databaseUrl = pathToFileURL(databasePath);
  databaseUrl.searchParams.set("immutable", "1");
  return new Database(databaseUrl.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

function readStableImmutable(databasePath: string): number {
  const before = recoveryState(databasePath);
  let database: Database | null = null;
  let outcome: { error: unknown; kind: "failure" } | { kind: "success"; version: number };
  try {
    database = openImmutable(databasePath);
    outcome = { kind: "success", version: readVersion(database, databasePath) };
  } catch (error: unknown) {
    outcome = { error, kind: "failure" };
  } finally {
    database?.close();
  }
  if (!sameRecoveryState(before, recoveryState(databasePath))) {
    throw new RecoverySnapshotChangedError(databasePath);
  }
  if (outcome.kind === "failure") {
    throw outcome.error;
  }
  return outcome.version;
}

function readRecoverySnapshot(
  databasePath: string,
  recoveryPath: string,
  recoverySuffix: "-journal" | "-wal",
): number {
  const directory = mkdtempSync(join(tmpdir(), "quest-sqlite-version-"));
  const snapshotPath = join(directory, "snapshot.db");
  const snapshotRecoveryPath = `${snapshotPath}${recoverySuffix}`;
  try {
    const databaseBefore = fileFingerprint(databasePath);
    const recoveryBefore = fileFingerprint(recoveryPath);
    try {
      copyFileSync(databasePath, snapshotPath);
      copyFileSync(recoveryPath, snapshotRecoveryPath);
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        throw new RecoverySnapshotChangedError(databasePath);
      }
      throw error;
    }
    if (
      !sameFileFingerprint(databaseBefore, fileFingerprint(databasePath)) ||
      !sameFileFingerprint(recoveryBefore, fileFingerprint(recoveryPath)) ||
      statSync(snapshotPath, { bigint: true }).size !== databaseBefore.size ||
      statSync(snapshotRecoveryPath, { bigint: true }).size !== recoveryBefore.size
    ) {
      throw new RecoverySnapshotChangedError(databasePath);
    }
    chmodSync(snapshotPath, 0o600);
    chmodSync(snapshotRecoveryPath, 0o600);
    const database = new Database(snapshotPath, {
      create: false,
      readwrite: true,
      strict: true,
    });
    try {
      return readVersion(database, databasePath);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function fileFingerprint(path: string): BigIntStats {
  try {
    return statSync(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      throw new RecoverySnapshotChangedError(path);
    }
    throw error;
  }
}

function sameFileFingerprint(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function recoveryState(databasePath: string): RecoveryState {
  return {
    database: fileFingerprint(databasePath),
    journal: optionalFileFingerprint(`${databasePath}-journal`),
    shm: optionalFileFingerprint(`${databasePath}-shm`),
    wal: optionalFileFingerprint(`${databasePath}-wal`),
  };
}

function optionalFileFingerprint(path: string): BigIntStats | null {
  try {
    return statSync(path, { bigint: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

function sameOptionalFileFingerprint(left: BigIntStats | null, right: BigIntStats | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return sameFileFingerprint(left, right);
}

function sameRecoveryState(left: RecoveryState, right: RecoveryState): boolean {
  return (
    sameFileFingerprint(left.database, right.database) &&
    sameOptionalFileFingerprint(left.journal, right.journal) &&
    sameOptionalFileFingerprint(left.shm, right.shm) &&
    sameOptionalFileFingerprint(left.wal, right.wal)
  );
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readVersion(database: Database, databasePath: string): number {
  const statement = database.prepare<UserVersionRow, []>("PRAGMA user_version");
  try {
    const version = statement.get()?.user_version;
    if (version === undefined || !Number.isSafeInteger(version)) {
      throw new Error(`failed to read SQLite schema version for ${databasePath}`);
    }
    return version;
  } finally {
    statement.finalize();
  }
}
