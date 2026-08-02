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
