import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { type DistributionTarget, distributionTargets } from "../src/distribution";

const rootDirectory = resolve(import.meta.dir, "..");
const npmRegistryUrl = "https://registry.npmjs.org";
const npmRegistryHost = new URL(npmRegistryUrl).hostname;
const maximumRegistryRedirects = 3;
const corePackageName = "@opentui/core";

export type DistributionDependencyErrorCode =
  | "DIST_DEPS_ARCHIVE_INVALID"
  | "DIST_DEPS_CORE_MISSING"
  | "DIST_DEPS_HTTP"
  | "DIST_DEPS_INSTALL_FAILED"
  | "DIST_DEPS_INTEGRITY_MISMATCH"
  | "DIST_DEPS_LOCKFILE_INVALID"
  | "DIST_DEPS_PACKAGE_INVALID"
  | "DIST_DEPS_NETWORK";

export class DistributionDependencyError extends Error {
  readonly code: DistributionDependencyErrorCode;
  readonly retryable: boolean;

  constructor(code: DistributionDependencyErrorCode, message: string, retryable: boolean) {
    super(`${code}: ${message}`);
    this.name = "DistributionDependencyError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DistributionDependency {
  readonly packageName: string;
  readonly targetId: DistributionTarget["id"];
  readonly version: string;
  readonly versionUrl: string;
}

export interface DistributionDependencyResult {
  readonly downloadedPackages: readonly string[];
  readonly version: string;
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

interface RegistryManifest extends PackageMetadata {
  readonly integrity: string;
  readonly tarballUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageMetadata(value: unknown, source: string): PackageMetadata {
  const name = isRecord(value) ? value["name"] : undefined;
  const version = isRecord(value) ? value["version"] : undefined;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `${source} must contain string name and version fields; run bun install and retry`,
      false,
    );
  }

  return { name, version };
}

function parseJson(contents: string, source: string): unknown {
  try {
    return JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `${source} is not valid JSON (${detail}); run bun install and retry`,
      false,
    );
  }
}

function parseRegistryManifest(
  value: unknown,
  dependency: DistributionDependency,
): RegistryManifest {
  const metadata = packageMetadata(
    value,
    `npm metadata for ${dependency.packageName}@${dependency.version}`,
  );
  if (metadata.name !== dependency.packageName || metadata.version !== dependency.version) {
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `npm returned ${metadata.name}@${metadata.version}, expected ${dependency.packageName}@${dependency.version}; retry the request`,
      true,
    );
  }

  const dist = isRecord(value) ? value["dist"] : undefined;
  const tarball = isRecord(dist) ? dist["tarball"] : undefined;
  const integrity = isRecord(dist) ? dist["integrity"] : undefined;
  if (
    typeof tarball !== "string" ||
    typeof integrity !== "string" ||
    !isSha512Integrity(integrity)
  ) {
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `npm metadata for ${dependency.packageName}@${dependency.version} must include an HTTPS tarball and sha512 integrity; retry the request`,
      true,
    );
  }

  const tarballUrl = registryUrl(
    tarball,
    `npm tarball for ${dependency.packageName}@${dependency.version}`,
  );

  return { ...metadata, integrity, tarballUrl: tarballUrl.toString() };
}

function registryUrl(value: string, description: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `${description} is not a valid URL (${detail}); retry the request`,
      true,
    );
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== npmRegistryHost) {
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `${description} must use https://${npmRegistryHost}; do not follow registry metadata to another host`,
      false,
    );
  }

  return parsed;
}

function isSha512Integrity(value: string): boolean {
  return /^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

async function readLockfile(projectRoot: string): Promise<unknown> {
  const lockfilePath = join(projectRoot, "bun.lock");
  try {
    const contents = await readFile(lockfilePath, "utf8");
    const parsed: unknown = Bun.JSONC.parse(contents);
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_LOCKFILE_INVALID",
      `could not read ${lockfilePath} as a Bun lockfile (${detail}); run bun install --frozen-lockfile and retry`,
      false,
    );
  }
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function lockfileIntegrity(lockfile: unknown, dependency: DistributionDependency): string {
  const packages = isRecord(lockfile) ? lockfile["packages"] : undefined;
  const entry = isRecord(packages) ? packages[dependency.packageName] : undefined;
  const locator = isUnknownArray(entry) ? entry[0] : undefined;
  const integrity = isUnknownArray(entry) ? entry[3] : undefined;
  const expectedLocator = `${dependency.packageName}@${dependency.version}`;
  if (
    locator !== expectedLocator ||
    typeof integrity !== "string" ||
    !isSha512Integrity(integrity)
  ) {
    throw new DistributionDependencyError(
      "DIST_DEPS_LOCKFILE_INVALID",
      `bun.lock does not pin ${expectedLocator} with a sha512 integrity; run bun install --frozen-lockfile and retry`,
      false,
    );
  }

  return integrity;
}

function verifyManifestIntegrity(
  dependency: DistributionDependency,
  manifest: RegistryManifest,
  expectedIntegrity: string,
): void {
  if (manifest.integrity !== expectedIntegrity) {
    throw new DistributionDependencyError(
      "DIST_DEPS_INTEGRITY_MISMATCH",
      `npm metadata for ${dependency.packageName}@${dependency.version} has integrity ${manifest.integrity}, but bun.lock pins ${expectedIntegrity}; refresh the lockfile intentionally, then retry`,
      false,
    );
  }
}

function verifyTarballIntegrity(
  dependency: DistributionDependency,
  tarball: ArrayBuffer,
  expectedIntegrity: string,
): void {
  const actualIntegrity = `sha512-${createHash("sha512")
    .update(new Uint8Array(tarball))
    .digest("base64")}`;
  if (actualIntegrity !== expectedIntegrity) {
    throw new DistributionDependencyError(
      "DIST_DEPS_INTEGRITY_MISMATCH",
      `downloaded ${dependency.packageName}@${dependency.version} does not match bun.lock integrity ${expectedIntegrity}; retry the download`,
      true,
    );
  }
}

function packageDirectory(projectRoot: string, packageName: string): string {
  return join(projectRoot, "node_modules", "@opentui", packageName.slice("@opentui/".length));
}

function isExistingDestinationError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const code = error["code"];
  return code === "EEXIST" || code === "ENOTEMPTY";
}

async function fetchRegistryResponse(url: URL, description: string): Promise<Response> {
  try {
    return await fetch(url, { redirect: "manual" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_NETWORK",
      `could not fetch ${description} from ${url} (${detail}); retry when the npm registry is reachable`,
      true,
    );
  }
}

function redirectedRegistryUrl(
  response: Response,
  currentUrl: URL,
  description: string,
): URL | undefined {
  if (response.status < 300 || response.status >= 400) {
    return undefined;
  }

  const location = response.headers.get("location");
  if (location === null) {
    throw new DistributionDependencyError(
      "DIST_DEPS_HTTP",
      `npm redirected ${description} without a location; retry the request`,
      true,
    );
  }

  return registryUrl(new URL(location, currentUrl).toString(), description);
}

async function readPackageMetadataIfPresent(
  packageJsonPath: string,
): Promise<PackageMetadata | undefined> {
  const packageFile = Bun.file(packageJsonPath);
  if (!(await packageFile.exists())) {
    return undefined;
  }

  return packageMetadata(parseJson(await packageFile.text(), packageJsonPath), packageJsonPath);
}

async function requestRegistry(url: string, description: string): Promise<Response> {
  let requestUrl = registryUrl(url, description);
  for (let redirectCount = 0; redirectCount <= maximumRegistryRedirects; redirectCount += 1) {
    const response = await fetchRegistryResponse(requestUrl, description);
    const redirectUrl = redirectedRegistryUrl(response, requestUrl, description);
    if (redirectUrl !== undefined) {
      requestUrl = redirectUrl;
      continue;
    }

    if (!response.ok) {
      throw new DistributionDependencyError(
        "DIST_DEPS_HTTP",
        `npm returned HTTP ${response.status} for ${description}; retry the request${response.status === 404 ? " or check that the installed @opentui/core version is published" : ""}`,
        response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500,
      );
    }

    return response;
  }

  throw new DistributionDependencyError(
    "DIST_DEPS_HTTP",
    `npm redirected ${description} more than ${maximumRegistryRedirects} times; retry the request`,
    true,
  );
}

async function fetchManifest(dependency: DistributionDependency): Promise<RegistryManifest> {
  const manifestResponse = await requestRegistry(
    dependency.versionUrl,
    `${dependency.packageName}@${dependency.version} metadata`,
  );
  let manifestValue: unknown;
  try {
    manifestValue = await manifestResponse.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `npm returned invalid metadata for ${dependency.packageName}@${dependency.version} (${detail}); retry the request`,
      true,
    );
  }

  return parseRegistryManifest(manifestValue, dependency);
}

async function fetchTarball(
  dependency: DistributionDependency,
  manifest: RegistryManifest,
): Promise<ArrayBuffer> {
  const tarballResponse = await requestRegistry(
    manifest.tarballUrl,
    `${dependency.packageName}@${dependency.version} tarball`,
  );
  let tarball: ArrayBuffer;
  try {
    tarball = await tarballResponse.arrayBuffer();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_NETWORK",
      `could not read the ${dependency.packageName}@${dependency.version} tarball (${detail}); retry the request`,
      true,
    );
  }

  return tarball;
}

async function extractPackage(
  temporaryDirectory: string,
  dependency: DistributionDependency,
  tarball: ArrayBuffer,
): Promise<string> {
  let entryCount: number;
  try {
    entryCount = await new Bun.Archive(tarball).extract(temporaryDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_ARCHIVE_INVALID",
      `could not extract ${dependency.packageName}@${dependency.version} (${detail}); retry the download`,
      true,
    );
  }

  if (entryCount === 0) {
    throw new DistributionDependencyError(
      "DIST_DEPS_ARCHIVE_INVALID",
      `${dependency.packageName}@${dependency.version} tarball was empty; retry the download`,
      true,
    );
  }

  const extractedPackage = join(temporaryDirectory, "package");
  const extractedMetadata = await readPackageMetadataIfPresent(
    join(extractedPackage, "package.json"),
  );
  if (extractedMetadata === undefined) {
    throw new DistributionDependencyError(
      "DIST_DEPS_ARCHIVE_INVALID",
      `${dependency.packageName}@${dependency.version} tarball did not contain package/package.json; retry the download`,
      true,
    );
  }
  if (
    extractedMetadata.name !== dependency.packageName ||
    extractedMetadata.version !== dependency.version
  ) {
    throw new DistributionDependencyError(
      "DIST_DEPS_PACKAGE_INVALID",
      `downloaded package is ${extractedMetadata.name}@${extractedMetadata.version}, expected ${dependency.packageName}@${dependency.version}; retry the request`,
      true,
    );
  }

  return extractedPackage;
}

async function installDependency(
  projectRoot: string,
  dependency: DistributionDependency,
  expectedIntegrity: string,
): Promise<void> {
  const manifest = await fetchManifest(dependency);
  verifyManifestIntegrity(dependency, manifest, expectedIntegrity);
  const tarball = await fetchTarball(dependency, manifest);
  verifyTarballIntegrity(dependency, tarball, expectedIntegrity);
  const destination = packageDirectory(projectRoot, dependency.packageName);
  const temporaryDirectory = await mkdtemp(join(projectRoot, ".quest-dist-deps-"));
  try {
    const extractedPackage = await extractPackage(temporaryDirectory, dependency, tarball);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(extractedPackage, destination);
    } catch (error) {
      if (!isExistingDestinationError(error)) {
        throw error;
      }

      const installedMetadata = await readPackageMetadataIfPresent(
        join(destination, "package.json"),
      );
      if (
        installedMetadata?.name === dependency.packageName &&
        installedMetadata.version === dependency.version
      ) {
        return;
      }

      throw new DistributionDependencyError(
        "DIST_DEPS_PACKAGE_INVALID",
        `another preflight created ${destination}, but it is not ${dependency.packageName}@${dependency.version}; remove the incomplete package and retry`,
        false,
      );
    }
  } catch (error) {
    if (error instanceof DistributionDependencyError) {
      throw error;
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new DistributionDependencyError(
      "DIST_DEPS_INSTALL_FAILED",
      `could not install ${dependency.packageName}@${dependency.version} into ${destination} (${detail}); remove the incomplete package and retry`,
      true,
    );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

export function platformPackageName(target: DistributionTarget): string {
  return target.id === "windows-x64" ? "@opentui/core-win32-x64" : `@opentui/core-${target.id}`;
}

export function registryVersionUrl(packageName: string, version: string): string {
  return `${npmRegistryUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
}

export function distributionDependencies(version: string): readonly DistributionDependency[] {
  return distributionTargets.map((target) => {
    const packageName = platformPackageName(target);
    return {
      packageName,
      targetId: target.id,
      version,
      versionUrl: registryVersionUrl(packageName, version),
    };
  });
}

export async function ensureDistributionDependencies(
  projectRoot: string = rootDirectory,
): Promise<DistributionDependencyResult> {
  const corePackageJson = join(projectRoot, "node_modules", "@opentui", "core", "package.json");
  const coreMetadata = await readPackageMetadataIfPresent(corePackageJson);
  if (coreMetadata === undefined || coreMetadata.name !== corePackageName) {
    throw new DistributionDependencyError(
      "DIST_DEPS_CORE_MISSING",
      `expected installed ${corePackageName} at ${corePackageJson}; run bun install --frozen-lockfile, then retry`,
      false,
    );
  }

  const lockfile = await readLockfile(projectRoot);
  const downloadedPackages: string[] = [];
  for (const dependency of distributionDependencies(coreMetadata.version)) {
    const expectedIntegrity = lockfileIntegrity(lockfile, dependency);
    const packageJsonPath = join(
      packageDirectory(projectRoot, dependency.packageName),
      "package.json",
    );
    const installedMetadata = await readPackageMetadataIfPresent(packageJsonPath);
    if (installedMetadata !== undefined) {
      if (
        installedMetadata.name !== dependency.packageName ||
        installedMetadata.version !== dependency.version
      ) {
        throw new DistributionDependencyError(
          "DIST_DEPS_PACKAGE_INVALID",
          `found ${installedMetadata.name}@${installedMetadata.version} at ${packageJsonPath}, expected ${dependency.packageName}@${dependency.version}; remove it or run bun install, then retry`,
          false,
        );
      }
      continue;
    }

    await installDependency(projectRoot, dependency, expectedIntegrity);
    downloadedPackages.push(dependency.packageName);
  }

  return { downloadedPackages, version: coreMetadata.version };
}

if (import.meta.main) {
  const result = await ensureDistributionDependencies();
  const downloaded =
    result.downloadedPackages.length === 0
      ? "no downloads needed"
      : `downloaded ${result.downloadedPackages.join(", ")}`;
  process.stdout.write(
    `Distribution dependencies ready for @opentui/core ${result.version}; ${downloaded}\n`,
  );
}
