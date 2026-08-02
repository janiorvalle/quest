import { z } from "zod";

import { sha256Schema } from "./entities";
import { nonEmptyTextSchema } from "./primitives";

export const migrationBackendSchema = z.enum(["sqlite", "convex"]);

export const migrationCountsSchema = z.strictObject({
  quests: z.int().nonnegative(),
  evidence: z.int().nonnegative(),
  chains: z.int().nonnegative(),
  events: z.int().nonnegative(),
});
export type MigrationCounts = z.infer<typeof migrationCountsSchema>;

export const migrationResultSchema = z.strictObject({
  repository: nonEmptyTextSchema,
  source_backend: migrationBackendSchema,
  target_backend: migrationBackendSchema,
  deployment: nonEmptyTextSchema.nullable(),
  backups: z.strictObject({
    source: nonEmptyTextSchema,
    destination: nonEmptyTextSchema.nullable(),
  }),
  counts: migrationCountsSchema,
  spot_checks: z.strictObject({
    first_quest_id: z.int().positive().nullable(),
    last_quest_id: z.int().positive().nullable(),
    evidence_hashes: z.array(sha256Schema),
  }),
  recovered: z.boolean().default(false),
  verified: z.literal(true),
});
export type MigrationResult = z.infer<typeof migrationResultSchema>;
