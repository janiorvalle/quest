import { expect, test } from "bun:test";
import { ConvexError } from "convex/values";

import { QUEST_INPUT_LIMITS, QUEST_INPUT_TOO_LARGE_CODE } from "../src/schema";
import { QUEST_CLIENT_PROTOCOL } from "../src/store/convex/protocol";
import { transition } from "./quest";

test("oversized turn-in summaries fail after auth but before a database read or write", async () => {
  const transitionHandler = (
    transition as unknown as {
      _handler: (
        context: never,
        args: {
          auth_token?: string;
          client_protocol?: number;
          id: number;
          transition: unknown;
        },
      ) => Promise<unknown>;
    }
  )._handler;
  let authenticationCalls = 0;
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
    await transitionHandler(context as never, {
      auth_token: "member-token",
      client_protocol: QUEST_CLIENT_PROTOCOL,
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
});
