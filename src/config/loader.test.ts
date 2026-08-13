import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlatform } from "../platform";
import { configSchema } from "../schema";
import { type ConfigFileReader, ConfigLoadError, type ConfigOverrides, loadConfig } from "./loader";

const platform = createPlatform({
  platform: "darwin",
  homeDirectory: "/Users/example",
});
const configFile = join(platform.directories.config, "config.toml");
const repoName = "quest";

function missingFileReader(): ConfigFileReader {
  return () => {
    const error = new Error("file does not exist");
    Object.defineProperty(error, "code", { value: "ENOENT" });
    return Promise.reject(error);
  };
}

function textReader(contents: string): ConfigFileReader {
  return () => Promise.resolve(contents);
}

// A platform module resolves and validates paths with the rules of the platform it
// is configured for, so a fixture that touches the real filesystem has to describe
// the host: a darwin-configured module rejects a Windows temporary directory.
function hostPlatformRootedAt(homeDirectory: string) {
  return createPlatform({ environment: {}, homeDirectory });
}

const defaults = {
  identity: "defaults",
  repos: { quest: "defaults" },
  areas: { quest: ["defaults"] },
  colors: { complete: "defaults" },
  backupRoot: "/backups/defaults",
} satisfies ConfigOverrides;

const fileContents = `
identity = "file"
repos = { quest = "file", file_only = "file" }
areas = { quest = ["file"] }
colors = { complete = "file" }

[backup]
root = "/backups/file"
`;

const environment = {
  QUEST_IDENTITY: "environment",
  QUEST_REPOS: JSON.stringify({ quest: "environment", environment_only: "environment" }),
  QUEST_AREAS: JSON.stringify({ quest: ["environment"] }),
  QUEST_COLORS: JSON.stringify({ complete: "environment" }),
  QUEST_BACKUP_ROOT: "/backups/environment",
};

const flags = {
  identity: "flags",
  repos: { quest: "flags", flags_only: "flags" },
  areas: { quest: ["flags"] },
  colors: { complete: "flags" },
  backupRoot: "/backups/flags",
} satisfies ConfigOverrides;

describe("config precedence", () => {
  const scenarios = [
    {
      name: "command-line flags override every lower source",
      readFile: textReader(fileContents),
      environment,
      flags,
      expected: "flags",
      backupRoot: "/backups/flags",
    },
    {
      name: "environment overrides config file and defaults",
      readFile: textReader(fileContents),
      environment,
      expected: "environment",
      backupRoot: "/backups/environment",
    },
    {
      name: "config file overrides defaults",
      readFile: textReader(fileContents),
      environment: {},
      expected: "file",
      backupRoot: "/backups/file",
    },
    {
      name: "defaults apply when no higher source provides a value",
      readFile: missingFileReader(),
      environment: {},
      expected: "defaults",
      backupRoot: "/backups/defaults",
    },
  ];

  for (const scenario of scenarios) {
    test(scenario.name, async () => {
      const config = await loadConfig({
        platform,
        defaults,
        readFile: scenario.readFile,
        environment: scenario.environment,
        ...(scenario.flags === undefined ? {} : { flags: scenario.flags }),
      });

      expect(config.identity).toBe(scenario.expected);
      expect(config.repos[repoName]).toBe(scenario.expected);
      expect(config.areas[repoName]).toEqual([scenario.expected]);
      expect(config.colors.complete).toBe(scenario.expected);
      expect(config.backup.root).toBe(scenario.backupRoot);
      expect(configSchema.safeParse(config).success).toBeTrue();
    });
  }

  test("merges map entries while higher sources replace conflicting leaves", async () => {
    const config = await loadConfig({
      platform,
      defaults,
      readFile: textReader(fileContents),
      environment,
      flags,
    });

    expect(config.repos).toEqual({
      quest: "flags",
      file_only: "file",
      environment_only: "environment",
      flags_only: "flags",
    });
  });
});

describe("config loading", () => {
  test("warns once and ignores an unknown key in a known section", async () => {
    const warnings: string[] = [];
    const config = await loadConfig({
      platform,
      environment: {},
      onWarning: (warning) => warnings.push(warning),
      readFile: textReader('[store]\nlease_ttl_minutes = 60\nfuture_option = "ignored"'),
    });

    expect(config.store).toEqual({ backend: "sqlite", lease_ttl_minutes: 60 });
    expect(warnings).toEqual([
      'ignored unknown config key "store.future_option"; no value was applied; store.backend remains "sqlite"; set store.backend explicitly if you intended a different backend; upgrade the Quest binary before relying on this setting',
    ]);
  });

  test("warns when an unknown store key cannot change the selected backend", async () => {
    const warnings: string[] = [];
    const config = await loadConfig({
      platform,
      environment: {},
      onWarning: (warning) => warnings.push(warning),
      readFile: textReader('[store]\nbacknd = "convex"'),
    });

    expect(config.store.backend).toBe("sqlite");
    expect(warnings).toEqual([
      'ignored unknown config key "store.backnd"; no value was applied; store.backend remains "sqlite"; set store.backend explicitly if you intended a different backend; upgrade the Quest binary before relying on this setting',
    ]);
  });

  test("warns once and ignores an unknown top-level section", async () => {
    const warnings: string[] = [];
    const config = await loadConfig({
      platform,
      environment: {},
      onWarning: (warning) => warnings.push(warning),
      readFile: textReader('[future]\nnew_option = "ignored"'),
    });

    expect(config.store.backend).toBe("sqlite");
    expect(warnings).toEqual([
      'ignored unknown config section "future"; no settings from it were applied; upgrade the Quest binary before relying on this setting',
    ]);
  });

  test("resolves the session guild from config, environment, and flags", async () => {
    const resolved = await loadConfig({
      platform,
      defaults: { guild: "defaults" },
      readFile: textReader('guild = "file"'),
      environment: { QUEST_GUILD: "environment" },
      flags: { guild: "flags" },
    });
    expect(resolved.guild).toBe("flags");

    const environmentGuild = await loadConfig({
      platform,
      readFile: textReader('guild = "file"'),
      environment: { QUEST_GUILD: "environment" },
    });
    expect(environmentGuild.guild).toBe("environment");

    const fileGuild = await loadConfig({
      platform,
      readFile: textReader('guild = "file"'),
      environment: {},
    });
    expect(fileGuild.guild).toBe("file");
  });

  test("uses the platform backup directory and schema defaults when config is absent", async () => {
    const config = await loadConfig({
      platform,
      environment: {},
      readFile: missingFileReader(),
    });

    expect(config).toEqual({
      store: { backend: "sqlite" },
      repos: {},
      areas: {},
      colors: {},
      labels: { areas: {}, statuses: {}, verdicts: {} },
      backup: {
        root: "/Users/example/Backups/quest",
        retention: { daily: 7, weekly: 4, monthly: 6 },
      },
    });
  });

  test("maps legacy ready colors and labels to open with open taking precedence", async () => {
    const config = await loadConfig({
      platform,
      environment: {},
      readFile: textReader(`
colors = { ready = "legacy", open = "current" }
[labels.statuses]
ready = "Available"
`),
    });

    expect(config.colors).toEqual({ open: "current" });
    expect(config.labels.statuses).toEqual({ open: "Available" });
  });

  test("reads config.toml from the platform config directory with smol-toml", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-config-"));
    const temporaryPlatform = hostPlatformRootedAt(homeDirectory);
    const expectedConfigFile = join(temporaryPlatform.directories.config, "config.toml");

    try {
      await mkdir(temporaryPlatform.directories.config, { recursive: true });
      await writeFile(
        expectedConfigFile,
        `
identity = "janior"

[store]
backend = "convex"
convex_deployment = "dev:quest"
lease_ttl_minutes = 60

[dispatch]
trust = "guarded"
claude_args = ["--model", "sonnet"]
codex_args = ["--model", "gpt-5"]

[backup]
retention = { daily = 2, weekly = 1, monthly = 0 }
`,
      );

      const config = await loadConfig({ platform: temporaryPlatform, environment: {} });

      expect(config.identity).toBe("janior");
      expect(config.store).toEqual({
        backend: "convex",
        convex_deployment: "dev:quest",
        lease_ttl_minutes: 60,
      });
      expect(config.dispatch).toEqual({
        trust: "guarded",
        claude_args: ["--model", "sonnet"],
        codex_args: ["--model", "gpt-5"],
      });
      expect(config.backup).toEqual({
        root: temporaryPlatform.directories.backup,
        retention: { daily: 2, weekly: 1, monthly: 0 },
      });
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });

  test("reads per-repository backend overrides from nested TOML tables", async () => {
    const config = await loadConfig({
      platform,
      environment: {},
      readFile: textReader(`
[store]
backend = "sqlite"

[repos.web-app.store]
backend = "convex"
deployment = "https://happy-fox-123.convex.cloud"
`),
    });

    expect(config.repos["web-app"]).toEqual({
      store: {
        backend: "convex",
        deployment: "https://happy-fox-123.convex.cloud",
      },
    });
  });

  test("recovers a config left beside the path by an interrupted migration", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-config-recovery-"));
    const temporaryPlatform = hostPlatformRootedAt(homeDirectory);
    const temporaryConfigFile = join(temporaryPlatform.directories.config, "config.toml");
    const recoveryFile = `${temporaryConfigFile}.quest-migration-recovery`;
    try {
      await mkdir(temporaryPlatform.directories.config, { recursive: true });
      await writeFile(recoveryFile, 'identity = "recovered"\n');

      const config = await loadConfig({ platform: temporaryPlatform, environment: {} });

      expect(config.identity).toBe("recovered");
      expect(await readFile(temporaryConfigFile, "utf8")).toBe('identity = "recovered"\n');
    } finally {
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("waits for a config writer lock before recovering an interrupted file", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-config-recovery-lock-"));
    const temporaryPlatform = hostPlatformRootedAt(homeDirectory);
    const temporaryConfigFile = join(temporaryPlatform.directories.config, "config.toml");
    const recoveryFile = `${temporaryConfigFile}.quest-migration-recovery`;
    const lockDirectory = `${temporaryConfigFile}.lock`;
    try {
      await mkdir(temporaryPlatform.directories.config, { recursive: true });
      await writeFile(recoveryFile, 'identity = "recovered"\n');
      await mkdir(lockDirectory);

      const loading = loadConfig({ platform: temporaryPlatform, environment: {} });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(await readFile(recoveryFile, "utf8")).toBe('identity = "recovered"\n');

      await rm(lockDirectory, { recursive: true, force: true });
      const config = await loading;
      expect(config.identity).toBe("recovered");
    } finally {
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("reclaims stale config locks before recovering an interrupted file", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "quest-config-recovery-stale-lock-"));
    const temporaryPlatform = hostPlatformRootedAt(homeDirectory);
    const temporaryConfigFile = join(temporaryPlatform.directories.config, "config.toml");
    const recoveryFile = `${temporaryConfigFile}.quest-migration-recovery`;
    const lockDirectory = `${temporaryConfigFile}.lock`;
    const reclaimDirectory = `${lockDirectory}.reclaim`;
    try {
      await mkdir(temporaryPlatform.directories.config, { recursive: true });
      await writeFile(recoveryFile, 'identity = "recovered"\n');
      await mkdir(lockDirectory);
      const staleTime = new Date(Date.now() - 20_000);
      await utimes(lockDirectory, staleTime, staleTime);
      await mkdir(reclaimDirectory);
      await utimes(reclaimDirectory, staleTime, staleTime);

      const config = await loadConfig({ platform: temporaryPlatform, environment: {} });
      expect(config.identity).toBe("recovered");
    } finally {
      await rm(reclaimDirectory, { recursive: true, force: true });
      await rm(lockDirectory, { recursive: true, force: true });
      await rm(homeDirectory, { force: true, recursive: true });
    }
  });

  test("reads viewer preferences from the shared tui section", async () => {
    const config = await loadConfig({
      platform,
      environment: {},
      readFile: textReader('[tui]\nmouse = false\ntheme = "dense"'),
    });

    expect(config.tui).toEqual({ mouse: false, theme: "dense" });
  });
});

describe("config errors", () => {
  test("reports TOML parse errors with the config file path", async () => {
    const promise = loadConfig({
      platform,
      environment: {},
      readFile: textReader("identity = ["),
    });

    await expect(promise).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(promise).rejects.toThrow(`could not parse config file ${configFile}`);
  });

  test("reports schema paths for invalid config file values", async () => {
    const promise = loadConfig({
      platform,
      environment: {},
      readFile: textReader('areas = { quest = ["cli", 9] }'),
    });

    await expect(promise).rejects.toThrow(`invalid config file ${configFile}`);
    await expect(promise).rejects.toThrow("areas.quest.1");
    await expect(promise).rejects.toThrow("expected string");
  });

  test("does not silently merge TOML dates into object-valued settings", async () => {
    for (const invalidConfig of ["repos = 2026-01-01", "[backup]\nretention = 2026-01-01"]) {
      const promise = loadConfig({
        platform,
        environment: {},
        readFile: textReader(invalidConfig),
      });

      await expect(promise).rejects.toThrow(`invalid config file ${configFile}`);
      await expect(promise).rejects.toThrow("expected record");
    }
  });

  test("reports the environment variable that contains invalid JSON", async () => {
    const promise = loadConfig({
      platform,
      environment: { QUEST_REPOS: "{not-json}" },
      readFile: missingFileReader(),
    });

    await expect(promise).rejects.toThrow("invalid QUEST_REPOS: expected JSON");
  });

  test("validates decoded environment values through the config schema", async () => {
    const promise = loadConfig({
      platform,
      environment: { QUEST_COLORS: JSON.stringify({ unknown: "red" }) },
      readFile: missingFileReader(),
    });

    await expect(promise).rejects.toThrow("invalid environment variables");
    await expect(promise).rejects.toThrow("colors.unknown");
  });

  test("distinguishes unreadable config files from missing ones", async () => {
    const readFile: ConfigFileReader = () => {
      const error = new Error("permission denied");
      Object.defineProperty(error, "code", { value: "EACCES" });
      return Promise.reject(error);
    };

    await expect(loadConfig({ platform, environment: {}, readFile })).rejects.toThrow(
      `could not read config file ${configFile}: permission denied`,
    );
  });
});
