import { describe, expect, test } from "bun:test";
import { configSchema } from "../schema";
import { configuredRepositoryStores, resolveRepositoryName, resolveRepositoryStore } from ".";

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
});
