import { z } from "zod";

export const questStatusSchema = z.enum([
  "open",
  "ready",
  "accepted",
  "turned_in",
  "complete",
  "dropped",
]);
export type QuestStatus = z.infer<typeof questStatusSchema>;

export const questKindSchema = z.enum(["bug", "task"]);
export type QuestKind = z.infer<typeof questKindSchema>;

export const verdictSchema = z.enum([
  "actionable",
  "not-reproduced",
  "works-as-intended",
  "invalid",
  "external",
  "duplicate",
  "wont-do",
]);
export type Verdict = z.infer<typeof verdictSchema>;

export const chainTypeSchema = z.enum(["requires", "duplicate-of"]);
export type ChainType = z.infer<typeof chainTypeSchema>;

export const evidenceKindSchema = z.enum(["screenshot", "doc", "log", "other"]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const evidenceStageSchema = z.enum(["report", "investigation", "fix", "verify"]);
export type EvidenceStage = z.infer<typeof evidenceStageSchema>;

export const eventActionSchema = z.enum([
  "add",
  "accept",
  "abandon",
  "verdict",
  "turnin",
  "complete",
  "reopen",
  "cancel",
  "update",
  "chain",
  "touch",
]);
export type EventAction = z.infer<typeof eventActionSchema>;
