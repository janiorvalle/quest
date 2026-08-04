import {
  ConvexClient,
  type HttpMutationOptions,
  ConvexHttpClient as NativeConvexHttpClient,
} from "convex/browser";
import type {
  ArgsAndOptions,
  FunctionReference,
  FunctionReturnType,
  OptionalRestArgs,
} from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

import { ConvexDeploymentError, normalizeConvexDeployment } from "../../config";
import type {
  AcceptQuestInput,
  AcceptResult,
  ChainMutation,
  ChainRemovalResult,
  ChainResult,
  Event,
  EventFilter,
  Evidence,
  NewEvidence,
  NewQuest,
  Quest,
  QuestDump,
  QuestFilter,
  QuestScope,
  QuestStats,
  QuestTransition,
  Sha256,
  SignoffBatchInput,
  SignoffBatchResult,
  TouchQuestInput,
} from "../../schema";
import type {
  AcceptQuestAndExportResult,
  Clock,
  FederatedReadSnapshot,
  QuestDetailSnapshot,
} from "../port";

type TestableMutation<T> = {
  readonly input: T;
  readonly test_failure?: boolean;
};

type AuthTokenInput = {
  readonly auth_token?: string;
};

type AuthenticatedMutation<T> = TestableMutation<T> & AuthTokenInput;

export type ConvexMemberStatus = "invited" | "active" | "removed";

export interface ConvexMember {
  readonly created_at: string;
  readonly name: string;
  readonly status: ConvexMemberStatus;
  readonly updated_at: string;
}

export const convexApi = {
  schemaVersion: makeFunctionReference<"query", Record<string, never>, number>(
    "quest:schemaVersion",
  ),
  serverTime: makeFunctionReference<"query", Record<string, never>, string>("quest:serverTime"),
  addQuest: makeFunctionReference<"mutation", AuthenticatedMutation<NewQuest>, Quest>(
    "quest:addQuest",
  ),
  acceptQuest: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<AcceptQuestInput>,
    AcceptResult
  >("quest:acceptQuest"),
  acceptQuestAndExport: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<AcceptQuestInput>,
    AcceptQuestAndExportResult
  >("quest:acceptQuestAndExport"),
  touchQuest: makeFunctionReference<"mutation", AuthenticatedMutation<TouchQuestInput>, Quest>(
    "quest:touchQuest",
  ),
  transition: makeFunctionReference<
    "mutation",
    {
      readonly auth_token?: string;
      readonly id: number;
      readonly transition: QuestTransition;
      readonly test_failure?: boolean;
    },
    Quest
  >("quest:transition"),
  signoffBatch: makeFunctionReference<
    "mutation",
    {
      readonly auth_token?: string;
      readonly input: SignoffBatchInput;
      readonly test_failure?: boolean;
    },
    SignoffBatchResult
  >("quest:signoffBatch"),
  addChainLink: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<ChainMutation>,
    ChainResult
  >("quest:addChainLink"),
  removeChainLink: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<ChainMutation>,
    ChainRemovalResult
  >("quest:removeChainLink"),
  addEvidence: makeFunctionReference<"mutation", AuthenticatedMutation<NewEvidence>, Evidence>(
    "quest:addEvidence",
  ),
  listQuests: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly filter: QuestFilter; readonly lease_cutoff: string },
    Quest[]
  >("quest:listQuests"),
  getQuest: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly id: number; readonly lease_cutoff: string },
    Quest | null
  >("quest:getQuest"),
  questDetail: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly id: number },
    QuestDetailSnapshot
  >("quest:questDetail"),
  stats: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly scope: QuestScope; readonly lease_cutoff: string },
    QuestStats
  >("quest:stats"),
  fencedRepositories: makeFunctionReference<"query", { readonly auth_token?: string }, string[]>(
    "quest:fencedRepositories",
  ),
  federatedSnapshot: makeFunctionReference<
    "query",
    { readonly auth_token?: string },
    FederatedReadSnapshot
  >("quest:federatedSnapshot"),
  events: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly quest_id: number },
    Event[]
  >("quest:events"),
  queryEvents: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly filter: EventFilter; readonly lease_cutoff: string },
    Event[]
  >("quest:queryEvents"),
  exportAll: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly lease_cutoff: string },
    QuestDump
  >("quest:exportAll"),
  rawExportAll: makeFunctionReference<"query", { readonly auth_token?: string }, QuestDump>(
    "quest:rawExportAll",
  ),
  replaceAll: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly dump: QuestDump },
    null
  >("quest:replaceAll"),
  beginRestore: makeFunctionReference<
    "mutation",
    {
      readonly auth_token?: string;
      readonly token: string;
      readonly expected_snapshot: string;
      readonly lease_cutoff: string;
      readonly restore_kind?: "full-backup";
    },
    null
  >("quest:beginRestore"),
  renewRestore: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly token: string },
    null
  >("quest:renewRestore"),
  restoreStatus: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly token: string },
    | { readonly status: "active" | "missing" }
    | { readonly status: "committed"; readonly dump: QuestDump }
  >("quest:restoreStatus"),
  activateRestore: makeFunctionReference<
    "mutation",
    {
      readonly auth_token?: string;
      readonly token: string;
      readonly dump: QuestDump;
    },
    QuestDump
  >("quest:activateRestore"),
  fenceRepository: makeFunctionReference<
    "mutation",
    { readonly token: string; readonly repo: string; readonly target_backend: string },
    null
  >("quest:fenceRepository"),
  unfenceRepository: makeFunctionReference<
    "mutation",
    { readonly token: string; readonly repo: string },
    boolean
  >("quest:unfenceRepository"),
  recoverRepositoryFence: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly repo: string },
    boolean
  >("quest:recoverRepositoryFence"),
  recoverMigrationFenceForRestore: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly token: string; readonly repo: string },
    boolean
  >("quest:recoverMigrationFenceForRestore"),
  commitRestore: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly token: string },
    QuestDump | null
  >("quest:commitRestore"),
  releaseRestore: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly token: string },
    null
  >("quest:releaseRestore"),
  rollbackRestore: makeFunctionReference<
    "mutation",
    { readonly auth_token?: string; readonly token: string },
    null
  >("quest:rollbackRestore"),
  generateBlobUploadUrl: makeFunctionReference<"mutation", AuthTokenInput, string>(
    "blob:generateUploadUrl",
  ),
  finalizeBlobUpload: makeFunctionReference<
    "action",
    {
      readonly auth_token?: string;
      readonly sha256: Sha256;
      readonly storage_id: string;
      readonly replace_existing?: boolean;
    },
    Sha256
  >("blob:finalizeUpload"),
  getBlobUrl: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly sha256: Sha256 },
    string | null
  >("blob:getUrl"),
  hasBlob: makeFunctionReference<
    "query",
    { readonly auth_token?: string; readonly sha256: Sha256 },
    boolean
  >("blob:has"),
  membersInvite: makeFunctionReference<
    "mutation",
    { readonly admin_secret: string; readonly name: string },
    { readonly member: string; readonly token: string }
  >("members:invite"),
  membersRotate: makeFunctionReference<
    "mutation",
    { readonly admin_secret: string; readonly name: string },
    { readonly member: string; readonly old_key_expires_at: number; readonly token: string }
  >("members:rotate"),
  membersRemove: makeFunctionReference<
    "mutation",
    { readonly admin_secret: string; readonly name: string },
    { readonly member: string; readonly revoked_keys: number }
  >("members:remove"),
  membersList: makeFunctionReference<"query", { readonly admin_secret: string }, ConvexMember[]>(
    "members:list",
  ),
  join: makeFunctionReference<
    "mutation",
    { readonly invite_token: string },
    { readonly member: string; readonly token: string }
  >("members:join"),
  whoami: makeFunctionReference<
    "mutation",
    { readonly auth_token: string },
    { readonly member: string }
  >("members:whoami"),
};

export interface ConvexClientPair {
  readonly http: NativeConvexHttpClient;
  readonly realtime: ConvexClient;
  readonly authToken?: string;
}

export function authTokenInput(clients: Pick<ConvexClientPair, "authToken">): AuthTokenInput {
  return clients.authToken === undefined ? {} : { auth_token: clients.authToken };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConvexError(error: unknown): unknown {
  if (!(error instanceof ConvexError) || !isRecord(error.data)) {
    return error;
  }
  const code = error.data["code"];
  const message = error.data["message"];
  if (typeof code !== "string" || typeof message !== "string") {
    return error;
  }
  return new Error(`[${code}] ${message}`);
}

class QuestConvexHttpClient extends NativeConvexHttpClient {
  override async consistentQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    try {
      return await super.consistentQuery(query, ...args);
    } catch (error: unknown) {
      throw normalizeConvexError(error);
    }
  }

  override async query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    try {
      return await super.query(query, ...args);
    } catch (error: unknown) {
      throw normalizeConvexError(error);
    }
  }

  override async mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...args: ArgsAndOptions<Mutation, HttpMutationOptions>
  ): Promise<FunctionReturnType<Mutation>> {
    try {
      return await super.mutation(mutation, ...args);
    } catch (error: unknown) {
      throw normalizeConvexError(error);
    }
  }

  override async action<Action extends FunctionReference<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<FunctionReturnType<Action>> {
    try {
      return await super.action(action, ...args);
    } catch (error: unknown) {
      throw normalizeConvexError(error);
    }
  }
}

function requireConvexClientDeployment(address: string): string {
  const deployment = normalizeConvexDeployment(address);
  if (deployment === "") {
    throw new Error("Convex deployment URL is empty; set store.convex_deployment first");
  }
  let url: URL;
  try {
    url = new URL(deployment);
  } catch {
    throw new ConvexDeploymentError(
      "QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED",
      "[QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED] Convex clients require a full https:// deployment URL or a recognized local http:// URL; replace the local deployment label with the URL printed by Convex. No credentials were sent.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConvexDeploymentError(
      "QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED",
      "[QUEST_CONVEX_DEPLOYMENT_UNSUPPORTED] Convex clients require a full https:// deployment URL or a recognized local http:// URL; replace the local deployment label with the URL printed by Convex. No credentials were sent.",
    );
  }
  return deployment;
}

export interface ConvexHttpClientOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export function createConvexHttpClient(
  address: string,
  options: ConvexHttpClientOptions = {},
): NativeConvexHttpClient {
  const deployment = requireConvexClientDeployment(address);
  return new QuestConvexHttpClient(deployment, {
    logger: false,
    skipConvexDeploymentUrlCheck: true,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export function createConvexClientPair(
  address: string,
  options: { readonly authToken?: string } = {},
): ConvexClientPair {
  const deployment = requireConvexClientDeployment(address);
  return {
    http: createConvexHttpClient(deployment),
    realtime: new ConvexClient(deployment, {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
    }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  };
}

export async function closeConvexClientPair(clients: ConvexClientPair): Promise<void> {
  await clients.realtime.close();
}

export function createConvexClock(clients: ConvexClientPair): Clock {
  return {
    now: () => clients.http.query(convexApi.serverTime, {}),
  };
}
