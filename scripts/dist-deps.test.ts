import { describe, expect, test } from "bun:test";
import { distributionTargets } from "../src/distribution";
import { distributionDependencies, platformPackageName, registryVersionUrl } from "./dist-deps";

describe("distribution dependency preflight", () => {
  test("uses the OpenTUI platform names required by the Bun target matrix", () => {
    expect(distributionTargets.map(platformPackageName)).toEqual([
      "@opentui/core-darwin-arm64",
      "@opentui/core-darwin-x64",
      "@opentui/core-linux-x64",
      "@opentui/core-linux-arm64",
      "@opentui/core-win32-x64",
    ]);
  });

  test("pins every registry lookup to the installed core version", () => {
    const dependencies = distributionDependencies("0.4.5");

    expect(dependencies.every((dependency) => dependency.version === "0.4.5")).toBe(true);
    expect(dependencies.every((dependency) => dependency.versionUrl.endsWith("/0.4.5"))).toBe(true);
    expect(registryVersionUrl("@opentui/core-win32-x64", "0.4.5")).toBe(
      "https://registry.npmjs.org/%40opentui%2Fcore-win32-x64/0.4.5",
    );
  });
});
