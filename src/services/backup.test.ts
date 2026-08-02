import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewQuest, QuestDump } from "../schema";
import { backupManifestSchema, newQuestSchema, STORE_SCHEMA_VERSION } from "../schema";
import {
  type BackupDatabase,
  type Clock,
  LocalBlobStore,
  SQLITE_SCHEMA_VERSION,
  SqliteBackupDatabase,
  SqliteStore,
} from "../store";
import { LocalBackupService, selectSnapshotsForRetention } from "./backup";

const createdAt = "2026-07-29T20:15:30.000Z";

function task(title: string): NewQuest {
  return newQuestSchema.parse({
    repo: "quest",
    area: "backup",
    kind: "task",
    title,
    description: `${title} description`,
    opened_by: "fixture",
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

function fixedClock(timestamp = createdAt): Clock {
  return { now: () => Promise.resolve(timestamp) };
}

function sequenceClock(timestamps: readonly string[]): Clock {
  let index = 0;
  return {
    now: () => {
      const timestamp = timestamps[Math.min(index, timestamps.length - 1)];
      index += 1;
      return timestamp === undefined
        ? Promise.reject(new Error("clock sequence is empty"))
        : Promise.resolve(timestamp);
    },
  };
}

async function seedStore(store: SqliteStore, evidenceDirectory: string): Promise<QuestDump> {
  const first = await store.addQuest(task("First backup quest"));
  const second = await store.addQuest(task("Second backup quest"));
  await store.addChainLink({
    actor: "fixture",
    link: {
      quest_id: second.id,
      target_id: first.id,
      type: "requires",
    },
  });
  const blobs = new LocalBlobStore(evidenceDirectory);
  const sha256 = await blobs.put(new TextEncoder().encode("backup evidence"));
  await store.addEvidence({
    quest_id: first.id,
    sha256,
    filename: "proof.txt",
    kind: "log",
    stage: "verify",
    added_by: "fixture",
  });
  return store.exportAll();
}

describe("local backup service", () => {
  test("rejects repository-scoped restore when the backend can only restore the full store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-full-scope-"));
    const databasePath = join(root, "state", "quest.db");
    const evidenceDirectory = join(root, "state", "evidence");
    const configFile = join(root, "config.toml");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      await store.addQuest({ ...task("target before restore"), repo: "target" });
      await store.addQuest({ ...task("unrelated before restore"), repo: "unrelated" });
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      const before = await store.exportAll();

      await expect(backup.restore(run.snapshot, "target")).rejects.toThrow(
        "[BACKUP_REPOSITORY_RESTORE_UNSUPPORTED] this backend cannot restore only repository target; rerun backup restore without a repository to restore the complete snapshot",
      );

      expect(await store.exportAll()).toEqual(before);
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("repository restore publishes only that repository's evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-repository-evidence-"));
    const databasePath = join(root, "state", "quest.db");
    const evidenceDirectory = join(root, "state", "evidence");
    const restoredEvidenceDirectory = join(root, "restored-evidence");
    const configFile = join(root, "config.toml");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const target = await store.addQuest({ ...task("target"), repo: "target" });
      const unrelated = await store.addQuest({ ...task("unrelated"), repo: "unrelated" });
      const sourceBlobs = new LocalBlobStore(evidenceDirectory);
      const targetHash = await sourceBlobs.put(new TextEncoder().encode("target evidence"));
      const unrelatedHash = await sourceBlobs.put(new TextEncoder().encode("unrelated evidence"));
      await store.addEvidence({
        quest_id: target.id,
        sha256: targetHash,
        filename: "target.txt",
        kind: "log",
        stage: "verify",
        added_by: "fixture",
      });
      await store.addEvidence({
        quest_id: unrelated.id,
        sha256: unrelatedHash,
        filename: "unrelated.txt",
        kind: "log",
        stage: "verify",
        added_by: "fixture",
      });
      const sqliteDatabase = new SqliteBackupDatabase(databasePath, store);
      const backup = new LocalBackupService({
        backupDatabase: sqliteDatabase,
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      const repositoryDatabase: BackupDatabase = {
        restoreScope: "repository",
        createSnapshot: (destination) => sqliteDatabase.createSnapshot(destination),
        inspect: (path) => sqliteDatabase.inspect(path),
        inspectCurrent: () => sqliteDatabase.inspectCurrent(),
        restoreSnapshot: (source, label) => sqliteDatabase.restoreSnapshot(source, label),
      };
      const restoredBlobs = new LocalBlobStore(restoredEvidenceDirectory);
      const restore = new LocalBackupService({
        backupDatabase: repositoryDatabase,
        blobStore: restoredBlobs,
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory: restoredEvidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });

      await restore.restore(run.snapshot, "target");

      expect(await restoredBlobs.has(targetHash)).toBeTrue();
      expect(await restoredBlobs.has(unrelatedHash)).toBeFalse();
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("runs, verifies, lists, wipes, and restores a complete scratch store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-service-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config", "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups", "quest");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(configFile, 'identity = "fixture"\n');

    const sourceStore = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const expectedDump = await seedStore(sourceStore, evidenceDirectory);
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, sourceStore),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });

      const run = await backup.run();
      expect(run.snapshot).toBe("2026-07-29T201530.000Z");
      expect(run.counts).toEqual({
        quests: 2,
        evidence: 1,
        chains: 1,
        events: 4,
      });
      expect(run.evidence).toEqual({ copied: 1, count: 1, total_bytes: 15 });
      expect(run.pruned).toEqual([]);

      const manifest = backupManifestSchema.parse(
        JSON.parse(await readFile(join(run.path, "manifest.json"), "utf8")),
      );
      expect(manifest.store_schema_version).toBe(SQLITE_SCHEMA_VERSION);
      expect(manifest.files["quest.db"].bytes).toBeGreaterThan(0);
      expect(manifest.files["export.json"].bytes).toBeGreaterThan(0);
      expect(manifest.files["config.toml"].bytes).toBeGreaterThan(0);

      const verification = await backup.verify();
      const expectedEvidence = expectedDump.evidence[0];
      if (expectedEvidence === undefined) {
        throw new Error("seeded backup evidence is missing");
      }
      expect(verification).toEqual({
        snapshot: run.snapshot,
        verified: true,
        full: false,
        counts: run.counts,
        integrity_check: "ok",
        sampled_evidence: [expectedEvidence.sha256],
      });
      const snapshots = await backup.list();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.snapshot).toBe(run.snapshot);
      expect(snapshots[0]?.size_bytes).toBeGreaterThan(0);

      sourceStore.close();
      await rm(stateDirectory, { force: true, recursive: true });
      await rm(join(root, "config"), { force: true, recursive: true });
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(configFile, 'identity = "replacement"\n');

      const emptyStore = new SqliteStore(databasePath, { now: () => createdAt });
      const concurrentStore = new SqliteStore(databasePath, { now: () => createdAt });
      try {
        const restore = new LocalBackupService({
          backupDatabase: new SqliteBackupDatabase(databasePath, emptyStore),
          clock: fixedClock(),
          configFile,
          defaultRoot: backupRoot,
          evidenceDirectory,
          retention: { daily: 7, weekly: 4, monthly: 6 },
        });
        const restored = await restore.restore(run.snapshot);
        expect(restored.verified).toBeTrue();
        expect(restored.evidence_restored).toBe(1);
        expect(restored.pre_restore_database?.endsWith(".pre-restore")).toBeTrue();
        expect(restored.pre_restore_config?.endsWith(".pre-restore")).toBeTrue();
        expect(await readFile(configFile, "utf8")).toBe('identity = "fixture"\n');
        if (restored.pre_restore_config === null) {
          throw new Error("restore did not preserve the previous config");
        }
        expect(await readFile(restored.pre_restore_config, "utf8")).toBe(
          'identity = "replacement"\n',
        );
        expect(await emptyStore.exportAll()).toEqual(expectedDump);
        expect(await concurrentStore.exportAll()).toEqual(expectedDump);

        if (restored.pre_restore_database === null) {
          throw new Error("restore did not preserve the previous database");
        }
        const previousStore = new SqliteStore(restored.pre_restore_database);
        try {
          expect((await previousStore.exportAll()).quests).toEqual([]);
        } finally {
          previousStore.close();
        }
      } finally {
        concurrentStore.close();
        emptyStore.close();
      }
    } finally {
      sourceStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("full verification re-hashes evidence outside the default sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-full-verify-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const seeded = await seedStore(store, evidenceDirectory);
      const quest = seeded.quests[0];
      if (quest === undefined) {
        throw new Error("seeded backup quest is missing");
      }
      const blobs = new LocalBlobStore(evidenceDirectory);
      for (let index = 0; index < 11; index += 1) {
        const sha256 = await blobs.put(new TextEncoder().encode(`backup evidence ${index}`));
        await store.addEvidence({
          quest_id: quest.id,
          sha256,
          filename: `proof-${index}.txt`,
          kind: "log",
          stage: "verify",
          added_by: "fixture",
        });
      }

      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      const sampled = await backup.verify(run.snapshot);
      const dump = await store.exportAll();
      const target = dump.evidence
        .map(({ sha256 }) => sha256)
        .find((sha256) => !sampled.sampled_evidence.includes(sha256));
      if (target === undefined) {
        throw new Error("expected evidence outside the verification sample");
      }
      const original = await readFile(join(backupRoot, "evidence", target));
      const corrupted = Uint8Array.from(original);
      const firstByte = corrupted[0];
      if (firstByte === undefined) {
        throw new Error("expected a non-empty evidence blob");
      }
      corrupted[0] = firstByte === 0 ? 1 : 0;
      await writeFile(join(backupRoot, "evidence", target), corrupted);

      await expect(backup.verify(run.snapshot, { full: true })).rejects.toThrow(
        `backup evidence ${target} failed its hash check`,
      );
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("quarantines and repairs a corrupt live evidence blob during restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-corrupt-blob-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const expectedDump = await seedStore(store, evidenceDirectory);
      const expectedEvidence = expectedDump.evidence[0];
      if (expectedEvidence === undefined) {
        throw new Error("seeded backup evidence is missing");
      }
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      const livePath = join(evidenceDirectory, expectedEvidence.sha256);
      const original = await readFile(livePath);
      const corrupt = new TextEncoder().encode("corrupt live evidence");
      await writeFile(livePath, corrupt);
      store.close();

      const recovery = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const restored = await recovery.restore(run.snapshot);
      expect(restored.evidence_restored).toBe(1);
      expect(await readFile(livePath)).toEqual(original);

      const quarantineName = (await readdir(evidenceDirectory)).find((name) =>
        name.startsWith(`${expectedEvidence.sha256}.corrupt-`),
      );
      if (quarantineName === undefined) {
        throw new Error("restore did not quarantine the corrupt evidence blob");
      }
      expect(await readFile(join(evidenceDirectory, quarantineName))).toEqual(Buffer.from(corrupt));
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not repair live evidence when restore ownership is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-locked-restore-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const expectedDump = await seedStore(store, evidenceDirectory);
      const expectedEvidence = expectedDump.evidence[0];
      if (expectedEvidence === undefined) {
        throw new Error("seeded backup evidence is missing");
      }
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      const livePath = join(evidenceDirectory, expectedEvidence.sha256);
      const corrupt = new TextEncoder().encode("locked restore evidence");
      await writeFile(livePath, corrupt);

      const recovery = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      await expect(recovery.restore(run.snapshot)).rejects.toThrow(
        "cannot replace the Quest store while another Quest process is using it",
      );
      expect(await readFile(livePath)).toEqual(Buffer.from(corrupt));
      expect(
        (await readdir(evidenceDirectory)).some((name) =>
          name.startsWith(`${expectedEvidence.sha256}.corrupt-`),
        ),
      ).toBeFalse();
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not activate an offline database until evidence restore succeeds", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-evidence-failure-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const expectedDump = await seedStore(store, evidenceDirectory);
      const expectedEvidence = expectedDump.evidence[0];
      if (expectedEvidence === undefined) {
        throw new Error("seeded backup evidence is missing");
      }
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      await store.addQuest(task("Current quest must survive evidence failure"));
      const currentDump = await store.exportAll();
      store.close();

      const livePath = join(evidenceDirectory, expectedEvidence.sha256);
      await rm(livePath, { force: true, recursive: true });
      await mkdir(livePath);
      const recovery = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      await expect(recovery.restore(run.snapshot)).rejects.toThrow();

      const unchangedStore = new SqliteStore(databasePath);
      try {
        expect(await unchangedStore.exportAll()).toEqual(currentDump);
      } finally {
        unchangedStore.close();
      }
      expect((await stat(livePath)).isDirectory()).toBeTrue();
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("detects changed snapshot artifacts and corrupt evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-corruption-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const dump = await seedStore(store, evidenceDirectory);
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      const expectedEvidence = dump.evidence[0];
      if (expectedEvidence === undefined) {
        throw new Error("seeded backup evidence is missing");
      }
      await writeFile(join(run.path, "export.json"), "{}\n");
      await expect(backup.verify(run.snapshot)).rejects.toThrow(
        "backup file export.json does not match manifest",
      );

      await writeFile(join(backupRoot, "evidence", expectedEvidence.sha256), "corrupt");
      await expect(backup.run()).rejects.toThrow("existing backup evidence blob");
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rolls the database back when config replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-rollback-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, 'identity = "original"\n');
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      await seedStore(store, evidenceDirectory);
      const backupDatabase = new SqliteBackupDatabase(databasePath, store);
      const backup = new LocalBackupService({
        backupDatabase,
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      await store.addQuest(task("Current quest that must survive failed restore"));
      const currentDump = await store.exportAll();

      const invalidConfigDestination = join(root, "config-destination-is-a-directory");
      await mkdir(invalidConfigDestination);
      const restore = new LocalBackupService({
        backupDatabase,
        clock: fixedClock(),
        configFile: invalidConfigDestination,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      await expect(restore.restore(run.snapshot)).rejects.toThrow();
      expect(await store.exportAll()).toEqual(currentDump);
      expect(await readFile(configFile, "utf8")).toBe('identity = "original"\n');
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("an unrelated corrupt snapshot does not block intact recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-isolation-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      await seedStore(store, evidenceDirectory);
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: sequenceClock([
          "2026-07-29T20:15:30.000Z",
          "2026-07-30T20:15:30.000Z",
          "2026-07-30T20:15:31.000Z",
        ]),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const intact = await backup.run();
      const damaged = await backup.run();
      await writeFile(join(damaged.path, "manifest.json"), "{");

      expect((await backup.verify(intact.snapshot)).snapshot).toBe(intact.snapshot);
      expect((await backup.verify()).snapshot).toBe(intact.snapshot);
      expect((await backup.list()).map(({ snapshot }) => snapshot)).toEqual([intact.snapshot]);
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not let a corrupt newer snapshot evict a verified recovery point", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-retention-verification-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: sequenceClock(["2026-07-29T20:15:30.000Z", "2026-07-30T20:15:30.000Z"]),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 0, monthly: 0 },
      });
      const older = await backup.run();
      const newer = await backup.run();
      await writeFile(join(newer.path, "export.json"), "{}\n");

      const pruning = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 1, weekly: 0, monthly: 0 },
      });
      expect(await pruning.prune()).toEqual({
        deleted: [],
        retained: [older.snapshot],
      });
      expect((await pruning.verify(older.snapshot)).verified).toBeTrue();
      expect((await stat(newer.path)).isDirectory()).toBeTrue();
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores through the offline recovery path when the live database is corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-corrupt-live-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, 'identity = "fixture"\n');
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const expected = await seedStore(store, evidenceDirectory);
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      store.close();
      await writeFile(databasePath, "not a sqlite database");

      const recovery = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const restored = await recovery.restore(run.snapshot);
      expect(restored.verified).toBeTrue();
      if (restored.pre_restore_database === null) {
        throw new Error("offline restore did not preserve the corrupt live database");
      }
      expect(await readFile(restored.pre_restore_database, "utf8")).toBe("not a sqlite database");

      const restoredStore = new SqliteStore(databasePath);
      try {
        expect(await restoredStore.exportAll()).toEqual(expected);
      } finally {
        restoredStore.close();
      }
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores an empty-evidence snapshot after the state directory is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-empty-state-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, 'identity = "fixture"\n');
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      store.close();
      await rm(stateDirectory, { force: true, recursive: true });

      const recovery = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const restored = await recovery.restore(run.snapshot);
      expect(restored.verified).toBeTrue();
      expect(restored.pre_restore_database).toBeNull();

      const restoredStore = new SqliteStore(databasePath);
      try {
        expect(await restoredStore.exportAll()).toEqual({
          schema_version: STORE_SCHEMA_VERSION,
          quests: [],
          evidence: [],
          chains: [],
          events: [],
        });
      } finally {
        restoredStore.close();
      }
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves orphaned SQLite sidecars during offline recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-orphan-sidecars-"));
    const stateDirectory = join(root, "state");
    const evidenceDirectory = join(stateDirectory, "evidence");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const expected = await seedStore(store, evidenceDirectory);
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const run = await backup.run();
      store.close();
      await rm(databasePath);
      await writeFile(`${databasePath}-wal`, "orphan wal");
      await writeFile(`${databasePath}-shm`, "orphan shm");

      const recovery = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory,
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      const restored = await recovery.restore(run.snapshot);
      if (restored.pre_restore_database === null) {
        throw new Error("offline restore did not allocate pre-restore sidecar paths");
      }
      expect(await Bun.file(restored.pre_restore_database).exists()).toBeFalse();
      expect(await readFile(`${restored.pre_restore_database}-wal`, "utf8")).toBe("orphan wal");
      expect(await readFile(`${restored.pre_restore_database}-shm`, "utf8")).toBe("orphan shm");

      const restoredStore = new SqliteStore(databasePath);
      try {
        expect(await restoredStore.exportAll()).toEqual(expected);
      } finally {
        restoredStore.close();
      }
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects an unsupported snapshot schema before offline replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-offline-schema-"));
    const sourcePath = join(root, "source.db");
    const destinationPath = join(root, "destination.db");
    const sourceStore = new SqliteStore(sourcePath);
    sourceStore.close();
    const sourceDatabase = new Database(sourcePath);
    try {
      sourceDatabase.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION + 1}`);
    } finally {
      sourceDatabase.close();
    }
    await writeFile(destinationPath, "live database");

    try {
      const database = new SqliteBackupDatabase(destinationPath);
      await expect(database.restoreSnapshot(sourcePath, "unsupported")).rejects.toThrow(
        `unsupported restore schema version ${SQLITE_SCHEMA_VERSION + 1}; expected ${SQLITE_SCHEMA_VERSION}`,
      );
      expect(await readFile(destinationPath, "utf8")).toBe("live database");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("protects the snapshot created by run even when retention is zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-protected-run-"));
    const stateDirectory = join(root, "state");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory: join(stateDirectory, "evidence"),
        retention: { daily: 0, weekly: 0, monthly: 0 },
      });
      const run = await backup.run();
      expect(run.pruned).toEqual([]);
      expect((await stat(run.path)).isDirectory()).toBeTrue();

      expect(await backup.prune()).toEqual({
        deleted: [run.snapshot],
        retained: [],
      });
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes concurrent publication and retention for one backup root", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-concurrent-runs-"));
    const stateDirectory = join(root, "state");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await writeFile(configFile, "");
    const store = new SqliteStore(databasePath, { now: () => createdAt });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let firstClockEntered = false;
    let secondClockCalls = 0;
    const options = {
      backupDatabase: new SqliteBackupDatabase(databasePath, store),
      configFile,
      defaultRoot: backupRoot,
      evidenceDirectory: join(stateDirectory, "evidence"),
      retention: { daily: 7, weekly: 4, monthly: 6 },
    };
    const first = new LocalBackupService({
      ...options,
      clock: {
        now: async () => {
          firstClockEntered = true;
          await firstGate;
          return "2026-07-29T20:15:30.000Z";
        },
      },
    });
    const second = new LocalBackupService({
      ...options,
      clock: {
        now: () => {
          secondClockCalls += 1;
          return Promise.resolve("2026-07-30T20:15:30.000Z");
        },
      },
    });

    try {
      const firstRun = first.run();
      while (!firstClockEntered) {
        await Bun.sleep(1);
      }
      const secondRun = second.run();
      await Bun.sleep(25);
      expect(secondClockCalls).toBe(0);
      if (releaseFirst === undefined) {
        throw new Error("first backup gate was not initialized");
      }
      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
      expect(secondClockCalls).toBe(1);
      expect((await stat(firstResult.path)).isDirectory()).toBeTrue();
      expect((await stat(secondResult.path)).isDirectory()).toBeTrue();
    } finally {
      releaseFirst?.();
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovers the root lock when the owning SQLite connection exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-backup-lock-recovery-"));
    const stateDirectory = join(root, "state");
    const configFile = join(root, "config.toml");
    const databasePath = join(stateDirectory, "quest.db");
    const backupRoot = join(root, "backups");
    await mkdir(backupRoot, { recursive: true });
    await writeFile(configFile, "");
    const abandoned = new Database(join(backupRoot, ".quest-backup-lock.sqlite"));
    abandoned.run("BEGIN IMMEDIATE");
    abandoned.close();

    const store = new SqliteStore(databasePath, { now: () => createdAt });
    try {
      const backup = new LocalBackupService({
        backupDatabase: new SqliteBackupDatabase(databasePath, store),
        clock: fixedClock(),
        configFile,
        defaultRoot: backupRoot,
        evidenceDirectory: join(stateDirectory, "evidence"),
        retention: { daily: 7, weekly: 4, monthly: 6 },
      });
      expect((await backup.run()).snapshot).toBe("2026-07-29T201530.000Z");
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("backup retention", () => {
  test("keeps the configured union of newest daily, weekly, and monthly buckets", () => {
    const snapshots = [
      { name: "s10", created_at: "2026-07-10T00:00:00.000Z" },
      { name: "s09", created_at: "2026-07-09T00:00:00.000Z" },
      { name: "s08", created_at: "2026-07-08T00:00:00.000Z" },
      { name: "s07", created_at: "2026-07-07T00:00:00.000Z" },
      { name: "s06", created_at: "2026-07-06T00:00:00.000Z" },
      { name: "s05", created_at: "2026-07-05T00:00:00.000Z" },
      { name: "s04", created_at: "2026-07-04T00:00:00.000Z" },
      { name: "s03", created_at: "2026-07-03T00:00:00.000Z" },
      { name: "june", created_at: "2026-06-15T00:00:00.000Z" },
      { name: "may", created_at: "2026-05-15T00:00:00.000Z" },
    ];

    expect([
      ...selectSnapshotsForRetention(snapshots, {
        daily: 7,
        weekly: 4,
        monthly: 6,
      }),
    ]).toEqual(["s10", "s09", "s08", "s07", "s06", "s05", "s04", "june", "may"]);
    expect([
      ...selectSnapshotsForRetention(snapshots, {
        daily: 2,
        weekly: 0,
        monthly: 0,
      }),
    ]).toEqual(["s10", "s09"]);
  });
});
