import {
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { v } from "convex/values";
import {
  allocateDisplayId,
  canApplyVerdict,
  computeQuestPlan,
  findChainCyclePath,
  isDispatchableQuest,
  isLeaseExpired,
  isLegalStatusTransition,
  isValidBackfill,
  leaseExpiry,
  materializeExpiredLease,
  signoffNotCompleteMessage,
  statusAfterClaimRelease,
  statusForRetestVerdict,
  statusForVerdict,
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
  type Quest,
  type QuestDump,
  type QuestFilter,
  type QuestScope,
  type QuestStats,
  type QuestTransition,
  questDumpSchema,
  questFilterSchema,
  questSchema,
  questScopeSchema,
  questStatsSchema,
  questTransitionSchema,
  type SignoffBatchInput,
  type SignoffBatchResult,
  STORE_SCHEMA_VERSION,
  signoffBatchInputSchema,
  signoffBatchResultSchema,
  stableSerialize,
  touchQuestInputSchema,
} from "../src/schema";
import { requireMemberActor, requireMemberQueryActor } from "./auth";
import type schema from "./schema";

const emptyArgs = {};
const failureArgs = { test_failure: v.optional(v.boolean()) };

function isRecord(value: unknown): value is Record<string, unknown> & { readonly id?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutSystemFields(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("Convex returned a non-object document");
  }
  const fields = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== "_id" && key !== "_creationTime" && key !== "token",
    ),
  );
  return fields;
}

function parseQuestDocument(value: unknown): Quest {
  return questSchema.parse(withoutSystemFields(value));
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
  | "restore_staged_events";
const RESTORE_LEASE_DURATION_MS = 10 * 60 * 1_000;

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

function counterValue<T extends { readonly id: number }>(items: readonly T[]): number {
  return allocateDisplayId(items.map((item) => item.id)) - 1;
}

async function counterHighWater(
  ctx: MutationContext,
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

async function readQuests(ctx: QueryContext, timestamp: string): Promise<Quest[]> {
  const documents = await ctx.db.query("quests").collect();
  return documents
    .map(parseQuestDocument)
    .map((quest) => materializeExpiredLease(quest, timestamp))
    .sort((left, right) => left.id - right.id);
}

async function readRawQuests(ctx: QueryContext): Promise<Quest[]> {
  const documents = await ctx.db.query("quests").collect();
  return documents.map(parseQuestDocument).sort((left, right) => left.id - right.id);
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
    throw new Error(`quest ${id} does not exist; check the display ID and retry`);
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
    throw new Error(`quest ${id} does not exist; check the display ID and retry`);
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

function requireLeaseOwner(
  quest: Quest,
  events: readonly Event[],
  actor: string,
  timestamp: string,
): void {
  if (quest.status !== "accepted") {
    return;
  }
  if (quest.lease_expires_at === null || isLeaseExpired(quest.lease_expires_at, timestamp)) {
    if (quest.assignee === actor) {
      throw new Error(`quest ${quest.id} lease expired; re-accept to continue`);
    }
    if (hasAcceptedEvent(events, quest.id, actor)) {
      throw new Error(`quest ${quest.id} lease expired; stop, ${quest.assignee} has it`);
    }
    throw new Error(`quest ${quest.id} lease expired; re-accept to continue`);
  }
  if (quest.assignee === actor) {
    return;
  }
  if (hasAcceptedEvent(events, quest.id, actor)) {
    throw new Error(`quest ${quest.id} lease expired; stop, ${quest.assignee} has it`);
  }
  if (quest.assignee === null) {
    throw new Error(`quest ${quest.id} has no active lease; re-accept to continue`);
  }
  throw new Error(
    `quest ${quest.id} lease owned by ${quest.assignee}; stop, ${quest.assignee} has it`,
  );
}

function requireActiveLeaseOwner(quest: Quest, owner: string, timestamp: string): void {
  if (quest.status !== "accepted") {
    throw new Error(`quest ${quest.id} is not accepted; re-accept to continue`);
  }
  if (quest.assignee !== owner) {
    if (quest.assignee === null) {
      throw new Error(`quest ${quest.id} has no active lease; re-accept to continue`);
    }
    throw new Error(
      `quest ${quest.id} lease owned by ${quest.assignee}; stop, ${quest.assignee} has it`,
    );
  }
  if (quest.lease_expires_at === null || isLeaseExpired(quest.lease_expires_at, timestamp)) {
    throw new Error(`quest ${quest.id} lease expired; re-accept to continue`);
  }
}

function applyVerdict(
  current: Quest,
  transition: Extract<QuestTransition, { action: "verdict" }>,
  timestamp: string,
): Quest {
  if (!canApplyVerdict(current.kind, current.status)) {
    throw new Error(`quest ${current.id} cannot receive a verdict from ${current.status}`);
  }
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
  if (
    current.status !== "turned_in" &&
    current.status !== "complete" &&
    current.status !== "dropped"
  ) {
    throw new Error(`illegal quest transition: ${current.status} -> reopen`);
  }
  const reopenedStatus =
    current.status === "dropped" && current.kind === "bug"
      ? "open"
      : statusAfterClaimRelease(current);
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
  switch (transition.action) {
    case "abandon": {
      const releasedStatus = statusAfterClaimRelease(current);
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
      if (current.status !== "complete") {
        throw new Error(signoffNotCompleteMessage(current.id, current.status));
      }
      return current;
    case "cancel":
      return applyCancel(current, transition, timestamp);
    case "reopen":
      return applyReopen(current, transition, timestamp);
    case "update":
      return applyUpdate(current, transition, timestamp);
  }
}

function filterQuests(
  quests: readonly Quest[],
  chains: readonly Chain[],
  filter: QuestFilter,
): Quest[] {
  const statusById = new Map(quests.map((quest) => [quest.id, quest.status]));
  const blockedIds = new Set<number>();
  if (filter.blocked !== undefined) {
    for (const link of chains) {
      if (link.type === "requires" && statusById.get(link.target_id) !== "complete") {
        blockedIds.add(link.quest_id);
      }
    }
  }
  return quests.filter(
    (quest) =>
      (filter.repo === undefined || quest.repo === filter.repo) &&
      (filter.status === undefined || quest.status === filter.status) &&
      (filter.area === undefined || quest.area === filter.area) &&
      (filter.kind === undefined || quest.kind === filter.kind) &&
      (filter.assignee === undefined || quest.assignee === filter.assignee) &&
      (filter.blocked === undefined || blockedIds.has(quest.id) === filter.blocked),
  );
}

function buildStats(quests: readonly Quest[], scope: QuestScope): QuestStats {
  const repositories = new Map<
    string,
    {
      total: number;
      statusCounts: Map<string, number>;
      verdictCounts: Map<string, number>;
      reopenCount: number;
      assigneeLoad: Map<string, number>;
    }
  >();
  for (const quest of quests) {
    if (scope.repo !== null && quest.repo !== scope.repo) {
      continue;
    }
    const aggregate = repositories.get(quest.repo) ?? {
      total: 0,
      statusCounts: new Map<string, number>(),
      verdictCounts: new Map<string, number>(),
      reopenCount: 0,
      assigneeLoad: new Map<string, number>(),
    };
    aggregate.total += 1;
    aggregate.statusCounts.set(quest.status, (aggregate.statusCounts.get(quest.status) ?? 0) + 1);
    if (quest.verdict !== null) {
      aggregate.verdictCounts.set(
        quest.verdict,
        (aggregate.verdictCounts.get(quest.verdict) ?? 0) + 1,
      );
    }
    aggregate.reopenCount += quest.reopen_count;
    if (quest.assignee !== null) {
      aggregate.assigneeLoad.set(
        quest.assignee,
        (aggregate.assigneeLoad.get(quest.assignee) ?? 0) + 1,
      );
    }
    repositories.set(quest.repo, aggregate);
  }
  const stats = {
    repos: [...repositories.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([repo, aggregate]) => ({
        repo,
        total: aggregate.total,
        status_counts: Object.fromEntries(aggregate.statusCounts),
        verdict_counts: Object.fromEntries(aggregate.verdictCounts),
        reopen_count: aggregate.reopenCount,
        assignee_load: Object.fromEntries(aggregate.assigneeLoad),
      })),
  } satisfies QuestStats;
  return questStatsSchema.parse(stats);
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

async function exportRawDump(ctx: QueryContext): Promise<QuestDump> {
  return createQuestDump(ctx, await readRawQuests(ctx));
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

async function readRepositoryQuests(
  ctx: QueryContext,
  repository: string,
  timestamp: string,
): Promise<Quest[]> {
  const documents = await ctx.db
    .query("quests")
    .withIndex("by_repo", (query) => query.eq("repo", repository))
    .collect();
  return documents
    .map(parseQuestDocument)
    .map((quest) => materializeExpiredLease(quest, timestamp))
    .sort((left, right) => left.id - right.id);
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
    await readRepositoryQuests(ctx, current.repo, timestamp),
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

async function clearRestoreStage(ctx: MutationContext, token: string): Promise<void> {
  const tables: readonly RestoreStageTable[] = [
    "restore_staged_events",
    "restore_staged_chains",
    "restore_staged_evidence",
    "restore_staged_quests",
  ];
  for (const table of tables) {
    const documents = await ctx.db
      .query(table)
      .withIndex("by_token", (query) => query.eq("token", token))
      .collect();
    for (const document of documents) {
      await ctx.db.delete(document._id);
    }
  }
}

async function stageRestoreDump(
  ctx: MutationContext,
  token: string,
  dump: QuestDump,
): Promise<void> {
  for (const quest of dump.quests) {
    await ctx.db.insert("restore_staged_quests", { token, ...quest });
  }
  for (const evidence of dump.evidence) {
    await ctx.db.insert("restore_staged_evidence", { token, ...evidence });
  }
  for (const chain of dump.chains) {
    await ctx.db.insert("restore_staged_chains", { token, ...chain });
  }
  for (const event of dump.events) {
    await ctx.db.insert("restore_staged_events", { token, ...event });
  }
}

async function readRestoreStage(ctx: QueryContext, token: string): Promise<QuestDump> {
  const quests = (
    await ctx.db
      .query("restore_staged_quests")
      .withIndex("by_token", (query) => query.eq("token", token))
      .collect()
  )
    .map(parseQuestDocument)
    .sort((left, right) => left.id - right.id);
  const evidence = (
    await ctx.db
      .query("restore_staged_evidence")
      .withIndex("by_token", (query) => query.eq("token", token))
      .collect()
  )
    .map(parseEvidenceDocument)
    .sort((left, right) => left.id - right.id);
  const chains = (
    await ctx.db
      .query("restore_staged_chains")
      .withIndex("by_token", (query) => query.eq("token", token))
      .collect()
  )
    .map(parseChainDocument)
    .sort(
      (left, right) =>
        left.quest_id - right.quest_id ||
        left.target_id - right.target_id ||
        left.type.localeCompare(right.type),
    );
  const events = (
    await ctx.db
      .query("restore_staged_events")
      .withIndex("by_token", (query) => query.eq("token", token))
      .collect()
  )
    .map(parseEventDocument)
    .sort((left, right) => left.id - right.id);
  return questDumpSchema.parse({
    schema_version: STORE_SCHEMA_VERSION,
    quests,
    evidence,
    chains,
    events,
  });
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

async function snapshotFingerprint(snapshot: QuestDump): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableSerialize(snapshot)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function legacySnapshotFingerprint(snapshot: QuestDump): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(snapshot)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matchesSnapshotFingerprint(snapshot: QuestDump, expected: string): Promise<boolean> {
  // Existing leases and fences have no hash-version field. Both hashes cover the
  // complete dump; the legacy form differs only in key ordering.
  return (
    (await snapshotFingerprint(snapshot)) === expected ||
    (await legacySnapshotFingerprint(snapshot)) === expected
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

async function repositorySnapshotFingerprint(
  snapshot: QuestDump,
  repository: string,
): Promise<string> {
  return snapshotFingerprint(repositorySnapshot(snapshot, repository));
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
    await restoreMigrationFencesAfterRestore(ctx, lease.token, lease.committed === true);
    await clearRestoreStage(ctx, lease.token);
    await ctx.db.delete(lease._id);
    return;
  }
  throw new Error(
    "Convex restore is in progress; retry after the active restore commits or rolls back",
  );
}

async function requireRestoreLease(ctx: MutationContext, token: string) {
  const lease = await findRestoreLease(ctx, token);
  if (lease === null) {
    throw new Error("Convex restore session is missing or expired; retry the restore");
  }
  const expiresAt = Date.parse(lease.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now())) {
    throw new Error("Convex restore session is missing or expired; retry the restore");
  }
  return lease;
}

async function requireRepositoryNotFenced(ctx: MutationContext, repository: string): Promise<void> {
  const fence = await ctx.db
    .query("migration_fences")
    .withIndex("by_repo", (query) => query.eq("repo", repository))
    .unique();
  if (fence !== null && fence.unfenced !== true) {
    throw new Error(
      `[MIGRATION_REPOSITORY_FENCED] repository ${repository} is fenced after a backend migration; refresh routing before retrying writes`,
    );
  }
}

async function removeAll(ctx: MutationContext): Promise<void> {
  const tables: readonly ("events" | "chains" | "evidence" | "quests" | "counters")[] = [
    "events",
    "chains",
    "evidence",
    "quests",
    "counters",
  ];
  for (const table of tables) {
    for (const document of await ctx.db.query(table).collect()) {
      await ctx.db.delete(document._id);
    }
  }
}

async function restoreDump(ctx: MutationContext, dump: QuestDump): Promise<void> {
  const sequenceFloor = {
    quests: await counterHighWater(ctx, "quests", "quests"),
    evidence: await counterHighWater(ctx, "evidence", "evidence"),
    events: await counterHighWater(ctx, "events", "events"),
  };
  await removeAll(ctx);
  for (const quest of dump.quests) {
    await ctx.db.insert("quests", quest);
  }
  for (const evidence of dump.evidence) {
    await ctx.db.insert("evidence", evidence);
  }
  for (const chain of dump.chains) {
    await ctx.db.insert("chains", chain);
  }
  for (const event of dump.events) {
    await ctx.db.insert("events", event);
  }
  await ctx.db.insert("counters", {
    name: "quests",
    value: Math.max(sequenceFloor.quests, counterValue(dump.quests)),
  });
  await ctx.db.insert("counters", {
    name: "evidence",
    value: Math.max(sequenceFloor.evidence, counterValue(dump.evidence)),
  });
  await ctx.db.insert("counters", {
    name: "events",
    value: Math.max(sequenceFloor.events, counterValue(dump.events)),
  });
}

async function markMigrationFencesCommitted(
  ctx: MutationContext,
  token: string,
  snapshot: QuestDump,
  recoveryCutoff: string,
): Promise<void> {
  const fences = await ctx.db.query("migration_fences").collect();
  for (const fence of fences) {
    if (fence.lease_token === token) {
      await ctx.db.patch(fence._id, {
        committed: true,
        recovery_hash: await repositorySnapshotFingerprint(snapshot, fence.repo),
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

async function restoreMigrationFencesAfterRestore(
  ctx: MutationContext,
  token: string,
  committed: boolean,
): Promise<void> {
  for (const fence of await ctx.db.query("migration_fences").collect()) {
    if (fence.recovery_restore_token === token) {
      if (committed) {
        await ctx.db.delete(fence._id);
        continue;
      }
      await ctx.db.patch(fence._id, {
        unfenced: false,
        recovery_restore_token: undefined,
      });
      continue;
    }
    if (fence.lease_token === token && !committed) {
      await ctx.db.delete(fence._id);
    }
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
    throw new Error(
      `[MIGRATION_FENCE_STATUS_UNKNOWN] repository ${repo} has a fence recovery restore without a live restore lease; inspect restore state before retrying`,
    );
  }
  const current = Date.parse(now());
  const expiresAt = Date.parse(pendingLease.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt > current) {
    throw new Error(
      `[MIGRATION_FENCE_RECOVERY_BLOCKED] repository ${repo} is being restored; retry after the backup restore commits or rolls back`,
    );
  }
  if (pendingLease.committed === true) {
    const committed = await exportDump(ctx, parseLeaseCutoff(pendingLease.lease_cutoff));
    if (!(await matchesSnapshotFingerprint(committed, pendingLease.expected_hash))) {
      throw new Error(
        "[MIGRATION_COMMITTED_STATE_CHANGED] the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
      );
    }
  }
  await restoreMigrationFencesAfterRestore(
    ctx,
    pendingLease.token,
    pendingLease.committed === true,
  );
  await clearRestoreStage(ctx, pendingLease.token);
  await ctx.db.delete(pendingLease._id);
  return pendingLease.committed === true;
}

function isLegacyMigrationFence(fence: {
  readonly committed?: boolean;
  readonly recovery_cutoff?: string;
  readonly recovery_hash?: string;
  readonly unfenced?: boolean;
}): boolean {
  return (
    fence.committed === undefined &&
    fence.recovery_cutoff === undefined &&
    fence.recovery_hash === undefined &&
    fence.unfenced === undefined
  );
}

async function verifyCommittedFenceSnapshot(
  ctx: MutationContext,
  repo: string,
  recoveryHash: string,
  recoveryCutoff: string | undefined,
  isUnfenced: boolean,
): Promise<void> {
  if (isUnfenced) {
    return;
  }
  const current = await exportDump(ctx, parseLeaseCutoff(recoveryCutoff ?? now()));
  if (!(await matchesRepositorySnapshotFingerprint(current, repo, recoveryHash))) {
    throw new Error(
      `[MIGRATION_FENCE_RECOVERY_BLOCKED] repository ${repo} changed after its committed migration; inspect the destination and routing before retrying`,
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
    throw new Error(
      `[MIGRATION_FENCE_RECOVERY_BLOCKED] repository ${repo} changed after its committed migration; inspect the destination and routing before retrying`,
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
  if (existing.recovery_hash === undefined) {
    throw new Error(
      `[MIGRATION_FENCE_STATUS_UNKNOWN] repository ${repo} has a committed fence without a recovery fingerprint; verify routing and use the owning migration session or a privileged deployment recovery before retrying`,
    );
  }
  const lease = await findRestoreLease(ctx);
  if (lease !== null) {
    if (lease.committed !== true) {
      throw new Error(
        `[MIGRATION_FENCE_STATUS_UNKNOWN] repository ${repo} has a committed fence but its owning lease is not committed; inspect migration state before retrying`,
      );
    }
    if (existing.lease_token !== lease.token) {
      throw new Error(
        `[MIGRATION_FENCE_OWNER_MISMATCH] repository ${repo} is fenced by another migration; recover or clear the owning migration before retrying`,
      );
    }
    const current = Date.parse(now());
    const expiresAt = Date.parse(lease.expires_at);
    if (
      existing.unfenced !== true &&
      (!Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt > current)
    ) {
      throw new Error(
        "[MIGRATION_FENCE_RECOVERY_BLOCKED] an active committed Convex migration lease still owns the fence; retry with the owning migration or wait for it to expire",
      );
    }
  }
  await verifyCommittedFenceSnapshot(
    ctx,
    repo,
    existing.recovery_hash,
    existing.recovery_cutoff,
    existing.unfenced === true,
  );
  if (lease !== null) {
    await clearRestoreStage(ctx, lease.token);
    await ctx.db.delete(lease._id);
  }
  await ctx.db.delete(existing._id);
  return true;
}

export const schemaVersion = queryGeneric({
  args: emptyArgs,
  handler: async () => STORE_SCHEMA_VERSION,
});

// Quest 83 deliberately leaves authorization to Quest 86; this provider is tested against an anonymous local deployment.
export const serverTime = queryGeneric({
  args: emptyArgs,
  handler: async () => now(),
});

export const addQuest = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = newQuestSchema.parse(args.input);
    await requireRepositoryNotFenced(ctx, parsed.repo);
    if (!isValidBackfill(parsed)) {
      throw new Error(
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
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = acceptQuestInputSchema.parse(args.input);
    return accept(ctx, { ...parsed, owner: actor }, args.test_failure);
  },
});

export const acceptQuestAndExport = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = acceptQuestInputSchema.parse(args.input);
    const acceptance = await accept(ctx, { ...parsed, owner: actor }, args.test_failure);
    // The port requires one atomic full snapshot here; pagination would change the provider contract.
    return { acceptance, snapshot: await exportDump(ctx, now()) };
  },
});

export const touchQuest = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = touchQuestInputSchema.parse(args.input);
    const input = { ...parsed, owner: actor };
    const record = await requireQuestRecord(ctx, input.id);
    const current = parseQuestDocument(record);
    await requireRepositoryNotFenced(ctx, current.repo);
    const timestamp = now();
    requireActiveLeaseOwner(current, input.owner, timestamp);
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
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const id = questSchema.shape.id.parse(args.id);
    const parsedTransition = questTransitionSchema.parse(args.transition);
    const transitionInput = questTransitionSchema.parse({ ...parsedTransition, actor });
    const record = await requireQuestRecord(ctx, id);
    const current = parseQuestDocument(record);
    await requireRepositoryNotFenced(ctx, current.repo);
    const timestamp = now();
    const events = await readQuestEvents(ctx, current.id);
    if (transitionInput.action !== "signoff") {
      requireLeaseOwner(current, events, transitionInput.actor, timestamp);
    }
    const updated = applyTransition(current, transitionInput, timestamp);
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
    applyTransition(quest, transition, now());
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
      throw new Error("sign-off batches accept only signoff-stage evidence");
    }
    const evidence = newEvidenceSchema.parse({ ...parsedEvidence, added_by: actor });
    const quest = questsById.get(evidence.quest_id);
    if (quest === undefined) {
      throw new Error(
        `sign-off evidence references quest ${evidence.quest_id} outside the requested batch`,
      );
    }
    if (quest.status !== "complete") {
      throw new Error(signoffNotCompleteMessage(quest.id, quest.status));
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
  const transition = questTransitionSchema.parse({ ...input.transition, actor });
  if (transition.action !== "signoff") {
    throw new Error("sign-off batch transition must use the signoff action");
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
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = signoffBatchInputSchema.parse(args.input);
    const prepared = await prepareSignoffBatch(ctx, parsed, actor);
    return persistSignoffBatch(ctx, prepared, args.test_failure);
  },
});

export const addChainLink = mutationGeneric({
  args: { auth_token: v.optional(v.string()), input: v.any(), ...failureArgs },
  handler: async (ctx, args) => {
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = chainMutationSchema.parse(args.input);
    const input = chainMutationSchema.parse({ ...parsed, actor });
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
    requireLeaseOwner(current, events, input.actor, timestamp);
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
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = chainMutationSchema.parse(args.input);
    const input = chainMutationSchema.parse({ ...parsed, actor });
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
    requireLeaseOwner(current, events, input.actor, timestamp);
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
    await requireNoRestoreLease(ctx);
    const actor = await requireMemberActor(ctx, args.auth_token);
    const parsed = newEvidenceSchema.parse(args.input);
    const input = newEvidenceSchema.parse({ ...parsed, added_by: actor });
    const record = await requireQuestRecord(ctx, input.quest_id);
    const current = parseQuestDocument(record);
    await requireRepositoryNotFenced(ctx, current.repo);
    const timestamp = now();
    const events = await readQuestEvents(ctx, current.id);
    if (input.stage === "signoff" && current.status !== "complete") {
      throw new Error(signoffNotCompleteMessage(current.id, current.status));
    }
    if (input.stage !== "signoff") {
      requireLeaseOwner(current, events, input.added_by, timestamp);
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
  args: { auth_token: v.optional(v.string()), filter: v.any(), lease_cutoff: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const filter = questFilterSchema.parse(args.filter);
    return filterQuests(
      await readQuests(ctx, parseLeaseCutoff(args.lease_cutoff)),
      await readChains(ctx),
      filter,
    );
  },
});

export const fencedRepositories = queryGeneric({
  args: { auth_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    return (await ctx.db.query("migration_fences").collect())
      .filter((fence) => fence.unfenced !== true)
      .map((fence) => fence.repo)
      .sort();
  },
});

export const federatedSnapshot = queryGeneric({
  args: { auth_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const timestamp = now();
    return {
      dump: await exportDump(ctx, timestamp),
      fencedRepositories: (await ctx.db.query("migration_fences").collect())
        .filter((fence) => fence.unfenced !== true)
        .map((fence) => fence.repo)
        .sort(),
    };
  },
});

export const getQuest = queryGeneric({
  args: { auth_token: v.optional(v.string()), id: v.number(), lease_cutoff: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const id = questSchema.shape.id.parse(args.id);
    const record = await findQuestRecord(ctx, id);
    return record === null
      ? null
      : materializeExpiredLease(parseQuestDocument(record), parseLeaseCutoff(args.lease_cutoff));
  },
});

export const questDetail = queryGeneric({
  args: { auth_token: v.optional(v.string()), id: v.number() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const id = questSchema.shape.id.parse(args.id);
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
        materializeExpiredLease(
          parseQuestDocument(await requireQuestRecord(ctx, relatedId)),
          now(),
        ),
      ),
    );
    return { chains, events, evidence, quest, related_quests: relatedQuests };
  },
});

export const stats = queryGeneric({
  args: { auth_token: v.optional(v.string()), scope: v.any(), lease_cutoff: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    return buildStats(
      await readQuests(ctx, parseLeaseCutoff(args.lease_cutoff)),
      questScopeSchema.parse(args.scope),
    );
  },
});

export const events = queryGeneric({
  args: { auth_token: v.optional(v.string()), quest_id: v.number() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const id = questSchema.shape.id.parse(args.quest_id);
    return readQuestEvents(ctx, id);
  },
});

export const queryEvents = queryGeneric({
  args: { auth_token: v.optional(v.string()), filter: v.any(), lease_cutoff: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const filter = eventFilterSchema.parse(args.filter);
    const quests = await readQuests(ctx, parseLeaseCutoff(args.lease_cutoff));
    const byId = new Map(quests.map((quest) => [quest.id, quest]));
    return (await readEvents(ctx)).filter((event) => {
      const quest = byId.get(event.quest_id);
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
    });
  },
});

export const exportAll = queryGeneric({
  args: { auth_token: v.optional(v.string()), lease_cutoff: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    return exportDump(ctx, parseLeaseCutoff(args.lease_cutoff));
  },
});

export const rawExportAll = queryGeneric({
  args: { auth_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    return exportRawDump(ctx);
  },
});

export const replaceAll = mutationGeneric({
  args: { auth_token: v.optional(v.string()), dump: v.any() },
  handler: async (ctx, args) => {
    await requireNoRestoreLease(ctx);
    await requireMemberActor(ctx, args.auth_token);
    await restoreDump(ctx, questDumpSchema.parse(args.dump));
    return null;
  },
});

export const beginRestore = mutationGeneric({
  args: {
    auth_token: v.optional(v.string()),
    token: v.string(),
    expected_snapshot: v.string(),
    lease_cutoff: v.string(),
    restore_kind: v.optional(v.literal("full-backup")),
  },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const token = args.token.trim();
    if (token === "") {
      throw new Error("Convex restore token is empty; retry with a new restore session");
    }
    const timestamp = now();
    const existing = await findRestoreLease(ctx);
    if (existing !== null) {
      const expiresAt = Date.parse(existing.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt > Date.parse(timestamp)) {
        throw new Error(
          "Convex restore is already in progress; retry after the active restore commits or rolls back",
        );
      }
      await restoreMigrationFencesAfterRestore(ctx, existing.token, existing.committed === true);
      await clearRestoreStage(ctx, existing.token);
      await ctx.db.delete(existing._id);
    }
    const current = await exportDump(ctx, parseLeaseCutoff(args.lease_cutoff));
    if (
      stableSerialize(current) !== args.expected_snapshot &&
      JSON.stringify(current) !== args.expected_snapshot
    ) {
      throw new Error(
        "Convex restore precondition failed; the store changed, so retry the restore",
      );
    }
    if (args.restore_kind === "full-backup") {
      const fenced = (await ctx.db.query("migration_fences").collect())[0];
      if (fenced !== undefined) {
        throw new Error(
          `[BACKUP_FULL_RESTORE_FENCED] full Convex restore would replace repository ${fenced.repo} while a migration fence exists; retry with a repository-scoped restore for ${fenced.repo} or recover the fence before restoring the complete backup`,
        );
      }
    }
    const expectedHash = await snapshotFingerprint(current);
    await ctx.db.insert("restore_leases", {
      token,
      expires_at: restoreLeaseExpiry(timestamp),
      expected_hash: expectedHash,
      lease_cutoff: parseLeaseCutoff(args.lease_cutoff),
      activated: false,
      replacement_hash: null,
      committed: false,
    });
    return null;
  },
});

export const renewRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const lease = await requireRestoreLease(ctx, args.token);
    await ctx.db.patch(lease._id, { expires_at: restoreLeaseExpiry(now()) });
    return null;
  },
});

export const restoreStatus = queryGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const lease = await findRestoreLease(ctx, args.token);
    if (lease === null) {
      return { status: "missing" as const };
    }
    if (lease.committed !== true) {
      return { status: "active" as const };
    }
    const committed = await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff));
    if (!(await matchesSnapshotFingerprint(committed, lease.expected_hash))) {
      throw new Error(
        "[MIGRATION_COMMITTED_STATE_CHANGED] the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
      );
    }
    return { status: "committed" as const, dump: committed };
  },
});

export const activateRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), dump: v.any() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true) {
      const committed = await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff));
      if (!(await matchesSnapshotFingerprint(committed, lease.expected_hash))) {
        throw new Error(
          "[MIGRATION_COMMITTED_STATE_CHANGED] the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
        );
      }
      return committed;
    }
    const cutoff = parseLeaseCutoff(lease.lease_cutoff);
    if (lease.activated && lease.replacement_hash !== null) {
      const staged = await readRestoreStage(ctx, args.token);
      if (!(await matchesSnapshotFingerprint(staged, lease.replacement_hash))) {
        throw new Error("Convex restore stage is missing or changed; retry the restore");
      }
      return staged;
    }
    const current = await exportDump(ctx, cutoff);
    if (!(await matchesSnapshotFingerprint(current, lease.expected_hash))) {
      throw new Error(
        "Convex restore precondition failed; the store changed, so retry the restore",
      );
    }
    const replacement = questDumpSchema.parse(args.dump);
    await clearRestoreStage(ctx, args.token);
    await stageRestoreDump(ctx, args.token, replacement);
    const staged = await readRestoreStage(ctx, args.token);
    const replacementHash = await snapshotFingerprint(staged);
    await ctx.db.patch(lease._id, {
      expires_at: restoreLeaseExpiry(now()),
      activated: true,
      replacement_hash: replacementHash,
    });
    return staged;
  },
});

export const fenceRepository = mutationGeneric({
  args: { token: v.string(), repo: v.string(), target_backend: v.string() },
  handler: async (ctx, args) => {
    const lease = await requireRestoreLease(ctx, args.token);
    const repo = args.repo.trim();
    if (repo === "") {
      throw new Error("[MIGRATION_REPOSITORY_REQUIRED] fenceRepository needs a repository name");
    }
    const existing = await ctx.db
      .query("migration_fences")
      .withIndex("by_repo", (query) => query.eq("repo", repo))
      .unique();
    if (existing !== null && existing.target_backend !== args.target_backend) {
      throw new Error(
        `[MIGRATION_REPOSITORY_FENCED] repository ${repo} is already fenced for ${existing.target_backend}; clear the existing migration fence before retrying`,
      );
    }
    if (existing !== null && existing.lease_token !== args.token) {
      throw new Error(
        `[MIGRATION_FENCE_OWNER_MISMATCH] repository ${repo} is already fenced by another migration; recover or clear the owning migration before retrying`,
      );
    }
    if (existing === null) {
      const committed = lease.committed === true;
      const recoveryHash = committed
        ? await repositorySnapshotFingerprint(
            await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff)),
            repo,
          )
        : undefined;
      await ctx.db.insert("migration_fences", {
        repo,
        target_backend: args.target_backend,
        created_at: now(),
        lease_token: args.token,
        committed,
        ...(recoveryHash === undefined ? {} : { recovery_hash: recoveryHash }),
        ...(committed ? { recovery_cutoff: lease.lease_cutoff } : {}),
        unfenced: false,
      });
    }
    return null;
  },
});

export const unfenceRepository = mutationGeneric({
  args: { token: v.string(), repo: v.string() },
  handler: async (ctx, args) => {
    await requireRestoreLease(ctx, args.token);
    const repo = args.repo.trim();
    const existing = await ctx.db
      .query("migration_fences")
      .withIndex("by_repo", (query) => query.eq("repo", repo))
      .unique();
    if (existing !== null) {
      if (existing.lease_token !== args.token) {
        throw new Error(
          `[MIGRATION_FENCE_OWNER_MISMATCH] repository ${repo} is fenced by another migration; use the owning migration token or recover it before retrying`,
        );
      }
      await ctx.db.patch(existing._id, { unfenced: true });
    }
    return existing !== null;
  },
});

export const recoverRepositoryFence = mutationGeneric({
  args: { auth_token: v.optional(v.string()), repo: v.string() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const repo = args.repo.trim();
    if (repo === "") {
      throw new Error(
        "[MIGRATION_REPOSITORY_REQUIRED] recoverRepositoryFence needs a repository name",
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
        await ctx.db.delete(existing._id);
        return true;
      }
      throw new Error(
        `[MIGRATION_FENCE_STATUS_UNKNOWN] repository ${repo} has no owning migration lease; ordinary member recovery cannot prove that the fence is stale, so verify routing and use the owning migration session or a privileged deployment recovery before retrying`,
      );
    }
    if (existing.lease_token !== lease.token) {
      throw new Error(
        `[MIGRATION_FENCE_OWNER_MISMATCH] repository ${repo} is fenced by another migration; recover or clear the owning migration before retrying`,
      );
    }
    const timestamp = now();
    const current = Date.parse(timestamp);
    const expiresAt = Date.parse(lease.expires_at);
    if (!Number.isFinite(expiresAt) || !Number.isFinite(current) || expiresAt > current) {
      throw new Error(
        "[MIGRATION_FENCE_RECOVERY_BLOCKED] an active Convex migration lease still owns the fence; retry with the owning migration or wait for it to expire",
      );
    }
    if (isLegacyMigrationFence(existing)) {
      await verifyLegacyFenceSnapshot(ctx, repo, lease.expected_hash, lease.lease_cutoff);
      await clearRestoreStage(ctx, lease.token);
      await ctx.db.delete(lease._id);
      await ctx.db.delete(existing._id);
      return true;
    }
    if (lease.committed === true || existing.committed !== false) {
      throw new Error(
        `[MIGRATION_FENCE_STATUS_UNKNOWN] repository ${repo} has a fence whose commit status cannot be proven; inspect routing and deployment state before retrying`,
      );
    }
    await clearRestoreStage(ctx, lease.token);
    await ctx.db.delete(lease._id);

    await ctx.db.delete(existing._id);
    return true;
  },
});

export const recoverMigrationFenceForRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string(), repo: v.string() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const token = args.token.trim();
    const repo = args.repo.trim();
    if (token === "") {
      throw new Error(
        "[MIGRATION_RESTORE_TOKEN_REQUIRED] recoverMigrationFenceForRestore needs the active restore token",
      );
    }
    if (repo === "") {
      throw new Error(
        "[MIGRATION_REPOSITORY_REQUIRED] recoverMigrationFenceForRestore needs a repository name",
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
      throw new Error(
        `[MIGRATION_FENCE_OWNER_MISMATCH] repository ${repo} is already being recovered by another restore; retry after that restore commits or rolls back`,
      );
    }
    if (existing.recovery_restore_token === token) {
      return true;
    }
    if (existing.committed !== true || existing.recovery_hash === undefined) {
      throw new Error(
        `[MIGRATION_FENCE_STATUS_UNKNOWN] repository ${repo} does not have a committed recovery fingerprint; use the owning migration session or a privileged deployment recovery before retrying`,
      );
    }
    await verifyCommittedFenceSnapshot(
      ctx,
      repo,
      existing.recovery_hash,
      existing.recovery_cutoff,
      false,
    );
    await ctx.db.patch(existing._id, {
      unfenced: true,
      recovery_restore_token: token,
    });
    return true;
  },
});

export const commitRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true) {
      const committed = await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff));
      if (!(await matchesSnapshotFingerprint(committed, lease.expected_hash))) {
        throw new Error(
          "[MIGRATION_COMMITTED_STATE_CHANGED] the committed Convex restore no longer matches its recorded snapshot; inspect the destination before retrying",
        );
      }
      return committed;
    }
    if (!lease.activated || lease.replacement_hash === null) {
      const current = await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff));
      if (!(await matchesSnapshotFingerprint(current, lease.expected_hash))) {
        throw new Error(
          "[MIGRATION_CONCURRENT_WRITE] the Convex store changed during a fence-only migration commit; retry the migration",
        );
      }
      await clearRestoreStage(ctx, args.token);
      await ctx.db.patch(lease._id, {
        expires_at: restoreLeaseExpiry(now()),
        committed: true,
      });
      await markMigrationFencesCommitted(ctx, args.token, current, lease.lease_cutoff);
      return current;
    }
    const staged = await readRestoreStage(ctx, args.token);
    if (!(await matchesSnapshotFingerprint(staged, lease.replacement_hash))) {
      throw new Error("Convex restore stage is missing or changed; retry the restore");
    }
    const timestamp = now();
    await restoreDump(ctx, staged);
    const committed = await exportDump(ctx, timestamp);
    await clearRestoreStage(ctx, args.token);
    await ctx.db.patch(lease._id, {
      expires_at: restoreLeaseExpiry(timestamp),
      expected_hash: await snapshotFingerprint(committed),
      lease_cutoff: timestamp,
      activated: false,
      replacement_hash: null,
      committed: true,
    });
    await markMigrationFencesCommitted(ctx, args.token, committed, timestamp);
    return committed;
  },
});

export const releaseRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const lease = await findRestoreLease(ctx, args.token);
    if (lease !== null) {
      await restoreMigrationFencesAfterRestore(ctx, args.token, lease.committed === true);
      await clearRestoreStage(ctx, args.token);
      await ctx.db.delete(lease._id);
    }
    for (const fence of await ctx.db.query("migration_fences").collect()) {
      if (fence.lease_token === args.token && fence.unfenced === true) {
        await ctx.db.delete(fence._id);
      }
    }
    return null;
  },
});

export const rollbackRestore = mutationGeneric({
  args: { auth_token: v.optional(v.string()), token: v.string() },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    const lease = await requireRestoreLease(ctx, args.token);
    if (lease.committed === true) {
      throw new Error(
        "[MIGRATION_COMMITTED] the Convex restore already committed; release the restore lease instead of rolling it back",
      );
    }
    const current = await exportDump(ctx, parseLeaseCutoff(lease.lease_cutoff));
    if (!(await matchesSnapshotFingerprint(current, lease.expected_hash))) {
      throw new Error(
        "Convex restore rollback precondition failed; the store changed, so retry the rollback",
      );
    }
    await restoreMigrationFencesAfterRestore(ctx, args.token, false);
    await clearRestoreStage(ctx, args.token);
    await ctx.db.delete(lease._id);
    return null;
  },
});
