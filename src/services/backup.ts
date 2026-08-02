import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type Dirent } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";

import { restoreRepositoryConfigEntryIfUnchanged } from "../config";
import {
  BACKUP_MANIFEST_SCHEMA,
  type BackupCounts,
  type BackupManifest,
  backupManifestSchema,
  type Config,
  configSchema,
  type QuestDump,
  type RepoConfigEntry,
  type Sha256,
  stableSerialize,
} from "../schema";
import {
  type BackupDatabase,
  type BackupDatabaseRestoreSession,
  type BlobStore,
  type Clock,
  LocalBlobStore,
} from "../store";
import { parseQuestBackupExport, serializeQuestBackupExport } from "./export";

const SNAPSHOTS_DIRECTORY = "snapshots";
const EVIDENCE_DIRECTORY = "evidence";
const DATABASE_FILE = "quest.db";
const EXPORT_FILE = "export.json";
const CONFIG_FILE = "config.toml";
const MANIFEST_FILE = "manifest.json";
const EVIDENCE_SAMPLE_SIZE = 10;
const BACKUP_LOCK_DATABASE = ".quest-backup-lock.sqlite";
const BACKUP_LOCK_TIMEOUT_MS = 30_000;
const SNAPSHOT_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z(?:-\d+)?$/u;
const inProcessBackupLocks = new Map<string, Promise<void>>();

type Retention = Config["backup"]["retention"];

interface SnapshotRecord {
  readonly directory: string;
  readonly manifest: BackupManifest;
  readonly name: string;
}

interface SnapshotIdentity {
  readonly created_at: string;
  readonly name: string;
}

interface FileDigest {
  readonly bytes: number;
  readonly sha256: string;
}

type EvidenceVerification = "sample" | "full";

export interface BackupRunResult {
  readonly snapshot: string;
  readonly path: string;
  readonly counts: BackupCounts;
  readonly evidence: {
    readonly copied: number;
    readonly count: number;
    readonly total_bytes: number;
  };
  readonly pruned: readonly string[];
}

export interface BackupVerifyResult {
  readonly snapshot: string;
  readonly verified: true;
  readonly full: boolean;
  readonly counts: BackupCounts;
  readonly integrity_check: "ok";
  readonly sampled_evidence: readonly string[];
}

export interface BackupVerifyOptions {
  readonly full?: boolean;
}

export interface BackupSnapshotSummary {
  readonly snapshot: string;
  readonly created_at: string;
  readonly age_seconds: number;
  readonly size_bytes: number;
  readonly counts: BackupCounts;
}

export interface BackupRestoreResult {
  readonly snapshot: string;
  readonly pre_restore_database: string | null;
  readonly pre_restore_config: string | null;
  readonly evidence_restored: number;
  readonly verified: true;
}

export interface BackupPruneResult {
  readonly deleted: readonly string[];
  readonly retained: readonly string[];
}

export interface BackupOperations {
  run(rootOverride?: string): Promise<BackupRunResult>;
  verify(snapshot?: string, options?: BackupVerifyOptions): Promise<BackupVerifyResult>;
  list(): Promise<readonly BackupSnapshotSummary[]>;
  restore(snapshot: string, repository?: string): Promise<BackupRestoreResult>;
  prune(): Promise<BackupPruneResult>;
}

export interface LocalBackupServiceOptions {
  readonly backupDatabase: BackupDatabase;
  readonly blobStore?: BlobStore;
  readonly clock: Clock;
  readonly configFile: string;
  readonly defaultRoot: string;
  readonly evidenceDirectory: string;
  readonly retention: Retention;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return error.code === "EINVAL" || error.code === "EPERM" || error.code === "EISDIR";
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  }
}

async function ensureDirectoryDurable(path: string): Promise<void> {
  const missing: string[] = [];
  let current = path;
  while (!(await directoryExists(current))) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  for (const directory of missing.reverse()) {
    await syncDirectory(dirname(directory));
  }
}

async function acquireInProcessBackupLock(root: string): Promise<() => void> {
  const previous = inProcessBackupLocks.get(root) ?? Promise.resolve();
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate;
  });
  const tail = previous.then(() => gate);
  inProcessBackupLocks.set(root, tail);
  await previous;
  return () => {
    releaseGate?.();
    if (inProcessBackupLocks.get(root) === tail) {
      inProcessBackupLocks.delete(root);
    }
  };
}

async function acquireBackupRootLock(root: string): Promise<() => Promise<void>> {
  const releaseInProcess = await acquireInProcessBackupLock(root);
  try {
    await ensureDirectoryDurable(root);
  } catch (error: unknown) {
    releaseInProcess();
    throw error;
  }
  const lockPath = join(root, BACKUP_LOCK_DATABASE);
  let database: Database;
  try {
    database = new Database(lockPath, { create: true, strict: true });
  } catch (error: unknown) {
    releaseInProcess();
    throw error;
  }
  try {
    database.run(`PRAGMA busy_timeout = ${BACKUP_LOCK_TIMEOUT_MS}`);
    database.run("BEGIN IMMEDIATE");
  } catch (error: unknown) {
    database.close();
    releaseInProcess();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not acquire backup root lock ${lockPath}: ${detail}`);
  }
  let active = true;
  return () => {
    if (!active) {
      return Promise.resolve();
    }
    active = false;
    try {
      database.run("ROLLBACK");
    } finally {
      database.close();
      releaseInProcess();
    }
    return Promise.resolve();
  };
}

function localRoot(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "") {
    throw new Error("backup root must not be empty");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) {
    throw new Error("backup roots are local-only; URL and cloud destinations are not supported");
  }
  return resolve(trimmed);
}

function normalizedTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`backup clock returned an invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function snapshotName(timestamp: string): string {
  return timestamp.replaceAll(":", "");
}

function dumpCounts(dump: QuestDump): BackupCounts {
  return {
    quests: dump.quests.length,
    evidence: dump.evidence.length,
    chains: dump.chains.length,
    events: dump.events.length,
  };
}

function uniqueEvidenceHashes(dump: QuestDump): Sha256[] {
  return [...new Set(dump.evidence.map(({ sha256 }) => sha256))].sort();
}

async function digestFile(path: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return {
    bytes: (await stat(path)).size,
    sha256: hash.digest("hex"),
  };
}

async function copyEvidenceFile(
  source: string,
  destination: string,
  expectedSha256: string,
): Promise<{ readonly bytes: number; readonly copied: boolean }> {
  const sourceDigest = await digestFile(source);
  if (sourceDigest.sha256 !== expectedSha256) {
    throw new Error(`evidence blob ${basename(source)} does not match its content address`);
  }
  if (await regularFileExists(destination)) {
    const destinationDigest = await digestFile(destination);
    if (destinationDigest.sha256 !== expectedSha256) {
      throw new Error(`existing backup evidence blob ${basename(destination)} is corrupt`);
    }
    return { bytes: sourceDigest.bytes, copied: false };
  }

  await ensureDirectoryDurable(dirname(destination));
  const temporary = join(dirname(destination), `.${expectedSha256}.${randomUUID()}.tmp`);
  await copyFile(source, temporary, constants.COPYFILE_EXCL);
  try {
    await syncFile(temporary);
    const temporaryDigest = await digestFile(temporary);
    if (temporaryDigest.sha256 !== expectedSha256) {
      throw new Error(`copied evidence blob ${expectedSha256} failed its hash check`);
    }
    try {
      await link(temporary, destination);
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const destinationDigest = await digestFile(destination);
      if (destinationDigest.sha256 !== expectedSha256) {
        throw new Error(`existing evidence blob ${expectedSha256} is corrupt`);
      }
      return { bytes: sourceDigest.bytes, copied: false };
    }
    await syncDirectory(dirname(destination));
    return { bytes: sourceDigest.bytes, copied: true };
  } finally {
    await removeIfPresent(temporary);
  }
}

async function syncRemoteEvidence(
  hashes: readonly Sha256[],
  destinationDirectory: string,
  sourceStore: BlobStore,
): Promise<{ readonly copied: number; readonly totalBytes: number }> {
  const destinationStore = new LocalBlobStore(destinationDirectory);
  let copied = 0;
  let totalBytes = 0;
  for (const hash of hashes) {
    const bytes = await sourceStore.get(hash);
    if (bytes === null) {
      throw new Error(
        `evidence blob ${hash} is missing from the active backend; republish it before backing up`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== hash) {
      throw new Error(`evidence blob ${hash} does not match its content address`);
    }
    const existing = await destinationStore.get(hash);
    if (existing === null) {
      const published = await destinationStore.put(bytes);
      if (published !== hash) {
        throw new Error(`backup evidence publication returned the wrong address for ${hash}`);
      }
      copied += 1;
    } else {
      const existingDigest = createHash("sha256").update(existing).digest("hex");
      if (existingDigest !== hash) {
        throw new Error(`existing backup evidence blob ${hash} is corrupt`);
      }
    }
    totalBytes += bytes.byteLength;
  }
  return { copied, totalBytes };
}

async function syncEvidence(
  hashes: readonly Sha256[],
  sourceDirectory: string,
  destinationDirectory: string,
  sourceStore?: BlobStore,
): Promise<{ readonly copied: number; readonly totalBytes: number }> {
  if (sourceStore !== undefined) {
    return syncRemoteEvidence(hashes, destinationDirectory, sourceStore);
  }
  let copied = 0;
  let totalBytes = 0;
  for (const hash of hashes) {
    const result = await copyEvidenceFile(
      join(sourceDirectory, hash),
      join(destinationDirectory, hash),
      hash,
    );
    totalBytes += result.bytes;
    if (result.copied) {
      copied += 1;
    }
  }
  return { copied, totalBytes };
}

async function restoreEvidence(
  hashes: readonly Sha256[],
  sourceDirectory: string,
  destinationStore: BlobStore,
): Promise<{ readonly copied: number; readonly totalBytes: number }> {
  let copied = 0;
  let totalBytes = 0;
  for (const hash of hashes) {
    const source = join(sourceDirectory, hash);
    const sourceDigest = await digestFile(source);
    if (sourceDigest.sha256 !== hash) {
      throw new Error(`evidence blob ${basename(source)} does not match its content address`);
    }
    const bytes = await readFile(source);
    const result =
      destinationStore.restore === undefined
        ? {
            copied: (await destinationStore.get(hash)) === null,
            quarantined: null,
          }
        : await destinationStore.restore(hash, bytes);
    if (result.copied && destinationStore.restore === undefined) {
      const published = await destinationStore.put(bytes);
      if (published !== hash) {
        throw new Error(`evidence restore returned the wrong address for ${hash}`);
      }
    }
    totalBytes += sourceDigest.bytes;
    if (result.copied) {
      copied += 1;
    }
  }
  return { copied, totalBytes };
}

function sameDump(left: QuestDump, right: QuestDump): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

function requireMatchingDump(physical: QuestDump, logical: QuestDump): void {
  if (!sameDump(physical, logical)) {
    throw new Error("physical snapshot and logical export do not contain the same store state");
  }
}

function repositoryDump(dump: QuestDump, repository: string): QuestDump {
  const quests = dump.quests.filter((quest) => quest.repo === repository);
  const questIds = new Set(quests.map((quest) => quest.id));
  return {
    schema_version: dump.schema_version,
    quests,
    evidence: dump.evidence.filter((item) => questIds.has(item.quest_id)),
    chains: dump.chains.filter(
      (chain) => questIds.has(chain.quest_id) || questIds.has(chain.target_id),
    ),
    events: dump.events.filter((event) => questIds.has(event.quest_id)),
  };
}

function requireIntegrityOk(results: readonly string[]): void {
  if (results.length !== 1 || results[0]?.toLowerCase() !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${results.join("; ")}`);
  }
}

function requireEqualCounts(actual: BackupCounts, expected: BackupCounts): void {
  const requireEqual = (name: string, actualCount: number, expectedCount: number): void => {
    if (actualCount !== expectedCount) {
      throw new Error(
        `backup count mismatch for ${name}: manifest=${expectedCount} actual=${actualCount}`,
      );
    }
  };
  requireEqual("quests", actual.quests, expected.quests);
  requireEqual("evidence", actual.evidence, expected.evidence);
  requireEqual("chains", actual.chains, expected.chains);
  requireEqual("events", actual.events, expected.events);
}

async function readConfigSnapshot(configFile: string): Promise<Uint8Array> {
  try {
    return await readFile(configFile);
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return new Uint8Array();
    }
    throw error;
  }
}

async function readManifest(directory: string): Promise<BackupManifest> {
  const manifestPath = join(directory, MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read backup manifest ${manifestPath}: ${detail}`);
  }
  return backupManifestSchema.parse(parsed);
}

async function snapshotRecords(root: string): Promise<SnapshotRecord[]> {
  const snapshotsDirectory = join(root, SNAPSHOTS_DIRECTORY);
  let entries: Dirent[];
  try {
    entries = await readdir(snapshotsDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }

  const records: SnapshotRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SNAPSHOT_NAME_PATTERN.test(entry.name)) {
      continue;
    }
    const directory = join(snapshotsDirectory, entry.name);
    try {
      records.push({
        directory,
        manifest: await readManifest(directory),
        name: entry.name,
      });
    } catch {
      // A damaged snapshot must not block recovery from other intact snapshots.
    }
  }
  return records.sort(
    (left, right) =>
      right.manifest.created_at.localeCompare(left.manifest.created_at) ||
      right.name.localeCompare(left.name),
  );
}

function validateSnapshotName(name: string): string {
  if (name !== basename(name) || !SNAPSHOT_NAME_PATTERN.test(name)) {
    throw new Error(`invalid backup snapshot name: ${name}`);
  }
  return name;
}

async function resolveSnapshot(root: string, requested?: string): Promise<SnapshotRecord> {
  if (requested !== undefined) {
    const name = validateSnapshotName(requested);
    const directory = join(root, SNAPSHOTS_DIRECTORY, name);
    if (!(await directoryExists(directory))) {
      throw new Error(`backup snapshot does not exist: ${name}`);
    }
    return {
      directory,
      manifest: await readManifest(directory),
      name,
    };
  }
  const latest = (await snapshotRecords(root))[0];
  if (latest === undefined) {
    throw new Error(`no valid backup snapshots found under ${root}`);
  }
  return latest;
}

interface ConfigRestoreSession {
  readonly pre_restore_config: string | null;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function prepareConfigRestore(
  source: string,
  destination: string,
  label: string,
): Promise<ConfigRestoreSession> {
  await ensureDirectoryDurable(dirname(destination));
  const temporary = `${destination}.${randomUUID()}.restore`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await syncFile(temporary);
  } catch (error: unknown) {
    await removeIfPresent(temporary);
    throw error;
  }
  const existing = await regularFileExists(destination);
  const preRestore = existing ? await availablePreRestoreFile(destination, label) : null;
  let previousMoved = false;
  let replacementInstalled = false;

  const rollback = async (): Promise<void> => {
    if (replacementInstalled) {
      await removeIfPresent(destination);
      replacementInstalled = false;
    }
    if (previousMoved && preRestore !== null) {
      await rename(preRestore, destination);
      previousMoved = false;
    }
    await removeIfPresent(temporary);
    await syncDirectory(dirname(destination));
  };

  return {
    pre_restore_config: preRestore,
    commit: async () => {
      if (replacementInstalled) {
        return;
      }
      try {
        if (preRestore !== null) {
          await rename(destination, preRestore);
          previousMoved = true;
        }
        await rename(temporary, destination);
        replacementInstalled = true;
        await syncDirectory(dirname(destination));
      } catch (error: unknown) {
        await rollback();
        throw error;
      }
    },
    rollback,
  };
}

function repositoryConfigEntry(
  contents: Uint8Array,
  repository: string,
): RepoConfigEntry | undefined {
  const text = new TextDecoder().decode(contents);
  if (text.trim() === "") {
    return undefined;
  }
  return configSchema.parse(parse(text)).repos[repository];
}

async function repositoryConfigEntryMatches(
  destination: string,
  repository: string,
  expected: RepoConfigEntry | undefined,
): Promise<boolean> {
  try {
    return (
      stableSerialize(repositoryConfigEntry(await readFile(destination), repository)) ===
      stableSerialize(expected)
    );
  } catch {
    return false;
  }
}

async function rollbackUncommittedRepositoryConfig(
  destination: string,
  repository: string,
  previousEntry: RepoConfigEntry | undefined,
  preRestore: string | null,
  commitAttempted: boolean,
): Promise<boolean> {
  if (
    commitAttempted &&
    !(await repositoryConfigEntryMatches(destination, repository, previousEntry))
  ) {
    return false;
  }
  if (preRestore !== null) {
    await removeIfPresent(preRestore);
  }
  return true;
}

async function prepareRepositoryConfigRestore(
  source: string,
  destination: string,
  label: string,
  repository: string,
): Promise<ConfigRestoreSession> {
  await ensureDirectoryDurable(dirname(destination));
  const sourceEntry = repositoryConfigEntry(await readConfigSnapshot(source), repository);
  const previousEntry = repositoryConfigEntry(await readConfigSnapshot(destination), repository);
  const existing = await regularFileExists(destination);
  const preRestore = existing ? await availablePreRestoreFile(destination, label) : null;
  if (preRestore !== null) {
    await copyFile(destination, preRestore, constants.COPYFILE_EXCL);
    await syncFile(preRestore);
  }
  let committed = false;
  let commitAttempted = false;
  return {
    pre_restore_config: preRestore,
    commit: async () => {
      if (committed) {
        return;
      }
      commitAttempted = true;
      try {
        const restored = await restoreRepositoryConfigEntryIfUnchanged(
          destination,
          repository,
          previousEntry,
          sourceEntry,
        );
        if (!restored) {
          throw new Error(
            `[CONFIG_ROUTE_CHANGED] routing for ${repository} changed during backup restore; inspect config.toml and retry`,
          );
        }
        committed = true;
      } catch (error: unknown) {
        if (await repositoryConfigEntryMatches(destination, repository, sourceEntry)) {
          committed = true;
          return;
        }
        throw error;
      }
    },
    rollback: async () => {
      if (
        !committed &&
        (await rollbackUncommittedRepositoryConfig(
          destination,
          repository,
          previousEntry,
          preRestore,
          commitAttempted,
        ))
      ) {
        commitAttempted = false;
        return;
      }
      const restored = await restoreRepositoryConfigEntryIfUnchanged(
        destination,
        repository,
        sourceEntry,
        previousEntry,
      );
      if (!restored) {
        throw new Error(
          `[CONFIG_ROUTE_CHANGED] routing for ${repository} changed during backup restore; inspect config.toml and retry`,
        );
      }
      if (preRestore !== null) {
        await removeIfPresent(preRestore);
      }
      committed = false;
    },
  };
}

async function rollbackRestore(
  config: ConfigRestoreSession,
  database: BackupDatabaseRestoreSession | undefined,
): Promise<void> {
  try {
    await config.rollback();
  } finally {
    if (database !== undefined) {
      await database.rollback();
    }
  }
}

function isoWeek(timestamp: string): string {
  const source = new Date(timestamp);
  const date = new Date(
    Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()),
  );
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const weekYear = date.getUTCFullYear();
  const first = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((date.valueOf() - first.valueOf()) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

function retainedForBucket(
  snapshots: readonly SnapshotIdentity[],
  limit: number,
  bucket: (createdAt: string) => string,
): Set<string> {
  const kept = new Set<string>();
  const buckets = new Set<string>();
  for (const snapshot of snapshots) {
    const key = bucket(snapshot.created_at);
    if (buckets.has(key)) {
      continue;
    }
    if (buckets.size >= limit) {
      break;
    }
    buckets.add(key);
    kept.add(snapshot.name);
  }
  return kept;
}

export function selectSnapshotsForRetention(
  snapshots: readonly SnapshotIdentity[],
  retention: Retention,
): Set<string> {
  const newestFirst = [...snapshots].sort(
    (left, right) =>
      right.created_at.localeCompare(left.created_at) || right.name.localeCompare(left.name),
  );
  const retained = new Set<string>();
  const categories = [
    retainedForBucket(newestFirst, retention.daily, (timestamp) => timestamp.slice(0, 10)),
    retainedForBucket(newestFirst, retention.weekly, isoWeek),
    retainedForBucket(newestFirst, retention.monthly, (timestamp) => timestamp.slice(0, 7)),
  ];
  for (const category of categories) {
    for (const name of category) {
      retained.add(name);
    }
  }
  return retained;
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
    } else if (entry.isFile()) {
      total += (await stat(path)).size;
    } else {
      throw new Error(`backup snapshot contains an unsupported file type: ${path}`);
    }
  }
  return total;
}

function sampledEvidence(hashes: readonly string[]): string[] {
  if (hashes.length <= EVIDENCE_SAMPLE_SIZE) {
    return [...hashes];
  }
  const sample = new Set<string>();
  for (let index = 0; index < EVIDENCE_SAMPLE_SIZE; index += 1) {
    const position = Math.floor((index * (hashes.length - 1)) / (EVIDENCE_SAMPLE_SIZE - 1));
    const hash = hashes[position];
    if (hash !== undefined) {
      sample.add(hash);
    }
  }
  return [...sample];
}

async function availableSnapshotName(root: string, createdAt: string): Promise<string> {
  const base = snapshotName(createdAt);
  let candidate = base;
  let sequence = 2;
  while (await pathExists(join(root, SNAPSHOTS_DIRECTORY, candidate))) {
    candidate = `${base}-${sequence}`;
    sequence += 1;
  }
  return candidate;
}

async function availablePreRestoreFile(path: string, label: string): Promise<string> {
  const safeLabel = label.replaceAll(/[^0-9A-Za-z._-]/gu, "_");
  const base = `${path}.${safeLabel === "" ? "restore" : safeLabel}`;
  let candidate = `${base}.pre-restore`;
  let sequence = 2;
  while (await pathExists(candidate)) {
    candidate = `${base}.${sequence}.pre-restore`;
    sequence += 1;
  }
  return candidate;
}

export class LocalBackupService implements BackupOperations {
  readonly #backupDatabase: BackupDatabase;
  readonly #blobStore: BlobStore | undefined;
  readonly #clock: Clock;
  readonly #configFile: string;
  readonly #defaultRoot: string;
  readonly #evidenceDirectory: string;
  readonly #retention: Retention;

  constructor(options: LocalBackupServiceOptions) {
    if (!isAbsolute(options.configFile)) {
      throw new Error(`config file must be absolute: ${options.configFile}`);
    }
    if (!isAbsolute(options.evidenceDirectory)) {
      throw new Error(`evidence directory must be absolute: ${options.evidenceDirectory}`);
    }
    this.#backupDatabase = options.backupDatabase;
    this.#blobStore = options.blobStore;
    this.#clock = options.clock;
    this.#configFile = options.configFile;
    this.#defaultRoot = localRoot(options.defaultRoot);
    this.#evidenceDirectory = options.evidenceDirectory;
    this.#retention = options.retention;
  }

  async run(rootOverride?: string): Promise<BackupRunResult> {
    const root = rootOverride === undefined ? this.#defaultRoot : localRoot(rootOverride);
    const release = await acquireBackupRootLock(root);
    try {
      return await this.#runLocked(root);
    } finally {
      await release();
    }
  }

  async #runLocked(root: string): Promise<BackupRunResult> {
    const createdAt = normalizedTimestamp(await this.#clock.now());
    const name = await availableSnapshotName(root, createdAt);
    const snapshotsDirectory = join(root, SNAPSHOTS_DIRECTORY);
    const finalDirectory = join(snapshotsDirectory, name);
    const stagingDirectory = join(snapshotsDirectory, `.${name}.${randomUUID()}.tmp`);
    const backupEvidenceDirectory = join(root, EVIDENCE_DIRECTORY);
    await ensureDirectoryDurable(snapshotsDirectory);
    await ensureDirectoryDurable(backupEvidenceDirectory);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });

    try {
      const databasePath = join(stagingDirectory, DATABASE_FILE);
      const exportPath = join(stagingDirectory, EXPORT_FILE);
      const configPath = join(stagingDirectory, CONFIG_FILE);
      const inspection = await this.#backupDatabase.createSnapshot(databasePath);
      requireIntegrityOk(inspection.integrity_check);

      const dump = inspection.dump;
      const serialized = serializeQuestBackupExport(dump);
      const parsed = parseQuestBackupExport(serialized);
      requireMatchingDump(parsed, dump);

      const hashes = uniqueEvidenceHashes(dump);
      const evidence = await syncEvidence(
        hashes,
        this.#evidenceDirectory,
        backupEvidenceDirectory,
        this.#blobStore,
      );

      await writeFile(exportPath, serialized, { mode: 0o600 });
      await writeFile(configPath, await readConfigSnapshot(this.#configFile), { mode: 0o600 });

      const manifest = backupManifestSchema.parse({
        schema: BACKUP_MANIFEST_SCHEMA,
        created_at: createdAt,
        store_schema_version: inspection.schema_version,
        counts: dumpCounts(dump),
        files: {
          [DATABASE_FILE]: await digestFile(databasePath),
          [EXPORT_FILE]: await digestFile(exportPath),
          [CONFIG_FILE]: await digestFile(configPath),
        },
        evidence: {
          count: hashes.length,
          total_bytes: evidence.totalBytes,
        },
      });
      const manifestPath = join(stagingDirectory, MANIFEST_FILE);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await Promise.all([
        syncFile(databasePath),
        syncFile(exportPath),
        syncFile(configPath),
        syncFile(manifestPath),
      ]);
      await syncDirectory(stagingDirectory);
      await rename(stagingDirectory, finalDirectory);
      await syncDirectory(snapshotsDirectory);

      const pruned = await this.#pruneRoot(root, new Set([name]));
      return {
        snapshot: name,
        path: finalDirectory,
        counts: manifest.counts,
        evidence: {
          copied: evidence.copied,
          count: manifest.evidence.count,
          total_bytes: manifest.evidence.total_bytes,
        },
        pruned: pruned.deleted,
      };
    } catch (error: unknown) {
      await rm(stagingDirectory, { force: true, recursive: true });
      throw error;
    }
  }

  async verify(snapshot?: string, options: BackupVerifyOptions = {}): Promise<BackupVerifyResult> {
    const evidenceVerification: EvidenceVerification = options.full === true ? "full" : "sample";
    const verified = await this.#verifyRecord(
      await resolveSnapshot(this.#defaultRoot, snapshot),
      this.#defaultRoot,
      evidenceVerification,
    );
    return verified.result;
  }

  async list(): Promise<readonly BackupSnapshotSummary[]> {
    const now = new Date(normalizedTimestamp(await this.#clock.now())).valueOf();
    const records = await snapshotRecords(this.#defaultRoot);
    return Promise.all(
      records.map(async (record) => ({
        snapshot: record.name,
        created_at: record.manifest.created_at,
        age_seconds: Math.max(
          0,
          Math.floor((now - new Date(record.manifest.created_at).valueOf()) / 1000),
        ),
        size_bytes: await directorySize(record.directory),
        counts: record.manifest.counts,
      })),
    );
  }

  async restore(snapshot: string, repository?: string): Promise<BackupRestoreResult> {
    const release = await acquireBackupRootLock(this.#defaultRoot);
    try {
      return await this.#restoreLocked(snapshot, repository);
    } finally {
      await release();
    }
  }

  async #restoreLocked(snapshot: string, repository?: string): Promise<BackupRestoreResult> {
    const trimmedRepository = repository?.trim();
    if (repository !== undefined && trimmedRepository === "") {
      throw new Error(
        "[BACKUP_REPOSITORY_REQUIRED] repository-scoped restore received a blank repository; provide a repository name or omit the repository to restore the complete snapshot",
      );
    }
    if (
      trimmedRepository !== undefined &&
      trimmedRepository !== "" &&
      this.#backupDatabase.restoreScope === "full"
    ) {
      throw new Error(
        `[BACKUP_REPOSITORY_RESTORE_UNSUPPORTED] this backend cannot restore only repository ${trimmedRepository}; rerun backup restore without a repository to restore the complete snapshot`,
      );
    }
    const record = await resolveSnapshot(this.#defaultRoot, snapshot);
    const verified = await this.#verifyRecord(record, this.#defaultRoot);
    const effectiveRepository = trimmedRepository === "" ? undefined : trimmedRepository;
    const evidenceDump =
      effectiveRepository === undefined
        ? verified.dump
        : repositoryDump(verified.dump, effectiveRepository);
    const hashes = uniqueEvidenceHashes(evidenceDump);
    let databaseRestore: BackupDatabaseRestoreSession | undefined;
    let configRestore: ConfigRestoreSession | undefined;
    try {
      const activeDatabaseRestore = await this.#backupDatabase.restoreSnapshot(
        join(record.directory, DATABASE_FILE),
        record.name,
        effectiveRepository,
      );
      databaseRestore = activeDatabaseRestore;

      const evidence = await restoreEvidence(
        hashes,
        join(this.#defaultRoot, EVIDENCE_DIRECTORY),
        this.#blobStore ?? new LocalBlobStore(this.#evidenceDirectory),
      );

      const activeConfigRestore =
        effectiveRepository === undefined
          ? await prepareConfigRestore(
              join(record.directory, CONFIG_FILE),
              this.#configFile,
              record.name,
            )
          : await prepareRepositoryConfigRestore(
              join(record.directory, CONFIG_FILE),
              this.#configFile,
              record.name,
              effectiveRepository,
            );
      configRestore = activeConfigRestore;

      await activeDatabaseRestore.activate();
      await activeConfigRestore.commit();
      const restored = await this.#backupDatabase.inspectCurrent();
      requireIntegrityOk(restored.integrity_check);
      requireMatchingDump(
        effectiveRepository === undefined
          ? restored.dump
          : repositoryDump(restored.dump, effectiveRepository),
        effectiveRepository === undefined
          ? verified.dump
          : repositoryDump(verified.dump, effectiveRepository),
      );
      await activeDatabaseRestore.commit();

      return {
        snapshot: record.name,
        pre_restore_database: activeDatabaseRestore.pre_restore_database,
        pre_restore_config: activeConfigRestore.pre_restore_config,
        evidence_restored: evidence.copied,
        verified: true,
      };
    } catch (error: unknown) {
      if (configRestore !== undefined) {
        await rollbackRestore(configRestore, databaseRestore);
      } else if (databaseRestore !== undefined) {
        await databaseRestore.rollback();
      }
      throw error;
    }
  }

  prune(): Promise<BackupPruneResult> {
    return this.#pruneLocked();
  }

  async #pruneLocked(): Promise<BackupPruneResult> {
    const release = await acquireBackupRootLock(this.#defaultRoot);
    try {
      return await this.#pruneRoot(this.#defaultRoot);
    } finally {
      await release();
    }
  }

  async #pruneRoot(
    root: string,
    protectedNames: ReadonlySet<string> = new Set(),
  ): Promise<BackupPruneResult> {
    const records = await snapshotRecords(root);
    const verifiedRecords: SnapshotRecord[] = [];
    for (const record of records) {
      try {
        await this.#verifyRecord(record, root);
        verifiedRecords.push(record);
      } catch {
        // Damaged snapshots neither displace nor trigger deletion of a verified recovery point.
      }
    }
    const retained = selectSnapshotsForRetention(
      verifiedRecords.map((record) => ({
        created_at: record.manifest.created_at,
        name: record.name,
      })),
      this.#retention,
    );
    for (const name of protectedNames) {
      retained.add(name);
    }
    const deleted = verifiedRecords.filter((record) => !retained.has(record.name));
    for (const record of deleted) {
      await rm(record.directory, { recursive: true });
    }
    return {
      deleted: deleted.map(({ name }) => name).sort(),
      retained: records
        .filter((record) => retained.has(record.name))
        .map(({ name }) => name)
        .sort(),
    };
  }

  async #verifyRecord(
    record: SnapshotRecord,
    root: string,
    evidenceVerification: EvidenceVerification = "sample",
  ): Promise<{ readonly dump: QuestDump; readonly result: BackupVerifyResult }> {
    const databasePath = join(record.directory, DATABASE_FILE);
    const exportPath = join(record.directory, EXPORT_FILE);
    const configPath = join(record.directory, CONFIG_FILE);
    const verifyFile = async (
      name: typeof DATABASE_FILE | typeof EXPORT_FILE | typeof CONFIG_FILE,
      path: string,
    ): Promise<void> => {
      const actual = await digestFile(path);
      const expected = record.manifest.files[name];
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        throw new Error(`backup file ${name} does not match manifest`);
      }
    };
    await verifyFile(DATABASE_FILE, databasePath);
    await verifyFile(EXPORT_FILE, exportPath);
    await verifyFile(CONFIG_FILE, configPath);

    const dump = parseQuestBackupExport(await readFile(exportPath, "utf8"));
    const inspection = await this.#backupDatabase.inspect(databasePath);
    requireIntegrityOk(inspection.integrity_check);
    if (inspection.schema_version !== record.manifest.store_schema_version) {
      throw new Error(
        `backup schema mismatch: manifest=${record.manifest.store_schema_version} actual=${inspection.schema_version}`,
      );
    }
    requireMatchingDump(inspection.dump, dump);
    requireEqualCounts(dumpCounts(inspection.dump), record.manifest.counts);

    const hashes = uniqueEvidenceHashes(dump);
    if (hashes.length !== record.manifest.evidence.count) {
      throw new Error(
        `backup evidence count mismatch: manifest=${record.manifest.evidence.count} actual=${hashes.length}`,
      );
    }
    let totalBytes = 0;
    for (const hash of hashes) {
      totalBytes += (await stat(join(root, EVIDENCE_DIRECTORY, hash))).size;
    }
    if (totalBytes !== record.manifest.evidence.total_bytes) {
      throw new Error(
        `backup evidence byte mismatch: manifest=${record.manifest.evidence.total_bytes} actual=${totalBytes}`,
      );
    }
    const sample = sampledEvidence(hashes);
    const hashesToVerify = evidenceVerification === "full" ? hashes : sample;
    for (const hash of hashesToVerify) {
      const digest = await digestFile(join(root, EVIDENCE_DIRECTORY, hash));
      if (digest.sha256 !== hash) {
        throw new Error(`backup evidence ${hash} failed its hash check`);
      }
    }

    return {
      dump,
      result: {
        snapshot: record.name,
        verified: true,
        full: evidenceVerification === "full",
        counts: record.manifest.counts,
        integrity_check: "ok",
        sampled_evidence: sample,
      },
    };
  }
}
