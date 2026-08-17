import { DEFAULT_LEASE_TTL_MINUTES, normalizeLeaseTtlMinutes } from "../../domain";
import {
  type AcceptQuestInput,
  type AcceptResult,
  acceptQuestInputSchema,
  type ChainMutation,
  type ChainRemovalResult,
  type ChainResult,
  chainMutationSchema,
  type Event,
  type EventFilter,
  type Evidence,
  eventFilterSchema,
  federatedListDumpSchema,
  type NewEvidence,
  type NewQuest,
  newEvidenceSchema,
  newQuestSchema,
  type Quest,
  type QuestDump,
  type QuestFilter,
  type QuestScope,
  type QuestStats,
  type QuestTransition,
  questDumpSchema,
  questFilterSchema,
  questSchema,
  questScopeSchema,
  questTransitionSchema,
  type SignoffBatchInput,
  type SignoffBatchResult,
  signoffBatchInputSchema,
  stableSerialize,
  type TouchQuestInput,
  touchQuestInputSchema,
} from "../../schema";
import type {
  AcceptQuestAndDetailResult,
  FederatedFullSnapshot,
  FederatedReadSnapshot,
  FederatedSnapshotWatchListener,
  AcceptQuestAndExportResult as PortAcceptQuestAndExportResult,
  QuestDetailSnapshot,
  QuestStore,
  QuestWatchListener,
  StoreMigrationSession,
  WatchSubscription,
} from "../port";
import {
  authTokenInput,
  type ConvexClientPair,
  closeConvexClientPair,
  convexApi,
  convexClientProtocolInput,
  createConvexClientPair,
} from "./client";
import {
  assembleConvexDump,
  type ConvexDumpPage,
  type ConvexRestorePage,
  canonicalizeQuestDump,
  createConvexRestorePages,
  parseConvexDumpPage,
} from "./pagination";

interface RealtimeSubscription {
  unsubscribe(): void;
}

const RESTORE_WRITE_RETRY_LIMIT = 8;
const RESTORE_WRITE_RETRY_START_MS = 125;

function realtimeWatchError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(
        "[CONVEX_WATCH_FAILED] the live Convex query stopped responding; check the deployment connection and retry",
      );
}

function isConvexWriteRateLimit(error: unknown): boolean {
  return error instanceof Error && /TooManyWrites|too many writes per second/i.test(error.message);
}

function retryDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryRestoreWrite<T>(operation: () => Promise<T>): Promise<T> {
  let delay = RESTORE_WRITE_RETRY_START_MS;
  for (let attempt = 0; attempt <= RESTORE_WRITE_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isConvexWriteRateLimit(error)) {
        throw error;
      }
      if (attempt === RESTORE_WRITE_RETRY_LIMIT) {
        throw new Error(
          "[CONVEX_RESTORE_RATE_LIMITED] Convex kept rejecting paged restore writes after retries; wait for the deployment write budget to recover, then retry the restore with the same snapshot",
          { cause: error },
        );
      }
      await retryDelay(delay);
      delay *= 2;
    }
  }
  throw new Error("unreachable Convex restore retry state");
}

function leaseRefreshDelay(
  quests: readonly Quest[],
  leaseCutoff: string,
  boundAt: number,
): number | null {
  const nextExpiry = quests
    .filter((quest) => quest.status === "accepted" && quest.lease_expires_at !== null)
    .map((quest) => Date.parse(quest.lease_expires_at ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const serverAtBind = Date.parse(leaseCutoff);
  if (nextExpiry === undefined || !Number.isFinite(serverAtBind)) {
    return null;
  }
  const estimatedServerNow = serverAtBind + (Date.now() - boundAt);
  return Math.min(Math.max(0, nextExpiry - estimatedServerNow + 1), 2_147_483_647);
}

type TestableMutation<T> = {
  readonly input: T;
  readonly test_failure?: boolean;
};

export interface ConvexStoreOptions {
  readonly clients?: ConvexClientPair;
  readonly leaseTtlMinutes?: number;
}

export interface ConvexExportSnapshot {
  readonly dump: QuestDump;
  readonly event_high_water?: number;
  readonly lease_cutoff: string;
}

function testableMutation<T>(
  clients: ConvexClientPair,
  input: T,
  testFailure: boolean,
): TestableMutation<T> & { readonly auth_token?: string } {
  return {
    ...authTokenInput(clients),
    input,
    ...(testFailure ? { test_failure: true } : {}),
  };
}

async function snapshotFingerprint(snapshot: QuestDump): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableSerialize(canonicalizeQuestDump(snapshot))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function valueFingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableSerialize(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function restoreManifestFingerprint(pages: readonly ConvexRestorePage[]): Promise<string> {
  const manifest = await Promise.all(
    pages.map(async (page) => ({
      page_index: page.page_index,
      section: page.section,
      item_count: page.items.length,
      page_hash: await valueFingerprint(page),
      high_water: page.items.reduce(
        (highest, item) => ("id" in item ? Math.max(highest, item.id) : highest),
        0,
      ),
    })),
  );
  return valueFingerprint({ version: 1, pages: manifest });
}

interface AssembledDumpPages {
  readonly dump: QuestDump;
  readonly event_high_water: number;
}

async function assembleDumpPages(
  firstPage: unknown,
  readNext: (cursor: string) => Promise<unknown>,
): Promise<AssembledDumpPages> {
  const legacyDump = questDumpSchema.safeParse(firstPage);
  if (legacyDump.success) {
    return {
      dump: canonicalizeQuestDump(legacyDump.data),
      event_high_water: legacyDump.data.events.reduce(
        (highest, event) => Math.max(highest, event.id),
        0,
      ),
    };
  }
  const pages: ConvexDumpPage[] = [];
  let page = parseConvexDumpPage(firstPage);
  while (true) {
    pages.push(page);
    if (page.next_cursor === null) {
      return { dump: assembleConvexDump(pages), event_high_water: page.event_high_water };
    }
    const nextPage = parseConvexDumpPage(await readNext(page.next_cursor));
    if (nextPage.event_high_water !== page.event_high_water) {
      throw new Error(
        "[CONVEX_SNAPSHOT_CHANGED] Convex returned pages from different consistency points; restart the export",
      );
    }
    page = nextPage;
  }
}

function isLegacyRestoreValidatorError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:expected_hash|expected_event_high_water).*(?:extra|unexpected|validator|argument)|(?:extra|unexpected|validator|argument).*(?:expected_hash|expected_event_high_water)/i.test(
      error.message,
    )
  );
}

function isMissingFencedRepositoriesQuery(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:could not find|not found|does not exist|not a function).*fencedRepositories|fencedRepositories.*(?:could not find|not found|does not exist|not a function)/i.test(
      error.message,
    )
  );
}

function acceptQuestAndDetailFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim();
  return (
    /(?:could not find|not found|does not exist|not a function).*acceptQuestAndDetail|acceptQuestAndDetail.*(?:could not find|not found|does not exist|not a function)/i.test(
      message,
    ) || /^\[Request ID: [0-9a-f]+\] Server Error$/i.test(message)
  );
}

function detailSnapshotFromDump(dump: QuestDump, id: number): QuestDetailSnapshot {
  const quest = dump.quests.find((candidate) => candidate.id === id);
  if (quest === undefined) {
    throw new Error(
      `[LEGACY_CLAIM_DETAIL_MISSING] quest ${id} was accepted but the fallback snapshot did not contain it; deploy the current Quest backend and retry`,
    );
  }
  const chains = dump.chains.filter((chain) => chain.quest_id === id || chain.target_id === id);
  const relatedIds = new Set(
    chains
      .flatMap((chain) => [chain.quest_id, chain.target_id])
      .filter((relatedId) => relatedId !== id),
  );
  return {
    chains,
    events: dump.events.filter((event) => event.quest_id === id),
    evidence: dump.evidence.filter((evidence) => evidence.quest_id === id),
    quest,
    related_quests: dump.quests.filter((candidate) => relatedIds.has(candidate.id)),
  };
}

type FederatedListSnapshotFailure = "confirmed-missing" | "opaque-server-error";

function federatedListSnapshotFailure(error: unknown): FederatedListSnapshotFailure | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const message = error.message.trim();
  if (
    /(?:could not find|not found|does not exist|not a function).*federatedListSnapshot|federatedListSnapshot.*(?:could not find|not found|does not exist|not a function)/i.test(
      message,
    )
  ) {
    return "confirmed-missing";
  }
  // Production Convex redacts a missing public function to this request envelope.
  return /^\[Request ID: [0-9a-f]+\] Server Error$/i.test(message)
    ? "opaque-server-error"
    : undefined;
}

function isMissingFederatedSnapshotQuery(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:could not find|not found|does not exist|not a function).*federatedSnapshot|federatedSnapshot.*(?:could not find|not found|does not exist|not a function)/i.test(
      error.message,
    )
  );
}

function projectFederatedListSnapshot(
  snapshot: FederatedReadSnapshot | FederatedFullSnapshot,
): FederatedReadSnapshot {
  return {
    dump: federatedListDumpSchema.parse({
      schema_version: snapshot.dump.schema_version,
      quests: snapshot.dump.quests,
      chains: snapshot.dump.chains,
    }),
    fencedRepositories: [...snapshot.fencedRepositories],
  };
}

function addConfiguredLeaseTtl<T extends { readonly lease_ttl_minutes?: number | undefined }>(
  input: T,
  leaseTtlMinutes: number,
): T {
  if (input.lease_ttl_minutes !== undefined || leaseTtlMinutes === DEFAULT_LEASE_TTL_MINUTES) {
    return input;
  }
  return { ...input, lease_ttl_minutes: leaseTtlMinutes };
}

export class ConvexStore implements QuestStore {
  readonly deployment: string;
  readonly #clients: ConvexClientPair;
  readonly #ownsClients: boolean;
  readonly #leaseTtlMinutes: number;
  #failNextEventAppend = false;
  #federatedListSnapshotAvailable: boolean | undefined;
  readonly #legacyRestoreTokens = new Set<string>();

  constructor(deployment: string, options: ConvexStoreOptions = {}) {
    this.deployment = deployment;
    this.#clients = options.clients ?? createConvexClientPair(deployment);
    this.#ownsClients = options.clients === undefined;
    this.#leaseTtlMinutes = normalizeLeaseTtlMinutes(options.leaseTtlMinutes);
  }

  async addQuest(input: NewQuest): Promise<Quest> {
    const parsed = newQuestSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.addQuest,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async acceptQuest(input: AcceptQuestInput): Promise<AcceptResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.acceptQuest,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async acceptQuestAndDetail(input: AcceptQuestInput): Promise<AcceptQuestAndDetailResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    const mutationInput = testableMutation(
      this.#clients,
      addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
      this.#consumeEventFailure(),
    );
    try {
      return await this.#clients.http.mutation(convexApi.acceptQuestAndDetail, mutationInput);
    } catch (error: unknown) {
      if (!acceptQuestAndDetailFailure(error)) {
        throw error;
      }
      const legacy = await this.#clients.http.mutation(
        convexApi.acceptQuestAndExport,
        mutationInput,
      );
      return {
        acceptance: legacy.acceptance,
        detail: detailSnapshotFromDump(legacy.snapshot, parsed.id),
      };
    }
  }

  async acceptQuestAndExport(input: AcceptQuestInput): Promise<PortAcceptQuestAndExportResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.acceptQuestAndExport,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async touchQuest(input: TouchQuestInput): Promise<Quest> {
    const parsed = touchQuestInputSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.touchQuest,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async transition(id: number, transition: QuestTransition): Promise<Quest> {
    const parsedId = questSchema.shape.id.parse(id);
    const parsedTransition = addConfiguredLeaseTtl(
      questTransitionSchema.parse(transition),
      this.#leaseTtlMinutes,
    );
    const testFailure = this.#consumeEventFailure();
    return this.#clients.http.mutation(
      convexApi.transition,
      testFailure
        ? {
            ...authTokenInput(this.#clients),
            id: parsedId,
            test_failure: true,
            transition: parsedTransition,
          }
        : { ...authTokenInput(this.#clients), id: parsedId, transition: parsedTransition },
    );
  }

  async signoffBatch(input: SignoffBatchInput): Promise<SignoffBatchResult> {
    const parsed = signoffBatchInputSchema.parse(input);
    const testFailure = this.#consumeEventFailure();
    return this.#clients.http.mutation(convexApi.signoffBatch, {
      ...authTokenInput(this.#clients),
      input: parsed,
      ...(testFailure ? { test_failure: true } : {}),
    });
  }

  async addChainLink(input: ChainMutation): Promise<ChainResult> {
    const parsed = chainMutationSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.addChainLink,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async removeChainLink(input: ChainMutation): Promise<ChainRemovalResult> {
    const parsed = chainMutationSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.removeChainLink,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async addEvidence(input: NewEvidence): Promise<Evidence> {
    const parsed = newEvidenceSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.addEvidence,
      testableMutation(
        this.#clients,
        addConfiguredLeaseTtl(parsed, this.#leaseTtlMinutes),
        this.#consumeEventFailure(),
      ),
    );
  }

  async listQuests(filter: QuestFilter): Promise<Quest[]> {
    const parsed = questFilterSchema.parse(filter);
    const leaseCutoff = await this.serverTime();
    return this.#clients.http.query(convexApi.listQuests, {
      ...authTokenInput(this.#clients),
      filter: parsed,
      lease_cutoff: leaseCutoff,
    });
  }

  async listFencedRepositories(): Promise<readonly string[]> {
    try {
      return await this.#clients.http.query(convexApi.fencedRepositories, {
        ...authTokenInput(this.#clients),
      });
    } catch (error: unknown) {
      if (isMissingFencedRepositoriesQuery(error)) {
        throw new Error(
          "[FEDERATED_FENCE_QUERY_UNAVAILABLE] this Convex deployment does not expose `quest:fencedRepositories`; deploy the current Quest backend before federated reads",
        );
      }
      throw error;
    }
  }

  async #readFederatedListSnapshot(repository?: string): Promise<{
    readonly source: "legacy" | "list";
    readonly snapshot: FederatedReadSnapshot;
  }> {
    if (this.#federatedListSnapshotAvailable === false) {
      return {
        source: "legacy",
        snapshot: projectFederatedListSnapshot(await this.readFederatedFullSnapshot()),
      };
    }
    try {
      const snapshot = await this.#clients.http.query(convexApi.federatedListSnapshot, {
        ...authTokenInput(this.#clients),
        ...(repository === undefined
          ? {}
          : { repository: questSchema.shape.repo.parse(repository) }),
      });
      this.#federatedListSnapshotAvailable = true;
      return { source: "list", snapshot };
    } catch (error: unknown) {
      const failure = federatedListSnapshotFailure(error);
      if (failure !== undefined) {
        const snapshot = projectFederatedListSnapshot(await this.readFederatedFullSnapshot());
        if (failure === "confirmed-missing") {
          this.#federatedListSnapshotAvailable = false;
        }
        return { source: "legacy", snapshot };
      }
      throw error;
    }
  }

  async readFederatedSnapshot(repository?: string): Promise<FederatedReadSnapshot> {
    return (await this.#readFederatedListSnapshot(repository)).snapshot;
  }

  async readFederatedFullSnapshot(): Promise<FederatedFullSnapshot> {
    try {
      const first = await this.#clients.http.query(convexApi.federatedSnapshot, {
        ...authTokenInput(this.#clients),
      });
      if ("dump" in first) {
        return {
          dump: questDumpSchema.parse(first.dump),
          fencedRepositories: [...first.fencedRepositories],
        };
      }
      const fencedRepositories = [...first.fencedRepositories];
      const assembled = await assembleDumpPages(first, (cursor) =>
        this.#clients.http.query(convexApi.federatedSnapshot, {
          ...authTokenInput(this.#clients),
          cursor,
        }),
      );
      return { dump: assembled.dump, fencedRepositories };
    } catch (error: unknown) {
      if (isMissingFederatedSnapshotQuery(error)) {
        throw new Error(
          "[FEDERATED_FULL_SNAPSHOT_QUERY_UNAVAILABLE] this Convex deployment does not expose `quest:federatedSnapshot`; deploy the current Quest backend before federated history or export reads",
        );
      }
      throw error;
    }
  }

  async watchFederatedSnapshot(
    repository: string | undefined,
    listener: FederatedSnapshotWatchListener,
  ): Promise<WatchSubscription> {
    let active = true;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const [initialLeaseCutoff, initialSnapshot] = await Promise.all([
      this.serverTime(),
      this.#readFederatedListSnapshot(repository),
    ]);
    let leaseCutoff = initialLeaseCutoff;
    let leaseCutoffObservedAt = Date.now();
    let snapshotRevision = 0;
    let latestSnapshot = initialSnapshot.snapshot;

    const retryLeaseRefresh = (error: unknown): void => {
      if (!active) {
        return;
      }
      listener(latestSnapshot, realtimeWatchError(error));
      leaseTimer = setTimeout(() => {
        void refreshExpiredLeases().catch(retryLeaseRefresh);
      }, 1_000);
      leaseTimer.unref?.();
    };

    const scheduleLeaseRefresh = (): void => {
      if (leaseTimer !== undefined) {
        clearTimeout(leaseTimer);
      }
      const delay = leaseRefreshDelay(
        latestSnapshot.dump.quests,
        leaseCutoff,
        leaseCutoffObservedAt,
      );
      leaseTimer =
        delay === null
          ? undefined
          : setTimeout(() => {
              void refreshExpiredLeases().catch(retryLeaseRefresh);
            }, delay);
      leaseTimer?.unref?.();
    };

    const refreshExpiredLeases = async (): Promise<void> => {
      const refreshRevision = snapshotRevision;
      const [nextLeaseCutoff, snapshot] = await Promise.all([
        this.serverTime(),
        this.readFederatedSnapshot(repository),
      ]);
      if (!active || refreshRevision !== snapshotRevision) {
        return;
      }
      snapshotRevision += 1;
      leaseCutoff = nextLeaseCutoff;
      leaseCutoffObservedAt = Date.now();
      latestSnapshot = {
        dump: federatedListDumpSchema.parse(snapshot.dump),
        fencedRepositories: [...snapshot.fencedRepositories],
      };
      listener(latestSnapshot);
      scheduleLeaseRefresh();
    };

    const receiveSnapshot = (snapshot: FederatedReadSnapshot | FederatedFullSnapshot): void => {
      if (!active) {
        return;
      }
      snapshotRevision += 1;
      latestSnapshot = projectFederatedListSnapshot(snapshot);
      listener(latestSnapshot);
      scheduleLeaseRefresh();
    };
    const receiveError = (error: unknown): void => {
      if (active) {
        listener(latestSnapshot, realtimeWatchError(error));
      }
    };
    const subscription =
      initialSnapshot.source === "list"
        ? this.#clients.realtime.onUpdate(
            convexApi.federatedListSnapshot,
            {
              ...authTokenInput(this.#clients),
              ...(repository === undefined
                ? {}
                : { repository: questSchema.shape.repo.parse(repository) }),
            },
            receiveSnapshot,
            receiveError,
          )
        : this.#clients.realtime.onUpdate(
            convexApi.federatedSnapshot,
            { ...authTokenInput(this.#clients) },
            (snapshot) => {
              if ("dump" in snapshot) {
                receiveSnapshot(snapshot);
              } else {
                receiveError(
                  new Error(
                    "[FEDERATED_FULL_SNAPSHOT_WATCH_UNAVAILABLE] paginated full snapshots cannot be watched; deploy a backend with quest:federatedListSnapshot and retry",
                  ),
                );
              }
            },
            receiveError,
          );
    return {
      unsubscribe: async () => {
        if (!active) {
          return;
        }
        active = false;
        if (leaseTimer !== undefined) {
          clearTimeout(leaseTimer);
          leaseTimer = undefined;
        }
        subscription.unsubscribe();
      },
    };
  }

  async getQuest(id: number): Promise<Quest | null> {
    const parsed = questSchema.shape.id.parse(id);
    const leaseCutoff = await this.serverTime();
    return this.#clients.http.query(convexApi.getQuest, {
      ...authTokenInput(this.#clients),
      id: parsed,
      lease_cutoff: leaseCutoff,
    });
  }

  async readQuestDetail(id: number): Promise<QuestDetailSnapshot> {
    const parsed = questSchema.shape.id.parse(id);
    return this.#clients.http.query(convexApi.questDetail, {
      ...authTokenInput(this.#clients),
      id: parsed,
    });
  }

  async stats(scope: QuestScope): Promise<QuestStats> {
    const parsed = questScopeSchema.parse(scope);
    const leaseCutoff = await this.serverTime();
    return this.#clients.http.query(convexApi.stats, {
      ...authTokenInput(this.#clients),
      scope: parsed,
      lease_cutoff: leaseCutoff,
    });
  }

  async events(questId: number): Promise<Event[]> {
    const parsed = questSchema.shape.id.parse(questId);
    return this.#clients.http.query(convexApi.events, {
      ...authTokenInput(this.#clients),
      quest_id: parsed,
    });
  }

  async queryEvents(filter: EventFilter): Promise<Event[]> {
    const parsed = eventFilterSchema.parse(filter);
    const leaseCutoff = await this.serverTime();
    return this.#clients.http.query(convexApi.queryEvents, {
      ...authTokenInput(this.#clients),
      filter: parsed,
      lease_cutoff: leaseCutoff,
    });
  }

  async exportAll(): Promise<QuestDump> {
    return (await this.exportAllWithCutoff()).dump;
  }

  async exportAllRaw(): Promise<QuestDump> {
    const firstPage = await this.#clients.http.query(convexApi.rawExportAll, {
      ...authTokenInput(this.#clients),
    });
    return (
      await assembleDumpPages(firstPage, (cursor) =>
        this.#clients.http.query(convexApi.rawExportAll, {
          ...authTokenInput(this.#clients),
          cursor,
        }),
      )
    ).dump;
  }

  async serverTime(): Promise<string> {
    return this.#clients.http.query(convexApi.serverTime, convexClientProtocolInput(this.#clients));
  }

  async exportAllAt(leaseCutoff: string): Promise<QuestDump> {
    const parsedCutoff = questSchema.shape.updated_at.parse(leaseCutoff);
    const firstPage = await this.#clients.http.query(convexApi.exportAll, {
      ...authTokenInput(this.#clients),
      lease_cutoff: parsedCutoff,
    });
    return (
      await assembleDumpPages(firstPage, (cursor) =>
        this.#clients.http.query(convexApi.exportAll, {
          ...authTokenInput(this.#clients),
          cursor,
          lease_cutoff: parsedCutoff,
        }),
      )
    ).dump;
  }

  async exportAllWithCutoff(): Promise<ConvexExportSnapshot> {
    const leaseCutoff = await this.serverTime();
    const firstPage = await this.#clients.http.query(convexApi.exportAll, {
      ...authTokenInput(this.#clients),
      lease_cutoff: leaseCutoff,
    });
    const snapshot = await assembleDumpPages(firstPage, (cursor) =>
      this.#clients.http.query(convexApi.exportAll, {
        ...authTokenInput(this.#clients),
        cursor,
        lease_cutoff: leaseCutoff,
      }),
    );
    return {
      dump: snapshot.dump,
      event_high_water: snapshot.event_high_water,
      lease_cutoff: leaseCutoff,
    };
  }

  async watch(filter: QuestFilter, listener: QuestWatchListener): Promise<WatchSubscription> {
    const parsed = questFilterSchema.parse(filter);
    let subscribed = true;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let subscription: RealtimeSubscription | undefined;
    let leaseSubscription: RealtimeSubscription | undefined;
    let latestQuests: readonly Quest[] = [];

    const retryBind = (error: unknown): void => {
      if (!subscribed) {
        return;
      }
      listener(latestQuests, realtimeWatchError(error));
      leaseTimer = setTimeout(() => {
        void bind().catch(retryBind);
      }, 1_000);
      leaseTimer.unref?.();
    };

    const bind = async (): Promise<void> => {
      const leaseCutoff = await this.serverTime();
      if (!subscribed) {
        return;
      }
      const boundAt = Date.now();
      const activeGeneration = ++generation;
      const onError = (error: unknown): void => {
        if (subscribed && activeGeneration === generation) {
          listener(latestQuests, realtimeWatchError(error));
        }
      };
      const nextSubscription = this.#clients.realtime.onUpdate(
        convexApi.listQuests,
        { ...authTokenInput(this.#clients), filter: parsed, lease_cutoff: leaseCutoff },
        (quests) => {
          if (!subscribed || activeGeneration !== generation) {
            return;
          }
          latestQuests = quests;
          listener(quests);
        },
        onError,
      );
      const nextLeaseSubscription = this.#clients.realtime.onUpdate(
        convexApi.listQuests,
        { ...authTokenInput(this.#clients), filter: {}, lease_cutoff: leaseCutoff },
        (quests) => {
          if (!subscribed || activeGeneration !== generation) {
            return;
          }
          if (leaseTimer !== undefined) {
            clearTimeout(leaseTimer);
          }
          const delay = leaseRefreshDelay(quests, leaseCutoff, boundAt);
          leaseTimer =
            delay === null
              ? undefined
              : setTimeout(() => {
                  void bind().catch(retryBind);
                }, delay);
          leaseTimer?.unref?.();
        },
        onError,
      );
      const previousSubscription = subscription;
      const previousLeaseSubscription = leaseSubscription;
      subscription = nextSubscription;
      leaseSubscription = nextLeaseSubscription;
      previousSubscription?.unsubscribe();
      previousLeaseSubscription?.unsubscribe();
    };

    await bind();
    return {
      unsubscribe: async () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        generation += 1;
        if (leaseTimer !== undefined) {
          clearTimeout(leaseTimer);
          leaseTimer = undefined;
        }
        subscription?.unsubscribe();
        leaseSubscription?.unsubscribe();
      },
    };
  }

  async failNextEventAppend(): Promise<void> {
    this.#failNextEventAppend = true;
  }

  async replaceAll(dump: QuestDump): Promise<void> {
    const parsed = questDumpSchema.parse(dump);
    const current = await this.exportAllWithCutoff();
    const token = await this.beginRestore(
      current.dump,
      current.lease_cutoff,
      "migration",
      current.event_high_water,
    );
    let committed = false;
    let commitStarted = false;
    try {
      await this.activateRestore(token, parsed);
      commitStarted = true;
      await this.#commitRestoreResolvingAmbiguity(token);
      committed = true;
    } finally {
      if (committed) {
        await this.releaseRestore(token);
      } else if (!commitStarted) {
        await this.rollbackRestore(token).catch(() => undefined);
      }
    }
  }

  async recoverMigrationFence(repository: string): Promise<boolean> {
    return this.#clients.http.mutation(convexApi.recoverRepositoryFence, {
      ...authTokenInput(this.#clients),
      repo: repository.trim(),
    });
  }

  async recoverMigrationFenceForRestore(token: string, repository: string): Promise<boolean> {
    return this.#clients.http.mutation(convexApi.recoverMigrationFenceForRestore, {
      ...authTokenInput(this.#clients),
      repo: repository.trim(),
      token,
    });
  }

  async beginMigration(expected: QuestDump): Promise<StoreMigrationSession> {
    const parsedExpected = questDumpSchema.parse(expected);
    const snapshot = await this.exportAllWithCutoff();
    if (stableSerialize(snapshot.dump) !== stableSerialize(parsedExpected)) {
      throw new Error(
        "[MIGRATION_CONCURRENT_WRITE] the Convex store changed after its snapshot; retry the migration",
      );
    }

    let token: string;
    try {
      token = await this.beginRestore(
        snapshot.dump,
        snapshot.lease_cutoff,
        "migration",
        snapshot.event_high_water,
      );
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[MIGRATION_CONCURRENT_WRITE] the Convex store changed or is already locked; retry the migration (${detail})`,
      );
    }

    let active = true;
    let committed = false;
    let replacement: QuestDump | undefined;
    let expectedSnapshot = parsedExpected;
    let heartbeatFailure: unknown | undefined;
    const heartbeat = setInterval(() => {
      void this.renewRestore(token).catch((error: unknown) => {
        heartbeatFailure = error;
      });
    }, 60_000);
    const stopHeartbeat = (): void => clearInterval(heartbeat);
    const requireActive = (): void => {
      if (!active) {
        throw new Error("the Convex migration session is no longer active");
      }
    };
    const renew = async (): Promise<void> => {
      requireActive();
      if (heartbeatFailure !== undefined) {
        const detail =
          heartbeatFailure instanceof Error ? heartbeatFailure.message : String(heartbeatFailure);
        throw new Error(
          `[MIGRATION_LOCK_LOST] the Convex migration lease was lost: ${detail}; restore the verified backup before retrying`,
        );
      }
      try {
        await this.renewRestore(token);
      } catch (error: unknown) {
        heartbeatFailure = error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[MIGRATION_LOCK_LOST] the Convex migration lease could not be renewed: ${detail}; restore the verified backup before retrying`,
        );
      }
    };
    const release = async (): Promise<void> => {
      if (!active) {
        return;
      }
      try {
        await this.releaseRestore(token);
        active = false;
      } finally {
        stopHeartbeat();
      }
    };
    const rollback = async (): Promise<void> => {
      if (!active) {
        return;
      }
      if (committed) {
        await release();
        return;
      }
      try {
        await this.rollbackRestore(token);
        active = false;
      } finally {
        stopHeartbeat();
      }
    };
    return {
      replace: async (dump) => {
        requireActive();
        await renew();
        expectedSnapshot = questDumpSchema.parse(dump);
        replacement = await this.activateRestore(token, expectedSnapshot);
      },
      snapshot: async () => {
        requireActive();
        return replacement ?? snapshot.dump;
      },
      validate: async () => {
        await renew();
        if (committed) {
          return;
        }
        if (replacement !== undefined) {
          replacement = await this.activateRestore(token, replacement);
          return;
        }
        const current = await this.exportAllAt(snapshot.lease_cutoff);
        if (stableSerialize(current) !== stableSerialize(expectedSnapshot)) {
          throw new Error(
            "[MIGRATION_CONCURRENT_WRITE] the Convex store changed while migration was held; retry the migration",
          );
        }
      },
      fence: async (repository) => {
        await renew();
        await this.#clients.http.mutation(convexApi.fenceRepository, {
          ...convexClientProtocolInput(this.#clients),
          repo: repository,
          target_backend: "migration",
          token,
        });
      },
      unfence: async (repository) => {
        await renew();
        return this.#clients.http.mutation(convexApi.unfenceRepository, {
          ...convexClientProtocolInput(this.#clients),
          repo: repository,
          token,
        });
      },
      commit: async () => {
        requireActive();
        await renew();
        if (committed) {
          return;
        }
        const committedDump = await this.#commitRestoreResolvingAmbiguity(token);
        committed = true;
        expectedSnapshot = questDumpSchema.parse(committedDump);
        replacement = expectedSnapshot;
      },
      release,
      rollback,
    } satisfies StoreMigrationSession;
  }

  async beginRestore(
    expected: QuestDump,
    leaseCutoff: string,
    restoreKind: "migration" | "full-backup" = "full-backup",
    expectedEventHighWater?: number,
  ): Promise<string> {
    const token = crypto.randomUUID();
    const parsedExpected = questDumpSchema.parse(expected);
    const parsedCutoff = questSchema.shape.updated_at.parse(leaseCutoff);
    const expectedHash = await snapshotFingerprint(parsedExpected);
    try {
      while (true) {
        const result = await this.#clients.http.mutation(convexApi.beginRestore, {
          ...authTokenInput(this.#clients),
          token,
          expected_hash: expectedHash,
          expected_event_high_water:
            expectedEventHighWater ??
            parsedExpected.events.reduce((highest, event) => Math.max(highest, event.id), 0),
          lease_cutoff: parsedCutoff,
          ...(restoreKind === "full-backup" ? { restore_kind: "full-backup" } : {}),
        });
        if (result?.status !== "cleanup") {
          break;
        }
      }
    } catch (error: unknown) {
      if (!isLegacyRestoreValidatorError(error)) {
        throw error;
      }
      await this.#clients.http.mutation(convexApi.beginRestore, {
        ...authTokenInput(this.#clients),
        token,
        expected_snapshot: JSON.stringify(parsedExpected),
        lease_cutoff: parsedCutoff,
        ...(restoreKind === "full-backup" ? { restore_kind: "full-backup" } : {}),
      });
      this.#legacyRestoreTokens.add(token);
    }
    return token;
  }

  async renewRestore(token: string): Promise<void> {
    await this.#clients.http.mutation(convexApi.renewRestore, {
      ...authTokenInput(this.#clients),
      token,
    });
  }

  async restoreStatus(
    token: string,
  ): Promise<
    | { readonly status: "active" | "missing" }
    | { readonly status: "committed"; readonly dump: QuestDump }
  > {
    const status = await this.#clients.http.query(convexApi.restoreStatus, {
      ...authTokenInput(this.#clients),
      token,
    });
    if (status.status !== "committed") {
      return status;
    }
    if ("dump" in status) {
      return { status: "committed", dump: questDumpSchema.parse(status.dump) };
    }
    return { status: "committed", dump: await this.exportAllAt(status.lease_cutoff) };
  }

  async activateRestore(token: string, replacement: QuestDump): Promise<QuestDump> {
    const parsed = canonicalizeQuestDump(replacement);
    if (this.#legacyRestoreTokens.has(token)) {
      const activated = await this.#clients.http.mutation(convexApi.activateRestore, {
        ...authTokenInput(this.#clients),
        token,
        dump: parsed,
      });
      return questDumpSchema.parse(activated);
    }
    const pages = createConvexRestorePages(parsed);
    for (const page of pages) {
      await retryRestoreWrite(() =>
        this.#clients.http.mutation(convexApi.uploadRestorePage, {
          ...authTokenInput(this.#clients),
          token,
          page,
        }),
      );
    }
    const replacementHash = await restoreManifestFingerprint(pages);
    await retryRestoreWrite(() =>
      this.#clients.http.mutation(convexApi.activateRestore, {
        ...authTokenInput(this.#clients),
        token,
        replacement_hash: replacementHash,
      }),
    );
    return parsed;
  }

  async commitRestore(token: string): Promise<QuestDump> {
    while (true) {
      const committed = await retryRestoreWrite(() =>
        this.#clients.http.mutation(convexApi.commitRestore, {
          ...authTokenInput(this.#clients),
          token,
        }),
      );
      if (committed === null) {
        return this.exportAll();
      }
      if ("schema_version" in committed) {
        return questDumpSchema.parse(committed);
      }
      if (committed.status === "pending") {
        continue;
      }
      return this.exportAllAt(committed.lease_cutoff);
    }
  }

  async releaseRestore(token: string): Promise<void> {
    while (
      (await retryRestoreWrite(() =>
        this.#clients.http.mutation(convexApi.releaseRestore, {
          ...authTokenInput(this.#clients),
          token,
        }),
      )) === false
    ) {
      // Each mutation stays below Convex's transaction read/write limits.
    }
    this.#legacyRestoreTokens.delete(token);
  }

  async rollbackRestore(token: string): Promise<void> {
    while (
      (await retryRestoreWrite(() =>
        this.#clients.http.mutation(convexApi.rollbackRestore, {
          ...authTokenInput(this.#clients),
          token,
        }),
      )) === false
    ) {
      // Each mutation stays below Convex's transaction read/write limits.
    }
    this.#legacyRestoreTokens.delete(token);
  }

  async #commitRestoreResolvingAmbiguity(token: string): Promise<QuestDump> {
    let firstError: unknown;
    try {
      return await this.commitRestore(token);
    } catch (error: unknown) {
      firstError = error;
    }
    try {
      return await this.commitRestore(token);
    } catch {
      let status: Awaited<ReturnType<ConvexStore["restoreStatus"]>>;
      try {
        status = await this.restoreStatus(token);
      } catch {
        throw firstError;
      }
      if (status.status === "committed") {
        return status.dump;
      }
      throw new Error(
        `[CONVEX_RESTORE_COMMIT_UNRESOLVED] Convex restore ${token} may have started committing; retry commitRestore with this token until it reports committed, and do not roll it back`,
        { cause: firstError },
      );
    }
  }

  async close(): Promise<void> {
    if (this.#ownsClients) {
      await closeConvexClientPair(this.#clients);
    }
  }

  #consumeEventFailure(): boolean {
    const shouldFail = this.#failNextEventAppend;
    this.#failNextEventAppend = false;
    return shouldFail;
  }
}
