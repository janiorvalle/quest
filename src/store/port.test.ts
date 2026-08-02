import { describe, expect, test } from "bun:test";

import {
  acceptQuestInputSchema,
  acceptResultSchema,
  chainMutationSchema,
  chainRemovalResultSchema,
  chainResultSchema,
  eventFilterSchema,
  newChainSchema,
  newEvidenceSchema,
  newQuestSchema,
  questDumpSchema,
  questFilterSchema,
  questScopeSchema,
  questStatsSchema,
  questTransitionSchema,
} from "../schema";

describe("store port boundary schemas", () => {
  test("validates a normal or backfilled quest input without store-owned fields", () => {
    const parsed = newQuestSchema.safeParse({
      repo: "quest",
      area: "store",
      kind: "task",
      title: "Define ports",
      description: "Keep adapters replaceable.",
      opened_by: "janior",
      assignee: null,
      status: "ready",
      verdict: null,
      verdict_notes: null,
      priority: 1,
      pr: null,
      guild: null,
      predicted_files: ["src/store/port.ts"],
      reopen_count: 0,
      backfill: true,
    });
    expect(parsed.success).toBeTrue();
    if (parsed.success) {
      expect(parsed.data.backfill).toBeTrue();
    }
  });

  test("keeps transitions domain-shaped rather than exposing generic field updates", () => {
    expect(
      acceptQuestInputSchema.safeParse({ id: 5, owner: "janior/codex-w3" }).success,
    ).toBeTrue();
    expect(acceptQuestInputSchema.safeParse({ id: 5, owner: "  " }).success).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "verdict",
        actor: "janior",
        verdict: "not-reproduced",
        notes: "Needs another environment.",
        retest: true,
        duplicate_of: null,
      }).success,
    ).toBeTrue();
    expect(
      questTransitionSchema.safeParse({
        action: "verdict",
        actor: "janior",
        verdict: "duplicate",
        notes: null,
        retest: false,
        duplicate_of: null,
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "verdict",
        actor: "janior",
        verdict: "invalid",
        notes: null,
        retest: false,
        duplicate_of: 3,
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "turnin",
        actor: "janior",
        pr: null,
        session_guild: null,
      }).success,
    ).toBeTrue();
    expect(
      questTransitionSchema.safeParse({
        action: "complete",
        actor: "janior",
        session_guild: null,
        pr_verified_merged: true,
      }).success,
    ).toBeTrue();
    expect(
      questTransitionSchema.safeParse({
        action: "complete",
        actor: "janior",
        session_guild: null,
        pr_unverified: true,
      }).success,
    ).toBeTrue();
    expect(
      questTransitionSchema.safeParse({
        action: "complete",
        actor: "janior",
        force: true,
        session_guild: null,
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "complete",
        actor: "janior",
        pr_unverified: true,
        pr_verified_merged: true,
        session_guild: null,
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "cancel",
        actor: "janior",
        reason: "superseded",
        session_guild: null,
      }).success,
    ).toBeTrue();
    expect(
      questTransitionSchema.safeParse({
        action: "update",
        actor: "janior",
        changes: { status: "complete" },
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "update",
        actor: "janior",
        changes: {},
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "update",
        actor: "janior",
        changes: { title: undefined },
      }).success,
    ).toBeFalse();
    expect(
      questTransitionSchema.safeParse({
        action: "update",
        actor: "janior",
        changes: { area: null },
      }).success,
    ).toBeTrue();
  });

  test("exports validation schemas for every port input and result family", () => {
    const schemas = [
      acceptQuestInputSchema,
      acceptResultSchema,
      chainMutationSchema,
      chainRemovalResultSchema,
      chainResultSchema,
      eventFilterSchema,
      newChainSchema,
      newEvidenceSchema,
      questDumpSchema,
      questFilterSchema,
      questScopeSchema,
      questStatsSchema,
    ];

    expect(schemas).toHaveLength(12);
    for (const schema of schemas) {
      expect(typeof schema.safeParse).toBe("function");
    }
  });

  test("accepts only nonnegative integer event cursors", () => {
    expect(eventFilterSchema.safeParse({ after_id: 0 }).success).toBeTrue();
    expect(eventFilterSchema.safeParse({ after_id: 12 }).success).toBeTrue();
    expect(eventFilterSchema.safeParse({ after_id: -1 }).success).toBeFalse();
    expect(eventFilterSchema.safeParse({ after_id: 1.5 }).success).toBeFalse();
  });
});
