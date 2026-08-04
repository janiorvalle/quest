import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliOutputBoundary, EXIT_SUCCESS } from "../output";
import type { NewQuest, QuestReport } from "../schema";
import { SqliteStore } from "../store";
import { createQuestCommand } from "./program";
import { executeQaCli } from "./qa";

const now = "2026-08-02T16:00:00Z";

function completed(title: string, changes: Partial<NewQuest> = {}): NewQuest {
  return {
    repo: "quest",
    area: "cli",
    kind: "task",
    title,
    description: title,
    opened_by: "fixture",
    assignee: null,
    status: "complete",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    lease_expires_at: null,
    reopen_count: 0,
    backfill: true,
    ...changes,
  };
}

describe("QA CLI behavior", () => {
  test("renders the three-session drill in JSON and human output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-cli-"));
    const stdout: string[] = [];
    const store = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    const output = createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: () => undefined,
    });
    try {
      const chainedOne = await store.addQuest(completed("chained one", { area: "store" }));
      const chainedTwo = await store.addQuest(completed("chained two", { area: "tui" }));
      const sharedOne = await store.addQuest(
        completed("shared one", {
          predicted_files: ["src/shared.ts"],
        }),
      );
      const sharedTwo = await store.addQuest(
        completed("shared two", {
          area: "store",
          predicted_files: ["src/shared.ts"],
        }),
      );
      const standalone = await store.addQuest(completed("standalone", { area: "docs" }));
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: chainedOne.id, target_id: chainedTwo.id, type: "requires" },
      });
      const before = await store.exportAll();

      const jsonCode = await executeQaCli({
        clock: { now: () => Promise.resolve(now) },
        format: "json",
        output,
        ports: { questStore: store },
        request: { command: "qa" },
        shell: "posix",
        scope: { repo: "quest" },
      });
      expect(jsonCode).toBe(EXIT_SUCCESS);
      const report = JSON.parse(stdout.join("")) as QuestReport;
      expect(report).toMatchObject({
        command: "qa",
        generated_at: now,
        data: {
          summary: { quests: 5, sessions: 3 },
          sessions: [
            { ids: [chainedOne.id, chainedTwo.id], reason: "chain" },
            { ids: [sharedOne.id, sharedTwo.id], reason: "shared_files" },
            { ids: [standalone.id], reason: "area" },
          ],
        },
      });
      expect(await store.exportAll()).toEqual(before);

      stdout.length = 0;
      const textCode = await executeQaCli({
        clock: { now: () => Promise.resolve(now) },
        format: "human",
        output,
        ports: { questStore: store },
        request: { command: "qa" },
        shell: "posix",
        scope: { repo: "quest" },
      });
      expect(textCode).toBe(EXIT_SUCCESS);
      expect(stdout.join("")).toContain("GROUP  IDS");
      expect(stdout.join("")).toContain("3 sessions instead of 5 quests.");
      expect(stdout.join("")).toContain("quest --repo 'quest' signoff");
      expect(stdout.join("")).toContain("quest --repo <repo> reopen <id> --notes");
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("registers qa as a read-only command", async () => {
    let request: unknown;
    const output = createCliOutputBoundary({ stdout: () => undefined, stderr: () => undefined });
    const command = createQuestCommand(output, { set: (value) => (request = value) });
    await command.parseAsync(["qa"], { from: "user" });
    expect(request).toEqual({ command: "qa" });
  });
});
