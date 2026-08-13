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
  SQLITE_TRIGGER_DEFINITIONS,
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

const PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS = SQLITE_CORE_SCHEMA_DEFINITIONS.map((definition) => ({
  ...definition,
  sql: definition.type === "table" ? definition.sql.replaceAll(", 'signoff'", "") : definition.sql,
}));

function replaceQuestTableWithReadySchema(database: Database): void {
  const questTable = SQLITE_CORE_SCHEMA_DEFINITIONS.find(
    ({ name, type }) => name === "quests" && type === "table",
  );
  if (questTable === undefined) {
    throw new Error("missing quests table fixture");
  }
  database.run("PRAGMA foreign_keys = OFF");
  database.run("DROP TABLE quests");
  database.run(questTable.sql.replace("'open', 'accepted'", "'open', 'ready', 'accepted'"));
  for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
    ({ target, type }) => target === "quests" && type === "index",
  )) {
    database.run(definition.sql);
  }
}

function preSignoffTableSql(name: "evidence" | "events", tableName: string): string {
  const definition = PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS.find(
    (candidate) => candidate.type === "table" && candidate.name === name,
  );
  if (definition === undefined) {
    throw new Error(`missing ${name} table fixture`);
  }
  const createIfMissing = `CREATE TABLE IF NOT EXISTS ${name}`;
  return definition.sql.includes(createIfMissing)
    ? definition.sql.replace(createIfMissing, `CREATE TABLE ${tableName}`)
    : definition.sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE ${tableName}`);
}

async function createLegacyStore(databasePath: string): Promise<void> {
  const database = new Database(databasePath, { create: true, readwrite: true, strict: true });
  try {
    database.run(LEGACY_QUESTS_TABLE_SQL);
    for (const definition of PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS) {
      if (
        definition.target !== "events" &&
        !(definition.type === "table" && definition.target === "quests")
      ) {
        database.run(definition.sql);
      }
    }
    database.run(PRE_CANCEL_EVENTS_TABLE_SQL);
    for (const definition of PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS) {
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
    status: "open",
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
      database.run("DROP INDEX IF EXISTS evidence_quest_id");
      database.run(preSignoffTableSql("evidence", "evidence_v2"));
      database.run("INSERT INTO evidence_v2 SELECT * FROM evidence ORDER BY id");
      database.run("DROP TABLE evidence");
      database.run(preSignoffTableSql("evidence", "evidence"));
      database.run("INSERT INTO evidence SELECT * FROM evidence_v2 ORDER BY id");
      database.run("DROP TABLE evidence_v2");
      for (const definition of PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS.filter(
        ({ target, type }) => target === "evidence" && type === "index",
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

async function createPreSignoffStore(databasePath: string): Promise<void> {
  const current = new SqliteStore(databasePath);
  current.close();

  const database = new Database(databasePath, { readwrite: true, strict: true });
  try {
    for (const { name } of SQLITE_TRIGGER_DEFINITIONS) {
      database.run(`DROP TRIGGER IF EXISTS ${name}`);
    }
    replaceQuestTableWithReadySchema(database);
    for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
      ({ target, type }) => (target === "evidence" || target === "events") && type === "index",
    )) {
      database.run(`DROP INDEX IF EXISTS ${definition.name}`);
    }

    for (const tableName of ["evidence", "events"] as const) {
      const definition = SQLITE_CORE_SCHEMA_DEFINITIONS.find(
        ({ name, type }) => name === tableName && type === "table",
      );
      if (definition === undefined) {
        throw new Error(`missing ${tableName} table fixture`);
      }
      const stagingName = `${tableName}_v6`;
      database.run(
        definition.sql
          .replaceAll(", 'signoff'", "")
          .replace(`CREATE TABLE IF NOT EXISTS ${tableName}`, `CREATE TABLE ${stagingName}`),
      );
      database.run(
        `INSERT INTO ${stagingName} SELECT * FROM ${tableName} ORDER BY ${tableName === "events" ? "id" : "id"}`,
      );
      database.run(`DROP TABLE ${tableName}`);
      database.run(
        definition.sql
          .replaceAll(", 'signoff'", "")
          .replace(`CREATE TABLE IF NOT EXISTS ${tableName}`, `CREATE TABLE ${tableName}`),
      );
      database.run(`INSERT INTO ${tableName} SELECT * FROM ${stagingName} ORDER BY id`);
      database.run(`DROP TABLE ${stagingName}`);
    }

    for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
      ({ target, type }) =>
        (target === "evidence" || target === "events") && type !== "table" && type !== "index",
    )) {
      database.run(definition.sql);
    }
    for (const definition of SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
      ({ target, type }) => (target === "evidence" || target === "events") && type === "index",
    )) {
      database.run(definition.sql);
    }
    for (const definition of SQLITE_MIGRATION_SCHEMA_DEFINITIONS) {
      database.run(definition.sql);
    }
    for (const tableName of ["evidence", "events"] as const) {
      database.run("DELETE FROM sqlite_sequence WHERE name = ?", [tableName]);
      database.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [tableName, 100]);
    }
    database.run("PRAGMA user_version = 6");
  } finally {
    database.close();
  }
}

async function createPreUnifiedOpenStore(databasePath: string): Promise<string> {
  const current = new SqliteStore(databasePath);
  current.close();
  const eventDetail = JSON.stringify({ backfill: false, status: "ready", title: "Ready work" });
  const database = new Database(databasePath, { readwrite: true, strict: true });
  try {
    for (const { name } of SQLITE_TRIGGER_DEFINITIONS) {
      database.run(`DROP TRIGGER IF EXISTS ${name}`);
    }
    replaceQuestTableWithReadySchema(database);
    for (const { sql } of SQLITE_TRIGGER_DEFINITIONS) {
      database.run(sql);
    }
    database.run(
      `INSERT INTO quests (
        id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
        verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at,
        created_at, updated_at
      ) VALUES (1, 'quest', 'store', 'task', 'Ready work', '', 'migration-test', NULL, NULL,
        'ready', NULL, NULL, 2, NULL, '[]', 0, NULL, ?, ?)`,
      ["2026-08-12T12:00:00.000Z", "2026-08-12T12:00:00.000Z"],
    );
    database.run(
      `INSERT INTO events (id, quest_id, at, actor, action, detail)
       VALUES (1, 1, ?, 'migration-test', 'add', ?)`,
      ["2026-08-12T12:00:00.000Z", eventDetail],
    );
    database.run("PRAGMA user_version = 7");
    return eventDetail;
  } finally {
    database.close();
  }
}

describe("SQLite migrations to v8", () => {
  test("converts v7 ready rows to open without rewriting event history", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-v7-open-"));
    const databasePath = join(root, "quest.db");
    const backupRoot = join(root, "backups");
    try {
      const eventDetail = await createPreUnifiedOpenStore(databasePath);
      await migrateSqliteStore({ backupRoot, databasePath });

      const migrated = new SqliteStore(databasePath);
      try {
        expect(await migrated.getQuest(1)).toMatchObject({ status: "open", title: "Ready work" });
        expect((await migrated.events(1))[0]?.detail).toEqual(JSON.parse(eventDetail));
      } finally {
        migrated.close();
      }
      const raw = new Database(databasePath, { readonly: true, strict: true });
      try {
        expect(
          raw.query<{ detail: string }, []>("SELECT detail FROM events WHERE id = 1").get(),
        ).toEqual({ detail: eventDetail });
      } finally {
        raw.close();
      }
      expect(await readdir(join(backupRoot, "migrations"))).toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores a physical v7 snapshot through open-status migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-restore-v7-"));
    const sourcePath = join(root, "source.db");
    const destinationPath = join(root, "restored", "quest.db");

    try {
      const eventDetail = await createPreUnifiedOpenStore(sourcePath);
      const restore = await new SqliteBackupDatabase(destinationPath).restoreSnapshot(
        sourcePath,
        "v7-ready-physical-backup",
      );
      await restore.commit();

      expect(readSqliteSchemaVersion(destinationPath)).toBe(SQLITE_SCHEMA_VERSION);
      const restored = new SqliteStore(destinationPath);
      try {
        expect(await restored.getQuest(1)).toMatchObject({ status: "open", title: "Ready work" });
      } finally {
        restored.close();
      }
      const raw = new Database(destinationPath, { readonly: true, strict: true });
      try {
        expect(
          raw.query<{ detail: string }, []>("SELECT detail FROM events WHERE id = 1").get(),
        ).toEqual({ detail: eventDetail });
      } finally {
        raw.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

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
          status: "open",
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
      await createPreSignoffStore(databasePath);
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
      await createPreSignoffStore(databasePath);
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
            ) VALUES ('other', 'task', 'blocked', '', 'test', 'open', 2, '[]', 0, ?, ?)`,
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

  test("adds sign-off enum values when migrating a physical v6 store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-v6-signoff-"));
    const databasePath = join(root, "quest.db");
    const backupRoot = join(root, "backups");

    try {
      await createPreSignoffStore(databasePath);
      expect(readSqliteSchemaVersion(databasePath)).toBe(6);

      await migrateSqliteStore({ backupRoot, databasePath });

      expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
      const migrated = new SqliteStore(databasePath);
      try {
        const quest = await migrated.addQuest({
          repo: "quest",
          area: "qa",
          kind: "task",
          title: "Migrated sign-off",
          description: "",
          opened_by: "migration-test",
          guild: null,
          assignee: "migration-test",
          status: "complete",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          predicted_files: [],
          reopen_count: 0,
          lease_expires_at: null,
          backfill: true,
        });
        await migrated.transition(quest.id, {
          action: "signoff",
          actor: "qa/reviewer",
          notes: "migration passed",
          session_guild: null,
        });
        const evidence = await migrated.addEvidence({
          quest_id: quest.id,
          sha256: "c".repeat(64),
          filename: "migration-qa.txt",
          kind: "doc",
          stage: "signoff",
          added_by: "qa/reviewer",
        });
        expect(evidence.stage).toBe("signoff");
        expect(evidence.id).toBeGreaterThan(100);
        expect((await migrated.events(quest.id)).at(-1)).toMatchObject({
          action: "update",
          id: expect.any(Number),
        });
        expect((await migrated.events(quest.id)).at(-1)?.id).toBeGreaterThan(100);
      } finally {
        migrated.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores a physical v6 snapshot through sign-off migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-migration-restore-v6-"));
    const sourcePath = join(root, "source.db");
    const destinationPath = join(root, "restored", "quest.db");

    try {
      await createPreSignoffStore(sourcePath);
      const restore = await new SqliteBackupDatabase(destinationPath).restoreSnapshot(
        sourcePath,
        "v6-signoff-physical-backup",
      );
      await restore.commit();

      expect(readSqliteSchemaVersion(destinationPath)).toBe(SQLITE_SCHEMA_VERSION);
      const restored = new SqliteStore(destinationPath);
      try {
        const quest = await restored.addQuest({
          repo: "quest",
          area: "qa",
          kind: "task",
          title: "Restored sign-off",
          description: "",
          opened_by: "migration-test",
          guild: null,
          assignee: "migration-test",
          status: "complete",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          predicted_files: [],
          reopen_count: 0,
          lease_expires_at: null,
          backfill: true,
        });
        await restored.transition(quest.id, {
          action: "signoff",
          actor: "qa/reviewer",
          notes: "physical restore passed",
          session_guild: null,
        });
        expect((await restored.events(quest.id)).at(-1)).toMatchObject({ action: "signoff" });
      } finally {
        restored.close();
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
