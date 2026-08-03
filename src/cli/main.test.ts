import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigLoadError } from "../config";
import {
  createCliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from "../output";
import { type BackupScheduleStatus, createPlatform } from "../platform";
import { type Config, newQuestSchema } from "../schema";
import type { UpgradeOperations } from "../services";
import { LocalBlobStore, SQLITE_SCHEMA_VERSION, SqliteStore } from "../store";
import {
  type CliBackendFactory,
  type ConfigLoader,
  createCompositionRoot,
  createSqliteCliBackend,
  type PlatformFactory,
  runQuestMain,
} from "./main";

const config = {
  store: { backend: "sqlite" },
  repos: {},
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

const scheduleStatus = {
  definition_exists: false,
  definition_path: "/home/Library/LaunchAgents/com.janiorvalle.quest.backup.plist",
  executable: "/home/.local/bin/quest",
  executable_exists: false,
  frequency: "daily",
  installed: false,
  kind: "launchd",
  task_name: null,
} satisfies BackupScheduleStatus;

const platformFactory: PlatformFactory = () => ({
  name: "darwin",
  directories: {
    config: "/home/.config/quest",
    state: "/home/.local/state/quest",
    evidence: "/home/.local/state/quest/evidence",
    backup: "/home/Backups/quest",
    install: "/home/.local/bin",
    executable: "/home/.local/bin/quest",
  },
  scheduler: {
    kind: "launchd",
    install: () => Promise.resolve(scheduleStatus),
    status: () => Promise.resolve(scheduleStatus),
    remove: () => Promise.resolve(scheduleStatus),
  },
  urlOpenCommand: (url) => ({ executable: "open", arguments: [url] }),
  openUrl: () => Promise.resolve(),
  isInstallDirectoryOnPath: () => true,
  addInstallDirectoryToPath: (searchPath) => searchPath ?? "/home/.local/bin",
});

const configLoader: ConfigLoader = () => Promise.resolve(config);

function backendFactory(calls: string[], name: string): CliBackendFactory {
  return () => {
    calls.push(name);
    return Promise.resolve({
      clock: {
        now: () => Promise.resolve("2026-07-29T12:00:00Z"),
      },
      compatibilityProbe: {
        check: () =>
          Promise.resolve({
            outcome: "compatible",
            supported_version: 1,
            store_version: 1,
          }),
      },
      openApplicationPorts: () => Promise.reject(new Error("version must not open the backend")),
    });
  };
}

describe("CLI composition root", () => {
  test("parses help and usage errors before reading invalid configuration", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-preflight-"));
    const configDirectories = [
      join(homeDirectory, ".config", "quest"),
      join(homeDirectory, "appdata", "quest"),
      join(homeDirectory, "xdg", "quest"),
    ];
    try {
      await Promise.all(
        configDirectories.map((directory) => mkdir(directory, { recursive: true })),
      );
      await Promise.all(
        configDirectories.map((directory) =>
          writeFile(join(directory, "config.toml"), "this is not toml"),
        ),
      );
      const environment = {
        ...process.env,
        APPDATA: join(homeDirectory, "appdata"),
        HOME: homeDirectory,
        LOCALAPPDATA: join(homeDirectory, "localappdata"),
        XDG_CONFIG_HOME: join(homeDirectory, "xdg"),
      };

      const help = Bun.spawn({
        cmd: [process.execPath, "src/entrypoint.ts", "--help"],
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(await help.exited).toBe(EXIT_SUCCESS);
      expect(await new Response(help.stdout).text()).toContain("Usage: quest");
      expect(await new Response(help.stderr).text()).toBe("");

      const invalid = Bun.spawn({
        cmd: [process.execPath, "src/entrypoint.ts", "--unknown"],
        env: environment,
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(await invalid.exited).toBe(2);
      expect(await new Response(invalid.stderr).text()).toBe(
        "quest: usage: unknown option '--unknown'\n",
      );
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("writes config compatibility warnings to stderr without corrupting JSON stdout", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-config-warning-"));
    const configDirectory = join(homeDirectory, "config");
    const basePlatform = platformFactory({ environment: {}, workingDirectory: homeDirectory });
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "config.toml"), '[future]\nnew_option = "ignored"\n');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const testPlatformFactory: PlatformFactory = () => ({
      ...basePlatform,
      directories: {
        ...basePlatform.directories,
        backup: join(homeDirectory, "backups"),
        config: configDirectory,
        evidence: join(homeDirectory, "evidence"),
        state: join(homeDirectory, "state"),
      },
    });

    try {
      const root = await createCompositionRoot({
        backendFactories: {
          sqlite: backendFactory([], "sqlite"),
          convex: backendFactory([], "convex"),
        },
        cleanupStaleEvidence: false,
        environment: {},
        initialWorkingDirectory: homeDirectory,
        isTty: false,
        output: createCliOutputBoundary({
          stderr: (line) => stderr.push(line),
          stdout: (text) => stdout.push(text),
        }),
        platformFactory: testPlatformFactory,
        version: "1.2.3",
      });

      expect(stderr).toEqual([
        'warning: ignored unknown config section "future"; no settings from it were applied; upgrade the Quest binary before relying on this setting',
      ]);
      expect(await root.run(["--format", "json", "--version"])).toBe(EXIT_SUCCESS);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        command: "version",
        data: { version: "1.2.3" },
      });
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("runs upgrade before initializing the configured backend", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const upgradeOperations: UpgradeOperations = {
      check: async (currentVersion) => {
        expect(currentVersion).toBe("1.2.3");
        return {
          artifact: "quest-1.3.0-darwin-arm64",
          artifact_url: "https://example.test/quest-1.3.0-darwin-arm64",
          current_version: currentVersion,
          latest_version: "1.3.0",
          release_url: "https://example.test/releases/v1.3.0",
          repository: "janiorvalle/quest",
          target: "darwin-arm64",
          update_available: true,
        };
      },
      install: () => Promise.reject(new Error("install must not run during --check")),
    };
    const rejectingBackend: CliBackendFactory = () =>
      Promise.reject(new Error("backend must not initialize for quest upgrade"));

    const exitCode = await runQuestMain(async () => undefined, ["upgrade", "--check"], {
      backendFactories: {
        sqlite: rejectingBackend,
        convex: rejectingBackend,
      },
      environment: {},
      initialWorkingDirectory: "/work/quest",
      output: createCliOutputBoundary({
        stderr: (text) => stderr.push(text),
        stdout: (text) => stdout.push(text),
      }),
      platformFactory,
      upgradeOperations,
      version: "1.2.3",
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stdout).toEqual([
      "quest upgrade: 1.3.0 is available (current 1.2.3); run quest upgrade to install\n",
    ]);
    expect(stderr).toEqual([]);
  });

  test("selects the configured backend only in the root and injects its ports", async () => {
    const calls: string[] = [];
    const stdout: string[] = [];
    const root = await createCompositionRoot({
      backendFactories: {
        sqlite: backendFactory(calls, "sqlite"),
        convex: backendFactory(calls, "convex"),
      },
      configLoader,
      environment: {},
      initialWorkingDirectory: "/work/quest",
      isTty: false,
      output: createCliOutputBoundary({
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      }),
      platformFactory,
      version: "1.2.3",
    });

    expect(calls).toEqual([]);
    expect(await root.run(["--version"])).toBe(EXIT_SUCCESS);
    expect(calls).toEqual(["sqlite"]);
    expect(stdout).toEqual(["quest 1.2.3\n"]);
  });

  test("routes a scoped repository to its backend override after scope resolution", async () => {
    const calls: string[] = [];
    const routedConfig = {
      ...config,
      repos: {
        remote: {
          store: {
            backend: "convex",
            deployment: "dev:remote",
          },
        },
      },
    } satisfies Config;
    const factory =
      (name: string): CliBackendFactory =>
      (context) => {
        calls.push(
          `${name}:${context.store?.deployment ?? "default"}:${context.store?.convex_deployment ?? "default"}`,
        );
        return Promise.resolve({
          clock: {
            now: () => Promise.resolve("2026-07-29T12:00:00Z"),
          },
          compatibilityProbe: {
            check: () =>
              Promise.resolve({
                outcome: "compatible",
                supported_version: 1,
                store_version: 1,
              }),
          },
          openApplicationPorts: () => Promise.reject(new Error("routing test does not open ports")),
        });
      };
    const root = await createCompositionRoot({
      backendFactories: { sqlite: factory("sqlite"), convex: factory("convex") },
      configLoader: () => Promise.resolve(routedConfig),
      environment: {},
      platformFactory,
    });

    expect(calls).toEqual([]);
    if (root.dependencies.openBackend === undefined) {
      throw new Error("composition root did not expose its scoped backend resolver");
    }
    await root.dependencies.openBackend({ repo: "remote" });
    expect(calls).toEqual(["convex:dev:remote:dev:remote"]);
    await root.dependencies.openBackend({ repo: "local" });
    expect(calls).toEqual(["convex:dev:remote:dev:remote", "sqlite:default:default"]);
  });

  test("routes repository-scoped maintenance and rejects federated migration", async () => {
    const calls: string[] = [];
    const routedConfig = {
      ...config,
      repos: {
        remote: {
          store: {
            backend: "convex",
            deployment: "dev:remote",
          },
        },
      },
    } satisfies Config;
    const factory =
      (name: string): CliBackendFactory =>
      (context) => {
        calls.push(`${name}:${context.store?.deployment ?? "default"}`);
        return Promise.resolve({
          clock: {
            now: () => Promise.resolve("2026-07-29T12:00:00Z"),
          },
          compatibilityProbe: {
            check: () =>
              Promise.resolve({
                outcome: "compatible",
                supported_version: 1,
                store_version: 1,
              }),
          },
          doctor: {
            inspectStore: () => Promise.resolve({ state: "missing" }),
            paths: {
              backup: "/tmp/quest-backups",
              database: "/tmp/quest.db",
              evidence: "/tmp/quest-evidence",
              ownership_database: "/tmp/quest-ownership.db",
              temporary_directory: "/tmp",
            },
          },
          openApplicationPorts: () => Promise.reject(new Error("maintenance test only")),
        });
      };
    const stderr: string[] = [];
    const root = await createCompositionRoot({
      backendFactories: { sqlite: factory("sqlite"), convex: factory("convex") },
      configLoader: () => Promise.resolve(routedConfig),
      environment: {},
      initialWorkingDirectory: "/work/quest",
      isTty: false,
      output: createCliOutputBoundary({
        stdout: () => undefined,
        stderr: (line) => stderr.push(line),
      }),
      locateGitRoot: () => Promise.resolve("/work/remote"),
      platformFactory,
      validateWorkingDirectory: () => Promise.resolve(),
    });

    expect(await root.run(["migrate"])).toBe(EXIT_SUCCESS);
    expect(calls).toEqual(["convex:dev:remote"]);

    expect(await root.run(["migrate", "--repo", "remote"])).toBe(EXIT_SUCCESS);
    expect(calls).toEqual(["convex:dev:remote"]);

    expect(await root.run(["doctor", "--repo", "remote"])).toBe(EXIT_DOMAIN_ERROR);
    expect(calls).toEqual(["convex:dev:remote"]);

    calls.length = 0;
    expect(await root.run(["migrate", "--all"])).toBe(EXIT_USAGE_ERROR);
    expect(calls).toEqual([]);
    expect(stderr.at(-1)).toContain("[UNSUPPORTED_SCOPE] migrate cannot use --all");
  });

  test("fans out --all reads across configured backends and keeps duplicate IDs scoped by repo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-federated-"));
    const stores = new Map<string, SqliteStore>();
    const stdout: string[] = [];
    const configWithOverride = {
      ...config,
      repos: {
        remote: {
          store: { backend: "convex", deployment: "dev:remote" },
        },
      },
    } satisfies Config;
    const factory =
      (name: string): CliBackendFactory =>
      () => {
        const store = new SqliteStore(join(directory, `${name}.db`), {
          now: () => "2026-07-29T12:00:00Z",
        });
        stores.set(name, store);
        return Promise.resolve({
          clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
          compatibilityProbe: {
            check: () =>
              Promise.resolve({
                outcome: "compatible",
                supported_version: SQLITE_SCHEMA_VERSION,
                store_version: SQLITE_SCHEMA_VERSION,
              }),
          },
          openApplicationPorts: () =>
            Promise.resolve({
              blobStore: new LocalBlobStore(join(directory, `${name}-evidence`)),
              clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
              questStore: store,
            }),
        });
      };
    const root = await createCompositionRoot({
      backendFactories: { sqlite: factory("sqlite"), convex: factory("convex") },
      configLoader: () => Promise.resolve(configWithOverride),
      environment: {},
      initialWorkingDirectory: directory,
      isTty: false,
      output: createCliOutputBoundary({
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      }),
      platformFactory,
      validateWorkingDirectory: () => Promise.resolve(),
    });

    try {
      if (root.dependencies.openBackend === undefined) {
        throw new Error("composition root did not expose its scoped backend resolver");
      }
      await root.dependencies.openBackend({ repo: null });
      const sqlite = stores.get("sqlite");
      const convex = stores.get("convex");
      if (sqlite === undefined || convex === undefined) {
        throw new Error("federated test did not create both backend stores");
      }
      await sqlite.addQuest(
        newQuestSchema.parse({
          repo: "local",
          area: "cli",
          kind: "task",
          title: "Local quest",
          description: "local",
          opened_by: "test",
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          guild: null,
          predicted_files: [],
          reopen_count: 0,
          backfill: true,
        }),
      );
      await convex.addQuest(
        newQuestSchema.parse({
          repo: "remote",
          area: "cli",
          kind: "task",
          title: "Remote quest",
          description: "remote",
          opened_by: "test",
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          guild: null,
          predicted_files: [],
          reopen_count: 0,
          backfill: true,
        }),
      );

      expect(await root.run(["list", "--all", "--format", "json"])).toBe(EXIT_SUCCESS);
      expect(JSON.parse(stdout.join("")).data.quests).toEqual([
        expect.objectContaining({ id: 1, repo: "local" }),
        expect.objectContaining({ id: 1, repo: "remote" }),
      ]);
    } finally {
      for (const store of stores.values()) {
        store.close();
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("federated reads exclude fenced copies from list, stats, and export", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-federated-fence-"));
    const stores = new Map<string, SqliteStore>();
    const configWithOverride = {
      ...config,
      repos: {
        remote: {
          store: { backend: "convex", deployment: "dev:remote" },
        },
      },
    } satisfies Config;
    const factory =
      (name: string): CliBackendFactory =>
      () => {
        const store = new SqliteStore(join(directory, `${name}.db`), {
          now: () => "2026-07-29T12:00:00Z",
        });
        stores.set(name, store);
        return Promise.resolve({
          clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
          compatibilityProbe: {
            check: () =>
              Promise.resolve({
                outcome: "compatible",
                supported_version: SQLITE_SCHEMA_VERSION,
                store_version: SQLITE_SCHEMA_VERSION,
              }),
          },
          openApplicationPorts: () =>
            Promise.resolve({
              blobStore: new LocalBlobStore(join(directory, `${name}-evidence`)),
              clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
              questStore: store,
            }),
        });
      };
    const root = await createCompositionRoot({
      backendFactories: { sqlite: factory("sqlite"), convex: factory("convex") },
      configLoader: () => Promise.resolve(configWithOverride),
      environment: {},
      initialWorkingDirectory: directory,
      isTty: false,
      platformFactory,
      validateWorkingDirectory: () => Promise.resolve(),
    });

    try {
      if (root.dependencies.openBackend === undefined) {
        throw new Error("federated test did not expose its scoped backend resolver");
      }
      const sqlite = await root.dependencies.openBackend({ repo: null });
      const local = stores.get("sqlite");
      const remote = stores.get("convex");
      if (local === undefined || remote === undefined) {
        throw new Error("federated fence test did not create both backend stores");
      }
      await local.addQuest(
        newQuestSchema.parse({
          repo: "local",
          area: "cli",
          kind: "task",
          title: "Stale local quest",
          description: "must stay hidden",
          opened_by: "test",
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          guild: null,
          predicted_files: [],
          reopen_count: 0,
          backfill: true,
        }),
      );
      await remote.addQuest(
        newQuestSchema.parse({
          repo: "remote",
          area: "cli",
          kind: "task",
          title: "Routed remote quest",
          description: "must stay visible",
          opened_by: "test",
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          guild: null,
          predicted_files: [],
          reopen_count: 0,
          backfill: true,
        }),
      );
      const migration = await local.beginMigration(await local.exportAll());
      await migration.fence("local");
      await migration.commit();
      await migration.release();

      const ports = await sqlite.openApplicationPorts();
      if (ports.questStore === undefined) {
        throw new Error("federated fence test did not open quest stores");
      }
      await expect(ports.questStore.listQuests({})).resolves.toMatchObject([
        { repo: "remote", title: "Routed remote quest" },
      ]);
      await expect(ports.questStore.listQuests({ repo: "local" })).resolves.toEqual([]);
      await expect(ports.questStore.stats({ repo: null })).resolves.toMatchObject({
        repos: [{ repo: "remote", total: 1 }],
      });
      await expect(ports.questStore.exportAll()).resolves.toMatchObject({
        quests: [{ repo: "remote", title: "Routed remote quest" }],
      });
    } finally {
      for (const store of stores.values()) {
        store.close();
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps compatible backends readable when another store needs an upgrade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-federated-compatibility-"));
    const stores = new Map<string, SqliteStore>();
    const configWithOverride = {
      ...config,
      repos: {
        remote: {
          store: { backend: "convex", deployment: "dev:remote" },
        },
      },
    } satisfies Config;
    const factory =
      (name: string): CliBackendFactory =>
      () => {
        const store = new SqliteStore(join(directory, `${name}.db`), {
          now: () => "2026-07-29T12:00:00Z",
        });
        stores.set(name, store);
        return Promise.resolve({
          clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
          compatibilityProbe: {
            check: () =>
              Promise.resolve(
                name === "sqlite"
                  ? {
                      action: "upgrade-binary" as const,
                      outcome: "store-newer" as const,
                      store_version: SQLITE_SCHEMA_VERSION + 1,
                      supported_version: SQLITE_SCHEMA_VERSION,
                    }
                  : {
                      outcome: "compatible" as const,
                      store_version: SQLITE_SCHEMA_VERSION,
                      supported_version: SQLITE_SCHEMA_VERSION,
                    },
              ),
          },
          openApplicationPorts: () =>
            Promise.resolve({
              blobStore: new LocalBlobStore(join(directory, `${name}-evidence`)),
              clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
              questStore: store,
            }),
        });
      };
    const root = await createCompositionRoot({
      backendFactories: { sqlite: factory("sqlite"), convex: factory("convex") },
      configLoader: () => Promise.resolve(configWithOverride),
      environment: {},
      initialWorkingDirectory: directory,
      isTty: false,
      platformFactory,
      validateWorkingDirectory: () => Promise.resolve(),
    });

    try {
      if (root.dependencies.openBackend === undefined) {
        throw new Error("federated compatibility test did not expose its backend resolver");
      }
      const strictBackend = await root.dependencies.openBackend({ repo: null });
      const remote = stores.get("convex");
      if (remote === undefined || strictBackend.openApplicationPorts === undefined) {
        throw new Error("federated compatibility test did not open both backends");
      }
      await remote.addQuest(
        newQuestSchema.parse({
          repo: "remote",
          area: "cli",
          kind: "task",
          title: "Readable remote quest",
          description: "remote",
          opened_by: "test",
          assignee: null,
          status: "ready",
          verdict: null,
          verdict_notes: null,
          priority: 2,
          pr: null,
          guild: null,
          predicted_files: [],
          reopen_count: 0,
          backfill: true,
        }),
      );

      await expect(strictBackend.compatibilityProbe.check()).resolves.toMatchObject({
        outcome: "compatible",
      });
      const strictPorts = await strictBackend.openApplicationPorts();
      await expect(strictPorts.questStore?.listQuests({})).rejects.toThrow(
        "[FEDERATED_SCOPE_UNAVAILABLE] the federated repository view",
      );
      const viewerBackend = await root.dependencies.openBackend({ repo: null }, { mode: "viewer" });
      await expect(viewerBackend.compatibilityProbe.check()).resolves.toMatchObject({
        outcome: "compatible",
      });
      const ports = await viewerBackend.openApplicationPorts();
      await expect(ports.questStore?.listQuests({})).resolves.toMatchObject([
        { repo: "remote", title: "Readable remote quest" },
      ]);
      await expect(ports.questStore?.listQuests({ repo: "local" })).rejects.toThrow(
        "[FEDERATED_SCOPE_UNAVAILABLE] repository local",
      );
    } finally {
      for (const store of stores.values()) {
        store.close();
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps the federated compatibility result paired with its remedy", async () => {
    const configWithOverride = {
      ...config,
      repos: {
        remote: {
          store: { backend: "convex", deployment: "dev:remote" },
        },
      },
    } satisfies Config;
    const factory =
      (name: "sqlite" | "convex"): CliBackendFactory =>
      () =>
        Promise.resolve({
          clock: { now: () => Promise.resolve("2026-07-29T12:00:00Z") },
          compatibilityProbe: {
            olderStoreRemedy: `${name} remedy`,
            check: () =>
              Promise.resolve({
                action: "migrate-store" as const,
                outcome: "store-older" as const,
                store_version: name === "sqlite" ? 6 : 5,
                supported_version: 7,
              }),
          },
          openApplicationPorts: () => Promise.reject(new Error("not needed")),
        });
    const root = await createCompositionRoot({
      backendFactories: { sqlite: factory("sqlite"), convex: factory("convex") },
      configLoader: () => Promise.resolve(configWithOverride),
      environment: {},
      initialWorkingDirectory: "/work/quest",
      platformFactory,
    });

    if (root.dependencies.openBackend === undefined) {
      throw new Error("federated compatibility pairing test did not expose its backend resolver");
    }
    const backend = await root.dependencies.openBackend({ repo: null });
    await expect(backend.compatibilityProbe.check()).resolves.toEqual({
      action: "migrate-store",
      outcome: "store-older",
      store_version: 6,
      supported_version: 7,
    });
    expect(backend.compatibilityProbe.olderStoreRemedy).toBe("sqlite remedy");
  });

  test("wires the real read-only SQLite version reader without creating a missing store", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-composition-"));
    const platform = createPlatform({
      environment: {},
      homeDirectory,
    });
    const databasePath = join(platform.directories.state, "quest.db");

    try {
      const backend = await createSqliteCliBackend({ config, platform });
      await expect(backend.compatibilityProbe.check()).resolves.toEqual({
        outcome: "compatible",
        supported_version: SQLITE_SCHEMA_VERSION,
        store_version: SQLITE_SCHEMA_VERSION,
      });
      expect(await Bun.file(databasePath).exists()).toBeFalse();

      const ports = await backend.openApplicationPorts();
      expect(ports.questStore).toBeInstanceOf(SqliteStore);
      expect(ports.blobStore).toBeInstanceOf(LocalBlobStore);
      if (ports.questStore instanceof SqliteStore) {
        ports.questStore.close();
      }
      expect(await Bun.file(databasePath).exists()).toBeTrue();
      await expect(backend.compatibilityProbe.check()).resolves.toEqual({
        outcome: "compatible",
        supported_version: SQLITE_SCHEMA_VERSION,
        store_version: SQLITE_SCHEMA_VERSION,
      });
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("opens backup recovery ports when the live SQLite database is corrupt", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-corrupt-recovery-"));
    const platform = createPlatform({
      environment: {},
      homeDirectory,
    });
    const databasePath = join(platform.directories.state, "quest.db");

    try {
      await mkdir(platform.directories.state, { recursive: true });
      await writeFile(databasePath, "not a sqlite database");
      const backend = await createSqliteCliBackend({
        config,
        platform,
        recoveryMode: true,
        restoreMode: true,
      });
      const ports = await backend.openApplicationPorts();
      expect(ports.questStore).toBeUndefined();
      expect(ports.backup).toBeDefined();
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("does not initialize a database over orphaned SQLite sidecars during recovery", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-sidecar-recovery-"));
    const platform = createPlatform({
      environment: {},
      homeDirectory,
    });
    const databasePath = join(platform.directories.state, "quest.db");

    try {
      await mkdir(platform.directories.state, { recursive: true });
      await writeFile(`${databasePath}-wal`, "orphan wal");
      const backend = await createSqliteCliBackend({
        config,
        platform,
        recoveryMode: true,
        restoreMode: true,
      });
      const ports = await backend.openApplicationPorts();
      expect(ports.questStore).toBeUndefined();
      expect(await Bun.file(databasePath).exists()).toBeFalse();
      expect(await Bun.file(`${databasePath}-wal`).text()).toBe("orphan wal");
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("does not create a missing live database for read-only backup recovery", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-read-recovery-"));
    const platform = createPlatform({
      environment: {},
      homeDirectory,
    });
    const databasePath = join(platform.directories.state, "quest.db");

    try {
      const backend = await createSqliteCliBackend({
        config,
        platform,
        recoveryMode: true,
      });
      const ports = await backend.openApplicationPorts();
      expect(ports.questStore).toBeUndefined();
      expect(await Bun.file(databasePath).exists()).toBeFalse();
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("uses the online restore path only for an existing healthy database", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-cli-online-recovery-"));
    const platform = createPlatform({
      environment: {},
      homeDirectory,
    });
    const databasePath = join(platform.directories.state, "quest.db");
    const store = new SqliteStore(databasePath);
    store.close();

    try {
      const backend = await createSqliteCliBackend({
        config,
        platform,
        recoveryMode: true,
        restoreMode: true,
      });
      const ports = await backend.openApplicationPorts();
      expect(ports.questStore).toBeInstanceOf(SqliteStore);
      if (ports.questStore instanceof SqliteStore) {
        ports.questStore.close();
      }
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("falls back to recovery config when the live config cannot be loaded", async () => {
    let recoveredConfig: Config | undefined;
    const recoveryFactory: CliBackendFactory = (context) => {
      recoveredConfig = context.config;
      return backendFactory([], "sqlite")(context);
    };
    const root = await createCompositionRoot({
      backendFactories: {
        sqlite: recoveryFactory,
        convex: backendFactory([], "convex"),
      },
      configLoader: () => Promise.reject(new ConfigLoadError("broken live config")),
      environment: { QUEST_BACKUP_ROOT: "/recovery/backups" },
      platformFactory,
      recoveryMode: true,
    });

    if (root.dependencies.openDefaultBackend === undefined) {
      throw new Error("composition root did not expose its default backend resolver");
    }
    await root.dependencies.openDefaultBackend();

    expect(recoveredConfig?.backup.root).toBe("/recovery/backups");
    expect(recoveredConfig?.store.backend).toBe("sqlite");
  });
});
