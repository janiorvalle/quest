import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewQuest } from "../schema";
import { SqliteStore } from "../store";
import { getQuestPlan } from "./plan";

const now = "2026-08-02T16:00:00Z";

function task(repo: string, title: string): NewQuest {
  return {
    repo,
    area: "cli",
    kind: "task",
    title,
    description: title,
    opened_by: "fixture",
    assignee: null,
    status: "open",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
    backfill: true,
  };
}

describe("quest plan service", () => {
  test("computes one scoped read snapshot without writing derived state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-plan-service-"));
    const store = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      const root = await store.addQuest(task("alpha", "Root"));
      const dependent = await store.addQuest(task("alpha", "Dependent"));
      const outsideRequirement = await store.addQuest(task("beta", "Other repository"));
      const crossRepositoryDependent = await store.addQuest(
        task("alpha", "Cross repository dependent"),
      );
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: dependent.id, target_id: root.id, type: "requires" },
      });
      await store.addChainLink({
        actor: "fixture",
        link: {
          quest_id: crossRepositoryDependent.id,
          target_id: outsideRequirement.id,
          type: "requires",
        },
      });
      const before = await store.exportAll();

      const result = await getQuestPlan(store, { repo: "alpha" }, now);

      expect(result.quests.map((quest) => quest.id)).toEqual([
        root.id,
        dependent.id,
        crossRepositoryDependent.id,
      ]);
      expect(result.quests.find((quest) => quest.id === dependent.id)).toMatchObject({
        blockers: [root.id],
        computed_state: "blocked",
        root_blockers: [root.id],
      });
      expect(result.quests.find((quest) => quest.id === crossRepositoryDependent.id)).toMatchObject(
        {
          blockers: [outsideRequirement.id],
          computed_state: "blocked",
          root_blockers: [outsideRequirement.id],
        },
      );
      expect(await store.exportAll()).toEqual(before);
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
