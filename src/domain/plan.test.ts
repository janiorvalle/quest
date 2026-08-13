import { describe, expect, test } from "bun:test";

import type { Chain, Quest } from "../schema";
import { computeQuestPlan } from "./plan";

const now = "2026-08-02T16:00:00Z";

function quest(id: number, title: string, options: Partial<Quest> = {}): Quest {
  return {
    id,
    repo: "quest",
    area: "cli",
    kind: "task",
    title,
    description: "",
    opened_by: "fixture",
    guild: null,
    assignee: null,
    status: "open",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    predicted_files: [],
    reopen_count: 0,
    lease_expires_at: null,
    created_at: now,
    updated_at: now,
    ...options,
  };
}

function plan(quests: readonly Quest[], chains: readonly Chain[] = []) {
  return computeQuestPlan({ chains, now, quests });
}

describe("computed quest plan", () => {
  test("includes open work and preserves its blockers", () => {
    const result = plan(
      [
        quest(1, "Ready task", { predicted_files: ["src/shared.ts"] }),
        quest(2, "Open bug", {
          kind: "bug",
          predicted_files: ["src/shared.ts"],
          status: "open",
        }),
        quest(3, "Blocked open bug", { kind: "bug", status: "open" }),
        quest(4, "Open root bug", { kind: "bug", status: "open" }),
      ],
      [{ quest_id: 3, target_id: 4, type: "requires" }],
    );

    expect(result.quests.map((item) => item.id)).toEqual([1, 2, 4, 3]);
    expect(result.quests.find((item) => item.id === 2)).toMatchObject({
      computed_state: "dispatchable",
      status: "open",
    });
    expect(result.quests.find((item) => item.id === 3)).toMatchObject({
      blocker_paths: [[3, 4]],
      blockers: [4],
      computed_state: "blocked",
      root_blockers: [4],
      status: "open",
    });
    expect(result.lane_clusters).toContainEqual({
      area: null,
      files: ["src/shared.ts"],
      heuristic: false,
      kind: "shared_files",
      quest_ids: [1, 2],
    });
  });

  test("layers direct and transitive blockers without persisting a status", () => {
    const result = plan(
      [
        quest(87, "Root blocker"),
        quest(100, "Middle blocker"),
        quest(101, "Dependent"),
        quest(102, "Dropped requirement", { status: "dropped" }),
        quest(103, "Unblocked by dropped requirement"),
      ],
      [
        { quest_id: 100, target_id: 87, type: "requires" },
        { quest_id: 101, target_id: 100, type: "requires" },
        { quest_id: 103, target_id: 102, type: "requires" },
      ],
    );

    expect(result.quests.map((item) => item.id)).toEqual([87, 103, 100, 101]);
    expect(result.quests.find((item) => item.id === 87)).toMatchObject({
      computed_state: "dispatchable",
      status: "open",
    });
    expect(result.quests.find((item) => item.id === 100)).toMatchObject({
      blockers: [87],
      blocker_paths: [[100, 87]],
      chain_depth: 1,
      computed_state: "blocked",
      root_blockers: [87],
    });
    expect(result.quests.find((item) => item.id === 101)).toMatchObject({
      blockers: [100],
      blocker_paths: [[101, 100, 87]],
      chain_depth: 2,
      computed_state: "blocked",
      root_blockers: [87],
    });
    expect(result.quests.find((item) => item.id === 103)).toMatchObject({
      computed_state: "dispatchable",
    });
    expect(result.quests.find((item) => item.id === 100)?.status).toBe("open");
  });

  test("uses every root path when a quest has multiple incomplete requirements", () => {
    const result = plan(
      [quest(1, "Dependent"), quest(2, "First root", { status: "open" }), quest(3, "Second root")],
      [
        { quest_id: 1, target_id: 2, type: "requires" },
        { quest_id: 1, target_id: 3, type: "requires" },
      ],
    );

    expect(result.quests.find((item) => item.id === 1)).toMatchObject({
      id: 1,
      blockers: [2, 3],
      root_blockers: [2, 3],
      blocker_paths: [
        [1, 2],
        [1, 3],
      ],
    });
  });

  test("marks only accepted quests with a live lease as in flight", () => {
    const result = plan([
      quest(1, "Live", {
        assignee: "worker",
        status: "accepted",
        lease_expires_at: "2026-08-02T17:00:00Z",
      }),
      quest(2, "Expired", {
        assignee: "worker",
        status: "accepted",
        lease_expires_at: "2026-08-02T15:00:00Z",
      }),
      quest(3, "Turned in", {
        assignee: "worker",
        status: "turned_in",
        lease_expires_at: "2026-08-02T17:00:00Z",
      }),
    ]);

    expect(result.quests.map((item) => [item.id, item.computed_state])).toEqual([[1, "in_flight"]]);
  });

  test("reports file conflicts and heuristic same-area conflicts separately", () => {
    const result = plan([
      quest(1, "Shared file", { predicted_files: ["src/shared.ts"] }),
      quest(2, "Shared file too", { predicted_files: ["src/shared.ts", "src/two.ts"] }),
      quest(3, "Same area", { predicted_files: [] }),
      quest(4, "Same area too", { predicted_files: [] }),
      quest(5, "Different area", { area: "store" }),
      quest(6, "Other repository", { predicted_files: ["src/shared.ts"], repo: "other" }),
    ]);

    expect(result.lane_clusters).toEqual([
      {
        area: null,
        files: ["src/shared.ts"],
        heuristic: false,
        kind: "shared_files",
        quest_ids: [1, 2],
      },
      {
        area: "cli",
        files: [],
        heuristic: true,
        kind: "same_area",
        quest_ids: [3, 4],
      },
    ]);
  });

  test("orders in-flight work, dispatchable work, and blocked work by chain depth", () => {
    const result = plan(
      [
        quest(1, "Deep blocked", { priority: 1 }),
        quest(2, "Shallow blocked", { priority: 3 }),
        quest(3, "Root", { kind: "bug", status: "open" }),
        quest(4, "Live", {
          assignee: "worker",
          status: "accepted",
          lease_expires_at: "2026-08-02T17:00:00Z",
        }),
        quest(5, "Dispatchable", { priority: 1 }),
        quest(6, "Middle"),
      ],
      [
        { quest_id: 1, target_id: 6, type: "requires" },
        { quest_id: 6, target_id: 3, type: "requires" },
        { quest_id: 2, target_id: 3, type: "requires" },
      ],
    );

    expect(result.quests.map((item) => item.id)).toEqual([4, 5, 3, 6, 2, 1]);
  });
});
