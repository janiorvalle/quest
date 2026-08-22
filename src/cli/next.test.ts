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
import type { Config, NewQuest, QuestKind, QuestReport, QuestStatus } from "../schema";
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
      kind?: QuestKind;
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
  readonly promptQuestions: string[];
  readonly setCliStore: (store: QuestStore) => void;
  readonly stop: () => Promise<void>;
  readonly store: SqliteStore;
}

function questInput(
  title: string,
  options: {
    assignee?: string | null;
    predictedFiles?: readonly string[];
    kind?: QuestKind;
    priority?: number;
    reopenCount?: number;
    repo?: string;
    status?: QuestStatus;
  },
): NewQuest {
  const status = options.status ?? "open";
  return {
    repo: options.repo ?? "quest",
    area: "cli",
    kind: options.kind ?? "task",
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
    backfill: status !== "open",
  };
}

async function createHarness(
  options: { readonly isTty?: boolean; readonly promptAnswer?: string } = {},
): Promise<NextCliHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-next-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const promptQuestions: string[] = [];
  let cliStore: QuestStore;
  let timestampIndex = 0;
  const timestamps = [
    "2026-07-29T12:00:00Z",
    "2026-07-29T12:01:00Z",
    "2026-07-29T12:02:00Z",
    "2026-07-29T12:03:00Z",
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
    isTty: options.isTty ?? true,
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
      ask: async (question) => {
        if (options.promptAnswer === undefined) {
          throw new Error("next must not prompt");
        }
        promptQuestions.push(question);
        return options.promptAnswer;
      },
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
    promptQuestions,
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
  test("claims an open bug selected by next", async () => {
    const harness = await createHarness();
    try {
      const openBug = await harness.addQuest("Open bug", {
        kind: "bug",
        priority: 1,
        status: "open",
      });
      await harness.addQuest("Ready task", { priority: 2 });

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        data: {
          claimed: true,
          quest: { id: openBug, status: "accepted" },
        },
      });
      expect(await harness.store.getQuest(openBug)).toMatchObject({
        assignee: identity,
        id: openBug,
        status: "accepted",
      });
    } finally {
      await harness.stop();
    }
  });

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

  test("skips a hard lane conflict when a conflict-free quest is available", async () => {
    const harness = await createHarness();
    try {
      const inFlight = await harness.addQuest("In-flight work", {
        assignee: "janior/fable-1",
        predictedFiles: ["src/shared.ts"],
        status: "accepted",
      });
      const conflicted = await harness.addQuest("Conflicted priority one", {
        predictedFiles: ["src/shared.ts"],
        priority: 1,
      });
      const available = await harness.addQuest("Available priority two", { priority: 2 });

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        warnings: [],
        data: {
          claimed: true,
          quest: { id: available, status: "accepted" },
        },
      });
      expect(await harness.store.getQuest(conflicted)).toMatchObject({
        assignee: null,
        id: conflicted,
        status: "open",
      });
      expect(await harness.store.getQuest(inFlight)).toMatchObject({
        id: inFlight,
        status: "accepted",
      });
    } finally {
      await harness.stop();
    }
  });

  test("prompts a TTY before claiming a hard lane conflict and records the acknowledgement", async () => {
    const harness = await createHarness({ promptAnswer: "y" });
    try {
      const inFlight = await harness.addQuest("In-flight work", {
        assignee: "janior/fable-1",
        predictedFiles: ["src/shared.ts"],
        status: "accepted",
      });
      const conflicted = await harness.addQuest("Conflicted work", {
        predictedFiles: ["src/shared.ts"],
      });

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(harness.promptQuestions).toEqual([
        `Lane conflict: quest ${conflicted} overlaps in-flight quest ${inFlight}: src/shared.ts. Claim anyway? [y/N] `,
      ]);
      expect((await harness.store.events(conflicted)).at(-1)?.detail).toMatchObject({
        lane_conflict_acknowledged: true,
      });
    } finally {
      await harness.stop();
    }
  });

  test("refuses a headless hard lane conflict with receiver-ready remedies and makes no claim", async () => {
    const harness = await createHarness({ isTty: false });
    try {
      const inFlight = await harness.addQuest("In-flight work", {
        assignee: "janior/fable-1",
        predictedFiles: ["src/shared.ts"],
        status: "accepted",
      });
      const conflicted = await harness.addQuest("Conflicted work", {
        predictedFiles: ["src/shared.ts"],
      });

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_DOMAIN_ERROR);
      expect(result.report).toBeNull();
      expect(result.stderr).toHaveLength(1);
      expect(result.stderr[0]).toContain(
        `quest ${conflicted} predicted_files overlap with in-flight quest ${inFlight}: src/shared.ts`,
      );
      expect(result.stderr[0]).toContain("NEXT_LANE_CONFLICT");
      expect(result.stderr[0]).toContain("no claim was made");
      expect(result.stderr[0]).toContain("pick another quest");
      expect(result.stderr[0]).toContain("re-run with --allow-conflict");
      expect((await harness.store.events(conflicted)).map((event) => event.action)).toEqual([
        "add",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("refuses a hard lane conflict that appears during the claim transaction", async () => {
    const harness = await createHarness({ isTty: false });
    try {
      const candidate = await harness.addQuest("Raced candidate", {
        predictedFiles: ["src/shared.ts"],
      });
      let injected = false;
      const racingStore = new Proxy(harness.store, {
        get(target, property, receiver) {
          if (property !== "acceptQuest") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (input: Parameters<QuestStore["acceptQuest"]>[0]) => {
            if (!injected) {
              injected = true;
              const inFlight = await target.addQuest({
                ...questInput("Raced in-flight work", {
                  assignee: "janior/racer",
                  predictedFiles: ["src/shared.ts"],
                  status: "accepted",
                }),
                lease_expires_at: "2099-01-01T00:00:00Z",
              });
              expect(inFlight.status).toBe("accepted");
            }
            return target.acceptQuest(input);
          };
        },
      });
      harness.setCliStore(racingStore);

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_DOMAIN_ERROR);
      expect(result.report).toBeNull();
      expect(result.stderr[0]).toContain(
        `quest ${candidate} predicted_files overlap with in-flight quest 2: src/shared.ts`,
      );
      expect(result.stderr[0]).toContain("NEXT_LANE_CONFLICT");
      expect((await harness.store.events(candidate)).map(({ action }) => action)).toEqual(["add"]);
    } finally {
      await harness.stop();
    }
  });

  test("reports a hard conflict discovered during an approved claim retry", async () => {
    const harness = await createHarness({ isTty: false });
    try {
      const candidate = await harness.addQuest("Raced candidate", {
        predictedFiles: ["src/shared.ts"],
      });
      let injected = false;
      const racingStore = new Proxy(harness.store, {
        get(target, property, receiver) {
          if (property !== "acceptQuest") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (input: Parameters<QuestStore["acceptQuest"]>[0]) => {
            if (!injected) {
              injected = true;
              const inFlight = await target.addQuest({
                ...questInput("Raced in-flight work", {
                  assignee: "janior/racer",
                  predictedFiles: ["src/shared.ts"],
                  status: "accepted",
                }),
                lease_expires_at: "2099-01-01T00:00:00Z",
              });
              expect(inFlight.status).toBe("accepted");
            }
            return target.acceptQuest(input);
          };
        },
      });
      harness.setCliStore(racingStore);

      const result = await harness.runJson(["next", "--claim", "--allow-conflict"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        warnings: [
          `quest ${candidate} predicted_files overlap with in-flight quest 2: src/shared.ts`,
        ],
        data: { claimed: true, quest: { id: candidate, status: "accepted" } },
      });
    } finally {
      await harness.stop();
    }
  });

  test("--allow-conflict claims hard-conflicted work without prompting and records the override", async () => {
    const harness = await createHarness({ isTty: false });
    try {
      const conflicted = await harness.addQuest("Conflicted work", {
        predictedFiles: ["src/shared.ts"],
      });
      await harness.addQuest("In-flight work", {
        assignee: "janior/fable-1",
        predictedFiles: ["src/shared.ts"],
        status: "accepted",
      });

      const result = await harness.runJson(["next", "--claim", "--allow-conflict"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(harness.promptQuestions).toEqual([]);
      expect((await harness.store.events(conflicted)).at(-1)?.detail).toMatchObject({
        lane_conflict_acknowledged: true,
      });
    } finally {
      await harness.stop();
    }
  });

  test("warns but claims a soft same-area conflict in a headless session", async () => {
    const harness = await createHarness({ isTty: false });
    try {
      await harness.addQuest("In-flight work", {
        assignee: "janior/fable-1",
        status: "accepted",
      });
      const available = await harness.addQuest("Same-area work");

      const result = await harness.runJson(["next", "--claim"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        warnings: [`quest ${available} shares area cli with in-flight quest 1 (heuristic)`],
        data: { claimed: true, quest: { id: available, status: "accepted" } },
      });
      expect((await harness.store.events(available)).at(-1)?.detail).not.toHaveProperty(
        "lane_conflict_acknowledged",
      );
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
        ],
        data: {
          claimed: false,
          quest: { id: selected, status: "open" },
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

  test("--claim --brief uses the atomic scoped detail from its claim", async () => {
    const harness = await createHarness();
    try {
      const selected = await harness.addQuest("Brief race");
      let atomicClaims = 0;
      let backlogReads = 0;
      const racingStore = new Proxy(harness.store, {
        get(target, property, receiver) {
          if (
            property !== "readFederatedSnapshot" &&
            property !== "acceptQuestAndDetail" &&
            property !== "readQuestDetail"
          ) {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          if (property === "readFederatedSnapshot") {
            return async () => {
              backlogReads += 1;
              return target.readFederatedSnapshot();
            };
          }
          if (property === "acceptQuestAndDetail") {
            return async (input: Parameters<QuestStore["acceptQuestAndDetail"]>[0]) => {
              atomicClaims += 1;
              const accepted = await target.acceptQuestAndDetail(input);
              await target.transition(selected, {
                action: "update",
                actor: identity,
                changes: { title: "Changed after claim" },
                session_guild: null,
              });
              return accepted;
            };
          }
          return async () => {
            throw new Error("claim briefing must not perform a follow-up detail read");
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
      expect(await harness.store.getQuest(selected)).toMatchObject({
        title: "Changed after claim",
      });
      expect(atomicClaims).toBe(1);
      expect(backlogReads).toBe(1);
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
          if (property !== "readFederatedSnapshot") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            const snapshot = await target.readFederatedSnapshot();
            await target.transition(selected, {
              action: "update",
              actor: identity,
              session_guild: null,
              changes: { guild: "claude" },
            });
            return snapshot;
          };
        },
      });

      const result = await getNextQuest(racingStore, { repo: "quest" }, identity, undefined, null);

      expect(result.claimed).toBeFalse();
      expect(result.quest).toMatchObject({ guild: "claude", id: selected, status: "open" });
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
        status: "open",
      });
    } finally {
      await harness.stop();
    }
  });

  test("--lease overrides the default for a claimed suggestion", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Short dispatcher lease"]);

      const result = await harness.runJson(["next", "--claim", "--lease", "5"]);

      expect(result.code).toBe(EXIT_SUCCESS);
      expect(result.report).toMatchObject({
        data: {
          claimed: true,
          quest: {
            assignee: identity,
            lease_expires_at: "2026-07-29T12:05:00.000Z",
          },
        },
      });
    } finally {
      await harness.stop();
    }
  });
});
