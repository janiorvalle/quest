import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLITE_SCHEMA_VERSION } from "./ddl";
import { readSqliteSchemaVersion } from "./schema-version";

describe("readSqliteSchemaVersion", () => {
  test("returns null for a missing database without creating its parent", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "missing", "quest.db");
      const before = await readdir(directory);

      expect(readSqliteSchemaVersion(databasePath)).toBeNull();
      expect(await readdir(directory)).toEqual(before);
    });
  });

  test("reads a new empty database as unversioned without changing it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "new.db");
      await Bun.write(databasePath, new Uint8Array());
      const before = await databaseSnapshot(directory, databasePath);

      expect(readSqliteSchemaVersion(databasePath)).toBe(0);
      expect(await databaseSnapshot(directory, databasePath)).toEqual(before);
    });
  });

  test("reads an unversioned database with tables without stamping it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "unversioned.db");
      const database = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      database.run("CREATE TABLE legacy (id INTEGER PRIMARY KEY)");
      database.close();
      const before = await databaseSnapshot(directory, databasePath);

      expect(readSqliteSchemaVersion(databasePath)).toBe(0);
      expect(await databaseSnapshot(directory, databasePath)).toEqual(before);
    });
  });

  test.each([
    ["current", SQLITE_SCHEMA_VERSION],
    ["newer", SQLITE_SCHEMA_VERSION + 1],
  ] satisfies ReadonlyArray<readonly [string, number]>)(
    "reads a %s schema version without creating WAL sidecars",
    async (_label, version) => {
      await withTemporaryDirectory(async (directory) => {
        const databasePath = join(directory, `version-${version}.db`);
        const database = new Database(databasePath, {
          create: true,
          readwrite: true,
          strict: true,
        });
        database.run("PRAGMA journal_mode = WAL");
        database.run("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
        database.run(`PRAGMA user_version = ${version}`);
        database.close();
        const before = await databaseSnapshot(directory, databasePath);

        expect(readSqliteSchemaVersion(databasePath)).toBe(version);
        expect(await databaseSnapshot(directory, databasePath)).toEqual(before);
      });
    },
  );

  test("reads the committed version while a WAL writer remains open", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "live-wal.db");
      const writer = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      try {
        writer.run("PRAGMA journal_mode = WAL");
        writer.run("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
        writer.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);

        expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
      } finally {
        writer.close();
      }
    });
  });

  test("uses SQLite locking when a rollback-journal writer has an uncommitted version", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "live-rollback.db");
      const writer = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      try {
        writer.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
        writer.run("BEGIN IMMEDIATE");
        writer.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
        expect(await Bun.file(`${databasePath}-journal`).exists()).toBeTrue();
        const before = await databaseSnapshot(directory, databasePath);
        const journalBefore = await Bun.file(`${databasePath}-journal`).bytes();

        expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
        expect(await databaseSnapshot(directory, databasePath)).toEqual(before);
        expect(await Bun.file(`${databasePath}-journal`).bytes()).toEqual(journalBefore);
      } finally {
        if (writer.inTransaction) {
          writer.run("ROLLBACK");
        }
        writer.close();
      }
    });
  });

  test("reads a committed WAL-only snapshot without creating its missing SHM file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const sourcePath = join(directory, "source.db");
      const databasePath = join(directory, "wal-only.db");
      const writer = new Database(sourcePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      try {
        writer.run("PRAGMA journal_mode = WAL");
        writer.run("CREATE TABLE marker (id INTEGER PRIMARY KEY)");
        writer.run("PRAGMA wal_checkpoint(TRUNCATE)");
        writer.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
        await copyFile(sourcePath, databasePath);
        await copyFile(`${sourcePath}-wal`, `${databasePath}-wal`);
        await chmod(databasePath, 0o444);
        await chmod(`${databasePath}-wal`, 0o444);
        const before = await databaseSnapshot(directory, databasePath);
        const walBefore = await Bun.file(`${databasePath}-wal`).bytes();

        expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
        expect(await databaseSnapshot(directory, databasePath)).toEqual(before);
        expect(await Bun.file(`${databasePath}-wal`).bytes()).toEqual(walBefore);
        expect(await Bun.file(`${databasePath}-shm`).exists()).toBeFalse();
      } finally {
        writer.close();
      }
    });
  });

  test("ignores a stale SHM-only sidecar without creating a WAL file", async () => {
    await withTemporaryDirectory(async (directory) => {
      const databasePath = join(directory, "shm-only.db");
      const database = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      database.run("PRAGMA journal_mode = WAL");
      database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      database.close();
      await rm(`${databasePath}-wal`, { force: true });
      await Bun.write(`${databasePath}-shm`, new Uint8Array());
      const before = await databaseSnapshot(directory, databasePath);

      expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
      expect(await databaseSnapshot(directory, databasePath)).toEqual(before);
      expect(await Bun.file(`${databasePath}-wal`).exists()).toBeFalse();
    });
  });
});

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "quest-version-probe-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function databaseSnapshot(
  directory: string,
  databasePath: string,
): Promise<{
  files: string[];
  bytes: Uint8Array;
}> {
  return {
    files: (await readdir(directory)).sort(),
    bytes: await Bun.file(databasePath).bytes(),
  };
}
