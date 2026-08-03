import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createCliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from "../output";
import type { BackupScheduleStatus, EvidenceOpener } from "../platform";
import type { Config } from "../schema";
import {
  type Clock,
  createSqliteStore,
  createStoreCompatibilityProbe,
  LocalBlobStore,
  type StoreCompatibilityProbe,
} from "../store";
import type { ConvexOnboardingOperations } from "./members";
import {
  type CliApplicationPorts,
  type FutureTuiContext,
  type FutureTuiLauncher,
  type QuestCliDependencies,
  runQuestCli,
} from "./program";

function compatibilityProbe(
  outcome: "compatible" | "store-newer" | "store-older" = "compatible",
): StoreCompatibilityProbe {
  return {
    check: () => {
      switch (outcome) {
        case "compatible":
          return Promise.resolve({
            outcome,
            supported_version: 1,
            store_version: 1,
          });
        case "store-newer":
          return Promise.resolve({
            outcome,
            supported_version: 1,
            store_version: 2,
            action: "upgrade-binary",
          });
        case "store-older":
          return Promise.resolve({
            outcome,
            supported_version: 1,
            store_version: 0,
            action: "migrate-store",
          });
      }
    },
  };
}

const clock: Clock = {
  now: () => Promise.resolve("2026-07-29T12:00:00Z"),
};

const config = {
  guild: "claude",
  identity: "janior/codex",
  store: { backend: "sqlite" },
  repos: { quest: "quest-alias" },
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

const workDirectory = join(resolve("/"), "work");
const questWorkingDirectory = join(workDirectory, "quest");

function harness(options: {
  readonly compatible?: "compatible" | "store-newer" | "store-older";
  readonly close?: () => Promise<void>;
  readonly config?: Config;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly isTty?: boolean;
  readonly launchTui?: FutureTuiLauncher;
  readonly onboarding?: ConvexOnboardingOperations;
  readonly openBackend?: QuestCliDependencies["openBackend"];
  readonly openApplicationPorts?: () => Promise<CliApplicationPorts>;
  readonly probe?: StoreCompatibilityProbe;
  readonly saveViewerTheme?: (themeName: string) => Promise<void>;
  readonly viewer?: EvidenceOpener;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies = {
    applicationVersion: "1.2.3",
    clock,
    ...(options.close === undefined ? {} : { close: options.close }),
    compatibilityProbe: options.probe ?? compatibilityProbe(options.compatible),
    config: options.config ?? config,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    evidenceFiles: {
      read: () => Promise.reject(new Error("evidence must not be read for this command")),
    },
    initialWorkingDirectory: questWorkingDirectory,
    isTty: options.isTty ?? false,
    ...(options.launchTui === undefined ? {} : { launchTui: options.launchTui }),
    ...(options.onboarding === undefined ? {} : { onboarding: options.onboarding }),
    locateGitRoot: () => Promise.resolve(questWorkingDirectory),
    ...(options.openBackend === undefined ? {} : { openBackend: options.openBackend }),
    openApplicationPorts:
      options.openApplicationPorts ??
      (() => Promise.reject(new Error("backend must not open for this command"))),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => Promise.reject(new Error("prompt must not run for this command")),
    },
    validateWorkingDirectory: () => Promise.resolve(),
    ...(options.saveViewerTheme === undefined ? {} : { saveViewerTheme: options.saveViewerTheme }),
    upgrade: {
      check: () =>
        Promise.resolve({
          artifact: "quest-1.2.3-darwin-arm64",
          artifact_url: "https://example.com/quest",
          current_version: "1.2.3",
          latest_version: "1.2.3",
          release_url: "https://example.com/release",
          repository: "janiorvalle/quest",
          target: "darwin-arm64",
          update_available: false,
        }),
      install: () =>
        Promise.resolve({
          artifact: "quest-1.2.3-darwin-arm64",
          artifact_url: "https://example.com/quest",
          checksum: null,
          current_version: "1.2.3",
          installed: false,
          latest_version: "1.2.3",
          release_url: "https://example.com/release",
          repository: "janiorvalle/quest",
          target: "darwin-arm64",
          update_available: false,
        }),
    },
    ...(options.viewer === undefined ? {} : { viewer: options.viewer }),
  };
  return { dependencies, stderr, stdout };
}

describe("Commander CLI wiring", () => {
  test("--version checks compatibility and retains the installed-binary output contract", async () => {
    const { dependencies, stderr, stdout } = harness({});

    expect(await runQuestCli(["--version"], dependencies)).toBe(EXIT_SUCCESS);
    expect(stdout).toEqual(["quest 1.2.3\n"]);
    expect(stderr).toEqual([]);
  });

  test("--version supports the JSON report envelope", async () => {
    const { dependencies, stdout } = harness({});

    expect(await runQuestCli(["--format", "json", "--version"], dependencies)).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema: "quest.report/v1",
      command: "version",
      generated_at: "2026-07-29T12:00:00Z",
      filters: {},
      warnings: [],
      data: {
        version: "1.2.3",
        store_schema_version: 1,
      },
    });
  });

  test("upgrade checks releases without opening the store or requiring compatibility", async () => {
    const { dependencies, stdout } = harness({ compatible: "store-newer" });

    expect(await runQuestCli(["upgrade", "--check"], dependencies)).toBe(EXIT_SUCCESS);
    expect(stdout).toEqual(["quest upgrade: 1.2.3 is already the latest release\n"]);
  });

  test("member admin commands use the repository-scoped Convex deployment", async () => {
    const calls: string[] = [];
    const scopedConfig = {
      ...config,
      repos: {
        "web-app": {
          store: { backend: "convex", deployment: "dev:scoped" },
        },
      },
    } satisfies Config;
    const onboarding: ConvexOnboardingOperations = {
      invite: async () => ({ member: "alice", token: "invite-token" }),
      rotate: async () => ({
        member: "alice",
        old_key_expires_at: 123,
        token: "member-token",
      }),
      remove: async () => ({ member: "alice", revoked_keys: 1 }),
      list: async (deployment) => {
        calls.push(deployment);
        return [];
      },
      join: async () => ({ member: "alice", token: "member-token" }),
      whoami: async () => ({ member: "alice" }),
      repositories: async () => [],
    };
    const { dependencies, stdout } = harness({
      config: scopedConfig,
      environment: { QUEST_ADMIN_SECRET: "admin-secret" },
      onboarding,
    });

    expect(await runQuestCli(["--repo", "web-app", "members", "list"], dependencies)).toBe(
      EXIT_SUCCESS,
    );
    expect(calls).toEqual(["dev:scoped"]);
    expect(stdout).toEqual(["No members\n"]);
  });

  test("preserves the command result when backend cleanup fails", async () => {
    const { dependencies, stderr, stdout } = harness({
      close: () => Promise.reject(new Error("cleanup failed")),
    });

    expect(await runQuestCli(["--version"], dependencies)).toBe(EXIT_SUCCESS);
    expect(stdout).toEqual(["quest 1.2.3\n"]);
    expect(stderr).toEqual([]);
  });

  test("bare invocation prints compact status and command help", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-bare-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const ports = {
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      clock,
      questStore: store,
    } satisfies CliApplicationPorts;
    const { dependencies, stdout } = harness({
      openApplicationPorts: () => Promise.resolve(ports),
    });

    try {
      expect(await runQuestCli(["--repo", "other-app"], dependencies)).toBe(EXIT_SUCCESS);
      expect(stdout.join("\n")).toContain("quest · other-app · 0 quests");
      expect(stdout.join("\n")).toContain("Usage: quest");

      stdout.length = 0;
      expect(await runQuestCli(["--format", "json", "--repo", "other-app"], dependencies)).toBe(
        EXIT_SUCCESS,
      );
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        schema: "quest.report/v1",
        command: "status",
        filters: { repo: "other-app" },
        data: {
          repo: "other-app",
          total: 0,
          status_counts: { ready: 0, complete: 0 },
        },
      });
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("bare invocation does not require a TTY", async () => {
    const { dependencies, stderr } = harness({});

    expect(await runQuestCli([], dependencies)).toBe(EXIT_DOMAIN_ERROR);
    expect(stderr[0]).toContain("backend must not open for this command");
  });

  test("bare TTY invocation launches the read-only viewer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-tui-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const ports = {
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      clock,
      questStore: store,
    } satisfies CliApplicationPorts;
    let viewerContext: FutureTuiContext | undefined;
    const { dependencies, stderr, stdout } = harness({
      isTty: true,
      launchTui: async (context) => {
        viewerContext = context;
      },
      openApplicationPorts: () => Promise.resolve(ports),
      viewer: { openEvidence: () => Promise.resolve(), openUrl: () => Promise.resolve() },
    });

    try {
      expect(await runQuestCli(["--repo", "other-app"], dependencies)).toBe(EXIT_SUCCESS);
      expect(viewerContext?.scope).toEqual({ repo: "other-app" });
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([]);
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("resolves the viewer theme by flag, then environment, then config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-theme-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const ports = {
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      clock,
      questStore: store,
    } satisfies CliApplicationPorts;
    const themeFor = async (options: {
      readonly arguments?: readonly string[];
      readonly configTheme?: string;
      readonly environmentTheme?: string;
    }) => {
      let viewerContext: FutureTuiContext | undefined;
      const { dependencies } = harness({
        ...(options.configTheme === undefined
          ? {}
          : { config: { ...config, tui: { theme: options.configTheme } } }),
        ...(options.environmentTheme === undefined
          ? {}
          : { environment: { QUEST_THEME: options.environmentTheme } }),
        isTty: true,
        launchTui: async (context) => {
          viewerContext = context;
        },
        openApplicationPorts: () => Promise.resolve(ports),
        viewer: { openEvidence: () => Promise.resolve(), openUrl: () => Promise.resolve() },
      });
      expect(await runQuestCli(options.arguments ?? [], dependencies)).toBe(EXIT_SUCCESS);
      return viewerContext?.theme;
    };

    try {
      expect((await themeFor({}))?.name).toBe("dense");
      expect((await themeFor({ configTheme: "dense" }))?.name).toBe("dense");
      expect((await themeFor({ arguments: ["--theme", "dense"] }))?.name).toBe("dense");
      expect((await themeFor({ environmentTheme: "dense" }))?.name).toBe("dense");

      // A config naming a theme this build lacks warns instead of failing.
      const stale = await themeFor({ configTheme: "from-a-newer-quest" });
      expect(stale?.name).toBe("dense");
      expect(stale?.warnings[0]).toContain('Config theme "from-a-newer-quest"');
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("an unknown theme from a flag or the environment is a usage error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-theme-unknown-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const ports = {
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      clock,
      questStore: store,
    } satisfies CliApplicationPorts;
    const viewerHarness = (environment?: Readonly<Record<string, string | undefined>>) =>
      harness({
        ...(environment === undefined ? {} : { environment }),
        isTty: true,
        launchTui: () => Promise.reject(new Error("the viewer must not launch on a bad theme")),
        openApplicationPorts: () => Promise.resolve(ports),
        viewer: { openEvidence: () => Promise.resolve(), openUrl: () => Promise.resolve() },
      });

    try {
      const flagRun = viewerHarness();
      expect(await runQuestCli(["--theme", "tavren"], flagRun.dependencies)).toBe(EXIT_USAGE_ERROR);
      expect(flagRun.stderr[0]).toContain("[QUEST_UNKNOWN_THEME]");
      expect(flagRun.stderr[0]).toContain("Valid themes: dense");

      const environmentRun = viewerHarness({ QUEST_THEME: "ledgr" });
      expect(await runQuestCli([], environmentRun.dependencies)).toBe(EXIT_USAGE_ERROR);
      expect(environmentRun.stderr[0]).toContain("QUEST_THEME=ledgr");
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("the viewer saves a theme through the config writer the CLI supplies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-theme-save-"));
    const store = createSqliteStore(join(directory, "quest.db"));
    const ports = {
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      clock,
      questStore: store,
    } satisfies CliApplicationPorts;
    const saved: string[] = [];
    let viewerContext: FutureTuiContext | undefined;
    const { dependencies } = harness({
      isTty: true,
      launchTui: async (context) => {
        viewerContext = context;
      },
      openApplicationPorts: () => Promise.resolve(ports),
      saveViewerTheme: async (themeName) => {
        saved.push(themeName);
      },
      viewer: { openEvidence: () => Promise.resolve(), openUrl: () => Promise.resolve() },
    });

    try {
      expect(await runQuestCli([], dependencies)).toBe(EXIT_SUCCESS);
      await viewerContext?.theme.save("dense");
      expect(saved).toEqual(["dense"]);
    } finally {
      store.close();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("closes the selected backend after viewer and list commands", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-backend-close-"));
    const stores: ReturnType<typeof createSqliteStore>[] = [];
    const keepAliveTimers: ReturnType<typeof setInterval>[] = [];
    const events: string[] = [];
    const routedConfig = {
      ...config,
      repos: {
        "other-app": {
          store: { backend: "sqlite" },
        },
      },
    } satisfies Config;
    let opened = 0;
    const openBackend: NonNullable<QuestCliDependencies["openBackend"]> = () => {
      const id = opened;
      opened += 1;
      const store = createSqliteStore(join(directory, `quest-${id}.db`));
      const keepAlive = setInterval(() => undefined, 60_000);
      stores.push(store);
      keepAliveTimers.push(keepAlive);
      return Promise.resolve({
        clock,
        close: async () => {
          events.push(`close:${id}`);
          clearInterval(keepAlive);
          store.close();
        },
        compatibilityProbe: compatibilityProbe(),
        openApplicationPorts: () =>
          Promise.resolve({
            blobStore: new LocalBlobStore(join(directory, `evidence-${id}`)),
            clock,
            questStore: store,
          }),
      });
    };

    try {
      const viewer = harness({
        config: routedConfig,
        isTty: true,
        launchTui: async () => {
          events.push("viewer-finished");
        },
        openBackend,
        viewer: { openEvidence: () => Promise.resolve(), openUrl: () => Promise.resolve() },
      });
      expect(await runQuestCli(["--repo", "other-app"], viewer.dependencies)).toBe(EXIT_SUCCESS);
      expect(events).toEqual(["viewer-finished", "close:0"]);

      const list = harness({ config: routedConfig, openBackend });
      expect(await runQuestCli(["--repo", "other-app", "list"], list.dependencies)).toBe(
        EXIT_SUCCESS,
      );
      expect(events).toEqual(["viewer-finished", "close:0", "close:1"]);
    } finally {
      for (const store of stores) {
        store.close();
      }
      for (const timer of keepAliveTimers) {
        clearInterval(timer);
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("emits generated completions without opening the backend", async () => {
    const { dependencies, stderr, stdout } = harness({});

    for (const shell of ["zsh", "bash", "fish"]) {
      expect(await runQuestCli(["completions", shell], dependencies)).toBe(EXIT_SUCCESS);
      const script = stdout.join("");
      expect(script).toContain("verdict");
      expect(script).toContain("actionable");
      expect(script).toContain("--status");
      expect(script).toContain("required-variadic");
      expect(script).toContain("option_file_paths");
      expect(script).toContain("attached_options");
      if (shell === "fish") {
        expect(script).toContain("complete -c quest -f -a");
        expect(script).toContain("complete -c quest -n '__quest_file_context' -F");
        expect(script).toContain("complete -c quest -s 'C' -r -n '__quest_file_context' -F");
      }
      stdout.length = 0;
    }
    expect(stderr).toEqual([]);
  });

  test("Commander usage failures flow through the output error boundary", async () => {
    const { dependencies, stderr } = harness({});

    expect(await runQuestCli(["--unknown"], dependencies)).toBe(EXIT_USAGE_ERROR);
    expect(stderr).toEqual(["quest: usage: unknown option '--unknown'"]);
  });

  test("whitespace-only option values return a sanitized usage error", async () => {
    const { dependencies, stderr } = harness({});

    expect(await runQuestCli(["--repo", "   "], dependencies)).toBe(EXIT_USAGE_ERROR);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toStartWith("quest: usage:");
    expect(stderr[0]).not.toContain("\n");
  });

  test("Commander rejects conflicting global scopes", async () => {
    const { dependencies, stderr } = harness({});

    expect(await runQuestCli(["--repo", "quest", "--all"], dependencies)).toBe(EXIT_USAGE_ERROR);
    expect(stderr.join("\n")).toContain("cannot be used with option");
  });

  test("newer stores tell the user to upgrade the binary", async () => {
    const { dependencies, stderr } = harness({ compatible: "store-newer" });

    expect(await runQuestCli(["--version"], dependencies)).toBe(EXIT_DOMAIN_ERROR);
    expect(stderr).toEqual([
      "quest: domain: store schema 2 was written by a newer quest; upgrade the quest binary (this binary supports schema 1)",
    ]);
  });

  test("older stores give a distinct migration instruction", async () => {
    const { dependencies, stderr } = harness({ compatible: "store-older" });

    expect(await runQuestCli(["--version"], dependencies)).toBe(EXIT_DOMAIN_ERROR);
    expect(stderr).toEqual([
      "quest: domain: store schema 0 is older than this binary supports (1); run quest migrate before retrying",
    ]);
  });

  test("ordinary commands do not migrate older stores", async () => {
    let migrationCalls = 0;
    const probe: StoreCompatibilityProbe = {
      check: () =>
        Promise.resolve({
          outcome: "store-older" as const,
          supported_version: 1,
          store_version: 0,
          action: "migrate-store" as const,
        }),
      migrate: () => {
        migrationCalls += 1;
        return Promise.resolve();
      },
    };
    const { dependencies, stderr } = harness({ probe });

    expect(await runQuestCli(["--version"], dependencies)).toBe(EXIT_DOMAIN_ERROR);
    expect(migrationCalls).toBe(0);
    expect(stderr[0]).toContain("run quest migrate");
  });

  test("migrate explicitly upgrades an older store", async () => {
    let migrationCalls = 0;
    let storeVersion = 0;
    const probe: StoreCompatibilityProbe = {
      check: () =>
        Promise.resolve(
          storeVersion === 0
            ? {
                outcome: "store-older" as const,
                supported_version: 1,
                store_version: 0,
                action: "migrate-store" as const,
              }
            : {
                outcome: "compatible" as const,
                supported_version: 1,
                store_version: 1,
              },
        ),
      migrate: () => {
        migrationCalls += 1;
        storeVersion = 1;
        return Promise.resolve();
      },
    };
    const { dependencies, stderr, stdout } = harness({ probe });

    expect(await runQuestCli(["--format", "json", "migrate"], dependencies)).toBe(EXIT_SUCCESS);
    expect(migrationCalls).toBe(1);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema: "quest.report/v1",
      command: "migrate",
      generated_at: "2026-07-29T12:00:00Z",
      filters: {},
      warnings: [],
      data: {
        changed: true,
        store_schema_version: 1,
      },
    });
  });

  test("backup management can open recovery ports without probing a corrupt live store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quest-cli-recovery-"));
    const restoreCalls: string[] = [];
    const scheduleCalls: string[] = [];
    const scheduleStatus = {
      definition_exists: false,
      definition_path: join(directory, "quest-backup.timer"),
      executable: join(directory, "quest"),
      executable_exists: false,
      frequency: "daily",
      installed: false,
      kind: "systemd",
      task_name: null,
    } satisfies BackupScheduleStatus;
    const ports = {
      backup: {
        list: () => Promise.resolve([]),
        prune: () => Promise.resolve({ deleted: [], retained: [] }),
        restore: (snapshot: string) => {
          restoreCalls.push(snapshot);
          return Promise.resolve({
            snapshot,
            pre_restore_database: join(directory, "quest.db.pre-restore"),
            pre_restore_config: null,
            evidence_restored: 0,
            verified: true,
          });
        },
        run: () => Promise.reject(new Error("backup run must not execute")),
        verify: (snapshot?: string) =>
          Promise.resolve({
            snapshot: snapshot ?? "2026-07-29T201530.000Z",
            verified: true,
            full: false,
            counts: { quests: 0, evidence: 0, chains: 0, events: 0 },
            integrity_check: "ok",
            sampled_evidence: [],
          }),
      },
      blobStore: new LocalBlobStore(join(directory, "evidence")),
      clock,
      scheduler: {
        install: () => {
          scheduleCalls.push("install");
          return Promise.resolve({ ...scheduleStatus, installed: true });
        },
        status: () => {
          scheduleCalls.push("status");
          return Promise.resolve(scheduleStatus);
        },
        remove: () => {
          scheduleCalls.push("remove");
          return Promise.resolve(scheduleStatus);
        },
      },
    } satisfies CliApplicationPorts;
    const { dependencies, stderr } = harness({
      compatible: "store-newer",
      openApplicationPorts: () => Promise.resolve(ports),
    });

    try {
      expect(await runQuestCli(["backup", "restore", "2026-07-29T201530.000Z"], dependencies)).toBe(
        EXIT_SUCCESS,
      );
      expect(await runQuestCli(["backup", "verify"], dependencies)).toBe(EXIT_SUCCESS);
      expect(await runQuestCli(["backup", "list"], dependencies)).toBe(EXIT_SUCCESS);
      expect(await runQuestCli(["backup", "prune"], dependencies)).toBe(EXIT_SUCCESS);
      expect(await runQuestCli(["backup", "schedule", "install"], dependencies)).toBe(EXIT_SUCCESS);
      expect(await runQuestCli(["backup", "schedule", "status"], dependencies)).toBe(EXIT_SUCCESS);
      expect(await runQuestCli(["backup", "schedule", "remove"], dependencies)).toBe(EXIT_SUCCESS);
      expect(restoreCalls).toEqual(["2026-07-29T201530.000Z"]);
      expect(scheduleCalls).toEqual(["install", "status", "remove"]);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("invalid infrastructure versions are domain errors rather than CLI usage errors", async () => {
    const probe = createStoreCompatibilityProbe({
      readStoreVersion: () => -1,
    });
    const { dependencies, stderr } = harness({ probe });

    expect(await runQuestCli(["--version"], dependencies)).toBe(EXIT_DOMAIN_ERROR);
    expect(stderr).toEqual([
      expect.stringContaining("quest: domain: invalid store compatibility result"),
    ]);
  });
});
