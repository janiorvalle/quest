import type {
  AcceptQuestInput,
  AcceptResult,
  ChainMutation,
  ChainRemovalResult,
  ChainResult,
  Event,
  EventFilter,
  Evidence,
  NewEvidence,
  NewQuest,
  Quest,
  QuestDump,
  QuestFilter,
  QuestScope,
  QuestStats,
  QuestTransition,
  Sha256,
  StoreCompatibilityResult,
  TouchQuestInput,
} from "../schema";

export interface BackupDatabaseInspection {
  readonly dump: QuestDump;
  readonly integrity_check: readonly string[];
  readonly schema_version: number;
}

export interface BackupDatabaseRestoreSession {
  readonly pre_restore_database: string | null;
  activate(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface BackupDatabase {
  /** Whether repository-scoped restores preserve unrelated repositories in this backend. */
  readonly restoreScope: "full" | "repository";

  /** Creates and inspects one physical snapshot at a single backend consistency point. */
  createSnapshot(destination: string): Promise<BackupDatabaseInspection>;

  /** Reads and integrity-checks a physical snapshot without mutating it. */
  inspect(databasePath: string): Promise<BackupDatabaseInspection>;

  /** Replaces the live database while retaining the previous file as a pre-restore copy. */
  restoreSnapshot(
    source: string,
    preRestoreLabel: string,
    repository?: string,
  ): Promise<BackupDatabaseRestoreSession>;

  /** Reads and integrity-checks the live database after a restore. */
  inspectCurrent(): Promise<BackupDatabaseInspection>;
}

export interface WatchSubscription {
  /** Idempotently stops future emissions and waits for in-flight callbacks to settle. */
  unsubscribe(): Promise<void>;
}

export type QuestWatchListener = (quests: readonly Quest[], error?: Error) => void;

export interface FederatedReadSnapshot {
  readonly dump: QuestDump;
  readonly fencedRepositories: readonly string[];
}

export interface AcceptQuestAndExportResult {
  readonly acceptance: AcceptResult;
  readonly snapshot: QuestDump;
}

export interface QuestStore {
  /**
   * Atomically validates the initial/backfilled state, allocates a never-reused display ID,
   * inserts the quest, and appends its add event with the explicit backfill marker. Failure
   * commits none of those effects.
   */
  addQuest(input: NewQuest): Promise<Quest>;

  /**
   * Atomically claims an unassigned dispatchable quest (an open bug or ready work) and appends
   * its accept event. Concurrent callers observe exactly one accepted result; every loser
   * receives the current quest as a conflict.
   */
  acceptQuest(input: AcceptQuestInput): Promise<AcceptResult>;

  /** Atomically accepts a quest and returns the same backend snapshot for the briefing package. */
  acceptQuestAndExport(input: AcceptQuestInput): Promise<AcceptQuestAndExportResult>;

  /** Atomically renews the owning quest lease and appends a touch event. */
  touchQuest(input: TouchQuestInput): Promise<Quest>;

  /**
   * Atomically validates and applies one typed domain transition and appends its matching event.
   * Duplicate verdict links are part of the same mutation. Invalid input changes no state.
   */
  transition(id: number, transition: QuestTransition): Promise<Quest>;

  /**
   * Atomically checks referential integrity, uniqueness, and requires-cycle safety inside the
   * write boundary, then inserts the link and its event. Replays return exists without a new event.
   */
  addChainLink(input: ChainMutation): Promise<ChainResult>;

  /**
   * Atomically checks referential integrity, removes one exact link, and appends its event.
   * Replays return missing without a new event.
   */
  removeChainLink(input: ChainMutation): Promise<ChainRemovalResult>;

  /**
   * Atomically validates the owning quest, inserts evidence metadata, and appends its update event.
   * Blob publication occurs through BlobStore before this method and is content-addressed.
   */
  addEvidence(input: NewEvidence): Promise<Evidence>;

  /** Reads all matching quests from one backend-consistent query snapshot. */
  listQuests(filter: QuestFilter): Promise<Quest[]>;

  /** Reads repositories fenced on this backend so federated reads can exclude stale copies. */
  listFencedRepositories?(): Promise<readonly string[]>;

  /** Reads the logical dump and migration fences from one backend-consistent snapshot. */
  readFederatedSnapshot?(): Promise<FederatedReadSnapshot>;

  /** Narrows read operations to one repository when the backend supports federated routing. */
  forRepository?(repository: string): QuestStore;

  /** Reads one quest from one backend-consistent query snapshot, returning null when absent. */
  getQuest(id: number): Promise<Quest | null>;

  /** Computes every requested aggregate from one backend-consistent query snapshot. */
  stats(scope: QuestScope): Promise<QuestStats>;

  /** Reads one quest's append-only events in stable ID order from one query snapshot. */
  events(questId: number): Promise<Event[]>;

  /** Reads append-only events across the selected quests using one query snapshot; filters may use an ID cursor. */
  queryEvents(filter: EventFilter): Promise<Event[]>;

  /** Exports entities, links, evidence, and events from one mutually consistent read snapshot. */
  exportAll(): Promise<QuestDump>;

  /** Replaces one backend with a schema-validated logical dump inside its write boundary. */
  replaceAll?(dump: QuestDump): Promise<void>;

  /**
   * Opens a compare-and-hold migration session. The session blocks concurrent writes until it
   * commits or releases, so a routing cutover cannot strand a newer source snapshot.
   */
  beginMigration?(expected: QuestDump): Promise<StoreMigrationSession>;

  /**
   * Removes a stale migration fence after an operator has verified that routing already points
   * at this store. Backends with lease-owned fences can use this without recreating the expired
   * migration session.
   */
  recoverMigrationFence?(repository: string): Promise<boolean>;

  /**
   * Atomically registers one logical query subscription. Every emission is a complete,
   * backend-consistent snapshot; registration returns an idempotent async unsubscriber.
   */
  watch(filter: QuestFilter, listener: QuestWatchListener): Promise<WatchSubscription>;
}

export interface StoreMigrationSession {
  replace(dump: QuestDump): Promise<void>;
  snapshot(): Promise<QuestDump>;
  validate(): Promise<void>;
  fence(repository: string): Promise<void>;
  unfence(repository: string): Promise<boolean>;
  commit(): Promise<void>;
  release(): Promise<void>;
  rollback(): Promise<void>;
}

export interface BlobStore {
  /**
   * Atomically publishes bytes under their SHA-256 address and returns that lowercase hash.
   * Repeating identical bytes is idempotent; failures leave no partially readable blob.
   */
  put(bytes: Uint8Array): Promise<Sha256>;

  /** Repairs or publishes one content-addressed blob during backup restore. */
  restore?(
    sha256: Sha256,
    bytes: Uint8Array,
  ): Promise<{ readonly copied: boolean; readonly quarantined: string | null }>;

  /** Reads the complete blob at one point in time, returning null when the hash is absent. */
  get(sha256: Sha256, repository?: string): Promise<Uint8Array | null>;

  /** Checks existence at one point in time and never observes a partially published blob. */
  has(sha256: Sha256, repository?: string): Promise<boolean>;
}

export interface Clock {
  /** Returns one backend-authoritative instant; each call is independent and has no side effects. */
  now(): Promise<string>;
}

/**
 * Infrastructure startup probe kept separate from QuestStore because schema compatibility is
 * about opening a backend, not a quest-domain operation.
 */
export interface StoreCompatibilityProbe {
  /** Gives callers an actionable remedy when the backend is older than this binary. */
  readonly olderStoreRemedy?: string | undefined;
  check(): Promise<StoreCompatibilityResult>;
  migrate?(): Promise<void>;
}
