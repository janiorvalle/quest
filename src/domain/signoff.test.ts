import { describe, expect, test } from "bun:test";

import { hasSignoffEvent, isQuestSigned, signoffNotCompleteMessage } from ".";

describe("QA sign-off state", () => {
  test("derives signed only from completion and a sign-off event", () => {
    expect(hasSignoffEvent([{ action: "complete" }, { action: "signoff" }])).toBeTrue();
    expect(
      isQuestSigned({ status: "complete" }, [{ action: "complete" }, { action: "signoff" }]),
    ).toBeTrue();
    expect(isQuestSigned({ status: "turned_in" }, [{ action: "signoff" }])).toBeFalse();
    expect(isQuestSigned({ status: "complete" }, [{ action: "complete" }])).toBeFalse();
  });

  test("requires a new attestation after a reopened quest is completed again", () => {
    const reopened = [
      { action: "complete" as const },
      { action: "signoff" as const },
      { action: "reopen" as const },
      { action: "complete" as const },
    ];

    expect(isQuestSigned({ status: "complete" }, reopened)).toBeFalse();
    expect(isQuestSigned({ status: "complete" }, [...reopened, { action: "signoff" }])).toBeTrue();
  });

  test("explains the next step for a non-complete quest", () => {
    expect(signoffNotCompleteMessage(42, "turned_in")).toBe(
      "[SIGNOFF_NOT_COMPLETE] quest 42 is turned_in; sign-off applies only after review, merge, and completion. Wait for the quest to reach complete, then retry `quest signoff 42`.",
    );
  });
});
