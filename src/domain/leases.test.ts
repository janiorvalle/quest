import { describe, expect, test } from "bun:test";
import type { Quest } from "../schema";
import { MAX_LEASE_TTL_MINUTES } from "../schema";
import {
  assertActiveLeaseOwner,
  assertLeaseOwner,
  DEFAULT_LEASE_TTL_MINUTES,
  leaseExpiry,
  normalizeLeaseTtlMinutes,
  transitionRequiresLeaseOwner,
} from "./leases";

const acceptedQuest = {
  id: 42,
  repo: "quest",
  area: null,
  kind: "task",
  title: "lease guard",
  description: "lease guard",
  opened_by: "owner",
  guild: null,
  assignee: "owner",
  status: "accepted",
  verdict: null,
  verdict_notes: null,
  priority: 2,
  pr: null,
  predicted_files: [],
  reopen_count: 0,
  lease_expires_at: "2026-08-02T00:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
} satisfies Quest;

describe("lease durations", () => {
  test("uses a 24-hour default", () => {
    expect(DEFAULT_LEASE_TTL_MINUTES).toBe(24 * 60);
    expect(leaseExpiry("2026-08-01T00:00:00Z")).toBe("2026-08-02T00:00:00.000Z");
  });

  test("accepts a positive whole-minute override", () => {
    expect(normalizeLeaseTtlMinutes(45)).toBe(45);
    expect(leaseExpiry("2026-08-01T00:00:00Z", 45)).toBe("2026-08-01T00:45:00.000Z");
  });

  test("rejects invalid durations", () => {
    expect(() => normalizeLeaseTtlMinutes(0)).toThrow(
      "lease TTL must be a positive whole number of minutes",
    );
    expect(() => normalizeLeaseTtlMinutes(1.5)).toThrow(
      "lease TTL must be a positive whole number of minutes",
    );
    expect(() => normalizeLeaseTtlMinutes(MAX_LEASE_TTL_MINUTES + 1)).toThrow(
      "no greater than 100000000",
    );
  });
});

describe("lease ownership guards", () => {
  test("uses stable codes for held, missing, expired, and inactive leases", () => {
    expect(() =>
      assertLeaseOwner(acceptedQuest, "reviewer", "2026-08-01T01:00:00.000Z", false),
    ).toThrow("[QUEST_LEASE_HELD] quest 42 lease owned by owner; stop, owner has it");
    expect(() =>
      assertLeaseOwner(acceptedQuest, "former-owner", "2026-08-01T01:00:00.000Z", true),
    ).toThrow("[QUEST_LEASE_HELD] quest 42 lease owned by owner; stop, owner has it");
    expect(() =>
      assertLeaseOwner(
        { ...acceptedQuest, assignee: null },
        "reviewer",
        "2026-08-01T01:00:00.000Z",
        false,
      ),
    ).toThrow("[QUEST_LEASE_REQUIRED]");
    expect(() =>
      assertLeaseOwner(acceptedQuest, "owner", "2026-08-03T00:00:00.000Z", false),
    ).toThrow("[QUEST_LEASE_EXPIRED]");
    expect(() =>
      assertActiveLeaseOwner(
        { ...acceptedQuest, status: "turned_in", lease_expires_at: null },
        "owner",
        "2026-08-01T01:00:00.000Z",
      ),
    ).toThrow("[QUEST_NOT_ACCEPTED]");
  });

  test("scopes ownership to implementer actions on accepted quests", () => {
    for (const action of ["abandon", "cancel", "turnin", "update", "verdict"] as const) {
      expect(transitionRequiresLeaseOwner(acceptedQuest, action)).toBeTrue();
    }
    for (const action of ["complete", "reopen", "signoff"] as const) {
      expect(transitionRequiresLeaseOwner(acceptedQuest, action)).toBeFalse();
    }
    expect(
      transitionRequiresLeaseOwner({ ...acceptedQuest, status: "turned_in" }, "complete"),
    ).toBeFalse();
    expect(
      transitionRequiresLeaseOwner({ ...acceptedQuest, status: "turned_in" }, "cancel"),
    ).toBeFalse();
  });
});
