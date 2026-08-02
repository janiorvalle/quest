import { describe, expect, test } from "bun:test";

import { createCliOutputBoundary, EXIT_SUCCESS } from "../output";
import type { UpgradeOperations } from "../services";
import { executeUpgradeCli } from "./upgrade";

const clock = {
  now: () => Promise.resolve("2026-07-31T18:00:00Z"),
};

function operations(): UpgradeOperations {
  return {
    check: () =>
      Promise.resolve({
        artifact: "quest-0.8.1-darwin-arm64",
        artifact_url: "https://example.com/quest",
        current_version: "0.8.0",
        latest_version: "0.8.1",
        release_url: "https://example.com/release",
        repository: "owner/repo",
        target: "darwin-arm64",
        update_available: true,
      }),
    install: () =>
      Promise.resolve({
        artifact: "quest-0.8.1-darwin-arm64",
        artifact_url: "https://example.com/quest",
        checksum: "a".repeat(64),
        current_version: "0.8.0",
        installed: true,
        latest_version: "0.8.1",
        release_url: "https://example.com/release",
        repository: "owner/repo",
        target: "darwin-arm64",
        update_available: true,
      }),
  };
}

describe("upgrade CLI", () => {
  test("renders a dry lookup in the JSON envelope", async () => {
    const stdout: string[] = [];
    const exitCode = await executeUpgradeCli({
      applicationVersion: "0.8.0",
      clock,
      format: "json",
      operations: operations(),
      output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
      request: { check: true, command: "upgrade" },
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema: "quest.report/v1",
      command: "upgrade",
      generated_at: "2026-07-31T18:00:00Z",
      filters: {},
      warnings: [],
      data: {
        artifact: "quest-0.8.1-darwin-arm64",
        artifact_url: "https://example.com/quest",
        checksum: null,
        current_version: "0.8.0",
        installed: false,
        latest_version: "0.8.1",
        release_url: "https://example.com/release",
        repository: "owner/repo",
        target: "darwin-arm64",
        update_available: true,
      },
    });
  });

  test("reports the old and new versions after installation", async () => {
    const stdout: string[] = [];
    const exitCode = await executeUpgradeCli({
      applicationVersion: "0.8.0",
      clock,
      format: "human",
      operations: operations(),
      output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
      request: { check: false, command: "upgrade" },
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stdout.join("\n")).toContain("Upgraded quest 0.8.0 -> 0.8.1");
    expect(stdout.join("\n")).toContain(`checksum: ${"a".repeat(64)}`);
  });
});
