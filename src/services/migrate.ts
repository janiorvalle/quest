import {
  type Event,
  eventBaseSchema,
  migrationResultSchema,
  type QuestDump,
  questDumpSchema,
  type StoreConfig,
  stableSerialize,
} from "../schema";
import type { BlobStore, QuestStore, StoreMigrationSession } from "../store";
import type { BackupOperations, BackupRunResult } from "./backup";

export interface RepositoryMigrationBackend {
  readonly config: StoreConfig;
  readonly backup: BackupOperations;
  readonly blobStore: BlobStore;
  readonly questStore: QuestStore;
}

export interface RepositoryMigrationOptions {
  readonly repository: string;
  readonly source: RepositoryMigrationBackend;
  readonly target: RepositoryMigrationBackend;
  readonly writeRouting: () => Promise<void>;
  readonly verifyRouting: () => Promise<boolean>;
  readonly verifyDestinationRouting: () => Promise<boolean>;
  readonly rollbackRouting: () => Promise<boolean>;
}

function migrationError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

type RoutingState = "source" | "destination" | "unknown";

interface RoutingCleanupResult {
  readonly failures: readonly string[];
  readonly state: RoutingState;
}

interface RoutingStateResult {
  readonly failures: readonly string[];
  readonly state: RoutingState;
}

function normalizedEvent(event: Event): Event {
  return eventBaseSchema.parse({
    id: event.id,
    quest_id: event.quest_id,
    at: event.at,
    actor: event.actor,
    action: event.action,
    detail: event.detail,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remapDetailId(
  detail: Record<string, unknown>,
  field: string,
  mapping: ReadonlyMap<number, number>,
  entity: string,
): Record<string, unknown> {
  const value = detail[field];
  return typeof value === "number"
    ? { ...detail, [field]: mappedId(mapping, value, entity) }
    : detail;
}

function remapChainDetail(value: unknown, questIds: ReadonlyMap<number, number>): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const questId = value["quest_id"];
  const targetId = value["target_id"];
  if (typeof questId !== "number" || typeof targetId !== "number") {
    return value;
  }
  return {
    ...value,
    quest_id: mappedId(questIds, questId, "event chain"),
    target_id: mappedId(questIds, targetId, "event chain"),
  };
}

function remapEventDetail(
  event: Event,
  questIds: ReadonlyMap<number, number>,
  evidenceIds: ReadonlyMap<number, number>,
): unknown {
  if (!isRecord(event.detail)) {
    return event.detail;
  }
  switch (event.action) {
    case "add":
      return remapDetailId(event.detail, "id", questIds, "event quest");
    case "verdict":
      return remapDetailId(event.detail, "duplicate_of", questIds, "event duplicate target");
    case "chain": {
      const remapped = remapDetailId(
        remapDetailId(event.detail, "quest_id", questIds, "event chain quest"),
        "target_id",
        questIds,
        "event chain target",
      );
      const link = remapped["link"];
      return link === undefined
        ? remapped
        : { ...remapped, link: remapChainDetail(link, questIds) };
    }
    case "update":
      return remapDetailId(
        remapDetailId(event.detail, "quest_id", questIds, "event evidence quest"),
        "evidence_id",
        evidenceIds,
        "event evidence",
      );
    default:
      return event.detail;
  }
}

function requireRepositoryLocalChains(dump: QuestDump, repository: string): void {
  const questsById = new Map(dump.quests.map((quest) => [quest.id, quest]));
  for (const link of dump.chains) {
    if (!questsById.has(link.quest_id) || !questsById.has(link.target_id)) {
      throw migrationError(
        "MIGRATION_INVALID_DUMP",
        `chain ${link.quest_id} -> ${link.target_id} references a missing quest; repair the source store and retry`,
      );
    }
  }
  const crossRepositoryLinks = dump.chains.filter(({ quest_id, target_id }) => {
    const source = questsById.get(quest_id);
    const target = questsById.get(target_id);
    return (
      source?.repo !== target?.repo && (source?.repo === repository || target?.repo === repository)
    );
  });
  if (crossRepositoryLinks.length === 0) {
    return;
  }
  const descriptions = crossRepositoryLinks.map((link) => {
    const source = questsById.get(link.quest_id);
    const target = questsById.get(link.target_id);
    if (source === undefined || target === undefined) {
      throw migrationError(
        "MIGRATION_INVALID_DUMP",
        `chain ${link.quest_id} -> ${link.target_id} references a missing quest; repair the source store and retry`,
      );
    }
    return `quest ${source.id} "${source.title}" (${source.repo}) ${link.type} quest ${target.id} "${target.title}" (${target.repo})`;
  });
  const removalExample = crossRepositoryLinks.find((link) => link.type === "requires");
  const removalInstruction =
    removalExample === undefined
      ? "remove the listed links with quest chain remove and retry"
      : `remove the listed links with quest chain remove (for example: quest chain rm ${removalExample.quest_id} --requires ${removalExample.target_id}) and retry`;
  throw migrationError(
    "MIGRATION_CROSS_REPO_LINKS",
    `repository ${repository} has cross-repository chain links: ${descriptions.join("; ")}. Migrate each linked repository into the same deployment so the links survive, or ${removalInstruction}`,
  );
}

function eventReferenceIds(event: Event): {
  readonly quest_ids: readonly number[];
  readonly evidence_ids: readonly number[];
} {
  if (!isRecord(event.detail)) {
    return { evidence_ids: [], quest_ids: [] };
  }
  const questIds: number[] = [];
  const evidenceIds: number[] = [];
  const addNumber = (value: unknown, target: number[]): void => {
    if (typeof value === "number") {
      target.push(value);
    }
  };
  switch (event.action) {
    case "verdict":
      addNumber(event.detail["duplicate_of"], questIds);
      break;
    case "chain":
      addNumber(event.detail["quest_id"], questIds);
      addNumber(event.detail["target_id"], questIds);
      if (isRecord(event.detail["link"])) {
        addNumber(event.detail["link"]["quest_id"], questIds);
        addNumber(event.detail["link"]["target_id"], questIds);
      }
      break;
    case "update":
      addNumber(event.detail["quest_id"], questIds);
      addNumber(event.detail["evidence_id"], evidenceIds);
      break;
    default:
      break;
  }
  return { evidence_ids: evidenceIds, quest_ids: questIds };
}

function requireRepositoryLocalEventReferences(dump: QuestDump, repository: string): void {
  const removedQuestIds = new Set(
    dump.quests.filter((quest) => quest.repo === repository).map((quest) => quest.id),
  );
  const removedEvidenceIds = new Set(
    dump.evidence
      .filter((evidence) => removedQuestIds.has(evidence.quest_id))
      .map((item) => item.id),
  );
  const crossBoundaryEvent = dump.events.find((event) => {
    if (removedQuestIds.has(event.quest_id)) {
      return false;
    }
    const references = eventReferenceIds(event);
    return (
      references.quest_ids.some((id) => removedQuestIds.has(id)) ||
      references.evidence_ids.some((id) => removedEvidenceIds.has(id))
    );
  });
  if (crossBoundaryEvent === undefined) {
    return;
  }
  throw migrationError(
    "MIGRATION_CROSS_REPOSITORY_EVENT",
    `event ${crossBoundaryEvent.id} owned by retained quest ${crossBoundaryEvent.quest_id} references ${repository}; preserve the historical link by migrating both repositories together or repair the source history and retry`,
  );
}

function repositoryDump(dump: QuestDump, repository: string): QuestDump {
  requireRepositoryLocalChains(dump, repository);
  const quests = dump.quests.filter((quest) => quest.repo === repository);
  const questIds = new Set(quests.map(({ id }) => id));
  return questDumpSchema.parse({
    schema_version: dump.schema_version,
    quests,
    evidence: dump.evidence.filter(({ quest_id }) => questIds.has(quest_id)),
    chains: dump.chains.filter(
      ({ quest_id, target_id }) => questIds.has(quest_id) && questIds.has(target_id),
    ),
    events: dump.events.filter(({ quest_id }) => questIds.has(quest_id)).map(normalizedEvent),
  });
}

function selectRepositoryDump(dump: QuestDump, repository: string): QuestDump {
  const selected = repositoryDump(dump, repository);
  if (selected.quests.length === 0) {
    throw migrationError(
      "MIGRATION_REPOSITORY_NOT_FOUND",
      `repository ${repository} has no quests in the source snapshot; check the repository name and retry`,
    );
  }
  return selected;
}

function nextAvailableId(used: Set<number>, candidate: number): number {
  let next = candidate;
  while (used.has(next)) {
    next += 1;
  }
  used.add(next);
  return next;
}

function displayIdMap(
  sourceIds: readonly number[],
  retainedIds: readonly number[],
): ReadonlyMap<number, number> {
  const used = new Set(retainedIds);
  const mapping = new Map<number, number>();
  let previous = 0;
  for (const sourceId of [...sourceIds].sort((left, right) => left - right)) {
    const mapped = nextAvailableId(used, Math.max(sourceId, previous + 1));
    mapping.set(sourceId, mapped);
    previous = mapped;
  }
  return mapping;
}

function mappedId(mapping: ReadonlyMap<number, number>, id: number, entity: string): number {
  const mapped = mapping.get(id);
  if (mapped === undefined) {
    throw migrationError(
      "MIGRATION_INVALID_DUMP",
      `${entity} references missing display ID ${id}; repair the source store and retry`,
    );
  }
  return mapped;
}

function mergeRepositoryDump(
  destination: QuestDump,
  sourceRepository: QuestDump,
  repository: string,
): QuestDump {
  const retainedQuests = destination.quests.filter((quest) => quest.repo !== repository);
  const retainedQuestIds = new Set(retainedQuests.map(({ id }) => id));
  const questIds = displayIdMap(
    sourceRepository.quests.map(({ id }) => id),
    [...retainedQuestIds],
  );
  const removedQuestIds = new Set(
    destination.quests.filter((quest) => quest.repo === repository).map(({ id }) => id),
  );
  const retainedEvidence = destination.evidence.filter(
    ({ quest_id }) => !removedQuestIds.has(quest_id),
  );
  const retainedEvents = destination.events.filter(
    ({ quest_id }) => !removedQuestIds.has(quest_id),
  );
  const retainedChains = destination.chains.filter(
    ({ quest_id, target_id }) => !removedQuestIds.has(quest_id) && !removedQuestIds.has(target_id),
  );
  const evidenceIds = displayIdMap(
    sourceRepository.evidence.map(({ id }) => id),
    retainedEvidence.map(({ id }) => id),
  );
  const eventIds = displayIdMap(
    sourceRepository.events.map(({ id }) => id),
    retainedEvents.map(({ id }) => id),
  );

  const quests = sourceRepository.quests.map((quest) => ({
    ...quest,
    id: mappedId(questIds, quest.id, "quest"),
  }));
  const evidence = sourceRepository.evidence.map((item) => ({
    ...item,
    id: mappedId(evidenceIds, item.id, "evidence"),
    quest_id: mappedId(questIds, item.quest_id, "evidence"),
  }));
  const chains = sourceRepository.chains.map((link) => ({
    ...link,
    quest_id: mappedId(questIds, link.quest_id, "chain"),
    target_id: mappedId(questIds, link.target_id, "chain"),
  }));
  const events = sourceRepository.events.map((event) => ({
    ...normalizedEvent(event),
    id: mappedId(eventIds, event.id, "event"),
    quest_id: mappedId(questIds, event.quest_id, "event"),
    detail: remapEventDetail(event, questIds, evidenceIds),
  }));

  return questDumpSchema.parse({
    schema_version: destination.schema_version,
    quests: [...retainedQuests, ...quests].sort((left, right) => left.id - right.id),
    evidence: [...retainedEvidence, ...evidence].sort((left, right) => left.id - right.id),
    chains: [...retainedChains, ...chains].sort(
      (left, right) =>
        left.quest_id - right.quest_id ||
        left.target_id - right.target_id ||
        left.type.localeCompare(right.type),
    ),
    events: [...retainedEvents.map(normalizedEvent), ...events].sort(
      (left, right) => left.id - right.id,
    ),
  });
}

function requireMigrationCapability(store: QuestStore, role: "source" | "destination"): void {
  if (store.beginMigration === undefined) {
    throw migrationError(
      "MIGRATION_LOCK_UNAVAILABLE",
      `the ${role} backend cannot hold a migration lock; upgrade quest and retry without moving data`,
    );
  }
}

function countsForRepository(dump: QuestDump, repository: string) {
  const selected = repositoryDump(dump, repository);
  return {
    quests: selected.quests.length,
    evidence: selected.evidence.length,
    chains: selected.chains.length,
    events: selected.events.length,
  };
}

function sampledEvidenceHashes(dump: QuestDump, repository: string): string[] {
  const hashes = [
    ...new Set(repositoryDump(dump, repository).evidence.map(({ sha256 }) => sha256)),
  ].sort();
  return hashes.slice(0, 3);
}

export function requireMatchingDump(expected: QuestDump, actual: QuestDump): void {
  if (stableSerialize(expected) !== stableSerialize(actual)) {
    throw migrationError(
      "MIGRATION_VERIFY_MISMATCH",
      "the destination export differs from the replay plan; no routing change was written, inspect the destination and retry",
    );
  }
}

function deploymentFor(store: StoreConfig): string | null {
  return store.backend === "convex" ? (store.deployment ?? store.convex_deployment ?? null) : null;
}

interface RepositoryMigrationPlan {
  readonly destinationBackup: BackupRunResult;
  readonly destinationDump: QuestDump;
  readonly replacement: QuestDump;
  readonly sourceBackup: BackupRunResult;
  readonly sourceSession: StoreMigrationSession;
  readonly targetSession: StoreMigrationSession;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function beginMigrationSession(
  store: QuestStore,
  expected: QuestDump,
  role: "source" | "destination",
): Promise<StoreMigrationSession> {
  if (store.beginMigration === undefined) {
    throw migrationError(
      "MIGRATION_LOCK_UNAVAILABLE",
      `the ${role} backend cannot hold a migration lock; upgrade quest and retry without moving data`,
    );
  }
  try {
    return await store.beginMigration(expected);
  } catch (error: unknown) {
    throw new Error(
      `[MIGRATION_CONCURRENT_WRITE] could not lock the ${role} backend: ${errorDetail(error)}`,
    );
  }
}

async function recoverDestinationFenceBeforeLock(
  options: RepositoryMigrationOptions,
  repository: string,
): Promise<void> {
  const recover = options.target.questStore.recoverMigrationFence;
  if (recover === undefined) {
    return;
  }
  if (!(await options.verifyRouting())) {
    throw migrationError(
      "MIGRATION_ROUTE_CHANGED",
      `routing for ${repository} is no longer verified on the source backend; do not recover the destination fence, inspect routing, and retry`,
    );
  }
  await recover.call(options.target.questStore, repository);
}

async function rollbackSessions(
  targetSession: StoreMigrationSession | undefined,
  sourceSession: StoreMigrationSession | undefined,
): Promise<string | null> {
  const failures: string[] = [];
  if (targetSession !== undefined) {
    try {
      await targetSession.rollback();
    } catch (error: unknown) {
      failures.push(`destination rollback: ${errorDetail(error)}`);
    }
  }
  if (sourceSession !== undefined) {
    try {
      await sourceSession.release();
    } catch (error: unknown) {
      failures.push(`source unlock: ${errorDetail(error)}`);
    }
  }
  return failures.length === 0 ? null : failures.join("; ");
}

async function releaseSessions(
  targetSession: StoreMigrationSession,
  sourceSession: StoreMigrationSession,
): Promise<string | null> {
  const failures: string[] = [];
  try {
    await targetSession.release();
  } catch (error: unknown) {
    failures.push(`destination unlock: ${errorDetail(error)}`);
  }
  try {
    await sourceSession.release();
  } catch (error: unknown) {
    failures.push(`source unlock: ${errorDetail(error)}`);
  }
  return failures.length === 0 ? null : failures.join("; ");
}

export async function recoverRepositoryFence(
  store: QuestStore,
  config: StoreConfig,
  repository: string,
): Promise<ReturnType<typeof migrationResultSchema.parse> | null> {
  const trimmedRepository = repository.trim();
  if (trimmedRepository === "") {
    throw migrationError("MIGRATION_REPOSITORY_REQUIRED", "pass a repository name and retry");
  }
  const expected = questDumpSchema.parse(await store.exportAll());
  if (store.recoverMigrationFence !== undefined) {
    const removed = await store.recoverMigrationFence(trimmedRepository);
    return removed ? recoveredMigrationResult(expected, config, trimmedRepository) : null;
  }
  const session = await beginMigrationSession(store, expected, "destination");
  try {
    await session.validate();
    const removed = await session.unfence(trimmedRepository);
    if (removed) {
      await session.commit();
    }
    await session.release();
    if (!removed) {
      return null;
    }
    return recoveredMigrationResult(expected, config, trimmedRepository);
  } catch (error: unknown) {
    try {
      await session.release();
    } catch (cleanupError: unknown) {
      throw migrationError(
        "MIGRATION_UNLOCK_FAILED",
        `fence recovery failed: ${errorDetail(error)}; the migration lock could not be released: ${errorDetail(cleanupError)}`,
      );
    }
    throw error;
  }
}

function recoveredMigrationResult(
  expected: QuestDump,
  config: StoreConfig,
  repository: string,
): ReturnType<typeof migrationResultSchema.parse> {
  const selected = repositoryDump(expected, repository);
  const firstQuest = selected.quests[0];
  const lastQuest = selected.quests.at(-1);
  return migrationResultSchema.parse({
    repository,
    source_backend: config.backend,
    target_backend: config.backend,
    deployment: deploymentFor(config),
    backups: {
      source: "not-created (fence recovery)",
      destination: null,
    },
    counts: countsForRepository(expected, repository),
    spot_checks: {
      first_quest_id: firstQuest?.id ?? null,
      last_quest_id: lastQuest?.id ?? null,
      evidence_hashes: sampledEvidenceHashes(expected, repository),
    },
    recovered: true,
    verified: true,
  });
}

function recoveryError(
  code: string,
  message: string,
  destinationBackup: BackupRunResult,
  rollbackFailure: string,
  routingState: RoutingState = "source",
): Error {
  const recoveryInstruction =
    routingState === "source"
      ? `routing is verified on the source backend; restore the verified destination backup ${destinationBackup.snapshot} before retrying (the restore recovers the verified committed destination fence before replacing data)`
      : routingState === "destination"
        ? "routing is verified on the destination backend; do not restore the destination backup, recover the destination fence before retrying"
        : "routing is not verified on either backend; do not restore the destination backup, keep both backends fenced, verify the active route, and recover only the fence belonging to that route before retrying";
  return migrationError(
    code,
    `${message}; cleanup failed: ${rollbackFailure}; ${recoveryInstruction}`,
  );
}

function requireVerifiedBackup(
  verification: Awaited<ReturnType<BackupOperations["verify"]>>,
  role: "source" | "destination",
): void {
  if (verification.verified !== true || verification.full !== true) {
    throw migrationError(
      "MIGRATION_BACKUP_UNVERIFIED",
      `the ${role} backup did not pass full verification; do not replay data until the backup verifies successfully`,
    );
  }
}

async function copyEvidence(
  source: RepositoryMigrationBackend,
  target: RepositoryMigrationBackend,
  repository: string,
  sourceRepository: QuestDump,
): Promise<void> {
  const evidenceHashes = [...new Set(sourceRepository.evidence.map(({ sha256 }) => sha256))].sort();
  for (const hash of evidenceHashes) {
    const bytes = await source.blobStore.get(hash, repository);
    if (bytes === null) {
      throw migrationError(
        "MIGRATION_EVIDENCE_MISSING",
        `source evidence ${hash} is referenced by ${repository} but its bytes are unavailable; restore the blob and retry`,
      );
    }
    const published = await target.blobStore.put(bytes);
    if (published !== hash) {
      throw migrationError(
        "MIGRATION_EVIDENCE_HASH_MISMATCH",
        `destination returned ${published} for source evidence ${hash}; no metadata was changed, retry after checking the backend`,
      );
    }
  }
}

async function prepareMigration(
  options: RepositoryMigrationOptions,
  repository: string,
): Promise<RepositoryMigrationPlan> {
  const sourceDump = questDumpSchema.parse(await options.source.questStore.exportAll());
  const sourceRepository = selectRepositoryDump(sourceDump, repository);
  const destinationDump = questDumpSchema.parse(await options.target.questStore.exportAll());
  requireRepositoryLocalChains(destinationDump, repository);
  requireRepositoryLocalEventReferences(destinationDump, repository);
  const replacement = mergeRepositoryDump(destinationDump, sourceRepository, repository);
  let sourceSession: StoreMigrationSession | undefined;
  let targetSession: StoreMigrationSession | undefined;
  let sourceBackup: BackupRunResult | undefined;
  let destinationBackup: BackupRunResult | undefined;
  try {
    sourceBackup = await options.source.backup.run();
    destinationBackup = await options.target.backup.run();
    const sourceVerification = await options.source.backup.verify(sourceBackup.snapshot, {
      full: true,
    });
    const destinationVerification = await options.target.backup.verify(destinationBackup.snapshot, {
      full: true,
    });
    requireVerifiedBackup(sourceVerification, "source");
    requireVerifiedBackup(destinationVerification, "destination");
    await recoverDestinationFenceBeforeLock(options, repository);
    sourceSession = await beginMigrationSession(options.source.questStore, sourceDump, "source");
    targetSession = await beginMigrationSession(
      options.target.questStore,
      destinationDump,
      "destination",
    );
    await sourceSession.validate();
    await targetSession.validate();
    await sourceSession.validate();
    await targetSession.validate();
    await copyEvidence(options.source, options.target, repository, sourceRepository);
    await sourceSession.validate();
    await targetSession.validate();
    return {
      destinationBackup,
      destinationDump,
      replacement,
      sourceBackup,
      sourceSession,
      targetSession,
    };
  } catch (error: unknown) {
    const rollbackFailure = await rollbackSessions(targetSession, sourceSession);
    if (rollbackFailure !== null && destinationBackup !== undefined) {
      throw recoveryError(
        "MIGRATION_PREPARE_FAILED",
        `migration preparation failed: ${errorDetail(error)}`,
        destinationBackup,
        rollbackFailure,
      );
    }
    throw error;
  }
}

async function verifyReplacement(plan: RepositoryMigrationPlan): Promise<void> {
  try {
    await plan.targetSession.replace(plan.replacement);
    const actual = await plan.targetSession.snapshot();
    requireMatchingDump(plan.replacement, actual);
    await plan.targetSession.validate();
  } catch (error: unknown) {
    const rollbackFailure = await rollbackSessions(plan.targetSession, plan.sourceSession);
    if (rollbackFailure !== null) {
      throw recoveryError(
        "MIGRATION_VERIFY_ROLLBACK_FAILED",
        `migration verification failed: ${errorDetail(error)}`,
        plan.destinationBackup,
        rollbackFailure,
      );
    }
    throw error;
  }
}

async function commitTargetBeforeRouting(
  options: RepositoryMigrationOptions,
  plan: RepositoryMigrationPlan,
  repository: string,
): Promise<void> {
  let sourceFenceAttempted = false;
  try {
    sourceFenceAttempted = true;
    await plan.sourceSession.fence(repository);
    await plan.targetSession.fence(repository);
    await plan.sourceSession.validate();
    await plan.targetSession.validate();
    await plan.targetSession.commit();
    await plan.targetSession.validate();
    await plan.sourceSession.commit();
    await plan.sourceSession.validate();
  } catch (error: unknown) {
    const failures = await cleanupCommitFailure(options, plan, repository, sourceFenceAttempted);
    const rollbackFailure = await rollbackSessions(plan.targetSession, plan.sourceSession);
    if (rollbackFailure !== null) {
      failures.push(rollbackFailure);
    }
    if (failures.length > 0) {
      throw recoveryError(
        "MIGRATION_COMMIT_FAILED",
        `destination commit failed before routing was written: ${errorDetail(error)}`,
        plan.destinationBackup,
        failures.join("; "),
      );
    }
    throw migrationError(
      "MIGRATION_COMMIT_FAILED",
      `destination commit failed before routing was written: ${errorDetail(error)}; routing remains on the source backend`,
    );
  }
}

async function cleanupCommitFailure(
  options: RepositoryMigrationOptions,
  plan: RepositoryMigrationPlan,
  repository: string,
  sourceFenceAttempted: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  try {
    await plan.targetSession.fence(repository);
  } catch (error: unknown) {
    failures.push(`destination fence: ${errorDetail(error)}`);
  }
  if (sourceFenceAttempted) {
    let sourceRoutingVerified = false;
    try {
      sourceRoutingVerified = await options.verifyRouting();
    } catch (error: unknown) {
      failures.push(`source routing verification: ${errorDetail(error)}`);
    }
    if (!sourceRoutingVerified) {
      failures.push("source routing could not be verified; source and destination remain fenced");
    } else {
      try {
        await plan.sourceSession.unfence(repository);
      } catch (error: unknown) {
        failures.push(`source fence removal: ${errorDetail(error)}`);
      }
    }
  }
  return failures;
}

async function writeRoutingAfterCommit(
  options: RepositoryMigrationOptions,
  plan: RepositoryMigrationPlan,
  repository: string,
): Promise<void> {
  try {
    await options.writeRouting();
    await requireDestinationRouting(options);
  } catch (error: unknown) {
    const cleanup = await cleanupRoutingFailure(options, plan, repository);
    const failures = [...cleanup.failures];
    const releaseFailure = await releaseSessions(plan.targetSession, plan.sourceSession);
    if (releaseFailure !== null) {
      failures.push(releaseFailure);
    }
    if (failures.length > 0) {
      throw recoveryError(
        "MIGRATION_CONFIG_WRITE_FAILED",
        `destination committed but routing could not be written: ${errorDetail(error)}`,
        plan.destinationBackup,
        failures.join("; "),
        cleanup.state,
      );
    }
    if (cleanup.state === "destination") {
      throw migrationError(
        "MIGRATION_CONFIG_WRITE_FAILED",
        `destination committed and routing is verified on the destination backend, but the routing write reported an error: ${errorDetail(error)}; the destination fence was recovered and the source remains fenced, inspect routing before retrying`,
      );
    }
    if (cleanup.state === "unknown") {
      throw migrationError(
        "MIGRATION_CONFIG_WRITE_FAILED",
        `destination committed but the routing write reported an error and the active backend could not be verified: ${errorDetail(error)}; do not restore the destination backup, keep both backends fenced, verify routing, and recover only the fence belonging to the active route before retrying`,
      );
    }
    throw migrationError(
      "MIGRATION_CONFIG_WRITE_FAILED",
      `destination committed but routing could not be written: ${errorDetail(error)}; routing remains on the source backend and the destination backup is verified for recovery`,
    );
  }
}

async function cleanupRoutingFailure(
  options: RepositoryMigrationOptions,
  plan: RepositoryMigrationPlan,
  repository: string,
): Promise<RoutingCleanupResult> {
  const failures: string[] = [];
  const destinationFenceFailure = await fenceDestinationAfterRoutingFailure(plan, repository);
  if (destinationFenceFailure !== null) {
    failures.push(destinationFenceFailure);
  }
  const routing = await determineRoutingState(options);
  failures.push(...routing.failures);
  const fenceRemovalFailure = await unfenceAfterRoutingFailure(plan, repository, routing.state);
  if (fenceRemovalFailure !== null) {
    failures.push(fenceRemovalFailure);
  }
  if (routing.state === "unknown") {
    failures.push("routing state could not be verified; source and destination remain fenced");
  }
  return { failures, state: routing.state };
}

async function fenceDestinationAfterRoutingFailure(
  plan: RepositoryMigrationPlan,
  repository: string,
): Promise<string | null> {
  try {
    await plan.targetSession.fence(repository);
    return null;
  } catch (error: unknown) {
    return `destination fence: ${errorDetail(error)}`;
  }
}

async function determineRoutingState(
  options: RepositoryMigrationOptions,
): Promise<RoutingStateResult> {
  let rollbackFailure: string | null = null;
  try {
    if (await options.rollbackRouting()) {
      return { failures: [], state: "source" };
    }
    rollbackFailure = "routing rollback did not verify the source backend";
  } catch (error: unknown) {
    rollbackFailure = `routing rollback: ${errorDetail(error)}`;
  }
  try {
    if (await options.verifyDestinationRouting()) {
      return { failures: [], state: "destination" };
    }
  } catch (error: unknown) {
    return {
      failures: [
        ...(rollbackFailure === null ? [] : [rollbackFailure]),
        `destination routing verification: ${errorDetail(error)}`,
      ],
      state: "unknown",
    };
  }
  return {
    failures: rollbackFailure === null ? [] : [rollbackFailure],
    state: "unknown",
  };
}

async function requireDestinationRouting(options: RepositoryMigrationOptions): Promise<void> {
  try {
    if (await options.verifyDestinationRouting()) {
      return;
    }
  } catch (error: unknown) {
    throw migrationError(
      "MIGRATION_ROUTE_NOT_EFFECTIVE",
      `destination routing could not be verified: ${errorDetail(error)}; keep both backends fenced and inspect the active route before retrying`,
    );
  }
  throw migrationError(
    "MIGRATION_ROUTE_NOT_EFFECTIVE",
    "routing was written but the active route is not verified on the destination backend; keep both backends fenced and inspect the active route before retrying",
  );
}

async function unfenceAfterRoutingFailure(
  plan: RepositoryMigrationPlan,
  repository: string,
  routingState: RoutingState,
): Promise<string | null> {
  if (routingState === "unknown") {
    return null;
  }
  const session = routingState === "source" ? plan.sourceSession : plan.targetSession;
  const backend = routingState === "source" ? "source" : "destination";
  try {
    await session.unfence(repository);
    return null;
  } catch (error: unknown) {
    return `${backend} fence removal: ${errorDetail(error)}`;
  }
}

async function releaseAfterRouting(
  options: RepositoryMigrationOptions,
  plan: RepositoryMigrationPlan,
  repository: string,
): Promise<void> {
  const failures: string[] = [];
  try {
    await plan.sourceSession.release();
  } catch (error: unknown) {
    failures.push(`source unlock: ${errorDetail(error)}`);
  }
  if (failures.length === 0) {
    try {
      await requireDestinationRouting(options);
      await plan.targetSession.unfence(repository);
    } catch (error: unknown) {
      failures.push(
        errorDetail(error).startsWith("[MIGRATION_ROUTE_NOT_EFFECTIVE]")
          ? `destination routing verification: ${errorDetail(error)}`
          : `destination fence removal: ${errorDetail(error)}`,
      );
    }
  }
  try {
    await plan.targetSession.release();
  } catch (error: unknown) {
    failures.push(`destination unlock: ${errorDetail(error)}`);
  }
  if (failures.length > 0) {
    throw migrationError(
      "MIGRATION_UNLOCK_FAILED",
      `migration cleanup could not safely release ${repository}: ${failures.join("; ")}; keep both backends fenced until destination routing and fence recovery are verified, then retry`,
    );
  }
}

export async function migrateRepository(
  options: RepositoryMigrationOptions,
): Promise<ReturnType<typeof migrationResultSchema.parse>> {
  const repository = options.repository.trim();
  if (repository === "") {
    throw migrationError("MIGRATION_REPOSITORY_REQUIRED", "pass a repository name and retry");
  }
  if (options.source.questStore === options.target.questStore) {
    throw migrationError(
      "MIGRATION_ALREADY_ON_TARGET",
      `repository ${repository} already resolves to the target backend; change the routing first only if you intend to move it elsewhere`,
    );
  }
  requireMigrationCapability(options.source.questStore, "source");
  requireMigrationCapability(options.target.questStore, "destination");

  const plan = await prepareMigration(options, repository);
  await verifyReplacement(plan);
  await commitTargetBeforeRouting(options, plan, repository);
  await writeRoutingAfterCommit(options, plan, repository);
  await releaseAfterRouting(options, plan, repository);

  const selectedReplacement = selectRepositoryDump(plan.replacement, repository);
  const firstQuest = selectedReplacement.quests[0];
  const lastQuest = selectedReplacement.quests.at(-1);
  return migrationResultSchema.parse({
    repository,
    source_backend: options.source.config.backend,
    target_backend: options.target.config.backend,
    deployment: deploymentFor(options.target.config),
    backups: {
      source: plan.sourceBackup.snapshot,
      destination: plan.destinationBackup.snapshot,
    },
    counts: countsForRepository(plan.replacement, repository),
    spot_checks: {
      first_quest_id: firstQuest?.id ?? null,
      last_quest_id: lastQuest?.id ?? null,
      evidence_hashes: sampledEvidenceHashes(plan.replacement, repository),
    },
    verified: true,
  });
}
