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
import {
  type BlobStore,
  CONVEX_OLDER_STORE_REMEDY,
  type StoreCapacityInspection,
  type StoreEvidenceSampleInspection,
  type StoreStaleClaimsInspection,
} from "../store";
import type { BackupOperations, BackupSnapshotSummary, BackupVerifyResult } from "./backup";
import type { ConvexOccRetryInspection } from "./convex-insights";

const MAX_BACKUP_AGE_SECONDS = 24 * 60 * 60;
const EVIDENCE_SAMPLE_SIZE = 10;
const CONVEX_RESPONSE_ELEMENT_LIMIT = 8_192;
const CONVEX_SCAN_DOCUMENT_LIMIT = 32_000;
const CONVEX_DOCUMENT_SIZE_LIMIT_BYTES = 1_048_576;
const CAPACITY_INFORMATION_PERCENT = 50;
const CAPACITY_WARNING_PERCENT = 80;
const CAPACITY_ERROR_PERCENT = 95;
const EXACT_ID_WRITE_CEILING_PER_SECOND = 70;
const EVENT_RATE_RECENCY_HOURS = 72;

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
      readonly scope?: "diagnostics" | undefined;
      readonly state: "present";
    };

export interface DoctorOperations {
  readonly backup?: BackupOperations | undefined;
  readonly blobStore?: BlobStore | undefined;
  readonly inspectCapacity?: (() => Promise<StoreCapacityInspection>) | undefined;
  readonly inspectEvidenceSample?: (() => Promise<StoreEvidenceSampleInspection>) | undefined;
  readonly inspectOccRetries?: (() => Promise<ConvexOccRetryInspection>) | undefined;
  readonly inspectProcesses?: (() => Promise<ProcessHoldingResult>) | undefined;
  readonly inspectStaleClaims?: ((now: string) => Promise<StoreStaleClaimsInspection>) | undefined;
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

function diagnosticReadRemedy(detail: string): string {
  return detail.includes("[CONVEX_DOCTOR_OUTDATED]")
    ? CONVEX_OLDER_STORE_REMEDY
    : "check the Convex deployment connection and permissions, then rerun quest doctor";
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

function hasDiagnosticContents(
  inspection: Extract<DoctorStoreInspection, { state: "present" }>,
): boolean {
  return inspection.dump !== undefined || inspection.scope === "diagnostics";
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
    if (!hasDiagnosticContents(inspection)) {
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

function percentUsed(highWaterMark: number, limit: number): number {
  return Math.round((highWaterMark / limit) * 1_000) / 10;
}

function sampleIsRecent(lastAt: string, now: string): boolean {
  const ageMilliseconds = Date.parse(now) - Date.parse(lastAt);
  return (
    Number.isFinite(ageMilliseconds) &&
    ageMilliseconds >= 0 &&
    ageMilliseconds <= EVENT_RATE_RECENCY_HOURS * 60 * 60 * 1_000
  );
}

function eventRatePerDay(inspection: StoreCapacityInspection, now: string): number | null {
  const { count, first, last } = inspection.event_rate_sample;
  if (count < 2 || first === null || last === null || !sampleIsRecent(last.at, now)) {
    return null;
  }
  const elapsedMilliseconds = Date.parse(last.at) - Date.parse(first.at);
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
    return null;
  }
  return Math.round(((count - 1) / (elapsedMilliseconds / 86_400_000)) * 100) / 100;
}

function eventRatePerSecond(inspection: StoreCapacityInspection, now: string): number | null {
  const { count, first, last } = inspection.event_rate_sample;
  if (count < 2 || first === null || last === null || !sampleIsRecent(last.at, now)) {
    return null;
  }
  const elapsedMilliseconds = Date.parse(last.at) - Date.parse(first.at);
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds <= 0) {
    return null;
  }
  return Math.round(((count - 1) / (elapsedMilliseconds / 1_000)) * 100) / 100;
}

function estimatedLimitDate(
  highWaterMark: number,
  limit: number,
  ratePerDay: number | null,
  now: string,
): string | null {
  if (highWaterMark >= limit || ratePerDay === null || ratePerDay <= 0) {
    return null;
  }
  const nowMilliseconds = Date.parse(now);
  const estimatedMilliseconds =
    nowMilliseconds + ((limit - highWaterMark) / ratePerDay) * 86_400_000;
  if (!Number.isFinite(estimatedMilliseconds)) {
    return null;
  }
  try {
    return new Date(estimatedMilliseconds).toISOString();
  } catch {
    return null;
  }
}

function capacityRemedy(table: StoreCapacityInspection["tables"][number]["table"]): string {
  switch (table) {
    case "quests":
      return "verify quest 375's paged list, stats, viewer, and claim surfaces are deployed; page any custom quest reads, then rerun quest doctor";
    case "evidence":
      return "page the quest-detail evidence surface before this table reaches the Convex response limit, then rerun quest doctor";
    case "events":
      return "verify quest 374's paged event-feed surface is deployed; page any custom event reads, then rerun quest doctor";
  }
}

const unavailableOccRetries: ConvexOccRetryInspection = {
  reason:
    "Convex Insights was not configured for this backend; inspect OCC retries in the deployment dashboard",
  state: "unavailable",
  window_hours: 72,
};

async function inspectOccRetries(operations: DoctorOperations): Promise<ConvexOccRetryInspection> {
  if (operations.inspectOccRetries === undefined) {
    return unavailableOccRetries;
  }
  try {
    return await operations.inspectOccRetries();
  } catch {
    return {
      reason:
        "Convex Insights could not be read; check the Convex CLI login, then rerun quest doctor",
      state: "unavailable",
      window_hours: 72,
    };
  }
}

function capacityStatus(percent: number): DoctorFinding["status"] {
  if (percent > CAPACITY_ERROR_PERCENT) {
    return "fail";
  }
  return percent >= CAPACITY_WARNING_PERCENT ? "warn" : "pass";
}

function combineCapacityStatus(
  table: DoctorFinding["status"],
  writePath: DoctorFinding["status"],
): DoctorFinding["status"] {
  if (table === "fail" || writePath === "fail") {
    return "fail";
  }
  return table === "warn" || writePath === "warn" ? "warn" : "pass";
}

function statusRank(status: DoctorFinding["status"]): number {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return 1;
    case "fail":
      return 2;
  }
}

function capacityTables(
  inspection: StoreCapacityInspection,
  eventRatePerDay: number | null,
  now: string,
) {
  // Display IDs are never reused, so the indexed tail is the intentionally conservative
  // capacity proxy that keeps doctor constant-time even after restores introduce gaps.
  return inspection.tables.map((table) => {
    const tableRatePerDay = table.table === "events" ? eventRatePerDay : null;
    return {
      id_high_water_upper_bound: table.high_water_mark,
      measurement: "monotonic_display_id_upper_bound",
      response_limit: {
        upper_bound_estimated_at: estimatedLimitDate(
          table.high_water_mark,
          CONVEX_RESPONSE_ELEMENT_LIMIT,
          tableRatePerDay,
          now,
        ),
        limit: CONVEX_RESPONSE_ELEMENT_LIMIT,
        upper_bound_percent_used: percentUsed(table.high_water_mark, CONVEX_RESPONSE_ELEMENT_LIMIT),
      },
      scan_limit: {
        upper_bound_estimated_at: estimatedLimitDate(
          table.high_water_mark,
          CONVEX_SCAN_DOCUMENT_LIMIT,
          tableRatePerDay,
          now,
        ),
        limit: CONVEX_SCAN_DOCUMENT_LIMIT,
        upper_bound_percent_used: percentUsed(table.high_water_mark, CONVEX_SCAN_DOCUMENT_LIMIT),
      },
      table: table.table,
    };
  });
}

function nearestCapacityWall(tables: ReturnType<typeof capacityTables>) {
  return tables.reduce((nearest, table) =>
    table.response_limit.upper_bound_percent_used > nearest.response_limit.upper_bound_percent_used
      ? table
      : nearest,
  );
}

function tableCapacitySummary(nearestWall: ReturnType<typeof capacityTables>[number]): string {
  const usage = nearestWall.response_limit.upper_bound_percent_used;
  if (usage < CAPACITY_INFORMATION_PERCENT) {
    return "Convex table display-ID upper bounds are below 50% of known limits";
  }
  const estimatedAt = nearestWall.response_limit.upper_bound_estimated_at;
  const projection =
    nearestWall.id_high_water_upper_bound >= CONVEX_RESPONSE_ELEMENT_LIMIT
      ? "; the upper bound has crossed the limit"
      : estimatedAt === null
        ? ""
        : `; the upper bound is projected to reach it ${estimatedAt}`;
  return `Convex ${nearestWall.table} display-ID upper bound ${nearestWall.id_high_water_upper_bound.toLocaleString("en-US")} is ${usage}% of the 8,192-element response limit${projection}; sparse restored stores may read high`;
}

function writePathStatus(input: {
  readonly failedCalls: number | null;
  readonly headroomUsed: number | null;
  readonly retriedCalls: number | null;
}): DoctorFinding["status"] {
  if ((input.failedCalls ?? 0) > 0 || (input.headroomUsed ?? 0) > CAPACITY_ERROR_PERCENT) {
    return "fail";
  }
  return (input.retriedCalls ?? 0) > 0 || (input.headroomUsed ?? 0) >= CAPACITY_WARNING_PERCENT
    ? "warn"
    : "pass";
}

function writePathSummary(input: {
  readonly failedCalls: number | null;
  readonly headroomUsed: number | null;
  readonly ratePerSecond: number | null;
  readonly retriedCalls: number | null;
  readonly windowHours: number;
}): string | null {
  if ((input.failedCalls ?? 0) > 0) {
    return `Convex exact-ID writes permanently failed after OCC retries ${input.failedCalls?.toLocaleString("en-US")} time${input.failedCalls === 1 ? "" : "s"} in the last ${input.windowHours} hours`;
  }
  if ((input.retriedCalls ?? 0) > 0) {
    return `Convex retried ${input.retriedCalls?.toLocaleString("en-US")} exact-ID write${input.retriedCalls === 1 ? "" : "s"} after OCC conflicts in the last ${input.windowHours} hours`;
  }
  if (input.headroomUsed !== null && input.headroomUsed >= CAPACITY_WARNING_PERCENT) {
    return `Recent event throughput is ${input.ratePerSecond?.toLocaleString("en-US")} inserts/s, ${input.headroomUsed}% of the measured 70 inserts/s exact-ID ceiling`;
  }
  return null;
}

function assessWritePath(
  inspection: StoreCapacityInspection,
  occRetries: ConvexOccRetryInspection,
  now: string,
) {
  const ratePerSecond = eventRatePerSecond(inspection, now);
  const headroomUsed =
    ratePerSecond === null ? null : percentUsed(ratePerSecond, EXACT_ID_WRITE_CEILING_PER_SECOND);
  const retriedCalls = occRetries.state === "available" ? occRetries.retried_calls : null;
  const failedCalls = occRetries.state === "available" ? occRetries.failed_calls : null;
  const status = writePathStatus({ failedCalls, headroomUsed, retriedCalls });
  return {
    details: {
      ceiling_events_per_second: EXACT_ID_WRITE_CEILING_PER_SECOND,
      headroom_percent_used: headroomUsed,
      occ_retry_rate: {
        failed_calls: failedCalls,
        retries_per_hour:
          retriedCalls === null
            ? null
            : Math.round((retriedCalls / occRetries.window_hours) * 100) / 100,
        retried_calls: retriedCalls,
        source: "Convex Insights",
        state: occRetries.state,
        ...(occRetries.state === "unavailable" ? { reason: occRetries.reason } : {}),
        window_hours: occRetries.window_hours,
      },
      recent_events_per_second: ratePerSecond,
      sample: inspection.event_rate_sample,
    },
    status,
    summary: writePathSummary({
      failedCalls,
      headroomUsed,
      ratePerSecond,
      retriedCalls,
      windowHours: occRetries.window_hours,
    }),
  };
}

async function capacityFinding(
  operations: DoctorOperations,
  now: string,
): Promise<DoctorFinding | undefined> {
  if (operations.inspectCapacity === undefined) {
    return undefined;
  }

  let inspection: StoreCapacityInspection;
  try {
    inspection = await operations.inspectCapacity();
  } catch (error: unknown) {
    const detail = errorDetail(error);
    return finding({
      check: "capacity",
      details: { error: detail },
      remedy: diagnosticReadRemedy(detail),
      status: "fail",
      summary: `Convex capacity could not be checked: ${detail}`,
    });
  }

  const ratePerDay = eventRatePerDay(inspection, now);
  const tables = capacityTables(inspection, ratePerDay, now);
  const nearestWall = nearestCapacityWall(tables);
  const usage = nearestWall.response_limit.upper_bound_percent_used;
  const tableStatus = capacityStatus(usage);
  const writePath = assessWritePath(inspection, await inspectOccRetries(operations), now);
  const status = combineCapacityStatus(tableStatus, writePath.status);
  const writeRemedy =
    "capture `convex insights --details --json`, then reopen quest 377 to evaluate protocol v3 opaque event and evidence IDs";
  const tableSummary = tableCapacitySummary(nearestWall);
  const tableRemedy = capacityRemedy(nearestWall.table);
  const tableRank = statusRank(tableStatus);
  const writeRank = statusRank(writePath.status);
  const summary =
    tableRank === writeRank && tableRank > 0 && writePath.summary !== null
      ? `${tableSummary}; ${writePath.summary}`
      : writeRank > tableRank && writePath.summary !== null
        ? writePath.summary
        : tableSummary;
  const remedy =
    status === "pass"
      ? null
      : tableRank === writeRank && tableRank > 0
        ? `${tableRemedy}; also ${writeRemedy}`
        : writeRank > tableRank
          ? writeRemedy
          : tableRemedy;

  return finding({
    check: "capacity",
    details: {
      document_size_limit: {
        bytes: CONVEX_DOCUMENT_SIZE_LIMIT_BYTES,
        remedy:
          "quest 376 validates agent payloads before they reach Convex's 1 MiB document limit",
      },
      event_burn_rate: {
        events_per_day: ratePerDay,
        measurement: "bounded_recent_document_sample",
        sample: inspection.event_rate_sample,
      },
      table_capacity_basis: {
        measurement: "monotonic_display_id_upper_bound",
        note: "The indexed display-ID tail is a conservative upper bound, not a document count; sparse stores after restore may report high but cannot under-report capacity pressure.",
      },
      write_path: writePath.details,
      tables,
      thresholds: {
        error_percent: CAPACITY_ERROR_PERCENT,
        information_percent: CAPACITY_INFORMATION_PERCENT,
        warning_percent: CAPACITY_WARNING_PERCENT,
      },
    },
    remedy,
    status,
    summary,
  });
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

function noStaleClaimsFinding(truncated: boolean | undefined): DoctorFinding {
  if (truncated === true) {
    return finding({
      check: "leases",
      details: { claims: [], store_exists: true, truncated: true },
      remedy:
        "reduce accepted claims below 100 or inspect leases in the Convex dashboard, then rerun quest doctor",
      status: "warn",
      summary: "stale claims could not be ruled out because more than 100 claims are accepted",
    });
  }
  return finding({
    check: "leases",
    details: { claims: [], store_exists: true },
    remedy: null,
    status: "pass",
    summary: "no stale claims or expired leases",
  });
}

async function leaseFinding(
  operations: DoctorOperations,
  compatibility: StoreCompatibilityResult | undefined,
  compatibilityError: unknown,
  olderStoreRemedy: string | undefined,
  inspection: DoctorStoreInspection | undefined,
  inspectionError: string | undefined,
  now: string,
): Promise<DoctorFinding> {
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
  let staleClaims: readonly {
    readonly assignee: string | null;
    readonly id: number;
    readonly lease_expires_at: string | null;
    readonly reason: "expired lease" | "missing lease";
  }[];
  let staleClaimsTruncated: boolean | undefined;
  if (inspection.dump !== undefined) {
    staleClaims = inspection.dump.quests
      .filter(
        (quest) =>
          quest.status === "accepted" &&
          (quest.lease_expires_at === null ||
            Date.parse(quest.lease_expires_at) <= Date.parse(now)),
      )
      .map((quest) => ({
        assignee: quest.assignee,
        id: quest.id,
        lease_expires_at: quest.lease_expires_at,
        reason: quest.lease_expires_at === null ? "missing lease" : "expired lease",
      }));
  } else if (inspection.scope === "diagnostics" && operations.inspectStaleClaims !== undefined) {
    try {
      const inspection = await operations.inspectStaleClaims(now);
      staleClaims = inspection.claims.map((quest) => ({
        ...quest,
        reason: quest.lease_expires_at === null ? "missing lease" : "expired lease",
      }));
      staleClaimsTruncated = inspection.truncated;
    } catch (error: unknown) {
      const detail = errorDetail(error);
      return finding({
        check: "leases",
        details: { error: detail, store_exists: true },
        remedy: diagnosticReadRemedy(detail),
        status: "warn",
        summary: `stale claims could not be checked: ${detail}`,
      });
    }
  } else {
    return unavailableStoreFinding(
      "leases",
      compatibility,
      inspectionError,
      compatibilityError,
      olderStoreRemedy,
    );
  }

  if (staleClaims.length === 0) {
    return noStaleClaimsFinding(staleClaimsTruncated);
  }
  return finding({
    check: "leases",
    details: {
      claims: staleClaims,
      store_exists: true,
      ...(staleClaimsTruncated === undefined ? {} : { truncated: staleClaimsTruncated }),
    },
    remedy: "confirm no worker still owns each listed quest, then re-accept the stale quests",
    status: "fail",
    summary: `${staleClaimsTruncated === true ? "at least " : ""}${staleClaims.length} stale claim${staleClaims.length === 1 ? "" : "s"} need attention`,
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

type EvidenceInventory =
  | {
      readonly details: Record<string, unknown>;
      readonly hashes: string[];
      readonly outcome: "available";
    }
  | { readonly detail: string; readonly outcome: "error" }
  | { readonly outcome: "unavailable" };

async function readEvidenceInventory(
  operations: DoctorOperations,
  inspection: Extract<DoctorStoreInspection, { state: "present" }>,
): Promise<EvidenceInventory> {
  if (inspection.dump !== undefined) {
    const hashes = [...new Set(inspection.dump.evidence.map((item) => item.sha256))].sort();
    return { details: { total: hashes.length }, hashes, outcome: "available" };
  }
  if (inspection.scope !== "diagnostics" || operations.inspectEvidenceSample === undefined) {
    return { outcome: "unavailable" };
  }
  try {
    const sample = await operations.inspectEvidenceSample();
    return {
      details: { high_water_mark: sample.high_water_mark },
      hashes: [...sample.hashes],
      outcome: "available",
    };
  } catch (error: unknown) {
    return { detail: errorDetail(error), outcome: "error" };
  }
}

async function evidenceFinding(
  operations: DoctorOperations,
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
  const inventory = await readEvidenceInventory(operations, inspection);
  if (inventory.outcome === "unavailable") {
    return unavailableStoreFinding(
      "evidence",
      compatibility,
      inspectionError,
      compatibilityError,
      olderStoreRemedy,
    );
  }
  if (inventory.outcome === "error") {
    return finding({
      check: "evidence",
      details: { error: inventory.detail, store_exists: true },
      remedy: diagnosticReadRemedy(inventory.detail),
      status: "warn",
      summary: `evidence sample could not be read: ${inventory.detail}`,
    });
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

  const sample = inventory.hashes.slice(0, EVIDENCE_SAMPLE_SIZE);
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
      details: { failures, sample, ...inventory.details },
      remedy: "restore the listed evidence blobs from a verified backup, then rerun quest doctor",
      status: "fail",
      summary: `evidence spot-check failed for ${failures.length} of ${sample.length} sampled blob${sample.length === 1 ? "" : "s"}`,
    });
  }
  return finding({
    check: "evidence",
    details: { sample, ...inventory.details },
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

  const schema = schemaFinding(
    options.compatibility,
    options.compatibilityError,
    options.olderStoreRemedy,
    inspection,
    inspectionError,
  );
  const [backup, capacity, leases, processes, viewerTemp, evidence] = await Promise.all([
    backupFinding(options.operations, options.now),
    capacityFinding(options.operations, options.now),
    leaseFinding(
      options.operations,
      options.compatibility,
      options.compatibilityError,
      options.olderStoreRemedy,
      inspection,
      inspectionError,
      options.now,
    ),
    processFinding(options.operations),
    viewerTempFinding(options.operations, options.now),
    evidenceFinding(
      options.operations,
      options.compatibility,
      options.compatibilityError,
      options.olderStoreRemedy,
      inspection,
      inspectionError,
      options.operations.blobStore,
    ),
  ]);
  const checks = [
    schema,
    ...(capacity === undefined ? [] : [capacity]),
    backup,
    leases,
    processes,
    viewerTemp,
    evidence,
  ];
  return doctorDataSchema.parse({
    checks,
    healthy: checks.every((check) => check.status === "pass"),
  });
}
