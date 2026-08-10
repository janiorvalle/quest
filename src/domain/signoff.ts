import type { Event, Quest, QuestStatus } from "../schema";

export function signoffNotCompleteInstruction(id: number, status: QuestStatus): string {
  return `quest ${id} is ${status}; sign-off applies only after review, merge, and completion. Wait for the quest to reach complete, then retry \`quest signoff ${id}\`.`;
}

export function signoffNotCompleteMessage(id: number, status: QuestStatus): string {
  return `[SIGNOFF_NOT_COMPLETE] ${signoffNotCompleteInstruction(id, status)}`;
}

export function hasSignoffEvent(events: readonly Pick<Event, "action">[]): boolean {
  return events.some((event) => event.action === "signoff");
}

export function isQuestSigned(
  quest: Pick<Quest, "status">,
  events: readonly Pick<Event, "action">[],
): boolean {
  if (quest.status !== "complete") {
    return false;
  }
  let latestCompletion = -1;
  let latestSignoff = -1;
  events.forEach((event, index) => {
    if (event.action === "complete") {
      latestCompletion = index;
    }
    if (event.action === "signoff") {
      latestSignoff = index;
    }
  });
  return latestSignoff > latestCompletion;
}
