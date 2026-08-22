import type {
  AcceptQuestInput,
  Chain,
  ChainMutation,
  ChainRemovalResult,
  ChainResult,
  Event,
  EventFilter,
  Evidence,
  FederatedListDump,
  NewEvidence,
  NewQuest,
  Quest,
  QuestDump,
  QuestFilter,
  QuestScope,
  QuestStats,
  QuestTransition,
  RepoStats,
  Sha256,
  SignoffBatchInput,
  SignoffBatchResult,
  TouchQuestInput,
} from "../schema";
import {
  eventRepository,
  federatedListDumpSchema,
  questDumpSchema,
  questStatusSchema,
  STORE_SCHEMA_VERSION,
  verdictSchema,
} from "../schema";
import { readQuestListDump } from "./list-dump";
import type {
  BlobStore,
  FederatedFullSnapshot,
  FederatedReadSnapshot,
  FederatedSnapshotWatchListener,
  QuestDetailSnapshot,
  QuestStore,
  QuestWatchListener,
  WatchSubscription,
} from "./port";

export interface FederatedStoreSource {
  readonly blobStore: BlobStore;
  readonly includeRepository: (repo: string) => boolean;
  readonly needsWatchPolling?: () => boolean;
  readonly questStore: QuestStore;
  readonly readError?: (repository: string | undefined) => Error | undefined;
  readonly readFullSnapshot?: (() => Promise<FederatedFullSnapshot>) | undefined;
  readonly readSnapshot?: ((repository?: string) => Promise<FederatedReadSnapshot>) | undefined;
  readonly refresh?: () => Promise<void>;
  readonly routesRepository?: (repo: string) => boolean;
  readonly watchSnapshot?: (
    repository: string | undefined,
    listener: FederatedSnapshotWatchListener,
  ) => Promise<WatchSubscription>;
}

export class FederatedReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FederatedReadError";
  }
}

function compareQuests(left: Quest, right: Quest): number {
  return left.id - right.id || left.repo.localeCompare(right.repo);
}

function compareEvents(left: Event, right: Event): number {
  return (
    left.id - right.id || (eventRepository(left) ?? "").localeCompare(eventRepository(right) ?? "")
  );
}

function compareChains(left: Chain, right: Chain): number {
  return (
    left.quest_id - right.quest_id ||
    left.target_id - right.target_id ||
    left.type.localeCompare(right.type)
  );
}

function sourceRoutesRepository(source: FederatedStoreSource, repository: string): boolean {
  return (source.routesRepository ?? source.includeRepository)(repository);
}

function sourceIncludesRepository(
  source: FederatedStoreSource,
  repository: string,
  fencedRepositories: ReadonlySet<string> | undefined = undefined,
): boolean {
  return fencedRepositories === undefined
    ? source.includeRepository(repository)
    : sourceRoutesRepository(source, repository) && !fencedRepositories.has(repository);
}

function sourceReadError(
  source: FederatedStoreSource,
  repository: string | undefined,
): Error | undefined {
  return source.readError?.(repository);
}

function filterQuests(
  quests: readonly Quest[],
  source: FederatedStoreSource,
  scope: QuestScope | undefined = undefined,
  fencedRepositories: ReadonlySet<string> | undefined = undefined,
): Quest[] {
  return quests
    .filter((quest) => sourceIncludesRepository(source, quest.repo, fencedRepositories))
    .filter((quest) => scope === undefined || scope.repo === null || quest.repo === scope.repo);
}

function filterSnapshotQuests(
  snapshot: FederatedReadSnapshot,
  source: FederatedStoreSource,
  filter: QuestFilter,
): Quest[] {
  const fencedRepositories = new Set(snapshot.fencedRepositories);
  const statusById = new Map(snapshot.dump.quests.map((quest) => [quest.id, quest.status]));
  const blockedIds =
    filter.blocked === undefined
      ? undefined
      : new Set(
          snapshot.dump.chains
            .filter(
              (link) => link.type === "requires" && statusById.get(link.target_id) !== "complete",
            )
            .map((link) => link.quest_id),
        );
  return snapshot.dump.quests.filter(
    (quest) =>
      sourceIncludesRepository(source, quest.repo, fencedRepositories) &&
      (filter.repo === undefined || quest.repo === filter.repo) &&
      (filter.status === undefined || quest.status === filter.status) &&
      (filter.area === undefined || quest.area === filter.area) &&
      (filter.kind === undefined || quest.kind === filter.kind) &&
      (filter.assignee === undefined || quest.assignee === filter.assignee) &&
      (filter.blocked === undefined || blockedIds?.has(quest.id) === filter.blocked),
  );
}

export function statsForQuests(quests: readonly Quest[]): QuestStats {
  const repos = new Map<string, RepoStats>();
  for (const quest of quests) {
    const current = repos.get(quest.repo) ?? {
      repo: quest.repo,
      total: 0,
      status_counts: {},
      verdict_counts: {},
      reopen_count: 0,
      assignee_load: {},
    };
    current.total += 1;
    current.status_counts[quest.status] = (current.status_counts[quest.status] ?? 0) + 1;
    if (quest.verdict !== null) {
      current.verdict_counts[quest.verdict] = (current.verdict_counts[quest.verdict] ?? 0) + 1;
    }
    current.reopen_count += quest.reopen_count;
    if (quest.assignee !== null) {
      current.assignee_load[quest.assignee] = (current.assignee_load[quest.assignee] ?? 0) + 1;
    }
    repos.set(quest.repo, current);
  }
  return {
    repos: [...repos.values()].sort((left, right) => left.repo.localeCompare(right.repo)),
  };
}

function filterSnapshotEvents(
  snapshot: FederatedFullSnapshot,
  source: FederatedStoreSource,
  filter: EventFilter,
): Event[] {
  const fencedRepositories = new Set(snapshot.fencedRepositories);
  const questsById = new Map(snapshot.dump.quests.map((quest) => [quest.id, quest]));
  return snapshot.dump.events
    .filter((event) => {
      const quest = questsById.get(event.quest_id);
      return (
        quest !== undefined &&
        sourceIncludesRepository(source, quest.repo, fencedRepositories) &&
        (filter.repo === undefined || quest.repo === filter.repo) &&
        (filter.quest_id === undefined || event.quest_id === filter.quest_id) &&
        (filter.after_id === undefined || event.id > filter.after_id) &&
        (filter.since === undefined || Date.parse(event.at) >= Date.parse(filter.since)) &&
        (filter.until === undefined || Date.parse(event.at) <= Date.parse(filter.until)) &&
        (filter.actor === undefined || event.actor === filter.actor) &&
        (filter.action === undefined || event.action === filter.action) &&
        (filter.area === undefined || quest.area === filter.area)
      );
    })
    .map((event) => {
      const quest = questsById.get(event.quest_id);
      return quest === undefined ? event : { ...event, repo: quest.repo };
    });
}

function requireFullSnapshotReader(
  source: FederatedStoreSource,
): () => Promise<FederatedFullSnapshot> {
  if (source.readFullSnapshot !== undefined) {
    return source.readFullSnapshot;
  }
  throw new FederatedReadError(
    "[FEDERATED_FULL_SNAPSHOT_UNAVAILABLE] this reactive backend cannot provide an atomic history or export read; update its store adapter and retry",
  );
}

async function readValidatedFullSnapshot(
  source: FederatedStoreSource,
  repository: string | undefined,
): Promise<FederatedFullSnapshot> {
  const snapshot = await requireFullSnapshotReader(source)();
  const readError = source.readError?.(repository);
  if (readError !== undefined) {
    throw readError;
  }
  return snapshot;
}

function repositoryScope(repository: string | undefined): QuestScope | undefined {
  return repository === undefined ? undefined : { repo: repository };
}

function chainNeighbors(chain: Chain, questId: number): readonly number[] {
  if (chain.quest_id === questId) {
    return [chain.target_id];
  }
  return chain.target_id === questId ? [chain.quest_id] : [];
}

function expandExportQuestIds(
  dump: FederatedListDump,
  source: FederatedStoreSource,
  allowedIds: Set<number>,
  fencedRepositories: ReadonlySet<string> | undefined,
): void {
  const pending = [...allowedIds];
  while (pending.length > 0) {
    const questId = pending.pop();
    if (questId === undefined) {
      continue;
    }
    for (const chain of dump.chains) {
      for (const relatedId of chainNeighbors(chain, questId)) {
        const quest = dump.quests.find((candidate) => candidate.id === relatedId);
        if (
          quest === undefined ||
          !sourceIncludesRepository(source, quest.repo, fencedRepositories) ||
          allowedIds.has(relatedId)
        ) {
          continue;
        }
        allowedIds.add(relatedId);
        pending.push(relatedId);
      }
    }
  }
}

function exportQuestIds(
  dump: FederatedListDump,
  source: FederatedStoreSource,
  repository: string | undefined,
  fencedRepositories: ReadonlySet<string> | undefined = undefined,
): ReadonlySet<number> {
  const allowedIds = new Set(
    filterQuests(dump.quests, source, repositoryScope(repository), fencedRepositories).map(
      (quest) => quest.id,
    ),
  );
  if (repository === undefined) {
    return allowedIds;
  }
  expandExportQuestIds(dump, source, allowedIds, fencedRepositories);
  return allowedIds;
}

function mergeStatusCounts(left: RepoStats, right: RepoStats): RepoStats["status_counts"] {
  const counts: RepoStats["status_counts"] = {};
  for (const status of questStatusSchema.options) {
    const count = (left.status_counts[status] ?? 0) + (right.status_counts[status] ?? 0);
    if (count > 0) {
      counts[status] = count;
    }
  }
  return counts;
}

function mergeVerdictCounts(left: RepoStats, right: RepoStats): RepoStats["verdict_counts"] {
  const counts: RepoStats["verdict_counts"] = {};
  for (const verdict of verdictSchema.options) {
    const count = (left.verdict_counts[verdict] ?? 0) + (right.verdict_counts[verdict] ?? 0);
    if (count > 0) {
      counts[verdict] = count;
    }
  }
  return counts;
}

function mergeAssigneeLoad(left: RepoStats, right: RepoStats): RepoStats["assignee_load"] {
  const load = { ...left.assignee_load };
  for (const [assignee, count] of Object.entries(right.assignee_load)) {
    load[assignee] = (load[assignee] ?? 0) + count;
  }
  return load;
}

function mergeRepoStats(left: RepoStats, right: RepoStats): RepoStats {
  return {
    repo: left.repo,
    total: left.total + right.total,
    status_counts: mergeStatusCounts(left, right),
    verdict_counts: mergeVerdictCounts(left, right),
    reopen_count: left.reopen_count + right.reopen_count,
    assignee_load: mergeAssigneeLoad(left, right),
  };
}

function mergeQuestSnapshots(snapshots: readonly (readonly Quest[])[]): Quest[] {
  return snapshots.flat().sort(compareQuests);
}

interface FederatedWatchResult {
  readonly error?: Error;
  readonly snapshot?: Quest[];
}

interface FederatedSourceRead {
  readonly source: FederatedStoreSource;
  readonly snapshot?: FederatedReadSnapshot;
}

interface FederatedFullSourceRead {
  readonly source: FederatedStoreSource;
  readonly snapshot?: FederatedFullSnapshot;
}

async function readFederatedSource(
  source: FederatedStoreSource,
  repository: string | undefined,
): Promise<FederatedSourceRead> {
  if (source.readSnapshot === undefined) {
    return { source };
  }
  const snapshot = await source.readSnapshot(repository);
  const readError = source.readError?.(undefined);
  if (readError !== undefined) {
    throw readError;
  }
  return { source, snapshot };
}

function federatedWatchReadError(filter: QuestFilter, error: unknown): FederatedReadError {
  if (error instanceof FederatedReadError) {
    return error;
  }
  if (error instanceof Error && /^\[[A-Z0-9_]+\]/.test(error.message)) {
    return new FederatedReadError(error.message);
  }
  const scope = filter.repo === undefined ? "a routed backend" : `repository ${filter.repo}`;
  return new FederatedReadError(
    `[FEDERATED_SCOPE_UNAVAILABLE] ${scope} stopped responding; retry when its deployment is reachable`,
  );
}

async function readFederatedWatchSnapshot(
  filter: QuestFilter,
  source: FederatedStoreSource,
): Promise<FederatedWatchResult> {
  try {
    if (source.readSnapshot !== undefined) {
      const readError = source.readError?.(filter.repo);
      if (readError !== undefined) {
        return { error: readError };
      }
      const snapshot = await source.readSnapshot(filter.repo);
      const refreshedReadError = source.readError?.(filter.repo);
      return refreshedReadError === undefined
        ? { snapshot: filterSnapshotQuests(snapshot, source, filter) }
        : { error: refreshedReadError };
    }
    await source.refresh?.();
    const readError = source.readError?.(filter.repo);
    if (readError !== undefined) {
      return { error: readError };
    }
    return {
      snapshot: filterQuests(await source.questStore.listQuests(filter), source),
    };
  } catch (error: unknown) {
    return { error: federatedWatchReadError(filter, error) };
  }
}

async function refreshFederatedWatchResult(
  filter: QuestFilter,
  source: FederatedStoreSource,
  quests: readonly Quest[],
  sourceError: Error | undefined,
): Promise<FederatedWatchResult> {
  if (sourceError !== undefined) {
    return { error: federatedWatchReadError(filter, sourceError) };
  }
  try {
    if (source.readSnapshot !== undefined) {
      const readError = source.readError?.(filter.repo);
      if (readError !== undefined) {
        return { error: readError };
      }
      const snapshot = await source.readSnapshot(filter.repo);
      const refreshedReadError = source.readError?.(filter.repo);
      return refreshedReadError === undefined
        ? { snapshot: filterSnapshotQuests(snapshot, source, filter) }
        : { error: refreshedReadError };
    }
    await source.refresh?.();
  } catch (error: unknown) {
    return { error: federatedWatchReadError(filter, error) };
  }
  const readError = source.readError?.(filter.repo);
  return readError === undefined
    ? { snapshot: filterQuests(quests, source) }
    : { error: readError };
}

function reactiveFederatedWatchResult(
  filter: QuestFilter,
  source: FederatedStoreSource,
  snapshot: FederatedReadSnapshot,
  sourceError: Error | undefined,
): FederatedWatchResult {
  if (sourceError !== undefined) {
    return { error: federatedWatchReadError(filter, sourceError) };
  }
  const readError = source.readError?.(filter.repo);
  return readError === undefined
    ? { snapshot: filterSnapshotQuests(snapshot, source, filter) }
    : { error: readError };
}

function watchFederatedSource(
  source: FederatedStoreSource,
  filter: QuestFilter,
  onQuests: QuestWatchListener,
  onSnapshot: Parameters<NonNullable<QuestStore["watchFederatedSnapshot"]>>[1],
): Promise<WatchSubscription> {
  const watchSnapshot =
    source.watchSnapshot ??
    (source.needsWatchPolling === undefined
      ? source.questStore.watchFederatedSnapshot?.bind(source.questStore)
      : undefined);
  return watchSnapshot === undefined
    ? source.questStore.watch(filter, onQuests)
    : watchSnapshot(filter.repo, onSnapshot);
}

function sourceHasReactiveWatch(source: FederatedStoreSource): boolean {
  return (
    source.watchSnapshot !== undefined ||
    (source.needsWatchPolling === undefined &&
      source.questStore.watchFederatedSnapshot !== undefined)
  );
}

function sourceNeedsPolling(source: FederatedStoreSource): boolean {
  return (
    (source.refresh !== undefined || source.readSnapshot !== undefined) &&
    (source.needsWatchPolling?.() ?? !sourceHasReactiveWatch(source))
  );
}

async function readInitialFederatedWatchResults(
  sources: readonly FederatedStoreSource[],
  filter: QuestFilter,
  progressive: boolean,
  listener: QuestWatchListener,
): Promise<FederatedWatchResult[]> {
  const results: FederatedWatchResult[] = sources.map(() => ({}));
  await Promise.all(
    sources.map(async (source, index) => {
      const result = await readFederatedWatchSnapshot(filter, source);
      results[index] = result;
      if (progressive && result.snapshot !== undefined) {
        listener(
          mergeQuestSnapshots(results.map((candidate) => candidate.snapshot ?? [])),
          results.find((candidate) => candidate.error !== undefined)?.error,
        );
      }
    }),
  );
  return results;
}

function requireUsableInitialWatch(
  filter: QuestFilter,
  allowPartialReads: boolean,
  results: readonly FederatedWatchResult[],
): void {
  const initialError = results.find((result) => result.error !== undefined)?.error;
  const hasHealthySource = results.some((result) => result.error === undefined);
  if (
    initialError !== undefined &&
    (filter.repo !== undefined || !allowPartialReads || !hasHealthySource)
  ) {
    throw initialError;
  }
}

function readOnlyMutationError(): FederatedReadError {
  return new FederatedReadError(
    "[FEDERATED_READ_ONLY] --all is a read-only scope; rerun without --all and pass --repo <name> for mutations",
  );
}

function ambiguousDisplayIdError(id: number): FederatedReadError {
  return new FederatedReadError(
    `[AMBIGUOUS_DISPLAY_ID] quest ${id} exists in multiple backends; display IDs are per-store; rerun with --repo <name> to select one backend`,
  );
}

function federatedCursorError(): FederatedReadError {
  return new FederatedReadError(
    "[UNSUPPORTED_FEDERATED_CURSOR] --after-id is backend-local and cannot continue a federated event feed; rerun with --repo <name> for a stable cursor",
  );
}

interface FederatedQuestMatch {
  readonly quest: Quest;
  readonly source: FederatedStoreSource;
  readonly snapshot?: FederatedReadSnapshot;
}

async function matchingQuestSources(
  sources: readonly FederatedStoreSource[],
  id: number,
  repository?: string,
): Promise<readonly FederatedQuestMatch[]> {
  const matches = await Promise.all(
    sources.map(async (source) => {
      if (source.readSnapshot !== undefined) {
        const snapshot = await source.readSnapshot(repository);
        const readError = source.readError?.(repository);
        if (readError !== undefined) {
          throw readError;
        }
        const quest = snapshot.dump.quests.find(
          (candidate) =>
            candidate.id === id &&
            (repository === undefined || candidate.repo === repository) &&
            sourceIncludesRepository(source, candidate.repo, new Set(snapshot.fencedRepositories)),
        );
        return quest === undefined ? null : { quest, source, snapshot };
      }
      const readError = source.readError?.(undefined);
      if (readError !== undefined) {
        throw readError;
      }
      const quest = await source.questStore.getQuest(id);
      return quest !== null &&
        (repository === undefined || quest.repo === repository) &&
        source.includeRepository(quest.repo)
        ? { quest, source }
        : null;
    }),
  );
  return matches.flatMap((match) => (match === null ? [] : [match]));
}

function requireUnambiguousQuest(matches: readonly FederatedQuestMatch[], id: number): void {
  if (matches.length > 1) {
    throw ambiguousDisplayIdError(id);
  }
}

function assertUniqueQuestIds(quests: readonly Quest[]): void {
  const repositoriesById = new Map<number, string>();
  for (const quest of quests) {
    const existingRepository = repositoriesById.get(quest.id);
    if (existingRepository !== undefined) {
      throw new FederatedReadError(
        `[AMBIGUOUS_DISPLAY_ID] federated export cannot preserve relationships for quest ${quest.id} from repositories ${existingRepository} and ${quest.repo}; display IDs are per-store; rerun with --repo <name> for a relational read`,
      );
    }
    repositoriesById.set(quest.id, quest.repo);
  }
}

export class FederatedQuestStore implements QuestStore {
  readonly #sources: readonly FederatedStoreSource[];
  readonly #repositoryScope: string | undefined;
  readonly #allowPartialReads: boolean;

  constructor(
    sources: readonly FederatedStoreSource[],
    repositoryScope?: string,
    options: { readonly allowPartialReads?: boolean } = {},
  ) {
    this.#sources = [...sources];
    this.#repositoryScope = repositoryScope;
    this.#allowPartialReads = options.allowPartialReads ?? false;
  }

  addQuest(_input: NewQuest): Promise<Quest> {
    return Promise.reject(readOnlyMutationError());
  }

  acceptQuest(_input: AcceptQuestInput): ReturnType<QuestStore["acceptQuest"]> {
    return Promise.reject(readOnlyMutationError());
  }

  acceptQuestAndDetail(_input: AcceptQuestInput): ReturnType<QuestStore["acceptQuestAndDetail"]> {
    return Promise.reject(readOnlyMutationError());
  }

  touchQuest(_input: TouchQuestInput): Promise<Quest> {
    return Promise.reject(readOnlyMutationError());
  }

  transition(_id: number, _transition: QuestTransition): Promise<Quest> {
    return Promise.reject(readOnlyMutationError());
  }

  signoffBatch(_input: SignoffBatchInput): Promise<SignoffBatchResult> {
    return Promise.reject(readOnlyMutationError());
  }

  addChainLink(_input: ChainMutation): Promise<ChainResult> {
    return Promise.reject(readOnlyMutationError());
  }

  removeChainLink(_input: ChainMutation): Promise<ChainRemovalResult> {
    return Promise.reject(readOnlyMutationError());
  }

  addEvidence(_input: NewEvidence): Promise<Evidence> {
    return Promise.reject(readOnlyMutationError());
  }

  #selectSourcesForRepository(repository: string | undefined): readonly FederatedStoreSource[] {
    const scopedRepository = this.#repositoryScope ?? repository;
    return scopedRepository === undefined
      ? this.#sources
      : this.#sources.filter((source) =>
          (source.routesRepository ?? source.includeRepository)(scopedRepository),
        );
  }

  #sourcesForRepository(repository: string | undefined): readonly FederatedStoreSource[] {
    const sources = this.#selectSourcesForRepository(repository);
    if (repository === undefined) {
      const unavailable = sources.find(
        (source) => sourceReadError(source, undefined) !== undefined,
      );
      if (!this.#allowPartialReads && unavailable !== undefined) {
        const readError = sourceReadError(unavailable, undefined);
        if (readError !== undefined) {
          throw readError;
        }
      }
      return this.#allowPartialReads
        ? sources.filter((source) => sourceReadError(source, undefined) === undefined)
        : sources;
    }
    const unavailable = sources.find((source) => sourceReadError(source, repository) !== undefined);
    const readError =
      unavailable === undefined ? undefined : sourceReadError(unavailable, repository);
    if (readError !== undefined) {
      throw readError;
    }
    return sources;
  }

  async #readSources(repository: string | undefined): Promise<readonly FederatedStoreSource[]> {
    await Promise.all(
      this.#sources
        .filter((source) => source.readSnapshot === undefined)
        .map((source) => source.refresh?.()),
    );
    return this.#sourcesForRepository(this.#repositoryScope ?? repository);
  }

  async #settleSourceReads<Read>(
    repository: string | undefined,
    reads: readonly Promise<Read>[],
  ): Promise<readonly Read[]> {
    const attempts = await Promise.allSettled(reads);
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    if (rejected.length > 0 && (!this.#allowPartialReads || repository !== undefined)) {
      throw federatedWatchReadError({ repo: repository }, rejected[0]?.reason);
    }
    return attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : []));
  }

  async #readSourceSnapshots(
    repository: string | undefined,
  ): Promise<readonly FederatedSourceRead[]> {
    const sources = await this.#readSources(repository);
    return this.#settleSourceReads(
      repository,
      sources.map((source) => readFederatedSource(source, repository)),
    );
  }

  /**
   * Reads each routed source's whole-store list snapshot. A repository-scoped source read keeps
   * only one chain hop, which is enough for lists but not for relational reads (plans, chain
   * trees, next selection) that need the transitive closure the same way exportAll does.
   */
  async #readWholeStoreSourceSnapshots(
    repository: string | undefined,
  ): Promise<readonly FederatedSourceRead[]> {
    const sources = await this.#readSources(repository);
    return this.#settleSourceReads(
      repository,
      sources.map((source) => readFederatedSource(source, undefined)),
    );
  }

  async #readFullSourceSnapshots(
    repository: string | undefined,
  ): Promise<readonly FederatedFullSourceRead[]> {
    const sources = await this.#readSources(repository);
    return this.#settleSourceReads(
      repository,
      sources.map(async (source) => ({
        source,
        ...(source.readSnapshot === undefined
          ? {}
          : { snapshot: await readValidatedFullSnapshot(source, repository) }),
      })),
    );
  }

  #sourcesForRepositoryScope(): Promise<readonly FederatedStoreSource[]> {
    return this.#readSources(this.#repositoryScope);
  }

  forRepository(repository: string): QuestStore {
    return new FederatedQuestStore(this.#selectSourcesForRepository(repository), repository, {
      allowPartialReads: this.#allowPartialReads,
    });
  }

  async listQuests(filter: QuestFilter): Promise<Quest[]> {
    const scopedFilter =
      this.#repositoryScope === undefined ? filter : { ...filter, repo: this.#repositoryScope };
    const reads = await this.#readSourceSnapshots(scopedFilter.repo);
    const results = await Promise.all(
      reads.map(async ({ source, snapshot }) =>
        snapshot === undefined
          ? filterQuests(
              await source.questStore.listQuests(scopedFilter),
              source,
              repositoryScope(scopedFilter.repo),
            )
          : filterSnapshotQuests(snapshot, source, scopedFilter),
      ),
    );
    return mergeQuestSnapshots(results);
  }

  async getQuest(id: number): Promise<Quest | null> {
    const sources = await this.#sourcesForRepositoryScope();
    const matches = await matchingQuestSources(sources, id, this.#repositoryScope);
    requireUnambiguousQuest(matches, id);
    return matches[0]?.quest ?? null;
  }

  async readQuestDetail(id: number): Promise<QuestDetailSnapshot> {
    const sources = await this.#sourcesForRepositoryScope();
    const matches = await matchingQuestSources(sources, id, this.#repositoryScope);
    requireUnambiguousQuest(matches, id);
    const match = matches[0];
    if (match === undefined) {
      throw new Error(`quest ${id} does not exist`);
    }
    return match.source.questStore.readQuestDetail(id);
  }

  async stats(scope: QuestScope): Promise<QuestStats> {
    const scopedRepository =
      this.#repositoryScope ?? (scope.repo === null ? undefined : scope.repo);
    const reads = await this.#readSourceSnapshots(scopedRepository);
    const stats = await Promise.all(
      reads.map(async ({ source, snapshot }) => {
        if (snapshot !== undefined) {
          return statsForQuests(
            filterSnapshotQuests(
              snapshot,
              source,
              scopedRepository === undefined ? {} : { repo: scopedRepository },
            ),
          ).repos;
        }
        const result = await source.questStore.stats({ repo: null });
        return result.repos.filter(
          (repo) =>
            source.includeRepository(repo.repo) &&
            (scopedRepository === undefined || repo.repo === scopedRepository),
        );
      }),
    );
    const merged = new Map<string, RepoStats>();
    for (const repo of stats.flat()) {
      const existing = merged.get(repo.repo);
      merged.set(repo.repo, existing === undefined ? repo : mergeRepoStats(existing, repo));
    }
    return {
      repos: [...merged.values()].sort((left, right) => left.repo.localeCompare(right.repo)),
    };
  }

  async events(questId: number): Promise<Event[]> {
    const sources = await this.#sourcesForRepositoryScope();
    const matches = await matchingQuestSources(sources, questId, this.#repositoryScope);
    requireUnambiguousQuest(matches, questId);
    const match = matches[0];
    return match === undefined
      ? []
      : (match.source.readSnapshot === undefined
          ? await match.source.questStore.events(questId)
          : filterSnapshotEvents(
              await readValidatedFullSnapshot(match.source, this.#repositoryScope),
              match.source,
              {
                quest_id: questId,
                ...(this.#repositoryScope === undefined ? {} : { repo: this.#repositoryScope }),
              },
            )
        )
          .map((event) => ({ ...event, repo: match.quest.repo }))
          .sort(compareEvents);
  }

  async queryEvents(filter: EventFilter): Promise<Event[]> {
    if (filter.after_id !== undefined) {
      throw federatedCursorError();
    }
    const scopedFilter =
      this.#repositoryScope === undefined ? filter : { ...filter, repo: this.#repositoryScope };
    const reads = await this.#readFullSourceSnapshots(scopedFilter.repo);
    if (filter.quest_id !== undefined) {
      const matches = await matchingQuestSources(
        reads.map((read) => read.source),
        filter.quest_id,
        scopedFilter.repo,
      );
      requireUnambiguousQuest(matches, filter.quest_id);
    }
    const events = await Promise.all(
      reads.map(async ({ source, snapshot }) => {
        if (snapshot !== undefined) {
          return filterSnapshotEvents(snapshot, source, scopedFilter);
        }
        const result = await source.questStore.queryEvents(scopedFilter);
        const quests = await source.questStore.listQuests(
          scopedFilter.repo === undefined ? {} : { repo: scopedFilter.repo },
        );
        const allowedQuests = filterQuests(quests, source, repositoryScope(scopedFilter.repo));
        const repositoriesById = new Map(allowedQuests.map((quest) => [quest.id, quest.repo]));
        return result.flatMap((event) => {
          const repo = repositoriesById.get(event.quest_id);
          return repo === undefined ? [] : [{ ...event, repo }];
        });
      }),
    );
    return events.flat().sort(compareEvents);
  }

  /** Merges the per-source quests+chains list reads; no source pays for evidence or events. */
  async readFederatedSnapshot(repository?: string): Promise<FederatedReadSnapshot> {
    const scopedRepository = this.#repositoryScope ?? repository;
    const reads = await this.#readWholeStoreSourceSnapshots(scopedRepository);
    const dumps = await Promise.all(
      reads.map(async ({ source, snapshot }) => ({
        dump: snapshot?.dump ?? (await readQuestListDump(source.questStore)),
        fencedRepositories:
          snapshot === undefined ? undefined : new Set(snapshot.fencedRepositories),
        source,
      })),
    );
    const quests: Quest[] = [];
    const chains: Chain[] = [];
    const fencedRepositories = new Set<string>();
    for (const { dump, fencedRepositories: sourceFences, source } of dumps) {
      const allowedQuestIds = exportQuestIds(dump, source, scopedRepository, sourceFences);
      quests.push(...dump.quests.filter((quest) => allowedQuestIds.has(quest.id)));
      chains.push(
        ...dump.chains.filter(
          (link) => allowedQuestIds.has(link.quest_id) && allowedQuestIds.has(link.target_id),
        ),
      );
      for (const fenced of sourceFences ?? []) {
        fencedRepositories.add(fenced);
      }
    }
    assertUniqueQuestIds(quests);
    return {
      dump: federatedListDumpSchema.parse({
        schema_version: STORE_SCHEMA_VERSION,
        quests: quests.sort(compareQuests),
        chains: chains.sort(compareChains),
      }),
      fencedRepositories: [...fencedRepositories].sort(),
    };
  }

  async exportAll(): Promise<QuestDump> {
    const reads = await this.#readFullSourceSnapshots(this.#repositoryScope);
    const dumps = await Promise.all(
      reads.map(async ({ source, snapshot }) => {
        return {
          dump: snapshot?.dump ?? (await source.questStore.exportAll()),
          fencedRepositories:
            snapshot === undefined ? undefined : new Set(snapshot.fencedRepositories),
          source,
        };
      }),
    );
    const quests: Quest[] = [];
    const evidence: Evidence[] = [];
    const chains: Chain[] = [];
    const events: Event[] = [];
    for (const { dump, fencedRepositories, source } of dumps) {
      const allowedQuestIds = exportQuestIds(
        dump,
        source,
        this.#repositoryScope,
        fencedRepositories,
      );
      const allowedQuests = dump.quests.filter((quest) => allowedQuestIds.has(quest.id));
      quests.push(...allowedQuests);
      evidence.push(...dump.evidence.filter((item) => allowedQuestIds.has(item.quest_id)));
      chains.push(
        ...dump.chains.filter(
          (link) => allowedQuestIds.has(link.quest_id) && allowedQuestIds.has(link.target_id),
        ),
      );
      const repositoriesById = new Map(allowedQuests.map((quest) => [quest.id, quest.repo]));
      events.push(
        ...dump.events
          .filter((event) => allowedQuestIds.has(event.quest_id))
          .map((event) => ({ ...event, repo: repositoriesById.get(event.quest_id) })),
      );
    }
    assertUniqueQuestIds(quests);
    return questDumpSchema.parse({
      schema_version: STORE_SCHEMA_VERSION,
      quests: quests.sort(compareQuests),
      evidence: evidence.sort((left, right) => left.id - right.id),
      chains: chains.sort(compareChains),
      events: events.sort(compareEvents),
    });
  }

  async watch(filter: QuestFilter, listener: QuestWatchListener): Promise<WatchSubscription> {
    const scopedFilter =
      this.#repositoryScope === undefined ? filter : { ...filter, repo: this.#repositoryScope };
    const sources = this.#selectSourcesForRepository(scopedFilter.repo);
    await Promise.all(
      sources
        .filter((source) => source.readSnapshot === undefined)
        .map((source) => source.refresh?.()),
    );
    if (scopedFilter.repo === undefined && !this.#allowPartialReads) {
      this.#sourcesForRepository(undefined);
    }
    if (scopedFilter.repo !== undefined) {
      this.#sourcesForRepository(scopedFilter.repo);
    }
    const initialResults = await readInitialFederatedWatchResults(
      sources,
      scopedFilter,
      scopedFilter.repo === undefined && this.#allowPartialReads,
      listener,
    );
    requireUsableInitialWatch(scopedFilter, this.#allowPartialReads, initialResults);
    const sourceErrors = initialResults.map((result) => result.error);
    const snapshots = initialResults.map((result) => result.snapshot ?? []);
    let active = true;
    let refreshRunning = false;
    const sourceRefreshGenerations = sources.map(() => 0);
    const beginSourceRefresh = (index: number): number => {
      const generation = (sourceRefreshGenerations[index] ?? 0) + 1;
      sourceRefreshGenerations[index] = generation;
      return generation;
    };
    const inFlight = new Set<Promise<void>>();
    const track = (action: Promise<void>): void => {
      inFlight.add(action);
      void action.then(
        () => inFlight.delete(action),
        () => inFlight.delete(action),
      );
    };
    const waitForCallbacks = async (): Promise<void> => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    };
    const emit = (readError?: Error): void => {
      if (!active) {
        return;
      }
      listener(
        mergeQuestSnapshots(snapshots),
        readError ?? sourceErrors.find((error) => error !== undefined),
      );
    };
    const applyRefreshResults = (
      generations: readonly number[],
      results: readonly (FederatedWatchResult | undefined)[],
    ): { readonly applied: boolean; readonly firstError: Error | undefined } => {
      let firstError: Error | undefined;
      let applied = false;
      for (const [index, result] of results.entries()) {
        if (result === undefined) {
          continue;
        }
        if (generations[index] !== sourceRefreshGenerations[index]) {
          continue;
        }
        applied = true;
        sourceErrors[index] = result.error;
        if (result.snapshot !== undefined) {
          snapshots[index] = result.snapshot;
        } else if (result.error !== undefined) {
          snapshots[index] = [];
        }
        firstError ??= result.error;
      }
      return { applied, firstError };
    };
    const refreshSnapshot = async (): Promise<void> => {
      if (!active || refreshRunning) {
        return;
      }
      refreshRunning = true;
      try {
        const generations = sources.map((source, index) =>
          !sourceNeedsPolling(source)
            ? (sourceRefreshGenerations[index] ?? 0)
            : beginSourceRefresh(index),
        );
        const results = await Promise.all(
          sources.map((source) =>
            !sourceNeedsPolling(source)
              ? Promise.resolve(undefined)
              : readFederatedWatchSnapshot(scopedFilter, source),
          ),
        );
        if (!active) {
          return;
        }
        const outcome = applyRefreshResults(generations, results);
        if (outcome.applied) {
          emit(outcome.firstError);
        }
      } finally {
        refreshRunning = false;
      }
    };
    const refreshTimer = sources.some(sourceNeedsPolling)
      ? setInterval(() => {
          track(refreshSnapshot());
        }, 1_000)
      : undefined;
    refreshTimer?.unref?.();
    const subscriptions: WatchSubscription[] = [];
    const watchRetryTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const clearWatchRetryTimers = (): void => {
      for (const timer of watchRetryTimers.values()) {
        clearTimeout(timer);
      }
      watchRetryTimers.clear();
    };
    let unsubscribePromise: Promise<void> | undefined;
    let registrationComplete = false;
    const deferredWatchResults: Array<() => void> = [];
    try {
      for (const [index, source] of sources.entries()) {
        if (
          (initialResults[index]?.error !== undefined ||
            sourceReadError(source, scopedFilter.repo) !== undefined) &&
          !sourceHasReactiveWatch(source)
        ) {
          continue;
        }
        const handleResult = (result: FederatedWatchResult, refreshGeneration: number): void => {
          if (!registrationComplete) {
            deferredWatchResults.push(() => handleResult(result, refreshGeneration));
            return;
          }
          if (!active || refreshGeneration !== sourceRefreshGenerations[index]) {
            return;
          }
          sourceErrors[index] = result.error;
          if (result.error !== undefined) {
            snapshots[index] = [];
            emit(result.error);
            return;
          }
          snapshots[index] = result.snapshot ?? [];
          emit();
        };
        const registerSourceWatch = async (): Promise<void> => {
          try {
            const subscription = await watchFederatedSource(
              source,
              scopedFilter,
              (quests, sourceError) => {
                const refreshGeneration = beginSourceRefresh(index);
                const action = refreshFederatedWatchResult(
                  scopedFilter,
                  source,
                  quests,
                  sourceError,
                ).then((result) => handleResult(result, refreshGeneration));
                track(action);
              },
              (snapshot, sourceError) => {
                const refreshGeneration = beginSourceRefresh(index);
                handleResult(
                  reactiveFederatedWatchResult(scopedFilter, source, snapshot, sourceError),
                  refreshGeneration,
                );
              },
            );
            if (!active) {
              await subscription.unsubscribe();
              return;
            }
            subscriptions.push(subscription);
          } catch (watchError: unknown) {
            if (!active) {
              return;
            }
            if (scopedFilter.repo !== undefined || !this.#allowPartialReads) {
              throw watchError;
            }
            const readError = federatedWatchReadError(scopedFilter, watchError);
            sourceErrors[index] = readError;
            snapshots[index] = [];
            emit(readError);
            const retryTimer = setTimeout(() => {
              watchRetryTimers.delete(index);
              track(registerSourceWatch());
            }, 1_000);
            retryTimer.unref?.();
            watchRetryTimers.set(index, retryTimer);
          }
        };
        await registerSourceWatch();
      }
      emit();
      registrationComplete = true;
      for (const applyResult of deferredWatchResults) {
        applyResult();
      }
    } catch (error: unknown) {
      active = false;
      clearWatchRetryTimers();
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer);
      }
      await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()));
      await waitForCallbacks();
      throw error;
    }
    return {
      unsubscribe: () => {
        if (unsubscribePromise !== undefined) {
          return unsubscribePromise;
        }
        active = false;
        clearWatchRetryTimers();
        if (refreshTimer !== undefined) {
          clearInterval(refreshTimer);
        }
        unsubscribePromise = (async () => {
          const results = await Promise.allSettled(
            subscriptions.map((subscription) => subscription.unsubscribe()),
          );
          await waitForCallbacks();
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure !== undefined) {
            throw failure.reason;
          }
        })();
        return unsubscribePromise;
      },
    };
  }
}

export class FederatedBlobStore implements BlobStore {
  readonly #sources: readonly FederatedStoreSource[];

  constructor(sources: readonly FederatedStoreSource[]) {
    this.#sources = [...sources];
  }

  put(_bytes: Uint8Array): Promise<Sha256> {
    return Promise.reject(readOnlyMutationError());
  }

  async #readSources(repository: string): Promise<
    readonly {
      readonly source: FederatedStoreSource;
      readonly fencedRepositories?: ReadonlySet<string>;
    }[]
  > {
    const sources = this.#sources.filter((source) => sourceRoutesRepository(source, repository));
    return Promise.all(
      sources.map(async (source) => {
        const initialError = source.readError?.(repository);
        if (initialError !== undefined) {
          throw initialError;
        }
        if (source.readSnapshot !== undefined) {
          try {
            const snapshot = await source.readSnapshot(repository);
            const readError = source.readError?.(repository);
            if (readError !== undefined) {
              throw readError;
            }
            return { source, fencedRepositories: new Set(snapshot.fencedRepositories) };
          } catch (error: unknown) {
            throw federatedWatchReadError({ repo: repository }, error);
          }
        }
        await source.refresh?.();
        const readError = source.readError?.(repository);
        if (readError !== undefined) {
          throw readError;
        }
        return { source };
      }),
    );
  }

  async get(sha256: Sha256, repository?: string): Promise<Uint8Array | null> {
    if (repository === undefined) {
      throw new FederatedReadError(
        "[FEDERATED_BLOB_REPOSITORY_REQUIRED] evidence retrieval needs a repository; rerun with --repo <name> or select a quest before materializing evidence",
      );
    }
    const sources = await this.#readSources(repository);
    for (const { source, fencedRepositories } of sources) {
      if (
        fencedRepositories?.has(repository) === true ||
        (fencedRepositories === undefined && !source.includeRepository(repository))
      ) {
        continue;
      }
      const bytes = await source.blobStore.get(sha256);
      if (bytes !== null) {
        return bytes;
      }
    }
    return null;
  }

  async has(sha256: Sha256, repository?: string): Promise<boolean> {
    if (repository === undefined) {
      throw new FederatedReadError(
        "[FEDERATED_BLOB_REPOSITORY_REQUIRED] evidence retrieval needs a repository; rerun with --repo <name> or select a quest before materializing evidence",
      );
    }
    const sources = await this.#readSources(repository);
    for (const { source, fencedRepositories } of sources) {
      if (
        fencedRepositories?.has(repository) === true ||
        (fencedRepositories === undefined && !source.includeRepository(repository))
      ) {
        continue;
      }
      if (await source.blobStore.has(sha256)) {
        return true;
      }
    }
    return false;
  }
}
