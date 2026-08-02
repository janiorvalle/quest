import {
  actionGeneric,
  type DataModelFromSchemaDefinition,
  type GenericActionCtx,
  type GenericQueryCtx,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { type GenericId, v } from "convex/values";

import { sha256Schema } from "../src/schema";
import { requireMemberActor, requireMemberQueryActor, validateActorReference } from "./auth";
import type schema from "./schema";

type BlobRecord = {
  readonly storage_id: GenericId<"_storage">;
  readonly bytes: number;
};

type BlobRecordMutationResult = {
  readonly redundant_storage_id: GenericId<"_storage"> | null;
  readonly replaced_storage_id: GenericId<"_storage"> | null;
};

const recordBlobReference = makeFunctionReference<
  "mutation",
  {
    readonly sha256: string;
    readonly storage_id: GenericId<"_storage">;
    readonly bytes: number;
    readonly replace_existing?: boolean;
  },
  BlobRecordMutationResult
>("blob:record");

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function findBlob(ctx: QueryContext, address: string): Promise<BlobRecord | null> {
  const record = await ctx.db
    .query("blobs")
    .withIndex("by_sha256", (query) => query.eq("sha256", address))
    .unique();
  return record === null ? null : { storage_id: record.storage_id, bytes: record.bytes };
}

type QueryContext = GenericQueryCtx<DataModelFromSchemaDefinition<typeof schema>>;
type ActionContext = GenericActionCtx<DataModelFromSchemaDefinition<typeof schema>>;

export const record = internalMutationGeneric({
  args: {
    sha256: v.string(),
    storage_id: v.id("_storage"),
    bytes: v.number(),
    replace_existing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const address = sha256Schema.parse(args.sha256);
    const existing = await ctx.db
      .query("blobs")
      .withIndex("by_sha256", (query) => query.eq("sha256", address))
      .unique();
    if (existing === null) {
      await ctx.db.insert("blobs", {
        sha256: address,
        storage_id: args.storage_id,
        bytes: args.bytes,
      });
      return { redundant_storage_id: null, replaced_storage_id: null };
    }
    const existingStorage = await ctx.db.system.get("_storage", existing.storage_id);
    if (existingStorage !== null && args.replace_existing !== true) {
      return {
        redundant_storage_id: existing.storage_id === args.storage_id ? null : args.storage_id,
        replaced_storage_id: null,
      };
    }
    await ctx.db.patch(existing._id, { storage_id: args.storage_id, bytes: args.bytes });
    return {
      redundant_storage_id: null,
      replaced_storage_id: existingStorage === null ? null : existing.storage_id,
    };
  },
});

export const generateUploadUrl = mutationGeneric({
  args: { auth_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireMemberActor(ctx, args.auth_token);
    return ctx.storage.generateUploadUrl();
  },
});

export const finalizeUpload = actionGeneric({
  args: {
    auth_token: v.optional(v.string()),
    sha256: v.string(),
    storage_id: v.id("_storage"),
    replace_existing: v.optional(v.boolean()),
  },
  handler: async (ctx: ActionContext, args) => {
    await ctx.runMutation(validateActorReference, { auth_token: args.auth_token ?? "" });
    const address = sha256Schema.parse(args.sha256);
    const stored = await ctx.storage.get(args.storage_id);
    if (stored === null) {
      throw new Error(`uploaded blob ${args.storage_id} is missing; retry the upload`);
    }
    const bytes = await stored.arrayBuffer();
    const actual = await sha256(bytes);
    if (actual !== address) {
      try {
        await ctx.storage.delete(args.storage_id);
      } catch {
        throw new Error(
          `blob hash mismatch: expected ${address}, received ${actual}; cleanup failed, retry the upload`,
        );
      }
      throw new Error(`blob hash mismatch: expected ${address}, received ${actual}`);
    }
    const result: BlobRecordMutationResult = await ctx.runMutation(recordBlobReference, {
      sha256: address,
      storage_id: args.storage_id,
      bytes: bytes.byteLength,
      ...(args.replace_existing === undefined ? {} : { replace_existing: args.replace_existing }),
    });
    if (result.redundant_storage_id !== null) {
      await ctx.storage.delete(result.redundant_storage_id);
    }
    if (result.replaced_storage_id !== null && result.replaced_storage_id !== args.storage_id) {
      await ctx.storage.delete(result.replaced_storage_id);
    }
    return address;
  },
});

export const getUrl = queryGeneric({
  args: { auth_token: v.optional(v.string()), sha256: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const address = sha256Schema.parse(args.sha256);
    const record = await findBlob(ctx, address);
    return record === null ? null : ctx.storage.getUrl(record.storage_id);
  },
});

export const has = queryGeneric({
  args: { auth_token: v.optional(v.string()), sha256: v.string() },
  handler: async (ctx, args) => {
    await requireMemberQueryActor(ctx, args.auth_token);
    const address = sha256Schema.parse(args.sha256);
    const record = await findBlob(ctx, address);
    return record === null
      ? false
      : (await ctx.db.system.get("_storage", record.storage_id)) !== null;
  },
});
