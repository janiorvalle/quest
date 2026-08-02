import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";

import { loadConfig } from "./loader";
import {
  ConvexDeploymentError,
  normalizeConvexDeployment,
  restoreRepositoryConfigEntry,
  restoreRepositoryConfigEntryIfUnchanged,
  verifyRepositoryConfigEntry,
  withConfigLock,
  writeConvexToken,
  writeRepositoryStoreConfig,
  writeRepositoryStoreConfigIfUnchanged,
} from "./writer";

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
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
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
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
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
