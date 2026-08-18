import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const INSIGHTS_WINDOW_HOURS = 72;
const INSIGHTS_TIMEOUT_MS = 15_000;
const INSIGHTS_QUERY_ID = "9ab3b74e-a725-480b-88a6-43e6bd70bd82";
const CONVEX_API_ORIGIN = "https://api.convex.dev";
const EXACT_ID_MUTATIONS = new Set([
  "quest:acceptQuest",
  "quest:acceptQuestAndDetail",
  "quest:addChainLink",
  "quest:addEvidence",
  "quest:addQuest",
  "quest:removeChainLink",
  "quest:signoffBatch",
  "quest:touchQuest",
  "quest:transition",
]);

const accessTokenFileSchema = z.object({ accessToken: z.string().min(1) });
const teamAndProjectSchema = z.object({ teamId: z.number().int().positive() });
const insightRowsSchema = z.array(z.tuple([z.string(), z.string(), z.string(), z.string()]));
const occInsightDetailsSchema = z.object({
  occCalls: z.number().int().nonnegative(),
  occTableName: z.string().optional(),
});

export type ConvexOccRetryInspection =
  | {
      readonly failed_calls: number;
      readonly retried_calls: number;
      readonly state: "available";
      readonly window_hours: number;
    }
  | {
      readonly reason: string;
      readonly state: "unavailable";
      readonly window_hours: number;
    };

export type ConvexInsightsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ConvexInsightsOptions {
  readonly fetch?: ConvexInsightsFetch;
  readonly now?: () => Date;
  readonly readAccessToken?: () => Promise<string | null>;
}

function deploymentName(deployment: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(deployment).hostname;
  } catch {
    return null;
  }
  return /^([a-z0-9-]+)\.convex\.(?:cloud|site)$/u.exec(hostname)?.[1] ?? null;
}

async function defaultAccessTokenReader(): Promise<string | null> {
  const override = process.env["CONVEX_OVERRIDE_ACCESS_TOKEN"]?.trim();
  if (override !== undefined && override !== "") {
    return override;
  }
  try {
    const value: unknown = JSON.parse(
      await readFile(join(homedir(), ".convex", "config.json"), "utf8"),
    );
    const parsed = accessTokenFileSchema.safeParse(value);
    return parsed.success ? parsed.data.accessToken : null;
  } catch {
    return null;
  }
}

function unavailable(reason: string): ConvexOccRetryInspection {
  return { reason, state: "unavailable", window_hours: INSIGHTS_WINDOW_HOURS };
}

function authenticatedHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Convex-Client": "quest-doctor",
    Origin: CONVEX_API_ORIGIN,
  };
}

function authenticatedRequest(accessToken: string): RequestInit {
  return {
    headers: authenticatedHeaders(accessToken),
    signal: AbortSignal.timeout(INSIGHTS_TIMEOUT_MS),
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`Convex Insights returned HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchTeamId(
  name: string,
  accessToken: string,
  fetchInsights: ConvexInsightsFetch,
): Promise<number> {
  const response = await fetchInsights(
    `${CONVEX_API_ORIGIN}/api/deployment/${encodeURIComponent(name)}/team_and_project`,
    authenticatedRequest(accessToken),
  );
  return teamAndProjectSchema.parse(await readJson(response)).teamId;
}

function insightWindow(now: Date): { readonly from: string; readonly to: string } {
  const from = new Date(now.getTime() - INSIGHTS_WINDOW_HOURS * 60 * 60 * 1_000);
  return { from: from.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

async function fetchInsightRows(
  name: string,
  teamId: number,
  accessToken: string,
  now: Date,
  fetchInsights: ConvexInsightsFetch,
): Promise<z.infer<typeof insightRowsSchema>> {
  const window = insightWindow(now);
  const parameters = new URLSearchParams({
    deploymentName: name,
    from: window.from,
    queryId: INSIGHTS_QUERY_ID,
    to: window.to,
  });
  const response = await fetchInsights(
    `${CONVEX_API_ORIGIN}/api/dashboard/teams/${teamId}/usage/query?${parameters.toString()}`,
    authenticatedRequest(accessToken),
  );
  return insightRowsSchema.parse(await readJson(response));
}

function parseOccDetails(serialized: string): z.infer<typeof occInsightDetailsSchema> | null {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const parsed = occInsightDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function countCounterConflicts(rows: z.infer<typeof insightRowsSchema>): {
  readonly failed_calls: number;
  readonly retried_calls: number;
} {
  let failedCalls = 0;
  let retriedCalls = 0;
  for (const [kind, functionName, component, serializedDetails] of rows) {
    const details = parseOccDetails(serializedDetails);
    if (
      component !== "-root-component-" ||
      !EXACT_ID_MUTATIONS.has(functionName) ||
      details?.occTableName !== "counters"
    ) {
      continue;
    }
    if (kind === "occFailedPermanently") {
      failedCalls += details.occCalls;
    } else if (kind === "occRetried") {
      retriedCalls += details.occCalls;
    }
  }
  return { failed_calls: failedCalls, retried_calls: retriedCalls };
}

async function inspectCloudOccRetries(
  name: string,
  options: ConvexInsightsOptions,
): Promise<ConvexOccRetryInspection> {
  const accessToken = await (options.readAccessToken ?? defaultAccessTokenReader)();
  if (accessToken === null) {
    return unavailable(
      "Convex Insights requires a logged-in deployment owner; run `convex login`, then rerun quest doctor",
    );
  }
  try {
    const fetchInsights = options.fetch ?? fetch;
    const teamId = await fetchTeamId(name, accessToken, fetchInsights);
    const rows = await fetchInsightRows(
      name,
      teamId,
      accessToken,
      (options.now ?? (() => new Date()))(),
      fetchInsights,
    );
    return {
      ...countCounterConflicts(rows),
      state: "available",
      window_hours: INSIGHTS_WINDOW_HOURS,
    };
  } catch {
    return unavailable(
      "Convex Insights could not be read with the deployment-owner login; run `convex login`, then rerun quest doctor",
    );
  }
}

export function createConvexOccRetryInspector(
  deployment: string,
  options: ConvexInsightsOptions = {},
): () => Promise<ConvexOccRetryInspection> {
  const name = deploymentName(deployment);
  return name === null
    ? () =>
        Promise.resolve(
          unavailable(
            "Convex Insights is available only for standard cloud deployments; inspect OCC retries in the deployment dashboard",
          ),
        )
    : () => inspectCloudOccRetries(name, options);
}
