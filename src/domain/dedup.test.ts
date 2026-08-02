import { describe, expect, test } from "bun:test";

import { scoreDedupCandidate } from ".";

describe("dedup scoring", () => {
  test("normalizes case, punctuation, and whitespace", () => {
    const left = { title: "Login: button fails!", description: "Clicking does nothing." };
    const right = { title: "  login button FAILS ", description: "clicking does nothing" };
    expect(scoreDedupCandidate(left, right)).toBe(1);
  });

  test("weights title above description and falls back to title when detail is absent", () => {
    expect(
      scoreDedupCandidate(
        { title: "save button fails", description: "on profile" },
        { title: "save button fails", description: "on settings" },
      ),
    ).toBe(0.8);
    expect(
      scoreDedupCandidate(
        { title: "save button fails", description: "" },
        { title: "save button fails", description: "on settings" },
      ),
    ).toBe(1);
  });

  test("is symmetric, bounded, and zero for disjoint text", () => {
    const samples = [
      { title: "", description: "" },
      { title: "alpha beta", description: "gamma" },
      { title: "alpha delta", description: "epsilon" },
      { title: "completely distinct", description: "words" },
    ];
    for (const left of samples) {
      for (const right of samples) {
        const forward = scoreDedupCandidate(left, right);
        expect(forward).toBeGreaterThanOrEqual(0);
        expect(forward).toBeLessThanOrEqual(1);
        expect(forward).toBe(scoreDedupCandidate(right, left));
      }
    }
    expect(
      scoreDedupCandidate(
        { title: "alpha beta", description: "gamma" },
        { title: "completely distinct", description: "words" },
      ),
    ).toBe(0);
  });
});
