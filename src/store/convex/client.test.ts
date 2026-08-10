import { expect, test } from "bun:test";

import { convexApi, createConvexHttpClient } from "./client";

function convexErrorResponse(
  code = "QUEST_INVITE_INVALID",
  message = "invite token is invalid",
): Response {
  return new Response(
    JSON.stringify({
      status: "error",
      errorMessage: `Server Error Uncaught ConvexError: ${JSON.stringify({ code, message })} at failMember (convex/members.ts:38:9) at handler (convex/members.ts:200:3)`,
      errorData: { code, message },
    }),
    { headers: { "Content-Type": "application/json" }, status: 560 },
  );
}

function fetchResponses(responses: Response[]): typeof globalThis.fetch {
  const fetchImplementation = async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected Convex request");
    }
    return response;
  };
  return Object.assign(fetchImplementation, { preconnect: globalThis.fetch.preconnect });
}

async function captureFailure(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the Convex request to fail");
}

test("normalizes ConvexError data for queries and mutations", async () => {
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: fetchResponses([convexErrorResponse(), convexErrorResponse()]),
  });

  const queryError = await captureFailure(() => client.query(convexApi.serverTime, {}));
  expect(queryError.message).toBe("[QUEST_INVITE_INVALID] invite token is invalid");
  expect(queryError.message).not.toContain("Request ID");
  expect(queryError.message).not.toContain("at failMember");

  const mutationError = await captureFailure(() =>
    client.mutation(convexApi.join, { invite_token: "bad-token" }),
  );
  expect(mutationError.message).toBe("[QUEST_INVITE_INVALID] invite token is invalid");
  expect(mutationError.message).not.toContain("Request ID");
  expect(mutationError.message).not.toContain("at handler");
});

test("preserves stable lifecycle error codes from Convex", async () => {
  const message =
    "quest 384 is open; completion requires turned_in. Run `quest accept 384`, finish the work, and turn it in before retrying. No state changed.";
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: fetchResponses([convexErrorResponse("COMPLETE_INVALID_STATE", message)]),
  });

  const error = await captureFailure(() =>
    client.mutation(convexApi.transition, {
      id: 384,
      transition: { action: "complete", actor: "tester", session_guild: null },
    }),
  );
  expect(error.message).toBe(`[COMPLETE_INVALID_STATE] ${message}`);
  expect(error.message).not.toContain("Request ID");
});

test("leaves non-Convex request failures unchanged", async () => {
  const networkError = new Error("fetch failed: connection refused");
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: Object.assign(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        throw networkError;
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  });

  const error = await captureFailure(() => client.query(convexApi.serverTime, {}));
  expect(error).toBe(networkError);
});
