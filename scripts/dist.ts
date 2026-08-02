import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { artifactName, resolveDistVersion, selectDistTargets } from "./dist-config";
import { ensureDistributionDependencies } from "./dist-deps";
import { buildStandaloneExecutable } from "./standalone-build";

const rootDirectory = resolve(import.meta.dir, "..");
const distDirectory = join(rootDirectory, "dist");
const entrypoint = join(rootDirectory, "src", "entrypoint.ts");
const requiredAssets = [
  join(rootDirectory, ".agents", "skills", "quest", "SKILL.md"),
  join(rootDirectory, ".agents", "skills", "quest", "agents", "openai.yaml"),
] as const;
const {
  QUEST_RELEASE,
  QUEST_TARGET: environmentTarget,
  QUEST_VERSION: environmentVersion,
} = process.env;
const targetId = QUEST_RELEASE === "1" ? undefined : environmentTarget;
const version = resolveDistVersion(environmentVersion);
const targets = selectDistTargets(targetId);

await ensureDistributionDependencies(rootDirectory);

await rm(distDirectory, { force: true, recursive: true });
await mkdir(distDirectory, { recursive: true });

const checksumLines: string[] = [];

for (const target of targets) {
  const name = artifactName(version, target);
  const outputPath = join(distDirectory, name);
  await buildStandaloneExecutable({
    define: {
      __QUEST_VERSION__: JSON.stringify(version),
    },
    entrypoint,
    outfile: outputPath,
    requiredAssets,
    target: target.bunTarget,
  });

  if (target.executableSuffix === "") {
    await chmod(outputPath, 0o755);
  }

  const bytes = await Bun.file(outputPath).arrayBuffer();
  const checksum = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  checksumLines.push(`${checksum}  ${name}`);
}

await writeFile(join(distDirectory, "checksums.txt"), `${checksumLines.join("\n")}\n`, "utf8");
process.stdout.write(
  `Built quest ${version} for ${targets.map((target) => target.id).join(", ")}\n`,
);
