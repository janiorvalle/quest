import { describe, expect, test } from "bun:test";

import { createConvexOccRetryInspector } from "./convex-insights";

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

describe("Convex OCC retry insights", () => {
  test("counts exact-ID counter conflicts through the bundled Insights API path", async () => {
    const requests: string[] = [];
    const inspect = createConvexOccRetryInspector("https://steady-bird-123.convex.cloud", {
      fetch: async (input) => {
        const url = requestUrl(input);
        requests.push(url);
        if (url.endsWith("/deployment/steady-bird-123/team_and_project")) {
          return Response.json({ teamId: 42 });
        }
        return Response.json([
          [
            "occRetried",
            "quest:addQuest",
            "-root-component-",
            JSON.stringify({ occCalls: 7, occTableName: "counters" }),
          ],
          [
            "occFailedPermanently",
            "quest:transition",
            "-root-component-",
            JSON.stringify({ occCalls: 2, occTableName: "counters" }),
          ],
          [
            "occRetried",
            "quest:transition",
            "-root-component-",
            JSON.stringify({ occCalls: 99, occTableName: "quests" }),
          ],
          [
            "occRetried",
            "apiKeys:rotate",
            "apiKeys",
            JSON.stringify({ occCalls: 101, occTableName: "counters" }),
          ],
          [
            "occRetried",
            "other:write",
            "-root-component-",
            JSON.stringify({ occCalls: 103, occTableName: "counters" }),
          ],
          [
            "occRetried",
            "quest:migrateReadyStatuses",
            "-root-component-",
            JSON.stringify({ occCalls: 107, occTableName: "counters" }),
          ],
          ["documentsReadThreshold", "quest:list", "-root-component-", "{}"],
        ]);
      },
      now: () => new Date("2026-08-17T18:00:00.000Z"),
      readAccessToken: () => Promise.resolve("owner-token"),
    });

    expect(await inspect()).toEqual({
      failed_calls: 2,
      retried_calls: 7,
      state: "available",
      window_hours: 72,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("dashboard/teams/42/usage/query");
    expect(requests[1]).toContain("deploymentName=steady-bird-123");
    expect(requests[1]).toContain("from=2026-08-14");
    expect(requests[1]).toContain("to=2026-08-17");
  });

  test("explains how to enable owner-only insights", async () => {
    const inspect = createConvexOccRetryInspector("https://steady-bird-123.convex.cloud", {
      readAccessToken: () => Promise.resolve(null),
    });

    expect(await inspect()).toEqual({
      reason:
        "Convex Insights requires a logged-in deployment owner; run `convex login`, then rerun quest doctor",
      state: "unavailable",
      window_hours: 72,
    });
  });

  test("does not invoke cloud insights for a local deployment", async () => {
    let invoked = false;
    const inspect = createConvexOccRetryInspector("http://127.0.0.1:3210", {
      readAccessToken: () => {
        invoked = true;
        return Promise.resolve("owner-token");
      },
    });

    expect(await inspect()).toMatchObject({ state: "unavailable", window_hours: 72 });
    expect(invoked).toBeFalse();
  });
});
