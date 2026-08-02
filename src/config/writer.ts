import { randomUUID } from "node:crypto";
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "smol-toml";

import {
  configSchema,
  type RepoConfigEntry,
  repoConfigEntrySchema,
  type StoreConfig,
} from "../schema";
import { resolveRepositoryName, resolveRepositoryStore } from "./routing";

export class ConfigWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

export type ConvexDeploymentErrorCode =
  | "QUEST_INSECURE_CONVEX_DEPLOYMENT"
  | "QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED";

export class ConvexDeploymentError extends Error {
  readonly code: ConvexDeploymentErrorCode;

  constructor(code: ConvexDeploymentErrorCode, message: string) {
    super(message);
    this.name = "ConvexDeploymentError";
    this.code = code;
  }
}

const CONFIG_LOCK_TIMEOUT_MS = 5_000;
const CONFIG_LOCK_RETRY_MS = 25;
const CONFIG_LOCK_ATTEMPTS = 240;
const CONFIG_LOCK_DELAY_MS = 50;
const CONFIG_LOCK_HEARTBEAT_MS = 1_000;
const CONFIG_LOCK_RECLAIM_SUFFIX = ".reclaim";
const CONFIG_LOCK_OWNER_FILE = "owner";

type TomlTable = Record<string, unknown>;

export interface RepositoryRoutingSnapshot {
  readonly canonicalRepository: string;
  readonly detectedRepository: string;
  readonly repositoryEntry: RepoConfigEntry | undefined;
  readonly sourceStore: StoreConfig;
}

interface ConfigFileVersion {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface TomlFileSnapshot {
  readonly contents: string;
  readonly value: TomlTable;
  readonly version: ConfigFileVersion | undefined;
}

interface ConfigLockLease {
  readonly assertOwner: () => Promise<void>;
  readonly release: () => Promise<void>;
}

export function normalizeConvexDeployment(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
      if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
        throw new ConvexDeploymentError(
          "QUEST_INSECURE_CONVEX_DEPLOYMENT",
          "[QUEST_INSECURE_CONVEX_DEPLOYMENT] refusing plaintext HTTP for a remote Convex deployment; use an https:// URL, or use http://localhost, http://127.0.0.1, or http://[::1] only for local development. No credentials were sent.",
        );
      }
      const path = url.pathname.replace(/\/+$/u, "");
      return `${url.origin}${path}${url.search}${url.hash}`;
    }
    if (url.origin !== "null") {
      throw new ConvexDeploymentError(
        "QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED",
        "[QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED] deployment must be an https:// URL, a recognized local http:// URL, or a local deployment label such as dev:quest. No credentials were sent.",
      );
    }
  } catch (error: unknown) {
    if (error instanceof ConvexDeploymentError) {
      throw error;
    }
    // Convex local deployments can use labels such as dev:quest rather than URLs.
  }
  return trimmed.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is TomlTable {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function convexTable(config: Record<string, unknown>, configFile: string): Record<string, unknown> {
  const value = config["convex"];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ConfigWriteError(`config file ${configFile} has a non-table [convex] value`);
  }
  return value;
}

function deploymentTable(
  convex: Record<string, unknown>,
  deployment: string,
  configFile: string,
): Record<string, unknown> {
  const value = convex[deployment];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ConfigWriteError(
      `config file ${configFile} has a non-table [convex."${deployment}"] value`,
    );
  }
  return value;
}

function configStoreValue(store: StoreConfig): StoreConfig {
  if (store.backend === "sqlite") {
    return { backend: "sqlite" };
  }
  const deployment = store.deployment ?? store.convex_deployment;
  if (deployment === undefined) {
    throw new Error(
      "[MIGRATION_DEPLOYMENT_REQUIRED] a Convex routing block needs a deployment; pass --deployment <url> and retry",
    );
  }
  return { backend: "convex", deployment };
}

function repositoryEntryWithStore(
  entry: RepoConfigEntry | undefined,
  store: StoreConfig,
): RepoConfigEntry {
  if (typeof entry === "string") {
    throw new Error(
      "[CONFIG_ALIAS_ROUTE_CHANGED] repository aliases must resolve to their canonical repository before adding a store; retry with the canonical repository name",
    );
  }
  return { ...(entry ?? {}), store: configStoreValue(store) };
}

function tomlRepositoryEntryWithStore(entry: unknown, store: StoreConfig): TomlTable {
  if (typeof entry === "string") {
    throw new Error(
      "[CONFIG_ALIAS_ROUTE_CHANGED] repository aliases must resolve to their canonical repository before adding a store; retry with the canonical repository name",
    );
  }
  return { ...(isRecord(entry) ? entry : {}), store: configStoreValue(store) };
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function versionFromStats(stats: {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}): ConfigFileVersion {
  return {
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    mtimeNs: stats.mtimeNs,
    size: stats.size,
  };
}

function sameConfigFileVersion(left: ConfigFileVersion, right: ConfigFileVersion): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameConfigFileIdentity(left: ConfigFileVersion, right: ConfigFileVersion): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function configRouteChangedError(filePath: string): Error {
  return new Error(
    `[CONFIG_ROUTE_CHANGED] ${filePath} changed while migration was running; no route was overwritten, inspect config.toml and retry`,
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function tryAcquireConfigLock(
  lockFile: string,
  configFile: string,
): Promise<ConfigLockLease | null> {
  const ownerToken = randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockFile, "wx", 0o600);
    await handle.writeFile(`${ownerToken}\n`, "utf8");
    await handle.close();
    const stopHeartbeat = startConfigLockHeartbeat(lockFile);
    return {
      assertOwner: () => assertConfigLockOwner(lockFile, configFile, ownerToken),
      release: async () => {
        try {
          await releaseConfigLock(lockFile, ownerToken);
        } finally {
          stopHeartbeat();
        }
      },
    };
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    if (hasErrorCode(error, "EEXIST")) {
      return null;
    }
    if (handle !== undefined) {
      await releaseConfigLockIfOwned(lockFile, ownerToken);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigWriteError(`could not lock config file ${configFile}: ${detail}`);
  }
}

function startConfigLockHeartbeat(lockPath: string): () => void {
  const timer = setInterval(() => {
    void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
  }, CONFIG_LOCK_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

async function writeConfigLockOwner(lockPath: string, ownerToken: string): Promise<void> {
  await writeFile(join(lockPath, CONFIG_LOCK_OWNER_FILE), `${ownerToken}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function readConfigLockOwner(lockPath: string): Promise<string | undefined> {
  try {
    const metadata = await stat(lockPath);
    const ownerPath = metadata.isDirectory() ? join(lockPath, CONFIG_LOCK_OWNER_FILE) : lockPath;
    return (await readFile(ownerPath, "utf8")).trim();
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function assertConfigLockOwner(
  lockPath: string,
  configFile: string,
  ownerToken: string,
): Promise<void> {
  if ((await readConfigLockOwner(lockPath)) !== ownerToken) {
    throw new ConfigWriteError(
      `[CONFIG_LOCK_LOST] ownership of ${configFile} changed while writing; retry the update and inspect the resulting config first`,
    );
  }
}

async function releaseConfigLockIfOwned(lockPath: string, ownerToken: string): Promise<void> {
  try {
    if ((await readConfigLockOwner(lockPath)) === ownerToken) {
      await releaseConfigLock(lockPath, ownerToken);
    }
  } catch {
    // Leave an uncertain lock in place; deleting it could remove a successor's lock.
  }
}

async function releaseConfigLock(lockPath: string, ownerToken: string): Promise<void> {
  const releaseReclaimer = await acquireConfigLockReclaimer(lockPath);
  try {
    await releaseConfigLockPath(lockPath, ownerToken);
  } finally {
    await releaseReclaimer();
  }
}

async function releaseConfigLockPath(lockPath: string, ownerToken: string): Promise<void> {
  if ((await readConfigLockOwner(lockPath)) !== ownerToken) {
    throw new ConfigWriteError(
      `[CONFIG_LOCK_LOST] ownership of ${lockPath} changed while releasing; retry the update and inspect the resulting config first`,
    );
  }
  const claimedPath = `${lockPath}.release-${randomUUID()}`;
  try {
    await rename(lockPath, claimedPath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  await rm(claimedPath, { force: true, recursive: true });
}

async function acquireConfigLockReclaimer(lockFile: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const release = await tryAcquireConfigLockReclaimer(lockFile);
    if (release !== null) {
      return release;
    }
    await delay(CONFIG_LOCK_DELAY_MS);
  }
  throw new ConfigWriteError(
    `[CONFIG_LOCK_LOST] could not coordinate release of ${lockFile}; retry the update and inspect the resulting config first`,
  );
}

async function tryAcquireConfigLockReclaimer(
  lockFile: string,
): Promise<(() => Promise<void>) | null> {
  const reclaimPath = `${lockFile}${CONFIG_LOCK_RECLAIM_SUFFIX}`;
  const ownerToken = randomUUID();
  try {
    await mkdir(reclaimPath, { mode: 0o700 });
    await writeConfigLockOwner(reclaimPath, ownerToken);
    const stopHeartbeat = startConfigLockHeartbeat(reclaimPath);
    return async () => {
      try {
        await releaseConfigLockPath(reclaimPath, ownerToken);
      } finally {
        stopHeartbeat();
      }
    };
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) {
      await reclaimAbandonedConfigLockReclaimer(reclaimPath);
      return null;
    }
    await rm(reclaimPath, { force: true, recursive: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigWriteError(`could not coordinate config lock recovery ${lockFile}: ${detail}`);
  }
}

async function reclaimAbandonedConfigLockReclaimer(reclaimPath: string): Promise<void> {
  try {
    const metadata = await stat(reclaimPath);
    if (Date.now() - metadata.mtimeMs <= CONFIG_LOCK_TIMEOUT_MS * 2) {
      return;
    }
    const stalePath = `${reclaimPath}.stale-${randomUUID()}`;
    try {
      await rename(reclaimPath, stalePath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    await rm(stalePath, { force: true, recursive: true });
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigWriteError(
        `could not inspect config lock reclaimer ${reclaimPath}: ${detail}`,
      );
    }
  }
}

async function shouldReclaimConfigLock(lockFile: string): Promise<boolean> {
  const metadata = await stat(lockFile);
  if (Date.now() - metadata.mtimeMs <= CONFIG_LOCK_TIMEOUT_MS * 2) {
    return false;
  }
  return true;
}

async function reclaimConfigLock(lockFile: string): Promise<void> {
  if (!(await shouldReclaimConfigLock(lockFile))) {
    return;
  }
  const stalePath = `${lockFile}.stale-${randomUUID()}`;
  try {
    await rename(lockFile, stalePath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  await rm(stalePath, { force: true, recursive: true });
}

async function removeStaleConfigLock(lockFile: string): Promise<void> {
  const releaseReclaimer = await tryAcquireConfigLockReclaimer(lockFile);
  if (releaseReclaimer === null) {
    return;
  }
  try {
    await reclaimConfigLock(lockFile);
  } catch (error: unknown) {
    if (!hasErrorCode(error, "ENOENT")) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigWriteError(`could not inspect config lock ${lockFile}: ${detail}`);
    }
  } finally {
    await releaseReclaimer();
  }
}

async function acquireConfigLock(configFile: string): Promise<ConfigLockLease> {
  const lockFile = `${configFile}.lock`;
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const release = await tryAcquireConfigLock(lockFile, configFile);
    if (release !== null) {
      return release;
    }
    await removeStaleConfigLock(lockFile);
    await new Promise<void>((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS));
  }
  throw new ConfigWriteError(
    `config file ${configFile} is busy; retry after the other Quest process finishes`,
  );
}

export async function writeConvexToken(
  configFile: string,
  deployment: string,
  token: string,
): Promise<void> {
  const normalizedDeployment = normalizeConvexDeployment(deployment);
  const normalizedToken = token.trim();
  if (normalizedDeployment === "") {
    throw new ConfigWriteError("cannot write a Convex token without a deployment URL");
  }
  if (normalizedToken === "") {
    throw new ConfigWriteError("cannot write an empty Convex token");
  }

  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  const configLock = await acquireConfigLock(configFile);
  try {
    const fileSnapshot = await readTomlFileSnapshot(configFile);
    const config = fileSnapshot.value;
    const convex = convexTable(config, configFile);
    const current = deploymentTable(convex, normalizedDeployment, configFile);
    const updated = {
      ...config,
      convex: {
        ...convex,
        [normalizedDeployment]: { ...current, token: normalizedToken },
      },
    };
    try {
      await writeTomlFileIfCurrent(configFile, updated, fileSnapshot, configLock.assertOwner);
    } catch (error: unknown) {
      if (error instanceof ConfigWriteError) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConfigWriteError(`could not write Convex token to ${configFile}: ${detail}`);
    }
  } finally {
    await configLock.release();
  }
}

function repositoryEntriesMatch(actual: unknown, expected: RepoConfigEntry | undefined): boolean {
  if (expected === undefined) {
    return actual === undefined;
  }
  const parsedActual = repoConfigEntrySchema.safeParse(actual);
  return (
    stableSerialize(parsedActual.success ? parsedActual.data : actual) === stableSerialize(expected)
  );
}

function storeRoutesMatch(actual: StoreConfig, expected: StoreConfig): boolean {
  if (actual.backend !== expected.backend) {
    return false;
  }
  if (actual.backend === "sqlite") {
    return true;
  }
  return (
    (actual.deployment ?? actual.convex_deployment) ===
    (expected.deployment ?? expected.convex_deployment)
  );
}

function currentRepositoryRoute(
  config: TomlTable,
  detectedRepository: string,
): { readonly canonicalRepository: string; readonly store: StoreConfig } {
  const parsedConfig = configSchema.parse(config);
  return {
    canonicalRepository: resolveRepositoryName(parsedConfig, detectedRepository),
    store: resolveRepositoryStore(parsedConfig, detectedRepository),
  };
}

function resolveTomlRepositoryName(config: TomlTable, detectedRepository: string): string {
  const repos = isRecord(config["repos"]) ? config["repos"] : {};
  const visited = new Set<string>();
  let current = detectedRepository;
  while (true) {
    if (visited.has(current)) {
      throw new Error(
        `[CONFIG_ALIAS_CYCLE] repository alias cycle includes "${current}"; update [repos] so aliases eventually name a concrete repository`,
      );
    }
    visited.add(current);
    const entry = repos[current];
    if (typeof entry !== "string") {
      return current;
    }
    current = entry;
  }
}

function routingSnapshotMatches(config: TomlTable, snapshot: RepositoryRoutingSnapshot): boolean {
  const route = currentRepositoryRoute(config, snapshot.detectedRepository);
  const repos = isRecord(config["repos"]) ? config["repos"] : {};
  return (
    route.canonicalRepository === snapshot.canonicalRepository &&
    storeRoutesMatch(route.store, snapshot.sourceStore) &&
    repositoryEntriesMatch(repos[snapshot.canonicalRepository], snapshot.repositoryEntry)
  );
}

function repositoryEntryFromToml(
  config: TomlTable,
  canonicalRepository: string,
): RepoConfigEntry | undefined {
  const repos = isRecord(config["repos"]) ? config["repos"] : {};
  const value = repos[canonicalRepository];
  if (value === undefined) {
    return undefined;
  }
  const parsed = repoConfigEntrySchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[CONFIG_WRITE_FAILED] repository ${canonicalRepository} has an invalid routing entry; fix config.toml and retry`,
    );
  }
  return parsed.data;
}

async function readTomlFile(filePath: string): Promise<TomlTable> {
  try {
    const parsed: unknown = parse(await readFile(filePath, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("the config root must be a TOML table");
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not read ${filePath}: ${detail}`);
  }
}

async function readTomlFileSnapshot(filePath: string): Promise<TomlFileSnapshot> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { contents: "", value: {}, version: undefined };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not read ${filePath}: ${detail}`);
  }

  try {
    const contents = await handle.readFile("utf8");
    const version = versionFromStats(await handle.stat({ bigint: true }));
    const currentPathVersion = versionFromStats(await stat(filePath, { bigint: true }));
    if (!sameConfigFileVersion(version, currentPathVersion)) {
      throw configRouteChangedError(filePath);
    }
    const parsed: unknown = parse(contents);
    if (!isRecord(parsed)) {
      throw new Error("the config root must be a TOML table");
    }
    return { contents, value: parsed, version };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("[CONFIG_ROUTE_CHANGED]")) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not read ${filePath}: ${detail}`);
  } finally {
    await handle.close();
  }
}

async function writeTomlFile(
  filePath: string,
  value: TomlTable,
  assertOwner: () => Promise<void>,
): Promise<void> {
  const snapshot = await readTomlFileSnapshot(filePath);
  await writeTomlFileIfCurrent(filePath, value, snapshot, assertOwner);
}

async function writeTomlFileIfCurrent(
  filePath: string,
  value: TomlTable,
  snapshot: TomlFileSnapshot,
  assertOwner: () => Promise<void>,
): Promise<void> {
  const contents = `${stringify(value)}\n`;
  const temporaryPath = join(dirname(filePath), `.quest-config-${randomUUID()}.tmp`);
  const recoveryPath = `${filePath}.quest-migration-recovery`;
  try {
    await stageTomlFile(temporaryPath, contents);
    if (snapshot.version === undefined) {
      await assertOwner();
      await linkStagedTomlFile(temporaryPath, filePath);
      await syncContainingDirectory(filePath);
      return;
    }
    await verifyTomlFileStillCurrent(filePath, snapshot);
    await copyCurrentTomlFile(filePath, recoveryPath, snapshot);
    await assertOwner();
    try {
      await replaceTomlFile(temporaryPath, filePath, recoveryPath, snapshot, assertOwner);
    } catch (error: unknown) {
      await restoreCopiedTomlFile(filePath, recoveryPath);
      throw error;
    }
    await removePostCommitArtifact(recoveryPath, filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("[CONFIG_ROUTE_CHANGED]")) {
      throw error;
    }
    if (error instanceof ConfigWriteError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not update ${filePath}: ${detail}`);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function stageTomlFile(filePath: string, contents: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "wx");
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw configRouteChangedError(filePath);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not update ${filePath}: ${detail}`);
  } finally {
    await handle?.close();
  }
}

async function syncContainingDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const handle = await open(dirname(filePath), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removePostCommitArtifact(artifactPath: string, filePath: string): Promise<void> {
  try {
    await rm(artifactPath, { force: true });
    await syncContainingDirectory(filePath);
  } catch {
    // The replacement and its directory entry are already durable. A stale
    // artifact is safer than reporting the committed route as a failed write.
  }
}

async function verifyTomlFileStillCurrent(
  filePath: string,
  snapshot: TomlFileSnapshot,
): Promise<void> {
  if (snapshot.version === undefined) {
    throw configRouteChangedError(filePath);
  }
  const pathVersion = versionFromStats(await stat(filePath, { bigint: true }));
  if (
    !sameConfigFileVersion(pathVersion, snapshot.version) ||
    (await readFile(filePath, "utf8")) !== snapshot.contents
  ) {
    throw configRouteChangedError(filePath);
  }
}

async function copyCurrentTomlFile(
  filePath: string,
  recoveryPath: string,
  snapshot: TomlFileSnapshot,
): Promise<void> {
  await ensureRecoveryPathAbsent(recoveryPath);
  await copyTomlFileToRecovery(filePath, recoveryPath);
  await verifyCopiedTomlFile(filePath, recoveryPath, snapshot);
  await syncContainingDirectory(filePath);
}

async function ensureRecoveryPathAbsent(recoveryPath: string): Promise<void> {
  try {
    await stat(recoveryPath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    if (!hasErrorCode(error, "ENOENT")) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[CONFIG_WRITE_FAILED] could not inspect ${recoveryPath}: ${detail}`);
    }
  }
  throw new Error(
    `[CONFIG_ROUTE_CHANGED] an unfinished config update exists at ${recoveryPath}; recover it before retrying the migration`,
  );
}

async function copyTomlFileToRecovery(filePath: string, recoveryPath: string): Promise<void> {
  try {
    await link(filePath, recoveryPath);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[CONFIG_ROUTE_CHANGED] ${filePath} could not be snapshotted for the routing update: ${detail}; no route was overwritten, inspect config.toml and retry`,
    );
  }
}

async function verifyCopiedTomlFile(
  filePath: string,
  recoveryPath: string,
  snapshot: TomlFileSnapshot,
): Promise<void> {
  try {
    const movedVersion = versionFromStats(await stat(recoveryPath, { bigint: true }));
    const movedFileIsCurrent =
      snapshot.version !== undefined &&
      sameConfigFileIdentity(movedVersion, snapshot.version) &&
      (await readFile(recoveryPath, "utf8")) === snapshot.contents;
    if (movedFileIsCurrent) {
      return;
    }
    await restoreCopiedTomlFile(filePath, recoveryPath);
    throw configRouteChangedError(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("[CONFIG_ROUTE_CHANGED]")) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not verify ${filePath}: ${detail}`);
  }
}

async function linkStagedTomlFile(stagedPath: string, filePath: string): Promise<void> {
  try {
    await link(stagedPath, filePath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw configRouteChangedError(filePath);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[CONFIG_WRITE_FAILED] could not install ${filePath}: ${detail}`);
  }
}

async function tomlFileMatchesSnapshot(
  filePath: string,
  snapshot: TomlFileSnapshot,
): Promise<boolean> {
  if (snapshot.version === undefined) {
    return false;
  }
  const pathVersion = versionFromStats(await stat(filePath, { bigint: true }));
  return (
    sameConfigFileIdentity(pathVersion, snapshot.version) &&
    (await readFile(filePath, "utf8")) === snapshot.contents
  );
}

async function restoreClaimedTomlFile(claimedPath: string, filePath: string): Promise<void> {
  try {
    await link(claimedPath, filePath);
    await syncContainingDirectory(filePath);
    await removePostCommitArtifact(claimedPath, filePath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "EEXIST")) {
      return;
    }
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

async function replaceTomlFile(
  stagedPath: string,
  filePath: string,
  recoveryPath: string,
  snapshot: TomlFileSnapshot,
  assertOwner: () => Promise<void>,
): Promise<void> {
  const claimedPath = join(dirname(filePath), `.quest-config-claim-${randomUUID()}.tmp`);
  try {
    await assertOwner();
    await rename(filePath, claimedPath);
    await syncContainingDirectory(filePath);
    try {
      await assertOwner();
    } catch (error: unknown) {
      await restoreClaimedTomlFile(claimedPath, filePath);
      throw error;
    }
    if (!(await tomlFileMatchesSnapshot(claimedPath, snapshot))) {
      await restoreClaimedTomlFile(claimedPath, filePath);
      throw configRouteChangedError(filePath);
    }
    try {
      await link(stagedPath, filePath);
      await syncContainingDirectory(filePath);
    } catch (error: unknown) {
      if (hasErrorCode(error, "EEXIST")) {
        await rm(claimedPath, { force: true });
        throw configRouteChangedError(filePath);
      }
      throw error;
    }
    await removePostCommitArtifact(claimedPath, filePath);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("[CONFIG_ROUTE_CHANGED]")) {
      throw error;
    }
    if (error instanceof ConfigWriteError) {
      throw error;
    }
    await restoreClaimedTomlFile(claimedPath, filePath);
    await restoreCopiedTomlFile(filePath, recoveryPath);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[CONFIG_WRITE_FAILED] could not install ${filePath} without overwriting a concurrent change: ${detail}`,
    );
  }
}

async function restoreCopiedTomlFile(filePath: string, recoveryPath: string): Promise<void> {
  try {
    await link(recoveryPath, filePath);
    await syncContainingDirectory(filePath);
    await rm(recoveryPath, { force: true });
    await syncContainingDirectory(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

export async function withConfigLock<T>(
  configFile: string,
  action: (assertOwner: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lockPath = `${configFile}.lock`;
  await mkdir(dirname(configFile), { mode: 0o700, recursive: true });
  let acquired = false;
  let ownerToken = "";
  for (let attempt = 0; attempt < CONFIG_LOCK_ATTEMPTS; attempt += 1) {
    let lockCreated = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      lockCreated = true;
      ownerToken = randomUUID();
      await writeConfigLockOwner(lockPath, ownerToken);
      acquired = true;
      break;
    } catch (error: unknown) {
      if (lockCreated) {
        await releaseConfigLockIfOwned(lockPath, ownerToken);
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw new Error(
          `[CONFIG_WRITE_LOCKED] could not acquire ${lockPath}; retry after checking the config directory`,
        );
      }
      await removeStaleConfigLock(lockPath);
      await delay(CONFIG_LOCK_DELAY_MS);
    }
  }
  if (!acquired) {
    throw new Error(
      `[CONFIG_WRITE_LOCKED] another process is updating ${configFile}; retry after it finishes or remove the stale lock ${lockPath}`,
    );
  }
  const stopHeartbeat = startConfigLockHeartbeat(lockPath);
  try {
    return await action(() => assertConfigLockOwner(lockPath, configFile, ownerToken));
  } finally {
    try {
      await releaseConfigLock(lockPath, ownerToken);
    } finally {
      stopHeartbeat();
    }
  }
}

export async function readRepositoryRoutingSnapshot(
  configFile: string,
  detectedRepository: string,
): Promise<RepositoryRoutingSnapshot> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  const trimmedRepository = detectedRepository.trim();
  if (trimmedRepository === "") {
    throw new Error("[CONFIG_WRITE_FAILED] repository name must not be empty");
  }

  return withConfigLock(configFile, async () => {
    const snapshot = await readTomlFileSnapshot(configFile);
    try {
      const route = currentRepositoryRoute(snapshot.value, trimmedRepository);
      return {
        canonicalRepository: route.canonicalRepository,
        detectedRepository: trimmedRepository,
        repositoryEntry: repositoryEntryFromToml(snapshot.value, route.canonicalRepository),
        sourceStore: route.store,
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.startsWith("[CONFIG_WRITE_FAILED]")) {
        throw error;
      }
      throw new Error(
        `[CONFIG_ROUTE_CHANGED] routing for ${trimmedRepository} could not be read safely: ${detail}; inspect config.toml and retry`,
      );
    }
  });
}

export async function writeRepositoryStoreConfig(
  configFile: string,
  repository: string,
  store: StoreConfig,
): Promise<void> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  const trimmedRepository = repository.trim();
  if (trimmedRepository === "") {
    throw new Error("[CONFIG_WRITE_FAILED] repository name must not be empty");
  }

  await withConfigLock(configFile, async (assertOwner) => {
    const config = await readTomlFile(configFile);
    const canonicalRepository = resolveTomlRepositoryName(config, trimmedRepository);
    const reposKey = "repos";
    const currentRepos = isRecord(config[reposKey]) ? config[reposKey] : {};
    const currentValue = currentRepos[canonicalRepository];
    const repos = {
      ...currentRepos,
      [canonicalRepository]: tomlRepositoryEntryWithStore(currentValue, store),
    };
    await writeTomlFile(configFile, { ...config, repos }, assertOwner);
  });
}

export async function writeRepositoryStoreConfigIfUnchanged(
  configFile: string,
  store: StoreConfig,
  snapshot: RepositoryRoutingSnapshot,
): Promise<RepoConfigEntry> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  const trimmedRepository = snapshot.canonicalRepository.trim();
  if (trimmedRepository === "") {
    throw new Error("[CONFIG_WRITE_FAILED] repository name must not be empty");
  }

  await withConfigLock(configFile, async (assertOwner) => {
    const fileSnapshot = await readTomlFileSnapshot(configFile);
    const config = fileSnapshot.value;
    let matches = false;
    try {
      matches = routingSnapshotMatches(config, snapshot);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[CONFIG_ROUTE_CHANGED] routing for ${trimmedRepository} became invalid while migration was running: ${detail}; inspect config.toml and retry`,
      );
    }
    if (!matches) {
      throw new Error(
        `[CONFIG_ROUTE_CHANGED] routing for ${trimmedRepository} changed while migration was running; no route was overwritten, inspect config.toml and retry`,
      );
    }
    const currentRepos = isRecord(config["repos"]) ? config["repos"] : {};
    const repos = {
      ...currentRepos,
      [trimmedRepository]: repositoryEntryWithStore(snapshot.repositoryEntry, store),
    };
    await writeTomlFileIfCurrent(configFile, { ...config, repos }, fileSnapshot, assertOwner);
  });
  return repositoryEntryWithStore(snapshot.repositoryEntry, store);
}

export async function restoreRepositoryConfigEntry(
  configFile: string,
  repository: string,
  entry: RepoConfigEntry | undefined,
): Promise<void> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  const trimmedRepository = repository.trim();
  if (trimmedRepository === "") {
    throw new Error("[CONFIG_WRITE_FAILED] repository name must not be empty");
  }

  await withConfigLock(configFile, async (assertOwner) => {
    const config = await readTomlFile(configFile);
    const currentRepos = isRecord(config["repos"]) ? config["repos"] : {};
    const repos: TomlTable = { ...currentRepos };
    if (entry === undefined) {
      delete repos[trimmedRepository];
    } else if (typeof entry === "string") {
      repos[trimmedRepository] = entry;
    } else {
      repos[trimmedRepository] = { ...entry };
    }
    await writeTomlFile(configFile, { ...config, repos }, assertOwner);
  });
}

export async function restoreRepositoryConfigEntryIfUnchanged(
  configFile: string,
  repository: string,
  expectedCurrent: RepoConfigEntry | undefined,
  entry: RepoConfigEntry | undefined,
): Promise<boolean> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  const trimmedRepository = repository.trim();
  if (trimmedRepository === "") {
    throw new Error("[CONFIG_WRITE_FAILED] repository name must not be empty");
  }

  return withConfigLock(configFile, async (assertOwner) => {
    const fileSnapshot = await readTomlFileSnapshot(configFile);
    const config = fileSnapshot.value;
    const currentRepos = isRecord(config["repos"]) ? config["repos"] : {};
    if (!repositoryEntriesMatch(currentRepos[trimmedRepository], expectedCurrent)) {
      return false;
    }
    const repos: TomlTable = { ...currentRepos };
    if (entry === undefined) {
      delete repos[trimmedRepository];
    } else if (typeof entry === "string") {
      repos[trimmedRepository] = entry;
    } else {
      repos[trimmedRepository] = { ...entry };
    }
    await writeTomlFileIfCurrent(configFile, { ...config, repos }, fileSnapshot, assertOwner);
    return true;
  });
}

export async function verifyRepositoryStoreConfig(
  configFile: string,
  repository: string,
  expectedStore: StoreConfig,
): Promise<boolean> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  return withConfigLock(configFile, async () => {
    const config = await readTomlFile(configFile);
    const repos = config["repos"];
    if (!isRecord(repos)) {
      return false;
    }
    const repositoryConfig = repos[repository.trim()];
    if (!isRecord(repositoryConfig) || !isRecord(repositoryConfig["store"])) {
      return false;
    }
    return (
      stableSerialize(repositoryConfig["store"]) ===
      stableSerialize(configStoreValue(expectedStore))
    );
  });
}

export async function verifyRepositoryConfigEntry(
  configFile: string,
  repository: string,
  expected: RepoConfigEntry | undefined,
): Promise<boolean> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  return withConfigLock(configFile, async () => {
    const config = await readTomlFile(configFile);
    const repos = config["repos"];
    const actual = isRecord(repos) ? repos[repository.trim()] : undefined;
    return repositoryEntriesMatch(actual, expected);
  });
}

export async function verifyRepositoryRoute(
  configFile: string,
  snapshot: RepositoryRoutingSnapshot,
): Promise<boolean> {
  if (!isAbsolute(configFile)) {
    throw new Error(`[CONFIG_WRITE_FAILED] config path must be absolute: ${configFile}`);
  }
  return withConfigLock(configFile, async () => {
    const config = await readTomlFile(configFile);
    try {
      return routingSnapshotMatches(config, snapshot);
    } catch {
      return false;
    }
  });
}
