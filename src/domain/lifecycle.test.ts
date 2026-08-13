import { describe, expect, test } from "bun:test";
import {
  type QuestKind,
  type QuestStatus,
  type QuestTransition,
  questStatusSchema,
  type Verdict,
  verdictSchema,
} from "../schema";
import {
  assertLifecycleActionAllowed,
  canApplyVerdict,
  initialStatusForKind,
  isDispatchableQuest,
  isLegalStatusTransition,
  isValidBackfill,
  LifecycleInvalidStateError,
  statusAfterClaimRelease,
  statusForRetestVerdict,
  statusForVerdict,
} from ".";

function lifecycleQuest(kind: QuestKind, status: QuestStatus) {
  return { id: 42, kind, status };
}

const expectedTransitions = new Set([
  "open:accepted",
  "open:dropped",
  "accepted:open",
  "accepted:turned_in",
  "accepted:dropped",
  "turned_in:open",
  "turned_in:complete",
  "turned_in:dropped",
  "complete:open",
  "dropped:open",
]);

describe("status and kind rules", () => {
  test.each([
    ["bug", "open"],
    ["task", "open"],
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
    ["task", "open", true],
    ["bug", "open", true],
    ["task", "complete", false],
    ["bug", "accepted", false],
  ] satisfies ReadonlyArray<readonly [QuestKind, QuestStatus, boolean]>)(
    "%s/%s dispatchability is %s",
    (kind, status, expected) => {
      expect(isDispatchableQuest({ kind, status })).toBe(expected);
    },
  );
});

describe("lifecycle action validation", () => {
  test.each([
    ["abandon", "accepted"],
    ["verdict", "open"],
    ["turnin", "accepted"],
    ["complete", "turned_in"],
    ["signoff", "complete"],
    ["cancel", "open"],
    ["reopen", "dropped"],
    ["update", "complete"],
  ] satisfies ReadonlyArray<readonly [QuestTransition["action"], QuestStatus]>)(
    "%s accepts %s",
    (action, status) => {
      expect(() =>
        assertLifecycleActionAllowed(lifecycleQuest("bug", status), action),
      ).not.toThrow();
    },
  );

  test.each([
    ["abandon", "bug", "open", "ABANDON_INVALID_STATE"],
    ["verdict", "task", "open", "VERDICT_INVALID_STATE"],
    ["turnin", "bug", "open", "TURNIN_INVALID_STATE"],
    ["complete", "bug", "open", "COMPLETE_INVALID_STATE"],
    ["cancel", "bug", "complete", "CANCEL_INVALID_STATE"],
    ["reopen", "bug", "open", "REOPEN_INVALID_STATE"],
  ] satisfies ReadonlyArray<
    readonly [QuestTransition["action"], QuestKind, QuestStatus, LifecycleInvalidStateError["code"]]
  >)("%s rejects %s/%s with %s", (action, kind, status, code) => {
    let rejection: unknown;
    try {
      assertLifecycleActionAllowed(lifecycleQuest(kind, status), action);
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(LifecycleInvalidStateError);
    expect(rejection).toMatchObject({ code });
    expect((rejection as Error).message).toContain(`quest 42 is ${status}`);
    expect((rejection as Error).message).toContain("No state changed");
  });

  test("complete tells the receiver how and when to retry", () => {
    expect(() => assertLifecycleActionAllowed(lifecycleQuest("bug", "open"), "complete")).toThrow(
      "[COMPLETE_INVALID_STATE] quest 42 is open; completion requires turned_in. If it is open, run `quest accept 42`; if it is complete or dropped, reopen it before accepting.",
    );
  });

  test("signoff keeps its existing stable error contract", () => {
    expect(() =>
      assertLifecycleActionAllowed(lifecycleQuest("bug", "turned_in"), "signoff"),
    ).toThrow(
      "[SIGNOFF_NOT_COMPLETE] quest 42 is turned_in; sign-off applies only after review, merge, and completion.",
    );
  });
});

describe("verdict routing", () => {
  test.each([
    ["actionable", "normal", "open"],
    ["actionable", "retest", "open"],
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
      const expected = verdict === "actionable" ? "open" : "dropped";
      expect(statusForVerdict(verdict)).toBe(expected);
    }
  });
});

describe("backfill validity", () => {
  test.each([
    ["task", "open", null, true],
    ["task", "accepted", null, true],
    ["task", "turned_in", null, true],
    ["task", "complete", null, true],
    ["task", "dropped", null, true],
    ["task", "open", "actionable", false],
    ["bug", "open", null, true],
    ["bug", "open", "not-reproduced", true],
    ["bug", "open", "actionable", true],
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
  ] satisfies ReadonlyArray<readonly [QuestKind, QuestStatus, Verdict | null, boolean]>)(
    "%s/%s/%s validity is %s",
    (kind, status, verdict, expected) => {
      expect(isValidBackfill({ kind, status, verdict })).toBe(expected);
    },
  );

  test("claim release returns to open", () => {
    expect(statusAfterClaimRelease()).toBe("open");
  });
});
