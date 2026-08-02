import { describe, expect, test } from "bun:test";

import { allocateDisplayId } from ".";

describe("display id allocation", () => {
  test.each([
    [[], 1],
    [[1], 2],
    [[1, 2, 3], 4],
    [[7, 2, 4], 8],
    [[1, 3], 4],
  ] satisfies ReadonlyArray<readonly [number[], number]>)(
    "allocates one above the maximum in %j",
    (ids, expected) => {
      expect(allocateDisplayId(ids)).toBe(expected);
    },
  );

  test.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "rejects invalid existing id %j",
    (id) => {
      expect(() => allocateDisplayId([id])).toThrow(RangeError);
    },
  );

  test("rejects exhausted safe-integer space", () => {
    expect(() => allocateDisplayId([Number.MAX_SAFE_INTEGER])).toThrow(
      "display id space exhausted",
    );
  });
});
