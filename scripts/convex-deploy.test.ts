import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deployConvex,
  generatedConvexVersionSource,
  resolveConvexDeployVersion,
} from "./convex-deploy";

test("requires a released semantic version for Convex deployment", () => {
  expect(resolveConvexDeployVersion("1.2.3")).toBe("1.2.3");
  expect(() => resolveConvexDeployVersion(undefined)).toThrow("QUEST_VERSION");
  expect(() => resolveConvexDeployVersion("0.0.0-dev")).toThrow("released semantic version");
  expect(() => resolveConvexDeployVersion("1.2.3-rc.1")).toThrow(
    "stable released semantic version",
  );
});

test("stamps the bundle for deploy and restores the source afterward", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-convex-deploy-"));
  const convexDirectory = join(directory, "convex");
  const versionPath = join(convexDirectory, "version.ts");
  const originalSource = 'export const deployedQuestVersion = "source";\n';
  await mkdir(convexDirectory, { recursive: true });
  await writeFile(versionPath, originalSource, "utf8");

  try {
    await expect(
      deployConvex({
        rootDirectory: directory,
        run: async (rootDirectory, arguments_) => {
          expect(rootDirectory).toBe(directory);
          expect(arguments_).toEqual(["--env-file", ".env.self-hosted"]);
          expect(await readFile(versionPath, "utf8")).toBe(generatedConvexVersionSource("1.2.3"));
          return 0;
        },
        version: "1.2.3",
        arguments: ["--env-file", ".env.self-hosted"],
      }),
    ).resolves.toBe(0);
    await expect(readFile(versionPath, "utf8")).resolves.toBe(originalSource);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
