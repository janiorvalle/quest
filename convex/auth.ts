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

import type schema from "./schema";

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

type MemberAuthErrorCode = "QUEST_CONVEX_TOKEN_REQUIRED" | "QUEST_CONVEX_TOKEN_INVALID";

function failMemberAuth(code: MemberAuthErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

export async function requireMemberActor(
  ctx: Pick<MemberMutationContext, "runMutation">,
  authToken: string | undefined,
): Promise<string> {
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
  authToken: string | undefined,
): Promise<string> {
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
  { readonly auth_token: string },
  string
>("auth:validateActor");

export const validateActor = internalMutationGeneric({
  args: { auth_token: v.string() },
  handler: async (ctx: MemberMutationContext, args) => requireMemberActor(ctx, args.auth_token),
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
