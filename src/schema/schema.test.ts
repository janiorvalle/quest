import { describe, expect, test } from "bun:test";

import {
  acceptQuestInputSchema,
  chainMutationSchema,
  chainSchema,
  configSchema,
  eventActionSchema,
  eventSchema,
  evidenceSchema,
  newEvidenceSchema,
  newQuestSchema,
  QUEST_INPUT_LIMITS,
  QUEST_INPUT_TOO_LARGE_CODE,
  type Quest,
  type QuestReport,
  questInputTooLargeMessage,
  questReportSchema,
  questSchema,
  questStatusSchema,
  questTransitionSchema,
  touchQuestInputSchema,
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

const { id: _id, created_at: _createdAt, updated_at: _updatedAt, ...validNewQuest } = validQuest;

function oversizedText(limit: number): string {
  return "x".repeat(limit + 1);
}

function expectInputTooLarge(parse: () => unknown, field: string, limit: number): void {
  try {
    parse();
  } catch (error: unknown) {
    const message = questInputTooLargeMessage(error);
    expect(message).toContain(field);
    expect(message).toContain(`expected at most ${limit}`);
    if (error instanceof Error) {
      expect(error.message).toContain(QUEST_INPUT_TOO_LARGE_CODE);
    }
    return;
  }
  throw new Error(`expected ${field} to reject oversized input`);
}

describe("entity schemas", () => {
  test("accepts each specified quest status and verdict", () => {
    expect(questStatusSchema.options).toEqual([
      "open",
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
    expect(eventActionSchema.options).toContain("signoff");
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
      evidenceSchema.safeParse({
        id: 2,
        quest_id: 3,
        sha256: "b".repeat(64),
        filename: "qa.txt",
        kind: "doc",
        stage: "signoff",
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

describe("agent write limits", () => {
  test("bounds descriptions, summaries, and every lifecycle note before persistence", () => {
    expectInputTooLarge(
      () =>
        newQuestSchema.parse({
          ...validNewQuest,
          description: oversizedText(QUEST_INPUT_LIMITS.descriptionBytes),
        }),
      "description",
      QUEST_INPUT_LIMITS.descriptionBytes,
    );
    expectInputTooLarge(
      () =>
        newQuestSchema.parse({
          ...validNewQuest,
          verdict_notes: oversizedText(QUEST_INPUT_LIMITS.notesBytes),
        }),
      "verdict_notes",
      QUEST_INPUT_LIMITS.notesBytes,
    );

    const transitionCases = [
      {
        field: "summary",
        limit: QUEST_INPUT_LIMITS.summaryBytes,
        transition: {
          action: "turnin",
          actor: "janior",
          pr: null,
          summary: oversizedText(QUEST_INPUT_LIMITS.summaryBytes),
        },
      },
      {
        field: "notes",
        limit: QUEST_INPUT_LIMITS.notesBytes,
        transition: {
          action: "verdict",
          actor: "janior",
          verdict: "invalid",
          notes: oversizedText(QUEST_INPUT_LIMITS.notesBytes),
          retest: false,
          duplicate_of: null,
        },
      },
      {
        field: "notes",
        limit: QUEST_INPUT_LIMITS.notesBytes,
        transition: {
          action: "signoff",
          actor: "janior",
          notes: oversizedText(QUEST_INPUT_LIMITS.notesBytes),
        },
      },
      {
        field: "notes",
        limit: QUEST_INPUT_LIMITS.notesBytes,
        transition: {
          action: "reopen",
          actor: "janior",
          notes: oversizedText(QUEST_INPUT_LIMITS.notesBytes),
        },
      },
      {
        field: "reason",
        limit: QUEST_INPUT_LIMITS.notesBytes,
        transition: {
          action: "cancel",
          actor: "janior",
          reason: oversizedText(QUEST_INPUT_LIMITS.notesBytes),
        },
      },
      {
        field: "description",
        limit: QUEST_INPUT_LIMITS.descriptionBytes,
        transition: {
          action: "update",
          actor: "janior",
          changes: { description: oversizedText(QUEST_INPUT_LIMITS.descriptionBytes) },
        },
      },
      {
        field: "verdict_notes",
        limit: QUEST_INPUT_LIMITS.notesBytes,
        transition: {
          action: "update",
          actor: "janior",
          changes: { verdict_notes: oversizedText(QUEST_INPUT_LIMITS.notesBytes) },
        },
      },
    ];
    for (const { field, limit, transition } of transitionCases) {
      expectInputTooLarge(() => questTransitionSchema.parse(transition), field, limit);
    }
  });

  test("bounds every file list by item, count, and combined UTF-8 bytes", () => {
    const oversizedPath = oversizedText(QUEST_INPUT_LIMITS.filePathBytes);
    expectInputTooLarge(
      () => newQuestSchema.parse({ ...validNewQuest, predicted_files: [oversizedPath] }),
      "predicted_files[0]",
      QUEST_INPUT_LIMITS.filePathBytes,
    );
    expectInputTooLarge(
      () =>
        questTransitionSchema.parse({
          action: "turnin",
          actor: "janior",
          pr: null,
          actual_files: [oversizedPath],
        }),
      "actual_files[0]",
      QUEST_INPUT_LIMITS.filePathBytes,
    );
    expectInputTooLarge(
      () =>
        questTransitionSchema.parse({
          action: "update",
          actor: "janior",
          changes: { predicted_files: [oversizedPath] },
        }),
      "predicted_files[0]",
      QUEST_INPUT_LIMITS.filePathBytes,
    );

    expectInputTooLarge(
      () =>
        newQuestSchema.parse({
          ...validNewQuest,
          predicted_files: Array.from(
            { length: QUEST_INPUT_LIMITS.fileListItems + 1 },
            (_, index) => `src/${index}.ts`,
          ),
        }),
      "predicted_files",
      QUEST_INPUT_LIMITS.fileListItems,
    );

    const aggregatePathBytes = QUEST_INPUT_LIMITS.filePathBytes;
    const aggregatePaths = Array.from(
      { length: Math.floor(QUEST_INPUT_LIMITS.fileListBytes / aggregatePathBytes) + 1 },
      (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(aggregatePathBytes - 4)}`,
    );
    expectInputTooLarge(
      () => newQuestSchema.parse({ ...validNewQuest, predicted_files: aggregatePaths }),
      "predicted_files",
      QUEST_INPUT_LIMITS.fileListBytes,
    );
  });

  test("bounds evidence filenames and counts multibyte text as UTF-8 bytes", () => {
    expectInputTooLarge(
      () =>
        newEvidenceSchema.parse({
          quest_id: 3,
          sha256: "a".repeat(64),
          filename: oversizedText(QUEST_INPUT_LIMITS.evidenceFilenameBytes),
          kind: "log",
          stage: "fix",
          added_by: "janior",
        }),
      "filename",
      QUEST_INPUT_LIMITS.evidenceFilenameBytes,
    );

    const twoByteCharacters = "é".repeat(QUEST_INPUT_LIMITS.inlineTextBytes / 2 + 1);
    expectInputTooLarge(
      () => newQuestSchema.parse({ ...validNewQuest, title: twoByteCharacters }),
      "title",
      QUEST_INPUT_LIMITS.inlineTextBytes,
    );
  });

  test("bounds inline text on quest, attribution, and mutation inputs", () => {
    const oversized = oversizedText(QUEST_INPUT_LIMITS.inlineTextBytes);
    const newQuestCases = [
      ["repo", { repo: oversized }],
      ["area", { area: oversized }],
      ["title", { title: oversized }],
      ["opened_by", { opened_by: oversized }],
      ["guild", { guild: oversized }],
      ["assignee", { assignee: oversized }],
      ["pr", { pr: oversized }],
      ["session_guild", { session_guild: oversized }],
    ] as const;
    for (const [field, change] of newQuestCases) {
      expectInputTooLarge(
        () => newQuestSchema.parse({ ...validNewQuest, ...change }),
        field,
        QUEST_INPUT_LIMITS.inlineTextBytes,
      );
    }

    const mutationCases = [
      ["owner", () => acceptQuestInputSchema.parse({ id: 3, owner: oversized })],
      ["owner", () => touchQuestInputSchema.parse({ id: 3, owner: oversized })],
      [
        "actor",
        () => questTransitionSchema.parse({ action: "turnin", actor: oversized, pr: null }),
      ],
      [
        "session_model",
        () =>
          questTransitionSchema.parse({
            action: "turnin",
            actor: "janior",
            pr: null,
            session_model: oversized,
          }),
      ],
      [
        "session_effort",
        () =>
          questTransitionSchema.parse({
            action: "turnin",
            actor: "janior",
            pr: null,
            session_effort: oversized,
          }),
      ],
      [
        "session_guild",
        () =>
          questTransitionSchema.parse({
            action: "turnin",
            actor: "janior",
            pr: null,
            session_guild: oversized,
          }),
      ],
      [
        "pr",
        () =>
          questTransitionSchema.parse({
            action: "turnin",
            actor: "janior",
            pr: oversized,
          }),
      ],
      [
        "added_by",
        () =>
          newEvidenceSchema.parse({
            quest_id: 3,
            sha256: "a".repeat(64),
            filename: "proof.txt",
            kind: "log",
            stage: "fix",
            added_by: oversized,
          }),
      ],
      [
        "actor",
        () =>
          chainMutationSchema.parse({
            link: { quest_id: 3, target_id: 4, type: "requires" },
            actor: oversized,
          }),
      ],
    ] as const;
    for (const [field, parse] of mutationCases) {
      expectInputTooLarge(parse, field, QUEST_INPUT_LIMITS.inlineTextBytes);
    }
  });

  test("keeps persisted entity schemas compatible with existing oversized data", () => {
    expect(
      questSchema.safeParse({
        ...validQuest,
        description: oversizedText(QUEST_INPUT_LIMITS.descriptionBytes),
        predicted_files: [oversizedText(QUEST_INPUT_LIMITS.filePathBytes)],
      }).success,
    ).toBeTrue();
    expect(
      evidenceSchema.safeParse({
        id: 1,
        quest_id: 3,
        sha256: "a".repeat(64),
        filename: oversizedText(QUEST_INPUT_LIMITS.evidenceFilenameBytes),
        kind: "log",
        stage: "fix",
        added_by: "janior",
        created_at: timestamp,
      }).success,
    ).toBeTrue();
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
