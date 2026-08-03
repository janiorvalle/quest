import { describe, expect, test } from "bun:test";
import {
  type QuestKind,
  type QuestStatus,
  questStatusSchema,
  type Verdict,
  verdictSchema,
} from "../schema";
import {
  canApplyVerdict,
  initialStatusForKind,
  isDispatchableQuest,
  isLegalStatusTransition,
  isValidBackfill,
  statusAfterClaimRelease,
  statusForRetestVerdict,
  statusForVerdict,
} from ".";

const expectedTransitions = new Set([
  "open:ready",
  "open:accepted",
  "open:dropped",
  "ready:accepted",
  "ready:dropped",
  "accepted:open",
  "accepted:ready",
  "accepted:turned_in",
  "accepted:dropped",
  "turned_in:open",
  "turned_in:ready",
  "turned_in:complete",
  "turned_in:dropped",
  "complete:open",
  "complete:ready",
  "dropped:open",
  "dropped:ready",
]);

describe("status and kind rules", () => {
  test.each([
    ["bug", "open"],
    ["task", "ready"],
  ] satisfies ReadonlyArray<readonly [QuestKind, QuestStatus]>)(
    "%s quests start at %s",
    (kind, expected) => {
      expect(initialStatusForKind(kind)).toBe(expected);
    },
  );

  test("covers every status pair in the transition matrix", () => {
    for (const from of questStatusSchema.options) {
      for (const to of questStatusSchema.options) {
        expect(isLegalStatusTransition(from, to)).toBe(expectedTransitions.has(`${from}:${to}`));
      }
    }
  });

  test("only open or accepted bugs can receive verdicts", () => {
    const kinds = ["bug", "task"] satisfies readonly QuestKind[];
    for (const kind of kinds) {
      for (const status of questStatusSchema.options) {
        expect(canApplyVerdict(kind, status)).toBe(
          kind === "bug" && (status === "open" || status === "accepted"),
        );
      }
    }
  });

  test.each([
    ["task", "ready", true],
    ["bug", "ready", true],
    ["bug", "open", true],
    ["task", "open", false],
    ["bug", "accepted", false],
  ] satisfies ReadonlyArray<readonly [QuestKind, QuestStatus, boolean]>)(
    "%s/%s dispatchability is %s",
    (kind, status, expected) => {
      expect(isDispatchableQuest({ kind, status })).toBe(expected);
    },
  );
});

describe("verdict routing", () => {
  test.each([
    ["actionable", "normal", "ready"],
    ["actionable", "retest", "ready"],
    ["not-reproduced", "normal", "dropped"],
    ["not-reproduced", "retest", "open"],
    ["works-as-intended", "normal", "dropped"],
    ["invalid", "normal", "dropped"],
    ["external", "normal", "dropped"],
    ["duplicate", "normal", "dropped"],
    ["wont-do", "normal", "dropped"],
  ] satisfies ReadonlyArray<readonly [Verdict, "normal" | "retest", QuestStatus]>)(
    "%s with %s routing goes to %s",
    (verdict, routing, expected) => {
      const status =
        routing === "retest" ? statusForRetestVerdict(verdict) : statusForVerdict(verdict);
      expect(status).toBe(expected);
    },
  );

  test("every non-actionable verdict drops unless it is a not-reproduced retest", () => {
    for (const verdict of verdictSchema.options) {
      const expected = verdict === "actionable" ? "ready" : "dropped";
      expect(statusForVerdict(verdict)).toBe(expected);
    }
  });
});

describe("backfill validity", () => {
  test.each([
    ["task", "ready", null, true],
    ["task", "accepted", null, true],
    ["task", "turned_in", null, true],
    ["task", "complete", null, true],
    ["task", "open", null, false],
    ["task", "dropped", null, true],
    ["task", "ready", "actionable", false],
    ["bug", "open", null, true],
    ["bug", "open", "not-reproduced", true],
    ["bug", "ready", "actionable", true],
    ["bug", "accepted", null, true],
    ["bug", "accepted", "not-reproduced", true],
    ["bug", "accepted", "actionable", true],
    ["bug", "turned_in", null, true],
    ["bug", "complete", "not-reproduced", true],
    ["bug", "turned_in", "actionable", true],
    ["bug", "complete", "actionable", true],
    ["bug", "dropped", "not-reproduced", true],
    ["bug", "dropped", "invalid", true],
    ["bug", "dropped", null, false],
    ["bug", "dropped", "actionable", false],
    ["bug", "ready", null, false],
  ] satisfies ReadonlyArray<readonly [QuestKind, QuestStatus, Verdict | null, boolean]>)(
    "%s/%s/%s validity is %s",
    (kind, status, verdict, expected) => {
      expect(isValidBackfill({ kind, status, verdict })).toBe(expected);
    },
  );

  test.each([
    ["task", null, "ready"],
    ["bug", null, "open"],
    ["bug", "not-reproduced", "open"],
    ["bug", "actionable", "ready"],
  ] satisfies ReadonlyArray<readonly [QuestKind, Verdict | null, QuestStatus]>)(
    "%s/%s claim release returns %s",
    (kind, verdict, expected) => {
      expect(statusAfterClaimRelease({ kind, verdict })).toBe(expected);
    },
  );
});
