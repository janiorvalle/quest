import { expect, test } from "bun:test";
import { ConvexError } from "convex/values";

import { QUEST_INPUT_LIMITS, QUEST_INPUT_TOO_LARGE_CODE } from "../src/schema";
import { QUEST_CLIENT_PROTOCOL } from "../src/store/convex/protocol";
import { fenceRepository, transition, unfenceRepository } from "./quest";

test("oversized turn-in summaries fail after auth but before a database read or write", async () => {
  const transitionHandler = (
    transition as unknown as {
      _handler: (
        context: never,
        args: {
          auth_token?: string;
          client_protocol?: number;
          client_version?: string;
          id: number;
          transition: unknown;
        },
      ) => Promise<unknown>;
    }
  )._handler;
  let authenticationCalls = 0;
  const previousAllow = process.env["QUEST_ALLOW_DEV_CLIENTS"];
  process.env["QUEST_ALLOW_DEV_CLIENTS"] = "1";
  const context = {
    runMutation: async () => {
      authenticationCalls += 1;
      return {
        env: "live",
        ownerId: "janior",
        tags: ["member"],
        valid: true,
      };
    },
  };
  try {
    try {
      await transitionHandler(context as never, {
        auth_token: "member-token",
        client_protocol: QUEST_CLIENT_PROTOCOL,
        client_version: "1.0.0",
        id: 376,
        transition: {
          action: "turnin",
          actor: "janior",
          pr: null,
          summary: "x".repeat(QUEST_INPUT_LIMITS.summaryBytes + 1),
        },
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConvexError);
      if (!(error instanceof ConvexError)) {
        throw error;
      }
      expect(error.data).toEqual({
        code: QUEST_INPUT_TOO_LARGE_CODE,
        message: `summary has ${QUEST_INPUT_LIMITS.summaryBytes + 1} bytes; expected at most ${QUEST_INPUT_LIMITS.summaryBytes} bytes; shorten summary and retry`,
      });
      expect(authenticationCalls).toBe(1);
      return;
    }
    throw new Error("expected the oversized summary to fail");
  } finally {
    if (previousAllow === undefined) {
      delete process.env["QUEST_ALLOW_DEV_CLIENTS"];
    } else {
      process.env["QUEST_ALLOW_DEV_CLIENTS"] = previousAllow;
    }
  }
});

test("migration fence mutations check the client before reading the restore lease", async () => {
  type MigrationFenceArgs = {
    client_protocol?: number;
    client_version?: string;
    repo: string;
    target_backend?: string;
    token: string;
  };
  type MigrationFenceHandler = (context: unknown, args: MigrationFenceArgs) => Promise<unknown>;
  const handler = (value: unknown): MigrationFenceHandler =>
    (value as { _handler: MigrationFenceHandler })._handler;
  const migrationHandlers = [
    { handler: handler(fenceRepository), target_backend: "convex" },
    { handler: handler(unfenceRepository) },
  ];
  const previousAllow = process.env["QUEST_ALLOW_DEV_CLIENTS"];
  const previousMinimum = process.env["QUEST_MIN_CLIENT_VERSION"];
  process.env["QUEST_ALLOW_DEV_CLIENTS"] = "1";
  process.env["QUEST_MIN_CLIENT_VERSION"] = "1.2.3";
  let leaseReads = 0;
  const context = {
    db: {
      query: () => {
        leaseReads += 1;
        throw new Error("restore lease read should not happen");
      },
    },
  };
  try {
    for (const migration of migrationHandlers) {
      await expect(
        migration.handler(context, {
          client_protocol: QUEST_CLIENT_PROTOCOL,
          client_version: "1.2.2",
          repo: "web-app",
          ...(migration.target_backend === undefined
            ? {}
            : { target_backend: migration.target_backend }),
          token: "restore-token",
        }),
      ).rejects.toMatchObject({ data: { code: "QUEST_CLI_OUTDATED" } });
    }
  } finally {
    if (previousAllow === undefined) {
      delete process.env["QUEST_ALLOW_DEV_CLIENTS"];
    } else {
      process.env["QUEST_ALLOW_DEV_CLIENTS"] = previousAllow;
    }
    if (previousMinimum === undefined) {
      delete process.env["QUEST_MIN_CLIENT_VERSION"];
    } else {
      process.env["QUEST_MIN_CLIENT_VERSION"] = previousMinimum;
    }
  }
  expect(leaseReads).toBe(0);
});
