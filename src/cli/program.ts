import { Command, CommanderError, Option } from "commander";
import { z } from "zod";
import {
  ConvexDeploymentError,
  configuredRepositoryStores,
  resolveRepositoryStore,
} from "../config";
import type { EvidenceFileReader } from "../evidence";
import {
  buildQuestReport,
  type CliError,
  type CliOutputBoundary,
  EXIT_SUCCESS,
  type ExitCode,
  formatQuestReport,
} from "../output";
import type { EvidenceOpener } from "../platform";
import type { Config, QuestScope, QuestStats, StoreCompatibilityResult } from "../schema";
import { questStatusSchema, storeCompatibilityResultSchema } from "../schema";
import {
  type BackupOperations,
  type DoctorOperations,
  type PullRequestMergeChecker,
  questStats,
  type UpgradeOperations,
} from "../services";
import type { BlobStore, Clock, QuestStore, StoreCompatibilityProbe } from "../store";
import {
  assertKnownThemeFlag,
  selectQuestTheme,
  UnknownThemeError,
  type ViewerTheme,
} from "../tui/theme-selection";
import {
  type BackupCliRequest,
  BackupCliUsageError,
  type ExecuteBackupCliOptions,
  executeBackupCli,
  isBackupCliRequest,
  registerBackupCommands,
} from "./backup";
import {
  type ChainCliRequest,
  ChainCliUsageError,
  executeChainCli,
  isChainCliRequest,
  isChainCommandError,
  registerChainCommands,
} from "./chains";
import {
  type CompletionCliRequest,
  generateShellCompletions,
  registerCompletionCommand,
} from "./completions";
import {
  type DoctorCliRequest,
  executeDoctorCli,
  isDoctorCliRequest,
  registerDoctorCommand,
} from "./doctor";
import {
  type ExportCliRequest,
  ExportCliUsageError,
  executeExportCli,
  isExportCliRequest,
  registerExportCommand,
} from "./export";
import { resolveIdentity } from "./identity";
import {
  executeLifecycleCli,
  isLifecycleCliRequest,
  isLifecycleCommandError,
  type LifecycleCliRequest,
  LifecycleCliUsageError,
  registerLifecycleCommands,
} from "./lifecycle";
import {
  type ConvexJoinConfigWriter,
  type ConvexOnboardingOperations,
  executeMembersCli,
  isMembersCliRequest,
  type MembersCliRequest,
  MembersCliUsageError,
  registerMembersCommands,
} from "./members";
import {
  type ExecuteRepositoryMigrationCliOptions,
  executeRepositoryMigrationCli,
  type MigrateCliRequest,
  MigrateCliUsageError,
  type RepositoryMigrationOperations,
  registerMigrateCommand,
} from "./migrate";
import { executePlanCli, isPlanCliRequest, type PlanCliRequest, registerPlanCommand } from "./plan";
import type { CliPrompter } from "./prompt";
import {
  executeQueryCli,
  isQueryCliRequest,
  type QueryCliRequest,
  QueryCliUsageError,
  registerQueryCommands,
} from "./query";
import {
  type GitIdentityLocator,
  type GitRootLocator,
  type GlobalCliOptions,
  globalCliOptionsSchema,
  type ResolvedCliScope,
  resolveCliScope,
  ScopeResolutionError,
  type WorkingDirectoryValidator,
} from "./scope";
import {
  executeSkillCli,
  isSkillCliRequest,
  registerSkillCommands,
  SkillCliConflictError,
  type SkillCliRequest,
  SkillCliUsageError,
} from "./skill";
import {
  executeUpgradeCli,
  isUpgradeCliRequest,
  registerUpgradeCommand,
  type UpgradeCliRequest,
} from "./upgrade";

export type QuestCliRequest =
  | BackupCliRequest
  | ChainCliRequest
  | DoctorCliRequest
  | CompletionCliRequest
  | ExportCliRequest
  | LifecycleCliRequest
  | MembersCliRequest
  | QueryCliRequest
  | PlanCliRequest
  | SkillCliRequest
  | UpgradeCliRequest
  | MigrateCliRequest;

type OperationalQuestCliRequest = Exclude<
  QuestCliRequest,
  | CompletionCliRequest
  | DoctorCliRequest
  | MembersCliRequest
  | MigrateCliRequest
  | SkillCliRequest
  | UpgradeCliRequest
>;

interface CliRequestExecutionContext {
  readonly dependencies: QuestCliDependencies;
  readonly flags: GlobalCliOptions;
  readonly identity: string | undefined;
  readonly identityWarnings: readonly string[];
  readonly ports: CliApplicationPorts;
  readonly resolved: ResolvedCliScope;
}

type CliRequestExecutor = (
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
) => Promise<ExitCode>;

const versionDataSchema = z.strictObject({
  version: z.string().trim().min(1),
  store_schema_version: z.int().nonnegative(),
});

const migrateDataSchema = z.strictObject({
  changed: z.boolean(),
  store_schema_version: z.int().nonnegative(),
});

const bareQuestDataSchema = z.strictObject({
  repo: z.string().nullable(),
  status_counts: z.record(z.string(), z.int().nonnegative()),
  total: z.int().nonnegative(),
});

export interface CliApplicationPorts {
  readonly backup?: BackupOperations | undefined;
  readonly blobStore: BlobStore;
  readonly checkPullRequestMerge?: PullRequestMergeChecker;
  readonly clock: Clock;
  readonly questStore?: QuestStore | undefined;
  readonly scheduler?: ExecuteBackupCliOptions["ports"]["scheduler"];
}

export interface OperationalCliApplicationPorts extends CliApplicationPorts {
  readonly questStore: QuestStore;
}

export interface FutureTuiContext {
  readonly identity?: string;
  readonly ports: OperationalCliApplicationPorts;
  readonly scope: QuestScope;
  readonly theme: ViewerTheme;
  readonly viewer: EvidenceOpener;
  readonly workingDirectory: string;
}

export type FutureTuiLauncher = (context: FutureTuiContext) => Promise<void>;

interface CliBackendRuntime {
  readonly clock: Clock;
  readonly close?: (() => Promise<void>) | undefined;
  readonly compatibilityProbe: StoreCompatibilityProbe;
  readonly doctor?: DoctorOperations | undefined;
  readonly openApplicationPorts: () => Promise<CliApplicationPorts>;
}

export interface QuestCliBackendOpenOptions {
  readonly mode?: "command" | "viewer";
}

export interface QuestCliDependencies {
  readonly applicationVersion: string;
  readonly clock: Clock;
  readonly close?: (() => Promise<void>) | undefined;
  readonly compatibilityProbe: StoreCompatibilityProbe;
  readonly config: Config;
  readonly configWriter?: ConvexJoinConfigWriter | undefined;
  readonly doctor?: DoctorOperations | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly evidenceFiles: EvidenceFileReader;
  readonly initialWorkingDirectory: string;
  readonly isTty: boolean;
  readonly launchTui?: FutureTuiLauncher;
  readonly locateGitIdentity?: GitIdentityLocator;
  readonly locateGitRoot: GitRootLocator;
  readonly migration?: RepositoryMigrationOperations;
  readonly openBackend?: (
    scope: QuestScope,
    options?: QuestCliBackendOpenOptions,
  ) => Promise<CliBackendRuntime>;
  readonly openApplicationPorts: () => Promise<CliApplicationPorts>;
  readonly openDefaultBackend?: () => Promise<CliBackendRuntime>;
  readonly onboarding?: ConvexOnboardingOperations | undefined;
  readonly output: CliOutputBoundary;
  readonly prompter: CliPrompter;
  readonly readStdin?: (() => Promise<string>) | undefined;
  readonly saveViewerTheme?: ((themeName: string) => Promise<void>) | undefined;
  readonly upgrade?: UpgradeOperations | undefined;
  readonly validateWorkingDirectory: WorkingDirectoryValidator;
  readonly viewer?: EvidenceOpener;
}

export type QuestCliArgumentResult =
  | {
      readonly outcome: "run";
      readonly flags: GlobalCliOptions;
      readonly request?: QuestCliRequest;
    }
  | {
      readonly outcome: "exit";
      readonly exitCode: ExitCode;
    };

class StoreCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreCompatibilityError";
  }
}

interface CliErrorDispatchRule {
  readonly kind: CliError["kind"];
  readonly matches: (error: unknown) => boolean;
}

const CLI_ERROR_DISPATCH: readonly CliErrorDispatchRule[] = [
  { kind: "usage", matches: (error) => error instanceof ScopeResolutionError },
  { kind: "usage", matches: (error) => error instanceof UnknownThemeError },
  { kind: "usage", matches: (error) => error instanceof ConvexDeploymentError },
  { kind: "domain", matches: (error) => error instanceof StoreCompatibilityError },
  { kind: "usage", matches: (error) => error instanceof LifecycleCliUsageError },
  { kind: "usage", matches: (error) => error instanceof ChainCliUsageError },
  { kind: "usage", matches: (error) => error instanceof QueryCliUsageError },
  { kind: "usage", matches: (error) => error instanceof ExportCliUsageError },
  { kind: "usage", matches: (error) => error instanceof BackupCliUsageError },
  { kind: "usage", matches: (error) => error instanceof MembersCliUsageError },
  { kind: "usage", matches: (error) => error instanceof SkillCliUsageError },
  { kind: "domain", matches: (error) => error instanceof SkillCliConflictError },
  { kind: "usage", matches: (error) => error instanceof MigrateCliUsageError },
  { kind: "domain", matches: isLifecycleCommandError },
  { kind: "domain", matches: isChainCommandError },
];

function classifyCliError(error: unknown): CliError["kind"] {
  for (const rule of CLI_ERROR_DISPATCH) {
    if (rule.matches(error)) {
      return rule.kind;
    }
  }
  return "domain";
}

function parseGlobalOptions(program: Command) {
  return globalCliOptionsSchema.parse({
    directory: program.getOptionValue("C"),
    repo: program.getOptionValue("repo"),
    all: program.getOptionValue("all"),
    format: program.getOptionValue("format"),
    theme: program.getOptionValue("theme"),
    version: program.getOptionValue("version"),
  });
}

async function readStoreCompatibility(
  probe: StoreCompatibilityProbe,
): Promise<StoreCompatibilityResult> {
  let result: StoreCompatibilityResult;
  try {
    result = storeCompatibilityResultSchema.parse(await probe.check());
  } catch (error) {
    if (error instanceof z.ZodError) {
      const detail = error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      throw new StoreCompatibilityError(`invalid store compatibility result: ${detail}`);
    }
    throw error;
  }
  return result;
}

function olderStoreMessage(result: Extract<StoreCompatibilityResult, { outcome: "store-older" }>) {
  return `store schema ${result.store_version} is older than this binary supports (${result.supported_version}); run quest migrate before retrying`;
}

async function requireCompatibleStore(probe: StoreCompatibilityProbe): Promise<number> {
  const result = await readStoreCompatibility(probe);
  switch (result.outcome) {
    case "compatible":
      return result.store_version;
    case "store-newer":
      throw new StoreCompatibilityError(
        `store schema ${result.store_version} was written by a newer quest; upgrade the quest binary (this binary supports schema ${result.supported_version})`,
      );
    case "store-older":
      throw new StoreCompatibilityError(olderStoreMessage(result));
  }
}

async function migrateStore(probe: StoreCompatibilityProbe): Promise<number> {
  const result = await readStoreCompatibility(probe);
  if (result.outcome === "store-older") {
    if (probe.migrate === undefined) {
      throw new StoreCompatibilityError(olderStoreMessage(result));
    }
    await probe.migrate();
  }
  return requireCompatibleStore(probe);
}

function commanderUsageMessage(error: CommanderError): string {
  return error.message.replace(/^error:\s*/u, "");
}

function executeQueryRequest(
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
): Promise<ExitCode> {
  if (!isQueryCliRequest(request)) {
    throw new Error(`query dispatcher received ${request.command}`);
  }
  return executeQueryCli({
    config: context.dependencies.config,
    format: context.flags.format,
    identity: context.identity,
    output: context.dependencies.output,
    ports: requireOperationalPorts(context.ports),
    request,
    scope: context.resolved.scope,
  });
}

function executePlanRequest(
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
): Promise<ExitCode> {
  if (!isPlanCliRequest(request)) {
    throw new Error(`plan dispatcher received ${request.command}`);
  }
  return executePlanCli({
    clock: context.ports.clock,
    format: context.flags.format,
    output: context.dependencies.output,
    ports: requireOperationalPorts(context.ports),
    request,
    scope: context.resolved.scope,
  });
}

function executeChainRequest(
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
): Promise<ExitCode> {
  if (!isChainCliRequest(request)) {
    throw new Error(`chain dispatcher received ${request.command}`);
  }
  return executeChainCli({
    config: context.dependencies.config,
    format: context.flags.format,
    identity: context.identity,
    identityWarnings: context.identityWarnings,
    output: context.dependencies.output,
    ports: requireOperationalPorts(context.ports),
    request,
    scope: context.resolved.scope,
  });
}

function executeLifecycleRequest(
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
): Promise<ExitCode> {
  if (!isLifecycleCliRequest(request)) {
    throw new Error(`lifecycle dispatcher received ${request.command}`);
  }
  return executeLifecycleCli({
    config: context.dependencies.config,
    environment: context.dependencies.environment ?? process.env,
    format: context.flags.format,
    identity: context.identity,
    identityWarnings: context.identityWarnings,
    isTty: context.dependencies.isTty,
    output: context.dependencies.output,
    ports: {
      ...requireOperationalPorts(context.ports),
      evidenceFiles: context.dependencies.evidenceFiles,
    },
    prompter: context.dependencies.prompter,
    request,
    readStdin: context.dependencies.readStdin,
    scope: context.resolved.scope,
    workingDirectory: context.resolved.working_directory,
  });
}

function executeExportRequest(
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
): Promise<ExitCode> {
  if (!isExportCliRequest(request)) {
    throw new Error(`export dispatcher received ${request.command}`);
  }
  return executeExportCli({
    format: context.flags.format,
    output: context.dependencies.output,
    ports: requireOperationalPorts(context.ports),
    request,
    workingDirectory: context.resolved.working_directory,
  });
}

function executeBackupRequest(
  context: CliRequestExecutionContext,
  request: QuestCliRequest,
): Promise<ExitCode> {
  if (!isBackupCliRequest(request)) {
    throw new Error(`backup dispatcher received ${request.command}`);
  }
  return executeBackupCli({
    format: context.flags.format,
    output: context.dependencies.output,
    ports: context.ports,
    repository: context.resolved.scope.repo,
    request,
    workingDirectory: context.resolved.working_directory,
  });
}

const CLI_REQUEST_DISPATCH = {
  add: executeLifecycleRequest,
  next: executeLifecycleRequest,
  accept: executeLifecycleRequest,
  touch: executeLifecycleRequest,
  abandon: executeLifecycleRequest,
  verdict: executeLifecycleRequest,
  turnin: executeLifecycleRequest,
  complete: executeLifecycleRequest,
  cancel: executeLifecycleRequest,
  reopen: executeLifecycleRequest,
  update: executeLifecycleRequest,
  "chain-add": executeChainRequest,
  "chain-rm": executeChainRequest,
  "chain-show": executeChainRequest,
  list: executeQueryRequest,
  show: executeQueryRequest,
  stats: executeQueryRequest,
  events: executeQueryRequest,
  brief: executeQueryRequest,
  plan: executePlanRequest,
  export: executeExportRequest,
  "backup-run": executeBackupRequest,
  "backup-verify": executeBackupRequest,
  "backup-list": executeBackupRequest,
  "backup-restore": executeBackupRequest,
  "backup-prune": executeBackupRequest,
  "backup-schedule-install": executeBackupRequest,
  "backup-schedule-status": executeBackupRequest,
  "backup-schedule-remove": executeBackupRequest,
} satisfies Record<OperationalQuestCliRequest["command"], CliRequestExecutor>;

function isOperationalQuestCliRequest(
  request: QuestCliRequest,
): request is OperationalQuestCliRequest {
  return (
    !isMembersCliRequest(request) &&
    !isSkillCliRequest(request) &&
    request.command !== "completions" &&
    request.command !== "doctor" &&
    request.command !== "migrate" &&
    request.command !== "upgrade"
  );
}

function requireOperationalPorts(ports: CliApplicationPorts): OperationalCliApplicationPorts {
  if (ports.questStore === undefined) {
    throw new Error("the active quest store is unavailable for this command");
  }
  return {
    ...ports,
    questStore: ports.questStore,
  };
}

function requireUpgradeOperations(operations: UpgradeOperations | undefined): UpgradeOperations {
  if (operations === undefined) {
    throw new Error("upgrade operations are unavailable in this build");
  }
  return operations;
}

function requireRepositoryMigrationOperations(
  operations: RepositoryMigrationOperations | undefined,
): RepositoryMigrationOperations {
  if (operations === undefined) {
    throw new Error("repository migration is unavailable in this build");
  }
  return operations;
}

async function executeRepositoryMigrationRequest(
  flags: GlobalCliOptions,
  request: Extract<MigrateCliRequest, { repository: string }>,
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  if (flags.all) {
    throw new ScopeResolutionError(
      "[UNSUPPORTED_SCOPE] repository migration cannot use --all; migrate one repository at a time",
    );
  }
  if (flags.repo !== undefined && flags.repo !== request.repository) {
    throw new MigrateCliUsageError(
      `repository appears twice with different names (${request.repository} and ${flags.repo}); use the positional <repo> once`,
    );
  }
  const migrationOptions: ExecuteRepositoryMigrationCliOptions = {
    clock: dependencies.clock,
    format: flags.format,
    migration: requireRepositoryMigrationOperations(dependencies.migration),
    output: dependencies.output,
    request,
  };
  return executeRepositoryMigrationCli(migrationOptions);
}

async function executeMigrateRequest(
  flags: GlobalCliOptions,
  request: MigrateCliRequest,
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  if ("repository" in request) {
    return executeRepositoryMigrationRequest(flags, request, dependencies);
  }
  return executeStoreMigration(
    dependencies,
    flags,
    await openMaintenanceBackend(dependencies, flags, "migrate"),
  );
}

export function isBackupRecoveryRequest(request: QuestCliRequest | undefined): boolean {
  return request !== undefined && isBackupCliRequest(request) && request.command !== "backup-run";
}

function requestNeedsIdentity(request: QuestCliRequest | undefined): boolean {
  if (request === undefined) {
    return false;
  }
  if (isLifecycleCliRequest(request)) {
    return request.command !== "next" || request.claim;
  }
  if (isChainCliRequest(request)) {
    return request.command !== "chain-show";
  }
  if (isQueryCliRequest(request)) {
    return request.command === "list" && request.mine;
  }
  return false;
}

function identityOverride(request: QuestCliRequest | undefined): string | undefined {
  return request !== undefined && isLifecycleCliRequest(request) && request.command === "accept"
    ? request.owner
    : undefined;
}

async function resolveRequestIdentity(
  request: QuestCliRequest | undefined,
  resolved: ResolvedCliScope,
  dependencies: QuestCliDependencies,
): Promise<{ identity: string | undefined; identityWarnings: readonly string[] }> {
  if (!requestNeedsIdentity(request)) {
    return { identity: undefined, identityWarnings: [] };
  }

  const override = identityOverride(request);
  const configured = dependencies.config.identity;
  const git =
    override === undefined &&
    configured === undefined &&
    dependencies.locateGitIdentity !== undefined
      ? await dependencies.locateGitIdentity(resolved.working_directory)
      : undefined;
  const resolution = resolveIdentity({ configured, git, override });
  return {
    identity: resolution.identity,
    identityWarnings: resolution.warning === undefined ? [] : [resolution.warning],
  };
}

function legacyBackendRuntime(dependencies: QuestCliDependencies): CliBackendRuntime {
  return {
    clock: dependencies.clock,
    compatibilityProbe: dependencies.compatibilityProbe,
    ...(dependencies.doctor === undefined ? {} : { doctor: dependencies.doctor }),
    openApplicationPorts: dependencies.openApplicationPorts,
  };
}

async function openDefaultBackend(dependencies: QuestCliDependencies): Promise<CliBackendRuntime> {
  return dependencies.openDefaultBackend === undefined
    ? legacyBackendRuntime(dependencies)
    : dependencies.openDefaultBackend();
}

async function openScopedBackend(
  dependencies: QuestCliDependencies,
  scope: QuestScope,
  options?: QuestCliBackendOpenOptions,
): Promise<CliBackendRuntime> {
  return dependencies.openBackend === undefined
    ? legacyBackendRuntime(dependencies)
    : dependencies.openBackend(scope, options);
}

async function openMaintenanceBackend(
  dependencies: QuestCliDependencies,
  flags: GlobalCliOptions,
  command: "doctor" | "migrate",
): Promise<CliBackendRuntime> {
  if (flags.all) {
    throw new ScopeResolutionError(
      `[UNSUPPORTED_SCOPE] ${command} cannot use --all; rerun with --repo <name> to select one backend`,
    );
  }
  if (dependencies.openBackend === undefined) {
    return openDefaultBackend(dependencies);
  }
  const scope = await resolveMaintenanceScope(dependencies, flags);
  return scope === undefined
    ? openDefaultBackend(dependencies)
    : openScopedBackend(dependencies, scope);
}

async function resolveMaintenanceScope(
  dependencies: QuestCliDependencies,
  flags: GlobalCliOptions,
): Promise<QuestScope | undefined> {
  try {
    const resolved = await resolveCliScope({
      config: dependencies.config,
      flags,
      initialWorkingDirectory: dependencies.initialWorkingDirectory,
      locateGitRoot: dependencies.locateGitRoot,
      validateWorkingDirectory: dependencies.validateWorkingDirectory,
    });
    return resolved.scope;
  } catch (error: unknown) {
    if (
      error instanceof ScopeResolutionError &&
      (error.message.startsWith("cannot detect a git repository") ||
        error.message.startsWith("git returned an empty root"))
    ) {
      return undefined;
    }
    throw error;
  }
}

async function closeBackend(backend: Pick<CliBackendRuntime, "close">): Promise<void> {
  try {
    await backend.close?.();
  } catch {
    // Cleanup cannot replace the command result after a remote mutation may have committed.
  }
}

async function openRequestBackend(
  dependencies: QuestCliDependencies,
  request: QuestCliRequest | undefined,
  scope: QuestScope,
): Promise<CliBackendRuntime> {
  if (request !== undefined && isBackupCliRequest(request) && scope.repo === null) {
    throw new ScopeResolutionError(
      `[UNSUPPORTED_SCOPE] backup commands cannot use --all; rerun with --repo <name> to select one backend`,
    );
  }
  return openScopedBackend(dependencies, scope);
}

async function executeVersionRequest(
  flags: GlobalCliOptions,
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  const backend = await openDefaultBackend(dependencies);
  try {
    const storeSchemaVersion = await requireCompatibleStore(backend.compatibilityProbe);
    if (flags.format === "json") {
      const report = buildQuestReport(versionDataSchema, {
        command: "version",
        generated_at: await backend.clock.now(),
        filters: {},
        warnings: [],
        data: {
          version: dependencies.applicationVersion,
          store_schema_version: storeSchemaVersion,
        },
      });
      dependencies.output.write(formatQuestReport(report));
    } else {
      dependencies.output.write(`quest ${dependencies.applicationVersion}\n`);
    }
    return EXIT_SUCCESS;
  } finally {
    await closeBackend(backend);
  }
}

function executeCompletionsRequest(
  request: CompletionCliRequest,
  dependencies: QuestCliDependencies,
): ExitCode {
  dependencies.output.write(
    generateShellCompletions(createQuestCommand(dependencies.output), request.shell),
  );
  return EXIT_SUCCESS;
}

function executeMembersRequest(
  flags: GlobalCliOptions,
  request: MembersCliRequest,
  dependencies: QuestCliDependencies,
  config: Config,
): Promise<ExitCode> {
  return executeMembersCli({
    config,
    ...(dependencies.configWriter === undefined ? {} : { configWriter: dependencies.configWriter }),
    environment: dependencies.environment ?? process.env,
    format: flags.format,
    ...(dependencies.onboarding === undefined ? {} : { onboarding: dependencies.onboarding }),
    output: dependencies.output,
    prompter: dependencies.prompter,
    request,
  });
}

function executeSkillRequest(
  flags: GlobalCliOptions,
  request: SkillCliRequest,
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  return executeSkillCli({
    environment: dependencies.environment ?? process.env,
    format: flags.format,
    output: dependencies.output,
    request,
  });
}

async function resolveMembersConfig(
  flags: GlobalCliOptions,
  dependencies: QuestCliDependencies,
): Promise<Config> {
  if (flags.all) {
    throw new ScopeResolutionError(
      "[UNSUPPORTED_SCOPE] member commands target one Convex deployment; rerun with --repo <name> or --deployment <url>",
    );
  }
  if (flags.repo === undefined && configuredRepositoryStores(dependencies.config).length === 0) {
    return dependencies.config;
  }

  let resolved: ResolvedCliScope;
  try {
    resolved = await resolveCliScope({
      config: dependencies.config,
      flags,
      initialWorkingDirectory: dependencies.initialWorkingDirectory,
      locateGitRoot: dependencies.locateGitRoot,
      validateWorkingDirectory: dependencies.validateWorkingDirectory,
    });
  } catch (error: unknown) {
    if (
      error instanceof ScopeResolutionError &&
      (error.message.startsWith("cannot detect a git repository") ||
        error.message.startsWith("git returned an empty root"))
    ) {
      throw new ScopeResolutionError(
        "[QUEST_MEMBER_SCOPE_REQUIRED] cannot select a repository-scoped Convex deployment from this directory; rerun with --repo <name> or --deployment <url>",
      );
    }
    throw error;
  }
  if (resolved.scope.repo === null) {
    throw new ScopeResolutionError(
      "[UNSUPPORTED_SCOPE] member commands target one Convex deployment; rerun with --repo <name> or --deployment <url>",
    );
  }
  return {
    ...dependencies.config,
    store: resolveRepositoryStore(dependencies.config, resolved.scope.repo),
  };
}

async function executePreScopeRequest(
  flags: GlobalCliOptions,
  request: QuestCliRequest | undefined,
  dependencies: QuestCliDependencies,
): Promise<ExitCode | undefined> {
  if (flags.version) {
    return executeVersionRequest(flags, dependencies);
  }

  if (request?.command === "completions") {
    return executeCompletionsRequest(request, dependencies);
  }

  if (request !== undefined && isMembersCliRequest(request)) {
    if (request.command === "join" || request.deployment !== undefined) {
      return executeMembersRequest(flags, request, dependencies, dependencies.config);
    }
    return executeMembersRequest(
      flags,
      request,
      dependencies,
      await resolveMembersConfig(flags, dependencies),
    );
  }

  if (request?.command === "migrate") {
    return executeMigrateRequest(flags, request, dependencies);
  }

  if (request !== undefined && isUpgradeCliRequest(request)) {
    return executeUpgradeCli({
      applicationVersion: dependencies.applicationVersion,
      clock: dependencies.clock,
      format: flags.format,
      operations: requireUpgradeOperations(dependencies.upgrade),
      output: dependencies.output,
      request,
    });
  }

  if (request !== undefined && isDoctorCliRequest(request)) {
    return executeDoctorRequest(flags, dependencies);
  }

  return undefined;
}

async function executeDoctorRequest(
  flags: GlobalCliOptions,
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  const backend = await openMaintenanceBackend(dependencies, flags, "doctor");
  try {
    let compatibility: StoreCompatibilityResult | undefined;
    let compatibilityError: unknown;
    try {
      compatibility = await readStoreCompatibility(backend.compatibilityProbe);
    } catch (error: unknown) {
      compatibilityError = error;
    }
    return await executeDoctorCli({
      clock: backend.clock,
      compatibility,
      compatibilityError,
      doctor: backend.doctor ?? dependencies.doctor,
      format: flags.format,
      output: dependencies.output,
    });
  } finally {
    await closeBackend(backend);
  }
}

async function executeQuestCli(
  flags: GlobalCliOptions,
  request: QuestCliRequest | undefined,
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  if (flags.theme !== undefined) {
    assertKnownThemeFlag(flags.theme);
  }
  if (request !== undefined && isSkillCliRequest(request)) {
    return executeSkillRequest(flags, request, dependencies);
  }
  const preScopeResult = await executePreScopeRequest(flags, request, dependencies);
  if (preScopeResult !== undefined) {
    return preScopeResult;
  }

  const resolved = await resolveCliScope({
    config: dependencies.config,
    flags,
    initialWorkingDirectory: dependencies.initialWorkingDirectory,
    locateGitRoot: dependencies.locateGitRoot,
    validateWorkingDirectory: dependencies.validateWorkingDirectory,
  });
  // Resolve identity once after scope detection so Git metadata is read only once per command.
  const resolvedIdentity = await resolveRequestIdentity(request, resolved, dependencies);
  const backend =
    request === undefined && dependencies.isTty && flags.format !== "json"
      ? await openScopedBackend(dependencies, { repo: null }, { mode: "viewer" })
      : await openRequestBackend(dependencies, request, resolved.scope);
  try {
    if (!isBackupRecoveryRequest(request)) {
      await requireCompatibleStore(backend.compatibilityProbe);
    }
    const ports = await backend.openApplicationPorts();
    if (request === undefined) {
      return await executeBareQuestRequest(flags, dependencies, ports, resolved, backend.clock);
    }
    if (!isOperationalQuestCliRequest(request)) {
      throw new Error(`request ${request.command} was not handled before backend dispatch`);
    }
    return await CLI_REQUEST_DISPATCH[request.command](
      {
        dependencies,
        flags,
        identity: resolvedIdentity.identity,
        identityWarnings: resolvedIdentity.identityWarnings,
        ports,
        resolved,
      },
      request,
    );
  } finally {
    await closeBackend(backend);
  }
}

function resolveViewerTheme(
  flags: GlobalCliOptions,
  dependencies: QuestCliDependencies,
): ViewerTheme {
  const selection = selectQuestTheme({
    configTheme: dependencies.config.tui?.theme,
    environmentTheme: dependencies.environment?.["QUEST_THEME"],
    flagTheme: flags.theme,
  });
  const save = dependencies.saveViewerTheme;
  return {
    name: selection.theme.name,
    save: save ?? (() => Promise.reject(new Error("this build cannot write the user config file"))),
    warnings: selection.warnings,
  };
}

async function executeBareQuestRequest(
  flags: GlobalCliOptions,
  dependencies: QuestCliDependencies,
  ports: CliApplicationPorts,
  resolved: ResolvedCliScope,
  clock: Clock,
): Promise<ExitCode> {
  if (dependencies.isTty && flags.format !== "json") {
    if (dependencies.launchTui === undefined || dependencies.viewer === undefined) {
      throw new Error("the read-only viewer is unavailable in this build");
    }
    await dependencies.launchTui({
      ...(dependencies.config.identity === undefined
        ? {}
        : { identity: dependencies.config.identity }),
      ports: requireOperationalPorts(ports),
      scope: resolved.scope,
      theme: resolveViewerTheme(flags, dependencies),
      viewer: dependencies.viewer,
      workingDirectory: resolved.working_directory,
    });
    return EXIT_SUCCESS;
  }

  const stats = await executeBareQuestStats(
    requireOperationalPorts(ports).questStore,
    resolved.scope,
  );
  if (flags.format === "json") {
    const report = buildQuestReport(bareQuestDataSchema, {
      command: "status",
      generated_at: await clock.now(),
      filters: { repo: resolved.scope.repo },
      warnings: [],
      data: bareQuestData(stats, resolved.scope),
    });
    dependencies.output.write(formatQuestReport(report));
  } else {
    dependencies.output.write(
      `${renderBareQuest(stats, resolved.scope)}\n\n${createQuestCommand(dependencies.output).helpInformation()}`,
    );
  }
  return EXIT_SUCCESS;
}

async function executeStoreMigration(
  dependencies: QuestCliDependencies,
  flags: GlobalCliOptions,
  backend: CliBackendRuntime,
): Promise<ExitCode> {
  const before = await readStoreCompatibility(backend.compatibilityProbe);
  const storeSchemaVersion = await migrateStore(backend.compatibilityProbe);
  const changed = before.outcome === "store-older";
  if (flags.format === "json") {
    const report = buildQuestReport(migrateDataSchema, {
      command: "migrate",
      generated_at: await backend.clock.now(),
      filters: {},
      warnings: [],
      data: {
        changed,
        store_schema_version: storeSchemaVersion,
      },
    });
    dependencies.output.write(formatQuestReport(report));
  } else {
    dependencies.output.write(
      changed
        ? `quest store migrated to schema ${storeSchemaVersion}\n`
        : `quest store already uses schema ${storeSchemaVersion}\n`,
    );
  }
  return EXIT_SUCCESS;
}

async function executeBareQuestStats(store: QuestStore, scope: QuestScope): Promise<QuestStats> {
  return questStats(store, scope);
}

function renderBareQuest(stats: QuestStats, scope: QuestScope): string {
  const total = stats.repos.reduce((sum, repo) => sum + repo.total, 0);
  const statuses = questStatusSchema.options.flatMap((status) => {
    const count = stats.repos.reduce((sum, repo) => sum + (repo.status_counts[status] ?? 0), 0);
    return count === 0 ? [] : [`${count} ${status}`];
  });
  const repository = scope.repo ?? "all repos";
  return [`quest · ${repository} · ${total} quest${total === 1 ? "" : "s"}`, ...statuses].join(
    " · ",
  );
}

function bareQuestData(stats: QuestStats, scope: QuestScope) {
  return bareQuestDataSchema.parse({
    repo: scope.repo,
    status_counts: Object.fromEntries(
      questStatusSchema.options.map((status) => [
        status,
        stats.repos.reduce((sum, repo) => sum + (repo.status_counts[status] ?? 0), 0),
      ]),
    ),
    total: stats.repos.reduce((sum, repo) => sum + repo.total, 0),
  });
}

export function createQuestCommand(
  output: CliOutputBoundary,
  capture: { set(request: QuestCliRequest): void } = { set: () => undefined },
): Command {
  const program = new Command()
    .name("quest")
    .description("A fast, repo-aware quest tracker")
    .helpOption("-h, --help", "display help")
    .addOption(new Option("-C <dir>", "behave as if run from dir"))
    .addOption(new Option("--repo <name>", "select one repository").conflicts("all"))
    .addOption(new Option("--all", "select every repository").conflicts("repo"))
    .addOption(new Option("--format <format>", "select output format").choices(["json"]))
    .addOption(new Option("--theme <name>", "select the viewer theme"))
    .addOption(new Option("-V, --version", "display version"))
    .allowExcessArguments(false)
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: output.write,
      writeErr: () => undefined,
    })
    .exitOverride();
  registerLifecycleCommands(program, capture);
  registerChainCommands(program, capture);
  registerDoctorCommand(program, capture);
  registerCompletionCommand(program, capture);
  registerQueryCommands(program, capture);
  registerPlanCommand(program, capture);
  registerExportCommand(program, capture);
  registerBackupCommands(program, capture);
  registerMembersCommands(program, capture);
  registerSkillCommands(program, capture);
  registerUpgradeCommand(program, capture);
  registerMigrateCommand(program, capture);
  program.action(() => undefined);
  return program;
}

export async function runQuestCli(
  argumentsWithoutRuntime: readonly string[],
  dependencies: QuestCliDependencies,
): Promise<ExitCode> {
  const parsed = await parseQuestCliArguments(argumentsWithoutRuntime, dependencies.output);
  if (parsed.outcome === "exit") {
    return parsed.exitCode;
  }
  return runParsedQuestCli(parsed.flags, dependencies, parsed.request);
}

export async function parseQuestCliArguments(
  argumentsWithoutRuntime: readonly string[],
  output: CliOutputBoundary,
): Promise<QuestCliArgumentResult> {
  const captured: { request?: QuestCliRequest } = {};
  const program = createQuestCommand(output, {
    set: (request) => {
      captured.request = request;
    },
  });
  try {
    await program.parseAsync(argumentsWithoutRuntime, { from: "user" });
    return {
      outcome: "run",
      flags: parseGlobalOptions(program),
      ...(captured.request === undefined ? {} : { request: captured.request }),
    };
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        return { outcome: "exit", exitCode: EXIT_SUCCESS };
      }
      return {
        outcome: "exit",
        exitCode: output.writeError({
          kind: "usage",
          message: commanderUsageMessage(error),
        }),
      };
    }
    if (
      error instanceof z.ZodError ||
      error instanceof LifecycleCliUsageError ||
      error instanceof ChainCliUsageError ||
      error instanceof QueryCliUsageError ||
      error instanceof ExportCliUsageError ||
      error instanceof BackupCliUsageError ||
      error instanceof MembersCliUsageError ||
      error instanceof SkillCliUsageError ||
      error instanceof MigrateCliUsageError
    ) {
      return {
        outcome: "exit",
        exitCode: output.writeError({
          kind: "usage",
          message: error.message,
        }),
      };
    }
    throw error;
  }
}

export async function runParsedQuestCli(
  flags: GlobalCliOptions,
  dependencies: QuestCliDependencies,
  request?: QuestCliRequest,
): Promise<ExitCode> {
  let exitCode: ExitCode;
  try {
    exitCode = await executeQuestCli(flags, request, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitCode = dependencies.output.writeError({ kind: classifyCliError(error), message });
  }
  try {
    await dependencies.close?.();
  } catch {
    // Cleanup cannot replace the command result after a remote mutation may have committed.
  }
  return exitCode;
}
