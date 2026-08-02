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
  stableSerialize,
  type TouchQuestInput,
  touchQuestInputSchema,
} from "../../schema";
import type {
  AcceptQuestAndExportResult as PortAcceptQuestAndExportResult,
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

type TestableMutation<T> = {
  readonly input: T;
  readonly test_failure?: boolean;
};

export interface ConvexStoreOptions {
  readonly clients?: ConvexClientPair;
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

export class ConvexStore implements QuestStore {
  readonly deployment: string;
  readonly #clients: ConvexClientPair;
  readonly #ownsClients: boolean;
  #failNextEventAppend = false;

  constructor(deployment: string, options: ConvexStoreOptions = {}) {
    this.deployment = deployment;
    this.#clients = options.clients ?? createConvexClientPair(deployment);
    this.#ownsClients = options.clients === undefined;
  }

  async addQuest(input: NewQuest): Promise<Quest> {
    const parsed = newQuestSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.addQuest,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
    );
  }

  async acceptQuest(input: AcceptQuestInput): Promise<AcceptResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.acceptQuest,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
    );
  }

  async acceptQuestAndExport(input: AcceptQuestInput): Promise<PortAcceptQuestAndExportResult> {
    const parsed = acceptQuestInputSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.acceptQuestAndExport,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
    );
  }

  async touchQuest(input: TouchQuestInput): Promise<Quest> {
    const parsed = touchQuestInputSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.touchQuest,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
    );
  }

  async transition(id: number, transition: QuestTransition): Promise<Quest> {
    const parsedId = questSchema.shape.id.parse(id);
    const parsedTransition = questTransitionSchema.parse(transition);
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

  async addChainLink(input: ChainMutation): Promise<ChainResult> {
    const parsed = chainMutationSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.addChainLink,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
    );
  }

  async removeChainLink(input: ChainMutation): Promise<ChainRemovalResult> {
    const parsed = chainMutationSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.removeChainLink,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
    );
  }

  async addEvidence(input: NewEvidence): Promise<Evidence> {
    const parsed = newEvidenceSchema.parse(input);
    return this.#clients.http.mutation(
      convexApi.addEvidence,
      testableMutation(this.#clients, parsed, this.#consumeEventFailure()),
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

  async getQuest(id: number): Promise<Quest | null> {
    const parsed = questSchema.shape.id.parse(id);
    const leaseCutoff = await this.serverTime();
    return this.#clients.http.query(convexApi.getQuest, {
      ...authTokenInput(this.#clients),
      id: parsed,
      lease_cutoff: leaseCutoff,
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
    const initialCutoff = await this.serverTime();
    let subscribed = true;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshGeneration = 0;
    let scheduleLeaseRefresh: (quests: readonly Quest[], leaseCutoff: string) => void = () =>
      undefined;
    const refresh = (): void => {
      if (!subscribed) {
        return;
      }
      refreshGeneration += 1;
      const generation = refreshGeneration;
      void this.serverTime()
        .then((leaseCutoff) =>
          Promise.all([
            this.#clients.http.query(convexApi.listQuests, {
              ...authTokenInput(this.#clients),
              filter: parsed,
              lease_cutoff: leaseCutoff,
            }),
            this.#clients.http.query(convexApi.listQuests, {
              ...authTokenInput(this.#clients),
              filter: {},
              lease_cutoff: leaseCutoff,
            }),
          ]).then(([quests, allQuests]) => ({ quests, allQuests, leaseCutoff })),
        )
        .then(({ quests, allQuests, leaseCutoff }) => {
          if (!subscribed || generation !== refreshGeneration) {
            return;
          }
          listener(quests);
          scheduleLeaseRefresh(allQuests, leaseCutoff);
        })
        .catch(() => {
          if (subscribed && generation === refreshGeneration) {
            leaseTimer = setTimeout(refresh, 1_000);
          }
        });
    };
    // Convex reruns queries for writes, not for wall-clock lease expiry, so refresh at the next lease boundary.
    scheduleLeaseRefresh = (quests, leaseCutoff) => {
      if (leaseTimer !== undefined) {
        clearTimeout(leaseTimer);
        leaseTimer = undefined;
      }
      const expirations = quests
        .filter((quest) => quest.status === "accepted" && quest.lease_expires_at !== null)
        .map((quest) => Date.parse(quest.lease_expires_at ?? ""))
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
      const nextExpiry = expirations[0];
      if (nextExpiry === undefined) {
        return;
      }
      const serverNow = Date.parse(leaseCutoff);
      if (!Number.isFinite(serverNow)) {
        leaseTimer = setTimeout(refresh, 1_000);
        return;
      }
      const delay = Math.min(Math.max(0, nextExpiry - serverNow + 1), 2_147_483_647);
      leaseTimer = setTimeout(refresh, delay);
    };
    const subscription = this.#clients.realtime.onUpdate(
      convexApi.listQuests,
      { ...authTokenInput(this.#clients), filter: parsed, lease_cutoff: initialCutoff },
      refresh,
    );
    const leaseSubscription = this.#clients.realtime.onUpdate(
      convexApi.listQuests,
      { ...authTokenInput(this.#clients), filter: {}, lease_cutoff: initialCutoff },
      refresh,
    );
    refresh();
    return {
      unsubscribe: async () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        if (leaseTimer !== undefined) {
          clearTimeout(leaseTimer);
          leaseTimer = undefined;
        }
        subscription.unsubscribe();
        leaseSubscription.unsubscribe();
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
