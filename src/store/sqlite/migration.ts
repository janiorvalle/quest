import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { LEASE_TTL_MS } from "../../domain";
import {
  SQLITE_CORE_SCHEMA_DEFINITIONS,
  SQLITE_MIGRATION_FENCE_TRIGGER_DEFINITIONS,
  SQLITE_MIGRATION_SCHEMA_DEFINITIONS,
  SQLITE_PRE_GLOBAL_GUARD_MIGRATION_SCHEMA_DEFINITIONS,
  SQLITE_SCHEMA_VERSION,
  SQLITE_TRIGGER_DEFINITIONS,
} from "./ddl";
import { acquireExclusiveSqliteStoreOwnership } from "./ownership";

const LEGACY_SCHEMA_VERSION = 1;
const PRE_CANCEL_SCHEMA_VERSION = 2;
const PRE_LEASE_SCHEMA_VERSION = 3;
const PRE_FENCE_SCHEMA_VERSION = 4;
const PRE_GLOBAL_GUARD_SCHEMA_VERSION = 5;
const PRE_SIGNOFF_SCHEMA_VERSION = 6;

type SqliteSchemaDefinition = {
  readonly name: string;
  readonly sql: string;
  readonly target: string;
  readonly type: "index" | "table" | "trigger";
};

function withoutSignoffEnumValues(
  definitions: readonly SqliteSchemaDefinition[],
): SqliteSchemaDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    sql:
      definition.type === "table" ? definition.sql.replaceAll(", 'signoff'", "") : definition.sql,
  }));
}

const LEGACY_QUESTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    area TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'task')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    assignee TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'ready', 'accepted', 'turned_in', 'complete', 'dropped')),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('actionable', 'not-reproduced', 'works-as-intended', 'invalid', 'external', 'duplicate', 'wont-do')),
    verdict_notes TEXT,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
    pr TEXT,
    branch TEXT,
    predicted_files TEXT NOT NULL CHECK (json_valid(predicted_files)),
    reopen_count INTEGER NOT NULL CHECK (reopen_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`;

const NO_LEASE_QUESTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    area TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'task')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    opened_by TEXT NOT NULL,
    guild TEXT,
    assignee TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'ready', 'accepted', 'turned_in', 'complete', 'dropped')),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('actionable', 'not-reproduced', 'works-as-intended', 'invalid', 'external', 'duplicate', 'wont-do')),
    verdict_notes TEXT,
    priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
    pr TEXT,
    predicted_files TEXT NOT NULL CHECK (json_valid(predicted_files)),
    reopen_count INTEGER NOT NULL CHECK (reopen_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`;

const PRE_CANCEL_EVENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add', 'accept', 'abandon', 'verdict', 'turnin', 'complete', 'reopen', 'update', 'chain')),
    detail TEXT NOT NULL CHECK (json_valid(detail))
  ) STRICT`;

const PRE_LEASE_EVENTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL REFERENCES quests(id),
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('add', 'accept', 'abandon', 'verdict', 'turnin', 'complete', 'reopen', 'cancel', 'update', 'chain')),
    detail TEXT NOT NULL CHECK (json_valid(detail))
  ) STRICT`;

const LEGACY_SCHEMA_DEFINITIONS = withoutSignoffEnumValues(
  SQLITE_CORE_SCHEMA_DEFINITIONS.map((definition) =>
    definition.name === "quests"
      ? { ...definition, sql: LEGACY_QUESTS_TABLE_SQL }
      : definition.name === "events"
        ? { ...definition, sql: PRE_CANCEL_EVENTS_TABLE_SQL }
        : definition,
  ),
);

const PRE_CANCEL_SCHEMA_DEFINITIONS = withoutSignoffEnumValues(
  SQLITE_CORE_SCHEMA_DEFINITIONS.map((definition) =>
    definition.name === "quests"
      ? { ...definition, sql: NO_LEASE_QUESTS_TABLE_SQL }
      : definition.name === "events"
        ? { ...definition, sql: PRE_CANCEL_EVENTS_TABLE_SQL }
        : definition,
  ),
);

const PRE_LEASE_SCHEMA_DEFINITIONS = withoutSignoffEnumValues(
  SQLITE_CORE_SCHEMA_DEFINITIONS.map((definition) =>
    definition.name === "quests"
      ? { ...definition, sql: NO_LEASE_QUESTS_TABLE_SQL }
      : definition.name === "events"
        ? { ...definition, sql: PRE_LEASE_EVENTS_TABLE_SQL }
        : definition,
  ),
);

const PRE_FENCE_SCHEMA_DEFINITIONS = withoutSignoffEnumValues(SQLITE_CORE_SCHEMA_DEFINITIONS);
const PRE_GLOBAL_GUARD_SCHEMA_DEFINITIONS = [
  ...withoutSignoffEnumValues(SQLITE_CORE_SCHEMA_DEFINITIONS),
  ...SQLITE_PRE_GLOBAL_GUARD_MIGRATION_SCHEMA_DEFINITIONS,
] as const;

const PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS = withoutSignoffEnumValues(
  SQLITE_CORE_SCHEMA_DEFINITIONS,
);

const PRE_SIGNOFF_SCHEMA_DEFINITIONS = [
  ...PRE_SIGNOFF_CORE_SCHEMA_DEFINITIONS,
  ...SQLITE_MIGRATION_SCHEMA_DEFINITIONS,
] as const;

type UserVersionRow = {
  user_version: number;
};

type SchemaObjectRow = {
  name: string;
  sql: string | null;
  tbl_name: string;
  type: string;
};

type SchemaNameRow = {
  name: string;
  type: string;
};

export interface SqliteMigrationOptions {
  readonly backupRoot: string;
  readonly databasePath: string;
  readonly now?: () => string;
}

function migrationBackupName(sourceVersion: number, timestamp: string): string {
  return `quest-v${sourceVersion}-before-v${SQLITE_SCHEMA_VERSION}-${timestamp.replaceAll(/[^0-9]/gu, "")}-${randomUUID()}.db`;
}

async function createMigrationBackup(
  database: Database,
  options: SqliteMigrationOptions,
  sourceVersion: number,
): Promise<void> {
  const directory = join(resolve(options.backupRoot), "migrations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = options.now?.() ?? new Date().toISOString();
  const destination = join(directory, migrationBackupName(sourceVersion, timestamp));
  database.run("VACUUM INTO ?", [destination]);
}

function tableSql(name: "quests" | "evidence" | "events", stagingName: string): string {
  const definition = SQLITE_CORE_SCHEMA_DEFINITIONS.find(
    (candidate) => candidate.type === "table" && candidate.name === name,
  );
  if (definition === undefined) {
    throw new Error(`Quest SQLite schema is missing the ${name} table definition`);
  }
  return definition.sql.replace(new RegExp(`\\b${name}\\b`, "gu"), stagingName);
}

function currentTableSql(name: "quests" | "evidence" | "events"): string {
  const definition = SQLITE_CORE_SCHEMA_DEFINITIONS.find(
    (candidate) => candidate.type === "table" && candidate.name === name,
  );
  if (definition === undefined) {
    throw new Error(`Quest SQLite schema is missing the ${name} table definition`);
  }
  return definition.sql;
}

type SqliteSequenceRow = {
  seq: number;
};

function readSequenceFloor(
  database: Database,
  tableName: "evidence" | "events",
): number | undefined {
  const row = database
    .query<SqliteSequenceRow, [string]>("SELECT seq FROM sqlite_sequence WHERE name = ? LIMIT 1")
    .get(tableName);
  return row?.seq;
}

function restoreSequenceFloor(
  database: Database,
  tableName: "evidence" | "events",
  floor: number | undefined,
): void {
  if (floor === undefined) {
    return;
  }
  const current = database
    .query<SqliteSequenceRow, [string]>("SELECT seq FROM sqlite_sequence WHERE name = ? LIMIT 1")
    .get(tableName);
  if (current === null) {
    database.run("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", [tableName, floor]);
  } else if (current.seq < floor) {
    database.run("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", [floor, tableName]);
  }
}

function dropAllTriggers(database: Database): void {
  for (const { name } of SQLITE_TRIGGER_DEFINITIONS) {
    database.run(`DROP TRIGGER IF EXISTS ${name}`);
  }
}

function rebuildEnumTable(
  database: Database,
  name: "evidence" | "events",
  stagingName: string,
): void {
  const sequenceFloor = readSequenceFloor(database, name);
  database.run(tableSql(name, stagingName));
  database.run(`INSERT INTO ${stagingName} SELECT * FROM ${name} ORDER BY id`);
  database.run(`DROP TABLE ${name}`);
  database.run(currentTableSql(name));
  database.run(`INSERT INTO ${name} SELECT * FROM ${stagingName} ORDER BY id`);
  database.run(`DROP TABLE ${stagingName}`);
  const supportSql = name === "events" ? eventsSupportSql() : evidenceSupportSql();
  for (const sql of supportSql) {
    database.run(sql);
  }
  restoreSequenceFloor(database, name, sequenceFloor);
}

function questsIndexSql(): readonly string[] {
  return SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
    (candidate) => candidate.type === "index" && candidate.target === "quests",
  ).map(({ sql }) => sql);
}

function eventsSupportSql(): readonly string[] {
  return SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
    (candidate) => candidate.target === "events" && candidate.type !== "table",
  ).map(({ sql }) => sql);
}

function evidenceSupportSql(): readonly string[] {
  return SQLITE_CORE_SCHEMA_DEFINITIONS.filter(
    (candidate) => candidate.target === "evidence" && candidate.type !== "table",
  ).map(({ sql }) => sql);
}

function readUserVersion(database: Database): number {
  const row = database.query<UserVersionRow, []>("PRAGMA user_version").get();
  if (row === null) {
    throw new Error("failed to read SQLite schema version during migration");
  }
  return row.user_version;
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/\bIF NOT EXISTS\b/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function sourceDefinitions(version: number) {
  if (version === LEGACY_SCHEMA_VERSION) {
    return LEGACY_SCHEMA_DEFINITIONS;
  }
  if (version === PRE_CANCEL_SCHEMA_VERSION) {
    return PRE_CANCEL_SCHEMA_DEFINITIONS;
  }
  if (version === PRE_LEASE_SCHEMA_VERSION) {
    return PRE_LEASE_SCHEMA_DEFINITIONS;
  }
  if (version === PRE_FENCE_SCHEMA_VERSION) {
    return PRE_FENCE_SCHEMA_DEFINITIONS;
  }
  if (version === PRE_GLOBAL_GUARD_SCHEMA_VERSION) {
    return PRE_GLOBAL_GUARD_SCHEMA_DEFINITIONS;
  }
  if (version === PRE_SIGNOFF_SCHEMA_VERSION) {
    return PRE_SIGNOFF_SCHEMA_DEFINITIONS;
  }
  throw new Error(`unsupported source schema version ${version}`);
}

function verifySchema(
  database: Database,
  definitions: readonly {
    readonly name: string;
    readonly sql: string;
    readonly target: string;
    readonly type: "index" | "table" | "trigger";
  }[],
  versionLabel: string,
  unclaimedMigrationDefinitions: readonly {
    readonly name: string;
    readonly sql: string;
    readonly target: string;
    readonly type: "index" | "table" | "trigger";
  }[] = SQLITE_MIGRATION_SCHEMA_DEFINITIONS,
): void {
  const schemaObjects = new Map(
    database
      .query<SchemaObjectRow, []>(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'table', 'trigger')",
      )
      .all()
      .map((schemaObject) => [`${schemaObject.type}:${schemaObject.name}`, schemaObject]),
  );
  const expectedObjects = new Set(definitions.map(({ name, type }) => `${type}:${name}`));
  for (const stagingName of ["quests_v4", "evidence_v7", "events_v4"]) {
    const stagingCollision = database
      .query<SchemaNameRow, [string]>("SELECT name, type FROM sqlite_schema WHERE name = ? LIMIT 1")
      .get(stagingName);
    if (stagingCollision !== null) {
      throw new Error(
        `SQLite migration staging table ${stagingName} collides with ${stagingCollision.type} ${stagingName}`,
      );
    }
  }
  for (const definition of definitions) {
    const schemaObject = schemaObjects.get(`${definition.type}:${definition.name}`);
    if (
      schemaObject === undefined ||
      schemaObject.tbl_name !== definition.target ||
      schemaObject.sql === null ||
      normalizeSql(schemaObject.sql) !== normalizeSql(definition.sql)
    ) {
      throw new Error(
        `SQLite migration requires an owned ${versionLabel} schema; ${definition.type} ${definition.name} does not match`,
      );
    }
  }
  for (const definition of unclaimedMigrationDefinitions) {
    if (schemaObjects.has(`${definition.type}:${definition.name}`)) {
      throw new Error(
        `SQLite migration requires an unclaimed ${versionLabel} schema; reserved ${definition.type} ${definition.name} already exists`,
      );
    }
  }
  for (const schemaObject of schemaObjects.values()) {
    if (
      schemaObject.tbl_name === "quests" &&
      !expectedObjects.has(`${schemaObject.type}:${schemaObject.name}`)
    ) {
      throw new Error(
        `SQLite migration requires an owned ${versionLabel} schema; unexpected ${schemaObject.type} ${schemaObject.name}`,
      );
    }
  }
}

const leaseFromUpdatedAtSql = `CASE
  WHEN status = 'accepted' AND assignee IS NOT NULL
  THEN strftime('%Y-%m-%dT%H:%M:%fZ', julianday(updated_at) + ${LEASE_TTL_MS / 86_400_000})
  ELSE NULL
END`;

function copyQuestRowsSql(version: number): string {
  const guild = version === LEGACY_SCHEMA_VERSION ? "NULL" : "guild";
  return `
        INSERT INTO quests_v4 (
          id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
          verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at,
          created_at, updated_at
        )
        SELECT
          id, repo, area, kind, title, description, opened_by, ${guild}, assignee, status, verdict,
          verdict_notes, priority, pr, predicted_files, reopen_count, ${leaseFromUpdatedAtSql},
          created_at, updated_at
        FROM quests
        ORDER BY id`;
}

function runFenceSchemaMigration(database: Database): void {
  database.run("PRAGMA foreign_keys = OFF");
  database.run("BEGIN IMMEDIATE");
  try {
    dropAllTriggers(database);
    rebuildEnumTable(database, "evidence", "evidence_v7");
    rebuildEnumTable(database, "events", "events_v4");
    for (const { sql } of SQLITE_MIGRATION_SCHEMA_DEFINITIONS) {
      database.run(sql);
    }
    database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.run("COMMIT");
  } catch (error: unknown) {
    if (database.inTransaction) {
      database.run("ROLLBACK");
    }
    throw error;
  }
}

function runGlobalGuardSchemaMigration(database: Database): void {
  database.run("BEGIN IMMEDIATE");
  try {
    dropAllTriggers(database);
    rebuildEnumTable(database, "evidence", "evidence_v7");
    rebuildEnumTable(database, "events", "events_v4");
    for (const { sql } of SQLITE_MIGRATION_FENCE_TRIGGER_DEFINITIONS) {
      database.run(sql);
    }
    database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.run("COMMIT");
  } catch (error: unknown) {
    if (database.inTransaction) {
      database.run("ROLLBACK");
    }
    throw error;
  }
}

function runSignoffSchemaMigration(database: Database): void {
  database.run("PRAGMA foreign_keys = OFF");
  database.run("BEGIN IMMEDIATE");
  try {
    dropAllTriggers(database);
    rebuildEnumTable(database, "evidence", "evidence_v7");
    rebuildEnumTable(database, "events", "events_v4");
    for (const { sql } of SQLITE_MIGRATION_SCHEMA_DEFINITIONS) {
      database.run(sql);
    }

    database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.run("COMMIT");
  } catch (error: unknown) {
    if (database.inTransaction) {
      database.run("ROLLBACK");
    }
    throw error;
  }
}

function runLegacySchemaMigration(database: Database, version: number): void {
  database.run("PRAGMA foreign_keys = OFF");
  database.run("BEGIN IMMEDIATE");
  try {
    database.run(tableSql("quests", "quests_v4"));
    database.run(copyQuestRowsSql(version));
    database.run("DROP TABLE quests");
    database.run(currentTableSql("quests"));
    database.run(`
      INSERT INTO quests (
        id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
        verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at,
        created_at, updated_at
      )
      SELECT
        id, repo, area, kind, title, description, opened_by, guild, assignee, status, verdict,
        verdict_notes, priority, pr, predicted_files, reopen_count, lease_expires_at,
        created_at, updated_at
      FROM quests_v4
      ORDER BY id
    `);
    database.run("DROP TABLE quests_v4");
    for (const statement of questsIndexSql()) {
      database.run(statement);
    }

    dropAllTriggers(database);
    rebuildEnumTable(database, "evidence", "evidence_v7");
    rebuildEnumTable(database, "events", "events_v4");
    for (const { sql } of SQLITE_MIGRATION_SCHEMA_DEFINITIONS) {
      database.run(sql);
    }

    database.run(`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`);
    database.run("COMMIT");
  } catch (error: unknown) {
    if (database.inTransaction) {
      database.run("ROLLBACK");
    }
    throw error;
  }
}

export async function migrateSqliteStore(options: SqliteMigrationOptions): Promise<void> {
  const ownership = acquireExclusiveSqliteStoreOwnership(resolve(options.databasePath));
  let database: Database | undefined;
  try {
    database = new Database(resolve(options.databasePath), {
      readwrite: true,
      strict: true,
    });
    const version = readUserVersion(database);
    if (version === SQLITE_SCHEMA_VERSION) {
      return;
    }
    if (
      version !== LEGACY_SCHEMA_VERSION &&
      version !== PRE_CANCEL_SCHEMA_VERSION &&
      version !== PRE_LEASE_SCHEMA_VERSION &&
      version !== PRE_FENCE_SCHEMA_VERSION &&
      version !== PRE_GLOBAL_GUARD_SCHEMA_VERSION &&
      version !== PRE_SIGNOFF_SCHEMA_VERSION
    ) {
      throw new Error(
        `SQLite migration requires schema ${LEGACY_SCHEMA_VERSION}, ${PRE_CANCEL_SCHEMA_VERSION}, ${PRE_LEASE_SCHEMA_VERSION}, ${PRE_FENCE_SCHEMA_VERSION}, ${PRE_GLOBAL_GUARD_SCHEMA_VERSION}, or ${PRE_SIGNOFF_SCHEMA_VERSION}; found ${version}`,
      );
    }
    verifySchema(
      database,
      sourceDefinitions(version),
      `v${version}`,
      version === PRE_GLOBAL_GUARD_SCHEMA_VERSION || version === PRE_SIGNOFF_SCHEMA_VERSION
        ? []
        : SQLITE_MIGRATION_SCHEMA_DEFINITIONS,
    );

    await createMigrationBackup(database, options, version);
    if (version === PRE_FENCE_SCHEMA_VERSION) {
      runFenceSchemaMigration(database);
      return;
    }
    if (version === PRE_GLOBAL_GUARD_SCHEMA_VERSION) {
      runGlobalGuardSchemaMigration(database);
      return;
    }
    if (version === PRE_SIGNOFF_SCHEMA_VERSION) {
      runSignoffSchemaMigration(database);
      return;
    }
    runLegacySchemaMigration(database, version);
  } finally {
    database?.close();
    ownership.release();
  }
}
