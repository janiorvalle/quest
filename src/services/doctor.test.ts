import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEvidenceMaterializer } from "../evidence";
import {
  type Chain,
  type Event,
  type Evidence,
  type Quest,
  type QuestDump,
  questSchema,
  STORE_SCHEMA_VERSION,
  type StoreCompatibilityResult,
} from "../schema";
import { type BlobStore, SQLITE_SCHEMA_VERSION } from "../store";
import type { BackupOperations } from "./backup";
import { type DoctorOperations, type DoctorStoreInspection, runDoctor } from "./doctor";

const now = "2026-07-31T18:00:00.000Z";
const backupSnapshot = "2026-07-31T170000.000Z";
const evidenceBytes = new TextEncoder().encode("doctor evidence");
const evidenceHash = createHash("sha256").update(evidenceBytes).digest("hex");

const emptyBackupDump = {
  chains: [] as Chain[],
  evidence: [] as Evidence[],
  events: [] as Event[],
  quests: [] as Quest[],
  schema_version: STORE_SCHEMA_VERSION,
} satisfies QuestDump;

function compatible(): StoreCompatibilityResult {
  return {
    outcome: "compatible",
    store_version: SQLITE_SCHEMA_VERSION,
    supported_version: SQLITE_SCHEMA_VERSION,
  };
}

function task(changes: Partial<Quest> = {}): Quest {
  return questSchema.parse({
    area: "cli",
    assignee: null,
    created_at: "2026-07-31T17:00:00.000Z",
    description: "doctor fixture",
    guild: null,
    id: 1,
    kind: "task",
    lease_expires_at: null,
    opened_by: "fixture",
    pr: null,
    predicted_files: [],
    priority: 2,
    reopen_count: 0,
    repo: "quest",
    status: "ready",
    title: "doctor fixture",
    updated_at: "2026-07-31T17:00:00.000Z",
    verdict: null,
    verdict_notes: null,
    ...changes,
  });
}

function healthyDump(quest: Quest = task()): QuestDump {
  return {
    ...emptyBackupDump,
    evidence:
      quest.id === 1 && quest.status === "ready"
        ? [
            {
              added_by: "fixture",
              created_at: "2026-07-31T17:00:00.000Z",
              filename: "doctor.txt",
              id: 1,
              kind: "other",
              quest_id: quest.id,
              sha256: evidenceHash,
              stage: "fix",
            },
          ]
        : [],
    quests: [quest],
  };
}

function backup(overrides: Partial<BackupOperations> = {}): BackupOperations {
  return {
    list: () =>
      Promise.resolve([
        {
          age_seconds: 60,
          counts: { chains: 0, evidence: 0, events: 0, quests: 1 },
          created_at: "2026-07-31T17:59:00.000Z",
          size_bytes: 128,
          snapshot: backupSnapshot,
        },
      ]),
    prune: () => Promise.resolve({ deleted: [], retained: [backupSnapshot] }),
    restore: () =>
      Promise.resolve({
        evidence_restored: 0,
        pre_restore_config: null,
        pre_restore_database: null,
        snapshot: backupSnapshot,
        verified: true as const,
      }),
    run: () =>
      Promise.resolve({
        counts: { chains: 0, evidence: 0, events: 0, quests: 1 },
        evidence: { copied: 0, count: 0, total_bytes: 0 },
        path: "/backups/quest/snapshots/latest",
        pruned: [],
        snapshot: backupSnapshot,
      }),
    verify: () =>
      Promise.resolve({
        counts: { chains: 0, evidence: 0, events: 0, quests: 1 },
        full: false,
        integrity_check: "ok" as const,
        sampled_evidence: [],
        snapshot: backupSnapshot,
        verified: true as const,
      }),
    ...overrides,
  };
}

function blobStore(bytes: Uint8Array | null = evidenceBytes): BlobStore {
  return {
    get: () => Promise.resolve(bytes),
    has: () => Promise.resolve(bytes !== null),
    put: () => Promise.resolve(evidenceHash),
  };
}

function operations(
  root: string,
  inspection: DoctorStoreInspection = {
    dump: healthyDump(),
    integrity_check: ["ok"],
    state: "present",
  },
  overrides: Partial<DoctorOperations> = {},
): DoctorOperations {
  return {
    backup: backup(),
    blobStore: blobStore(),
    inspectProcesses: () => Promise.resolve({ available: true, holders: [] }),
    inspectStore: () => Promise.resolve(inspection),
    paths: {
      backup: join(root, "backups"),
      database: join(root, "quest.db"),
      evidence: join(root, "evidence"),
      ownership_database: join(root, "quest.db.ownership.sqlite"),
      temporary_directory: root,
    },
    ...overrides,
  };
}

function check(data: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const result = data.checks.find((item) => item.check === name);
  if (result === undefined) {
    throw new Error(`missing doctor check ${name}`);
  }
  return result;
}

describe("doctor diagnostics", () => {
  test("healthy fixtures pass every check", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-healthy-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root),
      });

      expect(result.healthy).toBeTrue();
      expect(result.checks.map((item) => item.status)).toEqual([
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
      ]);
      expect(check(result, "backup").details).toMatchObject({
        last_verify: { snapshot: backupSnapshot, status: "passed" },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports an older store with the exact migration remedy", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-schema-"));
    try {
      const result = await runDoctor({
        compatibility: {
          action: "migrate-store",
          outcome: "store-older",
          store_version: 3,
          supported_version: SQLITE_SCHEMA_VERSION,
        },
        now,
        operations: operations(root),
      });

      expect(result.healthy).toBeFalse();
      expect(check(result, "schema")).toMatchObject({
        remedy: "run quest migrate, then rerun quest doctor",
        status: "fail",
        summary: `store schema 3 is older than binary support ${SQLITE_SCHEMA_VERSION}`,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("uses the backend remedy for an older remote store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-remote-schema-"));
    try {
      const result = await runDoctor({
        compatibility: {
          action: "migrate-store",
          outcome: "store-older",
          store_version: 5,
          supported_version: 6,
        },
        now,
        olderStoreRemedy:
          "deploy the matching Convex functions with `bunx convex deploy`, then retry",
        operations: operations(root),
      });

      expect(check(result, "schema")).toMatchObject({
        remedy: "deploy the matching Convex functions with `bunx convex deploy`, then retry",
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves SQLite integrity failures when the dump is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-integrity-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, {
          integrity_check: ["database disk image is malformed"],
          state: "present",
        }),
      });

      expect(check(result, "schema")).toMatchObject({
        remedy: "restore the store from a verified backup, then rerun quest doctor",
        status: "fail",
        summary:
          "store schema matches, but SQLite integrity check returned database disk image is malformed",
      });
      expect(check(result, "leases")).toMatchObject({
        status: "warn",
        summary: "stale claims could not be trusted because SQLite integrity is not healthy",
      });
      expect(check(result, "evidence")).toMatchObject({
        status: "warn",
        summary: "evidence blobs could not be trusted because SQLite integrity is not healthy",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports a stale backup and a failed verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-backup-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          backup: backup({
            list: () =>
              Promise.resolve([
                {
                  age_seconds: 3 * 24 * 60 * 60,
                  counts: { chains: 0, evidence: 0, events: 0, quests: 1 },
                  created_at: "2026-07-28T18:00:00.000Z",
                  size_bytes: 128,
                  snapshot: backupSnapshot,
                },
              ]),
            verify: () =>
              Promise.reject(new Error("backup file export.json does not match manifest")),
          }),
        }),
      });

      expect(check(result, "backup")).toMatchObject({
        remedy: `run quest backup verify --full ${backupSnapshot}, fix the reported issue, then create a new backup`,
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports expired leases as stale claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-leases-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, {
          dump: healthyDump(
            task({
              assignee: "janior/codex",
              lease_expires_at: "2026-07-31T17:00:00.000Z",
              status: "accepted",
            }),
          ),
          integrity_check: ["ok"],
          state: "present",
        }),
      });

      expect(check(result, "leases")).toMatchObject({
        remedy: "confirm no worker still owns each listed quest, then re-accept the stale quests",
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports processes that still hold the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-processes-"));
    try {
      await writeFile(join(root, "quest.db"), "fixture");
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectProcesses: () =>
            Promise.resolve({
              available: true,
              holders: [{ command: "quest", paths: [join(root, "quest.db")], pid: 4242 }],
            }),
        }),
      });

      expect(check(result, "processes")).toMatchObject({
        remedy: "stop the listed Quest process(es), then rerun quest doctor",
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports known holders even when the process probe is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-partial-processes-"));
    try {
      await writeFile(join(root, "quest.db"), "fixture");
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectProcesses: () =>
            Promise.resolve({
              available: false,
              detail: "ownership probe denied",
              holders: [{ command: "quest", paths: [join(root, "quest.db")], pid: 4244 }],
            }),
        }),
      });

      expect(check(result, "processes")).toMatchObject({
        remedy: "stop the listed Quest process(es), then rerun quest doctor",
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("checks an ownership store when the main store file is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-orphaned-ownership-"));
    const ownershipDatabase = join(root, "quest.db.ownership.sqlite");
    try {
      await writeFile(ownershipDatabase, "fixture");
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectProcesses: () =>
            Promise.resolve({
              available: true,
              holders: [{ command: "quest", paths: [ownershipDatabase], pid: 4243 }],
            }),
        }),
      });

      expect(check(result, "processes")).toMatchObject({
        remedy: "stop the listed Quest process(es), then rerun quest doctor",
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports owned stale viewer directories without deleting them", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-viewer-"));
    const materializer = await createEvidenceMaterializer(root);
    try {
      await materializer.materialize(new TextEncoder().encode("viewer"), "viewer.txt");
      const old = new Date(Date.parse(now) - 2 * 24 * 60 * 60 * 1_000);
      await utimes(materializer.directory, old, old);
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root),
      });

      expect(check(result, "viewer_temp")).toMatchObject({ status: "fail" });
      expect((await stat(materializer.directory)).isDirectory()).toBeTrue();
    } finally {
      await materializer.cleanup();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports a missing or corrupt evidence blob", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-evidence-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          blobStore: blobStore(new Uint8Array([1, 2, 3])),
        }),
      });

      expect(check(result, "evidence")).toMatchObject({
        remedy: "restore the listed evidence blobs from a verified backup, then rerun quest doctor",
        status: "fail",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
