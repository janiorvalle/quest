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
  writeViewerTheme,
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
  type BlobStore,
  type Clock,
  CONVEX_OLDER_STORE_REMEDY,
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
  FederatedReadError,
  type FederatedReadSnapshot,
  type FederatedSnapshotWatchListener,
  type FederatedStoreSource,
  inspectSqliteStore,
  LocalBlobStore,
  migrateSqliteStore,
  type QuestStore,
  readSqliteSchemaVersion,
  SQLITE_SCHEMA_VERSION,
  SqliteBackupDatabase,
  type SqliteStore,
  type StoreCompatibilityProbe,
  type WatchSubscription,
} from "../store";
import { applicationVersion } from "../version";
import { createConvexOnboardingOperations } from "./members";
import type { RepositoryMigrationOperations, RepositoryMigrationRequest } from "./migrate";
import {
  type CliApplicationPorts,
  type FutureTuiLauncher,
  isBackupRecoveryRequest,
  parseQuestCliArguments,
  type QuestCliBackendOpenOptions,
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
import { refreshInstalledSkillsAfterUpgrade } from "./skill";
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

interface OpenedBackendApplication {
  readonly application: CliApplicationPorts;
  readonly handle: BackendHandle;
}

interface FederatedSources {
  readonly sourceFailures: ReadonlyMap<string, string>;
  readonly sources: readonly FederatedStoreSource[];
  readonly sourceHandles: readonly BackendHandle[];
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
  return JSON.stringify({
    backend: store.backend,
    deployment: backendDeployment(store) ?? null,
    lease_ttl_minutes: store.lease_ttl_minutes ?? null,
  });
}

function physicalBackendKey(store: StoreConfig): string {
  return JSON.stringify({
    backend: store.backend,
    deployment: backendDeployment(store) ?? null,
  });
}

function sameBackend(left: StoreConfig, right: StoreConfig): boolean {
  return backendKey(left) === backendKey(right);
}

function samePhysicalBackend(left: StoreConfig, right: StoreConfig): boolean {
  return physicalBackendKey(left) === physicalBackendKey(right);
}

function repositoryBelongsToPhysicalBackend(
  config: Config,
  store: StoreConfig,
  repo: string,
): boolean {
  return samePhysicalBackend(resolveRepositoryStore(config, repo), store);
}

function sameRepositorySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const repository of left) {
    if (!right.has(repository)) {
      return false;
    }
  }
  return true;
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
  readonly openScopedBackend: (
    scope: QuestScope,
    options?: QuestCliBackendOpenOptions,
  ) => Promise<CliBackendPorts>;
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

function compatibilityFailureMessage(
  result: Exclude<StoreCompatibilityResult, { outcome: "compatible" }>,
  olderStoreRemedy?: string,
): string {
  return result.outcome === "store-newer"
    ? `store schema ${result.store_version} was written by a newer quest; upgrade the quest binary (this binary supports schema ${result.supported_version})`
    : `store schema ${result.store_version} is older than this binary supports (${result.supported_version}); ${olderStoreRemedy ?? "run quest migrate before retrying"}`;
}

function backendFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedBackendHandle(store: StoreConfig, failure: string): BackendHandle {
  const retry = async (): Promise<never> => {
    throw new Error(failure);
  };
  return {
    ports: {
      clock: createSystemClock(),
      close: async () => undefined,
      compatibilityProbe: { check: retry },
      openApplicationPorts: retry,
    },
    store,
  };
}

function recordCompatibilityAttempt(
  attempt: PromiseSettledResult<StoreCompatibilityResult>,
  handle: BackendHandle,
  compatibilityFailures: Map<string, string>,
  compatible: StoreCompatibilityResult[],
  incompatible: IncompatibleCompatibility[],
): void {
  const key = backendKey(handle.store);
  if (attempt.status === "rejected") {
    const detail =
      attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason);
    compatibilityFailures.set(key, detail);
    return;
  }
  if (attempt.value.outcome === "compatible") {
    compatibilityFailures.delete(key);
    compatible.push(attempt.value);
    return;
  }
  const olderStoreRemedy = handle.ports.compatibilityProbe.olderStoreRemedy;
  compatibilityFailures.set(key, compatibilityFailureMessage(attempt.value, olderStoreRemedy));
  incompatible.push({
    result: attempt.value,
    ...(olderStoreRemedy === undefined ? {} : { olderStoreRemedy }),
  });
}

interface IncompatibleCompatibility {
  readonly olderStoreRemedy?: string;
  readonly result: Exclude<StoreCompatibilityResult, { outcome: "compatible" }>;
}

async function createFederatedStoreSource(
  config: Config,
  handle: BackendHandle | undefined,
  application: CliApplicationPorts,
  compatibilityFailure: string | undefined,
  repositoryMatcher: (
    config: Config,
    store: StoreConfig,
    repo: string,
  ) => boolean = repositoryBelongsToPhysicalBackend,
): Promise<FederatedStoreSource> {
  if (handle === undefined || application.questStore === undefined) {
    throw new Error(
      "a configured backend did not provide a quest store; rerun without --all or configure a readable backend",
    );
  }

  let fencedRepositories: ReadonlySet<string> = new Set();
  let observedFences: ReadonlySet<string> | undefined;
  let routingStale = false;
  let readFailure = compatibilityFailure;
  const listFencedRepositories = application.questStore.listFencedRepositories?.bind(
    application.questStore,
  );
  const readSnapshot = application.questStore.readFederatedSnapshot?.bind(application.questStore);
  const watchSnapshot = application.questStore.watchFederatedSnapshot?.bind(application.questStore);
  const observeSnapshot = (snapshot: FederatedReadSnapshot): FederatedReadSnapshot => {
    const nextFences = new Set(snapshot.fencedRepositories);
    if (observedFences !== undefined && !sameRepositorySet(observedFences, nextFences)) {
      routingStale = true;
    }
    observedFences = nextFences;
    fencedRepositories = nextFences;
    readFailure = compatibilityFailure;
    return snapshot;
  };
  const readSnapshotPort =
    readSnapshot === undefined ? undefined : async () => observeSnapshot(await readSnapshot());
  const watchSnapshotPort =
    watchSnapshot === undefined
      ? undefined
      : (listener: Parameters<typeof watchSnapshot>[0]) =>
          watchSnapshot((snapshot, error) => {
            listener(error === undefined ? observeSnapshot(snapshot) : snapshot, error);
          });
  const refresh = async (): Promise<void> => {
    if (listFencedRepositories === undefined) {
      return;
    }
    try {
      const nextFences = new Set(await listFencedRepositories());
      if (observedFences !== undefined && !sameRepositorySet(observedFences, nextFences)) {
        routingStale = true;
      }
      observedFences = nextFences;
      fencedRepositories = nextFences;
      readFailure = compatibilityFailure;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      fencedRepositories = new Set();
      readFailure = `[FEDERATED_FENCE_READ_UNAVAILABLE] cannot determine migration fences for ${handle.store.backend} backend; retry when it is reachable (${detail})`;
    }
  };
  if (readSnapshotPort === undefined) {
    await refresh();
  }

  const readError = (repository: string | undefined): Error | undefined => {
    if (routingStale) {
      return new FederatedReadError(
        "[FEDERATED_ROUTING_STALE] repository routing changed while the viewer was open; restart the Quest viewer to reload configured backends before reading again",
      );
    }
    if (readFailure === undefined) {
      return undefined;
    }
    const scope =
      repository === undefined ? "the federated repository view" : `repository ${repository}`;
    return new FederatedReadError(
      `[FEDERATED_SCOPE_UNAVAILABLE] ${scope} cannot read the routed ${handle.store.backend} backend; retry when its deployment is reachable. No local fallback was used (${readFailure})`,
    );
  };

  return {
    blobStore: application.blobStore,
    includeRepository: (repo) =>
      !routingStale &&
      readFailure === undefined &&
      !fencedRepositories.has(repo) &&
      repositoryMatcher(config, handle.store, repo),
    questStore: application.questStore,
    readError,
    ...(readSnapshotPort === undefined ? {} : { readSnapshot: readSnapshotPort }),
    routesRepository: (repo) => repositoryMatcher(config, handle.store, repo),
    ...(readSnapshotPort !== undefined || listFencedRepositories === undefined ? {} : { refresh }),
    ...(watchSnapshotPort === undefined ? {} : { watchSnapshot: watchSnapshotPort }),
  };
}

function createUnavailableFederatedStoreSource(
  config: Config,
  handle: BackendHandle,
  questStore: QuestStore,
  blobStore: BlobStore,
  readFailure: string,
): FederatedStoreSource {
  let activeSource: FederatedStoreSource | undefined;
  let currentFailure: string | undefined = readFailure;
  const readError = (repository: string | undefined): Error | undefined => {
    if (activeSource !== undefined) {
      return activeSource.readError?.(repository);
    }
    const scope =
      repository === undefined ? "the federated repository view" : `repository ${repository}`;
    return new FederatedReadError(
      `[FEDERATED_SCOPE_UNAVAILABLE] ${scope} cannot read the routed ${handle.store.backend} backend; retry after fixing its deployment. No local fallback was used (${currentFailure ?? "backend retry is in progress"})`,
    );
  };
  const refresh = async (): Promise<void> => {
    if (activeSource === undefined) {
      try {
        const compatibility = await handle.ports.compatibilityProbe.check();
        if (compatibility.outcome !== "compatible") {
          currentFailure = compatibilityFailureMessage(
            compatibility,
            handle.ports.compatibilityProbe.olderStoreRemedy,
          );
          return;
        }
        const application = await handle.ports.openApplicationPorts();
        activeSource = await createFederatedStoreSource(config, handle, application, undefined);
        currentFailure = undefined;
      } catch (error: unknown) {
        currentFailure = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    await activeSource?.refresh?.();
  };
  const recoveryWatchSnapshot: FederatedStoreSource["watchSnapshot"] =
    handle.store.backend !== "convex"
      ? undefined
      : (listener) =>
          watchRecoveringFederatedSource({
            currentWatch: () => activeSource?.watchSnapshot,
            listener,
            refresh,
          });
  return {
    get blobStore() {
      return activeSource?.blobStore ?? blobStore;
    },
    includeRepository: (repo) => activeSource?.includeRepository(repo) ?? false,
    needsWatchPolling: () =>
      recoveryWatchSnapshot === undefined &&
      (activeSource === undefined || activeSource.watchSnapshot === undefined),
    get questStore() {
      return activeSource?.questStore ?? questStore;
    },
    readError,
    get readSnapshot() {
      return activeSource?.readSnapshot;
    },
    refresh,
    routesRepository: (repo) => repositoryBelongsToPhysicalBackend(config, handle.store, repo),
    ...(recoveryWatchSnapshot === undefined ? {} : { watchSnapshot: recoveryWatchSnapshot }),
  };
}

interface RecoveringFederatedWatchOptions {
  readonly currentWatch: () => FederatedStoreSource["watchSnapshot"];
  readonly listener: FederatedSnapshotWatchListener;
  readonly refresh: () => Promise<void>;
}

async function watchRecoveringFederatedSource(
  options: RecoveringFederatedWatchOptions,
): Promise<WatchSubscription> {
  let subscribed = true;
  let liveSubscription: WatchSubscription | undefined;

  const connect = async (): Promise<void> => {
    await options.refresh();
    if (!subscribed) {
      return;
    }
    const watchSnapshot = options.currentWatch();
    if (watchSnapshot === undefined) {
      throw new FederatedReadError(
        "[FEDERATED_REALTIME_UNAVAILABLE] the recovered backend is not ready for live updates; retry registration",
      );
    }
    const openedSubscription = await watchSnapshot(options.listener);
    if (!subscribed) {
      await openedSubscription.unsubscribe();
      return;
    }
    liveSubscription = openedSubscription;
  };

  await connect();
  return {
    unsubscribe: async () => {
      subscribed = false;
      await liveSubscription?.unsubscribe();
    },
  };
}

async function openFederatedApplications(
  handles: readonly BackendHandle[],
  compatibilityFailures: ReadonlyMap<string, string>,
): Promise<{
  readonly applications: readonly OpenedBackendApplication[];
  readonly failures: ReadonlyMap<string, string>;
}> {
  const readableHandles = handles.filter(
    (handle) => compatibilityFailures.get(backendKey(handle.store)) === undefined,
  );
  const attempts = await Promise.allSettled(
    readableHandles.map(async (handle) => ({
      application: await handle.ports.openApplicationPorts(),
      handle,
    })),
  );
  const failures = new Map<string, string>();
  const applications: OpenedBackendApplication[] = [];
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.status === "fulfilled") {
      applications.push(attempt.value);
      continue;
    }
    const handle = readableHandles[index];
    if (handle !== undefined) {
      failures.set(backendKey(handle.store), backendFailureMessage(attempt.reason));
    }
  }
  return { applications, failures };
}

async function createFederatedSources(
  config: Config,
  applications: readonly OpenedBackendApplication[],
  compatibilityFailures: ReadonlyMap<string, string>,
  repositoryMatcher: (
    config: Config,
    store: StoreConfig,
    repo: string,
  ) => boolean = repositoryBelongsToPhysicalBackend,
): Promise<FederatedSources> {
  const attempts = await Promise.allSettled(
    applications.map(({ application, handle }) =>
      createFederatedStoreSource(
        config,
        handle,
        application,
        compatibilityFailures.get(backendKey(handle.store)),
        repositoryMatcher,
      ).then((source) => ({ handle, source })),
    ),
  );
  const sourceFailures = new Map<string, string>();
  const sources: FederatedStoreSource[] = [];
  const sourceHandles: BackendHandle[] = [];
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.status === "fulfilled") {
      sources.push(attempt.value.source);
      sourceHandles.push(attempt.value.handle);
      continue;
    }
    const handle = applications[index]?.handle;
    if (handle !== undefined) {
      sourceFailures.set(backendKey(handle.store), backendFailureMessage(attempt.reason));
    }
  }
  return {
    sourceFailures,
    sources,
    sourceHandles,
  };
}

function createFederatedBackend(
  config: Config,
  handles: readonly BackendHandle[],
  options: {
    readonly allowPartialReads: boolean;
    readonly initialFailures?: readonly { readonly store: StoreConfig; readonly message: string }[];
  },
): CliBackendPorts {
  const failedHandles =
    options.initialFailures?.map(({ store, message }) => failedBackendHandle(store, message)) ?? [];
  const allHandles = [...handles, ...failedHandles];
  const physicalGroups: BackendHandle[][] = [];
  for (const handle of allHandles) {
    const group = physicalGroups.find((candidate) =>
      samePhysicalBackend(candidate[0]?.store ?? handle.store, handle.store),
    );
    if (group === undefined) {
      physicalGroups.push([handle]);
    } else {
      group.push(handle);
    }
  }
  const sourceHandles = physicalGroups.flatMap((group) =>
    group[0] === undefined ? [] : [group[0]],
  );
  let olderStoreRemedy: string | undefined;
  const compatibilityFailures = new Map(
    options.initialFailures?.map(({ store, message }) => [backendKey(store), message]) ?? [],
  );
  const compatibilityProbe: StoreCompatibilityProbe = {
    get olderStoreRemedy() {
      return olderStoreRemedy;
    },
    check: async () => {
      const attempts = await Promise.allSettled(
        sourceHandles.map((handle) => handle.ports.compatibilityProbe.check()),
      );
      const results: StoreCompatibilityResult[] = [];
      const incompatible: IncompatibleCompatibility[] = [];
      olderStoreRemedy = undefined;
      for (const [index, attempt] of attempts.entries()) {
        const handle = sourceHandles[index];
        if (handle === undefined) {
          continue;
        }
        recordCompatibilityAttempt(attempt, handle, compatibilityFailures, results, incompatible);
      }
      if (results.length === 0) {
        const firstIncompatible = incompatible[0];
        if (firstIncompatible !== undefined) {
          olderStoreRemedy = firstIncompatible.olderStoreRemedy;
          return firstIncompatible.result;
        }
        throw new Error(
          "[FEDERATED_BACKENDS_UNAVAILABLE] every configured backend is unreachable; retry when at least one deployment is reachable",
        );
      }
      return compatibleFederatedResult(results);
    },
  };
  return {
    clock: sourceHandles[0]?.ports.clock ?? createSystemClock(),
    close: async () => {
      await Promise.all(allHandles.map((handle) => closeBackend(handle.ports)));
    },
    compatibilityProbe,
    openApplicationPorts: async () => {
      const applications = await openFederatedApplications(sourceHandles, compatibilityFailures);
      const sources = await createFederatedSources(
        config,
        applications.applications,
        compatibilityFailures,
        repositoryBelongsToPhysicalBackend,
      );
      const constructionFailures = [
        ...applications.failures.values(),
        ...sources.sourceFailures.values(),
      ];
      if (constructionFailures.length > 0 && !options.allowPartialReads) {
        throw new Error(constructionFailures[0]);
      }
      const firstSource = sources.sources[0];
      if (firstSource === undefined) {
        throw new Error("no configured backends were available for the federated read");
      }
      const failedHandles = allHandles.filter((handle) => {
        const key = backendKey(handle.store);
        return (
          compatibilityFailures.get(key) !== undefined ||
          applications.failures.get(key) !== undefined ||
          sources.sourceFailures.get(key) !== undefined
        );
      });
      const unavailableSources = failedHandles.map((handle) =>
        createUnavailableFederatedStoreSource(
          config,
          handle,
          firstSource.questStore,
          firstSource.blobStore,
          compatibilityFailures.get(backendKey(handle.store)) ??
            applications.failures.get(backendKey(handle.store)) ??
            sources.sourceFailures.get(backendKey(handle.store)) ??
            "backend construction failed",
        ),
      );
      return {
        blobStore: new FederatedBlobStore([...sources.sources, ...unavailableSources]),
        clock: sources.sourceHandles[0]?.ports.clock ?? createSystemClock(),
        questStore: new FederatedQuestStore(
          [...sources.sources, ...unavailableSources],
          undefined,
          options,
        ),
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
    const backendConfig = { ...config };
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
    openScopedBackend: async (scope, options = {}) => {
      if (scope.repo !== null) {
        return (await openConfiguredBackend(resolveRepositoryStore(config, scope.repo))).ports;
      }
      const configuredStores = uniqueStoreConfigs(config);
      const attempts = await Promise.allSettled(
        configuredStores.map(async (store) => openConfiguredBackend(store)),
      );
      const scopedHandles: BackendHandle[] = [];
      const initialFailures: Array<{ readonly store: StoreConfig; readonly message: string }> = [];
      for (const [index, attempt] of attempts.entries()) {
        const store = configuredStores[index];
        if (store === undefined) {
          continue;
        }
        if (attempt.status === "fulfilled") {
          scopedHandles.push(attempt.value);
        } else {
          initialFailures.push({ store, message: backendFailureMessage(attempt.reason) });
        }
      }
      if (initialFailures.length > 0 && options.mode !== "viewer") {
        throw new Error(initialFailures[0]?.message ?? "backend construction failed");
      }
      return createFederatedBackend(config, scopedHandles, {
        allowPartialReads: options.mode === "viewer",
        ...(initialFailures.length === 0 ? {} : { initialFailures }),
      });
    },
  };
}

function migrationStoreConfig(
  config: Config,
  repository: string,
  request: RepositoryMigrationRequest,
): StoreConfig {
  const current = resolveRepositoryStore(config, repository);
  const leaseTtl =
    current.lease_ttl_minutes === undefined ? {} : { lease_ttl_minutes: current.lease_ttl_minutes };
  if (request.target === "sqlite") {
    return { backend: "sqlite", ...leaseTtl };
  }
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
  return {
    backend: "convex",
    convex_deployment: normalizeConvexDeployment(deployment),
    ...leaseTtl,
  };
}

function repositoryHasLeaseOverride(config: Config, repository: string): boolean {
  const entry = config.repos[repository];
  return typeof entry === "object" && entry.store?.lease_ttl_minutes !== undefined;
}

function migrationRouteStoreConfig(
  config: Config,
  repository: string,
  target: StoreConfig,
): StoreConfig {
  if (repositoryHasLeaseOverride(config, repository)) {
    return target;
  }
  const { lease_ttl_minutes: _leaseTtlMinutes, ...withoutLeaseTtl } = target;
  return withoutLeaseTtl;
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
  readonly targetRouteConfig: StoreConfig;
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
  const targetConfig = migrationStoreConfig(activeConfig, repository, request);
  return {
    originalRepositoryConfig: routingSnapshot.repositoryEntryRaw ?? routingSnapshot.repositoryEntry,
    repository,
    routingSnapshot,
    sourceConfig,
    targetConfig,
    targetRouteConfig: migrationRouteStoreConfig(activeConfig, repository, targetConfig),
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
      const {
        originalRepositoryConfig,
        repository,
        routingSnapshot,
        sourceConfig,
        targetConfig,
        targetRouteConfig,
      } = await prepareRepositoryMigration(configFile, request, reloadConfig);
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
              sameBackend(current.repositoryEntry.store, targetRouteConfig)
            : await verifyRepositoryConfigEntry(configFile, repository, writtenRepositoryConfig);
        return (
          current.canonicalRepository === repository &&
          sameBackend(current.sourceStore, targetConfig) &&
          persistedRoute &&
          (await verifyEffectiveRoute(targetConfig))
        );
      };
      if (samePhysicalBackend(sourceConfig, targetConfig)) {
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
              targetRouteConfig,
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
  olderStoreRemedy: string | undefined,
): CliBackendPorts {
  return {
    clock: {
      now: async () => (await openDefaultBackend()).clock.now(),
    },
    compatibilityProbe: {
      ...(olderStoreRemedy === undefined ? {} : { olderStoreRemedy }),
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

async function openSqliteStore(
  databasePath: string,
  leaseTtlMinutes: number | undefined,
): Promise<SqliteStore> {
  return createSqliteStore(databasePath, leaseTtlMinutes === undefined ? {} : { leaseTtlMinutes });
}

async function openSqliteStoreForRecovery(
  databasePath: string,
  leaseTtlMinutes: number | undefined,
): Promise<SqliteStore | undefined> {
  try {
    if (readSqliteSchemaVersion(databasePath) !== SQLITE_SCHEMA_VERSION) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  let questStore: SqliteStore | undefined;
  try {
    questStore = await openSqliteStore(databasePath, leaseTtlMinutes);
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
  const leaseTtlMinutes =
    context.store?.lease_ttl_minutes ?? context.config.store.lease_ttl_minutes;
  const clock = createSystemClock();
  let activeQuestStore: SqliteStore | undefined;
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
    close: async () => {
      activeQuestStore?.close();
      activeQuestStore = undefined;
    },
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
          ? await openSqliteStoreForRecovery(databasePath, leaseTtlMinutes)
          : undefined
        : await openSqliteStore(databasePath, leaseTtlMinutes);
      activeQuestStore = questStore;
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
  const output = options.output ?? createCliOutputBoundary();
  try {
    return await (options.configLoader ?? loadConfig)({
      platform,
      environment,
      ...(options.configDefaults === undefined ? {} : { defaults: options.configDefaults }),
      ...(options.configFlags === undefined ? {} : { flags: options.configFlags }),
      onWarning: output.writeWarning,
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
  const leaseTtlMinutes = selectedStore.lease_ttl_minutes ?? context.config.store.lease_ttl_minutes;
  const questStore = new ConvexStore(
    deployment,
    leaseTtlMinutes === undefined ? { clients } : { clients, leaseTtlMinutes },
  );
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
        dump: await questStore.exportAllRaw(),
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
      refreshInstalledSkills: (executablePath, previousVersion) =>
        refreshInstalledSkillsAfterUpgrade({
          environment: options.environment,
          executablePath,
          previousVersion,
        }),
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
  readonly openScopedBackend: (
    scope: QuestScope,
    options?: QuestCliBackendOpenOptions,
  ) => Promise<CliBackendPorts>;
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
    saveViewerTheme: (themeName) => writeViewerTheme(configFile, themeName),
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
    refreshInstalledSkills: (executablePath, previousVersion) =>
      refreshInstalledSkillsAfterUpgrade({ environment, executablePath, previousVersion }),
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
  const ports = createLazyBackendPorts(
    openDefaultBackend,
    config.store.backend === "convex" ? CONVEX_OLDER_STORE_REMEDY : undefined,
  );
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
