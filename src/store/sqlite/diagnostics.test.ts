import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newQuestSchema } from "../../schema";
import { SqliteStore } from "./adapter";
import { inspectSqliteStore } from "./diagnostics";

describe("SQLite doctor inspection", () => {
  test("reads the raw lease state without opening the writable store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-sqlite-doctor-"));
    const databasePath = join(root, "quest.db");
    const store = new SqliteStore(databasePath, {
      now: () => "2026-07-31T18:00:00.000Z",
    });
    try {
      await store.addQuest(
        newQuestSchema.parse({
          area: "cli",
          assignee: "stale-worker",
          description: "stale fixture",
          guild: null,
          kind: "task",
          lease_expires_at: "2026-07-31T17:30:00.000Z",
          opened_by: "fixture",
          pr: null,
          predicted_files: [],
          priority: 2,
          repo: "quest",
          reopen_count: 0,
          status: "accepted",
          title: "stale fixture",
          verdict: null,
          verdict_notes: null,
        }),
      );
    } finally {
      store.close();
    }

    try {
      const inspection = inspectSqliteStore(databasePath);
      expect(inspection).toMatchObject({
        integrity_check: ["ok"],
        state: "present",
      });
      if (inspection.state === "present" && inspection.dump !== undefined) {
        expect(inspection.dump.quests[0]).toMatchObject({
          assignee: "stale-worker",
          lease_expires_at: "2026-07-31T17:30:00.000Z",
          status: "accepted",
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
