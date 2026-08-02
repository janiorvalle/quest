import type { Chain } from "../schema";

function requiresAdjacency(
  existingLinks: readonly Chain[],
): ReadonlyMap<number, readonly number[]> {
  const adjacency = new Map<number, number[]>();
  for (const link of existingLinks) {
    if (link.type !== "requires") {
      continue;
    }
    const targets = adjacency.get(link.quest_id) ?? [];
    if (!targets.includes(link.target_id)) {
      targets.push(link.target_id);
      targets.sort((left, right) => left - right);
      adjacency.set(link.quest_id, targets);
    }
  }
  return adjacency;
}

function reconstructPath(
  previous: ReadonlyMap<number, number | undefined>,
  start: number,
  goal: number,
): number[] | undefined {
  const path = [goal];
  let cursor = goal;
  while (cursor !== start) {
    const parent = previous.get(cursor);
    if (parent === undefined) {
      return undefined;
    }
    path.push(parent);
    cursor = parent;
  }
  path.reverse();
  return path;
}

function findRequiresPath(
  adjacency: ReadonlyMap<number, readonly number[]>,
  start: number,
  goal: number,
): number[] | undefined {
  const previous = new Map<number, number | undefined>([[start, undefined]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) {
      continue;
    }
    for (const target of adjacency.get(current) ?? []) {
      if (previous.has(target)) {
        continue;
      }
      previous.set(target, current);
      if (target === goal) {
        return reconstructPath(previous, start, goal);
      }
      queue.push(target);
    }
  }
  return undefined;
}

export function findChainCyclePath(
  existingLinks: readonly Chain[],
  proposedLink: Chain,
): number[] | undefined {
  if (proposedLink.type !== "requires") {
    return undefined;
  }
  if (proposedLink.quest_id === proposedLink.target_id) {
    return [proposedLink.quest_id, proposedLink.quest_id];
  }

  const path = findRequiresPath(
    requiresAdjacency(existingLinks),
    proposedLink.target_id,
    proposedLink.quest_id,
  );
  return path === undefined ? undefined : [proposedLink.quest_id, ...path];
}

export function wouldCreateChainCycle(
  existingLinks: readonly Chain[],
  proposedLink: Chain,
): boolean {
  return findChainCyclePath(existingLinks, proposedLink) !== undefined;
}
