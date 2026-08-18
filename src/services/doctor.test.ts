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
import { type BlobStore, SQLITE_SCHEMA_VERSION, type StoreCapacityInspection } from "../store";
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
    status: "open",
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
      quest.id === 1 && quest.status === "open"
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

function capacityInspection(
  quests: number,
  evidence: number,
  events: number,
): StoreCapacityInspection {
  return {
    event_rate_sample: {
      count: 64,
      first: { at: "2026-07-21T18:00:00.000Z", id: Math.max(1, events - 63) },
      last: { at: now, id: events },
    },
    tables: [
      { high_water_mark: quests, table: "quests" },
      { high_water_mark: evidence, table: "evidence" },
      { high_water_mark: events, table: "events" },
    ],
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

  test("keeps a small Convex deployment healthy without exporting its full store", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-small-capacity-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(
          root,
          { integrity_check: ["ok"], scope: "diagnostics", state: "present" },
          {
            inspectCapacity: () => Promise.resolve(capacityInspection(100, 200, 300)),
            inspectEvidenceSample: () => Promise.resolve({ hashes: [], high_water_mark: 200 }),
            inspectStaleClaims: () => Promise.resolve({ claims: [], truncated: false }),
          },
        ),
      });

      expect(result.healthy).toBeTrue();
      expect(check(result, "capacity")).toMatchObject({
        details: {
          write_path: {
            ceiling_events_per_second: 70,
            occ_retry_rate: { retries_per_hour: null, state: "unavailable" },
          },
        },
        remedy: null,
        status: "pass",
        summary: "Convex table display-ID upper bounds are below 50% of known limits",
      });
      expect(check(result, "evidence").details).toEqual({
        high_water_mark: 200,
        sample: [],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("warns when recent event writes approach the measured exact-ID ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-write-headroom-"));
    try {
      const inspection: StoreCapacityInspection = {
        ...capacityInspection(100, 100, 164),
        event_rate_sample: {
          count: 65,
          first: { at: "2026-07-31T17:59:59.000Z", id: 100 },
          last: { at: now, id: 164 },
        },
      };
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () => Promise.resolve(inspection),
          inspectOccRetries: () =>
            Promise.resolve({
              failed_calls: 0,
              retried_calls: 0,
              state: "available",
              window_hours: 72,
            }),
        }),
      });

      expect(check(result, "capacity")).toMatchObject({
        details: {
          write_path: {
            ceiling_events_per_second: 70,
            headroom_percent_used: 91.4,
            recent_events_per_second: 64,
          },
        },
        remedy:
          "capture `convex insights --details --json`, then reopen quest 377 to evaluate protocol v3 opaque event and evidence IDs",
        status: "warn",
        summary:
          "Recent event throughput is 64 inserts/s, 91.4% of the measured 70 inserts/s exact-ID ceiling",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("uses sampled documents rather than sparse display-ID gaps for throughput", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-sparse-event-rate-"));
    try {
      const inspection: StoreCapacityInspection = {
        ...capacityInspection(100, 100, 8_000),
        event_rate_sample: {
          count: 2,
          first: { at: "2026-07-31T17:59:59.000Z", id: 7_937 },
          last: { at: now, id: 8_000 },
        },
      };
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () => Promise.resolve(inspection),
        }),
      });

      expect(check(result, "capacity")).toMatchObject({
        details: { write_path: { headroom_percent_used: 1.4, recent_events_per_second: 1 } },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not report an old event burst as current write pressure", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-old-event-rate-"));
    try {
      const inspection: StoreCapacityInspection = {
        ...capacityInspection(100, 100, 300),
        event_rate_sample: {
          count: 64,
          first: { at: "2026-06-01T17:59:59.000Z", id: 237 },
          last: { at: "2026-06-01T18:00:00.000Z", id: 300 },
        },
      };
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () => Promise.resolve(inspection),
        }),
      });

      expect(check(result, "capacity")).toMatchObject({
        details: {
          event_burn_rate: { events_per_day: null },
          write_path: { headroom_percent_used: null, recent_events_per_second: null },
        },
        status: "pass",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reports the exact-ID allocator OCC retry rate from Convex Insights", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-occ-retries-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () => Promise.resolve(capacityInspection(100, 100, 300)),
          inspectOccRetries: () =>
            Promise.resolve({
              failed_calls: 0,
              retried_calls: 15,
              state: "available",
              window_hours: 72,
            }),
        }),
      });

      expect(check(result, "capacity")).toMatchObject({
        details: {
          write_path: {
            occ_retry_rate: {
              failed_calls: 0,
              retries_per_hour: 0.21,
              retried_calls: 15,
              state: "available",
              window_hours: 72,
            },
          },
        },
        remedy:
          "capture `convex insights --details --json`, then reopen quest 377 to evaluate protocol v3 opaque event and evidence IDs",
        status: "warn",
        summary: "Convex retried 15 exact-ID writes after OCC conflicts in the last 72 hours",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("warns before the nearest Convex wall with its projected date and exact remedy", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-near-capacity-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () => Promise.resolve(capacityInspection(500, 1_000, 7_000)),
        }),
      });

      expect(result.healthy).toBeFalse();
      expect(check(result, "capacity")).toMatchObject({
        details: {
          document_size_limit: { bytes: 1_048_576 },
          event_burn_rate: {
            events_per_day: 6.3,
            measurement: "bounded_recent_document_sample",
          },
          table_capacity_basis: {
            measurement: "monotonic_display_id_upper_bound",
            note: "The indexed display-ID tail is a conservative upper bound, not a document count; sparse stores after restore may report high but cannot under-report capacity pressure.",
          },
          tables: [
            { response_limit: { upper_bound_estimated_at: null }, table: "quests" },
            { response_limit: { upper_bound_estimated_at: null }, table: "evidence" },
            {
              id_high_water_upper_bound: 7_000,
              measurement: "monotonic_display_id_upper_bound",
              response_limit: {
                upper_bound_estimated_at: "2027-02-05T22:57:08.571Z",
                limit: 8_192,
                upper_bound_percent_used: 85.4,
              },
              table: "events",
            },
          ],
        },
        remedy:
          "verify quest 374's paged event-feed surface is deployed; page any custom event reads, then rerun quest doctor",
        status: "warn",
        summary:
          "Convex events display-ID upper bound 7,000 is 85.4% of the 8,192-element response limit; the upper bound is projected to reach it 2027-02-05T22:57:08.571Z; sparse restored stores may read high",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails a sparse high-water upper bound above 95% and labels the conservative basis", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-capacity-error-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () => Promise.resolve(capacityInspection(7_800, 1_000, 2_000)),
          inspectOccRetries: () =>
            Promise.resolve({
              failed_calls: 0,
              retried_calls: 1,
              state: "available",
              window_hours: 72,
            }),
        }),
      });

      expect(check(result, "capacity")).toMatchObject({
        details: {
          table_capacity_basis: {
            measurement: "monotonic_display_id_upper_bound",
            note: expect.stringContaining("not a document count"),
          },
          tables: expect.arrayContaining([
            expect.objectContaining({
              id_high_water_upper_bound: 7_800,
              response_limit: expect.objectContaining({ upper_bound_percent_used: 95.2 }),
              table: "quests",
            }),
          ]),
        },
        remedy:
          "verify quest 375's paged list, stats, viewer, and claim surfaces are deployed; page any custom quest reads, then rerun quest doctor",
        status: "fail",
        summary:
          "Convex quests display-ID upper bound 7,800 is 95.2% of the 8,192-element response limit; sparse restored stores may read high",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("tells operators to deploy matching functions when capacity diagnostics are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-outdated-capacity-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(root, undefined, {
          inspectCapacity: () =>
            Promise.reject(
              new Error(
                "[CONVEX_DOCTOR_OUTDATED] this Convex deployment does not expose quest:doctorCapacity",
              ),
            ),
        }),
      });

      expect(check(result, "capacity")).toMatchObject({
        remedy: "deploy the matching Convex functions with `bunx convex deploy`, then retry",
        status: "fail",
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

  test("warns instead of hiding stale claims beyond the bounded Convex sample", async () => {
    const root = await mkdtemp(join(tmpdir(), "quest-doctor-truncated-leases-"));
    try {
      const result = await runDoctor({
        compatibility: compatible(),
        now,
        operations: operations(
          root,
          { integrity_check: ["ok"], scope: "diagnostics", state: "present" },
          {
            inspectEvidenceSample: () => Promise.resolve({ hashes: [], high_water_mark: 0 }),
            inspectStaleClaims: () => Promise.resolve({ claims: [], truncated: true }),
          },
        ),
      });

      expect(check(result, "leases")).toEqual({
        check: "leases",
        details: { claims: [], store_exists: true, truncated: true },
        remedy:
          "reduce accepted claims below 100 or inspect leases in the Convex dashboard, then rerun quest doctor",
        status: "warn",
        summary: "stale claims could not be ruled out because more than 100 claims are accepted",
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
