import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newQuestSchema } from "../schema";
import type { FederatedStoreSource, QuestStore, WatchSubscription } from ".";
import {
  FederatedBlobStore,
  FederatedQuestStore,
  FederatedReadError,
  LocalBlobStore,
  SqliteStore,
} from ".";

const timestamp = "2026-07-31T12:00:00Z";

function task(repo: string, title: string) {
  return newQuestSchema.parse({
    repo,
    area: "routing",
    kind: "task",
    title,
    description: title,
    opened_by: "test",
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
  });
}

async function createSource(root: string, allowedRepo: string): Promise<FederatedStoreSource> {
  const questStore = new SqliteStore(join(root, `${allowedRepo}.db`), {
    now: () => timestamp,
  });
  return {
    blobStore: new LocalBlobStore(join(root, `${allowedRepo}-evidence`)),
    includeRepository: (repo) => repo === allowedRepo,
    questStore,
  };
}

describe("federated quest reads", () => {
  test("filters and merges per-store list and stats reads while preserving display IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-store-"));
    const alpha = await createSource(root, "alpha");
    const beta = await createSource(root, "beta");
    try {
      await alpha.questStore.addQuest(task("alpha", "Alpha quest"));
      await alpha.questStore.addQuest(task("ignored", "Ignored stale quest"));
      await beta.questStore.addQuest(task("beta", "Beta quest"));

      const store = new FederatedQuestStore([alpha, beta]);
      await expect(store.listQuests({})).resolves.toMatchObject([
        { id: 1, repo: "alpha", title: "Alpha quest" },
        { id: 1, repo: "beta", title: "Beta quest" },
      ]);
      await expect(store.stats({ repo: null })).resolves.toMatchObject({
        repos: [
          { repo: "alpha", total: 1 },
          { repo: "beta", total: 1 },
        ],
      });
      await expect(store.queryEvents({})).resolves.toMatchObject([
        { id: 1, quest_id: 1, repo: "alpha" },
        { id: 1, quest_id: 1, repo: "beta" },
      ]);
      await expect(store.queryEvents({ after_id: 0 })).rejects.toThrow(
        "[UNSUPPORTED_FEDERATED_CURSOR] --after-id is backend-local",
      );
      await expect(store.exportAll()).rejects.toThrow(
        "[AMBIGUOUS_DISPLAY_ID] federated export cannot preserve relationships for quest 1",
      );
      const alphaScope = store.forRepository("alpha");
      await expect(alphaScope.getQuest(1)).resolves.toMatchObject({ repo: "alpha" });
      await expect(alphaScope.exportAll()).resolves.toMatchObject({
        quests: [{ repo: "alpha", title: "Alpha quest" }],
      });
    } finally {
      if (alpha.questStore instanceof SqliteStore) {
        alpha.questStore.close();
      }
      if (beta.questStore instanceof SqliteStore) {
        beta.questStore.close();
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  test("merges per-source quests+chains list snapshots without reading evidence or events", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-list-merge-"));
    const alphaStore = new SqliteStore(join(root, "alpha.db"), { now: () => timestamp });
    const betaStore = new SqliteStore(join(root, "beta.db"), { now: () => timestamp });
    let fullSnapshotReads = 0;
    let exportReads = 0;
    try {
      const alphaRoot = await alphaStore.addQuest(task("alpha", "Alpha root"));
      const alphaDependent = await alphaStore.addQuest(task("alpha", "Alpha dependent"));
      const alphaStale = await alphaStore.addQuest(task("ignored", "Ignored stale quest"));
      await alphaStore.addChainLink({
        actor: "test",
        link: { quest_id: alphaDependent.id, target_id: alphaRoot.id, type: "requires" },
      });
      await alphaStore.addChainLink({
        actor: "test",
        link: { quest_id: alphaStale.id, target_id: alphaRoot.id, type: "requires" },
      });
      for (const filler of ["Skip one", "Skip two", "Skip three"]) {
        await betaStore.addQuest(task("skip", filler));
      }
      const betaQuest = await betaStore.addQuest(task("beta", "Beta quest"));
      const source = (repo: string, questStore: SqliteStore): FederatedStoreSource => ({
        blobStore: new LocalBlobStore(join(root, `${repo}-evidence`)),
        includeRepository: (candidate) => candidate === repo,
        questStore: Object.assign(questStore, {
          exportAll: async () => {
            exportReads += 1;
            return questStore.readFederatedFullSnapshot().then((snapshot) => snapshot.dump);
          },
        }),
        readFullSnapshot: async () => {
          fullSnapshotReads += 1;
          return questStore.readFederatedFullSnapshot();
        },
        readSnapshot: async () => ({
          ...(await questStore.readFederatedSnapshot()),
          fencedRepositories: [`${repo}-fenced`],
        }),
      });
      const store = new FederatedQuestStore([
        source("alpha", alphaStore),
        source("beta", betaStore),
      ]);

      const snapshot = await store.readFederatedSnapshot();

      expect(snapshot.dump.quests.map((quest) => [quest.id, quest.repo])).toEqual([
        [alphaRoot.id, "alpha"],
        [alphaDependent.id, "alpha"],
        [betaQuest.id, "beta"],
      ]);
      expect(snapshot.dump.chains).toEqual([
        { quest_id: alphaDependent.id, target_id: alphaRoot.id, type: "requires" },
      ]);
      expect(snapshot.dump).not.toHaveProperty("events");
      expect(snapshot.dump).not.toHaveProperty("evidence");
      expect(snapshot.fencedRepositories).toEqual(["alpha-fenced", "beta-fenced"]);
      expect(fullSnapshotReads).toBe(0);
      expect(exportReads).toBe(0);
    } finally {
      alphaStore.close();
      betaStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps reactive list snapshots bounded while history and exports stay complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-list-snapshot-"));
    const questStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const baseEvents = questStore.events.bind(questStore);
    const baseExportAll = questStore.exportAll.bind(questStore);
    const baseQueryEvents = questStore.queryEvents.bind(questStore);
    let eventReads = 0;
    let exportReads = 0;
    let fullSnapshotReads = 0;
    const snapshotScopes: Array<string | undefined> = [];

    try {
      await questStore.addQuest(task("remote", "Remote quest"));
      const fullDump = await baseExportAll();
      const listDump = {
        schema_version: fullDump.schema_version,
        quests: fullDump.quests,
        chains: fullDump.chains,
      };
      const countedStore: QuestStore = Object.assign(questStore, {
        events: async (questId: number) => {
          eventReads += 1;
          return baseEvents(questId);
        },
        exportAll: async () => {
          exportReads += 1;
          return baseExportAll();
        },
        queryEvents: async (filter: Parameters<QuestStore["queryEvents"]>[0]) => {
          eventReads += 1;
          return baseQueryEvents(filter);
        },
      });
      const source: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "remote-evidence")),
        includeRepository: (repo) => repo === "remote",
        questStore: countedStore,
        readFullSnapshot: async () => {
          fullSnapshotReads += 1;
          return { dump: fullDump, fencedRepositories: [] };
        },
        readSnapshot: async (repository) => {
          snapshotScopes.push(repository);
          return { dump: listDump, fencedRepositories: [] };
        },
      };
      const scopedStore = new FederatedQuestStore([source]).forRepository("remote");

      await expect(scopedStore.listQuests({})).resolves.toMatchObject([{ repo: "remote" }]);
      await expect(scopedStore.events(1)).resolves.toHaveLength(fullDump.events.length);
      await expect(scopedStore.queryEvents({})).resolves.toHaveLength(fullDump.events.length);
      await expect(scopedStore.exportAll()).resolves.toMatchObject({
        chains: fullDump.chains,
        events: [{ ...fullDump.events[0], repo: "remote" }],
        evidence: fullDump.evidence,
        quests: fullDump.quests,
      });

      expect(listDump).not.toHaveProperty("events");
      expect(listDump).not.toHaveProperty("evidence");
      expect(snapshotScopes).toEqual(["remote", "remote"]);
      expect(eventReads).toBe(0);
      expect(exportReads).toBe(0);
      expect(fullSnapshotReads).toBe(3);
    } finally {
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects history and exports when routing changes during the atomic read", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-full-snapshot-race-"));
    const questStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    let routingStale = false;
    const staleError = new FederatedReadError(
      "[FEDERATED_ROUTING_STALE] repository routing changed during the read; retry with a fresh store",
    );

    try {
      await questStore.addQuest(task("remote", "Remote quest"));
      const dump = await questStore.exportAll();
      const source: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "remote-evidence")),
        includeRepository: (repo) => repo === "remote",
        questStore,
        readError: () => (routingStale ? staleError : undefined),
        readFullSnapshot: async () => {
          routingStale = true;
          return { dump, fencedRepositories: ["remote"] };
        },
        readSnapshot: async () => ({
          dump: {
            schema_version: dump.schema_version,
            quests: dump.quests,
            chains: dump.chains,
          },
          fencedRepositories: [],
        }),
      };
      const scopedStore = new FederatedQuestStore([source]).forRepository("remote");

      await expect(scopedStore.events(1)).rejects.toThrow(staleError.message);
      routingStale = false;
      await expect(scopedStore.queryEvents({ quest_id: 1 })).rejects.toThrow(staleError.message);
      routingStale = false;
      await expect(scopedStore.exportAll()).rejects.toThrow(staleError.message);
    } finally {
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps healthy full snapshots in unscoped partial-read mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-full-snapshot-partial-"));
    const healthyStore = new SqliteStore(join(root, "healthy.db"), { now: () => timestamp });
    const failedStore = new SqliteStore(join(root, "failed.db"), { now: () => timestamp });

    try {
      await healthyStore.addQuest(task("healthy", "Healthy quest"));
      const healthyDump = await healthyStore.exportAll();
      const emptyDump = await failedStore.exportAll();
      const listSnapshot = (dump: typeof healthyDump) => ({
        dump: {
          schema_version: dump.schema_version,
          quests: dump.quests,
          chains: dump.chains,
        },
        fencedRepositories: [],
      });
      const healthySource: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "healthy-evidence")),
        includeRepository: (repo) => repo === "healthy",
        questStore: healthyStore,
        readFullSnapshot: async () => ({ dump: healthyDump, fencedRepositories: [] }),
        readSnapshot: async () => listSnapshot(healthyDump),
      };
      const failedSource: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "failed-evidence")),
        includeRepository: (repo) => repo === "failed",
        questStore: failedStore,
        readFullSnapshot: async () => {
          throw new Error("failed backend is offline");
        },
        readSnapshot: async () => listSnapshot(emptyDump),
      };
      const store = new FederatedQuestStore([healthySource, failedSource], undefined, {
        allowPartialReads: true,
      });

      await expect(store.queryEvents({})).resolves.toMatchObject([{ repo: "healthy" }]);
      await expect(store.exportAll()).resolves.toMatchObject({ quests: [{ repo: "healthy" }] });
      await expect(store.forRepository("failed").exportAll()).rejects.toThrow(
        "[FEDERATED_SCOPE_UNAVAILABLE] repository failed stopped responding",
      );
    } finally {
      healthyStore.close();
      failedStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("requires an explicit repository for ambiguous IDs and rejects writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-guard-"));
    const alpha = await createSource(root, "alpha");
    const beta = await createSource(root, "beta");
    try {
      await alpha.questStore.addQuest(task("alpha", "Alpha quest"));
      await beta.questStore.addQuest(task("beta", "Beta quest"));
      const store = new FederatedQuestStore([alpha, beta]);

      await expect(store.getQuest(1)).rejects.toThrow(
        "[AMBIGUOUS_DISPLAY_ID] quest 1 exists in multiple backends",
      );
      await expect(store.events(1)).rejects.toThrow(
        "[AMBIGUOUS_DISPLAY_ID] quest 1 exists in multiple backends",
      );
      await expect(store.queryEvents({ quest_id: 1 })).rejects.toThrow(
        "[AMBIGUOUS_DISPLAY_ID] quest 1 exists in multiple backends",
      );
      await expect(
        store.acceptQuest({ id: 1, owner: "test", session_guild: null }),
      ).rejects.toThrow("[FEDERATED_READ_ONLY] --all is a read-only scope");
    } finally {
      if (alpha.questStore instanceof SqliteStore) {
        alpha.questStore.close();
      }
      if (beta.questStore instanceof SqliteStore) {
        beta.questStore.close();
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps the owning backend's relational rows available to a repository scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-owner-scope-"));
    const questStore = new SqliteStore(join(root, "owner.db"), { now: () => timestamp });
    const source: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "owner-evidence")),
      includeRepository: (repo) => repo === "alpha" || repo === "beta",
      questStore,
    };

    try {
      const alpha = await questStore.addQuest(task("alpha", "Alpha root"));
      const beta = await questStore.addQuest(task("beta", "Beta dependency"));
      await questStore.addChainLink({
        actor: "test",
        link: { quest_id: alpha.id, target_id: beta.id, type: "requires" },
      });

      const alphaScope = new FederatedQuestStore([source]).forRepository("alpha");
      await expect(alphaScope.getQuest(beta.id)).resolves.toBeNull();
      await expect(alphaScope.listQuests({})).resolves.toMatchObject([
        { repo: "alpha", title: "Alpha root" },
      ]);
      await expect(alphaScope.stats({ repo: null })).resolves.toMatchObject({
        repos: [{ repo: "alpha", total: 1 }],
      });
      const scopedEvents = await alphaScope.queryEvents({});
      expect(scopedEvents.every((event) => "repo" in event && event.repo === "alpha")).toBeTrue();
      await expect(alphaScope.exportAll()).resolves.toMatchObject({
        quests: [
          { repo: "alpha", title: "Alpha root" },
          { repo: "beta", title: "Beta dependency" },
        ],
      });
      const snapshots: Array<readonly { readonly repo: string }[]> = [];
      const subscription = await alphaScope.watch({}, (quests) => snapshots.push(quests));
      await subscription.unsubscribe();
      expect(snapshots.at(-1)).toMatchObject([{ repo: "alpha" }]);
    } finally {
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("returns an actionable error for an unavailable named backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-unavailable-"));
    const store = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const source: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "remote-evidence")),
      includeRepository: (repo) => repo === "remote",
      questStore: store,
      readError: (repository) =>
        new FederatedReadError(
          `[FEDERATED_SCOPE_UNAVAILABLE] repository ${repository ?? "remote"} backend is unreachable; retry when its deployment is reachable`,
        ),
    };

    try {
      const federated = new FederatedQuestStore([source]);
      await expect(federated.listQuests({ repo: "remote" })).rejects.toThrow(
        "[FEDERATED_SCOPE_UNAVAILABLE] repository remote backend is unreachable",
      );
      await expect(federated.stats({ repo: "remote" })).rejects.toThrow(
        "retry when its deployment is reachable",
      );
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("routes federated blob reads through the owning repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-blobs-"));
    const alpha = await createSource(root, "alpha");
    const beta = await createSource(root, "beta");
    try {
      const alphaBytes = new TextEncoder().encode("alpha evidence");
      const alphaHash = await alpha.blobStore.put(alphaBytes);
      const store = new FederatedBlobStore([alpha, beta]);

      await expect(store.get(alphaHash, "alpha")).resolves.toEqual(alphaBytes);
      await expect(store.get(alphaHash, "beta")).resolves.toBeNull();
      await expect(store.get(alphaHash)).rejects.toThrow(
        "[FEDERATED_BLOB_REPOSITORY_REQUIRED] evidence retrieval needs a repository",
      );
    } finally {
      if (alpha.questStore instanceof SqliteStore) {
        alpha.questStore.close();
      }
      if (beta.questStore instanceof SqliteStore) {
        beta.questStore.close();
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  test("excludes fenced repositories from federated blob reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-fenced-blobs-"));
    const questStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    let fenced = false;
    const source: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "remote-evidence")),
      includeRepository: (repo) => repo === "remote" && !fenced,
      questStore,
      routesRepository: (repo) => repo === "remote",
    };

    try {
      const hash = await source.blobStore.put(new TextEncoder().encode("stale evidence"));
      fenced = true;
      const store = new FederatedBlobStore([source]);

      await expect(store.get(hash, "remote")).resolves.toBeNull();
      await expect(store.has(hash, "remote")).resolves.toBeFalse();
    } finally {
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("refreshes migration fences while a federated watch is open", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-watch-fence-"));
    const questStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    let refreshCount = 0;
    let fenced = false;
    const source: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "remote-evidence")),
      includeRepository: (repo) => repo === "remote" && !fenced,
      questStore,
      refresh: async () => {
        refreshCount += 1;
        fenced = refreshCount >= 3;
      },
    };

    try {
      await questStore.addQuest(task("remote", "Remote quest"));
      const snapshots: (readonly ReturnType<typeof task>[])[] = [];
      const federated = new FederatedQuestStore([source]);
      const subscription = await federated.watch({}, (quests) => {
        snapshots.push(quests);
      });
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      await subscription.unsubscribe();

      expect(refreshCount).toBeGreaterThanOrEqual(3);
      expect(snapshots.some((snapshot) => snapshot.length === 1)).toBeTrue();
      expect(snapshots.at(-1)).toEqual([]);
    } finally {
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not poll a source that exposes a reactive federated snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-reactive-watch-"));
    const questStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    let snapshotReads = 0;
    let unsubscribed = false;
    let subscription: WatchSubscription | undefined;
    try {
      await questStore.addQuest(task("remote", "Remote quest"));
      const snapshot = { dump: await questStore.exportAll(), fencedRepositories: [] };
      const reactiveQuestStore = Object.assign(questStore, {
        watchFederatedSnapshot: async (
          _repository: string | undefined,
          listener: Parameters<
            NonNullable<FederatedStoreSource["questStore"]["watchFederatedSnapshot"]>
          >[1],
        ) => {
          listener(snapshot);
          return {
            unsubscribe: async () => {
              unsubscribed = true;
            },
          };
        },
      });
      const source: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "remote-evidence")),
        includeRepository: (repo) => repo === "remote",
        questStore: reactiveQuestStore,
        readSnapshot: async () => {
          snapshotReads += 1;
          return snapshot;
        },
      };
      const emissions: unknown[] = [];
      subscription = await new FederatedQuestStore([source]).watch({}, (quests) =>
        emissions.push(quests),
      );

      await Bun.sleep(1_250);
      expect(snapshotReads).toBe(1);
      expect(emissions.at(-1)).toMatchObject([{ repo: "remote" }]);
      await subscription.unsubscribe();
      subscription = undefined;
      expect(unsubscribed).toBeTrue();
    } finally {
      await subscription?.unsubscribe();
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("polls a non-reactive snapshot source for fence-only changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-snapshot-poll-"));
    const questStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    let snapshotReads = 0;
    let subscription: WatchSubscription | undefined;
    try {
      await questStore.addQuest(task("remote", "Remote quest"));
      const dump = await questStore.exportAll();
      const source: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "remote-evidence")),
        includeRepository: (repo) => repo === "remote",
        questStore,
        readSnapshot: async () => {
          snapshotReads += 1;
          return {
            dump,
            fencedRepositories: snapshotReads >= 3 ? ["remote"] : [],
          };
        },
      };
      const emissions: (readonly ReturnType<typeof task>[])[] = [];
      subscription = await new FederatedQuestStore([source]).watch({}, (quests) =>
        emissions.push(quests),
      );

      await Bun.sleep(1_100);
      expect(snapshotReads).toBeGreaterThanOrEqual(3);
      expect(emissions.at(-1)).toEqual([]);
    } finally {
      await subscription?.unsubscribe();
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves an unavailable reactive source error while recovery is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-reactive-recovery-"));
    const remoteStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const localStore = new SqliteStore(join(root, "local.db"), { now: () => timestamp });
    const outage = new FederatedReadError(
      "[FEDERATED_SCOPE_UNAVAILABLE] remote is unavailable; retry when its deployment is reachable",
    );
    let refreshCount = 0;
    const remoteSource: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "remote-evidence")),
      includeRepository: (repo) => repo === "remote",
      needsWatchPolling: () => false,
      questStore: remoteStore,
      readError: () => outage,
      refresh: async () => {
        refreshCount += 1;
      },
      watchSnapshot: async () => ({ unsubscribe: async () => undefined }),
    };
    const localSource: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "local-evidence")),
      includeRepository: (repo) => repo === "local",
      questStore: localStore,
    };
    let subscription: WatchSubscription | undefined;

    try {
      await localStore.addQuest(task("local", "Local quest"));
      const emissions: Array<{
        readonly error: Error | undefined;
        readonly repos: readonly string[];
      }> = [];
      subscription = await new FederatedQuestStore([remoteSource, localSource], undefined, {
        allowPartialReads: true,
      }).watch({}, (quests, error) => {
        emissions.push({ error, repos: quests.map((quest) => quest.repo) });
      });

      await Bun.sleep(1_250);
      expect(refreshCount).toBe(2);
      expect(emissions.at(-1)).toEqual({ error: outage, repos: ["local"] });
    } finally {
      await subscription?.unsubscribe();
      remoteStore.close();
      localStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("retries an initially failed reactive source without closing healthy peers", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-reactive-retry-"));
    const remoteStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const localStore = new SqliteStore(join(root, "local.db"), { now: () => timestamp });
    let watchAttempts = 0;
    let subscription: WatchSubscription | undefined;

    try {
      await remoteStore.addQuest(task("remote", "Remote quest"));
      await localStore.addQuest(task("local", "Local quest"));
      const remoteSnapshot = { dump: await remoteStore.exportAll(), fencedRepositories: [] };
      const reactiveRemoteStore = Object.assign(remoteStore, {
        watchFederatedSnapshot: async (
          _repository: string | undefined,
          listener: Parameters<
            NonNullable<FederatedStoreSource["questStore"]["watchFederatedSnapshot"]>
          >[1],
        ) => {
          watchAttempts += 1;
          if (watchAttempts === 1) {
            throw new Error("remote reactive registration failed");
          }
          listener(remoteSnapshot);
          return { unsubscribe: async () => undefined };
        },
      });
      const remoteSource: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "remote-evidence")),
        includeRepository: (repo) => repo === "remote",
        questStore: reactiveRemoteStore,
        readSnapshot: async () => {
          throw new Error("remote initial snapshot failed");
        },
      };
      const localSource: FederatedStoreSource = {
        blobStore: new LocalBlobStore(join(root, "local-evidence")),
        includeRepository: (repo) => repo === "local",
        questStore: localStore,
      };
      const emissions: Array<{
        readonly error: Error | undefined;
        readonly repos: readonly string[];
      }> = [];
      subscription = await new FederatedQuestStore([remoteSource, localSource], undefined, {
        allowPartialReads: true,
      }).watch({}, (quests, error) => {
        emissions.push({ error, repos: quests.map((quest) => quest.repo).sort() });
      });

      expect(emissions.at(-1)?.repos).toEqual(["local"]);
      await Bun.sleep(1_100);
      expect(watchAttempts).toBe(2);
      expect(emissions.at(-1)).toEqual({ error: undefined, repos: ["local", "remote"] });
    } finally {
      await subscription?.unsubscribe();
      remoteStore.close();
      localStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps polling an unavailable source until its own recovery completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-recovery-poll-"));
    const questStore = new SqliteStore(join(root, "fallback.db"), { now: () => timestamp });
    let refreshCount = 0;
    let needsRecovery = true;
    const reactiveQuestStore = Object.assign(questStore, {
      watchFederatedSnapshot: async () => ({ unsubscribe: async () => undefined }),
    });
    const source: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "fallback-evidence")),
      includeRepository: () => true,
      needsWatchPolling: () => needsRecovery,
      questStore: reactiveQuestStore,
      refresh: async () => {
        refreshCount += 1;
        if (refreshCount >= 2) {
          needsRecovery = false;
        }
      },
    };
    let subscription: WatchSubscription | undefined;

    try {
      subscription = await new FederatedQuestStore([source]).watch({}, () => undefined);
      await Bun.sleep(2_250);
      expect(refreshCount).toBe(3);
    } finally {
      await subscription?.unsubscribe();
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("paints a healthy source without waiting for a slow federated peer", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-progressive-watch-"));
    const remoteStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const localStore = new SqliteStore(join(root, "local.db"), { now: () => timestamp });
    let subscription: WatchSubscription | undefined;
    try {
      await localStore.addQuest(task("local", "Local quest"));
      const remoteSnapshot = { dump: await remoteStore.exportAll(), fencedRepositories: [] };
      const sources: FederatedStoreSource[] = [
        {
          blobStore: new LocalBlobStore(join(root, "remote-evidence")),
          includeRepository: (repo) => repo === "remote",
          questStore: remoteStore,
          readSnapshot: async () => {
            await Bun.sleep(300);
            return remoteSnapshot;
          },
        },
        {
          blobStore: new LocalBlobStore(join(root, "local-evidence")),
          includeRepository: (repo) => repo === "local",
          questStore: localStore,
        },
      ];
      const emissions: Array<{ readonly at: number; readonly repos: readonly string[] }> = [];
      const startedAt = performance.now();
      const opening = new FederatedQuestStore(sources, undefined, {
        allowPartialReads: true,
      }).watch({}, (quests) => {
        emissions.push({ at: performance.now(), repos: quests.map((quest) => quest.repo) });
      });
      while (!emissions.some((emission) => emission.repos.includes("local"))) {
        await Bun.sleep(2);
      }
      const localPaint = emissions.find((emission) => emission.repos.includes("local"));

      subscription = await opening;
      expect((localPaint?.at ?? Number.POSITIVE_INFINITY) - startedAt).toBeLessThan(100);
    } finally {
      await subscription?.unsubscribe();
      remoteStore.close();
      localStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not keep stale rows when a partial federated watch loses a backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-watch-outage-"));
    const remoteStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const localStore = new SqliteStore(join(root, "local.db"), { now: () => timestamp });
    let refreshCount = 0;
    const remoteSource: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "remote-evidence")),
      includeRepository: (repo) => repo === "remote",
      questStore: remoteStore,
      refresh: async () => {
        refreshCount += 1;
        if (refreshCount >= 3) {
          throw new Error("remote backend stopped responding");
        }
      },
    };
    const localSource: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "local-evidence")),
      includeRepository: (repo) => repo === "local",
      questStore: localStore,
      refresh: async () => undefined,
    };

    try {
      await remoteStore.addQuest(task("remote", "Remote quest"));
      const snapshots: (readonly ReturnType<typeof task>[])[] = [];
      const errors: Error[] = [];
      const federated = new FederatedQuestStore([remoteSource, localSource], undefined, {
        allowPartialReads: true,
      });
      const subscription = await federated.watch({}, (quests, error) => {
        snapshots.push(quests);
        if (error !== undefined) {
          errors.push(error);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 1_250));
      await subscription.unsubscribe();

      expect(snapshots.at(-1)).toEqual([]);
      expect(errors.at(-1)).toBeInstanceOf(FederatedReadError);
      expect(errors.at(-1)?.message).toContain("retry when its deployment is reachable");
    } finally {
      remoteStore.close();
      localStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not register a live watch for a snapshot source that failed its initial read", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-watch-snapshot-outage-"));
    const remoteStore = new SqliteStore(join(root, "remote.db"), { now: () => timestamp });
    const localStore = new SqliteStore(join(root, "local.db"), { now: () => timestamp });
    let remoteWatchCalled = false;
    remoteStore.watch = async () => {
      remoteWatchCalled = true;
      return Promise.reject(new Error("remote watch should not be registered"));
    };
    const remoteSource: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "remote-evidence")),
      includeRepository: (repo) => repo === "remote",
      questStore: remoteStore,
      readSnapshot: async () =>
        Promise.reject(
          new Error(
            "[FEDERATED_SNAPSHOT_QUERY_UNAVAILABLE] deploy the current Quest backend before federated reads",
          ),
        ),
    };
    const localSource: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "local-evidence")),
      includeRepository: (repo) => repo === "local",
      questStore: localStore,
    };

    try {
      await localStore.addQuest(task("local", "Local quest"));
      const snapshots: (readonly ReturnType<typeof task>[])[] = [];
      const errors: Error[] = [];
      const federated = new FederatedQuestStore([remoteSource, localSource], undefined, {
        allowPartialReads: true,
      });
      const subscription = await federated.watch({}, (quests, error) => {
        snapshots.push(quests);
        if (error !== undefined) {
          errors.push(error);
        }
      });
      await subscription.unsubscribe();

      expect(remoteWatchCalled).toBeFalse();
      expect(snapshots.at(-1)).toMatchObject([{ repo: "local" }]);
      expect(errors.at(-1)).toBeInstanceOf(FederatedReadError);
      expect(errors.at(-1)?.message).toContain("[FEDERATED_SNAPSHOT_QUERY_UNAVAILABLE]");
    } finally {
      remoteStore.close();
      localStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("cleans up federated watches when the initial listener throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-watch-listener-error-"));
    const questStore = new SqliteStore(join(root, "local.db"), { now: () => timestamp });
    let unsubscribed = false;
    questStore.watch = async () => ({
      unsubscribe: async () => {
        unsubscribed = true;
      },
    });
    const source: FederatedStoreSource = {
      blobStore: new LocalBlobStore(join(root, "local-evidence")),
      includeRepository: (repo) => repo === "local",
      questStore,
    };

    try {
      await expect(
        new FederatedQuestStore([source]).watch({}, () => {
          throw new Error("initial listener failed");
        }),
      ).rejects.toThrow("initial listener failed");
      expect(unsubscribed).toBeTrue();
    } finally {
      questStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("unsubscribes already-open watches when a later backend fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-federated-watch-"));
    const alphaStore = new SqliteStore(join(root, "alpha.db"), { now: () => timestamp });
    const betaStore = new SqliteStore(join(root, "beta.db"), { now: () => timestamp });
    let alphaUnsubscribed = false;
    alphaStore.watch = async () => ({
      unsubscribe: async () => {
        alphaUnsubscribed = true;
      },
    });
    betaStore.watch = async () => Promise.reject(new Error("beta watch failed"));
    const sources: FederatedStoreSource[] = [
      {
        blobStore: new LocalBlobStore(join(root, "alpha-evidence")),
        includeRepository: (repo) => repo === "alpha",
        questStore: alphaStore,
      },
      {
        blobStore: new LocalBlobStore(join(root, "beta-evidence")),
        includeRepository: (repo) => repo === "beta",
        questStore: betaStore,
      },
    ];

    try {
      await expect(new FederatedQuestStore(sources).watch({}, () => undefined)).rejects.toThrow(
        "beta watch failed",
      );
      expect(alphaUnsubscribed).toBeTrue();
    } finally {
      alphaStore.close();
      betaStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
