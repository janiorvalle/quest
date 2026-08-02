import { describe, expect, test } from "bun:test";

import { applicationName } from "./index";

describe("project scaffold", () => {
  test("exposes the application name", () => {
    expect(applicationName).toBe("quest");
  });
});
