import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalEvidenceFileReader } from "../evidence";
import {
  createCliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from "../output";
import type { Config, QuestReport } from "../schema";
import { acceptLifecycleQuest, type PullRequestMergeChecker } from "../services";
import { LocalBlobStore, SqliteStore } from "../store";
import type { GitIdentity } from "./identity";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const generatedAt = "2026-07-29T12:00:00Z";

const config = {
  identity: "janior",
  store: { backend: "sqlite" },
  repos: {},
  areas: { quest: ["cli", "store"] },
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

interface CliHarness {
  readonly directory: string;
  readonly runJson: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; report: QuestReport | null; stderr: readonly string[] }>;
  readonly runHuman: (
    argumentsWithoutRuntime: readonly string[],
  ) => Promise<{ code: number; stderr: readonly string[]; stdout: readonly string[] }>;
  readonly store: SqliteStore;
  readonly stop: () => Promise<void>;
}

async function createHarness(
  promptAnswers: readonly string[] = [],
  configOverride: Config = config,
  identityLocator?: (workingDirectory: string) => Promise<GitIdentity>,
  stdinText?: string | (() => Promise<string>),
  checkPullRequestMerge: PullRequestMergeChecker = () => Promise.resolve(undefined),
  environment: Readonly<Record<string, string | undefined>> = {},
): Promise<CliHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-lifecycle-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const answers = [...promptAnswers];
  const configuredLeaseTtl = configOverride.store.lease_ttl_minutes;
  const store = new SqliteStore(join(directory, "quest.db"), {
    now: () => generatedAt,
    ...(configuredLeaseTtl === undefined ? {} : { leaseTtlMinutes: configuredLeaseTtl }),
  });
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
    config: configOverride,
    environment,
    evidenceFiles: createLocalEvidenceFileReader(),
    initialWorkingDirectory: directory,
    isTty: true,
    ...(identityLocator === undefined ? {} : { locateGitIdentity: identityLocator }),
    locateGitRoot: () => Promise.resolve(directory),
    openApplicationPorts: () =>
      Promise.resolve({
        blobStore: new LocalBlobStore(join(directory, "evidence")),
        checkPullRequestMerge,
        clock: { now: () => Promise.resolve(generatedAt) },
        questStore: store,
      }),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => {
        const answer = answers.shift();
        return answer === undefined
          ? Promise.reject(new Error("unexpected interactive prompt"))
          : Promise.resolve(answer);
      },
    },
    ...(stdinText === undefined
      ? {}
      : {
          readStdin: typeof stdinText === "function" ? stdinText : () => Promise.resolve(stdinText),
        }),
    validateWorkingDirectory: () => Promise.resolve(),
  } satisfies QuestCliDependencies;

  const resetOutput = (): void => {
    stdout.length = 0;
    stderr.length = 0;
  };
  return {
    directory,
    async runJson(argumentsWithoutRuntime) {
      resetOutput();
      const code = await runQuestCli(
        argumentsWithoutRuntime.concat("--repo", "quest", "--format", "json"),
        dependencies,
      );
      return {
        code,
        report: stdout.length === 0 ? null : JSON.parse(stdout.join("")),
        stderr: [...stderr],
      };
    },
    async runHuman(argumentsWithoutRuntime) {
      resetOutput();
      const code = await runQuestCli(
        argumentsWithoutRuntime.concat("--repo", "quest"),
        dependencies,
      );
      return { code, stderr: [...stderr], stdout: [...stdout] };
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

describe("lifecycle CLI behavior", () => {
  test("accepts JSON stdin for add and update without changing mutation semantics", async () => {
    const description = 'line one\nquoted "line two"\nline three';
    let stdinText = JSON.stringify({
      title: "JSON quest",
      kind: "task",
      area: "cli",
      description,
    });
    const harness = await createHarness([], config, undefined, () => Promise.resolve(stdinText));
    try {
      const added = await harness.runJson(["add", "--json", "-"]);
      expect(added.code).toBe(EXIT_SUCCESS);
      expect(reportData(added.report)).toMatchObject({
        outcome: "created",
        quest: { title: "JSON quest", description },
      });

      stdinText = JSON.stringify({
        title: "JSON quest",
        kind: "task",
        area: "cli",
        description,
      });
      const duplicate = await harness.runJson(["add", "--json", "-"]);
      expect(duplicate.code).toBe(EXIT_SUCCESS);
      expect(reportData(duplicate.report)).toMatchObject({ outcome: "replayed", quest: { id: 1 } });

      stdinText = JSON.stringify({ title: "Invalid JSON area", area: "   " });
      const invalidArea = await harness.runJson(["add", "--json", "-"]);
      expect(invalidArea.code).toBe(EXIT_USAGE_ERROR);
      expect(invalidArea.stderr[0]).toContain("invalid JSON input");

      stdinText = JSON.stringify({ description });
      const updated = await harness.runJson(["update", "1", "--json", "-"]);
      expect(updated.code).toBe(EXIT_SUCCESS);
      expect(reportData(updated.report)).toMatchObject({
        changed: true,
        quest: { description },
      });
    } finally {
      await harness.stop();
    }
  });

  test("records turnin summaries and renders them in the brief attempts section", async () => {
    const harness = await createHarness();
    const summary = "Implemented the fix\nVerified it with the fast test suite";
    try {
      await harness.runJson(["add", "Turnin summary"]);
      await harness.runJson(["accept", "1"]);

      const turnedIn = await harness.runJson(["turnin", "1", "--pr", "42", "--summary", summary]);
      expect(reportData(turnedIn.report)).toMatchObject({
        changed: true,
        quest: { pr: "42", status: "turned_in" },
      });
      expect((await harness.store.events(1)).at(-1)?.detail).toMatchObject({
        action: "turnin",
        pr: "42",
        summary,
      });
      expect((await harness.store.events(1)).at(-1)?.detail).not.toHaveProperty("session_model");
      expect((await harness.store.events(1)).at(-1)?.detail).not.toHaveProperty("session_effort");

      const brief = await harness.runHuman(["brief", "1"]);
      expect(brief.stdout.join("")).toContain("## Attempts · 1");
      expect(brief.stdout.join("")).toContain(
        "— Implemented the fix\n  Verified it with the fast test suite",
      );

      const replay = await harness.runJson(["turnin", "1", "--pr", "42", "--summary", summary]);
      expect(reportData(replay.report)).toMatchObject({ changed: false });
    } finally {
      await harness.stop();
    }
  });

  test("records session model and effort on lifecycle events and turnin attempts", async () => {
    const harness = await createHarness([], config, undefined, undefined, undefined, {
      QUEST_EFFORT: "high",
      QUEST_MODEL: "opus-5",
    });
    try {
      await harness.runJson(["add", "Session attribution"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["touch", "1"]);
      await harness.runJson(["turnin", "1", "--summary", "Verified the fix"]);
      await harness.runJson(["complete", "1"]);

      const events = await harness.store.events(1);
      for (const action of ["accept", "touch", "turnin", "complete"] as const) {
        expect(events.find((event) => event.action === action)?.detail).toMatchObject({
          session_effort: "high",
          session_guild: null,
          session_model: "opus-5",
        });
      }

      const brief = await harness.runHuman(["brief", "1"]);
      expect(brief.stdout.join("")).toContain("opus-5/high");
    } finally {
      await harness.stop();
    }
  });

  test("accepts turnin summaries through JSON stdin", async () => {
    const summary = "Implemented the fix; verified the handoff path";
    const harness = await createHarness([], config, undefined, () =>
      Promise.resolve(JSON.stringify({ pr: "43", summary })),
    );
    try {
      await harness.runJson(["add", "JSON turnin summary"]);
      await harness.runJson(["accept", "1"]);

      const turnedIn = await harness.runJson(["turnin", "1", "--json", "-"]);
      expect(reportData(turnedIn.report)).toMatchObject({
        changed: true,
        quest: { pr: "43", status: "turned_in" },
      });
      expect((await harness.store.events(1)).at(-1)?.detail).toMatchObject({ summary });
    } finally {
      await harness.stop();
    }
  });

  test("derives a Git identity for mutations and announces it once", async () => {
    const derivedConfig: Config = {
      store: { backend: "sqlite" },
      repos: {},
      areas: { quest: ["cli", "store"] },
      colors: {},
      labels: { areas: {}, statuses: {}, verdicts: {} },
      backup: {
        retention: { daily: 7, weekly: 4, monthly: 6 },
      },
    };
    let locatorCalls = 0;
    const harness = await createHarness([], derivedConfig, () => {
      locatorCalls += 1;
      return Promise.resolve({ email: "derived.person@example.com" });
    });
    try {
      const added = await harness.runJson(["add", "Derived identity"]);
      expect(added.report?.warnings).toEqual([
        "identity derived from git: derived.person — set [identity] in config to pin",
      ]);
      expect(reportData(added.report)).toMatchObject({
        quest: { opened_by: "derived.person" },
      });
      expect(locatorCalls).toBe(1);

      const updated = await harness.runHuman(["update", "1", "--title", "Updated title"]);
      expect(updated.stdout.filter((line) => line.startsWith("warning:"))).toEqual([
        "warning: identity derived from git: derived.person — set [identity] in config to pin\n",
      ]);

      await harness.runJson(["add", "Override identity"]);
      const overridden = await harness.runJson(["accept", "2", "--as", "override.person"]);
      expect(overridden.report?.warnings).toEqual([]);
      expect(reportData(overridden.report)).toMatchObject({
        quest: { assignee: "override.person", status: "accepted" },
      });
      const touched = await harness.runJson(["touch", "2", "--as", "override.person"]);
      expect(touched.code).toBe(EXIT_SUCCESS);
      expect(reportData(touched.report)).toMatchObject({
        changed: true,
        quest: { assignee: "override.person", status: "accepted" },
      });
      expect(locatorCalls).toBe(4);
    } finally {
      await harness.stop();
    }
  });

  test("renews an accepted quest with the touch verb", async () => {
    const harness = await createHarness();
    try {
      const added = await harness.runJson(["add", "Touch lease", "--kind", "task"]);
      expect(added.code).toBe(EXIT_SUCCESS);
      expect((await harness.runJson(["accept", "1"])).code).toBe(EXIT_SUCCESS);

      const touched = await harness.runJson(["touch", "1"]);
      expect(touched.code).toBe(EXIT_SUCCESS);
      expect(touched.report).toMatchObject({
        command: "touch",
        data: { changed: true, quest: { assignee: "janior", status: "accepted" } },
      });
      expect((await harness.store.events(1)).map(({ action }) => action)).toEqual([
        "add",
        "accept",
        "touch",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("allows touch to override the lease duration", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "One-off touch lease"]);
      expect((await harness.runJson(["accept", "1"])).code).toBe(EXIT_SUCCESS);

      const touched = await harness.runJson(["touch", "1", "--lease", "5"]);
      expect(touched.code).toBe(EXIT_SUCCESS);
      expect(reportData(touched.report)).toMatchObject({
        quest: { lease_expires_at: "2026-07-29T12:05:00.000Z" },
      });
    } finally {
      await harness.stop();
    }
  });

  test("gives accept flags precedence over the configured lease duration", async () => {
    const harness = await createHarness([], {
      ...config,
      store: { backend: "sqlite", lease_ttl_minutes: 60 },
    });
    try {
      await harness.runJson(["add", "Configured lease"]);
      const configured = await harness.runJson(["accept", "1"]);
      expect(reportData(configured.report)).toMatchObject({
        lease_expires_at: "2026-07-29T13:00:00.000Z",
      });

      await harness.runJson(["abandon", "1"]);
      await harness.runJson(["add", "One-off lease"]);
      const overridden = await harness.runJson(["accept", "2", "--lease", "5"]);
      expect(reportData(overridden.report)).toMatchObject({
        lease_expires_at: "2026-07-29T12:05:00.000Z",
      });
    } finally {
      await harness.stop();
    }
  });

  test("drives a task through every claim and verification state with idempotent evidence", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.directory, "report.txt"), "reported");
    await writeFile(join(harness.directory, "report-two.md"), "also reported");
    await writeFile(join(harness.directory, "investigation.pdf"), "investigated");
    await writeFile(join(harness.directory, "evidence-only.log"), "evidence only");
    await writeFile(join(harness.directory, "fix.log"), "fixed");
    await writeFile(join(harness.directory, "verify.png"), "verified");
    try {
      const added = await harness.runJson([
        "add",
        "Implement lifecycle",
        "--kind",
        "task",
        "--area",
        "cli",
        "--evidence",
        "report.txt",
        "report-two.md",
      ]);
      expect(added.code).toBe(EXIT_SUCCESS);
      expect(added.report).toMatchObject({
        schema: "quest.report/v1",
        command: "add",
        generated_at: generatedAt,
        filters: { repo: "quest" },
        warnings: [],
      });
      expect(reportData(added.report)).toMatchObject({
        outcome: "created",
        evidence: [
          { filename: "report.txt", kind: "doc", stage: "report" },
          { filename: "report-two.md", kind: "doc", stage: "report" },
        ],
        quest: { id: 1, status: "ready" },
      });
      const evidenceOnly = await harness.runJson([
        "update",
        "1",
        "--add-evidence",
        "evidence-only.log",
      ]);
      expect(reportData(evidenceOnly.report)).toMatchObject({
        changed: true,
        evidence: [{ filename: "evidence-only.log", stage: "investigation" }],
      });
      const evidenceOnlyReplay = await harness.runJson([
        "update",
        "1",
        "--add-evidence",
        "evidence-only.log",
      ]);
      expect(reportData(evidenceOnlyReplay.report)).toMatchObject({ changed: false });

      const accepted = await harness.runJson(["accept", "1", "--as", "janior"]);
      expect(accepted.code).toBe(EXIT_SUCCESS);
      expect(reportData(accepted.report)).toMatchObject({
        changed: true,
        lease_expires_at: expect.any(String),
        quest: { assignee: "janior", status: "accepted" },
      });
      const acceptedReplay = await harness.runJson(["accept", "1", "--as", "janior"]);
      expect(reportData(acceptedReplay.report)).toMatchObject({ changed: false });
      expect(acceptedReplay.report?.warnings).toHaveLength(1);

      expect((await harness.runJson(["abandon", "1"])).code).toBe(EXIT_SUCCESS);
      expect(reportData((await harness.runJson(["abandon", "1"])).report)).toMatchObject({
        changed: false,
      });
      expect((await harness.runJson(["accept", "1"])).code).toBe(EXIT_SUCCESS);
      const updated = await harness.runJson([
        "update",
        "1",
        "--title",
        "Implement all lifecycle verbs",
        "--priority",
        "1",
        "--description",
        "updated lifecycle description",
        "--notes",
        "ready for review",
        "--add-evidence",
        "investigation.pdf",
      ]);
      expect(reportData(updated.report)).toMatchObject({
        changed: true,
        evidence: [{ filename: "investigation.pdf", stage: "investigation" }],
        quest: {
          description: "updated lifecycle description",
          priority: 1,
          title: "Implement all lifecycle verbs",
        },
      });
      const updateReplay = await harness.runJson([
        "update",
        "1",
        "--title",
        "Implement all lifecycle verbs",
        "--priority",
        "1",
        "--description",
        "updated lifecycle description",
        "--notes",
        "ready for review",
        "--add-evidence",
        "investigation.pdf",
      ]);
      expect(reportData(updateReplay.report)).toMatchObject({ changed: false });

      const aliasUpdate = await harness.runJson([
        "update",
        "1",
        "--desc",
        "updated through the desc alias",
      ]);
      expect(reportData(aliasUpdate.report)).toMatchObject({
        changed: true,
        quest: { description: "updated through the desc alias" },
      });

      const combinedDescription = await harness.runJson([
        "update",
        "1",
        "--description",
        "first description",
        "--desc",
        "last description",
      ]);
      expect(reportData(combinedDescription.report)).toMatchObject({
        changed: true,
        quest: { description: "last description" },
      });

      const turnedIn = await harness.runJson([
        "turnin",
        "1",
        "--pr",
        "42",
        "--evidence",
        "fix.log",
      ]);
      expect(reportData(turnedIn.report)).toMatchObject({
        changed: true,
        evidence: [{ filename: "fix.log", kind: "log", stage: "fix" }],
        quest: { status: "turned_in" },
      });
      const turnInReplay = await harness.runJson([
        "turnin",
        "1",
        "--pr",
        "42",
        "--evidence",
        "fix.log",
      ]);
      expect(reportData(turnInReplay.report)).toMatchObject({ changed: false });

      const legacyDatabase = new Database(join(harness.directory, "quest.db"));
      legacyDatabase.run("DROP TRIGGER events_are_append_only_update");
      legacyDatabase.run("UPDATE events SET detail = ? WHERE quest_id = ? AND action = 'turnin'", [
        JSON.stringify({
          action: "turnin",
          actor: "janior",
          pr: "42",
          branch: "legacy",
          session_guild: "old-guild",
        }),
        1,
      ]);
      legacyDatabase.run(`
        CREATE TRIGGER events_are_append_only_update
        BEFORE UPDATE ON events
        BEGIN
          SELECT RAISE(ABORT, 'events are append-only');
        END
      `);
      legacyDatabase.close();
      const legacyTurnInReplay = await harness.runJson(["turnin", "1", "--pr", "42"]);
      expect(reportData(legacyTurnInReplay.report)).toMatchObject({ changed: false });

      const reopened = await harness.runJson(["reopen", "1", "--notes", "verification failed"]);
      expect(reportData(reopened.report)).toMatchObject({
        changed: true,
        quest: { reopen_count: 1, status: "ready" },
      });
      const reopenReplay = await harness.runJson(["reopen", "1", "--notes", "verification failed"]);
      expect(reportData(reopenReplay.report)).toMatchObject({ changed: false });
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1", "--pr", "43"]);
      const completed = await harness.runJson(["complete", "1", "--evidence", "verify.png"]);
      expect(reportData(completed.report)).toMatchObject({
        changed: true,
        evidence: [{ filename: "verify.png", kind: "screenshot", stage: "verify" }],
        quest: { status: "complete" },
      });
      expect(
        (await harness.store.events(1)).find((event) => event.action === "complete")?.detail,
      ).toMatchObject({
        pr_unverified: true,
      });
      const completeReplay = await harness.runJson(["complete", "1", "--evidence", "verify.png"]);
      expect(reportData(completeReplay.report)).toMatchObject({
        changed: false,
        evidence: [{ filename: "verify.png", stage: "verify" }],
      });
      expect(completeReplay.report?.warnings).toHaveLength(2);
    } finally {
      await harness.stop();
    }
  });

  test("requires a merged PR before completing a PR-backed quest", async () => {
    const harness = await createHarness([], config, undefined, undefined, async () => ({
      state: "OPEN",
      url: "https://github.com/example/quest/pull/42",
    }));
    try {
      await harness.runJson(["add", "Needs a merged pull request", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1", "--pr", "42"]);

      const blocked = await harness.runJson(["complete", "1"]);
      expect(blocked.code).toBe(EXIT_DOMAIN_ERROR);
      expect(blocked.report).toBeNull();
      expect(blocked.stderr[0]).toContain(
        "quest: domain: COMPLETE_PR_UNMERGED: quest 1 cannot complete because PR https://github.com/example/quest/pull/42 is OPEN; merge it, or use reopen/cancel with a reason if the work is not landing",
      );
      expect((await harness.store.getQuest(1))?.status).toBe("turned_in");
    } finally {
      await harness.stop();
    }
  });

  test("records a verified merge in the completion event", async () => {
    const harness = await createHarness([], config, undefined, undefined, async () => ({
      state: "MERGED",
      url: "https://github.com/example/quest/pull/42",
    }));
    try {
      await harness.runJson(["add", "Merged PR completion", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1", "--pr", "42"]);

      const completed = await harness.runJson(["complete", "1"]);
      expect(completed.code).toBe(EXIT_SUCCESS);
      expect(reportData(completed.report)).toMatchObject({
        changed: true,
        quest: { status: "complete" },
      });
      expect((await harness.store.events(1)).at(-1)?.detail).toMatchObject({
        pr_verified_merged: true,
      });
    } finally {
      await harness.stop();
    }
  });

  test("records an unverified PR when gh cannot check merge state", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Unavailable merge check", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1", "--pr", "42"]);

      const completed = await harness.runJson(["complete", "1"]);
      expect(completed.code).toBe(EXIT_SUCCESS);
      expect((await harness.store.events(1)).at(-1)?.detail).toMatchObject({
        pr_unverified: true,
      });
    } finally {
      await harness.stop();
    }
  });

  test("completes PR-less work without merge audit fields", async () => {
    let checks = 0;
    const harness = await createHarness([], config, undefined, undefined, () => {
      checks += 1;
      return Promise.resolve({
        state: "OPEN",
        url: "https://github.com/example/quest/pull/42",
      });
    });
    try {
      await harness.runJson(["add", "Documentation-only completion", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1"]);

      const completed = await harness.runJson(["complete", "1"]);
      expect(completed.code).toBe(EXIT_SUCCESS);
      expect((await harness.store.events(1)).at(-1)?.detail).not.toHaveProperty("pr_unverified");
      expect((await harness.store.events(1)).at(-1)?.detail).not.toHaveProperty(
        "pr_verified_merged",
      );
      expect(checks).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  test("uses the event log when the mutable PR field is cleared", async () => {
    const harness = await createHarness([], config, undefined, undefined, async () => ({
      state: "OPEN",
      url: "https://github.com/example/quest/pull/42",
    }));
    try {
      await harness.runJson(["add", "Immutable PR history", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1", "--pr", "42"]);

      const database = new Database(join(harness.directory, "quest.db"));
      database.run("UPDATE quests SET pr = NULL WHERE id = 1");
      database.close();

      const blocked = await harness.runJson(["complete", "1"]);
      expect(blocked.code).toBe(EXIT_DOMAIN_ERROR);
      expect(blocked.stderr[0]).toContain("COMPLETE_PR_UNMERGED");
      expect((await harness.store.getQuest(1))?.pr).toBeNull();
    } finally {
      await harness.stop();
    }
  });

  test("does not advertise the removed complete force flag", async () => {
    const harness = await createHarness();
    try {
      const help = await harness.runHuman(["complete", "--help"]);
      expect(help.code).toBe(EXIT_SUCCESS);
      expect(help.stdout.join("")).not.toContain("--force");
    } finally {
      await harness.stop();
    }
  });

  test("warns when completion has no verify evidence", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Warn on missing verification proof", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.store.transition(1, {
        action: "turnin",
        actor: "janior",
        pr: null,
        session_guild: "worker",
      });

      const completed = await harness.runJson(["complete", "1"]);
      expect(completed.code).toBe(EXIT_SUCCESS);
      expect(reportData(completed.report)).toMatchObject({
        changed: true,
        quest: { status: "complete" },
      });
      expect(completed.report?.warnings).toEqual([
        "quest 1 has no verify-stage evidence; attach evidence with --evidence <path>",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("requires fresh verification evidence after a quest is reopened", async () => {
    const harness = await createHarness();
    await writeFile(join(harness.directory, "prior-verification.png"), "prior verification");
    try {
      await harness.runJson(["add", "Reverify after reopening", "--kind", "task"]);
      await harness.runJson(["accept", "1"]);
      await harness.runJson(["turnin", "1"]);
      await harness.runJson(["complete", "1", "--evidence", "prior-verification.png"]);
      await harness.runJson(["reopen", "1", "--notes", "verification needs a new cycle"]);
      await harness.runJson(["accept", "1"]);
      await harness.store.transition(1, {
        action: "turnin",
        actor: "janior",
        pr: null,
        session_guild: "worker",
      });

      const completed = await harness.runJson(["complete", "1"]);
      expect(completed.code).toBe(EXIT_SUCCESS);
      expect(completed.report?.warnings).toContain(
        "quest 1 has no verify-stage evidence; attach evidence with --evidence <path>",
      );
    } finally {
      await harness.stop();
    }
  });

  test("supports bug verdict routing, retest replay, and duplicate-of links", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Target bug", "--kind", "bug", "--area", "cli"]);
      await harness.runJson(["add", "Intermittent bug", "--kind", "bug", "--area", "cli"]);

      const retest = await harness.runJson([
        "verdict",
        "2",
        "not-reproduced",
        "--notes",
        "try again",
        "--retest",
      ]);
      expect(reportData(retest.report)).toMatchObject({
        changed: true,
        quest: { status: "open", verdict: "not-reproduced" },
      });
      const retestReplay = await harness.runJson([
        "verdict",
        "2",
        "not-reproduced",
        "--notes",
        "try again",
        "--retest",
      ]);
      expect(reportData(retestReplay.report)).toMatchObject({ changed: false });

      const actionable = await harness.runJson(["verdict", "2", "actionable"]);
      expect(reportData(actionable.report)).toMatchObject({
        quest: { status: "ready", verdict: "actionable" },
      });

      await harness.runJson(["add", "Duplicate bug", "--kind", "bug", "--area", "cli"]);
      const duplicate = await harness.runJson([
        "verdict",
        "3",
        "duplicate-of:1",
        "--notes",
        "same failure",
      ]);
      expect(reportData(duplicate.report)).toMatchObject({
        quest: { status: "dropped", verdict: "duplicate" },
      });
      expect((await harness.store.exportAll()).chains).toContainEqual({
        quest_id: 3,
        target_id: 1,
        type: "duplicate-of",
      });
    } finally {
      await harness.stop();
    }
  });

  test("supports late bug triage, universal cancellation, and terminal reopening", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Claimed bug", "--kind", "bug", "--area", "cli"]);
      await harness.runJson(["verdict", "1", "actionable"]);
      await harness.runJson(["accept", "1"]);

      const lateVerdict = await harness.runJson([
        "verdict",
        "1",
        "invalid",
        "--notes",
        "the claimed report is invalid",
      ]);
      expect(reportData(lateVerdict.report)).toMatchObject({
        changed: true,
        quest: { assignee: null, status: "dropped", verdict: "invalid" },
      });

      const reopenedBug = await harness.runJson([
        "reopen",
        "1",
        "--notes",
        "new evidence needs investigation",
      ]);
      expect(reportData(reopenedBug.report)).toMatchObject({
        quest: { reopen_count: 1, status: "open", verdict: null },
      });

      const canceledBug = await harness.runJson([
        "cancel",
        "1",
        "--reason",
        "declined after review",
      ]);
      expect(reportData(canceledBug.report)).toMatchObject({
        quest: {
          assignee: null,
          status: "dropped",
          verdict: "wont-do",
          verdict_notes: "declined after review",
        },
      });
      const cancelReplay = await harness.runJson([
        "cancel",
        "1",
        "--reason",
        "declined after review",
      ]);
      expect(reportData(cancelReplay.report)).toMatchObject({ changed: false });
      const reopenedCanceledBug = await harness.runJson([
        "reopen",
        "1",
        "--notes",
        "a second review is required",
      ]);
      expect(reportData(reopenedCanceledBug.report)).toMatchObject({
        quest: { reopen_count: 2, status: "open", verdict: null },
      });

      await harness.runJson(["add", "Canceled task", "--kind", "task", "--area", "cli"]);
      const canceledTask = await harness.runJson([
        "cancel",
        "2",
        "--reason",
        "superseded by a newer ruling",
      ]);
      expect(reportData(canceledTask.report)).toMatchObject({
        quest: {
          status: "dropped",
          verdict: null,
          verdict_notes: "superseded by a newer ruling",
        },
      });
      const reopenedTask = await harness.runJson(["reopen", "2", "--notes", "scope restored"]);
      expect(reportData(reopenedTask.report)).toMatchObject({
        quest: { reopen_count: 1, status: "ready", verdict: null },
      });

      await harness.runJson(["add", "Completed task", "--kind", "task", "--area", "cli"]);
      await harness.runJson(["accept", "3"]);
      await harness.runJson(["turnin", "3"]);
      await harness.runJson(["complete", "3"]);
      const reopenedComplete = await harness.runJson([
        "reopen",
        "3",
        "--notes",
        "verification was premature",
      ]);
      expect(reportData(reopenedComplete.report)).toMatchObject({
        quest: { reopen_count: 1, status: "ready" },
      });

      expect((await harness.store.events(1)).map(({ action }) => action)).toEqual([
        "add",
        "verdict",
        "accept",
        "verdict",
        "reopen",
        "cancel",
        "reopen",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("filters guild work and requires an explicit force override on accept", async () => {
    const harness = await createHarness();
    try {
      const added = await harness.runJson([
        "add",
        "Guild-scoped work",
        "--kind",
        "task",
        "--area",
        "cli",
        "--guild",
        "claude",
      ]);
      expect(reportData(added.report)).toMatchObject({
        outcome: "created",
        quest: { guild: "claude", status: "ready" },
      });

      const blockedHuman = await harness.runHuman(["accept", "1", "--as", "janior/codex-1"]);
      expect(blockedHuman.code).toBe(EXIT_DOMAIN_ERROR);
      expect(blockedHuman.stdout).toEqual([
        "warning: quest 1 is assigned to guild claude; session guild is undeclared; use --force to override\n",
      ]);

      const blocked = await harness.runJson(["accept", "1", "--as", "janior/codex-1"]);
      expect(blocked.code).toBe(EXIT_DOMAIN_ERROR);
      expect(blocked.report).toMatchObject({
        warnings: [
          "quest 1 is assigned to guild claude; session guild is undeclared; use --force to override",
        ],
        data: { changed: false, quest: { status: "ready", assignee: null } },
      });

      const forced = await harness.runJson(["accept", "1", "--as", "janior", "--force"]);
      expect(forced.code).toBe(EXIT_SUCCESS);
      expect(forced.report?.warnings).toEqual([
        "quest 1 is assigned to guild claude; session guild is undeclared; use --force to override (override accepted)",
      ]);
      expect(reportData(forced.report)).toMatchObject({
        changed: true,
        quest: { status: "accepted", assignee: "janior" },
      });

      const forcedReplay = await harness.runJson(["accept", "1", "--as", "janior", "--force"]);
      expect(forcedReplay.code).toBe(EXIT_SUCCESS);
      expect(reportData(forcedReplay.report)).toMatchObject({ changed: false });
      expect(forcedReplay.report?.warnings).toEqual([
        "quest 1 is already assigned to janior; no change was made",
      ]);

      const cleared = await harness.runJson(["update", "1", "--clear-guild"]);
      expect(reportData(cleared.report)).toMatchObject({
        changed: true,
        quest: { guild: null },
      });

      const events = await harness.store.events(1);
      expect(events.map((event) => event.detail)).toContainEqual(
        expect.objectContaining({ session_guild: null }),
      );
    } finally {
      await harness.stop();
    }
  });

  test("checks fuzzy duplicates before create, supports force, and replays identical adds", async () => {
    const harness = await createHarness();
    try {
      const first = await harness.runJson([
        "add",
        "Login button fails",
        "--kind",
        "bug",
        "--desc",
        "Clicking does nothing",
      ]);
      expect(first.code).toBe(EXIT_SUCCESS);

      const replay = await harness.runJson([
        "add",
        "Login button fails",
        "--kind",
        "bug",
        "--desc",
        "Clicking does nothing",
      ]);
      expect(replay.code).toBe(EXIT_SUCCESS);
      expect(reportData(replay.report)).toMatchObject({
        outcome: "replayed",
        quest: { id: 1 },
      });
      await harness.runJson(["update", "1", "--title", "Completely renamed intake"]);
      const replayAfterEdit = await harness.runJson([
        "add",
        "Login button fails",
        "--kind",
        "bug",
        "--desc",
        "Clicking does nothing",
      ]);
      expect(replayAfterEdit.code).toBe(EXIT_SUCCESS);
      expect(reportData(replayAfterEdit.report)).toMatchObject({
        outcome: "replayed",
        quest: { id: 1, title: "Completely renamed intake" },
      });
      await harness.runJson(["update", "1", "--title", "Login button fails"]);

      const blocked = await harness.runJson([
        "add",
        "Login button fails now",
        "--kind",
        "bug",
        "--desc",
        "Clicking does nothing",
      ]);
      expect(blocked.code).toBe(EXIT_DOMAIN_ERROR);
      expect(reportData(blocked.report)).toMatchObject({
        outcome: "duplicates",
        quest: null,
      });
      expect(blocked.report?.warnings[0]).toContain("possible duplicate: quest 1");

      const forced = await harness.runJson([
        "add",
        "Login button fails now",
        "--kind",
        "bug",
        "--desc",
        "Clicking does nothing",
        "--force",
      ]);
      expect(forced.code).toBe(EXIT_SUCCESS);
      expect(reportData(forced.report)).toMatchObject({
        outcome: "created",
        quest: { id: 2 },
      });
      expect(forced.report?.warnings[0]).toContain("possible duplicate: quest 1");
    } finally {
      await harness.stop();
    }
  });

  test("returns exit 1 when human-readable add is blocked by duplicate candidates", async () => {
    const harness = await createHarness();
    try {
      expect((await harness.runHuman(["add", "Login button fails"])).code).toBe(EXIT_SUCCESS);

      const blocked = await harness.runHuman(["add", "Login button fails now"]);

      expect(blocked.code).toBe(EXIT_DOMAIN_ERROR);
      expect(blocked.stderr).toEqual([]);
      expect(blocked.stdout).toEqual([
        expect.stringContaining("warning: possible duplicate: quest 1"),
        "quest not added; use --force to override duplicate candidates\n",
      ]);
    } finally {
      await harness.stop();
    }
  });

  test("records historical add flags as backfills and supports interactive intake", async () => {
    const harness = await createHarness(["Interactive bug", "bug", "cli", "filed from prompts"]);
    try {
      const historical = await harness.runJson(["add", "Historical task", "--status", "complete"]);
      expect(reportData(historical.report)).toMatchObject({
        quest: { assignee: "janior", status: "complete" },
      });
      expect((await harness.store.events(1))[0]?.detail).toMatchObject({ backfill: true });
      const historicalAccept = await harness.runHuman(["accept", "1", "--as", "janior"]);
      expect(historicalAccept.code).toBe(EXIT_DOMAIN_ERROR);

      const interactive = await harness.runJson(["add"]);
      expect(interactive.code).toBe(EXIT_SUCCESS);
      expect(reportData(interactive.report)).toMatchObject({
        quest: {
          area: "cli",
          description: "filed from prompts",
          kind: "bug",
          status: "open",
          title: "Interactive bug",
        },
      });
    } finally {
      await harness.stop();
    }
  });

  test("keeps duplicate targets in the add replay identity and repairs an interrupted link", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Target one", "--kind", "bug"]);
      await harness.runJson(["add", "Target two", "--kind", "bug"]);
      await harness.runJson([
        "add",
        "Historical duplicate",
        "--kind",
        "bug",
        "--verdict",
        "duplicate-of:1",
      ]);

      const differentTarget = await harness.runJson([
        "add",
        "Historical duplicate",
        "--kind",
        "bug",
        "--verdict",
        "duplicate-of:2",
      ]);
      expect(differentTarget.code).toBe(EXIT_DOMAIN_ERROR);
      expect(reportData(differentTarget.report)).toMatchObject({ outcome: "duplicates" });

      const interrupted = await harness.store.addQuest({
        repo: "quest",
        area: null,
        kind: "bug",
        title: "Interrupted duplicate",
        description: "",
        opened_by: "janior",
        assignee: null,
        status: "dropped",
        verdict: "duplicate",
        verdict_notes: null,
        priority: 2,
        pr: null,
        guild: null,
        predicted_files: [],
        reopen_count: 0,
        backfill: true,
      });
      const repaired = await harness.runJson([
        "add",
        "Interrupted duplicate",
        "--kind",
        "bug",
        "--verdict",
        "duplicate-of:1",
      ]);
      expect(repaired.code).toBe(EXIT_SUCCESS);
      expect(reportData(repaired.report)).toMatchObject({
        outcome: "replayed",
        quest: { id: interrupted.id },
      });
      expect((await harness.store.exportAll()).chains).toContainEqual({
        quest_id: interrupted.id,
        target_id: 1,
        type: "duplicate-of",
      });
    } finally {
      await harness.stop();
    }
  });

  test("treats concurrent same-owner accepts as one change and one replay", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Concurrent claim"]);
      const results = await Promise.all([
        acceptLifecycleQuest(harness.store, { repo: "quest" }, 1, "janior/codex-1"),
        acceptLifecycleQuest(harness.store, { repo: "quest" }, 1, "janior/codex-1"),
      ]);
      expect(results.filter(({ changed }) => changed)).toHaveLength(1);
      expect(results.filter(({ changed }) => !changed)).toHaveLength(1);
      expect(results.every(({ quest }) => quest.assignee === "janior/codex-1")).toBeTrue();
    } finally {
      await harness.stop();
    }
  });

  test("returns the stable claim-conflict line and usage failures without retrying", async () => {
    const harness = await createHarness();
    try {
      await harness.runJson(["add", "Claim conflict"]);
      await harness.runJson(["accept", "1", "--as", "janior/codex-1"]);
      const conflict = await harness.runHuman(["accept", "1", "--as", "janior/codex-2"]);
      expect(conflict.code).toBe(EXIT_DOMAIN_ERROR);
      expect(conflict.stderr).toEqual([
        "quest: domain: quest 1 already accepted by janior/codex-1",
      ]);

      const invalidRetest = await harness.runHuman(["verdict", "1", "invalid", "--retest"]);
      expect(invalidRetest.code).toBe(EXIT_USAGE_ERROR);
      expect(invalidRetest.stderr[0]).toContain("--retest is only valid");

      const emptyUpdate = await harness.runHuman(["update", "1"]);
      expect(emptyUpdate.code).toBe(EXIT_USAGE_ERROR);
      expect(emptyUpdate.stderr[0]).toContain("update requires");

      const mixedAddTransport = await harness.runHuman(["add", "Mixed transport", "--json", "-"]);
      expect(mixedAddTransport.code).toBe(EXIT_USAGE_ERROR);
      expect(mixedAddTransport.stderr[0]).toContain("add --json - cannot be combined");

      const malformedId = await harness.runHuman(["accept", "nope"]);
      expect(malformedId.code).toBe(EXIT_USAGE_ERROR);
      expect(malformedId.stderr[0]).toStartWith("quest: usage:");

      const invalidVerdict = await harness.runHuman(["verdict", "1", "bogus"]);
      expect(invalidVerdict.code).toBe(EXIT_USAGE_ERROR);
      expect(invalidVerdict.stderr[0]).toContain("invalid verdict bogus");

      const malformedDuplicate = await harness.runHuman(["verdict", "1", "duplicate-of:nope"]);
      expect(malformedDuplicate.code).toBe(EXIT_USAGE_ERROR);
      expect(malformedDuplicate.stderr[0]).toContain("invalid duplicate verdict");

      const missingCancelReason = await harness.runHuman(["cancel", "1"]);
      expect(missingCancelReason.code).toBe(EXIT_USAGE_ERROR);
      expect(missingCancelReason.stderr[0]).toContain("required option '--reason <text>'");
    } finally {
      await harness.stop();
    }
  });

  test("classifies invalid interactive add input as usage", async () => {
    const harness = await createHarness(["Interactive title", "story", "", ""]);
    try {
      const invalidKind = await harness.runHuman(["add"]);
      expect(invalidKind.code).toBe(EXIT_USAGE_ERROR);
      expect(invalidKind.stderr[0]).toContain("invalid kind story");
    } finally {
      await harness.stop();
    }
  });

  test("classifies an empty explicit add title as usage", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.runHuman(["add", "   "]);
      expect(result.code).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr[0]).toContain("add title must not be empty");
    } finally {
      await harness.stop();
    }
  });
});
