import type {
  AcceptQuestInput,
  Chain,
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
  RepoStats,
  Sha256,
  TouchQuestInput,
} from "../schema";
import {
  eventRepository,
  questDumpSchema,
  questStatusSchema,
  STORE_SCHEMA_VERSION,
  verdictSchema,
} from "../schema";
import type { BlobStore, QuestStore, QuestWatchListener, WatchSubscription } from "./port";

export interface FederatedStoreSource {
  readonly blobStore: BlobStore;
  readonly includeRepository: (repo: string) => boolean;
  readonly questStore: QuestStore;
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

function filterQuests(
  quests: readonly Quest[],
  source: FederatedStoreSource,
  scope: QuestScope | undefined = undefined,
): Quest[] {
  return quests
    .filter((quest) => source.includeRepository(quest.repo))
    .filter((quest) => scope === undefined || scope.repo === null || quest.repo === scope.repo);
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
}

async function matchingQuestSources(
  sources: readonly FederatedStoreSource[],
  id: number,
): Promise<readonly FederatedQuestMatch[]> {
  const matches = await Promise.all(
    sources.map(async (source) => {
      const quest = await source.questStore.getQuest(id);
      return quest !== null && source.includeRepository(quest.repo) ? { quest, source } : null;
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

  constructor(sources: readonly FederatedStoreSource[]) {
    this.#sources = [...sources];
  }

  addQuest(_input: NewQuest): Promise<Quest> {
    return Promise.reject(readOnlyMutationError());
  }

  acceptQuest(_input: AcceptQuestInput): ReturnType<QuestStore["acceptQuest"]> {
    return Promise.reject(readOnlyMutationError());
  }

  acceptQuestAndExport(_input: AcceptQuestInput): ReturnType<QuestStore["acceptQuestAndExport"]> {
    return Promise.reject(readOnlyMutationError());
  }

  touchQuest(_input: TouchQuestInput): Promise<Quest> {
    return Promise.reject(readOnlyMutationError());
  }

  transition(_id: number, _transition: QuestTransition): Promise<Quest> {
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

  async listQuests(filter: QuestFilter): Promise<Quest[]> {
    const results = await Promise.all(
      this.#sources.map(async (source) =>
        filterQuests(await source.questStore.listQuests(filter), source),
      ),
    );
    return mergeQuestSnapshots(results);
  }

  async getQuest(id: number): Promise<Quest | null> {
    const matches = await matchingQuestSources(this.#sources, id);
    requireUnambiguousQuest(matches, id);
    return matches[0]?.quest ?? null;
  }

  async stats(scope: QuestScope): Promise<QuestStats> {
    const stats = await Promise.all(
      this.#sources.map(async (source) => {
        const result = await source.questStore.stats({ repo: null });
        return result.repos.filter(
          (repo) =>
            source.includeRepository(repo.repo) &&
            (scope.repo === null || repo.repo === scope.repo),
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
    const matches = await matchingQuestSources(this.#sources, questId);
    requireUnambiguousQuest(matches, questId);
    const match = matches[0];
    return match === undefined
      ? []
      : (await match.source.questStore.events(questId))
          .map((event) => ({ ...event, repo: match.quest.repo }))
          .sort(compareEvents);
  }

  async queryEvents(filter: EventFilter): Promise<Event[]> {
    if (filter.after_id !== undefined) {
      throw federatedCursorError();
    }
    if (filter.quest_id !== undefined) {
      const matches = await matchingQuestSources(this.#sources, filter.quest_id);
      requireUnambiguousQuest(matches, filter.quest_id);
    }
    const events = await Promise.all(
      this.#sources.map(async (source) => {
        const result = await source.questStore.queryEvents(filter);
        const dump = await source.questStore.exportAll();
        const allowedQuests = filterQuests(dump.quests, source);
        const repositoriesById = new Map(allowedQuests.map((quest) => [quest.id, quest.repo]));
        return result.flatMap((event) => {
          const repo = repositoriesById.get(event.quest_id);
          return repo === undefined ? [] : [{ ...event, repo }];
        });
      }),
    );
    return events.flat().sort(compareEvents);
  }

  async exportAll(): Promise<QuestDump> {
    const dumps = await Promise.all(
      this.#sources.map(async (source) => ({
        dump: await source.questStore.exportAll(),
        source,
      })),
    );
    const quests: Quest[] = [];
    const evidence: Evidence[] = [];
    const chains: Chain[] = [];
    const events: Event[] = [];
    for (const { dump, source } of dumps) {
      const allowedQuests = filterQuests(dump.quests, source);
      const allowedQuestIds = new Set(allowedQuests.map((quest) => quest.id));
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
      chains: chains.sort(
        (left, right) =>
          left.quest_id - right.quest_id ||
          left.target_id - right.target_id ||
          left.type.localeCompare(right.type),
      ),
      events: events.sort(compareEvents),
    });
  }

  async watch(filter: QuestFilter, listener: QuestWatchListener): Promise<WatchSubscription> {
    const snapshots = await Promise.all(
      this.#sources.map(async (source) =>
        filterQuests(await source.questStore.listQuests(filter), source),
      ),
    );
    const subscriptions: WatchSubscription[] = [];
    try {
      for (const [index, source] of this.#sources.entries()) {
        subscriptions.push(
          await source.questStore.watch(filter, (quests) => {
            snapshots[index] = filterQuests(quests, source);
            listener(mergeQuestSnapshots(snapshots));
          }),
        );
      }
    } catch (error: unknown) {
      await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()));
      throw error;
    }
    listener(mergeQuestSnapshots(snapshots));
    return {
      unsubscribe: async () => {
        await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
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

  async get(sha256: Sha256, repository?: string): Promise<Uint8Array | null> {
    if (repository === undefined) {
      throw new FederatedReadError(
        "[FEDERATED_BLOB_REPOSITORY_REQUIRED] evidence retrieval needs a repository; rerun with --repo <name> or select a quest before materializing evidence",
      );
    }
    for (const source of this.#sources) {
      if (!source.includeRepository(repository)) {
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
    for (const source of this.#sources) {
      if (!source.includeRepository(repository)) {
        continue;
      }
      if (await source.blobStore.has(sha256)) {
        return true;
      }
    }
    return false;
  }
}
