import type { PlanComputedState, PlanLaneCluster, PlanQuest } from "../domain/plan";
import {
  type Event,
  eventRepository,
  type Quest,
  type QuestScope,
  type QuestStatus,
} from "../schema";
import { type Clock, FederatedReadError, type QuestStore, type WatchSubscription } from "../store";
import { getQuestPlanSnapshot, type QuestPlanSnapshot } from "./plan";
import { showQuestDetailFromSnapshot } from "./query";

export type QuestLogScope = "all" | "current";

export type QuestLogPrState = "awaiting-review" | "merged" | "quiet";

export interface QuestLogItem {
  readonly area: string | null;
  readonly assignee: string | null;
  readonly blocked: boolean;
  readonly blockerId?: number;
  readonly blockerIds?: readonly number[];
  readonly chainDepth?: number;
  readonly computedState?: PlanComputedState;
  readonly description: string;
  readonly id: number;
  readonly kind: Quest["kind"];
  readonly openedBy: string;
  readonly pr: string | null;
  readonly prState: QuestLogPrState | null;
  readonly predictedFiles: readonly string[];
  readonly priority: number;
  readonly repo: string;
  readonly status: QuestStatus;
  readonly title: string;
  readonly updatedAt: string;
}

export interface QuestLogPlan {
  readonly items: readonly QuestLogItem[];
  readonly laneClusters: readonly PlanLaneCluster[];
}

export interface QuestLogSnapshot {
  readonly currentRepo: string | null;
  readonly error: string | null;
  readonly items: readonly QuestLogItem[];
  readonly loading: boolean;
  readonly plan: QuestLogPlan | null;
  readonly scope: QuestLogScope;
}

export interface QuestLogScopeSelection {
  readonly currentRepo: string | null;
  readonly scope: QuestLogScope;
}

export interface QuestLogChainRef {
  readonly assignee: string | null;
  readonly id: number;
  readonly status: QuestStatus;
  readonly title: string;
}

export interface QuestLogEvidenceEntry {
  readonly actor: string;
  readonly filename: string;
  readonly id: number;
  readonly kind: string;
  readonly stage: string;
}

export interface QuestLogEventEntry {
  readonly action: string;
  readonly actor: string;
  readonly at: string;
  readonly detailSummary: string | null;
  readonly id: number;
}

export interface QuestLogSessionAttribution {
  readonly effort?: string;
  readonly guild?: string;
  readonly model?: string;
}

export interface QuestLogDetail {
  readonly duplicateOf: readonly QuestLogChainRef[];
  readonly events: readonly QuestLogEventEntry[];
  readonly evidence: readonly QuestLogEvidenceEntry[];
  readonly questId: number;
  readonly requiredBy: readonly QuestLogChainRef[];
  readonly requires: readonly QuestLogChainRef[];
  readonly sessionAttribution: QuestLogSessionAttribution | null;
}

export interface QuestLogRuntime {
  readonly cycleScope: () => Promise<QuestLogScopeSelection>;
  readonly pollIntervalMs: number;
  readonly loadDetail: (id: number, repository?: string) => Promise<QuestLogDetail>;
  readonly openEvidence: (id: number, repository?: string) => Promise<string>;
  readonly openPr: (url: string) => Promise<string>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly subscribe: (listener: (snapshot: QuestLogSnapshot) => void) => () => void;
}

export interface QuestLogRuntimeOptions {
  readonly clock?: Clock;
  readonly initialScope: QuestScope;
  readonly openEvidence?: (id: number, repository?: string) => Promise<string>;
  readonly openPr?: (url: string) => Promise<string>;
  readonly pollIntervalMs?: number;
  readonly store: QuestStore;
}

export const EMPTY_QUEST_LOG_SNAPSHOT: QuestLogSnapshot = {
  currentRepo: null,
  error: null,
  items: [],
  loading: true,
  plan: null,
  scope: "all",
};

function questIdentity(repository: string, id: number): string {
  return `${repository}\u0000${id}`;
}

function toQuestLogItem(
  quest: Quest,
  blockedIds: ReadonlySet<string>,
  mergedPrQuestIds: ReadonlySet<string>,
  planQuest: PlanQuest | undefined = undefined,
): QuestLogItem {
  const planMetadata =
    planQuest === undefined
      ? {}
      : {
          ...(planQuest.blockers[0] === undefined ? {} : { blockerId: planQuest.blockers[0] }),
          blockerIds: planQuest.blockers,
          chainDepth: planQuest.chain_depth,
          computedState: planQuest.computed_state,
        };
  return {
    area: quest.area,
    assignee: quest.assignee,
    blocked:
      planQuest === undefined
        ? blockedIds.has(questIdentity(quest.repo, quest.id))
        : planQuest.computed_state === "blocked",
    description: quest.description,
    id: quest.id,
    kind: quest.kind,
    openedBy: quest.opened_by,
    pr: quest.pr,
    prState: prStateForQuest(quest, mergedPrQuestIds),
    predictedFiles: quest.predicted_files,
    priority: quest.priority,
    repo: quest.repo,
    status: quest.status,
    title: quest.title,
    updatedAt: quest.updated_at,
    ...planMetadata,
  };
}

function planForItems(
  planSnapshot: QuestPlanSnapshot,
  flatItems: readonly QuestLogItem[],
): QuestLogPlan | null {
  if (!planSnapshot.has_requirements) {
    return null;
  }
  const itemsById = new Map(flatItems.map((item) => [item.id, item]));
  const plannedIds = new Set(planSnapshot.plan.quests.map((quest) => quest.id));
  const plannedItems = planSnapshot.plan.quests.flatMap((quest) => {
    const item = itemsById.get(quest.id);
    return item === undefined ? [] : [item];
  });
  const unplannedItems = flatItems.filter((item) => !plannedIds.has(item.id));
  return {
    items: [...plannedItems, ...unplannedItems],
    laneClusters: planSnapshot.plan.lane_clusters,
  };
}

function detailValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

export function summarizeEventDetail(detail: unknown): string | null {
  if (detail === null || detail === undefined) {
    return null;
  }
  if (typeof detail !== "object" || Array.isArray(detail)) {
    return detailValue(detail);
  }
  const summary = Object.entries(detail)
    .slice(0, 2)
    .map(([key, value]) => `${key.replaceAll("_", " ")} ${detailValue(value)}`)
    .join(" · ");
  return summary === "" ? null : summary;
}

type EventDetailRecord = Readonly<Record<string, unknown>> & {
  readonly pr_verified_merged?: unknown;
  readonly session_effort?: unknown;
  readonly session_guild?: unknown;
  readonly session_model?: unknown;
};

function isEventDetailRecord(detail: unknown): detail is EventDetailRecord {
  return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

function eventDetailRecord(detail: unknown): EventDetailRecord | null {
  return isEventDetailRecord(detail) ? detail : null;
}

function prStateForQuest(
  quest: Quest,
  mergedPrQuestIds: ReadonlySet<string>,
): QuestLogPrState | null {
  if (quest.pr === null) {
    return null;
  }
  if (quest.status === "turned_in") {
    return "awaiting-review";
  }
  if (
    quest.status === "complete" &&
    (mergedPrQuestIds.has(questIdentity(quest.repo, quest.id)) ||
      mergedPrQuestIds.has(questIdentity("", quest.id)))
  ) {
    return "merged";
  }
  return "quiet";
}

function mergedPrQuestIdsFromEvents(
  events: readonly Event[],
  fallbackRepository?: string,
): ReadonlySet<string> {
  const latestCompletionState = new Map<string, boolean>();
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    if (event.action !== "complete") {
      continue;
    }
    const repository = eventRepository(event) ?? fallbackRepository ?? "";
    latestCompletionState.set(
      questIdentity(repository, event.quest_id),
      eventDetailRecord(event.detail)?.pr_verified_merged === true,
    );
  }
  return new Set(
    [...latestCompletionState].filter(([, merged]) => merged).map(([questId]) => questId),
  );
}

function nonEmptyEventText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function sessionAttributionFromEvent(event: Event): QuestLogSessionAttribution | null {
  if (event.action !== "accept" && event.action !== "turnin") {
    return null;
  }
  const detail = eventDetailRecord(event.detail);
  if (detail === null) {
    return null;
  }
  const effort = nonEmptyEventText(detail.session_effort);
  const guild = nonEmptyEventText(detail.session_guild);
  const model = nonEmptyEventText(detail.session_model);
  const attribution: QuestLogSessionAttribution = {
    ...(effort === undefined ? {} : { effort }),
    ...(guild === undefined ? {} : { guild }),
    ...(model === undefined ? {} : { model }),
  };
  return Object.keys(attribution).length === 0 ? null : attribution;
}

function latestSessionAttribution(events: readonly Event[]): QuestLogSessionAttribution | null {
  for (const event of [...events].sort((left, right) => right.id - left.id)) {
    const attribution = sessionAttributionFromEvent(event);
    if (attribution !== null) {
      return attribution;
    }
  }
  return null;
}

function filterForScope(scope: QuestLogScope, currentRepo: string | null) {
  return scope === "current" && currentRepo !== null ? { repo: currentRepo } : {};
}

function nextScopeRepository(
  scope: QuestLogScope,
  currentRepo: string | null,
  repositories: readonly string[],
): string | null {
  if (scope === "all") {
    return repositories[0] ?? null;
  }
  if (currentRepo === null) {
    return null;
  }
  const currentIndex = repositories.indexOf(currentRepo);
  return currentIndex < 0 ? null : (repositories[currentIndex + 1] ?? null);
}

function toChainRef(reference: {
  readonly assignee: string | null;
  readonly id: number;
  readonly status: QuestStatus;
  readonly title: string;
}): QuestLogChainRef {
  return {
    assignee: reference.assignee,
    id: reference.id,
    status: reference.status,
    title: reference.title,
  };
}

export function createQuestLogRuntime(options: QuestLogRuntimeOptions): QuestLogRuntime {
  let currentRepo = options.initialScope.repo;
  let scope: QuestLogScope = currentRepo === null ? "all" : "current";
  let error: string | null = null;
  let quests: readonly Quest[] = [];
  let blockedIds: ReadonlySet<string> = new Set();
  let mergedPrQuestIds: ReadonlySet<string> = new Set();
  let planSnapshot: QuestPlanSnapshot | null = null;
  let planRevision = 0;
  let loading = true;
  let generation = 0;
  let generationSequence = 0;
  let mergedPrRefreshRevision = 0;
  let subscriptions: readonly WatchSubscription[] = [];
  let scopeTransitions: Promise<void> = Promise.resolve();
  const pendingActions = new Set<Promise<void>>();
  const retiredSubscriptions = new Set<WatchSubscription>();
  const listeners = new Set<(snapshot: QuestLogSnapshot) => void>();

  const planScope = (targetScope: QuestLogScope, targetRepo: string | null): QuestScope => ({
    repo: targetScope === "current" && targetRepo !== null ? targetRepo : null,
  });

  const loadPlan = async (
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): Promise<QuestPlanSnapshot> =>
    getQuestPlanSnapshot(
      options.store,
      planScope(targetScope, targetRepo),
      await (options.clock?.now() ?? Promise.resolve(new Date().toISOString())),
    );

  const loadMergedPrQuestIds = async (
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): Promise<ReadonlySet<string>> =>
    mergedPrQuestIdsFromEvents(
      await options.store.queryEvents(
        targetScope === "current" && targetRepo !== null ? { repo: targetRepo } : {},
      ),
      targetScope === "current" && targetRepo !== null ? targetRepo : undefined,
    );

  const enqueueScopeTransition = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const transition = scopeTransitions.then(operation);
    scopeTransitions = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  };

  const snapshot = (): QuestLogSnapshot => {
    const planQuestsById = new Map(
      planSnapshot?.has_requirements
        ? planSnapshot.plan.quests.map((quest) => [quest.id, quest])
        : [],
    );
    const items = quests.map((quest) =>
      toQuestLogItem(quest, blockedIds, mergedPrQuestIds, planQuestsById.get(quest.id)),
    );
    return {
      currentRepo,
      error,
      items,
      loading,
      plan: planSnapshot === null ? null : planForItems(planSnapshot, items),
      scope,
    };
  };

  const emit = (): void => {
    const value = snapshot();
    for (const listener of listeners) {
      listener(value);
    }
  };

  const disposeSubscriptions = async (
    subscriptionsToDispose: readonly WatchSubscription[],
  ): Promise<readonly WatchSubscription[]> => {
    const failures: WatchSubscription[] = [];
    await Promise.all(
      subscriptionsToDispose.map(async (subscription) => {
        try {
          await subscription.unsubscribe();
          retiredSubscriptions.delete(subscription);
        } catch {
          retiredSubscriptions.add(subscription);
          failures.push(subscription);
        }
      }),
    );
    return failures;
  };

  let pendingPlanRefresh: {
    readonly generation: number;
    readonly scope: QuestLogScope;
    readonly repo: string | null;
  } | null = null;
  let planRefreshRunning = false;
  let scopeSetupGeneration: number | null = null;

  const clearPlanAfterRefreshFailure = (requestGeneration: number): void => {
    if (requestGeneration !== generation || scopeSetupGeneration !== null) {
      return;
    }
    planSnapshot = null;
    planRevision += 1;
    emit();
  };

  const requestPlanRefresh = (
    activeGeneration: number,
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): void => {
    pendingPlanRefresh = { generation: activeGeneration, repo: targetRepo, scope: targetScope };
    if (planRefreshRunning) {
      return;
    }
    planRefreshRunning = true;
    const action = (async () => {
      while (pendingPlanRefresh !== null) {
        const request = pendingPlanRefresh;
        pendingPlanRefresh = null;
        try {
          const nextPlan = await loadPlan(request.scope, request.repo);
          if (request.generation !== generation || scopeSetupGeneration !== null) {
            continue;
          }
          planSnapshot = nextPlan;
          planRevision += 1;
          emit();
        } catch {
          clearPlanAfterRefreshFailure(request.generation);
        }
      }
      planRefreshRunning = false;
    })();
    const completion = action.then(
      () => undefined,
      () => undefined,
    );
    pendingActions.add(completion);
    void completion.then(() => {
      pendingActions.delete(completion);
    });
  };

  const requestMergedPrQuestIdsRefresh = (
    activeGeneration: number,
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): void => {
    const refreshRevision = ++mergedPrRefreshRevision;
    const action = loadMergedPrQuestIds(targetScope, targetRepo).then(
      (nextMergedPrQuestIds) => {
        if (
          activeGeneration !== generation ||
          scopeSetupGeneration !== null ||
          refreshRevision !== mergedPrRefreshRevision
        ) {
          return;
        }
        mergedPrQuestIds = nextMergedPrQuestIds;
        emit();
      },
      () => undefined,
    );
    const completion = action.then(
      () => undefined,
      () => undefined,
    );
    pendingActions.add(completion);
    void completion.then(() => {
      pendingActions.delete(completion);
    });
  };

  const unsubscribeCurrent = async (): Promise<void> => {
    const current = new Set([...subscriptions, ...retiredSubscriptions]);
    subscriptions = [];
    const failures = await disposeSubscriptions([...current]);
    if (failures.length === 0) {
      return;
    }
    const remaining = await disposeSubscriptions(failures);
    if (remaining.length > 0) {
      throw new Error("quest log could not stop its live subscriptions; retry shutdown");
    }
  };

  const subscribeToScope = async (
    targetScope: QuestLogScope = scope,
    targetRepo: string | null = currentRepo,
  ): Promise<void> => {
    const activeGeneration = ++generationSequence;
    scopeSetupGeneration = activeGeneration;
    const filter = filterForScope(targetScope, targetRepo);
    let nextQuests: readonly Quest[] = [];
    let nextBlockedIds: ReadonlySet<string> = new Set();
    let nextMergedPrQuestIds: ReadonlySet<string> = new Set();
    let nextLoading = true;
    let nextError: string | null = null;
    const nextReadErrors: Array<string | null> = [null, null];
    const updateNextReadError = (index: number, readError?: FederatedReadError): void => {
      nextReadErrors[index] = readError?.message ?? null;
      nextError = nextReadErrors.find((message) => message !== null) ?? null;
    };
    const activeReadError = (): string | null =>
      nextReadErrors.find((message) => message !== null) ?? null;
    const nextSubscriptions: WatchSubscription[] = [];
    const planRevisionBeforeSetup = planRevision;
    const [loadedPlanSnapshot, loadedMergedPrQuestIds] = await Promise.all([
      loadPlan(targetScope, targetRepo).catch(() => null),
      loadMergedPrQuestIds(targetScope, targetRepo).catch(() => new Set<string>()),
    ]);
    const nextPlanSnapshot = loadedPlanSnapshot;
    nextMergedPrQuestIds = loadedMergedPrQuestIds;
    try {
      nextSubscriptions.push(
        await options.store.watch(filter, (watchedQuests, readError) => {
          if (readError instanceof FederatedReadError) {
            nextQuests = watchedQuests;
            nextLoading = false;
            updateNextReadError(0, readError);
            handleWatchReadError(activeGeneration, readError, () => {
              quests = nextQuests;
              loading = false;
            });
            return;
          }
          nextQuests = watchedQuests;
          nextLoading = false;
          updateNextReadError(0);
          if (activeGeneration !== generation) {
            return;
          }
          error = activeReadError();
          quests = nextQuests;
          loading = false;
          emit();
          requestPlanRefresh(activeGeneration, targetScope, targetRepo);
          requestMergedPrQuestIdsRefresh(activeGeneration, targetScope, targetRepo);
        }),
      );
      nextSubscriptions.push(
        await options.store.watch({ ...filter, blocked: true }, (blockedQuests, readError) => {
          if (readError instanceof FederatedReadError) {
            nextBlockedIds = new Set(
              blockedQuests.map((quest) => questIdentity(quest.repo, quest.id)),
            );
            updateNextReadError(1, readError);
            handleWatchReadError(activeGeneration, readError, () => {
              blockedIds = nextBlockedIds;
            });
            return;
          }
          nextBlockedIds = new Set(
            blockedQuests.map((quest) => questIdentity(quest.repo, quest.id)),
          );
          updateNextReadError(1);
          if (activeGeneration !== generation) {
            return;
          }
          error = activeReadError();
          blockedIds = nextBlockedIds;
          emit();
          requestPlanRefresh(activeGeneration, targetScope, targetRepo);
        }),
      );
    } catch (error) {
      scopeSetupGeneration = null;
      await disposeSubscriptions(nextSubscriptions);
      throw error;
    }

    const previousSubscriptions = subscriptions;
    generation = activeGeneration;
    currentRepo = targetRepo;
    scope = targetScope;
    error = nextError;
    subscriptions = nextSubscriptions;
    quests = nextQuests;
    blockedIds = nextBlockedIds;
    mergedPrQuestIds = nextMergedPrQuestIds;
    if (planRevision === planRevisionBeforeSetup) {
      planSnapshot = nextPlanSnapshot;
    }
    scopeSetupGeneration = null;
    loading = nextLoading;
    emit();
    requestPlanRefresh(activeGeneration, targetScope, targetRepo);
    requestMergedPrQuestIdsRefresh(activeGeneration, targetScope, targetRepo);
    await disposeSubscriptions(previousSubscriptions);
  };

  const showScopeError = async (
    targetScope: QuestLogScope,
    targetRepo: string | null,
    readError: FederatedReadError,
  ): Promise<void> => {
    await unsubscribeCurrent();
    generation = ++generationSequence;
    currentRepo = targetRepo;
    scope = targetScope;
    error = readError.message;
    quests = [];
    blockedIds = new Set();
    mergedPrQuestIds = new Set();
    planSnapshot = null;
    loading = false;
    emit();
  };

  const showPartialScopeWarning = (
    activeGeneration: number,
    readError: FederatedReadError,
  ): void => {
    if (activeGeneration !== generation) {
      return;
    }
    error = readError.message;
    loading = false;
    emit();
  };

  const handleWatchReadError = (
    activeGeneration: number,
    readError: FederatedReadError,
    applyPartialSnapshot: () => void,
  ): void => {
    if (activeGeneration !== generation) {
      return;
    }
    applyPartialSnapshot();
    showPartialScopeWarning(activeGeneration, readError);
  };

  const knownRepositories = async (): Promise<readonly string[]> => {
    const stats = await options.store.stats({ repo: null });
    const repositories = new Set(stats.repos.map((repository) => repository.repo));
    if (currentRepo !== null) {
      repositories.add(currentRepo);
    }
    return [...repositories].sort((left, right) => left.localeCompare(right));
  };

  const readKnownRepositories = async (): Promise<readonly string[] | null> => {
    try {
      return await knownRepositories();
    } catch (readError: unknown) {
      if (!(readError instanceof FederatedReadError)) {
        throw readError;
      }
      await showScopeError(scope, currentRepo, readError);
      return null;
    }
  };

  const subscribeWithReadError = async (
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): Promise<void> => {
    try {
      await subscribeToScope(targetScope, targetRepo);
    } catch (readError: unknown) {
      if (!(readError instanceof FederatedReadError)) {
        throw readError;
      }
      await showScopeError(targetScope, targetRepo, readError);
    }
  };

  const currentSelection = (): QuestLogScopeSelection => ({ currentRepo, scope });

  const cycleScope = (): Promise<QuestLogScopeSelection> =>
    enqueueScopeTransition(async () => {
      const repositories = await readKnownRepositories();
      if (repositories === null) {
        return currentSelection();
      }
      const nextRepo = nextScopeRepository(scope, currentRepo, repositories);
      const nextScope: QuestLogScope = nextRepo === null ? "all" : "current";

      if (nextScope === scope && nextRepo === currentRepo) {
        return currentSelection();
      }

      await subscribeWithReadError(nextScope, nextRepo);
      return currentSelection();
    });

  const start = (): Promise<void> =>
    enqueueScopeTransition(async () => {
      try {
        await subscribeToScope();
      } catch (readError: unknown) {
        if (!(readError instanceof FederatedReadError)) {
          throw readError;
        }
        await showScopeError(scope, currentRepo, readError);
      }
    });

  const loadDetail = async (id: number, repository?: string): Promise<QuestLogDetail> => {
    const store =
      repository === undefined
        ? options.store
        : (options.store.forRepository?.(repository) ?? options.store);
    const selectedScope: QuestScope =
      repository === undefined ? { repo: null } : { repo: repository };
    const snapshot = await store.readQuestDetail(id);
    const detail = showQuestDetailFromSnapshot(snapshot, selectedScope, id);
    const orderedEvents = [...snapshot.events].sort((left, right) => right.id - left.id);
    return {
      duplicateOf: detail.chain_position.duplicate_of.map(toChainRef),
      events: orderedEvents.map((event) => ({
        action: event.action,
        actor: event.actor,
        at: event.at,
        detailSummary: summarizeEventDetail(event.detail),
        id: event.id,
      })),
      evidence: detail.evidence.map((item) => ({
        actor: item.added_by,
        filename: item.filename,
        id: item.id,
        kind: item.kind,
        stage: item.stage,
      })),
      questId: id,
      requiredBy: detail.chain_position.required_by.map(toChainRef),
      requires: detail.chain_position.requires.map(toChainRef),
      sessionAttribution: latestSessionAttribution(orderedEvents),
    };
  };

  const openEvidence = (id: number, repository?: string): Promise<string> => {
    const action = (async () => {
      if (options.openEvidence === undefined) {
        return `Quest ${id} evidence opening is not available`;
      }
      return await options.openEvidence(id, repository);
    })();
    const completion = action.then(
      () => undefined,
      () => undefined,
    );
    pendingActions.add(completion);
    void completion.then(() => {
      pendingActions.delete(completion);
    });
    return action;
  };

  const openPr = (url: string): Promise<string> => {
    const action = (async () => {
      if (options.openPr === undefined) {
        return "PR opening is not available";
      }
      return await options.openPr(url);
    })();
    const completion = action.then(
      () => undefined,
      () => undefined,
    );
    pendingActions.add(completion);
    void completion.then(() => {
      pendingActions.delete(completion);
    });
    return action;
  };

  return {
    cycleScope,
    pollIntervalMs: options.pollIntervalMs ?? 250,
    loadDetail,
    openEvidence,
    openPr,
    start,
    stop: async () => {
      await Promise.all([scopeTransitions, ...pendingActions]);
      generation = ++generationSequence;
      await unsubscribeCurrent();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
