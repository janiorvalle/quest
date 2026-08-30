import { expect, test } from "bun:test";

import { generatedConvexVersionSource } from "./version-stamp";

// Convex typechecks the stamped bundle at deploy time. A string-literal constant makes
// the dev-build comparison in convex/auth.ts a TS2367 error, so the stamp must widen.
test("the stamped Convex version constant is declared as a string, not a literal", () => {
  const source = generatedConvexVersionSource("0.24.0");
  expect(source).toContain('const __QUEST_VERSION__ = "0.24.0";');
  expect(source).toContain("export const deployedQuestVersion: string = __QUEST_VERSION__;");
});
