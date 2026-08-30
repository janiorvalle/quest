import { expect, test } from "bun:test";

import { convexApi, createConvexHttpClient, isQuestCliOutdatedError } from "./client";
import { clientProtocolInput } from "./protocol";

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

test("recognizes outdated errors after federated scope context is added", () => {
  expect(
    isQuestCliOutdatedError(
      new Error(
        "[FEDERATED_SCOPE_UNAVAILABLE] repository remote cannot be read ([QUEST_CLI_OUTDATED] upgrade required)",
      ),
    ),
  ).toBeTrue();
  expect(
    isQuestCliOutdatedError(new Error("[FEDERATED_SCOPE_UNAVAILABLE] backend is unreachable")),
  ).toBeFalse();
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

test("adds the current client protocol to every HTTP function call", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const responses = ["2026-08-17T13:00:00.000Z", { member: "janiorvalle", token: "qtk" }, "sha"];
  const fetchImplementation = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof init?.body !== "string") {
      throw new Error("expected Convex to send a JSON request body");
    }
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(JSON.stringify({ status: "success", value: responses.shift() }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: Object.assign(fetchImplementation, { preconnect: globalThis.fetch.preconnect }),
  });

  await client.query(convexApi.serverTime, {});
  await client.mutation(convexApi.join, { invite_token: "invite" });
  await client.action(convexApi.finalizeBlobUpload, {
    sha256: "0".repeat(64),
    storage_id: "storage-id",
  });

  expect(
    requestBodies.map((body) => {
      const input = (body["args"] as Array<Record<string, unknown>>)[0];
      return {
        client_protocol: input?.["client_protocol"],
        client_version: input?.["client_version"],
      };
    }),
  ).toEqual([clientProtocolInput(), clientProtocolInput(), clientProtocolInput()]);
});

test("remembers a legacy backend after its validator rejects the protocol field", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const responses = [
    new Response(
      JSON.stringify({
        status: "error",
        errorMessage:
          "ArgumentValidationError: Object contains extra field `client_protocol` that is not in the validator.",
      }),
      { headers: { "Content-Type": "application/json" }, status: 560 },
    ),
    new Response(JSON.stringify({ status: "success", value: "first" })),
    new Response(JSON.stringify({ status: "success", value: "second" })),
  ];
  const fetchImplementation = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof init?.body !== "string") {
      throw new Error("expected Convex to send a JSON request body");
    }
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected Convex request");
    }
    return response;
  };
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: Object.assign(fetchImplementation, { preconnect: globalThis.fetch.preconnect }),
  });

  expect(await client.query(convexApi.serverTime, {})).toBe("first");
  expect(await client.query(convexApi.serverTime, {})).toBe("second");
  expect(requestBodies.map((body) => (body["args"] as Array<Record<string, unknown>>)[0])).toEqual([
    clientProtocolInput(),
    {},
    {},
  ]);
});

test("keeps the protocol when an older backend rejects only the version field", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const responses = [
    new Response(
      JSON.stringify({
        status: "error",
        errorMessage:
          "ArgumentValidationError: Object contains extra field `client_version` that is not in the validator.",
      }),
      { headers: { "Content-Type": "application/json" }, status: 560 },
    ),
    new Response(JSON.stringify({ status: "success", value: "first" })),
    new Response(JSON.stringify({ status: "success", value: "second" })),
  ];
  const fetchImplementation = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof init?.body !== "string") {
      throw new Error("expected Convex to send a JSON request body");
    }
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected Convex request");
    }
    return response;
  };
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: Object.assign(fetchImplementation, { preconnect: globalThis.fetch.preconnect }),
  });

  expect(await client.query(convexApi.serverTime, {})).toBe("first");
  expect(await client.query(convexApi.serverTime, {})).toBe("second");
  expect(requestBodies.map((body) => (body["args"] as Array<Record<string, unknown>>)[0])).toEqual([
    clientProtocolInput(),
    { client_protocol: clientProtocolInput().client_protocol },
    { client_protocol: clientProtocolInput().client_protocol },
  ]);
});

test("does not reintroduce a rejected version field on later calls", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const responses = [
    new Response(
      JSON.stringify({
        status: "error",
        errorMessage:
          "ArgumentValidationError: Object contains extra field `client_version` that is not in the validator.",
      }),
      { headers: { "Content-Type": "application/json" }, status: 560 },
    ),
    new Response(JSON.stringify({ status: "success", value: "first" })),
    new Response(JSON.stringify({ status: "success", value: "second" })),
  ];
  const fetchImplementation = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (typeof init?.body !== "string") {
      throw new Error("expected Convex to send a JSON request body");
    }
    requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("unexpected Convex request");
    }
    return response;
  };
  const client = createConvexHttpClient("https://example.convex.cloud", {
    fetch: Object.assign(fetchImplementation, { preconnect: globalThis.fetch.preconnect }),
  });

  await client.query(convexApi.serverTime, { client_version: "1.2.3" });
  await client.query(convexApi.serverTime, { client_version: "1.2.4" });

  expect(requestBodies.map((body) => (body["args"] as Array<Record<string, unknown>>)[0])).toEqual([
    clientProtocolInput(),
    { client_protocol: clientProtocolInput().client_protocol },
    { client_protocol: clientProtocolInput().client_protocol },
  ]);
});
