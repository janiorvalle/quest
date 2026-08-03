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
