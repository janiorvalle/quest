import { computeQaQueue, type QaQueue, type QaSession, type QaShell } from "../domain/qa";
import {
  type Chain,
  type Event,
  type FederatedListDump,
  type Quest,
  type QuestScope,
  stableSerialize,
} from "../schema";
import type { QuestStore } from "../store";
import { readQuestListDump } from "../store/list-dump";
import { BATCH_HISTORY_MAX_QUEST_IDS, BatchHistoryUnavailableError } from "../store/port";

const QA_SNAPSHOT_ATTEMPTS = 3;

interface QaRead {
  readonly dump: FederatedListDump;
  readonly events: readonly Event[];
  readonly queue: QaQueue;
}

export async function getQaQueue(
  store: QuestStore,
  scope: QuestScope,
  shell: QaShell | undefined = undefined,
): Promise<QaQueue> {
  if (scope.repo !== null) {
    const scopedStore = store.forRepository?.(scope.repo) ?? store;
    return getRepositoryQaQueue(scopedStore, scope.repo, shell);
  }

  const repositories = (await store.stats({ repo: null })).repos.map(({ repo }) => repo);
  const queues = await Promise.all(
    repositories.map(async (repository) => {
      const scopedStore = store.forRepository?.(repository) ?? store;
      return getRepositoryQaQueue(scopedStore, repository, shell);
    }),
  );
  return mergeQaQueues(queues);
}

async function getRepositoryQaQueue(
  store: QuestStore,
  repository: string,
  shell: QaShell | undefined,
): Promise<QaQueue> {
  let previous = await readQaQueue(store, repository, shell);
  for (let attempt = 1; attempt < QA_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const current = await readQaQueue(store, repository, shell);
    if (sameQaSnapshot(previous, current)) {
      return current.queue;
    }
    previous = current;
  }
  throw new Error(
    "[QA_SNAPSHOT_CHANGED] the Quest store kept changing while qa read its completed candidates; retry `quest qa` after active writes settle",
  );
}

async function readQaQueue(
  store: QuestStore,
  repository: string,
  shell: QaShell | undefined,
): Promise<QaRead> {
  const dump = projectQaListDump(await readQuestListDump(store), repository);
  const completedQuests = dump.quests.filter((quest) => quest.status === "complete");
  const completedIds = completedQuests.map((quest) => quest.id);
  const events = await readCompletedQuestHistory(store, completedIds);
  const queue = computeQaQueue({
    chains: dump.chains,
    events,
    quests: dump.quests,
    repository,
    ...(shell === undefined ? {} : { shell }),
  });
  return { dump, events, queue };
}

function projectQaListDump(dump: FederatedListDump, repository: string): FederatedListDump {
  const repositoryQuests = dump.quests.filter((quest) => quest.repo === repository);
  const repositoryQuestIds = new Set(repositoryQuests.map(({ id }) => id));
  const repositoryChains = dump.chains.filter(
    (chain) => repositoryQuestIds.has(chain.quest_id) && repositoryQuestIds.has(chain.target_id),
  );
  const questIds = qaConnectedQuestIds(repositoryQuests, repositoryChains);
  return {
    ...dump,
    quests: repositoryQuests.filter((quest) => questIds.has(quest.id)),
    chains: repositoryChains.filter(
      (chain) => questIds.has(chain.quest_id) && questIds.has(chain.target_id),
    ),
  };
}

function qaConnectedQuestIds(quests: readonly Quest[], chains: readonly Chain[]): Set<number> {
  const connectedIds = new Set(
    quests.filter((quest) => quest.status === "complete").map(({ id }) => id),
  );
  const neighbors = new Map<number, Set<number>>();
  for (const chain of chains) {
    const sourceNeighbors = neighbors.get(chain.quest_id) ?? new Set<number>();
    const targetNeighbors = neighbors.get(chain.target_id) ?? new Set<number>();
    sourceNeighbors.add(chain.target_id);
    targetNeighbors.add(chain.quest_id);
    neighbors.set(chain.quest_id, sourceNeighbors);
    neighbors.set(chain.target_id, targetNeighbors);
  }
  const queue = [...connectedIds];
  for (const questId of queue) {
    for (const neighbor of neighbors.get(questId) ?? []) {
      if (!connectedIds.has(neighbor)) {
        connectedIds.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return connectedIds;
}

async function readCompletedQuestHistory(
  store: QuestStore,
  questIds: readonly number[],
): Promise<readonly Event[]> {
  const batches = Array.from(
    { length: Math.ceil(questIds.length / BATCH_HISTORY_MAX_QUEST_IDS) },
    (_, index) =>
      questIds.slice(
        index * BATCH_HISTORY_MAX_QUEST_IDS,
        (index + 1) * BATCH_HISTORY_MAX_QUEST_IDS,
      ),
  );
  const events = await Promise.all(batches.map((batch) => readHistoryBatch(store, batch)));
  return events.flat().sort((left, right) => left.id - right.id);
}

async function readHistoryBatch(store: QuestStore, questIds: readonly number[]): Promise<Event[]> {
  if (store.readBatchHistory !== undefined) {
    try {
      return await store.readBatchHistory(questIds);
    } catch (error: unknown) {
      if (!(error instanceof BatchHistoryUnavailableError)) {
        throw error;
      }
    }
  }
  return (await Promise.all(questIds.map((questId) => store.queryEvents({ quest_id: questId }))))
    .flat()
    .sort((left, right) => left.id - right.id);
}

function sameQaSnapshot(left: QaRead, right: QaRead): boolean {
  return qaSnapshotKey(left) === qaSnapshotKey(right);
}

function qaSnapshotKey(read: QaRead): string {
  return stableSerialize({
    chains: read.dump.chains,
    events: read.events,
    quests: read.dump.quests.map((quest) =>
      quest.status === "complete" ? quest : { id: quest.id },
    ),
  });
}

function mergeQaQueues(queues: readonly QaQueue[]): QaQueue {
  const sessions = queues
    .flatMap(({ sessions: queueSessions }) => queueSessions)
    .sort(
      (left, right) =>
        Date.parse(left.oldest_at) - Date.parse(right.oldest_at) ||
        (left.ids[0] ?? 0) - (right.ids[0] ?? 0) ||
        left.repo.localeCompare(right.repo),
    )
    .map((session, index): QaSession => ({ ...session, group: index + 1 }));
  const quests = queues.reduce((total, queue) => total + queue.summary.quests, 0);
  return {
    footer:
      queues[0]?.footer ??
      'Found a problem? use quest --repo <repo> reopen <id> --notes "<what failed>"',
    message: sessions.length === 0 ? "Nothing awaiting sign-off." : null,
    sessions,
    summary: { quests, sessions: sessions.length },
  };
}
