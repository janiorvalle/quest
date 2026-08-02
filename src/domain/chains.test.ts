import { describe, expect, test } from "bun:test";
import type { Chain } from "../schema";
import { findChainCyclePath, wouldCreateChainCycle } from ".";

const requires = (questId: number, targetId: number) =>
  ({ quest_id: questId, target_id: targetId, type: "requires" }) satisfies Chain;

describe("chain cycle detection", () => {
  test("rejects self-cycles and direct cycles", () => {
    expect(wouldCreateChainCycle([], requires(1, 1))).toBeTrue();
    expect(wouldCreateChainCycle([requires(1, 2)], requires(2, 1))).toBeTrue();
  });

  test("finds a cycle through a deep DFS path", () => {
    const links = [requires(1, 2), requires(2, 3), requires(3, 4), requires(4, 5)];
    expect(wouldCreateChainCycle(links, requires(5, 1))).toBeTrue();
    expect(findChainCyclePath(links, requires(5, 1))).toEqual([5, 1, 2, 3, 4, 5]);
  });

  test("returns a deterministic shortest offending path", () => {
    const links = [requires(1, 4), requires(1, 2), requires(2, 3), requires(3, 6), requires(4, 6)];
    expect(findChainCyclePath(links, requires(6, 1))).toEqual([6, 1, 4, 6]);
    expect(findChainCyclePath([], requires(1, 1))).toEqual([1, 1]);
  });

  test("allows acyclic branches and ignores duplicate links", () => {
    const links = [
      requires(1, 2),
      requires(1, 3),
      requires(3, 4),
      { quest_id: 4, target_id: 1, type: "duplicate-of" },
    ] satisfies Chain[];

    expect(wouldCreateChainCycle(links, requires(5, 1))).toBeFalse();
    expect(
      wouldCreateChainCycle(links, {
        quest_id: 4,
        target_id: 1,
        type: "duplicate-of",
      }),
    ).toBeFalse();
    expect(
      findChainCyclePath(links, {
        quest_id: 4,
        target_id: 1,
        type: "duplicate-of",
      }),
    ).toBeUndefined();
  });

  test("terminates on an already-cyclic imported graph", () => {
    const links = [requires(1, 2), requires(2, 1)];
    expect(wouldCreateChainCycle(links, requires(3, 1))).toBeFalse();
  });
});
