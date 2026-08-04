import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Keep this document model aligned with src/schema/entities.ts and the SQLite DDL.
// The application payload is intentionally stored with the same names and scalar shapes so
// exports can move between providers without a translation step.
const questFields = {
  id: v.number(),
  repo: v.string(),
  area: v.union(v.string(), v.null()),
  kind: v.union(v.literal("bug"), v.literal("task")),
  title: v.string(),
  description: v.string(),
  opened_by: v.string(),
  guild: v.union(v.string(), v.null()),
  assignee: v.union(v.string(), v.null()),
  status: v.union(
    v.literal("open"),
    v.literal("ready"),
    v.literal("accepted"),
    v.literal("turned_in"),
    v.literal("complete"),
    v.literal("dropped"),
  ),
  verdict: v.union(
    v.literal("actionable"),
    v.literal("not-reproduced"),
    v.literal("works-as-intended"),
    v.literal("invalid"),
    v.literal("external"),
    v.literal("duplicate"),
    v.literal("wont-do"),
    v.null(),
  ),
  verdict_notes: v.union(v.string(), v.null()),
  priority: v.number(),
  pr: v.union(v.string(), v.null()),
  predicted_files: v.array(v.string()),
  reopen_count: v.number(),
  lease_expires_at: v.union(v.string(), v.null()),
  created_at: v.string(),
  updated_at: v.string(),
};
const evidenceFields = {
  id: v.number(),
  quest_id: v.number(),
  sha256: v.string(),
  filename: v.string(),
  kind: v.union(v.literal("screenshot"), v.literal("doc"), v.literal("log"), v.literal("other")),
  stage: v.union(
    v.literal("report"),
    v.literal("investigation"),
    v.literal("fix"),
    v.literal("verify"),
    v.literal("signoff"),
  ),
  added_by: v.string(),
  created_at: v.string(),
};
const chainFields = {
  quest_id: v.number(),
  target_id: v.number(),
  type: v.union(v.literal("requires"), v.literal("duplicate-of")),
};
const memberFields = {
  name: v.string(),
  status: v.union(v.literal("invited"), v.literal("active"), v.literal("removed")),
  created_at: v.string(),
  updated_at: v.string(),
  token_hashes: v.optional(
    v.array(
      v.object({
        key_id: v.string(),
        hash: v.string(),
        expires_at: v.union(v.number(), v.null()),
      }),
    ),
  ),
};
const eventFields = {
  id: v.number(),
  quest_id: v.number(),
  at: v.string(),
  actor: v.string(),
  action: v.union(
    v.literal("add"),
    v.literal("accept"),
    v.literal("abandon"),
    v.literal("verdict"),
    v.literal("turnin"),
    v.literal("complete"),
    v.literal("reopen"),
    v.literal("cancel"),
    v.literal("update"),
    v.literal("chain"),
    v.literal("touch"),
    v.literal("signoff"),
  ),
  detail: v.any(),
};

export default defineSchema({
  quests: defineTable(questFields)
    .index("by_display_id", ["id"])
    .index("by_repo", ["repo"])
    .index("by_status", ["status"]),
  evidence: defineTable(evidenceFields).index("by_quest_id", ["quest_id"]),
  chains: defineTable(chainFields)
    .index("by_quest_id", ["quest_id"])
    .index("by_target_id", ["target_id"]),
  members: defineTable(memberFields).index("by_name", ["name"]).index("by_status", ["status"]),
  events: defineTable(eventFields).index("by_quest_id", ["quest_id"]),
  blobs: defineTable({
    sha256: v.string(),
    storage_id: v.id("_storage"),
    bytes: v.number(),
  }).index("by_sha256", ["sha256"]),
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
  restore_leases: defineTable({
    token: v.string(),
    expires_at: v.string(),
    expected_hash: v.string(),
    lease_cutoff: v.string(),
    activated: v.boolean(),
    replacement_hash: v.union(v.string(), v.null()),
    committed: v.optional(v.boolean()),
  }).index("by_token", ["token"]),
  migration_fences: defineTable({
    repo: v.string(),
    target_backend: v.string(),
    created_at: v.string(),
    lease_token: v.optional(v.string()),
    committed: v.optional(v.boolean()),
    recovery_hash: v.optional(v.string()),
    recovery_cutoff: v.optional(v.string()),
    unfenced: v.optional(v.boolean()),
    recovery_restore_token: v.optional(v.string()),
  }).index("by_repo", ["repo"]),
  restore_staged_quests: defineTable({ token: v.string(), ...questFields }).index("by_token", [
    "token",
  ]),
  restore_staged_evidence: defineTable({ token: v.string(), ...evidenceFields }).index("by_token", [
    "token",
  ]),
  restore_staged_chains: defineTable({ token: v.string(), ...chainFields }).index("by_token", [
    "token",
  ]),
  restore_staged_events: defineTable({ token: v.string(), ...eventFields }).index("by_token", [
    "token",
  ]),
});
