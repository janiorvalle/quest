import type { Chain, Event, Quest, QuestDump } from "../schema";
import { eventRepository } from "../schema";
import { isQuestSigned } from "./signoff";

export const qaGroupingReasonValues = ["chain", "shared_files", "area"] as const;
export type QaGroupingReason = (typeof qaGroupingReasonValues)[number];

export const qaShellValues = ["posix", "powershell", "cmd"] as const;
export type QaShell = (typeof qaShellValues)[number];

export interface QaQueueInput {
  readonly chains: readonly Chain[];
  readonly events: readonly Event[];
  readonly quests: readonly Quest[];
  readonly repository?: string | null;
  readonly shell?: QaShell;
}

export interface QaSession {
  readonly area: string | null;
  readonly files: readonly string[];
  readonly group: number;
  readonly ids: readonly number[];
  readonly oldest_at: string;
  readonly reason: QaGroupingReason;
  readonly repo: string;
  readonly signoff: string;
  readonly signoff_variants: readonly QaSignoffVariant[];
  readonly why: string;
}

export interface QaSignoffVariant {
  readonly command: string;
  readonly shell: QaShell;
}

export interface QaQueue {
  readonly footer: string;
  readonly message: string | null;
  readonly sessions: readonly QaSession[];
  readonly summary: {
    readonly quests: number;
    readonly sessions: number;
  };
}

interface PendingQuest {
  readonly completionAt: string;
  readonly files: readonly string[];
  readonly quest: Quest;
}

function shellQuote(value: string, shell: QaShell): string | undefined {
  switch (shell) {
    case "cmd":
      return hasUnrepresentableCmdCharacters(value) ? undefined : `"${value}"`;
    case "powershell":
      return `'${value.replaceAll("'", "''")}'`;
    case "posix":
      return `'${value.replaceAll("'", "'\\''")}'`;
  }
}

function hasUnrepresentableCmdCharacters(value: string): boolean {
  return (
    value.includes("%") ||
    value.includes("!") ||
    value.includes(String.fromCharCode(34)) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  );
}

function eventMatchesQuest(event: Event, quest: Quest): boolean {
  return (
    event.quest_id === quest.id &&
    (eventRepository(event) === undefined || eventRepository(event) === quest.repo)
  );
}

function eventDetailFiles(event: Event): readonly string[] {
  if (typeof event.detail !== "object" || event.detail === null || Array.isArray(event.detail)) {
    return [];
  }
  const detail = event.detail as Readonly<Record<string, unknown>>;
  return ["actual_files", "files_changed", "files"].flatMap((key) => {
    const value = detail[key];
    return Array.isArray(value)
      ? value.filter((file): file is string => typeof file === "string" && file.trim() !== "")
      : [];
  });
}

function questEvents(quest: Quest, events: readonly Event[]): readonly Event[] {
  return events
    .filter((event) => eventMatchesQuest(event, quest))
    .sort((left, right) => left.id - right.id);
}

function currentAttemptEvents(quest: Quest, events: readonly Event[]): readonly Event[] {
  const eventsForQuest = questEvents(quest, events);
  const latestReopen = eventsForQuest.findLast((event) => event.action === "reopen");
  const afterReopen =
    latestReopen === undefined
      ? eventsForQuest
      : eventsForQuest.filter((event) => event.id > latestReopen.id);
  const latestTurnIn = afterReopen.findLast((event) => event.action === "turnin");
  return latestTurnIn === undefined
    ? afterReopen
    : afterReopen.filter((event) => event.id >= latestTurnIn.id);
}

function completionAt(quest: Quest, events: readonly Event[]): string {
  const completed = questEvents(quest, events).filter((event) => event.action === "complete");
  return completed.at(-1)?.at ?? quest.updated_at;
}

function fileSignals(quest: Quest, events: readonly Event[]): readonly string[] {
  return [
    ...quest.predicted_files,
    ...currentAttemptEvents(quest, events).flatMap(eventDetailFiles),
  ]
    .filter((file, index, files) => files.indexOf(file) === index)
    .sort();
}

function pendingQuests(input: QaQueueInput): PendingQuest[] {
  return input.quests
    .filter(
      (quest) =>
        (input.repository === undefined ||
          input.repository === null ||
          quest.repo === input.repository) &&
        quest.status === "complete" &&
        !isQuestSigned(quest, questEvents(quest, input.events)),
    )
    .map((quest) => ({
      completionAt: completionAt(quest, input.events),
      files: fileSignals(quest, input.events),
      quest,
    }))
    .sort(
      (left, right) =>
        Date.parse(left.completionAt) - Date.parse(right.completionAt) ||
        left.quest.id - right.quest.id ||
        left.quest.repo.localeCompare(right.quest.repo),
    );
}

function connectedComponents(
  quests: readonly PendingQuest[],
  areConnected: (left: PendingQuest, right: PendingQuest) => boolean,
): PendingQuest[][] {
  const remaining = new Map(quests.map((candidate) => [candidate.quest.id, candidate]));
  const components: PendingQuest[][] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as PendingQuest;
    remaining.delete(first.quest.id);
    const component = [first];
    const queue = [first];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        continue;
      }
      for (const candidate of remaining.values()) {
        if (!areConnected(current, candidate)) {
          continue;
        }
        remaining.delete(candidate.quest.id);
        component.push(candidate);
        queue.push(candidate);
      }
    }
    components.push(component.sort(comparePendingQuests));
  }
  return components;
}

function comparePendingQuests(left: PendingQuest, right: PendingQuest): number {
  return (
    Date.parse(left.completionAt) - Date.parse(right.completionAt) ||
    left.quest.id - right.quest.id ||
    left.quest.repo.localeCompare(right.quest.repo)
  );
}

function sharedFiles(left: PendingQuest, right: PendingQuest): readonly string[] {
  const rightFiles = new Set(right.files);
  return left.files.filter((file) => rightFiles.has(file));
}

function groupArea(quests: readonly PendingQuest[]): string | null {
  const areas = [...new Set(quests.map(({ quest }) => quest.area))];
  return areas.length === 1 ? (areas[0] ?? null) : null;
}

function groupFiles(quests: readonly PendingQuest[]): readonly string[] {
  return [...new Set(quests.flatMap(({ files }) => files))].sort();
}

function sharedGroupFiles(quests: readonly PendingQuest[]): readonly string[] {
  const fileCounts = new Map<string, number>();
  for (const { files } of quests) {
    for (const file of files) {
      fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
    }
  }
  return [...fileCounts]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
}

function groupWhy(
  reason: QaGroupingReason,
  area: string | null,
  sharedFiles: readonly string[],
): string {
  switch (reason) {
    case "chain":
      return "chain-connected linked feature";
    case "shared_files":
      return `shared files: ${sharedFiles.join(", ")}`;
    case "area":
      return `same area: ${area ?? "<none>"}`;
  }
}

function chainNeighbors(
  questIds: ReadonlySet<number>,
  chains: readonly Chain[],
): Map<number, Set<number>> {
  const neighbors = new Map<number, Set<number>>();
  for (const chain of chains) {
    if (!questIds.has(chain.quest_id) || !questIds.has(chain.target_id)) {
      continue;
    }
    const left = neighbors.get(chain.quest_id) ?? new Set<number>();
    const right = neighbors.get(chain.target_id) ?? new Set<number>();
    left.add(chain.target_id);
    right.add(chain.quest_id);
    neighbors.set(chain.quest_id, left);
    neighbors.set(chain.target_id, right);
  }
  return neighbors;
}

function collectChainComponent(
  first: number,
  remaining: Set<number>,
  neighbors: ReadonlyMap<number, ReadonlySet<number>>,
): number[] {
  const component = [first];
  const queue = [first];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const neighbor of neighbors.get(current) ?? []) {
      if (!remaining.delete(neighbor)) {
        continue;
      }
      component.push(neighbor);
      queue.push(neighbor);
    }
  }
  return component.sort((left, right) => left - right);
}

function chainComponents(quests: readonly Quest[], chains: readonly Chain[]): number[][] {
  const questIds = new Set(quests.map(({ id }) => id));
  const neighbors = chainNeighbors(questIds, chains);
  const remaining = new Set(questIds);
  const components: number[][] = [];
  for (const first of questIds) {
    if (!remaining.delete(first)) {
      continue;
    }
    components.push(collectChainComponent(first, remaining, neighbors));
  }
  return components;
}

function signoffVariants(
  repo: string,
  ids: readonly number[],
  shell: QaShell | undefined,
): QaSignoffVariant[] {
  const shells = shell === undefined ? (["powershell", "cmd"] as const) : [shell];
  const command = (quotedRepo: string): string =>
    `quest --repo ${quotedRepo} signoff ${ids.join(" ")}`;
  return shells.map((variantShell) => {
    const quotedRepo = shellQuote(repo, variantShell);
    return {
      command:
        quotedRepo === undefined
          ? "unavailable for this repository name; use the PowerShell command"
          : command(quotedRepo),
      shell: variantShell,
    };
  });
}

function sessionFromGroup(
  group: number,
  reason: QaGroupingReason,
  quests: readonly PendingQuest[],
  shell: QaShell | undefined,
): QaSession {
  const ordered = [...quests].sort(comparePendingQuests);
  const first = ordered[0];
  if (first === undefined) {
    throw new Error("QA sessions cannot be empty");
  }
  const area = groupArea(ordered);
  const files = groupFiles(ordered);
  const sharedFiles = sharedGroupFiles(ordered);
  const ids = ordered.map(({ quest }) => quest.id).sort((left, right) => left - right);
  const signoffVariantsForGroup = signoffVariants(first.quest.repo, ids, shell);
  const signoff = signoffVariantsForGroup[0]?.command;
  if (signoff === undefined) {
    throw new Error("QA sessions must have a sign-off command");
  }
  return {
    area,
    files,
    group,
    ids,
    oldest_at: first.completionAt,
    reason,
    repo: first.quest.repo,
    signoff,
    signoff_variants: signoffVariantsForGroup,
    why: groupWhy(reason, area, sharedFiles),
  };
}

function sessionsForRepository(
  quests: readonly PendingQuest[],
  allQuests: readonly Quest[],
  chains: readonly Chain[],
  shell: QaShell | undefined,
): QaSession[] {
  const pendingById = new Map(quests.map((candidate) => [candidate.quest.id, candidate]));
  const chained = chainComponents(allQuests, chains)
    .map((component) => component.flatMap((id) => pendingById.get(id) ?? []))
    .filter((component) => component.length >= 2);
  const groups: Array<{ readonly reason: QaGroupingReason; readonly quests: PendingQuest[] }> = [];
  const claimed = new Set<number>();
  for (const component of chained) {
    if (component.length < 2) {
      continue;
    }
    groups.push({ reason: "chain", quests: component });
    component.forEach(({ quest }) => {
      claimed.add(quest.id);
    });
  }

  const unclaimed = quests.filter(({ quest }) => !claimed.has(quest.id));
  const fileGroups = connectedComponents(
    unclaimed,
    (left, right) => sharedFiles(left, right).length > 0,
  );
  for (const component of fileGroups) {
    if (component.length < 2) {
      continue;
    }
    groups.push({ reason: "shared_files", quests: component });
    component.forEach(({ quest }) => {
      claimed.add(quest.id);
    });
  }

  const areaGroups = new Map<string | null, PendingQuest[]>();
  for (const candidate of quests) {
    if (claimed.has(candidate.quest.id)) {
      continue;
    }
    const key = candidate.quest.area;
    const group = areaGroups.get(key) ?? [];
    group.push(candidate);
    areaGroups.set(key, group);
  }
  for (const areaGroup of areaGroups.values()) {
    groups.push({ reason: "area", quests: areaGroup });
  }

  return groups
    .sort((left, right) =>
      comparePendingQuests(firstPending(left.quests), firstPending(right.quests)),
    )
    .map(({ reason, quests: group }, index) => sessionFromGroup(index + 1, reason, group, shell));
}

function firstPending(quests: readonly PendingQuest[]): PendingQuest {
  const first = quests[0];
  if (first === undefined) {
    throw new Error("QA sessions cannot be empty");
  }
  return first;
}

export function computeQaQueue(input: QaQueueInput): QaQueue {
  const shell = input.shell ?? (process.platform === "win32" ? undefined : "posix");
  const pending = pendingQuests(input);
  const repositories = [...new Set(pending.map(({ quest }) => quest.repo))].sort();
  const sessions = repositories
    .flatMap((repository) => {
      const repositoryQuests = input.quests.filter((quest) => quest.repo === repository);
      const repositoryIds = new Set(repositoryQuests.map(({ id }) => id));
      const repositoryChains = input.chains.filter(
        (chain) => repositoryIds.has(chain.quest_id) && repositoryIds.has(chain.target_id),
      );
      return sessionsForRepository(
        pending.filter(({ quest }) => quest.repo === repository),
        repositoryQuests,
        repositoryChains,
        shell,
      );
    })
    .sort(
      (left, right) =>
        Date.parse(left.oldest_at) - Date.parse(right.oldest_at) ||
        (left.ids[0] ?? 0) - (right.ids[0] ?? 0) ||
        left.repo.localeCompare(right.repo),
    );
  const numbered = sessions.map((session, index) => ({ ...session, group: index + 1 }));
  return {
    footer: 'Found a problem? use quest --repo <repo> reopen <id> --notes "<what failed>"',
    message: numbered.length === 0 ? "Nothing awaiting sign-off." : null,
    sessions: numbered,
    summary: { quests: pending.length, sessions: numbered.length },
  };
}

export function computeQaQueueFromDump(
  dump: QuestDump,
  repository: string | null | undefined = undefined,
  shell: QaShell | undefined = undefined,
): QaQueue {
  const input = repository === undefined ? dump : { ...dump, repository };
  return shell === undefined ? computeQaQueue(input) : computeQaQueue({ ...input, shell });
}
