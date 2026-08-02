import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newQuestSchema } from "../schema";
import type { FederatedStoreSource } from ".";
import { FederatedBlobStore, FederatedQuestStore, LocalBlobStore, SqliteStore } from ".";

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
