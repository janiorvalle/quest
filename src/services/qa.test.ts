import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewQuest } from "../schema";
import {
  FederatedQuestStore,
  type FederatedStoreSource,
  LocalBlobStore,
  type QuestStore,
  SqliteStore,
} from "../store";
import { BatchHistoryUnavailableError } from "../store/port";
import { getQaQueue } from "./qa";

const now = "2026-08-02T16:00:00Z";

function task(title: string, repo = "quest"): NewQuest {
  return {
    repo,
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
  };
}

function countStoreReads(
  store: QuestStore,
  afterRead?: (method: string) => Promise<void>,
): {
  readonly calls: ReadonlyMap<string, readonly unknown[][]>;
  readonly store: QuestStore;
} {
  const calls = new Map<string, unknown[][]>();
  return {
    calls,
    store: new Proxy(store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function" || typeof property !== "string") {
          return value;
        }
        return async (...args: unknown[]) => {
          const methodCalls = calls.get(property) ?? [];
          methodCalls.push(args);
          calls.set(property, methodCalls);
          const result = await Reflect.apply(value, target, args);
          await afterRead?.(property);
          return result;
        };
      },
    }),
  };
}

describe("QA queue service", () => {
  test("reads a consistent dump without writing derived state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-service-"));
    const store = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      await store.addQuest(task("completed"));
      const before = await store.exportAll();
      const result = await getQaQueue(store, { repo: "quest" }, "posix");
      expect(result.summary).toEqual({ quests: 1, sessions: 1 });
      expect(await store.exportAll()).toEqual(before);
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps repository-qualified sessions safe for federated display IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-federated-"));
    const alphaStore = new SqliteStore(join(directory, "alpha.db"), { now: () => now });
    const betaStore = new SqliteStore(join(directory, "beta.db"), { now: () => now });
    let batchHistoryReads = 0;
    let fullSnapshotReads = 0;
    let listSnapshotReads = 0;
    const source = (repo: string, questStore: SqliteStore): FederatedStoreSource => ({
      blobStore: new LocalBlobStore(join(directory, `${repo}-evidence`)),
      includeRepository: (candidate) => candidate === repo,
      questStore: new Proxy(questStore, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "readBatchHistory" || typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]) => {
            batchHistoryReads += 1;
            return Reflect.apply(value, target, args);
          };
        },
      }),
      readFullSnapshot: async () => {
        fullSnapshotReads += 1;
        return questStore.readFederatedFullSnapshot();
      },
      readSnapshot: () => {
        listSnapshotReads += 1;
        return questStore.readFederatedSnapshot();
      },
    });
    const store = new FederatedQuestStore([source("alpha", alphaStore), source("beta", betaStore)]);
    try {
      await alphaStore.addQuest(task("Alpha completed", "alpha"));
      await alphaStore.addQuest(task("Alpha second", "alpha"));
      await betaStore.addQuest(task("Beta completed", "beta"));
      await betaStore.addQuest(task("Beta second", "beta"));

      const result = await getQaQueue(store, { repo: null }, "posix");

      expect(result.summary).toEqual({ quests: 4, sessions: 2 });
      expect(result.sessions.map(({ signoff }) => signoff).sort()).toEqual([
        "quest --repo 'alpha' signoff 1 2",
        "quest --repo 'beta' signoff 1 2",
      ]);
      expect(batchHistoryReads).toBe(4);
      expect(listSnapshotReads).toBe(10);
      expect(fullSnapshotReads).toBe(0);
    } finally {
      alphaStore.close();
      betaStore.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("reads the list snapshot and events only for completed QA candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-read-count-"));
    const sqlite = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      const completed = await sqlite.addQuest(task("Completed candidate"));
      const noisy = await sqlite.addQuest({ ...task("Noisy open quest"), status: "open" });
      const dump = await sqlite.exportAll();
      await sqlite.replaceAll({
        ...dump,
        events: [
          ...dump.events,
          ...Array.from({ length: 3_000 }, (_, index) => ({
            id: dump.events.length + index + 1,
            quest_id: noisy.id,
            at: now,
            actor: "fixture",
            action: "update" as const,
            detail: { sequence: index + 1 },
          })),
        ],
      });
      const counted = countStoreReads(sqlite);

      const result = await getQaQueue(counted.store, { repo: "quest" }, "posix");

      expect(result.summary).toEqual({ quests: 1, sessions: 1 });
      expect(counted.calls.get("exportAll") ?? []).toHaveLength(0);
      expect(counted.calls.get("readFederatedSnapshot") ?? []).toHaveLength(2);
      expect(counted.calls.get("readBatchHistory")).toEqual([[[completed.id]], [[completed.id]]]);
      expect(counted.calls.get("events") ?? []).toHaveLength(0);
    } finally {
      sqlite.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("bounds each batch history read to 128 completed quests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-batches-"));
    const sqlite = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      for (let index = 0; index < 129; index += 1) {
        await sqlite.addQuest(task(`Completed candidate ${index + 1}`));
      }
      const counted = countStoreReads(sqlite);

      const result = await getQaQueue(counted.store, { repo: "quest" }, "posix");

      expect(result.summary.quests).toBe(129);
      expect(
        (counted.calls.get("readBatchHistory") ?? []).map(([questIds]) =>
          Array.isArray(questIds) ? questIds.length : 0,
        ),
      ).toEqual([128, 1, 128, 1]);
    } finally {
      sqlite.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("ignores open-quest writes while stabilizing a scoped queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-repository-snapshot-"));
    const sqlite = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      await sqlite.addQuest(task("Target candidate", "target"));
      let unrelatedWrites = 0;
      const counted = countStoreReads(sqlite, async (method) => {
        if (method !== "readFederatedSnapshot") {
          return;
        }
        unrelatedWrites += 1;
        await sqlite.addQuest({
          ...task(`Open write ${unrelatedWrites}`, "target"),
          status: "open",
        });
      });

      const result = await getQaQueue(counted.store, { repo: "target" }, "posix");

      expect(result.summary).toEqual({ quests: 1, sessions: 1 });
      expect(unrelatedWrites).toBe(2);
    } finally {
      sqlite.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps completed candidates together through an open connector quest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-chain-connector-"));
    const sqlite = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      const first = await sqlite.addQuest(task("First completed"));
      const connector = await sqlite.addQuest({ ...task("Open connector"), status: "open" });
      const third = await sqlite.addQuest(task("Third completed"));
      const dump = await sqlite.exportAll();
      await sqlite.replaceAll({
        ...dump,
        chains: [
          { quest_id: first.id, target_id: connector.id, type: "requires" },
          { quest_id: connector.id, target_id: third.id, type: "requires" },
        ],
      });

      const result = await getQaQueue(sqlite, { repo: "quest" }, "posix");

      expect(result.summary).toEqual({ quests: 2, sessions: 1 });
      expect(result.sessions[0]).toMatchObject({
        ids: [first.id, third.id],
        reason: "chain",
      });
    } finally {
      sqlite.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("retries when a batch sign-off lands between candidate reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-qa-consistency-"));
    const sqlite = new SqliteStore(join(directory, "quest.db"), { now: () => now });
    try {
      const first = await sqlite.addQuest(task("First candidate"));
      const second = await sqlite.addQuest(task("Second candidate"));
      let signedOff = false;
      const counted = countStoreReads(sqlite, async (method) => {
        if (method !== "queryEvents" || signedOff) {
          return;
        }
        signedOff = true;
        await sqlite.signoffBatch({
          ids: [first.id, second.id],
          transition: {
            action: "signoff",
            actor: "qa/reviewer",
            notes: "concurrent sign-off",
            session_guild: null,
          },
          evidence: [],
        });
      });
      let unavailableBatchReads = 0;
      const legacyStore = new Proxy(counted.store, {
        get(target, property, receiver) {
          if (property === "readBatchHistory") {
            return async () => {
              unavailableBatchReads += 1;
              throw new BatchHistoryUnavailableError();
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });

      const result = await getQaQueue(legacyStore, { repo: "quest" }, "posix");

      expect(result.message).toBe("Nothing awaiting sign-off.");
      expect(result.summary).toEqual({ quests: 0, sessions: 0 });
      expect(counted.calls.get("readFederatedSnapshot") ?? []).toHaveLength(3);
      expect(unavailableBatchReads).toBe(3);
      expect(counted.calls.get("queryEvents") ?? []).toHaveLength(6);
    } finally {
      sqlite.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
