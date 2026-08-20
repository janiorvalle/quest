import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliOutputBoundary, EXIT_DOMAIN_ERROR, EXIT_SUCCESS } from "../output";
import type { Config, QuestReport } from "../schema";
import { doctorDataSchema, questReportSchema } from "../schema";
import type { BackupOperations } from "../services";
import { SQLITE_SCHEMA_VERSION } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const generatedAt = "2026-07-31T18:00:00.000Z";

const config = {
  store: { backend: "sqlite" },
  repos: {},
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: { retention: { daily: 7, monthly: 6, weekly: 4 } },
} satisfies Config;

function healthyBackup(): BackupOperations {
  return {
    list: () =>
      Promise.resolve([
        {
          age_seconds: 60,
          counts: { chains: 0, evidence: 0, events: 0, quests: 0 },
          created_at: generatedAt,
          size_bytes: 1,
          snapshot: "2026-07-31T175900.000Z",
        },
      ]),
    prune: () => Promise.resolve({ deleted: [], retained: [] }),
    restore: () =>
      Promise.resolve({
        evidence_restored: 0,
        pre_restore_config: null,
        pre_restore_database: null,
        snapshot: "2026-07-31T175900.000Z",
        verified: true as const,
      }),
    run: () =>
      Promise.resolve({
        counts: { chains: 0, evidence: 0, events: 0, quests: 0 },
        evidence: { copied: 0, count: 0, total_bytes: 0 },
        path: "/backups/quest/snapshots/latest",
        pruned: [],
        snapshot: "2026-07-31T175900.000Z",
      }),
    verify: () =>
      Promise.resolve({
        counts: { chains: 0, evidence: 0, events: 0, quests: 0 },
        full: false,
        integrity_check: "ok" as const,
        sampled_evidence: [],
        snapshot: "2026-07-31T175900.000Z",
        verified: true as const,
      }),
  };
}

async function createHarness(
  options: { readonly compatibilityProbe?: QuestCliDependencies["compatibilityProbe"] } = {},
): Promise<{
  readonly dependencies: QuestCliDependencies;
  readonly root: string;
  readonly stderr: string[];
  readonly stdout: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "quest-cli-doctor-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: QuestCliDependencies = {
    applicationVersion: "1.2.3",
    clock: { now: () => Promise.resolve(generatedAt) },
    compatibilityProbe: options.compatibilityProbe ?? {
      check: () =>
        Promise.resolve({
          outcome: "compatible" as const,
          store_version: SQLITE_SCHEMA_VERSION,
          supported_version: SQLITE_SCHEMA_VERSION,
        }),
    },
    config,
    doctor: {
      backup: healthyBackup(),
      inspectProcesses: () => Promise.resolve({ available: true, holders: [] }),
      inspectStore: () => Promise.resolve({ state: "missing" as const }),
      paths: {
        backup: join(root, "backups"),
        database: join(root, "quest.db"),
        evidence: join(root, "evidence"),
        ownership_database: join(root, "quest.db.ownership.sqlite"),
        temporary_directory: root,
      },
    },
    evidenceFiles: { read: () => Promise.reject(new Error("doctor must not read evidence files")) },
    initialWorkingDirectory: root,
    isTty: false,
    locateGitRoot: () => Promise.reject(new Error("doctor must not resolve a git scope")),
    openApplicationPorts: () => Promise.reject(new Error("doctor must not open application ports")),
    output: createCliOutputBoundary({
      stderr: (line) => stderr.push(line),
      stdout: (text) => stdout.push(text),
    }),
    prompter: { ask: () => Promise.reject(new Error("doctor must not prompt")) },
    validateWorkingDirectory: () => Promise.resolve(),
  };
  return { dependencies, root, stderr, stdout };
}

describe("doctor CLI", () => {
  test("emits the JSON envelope without opening a store or resolving git scope", async () => {
    const harness = await createHarness();
    try {
      expect(await runQuestCli(["--format", "json", "doctor"], harness.dependencies)).toBe(
        EXIT_SUCCESS,
      );
      const report: QuestReport = questReportSchema.parse(JSON.parse(harness.stdout.join("")));
      expect(report).toMatchObject({
        command: "doctor",
        data: { healthy: true },
        filters: {},
        warnings: [],
      });
      expect(harness.stderr).toEqual([]);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  test("renders the healthy report as one screen of actionable lines", async () => {
    const harness = await createHarness();
    try {
      expect(await runQuestCli(["doctor"], harness.dependencies)).toBe(EXIT_SUCCESS);
      const output = harness.stdout.join("");
      expect(output).toContain("quest doctor: HEALTHY");
      expect(output).toContain("[ok] schema:");
      expect(output).toContain("[ok] evidence:");
      expect(output.split("\n").filter(Boolean)).toHaveLength(7);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  test("keeps independent checks in the report when compatibility probing fails", async () => {
    const harness = await createHarness({
      compatibilityProbe: {
        check: () => Promise.reject(new Error("database is unreadable")),
      },
    });
    try {
      expect(await runQuestCli(["--format", "json", "doctor"], harness.dependencies)).toBe(
        EXIT_DOMAIN_ERROR,
      );
      const report: QuestReport = questReportSchema.parse(JSON.parse(harness.stdout.join("")));
      const data = doctorDataSchema.parse(report.data);
      expect(data.healthy).toBeFalse();
      expect(data.checks).toHaveLength(6);
      expect(data.checks[0]).toMatchObject({
        check: "schema",
        status: "fail",
        summary: "store schema could not be checked: database is unreadable",
      });
      expect(data.checks.slice(1).every((check) => check.check !== "schema")).toBeTrue();
      expect(harness.stderr).toEqual([]);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });

  test("shows the routed repository and backend when the checkout folder is mismatched", async () => {
    const harness = await createHarness();
    const configWithRoute = {
      ...config,
      repos: {
        "streamlyne-marketing": {
          store: { backend: "convex", deployment: "dev:marketing" },
        },
      },
    } satisfies Config;
    const dependencies = {
      ...harness.dependencies,
      config: configWithRoute,
      locateGitRoot: () => Promise.resolve("/work/marketing"),
      openBackend: async (scope: { readonly repo: string | null }) => {
        expect(scope).toEqual({ repo: "marketing" });
        return {
          clock: harness.dependencies.clock,
          compatibilityProbe: harness.dependencies.compatibilityProbe,
          doctor: harness.dependencies.doctor,
          openApplicationPorts: () =>
            Promise.reject(new Error("doctor test must not open application ports")),
        };
      },
    } satisfies QuestCliDependencies;
    try {
      expect(await runQuestCli(["doctor"], dependencies)).toBe(EXIT_SUCCESS);
      expect(harness.stdout.join("")).toContain("scope: repo=marketing; store=sqlite");
      expect(harness.stderr).toEqual([
        'warning: detected repository "marketing" is not configured, so Quest fell back to the default sqlite store; configured repository "streamlyne-marketing" uses a non-default convex store. Add [repos] marketing = "streamlyne-marketing" or rerun with --repo streamlyne-marketing',
      ]);
    } finally {
      await rm(harness.root, { force: true, recursive: true });
    }
  });
});
