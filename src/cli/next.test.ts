import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEvidenceFileReader } from "../evidence";
import { createCliOutputBoundary, EXIT_SUCCESS, EXIT_USAGE_ERROR } from "../output";
import type { Config, NewQuest, QuestReport, QuestStatus } from "../schema";
import { getNextQuest } from "../services";
import type { QuestStore } from "../store";
import { LocalBlobStore, SqliteStore } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const generatedAt = "2026-07-29T12:00:00Z";
const identity = "janior/codex-quest014";

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

interface NextCliHarness {
  readonly addQuest: (
    title: string,
    options?: {
      assignee?: string | null;
      predictedFiles?: readonly string[];
      priority?: number;
      reopenCount?: number;
      repo?: string;
      status?: QuestStatus;
    },
  ) => Promise<number>;
  readonly runHuman: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; stderr: readonly string[]; stdout: readonly string[] }>;
  readonly runJson: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; report: QuestReport | null; stderr: readonly string[] }>;
  readonly setCliStore: (store: QuestStore) => void;
  readonly stop: () => Promise<void>;
  readonly store: SqliteStore;
}

function questInput(
  title: string,
  options: {
    assignee?: string | null;
    predictedFiles?: readonly string[];
    priority?: number;
    reopenCount?: number;
    repo?: string;
    status?: QuestStatus;
  },
): NewQuest {
  const status = options.status ?? "ready";
  return {
    repo: options.repo ?? "quest",
    area: "cli",
    kind: "task",
    title,
    description: "",
    opened_by: identity,
    assignee: options.assignee ?? null,
    status,
    verdict: null,
    verdict_notes: null,
    priority: options.priority ?? 2,
    pr: null,
    guild: null,
    predicted_files: [...(options.predictedFiles ?? [])],
    reopen_count: options.reopenCount ?? 0,
    lease_expires_at: status === "accepted" ? "2026-08-01T00:00:00Z" : null,
    backfill: status !== "ready",
  };
}

async function createHarness(): Promise<NextCliHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-next-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  let cliStore: QuestStore;
  let timestampIndex = 0;
  const timestamps = [
    "2026-07-01T00:00:00Z",
    "2026-07-02T00:00:00Z",
    "2026-07-03T00:00:00Z",
    "2026-07-04T00:00:00Z",
  ];
  const store = new SqliteStore(join(directory, "quest.db"), {
    now: () => timestamps[timestampIndex++] ?? generatedAt,
  });
  cliStore = store;
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
        questStore: cliStore,
      }),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => Promise.reject(new Error("next must not prompt")),
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
      return (await store.addQuest(questInput(title, options))).id;
    },
    async runHuman(argumentsWithoutRuntime) {
      return run(argumentsWithoutRuntime.concat("--repo", "quest"));
    },
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
    setCliStore(nextStore) {
      cliStore = nextStore;
    },
    async stop() {
      store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
}

describe("next CLI behavior", () => {
  test("reaches overlap warnings through add and update predicted-files flags", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.runJson([
        "add",
        "Selected work",
        "--predicted-files",
        "src/shared.ts",
        "src/selected.ts",
      ]);
      expect(selected.code).toBe(EXIT_SUCCESS);
      expect(selected.report).toMatchObject({
        data: {
          quest: {
            id: 1,
            predicted_files: ["src/shared.ts", "src/selected.ts"],
          },
        },
      });

      expect((await harness.runJson(["add", "In-flight work"])).code).toBe(EXIT_SUCCESS);
      expect((await harness.runJson(["accept", "2"])).code).toBe(EXIT_SUCCESS);
      const updated = await harness.runJson([
        "update",
        "2",
        "--predicted-files",
        "src/shared.ts",
        "src/in-flight.ts",
      ]);
      expect(updated.code).toBe(EXIT_SUCCESS);
      expect(updated.report).toMatchObject({
        data: {
          quest: {
            assignee: identity,
            id: 2,
            predicted_files: ["src/shared.ts", "src/in-flight.ts"],
            status: "accepted",
          },
        },
      });

      const next = await harness.runJson(["next"]);
      expect(next.code).toBe(EXIT_SUCCESS);
      expect(next.report).toMatchObject({
        command: "next",
        warnings: ["quest 1 predicted_files overlap with in-flight quest 2: src/shared.ts"],
        data: {
          claimed: false,
          quest: { id: 1 },
        },
      });
    } finally {
      await harness.stop();
    }
  });

  test("skips chain-blocked work, selects strict priority then age, and envelopes warnings", async () => {
    const harness = await createHarness();
    try {
      const blocked = await harness.addQuest("Blocked priority one", {
        predictedFiles: ["src/cli/program.ts"],
        priority: 1,
      });
      const requirement = await harness.addQuest("In-flight requirement", {
        assignee: "janior/fable-1",
        status: "accepted",
      });
      const selected = await harness.addQuest("Available priority two", {
        predictedFiles: ["src/cli/program.ts"],
        priority: 2,
      });
      const overlap = await harness.addQuest("Overlapping work", {
        assignee: "janior/codex-16",
        predictedFiles: ["src/cli/program.ts"],
        status: "turned_in",
      });
      await harness.store.addChainLink({
        actor: identity,
        link: { quest_id: blocked, target_id: requirement, type: "requires" },
      });

      const result = await harness.runJson(["next"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stderr).toEqual([]);
      expect(result.report).toMatchObject({
        schema: "quest.report/v1",
        command: "next",
        generated_at: generatedAt,
        filters: { repo: "quest" },
        warnings: [
          `quest ${blocked} skipped: blocked by ${requirement} (accepted by janior/fable-1)`,
          `quest ${selected} predicted_files overlap with in-flight quest ${overlap}: src/cli/program.ts`,
        ],
        data: {
          claimed: false,
          quest: { id: selected, status: "ready" },
        },
      });
    } finally {
      await harness.stop();
    }
  });

  test("--claim accepts the selected quest in the same command", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.addQuest("Claim me", { priority: 1 });

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        command: "next",
        warnings: [],
        data: {
          claimed: true,
          quest: { assignee: identity, id: selected, status: "accepted" },
        },
      });
      expect(await harness.store.events(selected)).toHaveLength(2);
      expect((await harness.store.events(selected))[1]).toMatchObject({
        action: "accept",
        actor: identity,
      });
    } finally {
      await harness.stop();
    }
  });

  test("--brief requires --claim", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.runJson(["next", "--brief"]);

      expect(result.code).toBe(EXIT_USAGE_ERROR);
      expect(result.report).toBeNull();
      expect(result.stderr).toEqual([
        "quest: usage: --brief requires --claim; run `quest next --claim --brief` to claim work with its context package",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("--claim --brief returns the claim receipt and full context package", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.addQuest("Brief me", {
        predictedFiles: ["src/brief.ts"],
      });

      const result = await harness.runJson(["next", "--claim", "--brief"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        command: "next",
        warnings: [],
        data: {
          claimed: true,
          quest: { assignee: identity, id: selected, status: "accepted" },
          brief: {
            chain_position: {
              duplicate_of: [],
              duplicates: [],
              required_by: [],
              requires: [],
            },
            evidence: [],
            materialized: null,
            quest: { assignee: identity, id: selected, status: "accepted" },
          },
        },
      });
      if (result.report === null) {
        throw new Error("expected a JSON report");
      }
      expect(
        (result.report.data as { brief: { events: { action: string }[] } }).brief.events.map(
          ({ action }) => action,
        ),
      ).toEqual(["add", "accept"]);
    } finally {
      await harness.stop();
    }
  });

  test("--claim --brief uses the atomic claim snapshot for its receipt and package", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.addQuest("Brief race");
      let exportCount = 0;
      let atomicClaims = 0;
      const racingStore = new Proxy(harness.store, {
        get(target, property, receiver) {
          if (property !== "exportAll" && property !== "acceptQuestAndExport") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          if (property === "exportAll") {
            return async () => {
              exportCount += 1;
              return target.exportAll();
            };
          }
          return async (input: Parameters<QuestStore["acceptQuestAndExport"]>[0]) => {
            atomicClaims += 1;
            return target.acceptQuestAndExport(input);
          };
        },
      });
      harness.setCliStore(racingStore);

      const result = await harness.runJson(["next", "--claim", "--brief"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        warnings: [],
        data: {
          brief: { quest: { id: selected, title: "Brief race" } },
          claimed: true,
          quest: { id: selected, title: "Brief race" },
        },
      });
      expect(exportCount).toBe(1);
      expect(atomicClaims).toBe(1);
    } finally {
      await harness.stop();
    }
  });

  test("--claim --brief leaves the brief empty when no quest is available", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.runJson(["next", "--claim", "--brief"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        data: { brief: null, claimed: false, quest: null },
      });
    } finally {
      await harness.stop();
    }
  });

  test("human --claim --brief prints the receipt before the markdown brief", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.addQuest("Readable brief");

      const result = await harness.runHuman(["next", "--claim", "--brief"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stderr).toEqual([]);
      expect(result.stdout.join("")).toContain(`quest ${selected} accepted by ${identity}`);
      expect(result.stdout.join("")).toContain(`# quest ${selected} — Readable brief`);
      expect(result.stdout.join("")).toContain("## Working agreement");
    } finally {
      await harness.stop();
    }
  });

  test("does not report ownership when guild routing changes during --claim", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.addQuest("Guild-raced claim", { priority: 1 });
      const racingStore = new Proxy(harness.store, {
        get(target, property, receiver) {
          if (property !== "exportAll") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const dump = await target.exportAll();
            await target.transition(selected, {
              action: "update",
              actor: identity,
              session_guild: null,
              changes: { guild: "claude" },
            });
            return dump;
          };
        },
      });

      const result = await getNextQuest(racingStore, { repo: "quest" }, identity, undefined, null);

      expect(result.claimed).toBeFalse();
      expect(result.quest).toMatchObject({ guild: "claude", id: selected, status: "ready" });
      expect(result.warnings).toEqual([
        `quest ${selected} is assigned to guild claude; session guild is undeclared; use --force to override`,
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("reports an empty eligible backlog without claiming", async () => {
    const harness = await createHarness();
    try {
      await harness.addQuest("Already accepted", {
        assignee: "janior/fable-1",
        status: "accepted",
      });

      const result = await harness.runHuman(["next", "--claim"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.stderr).toEqual([]);
      expect(result.stdout).toEqual(["no available quest\n"]);
    } finally {
      await harness.stop();
    }
  });

  test("--skip-after-reopens leaves repeated failures ready for a human", async () => {
    const harness = await createHarness();
    try {
      const humanReview = await harness.addQuest("Human review", {
        priority: 1,
        reopenCount: 2,
      });
      const dispatchable = await harness.addQuest("Dispatchable", {
        priority: 2,
        reopenCount: 1,
      });

      const result = await harness.runJson(["next", "--claim", "--skip-after-reopens", "2"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        warnings: [`quest ${humanReview} skipped: reopened 2 times; human review required`],
        data: {
          claimed: true,
          quest: { id: dispatchable, status: "accepted" },
        },
      });
      expect(await harness.store.getQuest(humanReview)).toMatchObject({
        assignee: null,
        id: humanReview,
        status: "ready",
      });
    } finally {
      await harness.stop();
    }
  });
});
