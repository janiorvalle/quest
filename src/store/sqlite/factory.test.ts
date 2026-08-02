import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questSchema } from "../../schema";
import {
  createSqliteStore,
  createSystemClock,
  readSqliteSchemaVersion,
  SQLITE_SCHEMA_VERSION,
} from "../index";

describe("public SQLite composition factories", () => {
  test("exports a real store factory and read-only version reader", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-sqlite-factory-"));
    const databasePath = join(directory, "state", "quest.db");
    try {
      expect(readSqliteSchemaVersion(databasePath)).toBeNull();
      const store = createSqliteStore(databasePath);
      const quest = await store.addQuest({
        repo: "quest",
        area: "store",
        kind: "task",
        title: "wire SQLite",
        description: "",
        opened_by: "factory/test",
        assignee: null,
        status: "ready",
        verdict: null,
        verdict_notes: null,
        priority: 1,
        pr: null,
        guild: null,
        predicted_files: [],
        reopen_count: 0,
      });
      expect(questSchema.safeParse(quest).success).toBeTrue();
      store.close();
      expect(readSqliteSchemaVersion(databasePath)).toBe(SQLITE_SCHEMA_VERSION);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("exports the system Clock implementation expected by the composition root", async () => {
    const timestamp = await createSystemClock().now();
    expect(questSchema.shape.created_at.safeParse(timestamp).success).toBeTrue();
  });
});
