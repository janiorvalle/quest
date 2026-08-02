import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliOutputBoundary, EXIT_SUCCESS } from "../output";
import type { Config, NewQuest, QuestReport } from "../schema";
import { SqliteStore } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const now = "2026-08-02T16:00:00Z";

const config = {
  store: { backend: "sqlite" },
  repos: {},
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

function task(repo: string, title: string, changes: Partial<NewQuest> = {}): NewQuest {
  return {
    repo,
    area: "cli",
    kind: "task",
    title,
    description: title,
    opened_by: "fixture",
    assignee: null,
    status: "ready",
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

describe("plan CLI behavior", () => {
  test("drills the JSON and plain-text plan against a real board", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-plan-cli-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const store = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    const dependencies = {
      applicationVersion: "1.2.3",
      clock: { now: () => Promise.resolve(now) },
      compatibilityProbe: {
        check: () =>
          Promise.resolve({
            outcome: "compatible",
            supported_version: 1,
            store_version: 1,
          }),
      },
      config,
      evidenceFiles: { read: () => Promise.reject(new Error("plan must not read evidence")) },
      initialWorkingDirectory: directory,
      isTty: false,
      locateGitRoot: () => Promise.resolve(directory),
      openApplicationPorts: () =>
        Promise.resolve({
          blobStore: {
            get: () => Promise.resolve(null),
            has: () => Promise.resolve(false),
            put: () => Promise.reject(new Error("plan must not write evidence")),
          },
          clock: { now: () => Promise.resolve(now) },
          questStore: store,
        }),
      output: createCliOutputBoundary({
        stdout: (text) => stdout.push(text),
        stderr: (line) => stderr.push(line),
      }),
      prompter: { ask: () => Promise.reject(new Error("plan must not prompt")) },
      validateWorkingDirectory: () => Promise.resolve(),
    } satisfies QuestCliDependencies;

    try {
      const root = await store.addQuest(task("alpha", "Root", { area: "store" }));
      const blocked = await store.addQuest(
        task("alpha", "Blocked", { predicted_files: ["src/shared.ts"] }),
      );
      const inFlight = await store.addQuest(
        task("alpha", "In flight", {
          assignee: "worker",
          lease_expires_at: "2026-08-02T17:00:00Z",
          predicted_files: ["src/shared.ts"],
          status: "accepted",
        }),
      );
      const softOne = await store.addQuest(task("alpha", "Soft one", { area: "tui" }));
      const softTwo = await store.addQuest(task("alpha", "Soft two", { area: "tui" }));
      await store.addQuest(task("beta", "Other repository"));
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: blocked.id, target_id: root.id, type: "requires" },
      });
      const before = await store.exportAll();

      const jsonCode = await runQuestCli(
        ["plan", "--repo", "alpha", "--format", "json"],
        dependencies,
      );
      const report = JSON.parse(stdout.join("")) as QuestReport;
      expect(jsonCode).toBe(EXIT_SUCCESS);
      expect(stderr).toEqual([]);
      expect(report).toMatchObject({
        command: "plan",
        generated_at: now,
        filters: { repo: "alpha" },
        warnings: [],
        data: {
          quests: [
            { id: inFlight.id, computed_state: "in_flight" },
            { id: root.id, computed_state: "dispatchable" },
            { id: softOne.id, computed_state: "dispatchable" },
            { id: softTwo.id, computed_state: "dispatchable" },
            {
              id: blocked.id,
              computed_state: "blocked",
              blockers: [root.id],
              root_blockers: [root.id],
              blocker_paths: [[blocked.id, root.id]],
            },
          ],
          lane_clusters: expect.arrayContaining([
            {
              area: null,
              files: ["src/shared.ts"],
              heuristic: false,
              kind: "shared_files",
              quest_ids: [blocked.id, inFlight.id],
            },
            {
              area: "tui",
              files: [],
              heuristic: true,
              kind: "same_area",
              quest_ids: [softOne.id, softTwo.id],
            },
          ]),
        },
      });
      expect(await store.exportAll()).toEqual(before);

      stdout.length = 0;
      const textCode = await runQuestCli(["plan", "--repo", "alpha"], dependencies);
      const text = stdout.join("");
      expect(textCode).toBe(EXIT_SUCCESS);
      expect(text).toContain("ID  STATE");
      expect(text).toContain("in-flight");
      expect(text).toContain("heuristic");
      expect(text.indexOf("In flight")).toBeLessThan(text.indexOf("Blocked"));
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
