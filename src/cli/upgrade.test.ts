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
        skill_refresh_failures: [],
        skill_refreshes: [
          { agent: "Claude Code", previous_version: "0.8.0" },
          { agent: "Codex", previous_version: "0.8.0" },
        ],
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
        skill_refresh_failures: [],
        skill_refreshes: [],
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
    expect(stdout.join("\n")).toContain("refreshed skill for Claude Code (was 0.8.0)");
    expect(stdout.join("\n")).toContain("refreshed skill for Codex (was 0.8.0)");
  });

  test("reports a skill refresh failure without failing a successful binary upgrade", async () => {
    const stdout: string[] = [];
    const base = operations();
    const exitCode = await executeUpgradeCli({
      applicationVersion: "0.8.0",
      clock,
      format: "human",
      operations: {
        ...base,
        install: async () => ({
          ...(await base.install("0.8.0")),
          skill_refresh_failures: [
            {
              agent: "Codex",
              message: "permission denied",
              remedy: "quest skill install --force",
            },
          ],
          skill_refreshes: [],
        }),
      },
      output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
      request: { check: false, command: "upgrade" },
    });

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stdout.join("\n")).toContain(
      "warning: could not refresh skill for Codex: permission denied; run `quest skill install --force`",
    );
  });
});
