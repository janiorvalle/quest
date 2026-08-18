import type { Chain, Quest } from "../schema";
import { isDispatchableQuest } from "./lifecycle";

export const planComputedStateValues = ["dispatchable", "blocked", "in_flight"] as const;
export type PlanComputedState = (typeof planComputedStateValues)[number];

export type PlanBlockerPath = readonly number[];

export interface PlanQuest extends Quest {
  readonly blockers: readonly number[];
  readonly blocker_paths: readonly PlanBlockerPath[];
  readonly chain_depth: number;
  readonly computed_state: PlanComputedState;
  readonly root_blockers: readonly number[];
}

export type PlanLaneClusterKind = "same_area" | "shared_files";

export interface PlanLaneCluster {
  readonly area: string | null;
  readonly files: readonly string[];
  readonly heuristic: boolean;
  readonly kind: PlanLaneClusterKind;
  readonly quest_ids: readonly number[];
}

export interface QuestPlanInput {
  readonly chains: readonly Chain[];
  readonly now: string;
  readonly quests: readonly Quest[];
}

export interface QuestPlan {
  readonly lane_clusters: readonly PlanLaneCluster[];
  readonly quests: readonly PlanQuest[];
}

export class PlanModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanModelError";
  }
}

interface BlockerDetails {
  readonly blocker_paths: readonly PlanBlockerPath[];
  readonly blockers: readonly number[];
  readonly chain_depth: number;
  readonly root_blockers: readonly number[];
}

function compareIds(left: number, right: number): number {
  return left - right;
}

function compareQuestIdentity(
  left: Pick<Quest, "id" | "repo">,
  right: Pick<Quest, "id" | "repo">,
): number {
  return left.id - right.id || left.repo.localeCompare(right.repo);
}

function isSatisfiedRequirement(quest: Quest): boolean {
  return quest.status === "complete" || quest.status === "dropped";
}

function isLiveInFlight(quest: Quest, now: number): boolean {
  return (
    quest.status === "accepted" &&
    quest.assignee !== null &&
    quest.lease_expires_at !== null &&
    Date.parse(quest.lease_expires_at) > now
  );
}

function incompleteRequirementIds(
  questId: number,
  requiresByQuest: ReadonlyMap<number, readonly number[]>,
  questsById: ReadonlyMap<number, Quest>,
): readonly number[] {
  return (requiresByQuest.get(questId) ?? []).filter((targetId) => {
    const target = questsById.get(targetId);
    if (target === undefined) {
      throw new PlanModelError(
        `[PLAN_MISSING_QUEST] requires link for quest ${questId} points to missing quest ${targetId}; repair the chain and retry`,
      );
    }
    return !isSatisfiedRequirement(target);
  });
}

function rootPathsFor(
  questId: number,
  requiresByQuest: ReadonlyMap<number, readonly number[]>,
  questsById: ReadonlyMap<number, Quest>,
  cache: Map<number, readonly PlanBlockerPath[]>,
  ancestors: ReadonlySet<number> = new Set(),
): readonly PlanBlockerPath[] {
  const cached = cache.get(questId);
  if (cached !== undefined) {
    return cached;
  }
  if (ancestors.has(questId)) {
    const cycle = [...ancestors, questId].join(" -> ");
    throw new PlanModelError(
      `[PLAN_REQUIRES_CYCLE] requires chain contains a cycle (${cycle}); remove the cycle and retry`,
    );
  }
  const quest = questsById.get(questId);
  if (quest === undefined) {
    throw new PlanModelError(
      `[PLAN_MISSING_QUEST] requires link points to missing quest ${questId}; repair the chain and retry`,
    );
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(questId);
  const blockers = incompleteRequirementIds(questId, requiresByQuest, questsById);
  const paths =
    blockers.length === 0
      ? [[questId]]
      : blockers.flatMap((blockerId) =>
          rootPathsFor(blockerId, requiresByQuest, questsById, cache, nextAncestors).map((path) => [
            questId,
            ...path,
          ]),
        );
  const uniquePaths = new Map(paths.map((path) => [path.join("/"), path]));
  const result = [...uniquePaths.values()].sort((left, right) => {
    const leftKey = left.join("/");
    const rightKey = right.join("/");
    return leftKey.localeCompare(rightKey, "en", { numeric: true });
  });
  cache.set(questId, result);
  return result;
}

function blockerDetails(
  quest: Quest,
  requiresByQuest: ReadonlyMap<number, readonly number[]>,
  questsById: ReadonlyMap<number, Quest>,
  cache: Map<number, readonly PlanBlockerPath[]>,
): BlockerDetails {
  const blockers = incompleteRequirementIds(quest.id, requiresByQuest, questsById);
  const blocker_paths = blockers.flatMap((blockerId) =>
    rootPathsFor(blockerId, requiresByQuest, questsById, cache).map((path) => [quest.id, ...path]),
  );
  const root_blockers = [
    ...new Set(
      blocker_paths.flatMap((path) => {
        const root = path[path.length - 1];
        return root === undefined ? [] : [root];
      }),
    ),
  ].sort(compareIds);
  const chain_depth = blocker_paths.reduce((depth, path) => Math.max(depth, path.length - 1), 0);
  return { blocker_paths, blockers, chain_depth, root_blockers };
}

function comparePlanQuests(left: PlanQuest, right: PlanQuest): number {
  const stateOrder: Record<PlanComputedState, number> = {
    in_flight: 0,
    dispatchable: 1,
    blocked: 2,
  };
  const stateDifference = stateOrder[left.computed_state] - stateOrder[right.computed_state];
  if (stateDifference !== 0) {
    return stateDifference;
  }
  if (left.computed_state === "blocked" && right.computed_state === "blocked") {
    const depthDifference = left.chain_depth - right.chain_depth;
    if (depthDifference !== 0) {
      return depthDifference;
    }
  }
  const priorityDifference = left.priority - right.priority;
  if (priorityDifference !== 0) {
    return priorityDifference;
  }
  const ageDifference = Date.parse(left.created_at) - Date.parse(right.created_at);
  return ageDifference || compareQuestIdentity(left, right);
}

function compareClusters(left: PlanLaneCluster, right: PlanLaneCluster): number {
  const [leftFirst = 0, leftSecond = 0] = left.quest_ids;
  const [rightFirst = 0, rightSecond = 0] = right.quest_ids;
  return (
    leftFirst - rightFirst ||
    leftSecond - rightSecond ||
    left.kind.localeCompare(right.kind) ||
    left.files.join("\0").localeCompare(right.files.join("\0"))
  );
}

const MAX_EXHAUSTIVE_SAME_AREA_BUCKET_SIZE = 64;

function laneClusterForPair(left: PlanQuest, right: PlanQuest): PlanLaneCluster | null {
  if (left.repo !== right.repo) {
    return null;
  }
  const leftFiles = new Set(left.predicted_files);
  const rightFiles = new Set(right.predicted_files);
  const files = [...leftFiles].filter((file) => rightFiles.has(file)).sort();
  if (files.length > 0) {
    return {
      area: null,
      files,
      heuristic: false,
      kind: "shared_files",
      quest_ids: [left.id, right.id],
    };
  }
  if (
    left.predicted_files.length === 0 &&
    right.predicted_files.length === 0 &&
    left.area !== null &&
    left.area === right.area
  ) {
    return {
      area: left.area,
      files: [],
      heuristic: true,
      kind: "same_area",
      quest_ids: [left.id, right.id],
    };
  }
  return null;
}

function pairKey(left: PlanQuest, right: PlanQuest): string {
  return `${left.repo}\0${left.id}\0${right.id}`;
}

function pairwiseClusters(quests: readonly PlanQuest[]): PlanLaneCluster[] {
  const byIdentity = [...quests].sort(compareQuestIdentity);
  const clusters: PlanLaneCluster[] = [];
  for (const [leftIndex, left] of byIdentity.entries()) {
    for (const right of byIdentity.slice(leftIndex + 1)) {
      const cluster = laneClusterForPair(left, right);
      if (cluster !== null) {
        clusters.push(cluster);
      }
    }
  }
  return clusters;
}

interface SharedFilePair {
  readonly files: Set<string>;
  readonly left: PlanQuest;
  readonly right: PlanQuest;
}

function sharedFileClusters(quests: readonly PlanQuest[]): PlanLaneCluster[] {
  const questsByFile = new Map<string, PlanQuest[]>();
  for (const quest of quests) {
    for (const file of new Set(quest.predicted_files)) {
      const bucket = questsByFile.get(`${quest.repo}\0${file}`) ?? [];
      bucket.push(quest);
      questsByFile.set(`${quest.repo}\0${file}`, bucket);
    }
  }

  const pairs = new Map<string, SharedFilePair>();
  for (const [bucketKey, bucket] of questsByFile) {
    const separator = bucketKey.indexOf("\0");
    const file = bucketKey.slice(separator + 1);
    const byIdentity = [...bucket].sort(compareQuestIdentity);
    for (const [leftIndex, left] of byIdentity.entries()) {
      for (const right of byIdentity.slice(leftIndex + 1)) {
        const key = pairKey(left, right);
        const existing = pairs.get(key);
        if (existing === undefined) {
          pairs.set(key, { files: new Set([file]), left, right });
        } else {
          existing.files.add(file);
        }
      }
    }
  }

  return [...pairs.values()].map(({ files, left, right }) => ({
    area: null,
    files: [...files].sort(),
    heuristic: false,
    kind: "shared_files",
    quest_ids: [left.id, right.id],
  }));
}

function questsBySameArea(quests: readonly PlanQuest[]): Map<string, PlanQuest[]> {
  const questsByArea = new Map<string, PlanQuest[]>();
  for (const quest of quests) {
    if (quest.predicted_files.length > 0 || quest.area === null) {
      continue;
    }
    const key = `${quest.repo}\0${quest.area}`;
    const bucket = questsByArea.get(key) ?? [];
    bucket.push(quest);
    questsByArea.set(key, bucket);
  }
  return questsByArea;
}

function boundedSameAreaClusters(quests: readonly PlanQuest[]): PlanLaneCluster[] {
  // Same-area lanes are heuristic. A deterministic star keeps every quest visible to the lane
  // consumers while preventing a dense area from producing quadratic output. Shared-file lanes
  // remain exhaustive because they are hard conflicts.
  const center = quests.find((quest) => quest.computed_state === "in_flight") ?? quests[0];
  if (center === undefined) {
    return [];
  }
  return quests.flatMap((quest) => {
    if (quest === center) {
      return [];
    }
    const cluster = laneClusterForPair(center, quest);
    return cluster === null ? [] : [cluster];
  });
}

function sameAreaClusters(quests: readonly PlanQuest[]): PlanLaneCluster[] {
  const clusters: PlanLaneCluster[] = [];
  for (const bucket of questsBySameArea(quests).values()) {
    const byIdentity = [...bucket].sort(compareQuestIdentity);
    clusters.push(
      ...(byIdentity.length <= MAX_EXHAUSTIVE_SAME_AREA_BUCKET_SIZE
        ? pairwiseClusters(byIdentity)
        : boundedSameAreaClusters(byIdentity)),
    );
  }
  return clusters;
}

function laneClusters(quests: readonly PlanQuest[]): readonly PlanLaneCluster[] {
  return [...sharedFileClusters(quests), ...sameAreaClusters(quests)].sort(compareClusters);
}

export function computeQuestPlan(input: QuestPlanInput): QuestPlan {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) {
    throw new PlanModelError(
      `[PLAN_INVALID_TIME] now must be an ISO timestamp; received ${input.now}`,
    );
  }

  const questsById = new Map(input.quests.map((quest) => [quest.id, quest]));
  const requiresByQuest = new Map<number, number[]>();
  for (const chain of input.chains) {
    if (chain.type !== "requires") {
      continue;
    }
    const targets = requiresByQuest.get(chain.quest_id) ?? [];
    targets.push(chain.target_id);
    requiresByQuest.set(chain.quest_id, targets);
  }
  for (const [questId, targets] of requiresByQuest) {
    requiresByQuest.set(questId, [...new Set(targets)].sort(compareIds));
  }

  const rootPathCache = new Map<number, readonly PlanBlockerPath[]>();
  const planQuests = input.quests.flatMap((quest): PlanQuest[] => {
    const inFlight = isLiveInFlight(quest, now);
    if (!inFlight && !isDispatchableQuest(quest)) {
      return [];
    }
    const details = blockerDetails(quest, requiresByQuest, questsById, rootPathCache);
    return [
      {
        ...quest,
        ...details,
        computed_state: inFlight
          ? "in_flight"
          : details.blockers.length === 0
            ? "dispatchable"
            : "blocked",
      },
    ];
  });

  const quests = planQuests.sort(comparePlanQuests);
  return {
    lane_clusters: laneClusters(quests),
    quests,
  };
}
