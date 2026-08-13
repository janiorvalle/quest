import {
  chainTypeSchema,
  eventActionSchema,
  evidenceKindSchema,
  evidenceStageSchema,
  questKindSchema,
  questStatusSchema,
  verdictSchema,
} from "../../schema";

function enumCheck(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

const questKinds = enumCheck(questKindSchema.options);
const questStatuses = enumCheck(questStatusSchema.options);
const verdicts = enumCheck(verdictSchema.options);
const evidenceKinds = enumCheck(evidenceKindSchema.options);
const evidenceStages = enumCheck(evidenceStageSchema.options);
const chainTypes = enumCheck(chainTypeSchema.options);
const eventActions = enumCheck(eventActionSchema.options);

export const SQLITE_SCHEMA_VERSION = 8;

export const SQLITE_TABLE_NAMES = {
  quests: "quests",
  evidence: "evidence",
  chains: "chains",
  events: "events",
  migrationFences: "migration_fences",
};

export const SQLITE_MIGRATION_GLOBAL_GUARD = "";

type SqliteSchemaObjectType = "index" | "table" | "trigger";

function schemaDefinition(type: SqliteSchemaObjectType, name: string, target: string, sql: string) {
  return { name, sql, target, type };
}

export const SQLITE_EVENT_TRIGGER_DEFINITIONS = [
  {
    name: "events_are_append_only_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS events_are_append_only_insert
      BEFORE INSERT ON events
      WHEN EXISTS (SELECT 1 FROM events WHERE id = NEW.id)
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END`,
    target: SQLITE_TABLE_NAMES.events,
  },
  {
    name: "events_are_append_only_update",
    sql: `CREATE TRIGGER IF NOT EXISTS events_are_append_only_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END`,
    target: SQLITE_TABLE_NAMES.events,
  },
  {
    name: "events_are_append_only_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS events_are_append_only_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END`,
    target: SQLITE_TABLE_NAMES.events,
  },
] as const;

export const SQLITE_MIGRATION_FENCE_TRIGGER_DEFINITIONS = [
  {
    name: "migration_fence_quests_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_quests_insert
      BEFORE INSERT ON quests
      WHEN EXISTS (SELECT 1 FROM migration_fences WHERE repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}' OR repo = NEW.repo)
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.quests,
  },
  {
    name: "migration_fence_quests_update",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_quests_update
      BEFORE UPDATE ON quests
      WHEN EXISTS (SELECT 1 FROM migration_fences WHERE repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}' OR repo = OLD.repo)
        OR EXISTS (SELECT 1 FROM migration_fences WHERE repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}' OR repo = NEW.repo)
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.quests,
  },
  {
    name: "migration_fence_quests_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_quests_delete
      BEFORE DELETE ON quests
      WHEN EXISTS (SELECT 1 FROM migration_fences WHERE repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}' OR repo = OLD.repo)
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.quests,
  },
  {
    name: "migration_fence_evidence_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_evidence_insert
      BEFORE INSERT ON evidence
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = NEW.quest_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.evidence,
  },
  {
    name: "migration_fence_evidence_update",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_evidence_update
      BEFORE UPDATE ON evidence
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = OLD.quest_id OR q.id = NEW.quest_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.evidence,
  },
  {
    name: "migration_fence_evidence_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_evidence_delete
      BEFORE DELETE ON evidence
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = OLD.quest_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.evidence,
  },
  {
    name: "migration_fence_chains_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_chains_insert
      BEFORE INSERT ON chains
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = NEW.quest_id OR q.id = NEW.target_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.chains,
  },
  {
    name: "migration_fence_chains_update",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_chains_update
      BEFORE UPDATE ON chains
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = OLD.quest_id OR q.id = OLD.target_id OR q.id = NEW.quest_id OR q.id = NEW.target_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.chains,
  },
  {
    name: "migration_fence_chains_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_chains_delete
      BEFORE DELETE ON chains
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = OLD.quest_id OR q.id = OLD.target_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.chains,
  },
  {
    name: "migration_fence_events_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_events_insert
      BEFORE INSERT ON events
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = NEW.quest_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.events,
  },
  {
    name: "migration_fence_events_update",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_events_update
      BEFORE UPDATE ON events
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = OLD.quest_id OR q.id = NEW.quest_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.events,
  },
  {
    name: "migration_fence_events_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS migration_fence_events_delete
      BEFORE DELETE ON events
      WHEN EXISTS (
        SELECT 1
        FROM quests AS q
        INNER JOIN migration_fences AS f ON f.repo = q.repo OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'
        WHERE q.id = OLD.quest_id
      )
      BEGIN
        SELECT RAISE(ABORT, '[MIGRATION_REPOSITORY_FENCED] repository is fenced after a backend migration; refresh routing before retrying writes');
      END`,
    target: SQLITE_TABLE_NAMES.events,
  },
] as const;

// v5 databases have the same fence table, but their triggers do not know about
// the global guard used to protect the post-commit routing window.
export const SQLITE_PRE_GLOBAL_GUARD_MIGRATION_SCHEMA_DEFINITIONS = [
  schemaDefinition(
    "table",
    SQLITE_TABLE_NAMES.migrationFences,
    SQLITE_TABLE_NAMES.migrationFences,
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAMES.migrationFences} (
    repo TEXT PRIMARY KEY,
    target_backend TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  ),
  ...SQLITE_MIGRATION_FENCE_TRIGGER_DEFINITIONS.map(({ name, sql, target }) =>
    schemaDefinition(
      "trigger",
      name,
      target,
      sql
        .replaceAll(`repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}' OR `, "")
        .replaceAll(` OR f.repo = '${SQLITE_MIGRATION_GLOBAL_GUARD}'`, ""),
    ),
  ),
] as const;

export const SQLITE_TRIGGER_DEFINITIONS = [
  ...SQLITE_EVENT_TRIGGER_DEFINITIONS,
  ...SQLITE_MIGRATION_FENCE_TRIGGER_DEFINITIONS,
] as const;

export const SQLITE_CORE_SCHEMA_DEFINITIONS = [
  schemaDefinition(
    "table",
    SQLITE_TABLE_NAMES.quests,
    SQLITE_TABLE_NAMES.quests,
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAMES.quests} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    area TEXT,
    kind TEXT NOT NULL CHECK (kind IN (${questKinds})),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    guild TEXT,
    assignee TEXT,
    status TEXT NOT NULL CHECK (status IN (${questStatuses})),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN (${verdicts})),
    verdict_notes TEXT,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
    pr TEXT,
    predicted_files TEXT NOT NULL CHECK (json_valid(predicted_files)),
    reopen_count INTEGER NOT NULL CHECK (reopen_count >= 0),
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  ),
  schemaDefinition(
    "table",
    SQLITE_TABLE_NAMES.evidence,
    SQLITE_TABLE_NAMES.evidence,
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAMES.evidence} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    sha256 TEXT NOT NULL CHECK (
      length(sha256) = 64
      AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    filename TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (${evidenceKinds})),
    stage TEXT NOT NULL CHECK (stage IN (${evidenceStages})),
    added_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  ),
  schemaDefinition(
    "table",
    SQLITE_TABLE_NAMES.chains,
    SQLITE_TABLE_NAMES.chains,
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAMES.chains} (
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    target_id INTEGER NOT NULL REFERENCES quests(id),
    type TEXT NOT NULL CHECK (type IN (${chainTypes})),
    PRIMARY KEY (quest_id, target_id, type)
  ) STRICT, WITHOUT ROWID`,
  ),
  schemaDefinition(
    "table",
    SQLITE_TABLE_NAMES.events,
    SQLITE_TABLE_NAMES.events,
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAMES.events} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN (${eventActions})),
    detail TEXT NOT NULL CHECK (json_valid(detail))
  ) STRICT`,
  ),
  schemaDefinition(
    "index",
    "quests_repo_id",
    SQLITE_TABLE_NAMES.quests,
    "CREATE INDEX IF NOT EXISTS quests_repo_id ON quests(repo, id)",
  ),
  schemaDefinition(
    "index",
    "quests_status_id",
    SQLITE_TABLE_NAMES.quests,
    "CREATE INDEX IF NOT EXISTS quests_status_id ON quests(status, id)",
  ),
  schemaDefinition(
    "index",
    "chains_target",
    SQLITE_TABLE_NAMES.chains,
    "CREATE INDEX IF NOT EXISTS chains_target ON chains(target_id, type)",
  ),
  schemaDefinition(
    "index",
    "evidence_quest_id",
    SQLITE_TABLE_NAMES.evidence,
    "CREATE INDEX IF NOT EXISTS evidence_quest_id ON evidence(quest_id, id)",
  ),
  schemaDefinition(
    "index",
    "events_quest_id",
    SQLITE_TABLE_NAMES.events,
    "CREATE INDEX IF NOT EXISTS events_quest_id ON events(quest_id, id)",
  ),
  ...SQLITE_EVENT_TRIGGER_DEFINITIONS.map(({ name, sql, target }) =>
    schemaDefinition("trigger", name, target, sql),
  ),
] as const;

export const SQLITE_MIGRATION_SCHEMA_DEFINITIONS = [
  schemaDefinition(
    "table",
    SQLITE_TABLE_NAMES.migrationFences,
    SQLITE_TABLE_NAMES.migrationFences,
    `CREATE TABLE IF NOT EXISTS ${SQLITE_TABLE_NAMES.migrationFences} (
    repo TEXT PRIMARY KEY,
    target_backend TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  ),
  ...SQLITE_MIGRATION_FENCE_TRIGGER_DEFINITIONS.map(({ name, sql, target }) =>
    schemaDefinition("trigger", name, target, sql),
  ),
] as const;

export const SQLITE_SCHEMA_DEFINITIONS = [
  ...SQLITE_CORE_SCHEMA_DEFINITIONS,
  ...SQLITE_MIGRATION_SCHEMA_DEFINITIONS,
] as const;

export const SQLITE_MIGRATION_SCHEMA_STATEMENTS = SQLITE_MIGRATION_SCHEMA_DEFINITIONS.map(
  ({ sql }) => sql,
);
export const SQLITE_SCHEMA_STATEMENTS = SQLITE_SCHEMA_DEFINITIONS.map(({ sql }) => sql);
