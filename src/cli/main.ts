import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigOverrides, LoadConfigOptions, QuestEnvironment } from "../config";
import {
  ConfigLoadError,
  configuredRepositoryStores,
  loadConfig,
  normalizeConvexDeployment,
  readRepositoryRoutingSnapshot,
  resolveRepositoryName,
  resolveRepositoryStore,
  restoreRepositoryConfigEntryIfUnchanged,
  verifyRepositoryConfigEntry,
  verifyRepositoryRoute,
  writeConvexToken,
  writeHostedRepositoryRoutes,
  writeRepositoryStoreConfigIfUnchanged,
} from "../config";
import { cleanupStaleEvidenceMaterializations, createLocalEvidenceFileReader } from "../evidence";
import type { CliOutputBoundary, ExitCode } from "../output";
import { createCliOutputBoundary } from "../output";
import type { EvidenceOpener, PlatformModule, PlatformModuleOptions } from "../platform";
import { createPlatform, validateWorkingDirectory } from "../platform";
import {
  type Config,
  configSchema,
  type QuestScope,
  type RepoConfigEntry,
  type StoreCompatibilityResult,
  type StoreConfig,
} from "../schema";
import {
  createUpgradeOperations,
  type DoctorOperations,
  LocalBackupService,
  migrateRepository,
  type RepositoryMigrationBackend,
  recoverRepositoryFence,
  type UpgradeOperations,
} from "../services";
import {
  type Clock,
  ConvexBackupDatabase,
  ConvexBlobStore,
  ConvexStore,
  closeConvexClientPair,
  createConvexClientPair,
  createConvexClock,
  createConvexStoreCompatibilityProbe,
  createSqliteStore,
  createStoreCompatibilityProbe,
  createSystemClock,
  FederatedBlobStore,
  FederatedQuestStore,
  type FederatedStoreSource,
  inspectSqliteStore,
  LocalBlobStore,
  migrateSqliteStore,
  readSqliteSchemaVersion,
  SQLITE_SCHEMA_VERSION,
  SqliteBackupDatabase,
  type SqliteStore,
  type StoreCompatibilityProbe,
} from "../store";
import { applicationVersion } from "../version";
import { createConvexOnboardingOperations } from "./members";
import type { RepositoryMigrationOperations, RepositoryMigrationRequest } from "./migrate";
import {
  type CliApplicationPorts,
  type FutureTuiLauncher,
  isBackupRecoveryRequest,
  parseQuestCliArguments,
  type QuestCliDependencies,
  type QuestCliRequest,
  runParsedQuestCli,
  runQuestCli,
} from "./program";
import { type CliPrompter, createCliPrompter } from "./prompt";
import {
  type GitIdentityLocator,
  type GitRootLocator,
  type GlobalCliOptions,
  locateGitIdentity,
  locateGitRoot,
  type WorkingDirectoryValidator,
} from "./scope";
import { executeUpgradeCli, isUpgradeCliRequest, type UpgradeCliRequest } from "./upgrade";

type BackendName = Config["store"]["backend"];

export interface CliBackendPorts {
  readonly clock: Clock;
  readonly close?: (() => Promise<void>) | undefined;
  readonly compatibilityProbe: StoreCompatibilityProbe;
  readonly doctor?: DoctorOperations | undefined;
  readonly openApplicationPorts: () => Promise<CliApplicationPorts>;
}

export interface CliBackendFactoryContext {
  readonly config: Awaited<ReturnType<typeof loadConfig>>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform: PlatformModule;
  readonly repo?: string | null;
  readonly recoveryMode?: boolean;
  readonly restoreMode?: boolean;
  readonly store?: StoreConfig;
}

export type CliBackendFactory = (context: CliBackendFactoryContext) => Promise<CliBackendPorts>;

export interface CliBackendFactories {
  readonly sqlite: CliBackendFactory;
  readonly convex: CliBackendFactory;
}

export type PlatformFactory = (options: PlatformModuleOptions) => PlatformModule;
export type ConfigLoader = (
  options: LoadConfigOptions,
) => Promise<CliBackendFactoryContext["config"]>;

export interface CreateCompositionRootOptions {
  readonly backendFactories: CliBackendFactories;
  readonly configDefaults?: ConfigOverrides;
  readonly configFlags?: ConfigOverrides;
  readonly configLoader?: ConfigLoader;
  readonly cleanupStaleEvidence?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly initialWorkingDirectory?: string;
  readonly isTty?: boolean;
  readonly launchTui?: FutureTuiLauncher;
  readonly locateGitIdentity?: GitIdentityLocator;
  readonly locateGitRoot?: GitRootLocator;
  readonly output?: CliOutputBoundary;
  readonly platformFactory?: PlatformFactory;
  readonly prompter?: CliPrompter;
  readonly recoveryMode?: boolean;
  readonly restoreMode?: boolean;
  readonly validateWorkingDirectory?: WorkingDirectoryValidator;
  readonly version?: string;
}

interface BackendHandle {
  readonly ports: CliBackendPorts;
  readonly store: StoreConfig;
}

export interface QuestCompositionRoot {
  readonly dependencies: QuestCliDependencies;
  readonly run: (argumentsWithoutRuntime: readonly string[]) => Promise<ExitCode>;
}

export interface QuestMainRuntime {
  readonly backendFactories?: CliBackendFactories;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly initialWorkingDirectory?: string;
  readonly output?: CliOutputBoundary;
  readonly platformFactory?: PlatformFactory;
  readonly upgradeOperations?: UpgradeOperations;
  readonly version?: string;
}

interface StandaloneUpgradeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly initialWorkingDirectory: string;
  readonly output: CliOutputBoundary;
  readonly platformFactory: PlatformFactory;
  readonly upgradeOperations?: UpgradeOperations;
  readonly version?: string;
}

function backendFactory(name: BackendName, factories: CliBackendFactories): CliBackendFactory {
  switch (name) {
    case "sqlite":
      return factories.sqlite;
    case "convex":
      return factories.convex;
  }
}

function backendDeployment(store: StoreConfig): string | undefined {
  return store.deployment ?? store.convex_deployment;
}

function normalizeBackendStore(store: StoreConfig): StoreConfig {
  const deployment = backendDeployment(store);
  if (
    store.backend !== "convex" ||
    deployment === undefined ||
    store.convex_deployment === deployment
  ) {
    return store;
  }
  return { ...store, convex_deployment: deployment };
}

function backendKey(store: StoreConfig): string {
  return JSON.stringify({ backend: store.backend, deployment: backendDeployment(store) ?? null });
}

function sameBackend(left: StoreConfig, right: StoreConfig): boolean {
  return backendKey(left) === backendKey(right);
}

function repositoryBelongsToBackend(config: Config, store: StoreConfig, repo: string): boolean {
  return sameBackend(resolveRepositoryStore(config, repo), store);
}

function uniqueStoreConfigs(config: Config): StoreConfig[] {
  const stores = [config.store, ...configuredRepositoryStores(config)];
  const unique: StoreConfig[] = [];
  for (const store of stores) {
    if (!unique.some((candidate) => sameBackend(candidate, store))) {
      unique.push(store);
    }
  }
  return unique;
}

interface BackendRouter {
  readonly openDefaultBackend: () => Promise<CliBackendPorts>;
  readonly openConfiguredBackend: (store: StoreConfig) => Promise<CliBackendPorts>;
  readonly openScopedBackend: (scope: QuestScope) => Promise<CliBackendPorts>;
}

function memoizeBackend(factory: () => Promise<BackendHandle>): () => Promise<BackendHandle> {
  let promise: Promise<BackendHandle> | undefined;
  return () => {
    if (promise === undefined) {
      promise = factory();
    }
    return promise;
  };
}

function compatibleFederatedResult(
  results: readonly StoreCompatibilityResult[],
): StoreCompatibilityResult {
  const incompatible = results.find((result) => result.outcome !== "compatible");
  if (incompatible !== undefined) {
    return incompatible;
  }
  const supportedVersion = Math.max(...results.map((result) => result.supported_version));
  const storeVersion = Math.max(...results.map((result) => result.store_version));
  return {
    outcome: "compatible",
    supported_version: supportedVersion,
    store_version: storeVersion,
  };
}

function createFederatedBackend(
  config: Config,
  handles: readonly BackendHandle[],
): CliBackendPorts {
  const compatibilityProbe: StoreCompatibilityProbe = {
    check: async () => {
      const results = await Promise.all(
        handles.map((handle) => handle.ports.compatibilityProbe.check()),
      );
      return compatibleFederatedResult(results);
    },
  };
  return {
    clock: handles[0]?.ports.clock ?? createSystemClock(),
    compatibilityProbe,
    openApplicationPorts: async () => {
      const applications = await Promise.all(
        handles.map((handle) => handle.ports.openApplicationPorts()),
      );
      const sources: FederatedStoreSource[] = [];
      for (const [index, application] of applications.entries()) {
        const handle = handles[index];
        if (handle === undefined || application.questStore === undefined) {
          throw new Error(
            "a configured backend did not provide a quest store; rerun without --all or configure a readable backend",
          );
        }
        sources.push({
          blobStore: application.blobStore,
          includeRepository: (repo) => repositoryBelongsToBackend(config, handle.store, repo),
          questStore: application.questStore,
        });
      }
      const first = applications[0];
      if (first === undefined) {
        throw new Error("no configured backends were available for the federated read");
      }
      return {
        blobStore: new FederatedBlobStore(sources),
        clock: first.clock,
        questStore: new FederatedQuestStore(sources),
      };
    },
  };
}

function createBackendRouter(
  options: CreateCompositionRootOptions,
  config: Config,
  platform: PlatformModule,
  environment: Readonly<Record<string, string | undefined>>,
): BackendRouter {
  const handles = new Map<string, Promise<BackendHandle>>();
  const openConfiguredBackend = (store: StoreConfig): Promise<BackendHandle> => {
    const effectiveStore = normalizeBackendStore(store);
    const key = backendKey(effectiveStore);
    const existing = handles.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const backendConfig = { ...config, store: effectiveStore };
    const opened = backendFactory(
      effectiveStore.backend,
      options.backendFactories,
    )({
      config: backendConfig,
      platform,
      repo: null,
      recoveryMode: options.recoveryMode ?? false,
      restoreMode: options.restoreMode ?? false,
      environment,
      store: effectiveStore,
    }).then((ports) => ({ ports, store: effectiveStore }));
    handles.set(key, opened);
    return opened;
  };

  const openDefault = memoizeBackend(() => openConfiguredBackend(config.store));

  return {
    openDefaultBackend: async () => (await openDefault()).ports,
    openConfiguredBackend: async (store) => (await openConfiguredBackend(store)).ports,
    openScopedBackend: async (scope) => {
      if (scope.repo !== null) {
        return (await openConfiguredBackend(resolveRepositoryStore(config, scope.repo))).ports;
      }
      const scopedHandles = await Promise.all(
        uniqueStoreConfigs(config).map((store) => openConfiguredBackend(store)),
      );
      return createFederatedBackend(config, scopedHandles);
    },
  };
}

function migrationStoreConfig(
  config: Config,
  repository: string,
  request: RepositoryMigrationRequest,
): StoreConfig {
  if (request.target === "sqlite") {
    return { backend: "sqlite" };
  }
  const current = resolveRepositoryStore(config, repository);
  const deployment =
    request.deployment ??
    current.deployment ??
    current.convex_deployment ??
    config.store.deployment ??
    config.store.convex_deployment;
  if (deployment === undefined) {
    throw new Error(
      "[MIGRATION_DEPLOYMENT_REQUIRED] `quest migrate --to convex` needs --deployment <url> or a configured store deployment; retry with one",
    );
  }
  return { backend: "convex", convex_deployment: normalizeConvexDeployment(deployment) };
}

function requireMigrationBackend(
  config: StoreConfig,
  application: CliApplicationPorts,
  role: "source" | "destination",
): RepositoryMigrationBackend {
  if (application.questStore === undefined) {
    throw new Error(
      `[MIGRATION_STORE_UNAVAILABLE] the ${role} ${config.backend} store did not open; retry without recovery mode`,
    );
  }
  if (application.backup === undefined) {
    throw new Error(
      `[MIGRATION_BACKUP_UNAVAILABLE] the ${role} backend has no backup operation; migration refuses to write without a backup`,
    );
  }
  return {
    backup: application.backup,
    blobStore: application.blobStore,
    config,
    questStore: application.questStore,
  };
}

interface PreparedRepositoryMigration {
  readonly originalRepositoryConfig: RepoConfigEntry | undefined;
  readonly repository: string;
  readonly routingSnapshot: Awaited<ReturnType<typeof readRepositoryRoutingSnapshot>>;
  readonly sourceConfig: StoreConfig;
  readonly targetConfig: StoreConfig;
}

async function prepareRepositoryMigration(
  configFile: string,
  request: RepositoryMigrationRequest,
  reloadConfig: () => Promise<Config>,
): Promise<PreparedRepositoryMigration> {
  const routingSnapshot = await readRepositoryRoutingSnapshot(configFile, request.repository);
  const activeConfig = await reloadConfig();
  if (!(await verifyRepositoryRoute(configFile, routingSnapshot))) {
    throw new Error(
      `[MIGRATION_ROUTE_CHANGED] routing for ${request.repository} changed while migration was starting; inspect config.toml and retry`,
    );
  }
  const repository = resolveRepositoryName(activeConfig, request.repository);
  if (repository !== routingSnapshot.canonicalRepository) {
    throw new Error(
      `[MIGRATION_ROUTE_OVERRIDDEN] ${request.repository} resolves to ${repository} through active config layers, but config.toml routes it through ${routingSnapshot.canonicalRepository}; align the configured alias and retry`,
    );
  }
  const sourceConfig = resolveRepositoryStore(activeConfig, repository);
  if (!sameBackend(sourceConfig, routingSnapshot.sourceStore)) {
    throw new Error(
      `[MIGRATION_ROUTE_OVERRIDDEN] active config layers route ${repository} to ${sourceConfig.backend}, but config.toml currently routes it to ${routingSnapshot.sourceStore.backend}; remove the override and retry`,
    );
  }
  return {
    originalRepositoryConfig: routingSnapshot.repositoryEntry,
    repository,
    routingSnapshot,
    sourceConfig,
    targetConfig: migrationStoreConfig(activeConfig, repository, request),
  };
}

function createRepositoryMigrationOperations(
  platform: PlatformModule,
  router: BackendRouter,
  reloadConfig: () => Promise<Config>,
): RepositoryMigrationOperations {
  const configFile = join(platform.directories.config, "config.toml");
  return {
    migrate: async (request) => {
      const { originalRepositoryConfig, repository, routingSnapshot, sourceConfig, targetConfig } =
        await prepareRepositoryMigration(configFile, request, reloadConfig);
      const verifyEffectiveRoute = async (expectedStore: StoreConfig): Promise<boolean> => {
        const reloaded = await reloadConfig();
        return (
          resolveRepositoryName(reloaded, request.repository) ===
            routingSnapshot.canonicalRepository &&
          sameBackend(resolveRepositoryStore(reloaded, request.repository), expectedStore)
        );
      };
      const verifyDestinationRoute = async (): Promise<boolean> => {
        const current = await readRepositoryRoutingSnapshot(configFile, request.repository);
        const persistedRoute =
          writtenRepositoryConfig === undefined
            ? typeof current.repositoryEntry === "object" &&
              current.repositoryEntry !== null &&
              current.repositoryEntry.store !== undefined &&
              sameBackend(current.repositoryEntry.store, targetConfig)
            : await verifyRepositoryConfigEntry(configFile, repository, writtenRepositoryConfig);
        return (
          current.canonicalRepository === repository &&
          sameBackend(current.sourceStore, targetConfig) &&
          persistedRoute &&
          (await verifyEffectiveRoute(targetConfig))
        );
      };
      if (sameBackend(sourceConfig, targetConfig)) {
        const recoveryBackend = await router.openConfiguredBackend(targetConfig);
        try {
          const recoveryApplication = await recoveryBackend.openApplicationPorts();
          if (recoveryApplication.questStore === undefined) {
            throw new Error(
              `[MIGRATION_STORE_UNAVAILABLE] the ${targetConfig.backend} backend did not open for fence recovery; retry after checking the backend configuration`,
            );
          }
          const recovered = await recoverRepositoryFence(
            recoveryApplication.questStore,
            targetConfig,
            repository,
          );
          if (recovered !== null) {
            return recovered;
          }
        } finally {
          await closeBackend(recoveryBackend);
        }
        throw new Error(
          `[MIGRATION_ALREADY_ON_TARGET] repository ${repository} already uses ${targetConfig.backend}; choose the other backend or inspect its routing block`,
        );
      }

      const sourceBackend = await router.openConfiguredBackend(sourceConfig);
      let targetBackend: CliBackendPorts | undefined;
      let writtenRepositoryConfig: RepoConfigEntry | undefined;
      try {
        const sourceApplication = await sourceBackend.openApplicationPorts();
        targetBackend = await router.openConfiguredBackend(targetConfig);
        const targetApplication = await targetBackend.openApplicationPorts();
        return await migrateRepository({
          repository,
          source: requireMigrationBackend(sourceConfig, sourceApplication, "source"),
          target: requireMigrationBackend(targetConfig, targetApplication, "destination"),
          writeRouting: async () => {
            writtenRepositoryConfig = await writeRepositoryStoreConfigIfUnchanged(
              configFile,
              targetConfig,
              routingSnapshot,
            );
            const rawRouteWritten = await verifyRepositoryConfigEntry(
              configFile,
              repository,
              writtenRepositoryConfig,
            );
            if (!rawRouteWritten || !(await verifyDestinationRoute())) {
              throw new Error(
                `[MIGRATION_ROUTE_NOT_EFFECTIVE] config.toml was updated, but active config layers do not route ${repository} to ${targetConfig.backend}; remove the override and retry`,
              );
            }
          },
          verifyRouting: async () =>
            (await verifyRepositoryRoute(configFile, routingSnapshot)) &&
            (await verifyEffectiveRoute(sourceConfig)),
          verifyDestinationRouting: verifyDestinationRoute,
          rollbackRouting: async () => {
            if (writtenRepositoryConfig === undefined) {
              return (
                (await verifyRepositoryRoute(configFile, routingSnapshot)) &&
                (await verifyEffectiveRoute(sourceConfig))
              );
            }
            const restored = await restoreRepositoryConfigEntryIfUnchanged(
              configFile,
              repository,
              writtenRepositoryConfig,
              originalRepositoryConfig,
            );
            if (!restored) {
              return false;
            }
            return (
              (await verifyRepositoryRoute(configFile, routingSnapshot)) &&
              (await verifyEffectiveRoute(sourceConfig))
            );
          },
        });
      } finally {
        await closeBackend(targetBackend);
        await closeBackend(sourceBackend);
      }
    },
  };
}

async function closeBackend(backend: CliBackendPorts | undefined): Promise<void> {
  try {
    await backend?.close?.();
  } catch {
    // Cleanup cannot replace a migration result after routing or fence state may have committed.
  }
}

function createLazyBackendPorts(
  openDefaultBackend: () => Promise<CliBackendPorts>,
): CliBackendPorts {
  return {
    clock: {
      now: async () => (await openDefaultBackend()).clock.now(),
    },
    compatibilityProbe: {
      check: async () => (await openDefaultBackend()).compatibilityProbe.check(),
      migrate: async () => {
        const probe = (await openDefaultBackend()).compatibilityProbe;
        if (probe.migrate === undefined) {
          throw new Error("the configured store backend does not support schema migration");
        }
        await probe.migrate();
      },
    },
    openApplicationPorts: async () => (await openDefaultBackend()).openApplicationPorts(),
  };
}

async function openSqliteStore(databasePath: string): Promise<SqliteStore> {
  return createSqliteStore(databasePath);
}

async function openSqliteStoreForRecovery(databasePath: string): Promise<SqliteStore | undefined> {
  try {
    if (readSqliteSchemaVersion(databasePath) !== SQLITE_SCHEMA_VERSION) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  let questStore: SqliteStore | undefined;
  try {
    questStore = createSqliteStore(databasePath);
    const integrity = questStore.inspectBackupState().integrity_check;
    if (integrity.length !== 1 || integrity[0]?.toLowerCase() !== "ok") {
      questStore.close();
      return undefined;
    }
    return questStore;
  } catch {
    questStore?.close();
    return undefined;
  }
}

export function createSqliteCliBackend(
  context: CliBackendFactoryContext,
): Promise<CliBackendPorts> {
  const databasePath = join(context.platform.directories.state, "quest.db");
  const configFile = join(context.platform.directories.config, "config.toml");
  const evidenceDirectory = context.platform.directories.evidence;
  const backupRoot = context.config.backup.root ?? context.platform.directories.backup;
  const clock = createSystemClock();
  const doctor: DoctorOperations = {
    backup: new LocalBackupService({
      backupDatabase: new SqliteBackupDatabase(databasePath),
      clock,
      configFile,
      defaultRoot: backupRoot,
      evidenceDirectory,
      retention: context.config.backup.retention,
    }),
    blobStore: new LocalBlobStore(evidenceDirectory),
    ...(context.platform.inspectProcessesHoldingPaths === undefined
      ? {}
      : {
          inspectProcesses: () =>
            context.platform.inspectProcessesHoldingPaths?.([
              databasePath,
              `${databasePath}.ownership.sqlite`,
            ]) ?? Promise.resolve({ available: false, holders: [] }),
        }),
    inspectStore: async () => inspectSqliteStore(databasePath),
    paths: {
      backup: backupRoot,
      database: databasePath,
      evidence: evidenceDirectory,
      ownership_database: `${databasePath}.ownership.sqlite`,
      temporary_directory: tmpdir(),
    },
  };
  return Promise.resolve({
    clock,
    compatibilityProbe: createStoreCompatibilityProbe({
      migrateStore: () =>
        migrateSqliteStore({
          backupRoot,
          databasePath,
        }),
      readStoreVersion: () => readSqliteSchemaVersion(databasePath),
      supportedVersion: SQLITE_SCHEMA_VERSION,
    }),
    openApplicationPorts: async () => {
      const questStore = context.recoveryMode
        ? context.restoreMode
          ? await openSqliteStoreForRecovery(databasePath)
          : undefined
        : await openSqliteStore(databasePath);
      return {
        backup: new LocalBackupService({
          backupDatabase: new SqliteBackupDatabase(databasePath, questStore),
          clock,
          configFile,
          defaultRoot: backupRoot,
          evidenceDirectory,
          retention: context.config.backup.retention,
        }),
        blobStore: new LocalBlobStore(evidenceDirectory),
        clock,
        scheduler: context.platform.scheduler,
        ...(questStore === undefined ? {} : { questStore }),
      };
    },
    doctor,
  });
}

async function loadCompositionConfig(
  options: CreateCompositionRootOptions,
  platform: PlatformModule,
  environment: QuestEnvironment,
): Promise<Config> {
  try {
    return await (options.configLoader ?? loadConfig)({
      platform,
      environment,
      ...(options.configDefaults === undefined ? {} : { defaults: options.configDefaults }),
      ...(options.configFlags === undefined ? {} : { flags: options.configFlags }),
    });
  } catch (error: unknown) {
    if (!options.recoveryMode || !(error instanceof ConfigLoadError)) {
      throw error;
    }
    return configSchema.parse({
      backup: {
        root:
          options.configFlags?.backupRoot ??
          environment.QUEST_BACKUP_ROOT ??
          options.configDefaults?.backupRoot ??
          platform.directories.backup,
      },
    });
  }
}

async function createConvexCliBackend(context: CliBackendFactoryContext): Promise<CliBackendPorts> {
  const selectedStore = context.store ?? context.config.store;
  const configuredDeployment = selectedStore.convex_deployment ?? selectedStore.deployment;
  if (configuredDeployment === undefined) {
    throw new Error(
      "the selected Convex store has no deployment URL; set store.convex_deployment or store.deployment and retry",
    );
  }
  const deployment = normalizeConvexDeployment(configuredDeployment);
  const environmentToken = context.environment?.["QUEST_CONVEX_TOKEN"]?.trim();
  const token =
    environmentToken === undefined || environmentToken === ""
      ? context.config.convex?.[deployment]?.token
      : environmentToken;
  const clients = createConvexClientPair(
    deployment,
    token === undefined ? {} : { authToken: token },
  );
  const questStore = new ConvexStore(deployment, { clients });
  const blobStore = new ConvexBlobStore(deployment, { clients });
  const clock = createConvexClock(clients);
  const databasePath = join(context.platform.directories.state, "quest.convex.json");
  const backupRoot = context.config.backup.root ?? context.platform.directories.backup;
  const backup = new LocalBackupService({
    backupDatabase: new ConvexBackupDatabase(databasePath, questStore),
    blobStore,
    clock,
    configFile: join(context.platform.directories.config, "config.toml"),
    defaultRoot: backupRoot,
    evidenceDirectory: context.platform.directories.evidence,
    retention: context.config.backup.retention,
  });
  return {
    clock,
    close: () => closeConvexClientPair(clients),
    compatibilityProbe: createConvexStoreCompatibilityProbe(deployment, { clients }),
    doctor: {
      backup,
      blobStore,
      inspectStore: async () => ({
        dump: await questStore.exportAll(),
        integrity_check: ["ok"],
        state: "present",
      }),
      paths: {
        backup: backupRoot,
        database: databasePath,
        evidence: context.platform.directories.evidence,
        ownership_database: "Convex-managed transaction ownership",
        temporary_directory: tmpdir(),
      },
    },
    openApplicationPorts: async () => ({
      backup,
      blobStore,
      clock,
      questStore,
    }),
  };
}

function createEvidenceOpener(platform: PlatformModule): EvidenceOpener | undefined {
  return platform.openEvidence === undefined
    ? undefined
    : { openEvidence: platform.openEvidence, openUrl: platform.openUrl };
}

async function cleanupStartupEvidence(enabled: boolean | undefined): Promise<void> {
  if (enabled ?? true) {
    await cleanupStaleEvidenceMaterializations();
  }
}

function shouldRunStandaloneUpgrade(
  flags: GlobalCliOptions,
  request: QuestCliRequest | undefined,
): request is UpgradeCliRequest {
  return !flags.version && request !== undefined && isUpgradeCliRequest(request);
}

function githubToken(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return (
    environment["QUEST_GITHUB_TOKEN"] ?? environment["GH_TOKEN"] ?? environment["GITHUB_TOKEN"]
  );
}

function standaloneUpgradeOptions(
  runtime: QuestMainRuntime,
  output: CliOutputBoundary,
): StandaloneUpgradeOptions {
  return {
    environment: runtime.environment ?? process.env,
    initialWorkingDirectory: runtime.initialWorkingDirectory ?? process.cwd(),
    output,
    platformFactory: runtime.platformFactory ?? createPlatform,
    ...(runtime.upgradeOperations === undefined
      ? {}
      : { upgradeOperations: runtime.upgradeOperations }),
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
  };
}

function compositionRootOptions(
  runtime: QuestMainRuntime,
  launchTui: FutureTuiLauncher,
  output: CliOutputBoundary,
  request: QuestCliRequest | undefined,
): CreateCompositionRootOptions {
  return {
    backendFactories: runtime.backendFactories ?? {
      sqlite: createSqliteCliBackend,
      convex: createConvexCliBackend,
    },
    launchTui,
    output,
    cleanupStaleEvidence: request?.command !== "doctor",
    recoveryMode: isBackupRecoveryRequest(request),
    restoreMode: request?.command === "backup-restore",
    ...(runtime.environment === undefined ? {} : { environment: runtime.environment }),
    ...(runtime.initialWorkingDirectory === undefined
      ? {}
      : { initialWorkingDirectory: runtime.initialWorkingDirectory }),
    ...(runtime.platformFactory === undefined ? {} : { platformFactory: runtime.platformFactory }),
    ...(runtime.version === undefined ? {} : { version: runtime.version }),
  };
}

async function runStandaloneUpgrade(
  flags: GlobalCliOptions,
  request: UpgradeCliRequest,
  options: StandaloneUpgradeOptions,
): Promise<ExitCode> {
  const platform = options.platformFactory({
    environment: options.environment,
    workingDirectory: options.initialWorkingDirectory,
  });
  const token = githubToken(options.environment);
  const operations =
    options.upgradeOperations ??
    createUpgradeOperations({
      executablePath: platform.directories.executable,
      platform: platform.name,
      ...(options.environment["QUEST_UPGRADE_REPO"] === undefined
        ? {}
        : { repository: options.environment["QUEST_UPGRADE_REPO"] }),
      ...(token === undefined ? {} : { token }),
      ...(platform.replaceExecutable === undefined
        ? {}
        : { replaceExecutable: platform.replaceExecutable }),
    });
  return executeUpgradeCli({
    applicationVersion: options.version ?? applicationVersion,
    clock: createSystemClock(),
    format: flags.format,
    operations,
    output: options.output,
    request,
  });
}

function createCliDependencies(input: {
  readonly config: Awaited<ReturnType<typeof loadConfig>>;
  readonly configFile: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly initialWorkingDirectory: string;
  readonly migration: RepositoryMigrationOperations;
  readonly openDefaultBackend: () => Promise<CliBackendPorts>;
  readonly openScopedBackend: (scope: QuestScope) => Promise<CliBackendPorts>;
  readonly options: CreateCompositionRootOptions;
  readonly ports: CliBackendPorts;
  readonly upgrade: ReturnType<typeof createUpgradeOperations>;
  readonly viewer: EvidenceOpener | undefined;
}): QuestCliDependencies {
  const {
    config,
    configFile,
    environment,
    initialWorkingDirectory,
    migration,
    openDefaultBackend,
    openScopedBackend,
    options,
    ports,
    upgrade,
    viewer,
  } = input;
  return {
    applicationVersion: options.version ?? applicationVersion,
    clock: ports.clock,
    ...(ports.close === undefined ? {} : { close: ports.close }),
    compatibilityProbe: ports.compatibilityProbe,
    config,
    environment,
    onboarding: createConvexOnboardingOperations(),
    configWriter: {
      writeToken: (deployment, token) => writeConvexToken(configFile, deployment, token),
      writeRouting: (deployment, repositories) =>
        writeHostedRepositoryRoutes(configFile, repositories, deployment),
    },
    evidenceFiles: createLocalEvidenceFileReader(),
    initialWorkingDirectory,
    isTty: options.isTty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ...(options.launchTui === undefined ? {} : { launchTui: options.launchTui }),
    locateGitIdentity: options.locateGitIdentity ?? locateGitIdentity,
    locateGitRoot: options.locateGitRoot ?? locateGitRoot,
    migration,
    openApplicationPorts: ports.openApplicationPorts,
    openBackend: openScopedBackend,
    openDefaultBackend,
    output: options.output ?? createCliOutputBoundary(),
    prompter: options.prompter ?? createCliPrompter(),
    readStdin: () => Bun.stdin.text(),
    upgrade,
    validateWorkingDirectory: options.validateWorkingDirectory ?? validateWorkingDirectory,
    ...(viewer === undefined ? {} : { viewer }),
    ...(ports.doctor === undefined ? {} : { doctor: ports.doctor }),
  };
}

export async function createCompositionRoot(
  options: CreateCompositionRootOptions,
): Promise<QuestCompositionRoot> {
  const environment = options.environment ?? process.env;
  const initialWorkingDirectory = options.initialWorkingDirectory ?? process.cwd();
  const platform = (options.platformFactory ?? createPlatform)({
    environment,
    workingDirectory: initialWorkingDirectory,
  });
  await cleanupStartupEvidence(options.cleanupStaleEvidence);
  const config = await loadCompositionConfig(options, platform, environment);
  const viewer = createEvidenceOpener(platform);
  const token = githubToken(environment);
  const upgrade = createUpgradeOperations({
    executablePath: platform.directories.executable,
    platform: platform.name,
    ...(environment["QUEST_UPGRADE_REPO"] === undefined
      ? {}
      : { repository: environment["QUEST_UPGRADE_REPO"] }),
    ...(token === undefined ? {} : { token }),
    ...(platform.replaceExecutable === undefined
      ? {}
      : { replaceExecutable: platform.replaceExecutable }),
  });
  const router = createBackendRouter(options, config, platform, environment);
  const openDefaultBackend = router.openDefaultBackend;
  const ports = createLazyBackendPorts(openDefaultBackend);
  const migration = createRepositoryMigrationOperations(platform, router, () =>
    loadCompositionConfig(options, platform, environment),
  );
  const dependencies = createCliDependencies({
    config,
    configFile: join(platform.directories.config, "config.toml"),
    environment,
    initialWorkingDirectory,
    migration,
    openDefaultBackend,
    openScopedBackend: router.openScopedBackend,
    options,
    ports,
    upgrade,
    viewer,
  });

  return {
    dependencies,
    run: (argumentsWithoutRuntime) => runQuestCli(argumentsWithoutRuntime, dependencies),
  };
}

export async function runQuestMain(
  launchTui: FutureTuiLauncher,
  argumentsWithoutRuntime: readonly string[] = process.argv.slice(2),
  runtime: QuestMainRuntime = {},
): Promise<ExitCode> {
  const output = runtime.output ?? createCliOutputBoundary();
  try {
    const parsed = await parseQuestCliArguments(argumentsWithoutRuntime, output);
    if (parsed.outcome === "exit") {
      return parsed.exitCode;
    }
    if (shouldRunStandaloneUpgrade(parsed.flags, parsed.request)) {
      return await runStandaloneUpgrade(
        parsed.flags,
        parsed.request,
        standaloneUpgradeOptions(runtime, output),
      );
    }
    const root = await createCompositionRoot(
      compositionRootOptions(runtime, launchTui, output, parsed.request),
    );
    return await runParsedQuestCli(parsed.flags, root.dependencies, parsed.request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return output.writeError({
      kind: error instanceof ConfigLoadError ? "usage" : "domain",
      message,
    });
  }
}
