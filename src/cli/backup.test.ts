import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createCliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  type ExitCode,
} from "../output";
import type { Config } from "../schema";
import type { BackupOperations } from "../services";
import { LocalBlobStore, SqliteStore } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const timestamp = "2026-07-29T21:00:00.000Z";

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

interface BackupCliHarness {
  readonly calls: string[];
  readonly directory: string;
  readonly run: (argumentsWithoutRuntime: readonly string[]) => Promise<{
    readonly code: ExitCode;
    readonly stderr: readonly string[];
    readonly stdout: readonly string[];
  }>;
  readonly stop: () => Promise<void>;
}

interface BackupCliHarnessOptions {
  readonly installResultInstalled?: boolean;
  readonly removeResultInstalled?: boolean;
  readonly statusExecutableExists?: boolean;
}

async function createHarness(options: BackupCliHarnessOptions = {}): Promise<BackupCliHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-backup-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const store = new SqliteStore(join(directory, "quest.db"));
  const backup = {
    run: (root?: string) => {
      calls.push(`run:${root ?? "default"}`);
      return Promise.resolve({
        snapshot: "2026-07-29T210000.000Z",
        path: join(directory, "backups", "snapshots", "2026-07-29T210000.000Z"),
        counts: { quests: 2, evidence: 1, chains: 0, events: 2 },
        evidence: { copied: 1, count: 1, total_bytes: 10 },
        pruned: [],
      });
    },
    verify: (snapshot?: string, options: { readonly full?: boolean } = {}) => {
      calls.push(`verify:${snapshot ?? "latest"}:${options.full === true ? "full" : "sample"}`);
      return Promise.resolve({
        snapshot: snapshot ?? "2026-07-29T210000.000Z",
        verified: true,
        full: options.full === true,
        counts: { quests: 2, evidence: 1, chains: 0, events: 2 },
        integrity_check: "ok",
        sampled_evidence: ["a".repeat(64)],
      });
    },
    list: () => {
      calls.push("list");
      return Promise.resolve([
        {
          snapshot: "2026-07-29T210000.000Z",
          created_at: timestamp,
          age_seconds: 0,
          size_bytes: 1024,
          counts: { quests: 2, evidence: 1, chains: 0, events: 2 },
        },
      ]);
    },
    restore: (snapshot: string) => {
      calls.push(`restore:${snapshot}`);
      return Promise.resolve({
        snapshot,
        pre_restore_database: join(directory, "quest.db.pre-restore"),
        pre_restore_config: null,
        evidence_restored: 1,
        verified: true,
      });
    },
    prune: () => {
      calls.push("prune");
      return Promise.resolve({ deleted: ["old"], retained: ["new"] });
    },
  } satisfies BackupOperations;
  const dependencies = {
    applicationVersion: "1.2.3",
    clock: { now: () => Promise.resolve(timestamp) },
    compatibilityProbe: {
      check: () =>
        Promise.resolve({
          outcome: "compatible",
          supported_version: 1,
          store_version: 1,
        }),
    },
    config,
    evidenceFiles: {
      read: () => Promise.reject(new Error("backup commands must not use evidence readers")),
    },
    initialWorkingDirectory: directory,
    isTty: false,
    locateGitRoot: () => Promise.resolve(directory),
    openApplicationPorts: () =>
      Promise.resolve({
        backup,
        blobStore: new LocalBlobStore(join(directory, "evidence")),
        clock: { now: () => Promise.resolve(timestamp) },
        questStore: store,
        scheduler: {
          kind: "launchd",
          install: () => {
            calls.push("schedule:install");
            return Promise.resolve({
              definition_exists: true,
              definition_path: join(directory, "quest-backup.plist"),
              executable: join(directory, "quest"),
              executable_exists: true,
              frequency: "daily",
              installed: options.installResultInstalled ?? true,
              kind: "launchd",
              task_name: null,
            });
          },
          status: () => {
            calls.push("schedule:status");
            return Promise.resolve({
              definition_exists: true,
              definition_path: join(directory, "quest-backup.plist"),
              executable: join(directory, "quest"),
              executable_exists: options.statusExecutableExists ?? true,
              frequency: "daily",
              installed: true,
              kind: "launchd",
              task_name: null,
            });
          },
          remove: () => {
            calls.push("schedule:remove");
            return Promise.resolve({
              definition_exists: false,
              definition_path: join(directory, "quest-backup.plist"),
              executable: join(directory, "quest"),
              executable_exists: true,
              frequency: "daily",
              installed: options.removeResultInstalled ?? false,
              kind: "launchd",
              task_name: null,
            });
          },
        },
      }),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => Promise.reject(new Error("backup commands must not prompt")),
    },
    validateWorkingDirectory: () => Promise.resolve(),
  } satisfies QuestCliDependencies;

  return {
    calls,
    directory,
    async run(argumentsWithoutRuntime) {
      stdout.length = 0;
      stderr.length = 0;
      const code = await runQuestCli(argumentsWithoutRuntime, dependencies);
      return { code, stderr: [...stderr], stdout: [...stdout] };
    },
    async stop() {
      store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

describe("backup CLI", () => {
  test("registers and dispatches every backup verb with JSON envelopes", async () => {
    const harness = await createHarness();
    try {
      const run = await harness.run(["backup", "run", "--to", "portable", "--format", "json"]);
      expect(run.code).toBe(EXIT_SUCCESS);
      expect(JSON.parse(run.stdout.join("")).command).toBe("backup run");
      expect(harness.calls[0]).toBe(`run:${resolve(harness.directory, "portable")}`);
    } finally {
      await harness.stop();
    }
  });

  test("routes verify, list, restore, and prune without changing existing global parsing", async () => {
    const harness = await createHarness();
    try {
      const snapshot = "2026-07-29T210000.000Z";
      expect((await harness.run(["backup", "verify", "--format", "json"])).code).toBe(EXIT_SUCCESS);
      expect((await harness.run(["backup", "list", "--format", "json"])).code).toBe(EXIT_SUCCESS);
      expect((await harness.run(["backup", "restore", snapshot, "--format", "json"])).code).toBe(
        EXIT_SUCCESS,
      );
      expect((await harness.run(["backup", "prune", "--format", "json"])).code).toBe(EXIT_SUCCESS);
      expect(harness.calls).toEqual([
        "verify:latest:sample",
        "list",
        `restore:${snapshot}`,
        "prune",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("passes --full through to verification and the JSON contract", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.run(["backup", "verify", "--full", "--format", "json"]);
      expect(result.code).toBe(EXIT_SUCCESS);
      expect(JSON.parse(result.stdout.join("")).data.full).toBeTrue();
      expect(harness.calls).toEqual(["verify:latest:full"]);
    } finally {
      await harness.stop();
    }
  });

  test("rejects cloud-shaped --to destinations as usage without running backup", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.run(["backup", "run", "--to", "s3://bucket/quest"]);
      expect(result.code).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr[0]).toContain("local-only");
      expect(harness.calls).toEqual([]);
    } finally {
      await harness.stop();
    }
  });

  test("registers every schedule operation and preserves JSON envelopes", async () => {
    const harness = await createHarness();
    try {
      for (const operation of ["install", "status", "remove"]) {
        const result = await harness.run(["backup", "schedule", operation, "--format", "json"]);
        expect(result.code).toBe(EXIT_SUCCESS);
        const report = JSON.parse(result.stdout.join(""));
        expect(report.command).toBe(`backup schedule ${operation}`);
        expect(report.data.frequency).toBe("daily");
        expect(report.data.installed).toBe(operation !== "remove");
      }
      expect(harness.calls).toEqual(["schedule:install", "schedule:status", "schedule:remove"]);
    } finally {
      await harness.stop();
    }
  });

  test("rejects scheduler mutation results that contradict the requested operation", async () => {
    const failedInstall = await createHarness({ installResultInstalled: false });
    try {
      const result = await failedInstall.run(["backup", "schedule", "install", "--format", "json"]);
      expect(result.code).toBe(EXIT_DOMAIN_ERROR);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([
        "quest: domain: backup schedule install did not register the daily launchd schedule",
      ]);
    } finally {
      await failedInstall.stop();
    }

    const failedRemove = await createHarness({ removeResultInstalled: true });
    try {
      const result = await failedRemove.run(["backup", "schedule", "remove"]);
      expect(result.code).toBe(EXIT_DOMAIN_ERROR);
      expect(result.stdout).toEqual([]);
      expect(result.stderr).toEqual([
        "quest: domain: backup schedule remove left the daily launchd schedule installed",
      ]);
    } finally {
      await failedRemove.stop();
    }
  });

  test("reports a registered schedule with a missing executable as degraded", async () => {
    const harness = await createHarness({ statusExecutableExists: false });
    try {
      const result = await harness.run(["backup", "schedule", "status"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toEqual([
        `Daily launchd backup schedule is installed but its executable is missing: ${join(harness.directory, "quest")}\n`,
      ]);
    } finally {
      await harness.stop();
    }
  });
});
