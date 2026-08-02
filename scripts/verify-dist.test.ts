import { describe, expect, test } from "bun:test";

import { validateDistributionInventory } from "./verify-dist";

const fullMatrixArtifacts = [
  "quest-0.0.0-darwin-arm64",
  "quest-0.0.0-darwin-x64",
  "quest-0.0.0-linux-x64",
  "quest-0.0.0-linux-arm64",
  "quest-0.0.0-windows-x64.exe",
];

describe("distribution inventory verification", () => {
  test("requires all five artifacts and checksums for a full release", () => {
    expect(() =>
      validateDistributionInventory(
        [fullMatrixArtifacts[0] ?? "", "checksums.txt"],
        fullMatrixArtifacts,
        "full",
      ),
    ).toThrow("DIST_VERIFY_INCOMPLETE");
  });

  test("rejects unexpected files in a full release", () => {
    expect(() =>
      validateDistributionInventory(
        [...fullMatrixArtifacts, "checksums.txt", "quest-debug"],
        fullMatrixArtifacts,
        "full",
      ),
    ).toThrow("unexpected quest-debug");
  });

  test("allows other artifacts when verifying one CI target", () => {
    expect(() =>
      validateDistributionInventory(
        [fullMatrixArtifacts[0] ?? "", fullMatrixArtifacts[1] ?? "", "checksums.txt"],
        [fullMatrixArtifacts[0] ?? ""],
        "targeted",
      ),
    ).not.toThrow();
  });
});
