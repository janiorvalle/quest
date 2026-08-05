import { z } from "zod";

import { questStatusSchema, verdictSchema } from "./enums";
import { MAX_LEASE_TTL_MINUTES } from "./operations";
import { nonEmptyTextSchema } from "./primitives";

const labelMapSchema = z.record(nonEmptyTextSchema, nonEmptyTextSchema);
const objectInputSchema = z.record(z.string(), z.unknown());
const retentionSchema = objectInputSchema
  .pipe(
    z.object({
      daily: z.int().nonnegative().default(7),
      weekly: z.int().nonnegative().default(4),
      monthly: z.int().nonnegative().default(6),
    }),
  )
  .default({ daily: 7, weekly: 4, monthly: 6 });
const dispatchTrustSchema = z.enum(["full", "guarded"]);
const dispatchConfigSchema = objectInputSchema.pipe(
  z.object({
    trust: dispatchTrustSchema.optional(),
    claude_args: z.array(z.string()).default([]),
    codex_args: z.array(z.string()).default([]),
  }),
);

export const storeConfigSchema = objectInputSchema.pipe(
  // Unknown settings are intentionally stripped for forward compatibility. The loader warns
  // with the effective backend so a typo cannot silently change repository routing.
  z.object({
    backend: z.enum(["sqlite", "convex"]).default("sqlite"),
    deployment: nonEmptyTextSchema.optional(),
    convex_deployment: nonEmptyTextSchema.optional(),
    lease_ttl_minutes: z.int().positive().max(MAX_LEASE_TTL_MINUTES).optional(),
  }),
);

export const repoConfigSchema = objectInputSchema.pipe(
  z.object({
    store: storeConfigSchema.optional(),
  }),
);

export const repoConfigEntrySchema = z.union([nonEmptyTextSchema, repoConfigSchema]);

export const convexTokenConfigSchema = objectInputSchema.pipe(
  z.object({
    token: nonEmptyTextSchema,
  }),
);
export const convexConfigSchema = z.record(nonEmptyTextSchema, convexTokenConfigSchema);

export const configSchema = objectInputSchema.pipe(
  z.object({
    identity: nonEmptyTextSchema.optional(),
    guild: nonEmptyTextSchema.optional(),
    store: storeConfigSchema.default({ backend: "sqlite" }),
    repos: z.record(nonEmptyTextSchema, repoConfigEntrySchema).default({}),
    convex: convexConfigSchema.optional(),
    areas: z.record(nonEmptyTextSchema, z.array(nonEmptyTextSchema)).default({}),
    colors: z.partialRecord(questStatusSchema, nonEmptyTextSchema).default({}),
    labels: objectInputSchema
      .pipe(
        z.object({
          areas: z.record(nonEmptyTextSchema, labelMapSchema).default({}),
          statuses: z.partialRecord(questStatusSchema, nonEmptyTextSchema).default({}),
          verdicts: z.partialRecord(verdictSchema, nonEmptyTextSchema).default({}),
        }),
      )
      .default({ areas: {}, statuses: {}, verdicts: {} }),
    editor: nonEmptyTextSchema.optional(),
    // Keep viewer preferences under one stable section so future display settings do not need a
    // new top-level shape.
    tui: z
      .object({
        mouse: z.boolean().optional(),
        theme: nonEmptyTextSchema.optional(),
      })
      .optional(),
    evidence_dir: nonEmptyTextSchema.optional(),
    dispatch: dispatchConfigSchema.optional(),
    backup: objectInputSchema
      .pipe(
        z.object({
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
