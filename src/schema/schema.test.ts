import { describe, expect, test } from "bun:test";

import {
  chainSchema,
  configSchema,
  eventActionSchema,
  eventSchema,
  evidenceSchema,
  type Quest,
  type QuestReport,
  questReportSchema,
  questSchema,
  questStatusSchema,
  verdictSchema,
} from ".";

const timestamp = "2026-07-29T12:34:56Z";

const validQuest = {
  id: 3,
  repo: "quest",
  area: "schema",
  kind: "task",
  title: "Define schemas",
  description: "Use Zod as the source of truth.",
  opened_by: "janior",
  assignee: "janior/codex-w3",
  status: "accepted",
  verdict: null,
  verdict_notes: null,
  priority: 1,
  pr: null,
  guild: null,
  predicted_files: ["src/schema/index.ts"],
  reopen_count: 0,
  lease_expires_at: "2026-07-29T13:04:56Z",
  created_at: timestamp,
  updated_at: timestamp,
} satisfies Quest;

describe("entity schemas", () => {
  test("accepts each specified quest status and verdict", () => {
    expect(questStatusSchema.options).toEqual([
      "open",
      "ready",
      "accepted",
      "turned_in",
      "complete",
      "dropped",
    ]);
    expect(verdictSchema.options).toEqual([
      "actionable",
      "not-reproduced",
      "works-as-intended",
      "invalid",
      "external",
      "duplicate",
      "wont-do",
    ]);
    expect(eventActionSchema.options).toContain("cancel");
  });

  test("validates a complete quest and rejects out-of-budget fields", () => {
    expect(questSchema.parse(validQuest)).toEqual(validQuest);
    expect(questSchema.safeParse({ ...validQuest, custom_field: "no" }).success).toBeFalse();
    expect(questSchema.safeParse({ ...validQuest, priority: 4 }).success).toBeFalse();
  });

  test("validates evidence hashes, chains, and JSON event details", () => {
    expect(
      evidenceSchema.safeParse({
        id: 1,
        quest_id: 3,
        sha256: "a".repeat(64),
        filename: "proof.txt",
        kind: "log",
        stage: "fix",
        added_by: "janior/codex-w3",
        created_at: timestamp,
      }).success,
    ).toBeTrue();
    expect(
      chainSchema.safeParse({ quest_id: 4, target_id: 3, type: "requires" }).success,
    ).toBeTrue();
    expect(
      eventSchema.safeParse({
        id: 1,
        quest_id: 3,
        at: timestamp,
        actor: "janior/codex-w3",
        action: "accept",
        detail: { assignee: { from: null, to: "janior/codex-w3" } },
      }).success,
    ).toBeTrue();
    expect(
      eventSchema.safeParse({
        id: 1,
        quest_id: 3,
        at: timestamp,
        actor: "janior",
        action: "update",
        detail: { invalid: undefined },
      }).success,
    ).toBeFalse();
  });
});

describe("config schema", () => {
  test("fills documented defaults", () => {
    expect(configSchema.parse({})).toEqual({
      store: { backend: "sqlite" },
      repos: {},
      areas: {},
      colors: {},
      labels: { areas: {}, statuses: {}, verdicts: {} },
      backup: { retention: { daily: 7, weekly: 4, monthly: 6 } },
    });
  });

  test("accepts documented user configuration and strips unknown sections", () => {
    expect(
      configSchema.safeParse({
        identity: "janior",
        store: { backend: "sqlite" },
        repos: { quest: "quest" },
        areas: { quest: ["schema", "domain"] },
        colors: { complete: "green", turned_in: "yellow" },
        labels: {
          areas: { quest: { schema: "Data model" } },
          verdicts: { "not-reproduced": "Could not reproduce" },
        },
        editor: "code --wait",
        evidence_dir: "/tmp/quest-evidence",
        dispatch: {
          trust: "guarded",
          claude_args: ["--model", "sonnet"],
          codex_args: ["--model", "gpt-5"],
        },
        backup: { root: "/tmp/backups" },
      }).success,
    ).toBeTrue();
    const unknownSection = configSchema.safeParse({ workflow: { statuses: ["todo"] } });
    expect(unknownSection.success).toBeTrue();
    if (unknownSection.success) {
      expect(unknownSection.data).not.toHaveProperty("workflow");
    }
  });

  test("accepts per-repository backend overrides", () => {
    const config = configSchema.parse({
      store: { backend: "sqlite" },
      repos: {
        "web-app": {
          store: {
            backend: "convex",
            deployment: "https://happy-fox-123.convex.cloud",
          },
        },
      },
    });

    expect(config.repos["web-app"]).toEqual({
      store: {
        backend: "convex",
        deployment: "https://happy-fox-123.convex.cloud",
      },
    });
  });

  test("accepts a lease duration in the existing store section", () => {
    expect(
      configSchema.parse({ store: { backend: "sqlite", lease_ttl_minutes: 60 } }).store,
    ).toEqual({ backend: "sqlite", lease_ttl_minutes: 60 });
    expect(configSchema.safeParse({ store: { lease_ttl_minutes: 0 } }).success).toBeFalse();
    expect(
      configSchema.safeParse({ store: { lease_ttl_minutes: 100_000_001 } }).success,
    ).toBeFalse();
  });

  test("rejects non-record values for object-valued configuration", () => {
    expect(configSchema.safeParse(new Date()).success).toBeFalse();
    expect(configSchema.safeParse({ backup: { retention: new Date() } }).success).toBeFalse();
  });
});

describe("quest.report/v1 schema", () => {
  test("validates the CLI envelope and JSON payload", () => {
    const report = {
      schema: "quest.report/v1",
      command: "next",
      generated_at: timestamp,
      filters: { repo: "quest", status: null },
      warnings: ["quest 4 skipped: blocked by 3"],
      data: { quest: validQuest },
    } satisfies QuestReport;

    expect(questReportSchema.parse(report)).toEqual(report);
    expect(
      questReportSchema.safeParse({ ...report, schema: "quest.report/v2" }).success,
    ).toBeFalse();
    expect(questReportSchema.safeParse({ ...report, data: undefined }).success).toBeFalse();
  });
});
