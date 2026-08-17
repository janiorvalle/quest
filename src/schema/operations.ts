import { z } from "zod";

import { chainSchema, eventBaseSchema, eventSchema, evidenceSchema, questSchema } from "./entities";
import { eventActionSchema, questKindSchema, questStatusSchema, verdictSchema } from "./enums";
import { nonEmptyTextSchema } from "./primitives";

const displayIdSchema = z.int().positive();

export const QUEST_INPUT_TOO_LARGE_CODE = "QUEST_INPUT_TOO_LARGE";
export const QUEST_INPUT_LIMITS = {
  descriptionBytes: 256 * 1_024,
  evidenceFilenameBytes: 4 * 1_024,
  fileListBytes: 384 * 1_024,
  fileListItems: 128,
  filePathBytes: 4 * 1_024,
  inlineTextBytes: 16 * 1_024,
  notesBytes: 64 * 1_024,
  summaryBytes: 256 * 1_024,
} as const;

const inputTooLargePrefix = `[${QUEST_INPUT_TOO_LARGE_CODE}] `;
const textEncoder = new TextEncoder();

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function inputTooLargeMessage(
  field: string,
  actual: number,
  limit: number,
  unit: "bytes" | "items",
): string {
  return `${inputTooLargePrefix}${field} has ${actual} ${unit}; expected at most ${limit} ${unit}; shorten ${field} and retry`;
}

function byteBoundedTextSchema(
  field: string,
  maximumBytes: number,
  schema: z.ZodString = z.string(),
) {
  return schema.superRefine((value, context) => {
    const actualBytes = utf8Bytes(value);
    if (actualBytes > maximumBytes) {
      context.addIssue({
        code: "custom",
        message: inputTooLargeMessage(field, actualBytes, maximumBytes, "bytes"),
      });
    }
  });
}

function fileListInputSchema(field: string) {
  return z.array(nonEmptyTextSchema).superRefine((files, context) => {
    if (files.length > QUEST_INPUT_LIMITS.fileListItems) {
      context.addIssue({
        code: "custom",
        message: inputTooLargeMessage(
          field,
          files.length,
          QUEST_INPUT_LIMITS.fileListItems,
          "items",
        ),
      });
    }

    let totalBytes = 0;
    for (const [index, file] of files.entries()) {
      const fileBytes = utf8Bytes(file);
      totalBytes += fileBytes;
      if (fileBytes > QUEST_INPUT_LIMITS.filePathBytes) {
        context.addIssue({
          code: "custom",
          message: inputTooLargeMessage(
            `${field}[${index}]`,
            fileBytes,
            QUEST_INPUT_LIMITS.filePathBytes,
            "bytes",
          ),
          path: [index],
        });
      }
    }

    if (totalBytes > QUEST_INPUT_LIMITS.fileListBytes) {
      context.addIssue({
        code: "custom",
        message: inputTooLargeMessage(field, totalBytes, QUEST_INPUT_LIMITS.fileListBytes, "bytes"),
      });
    }
  });
}

function inlineTextInputSchema(field: string) {
  return byteBoundedTextSchema(field, QUEST_INPUT_LIMITS.inlineTextBytes, nonEmptyTextSchema);
}

const descriptionInputSchema = byteBoundedTextSchema(
  "description",
  QUEST_INPUT_LIMITS.descriptionBytes,
);
const evidenceFilenameInputSchema = byteBoundedTextSchema(
  "filename",
  QUEST_INPUT_LIMITS.evidenceFilenameBytes,
  nonEmptyTextSchema,
);
const notesInputSchema = byteBoundedTextSchema("notes", QUEST_INPUT_LIMITS.notesBytes);
const verdictNotesInputSchema = byteBoundedTextSchema(
  "verdict_notes",
  QUEST_INPUT_LIMITS.notesBytes,
);
const predictedFilesInputSchema = fileListInputSchema("predicted_files");
const actualFilesSchema = fileListInputSchema("actual_files").transform((files) =>
  [...new Set(files)].sort(),
);
const summaryInputSchema = byteBoundedTextSchema(
  "summary",
  QUEST_INPUT_LIMITS.summaryBytes,
  nonEmptyTextSchema,
);

export function questInputTooLargeMessage(error: unknown): string | undefined {
  if (!(error instanceof z.ZodError)) {
    return undefined;
  }
  const issue = error.issues.find(({ message }) => message.startsWith(inputTooLargePrefix));
  return issue?.message.slice(inputTooLargePrefix.length);
}

// Unified open status is part of the Convex wire contract; deploy and migrate the matching backend
// before releasing a client that no longer understands ready.
export const STORE_SCHEMA_VERSION = 10;
export const MAX_LEASE_TTL_MINUTES = 100_000_000;
const leaseTtlMinutesSchema = z.int().positive().max(MAX_LEASE_TTL_MINUTES);

const sessionGuildSchema = inlineTextInputSchema("session_guild").nullable().optional();
const sessionAttributionFields = {
  session_model: inlineTextInputSchema("session_model").optional(),
  session_effort: inlineTextInputSchema("session_effort").optional(),
};

export const storeCompatibilityResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("compatible"),
    supported_version: z.int().positive(),
    store_version: z.int().nonnegative(),
  }),
  z.strictObject({
    outcome: z.literal("store-newer"),
    supported_version: z.int().positive(),
    store_version: z.int().nonnegative(),
    action: z.literal("upgrade-binary"),
  }),
  z.strictObject({
    outcome: z.literal("store-older"),
    supported_version: z.int().positive(),
    store_version: z.int().nonnegative(),
    action: z.literal("migrate-store"),
  }),
]);
export type StoreCompatibilityResult = z.infer<typeof storeCompatibilityResultSchema>;

export const newQuestSchema = questSchema
  .omit({
    id: true,
    created_at: true,
    updated_at: true,
  })
  .extend({
    area: inlineTextInputSchema("area").nullable(),
    assignee: inlineTextInputSchema("assignee").nullable(),
    backfill: z.boolean().optional(),
    description: descriptionInputSchema,
    guild: inlineTextInputSchema("guild").nullable(),
    lease_expires_at: questSchema.shape.lease_expires_at.optional(),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    opened_by: inlineTextInputSchema("opened_by"),
    pr: inlineTextInputSchema("pr").nullable(),
    predicted_files: predictedFilesInputSchema,
    repo: inlineTextInputSchema("repo"),
    session_guild: sessionGuildSchema,
    title: inlineTextInputSchema("title"),
    verdict_notes: verdictNotesInputSchema.nullable(),
  });
export type NewQuest = z.infer<typeof newQuestSchema>;

export const newEvidenceSchema = evidenceSchema
  .omit({
    id: true,
    created_at: true,
  })
  .extend({
    added_by: inlineTextInputSchema("added_by"),
    filename: evidenceFilenameInputSchema,
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    session_guild: sessionGuildSchema,
  });
export type NewEvidence = z.infer<typeof newEvidenceSchema>;

// Chains have no store-generated fields; their complete tuple is the persisted identity.
export const newChainSchema = chainSchema.pick({
  quest_id: true,
  target_id: true,
  type: true,
});
export type NewChain = z.infer<typeof newChainSchema>;

export const laneConflictReferenceSchema = z.strictObject({
  files: z.array(nonEmptyTextSchema).min(1),
  quest_id: displayIdSchema,
});
export type LaneConflictReference = z.infer<typeof laneConflictReferenceSchema>;

export const acceptQuestInputSchema = z.strictObject({
  force: z.boolean().optional(),
  id: displayIdSchema,
  // next uses this guard so the backend checks live hard conflicts in the claim transaction.
  lane_conflict_guard: z.literal(true).optional(),
  lane_conflict_acknowledged: z.array(laneConflictReferenceSchema).optional(),
  lane_conflict_override: z.literal(true).optional(),
  lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
  owner: inlineTextInputSchema("owner"),
  ...sessionAttributionFields,
  session_guild: sessionGuildSchema,
});
export type AcceptQuestInput = z.infer<typeof acceptQuestInputSchema>;

export const acceptResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("accepted"),
    lease_expires_at: questSchema.shape.lease_expires_at,
    quest: questSchema,
  }),
  z.strictObject({
    outcome: z.literal("conflict"),
    lease_expires_at: questSchema.shape.lease_expires_at,
    quest: questSchema,
  }),
  z.strictObject({
    outcome: z.literal("lane-conflict-stale"),
    lane_conflicts: z.array(laneConflictReferenceSchema),
    lease_expires_at: questSchema.shape.lease_expires_at,
    quest: questSchema,
  }),
  z.strictObject({
    outcome: z.literal("lane-conflict"),
    lane_conflicts: z.array(laneConflictReferenceSchema).min(1),
    lease_expires_at: questSchema.shape.lease_expires_at,
    quest: questSchema,
  }),
  z.strictObject({
    outcome: z.literal("guild-mismatch"),
    lease_expires_at: questSchema.shape.lease_expires_at,
    quest: questSchema,
  }),
]);
export type AcceptResult = z.infer<typeof acceptResultSchema>;

export const touchQuestInputSchema = z.strictObject({
  id: displayIdSchema,
  lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
  owner: inlineTextInputSchema("owner"),
  ...sessionAttributionFields,
  session_guild: sessionGuildSchema,
});
export type TouchQuestInput = z.infer<typeof touchQuestInputSchema>;

const verdictTransitionSchema = z
  .strictObject({
    action: z.literal("verdict"),
    actor: inlineTextInputSchema("actor"),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    verdict: verdictSchema,
    notes: notesInputSchema.nullable(),
    retest: z.boolean(),
    duplicate_of: displayIdSchema.nullable(),
  })
  .refine(
    (transition) =>
      transition.verdict === "duplicate"
        ? transition.duplicate_of !== null
        : transition.duplicate_of === null,
    {
      message: "duplicate verdicts require a target; other verdicts reject one",
      path: ["duplicate_of"],
    },
  );

const signoffTransitionSchema = z.strictObject({
  action: z.literal("signoff"),
  actor: inlineTextInputSchema("actor"),
  lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
  ...sessionAttributionFields,
  session_guild: sessionGuildSchema,
  notes: notesInputSchema.nullable(),
});

export const questTransitionSchema = z.union([
  z.strictObject({
    action: z.literal("abandon"),
    actor: inlineTextInputSchema("actor"),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
  }),
  verdictTransitionSchema,
  z.strictObject({
    action: z.literal("turnin"),
    actor: inlineTextInputSchema("actor"),
    actual_files: actualFilesSchema.optional(),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    // Non-code tasks may turn in with evidence only; DATA-MODEL keeps both fields nullable.
    pr: inlineTextInputSchema("pr").nullable(),
    // Keep older CLI clients and persisted turnin event replays valid; agents should supply it.
    summary: summaryInputSchema.optional(),
  }),
  z
    .strictObject({
      action: z.literal("complete"),
      actor: inlineTextInputSchema("actor"),
      lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
      ...sessionAttributionFields,
      session_guild: sessionGuildSchema,
      pr_unverified: z.literal(true).optional(),
      pr_verified_merged: z.literal(true).optional(),
    })
    .refine(
      (transition) =>
        !(transition.pr_unverified === true && transition.pr_verified_merged === true),
      {
        message: "completion can record either an unverified PR or a verified merge, not both",
        path: ["pr_verified_merged"],
      },
    ),
  signoffTransitionSchema,
  z.strictObject({
    action: z.literal("reopen"),
    actor: inlineTextInputSchema("actor"),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    notes: byteBoundedTextSchema("notes", QUEST_INPUT_LIMITS.notesBytes, nonEmptyTextSchema),
  }),
  z.strictObject({
    action: z.literal("cancel"),
    actor: inlineTextInputSchema("actor"),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    reason: byteBoundedTextSchema("reason", QUEST_INPUT_LIMITS.notesBytes, nonEmptyTextSchema),
  }),
  z.strictObject({
    action: z.literal("update"),
    actor: inlineTextInputSchema("actor"),
    lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    changes: z
      .strictObject({
        title: inlineTextInputSchema("title").optional(),
        description: descriptionInputSchema.optional(),
        area: inlineTextInputSchema("area").nullable().optional(),
        priority: z.int().min(1).max(3).optional(),
        guild: inlineTextInputSchema("guild").nullable().optional(),
        verdict_notes: verdictNotesInputSchema.nullable().optional(),
        predicted_files: predictedFilesInputSchema.optional(),
      })
      .refine(
        (changes) => Object.values(changes).some((value) => value !== undefined),
        "at least one change is required",
      ),
  }),
]);
export type QuestTransition = z.infer<typeof questTransitionSchema>;

export const signoffBatchInputSchema = z.strictObject({
  ids: z.array(displayIdSchema).min(1),
  transition: signoffTransitionSchema,
  evidence: z.array(newEvidenceSchema),
});
export type SignoffBatchInput = z.infer<typeof signoffBatchInputSchema>;

export const signoffBatchResultSchema = z.strictObject({
  quests: z.array(questSchema),
  evidence: z.array(evidenceSchema),
});
export type SignoffBatchResult = z.infer<typeof signoffBatchResultSchema>;

export const chainMutationSchema = z.strictObject({
  link: newChainSchema,
  actor: inlineTextInputSchema("actor"),
  lease_ttl_minutes: leaseTtlMinutesSchema.optional(),
  session_guild: sessionGuildSchema,
});
export type ChainMutation = z.infer<typeof chainMutationSchema>;

export const chainResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("added"),
    link: chainSchema,
  }),
  z.strictObject({
    outcome: z.literal("exists"),
    link: chainSchema,
  }),
  z.strictObject({
    outcome: z.literal("cycle"),
    link: chainSchema,
    path: z.array(displayIdSchema).min(2),
  }),
]);
export type ChainResult = z.infer<typeof chainResultSchema>;

export const chainRemovalResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("removed"),
    link: chainSchema,
  }),
  z.strictObject({
    outcome: z.literal("missing"),
    link: chainSchema,
  }),
]);
export type ChainRemovalResult = z.infer<typeof chainRemovalResultSchema>;

export const questFilterSchema = z.strictObject({
  repo: nonEmptyTextSchema.optional(),
  status: questStatusSchema.optional(),
  area: nonEmptyTextSchema.nullable().optional(),
  kind: questKindSchema.optional(),
  assignee: nonEmptyTextSchema.nullable().optional(),
  blocked: z.boolean().optional(),
});
export type QuestFilter = z.infer<typeof questFilterSchema>;

export const eventFilterSchema = z
  .strictObject({
    repo: nonEmptyTextSchema.optional(),
    quest_id: displayIdSchema.optional(),
    after_id: z.int().nonnegative().optional(),
    since: eventBaseSchema.shape.at.optional(),
    until: eventBaseSchema.shape.at.optional(),
    actor: nonEmptyTextSchema.optional(),
    action: eventActionSchema.optional(),
    area: nonEmptyTextSchema.optional(),
  })
  .refine(
    ({ since, until }) =>
      since === undefined || until === undefined || Date.parse(since) <= Date.parse(until),
    { message: "since must be earlier than or equal to until", path: ["until"] },
  );
export type EventFilter = z.infer<typeof eventFilterSchema>;

export const questScopeSchema = z.strictObject({
  repo: nonEmptyTextSchema.nullable(),
});
export type QuestScope = z.infer<typeof questScopeSchema>;

export const repoStatsSchema = z.strictObject({
  repo: nonEmptyTextSchema,
  total: z.int().nonnegative(),
  status_counts: z.partialRecord(questStatusSchema, z.int().nonnegative()),
  verdict_counts: z.partialRecord(verdictSchema, z.int().nonnegative()),
  reopen_count: z.int().nonnegative(),
  assignee_load: z.record(nonEmptyTextSchema, z.int().nonnegative()),
});
export type RepoStats = z.infer<typeof repoStatsSchema>;

export const questStatsSchema = z.strictObject({
  repos: z.array(repoStatsSchema),
});
export type QuestStats = z.infer<typeof questStatsSchema>;

export const questDumpSchema = z.strictObject({
  schema_version: z.literal(STORE_SCHEMA_VERSION),
  quests: z.array(questSchema),
  evidence: z.array(evidenceSchema),
  chains: z.array(chainSchema),
  events: z.array(eventSchema),
});
export type QuestDump = z.infer<typeof questDumpSchema>;

export const federatedListDumpSchema = questDumpSchema.pick({
  schema_version: true,
  quests: true,
  chains: true,
});
export type FederatedListDump = z.infer<typeof federatedListDumpSchema>;
