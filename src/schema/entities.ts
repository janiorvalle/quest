import { z } from "zod";

import {
  chainTypeSchema,
  eventActionSchema,
  evidenceKindSchema,
  evidenceStageSchema,
  questKindSchema,
  questStatusSchema,
  verdictSchema,
} from "./enums";
import { nonEmptyTextSchema } from "./primitives";

const displayIdSchema = z.int().positive();
const timestampSchema = z.iso.datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof sha256Schema>;

export const questSchema = z.strictObject({
  id: displayIdSchema,
  repo: nonEmptyTextSchema,
  area: nonEmptyTextSchema.nullable(),
  kind: questKindSchema,
  title: nonEmptyTextSchema,
  description: z.string(),
  opened_by: nonEmptyTextSchema,
  guild: nonEmptyTextSchema.nullable(),
  assignee: nonEmptyTextSchema.nullable(),
  status: questStatusSchema,
  verdict: verdictSchema.nullable(),
  verdict_notes: z.string().nullable(),
  priority: z.int().min(1).max(3),
  pr: nonEmptyTextSchema.nullable(),
  predicted_files: z.array(nonEmptyTextSchema),
  reopen_count: z.int().nonnegative(),
  lease_expires_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type Quest = z.infer<typeof questSchema>;

export const evidenceSchema = z.strictObject({
  id: z.int().positive(),
  quest_id: displayIdSchema,
  sha256: sha256Schema,
  filename: nonEmptyTextSchema,
  kind: evidenceKindSchema,
  stage: evidenceStageSchema,
  added_by: nonEmptyTextSchema,
  created_at: timestampSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const chainSchema = z.strictObject({
  quest_id: displayIdSchema,
  target_id: displayIdSchema,
  type: chainTypeSchema,
});
export type Chain = z.infer<typeof chainSchema>;

const eventFields = {
  id: z.int().positive(),
  quest_id: displayIdSchema,
  at: timestampSchema,
  actor: nonEmptyTextSchema,
  action: eventActionSchema,
  detail: z.json(),
};

export const eventBaseSchema = z.strictObject(eventFields);
export const federatedEventSchema = z.strictObject({
  ...eventFields,
  repo: nonEmptyTextSchema,
});
export const eventSchema = z.union([eventBaseSchema, federatedEventSchema]);
export type Event = z.infer<typeof eventSchema>;

export function eventRepository(event: Event): string | undefined {
  return "repo" in event ? event.repo : undefined;
}
