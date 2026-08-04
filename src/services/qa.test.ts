import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewQuest } from "../schema";
import {
  FederatedQuestStore,
  type FederatedStoreSource,
  LocalBlobStore,
  SqliteStore,
} from "../store";
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
    const source = (repo: string, questStore: SqliteStore): FederatedStoreSource => ({
      blobStore: new LocalBlobStore(join(directory, `${repo}-evidence`)),
      includeRepository: (candidate) => candidate === repo,
      questStore,
    });
    const store = new FederatedQuestStore([source("alpha", alphaStore), source("beta", betaStore)]);
    try {
      await alphaStore.addQuest(task("Alpha completed", "alpha"));
      await betaStore.addQuest(task("Beta completed", "beta"));

      const result = await getQaQueue(store, { repo: null }, "posix");

      expect(result.summary).toEqual({ quests: 2, sessions: 2 });
      expect(result.sessions.map(({ signoff }) => signoff).sort()).toEqual([
        "quest --repo 'alpha' signoff 1",
        "quest --repo 'beta' signoff 1",
      ]);
    } finally {
      alphaStore.close();
      betaStore.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
