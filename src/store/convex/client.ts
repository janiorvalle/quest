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
  AcceptQuestAndDetailResult,
  Clock,
  FederatedFullSnapshot,
  FederatedReadSnapshot,
  QuestDetailSnapshot,
} from "../port";
import type {
  ConvexDumpPage,
  ConvexEventPage,
  ConvexListPage,
  ConvexRestorePage,
} from "./pagination";
import { type ClientProtocolInput, clientProtocolInput } from "./protocol";

type TestableMutation<T> = {
  readonly input: T;
  readonly test_failure?: boolean;
};

type AuthTokenInput = ClientProtocolInput & {
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

export interface ConvexReadyStatusMigrationResult {
  readonly converted: number;
  readonly total: number;
  readonly unchanged: number;
}

export type ConvexRestoreStatus =
  | { readonly status: "active" | "missing" }
  | { readonly status: "committed"; readonly lease_cutoff: string };

export interface ConvexActiveRestore {
  readonly status: "committed" | "copying" | "deleting" | "expired";
  readonly token: string;
}

interface LegacyAcceptQuestAndExportResult {
  readonly acceptance: AcceptResult;
  readonly snapshot: QuestDump;
}

export interface ConvexCommitRestoreResult {
  readonly status: "committed";
  readonly lease_cutoff: string;
}

export interface ConvexPendingRestoreResult {
  readonly status: "pending";
}

export const convexApi = {
  schemaVersion: makeFunctionReference<"query", ClientProtocolInput, number>("quest:schemaVersion"),
  serverTime: makeFunctionReference<"query", ClientProtocolInput, string>("quest:serverTime"),
  migrateReadyStatuses: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly admin_secret: string },
    ConvexReadyStatusMigrationResult
  >("quest:migrateReadyStatuses"),
  addQuest: makeFunctionReference<"mutation", AuthenticatedMutation<NewQuest>, Quest>(
    "quest:addQuest",
  ),
  acceptQuest: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<AcceptQuestInput>,
    AcceptResult
  >("quest:acceptQuest"),
  acceptQuestAndDetail: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<AcceptQuestInput>,
    AcceptQuestAndDetailResult
  >("quest:acceptQuestAndDetail"),
  acceptQuestAndExport: makeFunctionReference<
    "mutation",
    AuthenticatedMutation<AcceptQuestInput>,
    LegacyAcceptQuestAndExportResult
  >("quest:acceptQuestAndExport"),
  touchQuest: makeFunctionReference<"mutation", AuthenticatedMutation<TouchQuestInput>, Quest>(
    "quest:touchQuest",
  ),
  transition: makeFunctionReference<
    "mutation",
    AuthTokenInput & {
      readonly id: number;
      readonly transition: QuestTransition;
      readonly test_failure?: boolean;
    },
    Quest
  >("quest:transition"),
  signoffBatch: makeFunctionReference<
    "mutation",
    AuthTokenInput & {
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
    AuthTokenInput & {
      readonly cursor?: string;
      readonly filter: QuestFilter;
      readonly lease_cutoff: string;
    },
    ConvexListPage | Quest[]
  >("quest:listQuests"),
  getQuest: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly id: number; readonly lease_cutoff: string },
    Quest | null
  >("quest:getQuest"),
  questDetail: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly id: number },
    QuestDetailSnapshot
  >("quest:questDetail"),
  stats: makeFunctionReference<
    "query",
    AuthTokenInput & {
      readonly cursor?: string;
      readonly scope: QuestScope;
      readonly lease_cutoff: string;
    },
    ConvexListPage | QuestStats
  >("quest:stats"),
  fencedRepositories: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly cursor?: string },
    ConvexListPage | string[]
  >("quest:fencedRepositories"),
  federatedListSnapshot: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly cursor?: string; readonly repository?: string },
    ConvexListPage | FederatedReadSnapshot
  >("quest:federatedListSnapshot"),
  federatedSnapshot: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly cursor?: string },
    (ConvexDumpPage & { readonly fencedRepositories: readonly string[] }) | FederatedFullSnapshot
  >("quest:federatedSnapshot"),
  events: makeFunctionReference<"query", AuthTokenInput & { readonly quest_id: number }, Event[]>(
    "quest:events",
  ),
  queryEvents: makeFunctionReference<
    "query",
    AuthTokenInput & {
      readonly cursor?: string | null;
      readonly filter: EventFilter;
      readonly lease_cutoff: string;
    },
    Event[] | ConvexEventPage
  >("quest:queryEvents"),
  exportAll: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly cursor?: string; readonly lease_cutoff: string },
    ConvexDumpPage | QuestDump
  >("quest:exportAll"),
  rawExportAll: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly cursor?: string },
    ConvexDumpPage | QuestDump
  >("quest:rawExportAll"),
  replaceAll: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly dump: QuestDump },
    null
  >("quest:replaceAll"),
  beginRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & {
      readonly token: string;
      readonly expected_hash?: string;
      readonly expected_event_high_water?: number;
      readonly expected_snapshot?: string;
      readonly lease_cutoff: string;
      readonly restore_kind?: "full-backup";
    },
    { readonly status: "cleanup" | "ready" } | null
  >("quest:beginRestore"),
  renewRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly token: string },
    null
  >("quest:renewRestore"),
  activeRestore: makeFunctionReference<"query", AuthTokenInput, ConvexActiveRestore | null>(
    "quest:activeRestore",
  ),
  restoreStatus: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly token: string },
    ConvexRestoreStatus | { readonly status: "committed"; readonly dump: QuestDump }
  >("quest:restoreStatus"),
  uploadRestorePage: makeFunctionReference<
    "mutation",
    AuthTokenInput & {
      readonly token: string;
      readonly page: ConvexRestorePage;
    },
    null
  >("quest:uploadRestorePage"),
  activateRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & {
      readonly token: string;
      readonly replacement_hash?: string;
      readonly dump?: QuestDump;
    },
    QuestDump | null
  >("quest:activateRestore"),
  fenceRepository: makeFunctionReference<
    "mutation",
    ClientProtocolInput & {
      readonly token: string;
      readonly repo: string;
      readonly target_backend: string;
    },
    null
  >("quest:fenceRepository"),
  unfenceRepository: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly token: string; readonly repo: string },
    boolean
  >("quest:unfenceRepository"),
  recoverRepositoryFence: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly repo: string },
    boolean
  >("quest:recoverRepositoryFence"),
  recoverMigrationFenceForRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly token: string; readonly repo: string },
    boolean
  >("quest:recoverMigrationFenceForRestore"),
  commitRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly token: string },
    ConvexCommitRestoreResult | ConvexPendingRestoreResult | QuestDump | null
  >("quest:commitRestore"),
  releaseRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly token: string },
    boolean | null
  >("quest:releaseRestore"),
  rollbackRestore: makeFunctionReference<
    "mutation",
    AuthTokenInput & { readonly token: string },
    boolean | null
  >("quest:rollbackRestore"),
  generateBlobUploadUrl: makeFunctionReference<"mutation", AuthTokenInput, string>(
    "blob:generateUploadUrl",
  ),
  finalizeBlobUpload: makeFunctionReference<
    "action",
    AuthTokenInput & {
      readonly sha256: Sha256;
      readonly storage_id: string;
      readonly replace_existing?: boolean;
    },
    Sha256
  >("blob:finalizeUpload"),
  getBlobUrl: makeFunctionReference<
    "query",
    AuthTokenInput & { readonly sha256: Sha256 },
    string | null
  >("blob:getUrl"),
  hasBlob: makeFunctionReference<"query", AuthTokenInput & { readonly sha256: Sha256 }, boolean>(
    "blob:has",
  ),
  membersInvite: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly admin_secret: string; readonly name: string },
    { readonly member: string; readonly token: string }
  >("members:invite"),
  membersRotate: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly admin_secret: string; readonly name: string },
    { readonly member: string; readonly old_key_expires_at: number; readonly token: string }
  >("members:rotate"),
  membersRemove: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly admin_secret: string; readonly name: string },
    { readonly member: string; readonly revoked_keys: number }
  >("members:remove"),
  membersList: makeFunctionReference<
    "query",
    ClientProtocolInput & { readonly admin_secret: string },
    ConvexMember[]
  >("members:list"),
  join: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly invite_token: string },
    { readonly member: string; readonly token: string }
  >("members:join"),
  whoami: makeFunctionReference<
    "mutation",
    ClientProtocolInput & { readonly auth_token: string },
    { readonly member: string }
  >("members:whoami"),
};

export interface ConvexClientPair {
  readonly http: NativeConvexHttpClient;
  readonly realtime: ConvexClient;
  readonly authToken?: string;
  readonly protocol?: ConvexClientProtocol;
}

export interface ConvexClientProtocol {
  input(): ClientProtocolInput;
}

class ConvexClientProtocolState implements ConvexClientProtocol {
  #legacy = false;

  input(): ClientProtocolInput {
    return this.#legacy ? {} : clientProtocolInput();
  }

  selectLegacyProtocol(): void {
    this.#legacy = true;
  }
}

export function convexClientProtocolInput(
  clients: Pick<ConvexClientPair, "protocol">,
): ClientProtocolInput {
  return clients.protocol?.input() ?? clientProtocolInput();
}

export function authTokenInput(
  clients: Pick<ConvexClientPair, "authToken" | "protocol">,
): AuthTokenInput {
  return clients.authToken === undefined
    ? convexClientProtocolInput(clients)
    : { ...convexClientProtocolInput(clients), auth_token: clients.authToken };
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

function withClientProtocol<Args extends readonly unknown[]>(args: Args): Args {
  const [input, ...rest] = args;
  return [
    { ...(input as Readonly<Record<string, unknown>>), ...clientProtocolInput() },
    ...rest,
  ] as unknown as Args;
}

function withoutClientProtocol<Args extends readonly unknown[]>(args: Args): Args {
  const [input, ...rest] = args;
  const { client_protocol: _clientProtocol, ...legacyInput } = input as Readonly<
    Record<string, unknown>
  >;
  return [legacyInput, ...rest] as unknown as Args;
}

function isUnsupportedClientProtocol(error: unknown): boolean {
  return (
    error instanceof Error &&
    /ArgumentValidationError[\s\S]*(?:extra field|not in the validator)[\s\S]*client_protocol|ArgumentValidationError[\s\S]*client_protocol[\s\S]*(?:extra field|not in the validator)/i.test(
      error.message,
    )
  );
}

class QuestConvexHttpClient extends NativeConvexHttpClient {
  readonly #protocol: ConvexClientProtocolState;

  constructor(
    address: string,
    options: ConstructorParameters<typeof NativeConvexHttpClient>[1],
    protocol: ConvexClientProtocolState,
  ) {
    super(address, options);
    this.#protocol = protocol;
  }

  async #request<Args extends readonly unknown[], Result>(
    args: Args,
    request: (nextArgs: Args) => Promise<Result>,
  ): Promise<Result> {
    const nextArgs =
      this.#protocol.input().client_protocol === undefined
        ? withoutClientProtocol(args)
        : withClientProtocol(args);
    try {
      return await request(nextArgs);
    } catch (error: unknown) {
      if (!isUnsupportedClientProtocol(error)) {
        throw normalizeConvexError(error);
      }
      this.#protocol.selectLegacyProtocol();
      try {
        return await request(withoutClientProtocol(args));
      } catch (retryError: unknown) {
        throw normalizeConvexError(retryError);
      }
    }
  }

  override async consistentQuery<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    return this.#request(args, (nextArgs) => super.consistentQuery(query, ...nextArgs));
  }

  override async query<Query extends FunctionReference<"query">>(
    query: Query,
    ...args: OptionalRestArgs<Query>
  ): Promise<FunctionReturnType<Query>> {
    return this.#request(args, (nextArgs) => super.query(query, ...nextArgs));
  }

  override async mutation<Mutation extends FunctionReference<"mutation">>(
    mutation: Mutation,
    ...args: ArgsAndOptions<Mutation, HttpMutationOptions>
  ): Promise<FunctionReturnType<Mutation>> {
    return this.#request(args, (nextArgs) => super.mutation(mutation, ...nextArgs));
  }

  override async action<Action extends FunctionReference<"action">>(
    action: Action,
    ...args: OptionalRestArgs<Action>
  ): Promise<FunctionReturnType<Action>> {
    return this.#request(args, (nextArgs) => super.action(action, ...nextArgs));
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
  const protocol = new ConvexClientProtocolState();
  return new QuestConvexHttpClient(
    deployment,
    {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    },
    protocol,
  );
}

export function createConvexClientPair(
  address: string,
  options: { readonly authToken?: string } = {},
): ConvexClientPair {
  const deployment = requireConvexClientDeployment(address);
  const protocol = new ConvexClientProtocolState();
  return {
    http: new QuestConvexHttpClient(
      deployment,
      {
        logger: false,
        skipConvexDeploymentUrlCheck: true,
      },
      protocol,
    ),
    realtime: new ConvexClient(deployment, {
      logger: false,
      skipConvexDeploymentUrlCheck: true,
    }),
    protocol,
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
  };
}

export async function closeConvexClientPair(clients: ConvexClientPair): Promise<void> {
  await clients.realtime.close();
}

export function createConvexClock(clients: ConvexClientPair): Clock {
  return {
    now: () => clients.http.query(convexApi.serverTime, convexClientProtocolInput(clients)),
  };
}
