import type { Chain, Quest, QuestScope } from "../schema";
import type { QuestStore } from "../store";
import { compileQuestBriefFromDump, type QuestBrief } from "./brief";
import {
  acceptLifecycleQuest,
  acceptLifecycleQuestWithSnapshot,
  LifecycleCommandError,
  questGuildMatches,
  type SessionAttribution,
} from "./lifecycle";

const IN_FLIGHT_STATUSES = new Set<Quest["status"]>(["accepted", "turned_in"]);

export type NextSelectionPolicy = (quests: readonly Quest[]) => Quest | null;

export interface NextBacklog {
  readonly chains: readonly Chain[];
  readonly quests: readonly Quest[];
}

export interface NextQuestResult {
  readonly brief?: QuestBrief | null;
  readonly claimed: boolean;
  readonly quest: Quest | null;
  readonly warnings: readonly string[];
}

export const strictPriorityThenAgePolicy: NextSelectionPolicy = (quests) => {
  let selected: Quest | null = null;
  for (const quest of quests) {
    if (selected === null) {
      selected = quest;
      continue;
    }
    const priorityOrder = quest.priority - selected.priority;
    const ageOrder = Date.parse(quest.created_at) - Date.parse(selected.created_at);
    if (
      priorityOrder < 0 ||
      (priorityOrder === 0 && (ageOrder < 0 || (ageOrder === 0 && quest.id < selected.id)))
    ) {
      selected = quest;
    }
  }
  return selected;
};

function isInScope(quest: Quest, scope: QuestScope): boolean {
  return scope.repo === null || quest.repo === scope.repo;
}

function incompleteRequirements(
  quest: Quest,
  chains: readonly Chain[],
  questsById: ReadonlyMap<number, Quest>,
): Quest[] {
  return chains
    .filter((chain) => chain.type === "requires" && chain.quest_id === quest.id)
    .flatMap((chain) => {
      const requirement = questsById.get(chain.target_id);
      return requirement === undefined || requirement.status === "complete" ? [] : [requirement];
    })
    .sort((left, right) => left.id - right.id);
}

function blockedWarning(quest: Quest, requirement: Quest): string {
  const ownership =
    requirement.assignee === null
      ? requirement.status
      : `${requirement.status} by ${requirement.assignee}`;
  return `quest ${quest.id} skipped: blocked by ${requirement.id} (${ownership})`;
}

function overlapWarnings(selected: Quest, quests: readonly Quest[], scope: QuestScope): string[] {
  const selectedFiles = new Set(selected.predicted_files);
  return quests
    .filter(
      (quest) =>
        quest.id !== selected.id && isInScope(quest, scope) && IN_FLIGHT_STATUSES.has(quest.status),
    )
    .sort((left, right) => left.id - right.id)
    .flatMap((quest) => {
      const overlap = [...new Set(quest.predicted_files.filter((file) => selectedFiles.has(file)))];
      return overlap.length === 0
        ? []
        : [
            `quest ${selected.id} predicted_files overlap with in-flight quest ${quest.id}: ${overlap.join(", ")}`,
          ];
    });
}

export function selectNextQuest(
  backlog: NextBacklog,
  scope: QuestScope,
  policy: NextSelectionPolicy = strictPriorityThenAgePolicy,
  sessionGuild: string | null = null,
  skipAfterReopens: number | undefined = undefined,
): NextQuestResult {
  const questsById = new Map(backlog.quests.map((quest) => [quest.id, quest]));
  const eligible: Quest[] = [];
  const warnings: string[] = [];

  for (const quest of backlog.quests) {
    if (
      !isInScope(quest, scope) ||
      !questGuildMatches(quest, sessionGuild) ||
      quest.status !== "ready" ||
      quest.assignee !== null
    ) {
      continue;
    }
    if (skipAfterReopens !== undefined && quest.reopen_count >= skipAfterReopens) {
      warnings.push(
        `quest ${quest.id} skipped: reopened ${quest.reopen_count} times; human review required`,
      );
      continue;
    }
    const requirements = incompleteRequirements(quest, backlog.chains, questsById);
    if (requirements.length > 0) {
      warnings.push(...requirements.map((requirement) => blockedWarning(quest, requirement)));
      continue;
    }
    eligible.push(quest);
  }

  const quest = policy(eligible);
  return {
    claimed: false,
    quest,
    warnings:
      quest === null ? warnings : warnings.concat(overlapWarnings(quest, backlog.quests, scope)),
  };
}

export async function getNextQuest(
  store: QuestStore,
  scope: QuestScope,
  owner: string | null,
  policy: NextSelectionPolicy = strictPriorityThenAgePolicy,
  sessionGuild: string | null = null,
  skipAfterReopens: number | undefined = undefined,
  includeBrief = false,
  sessionAttribution: SessionAttribution = {},
): Promise<NextQuestResult> {
  const dump = await store.exportAll();
  const selection = selectNextQuest(
    { chains: dump.chains, quests: dump.quests },
    scope,
    policy,
    sessionGuild,
    skipAfterReopens,
  );
  if (selection.quest === null || owner === null) {
    return includeBrief ? { ...selection, brief: null } : selection;
  }

  const accepted = await (includeBrief ? acceptLifecycleQuestWithSnapshot : acceptLifecycleQuest)(
    store,
    scope,
    selection.quest.id,
    owner,
    { sessionAttribution, sessionGuild },
  );
  const result = {
    claimed: accepted.changed,
    quest: accepted.quest,
    warnings: selection.warnings.concat(accepted.warnings),
  };
  if (!includeBrief) {
    return result;
  }
  if (!accepted.changed) {
    return { ...result, brief: null };
  }
  if (accepted.snapshot === undefined) {
    throw new LifecycleCommandError(
      `quest ${accepted.quest.id} was accepted without a transaction snapshot; retry the claim with a store that supports atomic briefing`,
    );
  }
  return {
    ...result,
    brief: compileQuestBriefFromDump(accepted.snapshot, scope, accepted.quest.id),
  };
}
