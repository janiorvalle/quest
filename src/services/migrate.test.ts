import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type NewQuest,
  newQuestSchema,
  questDumpSchema,
  STORE_SCHEMA_VERSION,
  type StoreConfig,
} from "../schema";
import { LocalBlobStore, SqliteStore } from "../store";
import type { BackupRunResult, BackupVerifyResult } from "./backup";
import type { RepositoryMigrationBackend } from "./migrate";
import { migrateRepository, recoverRepositoryFence, requireMatchingDump } from "./migrate";

function task(repository: string, title: string): NewQuest {
  return newQuestSchema.parse({
    area: "migration",
    assignee: null,
    backfill: false,
    description: title,
    guild: null,
    kind: "task",
    opened_by: "migration/test",
    pr: null,
    predicted_files: [],
    priority: 2,
    repo: repository,
    reopen_count: 0,
    status: "open",
    title,
    verdict: null,
    verdict_notes: null,
  });
}

function backupResult(snapshot: string): BackupRunResult {
  return {
    counts: { chains: 0, evidence: 0, events: 0, quests: 0 },
    evidence: { copied: 0, count: 0, total_bytes: 0 },
    path: `/tmp/${snapshot}`,
    pruned: [],
    snapshot,
  };
}

function backup(snapshot: string, calls: string[]) {
  return {
    list: () => Promise.resolve([]),
    prune: () => Promise.resolve({ deleted: [], retained: [] }),
    restore: () => Promise.reject(new Error("restore is not part of migration")),
    run: () => {
      calls.push(`backup:${snapshot}`);
      return Promise.resolve(backupResult(snapshot));
    },
    verify: (requestedSnapshot?: string): Promise<BackupVerifyResult> => {
      calls.push(`verify:${requestedSnapshot ?? snapshot}`);
      return Promise.resolve({
        counts: { chains: 0, evidence: 0, events: 0, quests: 0 },
        integrity_check: "ok",
        sampled_evidence: [],
        snapshot: requestedSnapshot ?? snapshot,
        verified: true,
        full: true,
      });
    },
  };
}

function backend(
  config: StoreConfig,
  questStore: SqliteStore,
  blobStore: LocalBlobStore,
  snapshot: string,
  calls: string[],
): RepositoryMigrationBackend {
  return {
    backup: backup(snapshot, calls),
    blobStore,
    config,
    questStore,
  };
}

describe("repository migration", () => {
  test("matches dumps when backends return the same objects in a different key order", () => {
    const expected = questDumpSchema.parse({
      schema_version: STORE_SCHEMA_VERSION,
      quests: [
        {
          id: 1,
          repo: "web-app",
          area: "migration",
          kind: "task",
          title: "key order",
          description: "key order",
          opened_by: "migration/test",
          guild: null,
          assignee: null,
          status: "open",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          predicted_files: [],
          reopen_count: 0,
          lease_expires_at: null,
          created_at: "2026-08-01T14:00:00.000Z",
          updated_at: "2026-08-01T14:00:00.000Z",
        },
      ],
      evidence: [],
      chains: [],
      events: [],
    });
    const actual = questDumpSchema.parse({
      ...expected,
      quests: expected.quests.map((quest) => {
        const { id, repo, ...rest } = quest;
        return { ...rest, repo, id };
      }),
    });

    expect(() => requireMatchingDump(expected, actual)).not.toThrow();
  });

  test("backs up, replays one repository, preserves other destination data, and verifies the result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-"));
    const source = new SqliteStore(join(directory, "source.db"));
    const destination = new SqliteStore(join(directory, "destination.db"));
    const sourceBlobs = new LocalBlobStore(join(directory, "source-evidence"));
    const destinationBlobs = new LocalBlobStore(join(directory, "destination-evidence"));
    const calls: string[] = [];
    let routingWritten = false;
    try {
      const first = await source.addQuest(task("web-app", "first"));
      const second = await source.addQuest(task("web-app", "second"));
      await source.addChainLink({
        actor: "migration/test",
        link: { quest_id: second.id, target_id: first.id, type: "requires" },
      });
      const hash = await sourceBlobs.put(new TextEncoder().encode("migration evidence"));
      await source.addEvidence({
        added_by: "migration/test",
        filename: "migration.log",
        kind: "log",
        quest_id: first.id,
        session_guild: null,
        sha256: hash,
        stage: "fix",
      });
      await destination.addQuest(task("other-repo", "keep me"));
      Object.defineProperty(destination, "recoverMigrationFence", {
        value: (repository: string) => {
          calls.push(`recover-destination:${repository}`);
          return Promise.resolve(true);
        },
      });

      const result = await migrateRepository({
        repository: "web-app",
        source: backend({ backend: "sqlite" }, source, sourceBlobs, "source-snapshot", calls),
        target: backend(
          { backend: "convex", deployment: "dev:migration" },
          destination,
          destinationBlobs,
          "destination-snapshot",
          calls,
        ),
        rollbackRouting: async () => {
          calls.push("routing-rollback");
          return true;
        },
        verifyDestinationRouting: async () => true,
        verifyRouting: async () => true,
        writeRouting: async () => {
          expect(
            (await destination.exportAll()).quests.filter(({ repo }) => repo === "web-app"),
          ).toHaveLength(2);
          calls.push("routing");
          routingWritten = true;
        },
      });

      expect(calls.slice(0, 2)).toEqual(["backup:source-snapshot", "backup:destination-snapshot"]);
      expect(calls.slice(2, 4)).toEqual(["verify:source-snapshot", "verify:destination-snapshot"]);
      expect(calls[4]).toBe("recover-destination:web-app");
      expect(calls.at(-1)).toBe("routing");
      expect(routingWritten).toBeTrue();
      expect(result.counts).toEqual({ chains: 1, evidence: 1, events: 4, quests: 2 });
      expect(result.verified).toBeTrue();
      expect(result.spot_checks.evidence_hashes).toEqual([hash]);
      expect((await destination.listQuests({ repo: "other-repo" })).length).toBe(1);
      expect((await destination.listQuests({ repo: "web-app" })).length).toBe(2);
      await expect(source.addQuest(task("web-app", "blocked old client"))).rejects.toThrow(
        "MIGRATION_REPOSITORY_FENCED",
      );
      expect(await destinationBlobs.has(hash)).toBeTrue();
      const migratedEvents = (await destination.exportAll()).events;
      expect(migratedEvents).toContainEqual(
        expect.objectContaining({
          action: "chain",
          detail: { quest_id: 3, target_id: 2, type: "requires", session_guild: null },
        }),
      );
      expect(migratedEvents).toContainEqual(
        expect.objectContaining({
          action: "update",
          detail: expect.objectContaining({ evidence_id: 1, quest_id: 2 }),
        }),
      );
    } finally {
      source.close();
      destination.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects a chain that crosses the repository boundary before replay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-chain-"));
    const source = new SqliteStore(join(directory, "source.db"));
    const destination = new SqliteStore(join(directory, "destination.db"));
    const sourceBlobs = new LocalBlobStore(join(directory, "source-evidence"));
    const destinationBlobs = new LocalBlobStore(join(directory, "destination-evidence"));
    const calls: string[] = [];
    try {
      const local = await source.addQuest(task("web-app", "local"));
      const external = await source.addQuest(task("other-repo", "external"));
      const incoming = await source.addQuest(task("another-repo", "incoming"));
      await source.addChainLink({
        actor: "migration/test",
        link: { quest_id: local.id, target_id: external.id, type: "requires" },
      });
      await source.addChainLink({
        actor: "migration/test",
        link: { quest_id: incoming.id, target_id: local.id, type: "requires" },
      });
      const sourceBefore = await source.exportAll();
      const destinationBefore = await destination.exportAll();

      await expect(
        migrateRepository({
          repository: "web-app",
          rollbackRouting: async () => true,
          verifyDestinationRouting: async () => true,
          verifyRouting: async () => true,
          source: backend({ backend: "sqlite" }, source, sourceBlobs, "source", calls),
          target: backend(
            { backend: "convex", deployment: "dev:migration" },
            destination,
            destinationBlobs,
            "destination",
            calls,
          ),
          writeRouting: async () => undefined,
        }),
      ).rejects.toThrow(
        '[MIGRATION_CROSS_REPO_LINKS] repository web-app has cross-repository chain links: quest 1 "local" (web-app) requires quest 2 "external" (other-repo); quest 3 "incoming" (another-repo) requires quest 1 "local" (web-app). Migrate each linked repository into the same deployment so the links survive, or remove the listed links with quest chain remove (for example: quest chain rm 1 --requires 2) and retry',
      );
      expect(calls).toEqual([]);
      expect(await source.exportAll()).toEqual(sourceBefore);
      expect(await destination.exportAll()).toEqual(destinationBefore);
    } finally {
      source.close();
      destination.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("does not write routing or destination metadata when source evidence is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-missing-"));
    const source = new SqliteStore(join(directory, "source.db"));
    const destination = new SqliteStore(join(directory, "destination.db"));
    const sourceBlobs = new LocalBlobStore(join(directory, "source-evidence"));
    const destinationBlobs = new LocalBlobStore(join(directory, "destination-evidence"));
    let routingWritten = false;
    try {
      const quest = await source.addQuest(task("web-app", "missing blob"));
      await source.addEvidence({
        added_by: "migration/test",
        filename: "missing.log",
        kind: "log",
        quest_id: quest.id,
        session_guild: null,
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        stage: "fix",
      });
      await expect(
        migrateRepository({
          repository: "web-app",
          source: backend({ backend: "sqlite" }, source, sourceBlobs, "source", []),
          target: backend(
            { backend: "convex", deployment: "dev:migration" },
            destination,
            destinationBlobs,
            "destination",
            [],
          ),
          rollbackRouting: async () => true,
          verifyDestinationRouting: async () => true,
          verifyRouting: async () => true,
          writeRouting: async () => {
            routingWritten = true;
          },
        }),
      ).rejects.toThrow("MIGRATION_EVIDENCE_MISSING");
      expect(routingWritten).toBeFalse();
      expect((await destination.exportAll()).quests).toEqual([]);
    } finally {
      source.close();
      destination.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps the committed destination and clears the source fence when routing fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-routing-"));
    const source = new SqliteStore(join(directory, "source.db"));
    const destination = new SqliteStore(join(directory, "destination.db"));
    const sourceBlobs = new LocalBlobStore(join(directory, "source-evidence"));
    const destinationBlobs = new LocalBlobStore(join(directory, "destination-evidence"));
    try {
      await source.addQuest(task("web-app", "routing failure"));
      await expect(
        migrateRepository({
          repository: "web-app",
          source: backend({ backend: "sqlite" }, source, sourceBlobs, "source", []),
          target: backend(
            { backend: "convex", deployment: "dev:migration" },
            destination,
            destinationBlobs,
            "destination",
            [],
          ),
          rollbackRouting: async () => true,
          verifyDestinationRouting: async () => true,
          verifyRouting: async () => true,
          writeRouting: async () => {
            throw new Error("config is read-only");
          },
        }),
      ).rejects.toThrow("MIGRATION_CONFIG_WRITE_FAILED");
      expect((await destination.listQuests({ repo: "web-app" })).length).toBe(1);
      await expect(destination.addQuest(task("web-app", "blocked destination"))).rejects.toThrow(
        "MIGRATION_REPOSITORY_FENCED",
      );
      await source.addQuest(task("web-app", "retry remains possible"));
    } finally {
      source.close();
      destination.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("recovers the destination fence when routing already switched", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "quest-repository-migration-destination-route-"),
    );
    const source = new SqliteStore(join(directory, "source.db"));
    const destination = new SqliteStore(join(directory, "destination.db"));
    const sourceBlobs = new LocalBlobStore(join(directory, "source-evidence"));
    const destinationBlobs = new LocalBlobStore(join(directory, "destination-evidence"));
    let destinationRouting = false;
    try {
      await source.addQuest(task("web-app", "destination route"));
      await expect(
        migrateRepository({
          repository: "web-app",
          source: backend({ backend: "sqlite" }, source, sourceBlobs, "source", []),
          target: backend(
            { backend: "convex", deployment: "dev:migration" },
            destination,
            destinationBlobs,
            "destination",
            [],
          ),
          rollbackRouting: async () => false,
          verifyDestinationRouting: async () => destinationRouting,
          verifyRouting: async () => false,
          writeRouting: async () => {
            destinationRouting = true;
            throw new Error("route write acknowledgement lost");
          },
        }),
      ).rejects.toThrow("destination fence was recovered");
      await destination.addQuest(task("web-app", "destination writes resume"));
      await expect(source.addQuest(task("web-app", "source stays fenced"))).rejects.toThrow(
        "MIGRATION_REPOSITORY_FENCED",
      );
    } finally {
      source.close();
      destination.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps both fences when routing state cannot be verified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-unknown-route-"));
    const source = new SqliteStore(join(directory, "source.db"));
    const destination = new SqliteStore(join(directory, "destination.db"));
    const sourceBlobs = new LocalBlobStore(join(directory, "source-evidence"));
    const destinationBlobs = new LocalBlobStore(join(directory, "destination-evidence"));
    try {
      await source.addQuest(task("web-app", "unknown route"));
      await expect(
        migrateRepository({
          repository: "web-app",
          rollbackRouting: async () => false,
          verifyDestinationRouting: async () => false,
          verifyRouting: async () => false,
          source: backend({ backend: "sqlite" }, source, sourceBlobs, "source", []),
          target: backend(
            { backend: "convex", deployment: "dev:migration" },
            destination,
            destinationBlobs,
            "destination",
            [],
          ),
          writeRouting: async () => {
            throw new Error("route changed concurrently");
          },
        }),
      ).rejects.toThrow("do not restore the destination backup");
      await expect(source.addQuest(task("web-app", "source stays fenced"))).rejects.toThrow(
        "MIGRATION_REPOSITORY_FENCED",
      );
      await expect(
        destination.addQuest(task("web-app", "destination stays fenced")),
      ).rejects.toThrow("MIGRATION_REPOSITORY_FENCED");
    } finally {
      source.close();
      destination.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("recovers a destination fence after routing was already switched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-recovery-"));
    const store = new SqliteStore(join(directory, "destination.db"));
    try {
      await store.addQuest(task("web-app", "already migrated"));
      const session = await store.beginMigration(await store.exportAll());
      await session.fence("web-app");
      await session.commit();
      await session.release();

      const result = await recoverRepositoryFence(store, { backend: "sqlite" }, "web-app");

      expect(result?.recovered).toBeTrue();
      await store.addQuest(task("web-app", "writes resume"));
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("recovers an empty destination fence with zero counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-repository-migration-empty-recovery-"));
    const store = new SqliteStore(join(directory, "destination.db"));
    try {
      const session = await store.beginMigration(await store.exportAll());
      await session.fence("empty-repository");
      await session.commit();
      await session.release();

      const result = await recoverRepositoryFence(store, { backend: "sqlite" }, "empty-repository");

      expect(result?.recovered).toBeTrue();
      expect(result?.counts).toEqual({ chains: 0, evidence: 0, events: 0, quests: 0 });
      expect(result?.spot_checks).toEqual({
        evidence_hashes: [],
        first_quest_id: null,
        last_quest_id: null,
      });
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
