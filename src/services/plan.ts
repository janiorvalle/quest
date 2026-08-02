import { computeQuestPlan, type QuestPlan, type QuestPlanInput } from "../domain/plan";
import type { Quest, QuestDump, QuestScope } from "../schema";
import type { QuestStore } from "../store";

function isInScope(quest: Quest, scope: QuestScope): boolean {
  return scope.repo === null || quest.repo === scope.repo;
}

function requiresByQuest(chains: QuestDump["chains"]): ReadonlyMap<number, readonly number[]> {
  const requirements = new Map<number, number[]>();
  for (const chain of chains) {
    if (chain.type !== "requires") {
      continue;
    }
    const targets = requirements.get(chain.quest_id) ?? [];
    targets.push(chain.target_id);
    requirements.set(chain.quest_id, targets);
  }
  return requirements;
}

function requirementClosure(
  roots: readonly number[],
  requirements: ReadonlyMap<number, readonly number[]>,
  questsById: ReadonlyMap<number, Quest>,
): ReadonlySet<number> {
  const included = new Set(roots);
  const pending = [...roots];
  for (let index = 0; index < pending.length; index += 1) {
    const questId = pending[index];
    if (questId === undefined) {
      continue;
    }
    for (const targetId of requirements.get(questId) ?? []) {
      if (included.has(targetId)) {
        continue;
      }
      included.add(targetId);
      if (questsById.has(targetId)) {
        pending.push(targetId);
      }
    }
  }
  return included;
}

function scopedPlanInput(dump: QuestDump, scope: QuestScope, now: string): QuestPlanInput {
  const questsById = new Map(dump.quests.map((quest) => [quest.id, quest]));
  const requirements = requiresByQuest(dump.chains);
  const scopedQuestIds = dump.quests
    .filter((quest) => isInScope(quest, scope))
    .map((quest) => quest.id);
  const includedQuestIds = requirementClosure(scopedQuestIds, requirements, questsById);

  return {
    chains: dump.chains.filter(
      (chain) => chain.type === "requires" && includedQuestIds.has(chain.quest_id),
    ),
    now,
    quests: dump.quests.filter((quest) => includedQuestIds.has(quest.id)),
  };
}

export interface QuestPlanSnapshot {
  readonly has_requirements: boolean;
  readonly plan: QuestPlan;
}

export async function getQuestPlanSnapshot(
  store: QuestStore,
  scope: QuestScope,
  now: string,
): Promise<QuestPlanSnapshot> {
  const dump = await store.exportAll();
  const input = scopedPlanInput(dump, scope, now);
  const scopedQuestIds = new Set(
    input.quests.filter((quest) => isInScope(quest, scope)).map((quest) => quest.id),
  );
  const plan = computeQuestPlan(input);
  return {
    has_requirements: input.chains.length > 0,
    plan: {
      lane_clusters: plan.lane_clusters.filter((cluster) =>
        cluster.quest_ids.every((questId) => scopedQuestIds.has(questId)),
      ),
      quests: plan.quests.filter((quest) => isInScope(quest, scope)),
    },
  };
}

export async function getQuestPlan(
  store: QuestStore,
  scope: QuestScope,
  now: string,
): Promise<QuestPlan> {
  return (await getQuestPlanSnapshot(store, scope, now)).plan;
}
