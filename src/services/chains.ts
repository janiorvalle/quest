import type { Chain, ChainType, Quest, QuestScope } from "../schema";
import type { QuestStore } from "../store";

export interface ChainMutationResult {
  readonly changed: boolean;
  readonly link: Chain;
  readonly outcome: "added" | "exists" | "missing" | "removed";
  readonly warnings: readonly string[];
}

export interface ChainTreeLine {
  readonly blocked: boolean;
  readonly cycle: boolean;
  readonly depth: number;
  readonly link_type: ChainType | null;
  readonly quest: Quest;
}

export interface ChainTree {
  readonly lines: readonly ChainTreeLine[];
  readonly root_id: number;
}

export interface ChainTreeResult {
  readonly trees: readonly ChainTree[];
}

export class ChainCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainCommandError";
  }
}

function inScope(quest: Quest, scope: QuestScope): boolean {
  return scope.repo === null || quest.repo === scope.repo;
}

async function requireScopedQuest(
  store: QuestStore,
  id: number,
  scope: QuestScope,
): Promise<Quest> {
  const quest = await store.getQuest(id);
  if (quest === null || !inScope(quest, scope)) {
    throw new ChainCommandError(`quest ${id} not found in the selected scope`);
  }
  return quest;
}

async function requireScopedLinkQuests(
  store: QuestStore,
  link: Chain,
  scope: QuestScope,
): Promise<void> {
  await requireScopedQuest(store, link.quest_id, scope);
  await requireScopedQuest(store, link.target_id, scope);
}

export async function addQuestChain(
  store: QuestStore,
  scope: QuestScope,
  link: Chain,
  actor: string,
  sessionGuild: string | null = null,
): Promise<ChainMutationResult> {
  await requireScopedLinkQuests(store, link, scope);
  const result = await store.addChainLink({ actor, link, session_guild: sessionGuild });
  switch (result.outcome) {
    case "added":
      return {
        changed: true,
        link: result.link,
        outcome: result.outcome,
        warnings: [],
      };
    case "exists":
      return {
        changed: false,
        link: result.link,
        outcome: result.outcome,
        warnings: [
          `quest ${link.quest_id} already has ${link.type} link to quest ${link.target_id}`,
        ],
      };
    case "cycle":
      throw new ChainCommandError(`requires cycle rejected: ${result.path.join(" -> ")}`);
  }
}

export async function removeQuestChain(
  store: QuestStore,
  scope: QuestScope,
  link: Chain,
  actor: string,
  sessionGuild: string | null = null,
): Promise<ChainMutationResult> {
  await requireScopedLinkQuests(store, link, scope);
  const result = await store.removeChainLink({ actor, link, session_guild: sessionGuild });
  if (result.outcome === "removed") {
    return {
      changed: true,
      link: result.link,
      outcome: result.outcome,
      warnings: [],
    };
  }
  return {
    changed: false,
    link: result.link,
    outcome: result.outcome,
    warnings: [`quest ${link.quest_id} has no ${link.type} link to quest ${link.target_id}`],
  };
}

function chainTypeOrder(type: ChainType): number {
  return type === "requires" ? 0 : 1;
}

function isQuestBlocked(
  questId: number,
  allLinks: readonly Chain[],
  questById: ReadonlyMap<number, Quest>,
): boolean {
  return allLinks.some(
    (link) =>
      link.quest_id === questId &&
      link.type === "requires" &&
      questById.get(link.target_id)?.status !== "complete",
  );
}

function walkTree(
  rootId: number,
  scopedLinks: readonly Chain[],
  allLinks: readonly Chain[],
  questById: ReadonlyMap<number, Quest>,
): ChainTree {
  const lines: ChainTreeLine[] = [];

  const visit = (
    questId: number,
    depth: number,
    linkType: ChainType | null,
    ancestors: ReadonlySet<number>,
  ): void => {
    const quest = questById.get(questId);
    if (quest === undefined) {
      return;
    }
    const cycle = ancestors.has(questId);
    lines.push({
      blocked: isQuestBlocked(questId, allLinks, questById),
      cycle,
      depth,
      link_type: linkType,
      quest,
    });
    if (cycle) {
      return;
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(questId);
    for (const link of scopedLinks) {
      if (link.quest_id === questId) {
        visit(link.target_id, depth + 1, link.type, nextAncestors);
      }
    }
  };

  visit(rootId, 0, null, new Set());
  return { lines, root_id: rootId };
}

export async function showQuestChains(
  store: QuestStore,
  scope: QuestScope,
  id?: number,
): Promise<ChainTreeResult> {
  if (id !== undefined) {
    await requireScopedQuest(store, id, scope);
  }

  const dump = await store.exportAll();
  const questById = new Map(dump.quests.map((quest) => [quest.id, quest]));
  const scopedQuestIds = new Set(
    dump.quests.filter((quest) => inScope(quest, scope)).map((quest) => quest.id),
  );
  const scopedLinks = dump.chains
    .filter((link) => scopedQuestIds.has(link.quest_id) && scopedQuestIds.has(link.target_id))
    .sort(
      (left, right) =>
        left.quest_id - right.quest_id ||
        chainTypeOrder(left.type) - chainTypeOrder(right.type) ||
        left.target_id - right.target_id,
    );

  if (id !== undefined) {
    return { trees: [walkTree(id, scopedLinks, dump.chains, questById)] };
  }

  const sourceIds = new Set(scopedLinks.map((link) => link.quest_id));
  const targetIds = new Set(scopedLinks.map((link) => link.target_id));
  const rootIds = [...sourceIds]
    .filter((questId) => !targetIds.has(questId))
    .sort((left, right) => left - right);
  const trees: ChainTree[] = [];
  const renderedIds = new Set<number>();
  const addTree = (rootId: number): void => {
    const tree = walkTree(rootId, scopedLinks, dump.chains, questById);
    trees.push(tree);
    for (const line of tree.lines) {
      renderedIds.add(line.quest.id);
    }
  };

  for (const rootId of rootIds) {
    addTree(rootId);
  }
  for (const sourceId of [...sourceIds].sort((left, right) => left - right)) {
    if (!renderedIds.has(sourceId)) {
      addTree(sourceId);
    }
  }
  return { trees };
}
