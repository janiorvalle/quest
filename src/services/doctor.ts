import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { inspectStaleEvidenceMaterializations } from "../evidence";
import type { ProcessHoldingResult } from "../platform";
import {
  type DoctorData,
  type DoctorFinding,
  doctorDataSchema,
  doctorFindingSchema,
  type QuestDump,
  type StoreCompatibilityResult,
} from "../schema";
import type { BlobStore } from "../store";
import type { BackupOperations, BackupSnapshotSummary, BackupVerifyResult } from "./backup";

const MAX_BACKUP_AGE_SECONDS = 24 * 60 * 60;
const EVIDENCE_SAMPLE_SIZE = 10;

export interface DoctorPaths {
  readonly backup: string;
  readonly database: string;
  readonly evidence: string;
  readonly ownership_database: string;
  readonly temporary_directory: string;
}

export type DoctorStoreInspection =
  | {
      readonly state: "missing";
    }
  | {
      readonly dump?: QuestDump | undefined;
      readonly integrity_check: readonly string[];
      readonly state: "present";
    };

export interface DoctorOperations {
  readonly backup?: BackupOperations | undefined;
  readonly blobStore?: BlobStore | undefined;
  readonly inspectProcesses?: (() => Promise<ProcessHoldingResult>) | undefined;
  readonly inspectStore: () => Promise<DoctorStoreInspection>;
  readonly paths: DoctorPaths;
}

export interface RunDoctorOptions {
  readonly compatibility?: StoreCompatibilityResult | undefined;
  readonly compatibilityError?: unknown;
  readonly olderStoreRemedy?: string | undefined;
  readonly operations: DoctorOperations;
  readonly now: string;
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replaceAll(/\s+/gu, " ").trim() || "unknown error";
}

function finding(input: {
  readonly check: DoctorFinding["check"];
  readonly details: unknown;
  readonly remedy: string | null;
  readonly status: DoctorFinding["status"];
  readonly summary: string;
}): DoctorFinding {
  return doctorFindingSchema.parse(input);
}

function compatibilityRemedy(
  compatibility: StoreCompatibilityResult | undefined,
  olderStoreRemedy?: string,
): string {
  if (compatibility === undefined) {
    return "check the store path and permissions, then rerun quest doctor";
  }
  switch (compatibility.outcome) {
    case "compatible":
      return "rerun quest doctor after checking the store path and permissions";
    case "store-newer":
      return "upgrade the quest binary, then rerun quest doctor";
    case "store-older":
      return olderStoreRemedy ?? "run quest migrate, then rerun quest doctor";
  }
}

function compatibilitySummary(compatibility: StoreCompatibilityResult | undefined): string {
  if (compatibility === undefined) {
    return "store schema could not be checked";
  }
  switch (compatibility.outcome) {
    case "compatible":
      return `store schema ${compatibility.store_version} matches binary support`;
    case "store-newer":
      return `store schema ${compatibility.store_version} is newer than binary support ${compatibility.supported_version}`;
    case "store-older":
      return `store schema ${compatibility.store_version} is older than binary support ${compatibility.supported_version}`;
  }
}

function schemaFinding(
  compatibility: StoreCompatibilityResult | undefined,
  compatibilityError: unknown,
  olderStoreRemedy: string | undefined,
  inspection: DoctorStoreInspection | undefined,
  inspectionError: string | undefined,
): DoctorFinding {
  if (compatibilityError !== undefined || compatibility === undefined) {
    const detail =
      compatibilityError === undefined
        ? "store compatibility probe did not return a result"
        : errorDetail(compatibilityError);
    return finding({
      check: "schema",
      details: { error: detail, store_exists: inspection?.state === "present" },
      remedy: compatibilityRemedy(compatibility, olderStoreRemedy),
      status: "fail",
      summary: `store schema could not be checked: ${detail}`,
    });
  }
  if (compatibility.outcome !== "compatible") {
    return finding({
      check: "schema",
      details: {
        action: compatibility.action,
        store_exists: inspection?.state === "present",
        store_schema_version: compatibility.store_version,
        supported_schema_version: compatibility.supported_version,
      },
      remedy: compatibilityRemedy(compatibility, olderStoreRemedy),
      status: "fail",
      summary: compatibilitySummary(compatibility),
    });
  }

  if (inspectionError !== undefined) {
    return finding({
      check: "schema",
      details: {
        error: inspectionError,
        store_schema_version: compatibility.store_version,
        supported_schema_version: compatibility.supported_version,
      },
      remedy: compatibilityRemedy(compatibility, olderStoreRemedy),
      status: "fail",
      summary: `store schema matches, but the store could not be read: ${inspectionError}`,
    });
  }

  if (inspection?.state === "present") {
    const integrity = [...inspection.integrity_check];
    if (integrity.length !== 1 || integrity[0]?.toLowerCase() !== "ok") {
      return finding({
        check: "schema",
        details: {
          integrity_check: integrity,
          store_schema_version: compatibility.store_version,
          supported_schema_version: compatibility.supported_version,
        },
        remedy: "restore the store from a verified backup, then rerun quest doctor",
        status: "fail",
        summary: `store schema matches, but SQLite integrity check returned ${integrity.join(", ") || "no result"}`,
      });
    }
    if (inspection.dump === undefined) {
      return finding({
        check: "schema",
        details: { store_schema_version: compatibility.store_version },
        remedy: "restore the store from a verified backup, then rerun quest doctor",
        status: "fail",
        summary: "store schema matches, but its contents could not be read",
      });
    }
  }

  return finding({
    check: "schema",
    details: {
      integrity_check: inspection?.state === "present" ? [...inspection.integrity_check] : null,
      store_exists: inspection?.state === "present",
      store_schema_version: compatibility.store_version,
      supported_schema_version: compatibility.supported_version,
    },
    remedy: null,
    status: "pass",
    summary:
      inspection?.state === "missing"
        ? `${compatibilitySummary(compatibility)}; store is not initialized yet`
        : compatibilitySummary(compatibility),
  });
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return `${ageSeconds}s`;
  }
  if (ageSeconds < 60 * 60) {
    return `${Math.floor(ageSeconds / 60)}m`;
  }
  if (ageSeconds < 24 * 60 * 60) {
    return `${Math.floor(ageSeconds / (60 * 60))}h`;
  }
  return `${Math.floor(ageSeconds / (24 * 60 * 60))}d`;
}

function backupFailureDetails(
  snapshots: readonly BackupSnapshotSummary[],
  latest: BackupSnapshotSummary | undefined,
  lastVerify: Record<string, unknown>,
): Record<string, unknown> {
  return {
    latest: latest === undefined ? null : { ...latest },
    last_verify: lastVerify,
    snapshot_count: snapshots.length,
  };
}

async function backupFinding(operations: DoctorOperations, now: string): Promise<DoctorFinding> {
  const backup = operations.backup;
  if (backup === undefined) {
    return finding({
      check: "backup",
      details: { available: false },
      remedy: "use the SQLite backend, then rerun quest doctor",
      status: "warn",
      summary: "backup diagnostics are unavailable for the configured store backend",
    });
  }

  let snapshots: readonly BackupSnapshotSummary[];
  try {
    snapshots = await backup.list();
  } catch (error: unknown) {
    const detail = errorDetail(error);
    return finding({
      check: "backup",
      details: { error: detail },
      remedy: "check the configured backup root, then rerun quest doctor",
      status: "fail",
      summary: `backup list failed: ${detail}`,
    });
  }

  const latest = snapshots[0];
  if (latest === undefined) {
    return finding({
      check: "backup",
      details: backupFailureDetails(snapshots, latest, {
        checked_at: now,
        status: "missing",
      }),
      remedy: "run quest backup run, then rerun quest doctor",
      status: "fail",
      summary: "no backup snapshots found",
    });
  }

  try {
    const verification = await backup.verify(latest.snapshot);
    const stale = latest.age_seconds > MAX_BACKUP_AGE_SECONDS;
    const lastVerify = backupVerificationDetails(verification, now);
    return finding({
      check: "backup",
      details: backupFailureDetails(snapshots, latest, lastVerify),
      remedy: stale ? "run quest backup run, then rerun quest doctor" : null,
      status: stale ? "fail" : "pass",
      summary: `latest backup ${latest.snapshot} is ${formatAge(latest.age_seconds)} old; verification passed${stale ? ", but the backup is stale" : ""}`,
    });
  } catch (error: unknown) {
    const detail = errorDetail(error);
    return finding({
      check: "backup",
      details: backupFailureDetails(snapshots, latest, {
        checked_at: now,
        error: detail,
        snapshot: latest.snapshot,
        status: "failed",
      }),
      remedy: `run quest backup verify --full ${latest.snapshot}, fix the reported issue, then create a new backup`,
      status: "fail",
      summary: `latest backup ${latest.snapshot} could not be verified: ${detail}`,
    });
  }
}

function backupVerificationDetails(
  verification: BackupVerifyResult,
  checkedAt: string,
): Record<string, unknown> {
  return {
    checked_at: checkedAt,
    full: verification.full,
    snapshot: verification.snapshot,
    status: "passed",
  };
}

function unavailableStoreFinding(
  check: "leases" | "evidence",
  compatibility: StoreCompatibilityResult | undefined,
  inspectionError: string | undefined,
  compatibilityError: unknown,
  olderStoreRemedy: string | undefined,
): DoctorFinding {
  const detail =
    inspectionError ??
    (compatibilityError === undefined ? undefined : errorDetail(compatibilityError)) ??
    (compatibility === undefined
      ? "store compatibility was unavailable"
      : compatibility.outcome === "compatible"
        ? "store inspection was not available"
        : `store schema is ${compatibility.outcome}`);
  return finding({
    check,
    details: {
      error: detail,
      store_schema: compatibilitySummary(compatibility),
    },
    remedy: compatibilityRemedy(compatibility, olderStoreRemedy),
    status: "warn",
    summary: `${check === "leases" ? "lease" : "evidence"} check skipped: ${detail}`,
  });
}

function storeIntegrityIsHealthy(
  inspection: Extract<DoctorStoreInspection, { state: "present" }>,
): boolean {
  return (
    inspection.integrity_check.length === 1 && inspection.integrity_check[0]?.toLowerCase() === "ok"
  );
}

function leaseFinding(
  compatibility: StoreCompatibilityResult | undefined,
  compatibilityError: unknown,
  olderStoreRemedy: string | undefined,
  inspection: DoctorStoreInspection | undefined,
  inspectionError: string | undefined,
  now: string,
): DoctorFinding {
  if (
    compatibilityError !== undefined ||
    compatibility === undefined ||
    compatibility.outcome !== "compatible" ||
    inspectionError !== undefined ||
    inspection === undefined
  ) {
    return unavailableStoreFinding(
      "leases",
      compatibility,
      inspectionError,
      compatibilityError,
      olderStoreRemedy,
    );
  }
  if (inspection.state === "missing") {
    return finding({
      check: "leases",
      details: { claims: [], store_exists: false },
      remedy: null,
      status: "pass",
      summary: "no initialized store, so there are no stale claims",
    });
  }
  if (!storeIntegrityIsHealthy(inspection)) {
    return finding({
      check: "leases",
      details: { integrity_check: [...inspection.integrity_check] },
      remedy: "restore the store from a verified backup, then rerun quest doctor",
      status: "warn",
      summary: "stale claims could not be trusted because SQLite integrity is not healthy",
    });
  }
  if (inspection.dump === undefined) {
    return unavailableStoreFinding(
      "leases",
      compatibility,
      inspectionError,
      compatibilityError,
      olderStoreRemedy,
    );
  }

  const staleClaims = inspection.dump.quests
    .filter(
      (quest) =>
        quest.status === "accepted" &&
        (quest.lease_expires_at === null || Date.parse(quest.lease_expires_at) <= Date.parse(now)),
    )
    .map((quest) => ({
      assignee: quest.assignee,
      id: quest.id,
      lease_expires_at: quest.lease_expires_at,
      reason: quest.lease_expires_at === null ? "missing lease" : "expired lease",
    }));
  if (staleClaims.length === 0) {
    return finding({
      check: "leases",
      details: { claims: [], store_exists: true },
      remedy: null,
      status: "pass",
      summary: "no stale claims or expired leases",
    });
  }
  return finding({
    check: "leases",
    details: { claims: staleClaims, store_exists: true },
    remedy: "confirm no worker still owns each listed quest, then re-accept the stale quests",
    status: "fail",
    summary: `${staleClaims.length} stale claim${staleClaims.length === 1 ? "" : "s"} need attention`,
  });
}

async function processFinding(operations: DoctorOperations): Promise<DoctorFinding> {
  const databaseExists = existsSync(operations.paths.database);
  const ownershipDatabaseExists = existsSync(operations.paths.ownership_database);
  if (!databaseExists && !ownershipDatabaseExists) {
    return finding({
      check: "processes",
      details: { holders: [], ownership_store_exists: false, store_exists: false },
      remedy: null,
      status: "pass",
      summary: "store files are absent, so no process can hold them open",
    });
  }
  if (operations.inspectProcesses === undefined) {
    return finding({
      check: "processes",
      details: { available: false, holders: [] },
      remedy: "install lsof on macOS/Linux or use handle.exe on Windows, then rerun quest doctor",
      status: "warn",
      summary: "process holder diagnostics are unavailable",
    });
  }

  try {
    const result = await operations.inspectProcesses();
    if (!result.available) {
      const detail = result.detail ?? "the process probe did not report a reason";
      if (result.holders.length > 0) {
        return finding({
          check: "processes",
          details: { available: false, detail, holders: [...result.holders] },
          remedy: "stop the listed Quest process(es), then rerun quest doctor",
          status: "fail",
          summary: `${result.holders.length} known process${result.holders.length === 1 ? "" : "es"} hold the Quest store open; the probe was incomplete: ${detail}`,
        });
      }
      return finding({
        check: "processes",
        details: { available: false, detail, holders: [...result.holders] },
        remedy: "install lsof on macOS/Linux or use handle.exe on Windows, then rerun quest doctor",
        status: "warn",
        summary: `process holder diagnostics are unavailable: ${detail}`,
      });
    }
    if (result.holders.length === 0) {
      return finding({
        check: "processes",
        details: { available: true, holders: [] },
        remedy: null,
        status: "pass",
        summary: "no process is holding the Quest store open",
      });
    }
    return finding({
      check: "processes",
      details: { available: true, holders: [...result.holders] },
      remedy: "stop the listed Quest process(es), then rerun quest doctor",
      status: "fail",
      summary: `${result.holders.length} process${result.holders.length === 1 ? "" : "es"} currently hold the Quest store open`,
    });
  } catch (error: unknown) {
    const detail = errorDetail(error);
    return finding({
      check: "processes",
      details: { available: false, error: detail, holders: [] },
      remedy: "install lsof on macOS/Linux or use handle.exe on Windows, then rerun quest doctor",
      status: "warn",
      summary: `process holder diagnostics failed: ${detail}`,
    });
  }
}

async function viewerTempFinding(
  operations: DoctorOperations,
  now: string,
): Promise<DoctorFinding> {
  try {
    const stale = await inspectStaleEvidenceMaterializations(
      operations.paths.temporary_directory,
      () => Date.parse(now),
    );
    if (stale.length === 0) {
      return finding({
        check: "viewer_temp",
        details: { directories: [] },
        remedy: null,
        status: "pass",
        summary: "no orphaned viewer temp directories",
      });
    }
    return finding({
      check: "viewer_temp",
      details: { directories: [...stale] },
      remedy: "run quest once to clean owned stale viewer directories, then rerun quest doctor",
      status: "fail",
      summary: `${stale.length} orphaned viewer temp director${stale.length === 1 ? "y" : "ies"} found`,
    });
  } catch (error: unknown) {
    const detail = errorDetail(error);
    return finding({
      check: "viewer_temp",
      details: { error: detail },
      remedy: "check access to the system temp directory, then rerun quest doctor",
      status: "warn",
      summary: `viewer temp directory check failed: ${detail}`,
    });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inspectEvidenceBlob(
  hash: string,
  blobStore: BlobStore,
): Promise<{ hash: string; issue: string } | undefined> {
  try {
    const bytes = await blobStore.get(hash);
    if (bytes === null) {
      return { hash, issue: "blob is missing" };
    }
    const actual = sha256(bytes);
    return actual === hash ? undefined : { hash, issue: `content hash is ${actual}` };
  } catch (error: unknown) {
    return { hash, issue: errorDetail(error) };
  }
}

async function evidenceFinding(
  compatibility: StoreCompatibilityResult | undefined,
  compatibilityError: unknown,
  olderStoreRemedy: string | undefined,
  inspection: DoctorStoreInspection | undefined,
  inspectionError: string | undefined,
  blobStore: BlobStore | undefined,
): Promise<DoctorFinding> {
  if (
    compatibilityError !== undefined ||
    compatibility === undefined ||
    compatibility.outcome !== "compatible" ||
    inspectionError !== undefined ||
    inspection === undefined
  ) {
    return unavailableStoreFinding(
      "evidence",
      compatibility,
      inspectionError,
      compatibilityError,
      olderStoreRemedy,
    );
  }
  if (inspection.state === "missing") {
    return finding({
      check: "evidence",
      details: { sample: [], store_exists: false, total: 0 },
      remedy: null,
      status: "pass",
      summary: "no initialized store, so there are no evidence blobs to check",
    });
  }
  if (!storeIntegrityIsHealthy(inspection)) {
    return finding({
      check: "evidence",
      details: { integrity_check: [...inspection.integrity_check] },
      remedy: "restore the store from a verified backup, then rerun quest doctor",
      status: "warn",
      summary: "evidence blobs could not be trusted because SQLite integrity is not healthy",
    });
  }
  if (inspection.dump === undefined) {
    return unavailableStoreFinding(
      "evidence",
      compatibility,
      inspectionError,
      compatibilityError,
      olderStoreRemedy,
    );
  }
  if (blobStore === undefined) {
    return finding({
      check: "evidence",
      details: { available: false },
      remedy: "use the SQLite backend, then rerun quest doctor",
      status: "warn",
      summary: "evidence blob diagnostics are unavailable for the configured store backend",
    });
  }

  const hashes = [...new Set(inspection.dump.evidence.map((item) => item.sha256))].sort();
  const sample = hashes.slice(0, EVIDENCE_SAMPLE_SIZE);
  const failures: Array<{ hash: string; issue: string }> = [];
  for (const hash of sample) {
    const failure = await inspectEvidenceBlob(hash, blobStore);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  if (failures.length > 0) {
    return finding({
      check: "evidence",
      details: { failures, sample, total: hashes.length },
      remedy: "restore the listed evidence blobs from a verified backup, then rerun quest doctor",
      status: "fail",
      summary: `evidence spot-check failed for ${failures.length} of ${sample.length} sampled blob${sample.length === 1 ? "" : "s"}`,
    });
  }
  return finding({
    check: "evidence",
    details: { sample, total: hashes.length },
    remedy: null,
    status: "pass",
    summary: `spot-checked ${sample.length} evidence blob${sample.length === 1 ? "" : "s"}; content addresses match`,
  });
}

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorData> {
  let inspection: DoctorStoreInspection | undefined;
  let inspectionError: string | undefined;
  if (options.compatibilityError === undefined && options.compatibility?.outcome === "compatible") {
    try {
      inspection = await options.operations.inspectStore();
    } catch (error: unknown) {
      inspectionError = errorDetail(error);
    }
  }

  const [backup, processes, viewerTemp] = await Promise.all([
    backupFinding(options.operations, options.now),
    processFinding(options.operations),
    viewerTempFinding(options.operations, options.now),
  ]);
  const checks = [
    schemaFinding(
      options.compatibility,
      options.compatibilityError,
      options.olderStoreRemedy,
      inspection,
      inspectionError,
    ),
    backup,
    leaseFinding(
      options.compatibility,
      options.compatibilityError,
      options.olderStoreRemedy,
      inspection,
      inspectionError,
      options.now,
    ),
    processes,
    viewerTemp,
    await evidenceFinding(
      options.compatibility,
      options.compatibilityError,
      options.olderStoreRemedy,
      inspection,
      inspectionError,
      options.operations.blobStore,
    ),
  ];
  return doctorDataSchema.parse({
    checks,
    healthy: checks.every((check) => check.status === "pass"),
  });
}
