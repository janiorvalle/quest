import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import {
  type DistributionTarget,
  distributionArtifactName,
  hostDistributionTarget,
} from "../distribution";
import type { ExecutableReplacementOutcome, ExecutableReplacer } from "../platform";

export const DEFAULT_UPGRADE_REPOSITORY = "janiorvalle/quest";

const repositorySchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/u);
const releasePayloadSchema = z.object({
  assets: z.array(
    z.object({
      browser_download_url: z.url(),
      name: z.string().trim().min(1),
      url: z.url(),
    }),
  ),
  html_url: z.url(),
  tag_name: z.string().trim().min(1),
});
const checksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export type UpgradeErrorCode =
  | "UPGRADE_ASSET_MISSING"
  | "UPGRADE_CHECKSUM_MISMATCH"
  | "UPGRADE_INSTALL_FAILED"
  | "UPGRADE_INVALID_RELEASE"
  | "UPGRADE_NETWORK"
  | "UPGRADE_NO_RELEASE"
  | "UPGRADE_UNSUPPORTED_TARGET";

export class UpgradeError extends Error {
  readonly code: UpgradeErrorCode;
  readonly retryable: boolean;

  constructor(code: UpgradeErrorCode, message: string, retryable: boolean) {
    super(`${code}: ${message}`);
    this.name = "UpgradeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface UpgradeHttpClient {
  readonly request: (url: string, init: RequestInit) => Promise<Response>;
}

export interface UpgradeFileSystem {
  readonly chmodExecutable: (path: string) => Promise<void>;
  readonly copyFile: (source: string, destination: string) => Promise<void>;
  readonly createDirectory: (path: string) => Promise<void>;
  readonly createTemporaryDirectory: (parent: string) => Promise<string>;
  readonly fileExists: (path: string) => Promise<boolean>;
  readonly listDirectory: (path: string) => Promise<readonly string[]>;
  readonly move: (source: string, destination: string) => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
  readonly writeFile: (path: string, contents: Uint8Array) => Promise<void>;
}

export interface ExecutableVersionReadOptions {
  readonly executablePath: string;
  readonly isolatedDataDirectory: string;
}

export type ExecutableVersionReader = (options: ExecutableVersionReadOptions) => Promise<string>;

export interface UpgradeLookupResult {
  readonly artifact: string;
  readonly artifact_url: string;
  readonly current_version: string;
  readonly latest_version: string;
  readonly release_url: string;
  readonly repository: string;
  readonly target: string;
  readonly update_available: boolean;
}

export interface UpgradeResult extends UpgradeLookupResult {
  readonly checksum: string | null;
  readonly installed: boolean;
  readonly skill_refresh_failures: readonly SkillRefreshFailure[];
  readonly skill_refreshes: readonly SkillRefreshReceipt[];
}

export interface SkillRefreshReceipt {
  readonly agent: string;
  readonly previous_version: string;
}

export interface SkillRefreshFailure {
  readonly agent: string;
  readonly message: string;
  readonly remedy: "quest skill install --force";
}

export interface SkillRefreshResult {
  readonly failures: readonly SkillRefreshFailure[];
  readonly refreshed: readonly SkillRefreshReceipt[];
}

export type InstalledSkillRefresher = (
  newExecutablePath: string,
  previousVersion: string,
) => Promise<SkillRefreshResult>;

export interface UpgradeOperations {
  readonly check: (currentVersion: string) => Promise<UpgradeLookupResult>;
  readonly install: (currentVersion: string) => Promise<UpgradeResult>;
}

export interface CreateUpgradeOperationsOptions {
  readonly architecture?: NodeJS.Architecture;
  readonly executablePath: string;
  readonly fileSystem?: UpgradeFileSystem;
  readonly httpClient?: UpgradeHttpClient;
  readonly platform?: NodeJS.Platform;
  readonly readExecutableVersion?: ExecutableVersionReader;
  readonly refreshInstalledSkills?: InstalledSkillRefresher;
  readonly replaceExecutable?: ExecutableReplacer;
  readonly repository?: string;
  readonly token?: string;
}

interface ReleaseAsset {
  readonly browserUrl: string;
  readonly name: string;
  readonly url: string;
}

interface LatestRelease {
  readonly artifact: ReleaseAsset;
  readonly checksums: ReleaseAsset;
  readonly releaseUrl: string;
  readonly repository: string;
  readonly target: DistributionTarget;
  readonly version: string;
}

interface ComparableVersion {
  readonly numbers: readonly number[];
  readonly prerelease: readonly string[];
}

function defaultHttpClient(token: string | undefined): UpgradeHttpClient {
  return {
    request: async (url, init) => {
      const headers = new Headers(init.headers);
      if (token !== undefined && token.trim() !== "") {
        headers.set("Authorization", `Bearer ${token}`);
      }
      let currentUrl = url;
      for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
        const response = await fetch(currentUrl, { ...init, headers, redirect: "manual" });
        if (response.status < 300 || response.status >= 400) {
          return response;
        }
        const location = response.headers.get("location");
        if (location === null) {
          return response;
        }
        const nextUrl = new URL(location, currentUrl).toString();
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
          headers.delete("Authorization");
        }
        currentUrl = nextUrl;
      }
      throw new Error("GitHub release download redirected too many times");
    },
  };
}

const defaultFileSystem: UpgradeFileSystem = {
  chmodExecutable: (path) => chmod(path, 0o755),
  copyFile: (source, destination) => copyFile(source, destination),
  createDirectory: async (path) => {
    await mkdir(path, { recursive: true });
  },
  createTemporaryDirectory: (parent) => mkdtemp(join(parent, ".quest-upgrade-")),
  fileExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  listDirectory: (path) => readdir(path),
  move: (source, destination) => rename(source, destination),
  removeDirectory: (path) => rm(path, { force: true, recursive: true }),
  removeFile: (path) => rm(path, { force: true }),
  writeFile: (path, contents) => writeFile(path, contents),
};

function isolatedVersionEnvironment(isolatedDataDirectory: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      const normalizedKey = key.toUpperCase();
      return (
        !normalizedKey.startsWith("QUEST_") &&
        normalizedKey !== "APPDATA" &&
        normalizedKey !== "HOME" &&
        normalizedKey !== "LOCALAPPDATA" &&
        normalizedKey !== "USERPROFILE"
      );
    }),
  );
  return {
    ...inherited,
    APPDATA: join(isolatedDataDirectory, "appdata"),
    HOME: isolatedDataDirectory,
    LOCALAPPDATA: join(isolatedDataDirectory, "localappdata"),
    USERPROFILE: isolatedDataDirectory,
  };
}

function defaultExecutableVersionReader(options: ExecutableVersionReadOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      options.executablePath,
      ["--version"],
      {
        cwd: options.isolatedDataDirectory,
        encoding: "utf8",
        env: isolatedVersionEnvironment(options.isolatedDataDirectory),
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedRepository(repository: string | undefined): string {
  const value = repository?.trim() || DEFAULT_UPGRADE_REPOSITORY;
  return repositorySchema.parse(value);
}

function githubLatestReleaseUrl(repository: string): string {
  const separator = repository.indexOf("/");
  const owner = repository.slice(0, separator);
  const name = repository.slice(separator + 1);
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`;
}

function releaseVersion(tag: string): string {
  const version = tag.replace(/^v/u, "");
  if (version === "") {
    throw new UpgradeError(
      "UPGRADE_INVALID_RELEASE",
      "the latest release tag has no version; publish a tag such as v0.8.1",
      false,
    );
  }
  return version;
}

function requireAsset(
  assets: readonly ReleaseAsset[],
  name: string,
  version: string,
): ReleaseAsset {
  const asset = assets.find((candidate) => candidate.name === name);
  if (asset === undefined) {
    throw new UpgradeError(
      "UPGRADE_ASSET_MISSING",
      `release ${version} does not publish ${name}; publish the five binaries and checksums.txt, then retry`,
      false,
    );
  }
  return asset;
}

async function latestRelease(
  options: CreateUpgradeOperationsOptions,
  repository: string,
): Promise<LatestRelease> {
  let target: DistributionTarget;
  try {
    target = hostDistributionTarget(options.platform, options.architecture);
  } catch (error) {
    throw new UpgradeError("UPGRADE_UNSUPPORTED_TARGET", errorDetail(error), false);
  }

  const client = options.httpClient ?? defaultHttpClient(options.token);
  const releaseResponse = await requestResource(
    client,
    githubLatestReleaseUrl(repository),
    "latest release metadata",
  );
  let payload: unknown;
  try {
    payload = await releaseResponse.json();
  } catch (error) {
    throw new UpgradeError(
      "UPGRADE_INVALID_RELEASE",
      `GitHub returned unreadable release metadata; publish a valid release and retry (${errorDetail(error)})`,
      false,
    );
  }

  const parsed = releasePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new UpgradeError(
      "UPGRADE_INVALID_RELEASE",
      `GitHub returned release metadata in an unexpected shape; publish a valid release and retry (${parsed.error.message})`,
      false,
    );
  }

  const version = releaseVersion(parsed.data.tag_name);
  const artifactName = distributionArtifactName(version, target);
  const assets = parsed.data.assets.map((asset) => ({
    browserUrl: asset.browser_download_url,
    name: asset.name,
    url: asset.url,
  }));
  return {
    artifact: requireAsset(assets, artifactName, version),
    checksums: requireAsset(assets, "checksums.txt", version),
    releaseUrl: parsed.data.html_url,
    repository,
    target,
    version,
  };
}

async function requestResource(
  client: UpgradeHttpClient,
  url: string,
  description: string,
  accept = "application/vnd.github+json",
): Promise<Response> {
  let response: Response;
  try {
    response = await client.request(url, {
      headers: {
        Accept: accept,
        "User-Agent": "quest-upgrade",
      },
    });
  } catch (error) {
    throw new UpgradeError(
      "UPGRADE_NETWORK",
      `could not fetch ${description}; check network access and retry (${errorDetail(error)})`,
      true,
    );
  }
  if (!response.ok) {
    const code = response.status === 404 ? "UPGRADE_NO_RELEASE" : "UPGRADE_NETWORK";
    const action =
      code === "UPGRADE_NO_RELEASE"
        ? "publish a GitHub release, or set QUEST_GITHUB_TOKEN for a private repository, then retry"
        : "check network access and retry";
    throw new UpgradeError(
      code,
      `could not fetch ${description} (HTTP ${response.status}); ${action}`,
      code !== "UPGRADE_NO_RELEASE",
    );
  }
  return response;
}

async function downloadAsset(client: UpgradeHttpClient, asset: ReleaseAsset): Promise<Uint8Array> {
  const response = await requestResource(client, asset.url, asset.name, "application/octet-stream");
  try {
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new UpgradeError(
      "UPGRADE_NETWORK",
      `could not read downloaded ${asset.name}; retry the upgrade (${errorDetail(error)})`,
      true,
    );
  }
}

function checksumForArtifact(checksumText: string, artifactName: string): string {
  for (const line of checksumText.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    const filename = fields[1]?.replace(/^\*/u, "");
    if (filename === artifactName && fields[0] !== undefined) {
      const checksum = checksumSchema.safeParse(fields[0].toLowerCase());
      if (checksum.success) {
        return checksum.data;
      }
    }
  }
  throw new UpgradeError(
    "UPGRADE_ASSET_MISSING",
    `checksums.txt has no valid entry for ${artifactName}; publish a checksum receipt, then retry`,
    false,
  );
}

function comparableVersion(version: string): ComparableVersion | undefined {
  const [baseAndPrerelease, build] = version.replace(/^v/u, "").split("+");
  if (build !== undefined && build === "") {
    return undefined;
  }
  const [base, prerelease = ""] = baseAndPrerelease?.split("-") ?? [];
  if (base === undefined || base === "") {
    return undefined;
  }
  const numberParts = base.split(".");
  if (numberParts.some((part) => !/^\d+$/u.test(part))) {
    return undefined;
  }
  const numbers = numberParts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isSafeInteger(part))) {
    return undefined;
  }
  return {
    numbers,
    prerelease: prerelease === "" ? [] : prerelease.split("."),
  };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return Math.sign(leftNumber - rightNumber);
  }
  if (leftNumber !== undefined) {
    return -1;
  }
  if (rightNumber !== undefined) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNumberSequences(left: readonly number[], right: readonly number[]): number {
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

function comparePrereleaseVersions(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length !== 0) {
    return 1;
  }
  if (left.length !== 0 && right.length === 0) {
    return -1;
  }
  const countOfIdentifiers = Math.max(left.length, right.length);
  for (let index = 0; index < countOfIdentifiers; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const difference = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function compareVersions(left: ComparableVersion, right: ComparableVersion): number {
  const numericDifference = compareNumberSequences(left.numbers, right.numbers);
  return numericDifference === 0
    ? comparePrereleaseVersions(left.prerelease, right.prerelease)
    : numericDifference;
}

function newerRelease(latest: string, current: string): boolean {
  if (latest === current) {
    return false;
  }
  const latestComparable = comparableVersion(latest);
  const currentComparable = comparableVersion(current);
  return latestComparable === undefined || currentComparable === undefined
    ? true
    : compareVersions(latestComparable, currentComparable) > 0;
}

function lookupResult(currentVersion: string, release: LatestRelease): UpgradeLookupResult {
  return {
    artifact: release.artifact.name,
    artifact_url: release.artifact.browserUrl,
    current_version: currentVersion,
    latest_version: release.version,
    release_url: release.releaseUrl,
    repository: release.repository,
    target: release.target.id,
    update_available: newerRelease(release.version, currentVersion),
  };
}

interface PreviousExecutable {
  readonly copied: boolean;
  readonly existed: boolean;
  readonly path: string;
}

async function backupExistingExecutable(
  fileSystem: UpgradeFileSystem,
  executablePath: string,
  temporaryDirectory: string,
): Promise<PreviousExecutable> {
  const path = join(temporaryDirectory, `.quest.previous${basename(executablePath)}`);
  if (!(await fileSystem.fileExists(executablePath))) {
    return { copied: false, existed: false, path };
  }
  await fileSystem.copyFile(executablePath, path);
  return { copied: true, existed: true, path };
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsRollbackPath(executablePath: string): string {
  return `${executablePath}.previous`;
}

async function removeStaleWindowsUpgradeArtifact(
  path: string,
  remove: () => Promise<void>,
  manualCommand: string,
): Promise<void> {
  try {
    await remove();
  } catch (error) {
    throw new UpgradeError(
      "UPGRADE_INSTALL_FAILED",
      `could not remove stale upgrade artifact ${path}; no binary was replaced and the artifact remains in the install directory. Exit every quest process, run this PowerShell command, then retry: ${manualCommand} (${errorDetail(error)})`,
      true,
    );
  }
}

async function cleanupStaleWindowsUpgradeArtifacts(
  fileSystem: UpgradeFileSystem,
  installDirectory: string,
  executablePath: string,
): Promise<void> {
  const staleDirectories = (await fileSystem.listDirectory(installDirectory)).filter((entry) =>
    entry.startsWith(".quest-upgrade-"),
  );
  for (const entry of staleDirectories) {
    const path = join(installDirectory, entry);
    await removeStaleWindowsUpgradeArtifact(
      path,
      () => fileSystem.removeDirectory(path),
      `Remove-Item -LiteralPath ${powerShellLiteral(path)} -Recurse -Force`,
    );
  }

  const rollbackPath = windowsRollbackPath(executablePath);
  if (await fileSystem.fileExists(rollbackPath)) {
    await removeStaleWindowsUpgradeArtifact(
      rollbackPath,
      () => fileSystem.removeFile(rollbackPath),
      `Remove-Item -LiteralPath ${powerShellLiteral(rollbackPath)} -Force`,
    );
  }
}

async function windowsPreviousExecutable(
  fileSystem: UpgradeFileSystem,
  executablePath: string,
): Promise<PreviousExecutable> {
  return {
    copied: false,
    existed: await fileSystem.fileExists(executablePath),
    path: windowsRollbackPath(executablePath),
  };
}

function previousExecutableForReplacement(options: {
  readonly executablePath: string;
  readonly fileSystem: UpgradeFileSystem;
  readonly platform: NodeJS.Platform;
  readonly temporaryDirectory: string;
}): Promise<PreviousExecutable> {
  return options.platform === "win32"
    ? windowsPreviousExecutable(options.fileSystem, options.executablePath)
    : backupExistingExecutable(
        options.fileSystem,
        options.executablePath,
        options.temporaryDirectory,
      );
}

async function verifyWindowsReplacement(options: {
  readonly executablePath: string;
  readonly expectedVersion: string;
  readonly isolatedDataDirectory: string;
  readonly previous: PreviousExecutable;
  readonly readExecutableVersion: ExecutableVersionReader;
}): Promise<void> {
  const rollbackCommand = `Move-Item -LiteralPath ${powerShellLiteral(options.previous.path)} -Destination ${powerShellLiteral(options.executablePath)} -Force`;
  let installedVersion: string;
  try {
    installedVersion = await options.readExecutableVersion({
      executablePath: options.executablePath,
      isolatedDataDirectory: options.isolatedDataDirectory,
    });
  } catch (error) {
    throw new UpgradeError(
      "UPGRADE_INSTALL_FAILED",
      `the new binary is at ${options.executablePath}, but running its --version check failed; the previous binary remains at ${options.previous.path}. Exit every quest process and roll back in PowerShell with: ${rollbackCommand} (${errorDetail(error)})`,
      true,
    );
  }
  const expectedOutput = `quest ${options.expectedVersion}`;
  if (installedVersion !== expectedOutput) {
    throw new UpgradeError(
      "UPGRADE_INSTALL_FAILED",
      `the new binary at ${options.executablePath} reported ${JSON.stringify(installedVersion)} from --version instead of ${JSON.stringify(expectedOutput)}; the previous binary remains at ${options.previous.path}. Exit every quest process and roll back in PowerShell with: ${rollbackCommand}`,
      false,
    );
  }
}

async function replaceByUnlinkingAndMoving(
  fileSystem: UpgradeFileSystem,
  replacement: Parameters<ExecutableReplacer>[0],
): Promise<ExecutableReplacementOutcome> {
  // Unlink first: replacing a running signed binary in place can invalidate macOS's signature cache.
  await fileSystem.removeFile(replacement.destination);
  await fileSystem.move(replacement.stagedExecutable, replacement.destination);
  return "replaced";
}

async function cleanupReplacement(
  fileSystem: UpgradeFileSystem,
  executablePath: string,
  stagedExecutable: string,
  temporaryDirectory: string,
  previous: PreviousExecutable,
  outcome: ExecutableReplacementOutcome | undefined,
  platform: NodeJS.Platform,
): Promise<void> {
  if (outcome === "scheduled") {
    return;
  }
  if (platform === "win32") {
    if (outcome !== "replaced") {
      return;
    }
    try {
      await fileSystem.removeDirectory(temporaryDirectory);
    } catch (error) {
      const command = `Remove-Item -LiteralPath ${powerShellLiteral(temporaryDirectory)} -Recurse -Force`;
      throw new UpgradeError(
        "UPGRADE_INSTALL_FAILED",
        `quest was replaced at ${executablePath}, and the rollback remains at ${previous.path}, but the staging directory ${temporaryDirectory} could not be removed. Run this PowerShell command to finish cleanup: ${command} (${errorDetail(error)})`,
        true,
      );
    }
    return;
  }
  if (outcome === "replaced" && previous.copied) {
    await fileSystem.removeFile(previous.path).catch(() => undefined);
  }
  if (outcome !== "replaced" && previous.copied) {
    await fileSystem.removeFile(executablePath).catch(() => undefined);
    await fileSystem.move(previous.path, executablePath).catch(() => undefined);
  }
  await fileSystem.removeFile(stagedExecutable).catch(() => undefined);
  await fileSystem.removeDirectory(temporaryDirectory).catch(() => undefined);
}

export async function replaceInstalledExecutable(options: {
  readonly artifact: Uint8Array;
  readonly executablePath: string;
  readonly fileSystem: UpgradeFileSystem;
  readonly expectedVersion: string;
  readonly platform: NodeJS.Platform;
  readonly readExecutableVersion: ExecutableVersionReader;
  readonly replaceExecutable?: ExecutableReplacer;
}): Promise<{
  readonly newExecutablePath: string;
  readonly outcome: ExecutableReplacementOutcome;
}> {
  const installDirectory = dirname(options.executablePath);
  let temporaryDirectory: string | undefined;
  let stagedExecutable: string | undefined;
  let previous: PreviousExecutable | undefined;
  let outcome: ExecutableReplacementOutcome | undefined;
  try {
    await options.fileSystem.createDirectory(installDirectory);
    if (options.platform === "win32") {
      await cleanupStaleWindowsUpgradeArtifacts(
        options.fileSystem,
        installDirectory,
        options.executablePath,
      );
    }
    temporaryDirectory = await options.fileSystem.createTemporaryDirectory(installDirectory);
    stagedExecutable = join(temporaryDirectory, basename(options.executablePath));
    await options.fileSystem.writeFile(stagedExecutable, options.artifact);
    await options.fileSystem.chmodExecutable(stagedExecutable);
    previous = await previousExecutableForReplacement({
      executablePath: options.executablePath,
      fileSystem: options.fileSystem,
      platform: options.platform,
      temporaryDirectory,
    });
    const replaceExecutable =
      options.replaceExecutable ??
      ((replacement) => replaceByUnlinkingAndMoving(options.fileSystem, replacement));
    outcome = await replaceExecutable({
      destination: options.executablePath,
      ...(previous.existed ? { previousExecutable: previous.path } : {}),
      stagedExecutable,
      temporaryDirectory,
    });
    if (options.platform === "win32" && outcome === "replaced") {
      await verifyWindowsReplacement({
        executablePath: options.executablePath,
        expectedVersion: options.expectedVersion,
        isolatedDataDirectory: temporaryDirectory,
        previous,
        readExecutableVersion: options.readExecutableVersion,
      });
    }
    return {
      // A deferred Windows swap leaves the downloaded binary staged until this process exits.
      newExecutablePath: outcome === "scheduled" ? stagedExecutable : options.executablePath,
      outcome,
    };
  } catch (error) {
    if (error instanceof UpgradeError) {
      throw error;
    }
    throw new UpgradeError(
      "UPGRADE_INSTALL_FAILED",
      `could not replace ${options.executablePath}; retry the upgrade or run the installer manually (${errorDetail(error)})`,
      true,
    );
  } finally {
    if (
      temporaryDirectory !== undefined &&
      stagedExecutable !== undefined &&
      previous !== undefined
    ) {
      await cleanupReplacement(
        options.fileSystem,
        options.executablePath,
        stagedExecutable,
        temporaryDirectory,
        previous,
        outcome,
        options.platform,
      );
    }
  }
}

export function createUpgradeOperations(
  options: CreateUpgradeOperationsOptions,
): UpgradeOperations {
  const repository = normalizedRepository(options.repository);
  const client = options.httpClient ?? defaultHttpClient(options.token);
  const fileSystem = options.fileSystem ?? defaultFileSystem;

  async function resolve(currentVersion: string): Promise<{
    readonly lookup: UpgradeLookupResult;
    readonly release: LatestRelease;
  }> {
    const release = await latestRelease(options, repository);
    return {
      lookup: lookupResult(currentVersion, release),
      release,
    };
  }

  return {
    check: async (currentVersion) => (await resolve(currentVersion)).lookup,
    install: async (currentVersion) => {
      const resolved = await resolve(currentVersion);
      if (!resolved.lookup.update_available) {
        return {
          ...resolved.lookup,
          checksum: null,
          installed: false,
          skill_refresh_failures: [],
          skill_refreshes: [],
        };
      }

      const artifact = await downloadAsset(client, resolved.release.artifact);
      const checksumText = new TextDecoder().decode(
        await downloadAsset(client, resolved.release.checksums),
      );
      const expectedChecksum = checksumForArtifact(checksumText, resolved.release.artifact.name);
      const actualChecksum = createHash("sha256").update(artifact).digest("hex");
      if (actualChecksum !== expectedChecksum) {
        throw new UpgradeError(
          "UPGRADE_CHECKSUM_MISMATCH",
          `checksum mismatch for ${resolved.release.artifact.name}; expected ${expectedChecksum}, received ${actualChecksum}; retry the upgrade`,
          true,
        );
      }

      const replacement = await replaceInstalledExecutable({
        artifact,
        executablePath: options.executablePath,
        expectedVersion: resolved.release.version,
        fileSystem,
        platform: options.platform ?? process.platform,
        readExecutableVersion: options.readExecutableVersion ?? defaultExecutableVersionReader,
        ...(options.replaceExecutable === undefined
          ? {}
          : { replaceExecutable: options.replaceExecutable }),
      });
      let skillRefresh: SkillRefreshResult = { failures: [], refreshed: [] };
      if (options.refreshInstalledSkills !== undefined) {
        try {
          skillRefresh = await options.refreshInstalledSkills(
            replacement.newExecutablePath,
            currentVersion,
          );
        } catch (error) {
          skillRefresh = {
            failures: [
              {
                agent: "Claude Code and Codex",
                message: errorDetail(error),
                remedy: "quest skill install --force",
              },
            ],
            refreshed: [],
          };
        }
      }
      return {
        ...resolved.lookup,
        checksum: actualChecksum,
        installed: true,
        skill_refresh_failures: skillRefresh.failures,
        skill_refreshes: skillRefresh.refreshed,
      };
    },
  };
}
