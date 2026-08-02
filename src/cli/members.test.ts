import { expect, test } from "bun:test";

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
  };
}

test("join stores the personal token and reports the whoami round-trip without exposing it", async () => {
  const stdout: string[] = [];
  const writes: Array<{ deployment: string; token: string }> = [];
  const calls: Array<{ deployment: string; token: string }> = [];
  const code = await executeMembersCli({
    config,
    configWriter: {
      write: async (deployment, token) => {
        writes.push({ deployment, token });
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
    request: { command: "join", deployment: "https://team.convex.cloud/" },
  });

  expect(code).toBe(0);
  expect(stdout).toEqual(["Connected as alice\n"]);
  expect(writes).toEqual([{ deployment: "https://team.convex.cloud", token: "personal-token" }]);
  expect(calls).toEqual([{ deployment: "https://team.convex.cloud", token: "invite-token" }]);
  expect(stdout.join("")).not.toContain("personal-token");
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
      request: { command: "join", deployment: "dev:quest" },
    }),
  ).rejects.toThrow("the invite was not consumed");
  expect(joins).toBe(0);
});

test("join write failures point to rotation recovery for the active member", async () => {
  await expect(
    executeMembersCli({
      config,
      configWriter: { write: async () => Promise.reject(new Error("read-only config")) },
      environment: {},
      format: "human",
      onboarding: onboarding(),
      output: createCliOutputBoundary(),
      prompter: { ask: async () => "invite-token" },
      request: { command: "join", deployment: "dev:quest" },
    }),
  ).rejects.toThrow("quest members rotate alice");
});

test("join keeps the saved token when whoami verification fails", async () => {
  const stdout: string[] = [];
  const code = await executeMembersCli({
    config,
    configWriter: { write: async () => undefined },
    environment: {},
    format: "json",
    onboarding: {
      ...onboarding(),
      whoami: async () => Promise.reject(new Error("temporary Convex outage")),
    },
    output: createCliOutputBoundary({ stdout: (text) => stdout.push(text) }),
    prompter: { ask: async () => "invite-token" },
    request: { command: "join", deployment: "dev:quest" },
  });

  expect(code).toBe(0);
  expect(JSON.parse(stdout.join(""))).toMatchObject({
    data: { connected_as: "alice", deployment: "dev:quest" },
    warnings: [
      "[QUEST_JOIN_VERIFICATION_FAILED] the personal token was saved, but server verification failed; retry a normal Quest command and do not run quest join again",
    ],
  });
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
