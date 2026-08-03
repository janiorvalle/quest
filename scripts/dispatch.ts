import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { realpathSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { parse } from "smol-toml";
import { z } from "zod";
import { createCliPrompter } from "../src/cli/prompt";
import { briefDataSchema } from "../src/cli/query";
import { loadConfig, resolveRepositoryStore } from "../src/config";
import { createPlatform } from "../src/platform";
import { type Config, type Quest, questSchema } from "../src/schema";

const dispatchAgentSchema = z.enum(["codex", "claude"]);
const trustModeSchema = z.enum(["full", "guarded"]);
const ORCHESTRATION_COMMAND_TIMEOUT_MS = 60_000;
const DISPATCH_HEARTBEAT_WINDOW_MS = 30 * 60 * 1_000;
const WORKER_BRIEF_FILE_PREFIX = ".quest-dispatch-brief-";
const dispatchArgumentsSchema = z.strictObject({
  agent: dispatchAgentSchema.default("codex"),
  baseRef: z.string().trim().min(1).default("HEAD"),
  concurrency: z.coerce.number().int().min(1).max(16).default(2),
  guild: z.string().trim().min(1).optional(),
  skipAfterReopens: z.coerce.number().int().min(1).default(2),
  trust: trustModeSchema.optional(),
  yes: z.boolean().default(false),
  worktreeRoot: z.string().trim().min(1).optional(),
});

const nextReportSchema = z.strictObject({
  schema: z.literal("quest.report/v1"),
  command: z.literal("next"),
  generated_at: z.string(),
  filters: z.strictObject({ repo: z.string().nullable() }),
  warnings: z.array(z.string()),
  data: z.strictObject({
    brief: briefDataSchema.nullable(),
    claimed: z.boolean(),
    quest: questSchema.nullable(),
  }),
});

const touchReportSchema = z.strictObject({
  schema: z.literal("quest.report/v1"),
  command: z.literal("touch"),
  generated_at: z.iso.datetime({ offset: true }),
  filters: z.strictObject({ repo: z.string().nullable() }),
  warnings: z.array(z.string()),
  data: z.object({ quest: questSchema }),
});

type DispatchQuestBrief = z.infer<typeof briefDataSchema>;

const unattendedClaudeTools = [
  "Bash(bun run check)",
  "Bash(bun run format)",
  "Bash(bun install --frozen-lockfile)",
  "Bash(bun install --frozen-lockfile --ignore-scripts)",
  "Bash(bun run lint)",
  "Bash(bun run test)",
  "Bash(bun run typecheck)",
  "Bash(git add *)",
  "Bash(git branch *)",
  "Bash(git checkout *)",
  "Bash(git commit *)",
  "Bash(git ls-files *)",
  "Bash(git mv *)",
  "Bash(git push *)",
  "Bash(git reset *)",
  "Bash(git restore *)",
  "Bash(git rev-parse *)",
  "Bash(git rm *)",
  "Bash(git status *)",
  "Bash(git switch *)",
  "Bash(gh pr create *)",
  "Bash(gh pr view *)",
  "Bash(quest brief *)",
  "Bash(quest show *)",
  "Bash(quest touch *)",
  "Bash(quest turnin *)",
  "Bash(quest update *)",
];

function unattendedClaudeToolArguments(): readonly string[] {
  return process.platform === "win32"
    ? unattendedClaudeTools.filter((tool) => tool !== "Bash(bun install --frozen-lockfile)")
    : unattendedClaudeTools;
}
const claudePermissionUnsafeCharacters = new Set([
  "\r",
  "\n",
  "(",
  ")",
  ",",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
]);

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function claudeWritableDirectories(input: WorkerInvocationInput): readonly string[] {
  return uniquePaths([
    input.worktreePath,
    ...(input.workerHomePath === undefined ? [] : [input.workerHomePath]),
    ...(input.gitWritableRoots ?? []),
  ]);
}

function claudeReadableDirectories(input: WorkerInvocationInput): readonly string[] {
  return uniquePaths([
    ...claudeWritableDirectories(input),
    ...(input.gitReadableRoots ?? []),
    ...(input.workerBinPath === undefined ? [] : [input.workerBinPath]),
  ]);
}

function nativeRuntimeReadDirectories(): readonly string[] {
  return [
    "/bin",
    "/dev",
    "/etc/hosts",
    "/etc/resolv.conf",
    "/etc/ssl",
    "/lib",
    "/lib32",
    "/lib64",
    "/Library/Frameworks",
    "/opt/homebrew/bin",
    "/opt/homebrew/lib",
    "/opt/homebrew/libexec",
    "/opt/homebrew/opt",
    "/opt/homebrew/share",
    "/private/etc/hosts",
    "/private/etc/resolv.conf",
    "/private/etc/ssl",
    "/private/System/Library",
    "/System/Library",
    "/usr/bin",
    "/usr/lib",
    "/usr/lib32",
    "/usr/lib64",
    "/usr/libexec",
    "/usr/local/bin",
    "/usr/local/lib",
    "/usr/local/libexec",
    "/usr/local/opt",
    "/usr/local/share",
    "/usr/share",
  ];
}

function validateClaudePermissionPath(path: string): void {
  if (
    [...path].some((character) => claudePermissionUnsafeCharacters.has(character)) ||
    (process.platform !== "win32" && path.includes("\\"))
  ) {
    throw new DispatchError(
      "DISPATCH_TRUST_PATH_UNSAFE",
      `guarded Claude cannot safely encode path ${JSON.stringify(path)} in its permission rules; choose a path without commas, parentheses, glob characters, backslashes, or line breaks, then retry`,
    );
  }
}

function claudePermissionPath(path: string): string {
  validateClaudePermissionPath(path);
  const normalizedPath = resolve(path).replaceAll("\\", "/").replace(/^\/+/u, "");
  return `//${normalizedPath}/**`;
}

function claudeNativeDirectories(input: WorkerInvocationInput): readonly string[] {
  return input.trust === "full"
    ? []
    : claudeReadableDirectories(input).flatMap((directory) => ["--add-dir", directory]);
}

function nativePackageReadDirectories(canonicalCliPath: string): readonly string[] {
  const homebrewCellarPrefixes = ["/opt/homebrew/Cellar/", "/usr/local/Cellar/"];
  if (!homebrewCellarPrefixes.some((prefix) => canonicalCliPath.startsWith(prefix))) {
    return [];
  }
  const packageRoot = dirname(dirname(canonicalCliPath));
  return ["lib", "libexec", "share"].map((directory) => join(packageRoot, directory));
}

function cliReadDirectories(
  input: WorkerInvocationInput,
  deniedHomePath: string,
): readonly string[] {
  const deniedCredentialHomePaths = uniquePaths([
    join(resolve(deniedHomePath), ".claude"),
    join(resolve(deniedHomePath), ".codex"),
    join(resolve(deniedHomePath), ".ssh"),
    ...(input.hostClaudeConfigPath === undefined ? [] : [resolve(input.hostClaudeConfigPath)]),
    ...(input.hostCodexHomeOverridePath === undefined
      ? []
      : [resolve(input.hostCodexHomeOverridePath)]),
  ]).flatMap((path) => [path, canonicalPath(path)]);
  const cliPaths = uniquePaths([
    ...(input.workerCliPath === undefined ? [] : [input.workerCliPath]),
    ...(input.workerSupportPaths ?? []),
  ]);
  return uniquePaths(
    cliPaths.flatMap((cliPath) => {
      const lexicalCliPath = resolve(cliPath);
      const canonicalCliPath = canonicalPath(lexicalCliPath);
      const executablePaths = new Set([lexicalCliPath, canonicalCliPath]);
      const packageReadDirectories = uniquePaths([
        ...nativePackageReadDirectories(canonicalCliPath),
        ...[nodeModulesRoot(lexicalCliPath), nodeModulesRoot(canonicalCliPath)].filter(
          (candidate): candidate is string => candidate !== undefined,
        ),
      ]);
      const candidates = uniquePaths([
        lexicalCliPath,
        canonicalCliPath,
        dirname(lexicalCliPath),
        dirname(canonicalCliPath),
        ...packageReadDirectories,
      ]);
      return candidates.filter((candidate) => {
        const resolvedCandidate = resolve(candidate);
        const isCredentialHomePath = deniedCredentialHomePaths.some(
          (homePath) =>
            resolvedCandidate === homePath || resolvedCandidate.startsWith(`${homePath}${sep}`),
        );
        return (
          resolvedCandidate !== "/" &&
          (executablePaths.has(resolvedCandidate) ||
            (!isCredentialHomePath && packageReadDirectories.includes(resolvedCandidate)))
        );
      });
    }),
  );
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function nodeModulesRoot(path: string): string | undefined {
  const resolvedPath = resolve(path);
  const marker = `${sep}node_modules`;
  const nodeModulesIndex = resolvedPath.lastIndexOf(marker);
  return nodeModulesIndex === -1
    ? undefined
    : resolvedPath.slice(0, nodeModulesIndex + marker.length);
}

function claudeSandboxSettings(input: WorkerInvocationInput): string {
  const hostHomePath = resolve(input.hostHomePath ?? homedir());
  const readableDirectories = uniquePaths([
    ...nativeRuntimeReadDirectories(),
    ...claudeReadableDirectories(input),
    ...cliReadDirectories(input, hostHomePath),
  ]);
  const writableDirectories = uniquePaths([
    ...claudeWritableDirectories(input),
    ...(input.workerHomePath === undefined ? [] : [join(input.workerHomePath, "tmp")]),
  ]);
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: writableDirectories,
        denyRead: ["/"],
        allowRead: readableDirectories,
      },
      network: {
        allowedDomains: uniquePaths([
          "api.anthropic.com",
          "api.github.com",
          "github.com",
          "registry.npmjs.org",
          "registry.yarnpkg.com",
          ...(input.questBackendDomains ?? []),
        ]),
      },
    },
  });
}

function claudeAllowedTools(input: WorkerInvocationInput): string {
  if (input.questCliPath !== undefined) {
    validateClaudePermissionPath(input.questCliPath);
  }
  const readableFileTools = claudeReadableDirectories(input).map((directory) => {
    const permissionPath = claudePermissionPath(directory);
    return `Read(${permissionPath})`;
  });
  const writableFileTools = claudeWritableDirectories(input).flatMap((directory) => {
    const permissionPath = claudePermissionPath(directory);
    return [`Edit(${permissionPath})`, `Write(${permissionPath})`];
  });
  const questTools =
    input.questCliPath === undefined
      ? []
      : ["brief", "show", "touch", "turnin", "update"].map(
          (command) => `Bash(${input.questCliPath} ${command} *)`,
        );
  return [
    ...readableFileTools,
    ...writableFileTools,
    ...unattendedClaudeToolArguments(),
    ...questTools,
  ].join(",");
}

function tomlString(value: string | readonly string[]): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("supported Codex auth value could not be serialized");
  }
  return serialized;
}

function tomlInlineTable(entries: readonly (readonly [string, string])[]): string {
  return `{ ${entries.map(([key, value]) => `${tomlString(key)} = ${value}`).join(", ")} }`;
}

function questStoreConfigToml(store: Config["store"]): string {
  const deployment = store.deployment ?? store.convex_deployment;
  return [
    "[store]",
    `backend = ${tomlString(store.backend)}`,
    ...(store.lease_ttl_minutes === undefined
      ? []
      : [`lease_ttl_minutes = ${store.lease_ttl_minutes}`]),
    ...(deployment === undefined || store.backend !== "convex"
      ? []
      : [`convex_deployment = ${tomlString(deployment)}`]),
    "",
  ].join("\n");
}

export function questNetworkDomains(store: Config["store"], trust: TrustMode): readonly string[] {
  if (store.backend !== "convex" || trust === "full") {
    return [];
  }
  const deployment = store.deployment ?? store.convex_deployment;
  if (deployment === undefined) {
    throw new DispatchError(
      "DISPATCH_QUEST_BACKEND_INVALID",
      "the selected Quest backend is Convex but has no deployment URL; set store.deployment or store.convex_deployment in the Quest config and retry",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(deployment);
  } catch {
    throw new DispatchError(
      "DISPATCH_QUEST_BACKEND_INVALID",
      `the selected Convex deployment ${JSON.stringify(deployment)} is not a URL; set store.deployment or store.convex_deployment to an http(s) deployment URL and retry`,
    );
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    throw new DispatchError(
      "DISPATCH_QUEST_BACKEND_INVALID",
      `the selected Convex deployment ${JSON.stringify(deployment)} is not an http(s) URL; set store.deployment or store.convex_deployment to an http(s) deployment URL and retry`,
    );
  }
  return [parsed.hostname];
}

function codexAuthConfigArguments(input: WorkerInvocationInput): readonly string[] {
  const authConfig = input.codexAuthConfig;
  if (authConfig === undefined) {
    return [];
  }
  const assignments: string[] = [];
  if (authConfig.forcedChatgptWorkspaceId !== undefined) {
    assignments.push(
      `forced_chatgpt_workspace_id=${tomlString(authConfig.forcedChatgptWorkspaceId)}`,
    );
  }
  if (authConfig.forcedLoginMethod !== undefined) {
    assignments.push(`forced_login_method=${tomlString(authConfig.forcedLoginMethod)}`);
  }
  if (authConfig.cliAuthCredentialsStore !== undefined) {
    assignments.push(
      `cli_auth_credentials_store=${tomlString(authConfig.cliAuthCredentialsStore)}`,
    );
  }
  if (authConfig.chatgptBaseUrl !== undefined) {
    assignments.push(`chatgpt_base_url=${tomlString(authConfig.chatgptBaseUrl)}`);
  }
  return assignments.flatMap((assignment) => ["--config", assignment]);
}

function codexGuardedPermissionArguments(input: WorkerInvocationInput): readonly string[] {
  // A per-run profile name prevents any stale profile selection from augmenting this policy.
  const permissionProfile = `quest_guarded_${randomUUID().replaceAll("-", "")}`;
  const hostHomePath = resolve(input.hostHomePath ?? homedir());
  const writableDirectories = uniquePaths([
    input.worktreePath,
    ...(input.workerHomePath === undefined ? [] : [input.workerHomePath]),
    ...(input.gitWritableRoots ?? []),
  ]);
  const writableSet = new Set(writableDirectories.map((directory) => resolve(directory)));
  const readableDirectories = uniquePaths([
    ...(input.gitReadableRoots ?? []),
    ...cliReadDirectories(input, hostHomePath),
    ...(input.workerBinPath === undefined ? [] : [input.workerBinPath]),
  ]).filter((directory) => !writableSet.has(resolve(directory)));
  const filesystemEntries: readonly (readonly [string, string])[] = [
    [":minimal", tomlString("read")],
    ...writableDirectories.map((directory): readonly [string, string] => [
      resolve(directory),
      tomlString("write"),
    ]),
    ...readableDirectories.map((directory): readonly [string, string] => [
      resolve(directory),
      tomlString("read"),
    ]),
  ];
  const networkDomains = [
    "api.github.com",
    "codeload.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    ...(input.questBackendDomains ?? []),
  ];
  const assignments = [
    `default_permissions=${tomlString(permissionProfile)}`,
    `permissions.${permissionProfile}.filesystem=${tomlInlineTable(filesystemEntries)}`,
    `permissions.${permissionProfile}.network=${tomlInlineTable([
      ["enabled", "true"],
      ["mode", tomlString("full")],
      [
        "domains",
        tomlInlineTable(
          networkDomains.map((domain): readonly [string, string] => [domain, tomlString("allow")]),
        ),
      ],
    ])}`,
  ];
  return assignments.flatMap((assignment) => ["--config", assignment]);
}

function codexGuardedExtensionArguments(): readonly string[] {
  // The guarded process starts outside the checkout; these scalar overrides disable integrations
  // as defense in depth without replacing the subscription credentials.
  return [
    "--config",
    "notify=[]",
    "--config",
    "features.plugins=false",
    "--config",
    "features.hooks=false",
    "--config",
    "features.apps=false",
  ];
}

const workerShowReportSchema = z.strictObject({
  schema: z.literal("quest.report/v1"),
  command: z.literal("show"),
  generated_at: z.string(),
  filters: z.strictObject({ id: z.int().positive(), repo: z.string().nullable() }),
  warnings: z.array(z.string()),
  data: z.object({ quest: questSchema }),
});

export type DispatchAgent = z.infer<typeof dispatchAgentSchema>;
export type TrustMode = z.infer<typeof trustModeSchema>;
export type DispatchCliOptions = z.infer<typeof dispatchArgumentsSchema>;

export interface DispatchOptions extends Omit<DispatchCliOptions, "trust"> {
  readonly claudeArgs: readonly string[];
  readonly codexArgs: readonly string[];
  readonly trust: TrustMode;
}

export interface CommandSpec {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isolatedEnvironment?: boolean;
  readonly ignoreCommandSignal?: boolean;
  readonly maxOutputChars?: number | null;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type CommandRunner = (spec: CommandSpec) => Promise<CommandResult>;

export interface WorkerHandle {
  readonly completion: Promise<number>;
  cancel(): Promise<void>;
}

export type WorkerRunner = (spec: CommandSpec) => WorkerHandle;

export interface DispatchRuntime {
  readonly environment: string;
  readonly host: string;
  readonly lockScript: string;
  readonly processId: number;
  readonly pythonCommand: string;
  readonly repoRoot: string;
  readonly runCommand: CommandRunner;
  readonly spawnWorker: WorkerRunner;
  readonly dispatchId?: string;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly commandSignal?: AbortSignal;
  readonly githubToken?: string | null;
  readonly hostHomePath?: string | null;
  readonly hostCodexHomePath?: string | null;
  readonly hostCodexHomeOverridePath?: string | null;
  readonly hostClaudeConfigOverridePath?: string | null;
  readonly gitUserEmail?: string | null;
  readonly gitUserName?: string | null;
  readonly gitRemoteUrl?: string | null;
  readonly codexCliPath?: string | null;
  readonly codexAuthConfig?: CodexAuthConfig | null;
  readonly claudeCliPath?: string | null;
  readonly questCliPath?: string | null;
  readonly questBackendDomains?: readonly string[];
  readonly questRepositoryName?: string;
  readonly questStore?: Config["store"];
  readonly gitCliPath?: string | null;
  readonly gitExecPath?: string | null;
  readonly nodeCliPath?: string | null;
  readonly bunCliPath?: string | null;
  readonly supportCliPaths?: readonly string[];
}

export interface WorkerInvocationInput {
  readonly agent: DispatchAgent;
  readonly branchSuffix?: string | undefined;
  readonly guild?: string | undefined;
  readonly gitWritableRoots?: readonly string[] | undefined;
  readonly gitReadableRoots?: readonly string[] | undefined;
  readonly trust: TrustMode;
  readonly claudeArgs?: readonly string[] | undefined;
  readonly codexArgs?: readonly string[] | undefined;
  readonly codexAuthConfig?: CodexAuthConfig | undefined;
  readonly workerCliPath?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly hostHomePath?: string | undefined;
  readonly hostCodexHomeOverridePath?: string | undefined;
  readonly hostClaudeConfigPath?: string | undefined;
  readonly questCliPath?: string | undefined;
  readonly questBackendDomains?: readonly string[] | undefined;
  readonly questRepositoryName?: string | undefined;
  readonly workerBinPath?: string | undefined;
  readonly workerSupportPaths?: readonly string[] | undefined;
  readonly gitPointerSnapshot?: GitPointerSnapshot | undefined;
  readonly briefFileName?: string | undefined;
  readonly briefPath?: string | undefined;
  readonly owner: string;
  readonly quest: Quest;
  readonly workerHomePath?: string | undefined;
  readonly worktreePath: string;
}

export interface CodexAuthConfig {
  readonly chatgptBaseUrl?: string;
  readonly cliAuthCredentialsStore?: string;
  readonly forcedChatgptWorkspaceId?: string | readonly string[];
  readonly forcedLoginMethod?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly profileFiles?: Readonly<Record<string, CodexProfileAttribution>>;
  readonly profiles?: Readonly<Record<string, CodexProfileAttribution>>;
  readonly reasoningEffort?: string;
}

interface CodexProfileAttribution {
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export interface WorkerInvocation extends CommandSpec {
  readonly branch: string;
  readonly owner: string;
  readonly questId: number;
  readonly sessionName: string;
  readonly briefFileName: string | null;
  readonly workerBinPath: string | null;
  readonly workerHomePath: string | null;
  readonly gitPointerSnapshot: GitPointerSnapshot | null;
  readonly worktreePath: string;
}

export interface DispatchWorkerResult {
  readonly branch: string;
  readonly exitCode: number;
  readonly lockStatus: "active" | "handoff";
  readonly owner: string;
  readonly questId: number;
  readonly questStatus: Quest["status"] | null;
  readonly sessionName: string;
  readonly worktreePath: string;
}

export interface DispatchReport {
  readonly command: "dispatch";
  readonly concurrency: number;
  readonly failures: number;
  readonly finished_at: string;
  readonly interrupted: boolean;
  readonly skipped_after_reopens: number;
  readonly started_at: string;
  readonly warnings: readonly string[];
  readonly workers: readonly DispatchWorkerResult[];
}

export class DispatchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "DispatchError";
    this.code = code;
  }
}

interface ClaimedQuest {
  readonly brief: DispatchQuestBrief;
  readonly leaseObservedAt: string;
  readonly owner: string;
  readonly quest: Quest;
}

interface ClaimNextResult {
  readonly claimed: ClaimedQuest | null;
  readonly warnings: readonly string[];
}

interface PreparationFailure {
  readonly branchCreated: boolean;
  readonly branch: string;
  readonly cleanupWarnings: readonly string[];
  readonly error: string;
  readonly workerHomePath: string | null;
  readonly lockClaimed: boolean;
  readonly owner: string;
  readonly quest: Quest;
  readonly worktreeCreated: boolean;
  readonly worktreePath: string;
}

type PreparationResult =
  | { readonly outcome: "failed"; readonly failure: PreparationFailure }
  | { readonly outcome: "ready"; readonly invocation: WorkerInvocation };

interface WorkerPlan {
  readonly branch: string;
  readonly branchSuffix: string;
  readonly worktreePath: string;
}

interface ActiveWorkerControl {
  handle: WorkerHandle | null;
}

interface ActiveWorker {
  readonly control: ActiveWorkerControl;
  readonly promise: Promise<DispatchWorkerResult>;
}

interface FinishedWorker {
  readonly result: DispatchWorkerResult;
  readonly slot: number;
}

interface GitPointerSnapshot {
  readonly content: string;
  readonly device: number;
  readonly inode: number;
}

function parseOptionalValue(
  value: string | boolean | readonly (string | boolean)[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseDispatchArguments(
  argumentsWithoutRuntime: readonly string[],
): DispatchCliOptions {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      allowPositionals: false,
      args: [...argumentsWithoutRuntime],
      options: {
        agent: { type: "string" },
        "base-ref": { type: "string" },
        concurrency: { type: "string" },
        guild: { type: "string" },
        "skip-after-reopens": { type: "string" },
        trust: { type: "string" },
        yes: { type: "boolean" },
        "worktree-root": { type: "string" },
      },
      strict: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DispatchError(
      "DISPATCH_USAGE",
      `${detail}; example: bun run scripts/dispatch.ts --trust full --concurrency 2 --agent codex`,
    );
  }

  try {
    return dispatchArgumentsSchema.parse({
      agent: parseOptionalValue(parsed.values["agent"]),
      baseRef: parseOptionalValue(parsed.values["base-ref"]),
      concurrency: parseOptionalValue(parsed.values["concurrency"]),
      guild: parseOptionalValue(parsed.values["guild"]),
      skipAfterReopens: parseOptionalValue(parsed.values["skip-after-reopens"]),
      trust: parseOptionalValue(parsed.values["trust"]),
      yes: parsed.values["yes"] === true,
      worktreeRoot: parseOptionalValue(parsed.values["worktree-root"]),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DispatchError(
      "DISPATCH_USAGE",
      `invalid dispatcher options (${detail}); example: bun run scripts/dispatch.ts --trust full --concurrency 2 --agent codex`,
    );
  }
}

export function resolveDispatchOptions(
  cliOptions: DispatchCliOptions,
  dispatchConfig: Config["dispatch"] = undefined,
): DispatchOptions {
  const trust = cliOptions.trust ?? dispatchConfig?.trust;
  if (trust === undefined) {
    throw new DispatchError(
      "DISPATCH_TRUST_REQUIRED",
      "choose --trust full or --trust guarded, or set [dispatch].trust in the Quest config, then retry",
    );
  }
  validatePassthroughTrustArguments("claude", dispatchConfig?.claude_args ?? [], trust);
  validatePassthroughTrustArguments("codex", dispatchConfig?.codex_args ?? [], trust);
  return {
    ...cliOptions,
    claudeArgs: dispatchConfig?.claude_args ?? [],
    codexArgs: dispatchConfig?.codex_args ?? [],
    trust,
  };
}

function validatePassthroughTrustArguments(
  agent: DispatchAgent,
  argumentsToValidate: readonly string[],
  trust: TrustMode,
): void {
  const reservedArguments =
    agent === "claude"
      ? [
          "--agent",
          "--add-dir",
          "--agents",
          "--allow-dangerously-skip-permissions",
          "--allowed-tools",
          "--allowedTools",
          "--append-system-prompt",
          "--append-system-prompt-file",
          "--bare",
          "--background",
          "--chrome",
          "--cloud",
          "--continue",
          "--debug",
          "--debug-file",
          "--dangerously-skip-permissions",
          "--disallowed-tools",
          "--disallowedTools",
          "--disable-slash-commands",
          "--exec",
          "--exec-file",
          "--file",
          "--from-pr",
          "--fork-session",
          "--ide",
          "--input-format",
          "--mcp-config",
          "--name",
          "--output-format",
          "--permission-mode",
          "--plugin-dir",
          "--plugin-url",
          "--prompt-suggestions",
          "--remote-control",
          "--remote-control-session-name-prefix",
          "--remote",
          "--resume",
          "--session-id",
          "--safe-mode",
          "--sandbox",
          "--settings",
          "--setting-sources",
          "--system-prompt",
          "--system-prompt-file",
          "--strict-mcp-config",
          "--tmux",
          "--teleport",
          "--tools",
          "--worktree",
          "--bg",
          "-c",
          "-d",
          "-p",
          "-n",
          "-r",
          "-w",
        ]
      : [
          "--add-dir",
          "--approval-policy",
          "--ask-for-approval",
          "--config",
          "--dangerously-bypass-approvals-and-sandbox",
          "--dangerously-bypass-hook-trust",
          "--ephemeral",
          "--full-auto",
          "--ignore-rules",
          "--ignore-user-config",
          "--image",
          "--output-last-message",
          "--output-schema",
          "--profile",
          "--sandbox",
          "--cd",
          "--skip-git-repo-check",
          "--disable",
          "--enable",
          "-a",
          "-c",
          "-i",
          "-o",
          "-p",
          "-s",
        ];
  if (agent === "codex" && trust === "guarded") {
    reservedArguments.push("--search");
  }
  const conflictingArgument = argumentsToValidate.find((argument) =>
    reservedArguments.some((reservedArgument) =>
      isReservedPassthroughArgument(argument, reservedArgument),
    ),
  );
  if (conflictingArgument !== undefined) {
    const conflictingFlag =
      conflictingArgument === "--"
        ? "--"
        : (reservedArguments.find((reservedArgument) =>
            isReservedPassthroughArgument(conflictingArgument, reservedArgument),
          ) ?? "reserved option");
    throw new DispatchError(
      "DISPATCH_TRUST_ARGUMENT_CONFLICT",
      `${agent}_args contains trust-affecting flag ${conflictingFlag}; remove it because --trust owns the worker containment policy, then retry`,
    );
  }
}

function isReservedPassthroughArgument(argument: string, reservedArgument: string): boolean {
  if (argument === "--") {
    return true;
  }
  if (argument === reservedArgument || argument.startsWith(`${reservedArgument}=`)) {
    return true;
  }
  return (
    reservedArgument.length === 2 &&
    reservedArgument.startsWith("-") &&
    !reservedArgument.startsWith("--") &&
    argument.startsWith(reservedArgument) &&
    argument.length > reservedArgument.length
  );
}

export interface TrustConfirmationContext {
  readonly ask: (question: string) => Promise<string>;
  readonly isInteractive: boolean;
  readonly write: (message: string) => void;
}

const GUARDED_TRUST_WARNING =
  "Guarded trust selected: native containment may stall or fail when a worker requests an action outside its allowlist. Git commits need shared repository metadata, so choose trust full for workers that must commit. Trust full is recommended for unattended work.\n";

export async function confirmDispatchTrust(
  options: DispatchOptions,
  context: TrustConfirmationContext,
): Promise<void> {
  if (options.trust !== "guarded") {
    return;
  }

  context.write(GUARDED_TRUST_WARNING);
  if (options.yes) {
    return;
  }
  if (!context.isInteractive) {
    throw new DispatchError(
      "DISPATCH_GUARDED_CONFIRMATION_REQUIRED",
      "guarded trust requires an explicit non-interactive acknowledgment; rerun with --yes or choose --trust full",
    );
  }

  const answer = await context.ask("Continue with guarded trust? [y/N] ");
  if (!/^(?:y|yes)$/iu.test(answer.trim())) {
    throw new DispatchError(
      "DISPATCH_GUARDED_DECLINED",
      "guarded dispatch was cancelled; answer yes to continue or choose --trust full",
    );
  }
}

export function slugifyQuestTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/gu, "");
  return slug || "quest";
}

function workerPrompt(
  quest: Quest,
  owner: string,
  sessionName: string,
  worktreePath: string,
  questCliPath: string | undefined,
  briefPath: string | undefined,
): string {
  const questCommand = questCliPath ?? "quest";
  const context =
    briefPath === undefined
      ? `Read the quest brief first: ${questCommand} brief ${quest.id}.`
      : `The claim command returned the full quest brief atomically; read it from ${
          isAbsolute(briefPath) ? briefPath : resolve(worktreePath, briefPath)
        } instead of making a second brief query.`;
  const dependencyInstructions =
    process.platform === "win32"
      ? "If dependencies are missing, run only bun install --frozen-lockfile --ignore-scripts in this runtime; script-running installs are disabled on Windows."
      : "If dependencies are missing, run only bun install --frozen-lockfile --ignore-scripts or bun install --frozen-lockfile in this runtime; the latter is still subject to the selected native containment policy.";
  return `${sessionName}:
You are the implementation worker for Quest ${quest.id}, already claimed as ${owner}.

${context} Implement the requested behavior in this worktree, following the repository instructions. The
checkout is at ${worktreePath}; start repository commands there and read its instructions there. Use
${questCommand} touch ${quest.id} during a long grind so the lease stays alive. Run the repository gates,
create real evidence, push your branch, and turn in the quest with the PR and evidence. ${dependencyInstructions} Do
not use another package manager. Do not claim a different quest. Do not rename this session.

Quest title: ${quest.title}`;
}

interface WorkerSessionAttributionInput {
  readonly agent: DispatchAgent;
  readonly claudeArgs?: readonly string[] | undefined;
  readonly codexArgs?: readonly string[] | undefined;
  readonly codexAuthConfig?: CodexAuthConfig | null | undefined;
  readonly useCodexConfig?: boolean | undefined;
}

interface WorkerSessionAttribution {
  readonly effort?: string | undefined;
  readonly model?: string | undefined;
}

function argumentValue(
  argumentsToInspect: readonly string[],
  names: readonly string[],
): string | undefined {
  let resolved: string | undefined;
  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    const value = optionValueAt(argumentsToInspect, index, names);
    if (value !== undefined) {
      resolved = value;
    }
  }
  return resolved;
}

function optionValueAt(
  argumentsToInspect: readonly string[],
  index: number,
  names: readonly string[],
): string | undefined {
  const argument = argumentsToInspect[index];
  if (argument === undefined) {
    return undefined;
  }
  const inlineName = names.find((name) => argument.startsWith(`${name}=`));
  if (inlineName !== undefined) {
    return nonEmptyConfigString(argument.slice(inlineName.length + 1));
  }
  const shortName = names.find(
    (name) =>
      name.length === 2 &&
      argument.startsWith(name) &&
      argument.length > name.length &&
      !argument.startsWith(`${name}=`),
  );
  if (shortName !== undefined) {
    return nonEmptyConfigString(argument.slice(shortName.length));
  }
  if (!names.includes(argument)) {
    return undefined;
  }
  const value = argumentsToInspect[index + 1];
  return value === undefined || value.startsWith("-") ? undefined : nonEmptyConfigString(value);
}

function codexConfigValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    const parsed = parse(`value = ${trimmed}`);
    return nonEmptyConfigString(parsed["value"]);
  } catch {
    return nonEmptyConfigString(trimmed.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2"));
  }
}

function codexConfigAssignmentAt(
  argumentsToInspect: readonly string[],
  index: number,
): readonly [string, string | undefined] | undefined {
  const argument = argumentsToInspect[index];
  if (argument === undefined) {
    return undefined;
  }
  const inlineName = ["--config", "-c"].find((name) => argument.startsWith(`${name}=`));
  const attachedShortAssignment =
    inlineName === undefined && argument.startsWith("-c") && argument.length > 2
      ? argument.slice(2)
      : undefined;
  const assignment =
    inlineName === undefined
      ? argument === "--config" || argument === "-c"
        ? argumentsToInspect[index + 1]
        : attachedShortAssignment
      : argument.slice(inlineName.length + 1);
  if (assignment === undefined) {
    return undefined;
  }
  const equalsIndex = assignment.indexOf("=");
  if (equalsIndex <= 0) {
    return undefined;
  }
  return [
    assignment.slice(0, equalsIndex).trim(),
    codexConfigValue(assignment.slice(equalsIndex + 1)),
  ];
}

function codexProfileConfigOverride(
  key: string,
  value: string | undefined,
):
  | {
      readonly field: "effort" | "model";
      readonly profileName: string;
      readonly value: string | undefined;
    }
  | undefined {
  const [scope, profileName, field] = key.split(".");
  if (scope !== "profiles" || profileName === undefined || profileName === "") {
    return undefined;
  }
  if (field === "model") {
    return { field, profileName, value };
  }
  if (field === "model_reasoning_effort") {
    return { field: "effort", profileName, value };
  }
  return undefined;
}

function codexSelectedProfileName(
  argumentsToInspect: readonly string[],
  authConfig: CodexAuthConfig | null | undefined,
): string | undefined {
  const argumentProfile = argumentValue(argumentsToInspect, ["--profile", "-p"]);
  let configuredProfile = authConfig?.profile;
  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    const assignment = codexConfigAssignmentAt(argumentsToInspect, index);
    if (assignment?.[0] === "profile") {
      configuredProfile = assignment[1];
    }
  }
  return argumentProfile ?? configuredProfile;
}

function codexDedicatedAttributionAt(
  argumentsToInspect: readonly string[],
  index: number,
): WorkerSessionAttribution {
  const modelValue = optionValueAt(argumentsToInspect, index, ["--model", "-m"]);
  const effortValue = optionValueAt(argumentsToInspect, index, ["--effort", "--reasoning-effort"]);
  return {
    ...(effortValue === undefined ? {} : { effort: effortValue }),
    ...(modelValue === undefined ? {} : { model: modelValue }),
  };
}

interface CodexExplicitAttribution {
  readonly effort: string | undefined;
  readonly effortSpecified: boolean;
  readonly model: string | undefined;
  readonly modelSpecified: boolean;
}

function applyCodexExplicitAssignment(
  assignment: readonly [string, string | undefined],
  selectedProfileName: string | undefined,
  current: CodexExplicitAttribution,
): CodexExplicitAttribution {
  if (assignment[0] === "model") {
    return { ...current, model: assignment[1], modelSpecified: true };
  }
  if (assignment[0] === "model_reasoning_effort") {
    return { ...current, effort: assignment[1], effortSpecified: true };
  }
  const profileOverride = codexProfileConfigOverride(assignment[0], assignment[1]);
  if (profileOverride === undefined || profileOverride.profileName !== selectedProfileName) {
    return current;
  }
  return profileOverride.field === "model"
    ? { ...current, model: profileOverride.value, modelSpecified: true }
    : { ...current, effort: profileOverride.value, effortSpecified: true };
}

function applyCodexExplicitDedicated(
  dedicated: WorkerSessionAttribution,
  current: CodexExplicitAttribution,
): CodexExplicitAttribution {
  return {
    effort: dedicated.effort ?? current.effort,
    effortSpecified: dedicated.effort === undefined ? current.effortSpecified : true,
    model: dedicated.model ?? current.model,
    modelSpecified: dedicated.model === undefined ? current.modelSpecified : true,
  };
}

function codexExplicitAttribution(
  argumentsToInspect: readonly string[],
  authConfig: CodexAuthConfig | null | undefined,
): CodexExplicitAttribution {
  let explicit: CodexExplicitAttribution = {
    effort: undefined,
    effortSpecified: false,
    model: undefined,
    modelSpecified: false,
  };
  const selectedProfileName = codexSelectedProfileName(argumentsToInspect, authConfig);
  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    const assignment = codexConfigAssignmentAt(argumentsToInspect, index);
    if (assignment !== undefined) {
      explicit = applyCodexExplicitAssignment(assignment, selectedProfileName, explicit);
    }
  }
  for (let index = 0; index < argumentsToInspect.length; index += 1) {
    explicit = applyCodexExplicitDedicated(
      codexDedicatedAttributionAt(argumentsToInspect, index),
      explicit,
    );
  }
  return explicit;
}

function codexIgnoresUserConfig(argumentsToInspect: readonly string[]): boolean {
  return argumentsToInspect.some(
    (argument) =>
      argument === "--ignore-user-config" || argument.startsWith("--ignore-user-config="),
  );
}

function attributionArguments(argumentsToInspect: readonly string[]): readonly string[] {
  const endOfOptions = argumentsToInspect.indexOf("--");
  return endOfOptions === -1 ? argumentsToInspect : argumentsToInspect.slice(0, endOfOptions);
}

function workerSessionAttribution(input: WorkerSessionAttributionInput): WorkerSessionAttribution {
  const claudeArgs = attributionArguments(input.claudeArgs ?? []);
  if (input.agent === "claude") {
    return {
      effort: argumentValue(claudeArgs, ["--effort"]),
      model: argumentValue(claudeArgs, ["--model"]),
    };
  }
  const codexArgs = attributionArguments(input.codexArgs ?? []);
  const useCodexConfig = input.useCodexConfig !== false && !codexIgnoresUserConfig(codexArgs);
  const codexAuthConfig = useCodexConfig ? input.codexAuthConfig : undefined;
  const explicit = codexExplicitAttribution(codexArgs, codexAuthConfig);
  // Managed Codex requirements can replace user/profile defaults, so only explicit CLI values are
  // authoritative enough to stamp into the worker session.
  return {
    effort: explicit.effortSpecified ? explicit.effort : undefined,
    model: explicit.modelSpecified ? explicit.model : undefined,
  };
}

function sessionAttributionEnvironment(
  attribution: WorkerSessionAttribution,
): Record<string, string | undefined> {
  return {
    QUEST_EFFORT: attribution.effort,
    QUEST_MODEL: attribution.model,
  };
}

function subscriptionHomePath(input: WorkerInvocationInput): string {
  const hostHomePath = input.hostHomePath ?? homedir();
  return input.agent === "codex"
    ? (input.hostCodexHomeOverridePath ?? join(hostHomePath, ".codex"))
    : (input.hostClaudeConfigPath ?? join(hostHomePath, ".claude"));
}

function workerBaseEnvironment(input: WorkerInvocationInput): Record<string, string | undefined> {
  const sessionAttribution = workerSessionAttribution({
    ...input,
    useCodexConfig: input.trust === "full",
  });
  return {
    // Git inherits repository-selection overrides from the dispatcher shell. Explicitly unset
    // them so plain Git resolves the linked worktree from its cwd and .git pointer.
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_WORK_TREE: undefined,
    QUEST_IDENTITY: input.owner,
    ...(input.guild === undefined ? {} : { QUEST_GUILD: input.guild }),
    ...sessionAttributionEnvironment(sessionAttribution),
    ...(input.questRepositoryName === undefined
      ? {}
      : {
          QUEST_REPOS: JSON.stringify({
            [basename(input.worktreePath)]: input.questRepositoryName,
          }),
        }),
  };
}

function workerProviderEnvironment(
  input: WorkerInvocationInput,
  providerHomePath: string,
  workerHomePath: string,
): Record<string, string> {
  if (input.agent === "codex") {
    // Guarded workers keep the provider-home bridge because their isolated HOME has no subscription auth.
    return input.trust === "full" && input.hostCodexHomeOverridePath === undefined
      ? {}
      : { CODEX_HOME: providerHomePath };
  }
  return {
    ...(input.hostClaudeConfigPath === undefined ? {} : { CLAUDE_CONFIG_DIR: providerHomePath }),
    BUN_INSTALL_CACHE_DIR: join(workerHomePath, ".bun", "install", "cache"),
  };
}

function workerWindowsEnvironment(workerHomePath: string): Record<string, string> {
  return process.platform === "win32"
    ? {
        APPDATA: join(workerHomePath, "AppData", "Roaming"),
        LOCALAPPDATA: join(workerHomePath, "AppData", "Local"),
      }
    : {};
}

function workerEnvironment(input: WorkerInvocationInput): Record<string, string | undefined> {
  const baseEnvironment = workerBaseEnvironment(input);
  if (input.workerHomePath === undefined) {
    return baseEnvironment;
  }
  // Explicit human dispatch reuses the existing subscription session; provider API keys are never injected.
  const hostHomePath = input.hostHomePath ?? homedir();
  const providerHomePath = subscriptionHomePath(input);
  return {
    ...baseEnvironment,
    GH_CONFIG_DIR: join(input.workerHomePath, ".config", "gh"),
    GIT_CONFIG_GLOBAL: join(input.workerHomePath, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    HOME:
      (input.agent === "claude" || input.agent === "codex") && input.trust === "full"
        ? hostHomePath
        : input.workerHomePath,
    PATH: [input.workerBinPath ?? join(input.workerHomePath, "bin"), process.env["PATH"]]
      .filter((path): path is string => path !== undefined && path !== "")
      .join(delimiter),
    TMPDIR: join(input.workerHomePath, "tmp"),
    XDG_CONFIG_HOME: join(input.workerHomePath, ".config"),
    ...workerWindowsEnvironment(input.workerHomePath),
    ...workerProviderEnvironment(input, providerHomePath, input.workerHomePath),
    ...(input.githubToken === undefined ? {} : { GH_TOKEN: input.githubToken }),
  };
}

type WorkerInvocationIdentity = Pick<
  WorkerInvocation,
  | "branch"
  | "briefFileName"
  | "owner"
  | "questId"
  | "sessionName"
  | "workerBinPath"
  | "workerHomePath"
  | "gitPointerSnapshot"
  | "worktreePath"
>;

function workerInvocationIdentity(
  input: WorkerInvocationInput,
  branch: string,
  sessionName: string,
): WorkerInvocationIdentity {
  return {
    branch,
    briefFileName: input.briefFileName ?? null,
    owner: input.owner,
    questId: input.quest.id,
    sessionName,
    workerBinPath: input.workerBinPath ?? null,
    workerHomePath: input.workerHomePath ?? null,
    gitPointerSnapshot: input.gitPointerSnapshot ?? null,
    worktreePath: input.worktreePath,
  };
}

function createClaudeWorkerInvocation(
  input: WorkerInvocationInput,
  identity: WorkerInvocationIdentity,
  prompt: string,
  environment: Record<string, string | undefined>,
): WorkerInvocation {
  const trustArguments =
    input.trust === "full"
      ? ["--dangerously-skip-permissions"]
      : [
          "--permission-mode",
          "dontAsk",
          "--allowed-tools",
          claudeAllowedTools(input),
          "--setting-sources",
          "",
          "--safe-mode",
        ];
  return {
    args: [
      "-p",
      "--name",
      identity.sessionName,
      ...(input.claudeArgs ?? []),
      ...claudeNativeDirectories(input),
      ...trustArguments,
      ...(input.trust === "guarded" ? ["--settings", claudeSandboxSettings(input)] : []),
      prompt,
    ],
    command: input.workerCliPath ?? "claude",
    cwd: input.worktreePath,
    env: environment,
    isolatedEnvironment: input.workerHomePath !== undefined,
    ...identity,
  };
}

function createCodexWorkerInvocation(
  input: WorkerInvocationInput,
  identity: WorkerInvocationIdentity,
  prompt: string,
  environment: Record<string, string | undefined>,
): WorkerInvocation {
  const codexWorkspacePath = input.workerHomePath ?? input.worktreePath;
  const trustArguments =
    input.trust === "full"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--add-dir",
          input.worktreePath,
          ...codexAuthConfigArguments(input),
          ...codexGuardedExtensionArguments(),
          ...codexGuardedPermissionArguments(input),
        ];
  return {
    args: [
      "exec",
      ...(input.codexArgs ?? []),
      ...trustArguments,
      "--cd",
      input.trust === "guarded" ? codexWorkspacePath : input.worktreePath,
      prompt,
    ],
    command: input.workerCliPath ?? "codex",
    cwd: input.trust === "guarded" ? codexWorkspacePath : input.worktreePath,
    env: environment,
    isolatedEnvironment: true,
    ...identity,
  };
}

export function createWorkerInvocation(input: WorkerInvocationInput): WorkerInvocation {
  if (input.trust === undefined) {
    throw new DispatchError(
      "DISPATCH_TRUST_REQUIRED",
      "worker trust was not selected; provide --trust full or --trust guarded before dispatching",
    );
  }
  const slug = slugifyQuestTitle(input.quest.title);
  const branch = `quest/${input.quest.id}-${slug}${input.branchSuffix ?? ""}`;
  const sessionName = `quest ${input.quest.id} — ${slug}`;
  const identity = workerInvocationIdentity(input, branch, sessionName);
  const prompt = workerPrompt(
    input.quest,
    input.owner,
    sessionName,
    input.worktreePath,
    input.questCliPath,
    input.briefPath,
  );
  const environment = workerEnvironment(input);
  return input.agent === "claude"
    ? createClaudeWorkerInvocation(input, identity, prompt, environment)
    : createCodexWorkerInvocation(input, identity, prompt, environment);
}

function commandOutput(result: CommandResult): string {
  const output = [result.stderr.trim(), result.stdout.trim()].filter((item) => item !== "");
  return output.join(" | ").slice(0, 800) || "no output";
}

const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024;

function appendCapturedOutput(
  current: string,
  chunk: Buffer,
  maxOutputChars: number | null,
): string {
  const next = current + chunk.toString();
  return maxOutputChars === null || next.length <= maxOutputChars
    ? next
    : next.slice(-maxOutputChars);
}

function processEnvironment(spec: CommandSpec): NodeJS.ProcessEnv {
  if (spec.isolatedEnvironment !== true) {
    return { ...process.env, ...spec.env };
  }

  const inheritedNames = ["LANG", "LC_ALL", "LOGNAME", "NO_COLOR", "PATH", "TERM", "USER"];
  const inherited = Object.fromEntries(
    inheritedNames.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return { ...inherited, ...spec.env };
}

function runCommand(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      detached: process.platform !== "win32",
      env: processEnvironment(spec),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let interrupted = false;
    let timedOut = false;
    const terminate = (): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    };
    const onAbort = (): void => {
      interrupted = true;
      terminate();
    };
    if (spec.signal?.aborted === true) {
      onAbort();
    } else {
      spec.signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timeout =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, spec.timeoutMs);
    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      spec.signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapturedOutput(
        stdout,
        chunk,
        spec.maxOutputChars ?? MAX_CAPTURED_OUTPUT_CHARS,
      );
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapturedOutput(
        stderr,
        chunk,
        spec.maxOutputChars ?? MAX_CAPTURED_OUTPUT_CHARS,
      );
    });
    child.on("error", (error) => {
      if (!timedOut && !interrupted) {
        finish({ exitCode: 1, stderr: error.message, stdout: "" });
      }
    });
    child.on("close", (exitCode) => {
      if (timedOut) {
        finish({
          exitCode: 124,
          stderr: [`command timed out after ${spec.timeoutMs}ms`, stderr]
            .filter((item) => item !== "")
            .join(" | "),
          stdout,
        });
      } else if (interrupted) {
        finish({ exitCode: 130, stderr, stdout });
      } else {
        finish({
          exitCode: exitCode ?? 1,
          stderr,
          stdout,
        });
      }
    });
  });
}

function spawnWorker(spec: CommandSpec): WorkerHandle {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: processEnvironment(spec),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stderr, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  let resolveCompletion: ((exitCode: number) => void) | undefined;
  let completed = false;
  const completion = new Promise<number>((resolveCompletionPromise) => {
    resolveCompletion = resolveCompletionPromise;
  });
  const complete = (exitCode: number): void => {
    if (completed) {
      return;
    }
    completed = true;
    resolveCompletion?.(exitCode);
  };
  child.on("error", () => complete(1));
  child.on("close", (exitCode) => complete(exitCode ?? 1));

  return {
    completion,
    async cancel(): Promise<void> {
      if (process.platform === "win32" || child.pid === undefined) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        }
      }
      await completion;
    },
  };
}

function localEnvironment(): string {
  return process.platform === "darwin"
    ? "local:mac"
    : process.platform === "win32"
      ? "local:windows"
      : "local:linux";
}

async function resolveLockScript(environment: NodeJS.ProcessEnv): Promise<string> {
  const candidates: string[] = [];
  const configured = environment["QUEST_WORKTREE_LOCK_SCRIPT"];
  if (configured !== undefined && configured.trim() !== "") {
    candidates.push(resolve(configured));
  }
  const codexHome = environment["CODEX_HOME"] ?? join(homedir(), ".codex");
  candidates.push(join(codexHome, "skills", "worktree-lock", "scripts", "worktree_lock.py"));
  candidates.push(
    join(homedir(), ".agents", "skills", "worktree-lock", "scripts", "worktree_lock.py"),
  );

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }

  throw new DispatchError(
    "DISPATCH_LOCK_HELPER_MISSING",
    "worktree-lock helper was not found; install the worktree-lock skill or set " +
      "QUEST_WORKTREE_LOCK_SCRIPT to scripts/worktree_lock.py, then retry",
  );
}

async function createRuntime(
  agent: DispatchAgent,
  trust: TrustMode,
  config: Config,
): Promise<DispatchRuntime> {
  const rootResult = await runCommand({
    args: ["rev-parse", "--show-toplevel"],
    command: "git",
    cwd: process.cwd(),
  });
  if (rootResult.exitCode !== 0) {
    throw new DispatchError(
      "DISPATCH_NOT_A_REPOSITORY",
      `run this script from a Git repository; git reported ${commandOutput(rootResult)}`,
    );
  }

  const repoRoot = rootResult.stdout.trim();
  if (repoRoot === "") {
    throw new DispatchError(
      "DISPATCH_NOT_A_REPOSITORY",
      "Git returned an empty repository root; run from a checked-out repository and retry",
    );
  }

  const questRepositoryName = basename(repoRoot);
  const questStore = resolveRepositoryStore(config, questRepositoryName);
  const questBackendDomains = questNetworkDomains(questStore, trust);

  const hostHomePath = homedir();
  const hostCodexHomePath = configuredProviderHomePath(
    process.env["CODEX_HOME"],
    join(hostHomePath, ".codex"),
  );
  const hostCodexHomeOverridePath = configuredProviderHomeOverridePath(process.env["CODEX_HOME"]);
  const hostClaudeConfigOverridePath = configuredProviderHomeOverridePath(
    process.env["CLAUDE_CONFIG_DIR"],
  );
  const gitIdentity = await resolveGitIdentity(runCommand);
  const workerCliPath = await resolveExecutablePath(agent, runCommand);
  if (workerCliPath === null) {
    throw new DispatchError(
      "DISPATCH_WORKER_CLI_MISSING",
      `${agent} was not found on PATH; install ${agent} and retry before dispatching any work`,
    );
  }
  await preflightWorkerCli(agent, trust, workerCliPath, runCommand);
  const nodeCliPath = await resolveExecutablePath("node", runCommand);
  if (nodeCliPath === null) {
    throw new DispatchError(
      "DISPATCH_NODE_MISSING",
      "node was not found on PATH; install Node.js before dispatching any work",
    );
  }
  const supportCliPaths = await resolveSupportExecutablePaths(runCommand);
  const missingSupportExecutable = supportCliPaths.find(
    (supportExecutable) => supportExecutable.path === null,
  );
  if (missingSupportExecutable !== undefined) {
    throw new DispatchError(
      "DISPATCH_SUPPORT_CLI_MISSING",
      `${missingSupportExecutable.name} was not found on PATH; install it before dispatching work, then retry`,
    );
  }
  const questCliPath = await resolveAndPreflightQuestCli(supportCliPaths, repoRoot, runCommand);
  const gitCliPath = supportCliPaths.find(
    (supportExecutable) => supportExecutable.name === "git",
  )?.path;
  const gitExecPath = await resolveGitExecPath(gitCliPath ?? "git", runCommand);
  if (gitExecPath === null) {
    throw new DispatchError(
      "DISPATCH_GIT_EXEC_PATH_MISSING",
      "Git did not report an executable path; install a complete Git distribution before dispatching work, then retry",
    );
  }
  const githubToken = resolveExplicitGitHubToken();
  if (githubToken === null) {
    throw new DispatchError(
      "DISPATCH_GITHUB_TOKEN_REQUIRED",
      "set GH_TOKEN or GITHUB_TOKEN to a dedicated fine-grained GitHub token scoped to this repository before dispatching networked workers; the dispatcher will not use the ambient gh login",
    );
  }
  if (gitIdentity.remoteUrl === null) {
    throw new DispatchError(
      "DISPATCH_REMOTE_MISSING",
      "origin has no usable URL; configure a GitHub origin before dispatching work that must push a PR",
    );
  }
  const codexAuthConfig = await requireSubscriptionAuth(
    agent,
    workerCliPath,
    hostHomePath,
    hostCodexHomePath,
    runCommand,
  );
  const bunCliPath = supportCliPaths.find(
    (supportExecutable) => supportExecutable.name === "bun",
  )?.path;
  return {
    claudeCliPath: agent === "claude" ? workerCliPath : null,
    codexCliPath: agent === "codex" ? workerCliPath : null,
    environment: localEnvironment(),
    host: hostname(),
    lockScript: await resolveLockScript(process.env),
    processId: process.pid,
    pythonCommand: process.platform === "win32" ? "python" : "python3",
    repoRoot,
    runCommand,
    spawnWorker,
    githubToken,
    hostHomePath,
    hostCodexHomePath,
    hostCodexHomeOverridePath,
    hostClaudeConfigOverridePath,
    codexAuthConfig,
    questBackendDomains,
    questRepositoryName,
    questStore,
    gitUserEmail: gitIdentity.email,
    gitUserName: gitIdentity.name,
    gitRemoteUrl: gitIdentity.remoteUrl,
    questCliPath,
    gitCliPath: gitCliPath ?? null,
    gitExecPath,
    nodeCliPath,
    bunCliPath: bunCliPath ?? null,
    supportCliPaths: supportCliPaths.flatMap((supportExecutable) =>
      supportExecutable.path === null ? [] : [supportExecutable.path],
    ),
  };
}

async function preflightWorkerCli(
  agent: DispatchAgent,
  trust: TrustMode,
  workerCliPath: string,
  commandRunner: CommandRunner,
): Promise<void> {
  if (agent === "claude" && trust === "guarded") {
    await requireGuardedClaudeCompatibility(workerCliPath, commandRunner);
  }
  if (agent === "codex" && trust === "guarded") {
    await requireGuardedCodexCompatibility(workerCliPath, commandRunner);
  }
}

function configuredProviderHomePath(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === "" ? fallback : resolve(value);
}

function configuredProviderHomeOverridePath(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : resolve(value);
}

async function requireSubscriptionAuth(
  agent: DispatchAgent,
  workerCliPath: string,
  hostHomePath: string,
  codexHomePath: string,
  commandRunner: CommandRunner,
): Promise<CodexAuthConfig | null> {
  if (agent !== "codex") {
    return null;
  }
  return requireCodexSubscriptionAuth(workerCliPath, hostHomePath, codexHomePath, commandRunner);
}

export function hasCodexSubscriptionLogin(result: CommandResult): boolean {
  return (
    result.exitCode === 0 &&
    (result.stdout.trim() === "Logged in using ChatGPT" ||
      result.stderr.trim() === "Logged in using ChatGPT")
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function resolvedCodexConfigString(
  config: Record<string, unknown>,
  selectedProfile: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const profileValue = nonEmptyConfigString(selectedProfile?.[key]);
    if (profileValue !== undefined) {
      return profileValue;
    }
  }
  for (const key of keys) {
    const configValue = nonEmptyConfigString(config[key]);
    if (configValue !== undefined) {
      return configValue;
    }
  }
  return undefined;
}

function codexProfileAttributions(
  config: Record<string, unknown>,
): Readonly<Record<string, CodexProfileAttribution>> | undefined {
  const profiles = config["profiles"];
  if (!isRecordValue(profiles)) {
    return undefined;
  }
  const attributions: Record<string, CodexProfileAttribution> = {};
  for (const [name, profileValue] of Object.entries(profiles)) {
    if (!isRecordValue(profileValue)) {
      continue;
    }
    const model = resolvedCodexConfigString(config, profileValue, ["model"]);
    const reasoningEffort = resolvedCodexConfigString(config, profileValue, [
      "model_reasoning_effort",
    ]);
    attributions[name] = {
      ...(model === undefined ? {} : { model }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
  }
  return attributions;
}

export function parseCodexAuthConfig(contents: string): CodexAuthConfig {
  const config = parse(contents);
  const workspaceIds = config["forced_chatgpt_workspace_id"];
  const profileName = nonEmptyConfigString(config["profile"]);
  const profileDefinitions = config["profiles"];
  const selectedProfile =
    profileName !== undefined &&
    isRecordValue(profileDefinitions) &&
    isRecordValue(profileDefinitions[profileName])
      ? profileDefinitions[profileName]
      : undefined;
  const authConfig: {
    chatgptBaseUrl?: string;
    cliAuthCredentialsStore?: string;
    forcedChatgptWorkspaceId?: string | readonly string[];
    forcedLoginMethod?: string;
    model?: string;
    profile?: string;
    profiles?: Readonly<Record<string, CodexProfileAttribution>>;
    reasoningEffort?: string;
  } = {};
  if (typeof config["chatgpt_base_url"] === "string") {
    authConfig.chatgptBaseUrl = config["chatgpt_base_url"];
  }
  if (isRecordValue(selectedProfile) && typeof selectedProfile["chatgpt_base_url"] === "string") {
    authConfig.chatgptBaseUrl = selectedProfile["chatgpt_base_url"];
  }
  if (typeof config["cli_auth_credentials_store"] === "string") {
    authConfig.cliAuthCredentialsStore = config["cli_auth_credentials_store"];
  }
  if (typeof workspaceIds === "string" || isStringArray(workspaceIds)) {
    authConfig.forcedChatgptWorkspaceId = workspaceIds;
  }
  if (typeof config["forced_login_method"] === "string") {
    authConfig.forcedLoginMethod = config["forced_login_method"];
  }
  if (profileName !== undefined) {
    authConfig.profile = profileName;
  }
  const model = resolvedCodexConfigString(config, selectedProfile, ["model"]);
  const reasoningEffort = resolvedCodexConfigString(config, selectedProfile, [
    "model_reasoning_effort",
  ]);
  const profiles = codexProfileAttributions(config);
  if (model !== undefined) {
    authConfig.model = model;
  }
  if (profiles !== undefined) {
    authConfig.profiles = profiles;
  }
  if (reasoningEffort !== undefined) {
    authConfig.reasoningEffort = reasoningEffort;
  }
  return authConfig;
}

async function loadCodexAuthConfig(codexHomePath: string): Promise<CodexAuthConfig> {
  const configPath = join(codexHomePath, "config.toml");
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      contents = "";
    } else {
      throw new DispatchError(
        "DISPATCH_CODEX_CONFIG_UNREADABLE",
        `Codex config at ${configPath} could not be read; fix its permissions and retry`,
      );
    }
  }
  try {
    const authConfig = parseCodexAuthConfig(contents);
    const profileFiles = await loadCodexProfileFiles(codexHomePath);
    return Object.keys(profileFiles).length === 0 ? authConfig : { ...authConfig, profileFiles };
  } catch (error) {
    if (error instanceof DispatchError) {
      throw error;
    }
    throw new DispatchError(
      "DISPATCH_CODEX_CONFIG_INVALID",
      `Codex config at ${configPath} is not valid TOML; fix it before dispatching a worker and retry`,
    );
  }
}

async function loadCodexProfileFiles(
  codexHomePath: string,
): Promise<Readonly<Record<string, CodexProfileAttribution>>> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(codexHomePath, { withFileTypes: true });
  } catch {
    return {};
  }
  const profileFiles: Record<string, CodexProfileAttribution> = {};
  for (const entry of entries) {
    if (
      entry.isDirectory() ||
      !entry.name.endsWith(".config.toml") ||
      entry.name === "config.toml"
    ) {
      continue;
    }
    const profileName = entry.name.slice(0, -".config.toml".length);
    try {
      const profileConfig = parseCodexAuthConfig(
        await readFile(join(codexHomePath, entry.name), "utf8"),
      );
      profileFiles[profileName] = {
        ...(profileConfig.model === undefined ? {} : { model: profileConfig.model }),
        ...(profileConfig.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: profileConfig.reasoningEffort }),
      };
    } catch {}
  }
  return profileFiles;
}

async function requireCodexSubscriptionAuth(
  codexCliPath: string,
  hostHomePath: string,
  codexHomePath: string,
  commandRunner: CommandRunner,
): Promise<CodexAuthConfig> {
  const result = await commandRunner({
    args: ["login", "status"],
    command: codexCliPath,
    cwd: process.cwd(),
    env: {
      CODEX_HOME: codexHomePath,
      HOME: hostHomePath,
    },
    isolatedEnvironment: true,
    timeoutMs: ORCHESTRATION_COMMAND_TIMEOUT_MS,
  });
  if (!hasCodexSubscriptionLogin(result)) {
    throw new DispatchError(
      "DISPATCH_CODEX_AUTH_REQUIRED",
      `Codex subscription login was not verified in ${codexHomePath}; run "codex login" with that CODEX_HOME and retry. "codex login status" must report "Logged in using ChatGPT"; API-key login and provider API keys are not accepted`,
    );
  }
  return loadCodexAuthConfig(codexHomePath);
}

async function resolveExecutablePath(
  commandName: string,
  commandRunner: CommandRunner,
): Promise<string | null> {
  const result = await commandRunner({
    args: [commandName],
    command: "which",
    cwd: process.cwd(),
  });
  const path = result.stdout.trim().split(/\r?\n/gu)[0]?.trim() ?? "";
  if (result.exitCode !== 0 || path === "") {
    return null;
  }
  return path;
}

async function resolveQuestCliPath(commandRunner: CommandRunner): Promise<string | null> {
  const configured = process.env["QUEST_CLI"];
  if (configured === undefined || (!configured.includes("/") && !configured.includes("\\"))) {
    return resolveExecutablePath(configured ?? "quest", commandRunner);
  }
  try {
    await access(configured);
    return resolve(configured);
  } catch {
    return null;
  }
}

async function resolveGitExecPath(
  gitCliPath: string,
  commandRunner: CommandRunner,
): Promise<string | null> {
  const result = await commandRunner({
    args: ["--exec-path"],
    command: gitCliPath,
    cwd: process.cwd(),
  });
  const path = result.stdout.trim().split(/\r?\n/gu)[0]?.trim() ?? "";
  return result.exitCode === 0 && path !== "" ? path : null;
}

interface GitIdentity {
  readonly email: string | null;
  readonly name: string | null;
  readonly remoteUrl: string | null;
}

async function resolveGitIdentity(commandRunner: CommandRunner): Promise<GitIdentity> {
  const [nameResult, emailResult, remoteResult] = await Promise.all([
    commandRunner({
      args: ["config", "--get", "user.name"],
      command: "git",
      cwd: process.cwd(),
    }),
    commandRunner({
      args: ["config", "--get", "user.email"],
      command: "git",
      cwd: process.cwd(),
    }),
    commandRunner({
      args: ["remote", "get-url", "origin"],
      command: "git",
      cwd: process.cwd(),
    }),
  ]);
  const firstLine = (value: string): string | null => {
    const first = value.trim().split(/\r?\n/gu)[0]?.trim() ?? "";
    return first === "" ? null : first;
  };
  const remoteUrl = firstLine(remoteResult.stdout);
  if (remoteUrl !== null && hasEmbeddedCredentials(remoteUrl)) {
    throw new DispatchError(
      "DISPATCH_REMOTE_CREDENTIALS",
      "origin contains embedded credentials; remove them and use a dedicated GH_TOKEN or GITHUB_TOKEN before dispatching",
    );
  }
  return {
    email: firstLine(emailResult.stdout),
    name: firstLine(nameResult.stdout),
    remoteUrl,
  };
}

function hasEmbeddedCredentials(remoteUrl: string): boolean {
  try {
    const parsed = new URL(remoteUrl);
    if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") {
      return parsed.password !== "";
    }
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return false;
  }
}

function resolveExplicitGitHubToken(): string | null {
  const explicitToken = [process.env["GH_TOKEN"], process.env["GITHUB_TOKEN"]].find(
    (token) => token !== undefined && token.trim() !== "",
  );
  if (explicitToken !== undefined && explicitToken.trim() !== "") {
    return explicitToken;
  }
  return null;
}

interface SupportExecutable {
  readonly name: string;
  readonly path: string | null;
}

const MINIMUM_QUEST_CLI_VERSION = "0.7.0";
const MINIMUM_GUARDED_CLAUDE_VERSION = "2.1.169";
const MINIMUM_GUARDED_CODEX_VERSION = "0.144.6";
const questVersionReportSchema = z.object({
  schema: z.literal("quest.report/v1"),
  command: z.literal("version"),
  data: z.object({ version: z.string() }),
});

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
      value.trim(),
    );
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (
    ![major, minor, patch].every((component) => Number.isSafeInteger(component)) ||
    prerelease.some(
      (identifier) =>
        /^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  ) {
    return null;
  }
  return { major, minor, patch, prerelease };
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/u.test(left);
  const rightIsNumeric = /^\d+$/u.test(right);
  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }
  if (leftIsNumeric !== rightIsNumeric) {
    return leftIsNumeric ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemanticVersionCore(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) {
    return left.major > right.major ? 1 : -1;
  }
  if (left.minor !== right.minor) {
    return left.minor > right.minor ? 1 : -1;
  }
  if (left.patch !== right.patch) {
    return left.patch > right.patch ? 1 : -1;
  }
  return 0;
}

function compareSemanticVersions(left: SemanticVersion, right: SemanticVersion): number {
  const coreComparison = compareSemanticVersionCore(left, right);
  if (coreComparison !== 0) {
    return coreComparison;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

function meetsMinimumVersion(installed: SemanticVersion, minimum: SemanticVersion): boolean {
  return compareSemanticVersions(installed, minimum) >= 0;
}

function semanticVersionToken(value: string): string | undefined {
  return value.match(
    /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\b/u,
  )?.[0];
}

function guardedClaudeCompatibilityError(claudeCliPath: string, detail: string): DispatchError {
  return new DispatchError(
    "DISPATCH_GUARDED_CLAUDE_UNAVAILABLE",
    `guarded Claude at ${claudeCliPath} cannot provide native containment (${detail}); use Claude Code >=${MINIMUM_GUARDED_CLAUDE_VERSION} on macOS, Linux, or WSL2, or choose --trust full, then retry`,
  );
}

async function requireGuardedClaudeLinuxSandbox(
  claudeCliPath: string,
  commandRunner: CommandRunner,
): Promise<void> {
  const dependencies = await Promise.all(
    ["bwrap", "socat"].map(async (name) => ({
      name,
      path: await resolveExecutablePath(name, commandRunner),
    })),
  );
  const missingDependencies = dependencies
    .filter((dependency) => dependency.path === null)
    .map((dependency) => dependency.name);
  if (missingDependencies.length > 0) {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      "Linux sandbox dependencies are missing: " +
        missingDependencies.join(", ") +
        "; install bubblewrap and socat",
    );
  }

  const kernelResult = await commandRunner({
    args: ["-r"],
    command: "uname",
    cwd: process.cwd(),
    maxOutputChars: null,
  });
  const kernelRelease = kernelResult.stdout.trim();
  if (kernelResult.exitCode !== 0 || kernelRelease === "") {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      "Linux kernel capability could not be verified: " + commandOutput(kernelResult),
    );
  }
  const isWsl = /microsoft|wsl/iu.test(kernelRelease);
  const isWsl2 = /microsoft-standard|wsl2/iu.test(kernelRelease);
  if (isWsl && !isWsl2) {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      "WSL1 does not provide the kernel namespace support required by bubblewrap; use WSL2",
    );
  }

  const bwrapPath = dependencies.find((dependency) => dependency.name === "bwrap")?.path;
  if (bwrapPath === undefined || bwrapPath === null) {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      "bubblewrap was found inconsistently during the Linux sandbox preflight",
    );
  }
  const bwrapResult = await commandRunner({
    args: ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"],
    command: bwrapPath,
    cwd: process.cwd(),
    maxOutputChars: null,
    timeoutMs: ORCHESTRATION_COMMAND_TIMEOUT_MS,
  });
  if (bwrapResult.exitCode !== 0) {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      "bubblewrap self-test failed: " + commandOutput(bwrapResult),
    );
  }
}

export async function requireGuardedClaudeCompatibility(
  claudeCliPath: string,
  commandRunner: CommandRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "darwin" && platform !== "linux") {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      `native Claude sandbox is unavailable on ${platform}`,
    );
  }
  if (platform === "linux") {
    await requireGuardedClaudeLinuxSandbox(claudeCliPath, commandRunner);
  }

  const minimumVersion = parseSemanticVersion(MINIMUM_GUARDED_CLAUDE_VERSION);
  const versionResult = await commandRunner({
    args: ["--version"],
    command: claudeCliPath,
    cwd: process.cwd(),
    maxOutputChars: null,
  });
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  const versionToken = semanticVersionToken(versionOutput);
  const installedVersion =
    versionResult.exitCode === 0 && versionToken !== undefined
      ? parseSemanticVersion(versionToken)
      : null;
  if (
    minimumVersion === null ||
    installedVersion === null ||
    !meetsMinimumVersion(installedVersion, minimumVersion)
  ) {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      versionResult.exitCode !== 0
        ? commandOutput(versionResult)
        : `installed version is ${versionToken ?? "unknown"}`,
    );
  }

  const helpResult = await commandRunner({
    args: ["--help"],
    command: claudeCliPath,
    cwd: process.cwd(),
    maxOutputChars: null,
  });
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  const requiredFlags = [
    "--add-dir",
    "--allowed-tools",
    "--permission-mode",
    "--safe-mode",
    "--settings",
    "--setting-sources",
  ];
  const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
  if (helpResult.exitCode !== 0 || missingFlags.length > 0) {
    throw guardedClaudeCompatibilityError(
      claudeCliPath,
      missingFlags.length === 0
        ? commandOutput(helpResult)
        : `--help is missing ${missingFlags.join(", ")}`,
    );
  }
}

function guardedCodexCompatibilityError(codexCliPath: string, detail: string): DispatchError {
  return new DispatchError(
    "DISPATCH_GUARDED_CODEX_UNAVAILABLE",
    `guarded Codex at ${codexCliPath} cannot provide native containment (${detail}); install Codex CLI >=${MINIMUM_GUARDED_CODEX_VERSION} with the guarded dispatcher capabilities, or choose --trust full, then retry`,
  );
}

export async function requireGuardedCodexCompatibility(
  codexCliPath: string,
  commandRunner: CommandRunner,
): Promise<void> {
  const minimumVersion = parseSemanticVersion(MINIMUM_GUARDED_CODEX_VERSION);
  const versionResult = await commandRunner({
    args: ["--version"],
    command: codexCliPath,
    cwd: process.cwd(),
    maxOutputChars: null,
  });
  const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  const versionToken = semanticVersionToken(versionOutput);
  const installedVersion =
    versionResult.exitCode === 0 && versionToken !== undefined
      ? parseSemanticVersion(versionToken)
      : null;
  if (
    minimumVersion === null ||
    installedVersion === null ||
    !meetsMinimumVersion(installedVersion, minimumVersion)
  ) {
    throw guardedCodexCompatibilityError(
      codexCliPath,
      versionResult.exitCode !== 0
        ? commandOutput(versionResult)
        : `installed version is ${versionToken ?? "unknown"}`,
    );
  }

  const helpResult = await commandRunner({
    args: ["exec", "--help"],
    command: codexCliPath,
    cwd: process.cwd(),
    maxOutputChars: null,
  });
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  const requiredFlags = [
    "--add-dir",
    "--cd",
    "--config",
    "--ephemeral",
    "--ignore-rules",
    "--ignore-user-config",
    "--skip-git-repo-check",
  ];
  const missingFlags = requiredFlags.filter((flag) => !help.includes(flag));
  if (helpResult.exitCode !== 0 || missingFlags.length > 0) {
    throw guardedCodexCompatibilityError(
      codexCliPath,
      missingFlags.length === 0
        ? commandOutput(helpResult)
        : `exec --help is missing ${missingFlags.join(", ")}`,
    );
  }
}

function questCliCompatibilityError(questCliPath: string, detail: string): DispatchError {
  return new DispatchError(
    "DISPATCH_QUEST_CLI_INCOMPATIBLE",
    `Quest CLI at ${questCliPath} is not compatible with dispatcher trust rework (${detail}); upgrade Quest CLI to >=${MINIMUM_QUEST_CLI_VERSION}. It must support --format json, next --claim, and --skip-after-reopens <count>, then retry`,
  );
}

export async function requireQuestCliCompatibility(
  questCliPath: string,
  repoRoot: string,
  commandRunner: CommandRunner,
): Promise<void> {
  const minimumVersion = parseSemanticVersion(MINIMUM_QUEST_CLI_VERSION);
  if (minimumVersion === null) {
    throw new DispatchError(
      "DISPATCH_CONFIGURATION",
      `dispatcher minimum Quest CLI version is invalid: ${MINIMUM_QUEST_CLI_VERSION}`,
    );
  }

  const versionResult = await commandRunner({
    args: ["--format", "json", "--version"],
    command: questCliPath,
    cwd: repoRoot,
    maxOutputChars: null,
  });
  if (versionResult.exitCode !== 0) {
    throw questCliCompatibilityError(questCliPath, commandOutput(versionResult));
  }

  let version: string;
  try {
    version = questVersionReportSchema.parse(JSON.parse(versionResult.stdout)).data.version;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw questCliCompatibilityError(questCliPath, `version report was invalid: ${detail}`);
  }
  const installedVersion = parseSemanticVersion(version);
  if (installedVersion === null || !meetsMinimumVersion(installedVersion, minimumVersion)) {
    throw questCliCompatibilityError(questCliPath, `installed version is ${version}`);
  }

  const helpResult = await commandRunner({
    args: ["next", "--help"],
    command: questCliPath,
    cwd: repoRoot,
    maxOutputChars: null,
  });
  const help = `${helpResult.stdout}\n${helpResult.stderr}`;
  const missingFlags = ["--claim", "--skip-after-reopens"].filter((flag) => !help.includes(flag));
  if (helpResult.exitCode !== 0 || missingFlags.length > 0) {
    throw questCliCompatibilityError(
      questCliPath,
      missingFlags.length === 0
        ? commandOutput(helpResult)
        : `next --help is missing ${missingFlags.join(", ")}`,
    );
  }
}

async function resolveSupportExecutablePaths(
  commandRunner: CommandRunner,
): Promise<readonly SupportExecutable[]> {
  const names = [
    { name: "gh", command: "gh" },
    { name: "bun", command: "bun" },
    { name: "bunx", command: "bunx" },
    { name: "git", command: "git" },
  ];
  const supportExecutables = await Promise.all(
    names.map(async (executable) => ({
      name: executable.name,
      path: await resolveExecutablePath(executable.command, commandRunner),
    })),
  );
  return [{ name: "quest", path: await resolveQuestCliPath(commandRunner) }, ...supportExecutables];
}

async function resolveAndPreflightQuestCli(
  supportCliPaths: readonly SupportExecutable[],
  repoRoot: string,
  commandRunner: CommandRunner,
): Promise<string> {
  const questCliPath = supportCliPaths.find(
    (supportExecutable) => supportExecutable.name === "quest",
  )?.path;
  if (questCliPath === undefined || questCliPath === null) {
    throw new DispatchError(
      "DISPATCH_SUPPORT_CLI_MISSING",
      "quest was not found on PATH; install it before dispatching work, then retry",
    );
  }
  await requireQuestCliCompatibility(questCliPath, repoRoot, commandRunner);
  return questCliPath;
}

function questCommand(
  questCliPath: string | null | undefined,
  repoRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): CommandSpec {
  return {
    args: ["--format", "json", "next", "--claim", "--brief"],
    command: questCliPath ?? process.env["QUEST_CLI"] ?? "quest",
    cwd: repoRoot,
    env: environment,
    maxOutputChars: null,
  };
}

function questCliCommand(runtime: DispatchRuntime): string {
  return runtime.questCliPath ?? process.env["QUEST_CLI"] ?? "quest";
}

function dispatcherSessionAttribution(
  options: DispatchOptions,
  runtime: DispatchRuntime,
): WorkerSessionAttribution {
  return workerSessionAttribution({
    agent: options.agent,
    claudeArgs: options.claudeArgs,
    codexArgs: options.codexArgs,
    codexAuthConfig: runtime.codexAuthConfig,
    useCodexConfig: options.agent !== "codex" || options.trust === "full",
  });
}

function questEnvironment(
  owner: string,
  guild: string | undefined,
  sessionAttribution: WorkerSessionAttribution = {},
): Record<string, string | undefined> {
  const effectiveGuild = guild ?? process.env["QUEST_GUILD"];
  return {
    QUEST_IDENTITY: owner,
    ...(effectiveGuild === undefined ? {} : { QUEST_GUILD: effectiveGuild }),
    ...sessionAttributionEnvironment(sessionAttribution),
  };
}

function touchCommand(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  target: Pick<WorkerInvocation, "owner" | "questId">,
  timeoutMs: number,
): CommandSpec {
  return {
    args: ["--format", "json", "touch", String(target.questId), "--as", target.owner],
    command: questCliCommand(runtime),
    cwd: runtime.repoRoot,
    env: questEnvironment(
      target.owner,
      options.guild,
      dispatcherSessionAttribution(options, runtime),
    ),
    timeoutMs,
  };
}

interface QuestLeaseHeartbeat {
  readonly currentFailure: string | null;
  readonly failure: Promise<string | null>;
  stop(): Promise<void>;
}

interface QuestLeaseTarget {
  readonly leaseObservedAt: string;
  readonly owner: string;
  readonly questId: number;
  readonly leaseExpiresAt: string | null;
}

function dispatchHeartbeatWindowMs(target: QuestLeaseTarget): number {
  if (target.leaseExpiresAt === null) {
    return DISPATCH_HEARTBEAT_WINDOW_MS;
  }
  const leaseRemainingMs = Date.parse(target.leaseExpiresAt) - Date.parse(target.leaseObservedAt);
  if (!Number.isFinite(leaseRemainingMs)) {
    return DISPATCH_HEARTBEAT_WINDOW_MS;
  }
  return Math.max(1000, Math.min(DISPATCH_HEARTBEAT_WINDOW_MS, leaseRemainingMs));
}

function dispatchHeartbeatIntervalMs(
  target: QuestLeaseTarget,
  configuredIntervalMs: number | undefined,
): number {
  const heartbeatWindowMs = dispatchHeartbeatWindowMs(target);
  return Math.max(
    1,
    Math.min(configuredIntervalMs ?? heartbeatWindowMs / 3, heartbeatWindowMs / 3),
  );
}

function parseTouchLease(
  result: CommandResult,
): { readonly leaseExpiresAt: string | null; readonly leaseObservedAt: string } | null {
  try {
    const parsed = touchReportSchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) {
      return null;
    }
    return {
      leaseExpiresAt: parsed.data.data.quest.lease_expires_at,
      leaseObservedAt: parsed.data.generated_at,
    };
  } catch {
    return null;
  }
}

function timedCommand(
  commandRunner: CommandRunner,
  spec: CommandSpec,
  timeoutMs: number,
): Promise<CommandResult> {
  return commandRunner({ ...spec, timeoutMs: spec.timeoutMs ?? timeoutMs });
}

function orchestrationSpec(runtime: DispatchRuntime, spec: CommandSpec): CommandSpec {
  return {
    ...spec,
    timeoutMs: spec.timeoutMs ?? runtime.commandTimeoutMs ?? ORCHESTRATION_COMMAND_TIMEOUT_MS,
  };
}

function runOrchestrationCommand(
  runtime: DispatchRuntime,
  spec: CommandSpec,
): Promise<CommandResult> {
  return runtime.runCommand(orchestrationSpec(runtime, spec));
}

function startQuestLeaseHeartbeat(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  target: QuestLeaseTarget,
): QuestLeaseHeartbeat {
  let currentTarget = target;
  let intervalMs = dispatchHeartbeatIntervalMs(currentTarget, runtime.heartbeatIntervalMs);
  let failureMessage: string | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveFailure: ((message: string | null) => void) | undefined;
  let stopped = false;
  const failure = new Promise<string | null>((resolveFailurePromise) => {
    resolveFailure = resolveFailurePromise;
  });

  const recordFailure = (message: string): void => {
    if (failureMessage !== null) {
      return;
    }
    failureMessage = message;
    resolveFailure?.(message);
  };

  function scheduleRenewal(delayMs: number): void {
    if (stopped || failureMessage !== null) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      renew();
    }, delayMs);
  }

  function renew(): void {
    if (stopped || failureMessage !== null || inFlight !== null) {
      return;
    }
    const heartbeatWindowMs = dispatchHeartbeatWindowMs(currentTarget);
    const timeoutMs =
      runtime.heartbeatTimeoutMs ?? Math.max(1000, Math.min(heartbeatWindowMs / 3, intervalMs));
    inFlight = timedCommand(
      runtime.runCommand,
      touchCommand(options, runtime, currentTarget, timeoutMs),
      timeoutMs,
    )
      .then((result) => {
        if (result.exitCode !== 0) {
          recordFailure(
            `quest ${currentTarget.questId} lease renewal failed: ${commandOutput(result)}`,
          );
          return;
        }
        const renewedLease = parseTouchLease(result);
        if (renewedLease === null) {
          recordFailure(
            `quest ${currentTarget.questId} lease renewal returned an invalid JSON report; rerun with --format json and retry`,
          );
          return;
        }
        currentTarget = { ...currentTarget, ...renewedLease };
        intervalMs = dispatchHeartbeatIntervalMs(currentTarget, runtime.heartbeatIntervalMs);
        scheduleRenewal(intervalMs);
      })
      .catch((error: unknown) => {
        recordFailure(
          `quest ${currentTarget.questId} lease renewal failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        inFlight = null;
      });
  }

  scheduleRenewal(intervalMs);
  const leaseRemainingMs =
    target.leaseExpiresAt === null
      ? null
      : Date.parse(target.leaseExpiresAt) - Date.parse(target.leaseObservedAt);
  if (
    leaseRemainingMs !== null &&
    Number.isFinite(leaseRemainingMs) &&
    leaseRemainingMs <= intervalMs
  ) {
    renew();
  }

  return {
    get currentFailure(): string | null {
      return failureMessage;
    },
    failure,
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (inFlight !== null) {
        await inFlight;
      }
      if (failureMessage === null) {
        resolveFailure?.(null);
      }
    },
  };
}

function workerPlan(claimed: ClaimedQuest, worktreeRoot: string): WorkerPlan {
  const slug = slugifyQuestTitle(claimed.quest.title);
  const branchSuffix =
    claimed.quest.reopen_count === 0 ? "" : `-attempt-${claimed.quest.reopen_count + 1}`;
  return {
    branch: `quest/${claimed.quest.id}-${slug}${branchSuffix}`,
    branchSuffix,
    worktreePath: join(worktreeRoot, `${claimed.quest.id}-${slug}${branchSuffix}`),
  };
}

function gitConfigValue(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/[\r\n]/gu, " ")}"`;
}

function shellSingleQuoted(value: string): string {
  return "'" + value.replace(/'/gu, "'\\''") + "'";
}

function windowsBatchQuoted(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function workerBinPathForHome(workerHomePath: string): string {
  return join(dirname(workerHomePath), `${basename(workerHomePath)}-bin`);
}

function windowsBunShim(bunCliPath: string): string {
  return [
    "@echo off",
    "setlocal EnableExtensions",
    'set "QUEST_BUN_INSTALL=0"',
    'for %%A in (%*) do if /I "%%~A"=="install" set "QUEST_BUN_INSTALL=1"',
    'if "%QUEST_BUN_INSTALL%"=="1" (',
    '  set "GH_TOKEN="',
    '  set "GITHUB_TOKEN="',
    ")",
    `call ${windowsBatchQuoted(bunCliPath)} %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

async function createWorkerHome(
  gitIdentity: GitIdentity,
  bunCliPath: string,
  questStore?: Config["store"],
): Promise<{ readonly binPath: string; readonly path: string }> {
  // Keep Codex's process root outside the checkout so it cannot discover project config from the repository.
  const workerHomePath = await mkdtemp(join(tmpdir(), "quest-worker-home-"));
  const workerBinPath = workerBinPathForHome(workerHomePath);
  try {
    await mkdir(workerBinPath);
    await mkdir(join(workerHomePath, ".config", "gh"), { recursive: true });
    const questConfigDirectory =
      process.platform === "win32"
        ? join(workerHomePath, "AppData", "Roaming", "quest")
        : join(workerHomePath, ".config", "quest");
    await mkdir(questConfigDirectory, { recursive: true });
    if (questStore !== undefined) {
      await writeFile(join(questConfigDirectory, "config.toml"), questStoreConfigToml(questStore), {
        mode: 0o600,
      });
    }
    await mkdir(join(workerHomePath, "tmp"), { recursive: true });
    if (bunCliPath !== "bun") {
      const shimPath =
        process.platform === "win32" ? join(workerBinPath, "bun.cmd") : join(workerBinPath, "bun");
      const shimContents =
        process.platform === "win32"
          ? windowsBunShim(bunCliPath)
          : [
              "#!/bin/sh",
              'for argument in "$@"; do',
              '  if [ "$argument" = "install" ]; then',
              "    unset GH_TOKEN GITHUB_TOKEN",
              "    break",
              "  fi",
              "done",
              `exec ${shellSingleQuoted(bunCliPath)} "$@"`,
              "",
            ].join("\n");
      await writeFile(shimPath, shimContents, { mode: 0o700 });
    }
    await writeFile(
      join(workerHomePath, ".gitconfig"),
      [
        "[credential]",
        "\thelper = !gh auth git-credential",
        "",
        '[url "https://github.com/"]',
        "\tinsteadOf = git@github.com:",
        "\tinsteadOf = ssh://git@github.com/",
        ...(gitIdentity.name === null || gitIdentity.email === null
          ? []
          : [
              "",
              "[user]",
              `\tname = ${gitConfigValue(gitIdentity.name)}`,
              `\temail = ${gitConfigValue(gitIdentity.email)}`,
            ]),
        ...(gitIdentity.remoteUrl === null
          ? []
          : ["", '[remote "origin"]', `\turl = ${gitConfigValue(gitIdentity.remoteUrl)}`]),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    return { path: workerHomePath, binPath: workerBinPath };
  } catch (error) {
    await rm(workerHomePath, { force: true, recursive: true });
    await rm(workerBinPath, { force: true, recursive: true });
    throw error;
  }
}

type WorkerHomePreparation =
  | { readonly binPath: string; readonly error: null; readonly path: string }
  | { readonly binPath: null; readonly error: string; readonly path: null };

async function prepareWorkerHome(
  gitIdentity: GitIdentity,
  bunCliPath: string,
  questStore?: Config["store"],
): Promise<WorkerHomePreparation> {
  try {
    const workerHome = await createWorkerHome(gitIdentity, bunCliPath, questStore);
    return {
      binPath: workerHome.binPath,
      error: null,
      path: workerHome.path,
    };
  } catch (error) {
    return {
      binPath: null,
      error: `isolated worker home could not be created: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path: null,
    };
  }
}

function isSuccessfulQuestState(status: Quest["status"]): boolean {
  return status === "turned_in" || status === "complete";
}

async function claimNextQuest(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  slot: number,
): Promise<ClaimNextResult> {
  const owner = `quest-dispatch/${runtime.dispatchId ?? `${runtime.host}/${runtime.processId}`}/${slot}`;
  const environment = questEnvironment(
    owner,
    options.guild,
    dispatcherSessionAttribution(options, runtime),
  );
  const command = questCommand(runtime.questCliPath, runtime.repoRoot, environment);
  if (runtime.commandSignal?.aborted) {
    return {
      claimed: null,
      warnings: ["dispatcher interrupted before claiming another quest"],
    };
  }
  const result = await runOrchestrationCommand(runtime, {
    ...command,
    args: [...command.args, "--skip-after-reopens", String(options.skipAfterReopens)],
  });
  if (result.exitCode !== 0) {
    if (runtime.commandSignal?.aborted === true || result.exitCode === 130) {
      return {
        claimed: null,
        warnings: [`dispatcher interrupted while claiming quest for worker ${owner}`],
      };
    }
    throw new DispatchError(
      "DISPATCH_CLAIM_FAILED",
      `quest next --claim failed for worker ${owner}: ${commandOutput(result)}; repair the CLI or store and retry`,
    );
  }

  let report: z.infer<typeof nextReportSchema>;
  try {
    report = nextReportSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DispatchError(
      "DISPATCH_INVALID_CLAIM_REPORT",
      `quest next returned a response that is not quest.report/v1 (${detail}); rerun with --format json and retry`,
    );
  }

  if (!report.data.claimed || report.data.quest === null) {
    return { claimed: null, warnings: report.warnings };
  }
  if (report.data.brief === null) {
    throw new DispatchError(
      "DISPATCH_INVALID_CLAIM_REPORT",
      `quest next claimed quest ${report.data.quest.id} without a briefing package; rerun with --format json next --claim --brief`,
    );
  }
  return {
    claimed: {
      brief: report.data.brief,
      leaseObservedAt: report.generated_at,
      owner,
      quest: report.data.quest,
    },
    warnings: report.warnings,
  };
}

function lockCommand(
  runtime: DispatchRuntime,
  action: "claim" | "release",
  worker: { readonly branch: string; readonly owner: string; readonly path: string },
  baseRef?: string,
  releaseStatus: "handoff" | "released" = "handoff",
): CommandSpec {
  if (action === "claim") {
    if (baseRef === undefined) {
      throw new DispatchError(
        "DISPATCH_LOCK_CONFIGURATION",
        "worktree lock claim is missing its base ref; provide --base-ref and retry",
      );
    }
    return {
      args: [
        runtime.lockScript,
        "claim",
        "--repo",
        basename(runtime.repoRoot),
        "--environment",
        runtime.environment,
        "--host",
        runtime.host,
        "--path",
        worker.path,
        "--branch",
        worker.branch,
        "--base-ref",
        baseRef,
        "--owner",
        worker.owner,
        "--purpose",
        `Quest dispatcher worker ${worker.branch}`,
      ],
      command: runtime.pythonCommand,
      cwd: runtime.repoRoot,
    };
  }

  return {
    args: [
      runtime.lockScript,
      "release",
      "--environment",
      runtime.environment,
      "--path",
      worker.path,
      "--owner",
      worker.owner,
      "--status",
      releaseStatus,
    ],
    command: runtime.pythonCommand,
    cwd: runtime.repoRoot,
  };
}

interface GitRootsResult {
  readonly error: string | null;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
}

async function captureGitPointerSnapshot(worktreePath: string): Promise<GitPointerSnapshot> {
  const pointerPath = join(worktreePath, ".git");
  const stats = await lstat(pointerPath);
  if (!stats.isFile()) {
    throw new Error("linked worktree .git pointer is not a regular file");
  }
  return {
    content: await readFile(pointerPath, "utf8"),
    device: stats.dev,
    inode: stats.ino,
  };
}

async function gitPointerSnapshotMatches(invocation: WorkerInvocation): Promise<boolean> {
  const snapshot = invocation.gitPointerSnapshot;
  if (snapshot === null) {
    return false;
  }
  try {
    const pointerPath = join(invocation.worktreePath, ".git");
    const stats = await lstat(pointerPath);
    return (
      stats.isFile() &&
      stats.dev === snapshot.device &&
      stats.ino === snapshot.inode &&
      (await readFile(pointerPath, "utf8")) === snapshot.content
    );
  } catch {
    return false;
  }
}

async function verifyGitPointer(
  invocation: WorkerInvocation,
  warnings: string[],
): Promise<boolean> {
  if (await gitPointerSnapshotMatches(invocation)) {
    return true;
  }
  warnings.push(
    `linked worktree .git pointer changed while quest ${invocation.questId} was running; refusing lock handoff and preserving worker state for recovery`,
  );
  return false;
}

async function verifyGitBranch(
  runtime: DispatchRuntime,
  invocation: WorkerInvocation,
  warnings: string[],
): Promise<boolean> {
  const symbolicHead = await runOrchestrationCommand(runtime, {
    args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
    command: "git",
    cwd: invocation.worktreePath,
    ignoreCommandSignal: true,
  });
  const currentBranch = symbolicHead.stdout.trim();
  if (symbolicHead.exitCode !== 0 || currentBranch !== invocation.branch) {
    warnings.push(
      `worker Git HEAD is not attached to dispatched branch ${invocation.branch} for quest ${invocation.questId}; found ${currentBranch === "" ? "detached HEAD" : currentBranch}; preserving worker state for recovery`,
    );
    return false;
  }

  const branchTip = await runOrchestrationCommand(runtime, {
    args: ["rev-parse", "--verify", `refs/heads/${invocation.branch}^{commit}`],
    command: "git",
    cwd: invocation.worktreePath,
    ignoreCommandSignal: true,
  });
  if (branchTip.exitCode !== 0 || branchTip.stdout.trim() === "") {
    warnings.push(
      `dispatched branch ${invocation.branch} has no valid commit for quest ${invocation.questId}; preserving worker state for recovery`,
    );
    return false;
  }
  return true;
}

async function resolveGitWritableRoots(
  runtime: DispatchRuntime,
  worktreePath: string,
  ignoreCommandSignal = false,
): Promise<GitRootsResult> {
  const gitDirectories = await runOrchestrationCommand(runtime, {
    args: ["rev-parse", "--git-dir", "--git-common-dir"],
    command: "git",
    cwd: worktreePath,
    ignoreCommandSignal,
  });
  if (gitDirectories.exitCode !== 0) {
    return {
      error: `Git metadata paths could not be resolved: ${commandOutput(gitDirectories)}`,
      readableRoots: [],
      writableRoots: [],
    };
  }
  const roots = gitDirectories.stdout
    .split(/\r?\n/gu)
    .map((gitDirectory) => gitDirectory.trim())
    .filter((gitDirectory) => gitDirectory !== "")
    .map((gitDirectory) => resolve(worktreePath, gitDirectory));
  return roots.length === 2
    ? {
        error: null,
        readableRoots: [roots[1] ?? worktreePath],
        // Native worktrees keep their index, objects, and refs in the shared repository.
        // Guarded workers can edit the checkout, but full trust is required for Git writes.
        writableRoots: [roots[0] ?? worktreePath],
      }
    : {
        error: "Git returned incomplete metadata paths; retry from a valid linked worktree",
        readableRoots: [],
        writableRoots: [],
      };
}

async function reserveWorktreeDirectory(worktreePath: string): Promise<string | null> {
  try {
    await mkdir(dirname(worktreePath), { recursive: true });
    await mkdir(worktreePath);
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return `worktree destination already exists at ${worktreePath}; remove it or choose a different worktree root, then retry`;
    }
    return `worktree destination could not be reserved: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function preparationFailure(input: {
  readonly branchCreated: boolean;
  readonly branch: string;
  readonly cleanupWarnings: readonly string[];
  readonly error: string;
  readonly lockClaimed: boolean;
  readonly owner: string;
  readonly quest: Quest;
  readonly workerHomePath: string | null;
  readonly worktreeCreated: boolean;
  readonly worktreePath: string;
}): PreparationResult {
  return {
    outcome: "failed",
    failure: input,
  };
}

function selectedWorkerCliPath(
  options: DispatchOptions,
  runtime: DispatchRuntime,
): string | undefined {
  return options.agent === "codex"
    ? (runtime.codexCliPath ?? undefined)
    : (runtime.claudeCliPath ?? undefined);
}

function workerSupportPaths(runtime: DispatchRuntime): string[] {
  return [
    ...(runtime.supportCliPaths ?? []),
    ...(runtime.gitExecPath === undefined || runtime.gitExecPath === null
      ? []
      : [runtime.gitExecPath]),
    ...(runtime.nodeCliPath === undefined || runtime.nodeCliPath === null
      ? []
      : [runtime.nodeCliPath]),
  ];
}

async function createPreparedWorkerInvocation(input: {
  readonly branchSuffix: string;
  readonly claimed: ClaimedQuest;
  readonly gitRoots: GitRootsResult;
  readonly gitPointerSnapshot: GitPointerSnapshot;
  readonly options: DispatchOptions;
  readonly plan: WorkerPlan;
  readonly runtime: DispatchRuntime;
  readonly workerHomePath: string;
}): Promise<WorkerInvocation> {
  const briefFileName = `${WORKER_BRIEF_FILE_PREFIX}${input.claimed.quest.id}-${randomUUID()}.json`;
  const briefPath = join(input.workerHomePath, briefFileName);
  await writeFile(briefPath, `${JSON.stringify(input.claimed.brief)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return createWorkerInvocation({
    agent: input.options.agent,
    branchSuffix: input.branchSuffix,
    guild: input.options.guild ?? process.env["QUEST_GUILD"],
    gitReadableRoots: input.gitRoots.readableRoots,
    gitWritableRoots: input.gitRoots.writableRoots,
    trust: input.options.trust,
    claudeArgs: input.options.claudeArgs,
    codexArgs: input.options.codexArgs,
    codexAuthConfig: input.runtime.codexAuthConfig ?? undefined,
    githubToken: input.runtime.githubToken ?? undefined,
    hostHomePath: input.runtime.hostHomePath ?? homedir(),
    hostCodexHomeOverridePath: input.runtime.hostCodexHomeOverridePath ?? undefined,
    hostClaudeConfigPath: input.runtime.hostClaudeConfigOverridePath ?? undefined,
    questCliPath: input.runtime.questCliPath ?? undefined,
    questBackendDomains: input.runtime.questBackendDomains,
    questRepositoryName: input.runtime.questRepositoryName,
    workerBinPath: workerBinPathForHome(input.workerHomePath),
    workerSupportPaths: workerSupportPaths(input.runtime),
    workerCliPath: selectedWorkerCliPath(input.options, input.runtime),
    gitPointerSnapshot: input.gitPointerSnapshot,
    owner: input.claimed.owner,
    briefFileName,
    briefPath,
    quest: input.claimed.quest,
    workerHomePath: input.workerHomePath,
    worktreePath: input.plan.worktreePath,
  });
}

async function finalizeWorkerPreparation(input: {
  readonly branchCreated: boolean;
  readonly branchSuffix: string;
  readonly claimed: ClaimedQuest;
  readonly cleanupWarnings: readonly string[];
  readonly gitRoots: GitRootsResult;
  readonly gitPointerSnapshot: GitPointerSnapshot;
  readonly options: DispatchOptions;
  readonly plan: WorkerPlan;
  readonly runtime: DispatchRuntime;
  readonly workerHomePath: string;
}): Promise<PreparationResult> {
  return {
    outcome: "ready",
    invocation: await createPreparedWorkerInvocation({
      branchSuffix: input.branchSuffix,
      claimed: input.claimed,
      gitRoots: input.gitRoots,
      gitPointerSnapshot: input.gitPointerSnapshot,
      options: input.options,
      plan: input.plan,
      runtime: input.runtime,
      workerHomePath: input.workerHomePath,
    }),
  };
}

interface WorkerWorktreePreparation {
  readonly branchCreated: boolean;
  readonly error: string | null;
  readonly worktreeCreated: boolean;
}

async function prepareLinkedWorktree(input: {
  readonly baseRef: string;
  readonly branch: string;
  readonly runtime: DispatchRuntime;
  readonly worktreePath: string;
}): Promise<WorkerWorktreePreparation> {
  const branch = await runOrchestrationCommand(input.runtime, {
    args: ["-c", "core.hooksPath=/dev/null", "branch", "--no-track", input.branch, input.baseRef],
    command: "git",
    cwd: input.runtime.repoRoot,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    isolatedEnvironment: true,
  });
  if (branch.exitCode !== 0) {
    return {
      branchCreated: false,
      error: `git branch creation failed: ${commandOutput(branch)}`,
      worktreeCreated: false,
    };
  }
  const branchHead = await runOrchestrationCommand(input.runtime, {
    args: ["rev-parse", "--verify", `refs/heads/${input.branch}`],
    command: "git",
    cwd: input.runtime.repoRoot,
    ignoreCommandSignal: true,
  });
  const expectedHead = branchHead.stdout.trim();
  if (branchHead.exitCode !== 0 || expectedHead === "") {
    return {
      branchCreated: true,
      error: `created branch ${input.branch} could not be verified: ${commandOutput(branchHead)}`,
      worktreeCreated: false,
    };
  }
  // Atomic directory creation reserves this destination for this setup attempt. If Git is
  // interrupted before registering the worktree, cleanup can still remove only our reservation.
  const reservationError = await reserveWorktreeDirectory(input.worktreePath);
  if (reservationError !== null) {
    return {
      branchCreated: true,
      error: reservationError,
      worktreeCreated: false,
    };
  }
  const worktree = await runOrchestrationCommand(input.runtime, {
    args: ["-c", "core.hooksPath=/dev/null", "worktree", "add", input.worktreePath, input.branch],
    command: "git",
    cwd: input.runtime.repoRoot,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    isolatedEnvironment: true,
  });
  if (worktree.exitCode === 0) {
    return { branchCreated: true, error: null, worktreeCreated: true };
  }
  return {
    branchCreated: true,
    error: `git worktree add failed: ${commandOutput(worktree)}`,
    worktreeCreated: true,
  };
}

async function prepareWorker(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  claimed: ClaimedQuest,
  worktreeRoot: string,
): Promise<PreparationResult> {
  const plan = workerPlan(claimed, worktreeRoot);
  const { branch, branchSuffix, worktreePath } = plan;
  const lockWorker = { branch, owner: claimed.owner, path: worktreePath };
  let lockClaimed = false;
  let branchCreated = false;
  let worktreeCreated = false;
  let workerHomePath: string | null = null;
  let gitPointerSnapshot: GitPointerSnapshot | null = null;
  const cleanupWarnings: string[] = [];

  const workerHome = await prepareWorkerHome(
    {
      email: runtime.gitUserEmail ?? null,
      name: runtime.gitUserName ?? null,
      remoteUrl: runtime.gitRemoteUrl ?? null,
    },
    runtime.bunCliPath ?? "bun",
    runtime.questStore,
  );
  if (workerHome.error !== null) {
    return preparationFailure({
      branchCreated,
      branch,
      cleanupWarnings,
      error: workerHome.error,
      lockClaimed,
      owner: claimed.owner,
      quest: claimed.quest,
      workerHomePath,
      worktreeCreated,
      worktreePath,
    });
  }
  workerHomePath = workerHome.path;

  const lock = await runOrchestrationCommand(
    runtime,
    lockCommand(runtime, "claim", lockWorker, options.baseRef),
  );
  if (lock.exitCode !== 0) {
    return preparationFailure({
      branchCreated,
      branch,
      cleanupWarnings,
      error: `worktree lock claim failed: ${commandOutput(lock)}`,
      lockClaimed,
      owner: claimed.owner,
      quest: claimed.quest,
      workerHomePath,
      worktreeCreated,
      worktreePath,
    });
  }
  lockClaimed = true;

  const worktreePreparation = await prepareLinkedWorktree({
    baseRef: options.baseRef,
    branch,
    runtime,
    worktreePath,
  });
  if (worktreePreparation.error !== null) {
    return preparationFailure({
      branchCreated: worktreePreparation.branchCreated,
      branch,
      cleanupWarnings,
      error: worktreePreparation.error,
      lockClaimed,
      owner: claimed.owner,
      quest: claimed.quest,
      workerHomePath,
      worktreeCreated: worktreePreparation.worktreeCreated,
      worktreePath,
    });
  }
  worktreeCreated = worktreePreparation.worktreeCreated;
  branchCreated = worktreePreparation.branchCreated;

  try {
    gitPointerSnapshot = await captureGitPointerSnapshot(worktreePath);
  } catch (error) {
    return preparationFailure({
      branchCreated,
      branch,
      cleanupWarnings,
      error: `linked worktree .git pointer could not be captured: ${
        error instanceof Error ? error.message : String(error)
      }`,
      lockClaimed,
      owner: claimed.owner,
      quest: claimed.quest,
      workerHomePath,
      worktreeCreated,
      worktreePath,
    });
  }

  const gitRoots = await resolveGitWritableRoots(runtime, worktreePath);
  if (gitRoots.error !== null) {
    return preparationFailure({
      branchCreated,
      branch,
      cleanupWarnings,
      error: `linked worktree metadata could not be captured: ${gitRoots.error}`,
      lockClaimed,
      owner: claimed.owner,
      quest: claimed.quest,
      workerHomePath,
      worktreeCreated,
      worktreePath,
    });
  }

  try {
    return await finalizeWorkerPreparation({
      branchCreated,
      branchSuffix,
      claimed,
      cleanupWarnings,
      gitRoots,
      gitPointerSnapshot,
      options,
      plan,
      runtime,
      workerHomePath: workerHome.path,
    });
  } catch (error) {
    return preparationFailure({
      branchCreated,
      branch,
      cleanupWarnings,
      error: `worker setup could not be completed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      lockClaimed,
      owner: claimed.owner,
      quest: claimed.quest,
      workerHomePath,
      worktreeCreated,
      worktreePath,
    });
  }
}

async function cleanupPreparedWorker(
  runtime: DispatchRuntime,
  failure: PreparationFailure,
  warnings: string[],
): Promise<void> {
  if (failure.worktreeCreated) {
    const removed = await runOrchestrationCommand(runtime, {
      args: ["worktree", "remove", "--force", "--force", failure.worktreePath],
      command: "git",
      cwd: runtime.repoRoot,
      ignoreCommandSignal: true,
    });
    if (removed.exitCode !== 0) {
      warnings.push(
        `worktree cleanup failed for quest ${failure.quest.id}: ${commandOutput(removed)}`,
      );
    }
    try {
      await rm(failure.worktreePath, { force: true, recursive: true });
    } catch (error) {
      warnings.push(
        `partial worktree directory cleanup failed for quest ${failure.quest.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (failure.branchCreated) {
    const branchDeleted = await runOrchestrationCommand(runtime, {
      args: ["branch", "-D", "--", failure.branch],
      command: "git",
      cwd: runtime.repoRoot,
      ignoreCommandSignal: true,
    });
    if (branchDeleted.exitCode !== 0) {
      warnings.push(
        `branch cleanup failed for quest ${failure.quest.id}: ${commandOutput(branchDeleted)}`,
      );
    }
  }
}

async function cleanupWorkerDirectory(
  path: string,
  description: string,
  questId: number,
  warnings: string[],
): Promise<void> {
  try {
    await rm(path, { force: true, recursive: true });
  } catch (error) {
    warnings.push(
      `${description} cleanup failed for quest ${questId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function abandonClaimedQuest(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  failure: PreparationFailure,
  warnings: string[],
): Promise<void> {
  if (failure.workerHomePath !== null) {
    await cleanupWorkerDirectory(failure.workerHomePath, "worker home", failure.quest.id, warnings);
    await cleanupWorkerDirectory(
      workerBinPathForHome(failure.workerHomePath),
      "worker runtime bin",
      failure.quest.id,
      warnings,
    );
  }

  await cleanupPreparedWorker(runtime, failure, warnings);

  if (failure.lockClaimed) {
    const released = await runOrchestrationCommand(runtime, {
      ...lockCommand(
        runtime,
        "release",
        {
          branch: failure.branch,
          owner: failure.owner,
          path: failure.worktreePath,
        },
        undefined,
        "released",
      ),
      ignoreCommandSignal: true,
    });
    if (released.exitCode !== 0) {
      warnings.push(
        `worktree lock release failed for quest ${failure.quest.id}: ${commandOutput(released)}`,
      );
    }
  }

  const abandoned = await runOrchestrationCommand(runtime, {
    args: ["abandon", String(failure.quest.id), "--as", failure.owner],
    command: questCliCommand(runtime),
    cwd: runtime.repoRoot,
    env: questEnvironment(
      failure.owner,
      options.guild,
      dispatcherSessionAttribution(options, runtime),
    ),
    ignoreCommandSignal: true,
  });
  if (abandoned.exitCode !== 0) {
    warnings.push(`quest ${failure.quest.id} could not be released: ${commandOutput(abandoned)}`);
  }
}

interface QuestInspection {
  readonly error: string | null;
  readonly quest: Quest | null;
}

async function inspectWorkerQuest(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  invocation: WorkerInvocation,
): Promise<QuestInspection> {
  const result = await runOrchestrationCommand(runtime, {
    args: ["--format", "json", "show", String(invocation.questId)],
    command: questCliCommand(runtime),
    cwd: runtime.repoRoot,
    env: questEnvironment(
      invocation.owner,
      options.guild,
      dispatcherSessionAttribution(options, runtime),
    ),
    ignoreCommandSignal: true,
    maxOutputChars: null,
  });
  if (result.exitCode !== 0) {
    return {
      error: `quest show failed: ${commandOutput(result)}`,
      quest: null,
    };
  }

  try {
    const report = workerShowReportSchema.parse(JSON.parse(result.stdout));
    if (report.data.quest.id !== invocation.questId) {
      return {
        error: `quest show returned quest ${report.data.quest.id}; expected quest ${invocation.questId}`,
        quest: null,
      };
    }
    return { error: null, quest: report.data.quest };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      error: `quest show returned an invalid report: ${detail}`,
      quest: null,
    };
  }
}

async function abandonWorkerClaim(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  invocation: WorkerInvocation,
  warnings: string[],
): Promise<void> {
  const abandoned = await runOrchestrationCommand(runtime, {
    args: ["abandon", String(invocation.questId), "--as", invocation.owner],
    command: questCliCommand(runtime),
    cwd: runtime.repoRoot,
    env: questEnvironment(
      invocation.owner,
      options.guild,
      dispatcherSessionAttribution(options, runtime),
    ),
    ignoreCommandSignal: true,
  });
  if (abandoned.exitCode !== 0) {
    warnings.push(
      `quest ${invocation.questId} could not be released after worker failure: ${commandOutput(abandoned)}`,
    );
  }
}

interface WorkerVerification {
  readonly exitCode: number;
  readonly state: Quest["status"] | null;
}

async function verifyWorkerOutcome(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  invocation: WorkerInvocation,
  workerExitCode: number,
  warnings: string[],
): Promise<WorkerVerification> {
  const inspection = await inspectWorkerQuest(options, runtime, invocation);
  const state = inspection.quest?.status ?? null;
  let exitCode = workerExitCode;
  if (inspection.error !== null || inspection.quest === null) {
    exitCode = 1;
    warnings.push(
      `quest ${invocation.questId} could not be verified after the worker exited: ${inspection.error}`,
    );
    await abandonWorkerClaim(options, runtime, invocation, warnings);
  } else if (!isSuccessfulQuestState(inspection.quest.status)) {
    exitCode = 1;
    warnings.push(
      `quest ${invocation.questId} worker exited with state ${inspection.quest.status}; expected turned_in or complete`,
    );
    if (inspection.quest.status === "accepted") {
      await abandonWorkerClaim(options, runtime, invocation, warnings);
    }
  }
  return { exitCode, state };
}

async function handoffWorker(
  runtime: DispatchRuntime,
  invocation: WorkerInvocation,
  warnings: string[],
): Promise<"active" | "handoff"> {
  const released = await runOrchestrationCommand(runtime, {
    ...lockCommand(runtime, "release", {
      branch: invocation.branch,
      owner: invocation.owner,
      path: invocation.worktreePath,
    }),
    ignoreCommandSignal: true,
  });
  if (released.exitCode !== 0) {
    warnings.push(
      `worktree lock handoff failed for quest ${invocation.questId}: ${commandOutput(released)}; inspect ${invocation.worktreePath}`,
    );
  }
  return released.exitCode === 0 ? "handoff" : "active";
}

async function cleanupWorkerHome(invocation: WorkerInvocation, warnings: string[]): Promise<void> {
  if (invocation.workerHomePath === null) {
    return;
  }
  await cleanupWorkerDirectory(
    invocation.workerHomePath,
    "worker home",
    invocation.questId,
    warnings,
  );
  if (invocation.workerBinPath !== null) {
    await cleanupWorkerDirectory(
      invocation.workerBinPath,
      "worker runtime bin",
      invocation.questId,
      warnings,
    );
  }
}

async function cleanupWorkerBrief(invocation: WorkerInvocation, warnings: string[]): Promise<void> {
  if (invocation.briefFileName === null) {
    return;
  }
  try {
    await rm(join(invocation.workerHomePath ?? invocation.worktreePath, invocation.briefFileName), {
      force: true,
    });
  } catch (error) {
    warnings.push(
      `worker brief cleanup failed for quest ${invocation.questId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function finishWorker(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  invocation: WorkerInvocation,
  warnings: string[],
  heartbeat: QuestLeaseHeartbeat,
  onWorkerStarted: (worker: WorkerHandle) => void,
): Promise<DispatchWorkerResult> {
  const worker = runtime.spawnWorker(invocation);
  onWorkerStarted(worker);
  let workerExitCode = 1;
  let heartbeatFailure: string | null = null;
  try {
    const outcome = await Promise.race([
      worker.completion.then((exitCode) => ({ kind: "worker" as const, exitCode })),
      heartbeat.failure.then((message) => ({ kind: "heartbeat" as const, message })),
    ]);
    if (outcome.kind === "heartbeat") {
      heartbeatFailure = outcome.message;
      await worker.cancel();
      workerExitCode = await worker.completion;
    } else {
      workerExitCode = outcome.exitCode;
    }
  } finally {
    await heartbeat.stop();
    await worker.cancel();
  }
  if (heartbeatFailure !== null) {
    warnings.push(heartbeatFailure);
  }
  const verification = await verifyWorkerOutcome(
    options,
    runtime,
    invocation,
    workerExitCode,
    warnings,
  );
  await cleanupWorkerBrief(invocation, warnings);
  const pointerIntact = await verifyGitPointer(invocation, warnings);
  const gitReady = pointerIntact && (await verifyGitBranch(runtime, invocation, warnings));
  const lockStatus = gitReady ? await handoffWorker(runtime, invocation, warnings) : "active";
  if (!gitReady) {
    warnings.push(
      `worker Git state was preserved for quest ${invocation.questId}; lock remains active for recovery`,
    );
  } else {
    await cleanupWorkerHome(invocation, warnings);
  }
  return {
    branch: invocation.branch,
    exitCode: gitReady ? verification.exitCode : 1,
    lockStatus,
    owner: invocation.owner,
    questId: invocation.questId,
    questStatus: verification.state,
    sessionName: invocation.sessionName,
    worktreePath: invocation.worktreePath,
  };
}

async function cancelActiveWorkers(
  activeWorkers: Map<number, ActiveWorker>,
): Promise<FinishedWorker[]> {
  return Promise.all(
    [...activeWorkers.entries()].map(async ([slot, activeWorker]) => {
      if (activeWorker.control.handle !== null) {
        await activeWorker.control.handle.cancel();
      }
      return { result: await activeWorker.promise, slot };
    }),
  );
}

interface StartWorkerResult {
  readonly activeWorker: ActiveWorker | null;
  readonly exhausted: boolean;
  readonly failed: boolean;
}

async function startNextWorker(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  slot: number,
  worktreeRoot: string,
  warnings: string[],
  isShutdownRequested: () => boolean,
): Promise<StartWorkerResult> {
  const next = await claimNextQuest(options, runtime, slot);
  warnings.push(...next.warnings);
  if (next.claimed === null) {
    warnings.push(
      "queue is empty on the configured base ref; dependent work will wait for a later dispatch after integration",
    );
    return { activeWorker: null, exhausted: true, failed: false };
  }
  const heartbeat = startQuestLeaseHeartbeat(options, runtime, {
    leaseExpiresAt: next.claimed.quest.lease_expires_at,
    leaseObservedAt: next.claimed.leaseObservedAt,
    owner: next.claimed.owner,
    questId: next.claimed.quest.id,
  });
  try {
    if (isShutdownRequested()) {
      await heartbeat.stop();
      await abandonClaimedQuest(
        options,
        runtime,
        shutdownPreparationFailure(next.claimed, worktreeRoot),
        warnings,
      );
      return { activeWorker: null, exhausted: false, failed: true };
    }

    const preparation = await prepareWorker(options, runtime, next.claimed, worktreeRoot);
    if (preparation.outcome === "failed") {
      const leaseFailure = heartbeat.currentFailure;
      await heartbeat.stop();
      if (leaseFailure !== null) {
        warnings.push(leaseFailure);
      }
      warnings.push(
        `quest ${next.claimed.quest.id} was claimed but could not start: ${preparation.failure.error}`,
      );
      warnings.push(...preparation.failure.cleanupWarnings);
      await abandonClaimedQuest(options, runtime, preparation.failure, warnings);
      return { activeWorker: null, exhausted: false, failed: true };
    }
    if (heartbeat.currentFailure !== null) {
      const leaseFailure = heartbeat.currentFailure;
      await heartbeat.stop();
      warnings.push(leaseFailure);
      await abandonClaimedQuest(
        options,
        runtime,
        {
          branchCreated: true,
          branch: preparation.invocation.branch,
          cleanupWarnings: [],
          error: "lease renewal failed before the worker started",
          lockClaimed: true,
          owner: preparation.invocation.owner,
          quest: next.claimed.quest,
          workerHomePath: preparation.invocation.workerHomePath,
          worktreeCreated: true,
          worktreePath: preparation.invocation.worktreePath,
        },
        warnings,
      );
      return { activeWorker: null, exhausted: false, failed: true };
    }
    if (isShutdownRequested()) {
      await heartbeat.stop();
      await abandonClaimedQuest(
        options,
        runtime,
        {
          branchCreated: true,
          branch: preparation.invocation.branch,
          cleanupWarnings: [],
          error: "dispatcher interrupted before the worker started",
          lockClaimed: true,
          owner: preparation.invocation.owner,
          quest: next.claimed.quest,
          workerHomePath: preparation.invocation.workerHomePath,
          worktreeCreated: true,
          worktreePath: preparation.invocation.worktreePath,
        },
        warnings,
      );
      return { activeWorker: null, exhausted: false, failed: true };
    }

    const control: ActiveWorkerControl = { handle: null };
    const promise = finishWorker(
      options,
      runtime,
      preparation.invocation,
      warnings,
      heartbeat,
      (worker) => {
        control.handle = worker;
      },
    );
    return {
      activeWorker: { control, promise },
      exhausted: false,
      failed: false,
    };
  } catch (error) {
    await heartbeat.stop();
    throw error;
  }
}

async function waitForWorker(activeWorkers: Map<number, ActiveWorker>): Promise<FinishedWorker> {
  const finished = await Promise.race(
    [...activeWorkers.entries()].map(async ([slot, activeWorker]) => ({
      result: await activeWorker.promise,
      slot,
    })),
  );
  activeWorkers.delete(finished.slot);
  return finished;
}

function shutdownPreparationFailure(
  claimed: ClaimedQuest,
  worktreeRoot: string,
): PreparationFailure {
  const slug = slugifyQuestTitle(claimed.quest.title);
  const branchSuffix =
    claimed.quest.reopen_count === 0 ? "" : `-attempt-${claimed.quest.reopen_count + 1}`;
  return {
    branchCreated: false,
    branch: `quest/${claimed.quest.id}-${slug}${branchSuffix}`,
    cleanupWarnings: [],
    error: "dispatcher interrupted before the worker started",
    lockClaimed: false,
    owner: claimed.owner,
    quest: claimed.quest,
    workerHomePath: null,
    worktreeCreated: false,
    worktreePath: join(worktreeRoot, `${claimed.quest.id}-${slug}${branchSuffix}`),
  };
}

function defaultWorktreeRoot(repoRoot: string): string {
  const repositoryName = basename(repoRoot).replace(/[^a-z0-9._-]+/giu, "-") || "repo";
  const repositoryFingerprint = createHash("sha256")
    .update(resolve(repoRoot))
    .digest("hex")
    .slice(0, 12);
  return join(dirname(repoRoot), ".quest-dispatch", `${repositoryName}-${repositoryFingerprint}`);
}

async function validateBaseRef(options: DispatchOptions, runtime: DispatchRuntime): Promise<void> {
  const result = await runOrchestrationCommand(runtime, {
    args: ["rev-parse", "--verify", `${options.baseRef}^{commit}`],
    command: "git",
    cwd: runtime.repoRoot,
  });
  if (result.exitCode !== 0) {
    throw new DispatchError(
      "DISPATCH_BASE_REF_INVALID",
      `base ref "${options.baseRef}" did not resolve to a commit: ${commandOutput(result)}; choose an existing branch, tag, or commit and retry`,
    );
  }
}

async function validateDispatchOptions(
  options: DispatchOptions,
  runtime: DispatchRuntime,
): Promise<void> {
  await validateBaseRef(options, runtime);
}

function withCommandSignal(runtime: DispatchRuntime, signal: AbortSignal): DispatchRuntime {
  return {
    ...runtime,
    commandSignal: signal,
    runCommand: (spec) => {
      if (spec.signal !== undefined || spec.ignoreCommandSignal === true) {
        return runtime.runCommand(spec);
      }
      return runtime.runCommand({ ...spec, signal });
    },
  };
}

interface DispatchLoopState {
  readonly activeWorkers: Map<number, ActiveWorker>;
  readonly warnings: string[];
  readonly workers: DispatchWorkerResult[];
  failures: number;
  nextSlot: number;
  noMoreWork: boolean;
}

async function fillWorkerSlots(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  worktreeRoot: string,
  state: DispatchLoopState,
  isShutdownRequested: () => boolean,
): Promise<void> {
  while (
    !isShutdownRequested() &&
    !state.noMoreWork &&
    state.activeWorkers.size < options.concurrency
  ) {
    state.nextSlot += 1;
    const started = await startNextWorker(
      options,
      runtime,
      state.nextSlot,
      worktreeRoot,
      state.warnings,
      isShutdownRequested,
    );
    state.failures += Number(started.failed);
    if (started.failed) {
      state.noMoreWork = true;
      break;
    }
    if (started.exhausted) {
      state.noMoreWork = true;
      break;
    }
    if (started.activeWorker !== null) {
      state.activeWorkers.set(state.nextSlot, started.activeWorker);
      if (isShutdownRequested() && started.activeWorker.control.handle !== null) {
        await started.activeWorker.control.handle.cancel();
      }
    }
  }
}

async function runDispatchLoop(
  options: DispatchOptions,
  runtime: DispatchRuntime,
  worktreeRoot: string,
  state: DispatchLoopState,
  isShutdownRequested: () => boolean,
): Promise<void> {
  while (state.activeWorkers.size > 0 || !state.noMoreWork) {
    await fillWorkerSlots(options, runtime, worktreeRoot, state, isShutdownRequested);
    if (isShutdownRequested() || state.activeWorkers.size === 0) {
      break;
    }
    const finished = await waitForWorker(state.activeWorkers);
    state.workers.push(finished.result);
    const failed = finished.result.exitCode !== 0 || finished.result.lockStatus === "active";
    state.failures += Number(failed);
    if (failed) {
      // Stop new claims, but let the loop condition drain workers already started.
      state.noMoreWork = true;
      state.warnings.push(
        `dispatcher stopped after worker for quest ${finished.result.questId} failed; inspect its handoff worktree before retrying dispatch`,
      );
    }
  }
}

async function addShutdownResults(
  shutdownPromise: Promise<FinishedWorker[]>,
  state: DispatchLoopState,
): Promise<void> {
  const finishedWorkers = await shutdownPromise;
  for (const finishedWorker of finishedWorkers) {
    if (state.activeWorkers.delete(finishedWorker.slot)) {
      state.workers.push(finishedWorker.result);
      state.failures += Number(
        finishedWorker.result.exitCode !== 0 || finishedWorker.result.lockStatus === "active",
      );
    }
  }
}

export async function dispatch(
  options: DispatchOptions,
  runtime: DispatchRuntime,
): Promise<DispatchReport> {
  if (options.trust === undefined) {
    throw new DispatchError(
      "DISPATCH_TRUST_REQUIRED",
      "choose --trust full or --trust guarded before dispatching",
    );
  }
  const startedAt = new Date().toISOString();
  const commandController = new AbortController();
  const commandRuntime = withCommandSignal(
    {
      ...runtime,
      dispatchId: `${runtime.host}/${runtime.processId}/${randomUUID()}`,
    },
    commandController.signal,
  );
  await validateDispatchOptions(options, commandRuntime);
  const worktreeRoot = resolve(
    runtime.repoRoot,
    options.worktreeRoot ?? defaultWorktreeRoot(runtime.repoRoot),
  );
  await mkdir(worktreeRoot, { recursive: true });

  const state: DispatchLoopState = {
    activeWorkers: new Map<number, ActiveWorker>(),
    failures: 0,
    nextSlot: 0,
    noMoreWork: false,
    warnings: [],
    workers: [],
  };
  let shutdownRequested = false;
  let shutdownPromise: Promise<FinishedWorker[]> | null = null;
  const requestShutdown = (): void => {
    shutdownRequested = true;
    commandController.abort();
    shutdownPromise ??= cancelActiveWorkers(state.activeWorkers);
  };
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);

  try {
    await runDispatchLoop(options, commandRuntime, worktreeRoot, state, () => shutdownRequested);
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
    if (shutdownPromise !== null) {
      await addShutdownResults(shutdownPromise, state);
    }
    while (state.activeWorkers.size > 0) {
      await addShutdownResults(cancelActiveWorkers(state.activeWorkers), state);
    }
  }

  return {
    command: "dispatch",
    concurrency: options.concurrency,
    failures: state.failures,
    finished_at: new Date().toISOString(),
    interrupted: shutdownRequested,
    skipped_after_reopens: options.skipAfterReopens,
    started_at: startedAt,
    warnings: state.warnings,
    workers: state.workers,
  };
}

async function loadDispatchConfig(): Promise<Config> {
  try {
    return await loadConfig({ platform: createPlatform(), environment: process.env });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DispatchError(
      "DISPATCH_CONFIG_INVALID",
      `Quest config could not be loaded (${detail}); fix the config file and retry`,
    );
  }
}

export async function main(
  argumentsWithoutRuntime: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const cliOptions = parseDispatchArguments(argumentsWithoutRuntime);
    const config = await loadDispatchConfig();
    const options = resolveDispatchOptions(cliOptions, config.dispatch);
    await confirmDispatchTrust(options, {
      ask: createCliPrompter().ask,
      isInteractive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      write: (message) => process.stderr.write(message),
    });
    const runtime = await createRuntime(options.agent, options.trust, config);
    const report = await dispatch(options, runtime);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.interrupted
      ? 130
      : report.failures > 0 ||
          report.workers.some((worker) => worker.exitCode !== 0 || worker.lockStatus === "active")
        ? 1
        : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
