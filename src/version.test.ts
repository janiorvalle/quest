import { describe, expect, test } from "bun:test";

import { applicationVersion } from "./version";

describe("application version", () => {
  test("has a deterministic development fallback", () => {
    expect(applicationVersion).toBe("0.0.0-dev");
  });
});
