import type {
  Chain,
  Evidence,
  Quest,
  QuestDump,
  QuestFilter,
  QuestKind,
  QuestScope,
  QuestStats,
  QuestStatus,
} from "../schema";
import { questStatsSchema, questStatusSchema, verdictSchema } from "../schema";
import type { QuestDetailSnapshot, QuestStore } from "../store";

export interface ListQuestQuery {
  readonly area?: string | undefined;
  readonly assignee?: string | null | undefined;
  readonly blocked?: boolean | undefined;
  readonly kind?: QuestKind | undefined;
  readonly status?: QuestStatus | undefined;
}

export interface ChainQuestReference {
  readonly assignee: string | null;
  readonly id: number;
  readonly repo: string;
  readonly status: QuestStatus;
  readonly title: string;
}

export interface QuestChainPosition {
  readonly duplicate_of: readonly ChainQuestReference[];
  readonly duplicates: readonly ChainQuestReference[];
  readonly required_by: readonly ChainQuestReference[];
  readonly requires: readonly ChainQuestReference[];
}

export interface QuestDetail {
  readonly chain_position: QuestChainPosition;
  readonly evidence: readonly Evidence[];
  readonly quest: Quest;
}

export class QueryCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryCommandError";
  }
}

function scopedFilter(scope: QuestScope, query: ListQuestQuery): QuestFilter {
  return {
    ...(scope.repo === null ? {} : { repo: scope.repo }),
    ...(query.area === undefined ? {} : { area: query.area }),
    ...(query.assignee === undefined ? {} : { assignee: query.assignee }),
    ...(query.blocked === undefined ? {} : { blocked: query.blocked }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(query.status === undefined ? {} : { status: query.status }),
  };
}

export async function listQuestResults(
  store: QuestStore,
  scope: QuestScope,
  query: ListQuestQuery,
): Promise<Quest[]> {
  const quests = await store.listQuests(scopedFilter(scope, query));
  return quests.sort((left, right) => left.id - right.id);
}

function questReference(quest: Quest): ChainQuestReference {
  return {
    assignee: quest.assignee,
    id: quest.id,
    repo: quest.repo,
    status: quest.status,
    title: quest.title,
  };
}

function referencesFor(
  chains: readonly Chain[],
  questsById: ReadonlyMap<number, Quest>,
  predicate: (chain: Chain) => boolean,
  relatedId: (chain: Chain) => number,
): ChainQuestReference[] {
  const references: ChainQuestReference[] = [];
  for (const chain of chains) {
    if (!predicate(chain)) {
      continue;
    }
    const quest = questsById.get(relatedId(chain));
    if (quest === undefined) {
      throw new QueryCommandError(
        `quest ${relatedId(chain)} referenced by the chain graph does not exist`,
      );
    }
    references.push(questReference(quest));
  }
  return references.sort((left, right) => left.id - right.id);
}

function buildQuestDetail(
  quest: Quest,
  evidence: readonly Evidence[],
  chains: readonly Chain[],
  relatedQuests: readonly Quest[],
): QuestDetail {
  const questsById = new Map(
    [quest, ...relatedQuests].map((candidate) => [candidate.id, candidate]),
  );
  return {
    quest,
    evidence: [...evidence]
      .filter((item) => item.quest_id === quest.id)
      .sort((left, right) => left.id - right.id),
    chain_position: {
      requires: referencesFor(
        chains,
        questsById,
        (chain) => chain.quest_id === quest.id && chain.type === "requires",
        (chain) => chain.target_id,
      ),
      required_by: referencesFor(
        chains,
        questsById,
        (chain) => chain.target_id === quest.id && chain.type === "requires",
        (chain) => chain.quest_id,
      ),
      duplicate_of: referencesFor(
        chains,
        questsById,
        (chain) => chain.quest_id === quest.id && chain.type === "duplicate-of",
        (chain) => chain.target_id,
      ),
      duplicates: referencesFor(
        chains,
        questsById,
        (chain) => chain.target_id === quest.id && chain.type === "duplicate-of",
        (chain) => chain.quest_id,
      ),
    },
  };
}

export function showQuestDetailFromDump(
  dump: QuestDump,
  scope: QuestScope,
  id: number,
): QuestDetail {
  const matches = dump.quests.filter(
    (candidate) => candidate.id === id && (scope.repo === null || candidate.repo === scope.repo),
  );
  const quest = matches[0];
  if (quest === undefined) {
    throw new QueryCommandError(`quest ${id} does not exist in the selected scope`);
  }
  if (matches.length > 1) {
    throw new QueryCommandError(
      `quest ${id} exists in multiple backends; display IDs are per-store; rerun with --repo <name> to select one backend`,
    );
  }
  return buildQuestDetail(
    quest,
    dump.evidence,
    dump.chains,
    dump.quests.filter((candidate) => candidate.id !== quest.id),
  );
}

export function showQuestDetailFromSnapshot(
  snapshot: QuestDetailSnapshot,
  scope: QuestScope,
  id: number,
): QuestDetail {
  if (snapshot.quest.id !== id || (scope.repo !== null && snapshot.quest.repo !== scope.repo)) {
    throw new QueryCommandError(`quest ${id} does not exist in the selected scope`);
  }
  return buildQuestDetail(
    snapshot.quest,
    snapshot.evidence,
    snapshot.chains,
    snapshot.related_quests,
  );
}

export async function readScopedQuestDetailSnapshot(
  store: QuestStore,
  scope: QuestScope,
  id: number,
): Promise<QuestDetailSnapshot> {
  const quest = await store.getQuest(id);
  if (quest === null || (scope.repo !== null && quest.repo !== scope.repo)) {
    throw new QueryCommandError(`quest ${id} does not exist in the selected scope`);
  }
  return store.readQuestDetail(id);
}

export async function showQuestDetail(
  store: QuestStore,
  scope: QuestScope,
  id: number,
): Promise<QuestDetail> {
  return showQuestDetailFromSnapshot(
    await readScopedQuestDetailSnapshot(store, scope, id),
    scope,
    id,
  );
}

export async function questStats(store: QuestStore, scope: QuestScope): Promise<QuestStats> {
  const stats = await store.stats(scope);
  return questStatsSchema.parse({
    repos: stats.repos
      .map((repo) => ({
        ...repo,
        status_counts: Object.fromEntries(
          questStatusSchema.options.flatMap((status) => {
            const count = repo.status_counts[status];
            return count === undefined ? [] : [[status, count]];
          }),
        ),
        verdict_counts: Object.fromEntries(
          verdictSchema.options.flatMap((verdict) => {
            const count = repo.verdict_counts[verdict];
            return count === undefined ? [] : [[verdict, count]];
          }),
        ),
        assignee_load: Object.fromEntries(
          Object.entries(repo.assignee_load).sort(([left], [right]) => left.localeCompare(right)),
        ),
      }))
      .sort((left, right) => left.repo.localeCompare(right.repo)),
  });
}
