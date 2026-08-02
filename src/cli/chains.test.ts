import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEvidenceFileReader } from "../evidence";
import {
  createCliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from "../output";
import type { Config, NewQuest, QuestReport, QuestStatus } from "../schema";
import { LocalBlobStore, SqliteStore } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const generatedAt = "2026-07-29T12:00:00Z";
const identity = "janior/codex-quest013";

const config = {
  identity,
  store: { backend: "sqlite" },
  repos: {},
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

interface ChainCliHarness {
  readonly addQuest: (
    title: string,
    options?: { repo?: string; status?: QuestStatus },
  ) => Promise<number>;
  readonly runAllHuman: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; stderr: readonly string[]; stdout: readonly string[] }>;
  readonly runHuman: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; stderr: readonly string[]; stdout: readonly string[] }>;
  readonly runJson: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; report: QuestReport | null; stderr: readonly string[] }>;
  readonly stop: () => Promise<void>;
  readonly store: SqliteStore;
}

function questInput(title: string, repo: string, status: QuestStatus): NewQuest {
  return {
    repo,
    area: "cli",
    kind: "task",
    title,
    description: "",
    opened_by: identity,
    assignee: status === "complete" ? identity : null,
    status,
    verdict: null,
    verdict_notes: null,
    priority: 2,
    pr: null,
    guild: null,
    predicted_files: [],
    reopen_count: 0,
    backfill: status !== "ready",
  };
}

async function createHarness(): Promise<ChainCliHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-chain-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new SqliteStore(join(directory, "quest.db"));
  const dependencies = {
    applicationVersion: "1.2.3",
    clock: { now: () => Promise.resolve(generatedAt) },
    compatibilityProbe: {
      check: () =>
        Promise.resolve({
          outcome: "compatible",
          supported_version: 1,
          store_version: 1,
        }),
    },
    config,
    evidenceFiles: createLocalEvidenceFileReader(),
    initialWorkingDirectory: directory,
    isTty: true,
    locateGitRoot: () => Promise.resolve(directory),
    openApplicationPorts: () =>
      Promise.resolve({
        blobStore: new LocalBlobStore(join(directory, "evidence")),
        clock: { now: () => Promise.resolve(generatedAt) },
        questStore: store,
      }),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => Promise.reject(new Error("chain commands must not prompt")),
    },
    validateWorkingDirectory: () => Promise.resolve(),
  } satisfies QuestCliDependencies;

  const run = async (argumentsWithoutRuntime: readonly string[]) => {
    stdout.length = 0;
    stderr.length = 0;
    const code = await runQuestCli(argumentsWithoutRuntime, dependencies);
    return { code, stderr: [...stderr], stdout: [...stdout] };
  };

  return {
    async addQuest(title, options = {}) {
      const quest = await store.addQuest(
        questInput(title, options.repo ?? "quest", options.status ?? "ready"),
      );
      return quest.id;
    },
    runAllHuman: (argumentsWithoutRuntime) => run(argumentsWithoutRuntime.concat("--all")),
    runHuman: (argumentsWithoutRuntime) => run(argumentsWithoutRuntime.concat("--repo", "quest")),
    async runJson(argumentsWithoutRuntime) {
      const result = await run(
        argumentsWithoutRuntime.concat("--repo", "quest", "--format", "json"),
      );
      return {
        code: result.code,
        report: result.stdout.length === 0 ? null : JSON.parse(result.stdout.join("")),
        stderr: result.stderr,
      };
    },
    store,
    async stop() {
      store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

function reportData(report: QuestReport | null): Record<string, unknown> {
  expect(report).not.toBeNull();
  if (
    report === null ||
    typeof report.data !== "object" ||
    report.data === null ||
    Array.isArray(report.data)
  ) {
    throw new Error("expected report object data");
  }
  return report.data;
}

describe("chain CLI behavior", () => {
  test("adds both link types, removes requires links, and safely replays mutations", async () => {
    const harness = await createHarness();
    try {
      await harness.addQuest("Dependent");
      await harness.addQuest("Requirement");
      await harness.addQuest("Duplicate target");

      const added = await harness.runJson(["chain", "add", "1", "--requires", "2"]);
      expect(added.code).toBe(EXIT_SUCCESS);
      expect(added.report).toMatchObject({
        command: "chain add",
        filters: { repo: "quest" },
        generated_at: generatedAt,
        schema: "quest.report/v1",
        warnings: [],
      });
      expect(reportData(added.report)).toEqual({
        changed: true,
        link: { quest_id: 1, target_id: 2, type: "requires" },
        outcome: "added",
      });

      const replay = await harness.runJson(["chain", "add", "1", "--requires", "2"]);
      expect(reportData(replay.report)).toMatchObject({ changed: false, outcome: "exists" });
      expect(replay.report?.warnings).toEqual(["quest 1 already has requires link to quest 2"]);

      const duplicate = await harness.runJson(["chain", "add", "1", "--duplicate-of", "3"]);
      expect(reportData(duplicate.report)).toMatchObject({
        changed: true,
        link: { quest_id: 1, target_id: 3, type: "duplicate-of" },
      });

      const removed = await harness.runJson(["chain", "rm", "1", "--requires", "2"]);
      expect(reportData(removed.report)).toMatchObject({ changed: true, outcome: "removed" });
      const removalReplay = await harness.runJson(["chain", "rm", "1", "--requires", "2"]);
      expect(reportData(removalReplay.report)).toMatchObject({
        changed: false,
        outcome: "missing",
      });
      expect((await harness.store.exportAll()).chains).toEqual([
        { quest_id: 1, target_id: 3, type: "duplicate-of" },
      ]);
      expect((await harness.store.events(1)).map(({ action }) => action)).toEqual([
        "add",
        "chain",
        "chain",
        "chain",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("rejects cycles on write and prints the exact offending path", async () => {
    const harness = await createHarness();
    try {
      await harness.addQuest("One");
      await harness.addQuest("Two");
      await harness.addQuest("Three");
      await harness.runHuman(["chain", "add", "1", "--requires", "2"]);
      await harness.runHuman(["chain", "add", "2", "--requires", "3"]);

      const rejected = await harness.runHuman(["chain", "add", "3", "--requires", "1"]);
      expect(rejected.code).toBe(EXIT_DOMAIN_ERROR);
      expect(rejected.stdout).toEqual([]);
      expect(rejected.stderr).toEqual(["quest: domain: requires cycle rejected: 3 -> 1 -> 2 -> 3"]);
      expect((await harness.store.exportAll()).chains).toEqual([
        { quest_id: 1, target_id: 2, type: "requires" },
        { quest_id: 2, target_id: 3, type: "requires" },
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("renders scoped chain trees and derives blockedness from current requirements", async () => {
    const harness = await createHarness();
    try {
      await harness.addQuest("Root");
      await harness.addQuest("Complete requirement", { status: "complete" });
      await harness.addQuest("Open requirement");
      await harness.addQuest("Duplicate target");
      await harness.addQuest("Outside", { repo: "outside" });
      await harness.runHuman(["chain", "add", "1", "--requires", "2"]);
      await harness.runHuman(["chain", "add", "1", "--requires", "3"]);
      await harness.runHuman(["chain", "add", "1", "--duplicate-of", "4"]);
      await harness.runAllHuman(["chain", "add", "5", "--requires", "2"]);

      const shown = await harness.runJson(["chain", "show", "1"]);
      expect(reportData(shown.report)).toMatchObject({
        trees: [
          {
            root_id: 1,
            lines: [
              { blocked: true, depth: 0, link_type: null, quest: { id: 1 } },
              {
                blocked: false,
                depth: 1,
                link_type: "requires",
                quest: { id: 2, status: "complete" },
              },
              {
                blocked: false,
                depth: 1,
                link_type: "requires",
                quest: { id: 3, status: "ready" },
              },
              {
                blocked: false,
                depth: 1,
                link_type: "duplicate-of",
                quest: { id: 4 },
              },
            ],
          },
        ],
      });

      const human = await harness.runHuman(["chain", "show", "1"]);
      expect(human.stdout.join("")).toBe(
        [
          "1 Root [ready, blocked]",
          "- requires: 2 Complete requirement [complete]",
          "- requires: 3 Open requirement [ready]",
          "- duplicate-of: 4 Duplicate target [ready]",
          "",
        ].join("\n"),
      );
      const scoped = await harness.runHuman(["chain", "show"]);
      expect(scoped.stdout.join("")).not.toContain("5 Outside");
    } finally {
      await harness.stop();
    }
  });

  test("validates link flags and selected-scope membership", async () => {
    const harness = await createHarness();
    try {
      await harness.addQuest("Scoped");
      await harness.addQuest("Outside", { repo: "outside" });

      const missingFlag = await harness.runHuman(["chain", "add", "1"]);
      expect(missingFlag.code).toBe(EXIT_USAGE_ERROR);
      expect(missingFlag.stderr).toEqual([
        "quest: usage: chain add requires --requires or --duplicate-of",
      ]);

      const conflictingFlags = await harness.runHuman([
        "chain",
        "add",
        "1",
        "--requires",
        "2",
        "--duplicate-of",
        "2",
      ]);
      expect(conflictingFlags.code).toBe(EXIT_USAGE_ERROR);
      expect(conflictingFlags.stderr[0]).toContain("cannot be used with option");

      const outsideTarget = await harness.runHuman(["chain", "add", "1", "--requires", "2"]);
      expect(outsideTarget.code).toBe(EXIT_DOMAIN_ERROR);
      expect(outsideTarget.stderr).toEqual([
        "quest: domain: quest 2 not found in the selected scope",
      ]);
    } finally {
      await harness.stop();
    }
  });
});
