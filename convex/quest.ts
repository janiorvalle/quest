import {
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  allocateDisplayId,
  assertActiveLeaseOwner,
  assertLeaseOwner,
  assertLifecycleActionAllowed,
  computeQuestPlan,
  findChainCyclePath,
  isDispatchableQuest,
  isLeaseExpired,
  isLegalStatusTransition,
  isValidBackfill,
  LeaseInvalidStateError,
  LifecycleInvalidStateError,
  leaseExpiry,
  materializeExpiredLease,
  signoffNotCompleteInstruction,
  statusAfterClaimRelease,
  statusForRetestVerdict,
  statusForVerdict,
  transitionRequiresLeaseOwner,
} from "../src/domain";
import {
  type AcceptQuestInput,
  type AcceptResult,
  acceptQuestInputSchema,
  type Chain,
  type ChainRemovalResult,
  type ChainResult,
  chainMutationSchema,
  chainSchema,
  type Event,
  type Evidence,
  eventFilterSchema,
  eventSchema,
  evidenceSchema,
  type LaneConflictReference,
  type NewEvidence,
  newEvidenceSchema,
  newQuestSchema,
  QUEST_INPUT_TOO_LARGE_CODE,
  type Quest,
  type QuestDump,
  type QuestTransition,
  questDumpSchema,
  questFilterSchema,
  questInputTooLargeMessage,
  questSchema,
  questScopeSchema,
  questTransitionSchema,
  type SignoffBatchInput,
  type SignoffBatchResult,
  STORE_SCHEMA_VERSION,
  signoffBatchInputSchema,
  signoffBatchResultSchema,
  stableSerialize,
  touchQuestInputSchema,
} from "../src/schema";
import type { ConvexRevisionStamp } from "../src/store/convex/client";
import { legacyReadySnapshot } from "../src/store/convex/legacy-fingerprint";
import {
  CONVEX_DUMP_PAGE_MAX_BYTES,
  CONVEX_DUMP_PAGE_MAX_ITEMS,
  CONVEX_EVENT_PAGE_MAX_BYTES,
  CONVEX_EVENT_PAGE_MAX_ITEMS,
  type ConvexDumpCursor,
  type ConvexDumpPage,
  type ConvexEventCursor,
  type ConvexEventPage,
  type ConvexListCursor,
  type ConvexListPage,
  type ConvexRestorePage,
  decodeConvexDumpCursor,
  decodeConvexEventCursor,
  decodeConvexListCursor,
  encodeConvexDumpCursor,
  encodeConvexEventCursor,
  encodeConvexListCursor,
  nextConvexDumpSection,
  parseConvexRestorePage,
} from "../src/store/convex/pagination";
import type {
  StoreCapacityInspection,
  StoreEvidenceSampleInspection,
  StoreStaleClaimsInspection,
} from "../src/store/port";
import { assertAdminSecret } from "./admin";
import { requireMemberActor, requireMemberQueryActor } from "./auth";
import type schema from "./schema";

const clientProtocolArgs = { client_protocol: v.optional(v.number()) };
const emptyArgs = clientProtocolArgs;
const failureArgs = { ...clientProtocolArgs, test_failure: v.optional(v.boolean()) };

type QuestDomainErrorCode =
  | "BACKUP_FULL_RESTORE_FENCED"
  | "CONVEX_RESTORE_IN_PROGRESS"
  | "CONVEX_RESTORE_CLEANUP_REQUIRED"
  | "CONVEX_RESTORE_PRECONDITION_FAILED"
  | "CONVEX_RESTORE_SESSION_MISSING"
  | "CONVEX_RESTORE_STAGE_CHANGED"
  | "CONVEX_RESTORE_TOKEN_REQUIRED"
  | "CONVEX_SNAPSHOT_CHANGED"
  | "CONVEX_SNAPSHOT_CURSOR_INVALID"
  | "CONVEX_MONOLITHIC_DUMP_UNSUPPORTED"
  | "MIGRATION_COMMITTED"
  | "MIGRATION_COMMITTED_STATE_CHANGED"
  | "MIGRATION_CONCURRENT_WRITE"
  | "MIGRATION_FENCE_OWNER_MISMATCH"
  | "MIGRATION_FENCE_RECOVERY_BLOCKED"
  | "MIGRATION_FENCE_STATUS_UNKNOWN"
  | "MIGRATION_REPOSITORY_FENCED"
  | "MIGRATION_REPOSITORY_REQUIRED"
  | "MIGRATION_RESTORE_TOKEN_REQUIRED"
  | "QUEST_BACKFILL_INVALID"
  | typeof QUEST_INPUT_TOO_LARGE_CODE
  | "QUEST_NOT_FOUND"
  | "SIGNOFF_EVIDENCE_OUTSIDE_BATCH"
  | "SIGNOFF_EVIDENCE_STAGE_REQUIRED"
  | "SIGNOFF_NOT_COMPLETE"
  | "SIGNOFF_TRANSITION_REQUIRED";

function failQuestDomain(code: QuestDomainErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

function parseWriteInput<Output>(schema: { parse: (input: unknown) => Output }, input: unknown) {
  try {
    return schema.parse(input);
  } catch (error: unknown) {
    const message = questInputTooLargeMessage(error);
    if (message !== undefined) {
      failQuestDomain(QUEST_INPUT_TOO_LARGE_CODE, message);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> & { readonly id?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutSystemFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Convex returned a non-object document");
  }
  const fields = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) =>
        key !== "_id" && key !== "_creationTime" && key !== "token" && key !== "page_index",
    ),
  );
  return fields;
}

function parseQuestDocument(value: unknown): Quest {
  const fields = withoutSystemFields(value);
  return questSchema.parse({
    ...fields,
    status: fields["status"] === "ready" ? "open" : fields["status"],
  });
}

function parseEvidenceDocument(value: unknown): Evidence {
  return evidenceSchema.parse(withoutSystemFields(value));
}

function parseChainDocument(value: unknown): Chain {
  return chainSchema.parse(withoutSystemFields(value));
}

function parseEventDocument(value: unknown): Event {
  return eventSchema.parse(withoutSystemFields(value));
}

function numericDocumentId(value: unknown): number | undefined {
  if (!isRecord(value) || typeof value.id !== "number") {
    return undefined;
  }
  return value.id;
}

function eventInspectionPoint(
  event: Event | null,
): { readonly at: string; readonly id: number } | null {
  return event === null ? null : { at: event.at, id: event.id };
}

function now(): string {
  return new Date().toISOString();
}

type ConvexDataModel = DataModelFromSchemaDefinition<typeof schema>;
type QueryContext = GenericQueryCtx<ConvexDataModel>;
type MutationContext = GenericMutationCtx<ConvexDataModel>;
type CounterTable = "quests" | "evidence" | "events";
type RestoreStageTable =
  | "restore_staged_quests"
  | "restore_staged_evidence"
  | "restore_staged_chains"
  | "restore_staged_events"
  | "restore_staged_pages";
const RESTORE_LEASE_DURATION_MS = 10 * 60 * 1_000;
const RESTORE_MUTATION_MAXIMUM_BYTES_READ = 2 * 1_024 * 1_024;
const RESTORE_MUTATION_MAXIMUM_ROWS_READ = 256;
const SNAPSHOT_GENERATION_COUNTER = "snapshot_generation";
const FENCE_GENERATION_COUNTER = "fence_generation";
type ConvexListMode = ConvexListCursor["mode"];
const DOCTOR_EVENT_RATE_SAMPLE_SIZE = 64;
const DOCTOR_EVIDENCE_SAMPLE_SIZE = 10;
const DOCTOR_STALE_CLAIM_SAMPLE_SIZE = 100;
const DOCTOR_MAXIMUM_BYTES_READ = 2 * 1_024 * 1_024;
const MAX_TIMESTAMP_OFFSET_HOURS = 24;

async function nextDocumentId(
  ctx: MutationContext,
  counterName: CounterTable,
  table: CounterTable,
): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", counterName))
    .unique();
  if (counter !== null) {
    const next = counter.value + 1;
    await ctx.db.patch(counter._id, { value: next });
    return next;
  }

  // The fallback initializes counters for deployments created before the counter table existed.
  const documents = await ctx.db.query(table).collect();
  const next = allocateDisplayId(
    documents.map(numericDocumentId).filter((id): id is number => id !== undefined),
  );
  await ctx.db.insert("counters", { name: counterName, value: next });
  return next;
}

async function counterHighWater(
  ctx: QueryContext,
  counterName: CounterTable,
  table: CounterTable,
): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", counterName))
    .unique();
  if (counter !== null) {
    return counter.value;
  }
  const documents = await ctx.db.query(table).collect();
  return Math.max(
    0,
    ...documents.map(numericDocumentId).filter((id): id is number => id !== undefined),
  );
}

function parseLeaseCutoff(timestamp: string): string {
  return questSchema.shape.updated_at.parse(timestamp);
}

async function readStaleClaimSample(ctx: QueryContext, leaseCutoff: string) {
  const latestPossibleLocalTime = new Date(
    Date.parse(leaseCutoff) + MAX_TIMESTAMP_OFFSET_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const candidates = await ctx.db
    .query("quests")
    .withIndex("by_status_and_lease_expires_at", (query) =>
      query.eq("status", "accepted").lte("lease_expires_at", latestPossibleLocalTime),
    )
    .order("asc")
    .paginate({
      cursor: null,
      maximumBytesRead: DOCTOR_MAXIMUM_BYTES_READ,
      maximumRowsRead: DOCTOR_STALE_CLAIM_SAMPLE_SIZE + 1,
      numItems: DOCTOR_STALE_CLAIM_SAMPLE_SIZE + 1,
    });
  return {
    documents: candidates.page,
    truncated: !candidates.isDone,
  };
}

async function readQuests(ctx: QueryContext, timestamp: string): Promise<Quest[]> {
  const documents = await ctx.db.query("quests").collect();
  return documents
    .map(parseQuestDocument)
    .map((quest) => materializeExpiredLease(quest, timestamp))
    .sort((left, right) => left.id - right.id);
}

async function findQuestRecord(ctx: QueryContext, id: number) {
  return ctx.db
    .query("quests")
    .withIndex("by_display_id", (query) => query.eq("id", id))
    .unique();
}

async function requireQuestRecord(ctx: QueryContext, id: number) {
  const document = await findQuestRecord(ctx, id);
  if (document === null) {
    return failQuestDomain(
      "QUEST_NOT_FOUND",
      `quest ${id} does not exist; check the display ID and retry`,
    );
  }
  return document;
}

async function readEvidence(ctx: QueryContext): Promise<Evidence[]> {
  const documents = await ctx.db.query("evidence").collect();
  return documents.map(parseEvidenceDocument).sort((left, right) => left.id - right.id);
}

async function readQuestEvidence(ctx: QueryContext, questId: number): Promise<Evidence[]> {
  const documents = await ctx.db
    .query("evidence")
    .withIndex("by_quest_id", (query) => query.eq("quest_id", questId))
    .collect();
  return documents.map(parseEvidenceDocument).sort((left, right) => left.id - right.id);
}

async function readChains(ctx: QueryContext): Promise<Chain[]> {
  const documents = await ctx.db.query("chains").collect();
  return documents
    .map(parseChainDocument)
    .sort(
      (left, right) =>
        left.quest_id - right.quest_id ||
        left.target_id - right.target_id ||
        left.type.localeCompare(right.type),
    );
}

async function readEvents(ctx: QueryContext): Promise<Event[]> {
  const documents = await ctx.db.query("events").collect();
  return documents.map(parseEventDocument).sort((left, right) => left.id - right.id);
}

async function readQuestEvents(ctx: QueryContext, questId: number): Promise<Event[]> {
  const documents = await ctx.db
    .query("events")
    .withIndex("by_quest_id", (query) => query.eq("quest_id", questId))
    .collect();
  return documents.map(parseEventDocument).sort((left, right) => left.id - right.id);
}

async function readQuestChains(ctx: QueryContext, questId: number): Promise<Chain[]> {
  const [outgoing, incoming] = await Promise.all([
    ctx.db
      .query("chains")
      .withIndex("by_quest_id", (query) => query.eq("quest_id", questId))
      .collect(),
    ctx.db
      .query("chains")
      .withIndex("by_target_id", (query) => query.eq("target_id", questId))
      .collect(),
  ]);
  const unique = new Map(
    [...outgoing, ...incoming].map((document) => {
      const chain = parseChainDocument(document);
      return [`${chain.quest_id}:${chain.target_id}:${chain.type}`, chain] as const;
    }),
  );
  return [...unique.values()].sort(
    (left, right) =>
      left.quest_id - right.quest_id ||
      left.target_id - right.target_id ||
      left.type.localeCompare(right.type),
  );
}

function findQuestInSnapshot(quests: readonly Quest[], id: number): Quest | undefined {
  return quests.find((quest) => quest.id === id);
}

function requireQuestInSnapshot(quests: readonly Quest[], id: number): Quest {
  const quest = findQuestInSnapshot(quests, id);
  if (quest === undefined) {
    return failQuestDomain(
      "QUEST_NOT_FOUND",
      `quest ${id} does not exist; check the display ID and retry`,
    );
  }
  return quest;
}

function hasGuildMismatch(
  quest: Quest,
  sessionGuild: string | null | undefined,
  force: boolean | undefined,
): boolean {
  return quest.guild !== null && quest.guild !== (sessionGuild ?? null) && force !== true;
}

function isUnclaimedDispatchable(quest: Quest): boolean {
  return quest.assignee === null && isDispatchableQuest(quest);
}

function requireStatusTransition(
  current: Quest,
  expectedFrom: Quest["status"],
  target: Quest["status"],
): void {
  if (current.status !== expectedFrom || !isLegalStatusTransition(current.status, target)) {
    throw new Error(`illegal quest transition: ${current.status} -> ${target}`);
  }
}

function renewLease(quest: Quest, timestamp: string, leaseTtlMinutes?: number): Quest {
  return questSchema.parse({
    ...quest,
    lease_expires_at: leaseExpiry(timestamp, leaseTtlMinutes),
    updated_at: timestamp,
  });
}

function hasAcceptedEvent(events: readonly Event[], id: number, actor: string): boolean {
  return events.some(
    (event) => event.quest_id === id && event.action === "accept" && event.actor === actor,
  );
}

function applyVerdict(
  current: Quest,
  transition: Extract<QuestTransition, { action: "verdict" }>,
  timestamp: string,
): Quest {
  const status = transition.retest
    ? statusForRetestVerdict(transition.verdict)
    : statusForVerdict(transition.verdict);
  return questSchema.parse({
    ...current,
    assignee: null,
    status,
    verdict: transition.verdict,
    verdict_notes: transition.notes,
    lease_expires_at: null,
    updated_at: timestamp,
  });
}

function applyCancel(
  current: Quest,
  transition: Extract<QuestTransition, { action: "cancel" }>,
  timestamp: string,
): Quest {
  requireStatusTransition(current, current.status, "dropped");
  return questSchema.parse({
    ...current,
    assignee: null,
    lease_expires_at: null,
    status: "dropped",
    verdict: current.kind === "bug" ? "wont-do" : null,
    verdict_notes: transition.reason,
    updated_at: timestamp,
  });
}

function applyReopen(
  current: Quest,
  transition: Extract<QuestTransition, { action: "reopen" }>,
  timestamp: string,
): Quest {
  const reopenedStatus = statusAfterClaimRelease();
  requireStatusTransition(current, current.status, reopenedStatus);
  return questSchema.parse({
    ...current,
    assignee: null,
    lease_expires_at: null,
    status: reopenedStatus,
    verdict: current.status === "dropped" ? null : current.verdict,
    verdict_notes: transition.notes,
    reopen_count: current.reopen_count + 1,
    updated_at: timestamp,
  });
}

function applyUpdate(
  current: Quest,
  transition: Extract<QuestTransition, { action: "update" }>,
  timestamp: string,
): Quest {
  return questSchema.parse({
    ...current,
    title: transition.changes.title ?? current.title,
    description: transition.changes.description ?? current.description,
    area: transition.changes.area === undefined ? current.area : transition.changes.area,
    guild: transition.changes.guild === undefined ? current.guild : transition.changes.guild,
    priority: transition.changes.priority ?? current.priority,
    verdict_notes:
      transition.changes.verdict_notes === undefined
        ? current.verdict_notes
        : transition.changes.verdict_notes,
    predicted_files: transition.changes.predicted_files ?? current.predicted_files,
    lease_expires_at:
      current.status === "accepted" && current.assignee !== null
        ? leaseExpiry(timestamp, transition.lease_ttl_minutes)
        : current.lease_expires_at,
    updated_at: timestamp,
  });
}

function applyTransition(current: Quest, transition: QuestTransition, timestamp: string): Quest {
  assertLifecycleActionAllowed(current, transition.action);
  switch (transition.action) {
    case "abandon": {
      const releasedStatus = statusAfterClaimRelease();
      requireStatusTransition(current, "accepted", releasedStatus);
      return questSchema.parse({
        ...current,
        assignee: null,
        lease_expires_at: null,
        status: releasedStatus,
        updated_at: timestamp,
      });
    }
    case "verdict":
      return applyVerdict(current, transition, timestamp);
    case "turnin":
      requireStatusTransition(current, "accepted", "turned_in");
      return questSchema.parse({
        ...current,
        status: "turned_in",
        lease_expires_at: null,
        pr: transition.pr,
        updated_at: timestamp,
      });
    case "complete":
      requireStatusTransition(current, "turned_in", "complete");
      return questSchema.parse({
        ...current,
        status: "complete",
        lease_expires_at: null,
        updated_at: timestamp,
      });
    case "signoff":
      return current;
    case "cancel":
      return applyCancel(current, transition, timestamp);
    case "reopen":
      return applyReopen(current, transition, timestamp);
    case "update":
      return applyUpdate(current, transition, timestamp);
  }
}

function applyDomainGuardForMutation<Result>(guard: () => Result): Result {
  try {
    return guard();
  } catch (error: unknown) {
    if (error instanceof LifecycleInvalidStateError || error instanceof LeaseInvalidStateError) {
      throw new ConvexError({ code: error.code, message: error.receiverMessage });
    }
    throw error;
  }
}

function applyTransitionForMutation(
  current: Quest,
  transition: QuestTransition,
  timestamp: string,
): Quest {
  return applyDomainGuardForMutation(() => applyTransition(current, transition, timestamp));
}

async function appendEvent(
  ctx: MutationContext,
  questId: number,
  timestamp: string,
  actor: string,
  action: Event["action"],
  detail: unknown,
  testFailure: boolean | undefined,
): Promise<void> {
  const parsed = eventSchema.parse({
    id: await nextDocumentId(ctx, "events", "events"),
    quest_id: questId,
    at: timestamp,
    actor,
    action,
    detail,
  });
  if (testFailure === true) {
    throw new Error("test event append failure requested");
  }
  await ctx.db.insert("events", parsed);
  const quest = parseQuestDocument(await requireQuestRecord(ctx, questId));
  await advanceSnapshotGeneration(ctx, new Set([quest.repo]));
}

async function bumpRepositoryRevision(ctx: MutationContext, repository: string): Promise<void> {
  const revision = await ctx.db
    .query("repository_revisions")
    .withIndex("by_repo", (query) => query.eq("repo", repository))
    .unique();
  if (revision === null) {
    await ctx.db.insert("repository_revisions", { repo: repository, value: 1 });
  } else {
    await ctx.db.patch(revision._id, { value: revision.value + 1 });
  }
}

async function addDuplicateLink(
  ctx: MutationContext,
  questId: number,
  transition: Extract<QuestTransition, { action: "verdict" }>,
  timestamp: string,
): Promise<void> {
  if (transition.duplicate_of === null) {
    return;
  }
  const duplicateLink = chainSchema.parse({
    quest_id: questId,
    target_id: transition.duplicate_of,
    type: "duplicate-of",
  });
  requireQuestInSnapshot(await readQuests(ctx, timestamp), duplicateLink.target_id);
  const chains = await readChains(ctx);
  const alreadyPresent = chains.some(
    (link) =>
      link.quest_id === duplicateLink.quest_id &&
      link.target_id === duplicateLink.target_id &&
      link.type === duplicateLink.type,
  );
  if (!alreadyPresent) {
    // Duplicate links are references; the frozen domain contract checks cycles only for requires links.
    await ctx.db.insert("chains", duplicateLink);
  }
}

async function removeDuplicateLinks(
  ctx: MutationContext,
  questId: number,
  transition: Extract<QuestTransition, { action: "reopen" }>,
  timestamp: string,
  testFailure: boolean | undefined,
): Promise<void> {
  const chains = await readChains(ctx);
  const records = await ctx.db.query("chains").collect();
  for (const link of chains) {
    if (link.quest_id !== questId || link.type !== "duplicate-of") {
      continue;
    }
    const duplicateRecord = records.find(
      (document) =>
        document.quest_id === link.quest_id &&
        document.target_id === link.target_id &&
        document.type === link.type,
    );
    if (duplicateRecord !== undefined) {
      const duplicateTarget = await requireQuestRecord(ctx, link.target_id);
      await requireRepositoryNotFenced(ctx, parseQuestDocument(duplicateTarget).repo);
      await ctx.db.delete(duplicateRecord._id);
    }
    await appendEvent(
      ctx,
      questId,
      timestamp,
      transition.actor,
      "chain",
      {
        operation: "remove",
        link,
        session_guild: transition.session_guild ?? null,
      },
      testFailure,
    );
  }
}

async function createQuestDump(ctx: QueryContext, quests: readonly Quest[]): Promise<QuestDump> {
  const dump = {
    schema_version: STORE_SCHEMA_VERSION,
    quests: [...quests],
    evidence: await readEvidence(ctx),
    chains: await readChains(ctx),
    events: await readEvents(ctx),
  } satisfies QuestDump;
  return questDumpSchema.parse(dump);
}

async function exportDump(ctx: QueryContext, timestamp: string): Promise<QuestDump> {
  return createQuestDump(ctx, await readQuests(ctx, timestamp));
}

async function eventSequenceHighWater(ctx: QueryContext): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", "events"))
    .unique();
  if (counter !== null) {
    return counter.value;
  }
  const lastEvent = await ctx.db.query("events").withIndex("by_display_id").order("desc").first();
  return lastEvent === null ? 0 : parseEventDocument(lastEvent).id;
}

async function snapshotGeneration(ctx: QueryContext): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", SNAPSHOT_GENERATION_COUNTER))
    .unique();
  return counter?.value ?? eventSequenceHighWater(ctx);
}

async function fenceGeneration(ctx: QueryContext): Promise<number> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", FENCE_GENERATION_COUNTER))
    .unique();
  return counter?.value ?? 0;
}

async function advanceFenceGeneration(ctx: MutationContext): Promise<void> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", FENCE_GENERATION_COUNTER))
    .unique();
  if (counter === null) {
    await ctx.db.insert("counters", { name: FENCE_GENERATION_COUNTER, value: 1 });
  } else {
    await ctx.db.patch(counter._id, { value: counter.value + 1 });
  }
}

async function advanceSnapshotGeneration(
  ctx: MutationContext,
  repositories: ReadonlySet<string>,
): Promise<void> {
  const counter = await ctx.db
    .query("counters")
    .withIndex("by_name", (query) => query.eq("name", SNAPSHOT_GENERATION_COUNTER))
    .unique();
  if (counter === null) {
    await ctx.db.insert("counters", {
      name: SNAPSHOT_GENERATION_COUNTER,
      value: (await eventSequenceHighWater(ctx)) + 1,
    });
  } else {
    await ctx.db.patch(counter._id, { value: counter.value + 1 });
  }
  for (const repository of repositories) {
    await bumpRepositoryRevision(ctx, repository);
  }
}

async function activeFencedRepositories(ctx: QueryContext): Promise<string[]> {
  return (await ctx.db.query("migration_fences").collect())
    .filter((fence) => fence.unfenced !== true)
    .map((fence) => fence.repo)
    .sort();
}

async function requireNoPartialRestore(ctx: QueryContext): Promise<void> {
  const restoreLease = await findRestoreLease(ctx);
  if (restoreLease?.commit_phase !== undefined && restoreLease.committed !== true) {
    failQuestDomain(
      "CONVEX_RESTORE_IN_PROGRESS",
      "a paginated Convex restore is committing; retry this read after the restore finishes",
    );
  }
}

async function createDumpCursor(
  ctx: QueryContext,
  leaseCutoff: string,
  raw: boolean,
  fencedRepositories?: readonly string[],
): Promise<string> {
  await requireNoPartialRestore(ctx);
  return encodeConvexDumpCursor({
    version: 1,
    section: "quests",
    database_cursor: null,
    event_high_water: await snapshotGeneration(ctx),
    lease_cutoff: leaseCutoff,
    raw,
    ...(fencedRepositories === undefined ? {} : { fenced_repositories: [...fencedRepositories] }),
  });
}

function parseDumpCursor(cursor: string): ConvexDumpCursor {
  try {
    return decodeConvexDumpCursor(cursor);
  } catch {
    return failQuestDomain(
      "CONVEX_SNAPSHOT_CURSOR_INVALID",
      "the Convex snapshot cursor is invalid or belongs to another deployment; restart the export and retry with the first cursor it returns",
    );
  }
}

async function requireStableDumpCursor(
  ctx: QueryContext,
  cursor: ConvexDumpCursor,
  leaseCutoff: string,
  raw: boolean,
  fencedRepositories?: readonly string[],
): Promise<void> {
  await requireNoPartialRestore(ctx);
  if (cursor.lease_cutoff !== leaseCutoff || cursor.raw !== raw) {
    failQuestDomain(
      "CONVEX_SNAPSHOT_CURSOR_INVALID",
      "the Convex snapshot cursor does not match this export; restart the export and keep its cursor with the same export mode and lease cutoff",
    );
  }
  if ((await snapshotGeneration(ctx)) !== cursor.event_high_water) {
    failQuestDomain(
      "CONVEX_SNAPSHOT_CHANGED",
      "the Convex store changed while its paginated snapshot was being read; restart the export to capture one complete consistency point",
    );
  }
  if (fencedRepositories !== undefined) {
    if (stableSerialize(cursor.fenced_repositories ?? []) !== stableSerialize(fencedRepositories)) {
      failQuestDomain(
        "CONVEX_SNAPSHOT_CHANGED",
        "Convex repository fences changed while the federated snapshot was being read; restart the read to capture one complete consistency point",
      );
    }
  }
}

function nextDumpCursor(
  cursor: ConvexDumpCursor,
  continueCursor: string,
  isDone: boolean,
): string | null {
  const nextSection = isDone ? nextConvexDumpSection(cursor.section) : cursor.section;
  if (nextSection === undefined) {
    return null;
  }
  return encodeConvexDumpCursor({
    ...cursor,
    section: nextSection,
    database_cursor: isDone ? null : continueCursor,
  });
}

const dumpPaginationOptions = (cursor: string | null) => ({
  cursor,
  maximumBytesRead: CONVEX_DUMP_PAGE_MAX_BYTES,
  maximumRowsRead: CONVEX_DUMP_PAGE_MAX_ITEMS,
  numItems: CONVEX_DUMP_PAGE_MAX_ITEMS,
});

const eventPaginationOptions = (cursor: string | null) => ({
  cursor,
  maximumBytesRead: CONVEX_EVENT_PAGE_MAX_BYTES,
  maximumRowsRead: CONVEX_EVENT_PAGE_MAX_ITEMS,
  numItems: CONVEX_EVENT_PAGE_MAX_ITEMS,
});

type ParsedEventFilter = ReturnType<typeof eventFilterSchema.parse>;

function eventMatchesFilter(
  event: Event,
  quest: Quest | undefined,
  filter: ParsedEventFilter,
): boolean {
  return (
    quest !== undefined &&
    (filter.repo === undefined || quest.repo === filter.repo) &&
    (filter.quest_id === undefined || event.quest_id === filter.quest_id) &&
    (filter.after_id === undefined || event.id > filter.after_id) &&
    (filter.since === undefined || Date.parse(event.at) >= Date.parse(filter.since)) &&
    (filter.until === undefined || Date.parse(event.at) <= Date.parse(filter.until)) &&
    (filter.actor === undefined || event.actor === filter.actor) &&
    (filter.action === undefined || event.action === filter.action) &&
    (filter.area === undefined || quest.area === filter.area)
  );
}

async function readLegacyEventQuery(
  ctx: QueryContext,
  filter: ParsedEventFilter,
): Promise<Event[]> {
  const documents =
    filter.after_id === undefined
      ? await ctx.db.query("events").collect()
      : await ctx.db
          .query("events")
          .withIndex("by_display_id", (query) => query.gt("id", filter.after_id ?? 0))
          .order("asc")
          .collect();
  const events = documents.map(parseEventDocument).sort((left, right) => left.id - right.id);
  const questsById = await questsForEvents(ctx, events);
  return events.filter((event) =>
    eventMatchesFilter(event, questsById.get(event.quest_id), filter),
  );
}

async function questsForEvents(
  ctx: QueryContext,
  events: readonly Event[],
): Promise<ReadonlyMap<number, Quest>> {
  const questIds = [...new Set(events.map((event) => event.quest_id))];
  const quests = await Promise.all(questIds.map((id) => findQuestRecord(ctx, id)));
  return new Map(
    quests.flatMap((quest) =>
      quest === null ? [] : ([[quest.id, parseQuestDocument(quest)]] as const),
    ),
  );
}

function parseEventCursor(cursor: string): ConvexEventCursor {
  try {
    return decodeConvexEventCursor(cursor);
  } catch {
    return failQuestDomain(
      "CONVEX_SNAPSHOT_CURSOR_INVALID",
      "the Convex event cursor is invalid or belongs to another deployment; restart the event read and retry with the first cursor it returns",
    );
  }
}

async function eventCursor(ctx: QueryContext, cursor: string | null): Promise<ConvexEventCursor> {
  const parsed =
    cursor === null
      ? {
          version: 1 as const,
          database_cursor: null,
          snapshot_generation: await snapshotGeneration(ctx),
        }
      : parseEventCursor(cursor);
  if ((await snapshotGeneration(ctx)) !== parsed.snapshot_generation) {
    failQuestDomain(
      "CONVEX_SNAPSHOT_CHANGED",
      "the Convex store changed while its paginated events were being read; restart the event read to capture one complete consistency point",
    );
  }
  return parsed;
}

async function readEventQueryPage(
  ctx: QueryContext,
  filter: ParsedEventFilter,
  encodedCursor: string | null,
): Promise<ConvexEventPage> {
  const cursor = await eventCursor(ctx, encodedCursor);
  const result = await ctx.db
    .query("events")
    .withIndex("by_display_id", (query) =>
      filter.after_id === undefined ? query : query.gt("id", filter.after_id),
    )
    .order("asc")
    .paginate(eventPaginationOptions(cursor.database_cursor));
  const events = result.page.map(parseEventDocument);
  const questsById = await questsForEvents(ctx, events);
  const items = events.filter((event) =>
    eventMatchesFilter(event, questsById.get(event.quest_id), filter),
  );
  return {
    items,
    next_cursor: result.isDone
      ? null
      : encodeConvexEventCursor({
          ...cursor,
          database_cursor: result.continueCursor,
        }),
  };
}

async function readDumpPage(ctx: QueryContext, cursor: ConvexDumpCursor): Promise<ConvexDumpPage> {
  switch (cursor.section) {
    case "quests": {
      const result = await ctx.db
        .query("quests")
        .withIndex("by_display_id")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      const items = result.page
        .map(parseQuestDocument)
        .map((quest) => (cursor.raw ? quest : materializeExpiredLease(quest, cursor.lease_cutoff)));
      return {
        section: "quests",
        items,
        next_cursor: nextDumpCursor(cursor, result.continueCursor, result.isDone),
        event_high_water: cursor.event_high_water,
      };
    }
    case "evidence": {
      const result = await ctx.db
        .query("evidence")
        .withIndex("by_display_id")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      return {
        section: "evidence",
        items: result.page.map(parseEvidenceDocument),
        next_cursor: nextDumpCursor(cursor, result.continueCursor, result.isDone),
        event_high_water: cursor.event_high_water,
      };
    }
    case "chains": {
      const result = await ctx.db
        .query("chains")
        .withIndex("by_link")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      return {
        section: "chains",
        items: result.page.map(parseChainDocument),
        next_cursor: nextDumpCursor(cursor, result.continueCursor, result.isDone),
        event_high_water: cursor.event_high_water,
      };
    }
    case "events": {
      const result = await ctx.db
        .query("events")
        .withIndex("by_display_id")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      return {
        section: "events",
        items: result.page.map(parseEventDocument),
        next_cursor: nextDumpCursor(cursor, result.continueCursor, result.isDone),
        event_high_water: cursor.event_high_water,
      };
    }
  }
}

function firstListSection(mode: ConvexListMode): ConvexListCursor["section"] {
  return mode === "fences" ? "fences" : "quests";
}

function nextListSection(
  mode: ConvexListMode,
  section: ConvexListCursor["section"],
): ConvexListCursor["section"] | undefined {
  switch (mode) {
    case "stats":
    case "fences":
      return undefined;
    case "list":
      return section === "quests" ? "chains" : undefined;
    case "federated":
      if (section === "quests") {
        return "chains";
      }
      return section === "chains" ? "fences" : undefined;
  }
}

async function createListCursor(
  ctx: QueryContext,
  mode: ConvexListMode,
  leaseCutoff: string,
  requestKey: string,
): Promise<ConvexListCursor> {
  await requireNoPartialRestore(ctx);
  return {
    version: 1,
    mode,
    section: firstListSection(mode),
    database_cursor: null,
    snapshot_generation: await snapshotGeneration(ctx),
    fence_generation: await fenceGeneration(ctx),
    lease_cutoff: leaseCutoff,
    request_key: requestKey,
  };
}

function parseListCursor(cursor: string): ConvexListCursor {
  try {
    return decodeConvexListCursor(cursor);
  } catch {
    return failQuestDomain(
      "CONVEX_SNAPSHOT_CURSOR_INVALID",
      "the Convex list cursor is invalid or belongs to another deployment; restart the read and retry with the first cursor it returns",
    );
  }
}

async function requireStableListCursor(
  ctx: QueryContext,
  cursor: ConvexListCursor,
  mode: ConvexListMode,
  leaseCutoff: string,
  requestKey: string,
): Promise<void> {
  await requireNoPartialRestore(ctx);
  if (
    cursor.mode !== mode ||
    cursor.lease_cutoff !== leaseCutoff ||
    cursor.request_key !== requestKey
  ) {
    failQuestDomain(
      "CONVEX_SNAPSHOT_CURSOR_INVALID",
      "the Convex list cursor does not match this read; restart the read and keep its cursor with the same filter and lease cutoff",
    );
  }
  if ((await snapshotGeneration(ctx)) !== cursor.snapshot_generation) {
    failQuestDomain(
      "CONVEX_SNAPSHOT_CHANGED",
      "the Convex store changed while its paginated list was being read; restart the read to capture one complete consistency point",
    );
  }
  if ((await fenceGeneration(ctx)) !== cursor.fence_generation) {
    failQuestDomain(
      "CONVEX_SNAPSHOT_CHANGED",
      "Convex repository fences changed while its paginated list was being read; restart the read to capture one complete consistency point",
    );
  }
}

function nextListCursor(
  cursor: ConvexListCursor,
  continueCursor: string,
  isDone: boolean,
): string | null {
  const section = isDone ? nextListSection(cursor.mode, cursor.section) : cursor.section;
  if (section === undefined) {
    return null;
  }
  return encodeConvexListCursor({
    ...cursor,
    section,
    database_cursor: isDone ? null : continueCursor,
  });
}

async function readListPage(ctx: QueryContext, cursor: ConvexListCursor): Promise<ConvexListPage> {
  switch (cursor.section) {
    case "quests": {
      const result = await ctx.db
        .query("quests")
        .withIndex("by_display_id")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      return {
        section: "quests",
        items: result.page
          .map(parseQuestDocument)
          .map((quest) => materializeExpiredLease(quest, cursor.lease_cutoff)),
        next_cursor: nextListCursor(cursor, result.continueCursor, result.isDone),
        snapshot_generation: cursor.snapshot_generation,
      };
    }
    case "chains": {
      const result = await ctx.db
        .query("chains")
        .withIndex("by_link")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      return {
        section: "chains",
        items: result.page.map(parseChainDocument),
        next_cursor: nextListCursor(cursor, result.continueCursor, result.isDone),
        snapshot_generation: cursor.snapshot_generation,
      };
    }
    case "fences": {
      const result = await ctx.db
        .query("migration_fences")
        .withIndex("by_repo")
        .order("asc")
        .paginate(dumpPaginationOptions(cursor.database_cursor));
      return {
        section: "fences",
        items: result.page.filter((fence) => fence.unfenced !== true).map((fence) => fence.repo),
        next_cursor: nextListCursor(cursor, result.continueCursor, result.isDone),
        snapshot_generation: cursor.snapshot_generation,
      };
    }
  }
}

async function listPageFor(
  ctx: QueryContext,
  input: {
    readonly cursor: string | undefined;
    readonly leaseCutoff: string;
    readonly mode: ConvexListMode;
    readonly requestKey: string;
  },
): Promise<ConvexListPage> {
  const cursor =
    input.cursor === undefined
      ? await createListCursor(ctx, input.mode, input.leaseCutoff, input.requestKey)
      : parseListCursor(input.cursor);
  await requireStableListCursor(ctx, cursor, input.mode, input.leaseCutoff, input.requestKey);
  return readListPage(ctx, cursor);
}

function hardLaneConflictsForQuest(
  quests: readonly Quest[],
  questId: number,
  timestamp: string,
): Array<{ readonly files: string[]; readonly quest_id: number }> {
  const plan = computeQuestPlan({ chains: [], now: timestamp, quests });
  const inFlightQuestIds = new Set(
    plan.quests.filter((quest) => quest.computed_state === "in_flight").map((quest) => quest.id),
  );
  const planQuestsById = new Map(plan.quests.map((quest) => [quest.id, quest]));
  const candidate = planQuestsById.get(questId);
  if (candidate === undefined) {
    return [];
  }
  const conflicts = new Map<string, { readonly files: string[]; readonly quest_id: number }>();
  for (const cluster of plan.lane_clusters) {
    if (cluster.kind !== "shared_files" || !cluster.quest_ids.includes(questId)) {
      continue;
    }
    for (const candidateId of cluster.quest_ids) {
      const inFlight = planQuestsById.get(candidateId);
      if (
        candidateId === questId ||
        !inFlightQuestIds.has(candidateId) ||
        inFlight === undefined ||
        inFlight.repo !== candidate.repo
      ) {
        continue;
      }
      const conflict = { files: [...cluster.files], quest_id: candidateId };
      conflicts.set(`${candidateId}:${cluster.files.join("\0")}`, conflict);
    }
  }
  return [...conflicts.values()].sort(
    (left, right) =>
      left.quest_id - right.quest_id || left.files.join("\0").localeCompare(right.files.join("\0")),
  );
}

async function readLaneConflictQuests(
  ctx: MutationContext,
  current: Quest,
  timestamp: string,
): Promise<Quest[]> {
  // ISO offsets can put an active lease on the preceding calendar day. Search one full
  // offset window, then compare instants so legacy non-UTC timestamps remain correct.
  const earliestPossibleActiveLease = new Date(
    Date.parse(timestamp) - 24 * 60 * 60 * 1_000,
  ).toISOString();
  const documents = await ctx.db
    .query("quests")
    .withIndex("by_repo_status_and_lease_expiry", (query) =>
      query
        .eq("repo", current.repo)
        .eq("status", "accepted")
        .gt("lease_expires_at", earliestPossibleActiveLease),
    )
    .collect();
  return [
    current,
    ...documents
      .map(parseQuestDocument)
      .filter(
        (quest) => quest.id !== current.id && !isLeaseExpired(quest.lease_expires_at, timestamp),
      ),
  ].sort((left, right) => left.id - right.id);
}

function laneConflictsMatch(
  actual: readonly LaneConflictReference[],
  acknowledged: readonly LaneConflictReference[],
): boolean {
  if (actual.length !== acknowledged.length) {
    return false;
  }
  const key = (conflict: LaneConflictReference) =>
    `${conflict.quest_id}:${[...conflict.files].sort().join("\0")}`;
  const acknowledgedKeys = new Set(acknowledged.map(key));
  return actual.every((conflict) => acknowledgedKeys.has(key(conflict)));
}

async function unacknowledgedLaneConflict(
  ctx: MutationContext,
  input: AcceptQuestInput,
  timestamp: string,
  current: Quest,
): Promise<Extract<AcceptResult, { outcome: "lane-conflict" | "lane-conflict-stale" }> | null> {
  if (input.lane_conflict_guard !== true || input.lane_conflict_override === true) {
    return null;
  }
  const laneConflicts = hardLaneConflictsForQuest(
    await readLaneConflictQuests(ctx, current, timestamp),
    input.id,
    timestamp,
  );
  if (laneConflictsMatch(laneConflicts, input.lane_conflict_acknowledged ?? [])) {
    return null;
  }
  return {
    outcome: laneConflicts.length > 0 ? "lane-conflict" : "lane-conflict-stale",
    lane_conflicts: laneConflicts,
    lease_expires_at: current.lease_expires_at,
    quest: current,
  };
}

function restoreMutationPaginationOptions() {
  return {
    cursor: null,
    maximumBytesRead: RESTORE_MUTATION_MAXIMUM_BYTES_READ,
    maximumRowsRead: RESTORE_MUTATION_MAXIMUM_ROWS_READ,
    numItems: RESTORE_MUTATION_MAXIMUM_ROWS_READ,
  };
}

async function requireRestoreStageEmpty(
  ctx: MutationContext,
  token: string,
  retryAction: string,
): Promise<void> {
  const tables: readonly RestoreStageTable[] = [
    "restore_staged_pages",
    "restore_staged_events",
    "restore_staged_chains",
    "restore_staged_evidence",
    "restore_staged_quests",
  ];
  for (const table of tables) {
    const document = await ctx.db
      .query(table)
      .withIndex("by_token", (query) => query.eq("token", token))
      .first();
    if (document !== null) {
      failQuestDomain(
        "CONVEX_RESTORE_CLEANUP_REQUIRED",
        `Convex restore ${token} still has staged pages; call releaseRestore with that token until it succeeds, then ${retryAction}`,
      );
    }
  }
}

async function clearRestoreStagePage(ctx: MutationContext, token: string): Promise<boolean> {
  const tables: readonly RestoreStageTable[] = [
    "restore_staged_pages",
    "restore_staged_events",
    "restore_staged_chains",
    "restore_staged_evidence",
    "restore_staged_quests",
  ];
  for (const table of tables) {
    const firstDocument = await ctx.db
      .query(table)
      .withIndex("by_token", (query) => query.eq("token", token))
      .first();
    if (firstDocument === null) {
      continue;
    }
    const { page: documents } = await ctx.db
      .query(table)
      .withIndex("by_token", (query) => query.eq("token", token))
      .paginate(restoreMutationPaginationOptions());
    for (const document of documents) {
      await ctx.db.delete(document._id);
    }
    return false;
  }
  return true;
}

function requireMatchingStagedItem(existing: unknown, expected: unknown, pageIndex: number): void {
  if (
    !isRecord(existing) ||
    existing["page_index"] !== pageIndex ||
    stableSerialize(withoutSystemFields(existing)) !== stableSerialize(expected)
  ) {
    failQuestDomain(
      "CONVEX_RESTORE_STAGE_CHANGED",
      "a Convex restore page conflicts with data already uploaded for this session; roll back this restore, start a new session, and upload one unchanged snapshot",
    );
  }
}

async function stageRestoreQuests(
  ctx: MutationContext,
  token: string,
  pageIndex: number,
  items: readonly QuestDump["quests"][number][],
): Promise<void> {
  for (const item of items) {
    const existing = await ctx.db
      .query("restore_staged_quests")
      .withIndex("by_token_and_id", (query) => query.eq("token", token).eq("id", item.id))
      .unique();
    if (existing === null) {
      await ctx.db.insert("restore_staged_quests", { token, page_index: pageIndex, ...item });
    } else {
      requireMatchingStagedItem(existing, item, pageIndex);
    }
  }
}

async function stageRestoreEvidence(
  ctx: MutationContext,
  token: string,
  pageIndex: number,
  items: readonly QuestDump["evidence"][number][],
): Promise<void> {
  for (const item of items) {
    const existing = await ctx.db
      .query("restore_staged_evidence")
      .withIndex("by_token_and_id", (query) => query.eq("token", token).eq("id", item.id))
      .unique();
    if (existing === null) {
      await ctx.db.insert("restore_staged_evidence", { token, page_index: pageIndex, ...item });
    } else {
      requireMatchingStagedItem(existing, item, pageIndex);
    }
  }
}

async function stageRestoreChains(
  ctx: MutationContext,
  token: string,
  pageIndex: number,
  items: readonly QuestDump["chains"][number][],
): Promise<void> {
  for (const item of items) {
    const existing = await ctx.db
      .query("restore_staged_chains")
      .withIndex("by_token_and_link", (query) =>
        query
          .eq("token", token)
          .eq("quest_id", item.quest_id)
          .eq("target_id", item.target_id)
          .eq("type", item.type),
      )
      .unique();
    if (existing === null) {
      await ctx.db.insert("restore_staged_chains", { token, page_index: pageIndex, ...item });
    } else {
      requireMatchingStagedItem(existing, item, pageIndex);
    }
  }
}

async function stageRestoreEvents(
  ctx: MutationContext,
  token: string,
  pageIndex: number,
  items: readonly QuestDump["events"][number][],
): Promise<void> {
  for (const item of items) {
    const existing = await ctx.db
      .query("restore_staged_events")
      .withIndex("by_token_and_id", (query) => query.eq("token", token).eq("id", item.id))
      .unique();
    if (existing === null) {
      await ctx.db.insert("restore_staged_events", { token, page_index: pageIndex, ...item });
    } else {
      requireMatchingStagedItem(existing, item, pageIndex);
    }
  }
}

async function stageRestorePage(
  ctx: MutationContext,
  token: string,
  value: unknown,
): Promise<void> {
  let page: ConvexRestorePage;
  try {
    page = parseConvexRestorePage(value);
  } catch {
    return failQuestDomain(
      "CONVEX_SNAPSHOT_CURSOR_INVALID",
      "the Convex restore page is invalid; rebuild the backup with the current Quest CLI and retry the restore",
    );
  }
  switch (page.section) {
    case "quests":
      await stageRestoreQuests(ctx, token, page.page_index, page.items);
      break;
    case "evidence":
      await stageRestoreEvidence(ctx, token, page.page_index, page.items);
      break;
    case "chains":
      await stageRestoreChains(ctx, token, page.page_index, page.items);
      break;
    case "events":
      await stageRestoreEvents(ctx, token, page.page_index, page.items);
      break;
  }
  const pageHash = await snapshotFingerprint(page);
  const highWater = page.items.reduce((highest, item) => {
    if ("id" in item) {
      return Math.max(highest, item.id);
    }
    return highest;
  }, 0);
  const metadata = {
    token,
    page_index: page.page_index,
    section: page.section,
    item_count: page.items.length,
    page_hash: pageHash,
    high_water: highWater,
  };
  const existing = await ctx.db
    .query("restore_staged_pages")
    .withIndex("by_token_and_page", (query) =>
      query.eq("token", token).eq("page_index", page.page_index),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("restore_staged_pages", metadata);
    return;
  }
  if (
    existing.page_index !== metadata.page_index ||
    existing.section !== metadata.section ||
    existing.item_count !== metadata.item_count ||
    existing.page_hash !== metadata.page_hash ||
    existing.high_water !== metadata.high_water
  ) {
    failQuestDomain(
      "CONVEX_RESTORE_STAGE_CHANGED",
      "a Convex restore page index conflicts with data already uploaded for this session; roll back this restore, start a new session, and upload one unchanged snapshot",
    );
  }
}

async function findRestoreLease(ctx: QueryContext, token?: string) {
  if (token !== undefined) {
    return ctx.db
      .query("restore_leases")
      .withIndex("by_token", (query) => query.eq("token", token))
      .unique();
  }
  return (await ctx.db.query("restore_leases").collect())[0] ?? null;
}

function restoreLeaseExpiry(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Convex restore lease received an invalid server time: ${timestamp}`);
  }
  return new Date(parsed + RESTORE_LEASE_DURATION_MS).toISOString();
}

async function snapshotFingerprint(snapshot: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableSerialize(snapshot)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readRestoreManifest(ctx: QueryContext, token: string) {
  const documents = await ctx.db
    .query("restore_staged_pages")
    .withIndex("by_token", (query) => query.eq("token", token))
    .collect();
  const manifest = documents
    .map((document) => ({
      page_index: document.page_index,
      section: document.section,
      item_count: document.item_count,
      page_hash: document.page_hash,
      high_water: document.high_water,
    }))
    .sort((left, right) => left.page_index - right.page_index);
  if (manifest.some((page, index) => page.page_index !== index)) {
    failQuestDomain(
      "CONVEX_RESTORE_STAGE_CHANGED",
      "the Convex restore upload is missing a page index; retry every page from one unchanged backup, then activate again",
    );
  }
  return manifest;
}

async function restoreManifestFingerprint(ctx: QueryContext, token: string): Promise<string> {
  return snapshotFingerprint({ version: 1, pages: await readRestoreManifest(ctx, token) });
}

async function restoreManifestHighWater(
  ctx: QueryContext,
  token: string,
  section: "quests" | "evidence" | "events",
): Promise<number> {
  return (await readRestoreManifest(ctx, token))
    .filter((page) => page.section === section)
    .reduce((highest, page) => Math.max(highest, page.high_water), 0);
}

async function legacySnapshotFingerprint(snapshot: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matchesSnapshotFingerprint(snapshot: QuestDump, expected: string): Promise<boolean> {
  // Existing leases and fences have no hash-version field. Both hashes cover the
  // complete dump; the legacy form differs only in key ordering.
  if (
    (await snapshotFingerprint(snapshot)) === expected ||
    (await legacySnapshotFingerprint(snapshot)) === expected
  ) {
    return true;
  }
  const legacyReady = legacyReadySnapshot(snapshot);
  return (
    (await snapshotFingerprint(legacyReady)) === expected ||
    (await legacySnapshotFingerprint(legacyReady)) === expected
  );
}

function repositorySnapshot(snapshot: QuestDump, repository: string): QuestDump {
  const quests = snapshot.quests.filter((quest) => quest.repo === repository);
  const questIds = new Set(quests.map((quest) => quest.id));
  return questDumpSchema.parse({
    schema_version: snapshot.schema_version,
    quests,
    evidence: snapshot.evidence.filter((item) => questIds.has(item.quest_id)),
    chains: snapshot.chains.filter(
      (chain) => questIds.has(chain.quest_id) && questIds.has(chain.target_id),
    ),
    events: snapshot.events.filter((event) => questIds.has(event.quest_id)),
  });
}

async function matchesRepositorySnapshotFingerprint(
  snapshot: QuestDump,
  repository: string,
  expected: string,
): Promise<boolean> {
  return matchesSnapshotFingerprint(repositorySnapshot(snapshot, repository), expected);
}

async function requireNoRestoreLease(ctx: MutationContext): Promise<void> {
  const lease = await findRestoreLease(ctx);
  if (lease === null) {
    return;
  }
  const current = Date.parse(now());
  const expiresAt = Date.parse(lease.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt <= current) {
    if (lease.commit_phase !== undefined && lease.committed !== true) {
      failQuestDomain(
        "CONVEX_RESTORE_IN_PROGRESS",
        `Convex restore ${lease.token} expired during its ${lease.commit_phase} phase; resume commitRestore with that token until it reports committed before retrying this write`,
      );
    }
    await requireRestoreStageEmpty(ctx, lease.token, "retry this write");
    await restoreMigrationFencesAfterRestore(ctx, lease.token, lease.committed === true);
    await ctx.db.delete(lease._id);
    return;
  }
  failQuestDomain(
    "CONVEX_RESTORE_IN_PROGRESS",
    "Convex restore is in progress; retry after the active restore commits or rolls back",
  );
}

async function requireRestoreLease(ctx: MutationContext, token: string) {
  const lease = await findRestoreLease(ctx, token);
  if (lease === null) {
    return failQuestDomain(
      "CONVEX_RESTORE_SESSION_MISSING",
      "Convex restore session is missing or expired; retry the restore",
    );
  }
  const expiresAt = Date.parse(lease.expires_at);
  if (
    lease.commit_phase === undefined &&
    (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now()))
  ) {
    return failQuestDomain(
      "CONVEX_RESTORE_SESSION_MISSING",
      "Convex restore session is missing or expired; retry the restore",
    );
  }
  return lease;
}

async function requireRestoreStateUnchanged(
  ctx: QueryContext,
  lease: {
    readonly committed_event_high_water?: number;
    readonly expected_event_high_water?: number;
    readonly expected_hash: string;
    readonly lease_cutoff: string;
  },
  committed: boolean,
  code:
    | "CONVEX_RESTORE_PRECONDITION_FAILED"
    | "MIGRATION_COMMITTED_STATE_CHANGED"
    | "MIGRATION_CONCURRENT_WRITE",
  message: string,
): Promise<void> {
  const highWater = committed ? lease.committed_event_high_water : lease.expected_event_high_water;
  if (highWater !== undefined) {
    if ((await snapshotGeneration(ctx)) !== highWater) {
      failQuestDomain(code, message);
    }
    return;
  }
  const snapshot = await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff));
  if (!(await matchesSnapshotFingerprint(snapshot, lease.expected_hash))) {
    failQuestDomain(code, message);
  }
}

async function requireRepositoryNotFenced(ctx: MutationContext, repository: string): Promise<void> {
  const fence = await ctx.db
    .query("migration_fences")
    .withIndex("by_repo", (query) => query.eq("repo", repository))
    .unique();
  if (fence !== null && fence.unfenced !== true) {
    failQuestDomain(
      "MIGRATION_REPOSITORY_FENCED",
      `repository ${repository} is fenced after a backend migration; refresh routing before retrying writes`,
    );
  }
}

async function deleteRestoreDestinationPage(ctx: MutationContext): Promise<boolean> {
  const tables: readonly ("events" | "chains" | "evidence" | "quests" | "counters")[] = [
    "events",
    "chains",
    "evidence",
    "quests",
    "counters",
  ];
  for (const table of tables) {
    const firstDocument = await ctx.db.query(table).first();
    if (firstDocument === null) {
      continue;
    }
    const { page: documents } = await ctx.db
      .query(table)
      .paginate(restoreMutationPaginationOptions());
    for (const document of documents) {
      await ctx.db.delete(document._id);
    }
    return false;
  }
  return true;
}

async function copyRestoreStagePage(ctx: MutationContext, token: string): Promise<boolean> {
  const firstQuest = await ctx.db
    .query("restore_staged_quests")
    .withIndex("by_token", (query) => query.eq("token", token))
    .first();
  if (firstQuest !== null) {
    const { page: quests } = await ctx.db
      .query("restore_staged_quests")
      .withIndex("by_token", (query) => query.eq("token", token))
      .paginate(restoreMutationPaginationOptions());
    for (const document of quests) {
      await ctx.db.insert("quests", parseQuestDocument(document));
      await ctx.db.delete(document._id);
    }
    return false;
  }

  const firstEvidence = await ctx.db
    .query("restore_staged_evidence")
    .withIndex("by_token", (query) => query.eq("token", token))
    .first();
  if (firstEvidence !== null) {
    const { page: evidence } = await ctx.db
      .query("restore_staged_evidence")
      .withIndex("by_token", (query) => query.eq("token", token))
      .paginate(restoreMutationPaginationOptions());
    for (const document of evidence) {
      await ctx.db.insert("evidence", parseEvidenceDocument(document));
      await ctx.db.delete(document._id);
    }
    return false;
  }

  const firstChain = await ctx.db
    .query("restore_staged_chains")
    .withIndex("by_token", (query) => query.eq("token", token))
    .first();
  if (firstChain !== null) {
    const { page: chains } = await ctx.db
      .query("restore_staged_chains")
      .withIndex("by_token", (query) => query.eq("token", token))
      .paginate(restoreMutationPaginationOptions());
    for (const document of chains) {
      await ctx.db.insert("chains", parseChainDocument(document));
      await ctx.db.delete(document._id);
    }
    return false;
  }

  const firstEvent = await ctx.db
    .query("restore_staged_events")
    .withIndex("by_token", (query) => query.eq("token", token))
    .first();
  if (firstEvent !== null) {
    const { page: events } = await ctx.db
      .query("restore_staged_events")
      .withIndex("by_token", (query) => query.eq("token", token))
      .paginate(restoreMutationPaginationOptions());
    for (const document of events) {
      await ctx.db.insert("events", parseEventDocument(document));
      await ctx.db.delete(document._id);
    }
    return false;
  }
  return true;
}

async function markMigrationFencesCommitted(
  ctx: MutationContext,
  token: string,
  recoveryCutoff: string,
): Promise<void> {
  const fences = await ctx.db.query("migration_fences").collect();
  const recoveryEventHighWater = await snapshotGeneration(ctx);
  for (const fence of fences) {
    if (fence.lease_token === token) {
      const recoveryRepositoryRevision = await repositoryRevision(ctx, fence.repo);
      await ctx.db.patch(fence._id, {
        committed: true,
        recovery_event_high_water: recoveryEventHighWater,
        recovery_repository_revision: recoveryRepositoryRevision,
        recovery_cutoff: recoveryCutoff,
      });
    }
  }
}

async function findMigrationFence(ctx: MutationContext, repo: string) {
  return ctx.db
    .query("migration_fences")
    .withIndex("by_repo", (query) => query.eq("repo", repo))
    .unique();
}

async function deleteMigrationFence(
  ctx: MutationContext,
  fence: NonNullable<Awaited<ReturnType<typeof findMigrationFence>>>,
): Promise<void> {
  await ctx.db.delete(fence._id);
  if (fence.unfenced !== true) {
    await advanceFenceGeneration(ctx);
  }
}

async function repositoryRevision(ctx: QueryContext, repo: string): Promise<number> {
  const revision = await ctx.db
    .query("repository_revisions")
    .withIndex("by_repo", (query) => query.eq("repo", repo))
    .unique();
  return revision?.value ?? 0;
}

async function migrationFenceRecoveryFields(
  ctx: QueryContext,
  input: {
    readonly committed: boolean | undefined;
    readonly leaseCutoff: string;
    readonly repo: string;
  },
) {
  if (input.committed !== true) {
    return { committed: false } as const;
  }
  return {
    committed: true,
    recovery_cutoff: input.leaseCutoff,
    recovery_event_high_water: await snapshotGeneration(ctx),
    recovery_repository_revision: await repositoryRevision(ctx, input.repo),
  } as const;
}

async function restoreMigrationFencesAfterRestore(
  ctx: MutationContext,
  token: string,
  committed: boolean,
): Promise<void> {
  let changed = false;
  for (const fence of await ctx.db.query("migration_fences").collect()) {
    if (fence.recovery_restore_token === token) {
      if (committed) {
        await ctx.db.delete(fence._id);
        changed = true;
        continue;
      }
      await ctx.db.patch(fence._id, {
        unfenced: false,
        recovery_restore_token: undefined,
      });
      changed = true;
      continue;
    }
    if (fence.lease_token === token && !committed) {
      await ctx.db.delete(fence._id);
      changed = true;
    }
  }
  if (changed) {
    await advanceFenceGeneration(ctx);
  }
}

async function clearExpiredFenceRecoveryRestore(
  ctx: MutationContext,
  repo: string,
  token: string | undefined,
): Promise<boolean> {
  if (token === undefined) {
    return false;
  }
  const pendingLease = await findRestoreLease(ctx, token);
  if (pendingLease === null) {
    failQuestDomain(
      "MIGRATION_FENCE_STATUS_UNKNOWN",
      `repository ${repo} has a fence recovery restore without a live restore lease; inspect restore state before retrying`,
    );
  }
  const current = Date.parse(now());
  const expiresAt = Date.parse(pendingLease.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt > current) {
    failQuestDomain(
      "MIGRATION_FENCE_RECOVERY_BLOCKED",
      `repository ${repo} is being restored; retry after the backup restore commits or rolls back`,
    );
  }
  if (pendingLease.commit_phase !== undefined && pendingLease.committed !== true) {
    failQuestDomain(
      "MIGRATION_FENCE_RECOVERY_BLOCKED",
      `restore ${pendingLease.token} expired during its ${pendingLease.commit_phase} phase; resume commitRestore with that token before recovering repository ${repo}`,
    );
  }
  if (pendingLease.committed === true) {
    await requireRestoreStateUnchanged(
      ctx,
      pendingLease,
      true,
      "MIGRATION_COMMITTED_STATE_CHANGED",
      "the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
    );
  }
  await restoreMigrationFencesAfterRestore(
    ctx,
    pendingLease.token,
    pendingLease.committed === true,
  );
  await requireRestoreStageEmpty(ctx, pendingLease.token, `retry recovery for repository ${repo}`);
  await ctx.db.delete(pendingLease._id);
  return pendingLease.committed === true;
}

function isLegacyMigrationFence(fence: {
  readonly committed?: boolean;
  readonly recovery_cutoff?: string;
  readonly recovery_event_high_water?: number;
  readonly recovery_hash?: string;
  readonly recovery_repository_revision?: number;
  readonly unfenced?: boolean;
}): boolean {
  return (
    fence.committed === undefined &&
    fence.recovery_cutoff === undefined &&
    fence.recovery_event_high_water === undefined &&
    fence.recovery_hash === undefined &&
    fence.recovery_repository_revision === undefined &&
    fence.unfenced === undefined
  );
}

async function verifyCommittedFenceSnapshot(
  ctx: MutationContext,
  repo: string,
  recoveryHash: string | undefined,
  recoveryRepositoryRevision: number | undefined,
  recoveryEventHighWater: number | undefined,
  recoveryCutoff: string | undefined,
  isUnfenced: boolean,
): Promise<void> {
  if (isUnfenced) {
    return;
  }
  if (recoveryRepositoryRevision !== undefined) {
    if ((await repositoryRevision(ctx, repo)) !== recoveryRepositoryRevision) {
      failQuestDomain(
        "MIGRATION_FENCE_RECOVERY_BLOCKED",
        `repository ${repo} changed after its committed migration; inspect the destination and routing before retrying`,
      );
    }
    return;
  }
  if (recoveryEventHighWater !== undefined) {
    if ((await snapshotGeneration(ctx)) !== recoveryEventHighWater) {
      failQuestDomain(
        "MIGRATION_FENCE_RECOVERY_BLOCKED",
        `repository ${repo} changed after its committed migration; inspect the destination and routing before retrying`,
      );
    }
    return;
  }
  if (recoveryHash === undefined) {
    failQuestDomain(
      "MIGRATION_FENCE_STATUS_UNKNOWN",
      `repository ${repo} has a committed fence without a recovery fingerprint; verify routing and use the owning migration session or a privileged deployment recovery before retrying`,
    );
  }
  const current = await exportDump(ctx, parseLeaseCutoff(recoveryCutoff ?? now()));
  if (!(await matchesRepositorySnapshotFingerprint(current, repo, recoveryHash))) {
    failQuestDomain(
      "MIGRATION_FENCE_RECOVERY_BLOCKED",
      `repository ${repo} changed after its committed migration; inspect the destination and routing before retrying`,
    );
  }
}

async function verifyLegacyFenceSnapshot(
  ctx: MutationContext,
  repo: string,
  expectedHash: string,
  leaseCutoff: string,
): Promise<void> {
  const current = await exportDump(ctx, parseLeaseCutoff(leaseCutoff));
  if (!(await matchesSnapshotFingerprint(current, expectedHash))) {
    failQuestDomain(
      "MIGRATION_FENCE_RECOVERY_BLOCKED",
      `repository ${repo} changed after its committed migration; inspect the destination and routing before retrying`,
    );
  }
}

async function recoverCommittedMigrationFence(
  ctx: MutationContext,
  repo: string,
): Promise<boolean | undefined> {
  const existing = await findMigrationFence(ctx, repo);
  if (existing === null) {
    return undefined;
  }
  if (await clearExpiredFenceRecoveryRestore(ctx, repo, existing.recovery_restore_token)) {
    return true;
  }
  if (existing.committed !== true) {
    return undefined;
  }
  if (
    existing.recovery_hash === undefined &&
    existing.recovery_event_high_water === undefined &&
    existing.recovery_repository_revision === undefined
  ) {
    failQuestDomain(
      "MIGRATION_FENCE_STATUS_UNKNOWN",
      `repository ${repo} has a committed fence without a recovery fingerprint; verify routing and use the owning migration session or a privileged deployment recovery before retrying`,
    );
  }
  const lease = await findRestoreLease(ctx);
  if (lease !== null) {
    if (lease.committed !== true) {
      failQuestDomain(
        "MIGRATION_FENCE_STATUS_UNKNOWN",
        `repository ${repo} has a committed fence but its owning lease is not committed; inspect migration state before retrying`,
      );
    }
    if (existing.lease_token !== lease.token) {
      failQuestDomain(
        "MIGRATION_FENCE_OWNER_MISMATCH",
        `repository ${repo} is fenced by another migration; recover or clear the owning migration before retrying`,
      );
    }
    const current = Date.parse(now());
    const expiresAt = Date.parse(lease.expires_at);
    if (
      existing.unfenced !== true &&
      (!Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt > current)
    ) {
      failQuestDomain(
        "MIGRATION_FENCE_RECOVERY_BLOCKED",
        "an active committed Convex migration lease still owns the fence; retry with the owning migration or wait for it to expire",
      );
    }
  }
  await verifyCommittedFenceSnapshot(
    ctx,
    repo,
    existing.recovery_hash,
    existing.recovery_repository_revision,
    existing.recovery_event_high_water,
    existing.recovery_cutoff,
    existing.unfenced === true,
  );
  if (lease !== null) {
    await requireRestoreStageEmpty(ctx, lease.token, `retry recovery for repository ${repo}`);
    await ctx.db.delete(lease._id);
  }
  await deleteMigrationFence(ctx, existing);
  return true;
}

export const schemaVersion = queryGeneric({
  args: emptyArgs,
  handler: async () => STORE_SCHEMA_VERSION,
});

export const migrateReadyStatuses = mutationGeneric({
  args: { admin_secret: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await assertAdminSecret(args.admin_secret);
    await requireNoRestoreLease(ctx);
    const quests = await ctx.db.query("quests").collect();
    let converted = 0;
    const changedRepositories = new Set<string>();
    for (const quest of quests) {
      if (quest.status !== "ready") {
        continue;
      }
      await ctx.db.patch(quest._id, { status: "open" });
      changedRepositories.add(quest.repo);
      converted += 1;
    }
    if (converted > 0) {
      await advanceSnapshotGeneration(ctx, changedRepositories);
    }
    return { converted, unchanged: quests.length - converted, total: quests.length };
  },
});

// Quest 83 deliberately leaves authorization to Quest 86; this provider is tested against an anonymous local deployment.
export const serverTime = queryGeneric({
  args: emptyArgs,
  handler: async () => now(),
});

/**
 * Returns the two counters every list page is validated against. Viewers subscribe to this
 * instead of a list page: the subscription re-executes on every write but reads only the
 * counter documents, and the viewer fetches list pages over HTTP when the stamp changes.
 */
export const revisionStamp = queryGeneric({
  args: { auth_token: v.optional(v.string()), ...clientProtocolArgs },
  handler: async (ctx, args): Promise<ConvexRevisionStamp> => {
    await requireMemberQueryActor(ctx, args);
    return {
      snapshot_generation: await snapshotGeneration(ctx),
      fence_generation: await fenceGeneration(ctx),
    };
  },
});

export const doctorCapacity = queryGeneric({
  args: { auth_token: v.optional(v.string()), ...clientProtocolArgs },
  handler: async (ctx, args): Promise<StoreCapacityInspection> => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const [latestQuest, latestEvidence, latestEvent] = await Promise.all([
      ctx.db.query("quests").withIndex("by_display_id").order("desc").first(),
      ctx.db.query("evidence").withIndex("by_display_id").order("desc").first(),
      ctx.db.query("events").withIndex("by_display_id").order("desc").first(),
    ]);
    const parsedLatestEvent = latestEvent === null ? null : parseEventDocument(latestEvent);
    const recentEventPage = await ctx.db
      .query("events")
      .withIndex("by_display_id")
      .order("desc")
      .paginate({
        cursor: null,
        maximumBytesRead: DOCTOR_MAXIMUM_BYTES_READ,
        maximumRowsRead: DOCTOR_EVENT_RATE_SAMPLE_SIZE,
        numItems: DOCTOR_EVENT_RATE_SAMPLE_SIZE,
      });
    const recentEvents = recentEventPage.page.map(parseEventDocument);
    const firstRecentEvent = recentEvents.at(-1) ?? null;
    const lastRecentEvent = recentEvents[0] ?? null;
    return {
      event_rate_sample: {
        count: recentEvents.length,
        first: eventInspectionPoint(firstRecentEvent),
        last: eventInspectionPoint(lastRecentEvent),
      },
      tables: [
        { high_water_mark: numericDocumentId(latestQuest) ?? 0, table: "quests" },
        { high_water_mark: numericDocumentId(latestEvidence) ?? 0, table: "evidence" },
        { high_water_mark: parsedLatestEvent?.id ?? 0, table: "events" },
      ],
    };
  },
});

export const doctorEvidenceSample = queryGeneric({
  args: { auth_token: v.optional(v.string()), ...clientProtocolArgs },
  handler: async (ctx, args): Promise<StoreEvidenceSampleInspection> => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const [latestEvidence, evidenceSample] = await Promise.all([
      ctx.db.query("evidence").withIndex("by_display_id").order("desc").first(),
      ctx.db
        .query("evidence")
        .withIndex("by_display_id")
        .order("asc")
        .take(DOCTOR_EVIDENCE_SAMPLE_SIZE),
    ]);
    return {
      hashes: [
        ...new Set(evidenceSample.map((document) => parseEvidenceDocument(document).sha256)),
      ].sort(),
      high_water_mark: numericDocumentId(latestEvidence) ?? 0,
    };
  },
});

export const doctorStaleClaims = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    lease_cutoff: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args): Promise<StoreStaleClaimsInspection> => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const leaseCutoff = parseLeaseCutoff(args.lease_cutoff);
    const sample = await readStaleClaimSample(ctx, leaseCutoff);
    const staleDocuments = sample.documents.filter(
      (document) =>
        document.lease_expires_at === null ||
        Date.parse(document.lease_expires_at) <= Date.parse(leaseCutoff),
    );
    return {
      claims: staleDocuments.slice(0, DOCTOR_STALE_CLAIM_SAMPLE_SIZE).map((document) => {
        const quest = parseQuestDocument(document);
        return {
          assignee: quest.assignee,
          id: quest.id,
          lease_expires_at: quest.lease_expires_at,
        };
      }),
      truncated: sample.truncated || staleDocuments.length > DOCTOR_STALE_CLAIM_SAMPLE_SIZE,
    };
  },
});

export const addQuest = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    const requested = parseWriteInput(newQuestSchema, args.input);
    const parsed = parseWriteInput(newQuestSchema, { ...requested, opened_by: actor });
    await requireNoRestoreLease(ctx);
    await requireRepositoryNotFenced(ctx, parsed.repo);
    if (!isValidBackfill(parsed)) {
      return failQuestDomain(
        "QUEST_BACKFILL_INVALID",
        `invalid backfilled state for ${parsed.kind} quest: ${parsed.status}/${String(parsed.verdict)}`,
      );
    }
    const id = await nextDocumentId(ctx, "quests", "quests");
    const timestamp = now();
    const quest = questSchema.parse({
      repo: parsed.repo,
      area: parsed.area,
      kind: parsed.kind,
      title: parsed.title,
      description: parsed.description,
      opened_by: actor,
      guild: parsed.guild,
      assignee: parsed.assignee,
      status: parsed.status,
      verdict: parsed.verdict,
      verdict_notes: parsed.verdict_notes,
      priority: parsed.priority,
      pr: parsed.pr,
      predicted_files: parsed.predicted_files,
      reopen_count: parsed.reopen_count,
      lease_expires_at:
        parsed.lease_expires_at ??
        (parsed.status === "accepted" && parsed.assignee !== null
          ? leaseExpiry(timestamp, parsed.lease_ttl_minutes)
          : null),
      id,
      created_at: timestamp,
      updated_at: timestamp,
    });
    await ctx.db.insert("quests", quest);
    await appendEvent(
      ctx,
      id,
      timestamp,
      quest.opened_by,
      "add",
      {
        ...quest,
        backfill: parsed.backfill ?? false,
        session_guild: parsed.session_guild ?? null,
      },
      args.test_failure,
    );
    return quest;
  },
});

async function accept(
  ctx: MutationContext,
  input: AcceptQuestInput,
  testFailure: boolean | undefined,
): Promise<AcceptResult> {
  await requireNoRestoreLease(ctx);
  const storedRecord = await requireQuestRecord(ctx, input.id);
  const stored = parseQuestDocument(storedRecord);
  await requireRepositoryNotFenced(ctx, stored.repo);
  const timestamp = now();
  const current = materializeExpiredLease(stored, timestamp);
  if (hasGuildMismatch(current, input.session_guild, input.force)) {
    return {
      outcome: "guild-mismatch",
      lease_expires_at: current.lease_expires_at,
      quest: current,
    };
  }
  const expired = isLeaseExpired(stored.lease_expires_at, timestamp);
  const unclaimedDispatchable = isUnclaimedDispatchable(stored);
  const expiredAccepted = stored.status === "accepted" && expired;
  if (
    !(unclaimedDispatchable || expiredAccepted) ||
    !isLegalStatusTransition(current.status, "accepted")
  ) {
    return { outcome: "conflict", lease_expires_at: current.lease_expires_at, quest: current };
  }
  const laneConflict = await unacknowledgedLaneConflict(ctx, input, timestamp, current);
  if (laneConflict !== null) {
    return laneConflict;
  }
  const updated = questSchema.parse({
    ...stored,
    assignee: input.owner,
    status: "accepted",
    lease_expires_at: leaseExpiry(timestamp, input.lease_ttl_minutes),
    updated_at: timestamp,
  });
  await ctx.db.replace(storedRecord._id, updated);
  await appendEvent(
    ctx,
    input.id,
    timestamp,
    input.owner,
    "accept",
    {
      assignee: input.owner,
      lease_expires_at: updated.lease_expires_at,
      ...(expired && stored.assignee !== null ? { reclaimed_from: stored.assignee } : {}),
      status: "accepted",
      ...(input.lane_conflict_override === true ||
      (input.lane_conflict_acknowledged?.length ?? 0) > 0
        ? { lane_conflict_acknowledged: true }
        : {}),
      ...(input.session_effort === undefined ? {} : { session_effort: input.session_effort }),
      session_guild: input.session_guild ?? null,
      ...(input.session_model === undefined ? {} : { session_model: input.session_model }),
    },
    testFailure,
  );
  return { outcome: "accepted", lease_expires_at: updated.lease_expires_at, quest: updated };
}

export const acceptQuest = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    const parsed = parseWriteInput(acceptQuestInputSchema, args.input);
    const input = parseWriteInput(acceptQuestInputSchema, { ...parsed, owner: actor });
    return accept(ctx, input, args.test_failure);
  },
});

export const acceptQuestAndDetail = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    const parsed = parseWriteInput(acceptQuestInputSchema, args.input);
    const input = parseWriteInput(acceptQuestInputSchema, { ...parsed, owner: actor });
    const acceptance = await accept(ctx, input, args.test_failure);
    return { acceptance, detail: await readQuestDetailSnapshot(ctx, parsed.id) };
  },
});

export const acceptQuestAndExport = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    return failQuestDomain(
      "CONVEX_MONOLITHIC_DUMP_UNSUPPORTED",
      "acceptQuestAndExport no longer accepts a quest because its full-dump result is unsupported; call acceptQuestAndDetail, or retry the claim with the current Quest CLI",
    );
  },
});

export const touchQuest = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    await requireNoRestoreLease(ctx);
    const parsed = parseWriteInput(touchQuestInputSchema, args.input);
    const input = parseWriteInput(touchQuestInputSchema, { ...parsed, owner: actor });
    const record = await requireQuestRecord(ctx, input.id);
    const current = parseQuestDocument(record);
    await requireRepositoryNotFenced(ctx, current.repo);
    const timestamp = now();
    applyDomainGuardForMutation(() => assertActiveLeaseOwner(current, input.owner, timestamp));
    const updated = renewLease(current, timestamp, input.lease_ttl_minutes);
    await ctx.db.replace(record._id, updated);
    await appendEvent(
      ctx,
      input.id,
      timestamp,
      input.owner,
      "touch",
      {
        action: "touch",
        lease_expires_at: updated.lease_expires_at,
        ...(input.session_effort === undefined ? {} : { session_effort: input.session_effort }),
        session_guild: input.session_guild ?? null,
        ...(input.session_model === undefined ? {} : { session_model: input.session_model }),
      },
      args.test_failure,
    );
    return updated;
  },
});

export const transition = mutationGeneric({
  args: { auth_token: v.optional(v.string()), id: v.number(), transition: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    const parsedTransition = parseWriteInput(questTransitionSchema, args.transition);
    await requireNoRestoreLease(ctx);
    const id = questSchema.shape.id.parse(args.id);
    const transitionInput = parseWriteInput(questTransitionSchema, {
      ...parsedTransition,
      actor,
    });
    const record = await requireQuestRecord(ctx, id);
    const current = parseQuestDocument(record);
    await requireRepositoryNotFenced(ctx, current.repo);
    const timestamp = now();
    const events = await readQuestEvents(ctx, current.id);
    const updated = applyTransitionForMutation(current, transitionInput, timestamp);
    if (transitionRequiresLeaseOwner(current, transitionInput.action)) {
      applyDomainGuardForMutation(() =>
        assertLeaseOwner(
          current,
          transitionInput.actor,
          timestamp,
          hasAcceptedEvent(events, current.id, transitionInput.actor),
        ),
      );
    }
    if (transitionInput.action !== "signoff") {
      await ctx.db.replace(record._id, updated);
    }

    if (transitionInput.action === "verdict" && transitionInput.duplicate_of !== null) {
      const duplicateTarget = await requireQuestRecord(ctx, transitionInput.duplicate_of);
      await requireRepositoryNotFenced(ctx, parseQuestDocument(duplicateTarget).repo);
      await addDuplicateLink(ctx, id, transitionInput, timestamp);
    }
    if (transitionInput.action === "reopen" && current.verdict === "duplicate") {
      await removeDuplicateLinks(ctx, id, transitionInput, timestamp, args.test_failure);
    }
    const { lease_ttl_minutes: _leaseTtlMinutes, ...persistedTransition } = transitionInput;
    await appendEvent(
      ctx,
      id,
      timestamp,
      transitionInput.actor,
      transitionInput.action,
      { ...persistedTransition, session_guild: transitionInput.session_guild ?? null },
      args.test_failure,
    );
    return updated;
  },
});

type SignoffTransition = Extract<QuestTransition, { action: "signoff" }>;

type PreparedSignoffBatch = {
  readonly evidenceByQuest: Map<number, NewEvidence[]>;
  readonly ids: readonly number[];
  readonly questsById: Map<number, Quest>;
  readonly transition: SignoffTransition;
};

async function loadSignoffBatchQuests(
  ctx: MutationContext,
  ids: readonly number[],
  transition: SignoffTransition,
): Promise<Map<number, Quest>> {
  const records = await Promise.all(ids.map((id) => requireQuestRecord(ctx, id)));
  const questsById = new Map(
    records.map((record) => {
      const quest = parseQuestDocument(record);
      return [quest.id, quest] as const;
    }),
  );
  for (const quest of questsById.values()) {
    await requireRepositoryNotFenced(ctx, quest.repo);
    applyTransitionForMutation(quest, transition, now());
  }
  return questsById;
}

function groupSignoffEvidence(
  input: SignoffBatchInput,
  actor: string,
  questsById: ReadonlyMap<number, Quest>,
): Map<number, NewEvidence[]> {
  const evidenceByQuest = new Map<number, NewEvidence[]>();
  for (const parsedEvidence of input.evidence) {
    if (parsedEvidence.stage !== "signoff") {
      failQuestDomain(
        "SIGNOFF_EVIDENCE_STAGE_REQUIRED",
        "sign-off batches accept only signoff-stage evidence",
      );
    }
    const evidence = parseWriteInput(newEvidenceSchema, { ...parsedEvidence, added_by: actor });
    const quest = questsById.get(evidence.quest_id);
    if (quest === undefined) {
      failQuestDomain(
        "SIGNOFF_EVIDENCE_OUTSIDE_BATCH",
        `sign-off evidence references quest ${evidence.quest_id} outside the requested batch`,
      );
    }
    if (quest.status !== "complete") {
      failQuestDomain(
        "SIGNOFF_NOT_COMPLETE",
        signoffNotCompleteInstruction(quest.id, quest.status),
      );
    }
    const entries = evidenceByQuest.get(evidence.quest_id) ?? [];
    entries.push(evidence);
    evidenceByQuest.set(evidence.quest_id, entries);
  }
  return evidenceByQuest;
}

function existingSignoffEvidence(
  candidates: readonly Evidence[],
  input: NewEvidence,
): Evidence | undefined {
  return candidates.find(
    (candidate) =>
      candidate.quest_id === input.quest_id &&
      candidate.sha256 === input.sha256 &&
      candidate.filename === input.filename &&
      candidate.kind === input.kind &&
      candidate.stage === input.stage &&
      candidate.added_by === input.added_by,
  );
}

async function persistSignoffEvidence(
  ctx: MutationContext,
  questId: number,
  input: NewEvidence,
  existingEvidence: Evidence[],
  timestamp: string,
  testFailure: boolean | undefined,
): Promise<Evidence> {
  const existing = existingSignoffEvidence(existingEvidence, input);
  if (existing !== undefined) {
    return existing;
  }
  const evidenceId = await nextDocumentId(ctx, "evidence", "evidence");
  const created = evidenceSchema.parse({
    id: evidenceId,
    quest_id: input.quest_id,
    sha256: input.sha256,
    filename: input.filename,
    kind: input.kind,
    stage: input.stage,
    added_by: input.added_by,
    created_at: timestamp,
  });
  await ctx.db.insert("evidence", created);
  const { lease_ttl_minutes: _leaseTtlMinutes, ...persistedInput } = input;
  await appendEvent(
    ctx,
    questId,
    timestamp,
    input.added_by,
    "update",
    {
      evidence_id: evidenceId,
      ...persistedInput,
      session_guild: input.session_guild ?? null,
    },
    testFailure,
  );
  existingEvidence.push(created);
  return created;
}

async function persistSignoffQuest(
  ctx: MutationContext,
  quest: Quest,
  transition: SignoffTransition,
  evidenceInputs: readonly NewEvidence[],
  existingEvidence: Evidence[],
  timestamp: string,
  testFailure: boolean | undefined,
): Promise<Evidence[]> {
  const { lease_ttl_minutes: _leaseTtlMinutes, ...persistedTransition } = transition;
  await appendEvent(
    ctx,
    quest.id,
    timestamp,
    transition.actor,
    "signoff",
    { ...persistedTransition, session_guild: transition.session_guild ?? null },
    testFailure,
  );
  const evidence: Evidence[] = [];
  for (const input of evidenceInputs) {
    evidence.push(
      await persistSignoffEvidence(ctx, quest.id, input, existingEvidence, timestamp, testFailure),
    );
  }
  return evidence;
}

async function prepareSignoffBatch(
  ctx: MutationContext,
  input: SignoffBatchInput,
  actor: string,
): Promise<PreparedSignoffBatch> {
  const ids = [...new Set(input.ids)];
  const transition = parseWriteInput(questTransitionSchema, { ...input.transition, actor });
  if (transition.action !== "signoff") {
    failQuestDomain(
      "SIGNOFF_TRANSITION_REQUIRED",
      "sign-off batch transition must use the signoff action",
    );
  }
  const questsById = await loadSignoffBatchQuests(ctx, ids, transition);
  return {
    evidenceByQuest: groupSignoffEvidence(input, actor, questsById),
    ids,
    questsById,
    transition,
  };
}

async function persistSignoffBatch(
  ctx: MutationContext,
  prepared: PreparedSignoffBatch,
  testFailure: boolean | undefined,
): Promise<SignoffBatchResult> {
  const timestamp = now();
  const existingEvidenceByQuest = new Map<number, Evidence[]>();
  for (const [id, inputs] of prepared.evidenceByQuest) {
    if (inputs.length > 0) {
      existingEvidenceByQuest.set(id, await readQuestEvidence(ctx, id));
    }
  }
  const evidence: Evidence[] = [];
  const quests: Quest[] = [];
  for (const id of prepared.ids) {
    const quest = prepared.questsById.get(id);
    if (quest === undefined) {
      throw new Error(`quest ${id} does not exist`);
    }
    evidence.push(
      ...(await persistSignoffQuest(
        ctx,
        quest,
        prepared.transition,
        prepared.evidenceByQuest.get(id) ?? [],
        existingEvidenceByQuest.get(id) ?? [],
        timestamp,
        testFailure,
      )),
    );
    quests.push(quest);
  }
  return signoffBatchResultSchema.parse({ quests, evidence });
}

export const signoffBatch = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    const parsed = parseWriteInput(signoffBatchInputSchema, args.input);
    await requireNoRestoreLease(ctx);
    const prepared = await prepareSignoffBatch(ctx, parsed, actor);
    return persistSignoffBatch(ctx, prepared, args.test_failure);
  },
});

export const addChainLink = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    await requireNoRestoreLease(ctx);
    const parsed = parseWriteInput(chainMutationSchema, args.input);
    const input = parseWriteInput(chainMutationSchema, { ...parsed, actor });
    const timestamp = now();
    const quests = await readQuests(ctx, timestamp);
    const sourceQuest = requireQuestInSnapshot(quests, input.link.quest_id);
    const targetQuest = requireQuestInSnapshot(quests, input.link.target_id);
    await requireRepositoryNotFenced(ctx, sourceQuest.repo);
    await requireRepositoryNotFenced(ctx, targetQuest.repo);
    const chains = await readChains(ctx);
    const existing = chains.find(
      (link) =>
        link.quest_id === input.link.quest_id &&
        link.target_id === input.link.target_id &&
        link.type === input.link.type,
    );
    if (existing !== undefined) {
      return { outcome: "exists", link: existing } satisfies ChainResult;
    }
    const path = findChainCyclePath(chains, input.link);
    if (path !== undefined) {
      return { outcome: "cycle", link: input.link, path } satisfies ChainResult;
    }
    const record = await requireQuestRecord(ctx, input.link.quest_id);
    const current = parseQuestDocument(record);
    const events = await readQuestEvents(ctx, current.id);
    applyDomainGuardForMutation(() =>
      assertLeaseOwner(
        current,
        input.actor,
        timestamp,
        hasAcceptedEvent(events, current.id, input.actor),
      ),
    );
    if (current.status === "accepted") {
      await ctx.db.replace(record._id, renewLease(current, timestamp, input.lease_ttl_minutes));
    }
    await ctx.db.insert("chains", input.link);
    await appendEvent(
      ctx,
      input.link.quest_id,
      timestamp,
      input.actor,
      "chain",
      { ...input.link, session_guild: input.session_guild ?? null },
      args.test_failure,
    );
    return { outcome: "added", link: input.link } satisfies ChainResult;
  },
});

export const removeChainLink = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    await requireNoRestoreLease(ctx);
    const parsed = parseWriteInput(chainMutationSchema, args.input);
    const input = parseWriteInput(chainMutationSchema, { ...parsed, actor });
    const timestamp = now();
    const quests = await readQuests(ctx, timestamp);
    const sourceQuest = requireQuestInSnapshot(quests, input.link.quest_id);
    const targetQuest = requireQuestInSnapshot(quests, input.link.target_id);
    await requireRepositoryNotFenced(ctx, sourceQuest.repo);
    await requireRepositoryNotFenced(ctx, targetQuest.repo);
    const record = (await ctx.db.query("chains").collect()).find(
      (document) =>
        document.quest_id === input.link.quest_id &&
        document.target_id === input.link.target_id &&
        document.type === input.link.type,
    );
    if (record === undefined) {
      return { outcome: "missing", link: input.link } satisfies ChainRemovalResult;
    }
    const questRecord = await requireQuestRecord(ctx, input.link.quest_id);
    const current = parseQuestDocument(questRecord);
    await requireRepositoryNotFenced(ctx, current.repo);
    const events = await readQuestEvents(ctx, current.id);
    applyDomainGuardForMutation(() =>
      assertLeaseOwner(
        current,
        input.actor,
        timestamp,
        hasAcceptedEvent(events, current.id, input.actor),
      ),
    );
    await ctx.db.delete(record._id);
    if (current.status === "accepted") {
      await ctx.db.replace(
        questRecord._id,
        renewLease(current, timestamp, input.lease_ttl_minutes),
      );
    }
    await appendEvent(
      ctx,
      input.link.quest_id,
      timestamp,
      input.actor,
      "chain",
      { operation: "remove", link: input.link, session_guild: input.session_guild ?? null },
      args.test_failure,
    );
    return { outcome: "removed", link: input.link } satisfies ChainRemovalResult;
  },
});

export const addEvidence = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args);
    const parsed = parseWriteInput(newEvidenceSchema, args.input);
    await requireNoRestoreLease(ctx);
    const input = parseWriteInput(newEvidenceSchema, { ...parsed, added_by: actor });
    const record = await requireQuestRecord(ctx, input.quest_id);
    const current = parseQuestDocument(record);
    await requireRepositoryNotFenced(ctx, current.repo);
    const timestamp = now();
    const events = await readQuestEvents(ctx, current.id);
    if (input.stage === "signoff" && current.status !== "complete") {
      failQuestDomain(
        "SIGNOFF_NOT_COMPLETE",
        signoffNotCompleteInstruction(current.id, current.status),
      );
    }
    if (input.stage !== "signoff") {
      applyDomainGuardForMutation(() =>
        assertLeaseOwner(
          current,
          input.added_by,
          timestamp,
          hasAcceptedEvent(events, current.id, input.added_by),
        ),
      );
    }
    if (current.status === "accepted") {
      await ctx.db.replace(record._id, renewLease(current, timestamp, input.lease_ttl_minutes));
    }
    const evidenceId = await nextDocumentId(ctx, "evidence", "evidence");
    const evidence = evidenceSchema.parse({
      id: evidenceId,
      quest_id: input.quest_id,
      sha256: input.sha256,
      filename: input.filename,
      kind: input.kind,
      stage: input.stage,
      added_by: input.added_by,
      created_at: timestamp,
    });
    await ctx.db.insert("evidence", evidence);
    const { lease_ttl_minutes: _leaseTtlMinutes, ...persistedInput } = input;
    await appendEvent(
      ctx,
      input.quest_id,
      timestamp,
      input.added_by,
      "update",
      { evidence_id: evidenceId, ...persistedInput, session_guild: input.session_guild ?? null },
      args.test_failure,
    );
    return evidence;
  },
});

export const listQuests = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    filter: v.any(),
    lease_cutoff: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const filter = questFilterSchema.parse(args.filter);
    const leaseCutoff = parseLeaseCutoff(args.lease_cutoff);
    return listPageFor(ctx, {
      cursor: args.cursor,
      leaseCutoff,
      mode: "list",
      requestKey: stableSerialize(filter),
    });
  },
});

export const fencedRepositories = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    return listPageFor(ctx, {
      cursor: args.cursor,
      leaseCutoff: "",
      mode: "fences",
      requestKey: "fences",
    });
  },
});

export const federatedSnapshot = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const fencedRepositories = await activeFencedRepositories(ctx);
    const cursor = parseDumpCursor(
      args.cursor ?? (await createDumpCursor(ctx, now(), false, fencedRepositories)),
    );
    await requireStableDumpCursor(ctx, cursor, cursor.lease_cutoff, false, fencedRepositories);
    return {
      ...(await readDumpPage(ctx, cursor)),
      fencedRepositories,
    };
  },
});

export const federatedListSnapshot = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    repository: v.optional(v.string()),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const repository =
      args.repository === undefined ? undefined : questSchema.shape.repo.parse(args.repository);
    const leaseCutoff =
      args.cursor === undefined ? now() : parseListCursor(args.cursor).lease_cutoff;
    return listPageFor(ctx, {
      cursor: args.cursor,
      leaseCutoff,
      mode: "federated",
      requestKey: stableSerialize(repository ?? null),
    });
  },
});

export const getQuest = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    id: v.number(),
    lease_cutoff: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const id = questSchema.shape.id.parse(args.id);
    const record = await findQuestRecord(ctx, id);
    return record === null
      ? null
      : materializeExpiredLease(parseQuestDocument(record), parseLeaseCutoff(args.lease_cutoff));
  },
});

async function readQuestDetailSnapshot(ctx: QueryContext, id: number) {
  const quest = materializeExpiredLease(
    parseQuestDocument(await requireQuestRecord(ctx, id)),
    now(),
  );
  const [evidence, events, chains] = await Promise.all([
    readQuestEvidence(ctx, id),
    readQuestEvents(ctx, id),
    readQuestChains(ctx, id),
  ]);
  const relatedIds = [
    ...new Set(
      chains
        .flatMap((link) => [link.quest_id, link.target_id])
        .filter((relatedId) => relatedId !== id),
    ),
  ];
  const relatedQuests = await Promise.all(
    relatedIds.map(async (relatedId) =>
      materializeExpiredLease(parseQuestDocument(await requireQuestRecord(ctx, relatedId)), now()),
    ),
  );
  return { chains, events, evidence, quest, related_quests: relatedQuests };
}

export const questDetail = queryGeneric({
  args: { auth_token: v.optional(v.string()), id: v.number(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const id = questSchema.shape.id.parse(args.id);
    return readQuestDetailSnapshot(ctx, id);
  },
});

export const stats = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    scope: v.any(),
    lease_cutoff: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const scope = questScopeSchema.parse(args.scope);
    return listPageFor(ctx, {
      cursor: args.cursor,
      leaseCutoff: parseLeaseCutoff(args.lease_cutoff),
      mode: "stats",
      requestKey: stableSerialize(scope),
    });
  },
});

export const events = queryGeneric({
  args: { auth_token: v.optional(v.string()), quest_id: v.number(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const id = questSchema.shape.id.parse(args.quest_id);
    return readQuestEvents(ctx, id);
  },
});

export const queryEvents = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.union(v.string(), v.null())),
    filter: v.any(),
    lease_cutoff: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    await requireNoPartialRestore(ctx);
    const filter = eventFilterSchema.parse(args.filter);
    parseLeaseCutoff(args.lease_cutoff);
    return args.cursor === undefined
      ? readLegacyEventQuery(ctx, filter)
      : readEventQueryPage(ctx, filter, args.cursor);
  },
});

export const exportAll = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    lease_cutoff: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const leaseCutoff = parseLeaseCutoff(args.lease_cutoff);
    const cursor = parseDumpCursor(
      args.cursor ?? (await createDumpCursor(ctx, leaseCutoff, false)),
    );
    await requireStableDumpCursor(ctx, cursor, leaseCutoff, false);
    return readDumpPage(ctx, cursor);
  },
});

export const rawExportAll = queryGeneric({
  args: {
    auth_token: v.optional(v.string()),
    cursor: v.optional(v.string()),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const cursor = parseDumpCursor(args.cursor ?? (await createDumpCursor(ctx, "", true)));
    await requireStableDumpCursor(ctx, cursor, "", true);
    return readDumpPage(ctx, cursor);
  },
});

export const replaceAll = mutationGeneric({
  args: { auth_token: v.optional(v.string()), dump: v.optional(v.any()), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    return failQuestDomain(
      "CONVEX_MONOLITHIC_DUMP_UNSUPPORTED",
      "this Convex deployment no longer accepts a complete dump in one call; run the current Quest CLI so it can upload restore pages, then retry",
    );
  },
});

function parseRestoreExpectation(
  expectedHash: string | undefined,
  eventHighWater: number | undefined,
) {
  if (
    expectedHash === undefined ||
    !/^[0-9a-f]{64}$/.test(expectedHash) ||
    eventHighWater === undefined ||
    !Number.isSafeInteger(eventHighWater) ||
    eventHighWater < 0
  ) {
    failQuestDomain(
      "CONVEX_RESTORE_PRECONDITION_FAILED",
      "beginRestore needs the current snapshot fingerprint and event high-water mark; restart the restore with the current Quest CLI",
    );
  }
  return { eventHighWater, expectedHash };
}

function parseRestoreToken(value: string): string {
  const token = value.trim();
  if (token === "") {
    failQuestDomain(
      "CONVEX_RESTORE_TOKEN_REQUIRED",
      "Convex restore token is empty; retry with a new restore session",
    );
  }
  return token;
}

export const beginRestore = mutationGeneric({
  args: {
    auth_token: v.optional(v.string()),
    token: v.string(),
    expected_hash: v.optional(v.string()),
    expected_event_high_water: v.optional(v.number()),
    expected_snapshot: v.optional(v.string()),
    lease_cutoff: v.string(),
    restore_kind: v.optional(v.literal("full-backup")),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    if (args.expected_snapshot !== undefined) {
      failQuestDomain(
        "CONVEX_MONOLITHIC_DUMP_UNSUPPORTED",
        "this Convex deployment no longer accepts a complete snapshot in beginRestore; run the current Quest CLI so it can send the snapshot fingerprint and paged data, then retry",
      );
    }
    const expectation = parseRestoreExpectation(args.expected_hash, args.expected_event_high_water);
    const token = parseRestoreToken(args.token);
    const timestamp = now();
    const existing = await findRestoreLease(ctx);
    if (existing !== null) {
      if (existing.commit_phase !== undefined && existing.committed !== true) {
        failQuestDomain(
          "CONVEX_RESTORE_IN_PROGRESS",
          `Convex restore ${existing.token} stopped during its ${existing.commit_phase} phase; resume commitRestore with that token until it reports committed before starting another restore`,
        );
      }
      const expiresAt = Date.parse(existing.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt > Date.parse(timestamp)) {
        failQuestDomain(
          "CONVEX_RESTORE_IN_PROGRESS",
          "Convex restore is already in progress; retry after the active restore commits or rolls back",
        );
      }
      await restoreMigrationFencesAfterRestore(ctx, existing.token, existing.committed === true);
      if (!(await clearRestoreStagePage(ctx, existing.token))) {
        return { status: "cleanup" as const };
      }
      await ctx.db.delete(existing._id);
    }
    if ((await snapshotGeneration(ctx)) !== expectation.eventHighWater) {
      failQuestDomain(
        "CONVEX_RESTORE_PRECONDITION_FAILED",
        "Convex restore precondition failed; the store changed, so retry the restore",
      );
    }
    if (args.restore_kind === "full-backup") {
      const fenced = (await ctx.db.query("migration_fences").collect())[0];
      if (fenced !== undefined) {
        failQuestDomain(
          "BACKUP_FULL_RESTORE_FENCED",
          `full Convex restore would replace repository ${fenced.repo} while a migration fence exists; retry with a repository-scoped restore for ${fenced.repo} or recover the fence before restoring the complete backup`,
        );
      }
    }
    await ctx.db.insert("restore_leases", {
      token,
      expires_at: restoreLeaseExpiry(timestamp),
      expected_hash: expectation.expectedHash,
      expected_event_high_water: expectation.eventHighWater,
      lease_cutoff: parseLeaseCutoff(args.lease_cutoff),
      activated: false,
      replacement_hash: null,
      committed: false,
    });
    return { status: "ready" as const };
  },
});

export const renewRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const lease = await requireRestoreLease(ctx, args.token);
    await ctx.db.patch(lease._id, { expires_at: restoreLeaseExpiry(now()) });
    return null;
  },
});

export const activeRestore = queryGeneric({
  args: { auth_token: v.optional(v.string()), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const lease = await findRestoreLease(ctx);
    if (lease === null) {
      return null;
    }
    if (lease.committed === true) {
      return { status: "committed" as const, token: lease.token };
    }
    if (lease.commit_phase !== undefined) {
      return { status: lease.commit_phase, token: lease.token };
    }
    const expiresAt = Date.parse(lease.expires_at);
    const current = Date.parse(now());
    if (Number.isFinite(expiresAt) && Number.isFinite(current) && expiresAt <= current) {
      return { status: "expired" as const, token: lease.token };
    }
    return null;
  },
});

export const restoreStatus = queryGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args);
    const lease = await findRestoreLease(ctx, args.token);
    if (lease === null) {
      return { status: "missing" as const };
    }
    if (lease.committed !== true) {
      return { status: "active" as const };
    }
    await requireRestoreStateUnchanged(
      ctx,
      lease,
      true,
      "MIGRATION_COMMITTED_STATE_CHANGED",
      "the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
    );
    return {
      status: "committed" as const,
      lease_cutoff: parseLeaseCutoff(lease.lease_cutoff),
    };
  },
});

export const uploadRestorePage = mutationGeneric({
  args: {
    auth_token: v.optional(v.string()),
    token: v.string(),
    page: v.any(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true || lease.commit_phase !== undefined) {
      failQuestDomain(
        "CONVEX_RESTORE_STAGE_CHANGED",
        "the Convex restore stage is already committing or committed; reuse its existing result, or start a new restore before uploading different pages",
      );
    }
    await stageRestorePage(ctx, args.token, args.page);
    await ctx.db.patch(lease._id, { expires_at: restoreLeaseExpiry(now()) });
    return null;
  },
});

export const activateRestore = mutationGeneric({
  args: {
    auth_token: v.optional(v.string()),
    token: v.string(),
    replacement_hash: v.optional(v.string()),
    dump: v.optional(v.any()),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    if (args.dump !== undefined) {
      failQuestDomain(
        "CONVEX_MONOLITHIC_DUMP_UNSUPPORTED",
        "this Convex deployment no longer accepts a complete dump in activateRestore; run the current Quest CLI so it can upload restore pages, then retry",
      );
    }
    if (args.replacement_hash === undefined || !/^[0-9a-f]{64}$/.test(args.replacement_hash)) {
      failQuestDomain(
        "CONVEX_RESTORE_STAGE_CHANGED",
        "activateRestore needs the uploaded snapshot SHA-256 fingerprint; restart the restore with the current Quest CLI",
      );
    }
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true) {
      await requireRestoreStateUnchanged(
        ctx,
        lease,
        true,
        "MIGRATION_COMMITTED_STATE_CHANGED",
        "the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
      );
      return null;
    }
    if (lease.activated && lease.replacement_hash !== null) {
      const stagedHash = await restoreManifestFingerprint(ctx, args.token);
      if (stagedHash !== lease.replacement_hash) {
        failQuestDomain(
          "CONVEX_RESTORE_STAGE_CHANGED",
          "Convex restore stage is missing or changed; retry the restore",
        );
      }
      if (stagedHash !== args.replacement_hash) {
        failQuestDomain(
          "CONVEX_RESTORE_STAGE_CHANGED",
          "the activated Convex restore does not match the requested snapshot; start a new restore before uploading different data",
        );
      }
      return null;
    }
    await requireRestoreStateUnchanged(
      ctx,
      lease,
      false,
      "CONVEX_RESTORE_PRECONDITION_FAILED",
      "Convex restore precondition failed; the store changed, so retry the restore",
    );
    const replacementHash = await restoreManifestFingerprint(ctx, args.token);
    if (replacementHash !== args.replacement_hash) {
      failQuestDomain(
        "CONVEX_RESTORE_STAGE_CHANGED",
        "the uploaded Convex restore pages are incomplete or changed; retry every page from one unchanged backup, then activate again",
      );
    }
    await ctx.db.patch(lease._id, {
      expires_at: restoreLeaseExpiry(now()),
      activated: true,
      replacement_hash: replacementHash,
      replacement_high_water_quests: await restoreManifestHighWater(ctx, args.token, "quests"),
      replacement_high_water_evidence: await restoreManifestHighWater(ctx, args.token, "evidence"),
      replacement_high_water_events: await restoreManifestHighWater(ctx, args.token, "events"),
    });
    return null;
  },
});

export const fenceRepository = mutationGeneric({
  args: {
    token: v.string(),
    repo: v.string(),
    target_backend: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    const lease = await requireRestoreLease(ctx, args.token);
    const repo = args.repo.trim();
    if (repo === "") {
      failQuestDomain("MIGRATION_REPOSITORY_REQUIRED", "fenceRepository needs a repository name");
    }
    const existing = await ctx.db
      .query("migration_fences")
      .withIndex("by_repo", (query) => query.eq("repo", repo))
      .unique();
    if (existing !== null && existing.target_backend !== args.target_backend) {
      failQuestDomain(
        "MIGRATION_REPOSITORY_FENCED",
        `repository ${repo} is already fenced for ${existing.target_backend}; clear the existing migration fence before retrying`,
      );
    }
    if (existing !== null && existing.lease_token !== args.token) {
      failQuestDomain(
        "MIGRATION_FENCE_OWNER_MISMATCH",
        `repository ${repo} is already fenced by another migration; recover or clear the owning migration before retrying`,
      );
    }
    if (existing === null) {
      const recovery = await migrationFenceRecoveryFields(ctx, {
        committed: lease.committed,
        leaseCutoff: lease.lease_cutoff,
        repo,
      });
      await ctx.db.insert("migration_fences", {
        repo,
        target_backend: args.target_backend,
        created_at: now(),
        lease_token: args.token,
        ...recovery,
        unfenced: false,
      });
      await advanceFenceGeneration(ctx);
    }
    return null;
  },
});

export const unfenceRepository = mutationGeneric({
  args: { token: v.string(), repo: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireRestoreLease(ctx, args.token);
    const repo = args.repo.trim();
    const existing = await ctx.db
      .query("migration_fences")
      .withIndex("by_repo", (query) => query.eq("repo", repo))
      .unique();
    if (existing !== null) {
      if (existing.lease_token !== args.token) {
        failQuestDomain(
          "MIGRATION_FENCE_OWNER_MISMATCH",
          `repository ${repo} is fenced by another migration; use the owning migration token or recover it before retrying`,
        );
      }
      if (existing.unfenced !== true) {
        await ctx.db.patch(existing._id, { unfenced: true });
        await advanceFenceGeneration(ctx);
      }
    }
    return existing !== null;
  },
});

export const recoverRepositoryFence = mutationGeneric({
  args: { auth_token: v.optional(v.string()), repo: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const repo = args.repo.trim();
    if (repo === "") {
      failQuestDomain(
        "MIGRATION_REPOSITORY_REQUIRED",
        "recoverRepositoryFence needs a repository name",
      );
    }

    const committedRecovery = await recoverCommittedMigrationFence(ctx, repo);
    if (committedRecovery !== undefined) {
      return committedRecovery;
    }

    const existing = await findMigrationFence(ctx, repo);
    if (existing === null) {
      return false;
    }

    const lease = await findRestoreLease(ctx);
    if (lease === null) {
      if (isLegacyMigrationFence(existing) || existing.committed === false) {
        await deleteMigrationFence(ctx, existing);
        return true;
      }
      failQuestDomain(
        "MIGRATION_FENCE_STATUS_UNKNOWN",
        `repository ${repo} has no owning migration lease; ordinary member recovery cannot prove that the fence is stale, so verify routing and use the owning migration session or a privileged deployment recovery before retrying`,
      );
    }
    if (existing.lease_token !== lease.token) {
      failQuestDomain(
        "MIGRATION_FENCE_OWNER_MISMATCH",
        `repository ${repo} is fenced by another migration; recover or clear the owning migration before retrying`,
      );
    }
    const timestamp = now();
    const current = Date.parse(timestamp);
    const expiresAt = Date.parse(lease.expires_at);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt > current) {
      failQuestDomain(
        "MIGRATION_FENCE_RECOVERY_BLOCKED",
        "an active Convex migration lease still owns the fence; retry with the owning migration or wait for it to expire",
      );
    }
    if (isLegacyMigrationFence(existing)) {
      await verifyLegacyFenceSnapshot(ctx, repo, lease.expected_hash, lease.lease_cutoff);
      await requireRestoreStageEmpty(ctx, lease.token, `retry recovery for repository ${repo}`);
      await ctx.db.delete(lease._id);
      await deleteMigrationFence(ctx, existing);
      return true;
    }
    if (lease.committed === true || existing.committed !== false) {
      failQuestDomain(
        "MIGRATION_FENCE_STATUS_UNKNOWN",
        `repository ${repo} has a fence whose commit status cannot be proven; inspect routing and deployment state before retrying`,
      );
    }
    await requireRestoreStageEmpty(ctx, lease.token, `retry recovery for repository ${repo}`);
    await ctx.db.delete(lease._id);

    await deleteMigrationFence(ctx, existing);
    return true;
  },
});

export const recoverMigrationFenceForRestore = mutationGeneric({
  args: {
    auth_token: v.optional(v.string()),
    token: v.string(),
    repo: v.string(),
    ...clientProtocolArgs,
  },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const token = args.token.trim();
    const repo = args.repo.trim();
    if (token === "") {
      failQuestDomain(
        "MIGRATION_RESTORE_TOKEN_REQUIRED",
        "recoverMigrationFenceForRestore needs the active restore token",
      );
    }
    if (repo === "") {
      failQuestDomain(
        "MIGRATION_REPOSITORY_REQUIRED",
        "recoverMigrationFenceForRestore needs a repository name",
      );
    }
    await requireRestoreLease(ctx, token);
    const existing = await findMigrationFence(ctx, repo);
    if (existing === null) {
      return false;
    }
    if (
      existing.recovery_restore_token !== undefined &&
      existing.recovery_restore_token !== token
    ) {
      failQuestDomain(
        "MIGRATION_FENCE_OWNER_MISMATCH",
        `repository ${repo} is already being recovered by another restore; retry after that restore commits or rolls back`,
      );
    }
    if (existing.recovery_restore_token === token) {
      return true;
    }
    if (
      existing.committed !== true ||
      (existing.recovery_hash === undefined &&
        existing.recovery_event_high_water === undefined &&
        existing.recovery_repository_revision === undefined)
    ) {
      failQuestDomain(
        "MIGRATION_FENCE_STATUS_UNKNOWN",
        `repository ${repo} does not have a committed recovery fingerprint; use the owning migration session or a privileged deployment recovery before retrying`,
      );
    }
    await verifyCommittedFenceSnapshot(
      ctx,
      repo,
      existing.recovery_hash,
      existing.recovery_repository_revision,
      existing.recovery_event_high_water,
      existing.recovery_cutoff,
      false,
    );
    await ctx.db.patch(existing._id, {
      unfenced: true,
      recovery_restore_token: token,
    });
    await advanceFenceGeneration(ctx);
    return true;
  },
});

export const commitRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true) {
      await requireRestoreStateUnchanged(
        ctx,
        lease,
        true,
        "MIGRATION_COMMITTED_STATE_CHANGED",
        "the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
      );
      return {
        status: "committed" as const,
        lease_cutoff: parseLeaseCutoff(lease.lease_cutoff),
      };
    }
    if (!lease.activated || lease.replacement_hash === null) {
      await requireRestoreStateUnchanged(
        ctx,
        lease,
        false,
        "MIGRATION_CONCURRENT_WRITE",
        "the Convex store changed during a fence-only migration commit; retry the migration",
      );
      if (!(await clearRestoreStagePage(ctx, args.token))) {
        await ctx.db.patch(lease._id, { expires_at: restoreLeaseExpiry(now()) });
        return { status: "pending" as const };
      }
      const committedEventHighWater = await snapshotGeneration(ctx);
      await ctx.db.patch(lease._id, {
        expires_at: restoreLeaseExpiry(now()),
        committed_event_high_water: committedEventHighWater,
        committed: true,
      });
      await markMigrationFencesCommitted(ctx, args.token, lease.lease_cutoff);
      return {
        status: "committed" as const,
        lease_cutoff: parseLeaseCutoff(lease.lease_cutoff),
      };
    }
    const replacementHighWaterQuests = lease.replacement_high_water_quests;
    const replacementHighWaterEvidence = lease.replacement_high_water_evidence;
    const replacementHighWaterEvents = lease.replacement_high_water_events;
    if (
      replacementHighWaterQuests === undefined ||
      replacementHighWaterEvidence === undefined ||
      replacementHighWaterEvents === undefined
    ) {
      failQuestDomain(
        "CONVEX_MONOLITHIC_DUMP_UNSUPPORTED",
        `Convex restore ${lease.token} was staged by an older monolithic backend and has not changed the destination; call rollbackRestore with this token until it succeeds, then retry the restore with the current Quest CLI`,
      );
    }
    if (lease.commit_phase === undefined) {
      await ctx.db.patch(lease._id, {
        expires_at: restoreLeaseExpiry(now()),
        commit_phase: "deleting",
        sequence_floor_quests: await counterHighWater(ctx, "quests", "quests"),
        sequence_floor_evidence: await counterHighWater(ctx, "evidence", "evidence"),
        sequence_floor_events: await counterHighWater(ctx, "events", "events"),
        sequence_floor_snapshot_generation: await snapshotGeneration(ctx),
      });
      return { status: "pending" as const };
    }
    if (lease.commit_phase === "deleting") {
      if (!(await deleteRestoreDestinationPage(ctx))) {
        await ctx.db.patch(lease._id, { expires_at: restoreLeaseExpiry(now()) });
        return { status: "pending" as const };
      }
      await ctx.db.patch(lease._id, {
        expires_at: restoreLeaseExpiry(now()),
        commit_phase: "copying",
      });
      return { status: "pending" as const };
    }
    if (!(await copyRestoreStagePage(ctx, args.token))) {
      await ctx.db.patch(lease._id, { expires_at: restoreLeaseExpiry(now()) });
      return { status: "pending" as const };
    }
    const sequenceFloorQuests = lease.sequence_floor_quests;
    const sequenceFloorEvidence = lease.sequence_floor_evidence;
    const sequenceFloorEvents = lease.sequence_floor_events;
    const sequenceFloorSnapshotGeneration =
      lease.sequence_floor_snapshot_generation ?? lease.sequence_floor_events;
    if (
      sequenceFloorQuests === undefined ||
      sequenceFloorEvidence === undefined ||
      sequenceFloorEvents === undefined ||
      sequenceFloorSnapshotGeneration === undefined
    ) {
      failQuestDomain(
        "CONVEX_RESTORE_STAGE_CHANGED",
        "the paginated Convex restore lost its sequence metadata; keep the restore lease in place and retry with a current Quest CLI",
      );
    }
    await ctx.db.insert("counters", {
      name: "quests",
      value: Math.max(sequenceFloorQuests, replacementHighWaterQuests),
    });
    await ctx.db.insert("counters", {
      name: "evidence",
      value: Math.max(sequenceFloorEvidence, replacementHighWaterEvidence),
    });
    await ctx.db.insert("counters", {
      name: "events",
      value: Math.max(sequenceFloorEvents, replacementHighWaterEvents),
    });
    const committedSnapshotGeneration = sequenceFloorSnapshotGeneration + 1;
    await ctx.db.insert("counters", {
      name: SNAPSHOT_GENERATION_COUNTER,
      value: committedSnapshotGeneration,
    });
    const timestamp = now();
    await ctx.db.patch(lease._id, {
      expires_at: restoreLeaseExpiry(timestamp),
      expected_hash: lease.replacement_hash,
      expected_event_high_water: committedSnapshotGeneration,
      committed_event_high_water: committedSnapshotGeneration,
      lease_cutoff: timestamp,
      activated: false,
      replacement_hash: null,
      committed: true,
    });
    await markMigrationFencesCommitted(ctx, args.token, timestamp);
    return { status: "committed" as const, lease_cutoff: timestamp };
  },
});

export const releaseRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const lease = await findRestoreLease(ctx, args.token);
    if (lease !== null) {
      if (lease.commit_phase !== undefined && lease.committed !== true) {
        failQuestDomain(
          "CONVEX_RESTORE_IN_PROGRESS",
          `Convex restore ${lease.token} is in its ${lease.commit_phase} phase; resume commitRestore until it reports committed before releasing the restore`,
        );
      }
      if (!(await clearRestoreStagePage(ctx, args.token))) {
        return false;
      }
      await restoreMigrationFencesAfterRestore(ctx, args.token, lease.committed === true);
      await ctx.db.delete(lease._id);
    }
    for (const fence of await ctx.db.query("migration_fences").collect()) {
      if (fence.lease_token === args.token && fence.unfenced === true) {
        await ctx.db.delete(fence._id);
      }
    }
    return true;
  },
});

export const rollbackRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), ...clientProtocolArgs },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args);
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true) {
      failQuestDomain(
        "MIGRATION_COMMITTED",
        "the Convex restore already committed; release the restore lease instead of rolling it back",
      );
    }
    if (lease.commit_phase !== undefined) {
      failQuestDomain(
        "CONVEX_RESTORE_IN_PROGRESS",
        `Convex restore ${lease.token} is in its ${lease.commit_phase} phase; resume commitRestore until it reports committed because rollback can no longer reconstruct the previous store`,
      );
    }
    await requireRestoreStateUnchanged(
      ctx,
      lease,
      false,
      "CONVEX_RESTORE_PRECONDITION_FAILED",
      "Convex restore rollback precondition failed; the store changed, so retry the rollback",
    );
    await restoreMigrationFencesAfterRestore(ctx, args.token, false);
    if (!(await clearRestoreStagePage(ctx, args.token))) {
      return false;
    }
    await ctx.db.delete(lease._id);
    return true;
  },
});
