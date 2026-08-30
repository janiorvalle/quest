import { ApiKeys } from "@vllnt/convex-api-keys";
import type { ComponentApi } from "@vllnt/convex-api-keys/_generated/component";
import {
  componentsGeneric,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  internalMutationGeneric,
  makeFunctionReference,
} from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  type ClientProtocolInput,
  compareQuestVersions,
  isStableQuestVersion,
  MINIMUM_QUEST_CLIENT_PROTOCOL,
  QUEST_DEV_VERSION,
} from "../src/store/convex/protocol";
import type schema from "./schema";
import { deployedQuestVersion } from "./version";

export type MemberMutationContext = GenericMutationCtx<
  DataModelFromSchemaDefinition<typeof schema>
>;
export type MemberQueryContext = GenericQueryCtx<DataModelFromSchemaDefinition<typeof schema>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasComponentKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return names.every((name) => value[name] !== undefined);
}

function isComponentApi(value: unknown): value is ComponentApi {
  if (!isRecord(value)) {
    return false;
  }
  const mutations = value["mutations"];
  const queries = value["queries"];
  return (
    isRecord(mutations) &&
    isRecord(queries) &&
    hasComponentKeys(mutations, [
      "configure",
      "create",
      "disable",
      "enable",
      "revoke",
      "revokeByTag",
      "rotate",
      "update",
      "validate",
    ]) &&
    hasComponentKeys(queries, ["getUsage", "list", "listByTag"])
  );
}

function componentApiKeys(): ComponentApi {
  const component = componentsGeneric()["apiKeys"];
  if (!isComponentApi(component)) {
    throw new Error(
      "Convex api-keys component is not registered; add app.use(apiKeys) to convex/convex.config.ts and regenerate Convex functions",
    );
  }
  return component;
}

export const questApiKeys = new ApiKeys(componentApiKeys(), {
  defaultType: "secret",
  prefix: "qtk",
});

type MemberAuthErrorCode =
  | "QUEST_CLI_OUTDATED"
  | "QUEST_CLIENT_VERSION_CONFIG_INVALID"
  | "QUEST_CONVEX_TOKEN_REQUIRED"
  | "QUEST_CONVEX_TOKEN_INVALID";

const MINIMUM_CLIENT_VERSION_ENVIRONMENT_VARIABLE = "QUEST_MIN_CLIENT_VERSION";
const ALLOW_DEV_CLIENTS_ENVIRONMENT_VARIABLE = "QUEST_ALLOW_DEV_CLIENTS";

function failMemberAuth(code: MemberAuthErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

function developmentClientsAllowed(): boolean {
  return process.env[ALLOW_DEV_CLIENTS_ENVIRONMENT_VARIABLE] === "1";
}

function minimumClientVersion(): string {
  const configuredMinimum = process.env[MINIMUM_CLIENT_VERSION_ENVIRONMENT_VARIABLE]?.trim();
  if (!isStableQuestVersion(deployedQuestVersion)) {
    if (deployedQuestVersion !== QUEST_DEV_VERSION || !developmentClientsAllowed()) {
      return failMemberAuth(
        "QUEST_CLIENT_VERSION_CONFIG_INVALID",
        "this Convex bundle has no valid baked Quest release version; deploy again with `QUEST_VERSION=x.y.z bun run convex:deploy`, then retry. No read or mutation was attempted.",
      );
    }
    if (configuredMinimum === undefined || configuredMinimum === "") {
      return deployedQuestVersion;
    }
    if (!isStableQuestVersion(configuredMinimum)) {
      return failMemberAuth(
        "QUEST_CLIENT_VERSION_CONFIG_INVALID",
        "QUEST_MIN_CLIENT_VERSION must be a stable released semantic version such as 1.2.3; set it before retrying. No read or mutation was attempted.",
      );
    }
    return configuredMinimum;
  }
  if (configuredMinimum === undefined || configuredMinimum === "") {
    return deployedQuestVersion;
  }
  if (!isStableQuestVersion(configuredMinimum)) {
    return failMemberAuth(
      "QUEST_CLIENT_VERSION_CONFIG_INVALID",
      `QUEST_MIN_CLIENT_VERSION must be a stable semantic version at least ${deployedQuestVersion}; set it to a value such as ${deployedQuestVersion}, then retry. No read or mutation was attempted.`,
    );
  }
  const comparison = compareQuestVersions(configuredMinimum, deployedQuestVersion);
  if (comparison === undefined) {
    return failMemberAuth(
      "QUEST_CLIENT_VERSION_CONFIG_INVALID",
      `QUEST_MIN_CLIENT_VERSION must be a semantic version at least ${deployedQuestVersion}; set it to a value such as ${deployedQuestVersion}, then retry. No read or mutation was attempted.`,
    );
  }
  return comparison > 0 ? configuredMinimum : deployedQuestVersion;
}

export function requireClientVersion(clientVersion: string | undefined): void {
  const minimum = minimumClientVersion();
  const developmentClientAllowed = developmentClientsAllowed();
  if (clientVersion === QUEST_DEV_VERSION) {
    if (developmentClientAllowed) {
      return;
    }
    failMemberAuth(
      "QUEST_CLI_OUTDATED",
      `this Quest CLI version ${clientVersion} is not allowed on this Convex deployment; the required released client version is ${minimum}; run \`quest upgrade\`, then retry. No read or mutation was attempted.`,
    );
  }
  const comparison =
    clientVersion === undefined ? undefined : compareQuestVersions(clientVersion, minimum);
  if (comparison !== undefined && comparison >= 0) {
    return;
  }

  const received = clientVersion === undefined ? "missing" : clientVersion;
  failMemberAuth(
    "QUEST_CLI_OUTDATED",
    `this Quest CLI version ${received} is older than the Convex deployment's required client version ${minimum}; run \`quest upgrade\`, then retry. No read or mutation was attempted.`,
  );
}

export function requireClientProtocol(clientProtocol: number | undefined): void {
  if (
    clientProtocol === undefined ||
    !Number.isSafeInteger(clientProtocol) ||
    clientProtocol < MINIMUM_QUEST_CLIENT_PROTOCOL
  ) {
    failMemberAuth(
      "QUEST_CLI_OUTDATED",
      "this Quest CLI is too old for this Convex deployment; run `quest upgrade`, then retry. No read or mutation was attempted.",
    );
  }
}

export function requireClientCompatibility(credentials: ClientProtocolInput): void {
  requireClientVersion(credentials.client_version);
  requireClientProtocol(credentials.client_protocol);
}

type MemberCredentials = ClientProtocolInput & {
  readonly auth_token?: string;
};

export type ExpensiveMemberQueryPage = {
  readonly actor: string;
  readonly cursorSection: string;
  readonly functionName: "exportAll" | "federatedSnapshot" | "rawExportAll";
};

export function logExpensiveMemberQueryPage(page: ExpensiveMemberQueryPage): void {
  // biome-ignore lint/suspicious/noConsole: Convex dashboard logs are the observability surface for expensive reads.
  console.log(
    JSON.stringify({
      actor: page.actor,
      function: page.functionName,
      cursor_section: page.cursorSection,
    }),
  );
}

export async function requireMemberActor(
  ctx: Pick<MemberMutationContext, "runMutation">,
  credentials: MemberCredentials,
): Promise<string> {
  requireClientCompatibility(credentials);
  const authToken = credentials.auth_token;
  if (authToken === undefined || authToken.trim() === "") {
    return failMemberAuth(
      "QUEST_CONVEX_TOKEN_REQUIRED",
      "this Convex deployment requires a member token; run `quest join <deployment-url>` or set QUEST_CONVEX_TOKEN and retry. No mutation was attempted.",
    );
  }

  const result = await questApiKeys.validate(ctx, { key: authToken });
  if (!result.valid || result.env !== "live" || !result.tags.includes("member")) {
    const reason = result.valid ? "not a member token" : result.reason;
    return failMemberAuth(
      "QUEST_CONVEX_TOKEN_INVALID",
      `the Convex member token was rejected (${reason}); run 'quest join <deployment-url>' or set QUEST_CONVEX_TOKEN to a current personal token, then retry. No mutation was attempted.`,
    );
  }

  return result.ownerId;
}

export async function hashMemberToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ExpireMemberTokenArgs = {
  readonly member_id: string;
  readonly key_id: string;
  readonly expires_at: number;
};

export const expireMemberTokenReference = makeFunctionReference<
  "mutation",
  ExpireMemberTokenArgs,
  null
>("auth:expireMemberToken");

export async function requireMemberQueryActor(
  ctx: MemberQueryContext,
  credentials: MemberCredentials,
): Promise<string> {
  requireClientCompatibility(credentials);
  const authToken = credentials.auth_token;
  if (authToken === undefined || authToken.trim() === "") {
    return failMemberAuth(
      "QUEST_CONVEX_TOKEN_REQUIRED",
      "this Convex deployment requires a member token; run `quest join <deployment-url>` or set QUEST_CONVEX_TOKEN and retry. No read was attempted.",
    );
  }

  const hash = await hashMemberToken(authToken);
  const now = Date.now();
  const members = await ctx.db
    .query("members")
    .withIndex("by_status", (query) => query.eq("status", "active"))
    .collect();
  const member = members.find((candidate) =>
    (candidate.token_hashes ?? []).some(
      (entry) => entry.hash === hash && (entry.expires_at === null || entry.expires_at > now),
    ),
  );
  if (member === undefined) {
    return failMemberAuth(
      "QUEST_CONVEX_TOKEN_INVALID",
      "the Convex member token was rejected; run `quest join <deployment-url>` or set QUEST_CONVEX_TOKEN to a current personal token, then retry. No read was attempted.",
    );
  }
  return member.name;
}

export const validateActorReference = makeFunctionReference<
  "mutation",
  { readonly auth_token: string } & ClientProtocolInput,
  string
>("auth:validateActor");

export const validateActor = internalMutationGeneric({
  args: {
    auth_token: v.string(),
    client_protocol: v.optional(v.number()),
    client_version: v.optional(v.string()),
  },
  handler: async (ctx: MemberMutationContext, args) => requireMemberActor(ctx, args),
});

export const expireMemberToken = internalMutationGeneric({
  args: {
    member_id: v.id("members"),
    key_id: v.string(),
    expires_at: v.number(),
  },
  handler: async (ctx: MemberMutationContext, args) => {
    const member = await ctx.db.get(args.member_id);
    if (member === null) {
      return null;
    }
    const tokenHashes = member.token_hashes ?? [];
    const remainingTokenHashes = tokenHashes.filter(
      (entry) => !(entry.key_id === args.key_id && entry.expires_at === args.expires_at),
    );
    if (remainingTokenHashes.length !== tokenHashes.length) {
      await ctx.db.patch(member._id, {
        token_hashes: remainingTokenHashes,
        updated_at: new Date().toISOString(),
      });
    }
    return null;
  },
});
