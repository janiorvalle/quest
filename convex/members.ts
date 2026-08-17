import type { KeyMetadata, RotateResult } from "@vllnt/convex-api-keys";
import {
  type DataModelFromSchemaDefinition,
  type GenericQueryCtx,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, v } from "convex/values";

import { assertAdminSecret } from "./admin";
import {
  expireMemberTokenReference,
  hashMemberToken,
  type MemberMutationContext,
  questApiKeys,
  requireClientProtocol,
  requireMemberActor,
} from "./auth";
import type schema from "./schema";

type MemberQueryContext = GenericQueryCtx<DataModelFromSchemaDefinition<typeof schema>>;

const memberNameLimit = 256;
const inviteKeyName = "quest invite";
const memberKeyName = "quest member";

type MemberErrorCode =
  | "QUEST_MEMBER_NAME_REQUIRED"
  | "QUEST_MEMBER_NAME_TOO_LONG"
  | "QUEST_MEMBER_ALREADY_EXISTS"
  | "QUEST_MEMBER_NOT_FOUND"
  | "QUEST_MEMBER_NOT_ACTIVE"
  | "QUEST_MEMBER_ALREADY_JOINED"
  | "QUEST_INVITE_INVALID"
  | "QUEST_MEMBER_KEY_MISSING"
  | "QUEST_FINITE_KEY_ROTATION_FORBIDDEN";

function failMember(code: MemberErrorCode, message: string): never {
  throw new ConvexError({ code, message });
}

export function normalizeMemberName(value: string): string {
  const name = value.trim();
  if (name === "") {
    return failMember(
      "QUEST_MEMBER_NAME_REQUIRED",
      "member name is empty; retry with `quest members invite <name>` using a non-empty name. No roster mutation was attempted.",
    );
  }
  if (name.length > memberNameLimit) {
    return failMember(
      "QUEST_MEMBER_NAME_TOO_LONG",
      `member name is longer than ${memberNameLimit} characters; retry with a shorter name. No roster mutation was attempted.`,
    );
  }
  return name;
}

async function findMember(ctx: MemberQueryContext, name: string) {
  return ctx.db
    .query("members")
    .withIndex("by_name", (query) => query.eq("name", name))
    .unique();
}

function memberErrorMessage(code: MemberErrorCode, name: string): string {
  switch (code) {
    case "QUEST_MEMBER_ALREADY_EXISTS":
      return (
        "member " +
        name +
        " already has an invite or active key; run 'quest members rotate " +
        name +
        "' for an active member, or 'quest members remove " +
        name +
        "' before reinviting. No roster mutation was attempted."
      );
    case "QUEST_MEMBER_NOT_FOUND":
      return (
        "member " +
        name +
        " is not in this deployment; run 'quest members invite " +
        name +
        "' first. No roster mutation was attempted."
      );
    case "QUEST_MEMBER_NOT_ACTIVE":
      return (
        "member " +
        name +
        " has not completed 'quest join <deployment-url>'; send the one-time invite token and retry after they join. No roster mutation was attempted."
      );
    case "QUEST_MEMBER_KEY_MISSING":
      return `member ${name} is active but has no current personal key; remove and reinvite the member. No roster mutation was attempted.`;
    case "QUEST_MEMBER_ALREADY_JOINED":
      return `member ${name} already joined; use the configured token or ask an admin to remove and reinvite the member. No roster mutation was attempted.`;
    case "QUEST_INVITE_INVALID":
      return "the invite token was rejected or already consumed; ask the administrator to run `quest members invite <name>` again. No roster mutation was attempted.";
    case "QUEST_FINITE_KEY_ROTATION_FORBIDDEN":
      return "finite-use keys cannot be rotated; invite tokens are one-time and must be replaced with `quest members invite <name>`. Revisit this guard only after @vllnt/convex-api-keys v0.3 fixes finite-use rotation quota sharing. No key rotation was attempted.";
    case "QUEST_MEMBER_NAME_REQUIRED":
    case "QUEST_MEMBER_NAME_TOO_LONG":
      return "invalid member name";
  }
}

function requireMemberRecord(record: Awaited<ReturnType<typeof findMember>>, name: string) {
  if (record === null) {
    return failMember("QUEST_MEMBER_NOT_FOUND", memberErrorMessage("QUEST_MEMBER_NOT_FOUND", name));
  }
  return record;
}

function requireActiveMember(record: Awaited<ReturnType<typeof findMember>>, name: string) {
  const member = requireMemberRecord(record, name);
  if (member.status !== "active") {
    return failMember(
      "QUEST_MEMBER_NOT_ACTIVE",
      memberErrorMessage("QUEST_MEMBER_NOT_ACTIVE", name),
    );
  }
  return member;
}

export function assertMemberKeyCanRotate(key: Pick<KeyMetadata, "remaining">): void {
  // Guard: the upstream v0.2.0 H7 defect duplicates finite-use quota during rotation. The vetting record
  // (in the pre-public private archive) documents the failure; revisit only after upstream v0.3.
  if (key.remaining !== undefined) {
    failMember(
      "QUEST_FINITE_KEY_ROTATION_FORBIDDEN",
      memberErrorMessage("QUEST_FINITE_KEY_ROTATION_FORBIDDEN", "the selected key"),
    );
  }
}

export type MemberKeyRotator = (input: {
  readonly keyId: string;
  readonly ownerId: string;
}) => Promise<RotateResult>;

export async function rotateMemberKey(
  rotate: MemberKeyRotator,
  key: Pick<KeyMetadata, "keyId" | "remaining">,
  ownerId: string,
): Promise<RotateResult> {
  assertMemberKeyCanRotate(key);
  return rotate({ keyId: key.keyId, ownerId });
}

export type MemberKeyBulkRevoker = (input: {
  readonly ownerId: string;
  readonly tag: string;
}) => Promise<{ readonly revokedCount: number }>;

export async function revokeOwnerKeys(
  revokeByTag: MemberKeyBulkRevoker,
  ownerId: string,
): Promise<number> {
  const memberKeys = await revokeByTag({ ownerId, tag: "member" });
  const inviteKeys = await revokeByTag({ ownerId, tag: "invite" });
  return memberKeys.revokedCount + inviteKeys.revokedCount;
}

export const invite = mutationGeneric({
  args: {
    admin_secret: v.string(),
    client_protocol: v.optional(v.number()),
    name: v.string(),
  },
  handler: async (ctx: MemberMutationContext, args) => {
    await assertAdminSecret(args.admin_secret);
    const name = normalizeMemberName(args.name);
    const existing = await findMember(ctx, name);
    if (existing !== null && existing.status !== "removed") {
      return failMember(
        "QUEST_MEMBER_ALREADY_EXISTS",
        memberErrorMessage("QUEST_MEMBER_ALREADY_EXISTS", name),
      );
    }

    const key = await questApiKeys.create(ctx, {
      env: "invite",
      metadata: { kind: "invite" },
      name: inviteKeyName,
      ownerId: name,
      remaining: 1,
      tags: ["invite"],
    });
    const timestamp = new Date().toISOString();
    if (existing === null) {
      await ctx.db.insert("members", {
        created_at: timestamp,
        name,
        status: "invited",
        token_hashes: [],
        updated_at: timestamp,
      });
    } else {
      await ctx.db.patch(existing._id, { status: "invited", updated_at: timestamp });
    }
    return { member: name, token: key.key };
  },
});

export const rotate = mutationGeneric({
  args: {
    admin_secret: v.string(),
    client_protocol: v.optional(v.number()),
    name: v.string(),
  },
  handler: async (ctx: MemberMutationContext, args) => {
    await assertAdminSecret(args.admin_secret);
    const name = normalizeMemberName(args.name);
    const member = requireActiveMember(await findMember(ctx, name), name);
    const keys = await questApiKeys.list(ctx, {
      env: "live",
      ownerId: name,
      status: "active",
    });
    const current = keys.find((key) => key.name === memberKeyName && key.status === "active");
    if (current === undefined) {
      return failMember(
        "QUEST_MEMBER_KEY_MISSING",
        memberErrorMessage("QUEST_MEMBER_KEY_MISSING", name),
      );
    }
    const currentToken = (member.token_hashes ?? []).find(
      (entry) => entry.key_id === current.keyId && entry.expires_at === null,
    );
    if (currentToken === undefined) {
      return failMember(
        "QUEST_MEMBER_KEY_MISSING",
        memberErrorMessage("QUEST_MEMBER_KEY_MISSING", name),
      );
    }
    const result = await rotateMemberKey((input) => questApiKeys.rotate(ctx, input), current, name);
    const now = Date.now();
    const tokenHashes = [
      ...(member.token_hashes ?? []).filter(
        (entry) =>
          entry.key_id !== current.keyId && (entry.expires_at === null || entry.expires_at > now),
      ),
      { key_id: current.keyId, hash: currentToken.hash, expires_at: result.oldKeyExpiresAt },
      { key_id: result.newKeyId, hash: await hashMemberToken(result.newKey), expires_at: null },
    ];
    await ctx.db.patch(member._id, {
      token_hashes: tokenHashes,
      updated_at: new Date().toISOString(),
    });
    await ctx.scheduler.runAt(result.oldKeyExpiresAt, expireMemberTokenReference, {
      member_id: member._id,
      key_id: current.keyId,
      expires_at: result.oldKeyExpiresAt,
    });
    return {
      member: name,
      old_key_expires_at: result.oldKeyExpiresAt,
      token: result.newKey,
    };
  },
});

export const remove = mutationGeneric({
  args: {
    admin_secret: v.string(),
    client_protocol: v.optional(v.number()),
    name: v.string(),
  },
  handler: async (ctx: MemberMutationContext, args) => {
    await assertAdminSecret(args.admin_secret);
    const name = normalizeMemberName(args.name);
    const member = requireMemberRecord(await findMember(ctx, name), name);
    if (member.status === "removed") {
      return { member: name, revoked_keys: 0 };
    }
    const revokedKeys = await revokeOwnerKeys(
      (input) => questApiKeys.revokeByTag(ctx, input),
      name,
    );
    await ctx.db.patch(member._id, {
      status: "removed",
      token_hashes: [],
      updated_at: new Date().toISOString(),
    });
    return { member: name, revoked_keys: revokedKeys };
  },
});

export const list = queryGeneric({
  args: { admin_secret: v.string(), client_protocol: v.optional(v.number()) },
  handler: async (ctx: MemberQueryContext, args) => {
    await assertAdminSecret(args.admin_secret);
    const members = await ctx.db.query("members").collect();
    return members
      .map(({ name, status, created_at, updated_at }) => ({
        created_at,
        name,
        status,
        updated_at,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  },
});

export const join = mutationGeneric({
  args: { client_protocol: v.optional(v.number()), invite_token: v.string() },
  handler: async (ctx: MemberMutationContext, args) => {
    requireClientProtocol(args.client_protocol);
    const inviteToken = args.invite_token.trim();
    const result = await questApiKeys.validate(ctx, { key: inviteToken });
    if (
      !result.valid ||
      result.env !== "invite" ||
      !result.tags.includes("invite") ||
      result.metadata?.["kind"] !== "invite"
    ) {
      return failMember("QUEST_INVITE_INVALID", memberErrorMessage("QUEST_INVITE_INVALID", ""));
    }
    const name = normalizeMemberName(result.ownerId);
    const existing = await findMember(ctx, name);
    if (existing !== null && existing.status === "active") {
      return failMember(
        "QUEST_MEMBER_ALREADY_JOINED",
        memberErrorMessage("QUEST_MEMBER_ALREADY_JOINED", name),
      );
    }
    const key = await questApiKeys.create(ctx, {
      env: "live",
      metadata: { kind: "member" },
      name: memberKeyName,
      ownerId: name,
      tags: ["member"],
    });
    const timestamp = new Date().toISOString();
    if (existing === null) {
      await ctx.db.insert("members", {
        created_at: timestamp,
        name,
        status: "active",
        token_hashes: [
          { key_id: key.keyId, hash: await hashMemberToken(key.key), expires_at: null },
        ],
        updated_at: timestamp,
      });
    } else {
      await ctx.db.patch(existing._id, {
        status: "active",
        token_hashes: [
          { key_id: key.keyId, hash: await hashMemberToken(key.key), expires_at: null },
        ],
        updated_at: timestamp,
      });
    }
    return { member: name, token: key.key };
  },
});

export const whoami = mutationGeneric({
  args: { auth_token: v.string(), client_protocol: v.optional(v.number()) },
  handler: async (ctx: MemberMutationContext, args) => ({
    member: await requireMemberActor(ctx, args),
  }),
});
