import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { artifactName, resolveDistVersion, selectDistTargets } from "./dist-config";

const rootDirectory = resolve(import.meta.dir, "..");
const checksumFileName = "checksums.txt";

export type DistributionVerificationScope = "full" | "targeted";

function missingEntries(entries: readonly string[], expected: readonly string[]): string[] {
  const entrySet = new Set(entries);
  return expected.filter((name) => !entrySet.has(name));
}

export function validateDistributionInventory(
  entries: readonly string[],
  expectedArtifacts: readonly string[],
  scope: DistributionVerificationScope,
): void {
  const expectedEntries = [...expectedArtifacts, checksumFileName];
  const missing = missingEntries(entries, expectedEntries);
  const expectedSet = new Set(expectedEntries);
  const unexpected = scope === "full" ? entries.filter((entry) => !expectedSet.has(entry)) : [];

  if (missing.length === 0 && unexpected.length === 0) {
    return;
  }

  const details = [
    missing.length > 0 ? `missing ${missing.join(", ")}` : undefined,
    unexpected.length > 0 ? `unexpected ${unexpected.join(", ")}` : undefined,
  ]
    .filter((detail): detail is string => detail !== undefined)
    .join("; ");
  const remedy =
    scope === "full"
      ? "rerun `make dist` with QUEST_TARGET unset"
      : "rerun the target build and verification with the same QUEST_TARGET value";
  throw new Error(
    `DIST_VERIFY_INCOMPLETE: ${scope === "full" ? "release" : "target"} verification requires the expected executable artifact set and checksums.txt; ${details}; ${remedy}`,
  );
}

async function distributionEntries(distDirectory: string): Promise<string[]> {
  try {
    return await readdir(distDirectory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `DIST_VERIFY_MISSING_DIRECTORY: expected ${distDirectory} with distribution artifacts and checksums.txt (${detail}); run make dist before verification`,
    );
  }
}

export async function verifyDistribution(projectRoot: string = rootDirectory): Promise<void> {
  const distDirectory = join(projectRoot, "dist");
  const {
    QUEST_RELEASE,
    QUEST_TARGET: environmentTarget,
    QUEST_VERSION: environmentVersion,
  } = process.env;
  const targetId = QUEST_RELEASE === "1" ? undefined : environmentTarget;
  const version = resolveDistVersion(environmentVersion);
  const targets = selectDistTargets(targetId);
  const scope: DistributionVerificationScope = targetId === undefined ? "full" : "targeted";
  const expectedArtifacts = targets.map((target) => artifactName(version, target));
  const entries = await distributionEntries(distDirectory);

  validateDistributionInventory(entries, expectedArtifacts, scope);

  const checksumText = await readFile(join(distDirectory, checksumFileName), "utf8");
  const checksumLines = new Set(checksumText.split(/\r?\n/u));
  const versionBytes = new TextEncoder().encode(version);

  for (const target of targets) {
    const name = artifactName(version, target);
    const bytes = new Uint8Array(await Bun.file(join(distDirectory, name)).arrayBuffer());

    if (bytes.byteLength === 0) {
      throw new Error(`DIST_VERIFY_EMPTY_ARTIFACT: ${name} is empty; rebuild it with make dist`);
    }
    if (!target.magic.every((byte, index) => bytes[index] === byte)) {
      throw new Error(
        `DIST_VERIFY_BAD_SIGNATURE: ${name} does not have the expected executable signature; rebuild it with make dist`,
      );
    }

    if (Buffer.from(bytes).indexOf(versionBytes) === -1) {
      throw new Error(
        `DIST_VERIFY_VERSION_MISSING: ${name} does not contain stamped version ${version}; rebuild with QUEST_VERSION=${version} make dist`,
      );
    }

    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (!checksumLines.has(`${checksum}  ${name}`)) {
      throw new Error(
        `DIST_VERIFY_CHECKSUM_MISMATCH: ${name} is not recorded with its SHA-256 in checksums.txt; rebuild with make dist`,
      );
    }
  }

  process.stdout.write(
    `Verified ${targets.length} distribution artifact(s) for quest ${version} (${scope})\n`,
  );
}

if (import.meta.main) {
  await verifyDistribution();
}
