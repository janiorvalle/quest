import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newQuestSchema } from "../schema";
import type { FederatedStoreSource } from ".";
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
    status: "ready",
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
