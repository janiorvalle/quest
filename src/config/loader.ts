import { link, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "smol-toml";

import type { PlatformModule } from "../platform";
import {
  type Config,
  type ConvexTokenConfig,
  configSchema,
  type QuestStatus,
  type RepoConfigEntry,
} from "../schema";
import { withConfigLock } from "./writer";

const CONFIG_FILE_NAME = "config.toml";
const CONFIG_RECOVERY_SUFFIX = ".quest-migration-recovery";
const MISSING_CONFIG_FILE = Symbol("missing-config-file");

export interface ConfigOverrides {
  readonly identity?: string;
  readonly guild?: string;
  readonly convex?: Readonly<Record<string, ConvexTokenConfig>>;
  readonly repos?: Readonly<Record<string, RepoConfigEntry>>;
  readonly areas?: Readonly<Record<string, readonly string[]>>;
  readonly colors?: Readonly<Partial<Record<QuestStatus, string>>>;
  readonly backupRoot?: string;
}

export type ConfigFileReader = (filePath: string) => Promise<string>;

export interface QuestEnvironment extends Readonly<Record<string, string | undefined>> {
  readonly QUEST_IDENTITY?: string;
  readonly QUEST_GUILD?: string;
  readonly QUEST_CONVEX_TOKEN?: string;
  readonly QUEST_ADMIN_SECRET?: string;
  readonly QUEST_REPOS?: string;
  readonly QUEST_AREAS?: string;
  readonly QUEST_COLORS?: string;
  readonly QUEST_BACKUP_ROOT?: string;
}

export interface LoadConfigOptions {
  readonly platform: Pick<PlatformModule, "directories">;
  readonly flags?: ConfigOverrides;
  readonly environment?: QuestEnvironment;
  readonly defaults?: ConfigOverrides;
  readonly configFile?: string;
  readonly readFile?: ConfigFileReader;
}

export class ConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

interface ConfigLayer extends Record<string, unknown> {
  identity?: unknown;
  guild?: unknown;
  convex?: unknown;
  repos?: unknown;
  areas?: unknown;
  colors?: unknown;
  backup?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeConfigValues(lower: unknown, higher: unknown): unknown {
  if (!isRecord(lower) || !isRecord(higher)) {
    return higher;
  }

  const merged: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    merged[key] = key in lower ? mergeConfigValues(lower[key], value) : value;
  }
  return merged;
}

function formatValidationIssues(source: string, value: unknown): Config {
  const result = configSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
    return `  - ${path}: ${issue.message}`;
  });
  throw new ConfigLoadError(`invalid ${source}:\n${issues.join("\n")}`);
}

function overridesToConfigLayer(overrides: ConfigOverrides | undefined): ConfigLayer {
  if (overrides === undefined) {
    return {};
  }

  const layer: ConfigLayer = {};
  if (overrides.identity !== undefined) {
    layer.identity = overrides.identity;
  }
  if (overrides.guild !== undefined) {
    layer.guild = overrides.guild;
  }
  if (overrides.convex !== undefined) {
    layer.convex = overrides.convex;
  }
  if (overrides.repos !== undefined) {
    layer.repos = overrides.repos;
  }
  if (overrides.areas !== undefined) {
    layer.areas = overrides.areas;
  }
  if (overrides.colors !== undefined) {
    layer.colors = overrides.colors;
  }
  if (overrides.backupRoot !== undefined) {
    layer.backup = { root: overrides.backupRoot };
  }
  return layer;
}

function environmentJsonValue(environment: QuestEnvironment, name: string): unknown {
  const value = environment[name];
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`invalid ${name}: expected JSON (${detail})`);
  }
}

function environmentToConfigLayer(environment: QuestEnvironment): ConfigLayer {
  const layer: ConfigLayer = {};
  const identity = environment.QUEST_IDENTITY;
  const guild = environment.QUEST_GUILD;
  const repos = environmentJsonValue(environment, "QUEST_REPOS");
  const areas = environmentJsonValue(environment, "QUEST_AREAS");
  const colors = environmentJsonValue(environment, "QUEST_COLORS");
  const backupRoot = environment.QUEST_BACKUP_ROOT;

  if (identity !== undefined) {
    layer.identity = identity;
  }
  if (guild !== undefined) {
    layer.guild = guild;
  }
  if (repos !== undefined) {
    layer.repos = repos;
  }
  if (areas !== undefined) {
    layer.areas = areas;
  }
  if (colors !== undefined) {
    layer.colors = colors;
  }
  if (backupRoot !== undefined) {
    layer.backup = { root: backupRoot };
  }
  return layer;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function recoverInterruptedConfigFileWhileLocked(filePath: string): Promise<void> {
  const recoveryPath = `${filePath}${CONFIG_RECOVERY_SUFFIX}`;
  try {
    await stat(recoveryPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`could not inspect recovery file ${recoveryPath}: ${detail}`);
  }

  try {
    await readFile(filePath);
    await rm(recoveryPath, { force: true });
    return;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      return;
    }
  }

  try {
    await link(recoveryPath, filePath);
    await rm(recoveryPath, { force: true });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EEXIST")
    ) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(
      `could not recover interrupted config file ${filePath}: ${detail}; inspect ${recoveryPath} and retry`,
    );
  }
}

async function recoverInterruptedConfigFile(filePath: string): Promise<void> {
  const recoveryPath = `${filePath}${CONFIG_RECOVERY_SUFFIX}`;
  try {
    await stat(recoveryPath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`could not inspect recovery file ${recoveryPath}: ${detail}`);
  }

  await withConfigLock(filePath, async () => {
    await recoverInterruptedConfigFileWhileLocked(filePath);
  });
}

async function readConfigFile(
  filePath: string,
  readTextFile: ConfigFileReader,
): Promise<unknown | typeof MISSING_CONFIG_FILE> {
  let contents: string;
  try {
    contents = await readTextFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return MISSING_CONFIG_FILE;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`could not read config file ${filePath}: ${detail}`);
  }

  try {
    return parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigLoadError(`could not parse config file ${filePath}: ${detail}`);
  }
}

async function readMissingConfigAfterWriter(filePath: string): Promise<unknown> {
  return withConfigLock(filePath, async () => {
    await recoverInterruptedConfigFileWhileLocked(filePath);
    const retried = await readConfigFile(filePath, defaultConfigFileReader);
    if (retried !== MISSING_CONFIG_FILE) {
      return retried;
    }
    await recoverInterruptedConfigFileWhileLocked(filePath);
    const confirmedMissing = await readConfigFile(filePath, defaultConfigFileReader);
    return confirmedMissing === MISSING_CONFIG_FILE ? {} : confirmedMissing;
  });
}

const defaultConfigFileReader: ConfigFileReader = (filePath) => readFile(filePath, "utf8");

export async function loadConfig(options: LoadConfigOptions): Promise<Config> {
  const configFile =
    options.configFile ?? join(options.platform.directories.config, CONFIG_FILE_NAME);
  const environment = options.environment ?? process.env;
  const readTextFile = options.readFile ?? defaultConfigFileReader;

  let config = formatValidationIssues("built-in defaults", {
    backup: { root: options.platform.directories.backup },
  });
  config = formatValidationIssues(
    "defaults",
    mergeConfigValues(config, overridesToConfigLayer(options.defaults)),
  );

  if (options.readFile === undefined) {
    await recoverInterruptedConfigFile(configFile);
  }
  const loadedFileConfig = await readConfigFile(configFile, readTextFile);
  const fileConfig =
    loadedFileConfig === MISSING_CONFIG_FILE
      ? options.readFile === undefined
        ? await readMissingConfigAfterWriter(configFile)
        : {}
      : loadedFileConfig;
  config = formatValidationIssues(
    `config file ${configFile}`,
    mergeConfigValues(config, fileConfig),
  );
  config = formatValidationIssues(
    "environment variables",
    mergeConfigValues(config, environmentToConfigLayer(environment)),
  );
  return formatValidationIssues(
    "command-line flags",
    mergeConfigValues(config, overridesToConfigLayer(options.flags)),
  );
}
