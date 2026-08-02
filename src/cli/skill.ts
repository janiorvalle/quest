import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { type Command, Option } from "commander";
import { z } from "zod";

import { type CliOutputBoundary, EXIT_SUCCESS, type ExitCode, formatQuestReport } from "../output";
import { questReportSchema } from "../schema";
import type { CliFormat } from "./scope";
import { bundledSkillFiles, bundledSkillMarkdown } from "./skill-assets";

const nonEmptyTextSchema = z.string().trim().min(1);
const installDataSchema = z.strictObject({
  codex_directory: nonEmptyTextSchema,
  claude_directory: nonEmptyTextSchema,
  written: z.array(nonEmptyTextSchema),
});

const CLAUDE_DIRECTORY_ENVIRONMENT = "QUEST_CLAUDE_SKILL_DIR";
const CODEX_DIRECTORY_ENVIRONMENT = "QUEST_CODEX_SKILL_DIR";
const CODEX_HOME_ENVIRONMENT = "CODEX_HOME";
const HOME_ENVIRONMENT_NAMES = ["HOME", "USERPROFILE"] as const;

export const QUEST_SKILL_INSTALL_SUGGESTION =
  "Quest agent skill not detected; run `quest skill install` to install it for Claude Code and Codex.";

export type SkillCliRequest =
  | {
      readonly claudeDirectory?: string | undefined;
      readonly codexDirectory?: string | undefined;
      readonly command: "skill-install";
      readonly force: boolean;
      readonly stdout: boolean;
    }
  | {
      readonly command: "skill-show";
    };

export interface SkillRequestCapture {
  set(request: SkillCliRequest): void;
}

export interface ExecuteSkillCliOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly format: CliFormat;
  readonly output: CliOutputBoundary;
  readonly request: SkillCliRequest;
}

export class SkillCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCliUsageError";
  }
}

export class SkillCliConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCliConflictError";
  }
}

interface SkillDirectories {
  readonly claude: string;
  readonly codex: string;
}

interface SkillDirectoryOptions {
  readonly claudeDirectory?: string | undefined;
  readonly codexDirectory?: string | undefined;
}

interface PreferredDirectoryBase {
  readonly environmentName: string;
  readonly segments: readonly string[];
}

interface PlannedSkillFile {
  readonly content: string;
  readonly destination: string;
  readonly write: boolean;
}

function optionalPath(command: Command, name: string): string | undefined {
  const value = command.getOptionValue(name);
  return value === undefined ? undefined : nonEmptyTextSchema.parse(value);
}

export function registerSkillCommands(program: Command, capture: SkillRequestCapture): void {
  const skill = program.command("skill").description("install or inspect the bundled agent skill");
  skill
    .command("install")
    .description("install the Quest skill for Claude Code and Codex")
    .addOption(new Option("--force", "replace different existing skill files"))
    .addOption(new Option("--stdout", "print SKILL.md instead of installing files"))
    .addOption(new Option("--claude-dir <path>", "override the Claude Code skill directory"))
    .addOption(new Option("--codex-dir <path>", "override the Codex skill directory"))
    .action(function (this: Command) {
      capture.set({
        command: "skill-install",
        ...(optionalPath(this, "claudeDir") === undefined
          ? {}
          : { claudeDirectory: optionalPath(this, "claudeDir") }),
        ...(optionalPath(this, "codexDir") === undefined
          ? {}
          : { codexDirectory: optionalPath(this, "codexDir") }),
        force: this.getOptionValue("force") === true,
        stdout: this.getOptionValue("stdout") === true,
      });
    });
  skill
    .command("show")
    .description("print the bundled SKILL.md")
    .action(() => capture.set({ command: "skill-show" }));
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function resolveDirectory(
  directory: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  environmentName: string,
  defaultSegments: readonly string[],
  preferredBase?: PreferredDirectoryBase,
): string | undefined {
  const configured = directory ?? environmentValue(environment, environmentName);
  if (configured !== undefined) {
    return resolve(configured);
  }

  if (preferredBase !== undefined) {
    const preferredRoot = environmentValue(environment, preferredBase.environmentName);
    if (preferredRoot !== undefined) {
      return resolve(join(preferredRoot, ...preferredBase.segments));
    }
  }

  const home = HOME_ENVIRONMENT_NAMES.map((name) => environmentValue(environment, name)).find(
    (value) => value !== undefined,
  );
  return home === undefined ? undefined : resolve(join(home, ...defaultSegments));
}

function resolveInstallDirectories(
  environment: Readonly<Record<string, string | undefined>>,
  options: SkillDirectoryOptions = {},
): SkillDirectories {
  const claude = resolveDirectory(
    options.claudeDirectory,
    environment,
    CLAUDE_DIRECTORY_ENVIRONMENT,
    [".claude", "skills", "quest"],
  );
  const codex = resolveDirectory(
    options.codexDirectory,
    environment,
    CODEX_DIRECTORY_ENVIRONMENT,
    [".codex", "skills", "quest"],
    { environmentName: CODEX_HOME_ENVIRONMENT, segments: ["skills", "quest"] },
  );
  if (claude === undefined || codex === undefined) {
    throw new SkillCliUsageError(
      "[QUEST_SKILL_HOME_REQUIRED] HOME or USERPROFILE is not set; set one, or pass both --claude-dir <path> and --codex-dir <path>, then retry",
    );
  }
  return { claude, codex };
}

function skillFilePath(directory: string, relativePath: string): string {
  return join(directory, relativePath);
}

async function existingFileBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) {
      throw new SkillCliConflictError(
        `[QUEST_SKILL_PATH_UNSAFE] ${path} exists but is not a regular file; remove it manually before retrying`,
      );
    }
    return new Uint8Array(await readFile(path));
  } catch (error: unknown) {
    if (error instanceof SkillCliConflictError) {
      throw error;
    }
    if (isMissingPathError(error)) {
      return undefined;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SkillCliUsageError(
      `[QUEST_SKILL_READ_FAILED] could not inspect ${path}: ${detail}; fix its permissions and retry`,
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

function skillConflict(path: string): SkillCliConflictError {
  return new SkillCliConflictError(
    `[QUEST_SKILL_CONFLICT] ${path} contains a different Quest skill version; rerun \`quest skill install --force\` to replace it`,
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function validateDestinationParent(destination: string, directory: string): Promise<void> {
  const relativeParent = destination.slice(directory.length).replace(/^[/\\]/u, "");
  const segments = relativeParent.split(/[/\\]/u).slice(0, -1);
  let current = directory;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new SkillCliConflictError(
          `[QUEST_SKILL_PATH_UNSAFE] ${current} is not a real directory inside ${directory}; remove the path or choose a different destination before retrying`,
        );
      }
    } catch (error: unknown) {
      if (error instanceof SkillCliConflictError) {
        throw error;
      }
      if (isMissingPathError(error)) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new SkillCliUsageError(
        `[QUEST_SKILL_READ_FAILED] could not inspect ${current}: ${detail}; fix its permissions and retry`,
      );
    }
  }
}

async function validateWritableParent(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new SkillCliConflictError(
        `[QUEST_SKILL_PATH_UNSAFE] ${path} is not a real directory; remove the path or choose a different destination before retrying`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof SkillCliConflictError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SkillCliUsageError(
      `[QUEST_SKILL_WRITE_FAILED] could not inspect ${path}: ${detail}; fix its permissions and retry`,
    );
  }
}

async function planSkillDirectory(directory: string, force: boolean): Promise<PlannedSkillFile[]> {
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory()) {
      throw new SkillCliUsageError(
        `[QUEST_SKILL_DIRECTORY_UNSAFE] ${directory} exists but is not a directory; pass a different directory or remove it manually`,
      );
    }
  } catch (error: unknown) {
    if (error instanceof SkillCliUsageError) {
      throw error;
    }
    if (!isMissingPathError(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SkillCliUsageError(
        `[QUEST_SKILL_DIRECTORY_READ_FAILED] could not inspect ${directory}: ${detail}; fix its permissions and retry`,
      );
    }
  }

  const plan: PlannedSkillFile[] = [];
  for (const file of bundledSkillFiles) {
    const destination = skillFilePath(directory, file.relativePath);
    await validateDestinationParent(destination, directory);
    const current = await existingFileBytes(destination);
    const expected = new TextEncoder().encode(file.content);
    if (current !== undefined && !bytesEqual(current, expected) && !force) {
      throw skillConflict(destination);
    }
    plan.push({
      content: file.content,
      destination,
      write: current === undefined || !bytesEqual(current, expected),
    });
  }
  return plan;
}

async function replaceSkillFile(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.quest-skill-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SkillCliUsageError(
      `[QUEST_SKILL_WRITE_FAILED] could not replace ${path}: ${detail}; fix its permissions and retry`,
    );
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function createMissingSkillFile(plan: PlannedSkillFile): Promise<boolean> {
  try {
    await writeFile(plan.destination, plan.content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (!isAlreadyExistsError(error)) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SkillCliUsageError(
        `[QUEST_SKILL_WRITE_FAILED] could not create ${plan.destination}: ${detail}; fix its permissions and retry`,
      );
    }
    const current = await existingFileBytes(plan.destination);
    if (current !== undefined && bytesEqual(current, new TextEncoder().encode(plan.content))) {
      return false;
    }
    if (current === undefined) {
      throw new SkillCliUsageError(
        `[QUEST_SKILL_WRITE_RACE] ${plan.destination} changed while installing; retry the same command`,
      );
    }
    throw skillConflict(plan.destination);
  }
}

async function writePlannedSkillFile(plan: PlannedSkillFile, force: boolean): Promise<boolean> {
  await mkdir(dirname(plan.destination), { recursive: true });
  await validateWritableParent(dirname(plan.destination));
  if (!force) {
    return createMissingSkillFile(plan);
  }
  await replaceSkillFile(plan.destination, plan.content);
  return true;
}

async function writeSkillFiles(directories: SkillDirectories, force: boolean): Promise<string[]> {
  const plans = await Promise.all([
    planSkillDirectory(directories.claude, force),
    planSkillDirectory(directories.codex, force),
  ]);
  const written: string[] = [];
  for (const plan of plans.flat()) {
    if (!plan.write) {
      continue;
    }
    if (await writePlannedSkillFile(plan, force)) {
      written.push(plan.destination);
    }
  }
  return written;
}

function installReport(
  options: ExecuteSkillCliOptions,
  directories: SkillDirectories,
  written: readonly string[],
): void {
  options.output.write(
    formatQuestReport(
      questReportSchema.parse({
        schema: "quest.report/v1",
        command: "skill install",
        generated_at: new Date().toISOString(),
        filters: {},
        warnings: [],
        data: installDataSchema.parse({
          claude_directory: directories.claude,
          codex_directory: directories.codex,
          written,
        }),
      }),
    ),
  );
}

export async function executeSkillCli(options: ExecuteSkillCliOptions): Promise<ExitCode> {
  if (options.request.command === "skill-show" || options.request.stdout) {
    options.output.write(bundledSkillMarkdown);
    return EXIT_SUCCESS;
  }

  const directories = resolveInstallDirectories(options.environment, options.request);
  const written = await writeSkillFiles(directories, options.request.force);
  if (options.format === "json") {
    installReport(options, directories, written);
    return EXIT_SUCCESS;
  }
  for (const path of written) {
    options.output.write(`Wrote ${path}\n`);
  }
  return EXIT_SUCCESS;
}

function skillDirectoryCandidates(
  environment: Readonly<Record<string, string | undefined>>,
): string[] | undefined {
  const claude = resolveDirectory(undefined, environment, CLAUDE_DIRECTORY_ENVIRONMENT, [
    ".claude",
    "skills",
    "quest",
  ]);
  const codex = resolveDirectory(
    undefined,
    environment,
    CODEX_DIRECTORY_ENVIRONMENT,
    [".codex", "skills", "quest"],
    { environmentName: CODEX_HOME_ENVIRONMENT, segments: ["skills", "quest"] },
  );
  const directories = [claude, codex].filter(
    (directory): directory is string => directory !== undefined,
  );
  return directories.length === 0 ? undefined : directories;
}

export async function hasQuestSkillInstalled(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<boolean | undefined> {
  const directories = skillDirectoryCandidates(environment);
  if (directories === undefined) {
    return undefined;
  }
  for (const directory of directories) {
    try {
      const metadata = await lstat(skillFilePath(directory, "SKILL.md"));
      if (metadata.isFile()) {
        return true;
      }
    } catch {}
  }
  return false;
}

export function isSkillCliRequest(
  request: SkillCliRequest | { readonly command: string },
): request is SkillCliRequest {
  return request.command === "skill-install" || request.command === "skill-show";
}
