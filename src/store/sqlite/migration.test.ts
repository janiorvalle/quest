import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEvidenceFileReader } from "../../evidence";
import type { NewQuest } from "../../schema";
import { addLifecycleQuest } from "../../services";
import { createStoreCompatibilityProbe } from "../compatibility";
import { LocalBlobStore } from "../local-blob-store";
import { SqliteStore } from "./adapter";
import { SqliteBackupDatabase } from "./backup";
import {
  SQLITE_CORE_SCHEMA_DEFINITIONS,
  SQLITE_MIGRATION_SCHEMA_DEFINITIONS,
  SQLITE_PRE_GLOBAL_GUARD_MIGRATION_SCHEMA_DEFINITIONS,
  SQLITE_SCHEMA_VERSION,
} from "./ddl";
import { migrateSqliteStore } from "./migration";
import { readSqliteSchemaVersion } from "./schema-version";

const LEGACY_QUESTS_TABLE_SQL = `CREATE TABLE quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    area TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'task')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    assignee TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'ready', 'accepted', 'turned_in', 'complete', 'dropped')),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('actionable', 'not-reproduced', 'works-as-intended', 'invalid', 'external', 'duplicate', 'wont-do')),
    verdict_notes TEXT,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
    pr TEXT,
    branch TEXT,
    predicted_files TEXT NOT NULL CHECK (json_valid(predicted_files)),
    reopen_count INTEGER NOT NULL CHECK (reopen_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`;

const PRE_CANCEL_EVENTS_TABLE_SQL = `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add', 'accept', 'abandon', 'verdict', 'turnin', 'complete', 'reopen', 'update', 'chain')),
    detail TEXT NOT NULL CHECK (json_valid(detail))
  ) STRICT`;

const NO_LEASE_QUESTS_TABLE_SQL = `CREATE TABLE quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    area TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'task')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    guild TEXT,
    assignee TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'ready', 'accepted', 'turned_in', 'complete', 'dropped')),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('actionable', 'not-reproduced', 'works-as-intended', 'invalid', 'external', 'duplicate', 'wont-do')),
    verdict_notes TEXT,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
    pr TEXT,
    predicted_files TEXT NOT NULL CHECK (json_valid(predicted_files)),
    reopen_count INTEGER NOT NULL CHECK (reopen_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`;

async function createLegacyStore(databasePath: string): Promise<void> {
  const database = new Database(databasePath, { create: true, readwrite: true, strict: true });
  try {
    database.run(LEGACY_QUESTS_TABLE_SQL);
    for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS) {
      if (
        definition.target !== "events" &&
        !(definition.type === "table" && definition.target === "quests")
      ) {
        database.run(definition.sql);
      }
    }
    database.run(PRE_CANCEL_EVENTS_TABLE_SQL);
    for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS) {
      if (definition.target === "events" && definition.type !== "table") {
        database.run(definition.sql);
      }
    }
    database.run(
      `INSERT INTO quests (
        id, repo, area, kind, title, description, opened_by, assignee, status, verdict,
        verdict_notes, priority, pr, branch, predicted_files, reopen_count, created_at, updated_at
      ) VALUES (1, 'quest', 'store', 'task', 'Legacy guild migration', '', 'janior', NULL,
        'ready', NULL, NULL, 2, NULL, 'quest/legacy', '[]', 0,
        '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z')`,
    );
    database.run(
      `INSERT INTO events (id, quest_id, at, actor, action, detail)
       VALUES (1, 1, '2026-07-30T00:00:00.000Z', 'janior', 'add', ?)`,
      [
        JSON.stringify({
          repo: "quest",
          area: "store",
          kind: "task",
          title: "Legacy guild migration",
          description: "",
          opened_by: "janior",
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          branch: "quest/legacy",
          predicted_files: [],
          reopen_count: 0,
          backfill: false,
        }),
      ],
    );
    database.run("PRAGMA user_version = 1");
  } finally {
    database.close();
  }
}

async function createPreCancelStore(databasePath: string): Promise<void> {
  const store = new SqliteStore(databasePath);
  await store.addQuest({
    repo: "quest",
    area: "store",
    kind: "task",
    title: "Pre-cancel restore",
    description: "",
    opened_by: "migration-test",
    assignee: null,
    status: "ready",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
  });
  store.close();

  const database = new Database(databasePath, { readwrite: true, strict: true });
  try {
    for (const definition of [...SQLITE_MIGRATION_SCHEMA_DEFINITIONS].reverse()) {
      if (definition.type === "trigger") {
        database.run(`DROP TRIGGER IF EXISTS ${definition.name}`);
      } else {
        database.run(`DROP TABLE IF EXISTS ${definition.name}`);
      }
    }
    database.run("PRAGMA foreign_keys = OFF");
    database.run("BEGIN IMMEDIATE");
    try {
      database.run(
        NO_LEASE_QUESTS_TABLE_SQL.replace("CREATE TABLE quests", "CREATE TABLE quests_v2"),
      );
      database.run(`
        INSERT INTO quests_v2 (
          id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
          verdict_notes, priority, pr, predicted_files, reopen_count, created_at, updated_at
        )
        SELECT
          id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
          verdict_notes, priority, pr, predicted_files, reopen_count, created_at, updated_at
        FROM quests
        ORDER BY id
      `);
      database.run("DROP TABLE quests");
      database.run(NO_LEASE_QUESTS_TABLE_SQL);
      database.run(`
        INSERT INTO quests (
          id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
          verdict_notes, priority, pr, predicted_files, reopen_count, created_at, updated_at
        )
        SELECT
          id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
          verdict_notes, priority, pr, predicted_files, reopen_count, created_at, updated_at
        FROM quests_v2
        ORDER BY id
      `);
      database.run("DROP TABLE quests_v2");
      for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
        ({ target, type }) => target === "quests" && type === "index",
      )) {
        database.run(definition.sql);
      }
      for (const { name } of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
        ({ target, type }) => target === "events" && type === "trigger",
      )) {
        database.run(`DROP TRIGGER IF EXISTS ${name}`);
      }
      database.run("DROP INDEX IF EXISTS events_quest_id");
      database.run(
        PRE_CANCEL_EVENTS_TABLE_SQL.replace("CREATE TABLE events", "CREATE TABLE events_v2"),
      );
      database.run(
        `INSERT INTO events_v2 (id, quest_id, at, actor, action, detail)
         SELECT id, quest_id, at, actor, action, detail
         FROM events
         ORDER BY id`,
      );
      database.run("DROP TABLE events");
      database.run(PRE_CANCEL_EVENTS_TABLE_SQL);
      database.run(
        `INSERT INTO events (id, quest_id, at, actor, action, detail)
         SELECT id, quest_id, at, actor, action, detail
         FROM events_v2
         ORDER BY id`,
      );
      database.run("DROP TABLE events_v2");
      for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
        ({ target, type }) => target === "events" && type !== "table",
      )) {
        database.run(definition.sql);
      }
      database.run("PRAGMA user_version = 2");
      database.run("COMMIT");
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

describe("SQLite migrations to v6", () => {
  test("backs up and migrates a live v1 store through the compatibility probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-"));
    const databasePath = join(root, "state", "quest.db");
    const backupRoot = join(root, "backups");

    try {
      await mkdir(join(root, "state"), { recursive: true });
      await createLegacyStore(databasePath);
      const probe = createStoreCompatibilityProbe({
        migrateStore: () => migrateSqliteStore({ backupRoot, databasePath }),
        readStoreVersion: () => readSqliteSchemaVersion(databasePath),
        supportedVersion: SQLITE_SCHEMA_VERSION,
      });

      expect(await probe.check()).toMatchObject({
        outcome: "store-older",
        store_version: 1,
        supported_version: SQLITE_SCHEMA_VERSION,
      });
      const migrate = probe.migrate;
      if (migrate === undefined) {
        throw new Error("compatibility probe did not expose the migration callback");
      }
      await migrate();

      expect(await probe.check()).toEqual({
        outcome: "compatible",
        store_version: SQLITE_SCHEMA_VERSION,
        supported_version: SQLITE_SCHEMA_VERSION,
      });
      const migrated = new SqliteStore(databasePath);
      try {
        expect(await migrated.getQuest(1)).toMatchObject({
          guild: null,
          title: "Legacy guild migration",
        });
        const replayInput = {
          repo: "quest",
          area: "store",
          kind: "task",
          title: "Legacy guild migration",
          description: "",
          opened_by: "janior",
          guild: null,
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          predicted_files: [],
          reopen_count: 0,
          backfill: false,
          session_guild: "new-guild",
        } satisfies NewQuest;
        const replay = await addLifecycleQuest(
          {
            blobStore: new LocalBlobStore(join(root, "evidence")),
            evidenceFiles: createLocalEvidenceFileReader(),
            questStore: migrated,
          },
          replayInput,
          {
            duplicateOf: null,
            evidence: {
              actor: "janior",
              paths: [],
              sessionGuild: "new-guild",
              stage: "report",
              workingDirectory: root,
            },
            force: false,
            sessionGuild: "new-guild",
          },
        );
        expect(replay).toMatchObject({ outcome: "replayed", quest: { id: 1 } });

        const accepted = await migrated.acceptQuest({ id: 1, owner: "janior" });
        expect(accepted.outcome).toBe("accepted");
        const touched = await migrated.touchQuest({ id: 1, owner: "janior" });
        expect(touched.status).toBe("accepted");
        expect((await migrated.events(1)).at(-1)?.action).toBe("touch");
      } finally {
        migrated.close();
      }

      const migrationFiles = await readdir(join(backupRoot, "migrations"));
      expect(migrationFiles).toHaveLength(1);
      const backupPath = join(backupRoot, "migrations", migrationFiles[0] ?? "");
      const backup = new Database(backupPath, { readonly: true, strict: true });
      try {
        expect(readSqliteSchemaVersion(backupPath)).toBe(1);
        expect(
          backup.query<{ branch: string | null }, []>("SELECT branch FROM quests").get(),
        ).toEqual({
          branch: "quest/legacy",
        });
      } finally {
        backup.close();
      }

      const restoredPath = join(root, "restored", "quest.db");
      const restore = await new SqliteBackupDatabase(restoredPath).restoreSnapshot(
        backupPath,
        "migration-backup",
      );
      await restore.commit();
      const restored = new SqliteStore(restoredPath);
      try {
        expect(await restored.getQuest(1)).toMatchObject({
          guild: null,
          title: "Legacy guild migration",
        });
      } finally {
        restored.close();
      }

      const active = new SqliteStore(databasePath);
      try {
        const onlineRestore = await new SqliteBackupDatabase(databasePath, active).restoreSnapshot(
          backupPath,
          "online-migration-backup",
        );
        await onlineRestore.commit();
        expect(await active.getQuest(1)).toMatchObject({
          guild: null,
          title: "Legacy guild migration",
        });
      } finally {
        active.close();
      }

      const migratedDatabase = new Database(databasePath, { readonly: true, strict: true });
      try {
        const columns = migratedDatabase
          .query<{ name: string }, []>("PRAGMA table_info(quests)")
          .all()
          .map(({ name }) => name);
        expect(columns).toContain("guild");
        expect(columns).not.toContain("branch");
      } finally {
        migratedDatabase.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores a physical v2 snapshot through migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-restore-v2-"));
    const sourcePath = join(root, "source.db");
    const destinationPath = join(root, "restored", "quest.db");

    try {
      await createPreCancelStore(sourcePath);
      const restore = await new SqliteBackupDatabase(destinationPath).restoreSnapshot(
        sourcePath,
        "v2-physical-backup",
      );
      await restore.commit();

      expect(readSqliteSchemaVersion(destinationPath)).toBe(SQLITE_SCHEMA_VERSION);
      const restored = new SqliteStore(destinationPath);
      try {
        expect(await restored.getQuest(1)).toMatchObject({ title: "Pre-cancel restore" });
      } finally {
        restored.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("adds the fence schema when migrating a physical v4 store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-v4-fence-"));
    const databasePath = join(root, "quest.db");
    const backupRoot = join(root, "backups");

    try {
      const current = new SqliteStore(databasePath);
      current.close();

      const preFence = new Database(databasePath, { readwrite: true, strict: true });
      try {
        for (const definition of [...SQLITE_MIGRATION_SCHEMA_DEFINITIONS].reverse()) {
          if (definition.type === "trigger") {
            preFence.run(`DROP TRIGGER IF EXISTS ${definition.name}`);
          } else {
            preFence.run(`DROP TABLE IF EXISTS ${definition.name}`);
          }
        }
        preFence.run("PRAGMA user_version = 4");
      } finally {
        preFence.close();
      }

      await migrateSqliteStore({ backupRoot, databasePath });

      expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
      const migrated = new SqliteStore(databasePath);
      try {
        await expect(migrated.exportAll()).resolves.toMatchObject({ quests: [], evidence: [] });
      } finally {
        migrated.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("updates v5 fence triggers before accepting a current store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-v5-global-guard-"));
    const databasePath = join(root, "quest.db");
    const backupRoot = join(root, "backups");

    try {
      const current = new SqliteStore(databasePath);
      current.close();

      const preGlobalGuard = new Database(databasePath, { readwrite: true, strict: true });
      try {
        for (const definition of SQLITE_MIGRATION_SCHEMA_DEFINITIONS) {
          if (definition.type === "trigger") {
            preGlobalGuard.run(`DROP TRIGGER IF EXISTS ${definition.name}`);
          }
        }
        for (const definition of SQLITE_PRE_GLOBAL_GUARD_MIGRATION_SCHEMA_DEFINITIONS) {
          if (definition.type === "trigger") {
            preGlobalGuard.run(definition.sql);
          }
        }
        preGlobalGuard.run("PRAGMA user_version = 5");
      } finally {
        preGlobalGuard.close();
      }

      await migrateSqliteStore({ backupRoot, databasePath });

      expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
      const migrated = new SqliteStore(databasePath);
      const staleWriter = new Database(databasePath, { readwrite: true, strict: true });
      try {
        const session = await migrated.beginMigration(await migrated.exportAll());
        await session.fence("fenced");
        await session.commit();
        expect(() =>
          staleWriter.run(
            `INSERT INTO quests (
              repo, kind, title, description, opened_by, status, priority,
              predicted_files, reopen_count, created_at, updated_at
            ) VALUES ('other', 'task', 'blocked', '', 'test', 'ready', 2, '[]', 0, ?, ?)`,
            ["2026-07-31T12:00:00.000Z", "2026-07-31T12:00:00.000Z"],
          ),
        ).toThrow("MIGRATION_REPOSITORY_FENCED");
        await session.release();
      } finally {
        staleWriter.close();
        migrated.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses to rewrite a v1 store with unexpected quest columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-drift-"));
    const databasePath = join(root, "quest.db");

    try {
      await createLegacyStore(databasePath);
      const database = new Database(databasePath, { readwrite: true, strict: true });
      try {
        database.run("ALTER TABLE quests ADD COLUMN unexpected TEXT");
      } finally {
        database.close();
      }

      await expect(
        migrateSqliteStore({ backupRoot: join(root, "backups"), databasePath }),
      ).rejects.toThrow("owned v1 schema");

      const unchanged = new Database(databasePath, { readonly: true, strict: true });
      try {
        expect(readSqliteSchemaVersion(databasePath)).toBe(1);
        expect(
          unchanged.query<{ name: string }, []>("PRAGMA table_info(quests)").all(),
        ).toContainEqual(expect.objectContaining({ name: "unexpected" }));
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("repeated migrations keep one migration backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-race-"));
    const databasePath = join(root, "quest.db");
    const backupRoot = join(root, "backups");

    try {
      await createLegacyStore(databasePath);
      await migrateSqliteStore({ backupRoot, databasePath });
      await migrateSqliteStore({ backupRoot, databasePath });

      expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
      expect(await readdir(join(backupRoot, "migrations"))).toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses to rewrite a v1 store with unexpected quest indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-index-"));
    const databasePath = join(root, "quest.db");

    try {
      await createLegacyStore(databasePath);
      const database = new Database(databasePath, { readwrite: true, strict: true });
      try {
        database.run("CREATE INDEX custom_quests_title ON quests(title)");
      } finally {
        database.close();
      }

      await expect(
        migrateSqliteStore({ backupRoot: join(root, "backups"), databasePath }),
      ).rejects.toThrow("unexpected index custom_quests_title");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses a staging-table name collision before migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-staging-"));
    const databasePath = join(root, "quest.db");

    try {
      await createLegacyStore(databasePath);
      const database = new Database(databasePath, { readwrite: true, strict: true });
      try {
        database.run("CREATE TABLE quests_v4 (id INTEGER PRIMARY KEY) STRICT");
      } finally {
        database.close();
      }

      await expect(
        migrateSqliteStore({ backupRoot: join(root, "backups"), databasePath }),
      ).rejects.toThrow("staging table quests_v4 collides");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
