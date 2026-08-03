import { computeQuestPlan, isDispatchableQuest, type PlanLaneCluster } from "../domain";
import type { Chain, LaneConflictReference, Quest, QuestScope } from "../schema";
import type { QuestStore } from "../store";
import { compileQuestBriefFromDump, type QuestBrief } from "./brief";
import {
  acceptLifecycleQuest,
  acceptLifecycleQuestWithSnapshot,
  LaneConflictCommandError,
  LifecycleCommandError,
  questGuildMatches,
  type SessionAttribution,
} from "./lifecycle";

export type NextSelectionPolicy = (quests: readonly Quest[]) => Quest | null;

export interface NextBacklog {
  readonly chains: readonly Chain[];
  readonly quests: readonly Quest[];
}

export interface NextQuestResult {
  readonly brief?: QuestBrief | null;
  readonly claimed: boolean;
  readonly laneConflicts: readonly NextLaneConflict[];
  readonly quest: Quest | null;
  readonly warnings: readonly string[];
}

export interface NextLaneConflict {
  readonly area: string | null;
  readonly files: readonly string[];
  readonly heuristic: boolean;
  readonly inFlightQuestId: number;
  readonly kind: PlanLaneCluster["kind"];
  readonly questId: number;
}

export interface NextQuestOptions {
  readonly allowConflict?: boolean;
  readonly leaseTtlMinutes?: number;
  readonly now?: string;
  readonly resolveLaneConflict?: (conflicts: readonly NextLaneConflict[]) => Promise<boolean>;
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

function blockedWarning(quest: Quest, requirement: Quest): string {
  const ownership =
    requirement.assignee === null
      ? requirement.status
      : `${requirement.status} by ${requirement.assignee}`;
  return `quest ${quest.id} skipped: blocked by ${requirement.id} (${ownership})`;
}

function nextCandidate(
  quest: Quest,
  scope: QuestScope,
  sessionGuild: string | null,
  skipAfterReopens: number | undefined,
  planQuestsById: ReadonlyMap<number, ReturnType<typeof computeQuestPlan>["quests"][number]>,
  questsById: ReadonlyMap<number, Quest>,
): { readonly quest: Quest | null; readonly warnings: readonly string[] } {
  if (
    !isInScope(quest, scope) ||
    !questGuildMatches(quest, sessionGuild) ||
    !isDispatchableQuest(quest) ||
    quest.assignee !== null
  ) {
    return { quest: null, warnings: [] };
  }
  if (skipAfterReopens !== undefined && quest.reopen_count >= skipAfterReopens) {
    return {
      quest: null,
      warnings: [
        `quest ${quest.id} skipped: reopened ${quest.reopen_count} times; human review required`,
      ],
    };
  }
  const plannedQuest = planQuestsById.get(quest.id);
  if (plannedQuest?.computed_state === "dispatchable") {
    return { quest, warnings: [] };
  }
  return {
    quest: null,
    warnings:
      plannedQuest?.computed_state === "blocked"
        ? plannedQuest.blockers.flatMap((blockerId) => {
            const requirement = questsById.get(blockerId);
            return requirement === undefined ? [] : [blockedWarning(quest, requirement)];
          })
        : [],
  };
}

function laneConflictsForQuest(
  questId: number,
  plan: ReturnType<typeof computeQuestPlan>,
  scope: QuestScope,
): NextLaneConflict[] {
  const planQuestsById = new Map(plan.quests.map((quest) => [quest.id, quest]));
  const selectedQuest = planQuestsById.get(questId);
  if (selectedQuest === undefined) {
    return [];
  }
  const inFlightQuestIds = new Set(
    plan.quests
      .filter(
        (quest) =>
          quest.computed_state === "in_flight" &&
          quest.repo === selectedQuest.repo &&
          isInScope(quest, scope),
      )
      .map((quest) => quest.id),
  );
  return plan.lane_clusters
    .flatMap((cluster): NextLaneConflict[] => {
      if (!cluster.quest_ids.includes(questId)) {
        return [];
      }
      return cluster.quest_ids
        .filter((candidateId) => candidateId !== questId && inFlightQuestIds.has(candidateId))
        .flatMap((inFlightQuestId): NextLaneConflict[] => {
          const inFlightQuest = planQuestsById.get(inFlightQuestId);
          return inFlightQuest === undefined ||
            inFlightQuest.repo !== selectedQuest.repo ||
            !isInScope(inFlightQuest, scope)
            ? []
            : [
                {
                  area: cluster.area,
                  files: cluster.files,
                  heuristic: cluster.heuristic,
                  inFlightQuestId,
                  kind: cluster.kind,
                  questId,
                },
              ];
        });
    })
    .sort(
      (left, right) =>
        left.inFlightQuestId - right.inFlightQuestId ||
        left.kind.localeCompare(right.kind) ||
        left.files.join("\0").localeCompare(right.files.join("\0")),
    );
}

function laneConflictWarning(conflict: NextLaneConflict): string {
  if (conflict.kind === "shared_files") {
    return `quest ${conflict.questId} predicted_files overlap with in-flight quest ${conflict.inFlightQuestId}: ${conflict.files.join(", ")}`;
  }
  return `quest ${conflict.questId} shares area ${conflict.area ?? "<none>"} with in-flight quest ${conflict.inFlightQuestId} (heuristic)`;
}

function laneConflictRefusal(conflicts: readonly NextLaneConflict[]): LifecycleCommandError {
  const details = conflicts.map(laneConflictWarning).join("; ");
  return new LifecycleCommandError(
    `NEXT_LANE_CONFLICT: ${details}; no claim was made; pick another quest, or re-run with --allow-conflict`,
  );
}

async function acknowledgeLaneConflicts(
  options: NextQuestOptions,
  conflicts: readonly NextLaneConflict[],
): Promise<boolean> {
  if (conflicts.length === 0) {
    return false;
  }
  if (options.allowConflict === true) {
    return true;
  }
  return options.resolveLaneConflict === undefined ? false : options.resolveLaneConflict(conflicts);
}

function laneConflictReferences(conflicts: readonly NextLaneConflict[]): LaneConflictReference[] {
  return conflicts
    .filter((conflict) => !conflict.heuristic)
    .map((conflict) => ({ files: [...conflict.files], quest_id: conflict.inFlightQuestId }));
}

function concurrentLaneConflicts(
  questId: number,
  error: LaneConflictCommandError,
): NextLaneConflict[] {
  return error.conflicts.map((conflict) => ({
    area: null,
    files: conflict.files,
    heuristic: false,
    inFlightQuestId: conflict.quest_id,
    kind: "shared_files",
    questId,
  }));
}

function mergeLaneConflicts(
  existing: readonly NextLaneConflict[],
  additions: readonly NextLaneConflict[],
): NextLaneConflict[] {
  return [...existing, ...additions].filter(
    (conflict, index, conflicts) =>
      conflicts.findIndex(
        (candidate) =>
          candidate.questId === conflict.questId &&
          candidate.inFlightQuestId === conflict.inFlightQuestId &&
          candidate.kind === conflict.kind &&
          candidate.files.join("\0") === conflict.files.join("\0"),
      ) === index,
  );
}

function sameLaneConflict(left: NextLaneConflict, right: NextLaneConflict): boolean {
  return (
    left.questId === right.questId &&
    left.inFlightQuestId === right.inFlightQuestId &&
    left.kind === right.kind &&
    left.files.join("\0") === right.files.join("\0")
  );
}

function appendUniqueWarnings(warnings: readonly string[], additions: readonly string[]): string[] {
  return [...warnings, ...additions.filter((warning) => !warnings.includes(warning))];
}

interface NextLaneAcceptanceState {
  acknowledged: readonly LaneConflictReference[];
  override: boolean;
}

type NextAcceptanceResult = Awaited<ReturnType<typeof acceptLifecycleQuest>>;

async function prepareLaneConflictRetry(
  options: NextQuestOptions,
  conflicts: readonly NextLaneConflict[],
  state: NextLaneAcceptanceState,
): Promise<boolean> {
  if (conflicts.length === 0) {
    state.acknowledged = [];
    state.override = false;
    return true;
  }
  if (!(await acknowledgeLaneConflicts(options, conflicts))) {
    return false;
  }
  if (options.allowConflict === true) {
    state.acknowledged = [];
    state.override = true;
  } else {
    state.acknowledged = laneConflictReferences(conflicts);
    state.override = false;
  }
  return true;
}

async function acceptWithLaneGuardRetry<T extends NextAcceptanceResult>(
  accept: () => Promise<T>,
  selectedQuestId: number,
  initialLaneConflicts: readonly NextLaneConflict[],
  options: NextQuestOptions,
  state: NextLaneAcceptanceState,
): Promise<{
  readonly accepted: T;
  readonly laneConflicts: NextLaneConflict[];
}> {
  let laneConflicts = [...initialLaneConflicts];
  while (true) {
    try {
      return { accepted: await accept(), laneConflicts };
    } catch (error: unknown) {
      if (!(error instanceof LaneConflictCommandError)) {
        throw error;
      }
      const concurrentConflicts = concurrentLaneConflicts(selectedQuestId, error);
      laneConflicts = mergeLaneConflicts(laneConflicts, concurrentConflicts);
      if (!(await prepareLaneConflictRetry(options, concurrentConflicts, state))) {
        throw laneConflictRefusal(concurrentConflicts);
      }
    }
  }
}

export function selectNextQuest(
  backlog: NextBacklog,
  scope: QuestScope,
  policy: NextSelectionPolicy = strictPriorityThenAgePolicy,
  sessionGuild: string | null = null,
  skipAfterReopens: number | undefined = undefined,
  now = new Date().toISOString(),
): NextQuestResult {
  const plan = computeQuestPlan({ chains: backlog.chains, now, quests: backlog.quests });
  const planQuestsById = new Map(plan.quests.map((quest) => [quest.id, quest]));
  const questsById = new Map(backlog.quests.map((quest) => [quest.id, quest]));
  const candidates = backlog.quests.map((quest) =>
    nextCandidate(quest, scope, sessionGuild, skipAfterReopens, planQuestsById, questsById),
  );
  const eligible = candidates.flatMap(({ quest }) => (quest === null ? [] : [quest]));
  const warnings = candidates.flatMap(({ warnings: candidateWarnings }) => candidateWarnings);

  const conflictsByQuestId = new Map(
    eligible.map((candidate) => [candidate.id, laneConflictsForQuest(candidate.id, plan, scope)]),
  );
  const conflictFree = eligible.filter(
    (candidate) =>
      !(conflictsByQuestId.get(candidate.id) ?? []).some((conflict) => !conflict.heuristic),
  );
  const quest = policy(conflictFree.length > 0 ? conflictFree : eligible);
  const laneConflicts = quest === null ? [] : (conflictsByQuestId.get(quest.id) ?? []);
  const laneWarnings =
    conflictFree.length === 0 || laneConflicts.some((conflict) => conflict.heuristic)
      ? laneConflicts.map(laneConflictWarning)
      : laneConflicts.filter((conflict) => conflict.heuristic).map(laneConflictWarning);
  return {
    claimed: false,
    laneConflicts,
    quest,
    warnings: warnings.concat(laneWarnings),
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
  options: NextQuestOptions = {},
): Promise<NextQuestResult> {
  const dump = await store.exportAll();
  const selection = selectNextQuest(
    { chains: dump.chains, quests: dump.quests },
    scope,
    policy,
    sessionGuild,
    skipAfterReopens,
    options.now,
  );
  if (selection.quest === null || owner === null) {
    return includeBrief ? { ...selection, brief: null } : selection;
  }
  const selectedQuest = selection.quest;

  const hardConflicts = selection.laneConflicts.filter((conflict) => !conflict.heuristic);
  const laneConflictApproved = await acknowledgeLaneConflicts(options, hardConflicts);
  if (hardConflicts.length > 0 && !laneConflictApproved) {
    throw laneConflictRefusal(hardConflicts);
  }
  const acceptanceState: NextLaneAcceptanceState = {
    acknowledged: options.allowConflict === true ? [] : laneConflictReferences(hardConflicts),
    override: options.allowConflict === true && hardConflicts.length > 0,
  };

  const accept = () =>
    (includeBrief ? acceptLifecycleQuestWithSnapshot : acceptLifecycleQuest)(
      store,
      scope,
      selectedQuest.id,
      owner,
      {
        laneConflictAcknowledged: acceptanceState.acknowledged,
        laneConflictGuard: true,
        laneConflictOverride: acceptanceState.override,
        ...(options.leaseTtlMinutes === undefined
          ? {}
          : { leaseTtlMinutes: options.leaseTtlMinutes }),
        sessionAttribution,
        sessionGuild,
      },
    );
  const { accepted, laneConflicts } = await acceptWithLaneGuardRetry(
    accept,
    selectedQuest.id,
    selection.laneConflicts,
    options,
    acceptanceState,
  );
  const concurrentWarnings = laneConflicts
    .filter(
      (conflict) =>
        !selection.laneConflicts.some((selectedConflict) =>
          sameLaneConflict(selectedConflict, conflict),
        ),
    )
    .map(laneConflictWarning);
  const result = {
    claimed: accepted.changed,
    laneConflicts,
    quest: accepted.quest,
    warnings: appendUniqueWarnings(
      selection.warnings.concat(accepted.warnings),
      concurrentWarnings,
    ),
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
