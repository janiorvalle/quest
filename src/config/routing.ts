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

export function resolveRepositoryStore(config: Config, repo: string): StoreConfig {
  const canonicalRepo = resolveRepositoryAlias(config, repo);
  const entry = repoConfigEntry(config, canonicalRepo);
  if (typeof entry === "object" && entry !== null && entry.store !== undefined) {
    return entry.store;
  }

  return config.store;
}

export function configuredRepositoryStores(config: Config): readonly StoreConfig[] {
  return Object.values(config.repos).flatMap((entry) =>
    typeof entry === "object" && entry.store !== undefined ? [entry.store] : [],
  );
}
