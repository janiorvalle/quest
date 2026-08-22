import {
  computeQaQueueFromDump,
  isQuestSigned,
  type QaGroupingReason,
  type QaSession,
} from "../domain";
import type { PlanComputedState, PlanLaneCluster, PlanQuest } from "../domain/plan";
import {
  type Event,
  eventRepository,
  type Quest,
  type QuestDump,
  type QuestFilter,
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

export interface QuestLogSignoffGroup {
  readonly group: number;
  readonly ids: readonly number[];
  readonly items: readonly QuestLogItem[];
  readonly label: string;
  readonly oldestAt: string;
  readonly reason: QaGroupingReason;
  readonly repo: string;
  readonly why: string;
}

export interface QuestLogSignedHistoryEntry {
  readonly item: QuestLogItem;
  readonly signedAt: string;
  readonly signer: string;
}

export interface QuestLogSignoffLens {
  readonly awaitingCount: number;
  readonly error: string | null;
  readonly emptyMessage: string | null;
  readonly groups: readonly QuestLogSignoffGroup[];
  readonly signed: readonly QuestLogSignedHistoryEntry[];
  readonly signedCount: number;
}

export interface QuestLogSnapshot {
  readonly currentRepo: string | null;
  readonly error: string | null;
  readonly items: readonly QuestLogItem[];
  /** Advances every time the live quest list delivers; the detail pane reloads on it. */
  readonly listRevision: number;
  readonly loading: boolean;
  readonly plan: QuestLogPlan | null;
  readonly refreshing: boolean;
  readonly signoff: QuestLogSignoffLens;
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
  readonly setSignoffActive: (active: boolean) => void;
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

interface SignoffLensRefreshRequest {
  readonly generation: number;
  readonly repo: string | null;
  readonly scope: QuestLogScope;
}

interface CachedQuestLogScope {
  readonly blockedIds: ReadonlySet<string>;
  readonly error: string | null;
  readonly mergedPrQuestIds: ReadonlySet<string>;
  readonly planSnapshot: QuestPlanSnapshot | null;
  readonly quests: readonly Quest[];
  readonly signoffLens: QuestLogSignoffLens;
}

export const EMPTY_QUEST_LOG_SIGNOFF: QuestLogSignoffLens = {
  awaitingCount: 0,
  error: null,
  emptyMessage: null,
  groups: [],
  signed: [],
  signedCount: 0,
};

export const EMPTY_QUEST_LOG_SNAPSHOT: QuestLogSnapshot = {
  currentRepo: null,
  error: null,
  items: [],
  listRevision: 0,
  loading: true,
  plan: null,
  refreshing: false,
  signoff: EMPTY_QUEST_LOG_SIGNOFF,
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

function eventsForQuest(quest: Quest, events: readonly Event[]): readonly Event[] {
  return events
    .filter(
      (event) =>
        event.quest_id === quest.id &&
        (eventRepository(event) === undefined || eventRepository(event) === quest.repo),
    )
    .sort((left, right) => left.id - right.id);
}

function latestSignoffEvent(quest: Quest, events: readonly Event[]): Event | undefined {
  const questEvents = eventsForQuest(quest, events);
  if (!isQuestSigned(quest, questEvents)) {
    return undefined;
  }
  let latestCompletion = -1;
  questEvents.forEach((event, index) => {
    if (event.action === "complete") {
      latestCompletion = index;
    }
  });
  return questEvents.slice(latestCompletion + 1).findLast((event) => event.action === "signoff");
}

function signoffSessionLabel(session: QaSession): string {
  return session.reason === "chain" ? `chained ${session.ids.join("-")}` : session.why;
}

function compareSignedHistory(
  left: QuestLogSignedHistoryEntry,
  right: QuestLogSignedHistoryEntry,
): number {
  return (
    Date.parse(right.signedAt) - Date.parse(left.signedAt) ||
    left.item.id - right.item.id ||
    left.item.repo.localeCompare(right.item.repo)
  );
}

function signoffLensReadError(error: unknown): string {
  return error instanceof FederatedReadError
    ? error.message
    : "Sign-off lens unavailable; retry when the backend is reachable";
}

function signoffLensAfterReadError(
  error: unknown,
  previous: QuestLogSignoffLens = EMPTY_QUEST_LOG_SIGNOFF,
): QuestLogSignoffLens {
  return { ...previous, error: signoffLensReadError(error) };
}

function mergeQuestLogSignoffLenses(lenses: readonly QuestLogSignoffLens[]): QuestLogSignoffLens {
  const groups = lenses
    .flatMap((lens) => lens.groups)
    .sort(
      (left, right) =>
        Date.parse(left.oldestAt) - Date.parse(right.oldestAt) ||
        (left.ids[0] ?? 0) - (right.ids[0] ?? 0) ||
        left.repo.localeCompare(right.repo),
    )
    .map((group, index) => ({ ...group, group: index + 1 }));
  const signed = lenses.flatMap((lens) => lens.signed).sort(compareSignedHistory);
  return {
    awaitingCount: lenses.reduce((total, lens) => total + lens.awaitingCount, 0),
    error: null,
    emptyMessage:
      groups.length === 0 && signed.length === 0 ? "No completed quests in sign-off lens." : null,
    groups,
    signed,
    signedCount: signed.length,
  };
}

function scopedQuest(quest: Quest, repository: string | null | undefined): boolean {
  return repository === undefined || repository === null || quest.repo === repository;
}

export function buildQuestLogSignoffLens(
  dump: QuestDump,
  repository: string | null | undefined = undefined,
): QuestLogSignoffLens {
  const mergedPrQuestIds = mergedPrQuestIdsFromEvents(dump.events);
  const visibleQuests = dump.quests.filter((quest) => scopedQuest(quest, repository));
  const itemsByKey = new Map(
    visibleQuests.map((quest) => [
      questIdentity(quest.repo, quest.id),
      toQuestLogItem(quest, new Set(), mergedPrQuestIds),
    ]),
  );
  const queue = computeQaQueueFromDump(dump, repository ?? undefined);
  const groups = queue.sessions.map((session) => ({
    group: session.group,
    ids: session.ids,
    items: session.ids.flatMap((id) => itemsByKey.get(questIdentity(session.repo, id)) ?? []),
    label: signoffSessionLabel(session),
    oldestAt: session.oldest_at,
    reason: session.reason,
    repo: session.repo,
    why: session.why,
  }));
  const signed = visibleQuests
    .filter((quest) => quest.status === "complete")
    .flatMap((quest) => {
      const event = latestSignoffEvent(quest, dump.events);
      const item = itemsByKey.get(questIdentity(quest.repo, quest.id));
      return event === undefined || item === undefined
        ? []
        : [{ item, signedAt: event.at, signer: event.actor }];
    })
    .sort(compareSignedHistory);
  return {
    awaitingCount: queue.summary.quests,
    error: null,
    emptyMessage:
      groups.length === 0 && signed.length === 0 ? "No completed quests in sign-off lens." : null,
    groups,
    signed,
    signedCount: signed.length,
  };
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

async function registerWatchSubscriptions(
  registrations: readonly Promise<WatchSubscription>[],
  retainFailedCleanup: (subscription: WatchSubscription) => void,
): Promise<readonly WatchSubscription[]> {
  const results = await Promise.allSettled(registrations);
  const subscriptions = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure === undefined) {
    return subscriptions;
  }
  const cleanupResults = await Promise.allSettled(
    subscriptions.map((subscription) => subscription.unsubscribe()),
  );
  for (const [index, cleanupResult] of cleanupResults.entries()) {
    if (cleanupResult.status === "rejected") {
      const subscription = subscriptions[index];
      if (subscription !== undefined) {
        retainFailedCleanup(subscription);
      }
    }
  }
  throw failure.reason;
}

async function refreshScopeRowsAfterFailedSetup(
  store: QuestStore,
  filter: QuestFilter,
  fallbackQuests: readonly Quest[],
  fallbackBlockedIds: ReadonlySet<string>,
): Promise<{ readonly blockedIds: ReadonlySet<string>; readonly quests: readonly Quest[] }> {
  const [refreshedQuests, refreshedBlockedQuests] = await Promise.all([
    store.listQuests(filter).catch(() => fallbackQuests),
    store
      .listQuests({ ...filter, blocked: true })
      .catch(() =>
        fallbackQuests.filter((quest) =>
          fallbackBlockedIds.has(questIdentity(quest.repo, quest.id)),
        ),
      ),
  ]);
  if (filter.repo !== undefined) {
    return {
      blockedIds: new Set(
        refreshedBlockedQuests.map((quest) => questIdentity(quest.repo, quest.id)),
      ),
      quests: refreshedQuests,
    };
  }
  const refreshedRepositories = new Set(refreshedQuests.map((quest) => quest.repo));
  const preservedQuests = fallbackQuests.filter((quest) => !refreshedRepositories.has(quest.repo));
  const preservedBlockedIds = new Set(
    preservedQuests
      .map((quest) => questIdentity(quest.repo, quest.id))
      .filter((identity) => fallbackBlockedIds.has(identity)),
  );
  for (const quest of refreshedBlockedQuests) {
    preservedBlockedIds.add(questIdentity(quest.repo, quest.id));
  }
  return {
    blockedIds: preservedBlockedIds,
    quests: [...preservedQuests, ...refreshedQuests],
  };
}

function rollbackReadError(
  hadSubscriptions: boolean,
  subscriptionErrors: readonly (string | null)[],
  previousError: string | null,
): string | null {
  return hadSubscriptions
    ? (subscriptionErrors.find((message) => message !== null) ?? null)
    : previousError;
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
  let signoffLens: QuestLogSignoffLens = EMPTY_QUEST_LOG_SIGNOFF;
  let planRevision = 0;
  let listRevision = 0;
  let loading = true;
  let scopeRefreshing = false;
  let signoffRefreshing = false;
  let generation = 0;
  let generationSequence = 0;
  let mergedPrRefreshRevision = 0;
  let signoffRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let signoffLensActive = false;
  let subscriptions: readonly WatchSubscription[] = [];
  let repositorySubscription: WatchSubscription | null = null;
  let scopeTransitions: Promise<void> = Promise.resolve();
  const pendingActions = new Set<Promise<void>>();
  const retiredSubscriptions = new Set<WatchSubscription>();
  const listeners = new Set<(snapshot: QuestLogSnapshot) => void>();
  const cachedScopes = new Map<string, CachedQuestLogScope>();
  const repositoryNames = new Set<string>(currentRepo === null ? [] : [currentRepo]);

  const scopeKey = (targetScope: QuestLogScope, targetRepo: string | null): string =>
    targetScope === "all" ? "all" : `repo:${targetRepo ?? ""}`;

  const cacheCurrentScope = (): void => {
    if (loading || error !== null) {
      return;
    }
    for (const quest of quests) {
      repositoryNames.add(quest.repo);
    }
    cachedScopes.set(scopeKey(scope, currentRepo), {
      blockedIds,
      error,
      mergedPrQuestIds,
      planSnapshot,
      quests,
      signoffLens,
    });
    if (scope === "all") {
      for (const repository of repositoryNames) {
        const key = scopeKey("current", repository);
        if (cachedScopes.has(key)) {
          continue;
        }
        cachedScopes.set(key, {
          blockedIds: new Set(
            [...blockedIds].filter((identity) => identity.startsWith(`${repository}\u0000`)),
          ),
          error: null,
          mergedPrQuestIds: new Set(
            [...mergedPrQuestIds].filter((identity) => identity.startsWith(`${repository}\u0000`)),
          ),
          planSnapshot: null,
          quests: quests.filter((quest) => quest.repo === repository),
          signoffLens: EMPTY_QUEST_LOG_SIGNOFF,
        });
      }
    }
  };

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

  const loadScopedSignoffLens = async (
    repository: string | undefined,
  ): Promise<QuestLogSignoffLens> => {
    const store =
      repository === undefined
        ? options.store
        : (options.store.forRepository?.(repository) ?? options.store);
    return buildQuestLogSignoffLens(await store.exportAll(), repository);
  };

  const loadSignoffLens = async (
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): Promise<QuestLogSignoffLens> => {
    if (targetScope === "current" && targetRepo !== null) {
      return loadScopedSignoffLens(targetRepo);
    }
    if (options.store.forRepository === undefined) {
      return loadScopedSignoffLens(undefined);
    }
    const repositories = (await options.store.stats({ repo: null })).repos.map(
      (repository) => repository.repo,
    );
    if (repositories.length === 0) {
      return loadScopedSignoffLens(undefined);
    }
    return mergeQuestLogSignoffLenses(
      await Promise.all(repositories.map((repository) => loadScopedSignoffLens(repository))),
    );
  };

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
      listRevision,
      loading,
      plan: planSnapshot === null ? null : planForItems(planSnapshot, items),
      refreshing: scopeRefreshing || signoffRefreshing,
      signoff: signoffLens,
      scope,
    };
  };

  const emit = (): void => {
    cacheCurrentScope();
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
  let pendingSignoffLensRefresh: SignoffLensRefreshRequest | null = null;
  let signoffLensRefreshRunning = false;
  let scopeSetupGeneration: number | null = null;
  let subscriptionGeneration = generation;
  let subscriptionReadErrors: [string | null, string | null] = [null, null];

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

  const applySignoffLensRefresh = async (request: SignoffLensRefreshRequest): Promise<void> => {
    const isCurrentRequest = (): boolean =>
      request.generation === generation && scopeSetupGeneration === null;
    if (!isCurrentRequest()) {
      return;
    }
    try {
      const nextSignoffLens = await loadSignoffLens(request.scope, request.repo);
      if (!isCurrentRequest()) {
        return;
      }
      signoffLens = nextSignoffLens;
    } catch (readError: unknown) {
      if (!isCurrentRequest()) {
        return;
      }
      signoffLens = signoffLensAfterReadError(readError, signoffLens);
    }
    if (isCurrentRequest()) {
      emit();
    }
  };

  const requestSignoffLensRefresh = (
    activeGeneration: number,
    targetScope: QuestLogScope,
    targetRepo: string | null,
  ): void => {
    if (signoffLensActive && !signoffRefreshing) {
      signoffRefreshing = true;
      emit();
    }
    pendingSignoffLensRefresh = {
      generation: activeGeneration,
      repo: targetRepo,
      scope: targetScope,
    };
    if (signoffLensRefreshRunning) {
      return;
    }
    signoffLensRefreshRunning = true;
    const action = (async () => {
      while (pendingSignoffLensRefresh !== null) {
        const request = pendingSignoffLensRefresh;
        pendingSignoffLensRefresh = null;
        await applySignoffLensRefresh(request);
      }
      signoffLensRefreshRunning = false;
      if (signoffRefreshing) {
        signoffRefreshing = false;
        emit();
      }
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

  const startSignoffRefreshTimer = (): void => {
    if (signoffRefreshTimer !== null) {
      return;
    }
    signoffRefreshTimer = setInterval(
      () => {
        if (!signoffLensActive || scopeSetupGeneration !== null) {
          return;
        }
        requestSignoffLensRefresh(generation, scope, currentRepo);
      },
      Math.max(1_000, options.pollIntervalMs ?? 250),
    );
    signoffRefreshTimer.unref?.();
  };

  const stopSignoffRefreshTimer = (): void => {
    if (signoffRefreshTimer === null) {
      return;
    }
    clearInterval(signoffRefreshTimer);
    signoffRefreshTimer = null;
  };

  const setSignoffActive = (active: boolean): void => {
    signoffLensActive = active;
    if (!active) {
      stopSignoffRefreshTimer();
      if (signoffRefreshing) {
        signoffRefreshing = false;
        emit();
      }
      return;
    }
    startSignoffRefreshTimer();
    requestSignoffLensRefresh(generation, scope, currentRepo);
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
    const previousState = {
      blockedIds,
      currentRepo,
      error,
      generation,
      loading,
      mergedPrQuestIds,
      planSnapshot,
      quests,
      scope,
      signoffLens,
    };
    const hadPreviousSubscriptions = subscriptions.length > 0;
    const activeGeneration = ++generationSequence;
    scopeSetupGeneration = activeGeneration;
    const filter = filterForScope(targetScope, targetRepo);
    const cachedScope = cachedScopes.get(scopeKey(targetScope, targetRepo));
    let nextQuests: readonly Quest[] = cachedScope?.quests ?? [];
    let nextBlockedIds: ReadonlySet<string> = cachedScope?.blockedIds ?? new Set();
    let nextMergedPrQuestIds: ReadonlySet<string> = cachedScope?.mergedPrQuestIds ?? new Set();
    let nextSignoffLens: QuestLogSignoffLens = cachedScope?.signoffLens ?? EMPTY_QUEST_LOG_SIGNOFF;
    let nextLoading = cachedScope === undefined;
    let nextError: string | null = cachedScope?.error ?? null;
    const nextReadErrors: Array<string | null> = [null, null];
    const updateNextReadError = (index: number, readError?: Error): void => {
      nextReadErrors[index] = readError?.message ?? null;
      nextError = nextReadErrors.find((message) => message !== null) ?? null;
    };
    const activeReadError = (): string | null =>
      nextReadErrors.find((message) => message !== null) ?? null;
    const nextSubscriptions: WatchSubscription[] = [];
    const planRevisionBeforeSetup = planRevision;
    generation = activeGeneration;
    currentRepo = targetRepo;
    scope = targetScope;
    error = nextError;
    quests = nextQuests;
    blockedIds = nextBlockedIds;
    mergedPrQuestIds = nextMergedPrQuestIds;
    signoffLens = nextSignoffLens;
    planSnapshot = cachedScope?.planSnapshot ?? null;
    loading = nextLoading;
    scopeRefreshing = true;
    emit();
    const [loadedPlanSnapshot, loadedMergedPrQuestIds, loadedSignoffLens] = await Promise.all([
      loadPlan(targetScope, targetRepo).catch(() => null),
      loadMergedPrQuestIds(targetScope, targetRepo).catch(() => new Set<string>()),
      loadSignoffLens(targetScope, targetRepo).catch((readError: unknown) =>
        signoffLensAfterReadError(readError),
      ),
    ]);
    const nextPlanSnapshot = loadedPlanSnapshot;
    nextMergedPrQuestIds = loadedMergedPrQuestIds;
    nextSignoffLens = loadedSignoffLens;
    try {
      nextSubscriptions.push(
        ...(await registerWatchSubscriptions(
          [
            options.store.watch(filter, (watchedQuests, readError) => {
              if (activeGeneration === subscriptionGeneration) {
                subscriptionReadErrors[0] = readError?.message ?? null;
              }
              if (readError !== undefined) {
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
              listRevision += 1;
              emit();
              requestPlanRefresh(activeGeneration, targetScope, targetRepo);
              requestMergedPrQuestIdsRefresh(activeGeneration, targetScope, targetRepo);
              if (signoffLensActive) {
                requestSignoffLensRefresh(activeGeneration, targetScope, targetRepo);
              }
            }),
            options.store.watch({ ...filter, blocked: true }, (blockedQuests, readError) => {
              if (activeGeneration === subscriptionGeneration) {
                subscriptionReadErrors[1] = readError?.message ?? null;
              }
              if (readError !== undefined) {
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
              listRevision += 1;
              emit();
              requestPlanRefresh(activeGeneration, targetScope, targetRepo);
              if (signoffLensActive) {
                requestSignoffLensRefresh(activeGeneration, targetScope, targetRepo);
              }
            }),
          ],
          (subscription) => retiredSubscriptions.add(subscription),
        )),
      );
    } catch (setupError) {
      scopeSetupGeneration = null;
      await disposeSubscriptions(nextSubscriptions);
      const previousFilter = filterForScope(previousState.scope, previousState.currentRepo);
      const [refreshedRows, refreshedPlan, refreshedMergedPrQuestIds, refreshedSignoffLens] =
        await Promise.all([
          refreshScopeRowsAfterFailedSetup(
            options.store,
            previousFilter,
            previousState.quests,
            previousState.blockedIds,
          ),
          loadPlan(previousState.scope, previousState.currentRepo).catch(
            () => previousState.planSnapshot,
          ),
          loadMergedPrQuestIds(previousState.scope, previousState.currentRepo).catch(
            () => previousState.mergedPrQuestIds,
          ),
          loadSignoffLens(previousState.scope, previousState.currentRepo).catch(
            () => previousState.signoffLens,
          ),
        ]);
      generation = previousState.generation;
      currentRepo = previousState.currentRepo;
      scope = previousState.scope;
      error = rollbackReadError(
        hadPreviousSubscriptions,
        subscriptionReadErrors,
        previousState.error,
      );
      quests = refreshedRows.quests;
      blockedIds = refreshedRows.blockedIds;
      mergedPrQuestIds = refreshedMergedPrQuestIds;
      signoffLens = refreshedSignoffLens;
      planSnapshot = refreshedPlan;
      loading = previousState.loading;
      scopeRefreshing = false;
      emit();
      throw setupError;
    }

    const previousSubscriptions = subscriptions;
    generation = activeGeneration;
    currentRepo = targetRepo;
    scope = targetScope;
    error = nextError;
    subscriptions = nextSubscriptions;
    subscriptionGeneration = activeGeneration;
    subscriptionReadErrors = [nextReadErrors[0] ?? null, nextReadErrors[1] ?? null];
    quests = nextQuests;
    blockedIds = nextBlockedIds;
    mergedPrQuestIds = nextMergedPrQuestIds;
    signoffLens = nextSignoffLens;
    if (planRevision === planRevisionBeforeSetup) {
      planSnapshot = nextPlanSnapshot;
    }
    scopeSetupGeneration = null;
    loading = nextLoading;
    scopeRefreshing = false;
    emit();
    requestPlanRefresh(activeGeneration, targetScope, targetRepo);
    requestMergedPrQuestIdsRefresh(activeGeneration, targetScope, targetRepo);
    requestSignoffLensRefresh(activeGeneration, targetScope, targetRepo);
    if (signoffLensActive) {
      startSignoffRefreshTimer();
    }
    await disposeSubscriptions(previousSubscriptions);
  };

  const showScopeError = async (
    targetScope: QuestLogScope,
    targetRepo: string | null,
    readError: FederatedReadError,
  ): Promise<void> => {
    stopSignoffRefreshTimer();
    await unsubscribeCurrent();
    generation = ++generationSequence;
    currentRepo = targetRepo;
    scope = targetScope;
    error = readError.message;
    quests = [];
    blockedIds = new Set();
    mergedPrQuestIds = new Set();
    planSnapshot = null;
    signoffLens = EMPTY_QUEST_LOG_SIGNOFF;
    loading = false;
    scopeRefreshing = false;
    emit();
  };

  const showPartialScopeWarning = (activeGeneration: number, readError: Error): void => {
    if (activeGeneration !== generation) {
      return;
    }
    error = readError.message;
    loading = false;
    emit();
  };

  const handleWatchReadError = (
    activeGeneration: number,
    readError: Error,
    applyPartialSnapshot: () => void,
  ): void => {
    if (activeGeneration !== generation) {
      return;
    }
    applyPartialSnapshot();
    showPartialScopeWarning(activeGeneration, readError);
  };

  const refreshKnownRepositories = async (): Promise<void> => {
    const stats = await options.store.stats({ repo: null });
    for (const repository of stats.repos) {
      repositoryNames.add(repository.repo);
    }
    if (currentRepo !== null) {
      repositoryNames.add(currentRepo);
    }
  };

  const recordDiscoveredRepositories = (discoveredQuests: readonly Quest[]): void => {
    const questsByRepository = new Map<string, Quest[]>();
    for (const quest of discoveredQuests) {
      repositoryNames.add(quest.repo);
      const repositoryQuests = questsByRepository.get(quest.repo) ?? [];
      repositoryQuests.push(quest);
      questsByRepository.set(quest.repo, repositoryQuests);
    }
    for (const [repository, repositoryQuests] of questsByRepository) {
      if (scope === "current" && currentRepo === repository) {
        continue;
      }
      const key = scopeKey("current", repository);
      const cached = cachedScopes.get(key);
      cachedScopes.set(key, {
        blockedIds: cached?.blockedIds ?? new Set(),
        error: cached?.error ?? null,
        mergedPrQuestIds: cached?.mergedPrQuestIds ?? new Set(),
        planSnapshot: cached?.planSnapshot ?? null,
        quests: repositoryQuests,
        signoffLens: cached?.signoffLens ?? EMPTY_QUEST_LOG_SIGNOFF,
      });
    }
  };

  const startRepositoryDiscovery = async (): Promise<void> => {
    repositorySubscription = await options.store.watch({}, recordDiscoveredRepositories);
  };

  const readKnownRepositories = async (): Promise<readonly string[] | null> => {
    if (repositorySubscription !== null && repositoryNames.size > 0) {
      return [...repositoryNames].sort((left, right) => left.localeCompare(right));
    }
    try {
      await refreshKnownRepositories();
      if (repositorySubscription === null) {
        await startRepositoryDiscovery().catch(() => undefined);
      }
      return [...repositoryNames].sort((left, right) => left.localeCompare(right));
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
        await Promise.all([
          refreshKnownRepositories().catch(() => undefined),
          startRepositoryDiscovery().catch(() => undefined),
        ]);
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
    setSignoffActive,
    start,
    stop: async () => {
      signoffLensActive = false;
      stopSignoffRefreshTimer();
      await Promise.all([scopeTransitions, ...pendingActions]);
      generation = ++generationSequence;
      scopeRefreshing = false;
      signoffRefreshing = false;
      const discoverySubscription = repositorySubscription;
      repositorySubscription = null;
      await Promise.all([
        unsubscribeCurrent(),
        discoverySubscription?.unsubscribe() ?? Promise.resolve(),
      ]);
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
