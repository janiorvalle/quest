import { type Changes, Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  allocateDisplayId,
  canApplyVerdict,
  findChainCyclePath,
  isLeaseExpired,
  isLegalStatusTransition,
  isValidBackfill,
  leaseExpiry,
  materializeExpiredLease,
  statusForRetestVerdict,
  statusForVerdict,
} from "../../domain";
import {
  type AcceptQuestInput,
  type AcceptResult,
  acceptQuestInputSchema,
  type Chain,
  type ChainMutation,
  type ChainRemovalResult,
  type ChainResult,
  chainMutationSchema,
  chainSchema,
  type Event,
  type EventFilter,
  type Evidence,
  eventBaseSchema,
  eventFilterSchema,
  eventSchema,
  evidenceSchema,
  type NewEvidence,
  type NewQuest,
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
  STORE_SCHEMA_VERSION,
  stableSerialize,
  type TouchQuestInput,
  touchQuestInputSchema,
} from "../../schema";
import type {
  AcceptQuestAndExportResult,
  BackupDatabaseInspection,
  QuestStore,
  QuestWatchListener,
  StoreMigrationSession,
  WatchSubscription,
} from "../port";
import {
  SQLITE_MIGRATION_GLOBAL_GUARD,
  SQLITE_SCHEMA_DEFINITIONS,
  SQLITE_SCHEMA_STATEMENTS,
  SQLITE_SCHEMA_VERSION,
  SQLITE_TABLE_NAMES,
  SQLITE_TRIGGER_DEFINITIONS,
} from "./ddl";
import {
  acquireSharedSqliteStoreOwnership,
  type SqliteMigrationLease,
  type SqliteStoreOwnership,
  tryAcquireSqliteMigrationLease,
} from "./ownership";

type QuestRow = Omit<Quest, "predicted_files"> & {
  predicted_files: string;
};

type EventRow = Omit<Event, "detail"> & {
  detail: string;
};

type JournalModeRow = {
  journal_mode: string;
};

type UserVersionRow = {
  user_version: number;
};

type IntegrityRow = {
  integrity_check: string;
};

type TableNameRow = {
  name: string;
};

type SchemaNameRow = TableNameRow & {
  type: string;
};

type SchemaObjectRow = {
  name: string;
  sql: string | null;
  tbl_name: string;
  type: string;
};

type SqliteSequenceHighWater = {
  readonly quests: number;
  readonly evidence: number;
  readonly events: number;
};

function maxEntityId(items: readonly { readonly id: number }[]): number {
  let maximum = 0;
  for (const item of items) {
    maximum = Math.max(maximum, item.id);
  }
  return maximum;
}

type Watcher = {
  filter: QuestFilter;
  listener: QuestWatchListener;
  signature: string;
};

export type SqliteStoreOptions = {
  beforeEventAppend?: () => void;
  now?: () => string;
  watchPollIntervalMs?: number;
};

const selectQuestsSql = `SELECT
  id, repo, area, kind, title, description, opened_by, assignee, status, verdict,
  guild, verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at,
  created_at, updated_at
FROM quests`;

const selectEvidenceSql = `SELECT
  id, quest_id, sha256, filename, kind, stage, added_by, created_at
FROM evidence`;

const selectChainsSql = "SELECT quest_id, target_id, type FROM chains";

const selectEventsSql = "SELECT id, quest_id, at, actor, action, detail FROM events";

const selectEventsWithQuestsSql = `SELECT
  e.id, e.quest_id, e.at, e.actor, e.action, e.detail
FROM events AS e
INNER JOIN quests AS q ON q.id = e.quest_id`;

function eventQuerySql(filter: EventFilter): {
  readonly parameters: SQLQueryBindings[];
  readonly where: string;
} {
  const clauses: string[] = [];
  const parameters: SQLQueryBindings[] = [];
  if (filter.repo !== undefined) {
    clauses.push("q.repo = ?");
    parameters.push(filter.repo);
  }
  if (filter.quest_id !== undefined) {
    clauses.push("e.quest_id = ?");
    parameters.push(filter.quest_id);
  }
  if (filter.after_id !== undefined) {
    clauses.push("e.id > ?");
    parameters.push(filter.after_id);
  }
  if (filter.since !== undefined) {
    clauses.push("julianday(e.at) >= julianday(?)");
    parameters.push(filter.since);
  }
  if (filter.until !== undefined) {
    clauses.push("julianday(e.at) <= julianday(?)");
    parameters.push(filter.until);
  }
  if (filter.actor !== undefined) {
    clauses.push("e.actor = ?");
    parameters.push(filter.actor);
  }
  if (filter.action !== undefined) {
    clauses.push("e.action = ?");
    parameters.push(filter.action);
  }
  if (filter.area !== undefined) {
    clauses.push("q.area = ?");
    parameters.push(filter.area);
  }
  return {
    parameters,
    where: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
  };
}

export function readSqliteQuestDump(database: Database): QuestDump {
  return questDumpSchema.parse({
    schema_version: STORE_SCHEMA_VERSION,
    quests: getRows<QuestRow, []>(database, `${selectQuestsSql} ORDER BY id`).map(decodeQuest),
    evidence: getRows<Evidence, []>(database, `${selectEvidenceSql} ORDER BY id`).map((row) =>
      evidenceSchema.parse(row),
    ),
    chains: getRows<Chain, []>(
      database,
      `${selectChainsSql} ORDER BY quest_id, target_id, type`,
    ).map((row) => chainSchema.parse(row)),
    events: getRows<EventRow, []>(database, `${selectEventsSql} ORDER BY id`).map(decodeEvent),
  });
}

function getRow<Row, Params extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  ...params: Params
): Row | null {
  const statement = database.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize();
  }
}

function getRows<Row, Params extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  ...params: Params
): Row[] {
  const statement = database.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}

function runStatement<Params extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  ...params: Params
): Changes {
  const statement = database.prepare<never, SQLQueryBindings[]>(sql);
  try {
    return statement.run(...params);
  } finally {
    statement.finalize();
  }
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\bIF NOT EXISTS\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function vacuumDatabaseInto(databasePath: string, destination: string): void {
  const database = new Database(databasePath, {
    readwrite: true,
    strict: true,
  });
  try {
    runStatement(database, "PRAGMA busy_timeout = 5000");
    runStatement(database, "VACUUM INTO ?", destination);
  } finally {
    database.close();
  }
}

export class SqliteStore implements QuestStore {
  readonly databasePath: string;

  readonly #database: Database;
  readonly #ownership: SqliteStoreOwnership;
  readonly #beforeEventAppend: (() => void) | undefined;
  readonly #now: () => string;
  readonly #watchPollIntervalMs: number;
  readonly #watchers = new Map<number, Watcher>();
  #nextWatcherId = 1;
  #watchTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  #backupRestoreActive = false;
  #backupRestorePreRestoreDestination: string | null = null;
  #migrationLockActive = false;
  #migrationCommitPending = false;
  #migrationGuardCleared = false;
  #migrationLease: SqliteMigrationLease | undefined;

  constructor(databasePath: string, options: SqliteStoreOptions = {}) {
    if (databasePath === ":memory:" || databasePath.length === 0) {
      throw new Error("SqliteStore requires a file path so WAL mode can be enabled");
    }
    if (
      options.watchPollIntervalMs !== undefined &&
      (!Number.isSafeInteger(options.watchPollIntervalMs) || options.watchPollIntervalMs < 1)
    ) {
      throw new RangeError("watchPollIntervalMs must be a positive integer");
    }

    this.databasePath = databasePath;
    this.#beforeEventAppend = options.beforeEventAppend;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#watchPollIntervalMs = options.watchPollIntervalMs ?? 250;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#ownership = acquireSharedSqliteStoreOwnership(databasePath);

    let database: Database | undefined;
    try {
      database = new Database(databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      this.#database = database;
      this.#configureDatabase();
      this.#recoverStaleMigrationGuard();
    } catch (error: unknown) {
      database?.close();
      this.#ownership.release();
      throw error;
    }
  }

  async addQuest(input: NewQuest): Promise<Quest> {
    const parsed = newQuestSchema.parse(input);
    const quest = this.#writeTransaction(() => {
      this.#requireRepositoryUnfenced(parsed.repo);
      if (!isValidBackfill(parsed)) {
        throw new Error(
          `invalid backfilled state for ${parsed.kind} quest: ${parsed.status}/${String(parsed.verdict)}`,
        );
      }
      const existingIds = getRows<{ id: number }, []>(
        this.#database,
        "SELECT id FROM quests ORDER BY id",
      ).map(({ id }) => id);
      const id = allocateDisplayId(existingIds);
      const timestamp = this.#now();
      const questInput = {
        repo: parsed.repo,
        area: parsed.area,
        kind: parsed.kind,
        title: parsed.title,
        description: parsed.description,
        opened_by: parsed.opened_by,
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
            ? leaseExpiry(timestamp)
            : null),
      };
      const candidate = questSchema.parse({
        ...questInput,
        id,
        created_at: timestamp,
        updated_at: timestamp,
      });
      this.#insertQuest(candidate);
      this.#appendEvent(candidate.id, timestamp, candidate.opened_by, "add", {
        ...questInput,
        backfill: parsed.backfill ?? false,
        session_guild: parsed.session_guild ?? null,
      });
      return this.#requireQuest(candidate.id);
    });
    this.#emitWatchers();
    return quest;
  }

  async acceptQuest(input: AcceptQuestInput): Promise<AcceptResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    const result = this.#writeTransaction(() => {
      const current = this.#requireStoredQuest(parsed.id);
      this.#requireRepositoryUnfenced(current.repo);
      return this.#acceptQuest(parsed);
    });
    if (result.outcome === "accepted") {
      this.#emitWatchers();
    }
    return result;
  }

  async acceptQuestAndExport(input: AcceptQuestInput): Promise<AcceptQuestAndExportResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    const result = this.#writeTransaction(() => {
      const current = this.#requireStoredQuest(parsed.id);
      this.#requireRepositoryUnfenced(current.repo);
      return {
        acceptance: this.#acceptQuest(parsed),
        snapshot: this.#readQuestDump(),
      };
    });
    if (result.acceptance.outcome === "accepted") {
      this.#emitWatchers();
    }
    return result;
  }

  #acceptQuest(parsed: AcceptQuestInput): AcceptResult {
    const stored = this.#requireStoredQuest(parsed.id);
    const current = materializeExpiredLease(stored, this.#now());
    if (this.#hasGuildMismatch(current, parsed.session_guild, parsed.force)) {
      return {
        outcome: "guild-mismatch",
        lease_expires_at: current.lease_expires_at,
        quest: current,
      } satisfies AcceptResult;
    }
    const timestamp = this.#now();
    const expired = isLeaseExpired(stored.lease_expires_at, timestamp);
    if (!this.#canAccept(stored, current, expired)) {
      return {
        outcome: "conflict",
        lease_expires_at: current.lease_expires_at,
        quest: current,
      } satisfies AcceptResult;
    }

    const nextLeaseExpiresAt = leaseExpiry(timestamp);
    const changed = runStatement(
      this.#database,
      `UPDATE quests
        SET assignee = ?, status = 'accepted', lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND (
          (assignee IS NULL AND status = 'ready') OR
          (status = 'accepted' AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at) <= julianday(?))
        )`,
      parsed.owner,
      nextLeaseExpiresAt,
      timestamp,
      parsed.id,
      timestamp,
    );
    if (changed.changes === 0) {
      return {
        outcome: "conflict",
        lease_expires_at: this.#publicQuest(this.#requireStoredQuest(parsed.id)).lease_expires_at,
        quest: this.#publicQuest(this.#requireStoredQuest(parsed.id)),
      } satisfies AcceptResult;
    }

    this.#appendEvent(parsed.id, timestamp, parsed.owner, "accept", {
      assignee: parsed.owner,
      lease_expires_at: nextLeaseExpiresAt,
      ...(expired && stored.assignee !== null ? { reclaimed_from: stored.assignee } : {}),
      status: "accepted",
      ...(parsed.session_effort === undefined ? {} : { session_effort: parsed.session_effort }),
      session_guild: parsed.session_guild ?? null,
      ...(parsed.session_model === undefined ? {} : { session_model: parsed.session_model }),
    });
    return {
      outcome: "accepted",
      lease_expires_at: nextLeaseExpiresAt,
      quest: this.#publicQuest(this.#requireStoredQuest(parsed.id)),
    } satisfies AcceptResult;
  }

  async touchQuest(input: TouchQuestInput): Promise<Quest> {
    const parsed = touchQuestInputSchema.parse(input);
    const quest = this.#writeTransaction(() => {
      const current = this.#requireStoredQuest(parsed.id);
      this.#requireRepositoryUnfenced(current.repo);
      const timestamp = this.#now();
      this.#requireActiveLeaseOwner(current, parsed.owner, timestamp);
      const updated = questSchema.parse({
        ...current,
        lease_expires_at: leaseExpiry(timestamp),
        updated_at: timestamp,
      });
      this.#updateQuest(updated);
      this.#appendEvent(parsed.id, timestamp, parsed.owner, "touch", {
        action: "touch",
        lease_expires_at: updated.lease_expires_at,
        ...(parsed.session_effort === undefined ? {} : { session_effort: parsed.session_effort }),
        session_guild: parsed.session_guild ?? null,
        ...(parsed.session_model === undefined ? {} : { session_model: parsed.session_model }),
      });
      return this.#publicQuest(updated);
    });
    this.#emitWatchers();
    return quest;
  }

  async transition(id: number, transition: QuestTransition): Promise<Quest> {
    const parsedId = questSchema.shape.id.parse(id);
    const parsedTransition = questTransitionSchema.parse(transition);
    const quest = this.#writeTransaction(() => {
      const current = this.#requireStoredQuest(parsedId);
      this.#requireRepositoryUnfenced(current.repo);
      const timestamp = this.#now();
      this.#requireLeaseOwner(current, parsedTransition.actor, timestamp);
      const updated = this.#applyTransition(current, parsedTransition, timestamp);
      this.#updateQuest(updated);

      if (parsedTransition.action === "verdict" && parsedTransition.duplicate_of !== null) {
        const duplicateLink = chainSchema.parse({
          quest_id: parsedId,
          target_id: parsedTransition.duplicate_of,
          type: "duplicate-of",
        });
        const duplicateTarget = this.#requireStoredQuest(duplicateLink.target_id);
        this.#requireRepositoryUnfenced(duplicateTarget.repo);
        // The frozen domain contract checks cycles only for `requires`; duplicate links are excluded.
        if (this.#getChain(duplicateLink) === null) {
          this.#insertChain(duplicateLink);
        }
      }
      if (parsedTransition.action === "reopen" && current.verdict === "duplicate") {
        this.#removeDuplicateLinksForReopen(parsedId, parsedTransition, timestamp);
      }

      this.#appendEvent(parsedId, timestamp, parsedTransition.actor, parsedTransition.action, {
        ...parsedTransition,
        session_guild: parsedTransition.session_guild ?? null,
      });
      return this.#publicQuest(this.#requireStoredQuest(parsedId));
    });
    this.#emitWatchers();
    return quest;
  }

  #removeDuplicateLinksForReopen(
    questId: number,
    transition: Extract<QuestTransition, { action: "reopen" }>,
    timestamp: string,
  ): void {
    const links = this.#allChains().filter(
      (link) => link.quest_id === questId && link.type === "duplicate-of",
    );
    for (const link of links) {
      const deletion = runStatement(
        this.#database,
        "DELETE FROM chains WHERE quest_id = ? AND target_id = ? AND type = ?",
        link.quest_id,
        link.target_id,
        link.type,
      );
      if (deletion.changes !== 1) {
        throw new Error("duplicate chain invariant violated during reopen");
      }
      this.#appendEvent(questId, timestamp, transition.actor, "chain", {
        operation: "remove",
        link,
        session_guild: transition.session_guild ?? null,
      });
    }
  }

  async addChainLink(input: ChainMutation): Promise<ChainResult> {
    const parsed = chainMutationSchema.parse(input);
    const result = this.#writeTransaction(() => {
      this.#requireQuest(parsed.link.quest_id);
      const sourceQuest = this.#requireStoredQuest(parsed.link.quest_id);
      const targetQuest = this.#requireStoredQuest(parsed.link.target_id);
      this.#requireRepositoryUnfenced(sourceQuest.repo);
      this.#requireRepositoryUnfenced(targetQuest.repo);
      const existing = this.#getChain(parsed.link);
      if (existing !== null) {
        return {
          outcome: "exists",
          link: chainSchema.parse(existing),
        } satisfies ChainResult;
      }

      const links = this.#allChains();
      const path = findChainCyclePath(links, parsed.link);
      if (path !== undefined) {
        return { outcome: "cycle", link: parsed.link, path } satisfies ChainResult;
      }

      const current = this.#requireStoredQuest(parsed.link.quest_id);
      const timestamp = this.#now();
      this.#requireLeaseOwner(current, parsed.actor, timestamp);
      if (current.status === "accepted") {
        this.#updateQuest(this.#renewLease(current, timestamp));
      }
      this.#insertChain(parsed.link);
      this.#appendEvent(parsed.link.quest_id, timestamp, parsed.actor, "chain", {
        ...parsed.link,
        session_guild: parsed.session_guild ?? null,
      });
      return { outcome: "added", link: parsed.link } satisfies ChainResult;
    });
    if (result.outcome === "added") {
      this.#emitWatchers();
    }
    return result;
  }

  async removeChainLink(input: ChainMutation): Promise<ChainRemovalResult> {
    const parsed = chainMutationSchema.parse(input);
    const result = this.#writeTransaction(() => {
      this.#requireQuest(parsed.link.quest_id);
      const sourceQuest = this.#requireStoredQuest(parsed.link.quest_id);
      const targetQuest = this.#requireStoredQuest(parsed.link.target_id);
      this.#requireRepositoryUnfenced(sourceQuest.repo);
      this.#requireRepositoryUnfenced(targetQuest.repo);
      const deletion = runStatement(
        this.#database,
        "DELETE FROM chains WHERE quest_id = ? AND target_id = ? AND type = ?",
        parsed.link.quest_id,
        parsed.link.target_id,
        parsed.link.type,
      );
      if (deletion.changes === 0) {
        return { outcome: "missing", link: parsed.link } satisfies ChainRemovalResult;
      }
      if (deletion.changes !== 1) {
        throw new Error("chain uniqueness invariant violated during removal");
      }
      const current = this.#requireStoredQuest(parsed.link.quest_id);
      const timestamp = this.#now();
      this.#requireLeaseOwner(current, parsed.actor, timestamp);
      if (current.status === "accepted") {
        this.#updateQuest(this.#renewLease(current, timestamp));
      }
      this.#appendEvent(parsed.link.quest_id, timestamp, parsed.actor, "chain", {
        operation: "remove",
        link: parsed.link,
        session_guild: parsed.session_guild ?? null,
      });
      return { outcome: "removed", link: parsed.link } satisfies ChainRemovalResult;
    });
    if (result.outcome === "removed") {
      this.#emitWatchers();
    }
    return result;
  }

  async addEvidence(input: NewEvidence): Promise<Evidence> {
    const parsed = newEvidenceSchema.parse(input);
    const evidence = this.#writeTransaction(() => {
      const current = this.#requireStoredQuest(parsed.quest_id);
      this.#requireRepositoryUnfenced(current.repo);
      const timestamp = this.#now();
      this.#requireLeaseOwner(current, parsed.added_by, timestamp);
      if (current.status === "accepted") {
        this.#updateQuest(this.#renewLease(current, timestamp));
      }
      const insertion = runStatement(
        this.#database,
        `INSERT INTO evidence (
          quest_id, sha256, filename, kind, stage, added_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        parsed.quest_id,
        parsed.sha256,
        parsed.filename,
        parsed.kind,
        parsed.stage,
        parsed.added_by,
        timestamp,
      );
      const evidenceId = Number(insertion.lastInsertRowid);
      this.#appendEvent(parsed.quest_id, timestamp, parsed.added_by, "update", {
        evidence_id: evidenceId,
        ...parsed,
        session_guild: parsed.session_guild ?? null,
      });
      return this.#requireEvidence(evidenceId);
    });
    this.#emitWatchers();
    return evidence;
  }

  async listQuests(filter: QuestFilter): Promise<Quest[]> {
    const parsed = questFilterSchema.parse(filter);
    return this.#readTransaction(() => this.#listQuests(parsed));
  }

  async getQuest(id: number): Promise<Quest | null> {
    const parsedId = questSchema.shape.id.parse(id);
    return this.#readTransaction(() => this.#getQuest(parsedId));
  }

  async stats(scope: QuestScope): Promise<QuestStats> {
    const parsed = questScopeSchema.parse(scope);
    return this.#readTransaction(() => {
      const quests = this.#allQuests().filter(
        (quest) => parsed.repo === null || quest.repo === parsed.repo,
      );
      const repos = new Map<
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
        const aggregate = repos.get(quest.repo) ?? {
          total: 0,
          statusCounts: new Map(),
          verdictCounts: new Map(),
          reopenCount: 0,
          assigneeLoad: new Map(),
        };
        aggregate.total += 1;
        aggregate.statusCounts.set(
          quest.status,
          (aggregate.statusCounts.get(quest.status) ?? 0) + 1,
        );
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
        repos.set(quest.repo, aggregate);
      }

      const stats = {
        repos: [...repos.entries()]
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
      questStatsSchema.parse(stats);
      return stats;
    });
  }

  async events(questId: number): Promise<Event[]> {
    const parsedId = questSchema.shape.id.parse(questId);
    return this.#readTransaction(() =>
      getRows<EventRow, [number]>(
        this.#database,
        `${selectEventsSql} WHERE quest_id = ? ORDER BY id`,
        parsedId,
      ).map(decodeEvent),
    );
  }

  async queryEvents(filter: EventFilter): Promise<Event[]> {
    const parsed = eventFilterSchema.parse(filter);
    const query = eventQuerySql(parsed);
    return this.#readTransaction(() =>
      getRows<EventRow, SQLQueryBindings[]>(
        this.#database,
        `${selectEventsWithQuestsSql}${query.where} ORDER BY e.id`,
        ...query.parameters,
      ).map(decodeEvent),
    );
  }

  async exportAll(): Promise<QuestDump> {
    if (this.#migrationLockActive) {
      return this.#readQuestDump();
    }
    return this.#readTransaction(() => this.#readQuestDump());
  }

  async replaceAll(dump: QuestDump): Promise<void> {
    const parsed = questDumpSchema.parse(dump);
    if (this.#migrationLockActive) {
      throw new Error(
        "[MIGRATION_LOCK_ACTIVE] cannot replace a SQLite store while a migration is active; use the active migration session and retry after it is released",
      );
    }
    this.#writeTransaction(() => {
      this.#requireNoMigrationFences();
      this.#replaceAllDump(parsed);
    });
    this.#emitWatchers();
  }

  async beginMigration(expected: QuestDump): Promise<StoreMigrationSession> {
    const parsedExpected = questDumpSchema.parse(expected);
    if (this.#closed) {
      throw new Error("cannot migrate a closed SQLite store");
    }
    if (this.#migrationLockActive) {
      throw new Error("a SQLite migration is already active");
    }
    const migrationCutoff = this.#now();
    try {
      runStatement(this.#database, "BEGIN IMMEDIATE");
      this.#migrationLockActive = true;
      this.#stopWatchTimer();
      if (
        stableSerialize(this.#readQuestDump(migrationCutoff)) !== stableSerialize(parsedExpected)
      ) {
        throw new Error(
          "[MIGRATION_CONCURRENT_WRITE] the SQLite store changed after its snapshot; retry the migration",
        );
      }
      const migrationLease = tryAcquireSqliteMigrationLease(this.databasePath);
      if (migrationLease === null) {
        throw new Error(
          "[MIGRATION_LOCK_BUSY] another SQLite migration is still finalizing; retry after it releases its migration lease",
        );
      }
      this.#migrationLease = migrationLease;
      this.#acquireMigrationGuard();
    } catch (error: unknown) {
      this.#rollbackMigration();
      throw error;
    }

    const sequenceFloor = this.#readSequenceHighWater();
    let active = true;
    let expectedSnapshot = parsedExpected;
    const requireActive = (): void => {
      if (!active) {
        throw new Error("the SQLite migration session is no longer active");
      }
    };
    return {
      replace: async (dump) => {
        requireActive();
        expectedSnapshot = questDumpSchema.parse(dump);
        this.#replaceAllDump(expectedSnapshot, sequenceFloor);
      },
      snapshot: async () => {
        requireActive();
        return this.#readQuestDump(migrationCutoff);
      },
      validate: async () => {
        requireActive();
        if (
          stableSerialize(this.#readQuestDump(migrationCutoff)) !==
          stableSerialize(expectedSnapshot)
        ) {
          throw new Error(
            "[MIGRATION_LOCK_LOST] the SQLite store changed while migration was held; restore the verified backup before retrying",
          );
        }
      },
      fence: async (repository) => {
        requireActive();
        this.#fenceRepository(repository);
      },
      unfence: async (repository) => {
        requireActive();
        return this.#unfenceRepository(repository);
      },
      commit: async () => {
        requireActive();
        this.#commitMigration();
      },
      release: async () => {
        if (!active) {
          return;
        }
        this.#rollbackMigration();
        active = false;
      },
      rollback: async () => {
        if (!active) {
          return;
        }
        this.#rollbackMigration();
        active = false;
      },
    } satisfies StoreMigrationSession;
  }

  createBackupSnapshot(destination: string): void {
    if (this.#closed) {
      throw new Error("cannot snapshot a closed SQLite store");
    }
    if (this.#migrationLockActive) {
      throw new Error(
        "[MIGRATION_LOCK_ACTIVE] cannot create a physical SQLite snapshot while a migration is active; use the migration session snapshot and retry after it is released",
      );
    }
    runStatement(this.#database, "VACUUM INTO ?", destination);
  }

  beginBackupRestore(source: string, preRestoreDestination: string): void {
    if (this.#closed) {
      throw new Error("cannot restore a closed SQLite store");
    }
    if (this.#migrationLockActive) {
      throw new Error(
        "[MIGRATION_LOCK_ACTIVE] cannot restore a SQLite backup while a migration is active; release the migration before retrying",
      );
    }
    if (this.#backupRestoreActive) {
      throw new Error("a SQLite backup restore is already active");
    }
    runStatement(this.#database, "ATTACH DATABASE ? AS restore_source", source);
    try {
      const sourceVersion = getRow<UserVersionRow, []>(
        this.#database,
        "PRAGMA restore_source.user_version",
      )?.user_version;
      if (sourceVersion !== SQLITE_SCHEMA_VERSION) {
        throw new Error(
          `unsupported restore schema version ${String(sourceVersion)}; expected ${SQLITE_SCHEMA_VERSION}`,
        );
      }
      runStatement(this.#database, "BEGIN IMMEDIATE");
      this.#backupRestoreActive = true;
      this.#backupRestorePreRestoreDestination = preRestoreDestination;
      this.#stopWatchTimer();
    } catch (error: unknown) {
      if (this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
      this.#backupRestoreActive = false;
      this.#backupRestorePreRestoreDestination = null;
      runStatement(this.#database, "DETACH DATABASE restore_source");
      this.#startWatchTimer();
      throw error;
    }
  }

  activateBackupRestore(): void {
    this.#requireActiveBackupRestore();
    const preRestoreDestination = this.#backupRestorePreRestoreDestination;
    if (preRestoreDestination === null) {
      throw new Error("SQLite backup restore has no pre-restore destination");
    }
    try {
      vacuumDatabaseInto(this.databasePath, preRestoreDestination);
      this.#replaceFromAttachedBackup();
      this.#verifyOwnedSchema();
    } catch (error: unknown) {
      if (this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
      this.#backupRestoreActive = false;
      this.#backupRestorePreRestoreDestination = null;
      runStatement(this.#database, "DETACH DATABASE restore_source");
      this.#startWatchTimer();
      throw error;
    }
  }

  commitBackupRestore(): void {
    this.#requireActiveBackupRestore();
    let committed = false;
    try {
      runStatement(this.#database, "COMMIT");
      committed = true;
    } catch (error: unknown) {
      if (this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
      throw error;
    } finally {
      this.#backupRestoreActive = false;
      this.#backupRestorePreRestoreDestination = null;
      runStatement(this.#database, "DETACH DATABASE restore_source");
      if (committed) {
        this.#emitWatchers();
      }
      this.#startWatchTimer();
    }
  }

  rollbackBackupRestore(): void {
    this.#requireActiveBackupRestore();
    try {
      runStatement(this.#database, "ROLLBACK");
    } finally {
      this.#backupRestoreActive = false;
      this.#backupRestorePreRestoreDestination = null;
      runStatement(this.#database, "DETACH DATABASE restore_source");
      this.#startWatchTimer();
    }
  }

  inspectBackupState(): BackupDatabaseInspection {
    if (this.#closed) {
      throw new Error("cannot inspect a closed SQLite store");
    }
    const inspect = (): BackupDatabaseInspection => ({
      dump: readSqliteQuestDump(this.#database),
      integrity_check: getRows<IntegrityRow, []>(this.#database, "PRAGMA integrity_check").map(
        (row) => row.integrity_check,
      ),
      schema_version: this.#readSchemaVersion(),
    });
    return this.#database.inTransaction ? inspect() : this.#readTransaction(inspect);
  }

  async watch(filter: QuestFilter, listener: QuestWatchListener): Promise<WatchSubscription> {
    const parsed = questFilterSchema.parse(filter);
    const snapshot = this.#readTransaction(() => this.#listQuests(parsed));
    const watcherId = this.#nextWatcherId;
    this.#nextWatcherId += 1;
    this.#watchers.set(watcherId, {
      filter: parsed,
      listener,
      signature: JSON.stringify(snapshot),
    });
    this.#startWatchTimer();
    this.#callListener(listener, snapshot);

    let subscribed = true;
    return {
      unsubscribe: async () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        this.#watchers.delete(watcherId);
        if (this.#watchers.size === 0) {
          this.#stopWatchTimer();
        }
      },
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#backupRestoreActive) {
      this.rollbackBackupRestore();
    }
    if (this.#migrationLockActive) {
      this.#rollbackMigration();
    }
    this.#closed = true;
    this.#stopWatchTimer();
    this.#watchers.clear();
    this.#database.close();
    this.#ownership.release();
  }

  #writeTransaction<T>(operation: () => T): T {
    return this.#transaction("IMMEDIATE", operation);
  }

  #readTransaction<T>(operation: () => T): T {
    return this.#transaction("DEFERRED", operation);
  }

  #transaction<T>(mode: "DEFERRED" | "IMMEDIATE", operation: () => T): T {
    if (this.#migrationLockActive) {
      throw new Error("cannot use the SQLite store while a migration is active");
    }
    if (this.#backupRestoreActive) {
      throw new Error("cannot use the SQLite store while a backup restore is uncommitted");
    }
    runStatement(this.#database, `BEGIN ${mode}`);
    try {
      const result = operation();
      runStatement(this.#database, "COMMIT");
      return result;
    } catch (error: unknown) {
      if (this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
      throw error;
    }
  }

  #commitMigration(): void {
    try {
      runStatement(this.#database, "COMMIT");
      this.#migrationCommitPending = true;
    } finally {
      if (!this.#migrationCommitPending && this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
      if (!this.#migrationCommitPending) {
        this.#migrationLease?.release();
        this.#migrationLease = undefined;
        this.#migrationLockActive = false;
        this.#startWatchTimer();
      }
    }
  }

  #releaseMigration(): void {
    const committed = this.#migrationCommitPending;
    try {
      if (this.#database.inTransaction) {
        runStatement(this.#database, this.#migrationCommitPending ? "COMMIT" : "ROLLBACK");
      }
      if (committed && !this.#migrationGuardCleared) {
        this.#clearMigrationGuard();
        this.#migrationGuardCleared = true;
      }
      this.#migrationLease?.release();
      this.#migrationLease = undefined;
    } catch (error: unknown) {
      if (this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
      throw error;
    }
    this.#migrationCommitPending = false;
    this.#migrationGuardCleared = false;
    this.#migrationLockActive = false;
    this.#startWatchTimer();
    if (committed) {
      this.#emitWatchers();
    }
  }

  #rollbackMigration(): void {
    if (this.#migrationCommitPending) {
      this.#releaseMigration();
      return;
    }
    try {
      if (this.#database.inTransaction) {
        runStatement(this.#database, "ROLLBACK");
      }
    } finally {
      this.#migrationLease?.release();
      this.#migrationLease = undefined;
      this.#migrationLockActive = false;
      this.#startWatchTimer();
    }
  }

  #requireRepositoryUnfenced(repository: string): void {
    if (
      getRow<{ found: number }, [string]>(
        this.#database,
        `SELECT 1 AS found FROM ${SQLITE_TABLE_NAMES.migrationFences}
         WHERE repo = ? OR repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'`,
        repository,
      ) !== null
    ) {
      throw new Error(
        `[MIGRATION_REPOSITORY_FENCED] repository ${repository} is fenced after a backend migration; refresh routing before retrying writes`,
      );
    }
  }

  #requireNoMigrationFences(): void {
    const fence = getRow<{ repo: string }, []>(
      this.#database,
      `SELECT repo FROM ${SQLITE_TABLE_NAMES.migrationFences} LIMIT 1`,
    );
    if (fence !== null) {
      throw new Error(
        `[MIGRATION_REPOSITORY_FENCED] cannot replace the SQLite store while repository ${fence.repo} is fenced; recover the migration or refresh routing before retrying`,
      );
    }
  }

  #acquireMigrationGuard(): void {
    runStatement(
      this.#database,
      `INSERT OR IGNORE INTO ${SQLITE_TABLE_NAMES.migrationFences} (repo, target_backend, created_at)
       VALUES (?, ?, ?)`,
      SQLITE_MIGRATION_GLOBAL_GUARD,
      "migration",
      this.#now(),
    );
  }

  #clearMigrationGuard(): void {
    runStatement(
      this.#database,
      `DELETE FROM ${SQLITE_TABLE_NAMES.migrationFences} WHERE repo = ?`,
      SQLITE_MIGRATION_GLOBAL_GUARD,
    );
  }

  #recoverStaleMigrationGuard(): void {
    const lease = tryAcquireSqliteMigrationLease(this.databasePath);
    if (lease === null) {
      return;
    }
    try {
      this.#writeTransaction(() => this.#clearMigrationGuard());
    } finally {
      lease.release();
    }
  }

  #fenceRepository(repository: string): void {
    runStatement(
      this.#database,
      `INSERT OR IGNORE INTO ${SQLITE_TABLE_NAMES.migrationFences} (repo, target_backend, created_at)
       VALUES (?, ?, ?)`,
      repository,
      "migration",
      this.#now(),
    );
  }

  #unfenceRepository(repository: string): boolean {
    return (
      runStatement(
        this.#database,
        `DELETE FROM ${SQLITE_TABLE_NAMES.migrationFences} WHERE repo = ?`,
        repository,
      ).changes > 0
    );
  }

  #readQuestDump(timestamp = this.#now()): QuestDump {
    const dump = readSqliteQuestDump(this.#database);
    return questDumpSchema.parse({
      ...dump,
      quests: dump.quests.map((quest) => materializeExpiredLease(quest, timestamp)),
    });
  }

  #readSequenceHighWater(): SqliteSequenceHighWater {
    const rows = getRows<{ name: string; seq: number }, []>(
      this.#database,
      "SELECT name, seq FROM sqlite_sequence WHERE name IN ('quests', 'evidence', 'events')",
    );
    return {
      quests: rows.find(({ name }) => name === "quests")?.seq ?? 0,
      evidence: rows.find(({ name }) => name === "evidence")?.seq ?? 0,
      events: rows.find(({ name }) => name === "events")?.seq ?? 0,
    };
  }

  #readSchemaVersion(): number {
    const version = getRow<UserVersionRow, []>(this.#database, "PRAGMA user_version")?.user_version;
    if (version === undefined) {
      throw new Error(`failed to read SQLite schema version for ${this.databasePath}`);
    }
    return version;
  }

  #configureDatabase(): void {
    runStatement(this.#database, "PRAGMA foreign_keys = ON");
    runStatement(this.#database, "PRAGMA busy_timeout = 5000");
    const schemaVersion = this.#readSchemaVersion();
    this.#requireInitializableSchema(schemaVersion);
    if (schemaVersion === 0) {
      this.#writeTransaction(() => {
        this.#requireInitializableSchema(this.#readSchemaVersion());
        for (const statement of SQLITE_SCHEMA_STATEMENTS) {
          runStatement(this.#database, statement);
        }
        this.#verifyOwnedSchema();
        runStatement(this.#database, `PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
      });
    } else {
      this.#verifyOwnedSchema();
    }
    const journalMode = getRow<JournalModeRow, []>(this.#database, "PRAGMA journal_mode = WAL");
    if (journalMode?.journal_mode.toLowerCase() !== "wal") {
      throw new Error(`failed to enable SQLite WAL mode for ${this.databasePath}`);
    }
  }

  #replaceFromAttachedBackup(): void {
    for (const trigger of SQLITE_TRIGGER_DEFINITIONS) {
      runStatement(this.#database, `DROP TRIGGER IF EXISTS ${trigger.name}`);
    }
    runStatement(this.#database, "DELETE FROM chains");
    runStatement(this.#database, "DELETE FROM evidence");
    runStatement(this.#database, "DELETE FROM events");
    runStatement(this.#database, `DELETE FROM ${SQLITE_TABLE_NAMES.migrationFences}`);
    runStatement(this.#database, "DELETE FROM quests");

    runStatement(
      this.#database,
      `INSERT INTO quests (
            id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
            verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at, created_at,
            updated_at
          )
          SELECT
            id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
            verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at, created_at,
            updated_at
          FROM restore_source.quests
          ORDER BY id`,
    );
    runStatement(
      this.#database,
      `INSERT INTO evidence (
            id, quest_id, sha256, filename, kind, stage, added_by, created_at
          )
          SELECT id, quest_id, sha256, filename, kind, stage, added_by, created_at
          FROM restore_source.evidence
          ORDER BY id`,
    );
    runStatement(
      this.#database,
      `INSERT INTO chains (quest_id, target_id, type)
          SELECT quest_id, target_id, type
          FROM restore_source.chains
          ORDER BY quest_id, target_id, type`,
    );
    runStatement(
      this.#database,
      `INSERT INTO events (id, quest_id, at, actor, action, detail)
          SELECT id, quest_id, at, actor, action, detail
          FROM restore_source.events
          ORDER BY id`,
    );
    runStatement(
      this.#database,
      `INSERT INTO ${SQLITE_TABLE_NAMES.migrationFences} (repo, target_backend, created_at)
          SELECT repo, target_backend, created_at
          FROM restore_source.${SQLITE_TABLE_NAMES.migrationFences}
          ORDER BY repo`,
    );
    runStatement(
      this.#database,
      "DELETE FROM sqlite_sequence WHERE name IN ('quests', 'evidence', 'events')",
    );
    runStatement(
      this.#database,
      `INSERT INTO sqlite_sequence (name, seq)
          SELECT name, seq
          FROM restore_source.sqlite_sequence
          WHERE name IN ('quests', 'evidence', 'events')`,
    );
    for (const trigger of SQLITE_TRIGGER_DEFINITIONS) {
      runStatement(this.#database, trigger.sql);
    }
  }

  #requireActiveBackupRestore(): void {
    if (!this.#backupRestoreActive || !this.#database.inTransaction) {
      throw new Error("no SQLite backup restore is active");
    }
  }

  #requireInitializableSchema(version: number): void {
    if (version !== 0 && version !== SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `unsupported SQLite schema version ${version}; expected ${SQLITE_SCHEMA_VERSION}`,
      );
    }
    if (version === 0 && this.#applicationTables().length > 0) {
      throw new Error("unversioned SQLite database already contains Quest tables");
    }
    if (version === 0) {
      const reservedTriggerNames = new Set<string>(
        SQLITE_TRIGGER_DEFINITIONS.map(({ name }) => name),
      );
      const conflict = getRows<TableNameRow, []>(
        this.#database,
        "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
      ).find(({ name }) => reservedTriggerNames.has(name));
      if (conflict !== undefined) {
        throw new Error(`unversioned SQLite database uses reserved trigger ${conflict.name}`);
      }
      const applicationObject = getRow<SchemaNameRow, []>(
        this.#database,
        `SELECT type, name
          FROM sqlite_schema
          WHERE name NOT LIKE 'sqlite_%'
          ORDER BY type, name
          LIMIT 1`,
      );
      if (applicationObject !== null) {
        throw new Error(
          `unversioned SQLite database already contains application ${applicationObject.type} ${applicationObject.name}`,
        );
      }
    }
  }

  #applicationTables(): string[] {
    const questTableNames = new Set(Object.values(SQLITE_TABLE_NAMES));
    return getRows<TableNameRow, []>(
      this.#database,
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
      .map(({ name }) => name)
      .filter((name) => questTableNames.has(name));
  }

  #verifyOwnedSchema(
    definitions: readonly {
      readonly name: string;
      readonly sql: string;
      readonly target: string;
      readonly type: string;
    }[] = SQLITE_SCHEMA_DEFINITIONS,
  ): void {
    const schemaObjects = new Map(
      getRows<SchemaObjectRow, []>(
        this.#database,
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'table', 'trigger')",
      ).map((schemaObject) => [`${schemaObject.type}:${schemaObject.name}`, schemaObject]),
    );
    for (const definition of definitions) {
      const schemaObject = schemaObjects.get(`${definition.type}:${definition.name}`);
      if (
        schemaObject === undefined ||
        schemaObject.tbl_name !== definition.target ||
        schemaObject.sql === null ||
        normalizeSql(schemaObject.sql) !== normalizeSql(definition.sql)
      ) {
        throw new Error(`SQLite ${definition.type} ${definition.name} does not match owned schema`);
      }
    }
  }

  #applyVerdictTransition(
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

  #applyCancelTransition(
    current: Quest,
    transition: Extract<QuestTransition, { action: "cancel" }>,
    timestamp: string,
  ): Quest {
    this.#requireStatusTransition(current, current.status, "dropped");
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

  #applyReopenTransition(
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
      current.status === "dropped" && current.kind === "bug" ? "open" : "ready";
    this.#requireStatusTransition(current, current.status, reopenedStatus);
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

  #applyTransition(current: Quest, transition: QuestTransition, timestamp: string): Quest {
    switch (transition.action) {
      case "abandon":
        this.#requireStatusTransition(current, "accepted", "ready");
        return questSchema.parse({
          ...current,
          assignee: null,
          lease_expires_at: null,
          status: "ready",
          updated_at: timestamp,
        });
      case "verdict":
        return this.#applyVerdictTransition(current, transition, timestamp);
      case "turnin":
        this.#requireStatusTransition(current, "accepted", "turned_in");
        return questSchema.parse({
          ...current,
          status: "turned_in",
          lease_expires_at: null,
          pr: transition.pr,
          updated_at: timestamp,
        });
      case "complete":
        this.#requireStatusTransition(current, "turned_in", "complete");
        return questSchema.parse({
          ...current,
          status: "complete",
          lease_expires_at: null,
          updated_at: timestamp,
        });
      case "cancel":
        return this.#applyCancelTransition(current, transition, timestamp);
      case "reopen":
        return this.#applyReopenTransition(current, transition, timestamp);
      case "update":
        return this.#applyUpdateTransition(current, transition, timestamp);
      default:
        return assertNever(transition);
    }
  }

  #applyUpdateTransition(
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
          ? leaseExpiry(timestamp)
          : current.lease_expires_at,
      updated_at: timestamp,
    });
  }

  #requireStatusTransition(
    current: Quest,
    expectedFrom: Quest["status"],
    target: Quest["status"],
  ): void {
    if (current.status !== expectedFrom || !isLegalStatusTransition(current.status, target)) {
      throw new Error(`illegal quest transition: ${current.status} -> ${target}`);
    }
  }

  #insertQuest(quest: Quest): void {
    runStatement(
      this.#database,
      `INSERT INTO quests (
        id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
        verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      quest.id,
      quest.repo,
      quest.area,
      quest.kind,
      quest.title,
      quest.description,
      quest.opened_by,
      quest.guild,
      quest.assignee,
      quest.status,
      quest.verdict,
      quest.verdict_notes,
      quest.priority,
      quest.pr,
      JSON.stringify(quest.predicted_files),
      quest.reopen_count,
      quest.lease_expires_at,
      quest.created_at,
      quest.updated_at,
    );
  }

  #replaceAllDump(
    dump: QuestDump,
    sequenceFloor: SqliteSequenceHighWater = this.#readSequenceHighWater(),
  ): void {
    for (const trigger of SQLITE_TRIGGER_DEFINITIONS) {
      runStatement(this.#database, `DROP TRIGGER IF EXISTS ${trigger.name}`);
    }
    try {
      runStatement(this.#database, "DELETE FROM chains");
      runStatement(this.#database, "DELETE FROM evidence");
      runStatement(this.#database, "DELETE FROM events");
      runStatement(this.#database, "DELETE FROM quests");
      for (const quest of dump.quests) {
        this.#insertQuest(quest);
      }
      for (const evidence of dump.evidence) {
        this.#insertEvidence(evidence);
      }
      for (const chain of dump.chains) {
        this.#insertChain(chain);
      }
      for (const event of dump.events) {
        this.#insertEvent(event);
      }
      this.#resetSequences(dump, sequenceFloor);
    } finally {
      for (const trigger of SQLITE_TRIGGER_DEFINITIONS) {
        runStatement(this.#database, trigger.sql);
      }
    }
  }

  #insertEvidence(evidence: Evidence): void {
    runStatement(
      this.#database,
      `INSERT INTO evidence (
        id, quest_id, sha256, filename, kind, stage, added_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      evidence.id,
      evidence.quest_id,
      evidence.sha256,
      evidence.filename,
      evidence.kind,
      evidence.stage,
      evidence.added_by,
      evidence.created_at,
    );
  }

  #insertEvent(event: Event): void {
    const detail = eventSchema.parse(event).detail;
    runStatement(
      this.#database,
      `INSERT INTO events (id, quest_id, at, actor, action, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      event.id,
      event.quest_id,
      event.at,
      event.actor,
      event.action,
      JSON.stringify(detail),
    );
  }

  #resetSequences(dump: QuestDump, sequenceFloor: SqliteSequenceHighWater): void {
    runStatement(
      this.#database,
      "DELETE FROM sqlite_sequence WHERE name IN ('quests', 'evidence', 'events')",
    );
    const sequences: readonly [string, number][] = [
      ["quests", Math.max(sequenceFloor.quests, maxEntityId(dump.quests))],
      ["evidence", Math.max(sequenceFloor.evidence, maxEntityId(dump.evidence))],
      ["events", Math.max(sequenceFloor.events, maxEntityId(dump.events))],
    ];
    for (const [name, sequence] of sequences) {
      if (sequence > 0) {
        runStatement(
          this.#database,
          "INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)",
          name,
          sequence,
        );
      }
    }
  }

  #updateQuest(quest: Quest): void {
    const changed = runStatement(
      this.#database,
      `UPDATE quests SET
        repo = ?, area = ?, kind = ?, title = ?, description = ?, opened_by = ?, guild = ?,
        assignee = ?, status = ?, verdict = ?, verdict_notes = ?, priority = ?,
        pr = ?, predicted_files = ?, reopen_count = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ?`,
      quest.repo,
      quest.area,
      quest.kind,
      quest.title,
      quest.description,
      quest.opened_by,
      quest.guild,
      quest.assignee,
      quest.status,
      quest.verdict,
      quest.verdict_notes,
      quest.priority,
      quest.pr,
      JSON.stringify(quest.predicted_files),
      quest.reopen_count,
      quest.lease_expires_at,
      quest.updated_at,
      quest.id,
    );
    if (changed.changes !== 1) {
      throw new Error(`quest ${quest.id} disappeared during transition`);
    }
  }

  #insertChain(link: Chain): void {
    runStatement(
      this.#database,
      "INSERT INTO chains (quest_id, target_id, type) VALUES (?, ?, ?)",
      link.quest_id,
      link.target_id,
      link.type,
    );
  }

  #getChain(link: Chain): Chain | null {
    const row = getRow<Chain, [number, number, string]>(
      this.#database,
      `${selectChainsSql}
        WHERE quest_id = ? AND target_id = ? AND type = ?`,
      link.quest_id,
      link.target_id,
      link.type,
    );
    return row === null ? null : chainSchema.parse(row);
  }

  #appendEvent(
    questId: number,
    timestamp: string,
    actor: string,
    action: Event["action"],
    detail: unknown,
  ): void {
    this.#beforeEventAppend?.();
    const parsedTimestamp = eventBaseSchema.shape.at.parse(timestamp);
    const parsedActor = eventBaseSchema.shape.actor.parse(actor);
    const parsedAction = eventBaseSchema.shape.action.parse(action);
    const parsedDetail = eventBaseSchema.shape.detail.parse(detail);
    const encodedDetail = JSON.stringify(parsedDetail);
    runStatement(
      this.#database,
      "INSERT INTO events (quest_id, at, actor, action, detail) VALUES (?, ?, ?, ?, ?)",
      questId,
      parsedTimestamp,
      parsedActor,
      parsedAction,
      encodedDetail,
    );
  }

  #getQuest(id: number): Quest | null {
    const quest = this.#getStoredQuest(id);
    return quest === null ? null : this.#publicQuest(quest);
  }

  #requireStoredQuest(id: number): Quest {
    const quest = this.#getStoredQuest(id);
    if (quest === null) {
      throw new Error(`quest ${id} does not exist`);
    }
    return quest;
  }

  #requireQuest(id: number): Quest {
    return this.#publicQuest(this.#requireStoredQuest(id));
  }

  #requireEvidence(id: number): Evidence {
    const row = getRow<Evidence, [number]>(this.#database, `${selectEvidenceSql} WHERE id = ?`, id);
    if (row === null) {
      throw new Error(`evidence ${id} does not exist`);
    }
    return evidenceSchema.parse(row);
  }

  #allQuests(): Quest[] {
    const now = this.#now();
    return getRows<QuestRow, []>(this.#database, `${selectQuestsSql} ORDER BY id`)
      .map(decodeQuest)
      .map((quest) => materializeExpiredLease(quest, now));
  }

  #getStoredQuest(id: number): Quest | null {
    const row = getRow<QuestRow, [number]>(this.#database, `${selectQuestsSql} WHERE id = ?`, id);
    return row === null ? null : decodeQuest(row);
  }

  #publicQuest(quest: Quest): Quest {
    return materializeExpiredLease(quest, this.#now());
  }

  #hasGuildMismatch(
    quest: Quest,
    sessionGuild: string | null | undefined,
    force: boolean | undefined,
  ): boolean {
    return quest.guild !== null && quest.guild !== (sessionGuild ?? null) && force !== true;
  }

  #canAccept(stored: Quest, current: Quest, expired: boolean): boolean {
    const unclaimedReady = stored.assignee === null && stored.status === "ready";
    const expiredAccepted = stored.status === "accepted" && expired;
    return (
      (unclaimedReady || expiredAccepted) && isLegalStatusTransition(current.status, "accepted")
    );
  }

  #renewLease(quest: Quest, timestamp: string): Quest {
    return questSchema.parse({
      ...quest,
      lease_expires_at: leaseExpiry(timestamp),
      updated_at: timestamp,
    });
  }

  #requireLeaseOwner(quest: Quest, actor: string, now: string): void {
    if (quest.status !== "accepted") {
      return;
    }
    if (quest.lease_expires_at === null || isLeaseExpired(quest.lease_expires_at, now)) {
      if (quest.assignee === actor) {
        throw new Error(`quest ${quest.id} lease expired; re-accept to continue`);
      }
      if (this.#hasAcceptedEvent(quest.id, actor)) {
        throw new Error(`quest ${quest.id} lease expired; stop, ${quest.assignee} has it`);
      }
      throw new Error(`quest ${quest.id} lease expired; re-accept to continue`);
    }
    if (quest.assignee === actor) {
      return;
    }
    if (this.#hasAcceptedEvent(quest.id, actor)) {
      throw new Error(`quest ${quest.id} lease expired; stop, ${quest.assignee} has it`);
    }
    if (quest.assignee === null) {
      throw new Error(`quest ${quest.id} has no active lease; re-accept to continue`);
    }
    throw new Error(
      `quest ${quest.id} lease owned by ${quest.assignee}; stop, ${quest.assignee} has it`,
    );
  }

  #requireActiveLeaseOwner(quest: Quest, owner: string, now: string): void {
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
    if (quest.lease_expires_at === null || isLeaseExpired(quest.lease_expires_at, now)) {
      throw new Error(`quest ${quest.id} lease expired; re-accept to continue`);
    }
  }

  #hasAcceptedEvent(id: number, actor: string): boolean {
    return (
      getRow<{ found: number }, [number, string]>(
        this.#database,
        "SELECT 1 AS found FROM events WHERE quest_id = ? AND action = 'accept' AND actor = ? LIMIT 1",
        id,
        actor,
      ) !== null
    );
  }

  #allChains(): Chain[] {
    return getRows<Chain, []>(
      this.#database,
      `${selectChainsSql} ORDER BY quest_id, target_id, type`,
    ).map((row) => chainSchema.parse(row));
  }

  #listQuests(filter: QuestFilter): Quest[] {
    const quests = this.#allQuests();
    const statusById = new Map(quests.map((quest) => [quest.id, quest.status]));
    const blockedIds = new Set<number>();
    if (filter.blocked !== undefined) {
      for (const link of this.#allChains()) {
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

  #emitWatchers(): void {
    if (this.#closed || this.#backupRestoreActive || this.#watchers.size === 0) {
      return;
    }
    for (const [id, watcher] of this.#watchers) {
      const snapshot = this.#readTransaction(() => this.#listQuests(watcher.filter));
      const signature = JSON.stringify(snapshot);
      if (signature === watcher.signature) {
        continue;
      }
      this.#watchers.set(id, { ...watcher, signature });
      this.#callListener(watcher.listener, snapshot);
    }
  }

  #callListener(listener: QuestWatchListener, snapshot: readonly Quest[]): void {
    try {
      listener(snapshot);
    } catch {
      return;
    }
  }

  #startWatchTimer(): void {
    if (this.#backupRestoreActive || this.#watchTimer !== null || this.#watchers.size === 0) {
      return;
    }
    this.#watchTimer = setInterval(() => {
      this.#emitWatchers();
    }, this.#watchPollIntervalMs);
    this.#watchTimer.unref();
  }

  #stopWatchTimer(): void {
    if (this.#watchTimer === null) {
      return;
    }
    clearInterval(this.#watchTimer);
    this.#watchTimer = null;
  }
}

function decodeQuest(row: QuestRow): Quest {
  return questSchema.parse({
    ...row,
    predicted_files: JSON.parse(row.predicted_files),
  });
}

function decodeEvent(row: EventRow): Event {
  return eventSchema.parse({
    ...row,
    detail: JSON.parse(row.detail),
  });
}

function assertNever(value: never): never {
  throw new Error(`unhandled transition: ${String(value)}`);
}
