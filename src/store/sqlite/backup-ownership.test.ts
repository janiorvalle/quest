import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { NewQuest } from "../../schema";
import { SqliteStore } from "./adapter";
import { SqliteBackupDatabase } from "./backup";
import { SQLITE_SCHEMA_VERSION } from "./ddl";
import { acquireExclusiveSqliteStoreOwnership } from "./ownership";

async function createSnapshotDatabase(path: string): Promise<void> {
  const store = new SqliteStore(`${path}.source`);
  store.createBackupSnapshot(path);
  store.close();
}

function task(title: string): NewQuest {
  return {
    repo: "sqlite",
    area: "store",
    kind: "task",
    title,
    description: "",
    opened_by: "ownership-test",
    assignee: null,
    status: "ready",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
  };
}

async function holdStoreOwnership(databasePath: string): Promise<() => Promise<void>> {
  const ownershipModule = pathToFileURL(join(import.meta.dir, "ownership.ts")).href;
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--eval",
      `
        const modulePath = process.env.QUEST_OWNERSHIP_MODULE;
        const databasePath = process.env.QUEST_OWNERSHIP_DATABASE;
        if (modulePath === undefined || databasePath === undefined) {
          throw new Error("ownership holder environment is incomplete");
        }
        const { acquireSharedSqliteStoreOwnership } = await import(modulePath);
        const ownership = acquireSharedSqliteStoreOwnership(databasePath);
        console.log("ready");
        await Bun.stdin.text();
        ownership.release();
      `,
    ],
    env: {
      ...process.env,
      QUEST_OWNERSHIP_DATABASE: databasePath,
      QUEST_OWNERSHIP_MODULE: ownershipModule,
    },
    stderr: "pipe",
    stdin: "pipe",
    stdout: "pipe",
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  reader.releaseLock();
  if (ready.done || ready.value === undefined) {
    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();
    throw new Error(`ownership holder exited ${exitCode} before ready: ${stderr}`);
  }
  expect(new TextDecoder().decode(ready.value)).toBe("ready\n");

  return async () => {
    child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
  };
}

describe("offline SQLite restore ownership", () => {
  test("keeps normal stores concurrent and requires every shared owner to close", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-restore-ownership-shared-"));
    const live = join(root, "quest.db");
    const first = new SqliteStore(live);
    const second = new SqliteStore(live);
    try {
      expect(() => acquireExclusiveSqliteStoreOwnership(live)).toThrow(
        "cannot replace the Quest store while another Quest process is using it",
      );
      first.close();
      expect(() => acquireExclusiveSqliteStoreOwnership(live)).toThrow(
        "cannot replace the Quest store while another Quest process is using it",
      );
      second.close();
      const exclusive = acquireExclusiveSqliteStoreOwnership(live);
      exclusive.release();
    } finally {
      first.close();
      second.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not expose online restore rows before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-restore-online-isolation-"));
    const live = join(root, "live.db");
    const sourceStore = new SqliteStore(join(root, "source.db"));
    await sourceStore.addQuest(task("restored quest"));
    const snapshot = join(root, "snapshot.db");
    sourceStore.createBackupSnapshot(snapshot);
    sourceStore.close();

    const store = new SqliteStore(live, { watchPollIntervalMs: 5 });
    const emissions: string[][] = [];
    const subscription = await store.watch({ repo: "sqlite" }, (quests) => {
      emissions.push(quests.map(({ title }) => title));
    });
    const backup = new SqliteBackupDatabase(live, store);
    try {
      const rolledBack = await backup.restoreSnapshot(snapshot, "online-rollback");
      await expect(store.listQuests({ repo: "sqlite" })).rejects.toThrow(
        "cannot use the SQLite store while a backup restore is uncommitted",
      );
      await Bun.sleep(20);
      expect(emissions).toEqual([[]]);
      await rolledBack.rollback();

      const committed = await backup.restoreSnapshot(snapshot, "online-commit");
      expect(emissions).toEqual([[]]);
      await committed.commit();
      expect(emissions).toEqual([[], ["restored quest"]]);
    } finally {
      await subscription.unsubscribe();
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores migration fences with a physical snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-restore-fence-snapshot-"));
    const sourcePath = join(root, "source.db");
    const livePath = join(root, "live.db");
    const snapshotPath = join(root, "snapshot.db");
    const source = new SqliteStore(sourcePath);
    const live = new SqliteStore(livePath);
    try {
      await source.addQuest(task("fenced restore"));
      const migration = await source.beginMigration(await source.exportAll());
      await migration.fence("sqlite");
      await migration.commit();
      await migration.release();
      source.createBackupSnapshot(snapshotPath);

      const restore = await new SqliteBackupDatabase(livePath, live).restoreSnapshot(
        snapshotPath,
        "fence-snapshot",
      );
      await restore.commit();

      await expect(live.addQuest(task("blocked after restore"))).rejects.toThrow(
        "MIGRATION_REPOSITORY_FENCED",
      );
    } finally {
      source.close();
      live.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses schema-incompatible replacement while a cooperating process owns the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-restore-ownership-schema-"));
    const source = join(root, "source.db");
    const live = join(root, "live", "quest.db");
    await createSnapshotDatabase(source);
    const liveStore = new SqliteStore(live);
    liveStore.close();
    const newer = new Database(live);
    newer.run("PRAGMA user_version = 2");
    newer.close();

    const stopHolder = await holdStoreOwnership(live);
    try {
      const backup = new SqliteBackupDatabase(live);
      await expect(backup.restoreSnapshot(source, "schema-locked")).rejects.toThrow(
        "cannot replace the Quest store while another Quest process is using it",
      );
      const unchanged = new Database(live, { readonly: true });
      try {
        expect(unchanged.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
          user_version: 2,
        });
      } finally {
        unchanged.close();
      }
    } finally {
      await stopHolder();
    }

    try {
      const restored = await new SqliteBackupDatabase(live).restoreSnapshot(
        source,
        "schema-released",
      );
      await restored.commit();
      const current = new Database(live, { readonly: true });
      try {
        expect(current.query<{ user_version: number }, []>("PRAGMA user_version").get()).toEqual({
          user_version: SQLITE_SCHEMA_VERSION,
        });
      } finally {
        current.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refuses corrupt replacement while a cooperating process owns the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-restore-ownership-corrupt-"));
    const source = join(root, "source.db");
    const live = join(root, "live", "quest.db");
    await createSnapshotDatabase(source);
    await mkdir(join(root, "live"), { recursive: true });
    await writeFile(live, "corrupt live database");

    const stopHolder = await holdStoreOwnership(live);
    try {
      await expect(
        new SqliteBackupDatabase(live).restoreSnapshot(source, "corrupt-locked"),
      ).rejects.toThrow("cannot replace the Quest store while another Quest process is using it");
      expect(await readFile(live, "utf8")).toBe("corrupt live database");
    } finally {
      await stopHolder();
    }

    try {
      const restored = await new SqliteBackupDatabase(live).restoreSnapshot(
        source,
        "corrupt-released",
      );
      await restored.commit();
      const current = new Database(live, { readonly: true });
      try {
        expect(
          current.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all(),
        ).toEqual([{ integrity_check: "ok" }]);
      } finally {
        current.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
