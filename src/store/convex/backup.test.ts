import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type QuestDump, STORE_SCHEMA_VERSION } from "../../schema";
import { ConvexBackupDatabase } from "./backup";

const emptyDump: QuestDump = {
  schema_version: STORE_SCHEMA_VERSION,
  quests: [],
  evidence: [],
  chains: [],
  events: [],
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function snapshotFile(dump: QuestDump): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "quest-convex-backup-"));
  directories.push(directory);
  const path = join(directory, "snapshot.json");
  await writeFile(path, `${JSON.stringify(dump)}\n`);
  return { directory, path };
}

function quest(id: number, repo: string): QuestDump["quests"][number] {
  return {
    id,
    repo,
    area: null,
    kind: "task",
    title: `Quest ${id}`,
    description: "restore fixture",
    opened_by: "test",
    guild: null,
    assignee: null,
    status: "ready",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    predicted_files: [],
    reopen_count: 0,
    lease_expires_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

describe("Convex backup restore", () => {
  test("resolves an ambiguous commit before allowing rollback", async () => {
    const { directory, path } = await snapshotFile(emptyDump);
    let commitAttempts = 0;
    let releases = 0;
    const store = {
      exportAll: async () => emptyDump,
      exportAllWithCutoff: async () => ({
        dump: emptyDump,
        lease_cutoff: "2026-08-01T00:00:00.000Z",
      }),
      beginRestore: async () => "restore-token",
      recoverMigrationFenceForRestore: async () => false,
      renewRestore: async () => undefined,
      activateRestore: async () => emptyDump,
      commitRestore: async () => {
        commitAttempts += 1;
        throw new Error("response was lost after commit");
      },
      restoreStatus: async () => ({ status: "committed" as const, dump: emptyDump }),
      releaseRestore: async () => {
        releases += 1;
      },
      rollbackRestore: async () => {
        throw new Error("committed data must not roll back");
      },
    };
    const backup = new ConvexBackupDatabase(join(directory, "live.json"), store);
    const restore = await backup.restoreSnapshot(path, "ambiguous");

    await restore.activate();
    await restore.commit();
    await restore.rollback();

    expect(commitAttempts).toBe(2);
    expect(releases).toBe(1);
  });

  test("restores snapshot cross-repository chains instead of newer destination links", async () => {
    const snapshot: QuestDump = {
      ...emptyDump,
      quests: [quest(1, "target"), quest(2, "other")],
      chains: [{ quest_id: 2, target_id: 1, type: "duplicate-of" }],
    };
    const current: QuestDump = {
      ...snapshot,
      chains: [{ quest_id: 1, target_id: 2, type: "requires" }],
    };
    const { directory, path } = await snapshotFile(snapshot);
    let activated = emptyDump;
    const store = {
      exportAll: async () => current,
      exportAllWithCutoff: async () => ({
        dump: current,
        lease_cutoff: "2026-08-01T00:00:00.000Z",
      }),
      beginRestore: async () => "restore-token",
      recoverMigrationFenceForRestore: async () => false,
      renewRestore: async () => undefined,
      activateRestore: async (_token: string, replacement: QuestDump) => {
        activated = replacement;
        return replacement;
      },
      commitRestore: async () => activated,
      restoreStatus: async () => ({ status: "active" as const }),
      releaseRestore: async () => undefined,
      rollbackRestore: async () => undefined,
    };
    const backup = new ConvexBackupDatabase(join(directory, "live.json"), store);
    const restore = await backup.restoreSnapshot(path, "chains", "target");

    await restore.activate();

    expect(activated.chains).toEqual([{ quest_id: 2, target_id: 1, type: "duplicate-of" }]);
    await restore.rollback();
  });

  test("rejects a repository restore that would leave a retained event dangling", async () => {
    const snapshot: QuestDump = {
      ...emptyDump,
      quests: [quest(2, "other")],
    };
    const current: QuestDump = {
      ...snapshot,
      quests: [quest(1, "target"), quest(2, "other")],
      events: [
        {
          id: 1,
          quest_id: 2,
          at: "2026-08-01T00:00:00.000Z",
          actor: "test",
          action: "verdict",
          detail: { duplicate_of: 1 },
        },
      ],
    };
    const { directory, path } = await snapshotFile(snapshot);
    let restoreStarted = false;
    const store = {
      exportAll: async () => current,
      exportAllWithCutoff: async () => ({
        dump: current,
        lease_cutoff: "2026-08-01T00:00:00.000Z",
      }),
      beginRestore: async () => {
        restoreStarted = true;
        return "restore-token";
      },
      recoverMigrationFenceForRestore: async () => false,
      renewRestore: async () => undefined,
      activateRestore: async (_token: string, replacement: QuestDump) => replacement,
      commitRestore: async () => emptyDump,
      restoreStatus: async () => ({ status: "active" as const }),
      releaseRestore: async () => undefined,
      rollbackRestore: async () => undefined,
    };
    const backup = new ConvexBackupDatabase(join(directory, "live.json"), store);

    await expect(backup.restoreSnapshot(path, "events", "target")).rejects.toThrow(
      "[BACKUP_REPOSITORY_RESTORE_CONFLICT] event 1 references quest ID 1 missing after restoring target; restore the complete backup after verifying the destination state",
    );
    expect(restoreStarted).toBeFalse();
  });

  test("rejects a repository restore whose snapshot event is already dangling", async () => {
    const snapshot: QuestDump = {
      ...emptyDump,
      quests: [quest(1, "target")],
      events: [
        {
          id: 1,
          quest_id: 1,
          at: "2026-08-01T00:00:00.000Z",
          actor: "test",
          action: "verdict",
          detail: { duplicate_of: 2 },
        },
      ],
    };
    const { directory, path } = await snapshotFile(snapshot);
    let restoreStarted = false;
    const store = {
      exportAll: async () => emptyDump,
      exportAllWithCutoff: async () => ({
        dump: emptyDump,
        lease_cutoff: "2026-08-01T00:00:00.000Z",
      }),
      beginRestore: async () => {
        restoreStarted = true;
        return "restore-token";
      },
      recoverMigrationFenceForRestore: async () => false,
      renewRestore: async () => undefined,
      activateRestore: async (_token: string, replacement: QuestDump) => replacement,
      commitRestore: async () => emptyDump,
      restoreStatus: async () => ({ status: "active" as const }),
      releaseRestore: async () => undefined,
      rollbackRestore: async () => undefined,
    };
    const backup = new ConvexBackupDatabase(join(directory, "live.json"), store);

    await expect(backup.restoreSnapshot(path, "events", "target")).rejects.toThrow(
      "[BACKUP_REPOSITORY_RESTORE_CONFLICT] event 1 references quest ID 2 missing after restoring target; restore the complete backup after verifying the destination state",
    );
    expect(restoreStarted).toBeFalse();
  });
});
