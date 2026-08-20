import type { Config, RepoConfigEntry, StoreConfig } from "../schema";

export function repoConfigEntry(config: Config, repo: string): RepoConfigEntry | undefined {
  return config.repos[repo];
}

function resolveRepositoryAlias(config: Config, detectedRepo: string): string {
  const visited = new Set<string>();
  let current = detectedRepo;
  while (true) {
    if (visited.has(current)) {
      throw new Error(
        `[CONFIG_ALIAS_CYCLE] repository alias cycle includes "${current}"; update [repos] so aliases eventually name a concrete repository`,
      );
    }
    visited.add(current);
    const entry = repoConfigEntry(config, current);
    if (typeof entry !== "string") {
      return current;
    }
    current = entry;
  }
}

export function resolveRepositoryName(config: Config, detectedRepo: string): string {
  return resolveRepositoryAlias(config, detectedRepo);
}

function storeFingerprint(store: StoreConfig): string {
  return JSON.stringify({
    backend: store.backend,
    deployment: store.deployment ?? store.convex_deployment ?? null,
    lease_ttl_minutes: store.lease_ttl_minutes ?? null,
  });
}

function isNonDefaultRepositoryStore(config: Config, repo: string): boolean {
  return storeFingerprint(resolveRepositoryStore(config, repo)) !== storeFingerprint(config.store);
}

export function repositoryRoutingWarning(config: Config, detectedRepo: string): string | undefined {
  if (repoConfigEntry(config, detectedRepo) !== undefined) {
    return undefined;
  }

  const configuredRoutes = Object.entries(config.repos)
    .filter(
      ([repo, entry]) =>
        repo !== detectedRepo &&
        typeof entry === "object" &&
        entry !== null &&
        entry.store !== undefined &&
        isNonDefaultRepositoryStore(config, repo),
    )
    .map(([repo]) => [repo, resolveRepositoryStore(config, repo)] as const);
  if (configuredRoutes.length === 0) {
    return undefined;
  }

  if (configuredRoutes.length > 1) {
    const configuredRepos = configuredRoutes.map(([repo]) => `"${repo}"`).join(", ");
    return `detected repository "${detectedRepo}" is not configured, so Quest fell back to the default ${config.store.backend} store; configured non-default stores exist for ${configuredRepos}. Add [repos] ${detectedRepo} = "<intended repository>" after choosing the matching route, or rerun with --repo <configured repository>`;
  }

  const configuredRoute = configuredRoutes[0];
  if (configuredRoute === undefined) {
    return undefined;
  }

  const [configuredRepo] = configuredRoute;
  const configuredStore = resolveRepositoryStore(config, configuredRepo);
  return `detected repository "${detectedRepo}" is not configured, so Quest fell back to the default ${config.store.backend} store; configured repository "${configuredRepo}" uses a non-default ${configuredStore.backend} store. Add [repos] ${detectedRepo} = "${configuredRepo}" or rerun with --repo ${configuredRepo}`;
}

function inheritLeaseTtl(config: Config, store: StoreConfig): StoreConfig {
  const leaseTtlMinutes = config.store.lease_ttl_minutes;
  if (store.lease_ttl_minutes !== undefined || leaseTtlMinutes === undefined) {
    return store;
  }
  return { ...store, lease_ttl_minutes: leaseTtlMinutes };
}

export function resolveRepositoryStore(config: Config, repo: string): StoreConfig {
  const canonicalRepo = resolveRepositoryAlias(config, repo);
  const entry = repoConfigEntry(config, canonicalRepo);
  if (typeof entry === "object" && entry !== null && entry.store !== undefined) {
    return inheritLeaseTtl(config, entry.store);
  }

  return config.store;
}

export function configuredRepositoryStores(config: Config): readonly StoreConfig[] {
  return Object.values(config.repos).flatMap((entry) => {
    if (typeof entry !== "object" || entry.store === undefined) {
      return [];
    }
    return [inheritLeaseTtl(config, entry.store)];
  });
}
