import { type Changes, Database, type SQLQueryBindings } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  chainTypeSchema,
  eventActionSchema,
  evidenceKindSchema,
  evidenceStageSchema,
  type NewQuest,
  questKindSchema,
  questSchema,
  questStatusSchema,
  verdictSchema,
} from "../../schema";
import {
  defineQuestStoreContract,
  defineReviewerHandoffContract,
  type QuestStoreFactory,
} from "../contract";
import { SqliteStore } from "./adapter";
import { SQLITE_SCHEMA_STATEMENTS, SQLITE_SCHEMA_VERSION } from "./ddl";

const actor = "sqlite/tester";
const cleanupDirectories = new Set<string>();

function getRow<Row>(database: Database, sql: string): Row | null {
  const statement = database.prepare<Row, []>(sql);
  try {
    return statement.get();
  } finally {
    statement.finalize();
  }
}

function getRows<Row>(database: Database, sql: string): Row[] {
  const statement = database.prepare<Row, []>(sql);
  try {
    return statement.all();
  } finally {
    statement.finalize();
  }
}

function runStatement<Params extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  ...params: Params
): Changes {
  const statement = database.prepare<never, SQLQueryBindings[]>(sql);
  try {
    return statement.run(...params);
  } finally {
    statement.finalize();
  }
}

afterAll(async () => {
  await Promise.all(
    [...cleanupDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const sqliteContractFactory: QuestStoreFactory = async () => {
  const { databasePath, directory } = await createDatabasePath();
  let failEventAppend = false;
  const store = new SqliteStore(databasePath, {
    beforeEventAppend: () => {
      if (failEventAppend) {
        failEventAppend = false;
        throw new Error("injected event append failure");
      }
    },
    watchPollIntervalMs: 5,
  });

  return {
    store,
    failNextEventAppend: async () => {
      failEventAppend = true;
    },
    flushWatch: async () => {
      await Promise.resolve();
    },
    close: async () => {
      store.close();
      await removeDirectory(directory);
    },
  };
};

defineQuestStoreContract("SqliteStore contract", sqliteContractFactory);
defineReviewerHandoffContract("SqliteStore reviewer handoff contract", sqliteContractFactory);

describe("SqliteStore", () => {
  test("enables WAL, installs the schema, persists rows, and writes schema-valid timestamps", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    const quest = await store.addQuest(taskInput("persistent quest"));
    const evidence = await store.addEvidence({
      quest_id: quest.id,
      sha256: "a".repeat(64),
      filename: "proof.log",
      kind: "log",
      stage: "fix",
      added_by: actor,
    });
    const events = await store.events(quest.id);

    expect(questSchema.safeParse(quest).success).toBeTrue();
    expect(await store.getQuest(99_999)).toBeNull();
    expect(quest.created_at.endsWith("Z")).toBeTrue();
    expect(evidence.created_at.endsWith("Z")).toBeTrue();
    expect(events.every((event) => event.at.endsWith("Z"))).toBeTrue();
    expect(await Bun.file(`${databasePath}-wal`).exists()).toBeTrue();
    store.close();

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    const journalMode = getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode");
    const userVersion = getRow<{ user_version: number }>(inspection, "PRAGMA user_version");
    const tables = getRows<{ name: string }>(
      inspection,
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    ).map(({ name }) => name);
    inspection.close();

    expect(journalMode?.journal_mode.toLowerCase()).toBe("wal");
    expect(userVersion?.user_version).toBe(SQLITE_SCHEMA_VERSION);
    expect(tables).toEqual(expect.arrayContaining(["chains", "events", "evidence", "quests"]));

    const reopened = new SqliteStore(databasePath);
    expect(await reopened.getQuest(quest.id)).toEqual(quest);
    expect(await reopened.events(quest.id)).toEqual(events);
    reopened.close();
    await removeDirectory(directory);
  });

  test("enforces a migration fence inside SQLite for a stale writer", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    const staleWriter = new Database(databasePath, { readwrite: true, strict: true });
    try {
      await store.addQuest(taskInput("fenced repository"));
      const session = await store.beginMigration(await store.exportAll());
      await session.fence("fenced repository");
      await session.commit();
      await session.release();

      expect(await store.listFencedRepositories()).toEqual(["fenced repository"]);
      await expect(store.replaceAll(await store.exportAll())).rejects.toThrow(
        "MIGRATION_REPOSITORY_FENCED",
      );
      expect(() =>
        runStatement(
          staleWriter,
          `INSERT INTO quests (
            repo, area, kind, title, description, opened_by, status, priority,
            predicted_files, reopen_count, created_at, updated_at
          ) VALUES (?, ?, 'task', ?, '', ?, 'open', 2, '[]', 0, ?, ?)`,
          "fenced repository",
          "store",
          "stale writer",
          actor,
          "2026-07-31T12:00:00.000Z",
          "2026-07-31T12:00:00.000Z",
        ),
      ).toThrow("MIGRATION_REPOSITORY_FENCED");
    } finally {
      staleWriter.close();
      store.close();
      await removeDirectory(directory);
    }
  });

  test("allows a committed migration release to retry after a busy guard cleanup", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    const blocker = new Database(databasePath, { readwrite: true, strict: true });
    try {
      const session = await store.beginMigration(await store.exportAll());
      await session.commit();
      runStatement(blocker, "BEGIN IMMEDIATE");

      await expect(session.release()).rejects.toThrow();

      runStatement(blocker, "ROLLBACK");
      await session.release();
      expect(() =>
        runStatement(
          blocker,
          `INSERT INTO quests (
              repo, area, kind, title, description, opened_by, status, priority,
              predicted_files, reopen_count, created_at, updated_at
            ) VALUES (?, ?, 'task', ?, '', ?, 'open', 2, '[]', 0, ?, ?)`,
          "after-release",
          "store",
          "retryable release",
          actor,
          "2026-07-31T12:00:00.000Z",
          "2026-07-31T12:00:00.000Z",
        ),
      ).not.toThrow();
    } finally {
      if (blocker.inTransaction) {
        runStatement(blocker, "ROLLBACK");
      }
      blocker.close();
      store.close();
      await removeDirectory(directory);
    }
  });

  test("rejects public replacement while a migration session is active", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    try {
      const session = await store.beginMigration(await store.exportAll());
      await expect(store.replaceAll(await store.exportAll())).rejects.toThrow(
        "MIGRATION_LOCK_ACTIVE",
      );
      await session.rollback();
    } finally {
      store.close();
      await removeDirectory(directory);
    }
  });

  test("rejects physical snapshots while a migration transaction is active", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    const snapshotPath = join(directory, "migration-snapshot.db");
    try {
      await store.addQuest(taskInput("before migration"));
      const expected = await store.exportAll();
      const session = await store.beginMigration(expected);
      await session.replace({
        ...expected,
        quests: expected.quests.map((quest) => ({ ...quest, title: "during migration" })),
      });

      expect(() => store.createBackupSnapshot(snapshotPath)).toThrow("MIGRATION_LOCK_ACTIVE");
      await session.rollback();
    } finally {
      store.close();
      await removeDirectory(directory);
    }
  });

  test("derives every persisted enum constraint from the Zod-owned options", () => {
    const ddl = SQLITE_SCHEMA_STATEMENTS.join("\n");
    const schemas = [
      questKindSchema,
      questStatusSchema,
      verdictSchema,
      evidenceKindSchema,
      evidenceStageSchema,
      chainTypeSchema,
      eventActionSchema,
    ];
    for (const schema of schemas) {
      for (const value of schema.options) {
        expect(ddl).toContain(`'${value}'`);
      }
    }
  });

  test("rejects unsupported schema versions before changing persistent journal settings", async () => {
    const { databasePath, directory } = await createDatabasePath();
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    const journalModeBefore = getRow<{ journal_mode: string }>(
      database,
      "PRAGMA journal_mode",
    )?.journal_mode;
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow(
      `unsupported SQLite schema version ${SQLITE_SCHEMA_VERSION + 1}`,
    );

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode")?.journal_mode).toBe(
      journalModeBefore,
    );
    expect(getRow<{ user_version: number }>(inspection, "PRAGMA user_version")?.user_version).toBe(
      SQLITE_SCHEMA_VERSION + 1,
    );
    inspection.close();
    await removeDirectory(directory);
  });

  test("does not claim an unrelated database that uses the current numeric version", async () => {
    const { databasePath, directory } = await createDatabasePath();
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    database.run("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    const journalModeBefore = getRow<{ journal_mode: string }>(
      database,
      "PRAGMA journal_mode",
    )?.journal_mode;
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow(
      "SQLite table quests does not match owned schema",
    );

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode")?.journal_mode).toBe(
      journalModeBefore,
    );
    expect(
      getRows<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).map(({ name }) => name),
    ).toEqual(["unrelated"]);
    inspection.close();
    await removeDirectory(directory);
  });

  test("does not claim an unrelated unversioned database", async () => {
    const { databasePath, directory } = await createDatabasePath();
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    database.run("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    const journalModeBefore = getRow<{ journal_mode: string }>(
      database,
      "PRAGMA journal_mode",
    )?.journal_mode;
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow(
      "unversioned SQLite database already contains application table unrelated",
    );

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode")?.journal_mode).toBe(
      journalModeBefore,
    );
    expect(getRow<{ user_version: number }>(inspection, "PRAGMA user_version")?.user_version).toBe(
      0,
    );
    expect(
      getRows<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).map(({ name }) => name),
    ).toEqual(["unrelated"]);
    inspection.close();
    await removeDirectory(directory);
  });

  test("rejects a current-version database whose owned schema was changed", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    store.close();
    const database = new Database(databasePath, {
      create: false,
      readwrite: true,
      strict: true,
    });
    database.run("DROP INDEX quests_repo_id");
    database.run("CREATE INDEX quests_repo_id ON quests(id)");
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow(
      "SQLite index quests_repo_id does not match owned schema",
    );

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(
      getRow<{ sql: string }>(
        inspection,
        "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'quests_repo_id'",
      )?.sql,
    ).toBe("CREATE INDEX quests_repo_id ON quests(id)");
    inspection.close();
    await removeDirectory(directory);
  });

  test("rejects unversioned Quest tables without stamping or changing journal mode", async () => {
    const { databasePath, directory } = await createDatabasePath();
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    database.run(
      "CREATE TABLE quests (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, status TEXT NOT NULL)",
    );
    const journalModeBefore = getRow<{ journal_mode: string }>(
      database,
      "PRAGMA journal_mode",
    )?.journal_mode;
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow(
      "unversioned SQLite database already contains Quest tables",
    );

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode")?.journal_mode).toBe(
      journalModeBefore,
    );
    expect(getRow<{ user_version: number }>(inspection, "PRAGMA user_version")?.user_version).toBe(
      0,
    );
    inspection.close();
    await removeDirectory(directory);
  });

  test("rolls back schema installation failures before changing journal mode", async () => {
    const { databasePath, directory } = await createDatabasePath();
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    database.run("CREATE VIEW quests AS SELECT 1 AS id");
    const journalModeBefore = getRow<{ journal_mode: string }>(
      database,
      "PRAGMA journal_mode",
    )?.journal_mode;
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow();

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode")?.journal_mode).toBe(
      journalModeBefore,
    );
    expect(getRow<{ user_version: number }>(inspection, "PRAGMA user_version")?.user_version).toBe(
      0,
    );
    expect(
      getRows<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      ).map(({ name }) => name),
    ).toEqual(["quests"]);
    inspection.close();
    await removeDirectory(directory);
  });

  test("rejects reserved trigger collisions before installing or stamping the schema", async () => {
    const { databasePath, directory } = await createDatabasePath();
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    database.run("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    database.run(`CREATE TRIGGER events_are_append_only_update
      BEFORE UPDATE ON unrelated
      BEGIN
        SELECT RAISE(ABORT, 'unrelated trigger');
      END`);
    const journalModeBefore = getRow<{ journal_mode: string }>(
      database,
      "PRAGMA journal_mode",
    )?.journal_mode;
    database.close();

    expect(() => new SqliteStore(databasePath)).toThrow(
      "unversioned SQLite database uses reserved trigger events_are_append_only_update",
    );

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(getRow<{ journal_mode: string }>(inspection, "PRAGMA journal_mode")?.journal_mode).toBe(
      journalModeBefore,
    );
    expect(getRow<{ user_version: number }>(inspection, "PRAGMA user_version")?.user_version).toBe(
      0,
    );
    expect(
      getRows<{ name: string }>(
        inspection,
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).map(({ name }) => name),
    ).toEqual(["unrelated"]);
    inspection.close();
    await removeDirectory(directory);
  });

  test("accepts offset timestamps and rejects an invalid event time atomically", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const offsetTimestamp = "2026-07-29T12:30:00-04:00";
    const offsetStore = new SqliteStore(databasePath, {
      now: () => offsetTimestamp,
    });
    const first = await offsetStore.addQuest(taskInput("offset timestamp one"));
    const second = await offsetStore.addQuest(taskInput("offset timestamp two"));
    expect(first.created_at).toBe(offsetTimestamp);
    expect((await offsetStore.events(first.id))[0]?.at).toBe(offsetTimestamp);
    offsetStore.close();

    const invalidStore = new SqliteStore(databasePath, {
      now: () => "2026-07-29 12:30:00",
    });
    const before = await invalidStore.exportAll();
    await expect(
      invalidStore.addChainLink({
        actor,
        link: {
          quest_id: second.id,
          target_id: first.id,
          type: "requires",
        },
      }),
    ).rejects.toThrow();
    expect(await invalidStore.exportAll()).toEqual(before);
    invalidStore.close();
    await removeDirectory(directory);
  });

  test("queries events across quests with inclusive instant ranges and quest filters", async () => {
    const { databasePath, directory } = await createDatabasePath();
    let now = "2026-07-29T12:30:00-04:00";
    const store = new SqliteStore(databasePath, { now: () => now });
    const first = await store.addQuest(taskInput("first event"));
    now = "2026-07-29T17:00:00Z";
    const second = await store.addQuest(taskInput("second event"));

    const events = await store.queryEvents({
      action: "add",
      area: "store",
      repo: "sqlite",
      since: "2026-07-29T16:30:00Z",
      until: "2026-07-29T17:00:00Z",
    });
    expect(events.map(({ quest_id }) => quest_id)).toEqual([first.id, second.id]);
    expect(await store.queryEvents({ quest_id: first.id })).toEqual(events.slice(0, 1));
    expect(await store.queryEvents({ after_id: events[0]?.id ?? 0 })).toEqual(events.slice(1));

    store.close();
    await removeDirectory(directory);
  });

  test("keeps the frozen lifecycle behavior and event sequence", async () => {
    await withStore(async (store) => {
      const quest = await store.addQuest(taskInput("lifecycle"));
      const updated = await store.transition(quest.id, {
        action: "update",
        actor,
        changes: {
          title: "updated lifecycle",
          area: null,
          priority: 1,
          predicted_files: ["src/store/sqlite/adapter.ts"],
        },
      });
      expect(updated).toMatchObject({
        title: "updated lifecycle",
        area: null,
        priority: 1,
        predicted_files: ["src/store/sqlite/adapter.ts"],
      });

      await store.acceptQuest({ id: quest.id, owner: actor });
      const abandoned = await store.transition(quest.id, {
        action: "abandon",
        actor,
      });
      expect(abandoned).toMatchObject({ assignee: null, status: "open" });

      await store.acceptQuest({ id: quest.id, owner: actor });
      await store.transition(quest.id, {
        action: "turnin",
        actor,
        pr: "17",
        session_guild: null,
      });
      const reopened = await store.transition(quest.id, {
        action: "reopen",
        actor,
        notes: "verification failed",
      });
      expect(reopened).toMatchObject({
        assignee: null,
        status: "open",
        reopen_count: 1,
        verdict_notes: "verification failed",
      });

      await store.acceptQuest({ id: quest.id, owner: actor });
      await store.transition(quest.id, {
        action: "turnin",
        actor,
        pr: "17",
        session_guild: null,
      });
      const completed = await store.transition(quest.id, {
        action: "complete",
        actor,
      });
      expect(completed.status).toBe("complete");
      const reopenedComplete = await store.transition(quest.id, {
        action: "reopen",
        actor,
        notes: "verification correction",
      });
      expect(reopenedComplete).toMatchObject({
        assignee: null,
        reopen_count: 2,
        status: "open",
      });

      const events = await store.events(quest.id);
      expect(events.map(({ action }) => action)).toEqual([
        "add",
        "update",
        "accept",
        "abandon",
        "accept",
        "turnin",
        "reopen",
        "accept",
        "turnin",
        "complete",
        "reopen",
      ]);
      expect(events.map(({ id }) => id)).toEqual(
        events.map(({ id }) => id).sort((left, right) => left - right),
      );
      expect(new Set(events.map(({ id }) => id)).size).toBe(events.length);
    });
  });

  test("preserves not-reproduced retest routing without changing lifecycle rules", async () => {
    await withStore(async (store) => {
      const bug = await store.addQuest(bugInput("retest bug"));
      const retest = await store.transition(bug.id, {
        action: "verdict",
        actor,
        verdict: "not-reproduced",
        notes: "try another environment",
        retest: true,
        duplicate_of: null,
      });
      expect(retest).toMatchObject({
        status: "open",
        verdict: "not-reproduced",
      });
      const dropped = await store.transition(bug.id, {
        action: "verdict",
        actor,
        verdict: "invalid",
        notes: null,
        retest: false,
        duplicate_of: null,
      });
      expect(dropped).toMatchObject({ status: "dropped", verdict: "invalid" });
    });
  });

  test("allows late triage for accepted bugs and clears the claim", async () => {
    await withStore(async (store) => {
      const bug = await store.addQuest(bugInput("late triage"));
      await store.transition(bug.id, {
        action: "verdict",
        actor,
        verdict: "actionable",
        notes: null,
        retest: false,
        duplicate_of: null,
      });
      await store.acceptQuest({ id: bug.id, owner: actor });

      const dropped = await store.transition(bug.id, {
        action: "verdict",
        actor,
        verdict: "invalid",
        notes: "late investigation disproved it",
        retest: false,
        duplicate_of: null,
      });
      expect(dropped).toMatchObject({
        assignee: null,
        status: "dropped",
        verdict: "invalid",
      });
    });
  });

  test("cancels tasks without a verdict and reopens terminal states forward", async () => {
    await withStore(async (store) => {
      const task = await store.addQuest(taskInput("cancel and reopen"));
      const canceled = await store.transition(task.id, {
        action: "cancel",
        actor,
        reason: "superseded",
      });
      expect(canceled).toMatchObject({
        status: "dropped",
        verdict: null,
        verdict_notes: "superseded",
      });

      const reopened = await store.transition(task.id, {
        action: "reopen",
        actor,
        notes: "scope restored",
      });
      expect(reopened).toMatchObject({ reopen_count: 1, status: "open" });

      await store.acceptQuest({ id: task.id, owner: actor });
      await store.transition(task.id, { action: "turnin", actor, pr: null });
      await store.transition(task.id, { action: "complete", actor });
      const corrected = await store.transition(task.id, {
        action: "reopen",
        actor,
        notes: "verification was premature",
      });
      expect(corrected).toMatchObject({ reopen_count: 2, status: "open" });
      expect((await store.events(task.id)).map(({ action }) => action)).toEqual([
        "add",
        "cancel",
        "reopen",
        "accept",
        "turnin",
        "complete",
        "reopen",
      ]);
    });
  });

  test("treats a matching pre-existing duplicate link as part of the verdict mutation", async () => {
    await withStore(async (store) => {
      const duplicate = await store.addQuest(bugInput("duplicate source"));
      const target = await store.addQuest(bugInput("duplicate target"));
      await store.addChainLink({
        actor,
        link: {
          quest_id: duplicate.id,
          target_id: target.id,
          type: "duplicate-of",
        },
      });

      const dropped = await store.transition(duplicate.id, {
        action: "verdict",
        actor,
        verdict: "duplicate",
        notes: null,
        retest: false,
        duplicate_of: target.id,
      });
      expect(dropped).toMatchObject({ status: "dropped", verdict: "duplicate" });
      expect(
        (await store.exportAll()).chains.filter(
          ({ quest_id, target_id, type }) =>
            quest_id === duplicate.id && target_id === target.id && type === "duplicate-of",
        ),
      ).toHaveLength(1);
      expect((await store.events(duplicate.id)).map(({ action }) => action)).toEqual([
        "add",
        "chain",
        "verdict",
      ]);

      const reopened = await store.transition(duplicate.id, {
        action: "reopen",
        actor,
        notes: "duplicate target was wrong",
      });
      expect(reopened).toMatchObject({ status: "open", verdict: null });
      expect(
        (await store.exportAll()).chains.filter(
          ({ quest_id, type }) => quest_id === duplicate.id && type === "duplicate-of",
        ),
      ).toHaveLength(0);
      expect((await store.events(duplicate.id)).map(({ action }) => action)).toEqual([
        "add",
        "chain",
        "verdict",
        "chain",
        "reopen",
      ]);
    });
  });

  test("uses the conditional claim update across independent adapters", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const first = new SqliteStore(databasePath);
    const second = new SqliteStore(databasePath);
    const quest = await first.addQuest(taskInput("cross-adapter claim"));

    const results = await Promise.all([
      first.acceptQuest({ id: quest.id, owner: "sqlite/one" }),
      second.acceptQuest({ id: quest.id, owner: "sqlite/two" }),
    ]);
    expect(results.filter(({ outcome }) => outcome === "accepted")).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === "conflict")).toHaveLength(1);
    expect((await first.events(quest.id)).map(({ action }) => action)).toEqual(["add", "accept"]);

    first.close();
    second.close();
    await removeDirectory(directory);
  });

  test("guards lane conflicts inside the claim transaction", async () => {
    await withStore(async (store) => {
      const inFlight = await store.addQuest({
        ...taskInput("lane owner"),
        assignee: "sqlite/other",
        lease_expires_at: "2099-01-01T00:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      });
      const candidate = await store.addQuest({
        ...taskInput("lane candidate"),
        predicted_files: ["src/shared.ts"],
      });
      await store.addQuest({
        ...taskInput("other repository lane owner"),
        repo: "other",
        assignee: "other/worker",
        lease_expires_at: "2099-01-01T00:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      });

      const refused = await store.acceptQuest({
        id: candidate.id,
        lane_conflict_guard: true,
        owner: actor,
      });
      expect(refused).toMatchObject({
        outcome: "lane-conflict",
        lane_conflicts: [{ files: ["src/shared.ts"], quest_id: inFlight.id }],
        quest: { assignee: null, status: "open" },
      });
      expect((await store.events(candidate.id)).map(({ action }) => action)).toEqual(["add"]);

      const acknowledged = await store.acceptQuest({
        id: candidate.id,
        lane_conflict_acknowledged: [{ files: ["src/shared.ts"], quest_id: inFlight.id }],
        lane_conflict_guard: true,
        owner: actor,
      });
      expect(acknowledged).toMatchObject({
        outcome: "accepted",
        quest: { assignee: actor, status: "accepted" },
      });
    });
  });

  test("checks guild routing inside the atomic claim update", async () => {
    await withStore(async (store) => {
      const quest = await store.addQuest({ ...taskInput("guild-routed claim"), guild: "claude" });

      const blocked = await store.acceptQuest({
        id: quest.id,
        owner: actor,
        session_guild: null,
      });
      expect(blocked).toMatchObject({
        outcome: "guild-mismatch",
        quest: { assignee: null, guild: "claude", status: "open" },
      });
      expect(await store.getQuest(quest.id)).toMatchObject({ assignee: null, status: "open" });

      const forced = await store.acceptQuest({
        force: true,
        id: quest.id,
        owner: actor,
        session_guild: null,
      });
      expect(forced).toMatchObject({
        outcome: "accepted",
        quest: { assignee: actor, guild: "claude", status: "accepted" },
      });
      await expect(
        store.touchQuest({ id: quest.id, owner: actor, session_guild: null }),
      ).resolves.toMatchObject({
        assignee: actor,
        status: "accepted",
      });
    });
  });

  test("materializes expired leases, renews touches, and rejects stale reclaimed writes", async () => {
    const { databasePath, directory } = await createDatabasePath();
    let now = "2026-07-31T00:00:00Z";
    const store = new SqliteStore(databasePath, { now: () => now });
    try {
      const quest = await store.addQuest(taskInput("lease lifecycle"));
      const accepted = await store.acceptQuest({ id: quest.id, owner: "ryan" });
      expect(accepted).toMatchObject({
        outcome: "accepted",
        lease_expires_at: "2026-08-01T00:00:00.000Z",
        quest: { assignee: "ryan", status: "accepted" },
      });

      now = "2026-07-31T00:10:00Z";
      const touched = await store.touchQuest({ id: quest.id, owner: "ryan" });
      expect(touched.lease_expires_at).toBe("2026-08-01T00:10:00.000Z");
      expect((await store.events(quest.id)).at(-1)?.action).toBe("touch");
      await expect(store.touchQuest({ id: quest.id, owner: "amy" })).rejects.toThrow(
        "lease owned by ryan",
      );

      now = "2026-08-01T00:11:00Z";
      expect(await store.getQuest(quest.id)).toMatchObject({
        assignee: null,
        lease_expires_at: null,
        status: "open",
      });
      await expect(store.touchQuest({ id: quest.id, owner: "ryan" })).rejects.toThrow(
        "re-accept to continue",
      );
      await expect(
        store.transition(quest.id, {
          action: "update",
          actor: "unseen",
          changes: { title: "stale" },
        }),
      ).rejects.toThrow("re-accept to continue");

      now = "2026-08-01T00:41:00Z";
      const database = new Database(databasePath);
      try {
        runStatement(
          database,
          "UPDATE quests SET assignee = ?, status = ?, lease_expires_at = ? WHERE id = ?",
          "ryan",
          "accepted",
          "2026-08-01T02:40:00+02:00",
          quest.id,
        );
      } finally {
        database.close();
      }
      const reclaimed = await store.acceptQuest({ id: quest.id, owner: "amy" });
      expect(reclaimed).toMatchObject({
        outcome: "accepted",
        quest: { assignee: "amy", status: "accepted" },
      });
      await expect(
        store.transition(quest.id, {
          action: "update",
          actor: "ryan",
          changes: { title: "stale" },
        }),
      ).rejects.toThrow("[QUEST_LEASE_HELD] quest 1 lease owned by amy; stop, amy has it");
      expect((await store.events(quest.id)).map(({ action }) => action)).toEqual([
        "add",
        "accept",
        "touch",
        "accept",
      ]);

      now = "2026-07-31T03:00:00Z";
      const openBug = await store.addQuest(bugInput("expired untriaged bug"));
      await store.acceptQuest({ id: openBug.id, lease_ttl_minutes: 30, owner: "ryan" });
      now = "2026-07-31T03:31:00Z";
      expect(await store.getQuest(openBug.id)).toMatchObject({
        assignee: null,
        lease_expires_at: null,
        status: "open",
        verdict: null,
      });
    } finally {
      store.close();
      await removeDirectory(directory);
    }
  });

  test("honors configured and per-accept lease durations", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const now = "2026-07-31T00:00:00Z";
    const store = new SqliteStore(databasePath, {
      leaseTtlMinutes: 60,
      now: () => now,
    });
    try {
      const configuredQuest = await store.addQuest(taskInput("configured lease"));
      const configured = await store.acceptQuest({ id: configuredQuest.id, owner: actor });
      expect(configured).toMatchObject({
        lease_expires_at: "2026-07-31T01:00:00.000Z",
      });

      const overriddenQuest = await store.addQuest(taskInput("overridden lease"));
      const overridden = await store.acceptQuest({
        id: overriddenQuest.id,
        lease_ttl_minutes: 5,
        owner: actor,
      });
      expect(overridden).toMatchObject({
        lease_expires_at: "2026-07-31T00:05:00.000Z",
      });
    } finally {
      store.close();
      await removeDirectory(directory);
    }
  });

  test("filters blocked quests and computes scoped aggregates from consistent snapshots", async () => {
    await withStore(async (store) => {
      const prerequisite = await store.addQuest({
        ...taskInput("prerequisite"),
        repo: "alpha",
      });
      const dependent = await store.addQuest({
        ...taskInput("dependent"),
        repo: "alpha",
      });
      await store.addQuest({ ...taskInput("other repo"), repo: "beta" });
      await store.addChainLink({
        actor,
        link: {
          quest_id: dependent.id,
          target_id: prerequisite.id,
          type: "requires",
        },
      });
      await store.acceptQuest({ id: dependent.id, owner: actor });

      expect(
        (await store.listQuests({ repo: "alpha", blocked: true })).map(({ id }) => id),
      ).toEqual([dependent.id]);
      expect(await store.stats({ repo: "alpha" })).toEqual({
        repos: [
          {
            repo: "alpha",
            total: 2,
            status_counts: { open: 1, accepted: 1 },
            verdict_counts: {},
            reopen_count: 0,
            assignee_load: { [actor]: 1 },
          },
        ],
      });
    });
  });

  test("counts assignee names that collide with Object prototype properties", async () => {
    await withStore(async (store) => {
      const first = await store.addQuest(taskInput("prototype owner one"));
      const second = await store.addQuest(taskInput("prototype owner two"));
      await store.acceptQuest({ id: first.id, owner: "__proto__" });
      await store.acceptQuest({ id: second.id, owner: "constructor" });

      const stats = await store.stats({ repo: "sqlite" });
      expect(Object.entries(stats.repos[0]?.assignee_load ?? {}).sort()).toEqual([
        ["__proto__", 1],
        ["constructor", 1],
      ]);
    });
  });

  test("polls external commits and emits complete filtered snapshots", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const watchingStore = new SqliteStore(databasePath, { watchPollIntervalMs: 5 });
    const writingStore = new SqliteStore(databasePath);
    const emissions: number[][] = [];
    const subscription = await watchingStore.watch({ repo: "watched" }, (quests) => {
      emissions.push(quests.map(({ id }) => id));
    });

    const quest = await writingStore.addQuest({
      ...taskInput("external write"),
      repo: "watched",
    });
    await waitFor(() => emissions.some((ids) => ids.includes(quest.id)));
    expect(emissions.at(-1)).toEqual([quest.id]);

    await subscription.unsubscribe();
    watchingStore.close();
    writingStore.close();
    await removeDirectory(directory);
  });

  test("emits passive lease expiry without waiting for a database write", async () => {
    const { databasePath, directory } = await createDatabasePath();
    let now = "2026-08-10T12:00:00.000Z";
    const store = new SqliteStore(databasePath, {
      now: () => now,
      watchPollIntervalMs: 5,
    });
    const quest = await store.addQuest(taskInput("passive lease expiry"));
    await store.acceptQuest({ id: quest.id, lease_ttl_minutes: 1, owner: actor });
    const statuses: string[] = [];
    const subscription = await store.watch({ repo: "sqlite" }, (quests) => {
      const watched = quests.find(({ id }) => id === quest.id);
      if (watched !== undefined) {
        statuses.push(watched.status);
      }
    });

    expect(statuses.at(-1)).toBe("accepted");
    now = "2026-08-10T12:01:01.000Z";
    await waitFor(() => statuses.at(-1) === "open");

    await subscription.unsubscribe();
    store.close();
    await removeDirectory(directory);
  });

  test("database constraints reject event rewrites and invalid enum storage", async () => {
    const { databasePath, directory } = await createDatabasePath();
    const store = new SqliteStore(databasePath);
    const quest = await store.addQuest(taskInput("protected rows"));
    store.close();

    const database = new Database(databasePath, { readwrite: true, strict: true });
    database.run("PRAGMA foreign_keys = ON");
    expect(() =>
      runStatement(database, "UPDATE events SET action = 'update' WHERE quest_id = ?", quest.id),
    ).toThrow("events are append-only");
    expect(() => runStatement(database, "DELETE FROM events WHERE quest_id = ?", quest.id)).toThrow(
      "events are append-only",
    );
    const eventBeforeReplace = getRow<{ action: string; id: number }>(
      database,
      "SELECT id, action FROM events ORDER BY id LIMIT 1",
    );
    expect(() =>
      runStatement(
        database,
        `INSERT OR REPLACE INTO events (id, quest_id, at, actor, action, detail)
          SELECT id, quest_id, at, actor, 'update', detail
          FROM events WHERE quest_id = ?`,
        quest.id,
      ),
    ).toThrow("events are append-only");
    expect(
      getRow<{ action: string; id: number }>(
        database,
        "SELECT id, action FROM events ORDER BY id LIMIT 1",
      ),
    ).toEqual(eventBeforeReplace);
    expect(() =>
      runStatement(database, "UPDATE quests SET status = 'unknown' WHERE id = ?", quest.id),
    ).toThrow();
    database.close();
    await removeDirectory(directory);
  });
});

async function withStore(run: (store: SqliteStore) => Promise<void>): Promise<void> {
  const { databasePath, directory } = await createDatabasePath();
  const store = new SqliteStore(databasePath);
  try {
    await run(store);
  } finally {
    store.close();
    await removeDirectory(directory);
  }
}

async function createDatabasePath(): Promise<{
  databasePath: string;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "quest-sqlite-"));
  cleanupDirectories.add(directory);
  return {
    databasePath: join(directory, "state", "quest.db"),
    directory,
  };
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { force: true, recursive: true });
  cleanupDirectories.delete(directory);
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for SQLite watcher emission");
    }
    await Bun.sleep(5);
  }
}

function taskInput(title: string): NewQuest {
  return {
    repo: "sqlite",
    area: "store",
    kind: "task",
    title,
    description: "",
    opened_by: actor,
    assignee: null,
    status: "open",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
  };
}

function bugInput(title: string): NewQuest {
  return {
    ...taskInput(title),
    kind: "bug",
    status: "open",
  };
}
