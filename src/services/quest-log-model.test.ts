import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewQuest, QuestScope } from "../schema";
import { createSqliteStore } from "../store";
import {
  createQuestLogRuntime,
  type QuestLogSnapshot,
  summarizeEventDetail,
} from "./quest-log-model";

const questInput = (repo: string, title: string): NewQuest => ({
  repo,
  area: "tui",
  kind: "task",
  title,
  description: "A dense viewer quest",
  opened_by: "test",
  assignee: null,
  status: "ready",
  verdict: null,
  verdict_notes: null,
  priority: 2,
  pr: null,
  guild: null,
  predicted_files: ["src/tui/quest-log.tsx"],
  reopen_count: 0,
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for quest log watcher");
    }
    await Bun.sleep(5);
  }
}

function latest(snapshots: readonly QuestLogSnapshot[]): QuestLogSnapshot {
  const snapshot = snapshots[snapshots.length - 1];
  if (snapshot === undefined) {
    throw new Error("quest log did not emit a snapshot");
  }
  return snapshot;
}

describe("read-only quest log runtime", () => {
  test("maps the live watch stream to the selected repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-model-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const scope: QuestScope = { repo: "quest" };
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({ initialScope: scope, store });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    try {
      await runtime.start();
      await store.addQuest(questInput("other", "Outside scope"));
      await store.addQuest(questInput("quest", "Inside scope"));
      await waitFor(
        () =>
          latest(snapshots).loading === false &&
          latest(snapshots).items.some((item) => item.title === "Inside scope"),
      );

      const snapshot = latest(snapshots);
      expect(snapshot.scope).toBe("current");
      expect(snapshot.currentRepo).toBe("quest");
      expect(snapshot.items.map((item) => item.title)).toEqual(["Inside scope"]);
      expect(snapshot.items[0]?.predictedFiles).toEqual(["src/tui/quest-log.tsx"]);
      expect(snapshot.plan).toBeNull();
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("derives PR markers from quest status and local completion events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-pr-state-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({ initialScope: { repo: null }, store });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    try {
      const review = await store.addQuest(questInput("quest", "Awaiting review"));
      await store.acceptQuest({ id: review.id, owner: "worker" });
      await store.transition(review.id, {
        action: "turnin",
        actor: "worker",
        pr: "https://github.com/janiorvalle/quest/pull/101",
      });

      const merged = await store.addQuest(questInput("quest", "Merged PR"));
      await store.acceptQuest({ id: merged.id, owner: "worker" });
      await store.transition(merged.id, {
        action: "turnin",
        actor: "worker",
        pr: "https://github.com/janiorvalle/quest/pull/102",
      });
      await store.transition(merged.id, {
        action: "complete",
        actor: "worker",
        pr_verified_merged: true,
      });

      await store.addQuest({
        ...questInput("quest", "PR on another status"),
        pr: "https://github.com/janiorvalle/quest/pull/103",
      });
      await store.addQuest(questInput("quest", "No PR"));

      await runtime.start();
      await waitFor(
        () => latest(snapshots).loading === false && latest(snapshots).items.length === 4,
      );

      const itemsByTitle = new Map(latest(snapshots).items.map((item) => [item.title, item]));
      expect(itemsByTitle.get("Awaiting review")?.prState).toBe("awaiting-review");
      expect(itemsByTitle.get("Merged PR")?.prState).toBe("merged");
      expect(itemsByTitle.get("PR on another status")?.prState).toBe("quiet");
      expect(itemsByTitle.get("No PR")?.prState).toBeNull();

      await store.transition(merged.id, {
        action: "reopen",
        actor: "worker",
        notes: "retest the merged PR",
      });
      await store.acceptQuest({ id: merged.id, owner: "worker" });
      await store.transition(merged.id, {
        action: "turnin",
        actor: "worker",
        pr: "https://github.com/janiorvalle/quest/pull/104",
      });
      await store.transition(merged.id, {
        action: "complete",
        actor: "worker",
        pr_unverified: true,
      });
      await waitFor(
        () => latest(snapshots).items.find((item) => item.id === merged.id)?.prState === "quiet",
      );
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("uses the shared plan for the default order and keeps the flat stream available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-plan-"));
    const store = createSqliteStore(join(directory, "quest.db"), {
      now: () => "2026-08-02T16:00:00Z",
    });
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      clock: { now: () => Promise.resolve("2026-08-02T16:00:00Z") },
      initialScope: { repo: "quest" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    try {
      const root = await store.addQuest({
        ...questInput("quest", "Root"),
        predicted_files: ["src/root.ts"],
      });
      const dependent = await store.addQuest({
        ...questInput("quest", "Dependent"),
        predicted_files: ["src/dependent.ts"],
      });
      const live = await store.addQuest({
        ...questInput("quest", "Live"),
        assignee: "worker",
        lease_expires_at: "2026-08-02T17:00:00Z",
        predicted_files: ["src/live.ts"],
        status: "accepted",
      });
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: dependent.id, target_id: root.id, type: "requires" },
      });

      await runtime.start();
      await waitFor(
        () =>
          latest(snapshots).loading === false &&
          latest(snapshots).plan !== null &&
          latest(snapshots).plan?.items.some((item) => item.id === dependent.id) === true,
      );

      const snapshot = latest(snapshots);
      expect(snapshot.items.map((item) => item.id)).toEqual([root.id, dependent.id, live.id]);
      expect(snapshot.plan?.items.map((item) => item.id)).toEqual([live.id, root.id, dependent.id]);
      expect(snapshot.items.find((item) => item.id === dependent.id)).toMatchObject({
        blocked: true,
        blockerId: root.id,
        blockerIds: [root.id],
        chainDepth: 1,
        computedState: "blocked",
      });
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("falls back to the flat live stream when a plan refresh fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-plan-refresh-"));
    const store = createSqliteStore(join(directory, "quest.db"), {
      now: () => "2026-08-02T16:00:00Z",
    });
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      clock: { now: () => Promise.resolve("2026-08-02T16:00:00Z") },
      initialScope: { repo: "quest" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    try {
      const root = await store.addQuest({
        ...questInput("quest", "Refresh root"),
        predicted_files: ["src/root.ts"],
      });
      const dependent = await store.addQuest({
        ...questInput("quest", "Refresh dependent"),
        predicted_files: ["src/dep.ts"],
      });
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: dependent.id, target_id: root.id, type: "requires" },
      });
      await runtime.start();
      await waitFor(() => latest(snapshots).loading === false && latest(snapshots).plan !== null);

      const exportAll = store.exportAll.bind(store);
      store.exportAll = async () => {
        throw new Error("fixture plan refresh failed");
      };
      const incoming = await store.addQuest({
        ...questInput("quest", "New live quest"),
        predicted_files: ["src/new.ts"],
      });
      await waitFor(
        () =>
          latest(snapshots).plan === null &&
          latest(snapshots).items.some((item) => item.id === incoming.id),
      );
      expect(latest(snapshots).items.map((item) => item.id)).toContain(incoming.id);
      store.exportAll = exportAll;
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("starts the viewer in flat mode when the initial plan load fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-plan-start-"));
    const store = createSqliteStore(join(directory, "quest.db"), {
      now: () => "2026-08-02T16:00:00Z",
    });
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      clock: { now: () => Promise.resolve("2026-08-02T16:00:00Z") },
      initialScope: { repo: "quest" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
    const exportAll = store.exportAll.bind(store);
    let shouldFail = true;
    store.exportAll = async () => {
      if (shouldFail) {
        throw new Error("fixture initial plan load failed");
      }
      return exportAll();
    };

    try {
      const root = await store.addQuest(questInput("quest", "Initial root"));
      const dependent = await store.addQuest(questInput("quest", "Initial dependent"));
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: dependent.id, target_id: root.id, type: "requires" },
      });

      await runtime.start();
      await waitFor(() => latest(snapshots).loading === false && latest(snapshots).plan === null);
      expect(latest(snapshots).items.map((item) => item.id)).toEqual([root.id, dependent.id]);

      shouldFail = false;
      await store.addQuest(questInput("quest", "Retry plan load"));
      await waitFor(() => latest(snapshots).plan !== null);
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("cycles store-known repositories through the all-repositories scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-scope-cycle-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: "alpha" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    try {
      await store.addQuest(questInput("alpha", "Alpha quest"));
      await runtime.start();
      await waitFor(
        () => latest(snapshots).loading === false && latest(snapshots).items.length === 1,
      );

      await store.addQuest(questInput("beta", "Beta quest"));

      await expect(runtime.cycleScope()).resolves.toEqual({
        currentRepo: "beta",
        scope: "current",
      });
      expect(latest(snapshots).items.map((item) => item.repo)).toEqual(["beta"]);

      await expect(runtime.cycleScope()).resolves.toEqual({ currentRepo: null, scope: "all" });
      expect(latest(snapshots).items.map((item) => item.repo)).toEqual(["alpha", "beta"]);

      await expect(runtime.cycleScope()).resolves.toEqual({
        currentRepo: "alpha",
        scope: "current",
      });
      expect(latest(snapshots).items.map((item) => item.repo)).toEqual(["alpha"]);
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("restores the previous live scope when a rebind fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-scope-rollback-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: "alpha" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
    const watch = store.watch.bind(store);
    let watchCalls = 0;
    store.watch = async (filter, listener) => {
      watchCalls += 1;
      if (watchCalls === 3) {
        throw new Error("scope watch failed");
      }
      return watch(filter, listener);
    };

    try {
      await store.addQuest(questInput("alpha", "Alpha quest"));
      await store.addQuest(questInput("beta", "Beta quest"));
      await runtime.start();
      await waitFor(
        () => latest(snapshots).loading === false && latest(snapshots).items.length === 1,
      );

      await expect(runtime.cycleScope()).rejects.toThrow("scope watch failed");
      expect(latest(snapshots)).toMatchObject({
        currentRepo: "alpha",
        scope: "current",
      });
      expect(latest(snapshots).items.map((item) => item.repo)).toEqual(["alpha"]);
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("loads read-only detail and delegates evidence opening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-detail-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const opened: number[] = [];
    const openedPrs: string[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: null },
      openEvidence: async (id) => {
        opened.push(id);
        return `Opened quest ${id}`;
      },
      openPr: async (url) => {
        openedPrs.push(url);
        return `Opened PR ${url}`;
      },
      store,
    });

    try {
      const quest = await store.addQuest(questInput("quest", "Detail quest"));
      const detail = await runtime.loadDetail(quest.id);
      expect(detail.questId).toBe(quest.id);
      expect(detail.events[0]?.action).toBe("add");
      expect(await runtime.openEvidence(quest.id)).toBe(`Opened quest ${quest.id}`);
      expect(opened).toEqual([quest.id]);
      expect(await runtime.openPr("https://github.com/janiorvalle/quest/pull/52")).toBe(
        "Opened PR https://github.com/janiorvalle/quest/pull/52",
      );
      expect(openedPrs).toEqual(["https://github.com/janiorvalle/quest/pull/52"]);
    } finally {
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("loads the latest accept or turnin session attribution without placeholders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-attribution-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const runtime = createQuestLogRuntime({ initialScope: { repo: null }, store });

    try {
      const quest = await store.addQuest(questInput("quest", "Attribution quest"));
      await store.acceptQuest({
        id: quest.id,
        owner: "worker",
        session_effort: "max",
        session_guild: "claude",
        session_model: "fable-5",
      });

      expect((await runtime.loadDetail(quest.id)).sessionAttribution).toEqual({
        effort: "max",
        guild: "claude",
        model: "fable-5",
      });

      await store.transition(quest.id, {
        action: "turnin",
        actor: "worker",
        pr: null,
        session_guild: "claude",
      });

      expect((await runtime.loadDetail(quest.id)).sessionAttribution).toEqual({
        guild: "claude",
      });
    } finally {
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("propagates evidence opener failures to the viewer boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-evidence-error-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const runtime = createQuestLogRuntime({
      initialScope: { repo: null },
      openEvidence: async () => {
        throw new Error("default app is unavailable");
      },
      store,
    });

    try {
      await expect(runtime.openEvidence(72)).rejects.toThrow("default app is unavailable");
    } finally {
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

test("summarizes event details without leaking object syntax into the viewer", () => {
  expect(summarizeEventDetail(null)).toBeNull();
  expect(summarizeEventDetail("ready")).toBe("ready");
  expect(summarizeEventDetail({ status: { from: "open", to: "ready" }, actor: "janior" })).toBe(
    'status {"from":"open","to":"ready"} · actor janior',
  );
});
