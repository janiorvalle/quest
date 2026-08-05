import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewQuest, QuestFilter, QuestScope } from "../schema";
import {
  createSqliteStore,
  FederatedQuestStore,
  FederatedReadError,
  type FederatedStoreSource,
  LocalBlobStore,
  type QuestWatchListener,
  type SqliteStore,
} from "../store";
import {
  buildQuestLogSignoffLens,
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
  test("builds the sign-off lens from shared QA sessions and signed history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-signoff-"));
    const store = createSqliteStore(join(directory, "quest.db"), {
      now: () => "2026-08-02T16:00:00Z",
    });
    const completed = async (title: string, area: string, predictedFiles: readonly string[] = []) =>
      store.addQuest({
        ...questInput("quest", title),
        area,
        backfill: true,
        predicted_files: [...predictedFiles],
        status: "complete",
      });

    try {
      const chainOne = await completed("Chain one", "store");
      const chainTwo = await completed("Chain two", "tui");
      const chainThree = await completed("Chain three", "store");
      await completed("Shared one", "cli", ["src/shared.ts"]);
      await completed("Shared two", "docs", ["src/shared.ts"]);
      await completed("Standalone", "docs");
      const signed = await completed("Signed history", "docs");
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: chainTwo.id, target_id: chainOne.id, type: "requires" },
      });
      await store.addChainLink({
        actor: "fixture",
        link: { quest_id: chainThree.id, target_id: chainTwo.id, type: "duplicate-of" },
      });
      await store.transition(signed.id, {
        action: "signoff",
        actor: "qa/reviewer",
        notes: "checked",
        session_guild: null,
      });

      const lens = buildQuestLogSignoffLens(await store.exportAll(), "quest");

      expect(lens.awaitingCount).toBe(6);
      expect(lens.groups.map((group) => group.label)).toEqual([
        "chained 1-2-3",
        "shared files: src/shared.ts",
        "same area: docs",
      ]);
      expect(
        lens.groups.flatMap((group) => group.items).every((item) => item.status === "complete"),
      ).toBe(true);
      expect(lens.signed).toMatchObject([
        {
          item: { title: "Signed history" },
          signer: "qa/reviewer",
          signedAt: "2026-08-02T16:00:00Z",
        },
      ]);
      expect(lens.signedCount).toBe(1);
      expect(lens.emptyMessage).toBeNull();
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("loads all-repository sign-off data through scoped federated exports", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-federated-signoff-"));
    const alphaStore = createSqliteStore(join(directory, "alpha.db"), {
      now: () => "2026-08-02T16:00:00Z",
    });
    const betaStore = createSqliteStore(join(directory, "beta.db"), {
      now: () => "2026-08-02T16:01:00Z",
    });
    const source = (repository: string, store: SqliteStore): FederatedStoreSource => ({
      blobStore: new LocalBlobStore(join(directory, `${repository}-evidence`)),
      includeRepository: (candidate) => candidate === repository,
      questStore: store,
    });
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: null },
      store: new FederatedQuestStore([source("alpha", alphaStore), source("beta", betaStore)]),
    });

    try {
      await alphaStore.addQuest({
        ...questInput("alpha", "Alpha complete"),
        backfill: true,
        status: "complete",
      });
      await betaStore.addQuest({
        ...questInput("beta", "Beta complete"),
        backfill: true,
        status: "complete",
      });
      runtime.subscribe((snapshot) => snapshots.push(snapshot));
      await runtime.start();
      await waitFor(() => latest(snapshots).signoff.awaitingCount === 2);
      expect(latest(snapshots).signoff.groups.map((group) => group.repo)).toEqual([
        "alpha",
        "beta",
      ]);
    } finally {
      await runtime.stop();
      alphaStore.close();
      betaStore.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("refreshes the sign-off lens after an event-only sign-off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-signoff-refresh-"));
    const store = createSqliteStore(join(directory, "quest.db"), {
      now: () => "2026-08-02T16:00:00Z",
    });
    const completed = await store.addQuest({
      ...questInput("quest", "Refresh me"),
      backfill: true,
      status: "complete",
    });
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: "quest" },
      pollIntervalMs: 1_000,
      store,
    });

    try {
      runtime.subscribe((snapshot) => snapshots.push(snapshot));
      await runtime.start();
      await waitFor(() => latest(snapshots).signoff.awaitingCount === 1);
      runtime.setSignoffActive(true);
      await store.transition(completed.id, {
        action: "signoff",
        actor: "qa/reviewer",
        notes: "checked",
        session_guild: null,
      });
      await waitFor(() => latest(snapshots).signoff.signedCount === 1);
      expect(latest(snapshots).signoff.awaitingCount).toBe(0);
    } finally {
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

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
      const openBug = await store.addQuest({
        ...questInput("quest", "Open bug"),
        backfill: true,
        kind: "bug",
        status: "open",
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
      expect(snapshot.items.map((item) => item.id)).toEqual([
        root.id,
        dependent.id,
        live.id,
        openBug.id,
      ]);
      expect(snapshot.plan?.items.map((item) => item.id)).toEqual([
        live.id,
        root.id,
        openBug.id,
        dependent.id,
      ]);
      expect(snapshot.plan?.items.find((item) => item.id === openBug.id)).toMatchObject({
        computedState: "dispatchable",
        status: "open",
      });
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

  test("paints a cached scope before a delayed live watch finishes rebinding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-stale-scope-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    await store.addQuest(questInput("alpha", "Alpha quest"));
    await store.addQuest(questInput("beta", "Beta quest"));
    const watch = store.watch.bind(store);
    let delayWatchRegistration = false;
    let releaseDelayedWatches = (): void => undefined;
    const delayedWatches = new Promise<void>((resolve) => {
      releaseDelayedWatches = resolve;
    });
    store.watch = async (filter, listener) => {
      if (delayWatchRegistration) {
        await delayedWatches;
      }
      return watch(filter, listener);
    };
    const snapshots: Array<{ readonly at: number; readonly value: QuestLogSnapshot }> = [];
    const runtime = createQuestLogRuntime({ initialScope: { repo: "alpha" }, store });
    const unsubscribe = runtime.subscribe((value) =>
      snapshots.push({ at: performance.now(), value }),
    );

    try {
      await runtime.start();
      delayWatchRegistration = true;
      const startedAt = performance.now();
      let refreshFinished = false;
      const switching = runtime.cycleScope().then((selection) => {
        refreshFinished = true;
        return selection;
      });
      await waitFor(() =>
        snapshots.some(
          ({ at, value }) => at >= startedAt && value.currentRepo === "beta" && value.refreshing,
        ),
      );
      const stalePaint = snapshots.find(
        ({ at, value }) => at >= startedAt && value.currentRepo === "beta" && value.refreshing,
      );

      expect((stalePaint?.at ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(100);
      expect(stalePaint?.value.items.map((item) => item.repo)).toEqual(["beta"]);
      expect(refreshFinished).toBeFalse();
      releaseDelayedWatches();
      await expect(switching).resolves.toEqual({ currentRepo: "beta", scope: "current" });
      expect(latest(snapshots.map(({ value }) => value)).refreshing).toBeFalse();
    } finally {
      releaseDelayedWatches();
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
    let lateSubscriptionClosed = false;
    let lateSubscriptionCloseAttempts = 0;
    let previousScopeListener: QuestWatchListener | undefined;
    store.watch = async (filter, listener) => {
      watchCalls += 1;
      if (watchCalls === 1) {
        previousScopeListener = listener;
      }
      if (watchCalls === 4) {
        await Bun.sleep(30);
        throw new Error("scope watch failed");
      }
      if (watchCalls === 5) {
        await Bun.sleep(60);
        const subscription = await watch(filter, listener);
        return {
          unsubscribe: async () => {
            lateSubscriptionCloseAttempts += 1;
            if (lateSubscriptionCloseAttempts === 1) {
              throw new Error("fixture transient unsubscribe failure");
            }
            lateSubscriptionClosed = true;
            await subscription.unsubscribe();
          },
        };
      }
      return watch(filter, listener);
    };

    try {
      const alpha = await store.addQuest(questInput("alpha", "Alpha quest"));
      await store.addQuest(questInput("beta", "Beta quest"));
      await runtime.start();
      await waitFor(
        () => latest(snapshots).loading === false && latest(snapshots).items.length === 1,
      );

      const switching = runtime.cycleScope();
      await Bun.sleep(10);
      await store.addQuest(questInput("alpha", "Alpha arrived during rollback"));
      await store.acceptQuest({ id: alpha.id, owner: "worker" });
      await store.transition(alpha.id, {
        action: "turnin",
        actor: "worker",
        pr: "https://github.com/janiorvalle/quest/pull/254",
      });
      await store.transition(alpha.id, {
        action: "complete",
        actor: "worker",
        pr_verified_merged: true,
      });
      previousScopeListener?.(
        await store.listQuests({ repo: "alpha" }),
        new Error("[CONVEX_REALTIME_WATCH_FAILED] previous scope disconnected; retrying"),
      );
      await expect(switching).rejects.toThrow("scope watch failed");
      expect(latest(snapshots)).toMatchObject({
        currentRepo: "alpha",
        scope: "current",
      });
      expect(latest(snapshots).items.map((item) => item.title)).toEqual([
        "Alpha quest",
        "Alpha arrived during rollback",
      ]);
      expect(latest(snapshots).items.find((item) => item.id === alpha.id)?.prState).toBe("merged");
      expect(latest(snapshots).error).toContain("previous scope disconnected");
      expect(lateSubscriptionCloseAttempts).toBe(1);
      expect(lateSubscriptionClosed).toBeFalse();
      await runtime.stop();
      expect(lateSubscriptionCloseAttempts).toBe(2);
      expect(lateSubscriptionClosed).toBeTrue();
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("preserves missing repositories when an all-scope rollback refresh is partial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-partial-rollback-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    await store.addQuest(questInput("alpha", "Alpha quest"));
    await store.addQuest(questInput("beta", "Beta quest"));
    const watch = store.watch.bind(store);
    const listQuests = store.listQuests.bind(store);
    let watchCalls = 0;
    let rollbackReadsArePartial = false;
    store.watch = async (filter, listener) => {
      watchCalls += 1;
      if (watchCalls === 4) {
        rollbackReadsArePartial = true;
        throw new Error("scope watch failed");
      }
      return watch(filter, listener);
    };
    store.listQuests = async (filter = {}) => {
      const quests = await listQuests(filter);
      return rollbackReadsArePartial && filter.repo === undefined
        ? quests.filter((quest) => quest.repo === "alpha")
        : quests;
    };
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({ initialScope: { repo: null }, store });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    try {
      await runtime.start();
      await expect(runtime.cycleScope()).rejects.toThrow("scope watch failed");
      expect(latest(snapshots)).toMatchObject({ currentRepo: null, scope: "all" });
      expect(
        latest(snapshots)
          .items.map((item) => item.repo)
          .sort(),
      ).toEqual(["alpha", "beta"]);
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("refreshes repository names after discovery registration fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-discovery-retry-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    await store.addQuest(questInput("alpha", "Alpha quest"));
    const watch = store.watch.bind(store);
    let discoveryAttempts = 0;
    store.watch = async (filter, listener) => {
      if (filter.repo === undefined && filter.blocked === undefined) {
        discoveryAttempts += 1;
        if (discoveryAttempts === 1) {
          throw new Error("fixture discovery registration failed");
        }
      }
      return watch(filter, listener);
    };
    const runtime = createQuestLogRuntime({ initialScope: { repo: "alpha" }, store });

    try {
      await runtime.start();
      await store.addQuest(questInput("beta", "Beta quest"));

      await expect(runtime.cycleScope()).resolves.toEqual({
        currentRepo: "beta",
        scope: "current",
      });
      expect(discoveryAttempts).toBe(2);
    } finally {
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps the viewer open with an actionable routed-backend error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-unavailable-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: "remote" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
    store.watch = async () =>
      Promise.reject(
        new FederatedReadError(
          "[FEDERATED_SCOPE_UNAVAILABLE] repository remote backend is unreachable; retry when its deployment is reachable",
        ),
      );

    try {
      await expect(runtime.start()).resolves.toBeUndefined();
      expect(latest(snapshots)).toMatchObject({
        currentRepo: "remote",
        error:
          "[FEDERATED_SCOPE_UNAVAILABLE] repository remote backend is unreachable; retry when its deployment is reachable",
        loading: false,
        scope: "current",
      });
    } finally {
      unsubscribe();
      await runtime.stop();
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps named-scope watches alive through a routed-backend outage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-log-recovery-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const quest = await store.addQuest(questInput("remote", "Recoverable quest"));
    const snapshots: QuestLogSnapshot[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: "remote" },
      store,
    });
    const unsubscribe = runtime.subscribe((snapshot) => snapshots.push(snapshot));
    const watchEntries: Array<{
      readonly filter: QuestFilter;
      readonly listener: QuestWatchListener;
    }> = [];
    store.watch = async (filter, listener) => {
      watchEntries.push({ filter, listener });
      listener(filter.blocked === true ? [] : [quest]);
      return { unsubscribe: async () => undefined };
    };

    try {
      await runtime.start();
      await waitFor(
        () => latest(snapshots).loading === false && latest(snapshots).items.length === 1,
      );
      const mainWatch = watchEntries.find((entry) => entry.filter.blocked !== true);
      const blockedWatch = watchEntries.find((entry) => entry.filter.blocked === true);
      if (mainWatch === undefined || blockedWatch === undefined) {
        throw new Error("quest log did not establish both named-scope watches");
      }

      const outage = new Error(
        "[CONVEX_REALTIME_WATCH_FAILED] the live Convex watch disconnected; retrying automatically",
      );
      mainWatch.listener([], outage);
      blockedWatch.listener([]);
      expect(latest(snapshots)).toMatchObject({
        error: outage.message,
        items: [],
        loading: false,
      });

      mainWatch.listener([quest]);
      expect(latest(snapshots)).toMatchObject({ error: null, items: [{ repo: "remote" }] });
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
    const opened: Array<{ readonly id: number; readonly repository: string | undefined }> = [];
    const openedPrs: string[] = [];
    const runtime = createQuestLogRuntime({
      initialScope: { repo: null },
      openEvidence: async (id, repository) => {
        opened.push({ id, repository });
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
      expect(await runtime.openEvidence(quest.id, "quest")).toBe(`Opened quest ${quest.id}`);
      expect(opened).toEqual([{ id: quest.id, repository: "quest" }]);
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
