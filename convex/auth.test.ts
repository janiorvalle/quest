import { expect, spyOn, test } from "bun:test";
import { ConvexError } from "convex/values";

import {
  MINIMUM_QUEST_CLIENT_PROTOCOL,
  QUEST_CLIENT_PROTOCOL,
  QUEST_DEV_VERSION,
} from "../src/store/convex/protocol";
import {
  logExpensiveMemberQueryPage,
  requireClientProtocol,
  requireClientVersion,
  requireMemberActor,
  requireMemberQueryActor,
} from "./auth";

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

function captureVersionFailure(
  clientVersion: string | undefined,
): ConvexError<{ code: string; message: string }> {
  try {
    requireClientVersion(clientVersion);
  } catch (error: unknown) {
    if (error instanceof ConvexError) {
      return error as ConvexError<{ code: string; message: string }>;
    }
    throw error;
  }
  throw new Error("expected client version validation to fail");
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

test("names the raised minimum version in an outdated-client error", () => {
  const previousMinimum = process.env["QUEST_MIN_CLIENT_VERSION"];
  const previousAllow = process.env["QUEST_ALLOW_DEV_CLIENTS"];
  process.env["QUEST_MIN_CLIENT_VERSION"] = "1.2.3";
  process.env["QUEST_ALLOW_DEV_CLIENTS"] = "1";
  try {
    const error = captureVersionFailure("1.2.2");
    expect(error.data).toEqual({
      code: "QUEST_CLI_OUTDATED",
      message:
        "this Quest CLI version 1.2.2 is older than the Convex deployment's required client version 1.2.3; run `quest upgrade`, then retry. No read or mutation was attempted.",
    });
  } finally {
    if (previousMinimum === undefined) {
      delete process.env["QUEST_MIN_CLIENT_VERSION"];
    } else {
      process.env["QUEST_MIN_CLIENT_VERSION"] = previousMinimum;
    }
    if (previousAllow === undefined) {
      delete process.env["QUEST_ALLOW_DEV_CLIENTS"];
    } else {
      process.env["QUEST_ALLOW_DEV_CLIENTS"] = previousAllow;
    }
  }
});

test("allows development clients only with the local opt-in", () => {
  const previousAllow = process.env["QUEST_ALLOW_DEV_CLIENTS"];
  delete process.env["QUEST_ALLOW_DEV_CLIENTS"];
  try {
    expect(captureVersionFailure(QUEST_DEV_VERSION).data.code).toBe(
      "QUEST_CLIENT_VERSION_CONFIG_INVALID",
    );
    process.env["QUEST_ALLOW_DEV_CLIENTS"] = "1";
    expect(() => requireClientVersion(QUEST_DEV_VERSION)).not.toThrow();
  } finally {
    if (previousAllow === undefined) {
      delete process.env["QUEST_ALLOW_DEV_CLIENTS"];
    } else {
      process.env["QUEST_ALLOW_DEV_CLIENTS"] = previousAllow;
    }
  }
});

test("checks the client version before member authentication or table reads", async () => {
  let mutationCalls = 0;
  const previousAllow = process.env["QUEST_ALLOW_DEV_CLIENTS"];
  const previousMinimum = process.env["QUEST_MIN_CLIENT_VERSION"];
  process.env["QUEST_ALLOW_DEV_CLIENTS"] = "1";
  process.env["QUEST_MIN_CLIENT_VERSION"] = "1.2.3";
  try {
    await expect(
      requireMemberActor(
        {
          runMutation: async () => {
            mutationCalls += 1;
            return undefined;
          },
        },
        {
          auth_token: "never-read",
          client_protocol: QUEST_CLIENT_PROTOCOL,
          client_version: "1.2.2",
        },
      ),
    ).rejects.toMatchObject({ data: { code: "QUEST_CLI_OUTDATED" } });
    expect(mutationCalls).toBe(0);

    let tableReads = 0;
    await expect(
      requireMemberQueryActor(
        {
          db: {
            query: () => {
              tableReads += 1;
              throw new Error("table read should not happen");
            },
          },
        } as never,
        {
          auth_token: "never-read",
          client_protocol: QUEST_CLIENT_PROTOCOL,
          client_version: "1.2.2",
        },
      ),
    ).rejects.toMatchObject({ data: { code: "QUEST_CLI_OUTDATED" } });
    expect(tableReads).toBe(0);
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
});

test("logs only the member name and page coordinates for an expensive read", () => {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    logExpensiveMemberQueryPage({
      actor: "janior",
      functionName: "federatedSnapshot",
      cursorSection: "events",
    });

    expect(log).toHaveBeenCalledWith(
      '{"actor":"janior","function":"federatedSnapshot","cursor_section":"events"}',
    );
  } finally {
    log.mockRestore();
  }
});
