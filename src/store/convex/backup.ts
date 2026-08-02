import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { findChainCyclePath } from "../../domain";
import { type Event, type QuestDump, questDumpSchema } from "../../schema";
import type {
  BackupDatabase,
  BackupDatabaseInspection,
  BackupDatabaseRestoreSession,
} from "../port";
import type { ConvexStore } from "./adapter";

type ConvexRestoreStore = Pick<
  ConvexStore,
  | "activateRestore"
  | "beginRestore"
  | "commitRestore"
  | "exportAll"
  | "exportAllWithCutoff"
  | "recoverMigrationFenceForRestore"
  | "releaseRestore"
  | "renewRestore"
  | "restoreStatus"
  | "rollbackRestore"
>;

async function releaseCommittedLease(store: ConvexRestoreStore, token: string): Promise<void> {
  let releaseError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await store.releaseRestore(token);
      return;
    } catch (error: unknown) {
      releaseError ??= error;
      try {
        if ((await store.restoreStatus(token)).status === "missing") {
          return;
        }
      } catch {
        // Preserve the release error: the caller still owns a retryable session.
      }
    }
  }
  const detail = releaseError instanceof Error ? releaseError.message : String(releaseError);
  throw new Error(
    `[BACKUP_RESTORE_CLEANUP_FAILED] the committed Convex restore lease could not be released: ${detail}; retry the restore cleanup before starting another backup or migration`,
    { cause: releaseError },
  );
}

async function writeAvailablePreRestore(
  databasePath: string,
  label: string,
  dump: QuestDump,
): Promise<string> {
  const safeLabel = label.replaceAll(/[^0-9A-Za-z._-]/gu, "_") || "restore";
  const base = `${databasePath}.${safeLabel}`;
  let candidate = `${base}.pre-restore`;
  let sequence = 2;
  while (true) {
    try {
      await writeFile(candidate, serializeDump(dump), { mode: 0o600, flag: "wx" });
      return candidate;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      candidate = `${base}.${sequence}.pre-restore`;
      sequence += 1;
    }
  }
}

function serializeDump(dump: QuestDump): string {
  return `${JSON.stringify(questDumpSchema.parse(dump), null, 2)}\n`;
}

function repositoryQuestIds(dump: QuestDump, repository: string): Set<number> {
  return new Set(dump.quests.filter((quest) => quest.repo === repository).map((quest) => quest.id));
}

function chainKey(chain: QuestDump["chains"][number]): string {
  return `${chain.quest_id}:${chain.target_id}:${chain.type}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventReferenceIds(event: Event): {
  readonly questIds: readonly number[];
  readonly evidenceIds: readonly number[];
} {
  if (!isRecord(event.detail)) {
    return { evidenceIds: [], questIds: [] };
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
  return { evidenceIds, questIds };
}

function requireValidRetainedEventReferences(
  events: readonly Event[],
  questIds: ReadonlySet<number>,
  evidenceIds: ReadonlySet<number>,
  repository: string,
): void {
  for (const event of events) {
    const references = eventReferenceIds(event);
    const missingQuestId = references.questIds.find((id) => !questIds.has(id));
    if (missingQuestId !== undefined) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_CONFLICT] event ${event.id} references quest ID ${missingQuestId} missing after restoring ${repository}; restore the complete backup after verifying the destination state`,
      );
    }
    const missingEvidenceId = references.evidenceIds.find((id) => !evidenceIds.has(id));
    if (missingEvidenceId !== undefined) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_CONFLICT] event ${event.id} references evidence ID ${missingEvidenceId} missing after restoring ${repository}; restore the complete backup after verifying the destination state`,
      );
    }
  }
}

function requireAcyclicChains(
  chains: readonly QuestDump["chains"][number][],
  repository: string,
): void {
  const accepted: QuestDump["chains"][number][] = [];
  for (const chain of chains) {
    const cycle = findChainCyclePath(accepted, chain);
    if (cycle !== undefined) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_CONFLICT] restoring ${repository} would create a requires cycle (${cycle.join(" -> ")}); remove the conflicting link or restore the complete backup after verifying the destination state`,
      );
    }
    accepted.push(chain);
  }
}

function repositoryReplacementChains(
  replacement: QuestDump,
  repositoryQuestIds: ReadonlySet<number>,
  mergedQuestIds: ReadonlySet<number>,
  repository: string,
): QuestDump["chains"] {
  const chains = replacement.chains.filter(
    (chain) => repositoryQuestIds.has(chain.quest_id) || repositoryQuestIds.has(chain.target_id),
  );
  for (const chain of chains) {
    if (mergedQuestIds.has(chain.quest_id) && mergedQuestIds.has(chain.target_id)) {
      continue;
    }
    const missingQuestId = mergedQuestIds.has(chain.quest_id) ? chain.target_id : chain.quest_id;
    throw new Error(
      `[BACKUP_REPOSITORY_RESTORE_CONFLICT] snapshot ${repository} contains a chain to missing quest ID ${missingQuestId}; restore the complete backup after verifying the destination state`,
    );
  }
  return chains;
}

function mergeRepositoryRestore(
  current: QuestDump,
  replacement: QuestDump,
  repository: string,
): QuestDump {
  const currentRepositoryIds = repositoryQuestIds(current, repository);
  const replacementRepositoryIds = repositoryQuestIds(replacement, repository);
  for (const quest of current.quests) {
    if (!currentRepositoryIds.has(quest.id) && replacementRepositoryIds.has(quest.id)) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_CONFLICT] snapshot ${repository} reuses quest ID ${quest.id} from another destination repository; restore the complete backup after verifying the destination state`,
      );
    }
  }
  const currentQuests = current.quests.filter((quest) => !currentRepositoryIds.has(quest.id));
  const replacementQuests = replacement.quests.filter((quest) => quest.repo === repository);
  const replacementQuestIds = new Set(replacementQuests.map((quest) => quest.id));
  const mergedQuestIds = new Set([...currentQuests, ...replacementQuests].map((quest) => quest.id));
  const currentEvidence = current.evidence.filter(
    (item) => !currentRepositoryIds.has(item.quest_id),
  );
  const replacementEvidence = replacement.evidence.filter((item) =>
    replacementRepositoryIds.has(item.quest_id),
  );
  const currentEvidenceIds = new Set(currentEvidence.map((item) => item.id));
  for (const item of replacementEvidence) {
    if (currentEvidenceIds.has(item.id)) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_CONFLICT] snapshot ${repository} reuses evidence ID ${item.id} from another destination repository; restore the complete backup after verifying the destination state`,
      );
    }
  }
  // A link is observable from both endpoint quests, so a scoped restore replaces
  // every link touching the repository with the snapshot's version.
  const currentChains = current.chains.filter(
    (chain) =>
      !currentRepositoryIds.has(chain.quest_id) && !currentRepositoryIds.has(chain.target_id),
  );
  const currentEvents = current.events.filter((event) => !currentRepositoryIds.has(event.quest_id));
  const replacementEvents = replacement.events.filter((event) =>
    replacementRepositoryIds.has(event.quest_id),
  );
  const currentEventIds = new Set(currentEvents.map((event) => event.id));
  for (const event of replacementEvents) {
    if (currentEventIds.has(event.id)) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_CONFLICT] snapshot ${repository} reuses event ID ${event.id} from another destination repository; restore the complete backup after verifying the destination state`,
      );
    }
  }
  requireValidRetainedEventReferences(
    [...currentEvents, ...replacementEvents],
    mergedQuestIds,
    new Set([...currentEvidence, ...replacementEvidence].map((item) => item.id)),
    repository,
  );
  const replacementChains = repositoryReplacementChains(
    replacement,
    replacementQuestIds,
    mergedQuestIds,
    repository,
  );
  const chains = new Map(
    [...currentChains, ...replacementChains].map((chain) => [chainKey(chain), chain]),
  );
  requireAcyclicChains([...chains.values()], repository);
  return questDumpSchema.parse({
    schema_version: current.schema_version,
    quests: [...currentQuests, ...replacementQuests],
    evidence: [...currentEvidence, ...replacementEvidence],
    chains: [...chains.values()],
    events: [...currentEvents, ...replacementEvents],
  });
}

async function readDump(path: string): Promise<QuestDump> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read Convex backup ${path}: ${detail}`);
  }
  return questDumpSchema.parse(parsed);
}

export class ConvexBackupDatabase implements BackupDatabase {
  readonly restoreScope = "repository";
  readonly #store: ConvexRestoreStore;
  readonly #databasePath: string;
  #activeReplacement: QuestDump | undefined;

  constructor(databasePath: string, store: ConvexRestoreStore) {
    if (!isAbsolute(databasePath)) {
      throw new Error(`Convex backup path must be absolute: ${databasePath}`);
    }
    this.#databasePath = databasePath;
    this.#store = store;
  }

  async createSnapshot(destination: string): Promise<BackupDatabaseInspection> {
    this.#requireAbsolute(destination, "snapshot path");
    const dump = await this.#store.exportAll();
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, serializeDump(dump), { mode: 0o600 });
    return this.#inspection(dump);
  }

  async inspect(databasePath: string): Promise<BackupDatabaseInspection> {
    this.#requireAbsolute(databasePath, "snapshot path");
    return this.#inspection(await readDump(databasePath));
  }

  async inspectCurrent(): Promise<BackupDatabaseInspection> {
    return this.#inspection(this.#activeReplacement ?? (await this.#store.exportAll()));
  }

  async restoreSnapshot(
    source: string,
    preRestoreLabel: string,
    repository?: string,
  ): Promise<BackupDatabaseRestoreSession> {
    this.#requireAbsolute(source, "snapshot path");
    const replacement = await readDump(source);
    const previousSnapshot = await this.#store.exportAllWithCutoff();
    const previous = previousSnapshot.dump;
    const trimmedRepository = repository?.trim();
    const restoreReplacement =
      trimmedRepository === undefined || trimmedRepository === ""
        ? replacement
        : mergeRepositoryRestore(previous, replacement, trimmedRepository);
    const restoreKind =
      trimmedRepository === undefined || trimmedRepository === "" ? "full-backup" : "migration";
    await mkdir(dirname(this.#databasePath), { recursive: true, mode: 0o700 });
    const preRestorePath = await writeAvailablePreRestore(
      this.#databasePath,
      preRestoreLabel,
      previous,
    );
    let token: string | undefined;
    try {
      token = await this.#store.beginRestore(previous, previousSnapshot.lease_cutoff, restoreKind);
      if (trimmedRepository !== undefined && trimmedRepository !== "") {
        await this.#store.recoverMigrationFenceForRestore(token, trimmedRepository);
      }
    } catch (error: unknown) {
      if (token !== undefined) {
        await this.#store.releaseRestore(token).catch(() => undefined);
      }
      await rm(preRestorePath, { force: true });
      throw error;
    }
    if (token === undefined) {
      await rm(preRestorePath, { force: true });
      throw new Error("Convex restore did not return a restore token; retry the restore");
    }
    const heartbeat = setInterval(() => {
      void this.#store.renewRestore(token).catch(() => undefined);
    }, 60_000);
    const stopHeartbeat = (): void => clearInterval(heartbeat);

    let active = true;
    let activationAttempted = false;
    let activated = false;
    let committed = false;
    const activate = async (): Promise<void> => {
      if (!active || activated) {
        return;
      }
      activationAttempted = true;
      this.#activeReplacement = await this.#store.activateRestore(token, restoreReplacement);
      activated = true;
    };
    const releaseCommittedRestore = async (): Promise<void> => {
      try {
        await releaseCommittedLease(this.#store, token);
      } catch (error: unknown) {
        stopHeartbeat();
        throw error;
      }
      active = false;
      this.#activeReplacement = undefined;
      stopHeartbeat();
    };
    const commitRestoreWithRetry = async (): Promise<void> => {
      let firstError: unknown;
      try {
        await this.#store.commitRestore(token);
      } catch (error: unknown) {
        firstError = error;
        try {
          await this.#store.commitRestore(token);
        } catch {
          let status: Awaited<ReturnType<ConvexRestoreStore["restoreStatus"]>>;
          try {
            status = await this.#store.restoreStatus(token);
          } catch {
            throw firstError;
          }
          if (status.status !== "committed") {
            throw firstError;
          }
        }
      }
    };
    const commitLiveRestore = async (): Promise<void> => {
      try {
        await commitRestoreWithRetry();
        committed = true;
      } finally {
        if (!committed) {
          stopHeartbeat();
        }
      }
    };
    return {
      pre_restore_database: preRestorePath,
      activate,
      commit: async () => {
        if (!active) {
          return;
        }
        if (committed) {
          await releaseCommittedRestore();
          return;
        }
        await activate();
        await commitLiveRestore();
        await releaseCommittedRestore();
      },
      rollback: async () => {
        if (!active) {
          return;
        }
        if (committed) {
          await releaseCommittedRestore();
          return;
        }
        try {
          if (activationAttempted) {
            await this.#store.rollbackRestore(token);
          } else {
            await this.#store.releaseRestore(token);
          }
          this.#activeReplacement = undefined;
          active = false;
        } finally {
          stopHeartbeat();
        }
      },
    };
  }

  #inspection(dump: QuestDump): BackupDatabaseInspection {
    return {
      dump,
      integrity_check: ["ok"],
      schema_version: dump.schema_version,
    };
  }

  #requireAbsolute(path: string, name: string): void {
    if (!isAbsolute(path)) {
      throw new Error(`${name} must be absolute: ${path}`);
    }
  }
}
