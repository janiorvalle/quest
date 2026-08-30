import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { isStableQuestVersion } from "../src/store/convex/protocol";
import { generatedConvexVersionSource } from "./version-stamp";

export { generatedConvexVersionSource } from "./version-stamp";

const rootDirectory = resolve(import.meta.dir, "..");
const versionFileName = join("convex", "version.ts");

export function resolveConvexDeployVersion(version: string | undefined): string {
  if (version === undefined || !isStableQuestVersion(version)) {
    throw new Error(
      "QUEST_VERSION must be a stable released semantic version such as 1.2.3; set it before deploying Convex",
    );
  }
  return version;
}

type ConvexDeployChild = {
  readonly kill: (signal?: NodeJS.Signals | number) => void;
};

export type ConvexDeployRunner = (
  rootDirectory: string,
  arguments_: readonly string[],
  registerChild?: (child: ConvexDeployChild | undefined) => void,
) => Promise<number>;

type TerminationSignal = "SIGINT" | "SIGTERM";

async function runConvexDeploy(
  directory: string,
  arguments_: readonly string[],
  registerChild?: (child: ConvexDeployChild | undefined) => void,
): Promise<number> {
  const child = Bun.spawn({
    cmd: [process.execPath, "x", "convex", "deploy", ...arguments_],
    cwd: directory,
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  registerChild?.(child);
  try {
    return await child.exited;
  } finally {
    registerChild?.(undefined);
  }
}

export async function deployConvex(options: {
  readonly arguments?: readonly string[];
  readonly rootDirectory: string;
  readonly run?: ConvexDeployRunner;
  readonly version: string;
}): Promise<number> {
  const version = resolveConvexDeployVersion(options.version);
  const versionPath = join(options.rootDirectory, versionFileName);
  const originalSource = await readFile(versionPath, "utf8");
  let terminationSignal: TerminationSignal | undefined;
  let activeChild: ConvexDeployChild | undefined;
  const registerChild = (child: ConvexDeployChild | undefined): void => {
    activeChild = child;
    if (child !== undefined && terminationSignal !== undefined) {
      child.kill(terminationSignal);
    }
  };
  const rememberTerminationSignal = (signal: TerminationSignal): void => {
    terminationSignal ??= signal;
    activeChild?.kill(signal);
  };
  process.on("SIGINT", rememberTerminationSignal);
  process.on("SIGTERM", rememberTerminationSignal);
  try {
    await writeFile(versionPath, generatedConvexVersionSource(version), "utf8");
    return await (options.run ?? runConvexDeploy)(
      options.rootDirectory,
      options.arguments ?? [],
      registerChild,
    );
  } finally {
    try {
      await writeFile(versionPath, originalSource, "utf8");
    } finally {
      process.off("SIGINT", rememberTerminationSignal);
      process.off("SIGTERM", rememberTerminationSignal);
    }
    if (terminationSignal !== undefined) {
      process.kill(process.pid, terminationSignal);
    }
  }
}

if (import.meta.main) {
  process.exitCode = await deployConvex({
    arguments: process.argv.slice(2),
    rootDirectory,
    version: resolveConvexDeployVersion(process.env["QUEST_VERSION"]),
  });
}
