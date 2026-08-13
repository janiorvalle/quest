import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCliOutputBoundary,
  EXIT_DOMAIN_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
} from "../output";
import type { Config, NewQuest, QuestReport } from "../schema";
import { newQuestSchema, questReportSchema } from "../schema";
import { LocalBlobStore, SqliteStore } from "../store";
import type { QuestCliDependencies } from "./program";
import { runQuestCli } from "./program";

const generatedAt = "2026-07-29T14:00:00Z";
const sha256 = "2d1538669db82cff95ff47d3b4ff888030a9aa45b8450d496ec2458ad711284a";

const config = {
  identity: "amy",
  store: { backend: "sqlite" },
  repos: {},
  areas: {},
  colors: {},
  labels: {
    areas: { alpha: { cli: "Command line" } },
    statuses: { open: "Open" },
    verdicts: { actionable: "Actionable" },
  },
  backup: {
    retention: { daily: 7, weekly: 4, monthly: 6 },
  },
} satisfies Config;

interface QueryCliHarness {
  readonly run: (argumentsWithoutRuntime: readonly string[]) => Promise<{
    code: number;
    report: QuestReport | null;
    stderr: readonly string[];
    stdout: readonly string[];
  }>;
  readonly store: SqliteStore;
  readonly blobStore: LocalBlobStore;
  readonly stop: () => Promise<void>;
}

async function createHarness(configOverride: Config = config): Promise<QueryCliHarness> {
  const directory = await mkdtemp(join(tmpdir(), "quest-query-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const store = new SqliteStore(join(directory, "quest.db"), { now: () => generatedAt });
  const blobStore = new LocalBlobStore(join(directory, "evidence"));
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
    evidenceFiles: {
      read: () => Promise.reject(new Error("query commands must not read evidence blobs")),
    },
    initialWorkingDirectory: directory,
    isTty: false,
    locateGitRoot: () => Promise.resolve(directory),
    openApplicationPorts: () =>
      Promise.resolve({
        blobStore,
        clock: { now: () => Promise.resolve(generatedAt) },
        questStore: store,
      }),
    output: createCliOutputBoundary({
      stdout: (text) => stdout.push(text),
      stderr: (line) => stderr.push(line),
    }),
    prompter: {
      ask: () => Promise.reject(new Error("query commands must not prompt")),
    },
    validateWorkingDirectory: () => Promise.resolve(),
  } satisfies QuestCliDependencies;

  return {
    async run(argumentsWithoutRuntime) {
      stdout.length = 0;
      stderr.length = 0;
      const code = await runQuestCli(argumentsWithoutRuntime, dependencies);
      return {
        code,
        report:
          stdout.length === 0 || !argumentsWithoutRuntime.includes("json")
            ? null
            : questReportSchema.parse(JSON.parse(stdout.join(""))),
        stderr: [...stderr],
        stdout: [...stdout],
      };
    },
    store,
    blobStore,
    async stop() {
      store.close();
      await rm(directory, { force: true, recursive: true });
    },
  };
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

async function seedFixture(store: SqliteStore): Promise<void> {
  const blockedOpen = await store.addQuest(task("Blocked open"));
  const accepted = await store.addQuest(
    task("Accepted work", { assignee: "amy", status: "accepted", priority: 1 }),
  );
  const complete = await store.addQuest(
    task("Completed bug", {
      assignee: "amy",
      kind: "bug",
      reopen_count: 2,
      status: "complete",
      verdict: "actionable",
      verdict_notes: "fixed twice",
    }),
  );
  await store.addQuest(
    task("Invalid report", {
      area: "store",
      kind: "bug",
      status: "dropped",
      verdict: "invalid",
    }),
  );
  const duplicate = await store.addQuest(
    task("Duplicate report", {
      kind: "bug",
      status: "dropped",
      verdict: "duplicate",
    }),
  );
  await store.addQuest(
    task("Beta in review", {
      area: "api",
      assignee: "sam",
      guild: null,
      pr: "42",
      repo: "beta",
      reopen_count: 1,
      status: "turned_in",
    }),
  );
  await store.addQuest(
    task("Beta open bug", {
      area: null,
      kind: "bug",
      repo: "beta",
      status: "open",
    }),
  );

  await store.addChainLink({
    actor: "fixture",
    link: { quest_id: blockedOpen.id, target_id: accepted.id, type: "requires" },
  });
  await store.addChainLink({
    actor: "fixture",
    link: { quest_id: complete.id, target_id: blockedOpen.id, type: "requires" },
  });
  await store.addChainLink({
    actor: "fixture",
    link: { quest_id: duplicate.id, target_id: blockedOpen.id, type: "duplicate-of" },
  });
  await store.addEvidence({
    quest_id: blockedOpen.id,
    sha256,
    filename: "failure.log",
    kind: "log",
    stage: "report",
    added_by: "fixture",
  });
}

describe("query CLI behavior", () => {
  test("composes list filters and supports mine and unclaimed views", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);

      const filtered = await harness.run([
        "list",
        "--status",
        "open",
        "--area",
        "cli",
        "--kind",
        "task",
        "--unclaimed",
        "--blocked",
        "--repo",
        "alpha",
        "--format",
        "json",
      ]);
      expect(filtered.code).toBe(EXIT_SUCCESS);
      expect(filtered.report).toMatchObject({
        schema: "quest.report/v1",
        command: "list",
        generated_at: generatedAt,
        filters: {
          repo: "alpha",
          status: "open",
          area: "cli",
          kind: "task",
          mine: false,
          unclaimed: true,
          blocked: true,
        },
        warnings: [],
        data: {
          quests: [{ id: 1, title: "Blocked open" }],
          total: 1,
        },
      });

      const mine = await harness.run(["list", "--mine", "--repo", "alpha", "--format", "json"]);
      expect(mine.report?.data).toMatchObject({
        quests: [
          { id: 2, assignee: "amy" },
          { id: 3, assignee: "amy" },
        ],
        total: 2,
      });

      const all = await harness.run(["list", "--all", "--format", "json"]);
      expect(all.report?.data).toMatchObject({ total: 7 });

      const conflicting = await harness.run(["list", "--mine", "--unclaimed", "--repo", "alpha"]);
      expect(conflicting.code).toBe(EXIT_USAGE_ERROR);
      expect(conflicting.stderr[0]).toContain("cannot be used with option");
    } finally {
      await harness.stop();
    }
  });

  test("shows every quest field, evidence metadata, and both sides of its chain position", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);

      const shown = await harness.run(["show", "1", "--repo", "alpha", "--format", "json"]);
      expect(shown.code).toBe(EXIT_SUCCESS);
      expect(shown.report).toMatchObject({
        command: "show",
        filters: { repo: "alpha", id: 1 },
        warnings: [],
        data: {
          quest: {
            id: 1,
            repo: "alpha",
            area: "cli",
            kind: "task",
            title: "Blocked open",
            description: "Blocked open description",
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
            lease_expires_at: null,
            created_at: generatedAt,
            updated_at: generatedAt,
          },
          evidence: [
            {
              id: 1,
              quest_id: 1,
              sha256,
              filename: "failure.log",
              kind: "log",
              stage: "report",
              added_by: "fixture",
              created_at: generatedAt,
            },
          ],
          chain_position: {
            requires: [{ id: 2, title: "Accepted work", status: "accepted" }],
            required_by: [{ id: 3, title: "Completed bug", status: "complete" }],
            duplicate_of: [],
            duplicates: [{ id: 5, title: "Duplicate report", status: "dropped" }],
          },
        },
      });

      const hiddenByScope = await harness.run(["show", "6", "--repo", "alpha", "--format", "json"]);
      expect(hiddenByScope.code).toBe(EXIT_DOMAIN_ERROR);
      expect(hiddenByScope.report).toBeNull();
      expect(hiddenByScope.stderr).toEqual([
        "quest: domain: quest 6 does not exist in the selected scope",
      ]);

      await harness.blobStore.put(new TextEncoder().encode("failure log"));
      const materialized = await harness.run(["show", "1", "--repo", "alpha", "--materialize"]);
      expect(materialized.code).toBe(EXIT_SUCCESS);
      const materializedOutput = materialized.stdout.join("");
      expect(materializedOutput).toContain("Materialized evidence\n");
      expect(materializedOutput).toContain("0001-failure.log");
      const directoryLine = materializedOutput
        .split("\n")
        .find((line) => line.startsWith("Directory: "));
      if (directoryLine === undefined) {
        throw new Error("materialization directory was not printed");
      }
      await rm(directoryLine.slice("Directory: ".length), { force: true, recursive: true });
    } finally {
      await harness.stop();
    }
  });

  test("reconciles all stats exactly with the multi-repository fixture", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);

      const all = await harness.run(["stats", "--all", "--format", "json"]);
      expect(all.code).toBe(EXIT_SUCCESS);
      expect(all.report).toEqual({
        schema: "quest.report/v1",
        command: "stats",
        generated_at: generatedAt,
        filters: { repo: null },
        warnings: [],
        data: {
          repos: [
            {
              repo: "alpha",
              total: 5,
              status_counts: { open: 1, accepted: 1, complete: 1, dropped: 2 },
              verdict_counts: { actionable: 1, invalid: 1, duplicate: 1 },
              reopen_count: 2,
              assignee_load: { amy: 2 },
            },
            {
              repo: "beta",
              total: 2,
              status_counts: { open: 1, turned_in: 1 },
              verdict_counts: {},
              reopen_count: 1,
              assignee_load: { sam: 1 },
            },
          ],
        },
      });

      const alpha = await harness.run(["stats", "--repo", "alpha", "--format", "json"]);
      expect(alpha.report?.data).toEqual({
        repos: [
          {
            repo: "alpha",
            total: 5,
            status_counts: { open: 1, accepted: 1, complete: 1, dropped: 2 },
            verdict_counts: { actionable: 1, invalid: 1, duplicate: 1 },
            reopen_count: 2,
            assignee_load: { amy: 2 },
          },
        ],
      });
    } finally {
      await harness.stop();
    }
  });

  test("renders established tables and requires configured identity for mine", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);

      const list = await harness.run(["list", "--repo", "alpha"]);
      expect(list.code).toBe(EXIT_SUCCESS);
      expect(list.stdout.join("")).toContain("ID  STATUS");
      expect(list.stdout.join("")).toContain("Open");
      expect(list.stdout.join("")).toContain("Command line");

      const show = await harness.run(["show", "1", "--repo", "alpha"]);
      expect(show.stdout.join("")).toContain("Evidence\n");
      expect(show.stdout.join("")).toContain("failure.log");
      expect(show.stdout.join("")).toContain("Chain position\n");
      expect(show.stdout.join("")).toContain("required by");

      const stats = await harness.run(["stats", "--all"]);
      expect(stats.stdout.join("")).toContain("Summary\n");
      expect(stats.stdout.join("")).toContain("Status\n");
      expect(stats.stdout.join("")).toContain("Verdict\n");
      expect(stats.stdout.join("")).toContain("Assignee load\n");
    } finally {
      await harness.stop();
    }

    const noIdentity = await createHarness({ ...config, identity: undefined });
    try {
      const result = await noIdentity.run(["list", "--mine", "--repo", "alpha"]);
      expect(result.code).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toEqual([
        "quest: usage: identity is not configured; set identity in config before using --mine",
      ]);
    } finally {
      await noIdentity.stop();
    }
  });

  test("queries the append-only event log across quests with composable filters", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);

      const all = await harness.run(["events", "--all", "--format", "json"]);
      expect(all.code).toBe(EXIT_SUCCESS);
      expect(all.report).toMatchObject({
        schema: "quest.report/v1",
        command: "events",
        generated_at: generatedAt,
        filters: {
          repo: null,
          after_id: null,
          since: null,
          until: null,
          actor: null,
          action: null,
          area: null,
          quest: null,
        },
        warnings: [],
        data: { total: 11 },
      });
      const allEvents = JSON.stringify(all.report?.data);
      expect(allEvents).toContain('"id":1');
      expect(allEvents).toContain('"id":11');

      const filtered = await harness.run([
        "events",
        "--repo",
        "alpha",
        "--after-id",
        "8",
        "--since",
        generatedAt,
        "--until",
        generatedAt,
        "--actor",
        "fixture",
        "--action",
        "chain",
        "--area",
        "cli",
        "--format",
        "json",
      ]);
      expect(filtered.code).toBe(EXIT_SUCCESS);
      expect(filtered.report?.data).toEqual({
        total: 2,
        events: [
          expect.objectContaining({ id: 9, quest_id: 3, action: "chain" }),
          expect.objectContaining({ id: 10, quest_id: 5, action: "chain" }),
        ],
      });

      const quest = await harness.run([
        "events",
        "--quest",
        "1",
        "--repo",
        "alpha",
        "--after-id",
        "1",
        "--format",
        "json",
      ]);
      expect(quest.report?.data).toMatchObject({
        total: 2,
        events: [
          { id: 8, action: "chain" },
          { id: 11, action: "update" },
        ],
      });

      const human = await harness.run(["events", "--quest", "1", "--repo", "alpha"]);
      expect(human.code).toBe(EXIT_SUCCESS);
      expect(human.stdout.join("")).toContain("ID  QUEST");
      expect(human.stdout.join("")).toContain('"sha256"');
    } finally {
      await harness.stop();
    }
  });

  test("rejects an event range whose start is after its end", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.run([
        "events",
        "--since",
        "2026-07-30T00:00:00Z",
        "--until",
        "2026-07-29T00:00:00Z",
      ]);
      expect(result.code).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toEqual(["quest: usage: since must be earlier than or equal to until"]);
    } finally {
      await harness.stop();
    }
  });

  test("rejects an empty event cursor", async () => {
    const harness = await createHarness();
    try {
      const result = await harness.run(["events", "--after-id", ""]);
      expect(result.code).toBe(EXIT_USAGE_ERROR);
      expect(result.stderr).toEqual(["quest: usage: --after-id must be a nonnegative integer"]);
    } finally {
      await harness.stop();
    }
  });
});

describe("brief CLI behavior", () => {
  test("compiles the full context package as a JSON envelope", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);
      const result = await harness.run(["brief", "1", "--repo", "alpha", "--format", "json"]);
      expect(result.code).toBe(EXIT_SUCCESS);
      const data = result.report?.data as {
        chain_position: { required_by: { id: number }[]; requires: { id: number }[] };
        events: { action: string; id: number }[];
        materialized: null;
        quest: { id: number; title: string };
      };
      expect(data.quest).toMatchObject({ id: 1, title: "Blocked open" });
      expect(data.materialized).toBeNull();
      expect(data.chain_position.requires.map(({ id }) => id)).toEqual([2]);
      expect(data.chain_position.required_by.map(({ id }) => id)).toEqual([3]);
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events.map(({ id }) => id)).toEqual(
        [...data.events.map(({ id }) => id)].sort((left, right) => left - right),
      );
    } finally {
      await harness.stop();
    }
  });

  test("renders the markdown handoff with blocked banner, sections, and working agreement", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);
      const result = await harness.run(["brief", "1", "--repo", "alpha"]);
      expect(result.code).toBe(EXIT_SUCCESS);
      const markdown = result.stdout.join("");
      expect(markdown).toContain("# quest 1 — Blocked open");
      expect(markdown).toContain("⛓ BLOCKED — incomplete requirements: 2");
      expect(markdown).toContain("## Mission");
      expect(markdown).toContain("Blocked open description");
      expect(markdown).not.toContain("## Verdict");
      expect(markdown).toContain("- requires 2 [accepted] Accepted work ← incomplete, blocks this");
      expect(markdown).toContain("- unlocks 3 [complete] Completed bug");
      expect(markdown).toContain("- duplicated by 5 [dropped] Duplicate report");
      expect(markdown).toContain("## Evidence · 1");
      expect(markdown).toContain("- [report] failure.log · log · added by fixture");
      expect(markdown).toContain(`  sha256 ${sha256}`);
      expect(markdown).toContain("(read the files: `quest brief 1 --materialize`)");
      expect(markdown).toContain("## History ·");
      expect(markdown).toContain("## Working agreement");
      expect(markdown).toContain("`quest turnin 1`");
      expect(markdown).toContain("(none recorded — record yours early:");
    } finally {
      await harness.stop();
    }
  });

  test("omits the blocked banner for unblocked quests and shows verdict when present", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);
      const result = await harness.run(["brief", "3", "--repo", "alpha"]);
      expect(result.code).toBe(EXIT_SUCCESS);
      const markdown = result.stdout.join("");
      expect(markdown).toContain("# quest 3 — Completed bug");
      expect(markdown).not.toContain("⛓ BLOCKED");
      expect(markdown).toContain("## Verdict");
      expect(markdown).toContain("actionable — fixed twice");
    } finally {
      await harness.stop();
    }
  });

  test("materializes evidence and includes the file paths in the handoff", async () => {
    const harness = await createHarness();
    try {
      await seedFixture(harness.store);
      const bytes = new TextEncoder().encode("brief evidence bytes");
      const storedSha = await harness.blobStore.put(bytes);
      await harness.store.addEvidence({
        quest_id: 2,
        sha256: storedSha,
        filename: "repro steps.txt",
        kind: "doc",
        stage: "investigation",
        added_by: "amy",
      });
      const result = await harness.run([
        "brief",
        "2",
        "--repo",
        "alpha",
        "--materialize",
        "--format",
        "json",
      ]);
      expect(result.code).toBe(EXIT_SUCCESS);
      const data = result.report?.data as {
        materialized: { directory: string; files: { evidence_id: number; path: string }[] };
      };
      expect(data.materialized.files).toHaveLength(1);
      const file = data.materialized.files[0];
      expect(file?.path).toContain("0001-repro_steps.txt");

      const markdownResult = await harness.run(["brief", "2", "--repo", "alpha", "--materialize"]);
      const markdown = markdownResult.stdout.join("");
      expect(markdown).toContain("  file ");
      expect(markdown).toContain("0001-repro_steps.txt");
      expect(markdown).not.toContain("(read the files:");
    } finally {
      await harness.stop();
    }
  });
});
