import { describe, expect, test } from "bun:test";

import { createCliOutputBoundary, EXIT_SUCCESS, EXIT_USAGE_ERROR } from "../output";
import { type Config, migrationResultSchema } from "../schema";
import { SQLITE_SCHEMA_VERSION } from "../store";
import type { QuestCliDependencies } from "./program";
import { parseQuestCliArguments, runQuestCli } from "./program";

const config = {
  areas: {},
  backup: { retention: { daily: 7, monthly: 6, weekly: 4 } },
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  repos: {},
  store: { backend: "sqlite" },
} satisfies Config;

const result = migrationResultSchema.parse({
  backups: { destination: "destination-snapshot", source: "source-snapshot" },
  counts: { chains: 1, evidence: 2, events: 3, quests: 2 },
  deployment: "dev:web-app",
  repository: "web-app",
  source_backend: "sqlite",
  spot_checks: {
    evidence_hashes: [],
    first_quest_id: 2,
    last_quest_id: 3,
  },
  target_backend: "convex",
  verified: true,
});

function dependencies(stdout: string[], stderr: string[]): QuestCliDependencies {
  return {
    applicationVersion: "1.2.3",
    clock: { now: () => Promise.resolve("2026-07-31T12:00:00Z") },
    compatibilityProbe: {
      check: () =>
        Promise.resolve({
          outcome: "compatible",
          supported_version: SQLITE_SCHEMA_VERSION,
          store_version: SQLITE_SCHEMA_VERSION,
        }),
    },
    config,
    evidenceFiles: { read: () => Promise.reject(new Error("not used")) },
    initialWorkingDirectory: "/work/quest",
    isTty: false,
    locateGitRoot: () => Promise.resolve("/work/quest"),
    migration: { migrate: () => Promise.resolve(result) },
    openApplicationPorts: () =>
      Promise.reject(new Error("repository migration must not open the normal backend")),
    output: createCliOutputBoundary({
      stderr: (line) => stderr.push(line),
      stdout: (text) => stdout.push(text),
    }),
    prompter: { ask: () => Promise.reject(new Error("not used")) },
    validateWorkingDirectory: () => Promise.resolve(),
  };
}

describe("repository migration CLI", () => {
  test("parses target backend, repository, and Convex deployment separately from schema migration", async () => {
    const parsed = await parseQuestCliArguments(
      ["migrate", "--to", "convex", "web-app", "--deployment", "dev:web-app"],
      createCliOutputBoundary(),
    );
    expect(parsed).toEqual({
      flags: {
        all: false,
        format: "human",
        repo: undefined,
        version: false,
      },
      outcome: "run",
      request: {
        command: "migrate",
        deployment: "dev:web-app",
        repository: "web-app",
        target: "convex",
      },
    });
  });

  test("emits the verified migration result as a report", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runQuestCli(
      ["--format", "json", "migrate", "--to", "convex", "web-app", "--deployment", "dev:web-app"],
      dependencies(stdout, stderr),
    );
    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      command: "migrate",
      data: result,
      filters: { repo: "web-app" },
    });
  });

  test("rejects repository replay without a repository", async () => {
    const stderr: string[] = [];
    const parsed = await parseQuestCliArguments(
      ["migrate", "--to", "convex"],
      createCliOutputBoundary({ stderr: (line) => stderr.push(line) }),
    );
    expect(parsed.outcome).toBe("exit");
    if (parsed.outcome === "exit") {
      expect(parsed.exitCode).toBe(EXIT_USAGE_ERROR);
    }
    expect(stderr[0]).toContain("requires <repo>");
  });

  test("turns whitespace-only migration values into usage errors", async () => {
    const stderr: string[] = [];
    const parsed = await parseQuestCliArguments(
      ["migrate", "--to", "convex", "web-app", "--deployment", " "],
      createCliOutputBoundary({ stderr: (line) => stderr.push(line) }),
    );
    expect(parsed.outcome).toBe("exit");
    if (parsed.outcome === "exit") {
      expect(parsed.exitCode).toBe(EXIT_USAGE_ERROR);
    }
    expect(stderr[0]).toContain("must not be empty");
  });

  test("converts Convex ready rows without putting the admin secret in argv", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const received: string[] = [];
    const base = dependencies(stdout, stderr);
    const exitCode = await runQuestCli(
      ["migrate", "--ready-statuses", "--deployment", "https://example.convex.cloud"],
      {
        ...base,
        environment: { QUEST_ADMIN_SECRET: "admin-secret" },
        onboarding: {
          migrateReadyStatuses: async (deployment, secret) => {
            received.push(deployment, secret);
            return { converted: 3, total: 5, unchanged: 2 };
          },
          invite: async () => ({ member: "unused", token: "unused" }),
          join: async () => ({ member: "unused", token: "unused" }),
          list: async () => [],
          remove: async () => ({ member: "unused", revoked_keys: 0 }),
          repositories: async () => [],
          rotate: async () => ({ member: "unused", old_key_expires_at: 0, token: "unused" }),
          whoami: async () => ({ member: "unused" }),
        },
      },
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stderr).toEqual([]);
    expect(received).toEqual(["https://example.convex.cloud", "admin-secret"]);
    expect(stdout.join("")).toContain("Converted 3 ready quests to open");
  });

  test("uses the injected clock in ready-status migration reports", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const base = dependencies(stdout, stderr);
    const exitCode = await runQuestCli(
      [
        "--format",
        "json",
        "migrate",
        "--ready-statuses",
        "--deployment",
        "https://example.convex.cloud",
      ],
      {
        ...base,
        environment: { QUEST_ADMIN_SECRET: "admin-secret" },
        onboarding: {
          migrateReadyStatuses: async () => ({ converted: 0, total: 2, unchanged: 2 }),
          invite: async () => ({ member: "unused", token: "unused" }),
          join: async () => ({ member: "unused", token: "unused" }),
          list: async () => [],
          remove: async () => ({ member: "unused", revoked_keys: 0 }),
          repositories: async () => [],
          rotate: async () => ({ member: "unused", old_key_expires_at: 0, token: "unused" }),
          whoami: async () => ({ member: "unused" }),
        },
      },
    );

    expect(exitCode).toBe(EXIT_SUCCESS);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      generated_at: "2026-07-31T12:00:00Z",
      data: { converted: 0, total: 2, unchanged: 2 },
    });
  });
});
