import { expect, test } from "bun:test";
import { ConvexError } from "convex/values";

import { MINIMUM_QUEST_CLIENT_PROTOCOL, QUEST_CLIENT_PROTOCOL } from "../src/store/convex/protocol";
import { requireClientProtocol } from "./auth";

function captureProtocolFailure(
  clientProtocol: number | undefined,
): ConvexError<{ code: string; message: string }> {
  try {
    requireClientProtocol(clientProtocol);
  } catch (error: unknown) {
    if (error instanceof ConvexError) {
      return error as ConvexError<{ code: string; message: string }>;
    }
    throw error;
  }
  throw new Error("expected client protocol validation to fail");
}

test("rejects missing and outdated Quest clients with an upgrade instruction", () => {
  for (const clientProtocol of [undefined, MINIMUM_QUEST_CLIENT_PROTOCOL - 1]) {
    const error = captureProtocolFailure(clientProtocol);
    expect(error.data).toEqual({
      code: "QUEST_CLI_OUTDATED",
      message:
        "this Quest CLI is too old for this Convex deployment; run `quest upgrade`, then retry. No read or mutation was attempted.",
    });
  }
});

test("accepts the current Quest client protocol", () => {
  expect(() => requireClientProtocol(QUEST_CLIENT_PROTOCOL)).not.toThrow();
});
