import { describe, expect, test } from "bun:test";

import { artifactName, distTargets, resolveDistVersion, selectDistTargets } from "./dist-config";

describe("distribution configuration", () => {
  test("defines the complete supported target matrix", () => {
    expect(distTargets.map((target) => target.bunTarget)).toEqual([
      "bun-darwin-arm64",
      "bun-darwin-x64",
      "bun-linux-x64",
      "bun-linux-arm64",
      "bun-windows-x64",
    ]);
  });

  test("uses an explicit stable version when provided", () => {
    expect(resolveDistVersion("1.2.3")).toBe("1.2.3");
  });

  test("defaults to the package version", () => {
    expect(resolveDistVersion(undefined)).toBe("0.0.0");
  });

  test("rejects versions that are not stable semantic versions", () => {
    expect(() => resolveDistVersion("../release")).toThrow("invalid distribution version");
    expect(() => resolveDistVersion("1.2")).toThrow("invalid distribution version");
    expect(() => resolveDistVersion("1.2.3-rc.1")).toThrow("invalid distribution version");
  });

  test("selects one target or the complete matrix", () => {
    expect(selectDistTargets("windows-x64").map((target) => target.id)).toEqual(["windows-x64"]);
    expect(selectDistTargets(undefined)).toHaveLength(5);
    expect(() => selectDistTargets("windows-arm64")).toThrow("unsupported distribution target");
  });

  test("uses the executable suffix only for Windows", () => {
    expect(artifactName("1.2.3", distTargets[0])).toBe("quest-1.2.3-darwin-arm64");
    expect(artifactName("1.2.3", distTargets[4])).toBe("quest-1.2.3-windows-x64.exe");
  });
});
