import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCliOutputBoundary } from "../output";
import type { Config } from "../schema";
import type { ConvexOnboardingOperations } from "./members";
import { executeMembersCli } from "./members";
import { createQuestCommand } from "./program";

const config = {
  store: { backend: "convex", convex_deployment: "dev:quest" },
  repos: {},
  areas: {},
  colors: {},
  labels: { areas: {}, statuses: {}, verdicts: {} },
  backup: { retention: { daily: 7, weekly: 4, monthly: 6 } },
} satisfies Config;

function onboarding(): ConvexOnboardingOperations {
  return {
    invite: async (_deployment, name, _adminSecret) => ({ member: name, token: "invite-token" }),
    rotate: async (_deployment, name, _adminSecret) => ({
      member: name,
      old_key_expires_at: 123,
      token: "rotated-token",
    }),
    remove: async (_deployment, name, _adminSecret) => ({ member: name, revoked_keys: 1 }),
    list: async () => [
      {
        created_at: "2026-07-31T00:00:00.000Z",
        name: "alice",
        status: "active",
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ],
    join: async () => ({ member: "alice", token: "personal-token" }),
    whoami: async () => ({ member: "alice" }),
    repositories: async () => ["api", "web-app"],
  };
}

function configWriter() {
  return {
    writeToken: async () => undefined,
    writeRouting: async (_deployment: string, repositories: readonly string[]) => ({
      added: repositories,
      conflicts: [],
    }),
  };
}

test("join stores the personal token and reports the whoami round-trip without exposing it", async () => {
  const stdout: string[] = [];
  const writes: Array<{ deployment: string; token: string }> = [];
  const routeWrites: Array<{ deployment: string; repositories: readonly string[] }> = [];
  const calls: Array<{ deployment: string; token: string }> = [];
  const code = await executeMembersCli({
    config,
    configWriter: {
      writeToken: async (deployment, token) => {
        writes.push({ deployment, token });
      },
      writeRouting: async (deployment, repositories) => {
        routeWrites.push({ deployment, repositories });
        return { added: repositories, conflicts: [] };
      },
    },
    environment: {},
    format: "human",
    onboarding: {
      ...onboarding(),
      join: async (deployment, inviteToken) => {
        calls.push({ deployment, token: inviteToken });
        return { member: "alice", token: "personal-token" };
      },
    },
    output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
    prompter: { ask: async () => "invite-token" },
    request: { command: "join", deployment: "https://team.convex.cloud/", routing: true },
  });

  expect(code).toBe(0);
  expect(stdout).toEqual(["Connected as alice · routing added: api, web-app\n"]);
  expect(writes).toEqual([{ deployment: "https://team.convex.cloud", token: "personal-token" }]);
  expect(calls).toEqual([{ deployment: "https://team.convex.cloud", token: "invite-token" }]);
  expect(routeWrites).toEqual([
    { deployment: "https://team.convex.cloud", repositories: ["api", "web-app"] },
  ]);
  expect(stdout.join("")).not.toContain("personal-token");
});

test("join suggests installing the agent skill when neither agent has it", async () => {
  const home = await mkdtemp(join(tmpdir(), "quest-join-skill-"));
  const stdout: string[] = [];
  try {
    const code = await executeMembersCli({
      config,
      configWriter: configWriter(),
      environment: { HOME: home },
      format: "human",
      onboarding: onboarding(),
      output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
      prompter: { ask: async () => "invite-token" },
      request: { command: "join", deployment: "dev:quest", routing: false },
    });

    expect(code).toBe(0);
    expect(stdout.join("")).toContain(
      "Quest agent skill not detected; run `quest skill install` to install it for Claude Code and Codex.",
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("join checks token persistence before consuming the invite", async () => {
  let joins = 0;
  await expect(
    executeMembersCli({
      config,
      environment: {},
      format: "human",
      onboarding: {
        ...onboarding(),
        join: async () => {
          joins += 1;
          return { member: "alice", token: "personal-token" };
        },
      },
      output: createCliOutputBoundary(),
      prompter: { ask: async () => "invite-token" },
      request: { command: "join", deployment: "dev:quest", routing: true },
    }),
  ).rejects.toThrow("the invite was not consumed");
  expect(joins).toBe(0);
});

test("join write failures point to rotation recovery for the active member", async () => {
  await expect(
    executeMembersCli({
      config,
      configWriter: {
        ...configWriter(),
        writeToken: async () => Promise.reject(new Error("read-only config")),
      },
      environment: {},
      format: "human",
      onboarding: onboarding(),
      output: createCliOutputBoundary(),
      prompter: { ask: async () => "invite-token" },
      request: { command: "join", deployment: "dev:quest", routing: true },
    }),
  ).rejects.toThrow("quest members rotate alice");
});

test("join keeps the saved token when whoami verification fails", async () => {
  const stdout: string[] = [];
  const code = await executeMembersCli({
    config,
    configWriter: configWriter(),
    environment: {},
    format: "json",
    onboarding: {
      ...onboarding(),
      whoami: async () => Promise.reject(new Error("temporary Convex outage")),
    },
    output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
    prompter: { ask: async () => "invite-token" },
    request: { command: "join", deployment: "dev:quest", routing: true },
  });

  expect(code).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    data: {
      connected_as: "alice",
      deployment: "dev:quest",
      routing_added: [],
      routing_skipped: [],
    },
    warnings: [
      "[QUEST_JOIN_VERIFICATION_FAILED] the personal token was saved, but server verification failed; retry a normal Quest command and do not run quest join again",
    ],
  });
});

test("join skips conflicting routes with an actionable warning", async () => {
  const stdout: string[] = [];
  const code = await executeMembersCli({
    config,
    configWriter: {
      ...configWriter(),
      writeRouting: async () => ({
        added: ["api"],
        conflicts: [{ repository: "web-app", configuredStore: { backend: "sqlite" } }],
      }),
    },
    environment: {},
    format: "json",
    onboarding: onboarding(),
    output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
    prompter: { ask: async () => "invite-token" },
    request: { command: "join", deployment: "dev:quest", routing: true },
  });

  expect(code).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    data: { routing_added: ["api"], routing_skipped: ["web-app"] },
    warnings: [
      expect.stringContaining(
        "[QUEST_JOIN_ROUTE_CONFLICT] routing for web-app was not changed because it already points to local SQLite",
      ),
    ],
  });
});

test("join conflict warnings quote repository names in the replacement TOML", async () => {
  const stdout: string[] = [];
  await executeMembersCli({
    config,
    configWriter: {
      ...configWriter(),
      writeRouting: async () => ({
        added: [],
        conflicts: [{ repository: "platform.api", configuredStore: { backend: "sqlite" } }],
      }),
    },
    environment: {},
    format: "json",
    onboarding: onboarding(),
    output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
    prompter: { ask: async () => "invite-token" },
    request: { command: "join", deployment: "dev:quest", routing: true },
  });

  expect(JSON.parse(stdout.join("")).warnings).toEqual([
    expect.stringContaining(
      '[repos."platform.api".store]\nbackend = "convex"\ndeployment = "dev:quest"',
    ),
  ]);
});

test("join --no-routing saves the token without querying repositories", async () => {
  let repositoryQueries = 0;
  let routeWrites = 0;
  await executeMembersCli({
    config,
    configWriter: {
      writeToken: async () => undefined,
      writeRouting: async () => {
        routeWrites += 1;
        return { added: [], conflicts: [] };
      },
    },
    environment: {},
    format: "human",
    onboarding: {
      ...onboarding(),
      repositories: async () => {
        repositoryQueries += 1;
        return ["web-app"];
      },
    },
    output: createCliOutputBoundary({ stdout: () => undefined }),
    prompter: { ask: async () => "invite-token" },
    request: { command: "join", deployment: "dev:quest", routing: false },
  });

  expect(repositoryQueries).toBe(0);
  expect(routeWrites).toBe(0);
});

test("admin invite uses the environment secret and returns the one-time token", async () => {
  const stdout: string[] = [];
  const received: string[] = [];
  const code = await executeMembersCli({
    config,
    environment: { QUEST_ADMIN_SECRET: "admin-secret" },
    format: "json",
    onboarding: {
      ...onboarding(),
      invite: async (_deployment, name, adminSecret) => {
        received.push(adminSecret);
        return { member: name, token: "invite-token" };
      },
    },
    output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
    prompter: { ask: async () => "must-not-prompt" },
    request: { command: "members-invite", name: "alice" },
  });

  expect(code).toBe(0);
  expect(received).toEqual(["admin-secret"]);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    command: "members invite",
    data: { member: "alice", token: "invite-token" },
  });
});

test("Commander captures member commands without opening a backend", async () => {
  let captured: unknown;
  const command = createQuestCommand(createCliOutputBoundary(), {
    set: (request) => {
      captured = request;
    },
  });

  await command.parseAsync(["members", "invite", "alice", "--deployment", "dev:quest"], {
    from: "user",
  });

  expect(captured).toEqual({
    command: "members-invite",
    deployment: "dev:quest",
    name: "alice",
  });
});

test("Commander captures the join routing opt-out", async () => {
  const requests: unknown[] = [];
  const command = createQuestCommand(createCliOutputBoundary(), {
    set: (request) => requests.push(request),
  });

  await command.parseAsync(["join", "dev:quest", "--no-routing"], { from: "user" });

  expect(requests).toEqual([{ command: "join", deployment: "dev:quest", routing: false }]);
});
