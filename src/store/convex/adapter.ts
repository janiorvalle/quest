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
  createConvexClientPair,
} from "./client";

interface RealtimeSubscription {
  unsubscribe(): void;
}

function realtimeWatchError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(
        "[CONVEX_WATCH_FAILED] the live Convex query stopped responding; check the deployment connection and retry",
      );
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

function isMissingFencedRepositoriesQuery(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:could not find|not found|does not exist|not a function).*fencedRepositories|fencedRepositories.*(?:could not find|not found|does not exist|not a function)/i.test(
      error.message,
    )
  );
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
      return await this.#clients.http.query(convexApi.federatedSnapshot, {
        ...authTokenInput(this.#clients),
      });
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
            receiveSnapshot,
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
    const dump = await this.#clients.http.query(convexApi.rawExportAll, {
      ...authTokenInput(this.#clients),
    });
    return questDumpSchema.parse(dump);
  }

  async serverTime(): Promise<string> {
    return this.#clients.http.query(convexApi.serverTime, {});
  }

  async exportAllAt(leaseCutoff: string): Promise<QuestDump> {
    const parsedCutoff = questSchema.shape.updated_at.parse(leaseCutoff);
    const dump = await this.#clients.http.query(convexApi.exportAll, {
      ...authTokenInput(this.#clients),
      lease_cutoff: parsedCutoff,
    });
    return questDumpSchema.parse(dump);
  }

  async exportAllWithCutoff(): Promise<ConvexExportSnapshot> {
    const leaseCutoff = await this.serverTime();
    return {
      dump: await this.exportAllAt(leaseCutoff),
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
    await this.#clients.http.mutation(convexApi.replaceAll, {
      ...authTokenInput(this.#clients),
      dump: parsed,
    });
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
      token = await this.beginRestore(snapshot.dump, snapshot.lease_cutoff, "migration");
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
          repo: repository,
          target_backend: "migration",
          token,
        });
      },
      unfence: async (repository) => {
        await renew();
        return this.#clients.http.mutation(convexApi.unfenceRepository, {
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
        let committedDump: QuestDump;
        try {
          committedDump = await this.commitRestore(token);
        } catch (error: unknown) {
          try {
            committedDump = await this.commitRestore(token);
          } catch {
            let status: Awaited<ReturnType<ConvexStore["restoreStatus"]>>;
            try {
              status = await this.restoreStatus(token);
            } catch {
              throw error;
            }
            if (status.status !== "committed") {
              throw error;
            }
            committedDump = status.dump;
          }
        }
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
  ): Promise<string> {
    const token = crypto.randomUUID();
    const parsedExpected = questDumpSchema.parse(expected);
    const parsedCutoff = questSchema.shape.updated_at.parse(leaseCutoff);
    await this.#clients.http.mutation(convexApi.beginRestore, {
      ...authTokenInput(this.#clients),
      token,
      expected_snapshot: JSON.stringify(parsedExpected),
      lease_cutoff: parsedCutoff,
      ...(restoreKind === "full-backup" ? { restore_kind: "full-backup" } : {}),
    });
    return token;
  }

  async renewRestore(token: string): Promise<void> {
    await this.#clients.http.mutation(convexApi.renewRestore, {
      ...authTokenInput(this.#clients),
      token,
    });
  }

  restoreStatus(
    token: string,
  ): Promise<
    | { readonly status: "active" | "missing" }
    | { readonly status: "committed"; readonly dump: QuestDump }
  > {
    return this.#clients.http.query(convexApi.restoreStatus, {
      ...authTokenInput(this.#clients),
      token,
    });
  }

  async activateRestore(token: string, replacement: QuestDump): Promise<QuestDump> {
    const activated = await this.#clients.http.mutation(convexApi.activateRestore, {
      ...authTokenInput(this.#clients),
      token,
      dump: questDumpSchema.parse(replacement),
    });
    return questDumpSchema.parse(activated);
  }

  async commitRestore(token: string): Promise<QuestDump> {
    const committed = await this.#clients.http.mutation(convexApi.commitRestore, {
      ...authTokenInput(this.#clients),
      token,
    });
    if (committed === null) {
      return this.exportAll();
    }
    return questDumpSchema.parse(committed);
  }

  async releaseRestore(token: string): Promise<void> {
    await this.#clients.http.mutation(convexApi.releaseRestore, {
      ...authTokenInput(this.#clients),
      token,
    });
  }

  async rollbackRestore(token: string): Promise<void> {
    await this.#clients.http.mutation(convexApi.rollbackRestore, {
      ...authTokenInput(this.#clients),
      token,
    });
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
