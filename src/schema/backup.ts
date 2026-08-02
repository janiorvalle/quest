import { z } from "zod";

import { sha256Schema } from "./entities";

export const BACKUP_MANIFEST_SCHEMA = "quest.backup/v1";

const backupFileSchema = z.strictObject({
  sha256: sha256Schema,
  bytes: z.int().nonnegative(),
});

export const backupCountsSchema = z.strictObject({
  quests: z.int().nonnegative(),
  evidence: z.int().nonnegative(),
  chains: z.int().nonnegative(),
  events: z.int().nonnegative(),
});
export type BackupCounts = z.infer<typeof backupCountsSchema>;

export const backupManifestSchema = z.strictObject({
  schema: z.literal(BACKUP_MANIFEST_SCHEMA),
  created_at: z.iso.datetime(),
  store_schema_version: z.int().positive(),
  counts: backupCountsSchema,
  files: z.strictObject({
    "quest.db": backupFileSchema,
    "export.json": backupFileSchema,
    "config.toml": backupFileSchema,
  }),
  evidence: z.strictObject({
    count: z.int().nonnegative(),
    total_bytes: z.int().nonnegative(),
  }),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;
