import { z } from "zod";

import { questStatusSchema, verdictSchema } from "./enums";
import { nonEmptyTextSchema } from "./primitives";

const labelMapSchema = z.record(nonEmptyTextSchema, nonEmptyTextSchema);
const objectInputSchema = z.record(z.string(), z.unknown());
const retentionSchema = objectInputSchema
  .pipe(
    z.strictObject({
      daily: z.int().nonnegative().default(7),
      weekly: z.int().nonnegative().default(4),
      monthly: z.int().nonnegative().default(6),
    }),
  )
  .default({ daily: 7, weekly: 4, monthly: 6 });
const dispatchTrustSchema = z.enum(["full", "guarded"]);
const dispatchConfigSchema = objectInputSchema.pipe(
  z.strictObject({
    trust: dispatchTrustSchema.optional(),
    claude_args: z.array(z.string()).default([]),
    codex_args: z.array(z.string()).default([]),
  }),
);

export const storeConfigSchema = objectInputSchema.pipe(
  z.strictObject({
    backend: z.enum(["sqlite", "convex"]).default("sqlite"),
    deployment: nonEmptyTextSchema.optional(),
    convex_deployment: nonEmptyTextSchema.optional(),
  }),
);

export const repoConfigSchema = objectInputSchema.pipe(
  z.strictObject({
    store: storeConfigSchema.optional(),
  }),
);

export const repoConfigEntrySchema = z.union([nonEmptyTextSchema, repoConfigSchema]);

export const convexTokenConfigSchema = objectInputSchema.pipe(
  z.strictObject({
    token: nonEmptyTextSchema,
  }),
);
export const convexConfigSchema = z.record(nonEmptyTextSchema, convexTokenConfigSchema);

export const configSchema = objectInputSchema.pipe(
  z.strictObject({
    identity: nonEmptyTextSchema.optional(),
    guild: nonEmptyTextSchema.optional(),
    store: storeConfigSchema.default({ backend: "sqlite" }),
    repos: z.record(nonEmptyTextSchema, repoConfigEntrySchema).default({}),
    convex: convexConfigSchema.optional(),
    areas: z.record(nonEmptyTextSchema, z.array(nonEmptyTextSchema)).default({}),
    colors: z.partialRecord(questStatusSchema, nonEmptyTextSchema).default({}),
    labels: objectInputSchema
      .pipe(
        z.strictObject({
          areas: z.record(nonEmptyTextSchema, labelMapSchema).default({}),
          statuses: z.partialRecord(questStatusSchema, nonEmptyTextSchema).default({}),
          verdicts: z.partialRecord(verdictSchema, nonEmptyTextSchema).default({}),
        }),
      )
      .default({ areas: {}, statuses: {}, verdicts: {} }),
    editor: nonEmptyTextSchema.optional(),
    tui: z
      .strictObject({
        theme: nonEmptyTextSchema.optional(),
      })
      .optional(),
    evidence_dir: nonEmptyTextSchema.optional(),
    dispatch: dispatchConfigSchema.optional(),
    backup: objectInputSchema
      .pipe(
        z.strictObject({
          root: nonEmptyTextSchema.optional(),
          retention: retentionSchema,
        }),
      )
      .default({ retention: { daily: 7, weekly: 4, monthly: 6 } }),
  }),
);
export type Config = z.infer<typeof configSchema>;
export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type RepoConfigEntry = z.infer<typeof repoConfigEntrySchema>;
export type StoreConfig = z.infer<typeof storeConfigSchema>;
export type ConvexTokenConfig = z.infer<typeof convexTokenConfigSchema>;
