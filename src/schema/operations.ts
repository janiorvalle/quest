import { z } from "zod";

import { chainSchema, eventBaseSchema, eventSchema, evidenceSchema, questSchema } from "./entities";
import { eventActionSchema, questKindSchema, questStatusSchema, verdictSchema } from "./enums";
import { nonEmptyTextSchema } from "./primitives";

const displayIdSchema = z.int().positive();

// Lifecycle input fields are part of the Convex wire contract; deploy the matching backend
// before a client that sends session attribution fields can write to it.
export const STORE_SCHEMA_VERSION = 5;

const sessionGuildSchema = nonEmptyTextSchema.nullable().optional();
const sessionAttributionFields = {
  session_model: nonEmptyTextSchema.optional(),
  session_effort: nonEmptyTextSchema.optional(),
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
    backfill: z.boolean().optional(),
    lease_expires_at: questSchema.shape.lease_expires_at.optional(),
    session_guild: sessionGuildSchema,
  });
export type NewQuest = z.infer<typeof newQuestSchema>;

export const newEvidenceSchema = evidenceSchema
  .omit({
    id: true,
    created_at: true,
  })
  .extend({
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
  owner: nonEmptyTextSchema,
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
  owner: nonEmptyTextSchema,
  ...sessionAttributionFields,
  session_guild: sessionGuildSchema,
});
export type TouchQuestInput = z.infer<typeof touchQuestInputSchema>;

const verdictTransitionSchema = z
  .strictObject({
    action: z.literal("verdict"),
    actor: nonEmptyTextSchema,
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    verdict: verdictSchema,
    notes: z.string().nullable(),
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

export const questTransitionSchema = z.union([
  z.strictObject({
    action: z.literal("abandon"),
    actor: nonEmptyTextSchema,
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
  }),
  verdictTransitionSchema,
  z.strictObject({
    action: z.literal("turnin"),
    actor: nonEmptyTextSchema,
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    // Non-code tasks may turn in with evidence only; DATA-MODEL keeps both fields nullable.
    pr: nonEmptyTextSchema.nullable(),
    // Keep older CLI clients and persisted turnin event replays valid; agents should supply it.
    summary: nonEmptyTextSchema.optional(),
  }),
  z
    .strictObject({
      action: z.literal("complete"),
      actor: nonEmptyTextSchema,
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
  z.strictObject({
    action: z.literal("reopen"),
    actor: nonEmptyTextSchema,
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    notes: nonEmptyTextSchema,
  }),
  z.strictObject({
    action: z.literal("cancel"),
    actor: nonEmptyTextSchema,
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    reason: nonEmptyTextSchema,
  }),
  z.strictObject({
    action: z.literal("update"),
    actor: nonEmptyTextSchema,
    ...sessionAttributionFields,
    session_guild: sessionGuildSchema,
    changes: z
      .strictObject({
        title: nonEmptyTextSchema.optional(),
        description: z.string().optional(),
        area: nonEmptyTextSchema.nullable().optional(),
        priority: z.int().min(1).max(3).optional(),
        guild: nonEmptyTextSchema.nullable().optional(),
        verdict_notes: z.string().nullable().optional(),
        predicted_files: z.array(nonEmptyTextSchema).optional(),
      })
      .refine(
        (changes) => Object.values(changes).some((value) => value !== undefined),
        "at least one change is required",
      ),
  }),
]);
export type QuestTransition = z.infer<typeof questTransitionSchema>;

export const chainMutationSchema = z.strictObject({
  link: newChainSchema,
  actor: nonEmptyTextSchema,
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
