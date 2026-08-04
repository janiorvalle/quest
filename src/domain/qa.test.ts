import { describe, expect, test } from "bun:test";

import type { Chain, Event, Quest } from "../schema";
import { computeQaQueue, type QaQueueInput } from "./qa";

const first = "2026-08-02T10:00:00Z";

function quest(id: number, title: string, options: Partial<Quest> = {}): Quest {
  return {
    id,
    repo: "quest",
    area: "cli",
    kind: "task",
    title,
    description: title,
    opened_by: "fixture",
    guild: null,
    assignee: null,
    status: "complete",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    predicted_files: [],
    reopen_count: 0,
    lease_expires_at: null,
    created_at: first,
    updated_at: first,
    ...options,
  };
}

function completeEvent(id: number, questId: number, at: string = first): Event {
  return { id, quest_id: questId, at, actor: "agent", action: "complete", detail: {} };
}

function computeTestQaQueue(input: QaQueueInput) {
  return computeQaQueue({ ...input, shell: input.shell ?? "posix" });
}

describe("QA sign-off queue model", () => {
  test("groups chains before shared files and falls back to area", () => {
    const quests = [
      quest(1, "chain one", { area: "store", updated_at: "2026-08-02T10:00:00Z" }),
      quest(2, "chain two", { area: "tui", updated_at: "2026-08-02T10:01:00Z" }),
      quest(3, "chain three", { area: "store", updated_at: "2026-08-02T10:02:00Z" }),
      quest(4, "shared one", {
        area: "cli",
        predicted_files: ["src/shared.ts"],
        updated_at: "2026-08-02T10:03:00Z",
      }),
      quest(5, "shared two", {
        area: "store",
        predicted_files: ["src/shared.ts"],
        updated_at: "2026-08-02T10:04:00Z",
      }),
      quest(6, "standalone", { area: "docs", updated_at: "2026-08-02T10:05:00Z" }),
    ];
    const chains: Chain[] = [
      { quest_id: 1, target_id: 2, type: "requires" },
      { quest_id: 2, target_id: 3, type: "duplicate-of" },
    ];

    const result = computeTestQaQueue({
      chains,
      events: quests.map((candidate, index) => completeEvent(index + 1, candidate.id)),
      quests,
      repository: "quest",
    });

    expect(result.summary).toEqual({ quests: 6, sessions: 3 });
    expect(result.sessions).toMatchObject([
      { group: 1, ids: [1, 2, 3], reason: "chain", why: "chain-connected linked feature" },
      {
        group: 2,
        ids: [4, 5],
        reason: "shared_files",
        why: "shared files: src/shared.ts",
      },
      { group: 3, ids: [6], reason: "area", why: "same area: docs" },
    ]);
    expect(result.sessions[1]?.signoff).toBe("quest --repo 'quest' signoff 4 5");
  });

  test("removes signed work, honors repository scope, and uses actual file signals", () => {
    const quests = [
      quest(1, "signed", { predicted_files: ["src/signed.ts"] }),
      quest(2, "pending", { predicted_files: [] }),
      quest(3, "other repo", { repo: "other", predicted_files: ["src/shared.ts"] }),
      quest(4, "other repo two", { repo: "other", predicted_files: ["src/shared.ts"] }),
    ];
    const events: Event[] = [
      completeEvent(1, 1),
      { id: 2, quest_id: 1, at: first, actor: "qa", action: "signoff", detail: {} },
      completeEvent(3, 2, "2026-08-02T11:00:00Z"),
      completeEvent(4, 3, "2026-08-02T12:00:00Z"),
      completeEvent(5, 4, "2026-08-02T12:01:00Z"),
      {
        id: 6,
        quest_id: 2,
        at: "2026-08-02T11:01:00Z",
        actor: "agent",
        action: "update",
        detail: { actual_files: ["src/actual.ts"] },
      },
    ];

    const result = computeTestQaQueue({ chains: [], events, quests, repository: "quest" });
    expect(result.summary).toEqual({ quests: 1, sessions: 1 });
    expect(result.sessions[0]).toMatchObject({ ids: [2], files: ["src/actual.ts"] });

    const all = computeTestQaQueue({ chains: [], events, quests });
    expect(all.summary).toEqual({ quests: 3, sessions: 2 });
    expect(all.sessions.find((session) => session.repo === "other")?.signoff).toBe(
      "quest --repo 'other' signoff 3 4",
    );
  });

  test("reports an empty queue with rejection guidance", () => {
    const result = computeTestQaQueue({
      chains: [],
      events: [
        completeEvent(1, 1),
        { id: 2, quest_id: 1, at: first, actor: "qa", action: "signoff", detail: {} },
      ],
      quests: [quest(1, "already signed")],
    });
    expect(result.sessions).toEqual([]);
    expect(result.message).toBe("Nothing awaiting sign-off.");
    expect(result.footer).toContain("quest --repo <repo> reopen <id> --notes");
  });

  test("describes only the paths shared by a shared-files session", () => {
    const quests = [
      quest(1, "first", { predicted_files: ["src/common.ts", "src/first.ts"] }),
      quest(2, "second", { predicted_files: ["src/common.ts", "src/second.ts"] }),
    ];

    const result = computeTestQaQueue({ quests, chains: [], events: [] });

    expect(result.sessions[0]).toMatchObject({
      files: ["src/common.ts", "src/first.ts", "src/second.ts"],
      why: "shared files: src/common.ts",
    });
  });

  test("keeps null and literal sentinel areas separate", () => {
    const quests = [
      quest(1, "unlabeled", { area: null }),
      quest(2, "named sentinel", { area: "<none>" }),
    ];

    const result = computeTestQaQueue({ quests, chains: [], events: [] });

    expect(result.summary).toEqual({ quests: 2, sessions: 2 });
    expect(result.sessions.map(({ area }) => area)).toEqual([null, "<none>"]);
  });

  test("uses only file signals from the current lifecycle attempt", () => {
    const quests = [
      quest(1, "retried", { area: "auth" }),
      quest(2, "other auth work", { area: "docs", predicted_files: ["src/auth.ts"] }),
    ];
    const events: Event[] = [
      {
        id: 1,
        quest_id: 1,
        at: first,
        actor: "agent",
        action: "turnin",
        detail: { actual_files: ["src/auth.ts"] },
      },
      completeEvent(2, 1),
      { id: 3, quest_id: 1, at: first, actor: "agent", action: "reopen", detail: {} },
      {
        id: 4,
        quest_id: 1,
        at: first,
        actor: "agent",
        action: "turnin",
        detail: { actual_files: ["docs/help.md"] },
      },
      completeEvent(5, 1),
      completeEvent(6, 2),
    ];

    const result = computeTestQaQueue({ quests, chains: [], events });

    expect(result.summary).toEqual({ quests: 2, sessions: 2 });
    expect(result.sessions.map(({ reason }) => reason)).toEqual(["area", "area"]);
    expect(result.sessions.find(({ ids }) => ids.includes(1))?.files).toEqual(["docs/help.md"]);
  });

  test("keeps pending quests together through signed chain members", () => {
    const quests = [
      quest(1, "first pending", { area: "one" }),
      quest(2, "signed bridge", { area: "bridge" }),
      quest(3, "last pending", { area: "three" }),
    ];
    const events: Event[] = [
      completeEvent(1, 1),
      completeEvent(2, 2),
      { id: 3, quest_id: 2, at: first, actor: "qa", action: "signoff", detail: {} },
      completeEvent(4, 3),
    ];

    const result = computeTestQaQueue({
      chains: [
        { quest_id: 1, target_id: 2, type: "requires" },
        { quest_id: 2, target_id: 3, type: "requires" },
      ],
      events,
      quests,
    });

    expect(result.summary).toEqual({ quests: 2, sessions: 1 });
    expect(result.sessions[0]).toMatchObject({ ids: [1, 3], reason: "chain" });
  });

  test("quotes Windows repository names for copyable commands", () => {
    const result = computeTestQaQueue({
      chains: [],
      events: [],
      quests: [quest(1, "Windows repo", { repo: "team&calc" })],
      shell: "powershell",
    });

    expect(result.sessions[0]?.signoff).toBe("quest --repo 'team&calc' signoff 1");
  });

  test("quotes cmd repository names without treating ampersands as separators", () => {
    const result = computeTestQaQueue({
      chains: [],
      events: [],
      quests: [quest(1, "cmd repo", { repo: "team&calc" })],
      shell: "cmd",
    });

    expect(result.sessions[0]?.signoff).toBe('quest --repo "team&calc" signoff 1');
  });

  test("does not emit an unsafe cmd command for an unrepresentable repository name", () => {
    const result = computeTestQaQueue({
      chains: [],
      events: [],
      quests: [quest(1, "unsafe cmd repo", { repo: 'safe" & calc' })],
      shell: "cmd",
    });

    expect(result.sessions[0]?.signoff).toBe(
      "unavailable for this repository name; use the PowerShell command",
    );
  });

  test("does not emit cmd commands containing control characters", () => {
    const result = computeTestQaQueue({
      chains: [],
      events: [],
      quests: [quest(1, "newline repo", { repo: "safe\ncalc.exe\nrem" })],
      shell: "cmd",
    });

    expect(result.sessions[0]?.signoff).toBe(
      "unavailable for this repository name; use the PowerShell command",
    );
  });
});
