import { describe, expect, test } from "bun:test";

import type { Chain, Quest } from "../schema";
import {
  type NextBacklog,
  type NextSelectionPolicy,
  selectNextQuest,
  strictPriorityThenAgePolicy,
} from "./next";

const now = "2026-08-02T16:00:00Z";

function quest(id: number, title: string, options: Partial<Quest> = {}): Quest {
  return {
    id,
    repo: "quest",
    area: "cli",
    kind: "task",
    title,
    description: "",
    opened_by: "janior",
    assignee: null,
    status: "ready",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
    lease_expires_at: null,
    created_at: "2026-07-29T12:00:00Z",
    updated_at: "2026-07-29T12:00:00Z",
    ...options,
  };
}

function backlog(quests: readonly Quest[], chains: readonly Chain[] = []): NextBacklog {
  return { chains, quests };
}

describe("next selection policy", () => {
  test("selects strict priority before age, then oldest instant and lowest id", () => {
    const quests = [
      quest(1, "Old low priority", {
        priority: 3,
        created_at: "2026-07-01T00:00:00Z",
      }),
      quest(2, "New high priority", {
        priority: 1,
        created_at: "2026-07-29T00:00:00Z",
      }),
      quest(3, "Old high priority", {
        priority: 1,
        created_at: "2026-07-29T01:00:00+02:00",
      }),
      quest(4, "Same age and priority", {
        priority: 1,
        created_at: "2026-07-29T01:00:00+02:00",
      }),
    ];

    expect(strictPriorityThenAgePolicy(quests)?.id).toBe(3);
    expect(selectNextQuest(backlog(quests), { repo: "quest" }).quest?.id).toBe(3);
  });

  test("skips ready quests with incomplete requirements and reports each blocker", () => {
    const quests = [
      quest(1, "Blocked high priority", { priority: 1 }),
      quest(2, "Accepted requirement", {
        assignee: "janior/fable-1",
        status: "accepted",
      }),
      quest(3, "Available", { priority: 2 }),
      quest(4, "Complete requirement", {
        assignee: "janior",
        status: "complete",
      }),
    ];
    const chains: Chain[] = [
      { quest_id: 1, target_id: 2, type: "requires" },
      { quest_id: 3, target_id: 4, type: "requires" },
    ];

    const result = selectNextQuest(backlog(quests, chains), { repo: "quest" });

    expect(result.quest?.id).toBe(3);
    expect(result.warnings).toEqual(["quest 1 skipped: blocked by 2 (accepted by janior/fable-1)"]);
  });

  test("warns on selected predicted-file overlap with live accepted work", () => {
    const quests = [
      quest(1, "Selected", {
        priority: 1,
        predicted_files: ["src/cli/program.ts", "src/services/next.ts"],
      }),
      quest(2, "Accepted overlap", {
        assignee: "janior/codex-2",
        lease_expires_at: "2026-08-02T17:00:00Z",
        status: "accepted",
        predicted_files: ["src/cli/program.ts"],
      }),
      quest(3, "Turned-in overlap", {
        assignee: "janior/codex-3",
        status: "turned_in",
        predicted_files: ["src/services/next.ts"],
      }),
      quest(4, "Complete overlap", {
        assignee: "janior",
        status: "complete",
        predicted_files: ["src/cli/program.ts"],
      }),
      quest(5, "Other repo overlap", {
        assignee: "janior/codex-5",
        repo: "other",
        status: "accepted",
        predicted_files: ["src/cli/program.ts"],
      }),
    ];

    expect(
      selectNextQuest(backlog(quests), { repo: "quest" }, undefined, null, undefined, now).warnings,
    ).toEqual(["quest 1 predicted_files overlap with in-flight quest 2: src/cli/program.ts"]);
  });

  test("selects open bugs and includes them in lane conflict clustering", () => {
    const quests = [
      quest(1, "In flight", {
        assignee: "worker",
        lease_expires_at: "2026-08-02T17:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      }),
      quest(2, "Open bug", {
        kind: "bug",
        predicted_files: ["src/shared.ts"],
        priority: 1,
        status: "open",
      }),
    ];

    const result = selectNextQuest(
      backlog(quests),
      { repo: "quest" },
      undefined,
      null,
      undefined,
      now,
    );

    expect(result.quest?.id).toBe(2);
    expect(result.laneConflicts).toEqual([
      {
        area: null,
        files: ["src/shared.ts"],
        heuristic: false,
        inFlightQuestId: 1,
        kind: "shared_files",
        questId: 2,
      },
    ]);
    expect(result.warnings).toEqual([
      "quest 2 predicted_files overlap with in-flight quest 1: src/shared.ts",
    ]);
  });

  test("skips hard lane conflicts when a conflict-free quest is available", () => {
    const quests = [
      quest(1, "In flight", {
        assignee: "worker",
        lease_expires_at: "2026-08-02T17:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      }),
      quest(2, "Conflicted priority", {
        predicted_files: ["src/shared.ts"],
        priority: 1,
      }),
      quest(3, "Available", { priority: 2 }),
    ];

    const result = selectNextQuest(
      backlog(quests),
      { repo: "quest" },
      undefined,
      null,
      undefined,
      now,
    );

    expect(result.quest?.id).toBe(3);
    expect(result.laneConflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("reports every scoped in-flight quest in a shared-files lane", () => {
    const quests = [
      quest(1, "In flight one", {
        assignee: "worker-one",
        lease_expires_at: "2026-08-02T17:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      }),
      quest(2, "In flight two", {
        assignee: "worker-two",
        lease_expires_at: "2026-08-02T17:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      }),
      quest(3, "Conflicted work", {
        predicted_files: ["src/shared.ts"],
      }),
      quest(4, "Other repository", {
        repo: "other",
        assignee: "other-worker",
        lease_expires_at: "2026-08-02T17:00:00Z",
        predicted_files: ["src/shared.ts"],
        status: "accepted",
      }),
    ];

    const result = selectNextQuest(
      backlog(quests),
      { repo: "quest" },
      undefined,
      null,
      undefined,
      now,
    );

    expect(result.quest?.id).toBe(3);
    expect(result.laneConflicts.map(({ inFlightQuestId }) => inFlightQuestId)).toEqual([1, 2]);
    expect(result.warnings).toEqual([
      "quest 3 predicted_files overlap with in-flight quest 1: src/shared.ts",
      "quest 3 predicted_files overlap with in-flight quest 2: src/shared.ts",
    ]);
  });

  test("keeps global selection lanes isolated by repository", () => {
    const result = selectNextQuest(
      backlog([
        quest(1, "Other repository work", {
          assignee: "other-worker",
          lease_expires_at: "2026-08-02T17:00:00Z",
          predicted_files: ["package.json"],
          repo: "other",
          status: "accepted",
        }),
        quest(2, "Quest repository work", { predicted_files: ["package.json"] }),
      ]),
      { repo: null },
      undefined,
      null,
      undefined,
      now,
    );

    expect(result.quest?.id).toBe(2);
    expect(result.laneConflicts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("warns on soft same-area conflicts without treating them as hard conflicts", () => {
    const quests = [
      quest(1, "In flight", {
        assignee: "worker",
        lease_expires_at: "2026-08-02T17:00:00Z",
        status: "accepted",
      }),
      quest(2, "Available"),
    ];

    const result = selectNextQuest(
      backlog(quests),
      { repo: "quest" },
      undefined,
      null,
      undefined,
      now,
    );

    expect(result.quest?.id).toBe(2);
    expect(result.laneConflicts).toEqual([
      {
        area: "cli",
        files: [],
        heuristic: true,
        inFlightQuestId: 1,
        kind: "same_area",
        questId: 2,
      },
    ]);
    expect(result.warnings).toEqual(["quest 2 shares area cli with in-flight quest 1 (heuristic)"]);
  });

  test("keeps the eligible-quest policy swappable without encoding area weighting", () => {
    const chooseHighestId: NextSelectionPolicy = (quests) => {
      let selected: Quest | null = null;
      for (const candidate of quests) {
        if (selected === null || candidate.id > selected.id) {
          selected = candidate;
        }
      }
      return selected;
    };
    const result = selectNextQuest(
      backlog([quest(1, "First"), quest(2, "Second")]),
      { repo: "quest" },
      chooseHighestId,
    );

    expect(result.quest?.id).toBe(2);
  });

  test("honors repository scope before invoking the policy", () => {
    const result = selectNextQuest(
      backlog([
        quest(1, "Other repository", { priority: 1, repo: "other" }),
        quest(2, "Scoped repository", { priority: 2 }),
      ]),
      { repo: "quest" },
    );

    expect(result.quest?.id).toBe(2);
  });

  test("filters guild-scoped quests while keeping untagged work available", () => {
    const quests = [
      quest(1, "Claude work", { guild: "claude", priority: 1 }),
      quest(2, "Codex work", { guild: "codex", priority: 1 }),
      quest(3, "Shared work", { guild: null, priority: 1 }),
    ];

    expect(selectNextQuest(backlog(quests), { repo: "quest" }, undefined, "claude").quest?.id).toBe(
      1,
    );
    expect(selectNextQuest(backlog(quests), { repo: "quest" }, undefined, "codex").quest?.id).toBe(
      2,
    );
    expect(selectNextQuest(backlog(quests), { repo: "quest" }).quest?.id).toBe(3);
  });

  test("does not expose tagged work to an undeclared session", () => {
    const result = selectNextQuest(backlog([quest(1, "Guild-only work", { guild: "claude" })]), {
      repo: "quest",
    });

    expect(result.quest).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test("leaves repeatedly reopened work for human review", () => {
    const result = selectNextQuest(
      backlog([
        quest(1, "Needs a human", { priority: 1, reopen_count: 2 }),
        quest(2, "Safe to dispatch", { priority: 2, reopen_count: 1 }),
      ]),
      { repo: "quest" },
      undefined,
      null,
      2,
    );

    expect(result.quest?.id).toBe(2);
    expect(result.warnings).toEqual(["quest 1 skipped: reopened 2 times; human review required"]);
  });
});
