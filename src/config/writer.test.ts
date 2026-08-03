import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";

import { loadConfig } from "./loader";
import {
  ConfigWriteError,
  ConvexDeploymentError,
  normalizeConvexDeployment,
  restoreRepositoryConfigEntry,
  restoreRepositoryConfigEntryIfUnchanged,
  verifyRepositoryConfigEntry,
  withConfigLock,
  writeConvexToken,
  writeHostedRepositoryRoutes,
  writeRepositoryStoreConfig,
  writeRepositoryStoreConfigIfUnchanged,
  writeViewerTheme,
} from "./writer";

// Windows ignores POSIX mode bits — NTFS ACLs decide who can read a file there — so
// the private-mode claim is only checkable on POSIX. On Windows the honest assertion
// is that the writer produced a regular file at all.
async function expectPrivateFile(filePath: string): Promise<void> {
  const stats = await stat(filePath);
  expect(stats.isFile()).toBeTrue();
  if (process.platform === "win32") {
    return;
  }
  expect(stats.mode & 0o777).toBe(0o600);
}

test("normalizeConvexDeployment rejects remote plaintext HTTP", () => {
  expect(() => normalizeConvexDeployment("http://example.com/quest")).toThrow(
    "[QUEST_INSECURE_CONVEX_DEPLOYMENT]",
  );
  expect(() => normalizeConvexDeployment("http://example.com/quest")).toThrow(
    ConvexDeploymentError,
  );
});

test("normalizeConvexDeployment allows loopback HTTP for local development", () => {
  expect(normalizeConvexDeployment("http://127.0.0.1:3210/")).toBe("http://127.0.0.1:3210");
  expect(normalizeConvexDeployment("http://[::1]:3210/")).toBe("http://[::1]:3210");
});

test("writeConvexToken preserves config and writes a private token file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-"));
  const configDirectory = join(directory, "config");
  const configFile = join(configDirectory, "config.toml");
  const deployment = "https://happy-fox.convex.cloud";
  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(
      configFile,
      `identity = "alice"\n\n[store]\nbackend = "convex"\nconvex_deployment = "${deployment}"\n`,
    );

    await writeConvexToken(configFile, deployment, "qtk-personal-token");

    const parsed = parse(await readFile(configFile, "utf8"));
    expect(parsed).toMatchObject({
      identity: "alice",
      convex: {
        [deployment]: { token: "qtk-personal-token" },
      },
    });
    await expectPrivateFile(configFile);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeConvexToken creates a missing config file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-missing-"));
  const configFile = join(directory, "nested", "config.toml");
  try {
    await writeConvexToken(configFile, "dev:quest", "qtk-token");
    expect(parse(await readFile(configFile, "utf8"))).toEqual({
      convex: { "dev:quest": { token: "qtk-token" } },
    });
    await expectPrivateFile(configFile);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeViewerTheme saves the theme and leaves every other setting untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-theme-"));
  const configFile = join(directory, "config.toml");
  try {
    await writeFile(
      configFile,
      'identity = "alice"\n\n[store]\nbackend = "sqlite"\n\n[repos]\nquest = "quest"\n',
    );

    await writeViewerTheme(configFile, "dense");

    expect(parse(await readFile(configFile, "utf8"))).toEqual({
      identity: "alice",
      store: { backend: "sqlite" },
      repos: { quest: "quest" },
      tui: { theme: "dense" },
    });
    await expectPrivateFile(configFile);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeViewerTheme replaces the previous theme instead of appending a second one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-theme-replace-"));
  const configFile = join(directory, "nested", "config.toml");
  try {
    await writeViewerTheme(configFile, "first");
    await writeViewerTheme(configFile, "second");

    const contents = await readFile(configFile, "utf8");
    expect(parse(contents)).toEqual({ tui: { theme: "second" } });
    expect(contents.match(/theme/gu)).toHaveLength(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// Keep the preference under the established viewer section so related settings remain easy to
// discover across binary versions.
test("writeViewerTheme saves into a section older quest versions already accept", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-theme-section-"));
  const configFile = join(directory, "config.toml");
  try {
    await writeViewerTheme(configFile, "dense");

    expect(Object.keys(parse(await readFile(configFile, "utf8")))).toEqual(["tui"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeViewerTheme refuses an empty theme name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-theme-empty-"));
  const configFile = join(directory, "config.toml");
  try {
    await expect(writeViewerTheme(configFile, "  ")).rejects.toThrow(ConfigWriteError);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeConvexToken serializes concurrent updates and canonicalizes deployment URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-concurrent-"));
  const configFile = join(directory, "config.toml");
  try {
    await Promise.all([
      writeConvexToken(configFile, "https://team.convex.cloud/", "qtk-one"),
      writeConvexToken(configFile, "https://other.convex.cloud/", "qtk-two"),
    ]);

    expect(parse(await readFile(configFile, "utf8"))).toEqual({
      convex: {
        "https://team.convex.cloud": { token: "qtk-one" },
        "https://other.convex.cloud": { token: "qtk-two" },
      },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeHostedRepositoryRoutes adds routes atomically and preserves conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-join-routing-"));
  const configFile = join(directory, "config.toml");
  try {
    await writeFile(
      configFile,
      '[store]\nbackend = "sqlite"\n\n[repos.web-app.store]\nbackend = "sqlite"\n',
    );

    const result = await writeHostedRepositoryRoutes(
      configFile,
      ["web-app", "api", "api"],
      "dev:quest",
    );

    expect(result).toEqual({
      added: ["api"],
      conflicts: [{ repository: "web-app", configuredStore: { backend: "sqlite" } }],
    });
    const parsed = parse(await readFile(configFile, "utf8"));
    expect(parsed).toMatchObject({
      repos: {
        api: { store: { backend: "convex", deployment: "dev:quest" } },
        "web-app": { store: { backend: "sqlite" } },
      },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("writeHostedRepositoryRoutes keeps matching routes without reporting them as added", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-join-existing-"));
  const configFile = join(directory, "config.toml");
  try {
    await writeFile(
      configFile,
      '[repos.web-app.store]\nbackend = "convex"\ndeployment = "dev:quest"\n',
    );

    await expect(
      writeHostedRepositoryRoutes(configFile, ["web-app"], "dev:quest"),
    ).resolves.toEqual({ added: [], conflicts: [] });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("reclaims a stale lock without trusting a reusable process ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-stale-lock-"));
  const configFile = join(directory, "config.toml");
  const lockPath = `${configFile}.lock`;
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner"), `${process.pid}:stale-lock\n`);
    const staleAt = new Date(Date.now() - 30_000);
    await utimes(lockPath, staleAt, staleAt);

    let callbackRan = false;
    await withConfigLock(configFile, async (assertOwner) => {
      await assertOwner();
      callbackRan = true;
    });

    expect(callbackRan).toBeTrue();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
describe("repository store config writer", () => {
  test("adds a Convex routing block without changing other config values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-"));
    const configFile = join(directory, "nested", "config.toml");
    try {
      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        deployment: "https://happy-fox-123.convex.cloud",
      });

      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toEqual({
        store: {
          backend: "convex",
          deployment: "https://happy-fox-123.convex.cloud",
        },
      });
      expect(config.store.backend).toBe("sqlite");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("preserves a repository lease TTL when writing a routing block", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-lease-ttl-"));
    const configFile = join(directory, "config.toml");
    try {
      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "sqlite",
        lease_ttl_minutes: 45,
      });

      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toEqual({
        store: { backend: "sqlite", lease_ttl_minutes: 45 },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("replaces an alias or previous backend block idempotently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-update-"));
    const configFile = join(directory, "config.toml");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        configFile,
        '[store]\nbackend = "sqlite"\n\n[repos.web-app]\nstore = { backend = "sqlite" }\n',
      );
      await writeRepositoryStoreConfig(configFile, "web-app", { backend: "sqlite" });
      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        convex_deployment: "dev:web-app",
      });

      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toEqual({
        store: { backend: "convex", deployment: "dev:web-app" },
      });
      expect(await readFile(configFile, "utf8")).toContain("[repos.web-app.store]");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("updates the canonical target without replacing a string alias", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-alias-"));
    const configFile = join(directory, "config.toml");
    try {
      await writeFile(
        configFile,
        '[repos]\nweb-app = "frontend"\n\n[repos.frontend]\nstore = { backend = "sqlite" }\n',
      );

      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        deployment: "dev:frontend",
      });

      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toBe("frontend");
      expect(config.repos["frontend"]).toEqual({
        store: { backend: "convex", deployment: "dev:frontend" },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("preserves repository metadata while changing only the store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-metadata-"));
    const configFile = join(directory, "config.toml");
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(
        configFile,
        '[repos.web-app]\nalias = "frontend"\nstore = { backend = "sqlite" }\n',
      );

      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        deployment: "dev:web-app",
      });

      const contents = await readFile(configFile, "utf8");
      expect(contents).toContain('alias = "frontend"');
      expect(contents).toContain('deployment = "dev:web-app"');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("restores an inherited repository entry when routing rollback removes an override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-rollback-"));
    const configFile = join(directory, "config.toml");
    try {
      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        deployment: "dev",
      });
      await restoreRepositoryConfigEntry(configFile, "web-app", undefined);

      expect(await verifyRepositoryConfigEntry(configFile, "web-app", undefined)).toBeTrue();
      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toBeUndefined();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("serializes concurrent routing updates without losing a repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-concurrent-"));
    const configFile = join(directory, "config.toml");
    try {
      await Promise.all([
        writeRepositoryStoreConfig(configFile, "web-app", { backend: "sqlite" }),
        writeRepositoryStoreConfig(configFile, "api", {
          backend: "convex",
          deployment: "dev:api",
        }),
      ]);

      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos).toEqual({
        api: { store: { backend: "convex", deployment: "dev:api" } },
        "web-app": { store: { backend: "sqlite" } },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("does not overwrite a route changed after the migration snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-cas-"));
    const configFile = join(directory, "config.toml");
    try {
      await writeRepositoryStoreConfig(configFile, "web-app", { backend: "sqlite" });
      const initial = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      const snapshot = {
        canonicalRepository: "web-app",
        detectedRepository: "web-app",
        repositoryEntry: initial.repos["web-app"],
        sourceStore: initial.store,
      };
      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        deployment: "dev:concurrent",
      });

      await expect(
        writeRepositoryStoreConfigIfUnchanged(
          configFile,
          { backend: "convex", deployment: "dev:migration" },
          snapshot,
        ),
      ).rejects.toThrow("CONFIG_ROUTE_CHANGED");

      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toEqual({
        store: { backend: "convex", deployment: "dev:concurrent" },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("detects a changed inherited global route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-global-cas-"));
    const configFile = join(directory, "config.toml");
    try {
      await writeFile(configFile, '[store]\nbackend = "sqlite"\n');
      const initial = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      const snapshot = {
        canonicalRepository: "web-app",
        detectedRepository: "web-app",
        repositoryEntry: undefined,
        sourceStore: initial.store,
      };
      await writeFile(configFile, '[store]\nbackend = "convex"\ndeployment = "dev:concurrent"\n');

      await expect(
        writeRepositoryStoreConfigIfUnchanged(
          configFile,
          { backend: "convex", deployment: "dev:migration" },
          snapshot,
        ),
      ).rejects.toThrow("CONFIG_ROUTE_CHANGED");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("does not roll back a route changed after cutover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-config-writer-rollback-cas-"));
    const configFile = join(directory, "config.toml");
    try {
      await writeRepositoryStoreConfig(configFile, "web-app", { backend: "sqlite" });
      const initial = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      const snapshot = {
        canonicalRepository: "web-app",
        detectedRepository: "web-app",
        repositoryEntry: initial.repos["web-app"],
        sourceStore: initial.store,
      };
      const written = await writeRepositoryStoreConfigIfUnchanged(
        configFile,
        { backend: "convex", deployment: "dev:migration" },
        snapshot,
      );
      await writeRepositoryStoreConfig(configFile, "web-app", {
        backend: "convex",
        deployment: "dev:concurrent",
      });

      await expect(
        restoreRepositoryConfigEntryIfUnchanged(
          configFile,
          "web-app",
          written,
          initial.repos["web-app"],
        ),
      ).resolves.toBeFalse();
      const config = await loadConfig({
        configFile,
        platform: { directories: testDirectories(directory) },
        environment: {},
      });
      expect(config.repos["web-app"]).toEqual({
        store: { backend: "convex", deployment: "dev:concurrent" },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function testDirectories(directory: string) {
  return {
    backup: join(directory, "backups"),
    config: join(directory, "config"),
    evidence: join(directory, "evidence"),
    executable: join(directory, "quest"),
    install: join(directory, "bin"),
    state: join(directory, "state"),
  };
}
