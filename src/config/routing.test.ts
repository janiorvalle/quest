import { describe, expect, test } from "bun:test";
import { configSchema } from "../schema";
import {
  configuredRepositoryStores,
  repositoryRoutingWarning,
  resolveRepositoryName,
  resolveRepositoryStore,
} from ".";

describe("repository backend routing", () => {
  test("resolves a per-repository store after applying an alias", () => {
    const config = configSchema.parse({
      store: { backend: "sqlite" },
      repos: {
        checkout: "frontend",
        frontend: "web-app",
        "web-app": {
          store: {
            backend: "convex",
            deployment: "https://happy-fox-123.convex.cloud",
          },
        },
      },
    });

    expect(resolveRepositoryName(config, "checkout")).toBe("web-app");
    expect(resolveRepositoryStore(config, "web-app")).toEqual({
      backend: "convex",
      deployment: "https://happy-fox-123.convex.cloud",
    });
    expect(resolveRepositoryStore(config, "checkout")).toEqual({
      backend: "convex",
      deployment: "https://happy-fox-123.convex.cloud",
    });
    expect(resolveRepositoryStore(config, "other")).toEqual({ backend: "sqlite" });
    expect(configuredRepositoryStores(config)).toEqual([
      {
        backend: "convex",
        deployment: "https://happy-fox-123.convex.cloud",
      },
    ]);
  });

  test("inherits the global lease TTL unless a repository overrides it", () => {
    const config = configSchema.parse({
      store: { backend: "sqlite", lease_ttl_minutes: 60 },
      repos: {
        inherited: {
          store: { backend: "convex", deployment: "dev:inherited" },
        },
        overridden: {
          store: { backend: "sqlite", lease_ttl_minutes: 5 },
        },
      },
    });

    expect(resolveRepositoryStore(config, "inherited")).toEqual({
      backend: "convex",
      deployment: "dev:inherited",
      lease_ttl_minutes: 60,
    });
    expect(resolveRepositoryStore(config, "overridden")).toEqual({
      backend: "sqlite",
      lease_ttl_minutes: 5,
    });
    expect(configuredRepositoryStores(config)).toEqual([
      {
        backend: "convex",
        deployment: "dev:inherited",
        lease_ttl_minutes: 60,
      },
      { backend: "sqlite", lease_ttl_minutes: 5 },
    ]);
  });

  test("rejects repository alias cycles with an actionable configuration error", () => {
    const config = configSchema.parse({
      repos: {
        alpha: "beta",
        beta: "alpha",
      },
    });

    expect(() => resolveRepositoryName(config, "alpha")).toThrow(
      '[CONFIG_ALIAS_CYCLE] repository alias cycle includes "alpha"',
    );
    expect(() => resolveRepositoryStore(config, "alpha")).toThrow(
      '[CONFIG_ALIAS_CYCLE] repository alias cycle includes "alpha"',
    );
  });

  test("warns when an unconfigured checkout can fall back from a routed repository", () => {
    const config = configSchema.parse({
      store: { backend: "sqlite" },
      repos: {
        "streamlyne-marketing": {
          store: { backend: "convex", deployment: "dev:marketing" },
        },
      },
    });

    expect(repositoryRoutingWarning(config, "marketing")).toBe(
      'detected repository "marketing" is not configured, so Quest fell back to the default sqlite store; configured repository "streamlyne-marketing" uses a non-default convex store. Add [repos] marketing = "streamlyne-marketing" or rerun with --repo streamlyne-marketing',
    );
  });

  test("does not warn when the checkout is explicitly routed or all stores use the default", () => {
    const aliased = configSchema.parse({
      store: { backend: "sqlite" },
      repos: {
        marketing: "streamlyne-marketing",
        "streamlyne-marketing": {
          store: { backend: "convex", deployment: "dev:marketing" },
        },
      },
    });
    const sameBackend = configSchema.parse({
      store: { backend: "sqlite" },
      repos: {
        "streamly-marketing": { store: { backend: "sqlite" } },
      },
    });

    expect(repositoryRoutingWarning(aliased, "marketing")).toBeUndefined();
    expect(repositoryRoutingWarning(sameBackend, "marketing")).toBeUndefined();
  });

  test("does not recommend an arbitrary route when several non-default stores exist", () => {
    const config = configSchema.parse({
      store: { backend: "sqlite" },
      repos: {
        "streamlyne-marketing": {
          store: { backend: "convex", deployment: "dev:marketing" },
        },
        "streamlyne-platform": {
          store: { backend: "convex", deployment: "dev:platform" },
        },
      },
    });

    const warning = repositoryRoutingWarning(config, "marketing");

    expect(warning).toContain(
      'configured non-default stores exist for "streamlyne-marketing", "streamlyne-platform"',
    );
    expect(warning).toContain('Add [repos] marketing = "<intended repository>"');
    expect(warning).not.toContain('Add [repos] marketing = "streamlyne-marketing"');
  });
});
