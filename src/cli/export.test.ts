import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliOutputBoundary, EXIT_SUCCESS, EXIT_USAGE_ERROR, type ExitCode } from "../output";
import type { Config, NewQuest } from "../schema";
import { newQuestSchema, questDumpSchema } from "../schema";
import { parseQuestBackupExport } from "../services";
import { LocalBlobStore, SqliteStore } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const timestamp = "2026-07-29T16:30:00Z";

const config = {
  identity: "amy",
  store: { backend: "sqlite" },
  repos: {},
  areas: {},
  colors: {},
  labels: {
    areas: {},
    statuses: {},
    verdicts: {},
  },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

interface ExportHarness {
  readonly directory: string;
  readonly run: (argumentsWithoutRuntime: readonly string[]) => Promise<{
    readonly code: ExitCode;
    readonly stderr: readonly string[];
    readonly stdout: readonly string[];
  }>;
  readonly stop: () => Promise<void>;
  readonly store: SqliteStore;
}

function task(title: string, changes: Partial<NewQuest> = {}): NewQuest {
  return newQuestSchema.parse({
    repo: "alpha",
    area: "cli",
    kind: "task",
    title,
    description: `${title} description`,
    opened_by: "fixture",
    assignee: null,
    status: "open",
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
    backfill: true,
    ...changes,
  });
}

async function createHarness(configOverride: Config = config): Promise<ExportHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-export-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new SqliteStore(join(directory, "quest.db"), { now: () => timestamp });
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
    config: configOverride,
    evidenceFiles: {
      read: () => Promise.reject(new Error("export commands must not read evidence blobs")),
    },
    initialWorkingDirectory: directory,
    isTty: false,
    locateGitRoot: () => Promise.resolve(directory),
    openApplicationPorts: () =>
      Promise.resolve({
        blobStore: new LocalBlobStore(join(directory, "evidence")),
        clock: { now: () => Promise.resolve(timestamp) },
        questStore: store,
      }),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => Promise.reject(new Error("export commands must not prompt")),
    },
    validateWorkingDirectory: () => Promise.resolve(),
  } satisfies QuestCliDependencies;

  return {
    directory,
    async run(argumentsWithoutRuntime) {
      stdout.length = 0;
      stderr.length = 0;
      const code = await runQuestCli(argumentsWithoutRuntime, dependencies);
      return { code, stderr: [...stderr], stdout: [...stdout] };
    },
    store,
    async stop() {
      store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

async function seedFixture(store: SqliteStore): Promise<void> {
  const complete = await store.addQuest(
    task("Complete export row", {
      assignee: "amy",
      status: "complete",
    }),
  );
  const turnedIn = await store.addQuest(
    task("Turned-in export row", {
      area: "store",
      assignee: "sam",
      guild: null,
      pr: "17",
      status: "turned_in",
    }),
  );
  await store.addChainLink({
    actor: "fixture",
    link: { quest_id: turnedIn.id, target_id: complete.id, type: "requires" },
  });
  await store.addEvidence({
    quest_id: complete.id,
    sha256: "b".repeat(64),
    filename: "proof.log",
    kind: "log",
    stage: "verify",
    added_by: "fixture",
  });
}

describe("export CLI", () => {
  test("requires exactly one export format", async () => {
    const harness = await createHarness();
    try {
      const missing = await harness.run(["export", "--repo", "alpha"]);
      expect(missing.code).toBe(EXIT_USAGE_ERROR);
      expect(missing.stderr[0]).toContain("--json is required");

      const xlsx = await harness.run(["export", "--xlsx", "--repo", "alpha"]);
      expect(xlsx.code).toBe(EXIT_USAGE_ERROR);
      expect(xlsx.stderr[0]).toContain("unknown option '--xlsx'");
    } finally {
      await harness.stop();
    }
  });

  test("writes the raw full-store JSON backup to stdout and round-trips it", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);
      await harness.store.addQuest(task("Beta quest", { repo: "beta" }));

      const result = await harness.run(["export", "--json", "--repo", "alpha"]);
      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stderr).toEqual([]);

      const restored = parseQuestBackupExport(result.stdout.join(""));
      expect(restored).toEqual(questDumpSchema.parse(await harness.store.exportAll()));
      expect(restored.quests.map(({ repo }) => repo)).toContain("beta");
    } finally {
      await harness.stop();
    }
  });

  test("writes an implicit routing warning to stderr with raw JSON output", async () => {
    const harness = await createHarness({
      ...config,
      repos: {
        "streamlyne-marketing": {
          store: { backend: "convex", deployment: "dev:marketing" },
        },
      },
    });
    try {
      const result = await harness.run(["export", "--json"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stderr[0]).toContain('detected repository "quest-export-cli-');
      expect(result.stderr[0]).toContain("streamlyne-marketing");
      expect(parseQuestBackupExport(result.stdout.join(""))).toEqual(
        questDumpSchema.parse(await harness.store.exportAll()),
      );
    } finally {
      await harness.stop();
    }
  });

  test("writes a restore-compatible JSON file when --out is present", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);
      const result = await harness.run([
        "export",
        "--json",
        "--out",
        "backup.json",
        "--repo",
        "alpha",
      ]);
      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stdout[0]).toContain("Exported JSON");

      const restored = parseQuestBackupExport(
        await Bun.file(join(harness.directory, "backup.json")).text(),
      );
      expect(restored).toEqual(questDumpSchema.parse(await harness.store.exportAll()));
    } finally {
      await harness.stop();
    }
  });
});
